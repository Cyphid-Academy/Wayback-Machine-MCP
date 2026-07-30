import { z } from 'zod';
import { compareSnapshotsInput, compareSnapshotsOutput } from '../schemas.js';
import {
  cdxSearch,
  fetchCaptureText,
  nearestAlternatives,
  offsetNotice,
  resolveTimestamp,
  type ResolvedTimestamp,
  type WaybackDeps,
} from '../lib/wayback.js';
import { normalizeTargetUrl, waybackVisualDiffUrl } from '../lib/urls.js';
import { timestampToIso } from '../lib/timestamps.js';
import { buildDiff, capText } from '../lib/diff.js';
import { diffResourceUri, resourceLink, truncationNotice, type ResourceLinkBlock } from '../lib/resources.js';
import { failure, type Failure } from '../lib/errors.js';
import { defineTool, fail, succeed, type ToolModule, type WithoutSummary } from './define.js';
import { count, shortDateTime, summary } from './format.js';

type Input = z.infer<typeof compareSnapshotsInput>;
type Output = z.infer<typeof compareSnapshotsOutput>;
type Structured = WithoutSummary<Output>;

/** Shared with get_snapshot: below this, an HTML capture is probably a shell (G8). */
const SUSPECT_TEXT_CHARS = 200;

export const compareSnapshotsTool: ToolModule = defineTool<Input, Output>({
  name: 'compare_snapshots',
  title: 'Diff two archived captures',
  description:
    'Diffs two captures of the same URL and returns the unified diff itself — inline, in both the text block and the `diff` field of structuredContent — alongside added/removed character counts and how many sections changed (the diff is capped at maxChars, default 15,000, up to 100,000). Both captures are fetched with the id_ modifier and stripped of navigation chrome first, so the diff shows content changes rather than banner and language-switcher noise. timestampA/timestampB default to the earliest and latest captures and accept "earliest"/"latest" or any date; when a date resolves to a capture some days away, the result says so for each endpoint, so a change is never dated to the wrong day. Pass firstSeen values from list_revisions to diff two specific revisions. Identical extracted text with differing CDX digests is a normal, reported outcome: it means the change was in markup, scripts or embedded tokens rather than visible content. Each call spends two capture fetches from the shared archive.org request budget.',
  annotations: { title: 'Diff two archived captures', readOnlyHint: true, openWorldHint: true },
  input: compareSnapshotsInput,
  output: compareSnapshotsOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;
    const deps = { config: ctx.config, upstream: ctx.upstream };

    const [resolvedA, resolvedB] = await Promise.all([
      resolveTimestamp(deps, url, input.timestampA ?? 'earliest'),
      resolveTimestamp(deps, url, input.timestampB ?? 'latest'),
    ]);
    if (!resolvedA.ok) return fail(resolvedA.failure);
    if (!resolvedB.ok) return fail(resolvedB.failure);

    const [captureA, captureB] = await Promise.all([
      fetchCaptureText(deps, url, resolvedA.value.timestamp, 'text'),
      fetchCaptureText(deps, url, resolvedB.value.timestamp, 'text'),
    ]);

    // F7: one unfetchable capture should not dead-end the comparison. Name the
    // endpoint that failed and hand back timestamps the caller can retry with.
    if (!captureA.ok) {
      return fail(await endpointFailure(deps, url, 'A', resolvedA.value.timestamp, resolvedB.value.timestamp, captureA.failure));
    }
    if (!captureB.ok) {
      return fail(await endpointFailure(deps, url, 'B', resolvedB.value.timestamp, resolvedA.value.timestamp, captureB.failure));
    }

    const timestampA = captureA.value.timestamp;
    const timestampB = captureB.value.timestamp;
    const diff = buildDiff(captureA.value.text, captureB.value.text, {
      granularity: input.granularity,
      labelA: `${url} @ ${timestampA}`,
      labelB: `${url} @ ${timestampB}`,
    });
    const capped = capText(diff.unified, input.maxChars);
    const uri = capped.truncated ? diffResourceUri(ctx.resourceBase, timestampA, timestampB, url, input.granularity) : null;
    const artifactBytes = Buffer.byteLength(diff.unified, 'utf8');

    // G8: identical text with differing CDX digests is a real and useful finding —
    // a markup-only change — so look the digests up rather than leaving the caller
    // unable to tell it apart from a broken extraction. One cheap index call, and
    // only when it can change the answer.
    let digestA: string | null = null;
    let digestB: string | null = null;
    if (diff.identical && timestampA !== timestampB) {
      const index = await cdxSearch(deps, {
        url,
        matchType: 'exact',
        from: timestampA < timestampB ? timestampA : timestampB,
        to: timestampA < timestampB ? timestampB : timestampA,
        limit: 500,
        fields: ['timestamp', 'digest'],
      });
      if (index.ok) {
        digestA = index.value.find((row) => row.timestamp === timestampA)?.digest ?? null;
        digestB = index.value.find((row) => row.timestamp === timestampB)?.digest ?? null;
      }
    }
    const markupOnlyChange = diff.identical && digestA !== null && digestB !== null && digestA !== digestB;
    const extractionSuspect =
      (captureA.value.wasHtml && captureA.value.text.length < SUSPECT_TEXT_CHARS) ||
      (captureB.value.wasHtml && captureB.value.text.length < SUSPECT_TEXT_CHARS);

    const structured: Structured = {
      url,
      timestampA,
      timestampB,
      timestampAIso: timestampToIso(timestampA),
      timestampBIso: timestampToIso(timestampB),
      granularity: input.granularity,
      requestedTimestampA: resolvedA.value.requested,
      requestedTimestampB: resolvedB.value.requested,
      offsetDaysA: resolvedA.value.offsetDays,
      offsetDaysB: resolvedB.value.offsetDays,
      identical: diff.identical,
      addedChars: diff.addedChars,
      removedChars: diff.removedChars,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      changedSections: diff.changedSections,
      charsA: captureA.value.text.length,
      charsB: captureB.value.text.length,
      diff: capped.text,
      diffTotalChars: diff.totalChars,
      artifactBytes,
      inlinedChars: capped.text.length,
      maxChars: input.maxChars,
      truncated: capped.truncated,
      digestA,
      digestB,
      markupOnlyChange,
      extractionSuspect,
      resourceUri: uri,
      visualDiffUrl: waybackVisualDiffUrl(ctx.config.webArchiveBase, timestampA, timestampB, url),
      degraded: diff.degraded,
    };

    const links: ResourceLinkBlock[] = [];
    if (uri !== null) {
      links.push(
        resourceLink({
          uri,
          name: `diff ${timestampA}..${timestampB} ${url}`,
          title: `Full ${input.granularity} diff of ${url}`,
          description: `Complete unified diff between the ${shortDateTime(timestampA)} and ${shortDateTime(timestampB)} captures, ${count(diff.totalChars)} characters.`,
          mimeType: 'text/plain',
          size: artifactBytes,
        }),
      );
    }

    const notices = [offsetNotice(resolvedA.value), offsetNotice(resolvedB.value)].filter(
      (line): line is string => line !== undefined,
    );
    const header = [
      ...(notices.length === 0 ? [] : [...notices, '']),
      `${url}`,
      endpointLine('A', resolvedA.value, timestampA, structured.charsA),
      endpointLine('B', resolvedB.value, timestampB, structured.charsB),
      `Visual diff: ${structured.visualDiffUrl}`,
    ];

    if (timestampA === timestampB) {
      return succeed(
        structured,
        summary([
          ...header,
          '',
          'Both timestamps resolved to the same capture, so there is nothing to diff.',
          'Next: call list_revisions and pass firstSeen from two different revisions.',
        ]),
        { links },
      );
    }

    if (diff.identical) {
      return succeed(
        structured,
        summary([
          ...header,
          '',
          markupOnlyChange
            ? 'Extracted text is identical, but the captures have different CDX digests — the change was in markup, scripts or embedded tokens, not visible content.'
            : 'The extracted text of these two captures is identical — the page did not change between them.',
          ...(extractionSuspect
            ? [
                `Caution: one or both captures extracted under ${String(SUSPECT_TEXT_CHARS)} characters of text, so "identical" may mean both are client-rendered shells rather than that the page is unchanged.`,
              ]
            : []),
          'Next: list_revisions groups captures by content and will show which captures differ.',
        ]),
        { links },
      );
    }

    if (diff.degraded) {
      return succeed(
        structured,
        summary([
          ...header,
          '',
          `The diff algorithm timed out on these two captures (${count(structured.charsA)} vs ${count(structured.charsB)} characters).`,
          `Approximate change: ${count(diff.addedChars)} characters added, ${count(diff.removedChars)} removed.`,
          'Next: retry with granularity="line", or compare two captures closer together in time.',
        ]),
        { links },
      );
    }

    const stats = `+${count(diff.addedChars)} / -${count(diff.removedChars)} characters across ${count(diff.changedSections)} changed section${
      diff.changedSections === 1 ? '' : 's'
    }${input.granularity === 'line' ? ` (+${count(diff.addedLines)} / -${count(diff.removedLines)} lines)` : ''}`;

    const notes = [...header, stats];
    if (extractionSuspect) {
      notes.push(
        `Caution: one or both captures extracted under ${String(SUSPECT_TEXT_CHARS)} characters of text — this page may render client-side, so the diff covers only the shell.`,
      );
    }
    if (capped.truncated) notes.push(truncationNotice(capped.text.length, capped.totalChars));

    // G2: the diff is the payload. It was previously computed, counted and dropped.
    return succeed(structured, notes.join('\n'), { payload: capped.text, links });
  },
});

