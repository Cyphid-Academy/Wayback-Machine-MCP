import { z } from 'zod';
import { archiveStatsInput, archiveStatsOutput, sparklineResponseSchema } from '../schemas.js';
import { CACHE_TTL } from '../lib/cache.js';
import { cdxSearch, statusBreakdown, type StatusBreakdown } from '../lib/wayback.js';
import { normalizeTargetUrl, waybackCalendarUrl } from '../lib/urls.js';
import { timestampToIso } from '../lib/timestamps.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { count, shortDate, summary } from './format.js';

type Input = z.infer<typeof archiveStatsInput>;
type Output = z.infer<typeof archiveStatsOutput>;

const CDX_LIMIT = 10_000;
/** Above this share of redirects, the URL has probably moved (F2). */
const REDIRECT_WARNING_SHARE = 0.2;

function yearBreakdown(byYear: Record<string, number>): string[] {
  const years = Object.keys(byYear).sort();
  if (years.length === 0) return [];
  const parts = years.map((year) => `${year}: ${count(byYear[year] ?? 0)}`);
  const lines: string[] = [];
  for (let index = 0; index < parts.length; index += 6) {
    lines.push(`  ${parts.slice(index, index + 6).join('   ')}`);
  }
  return ['Captures per year:', ...lines];
}

function statusLine(breakdown: StatusBreakdown): string {
  return `  200: ${count(breakdown.ok)}   3xx: ${count(breakdown.redirects)}   4xx: ${count(breakdown.clientErrors)}   5xx: ${count(breakdown.serverErrors)}${
    breakdown.other > 0 ? `   other: ${count(breakdown.other)}` : ''
  }`;
}

export const archiveStatsTool: ToolModule = defineTool<Input, Output>({
  name: 'archive_stats',
  title: 'Archive coverage for a URL',
  description:
    'Recommended first call for any historical investigation. Returns how many Wayback Machine captures exist for a URL, the first and last capture dates, a per-year breakdown, and a breakdown by HTTP status class — so you can see immediately whether the captures are readable pages or just redirects. One cheap request, no page content. Use it to decide whether a URL is worth investigating and to pick from/to bounds before calling the expensive tools (list_revisions, get_snapshot, compare_snapshots). If it reports zero captures, try search_snapshots with matchType "prefix" or "host" before concluding nothing is archived.',
  annotations: { title: 'Archive coverage for a URL', readOnlyHint: true, openWorldHint: true },
  input: archiveStatsInput,
  output: archiveStatsOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;
    const calendarUrl = waybackCalendarUrl(ctx.config.webArchiveBase, url);
    const deps = { config: ctx.config, upstream: ctx.upstream };

    // The CDX index is the primary source because it is the only one that can
    // report per-status counts, which F2 requires. The sparkline is a fallback.
    const rows = await cdxSearch(deps, {
      url,
      matchType: 'exact',
      limit: CDX_LIMIT,
      fields: ['timestamp', 'statuscode'],
    });

    let byYear: Record<string, number> = {};
    let totalCaptures = 0;
    let firstCapture: string | null = null;
    let lastCapture: string | null = null;
    let contentFirst: string | null = null;
    let contentLast: string | null = null;
    let breakdown: StatusBreakdown = { total: 0, ok: 0, redirects: 0, clientErrors: 0, serverErrors: 0, other: 0 };
    let source: 'sparkline' | 'cdx' = 'cdx';
    let capturesTruncated = false;

    if (rows.ok && rows.value.length > 0) {
      breakdown = statusBreakdown(rows.value);
      totalCaptures = rows.value.length;
      capturesTruncated = rows.value.length >= CDX_LIMIT;
      firstCapture = rows.value[0]?.timestamp ?? null;
      lastCapture = rows.value[rows.value.length - 1]?.timestamp ?? null;
      const okRows = rows.value.filter((row) => row.statuscode === '200');
      contentFirst = okRows[0]?.timestamp ?? null;
      contentLast = okRows[okRows.length - 1]?.timestamp ?? null;
      for (const row of rows.value) {
        const year = row.timestamp.slice(0, 4);
        if (year.length !== 4) continue;
        byYear[year] = (byYear[year] ?? 0) + 1;
      }
    } else {
      const sparklineUrl = `${ctx.config.webArchiveBase}/__wb/sparkline?output=json&collection=web&url=${encodeURIComponent(url)}`;
      const sparkline = await ctx.upstream.getJson(sparklineUrl, sparklineResponseSchema, {
        ttlMs: CACHE_TTL.index,
        what: 'the capture-count sparkline',
      });
      const years = sparkline.ok ? sparkline.value.years : undefined;
      if (years !== undefined && Object.keys(years).length > 0) {
        source = 'sparkline';
        byYear = {};
        for (const [year, months] of Object.entries(years)) {
          let yearTotal = 0;
          for (const month of months) {
            const value = typeof month === 'string' ? Number.parseInt(month, 10) : month;
            if (typeof value === 'number' && Number.isFinite(value)) yearTotal += value;
          }
          byYear[year] = yearTotal;
          totalCaptures += yearTotal;
        }
        firstCapture = (sparkline.ok ? sparkline.value.first_ts : undefined) ?? null;
        lastCapture = (sparkline.ok ? sparkline.value.last_ts : undefined) ?? null;
        breakdown = { total: totalCaptures, ok: 0, redirects: 0, clientErrors: 0, serverErrors: 0, other: totalCaptures };
      } else if (!rows.ok) {
        return fail(rows.failure);
      }
    }

    const redirectShare = breakdown.total === 0 ? 0 : breakdown.redirects / breakdown.total;

    const structured: Output = {
      url,
      totalCaptures,
      firstCapture,
      lastCapture,
      firstCaptureIso: firstCapture === null ? null : timestampToIso(firstCapture),
      lastCaptureIso: lastCapture === null ? null : timestampToIso(lastCapture),
      byStatusClass: breakdown,
      contentFirstCapture: contentFirst,
      contentLastCapture: contentLast,
      redirectShare: Math.round(redirectShare * 1000) / 1000,
      byYear,
      source,
      capturesTruncated,
      calendarUrl,
    };

    if (totalCaptures === 0) {
      return succeed(
        structured,
        summary([
          `No captures found for ${url}.`,
          'Next: search_snapshots with matchType "prefix" or "host" to find nearby archived URLs, or check the URL for typos.',
        ]),
      );
    }

    const range =
      firstCapture === null || lastCapture === null ? '' : ` between ${shortDate(firstCapture)} and ${shortDate(lastCapture)}`;
    const lines = [
      url,
      `${count(totalCaptures)}${capturesTruncated ? '+' : ''} captures${range}`,
    ];
    if (source === 'cdx') {
      lines.push(statusLine(breakdown));
      if (breakdown.ok === 0) {
        lines.push('No captures returned HTTP 200 — nothing here is readable page content.');
      } else if (contentFirst !== null && contentLast !== null) {
        lines.push(`Content captures (200 only): ${shortDate(contentFirst)} → ${shortDate(contentLast)}`);
      }
    } else {
      lines.push('  (status breakdown unavailable — counts came from the sparkline endpoint)');
    }
    lines.push(...yearBreakdown(byYear));
    if (redirectShare > REDIRECT_WARNING_SHARE) {
      lines.push(
        '',
        'A large share of captures are redirects — this URL may have moved. Try search_snapshots without a statuscode filter to see the redirect pattern.',
      );
    }
    lines.push(
      '',
      'Next: list_revisions to collapse these captures into distinct content revisions, then compare_snapshots on two of them.',
    );

    return succeed(structured, summary(lines));
  },
});
