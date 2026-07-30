import { z } from 'zod';
import { listScreenshotsInput, listScreenshotsOutput } from '../schemas.js';
import { cdxSearch } from '../lib/wayback.js';
import { absoluteUrl, normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { normalizeTimestamp, timestampToIso } from '../lib/timestamps.js';
import { MAX_TABLE_ROWS } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule, type WithoutSummary } from './define.js';
import { count, shortDateTime, summary } from './format.js';

type Input = z.infer<typeof listScreenshotsInput>;
type Output = z.infer<typeof listScreenshotsOutput>;
type Structured = WithoutSummary<Output>;
type Row = z.infer<typeof listScreenshotsOutput>['screenshots'][number];

const TEXT_ROWS = 12;

export const listScreenshotsTool: ToolModule = defineTool<Input, Output>({
  name: 'list_screenshots',
  title: 'Screenshot captures for a URL',
  description:
'Experimental. Lists page-screenshot captures the Wayback Machine holds for a URL, returning timestamps and image URLs only — never image bytes. Screenshots exist only for pages saved through Save Page Now with the screenshot option, so almost every URL has none, and `indexStatus` distinguishes "the index answered and holds none" from "the index could not be queried". Marked experimental because no URL with a screenshot capture has been found to verify a non-empty result against; treat a non-empty result as unproven. Use get_snapshot for page content.',
  annotations: { title: 'Screenshot captures for a URL', readOnlyHint: true, openWorldHint: true },
  input: listScreenshotsInput,
  output: listScreenshotsOutput,
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

    // Screenshots are indexed under a `screenshot:` pseudo-URL in the CDX index.
    const screenshotKey = `screenshot:${absoluteUrl(url)}`;
    const result = await cdxSearch(
      { config: ctx.config, upstream: ctx.upstream },
      {
        url: screenshotKey,
        matchType: 'exact',
        limit: Math.min(input.limit, MAX_TABLE_ROWS) + 1,
        ...(from === undefined ? {} : { from }),
        ...(to === undefined ? {} : { to }),
      },
    );
    // G9: an index that could not be queried is not the same as an index with no
    // screenshots, and returning [] for both hides a broken query.
    if (!result.ok) {
      const structured: Structured = { url, screenshots: [], totalReturned: 0, hasMore: false, indexStatus: 'unavailable' };
      return succeed(
        structured,
        summary([
          `The screenshot index could not be queried for ${url}: ${result.failure.message}`,
          'This is not the same as "no screenshots exist" — the query itself failed. Retry, or check archive.org availability.',
        ]),
      );
    }

    const limit = Math.min(input.limit, MAX_TABLE_ROWS);
    const hasMore = result.value.length > limit;
    const screenshots: Row[] = result.value.slice(0, limit).map((row) => ({
      timestamp: row.timestamp,
      timestampIso: timestampToIso(row.timestamp),
      mimetype: row.mimetype,
      length: row.length,
      screenshotUrl: waybackCaptureUrl(ctx.config.webArchiveBase, row.timestamp, screenshotKey),
      imageUrl: waybackCaptureUrl(ctx.config.webArchiveBase, row.timestamp, screenshotKey, 'im_'),
    }));

    const structured: Structured = {
      url,
      screenshots,
      totalReturned: screenshots.length,
      hasMore,
      indexStatus: screenshots.length === 0 ? 'none' : 'ok',
    };

    if (screenshots.length === 0) {
      return succeed(
        structured,
        summary([
          `No screenshot captures indexed for ${url}. The index answered; it holds none.`,
          'This is the normal result for almost every URL: screenshots exist only for pages saved via Save Page Now with the screenshot option enabled.',
          'Next: get_snapshot for the page content, or list_revisions for its change history.',
        ]),
      );
    }

    const lines = [
      `${count(screenshots.length)} screenshot capture${screenshots.length === 1 ? '' : 's'} of ${url}`,
      '',
      ...screenshots.slice(0, TEXT_ROWS).map((row) => `${row.timestamp}  ${shortDateTime(row.timestamp)}  ${row.mimetype}  ${row.imageUrl}`),
    ];
    if (screenshots.length > TEXT_ROWS) lines.push(`… ${count(screenshots.length - TEXT_ROWS)} more in structuredContent.`);
    if (hasMore) lines.push('More screenshots exist; raise limit or narrow from/to.');

    return succeed(structured, summary(lines));
  },
});
