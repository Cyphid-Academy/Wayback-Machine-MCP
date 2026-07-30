import type { z } from 'zod';
import type { Config } from '../config.js';
import type { CacheBackend } from '../lib/cache.js';
import type { RateLimiter } from '../lib/ratelimit.js';
import type { UpstreamClient } from '../lib/http.js';
import type { Logger } from '../lib/log.js';
import { failure, formatFailure, fromUnknown, type Failure } from '../lib/errors.js';
import type { ResourceBase, ResourceLinkBlock } from '../lib/resources.js';
import { toJsonSchema, type JsonSchemaObject } from '../schemas.js';

export interface ToolContext {
  readonly config: Config;
  /**
   * Base URL and path secret for resource links, resolved from the incoming
   * request rather than from configuration, so a link never points at the wrong
   * host (F5).
   */
  readonly resourceBase: ResourceBase;
  readonly cache: CacheBackend;
  readonly limiter: RateLimiter;
  readonly upstream: UpstreamClient;
  readonly logger: Logger;
}

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}

export type ContentBlock = TextBlock | ResourceLinkBlock;

export interface ToolResultPayload {
  readonly content: ContentBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint: boolean;
}

export type ToolOutcome<O> =
  | { readonly ok: true; readonly text: string; readonly structured: O; readonly links?: readonly ResourceLinkBlock[] }
  | { readonly ok: false; readonly failure: Failure };

export interface ToolModule {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly inputJsonSchema: JsonSchemaObject;
  readonly outputJsonSchema: JsonSchemaObject;
  run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResultPayload>;
}

export interface ToolSpec<I, O extends object> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  run(input: I, ctx: ToolContext): Promise<ToolOutcome<O>>;
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function errorPayload(failureValue: Failure): ToolResultPayload {
  return { content: [{ type: 'text', text: formatFailure(failureValue) }], isError: true };
}

function invalidInput(error: z.ZodError, toolName: string): Failure {
  const issues = error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return failure('invalid_input', `${toolName} received arguments it could not use — ${issues}.`, {
    hint: 'Check the tool input schema and retry with corrected arguments.',
  });
}

/**
 * Wraps a typed tool implementation into the erased shape the dispatcher uses.
 * Input is validated before the handler runs, output is validated against the
 * declared `outputSchema` after, and nothing escapes as an exception.
 */
export function defineTool<I, O extends object>(spec: ToolSpec<I, O>): ToolModule {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    annotations: spec.annotations,
    inputJsonSchema: toJsonSchema(spec.input, 'input'),
    outputJsonSchema: toJsonSchema(spec.output, 'output'),
    async run(rawArgs: unknown, ctx: ToolContext): Promise<ToolResultPayload> {
      const parsedInput = spec.input.safeParse(rawArgs ?? {});
      if (!parsedInput.success) return errorPayload(invalidInput(parsedInput.error, spec.name));

      let outcome: ToolOutcome<O>;
      try {
        outcome = await spec.run(parsedInput.data, ctx);
      } catch (error) {
        ctx.logger.error('tool threw', { tool: spec.name });
        return errorPayload(fromUnknown(error, `${spec.name} failed unexpectedly`));
      }
      if (!outcome.ok) return errorPayload(outcome.failure);

      const parsedOutput = spec.output.safeParse(outcome.structured);
      if (!parsedOutput.success) {
        const first = parsedOutput.error.issues[0];
        return errorPayload(
          failure(
            'internal',
            `${spec.name} produced a result that does not match its declared output schema (${
              first === undefined ? 'unknown field' : `${first.path.join('.') || '(root)'}: ${first.message}`
            }).`,
          ),
        );
      }

      return {
        content: [{ type: 'text', text: outcome.text }, ...(outcome.links ?? [])],
        structuredContent: toRecord(parsedOutput.data),
      };
    },
  };
}

/** Convenience constructors for tool handlers. */
export function succeed<O extends object>(
  structured: O,
  text: string,
  links?: readonly ResourceLinkBlock[],
): ToolOutcome<O> {
  return links === undefined ? { ok: true, structured, text } : { ok: true, structured, text, links };
}

export function fail<O extends object>(failureValue: Failure): ToolOutcome<O> {
  return { ok: false, failure: failureValue };
}
