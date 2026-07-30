import type { Config } from '../config.js';
import { availabilityResponseSchema } from '../schemas.js';
import { CACHE_TTL } from './cache.js';
import { buildCdxUrl, parseCdxJson, type CdxQuery, type CdxRow } from './cdx.js';
import { failure, type Failure } from './errors.js';
import { extract, isHtmlLike, normalizePlainText, type ExtractMode } from './extract.js';
import type { UpstreamClient } from './http.js';
import { normalizeTimestamp, timestampFromWaybackUrl, timestampToMillis } from './timestamps.js';
import { createHash } from 'node:crypto';
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

export interface StatusBreakdown {
  readonly total: number;
  readonly ok: number;
  readonly redirects: number;
  readonly clientErrors: number;
  readonly serverErrors: number;
  readonly other: number;
}

/** Buckets capture rows by HTTP status class so tools can be honest about exclusions (F2). */
export function statusBreakdown(rows: readonly CdxRow[]): StatusBreakdown {
  let ok = 0;
  let redirects = 0;
  let clientErrors = 0;
  let serverErrors = 0;
  let other = 0;
  for (const row of rows) {
    const code = Number.parseInt(row.statuscode, 10);
    if (code === 200) ok += 1;
    else if (code >= 300 && code < 400) redirects += 1;
    else if (code >= 400 && code < 500) clientErrors += 1;
    else if (code >= 500 && code < 600) serverErrors += 1;
    else other += 1;
  }
  return { total: rows.length, ok, redirects, clientErrors, serverErrors, other };
}

/**
 * Explains a URL that is archived but has no readable captures, instead of
 * claiming nothing is archived at all (F2).
 */
export function describeUnreadable(url: string, breakdown: StatusBreakdown): Failure {
  if (breakdown.total === 0) return noCaptures(url);
  const parts: string[] = [];
  if (breakdown.redirects > 0) parts.push(`3xx: ${String(breakdown.redirects)}`);
  if (breakdown.clientErrors > 0) parts.push(`4xx: ${String(breakdown.clientErrors)}`);
  if (breakdown.serverErrors > 0) parts.push(`5xx: ${String(breakdown.serverErrors)}`);
  if (breakdown.other > 0) parts.push(`other: ${String(breakdown.other)}`);
  return failure(
    'no_captures',
    `${String(breakdown.total)} capture${breakdown.total === 1 ? '' : 's'} exist for ${url} but none returned HTTP 200 (${parts.join(', ')}).`,
    {
      hint: 'The page likely moved — run search_snapshots without a status filter to see the redirect targets, then query the successor URL.',
    },
  );
}

const NO_CAPTURES_HINT =
  'Confirm the URL is right (try matchType "prefix" or "host" with search_snapshots), or run archive_stats to see whether anything is archived at all.';

function noCaptures(url: string): Failure {
  return failure('no_captures', `The Wayback Machine has no usable captures for ${url}.`, { hint: NO_CAPTURES_HINT });
}

export interface ResolvedTimestamp {
  /** The real capture timestamp that will be fetched. */
  readonly timestamp: string;
  /** What the caller asked for, normalised. 'earliest'/'latest' pass through. */
  readonly requested: string;
  /**
   * Signed distance in days from the requested date to the resolved capture, or
   * null when the request was 'earliest'/'latest' (exact by definition).
   */
  readonly offsetDays: number | null;
}

const MS_PER_DAY = 86_400_000;

/** Beyond this many days, the gap is called out prominently in tool output (F3). */
export const OFFSET_NOTICE_DAYS = 3;

/** The note prepended when a resolved capture is far from the requested date (F3). */
export function offsetNotice(resolved: ResolvedTimestamp): string | undefined {
  if (resolved.offsetDays === null) return undefined;
  if (Math.abs(resolved.offsetDays) <= OFFSET_NOTICE_DAYS) return undefined;
  const days = Math.abs(resolved.offsetDays);
  return `Note: nearest capture to ${resolved.requested.slice(0, 8)} is ${resolved.timestamp}, ${String(days)} day${days === 1 ? '' : 's'} ${resolved.offsetDays > 0 ? 'later' : 'earlier'}. There are no captures in between.`;
}

/**
 * Resolves `latest`, `earliest`, a partial date or a full timestamp to one real
 * capture timestamp. The CDX index is authoritative; the availability API is the
 * fallback because it sometimes lags for recently-archived URLs.
 */
