import type { Config } from '../config.js';
import { availabilityResponseSchema } from '../schemas.js';
import { CACHE_TTL } from './cache.js';
import { buildCdxUrl, parseCdxJson, type CdxQuery, type CdxRow } from './cdx.js';
import { failure, type Failure } from './errors.js';
import { extract, isHtmlLike, normalizePlainText, type ExtractMode } from './extract.js';
import type { UpstreamClient } from './http.js';
import { normalizeTimestamp, timestampFromWaybackUrl, timestampToMillis } from './timestamps.js';
import { absoluteUrl, preferHttps, waybackCaptureUrl } from './urls.js';

export interface WaybackDeps {
  readonly config: Config;
  readonly upstream: UpstreamClient;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/** Runs a CDX query and returns parsed rows. */
export async function cdxSearch(deps: WaybackDeps, query: CdxQuery): Promise<Result<CdxRow[]>> {
  const url = buildCdxUrl(deps.config.webArchiveBase, query);
  const response = await deps.upstream.get(url, { ttlMs: CACHE_TTL.index, what: 'the CDX capture index' });
  if (!response.ok) return { ok: false, failure: response.failure };
  const parsed = parseCdxJson(response.body);
  if (!parsed.ok) return { ok: false, failure: parsed.failure };
  return { ok: true, value: parsed.rows };
}

export interface AvailabilityInfo {
  readonly available: boolean;
  readonly timestamp: string | undefined;
  readonly snapshotUrl: string | undefined;
  readonly status: string | undefined;
}

/** The closest-snapshot endpoint. Cheap, but it lags the CDX index for some URLs. */
export async function checkAvailability(
  deps: WaybackDeps,
  url: string,
  timestamp?: string,
): Promise<Result<AvailabilityInfo>> {
  const params = new URLSearchParams({ url });
  if (timestamp !== undefined) params.set('timestamp', timestamp);
  const endpoint = `${deps.config.archiveBase}/wayback/available?${params.toString()}`;
  const response = await deps.upstream.getJson(endpoint, availabilityResponseSchema, {
    ttlMs: CACHE_TTL.index,
    what: 'the Wayback availability API',
  });
  if (!response.ok) return { ok: false, failure: response.failure };

  const closest = response.value.archived_snapshots?.closest;
  if (closest === undefined || closest.timestamp === undefined) {
    return { ok: true, value: { available: false, timestamp: undefined, snapshotUrl: undefined, status: undefined } };
  }
  const rawStatus = closest.status;
  return {
    ok: true,
    value: {
      available: closest.available ?? true,
      timestamp: closest.timestamp,
      snapshotUrl: closest.url === undefined ? undefined : preferHttps(closest.url),
      status: rawStatus === undefined ? undefined : String(rawStatus),
    },
  };
}

const NO_CAPTURES_HINT =
  'Confirm the URL is right (try matchType "prefix" or "host" with search_snapshots), or run archive_stats to see whether anything is archived at all.';

function noCaptures(url: string): Failure {
  return failure('no_captures', `The Wayback Machine has no usable captures for ${url}.`, { hint: NO_CAPTURES_HINT });
}

/**
 * Resolves `latest`, `earliest`, a partial date or a full timestamp to one real
 * capture timestamp. The CDX index is authoritative; the availability API is the
 * fallback because it sometimes lags for recently-archived URLs.
 */
export async function resolveTimestamp(deps: WaybackDeps, url: string, requested: string): Promise<Result<string>> {
  const wanted = requested.trim().toLowerCase();

  if (wanted === 'latest' || wanted === 'earliest' || wanted.length === 0) {
    const latest = wanted !== 'earliest';
    const primary = await cdxSearch(deps, {
      url,
      matchType: 'exact',
      filter: ['statuscode:200'],
      limit: latest ? -1 : 1,
      ...(latest ? { fastLatest: true } : {}),
    });
    if (primary.ok) {
      const row = latest ? primary.value[primary.value.length - 1] : primary.value[0];
      if (row !== undefined && row.timestamp.length > 0) return { ok: true, value: row.timestamp };
    }
    // Fall back to the availability API, which always reports the closest capture.
    const fallback = await checkAvailability(deps, url, latest ? undefined : '19960101');
    if (fallback.ok && fallback.value.timestamp !== undefined) {
      return { ok: true, value: fallback.value.timestamp };
    }
    if (!primary.ok) return { ok: false, failure: primary.failure };
    return { ok: false, failure: noCaptures(url) };
  }

  const normalized = normalizeTimestamp(requested, 'start');
  if (!normalized.ok) return { ok: false, failure: normalized.failure };
  const target = normalized.value;

  const availability = await checkAvailability(deps, url, target);
  if (availability.ok && availability.value.timestamp !== undefined) {
    return { ok: true, value: availability.value.timestamp };
  }

  // Availability came back empty: probe the CDX index either side of the target.
  const [before, after] = await Promise.all([
    cdxSearch(deps, { url, matchType: 'exact', filter: ['statuscode:200'], to: target, limit: -1 }),
    cdxSearch(deps, { url, matchType: 'exact', filter: ['statuscode:200'], from: target, limit: 1 }),
  ]);
  const candidates: string[] = [];
  if (before.ok) {
    const row = before.value[before.value.length - 1];
    if (row !== undefined && row.timestamp.length > 0) candidates.push(row.timestamp);
  }
  if (after.ok) {
    const row = after.value[0];
    if (row !== undefined && row.timestamp.length > 0) candidates.push(row.timestamp);
  }
  if (candidates.length === 0) {
    if (!before.ok) return { ok: false, failure: before.failure };
    if (!after.ok) return { ok: false, failure: after.failure };
    return { ok: false, failure: noCaptures(url) };
  }

  const targetMillis = timestampToMillis(target);
  let best = candidates[0] ?? target;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(timestampToMillis(candidate) - targetMillis);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return { ok: true, value: best };
}

export interface RawCapture {
  readonly timestamp: string;
  readonly resolvedUrl: string;
  readonly mimeType: string;
  readonly body: string;
  readonly bodyTruncated: boolean;
}

/**
 * Fetches one capture's original bytes. `id_` is the default modifier and matters:
 * without it the Wayback Machine injects its banner and rewrites every link,
 * which corrupts both extraction and diffs.
 */
export async function fetchCapture(
  deps: WaybackDeps,
  url: string,
  timestamp: string,
  modifier = 'id_',
): Promise<Result<RawCapture>> {
  const captureUrl = waybackCaptureUrl(deps.config.webArchiveBase, timestamp, url, modifier);
  const response = await deps.upstream.get(captureUrl, {
    ttlMs: CACHE_TTL.snapshot,
    what: `the capture of ${absoluteUrl(url)} at ${timestamp}`,
  });
  if (!response.ok) return { ok: false, failure: response.failure };

  // A capture request can land on a neighbouring capture; trust the final URL.
  const actual = timestampFromWaybackUrl(response.finalUrl) ?? timestamp;
  return {
    ok: true,
    value: {
      timestamp: actual,
      resolvedUrl: response.finalUrl,
      mimeType: response.contentType ?? 'application/octet-stream',
      body: response.body,
      bodyTruncated: response.truncated,
    },
  };
}

export interface CaptureText extends RawCapture {
  readonly text: string;
  readonly title: string | undefined;
  readonly wasHtml: boolean;
}

/** Fetch plus extraction, so tools and the /r/ resource routes stay in step. */
export async function fetchCaptureText(
  deps: WaybackDeps,
  url: string,
  timestamp: string,
  mode: ExtractMode,
  modifier = 'id_',
): Promise<Result<CaptureText>> {
  const capture = await fetchCapture(deps, url, timestamp, modifier);
  if (!capture.ok) return capture;

  const html = isHtmlLike(capture.value.mimeType, capture.value.body);
  if (!html) {
    return {
      ok: true,
      value: { ...capture.value, text: normalizePlainText(capture.value.body), title: undefined, wasHtml: false },
    };
  }
  const extracted = extract(capture.value.body, mode);
  return {
    ok: true,
    value: { ...capture.value, text: extracted.text, title: extracted.title, wasHtml: true },
  };
}
