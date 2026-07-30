/** Absolute base URL plus path secret, resolved per request — see F5 in the fix spec. */
export interface ResourceBase {
  /** e.g. https://my-app.replit.app — no trailing slash. */
  readonly baseUrl: string;
  readonly pathSecret: string;
}

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

export function snapshotResourceUri(base: ResourceBase, timestamp: string, url: string, format: string): string {
  return `${base.baseUrl}/r/${base.pathSecret}/snapshot/${timestamp}/${encodeURIComponent(url)}?format=${encodeURIComponent(format)}`;
}

export function diffResourceUri(
  base: ResourceBase,
  timestampA: string,
  timestampB: string,
  url: string,
  granularity: string,
): string {
  return `${base.baseUrl}/r/${base.pathSecret}/diff/${timestampA}/${timestampB}/${encodeURIComponent(url)}?granularity=${encodeURIComponent(granularity)}`;
}

/** True for a Replit workspace domain, whose links die when the workspace sleeps (F5). */
export function isEphemeralHost(baseUrl: string): boolean {
  try {
    return /\.replit\.dev$/i.test(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export interface TextPayload {
  /** The text to inline: the whole thing, or its first `limit` characters. */
  readonly inline: string;
  /** First PREVIEW_CHARS characters. Always present. */
  readonly preview: string;
  readonly totalChars: number;
  /** True when the text was too large to inline and only a preview is included. */
  readonly truncated: boolean;
}

/** Hard ceiling on an opt-in `maxChars` escalation (F8). */
export const MAX_INLINE_CHARS = 100_000;

/**
 * How much of a text artifact to inline, and whether anything was left out.
 *
 * Always inlines up to `limit`. The old behaviour — withholding everything past a
 * threshold and offering a 2,000-character preview instead — was removed with G1:
 * the preview was promised in the tool description but never actually emitted, and
 * a link is not a substitute for content because link resolution cannot be relied
 * on across clients.
 */
export function textPayload(text: string, limit: number = INLINE_TEXT_LIMIT): TextPayload {
  const totalChars = text.length;
  const inline = text.slice(0, limit);
  return { inline, preview: text.slice(0, PREVIEW_CHARS), totalChars, truncated: inline.length < totalChars };
}

/** The marker appended when an escalated inline read was still cut short (F8). */
export function truncationNotice(shown: number, total: number): string {
  return `[Truncated at ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters. Re-call with a higher maxChars to see more.]`;
}

export function mimeTypeForFormat(format: string): string {
  if (format === 'markdown') return 'text/markdown';
  return 'text/plain';
}
