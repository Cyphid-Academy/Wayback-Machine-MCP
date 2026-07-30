import { z } from 'zod';
import { listRevisionsInput, listRevisionsOutput } from '../schemas.js';
import {
  cdxSearch,
  describeUnreadable,
  evenlySpaced,
  fetchCaptureText,
  statusBreakdown,
  textDigest,
} from '../lib/wayback.js';
import { groupRevisions, type CdxRow } from '../lib/cdx.js';
import { failure } from '../lib/errors.js';
import { normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { normalizeTimestamp, timestampToIso } from '../lib/timestamps.js';
import { MAX_TABLE_ROWS } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { bytes, count, shortDate, summary } from './format.js';

type Input = z.infer<typeof listRevisionsInput>;
type Output = z.infer<typeof listRevisionsOutput>;
type Row = z.infer<typeof listRevisionsOutput>['revisions'][number];

const TEXT_ROWS = 20;
/**
 * At or above this ratio of distinct digests to captures, the CDX digests are
 * noise rather than signal — the page embeds a build hash or per-request nonce (F4).
 */
const NOISE_RATIO = 0.9;
/** Hard ceiling on capture fetches in text-digest mode, per F4. */
const MAX_TEXT_SAMPLES = 24;
/** Wall-clock budget for the sampling pass, so a handler cannot run away. */
const SAMPLING_BUDGET_MS = 120_000;
/** Sampling fetches may queue longer than a normal call for a rate-limit slot. */
const SAMPLE_WAIT_MS = 45_000;

export const listRevisionsTool: ToolModule = defineTool<Input, Output>({
  name: 'list_revisions',
  title: 'Distinct content revisions of a URL',
  description:
    'Turns hundreds of captures into the handful of times a page actually changed, and is the tool for reconstructing the edit history of a page rewritten in place at a stable URL. It first groups captures by the CDX content digest, which is free and exact — that works on server-rendered static pages. Many modern pages defeat it: a Next.js build hash or an embedded per-request nonce changes the digest on every capture even when the visible text is identical. When that is detected the tool automatically falls back to sampling up to 24 evenly-spaced captures, extracting and hashing the readable text of each, and grouping on that instead; revision boundaries are then accurate to the sampling interval rather than to the day, and narrowing from/to and re-running sharpens a boundary. The output always states which method produced it, how many captures were examined and how many were excluded. Feed two firstSeen values to compare_snapshots.',
  annotations: { title: 'Distinct content revisions of a URL', readOnlyHint: true, openWorldHint: true },
  input: listRevisionsInput,
  output: listRevisionsOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;
    const deps = { config: ctx.config, upstream: ctx.upstream };

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

    // Fetched unfiltered so the tool can report what it excluded rather than
    // letting counts silently disagree with archive_stats (F2).
    const result = await cdxSearch(deps, {
      url,
      matchType: 'exact',
      limit: input.maxCaptures + 1,
      resolveRevisits: true,
      fields: ['timestamp', 'digest', 'mimetype', 'length', 'statuscode'],
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    if (!result.ok) return fail(result.failure);

    const capturesTruncated = result.value.length > input.maxCaptures;
    const allCaptures = result.value.slice(0, input.maxCaptures).filter((row) => row.timestamp.length > 0);
    const breakdown = statusBreakdown(allCaptures);
    const captures = input.includeRedirects ? allCaptures : allCaptures.filter((row) => row.statuscode === '200');
    const excluded = allCaptures.length - captures.length;

    if (captures.length === 0) {
      if (allCaptures.length > 0) return fail(describeUnreadable(url, breakdown));
      return succeed(
        emptyOutput(url, allCaptures.length, excluded, capturesTruncated),
        summary([
          `No captures of ${url}${from === undefined && to === undefined ? '' : ' in that date range'}.`,
          'Next: widen from/to, or run archive_stats to check coverage.',
        ]),
      );
    }

    const digestRuns = groupRevisions(captures);
    const distinctDigests = new Set(captures.map((row) => row.digest)).size;
    const digestRatio = captures.length === 0 ? 0 : distinctDigests / captures.length;
    const digestsAreNoise = digestRatio >= NOISE_RATIO && captures.length > 3;
    const useText = input.method === 'text' || (input.method === 'auto' && digestsAreNoise);

    const excludedReason = excluded === 0 ? null : 'not status 200';
    const exclusionLine =
      excluded === 0
        ? `${count(captures.length)} captures examined`
        : `${count(captures.length)} of ${count(allCaptures.length)} captures examined (${count(excluded)} excluded: not status 200)`;

    if (!useText) {
      const runs = digestRuns;
      const revisions = toRows(ctx.config.webArchiveBase, url, runs);
      const structured: Output = {
        url,
        revisions: revisions.slice(0, MAX_TABLE_ROWS),
        totalRevisions: runs.length,
        distinctDigests,
        capturesExamined: captures.length,
        method: 'digest',
        capturesTotal: allCaptures.length,
        capturesExcluded: excluded,
        excludedReason,
        digestRatio: Math.round(digestRatio * 1000) / 1000,
        capturesSampled: 0,
        capturesTruncated,
        revisionsTruncated: runs.length > MAX_TABLE_ROWS,
        firstCapture: captures[0]?.timestamp ?? null,
        lastCapture: captures[captures.length - 1]?.timestamp ?? null,
      };
      const lines = [
        `${count(runs.length)} distinct content revision${runs.length === 1 ? '' : 's'} of ${url}`,
        exclusionLine,
        rangeLine(structured.firstCapture, structured.lastCapture),
      ];
      // Leads rather than trails: the summary is trimmed from the end, and a
      // caveat that gets cut off is worse than useless.
      if (digestsAreNoise) {
        lines.push(
          '',
          `Warning: ${count(distinctDigests)}/${count(captures.length)} digests are distinct, so this page probably embeds per-request tokens and these "revisions" are mostly noise. Re-run with method="text" (or "auto") for sampled text digesting.`,
        );
      }
      lines.push('', ...revisionLines(revisions));
      if (capturesTruncated) {
        lines.push(`Capture list hit maxCaptures=${count(input.maxCaptures)}; narrow from/to for complete coverage.`);
      }
      lines.push(...nextStep(revisions, url));
      return succeed(structured, summary(lines));
    }

    // ---- text-digest mode (F4) ----------------------------------------------
    const sample = evenlySpaced(captures, MAX_TEXT_SAMPLES);
    const deadline = Date.now() + SAMPLING_BUDGET_MS;
    const hashed: CdxRow[] = [];
    let failedFetches = 0;

    for (const capture of sample) {
      if (Date.now() > deadline) break;
      const text = await fetchCaptureText(deps, url, capture.timestamp, 'text', { maxWaitMs: SAMPLE_WAIT_MS });
      if (!text.ok) {
        failedFetches += 1;
        continue;
      }
      hashed.push({ ...capture, digest: textDigest(text.value.text) });
    }

    if (hashed.length === 0) {
      return fail(
        failure('upstream_error', `None of the ${count(sample.length)} sampled captures of ${url} could be fetched.`, {
          hint: 'archive.org may be refusing capture fetches right now. Retry shortly, or use method="digest" to group on the CDX index alone.',
        }),
      );
    }

    const runs = groupRevisions(hashed);
    const revisions = toRows(ctx.config.webArchiveBase, url, runs);
    const structured: Output = {
      url,
      revisions: revisions.slice(0, MAX_TABLE_ROWS),
      totalRevisions: runs.length,
      distinctDigests: new Set(hashed.map((row) => row.digest)).size,
      capturesExamined: captures.length,
      method: 'text',
      capturesTotal: allCaptures.length,
      capturesExcluded: excluded,
      excludedReason,
      digestRatio: Math.round(digestRatio * 1000) / 1000,
      capturesSampled: hashed.length,
      capturesTruncated,
      revisionsTruncated: runs.length > MAX_TABLE_ROWS,
      firstCapture: hashed[0]?.timestamp ?? null,
      lastCapture: hashed[hashed.length - 1]?.timestamp ?? null,
    };

    const lines = [
      `${count(runs.length)} distinct content revision${runs.length === 1 ? '' : 's'} of ${url}`,
      exclusionLine,
      rangeLine(structured.firstCapture, structured.lastCapture),
      '',
      `CDX digests were unusable (${count(distinctDigests)}/${count(captures.length)} distinct — this page embeds per-request tokens). Fell back to text-digest mode over ${count(hashed.length)} evenly-spaced captures. Revision boundaries are accurate to the sampling interval, not to the day. Narrow from/to and re-run to sharpen a boundary.`,
      '',
      ...revisionLines(revisions),
    ];
    if (failedFetches > 0) {
      lines.push(`${count(failedFetches)} sampled capture${failedFetches === 1 ? '' : 's'} could not be fetched and were skipped.`);
    }
    if (hashed.length < sample.length - failedFetches) {
      lines.push('Sampling stopped early on its time budget; raise RATE_LIMIT_PER_MINUTE or narrow from/to for a finer sample.');
    }
    if (capturesTruncated) {
      lines.push(`Capture list hit maxCaptures=${count(input.maxCaptures)}; narrow from/to for complete coverage.`);
    }
    lines.push(...nextStep(revisions, url));

    return succeed(structured, summary(lines));
  },
});

function rangeLine(first: string | null, last: string | null): string {
  if (first === null || last === null) return '';
  return `Range: ${shortDate(first)} → ${shortDate(last)}`;
}

function toRows(
  archiveBase: string,
  url: string,
  runs: readonly { revisionIndex: number; digest: string; firstSeen: string; lastSeen: string; captureCount: number; mimeType: string; length: string }[],
): Row[] {
  return runs.map((run) => ({
    revisionIndex: run.revisionIndex,
    digest: run.digest,
    firstSeen: run.firstSeen,
    firstSeenIso: timestampToIso(run.firstSeen),
    lastSeen: run.lastSeen,
    lastSeenIso: timestampToIso(run.lastSeen),
    captureCount: run.captureCount,
    mimeType: run.mimeType,
    length: run.length,
    snapshotUrl: waybackCaptureUrl(archiveBase, run.firstSeen, url),
  }));
}

function revisionLines(revisions: readonly Row[]): string[] {
  const lines = revisions.slice(0, TEXT_ROWS).map((row) => {
    const size = Number.parseInt(row.length, 10);
    const sizeLabel = Number.isFinite(size) ? bytes(size) : row.length;
    return `${String(row.revisionIndex).padStart(2)}. ${shortDate(row.firstSeen)} → ${shortDate(row.lastSeen)}  ${String(
      row.captureCount,
    ).padStart(4)} captures  ${sizeLabel.padStart(8)}  ${row.digest.slice(0, 10)}  ts=${row.firstSeen}`;
  });
  if (revisions.length > TEXT_ROWS) lines.push(`… ${count(revisions.length - TEXT_ROWS)} more revisions in structuredContent.`);
  return lines;
}

function nextStep(revisions: readonly Row[], url: string): string[] {
  const first = revisions[0];
  const last = revisions[revisions.length - 1];
  if (first === undefined || last === undefined || first.firstSeen === last.firstSeen) return [];
  return [
    '',
    `Next: compare_snapshots url="${url}" timestampA="${first.firstSeen}" timestampB="${last.firstSeen}" to diff the oldest against the newest revision.`,
  ];
}

function emptyOutput(url: string, total: number, excluded: number, capturesTruncated: boolean): Output {
  return {
    url,
    revisions: [],
    totalRevisions: 0,
    distinctDigests: 0,
    capturesExamined: 0,
    method: 'digest',
    capturesTotal: total,
    capturesExcluded: excluded,
    excludedReason: excluded === 0 ? null : 'not status 200',
    digestRatio: 0,
    capturesSampled: 0,
    capturesTruncated,
    revisionsTruncated: false,
    firstCapture: null,
    lastCapture: null,
  };
}
