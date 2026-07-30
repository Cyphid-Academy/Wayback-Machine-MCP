import { z } from 'zod';
import { compareSnapshotsInput, compareSnapshotsOutput } from '../schemas.js';
import { fetchCaptureText, resolveTimestamp } from '../lib/wayback.js';
import { normalizeTargetUrl, waybackVisualDiffUrl } from '../lib/urls.js';
import { timestampToIso } from '../lib/timestamps.js';
import { DIFF_INLINE_CAP, buildDiff, capText } from '../lib/diff.js';
import { diffResourceUri, resourceLink, type ResourceLinkBlock } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { count, shortDateTime, summary } from './format.js';

type Input = z.infer<typeof compareSnapshotsInput>;
type Output = z.infer<typeof compareSnapshotsOutput>;

export const compareSnapshotsTool: ToolModule = defineTool<Input, Output>({
  name: 'compare_snapshots',
  title: 'Diff two archived captures',
  description:
    'Diffs two captures of the same URL and returns what changed: added/removed character counts, how many sections changed, and a unified diff of the extracted text (capped at 15,000 characters, with a resource link to the full diff if it is longer). Both captures are fetched with the id_ modifier and stripped of navigation chrome first, so the diff shows content changes rather than banner and language-switcher noise. timestampA/timestampB default to the earliest and latest captures and accept "earliest"/"latest" or any date. Pass firstSeen values from list_revisions to diff two specific revisions. If the result says identical, both timestamps resolved to the same capture — pick timestamps from different revisions.',
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
      fetchCaptureText(deps, url, resolvedA.value, 'text'),
      fetchCaptureText(deps, url, resolvedB.value, 'text'),
    ]);
    if (!captureA.ok) return fail(captureA.failure);
    if (!captureB.ok) return fail(captureB.failure);

    const timestampA = captureA.value.timestamp;
    const timestampB = captureB.value.timestamp;
    const diff = buildDiff(captureA.value.text, captureB.value.text, {
      granularity: input.granularity,
      labelA: `${url} @ ${timestampA}`,
      labelB: `${url} @ ${timestampB}`,
    });
    const capped = capText(diff.unified, DIFF_INLINE_CAP);
    const uri = capped.truncated ? diffResourceUri(ctx.config, timestampA, timestampB, url, input.granularity) : null;

    const structured: Output = {
      url,
      timestampA,
      timestampB,
      timestampAIso: timestampToIso(timestampA),
      timestampBIso: timestampToIso(timestampB),
      granularity: input.granularity,
      identical: diff.identical,
      addedChars: diff.addedChars,
      removedChars: diff.removedChars,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      changedSections: diff.changedSections,
      charsA: captureA.value.text.length,
      charsB: captureB.value.text.length,
      diffTotalChars: diff.totalChars,
      truncated: capped.truncated,
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
          size: diff.totalChars,
        }),
      );
    }

    const header = [
      `${url}`,
      `A: ${timestampA} (${shortDateTime(timestampA)}), ${count(structured.charsA)} chars`,
      `B: ${timestampB} (${shortDateTime(timestampB)}), ${count(structured.charsB)} chars`,
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
        links,
      );
    }

    if (diff.identical) {
      return succeed(
        structured,
        summary([
          ...header,
          '',
          'The extracted text of these two captures is identical — the page did not change between them (only chrome or markup may have).',
          'Next: list_revisions groups captures by content digest and will show which captures differ.',
        ]),
        links,
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
          'Next: retry with granularity="line", or compare two captures that are closer together in time.',
        ]),
        links,
      );
    }

    const stats = `+${count(diff.addedChars)} / -${count(diff.removedChars)} characters across ${count(diff.changedSections)} changed section${
      diff.changedSections === 1 ? '' : 's'
    }${input.granularity === 'line' ? ` (+${count(diff.addedLines)} / -${count(diff.removedLines)} lines)` : ''}`;

    return succeed(
      structured,
      [
        ...header,
        stats,
        capped.truncated
          ? `Diff capped at ${count(DIFF_INLINE_CAP)} of ${count(capped.totalChars)} characters; the full diff is behind the resource link below.`
          : '',
        '',
        capped.text,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      links,
    );
  },
});