export async function resolveTimestamp(
  deps: WaybackDeps,
  url: string,
  requested: string,
): Promise<Result<ResolvedTimestamp>> {
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
    const exact = (timestamp: string): Result<ResolvedTimestamp> => ({
      ok: true,
      value: { timestamp, requested: latest ? 'latest' : 'earliest', offsetDays: null },
    });
    if (primary.ok) {
      const row = latest ? primary.value[primary.value.length - 1] : primary.value[0];
      if (row !== undefined && row.timestamp.length > 0) return exact(row.timestamp);
    }
    // Fall back to the availability API, which always reports the closest capture.
    const fallback = await checkAvailability(deps, url, latest ? undefined : '19960101');
    if (fallback.ok && fallback.value.timestamp !== undefined) return exact(fallback.value.timestamp);
    if (!primary.ok) return { ok: false, failure: primary.failure };
    return { ok: false, failure: await explainMissing(deps, url) };
  }

  const normalized = normalizeTimestamp(requested, 'start');
  if (!normalized.ok) return { ok: false, failure: normalized.failure };
  const target = normalized.value;

  const withOffset = (timestamp: string): Result<ResolvedTimestamp> => ({
    ok: true,
    value: {
      timestamp,
      requested: target,
      offsetDays: Math.round((timestampToMillis(timestamp) - timestampToMillis(target)) / MS_PER_DAY),
    },
  });

  const availability = await checkAvailability(deps, url, target);
  if (availability.ok && availability.value.timestamp !== undefined) {
    return withOffset(availability.value.timestamp);
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
    return { ok: false, failure: await explainMissing(deps, url) };
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
  return withOffset(best);
}

/**
 * Distinguishes "nothing archived" from "archived but nothing readable" before
 * reporting a failure, so a redirected page is never described as unarchived (F2).
 */
async function explainMissing(deps: WaybackDeps, url: string): Promise<Failure> {
  const all = await cdxSearch(deps, { url, matchType: 'exact', limit: 200, fields: ['timestamp', 'statuscode'] });
  if (!all.ok) return noCaptures(url);
  return describeUnreadable(url, statusBreakdown(all.value));
}

/** The three captures nearest a timestamp, for retry advice after a fetch failure (F7). */
export async function nearestAlternatives(
  deps: WaybackDeps,
  url: string,
  timestamp: string,
  exclude: readonly string[] = [],
): Promise<string[]> {
  const rows = await cdxSearch(deps, {
    url,
    matchType: 'exact',
    filter: ['statuscode:200'],
    limit: 400,
    fields: ['timestamp', 'statuscode'],
  });
  if (!rows.ok) return [];
  const target = timestampToMillis(timestamp);
  return rows.value
    .map((row) => row.timestamp)
    .filter((candidate) => candidate.length === 14 && candidate !== timestamp && !exclude.includes(candidate))
    .sort((left, right) => Math.abs(timestampToMillis(left) - target) - Math.abs(timestampToMillis(right) - target))
    .slice(0, 3)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Stable hash of a capture's readable content (F4). CDX content digests change on
 * every capture for pages that embed build hashes or per-request nonces; hashing
 * the chrome-stripped text instead compares what a reader would actually see.
 */
export function textDigest(text: string): string {
  const normalised = text.replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 32).toUpperCase();
}

/** Picks at most `limit` captures spread evenly across a chronological list (F4). */
export function evenlySpaced<T>(items: readonly T[], limit: number): T[] {
  if (limit <= 0) return [];
  if (items.length <= limit) return [...items];
  const picked: T[] = [];
  const step = (items.length - 1) / (limit - 1);
  for (let index = 0; index < limit; index += 1) {
    const item = items[Math.round(index * step)];
    if (item !== undefined && !picked.includes(item)) picked.push(item);
  }
  return picked;
}

export interface RawCapture {
  readonly timestamp: string;
  readonly resolvedUrl: string;
  readonly mimeType: string;
  readonly body: string;
  /** Exact artifact size in bytes — what a resource link should advertise (F6). */
  readonly byteLength: number;
  readonly bodyTruncated: boolean;
}

/**
 * Fetches one capture's original bytes. `id_` is the default modifier and matters:
 * without it the Wayback Machine injects its banner and rewrites every link,
 * which corrupts both extraction and diffs.
 */
export interface FetchCaptureOptions {
  readonly modifier?: string;
  readonly maxWaitMs?: number;
}

export async function fetchCapture(
  deps: WaybackDeps,
  url: string,
  timestamp: string,
  options: FetchCaptureOptions = {},
): Promise<Result<RawCapture>> {
  const modifier = options.modifier ?? 'id_';
  const captureUrl = waybackCaptureUrl(deps.config.webArchiveBase, timestamp, url, modifier);
  const response = await deps.upstream.get(captureUrl, {
    ttlMs: CACHE_TTL.snapshot,
    what: `Capture ${timestamp} of ${absoluteUrl(url)}`,
    errorSubject: 'capture',
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
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
      byteLength: response.byteLength,
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
  options: FetchCaptureOptions = {},
): Promise<Result<CaptureText>> {
  const capture = await fetchCapture(deps, url, timestamp, options);
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
