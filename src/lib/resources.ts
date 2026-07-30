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
  /** Full text when it is small enough to inline, otherwise undefined. */
  readonly inline: string | undefined;
  /** First PREVIEW_CHARS characters. Always present. */
  readonly preview: string;
  readonly totalChars: number;
  /** True when the text was too large to inline and only a preview is included. */
  readonly truncated: boolean;
}

/** Hard ceiling on an opt-in `maxChars` escalation (F8). */
export const MAX_INLINE_CHARS = 100_000;

/**
 * The inline-versus-link decision, in one place so every tool behaves identically.
 *
 * At the default limit an oversized document yields a 2,000-character preview plus
 * a resource link. When the caller opts into a higher `limit`, the text is inlined
 * up to that many characters — claude.ai does not resolve resource links, so the
 * escalation is the only way to see more (F8).
 */
export function textPayload(text: string, limit: number = INLINE_TEXT_LIMIT): TextPayload {
  const totalChars = text.length;
  if (totalChars <= limit) {
    return { inline: text, preview: text.slice(0, PREVIEW_CHARS), totalChars, truncated: false };
  }
  if (limit !== INLINE_TEXT_LIMIT) {
    // The caller set an explicit budget, so honour it literally: inline up to
    // `limit` characters and say what was cut. Only the default limit produces
    // the preview-plus-resource-link shape.
    return { inline: text.slice(0, limit), preview: text.slice(0, PREVIEW_CHARS), totalChars, truncated: true };
  }
  return { inline: undefined, preview: text.slice(0, PREVIEW_CHARS), totalChars, truncated: true };
}

/** The marker appended when an escalated inline read was still cut short (F8). */
export function truncationNotice(shown: number, total: number): string {
  return `[Truncated at ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} characters. Re-call with a higher maxChars to see more.]`;
}

export function mimeTypeForFormat(format: string): string {
  if (format === 'markdown') return 'text/markdown';
  return 'text/plain';
}
