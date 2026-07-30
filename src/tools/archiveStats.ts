import { z } from 'zod';
import { archiveStatsInput, archiveStatsOutput, sparklineResponseSchema } from '../schemas.js';
import { CACHE_TTL } from '../lib/cache.js';
import { cdxSearch } from '../lib/wayback.js';
import { normalizeTargetUrl, waybackCalendarUrl } from '../lib/urls.js';
import { timestampToIso } from '../lib/timestamps.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { count, shortDate, summary } from './format.js';

type Input = z.infer<typeof archiveStatsInput>;
type Output = z.infer<typeof archiveStatsOutput>;

const CDX_FALLBACK_LIMIT = 10_000;

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

export const archiveStatsTool: ToolModule = defineTool<Input, Output>({
  name: 'archive_stats',
  title: 'Archive coverage for a URL',
  description:
    'Recommended first call for any historical investigation. Returns how many Wayback Machine captures exist for a URL, the first and last capture dates, and a per-year breakdown — one cheap request, no page content. Use it to decide whether a URL is worth investigating and to pick sensible from/to bounds before calling the expensive tools (list_revisions, get_snapshot, compare_snapshots). If it reports zero captures, try search_snapshots with matchType "prefix" or "host" before concluding nothing is archived.',
  annotations: { title: 'Archive coverage for a URL', readOnlyHint: true, openWorldHint: true },
  input: archiveStatsInput,
  output: archiveStatsOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;
    const calendarUrl = waybackCalendarUrl(ctx.config.webArchiveBase, url);

    const sparklineUrl = `${ctx.config.webArchiveBase}/__wb/sparkline?output=json&collection=web&url=${encodeURIComponent(url)}`;
    const sparkline = await ctx.upstream.getJson(sparklineUrl, sparklineResponseSchema, {
      ttlMs: CACHE_TTL.index,
      what: 'the capture-count sparkline',
    });

    let byYear: Record<string, number> = {};
    let totalCaptures = 0;
    let firstCapture: string | null = null;
    let lastCapture: string | null = null;
    let source: 'sparkline' | 'cdx' = 'sparkline';
    let capsHit = false;

    const years = sparkline.ok ? sparkline.value.years : undefined;
    if (years !== undefined && Object.keys(years).length > 0) {
      for (const [year, months] of Object.entries(years)) {
        let yearTotal = 0;
        for (const month of months) {
          const value = typeof month === 'string' ? Number.parseInt(month, 10) : month;
          if (typeof value === 'number' && Number.isFinite(value)) yearTotal += value;
        }
        byYear[year] = yearTotal;
        totalCaptures += yearTotal;
      }
      const firstTs = sparkline.ok ? sparkline.value.first_ts : undefined;
      const lastTs = sparkline.ok ? sparkline.value.last_ts : undefined;
      firstCapture = firstTs ?? null;
      lastCapture = lastTs ?? null;
    } else {
      // Sparkline unavailable or empty: count from the CDX index instead.
      source = 'cdx';
      const rows = await cdxSearch(
        { config: ctx.config, upstream: ctx.upstream },
        { url, matchType: 'exact', limit: CDX_FALLBACK_LIMIT, fields: ['timestamp'] },
      );
      if (!rows.ok) {
        // Report the sparkline failure if that is what actually broke first.
        return fail(sparkline.ok ? rows.failure : sparkline.failure);
      }
      byYear = {};
      for (const row of rows.value) {
        const year = row.timestamp.slice(0, 4);
        if (year.length !== 4) continue;
        byYear[year] = (byYear[year] ?? 0) + 1;
      }
      totalCaptures = rows.value.length;
      capsHit = rows.value.length >= CDX_FALLBACK_LIMIT;
      firstCapture = rows.value[0]?.timestamp ?? null;
      lastCapture = rows.value[rows.value.length - 1]?.timestamp ?? null;
    }

    const structured: Output = {
      url,
      totalCaptures,
      firstCapture,
      lastCapture,
      firstCaptureIso: firstCapture === null ? null : timestampToIso(firstCapture),
      lastCaptureIso: lastCapture === null ? null : timestampToIso(lastCapture),
      byYear,
      source,
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
      firstCapture === null || lastCapture === null
        ? ''
        : ` between ${shortDate(firstCapture)} and ${shortDate(lastCapture)}`;
    return succeed(
      structured,
      summary([
        url,
        `${count(totalCaptures)}${capsHit ? '+' : ''} captures${range} (source: ${source})`,
        ...yearBreakdown(byYear),
        '',
        'Next: list_revisions to collapse these captures into distinct content revisions, then compare_snapshots on two of them.',
      ]),
    );
  },
});
