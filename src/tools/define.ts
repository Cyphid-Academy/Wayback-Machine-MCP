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

export interface ToolSuccessOptions {
  /**
   * The tool's actual payload — page text, a diff — as opposed to the summary
   * describing it. Delivered in both channels; see the G0 contract below.
   */
  readonly payload?: string;
  readonly links?: readonly ResourceLinkBlock[];
}

export type ToolOutcome<O> =
  | { readonly ok: true; readonly summary: string; readonly payload?: string; readonly structured: O; readonly links?: readonly ResourceLinkBlock[] }
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

/** A tool's structured output minus the summary, which `defineTool` injects. */
export type WithoutSummary<O> = Omit<O, 'summary'>;

export interface ToolSpec<I, O extends object> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  run(input: I, ctx: ToolContext): Promise<ToolOutcome<WithoutSummary<O>>>;
}

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

/**
 * Ceiling on the combined size of one tool result. The payload is delivered in
 * both channels (see the contract below), so it counts twice; past this the
 * text block defers to structuredContent rather than risk breaching the
 * ~30,000-token cap that fails a call outright.
 */
const SAFE_TOTAL_CHARS = 120_000;

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
 *
 * The output contract (G0), which every tool obeys because it is enforced here:
 *
 * - The `content` array holds exactly one `TextContent` block — the prose summary,
 *   followed by the payload when there is one. It is never JSON.
 * - `structuredContent` holds the typed machine data, and additionally carries
 *   `summary` (the same prose) and the payload in a named field.
 *
 * The duplication is deliberate and empirically motivated: some clients surface
 * only `structuredContent` and drop text blocks entirely, so a warning that lives
 * only in prose may never reach the model, while a warning that lives only in
 * structured data is easy to skim past. See DECISIONS-MADE.md.
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

      let outcome: ToolOutcome<WithoutSummary<O>>;
      try {
        outcome = await spec.run(parsedInput.data, ctx);
      } catch (error) {
        ctx.logger.error('tool threw', { tool: spec.name });
        return errorPayload(fromUnknown(error, `${spec.name} failed unexpectedly`));
      }
      if (!outcome.ok) return errorPayload(outcome.failure);

      // The summary is injected rather than set by each tool, so no tool can
      // forget it and the two channels cannot drift apart.
      const parsedOutput = spec.output.safeParse({ ...outcome.structured, summary: outcome.summary });
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

      const payload = outcome.payload ?? '';
      const combined = outcome.summary.length + payload.length * 2;
      const text =
        payload.length === 0
          ? outcome.summary
          : combined <= SAFE_TOTAL_CHARS
            ? `${outcome.summary}\n\n${payload}`
            : `${outcome.summary}\n\n[Payload omitted from this block to keep the result within size limits; it is in structuredContent.]`;

      return {
        content: [{ type: 'text', text }, ...(outcome.links ?? [])],
        structuredContent: toRecord(parsedOutput.data),
      };
    },
  };
}

/** Convenience constructors for tool handlers. */
export function succeed<O extends object>(
  structured: O,
  summary: string,
  options: ToolSuccessOptions = {},
): ToolOutcome<O> {
  return {
    ok: true,
    structured,
    summary,
    ...(options.payload === undefined ? {} : { payload: options.payload }),
    ...(options.links === undefined ? {} : { links: options.links }),
  };
}

export function fail<O extends object>(failureValue: Failure): ToolOutcome<O> {
  return { ok: false, failure: failureValue };
}
