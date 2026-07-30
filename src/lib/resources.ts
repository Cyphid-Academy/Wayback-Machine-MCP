import type { Config } from '../config.js';
import { resourceBasePath } from '../config.js';

/**
 * Build spec §2: anything whose extracted text is longer than this comes back as
 * a ResourceLink plus a preview, never inline. Custom-connector tool results are
 * capped at roughly 30k tokens and a breach fails the whole call.
 */
export const INLINE_TEXT_LIMIT = 8_000;
export const PREVIEW_CHARS = 2_000;
/** Ceiling for the compact human-readable summary that goes in `content`. */
export const SUMMARY_CHARS = 2_000;
/**
 * Row ceiling for any tool that returns a table in `structuredContent`. 1,000 CDX
 * rows would be tens of thousands of tokens on its own, so tables are trimmed and
 * the tool tells the caller how to page.
 */
export const MAX_TABLE_ROWS = 250;

export interface ResourceLinkBlock {
  readonly type: 'resource_link';
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export interface ResourceLinkInput {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly size?: number;
}

export function resourceLink(input: ResourceLinkInput): ResourceLinkBlock {
  return {
    type: 'resource_link',
    uri: input.uri,
    name: input.name,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    ...(input.size === undefined ? {} : { size: input.size }),
  };
}

export function snapshotResourceUri(config: Config, timestamp: string, url: string, format: string): string {
  return `${config.deployUrl}${resourceBasePath(config)}/snapshot/${timestamp}/${encodeURIComponent(url)}?format=${encodeURIComponent(format)}`;
}

export function diffResourceUri(
  config: Config,
  timestampA: string,
  timestampB: string,
  url: string,
  granularity: string,
): string {
  return `${config.deployUrl}${resourceBasePath(config)}/diff/${timestampA}/${timestampB}/${encodeURIComponent(url)}?granularity=${encodeURIComponent(granularity)}`;
}

export interface TextPayload {
  /** Full text when it is small enough to inline, otherwise undefined. */
  readonly inline: string | undefined;
  /** First PREVIEW_CHARS characters. Always present. */
  readonly preview: string;
  readonly totalChars: number;
  /** True when the text was too large to inline and only a preview is included. */
  readonly truncated: boolean;
}

/** The 8,000-character decision, in one place so every tool behaves identically. */
export function textPayload(text: string, limit: number = INLINE_TEXT_LIMIT): TextPayload {
  const totalChars = text.length;
  if (totalChars <= limit) {
    return { inline: text, preview: text.slice(0, PREVIEW_CHARS), totalChars, truncated: false };
  }
  return { inline: undefined, preview: text.slice(0, PREVIEW_CHARS), totalChars, truncated: true };
}

export function mimeTypeForFormat(format: string): string {
  if (format === 'markdown') return 'text/markdown';
  return 'text/plain';
}
