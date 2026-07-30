import { failure, type Failure } from './errors.js';

export type UrlOutcome = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly failure: Failure };

/** Prefixes the CDX index uses for non-page captures. */
const SPECIAL_PREFIXES = ['screenshot:', 'urn:'];

/**
 * Cleans a user-supplied target URL for use as a CDX lookup key. A scheme is
 * optional (the CDX index is keyed on host+path), but the string must at least
 * look like a host.
 */
export function normalizeTargetUrl(raw: string): UrlOutcome {
  let value = raw.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (value.length === 0) {
    return { ok: false, failure: failure('invalid_input', 'url is empty.', { hint: 'Pass a URL such as example.com/page or https://example.com/page.' }) };
  }
  if (/\s/.test(value)) {
    return {
      ok: false,
      failure: failure('invalid_input', `url contains whitespace: "${raw}".`, { hint: 'Percent-encode spaces as %20 or remove them, e.g. example.com/my%20page.' }),
    };
  }

  const special = SPECIAL_PREFIXES.find((prefix) => value.toLowerCase().startsWith(prefix));
  if (special !== undefined) return { ok: true, value };

  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = withoutScheme.split(/[/?#]/)[0] ?? '';
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) {
    return {
      ok: false,
      failure: failure('invalid_input', `"${raw}" does not look like a URL or hostname.`, {
        hint: 'Expected something like example.com, example.com/page, or https://example.com/page.',
      }),
    };
  }
  return { ok: true, value };
}

/** Same value, but guaranteed to carry a scheme so it can be fetched. */
export function absoluteUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  if (SPECIAL_PREFIXES.some((prefix) => url.toLowerCase().startsWith(prefix))) return url;
  return `https://${url}`;
}

/** Wayback replay URL. `modifier` is the raw modifier such as `id_` or `im_`. */
export function waybackCaptureUrl(base: string, timestamp: string, url: string, modifier = ''): string {
  return `${base}/web/${timestamp}${modifier}/${absoluteUrl(url)}`;
}

/** The human calendar page for a URL. */
export function waybackCalendarUrl(base: string, url: string): string {
  return `${base}/web/*/${absoluteUrl(url)}`;
}

/** The Wayback side-by-side visual diff between two captures. */
export function waybackVisualDiffUrl(base: string, timestampA: string, timestampB: string, url: string): string {
  return `${base}/web/diff/${timestampA}/${timestampB}/${absoluteUrl(url)}`;
}

/** http:// capture URLs handed back by the availability API become https://. */
export function preferHttps(url: string): string {
  return url.startsWith('http://web.archive.org') ? `https://${url.slice('http://'.length)}` : url;
}
