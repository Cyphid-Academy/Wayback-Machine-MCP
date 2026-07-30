import { z } from 'zod';
import { failure, type Failure } from './errors.js';

/** Fields requested explicitly so the column order does not depend on other params. */
export const CDX_FIELDS: readonly string[] = ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];

export interface CdxRow {
  readonly timestamp: string;
  readonly original: string;
  readonly mimetype: string;
  readonly statuscode: string;
  readonly digest: string;
  readonly length: string;
}

export interface CdxQuery {
  readonly url: string;
  readonly matchType?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly page?: number;
  readonly pageSize?: number;
  readonly collapse?: readonly string[];
  readonly filter?: readonly string[];
  readonly resolveRevisits?: boolean;
  readonly fastLatest?: boolean;
  readonly fields?: readonly string[];
}

export type CdxParse = { readonly ok: true; readonly rows: CdxRow[] } | { readonly ok: false; readonly failure: Failure };

/** CDX JSON is an array of arrays; the first row is the header. Values are strings. */
const cdxPayloadSchema = z.array(z.array(z.union([z.string(), z.number(), z.null()])));

export function buildCdxUrl(base: string, query: CdxQuery): string {
  const params = new URLSearchParams();
  params.set('url', query.url);
  params.set('output', 'json');
  params.set('fl', (query.fields ?? CDX_FIELDS).join(','));
  if (query.matchType !== undefined) params.set('matchType', query.matchType);
  if (query.from !== undefined) params.set('from', query.from);
  if (query.to !== undefined) params.set('to', query.to);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.offset !== undefined) params.set('offset', String(query.offset));
  if (query.page !== undefined) params.set('page', String(query.page));
  if (query.pageSize !== undefined) params.set('pageSize', String(query.pageSize));
  for (const collapse of query.collapse ?? []) params.append('collapse', collapse);
  for (const filter of query.filter ?? []) params.append('filter', filter);
  if (query.resolveRevisits === true) params.set('resolveRevisits', 'true');
  if (query.fastLatest === true) params.set('fastLatest', 'true');
  return `${base}/cdx/search/cdx?${params.toString()}`;
}

function cell(row: readonly (string | number | null)[], index: number | undefined): string {
  if (index === undefined) return '';
  const value = row[index];
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * Parses CDX JSON into objects, mapping columns by the header row rather than by
 * position — `resolveRevisits` and friends can add columns.
 */
export function parseCdxJson(body: string): CdxParse {
  const trimmed = body.trim();
  // No captures at all: the CDX server returns an empty body.
  if (trimmed.length === 0) return { ok: true, rows: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const looksLikeHtml = trimmed.slice(0, 200).toLowerCase().includes('<html');
    return {
      ok: false,
      failure: failure(
        'upstream_error',
        looksLikeHtml
          ? 'The CDX index returned an HTML error page instead of JSON.'
          : 'The CDX index returned a response that is not valid JSON.',
        { hint: 'web.archive.org does this when overloaded. Retry in a few seconds.' },
      ),
    };
  }

  const result = cdxPayloadSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      failure: failure('upstream_error', 'The CDX index returned JSON in an unexpected shape.', {
        hint: 'Expected an array of rows with a header row first.',
      }),
    };
  }

  const table = result.data;
  const header = table[0];
  if (header === undefined) return { ok: true, rows: [] };

  const columns = new Map<string, number>();
  for (const [index, name] of header.entries()) {
    if (typeof name === 'string') columns.set(name.trim().toLowerCase(), index);
  }

  const rows: CdxRow[] = [];
  for (const row of table.slice(1)) {
    rows.push({
      timestamp: cell(row, columns.get('timestamp')),
      original: cell(row, columns.get('original')),
      mimetype: cell(row, columns.get('mimetype')),
      statuscode: cell(row, columns.get('statuscode')),
      digest: cell(row, columns.get('digest')),
      length: cell(row, columns.get('length')),
    });
  }
  return { ok: true, rows };
}

/** Content revisions derived from a capture list by grouping consecutive digests. */
export interface RevisionRun {
  readonly revisionIndex: number;
  readonly digest: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly captureCount: number;
  readonly mimeType: string;
  readonly length: string;
}

/**
 * Groups a chronological capture list into runs of identical content digest.
 * CDX `collapse=digest` only collapses *adjacent* duplicates and cannot report a
 * run's last capture or its size, so this is done here instead — see
 * DECISIONS-MADE.md.
 */
export function groupRevisions(rows: readonly CdxRow[]): RevisionRun[] {
  const runs: RevisionRun[] = [];
  for (const row of rows) {
    const previous = runs[runs.length - 1];
    if (previous !== undefined && previous.digest === row.digest) {
      runs[runs.length - 1] = {
        ...previous,
        lastSeen: row.timestamp,
        captureCount: previous.captureCount + 1,
      };
      continue;
    }
    runs.push({
      revisionIndex: runs.length + 1,
      digest: row.digest,
      firstSeen: row.timestamp,
      lastSeen: row.timestamp,
      captureCount: 1,
      mimeType: row.mimetype,
      length: row.length,
    });
  }
  return runs;
}
