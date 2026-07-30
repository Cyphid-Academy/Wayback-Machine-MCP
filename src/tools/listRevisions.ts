import { z } from 'zod';
import { listRevisionsInput, listRevisionsOutput } from '../schemas.js';
import { cdxSearch } from '../lib/wayback.js';
import { groupRevisions } from '../lib/cdx.js';
import { normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { normalizeTimestamp, timestampToIso } from '../lib/timestamps.js';
import { MAX_TABLE_ROWS } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { bytes, count, shortDate, summary } from './format.js';

type Input = z.infer<typeof listRevisionsInput>;
type Output = z.infer<typeof listRevisionsOutput>;
type Row = z.infer<typeof listRevisionsOutput>['revisions'][number];

const TEXT_ROWS = 20;

export const listRevisionsTool: ToolModule = defineTool<Input, Output>({
  name: 'list_revisions',
  title: 'Distinct content revisions of a URL',
  description:
    'Turns hundreds of captures into the handful of times a page actually changed. A documentation or support page rewritten in place at a stable URL may have hundreds of Wayback captures but only a few distinct bodies; this groups captures by content digest and returns one row per revision with revisionIndex, digest, firstSeen, lastSeen and captureCount. This is the tool to reach for when reconstructing the edit history of a page, and the natural input to compare_snapshots: take firstSeen from two revisions and diff them. Run archive_stats first on a heavily-archived URL and pass from/to, so the capture list stays small.',
  annotations: { title: 'Distinct content revisions of a URL', readOnlyHint: true, openWorldHint: true },
  input: listRevisionsInput,
  output: listRevisionsOutput,
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

    // The full capture list is fetched (cheap fields only) and grouped here:
    // CDX `collapse=digest` only collapses *adjacent* rows and cannot report a
    // revision's last capture or how many captures it covers.
    const result = await cdxSearch(
      { config: ctx.config, upstream: ctx.upstream },
      {
        url,
        matchType: 'exact',
        limit: input.maxCaptures + 1,
        resolveRevisits: true,
        fields: ['timestamp', 'digest', 'mimetype', 'length', 'statuscode'],
        ...(input.includeRedirects ? {} : { filter: ['statuscode:200'] }),
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      },
    );
    if (!result.ok) return fail(result.failure);

    const capturesTruncated = result.value.length > input.maxCaptures;
    const captures = result.value.slice(0, input.maxCaptures).filter((row) => row.timestamp.length > 0);
    const runs = groupRevisions(captures);
    const revisionsTruncated = runs.length > MAX_TABLE_ROWS;
    const kept = runs.slice(0, MAX_TABLE_ROWS);

    const revisions: Row[] = kept.map((run) => ({
      revisionIndex: run.revisionIndex,
      digest: run.digest,
      firstSeen: run.firstSeen,
      firstSeenIso: timestampToIso(run.firstSeen),
      lastSeen: run.lastSeen,
      lastSeenIso: timestampToIso(run.lastSeen),
      captureCount: run.captureCount,
      mimeType: run.mimeType,
      length: run.length,
      snapshotUrl: waybackCaptureUrl(ctx.config.webArchiveBase, run.firstSeen, url),
    }));

    const structured: Output = {
      url,
      revisions,
      totalRevisions: runs.length,
      distinctDigests: new Set(captures.map((row) => row.digest)).size,
      capturesExamined: captures.length,
      capturesTruncated,
      revisionsTruncated,
      firstCapture: captures[0]?.timestamp ?? null,
      lastCapture: captures[captures.length - 1]?.timestamp ?? null,
    };

    if (revisions.length === 0) {
      return succeed(
        structured,
        summary([
          `No HTTP 200 captures of ${url}${from === undefined && to === undefined ? '' : ' in that date range'}.`,
          'Next: widen from/to, set includeRedirects=true, or run archive_stats to check coverage.',
        ]),
      );
    }

    const lines = [
      `${count(runs.length)} distinct content revision${runs.length === 1 ? '' : 's'} of ${url}`,
      `across ${count(captures.length)} captures${
        structured.firstCapture === null || structured.lastCapture === null
          ? ''
          : ` (${shortDate(structured.firstCapture)} → ${shortDate(structured.lastCapture)})`
      }`,
      '',
      ...revisions.slice(0, TEXT_ROWS).map((row) => {
        const size = Number.parseInt(row.length, 10);
        const sizeLabel = Number.isFinite(size) ? bytes(size) : row.length;
        return `${String(row.revisionIndex).padStart(2)}. ${shortDate(row.firstSeen)} → ${shortDate(row.lastSeen)}  ${String(
          row.captureCount,
        ).padStart(4)} captures  ${sizeLabel.padStart(8)}  ${row.digest.slice(0, 10)}  ts=${row.firstSeen}`;
      }),
    ];
    if (revisions.length > TEXT_ROWS) lines.push(`… ${count(revisions.length - TEXT_ROWS)} more revisions in structuredContent.`);
    if (capturesTruncated) {
      lines.push(
        `Capture list hit maxCaptures=${count(input.maxCaptures)}; narrow from/to (or raise maxCaptures) for complete coverage.`,
      );
    }
    if (revisionsTruncated) lines.push(`Revision list trimmed to ${String(MAX_TABLE_ROWS)} rows.`);

    const first = revisions[0];
    const last = revisions[revisions.length - 1];
    if (first !== undefined && last !== undefined && first.firstSeen !== last.firstSeen) {
      lines.push(
        '',
        `Next: compare_snapshots url="${url}" timestampA="${first.firstSeen}" timestampB="${last.firstSeen}" to diff the oldest against the newest revision.`,
      );
    }

    return succeed(structured, summary(lines));
  },
});