/**
 * Turns one endpoint's fetch failure into an actionable error: which endpoint,
 * that the other one was fine (so it is not a connectivity problem), and the
 * three nearest captures to retry with (F7).
 */
async function endpointFailure(
  deps: WaybackDeps,
  url: string,
  label: string,
  badTimestamp: string,
  goodTimestamp: string,
  original: Failure,
): Promise<Failure> {
  const alternatives = await nearestAlternatives(deps, url, badTimestamp, [goodTimestamp]);
  return failure(original.code, `Capture ${badTimestamp} (endpoint ${label}) could not be retrieved: ${original.message}`, {
    hint:
      alternatives.length === 0
        ? 'Run search_snapshots to pick another timestamp for that endpoint.'
        : `Nearest usable alternatives: ${alternatives.join(', ')}. The other endpoint (${goodTimestamp}) fetched fine, so this is that one capture rather than a connectivity problem.`,
  });
}

function endpointLine(label: string, resolved: ResolvedTimestamp, actual: string, chars: number): string {
  const requestedDiffers = resolved.offsetDays !== null && resolved.requested.slice(0, 8) !== actual.slice(0, 8);
  const requested = requestedDiffers ? ` (requested ${resolved.requested.slice(0, 8)})` : '';
  return `${label}: ${actual} (${shortDateTime(actual)})${requested}, ${count(chars)} chars`;
}
