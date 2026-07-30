import { z } from 'zod';
import { searchSnapshotsInput, searchSnapshotsOutput } from '../schemas.js';
import { cdxSearch } from '../lib/wayback.js';
import { normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { normalizeTimestamp, timestampToIso } from '../lib/timestamps.js';
import { MAX_TABLE_ROWS } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { count, shortDateTime, summary } from './format.js';

type Input = z.infer<typeof searchSnapshotsInput>;
type Output = z.infer<typeof searchSnapshotsOutput>;
type Row = z.infer<typeof searchSnapshotsOutput>['rows'][number];

const TEXT_ROWS = 12;

export const searchSnapshotsTool: ToolModule = defineTool<Input, Output>({
  name: 'search_snapshots',
  title: 'Search the capture index',
  description:
    'Queries the Wayback CDX index and returns capture rows as structured data (timestamp, status, mime type, content digest, size) — never raw index text and never page content. This is the general-purpose enumeration tool: use it to see what exists, to page through large capture sets, or to find URLs under a host with matchType "prefix"/"host"/"domain". For the specific job of "how many times did this page actually change?", prefer list_revisions, which collapses captures by content digest. Run archive_stats first on an unfamiliar URL so you can set from/to and avoid pulling thousands of rows.',
  annotations: { title: 'Search the capture index', readOnlyHint: true, openWorldHint: true },
  input: searchSnapshotsInput,
  output: searchSnapshotsOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;

    let from: string | undefined;
    if (input.from !== undefined) {
      const parsed = normalizeTimestamp(input.from, 'start');
      if (!parsed.ok) return fail(parsed.failure);
      from = parsed.value;
    }
    let to: string | undefined;
    if (input.to !== undefined) {
      const parsed = normalizeTimestamp(input.to, 'end');
      if (!parsed.ok) return fail(parsed.failure);
      to = parsed.value;
    }

    // Ask for one extra row so `hasMore` is exact rather than guessed.
    const result = await cdxSearch(
      { config: ctx.config, upstream: ctx.upstream },
      {
        url,
        matchType: input.matchType,
        limit: input.limit + 1,
        resolveRevisits: input.resolveRevisits,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
        ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.page === undefined ? {} : { page: input.page }),
        ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        ...(input.collapse === undefined ? {} : { collapse: [input.collapse] }),
        ...(input.filter === undefined ? {} : { filter: input.filter }),
      },
    );
    if (!result.ok) return fail(result.failure);

    const hasMore = result.value.length > input.limit;
    const withinLimit = result.value.slice(0, input.limit);
    const rowsTruncated = withinLimit.length > MAX_TABLE_ROWS;
    const kept = withinLimit.slice(0, MAX_TABLE_ROWS);

    const rows: Row[] = kept.map((row) => ({
      timestamp: row.timestamp,
      timestampIso: timestampToIso(row.timestamp),
      original: row.original,
      statuscode: row.statuscode,
      mimetype: row.mimetype,
      digest: row.digest,
      length: row.length,
      snapshotUrl: waybackCaptureUrl(ctx.config.webArchiveBase, row.timestamp, row.original.length > 0 ? row.original : url),
    }));

    const structured: Output = {
      url,
      matchType: input.matchType,
      rows,
      totalReturned: rows.length,
      hasMore,
      rowsTruncated,
      nextOffset: hasMore ? (input.offset ?? 0) + withinLimit.length : null,
    };

    if (rows.length === 0) {
      return succeed(
        structured,
        summary([
          `No captures matched ${url}${from === undefined && to === undefined ? '' : ' in that date range'}.`,
          'Next: widen the range, drop filters, or try matchType "prefix" / "host". archive_stats will confirm whether anything is archived.',
        ]),
      );
    }

    const lines = [
      `${count(rows.length)} capture${rows.length === 1 ? '' : 's'} of ${url} (matchType ${input.matchType})`,
      `Range: ${shortDateTime(rows[0]?.timestamp ?? '')} → ${shortDateTime(rows[rows.length - 1]?.timestamp ?? '')}`,
      '',
      ...rows.slice(0, TEXT_ROWS).map((row) => `${row.timestamp}  ${row.statuscode.padEnd(3)}  ${row.mimetype.padEnd(24).slice(0, 24)}  ${row.digest.slice(0, 12)}`),
    ];
    if (rows.length > TEXT_ROWS) lines.push(`… ${count(rows.length - TEXT_ROWS)} more rows in structuredContent.`);
    if (rowsTruncated) {
      lines.push(
        `Trimmed to ${String(MAX_TABLE_ROWS)} rows to stay inside the tool-result size cap; page with offset=${String(structured.nextOffset ?? MAX_TABLE_ROWS)}.`,
      );
    } else if (hasMore) {
      lines.push(`More captures exist; page with offset=${String(structured.nextOffset ?? 0)}.`);
    }

    return succeed(structured, summary(lines));
  },
});
