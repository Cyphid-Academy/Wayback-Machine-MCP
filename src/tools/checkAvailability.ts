import { z } from 'zod';
import { checkAvailabilityInput, checkAvailabilityOutput } from '../schemas.js';
import { checkAvailability } from '../lib/wayback.js';
import { normalizeTargetUrl } from '../lib/urls.js';
import { normalizeTimestamp, timestampToIso, timestampToMillis } from '../lib/timestamps.js';
import { defineTool, fail, succeed, type ToolModule, type WithoutSummary } from './define.js';
import { shortDateTime, summary } from './format.js';

type Input = z.infer<typeof checkAvailabilityInput>;
type Output = z.infer<typeof checkAvailabilityOutput>;
type Structured = WithoutSummary<Output>;

export const checkAvailabilityTool: ToolModule = defineTool<Input, Output>({
  name: 'check_availability',
  title: 'Closest capture to a date',
  description:
'Cheapest possible question: is this URL archived, and what is the nearest capture to a given date? One request, no page content. Use it as a prelude to get_snapshot when you have a date in mind but not a timestamp. The result reports offsetDays — how far the closest capture is from the date you asked for — because this is the tool whose answer everything downstream is built on, and an unnoticed gap here becomes a wrong date later. Note that this endpoint can lag the CDX index: if it reports nothing but you expect captures, confirm with search_snapshots or archive_stats before giving up.',
  annotations: { title: 'Closest capture to a date', readOnlyHint: true, openWorldHint: true },
  input: checkAvailabilityInput,
  output: checkAvailabilityOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;

    let requested: string | undefined;
    if (input.timestamp !== undefined) {
      const parsed = normalizeTimestamp(input.timestamp, 'start');
      if (!parsed.ok) return fail(parsed.failure);
      requested = parsed.value;
    }

    const result = await checkAvailability({ config: ctx.config, upstream: ctx.upstream }, url, requested);
    if (!result.ok) return fail(result.failure);
    const info = result.value;

    // G7: F3's offset reporting applies here too — this tool is the prelude to
    // picking a timestamp, so an unreported gap propagates into everything after it.
    const offsetDays =
      requested === undefined || info.timestamp === undefined
        ? null
        : Math.round((timestampToMillis(info.timestamp) - timestampToMillis(requested)) / 86_400_000);

    const structured: Structured = {
      url,
      available: info.available && info.timestamp !== undefined,
      timestamp: info.timestamp ?? null,
      timestampIso: info.timestamp === undefined ? null : timestampToIso(info.timestamp),
      snapshotUrl: info.snapshotUrl ?? null,
      status: info.status ?? null,
      requestedTimestamp: requested ?? null,
      offsetDays,
    };

    if (!structured.available || info.timestamp === undefined) {
      return succeed(
        structured,
        summary([
          `No capture reported for ${url}${requested === undefined ? '' : ` near ${shortDateTime(requested)}`}.`,
          'The availability API lags for some URLs. Next: search_snapshots (queries the CDX index directly) or archive_stats.',
        ]),
      );
    }

    const gapNotice =
      offsetDays !== null && Math.abs(offsetDays) > 3
        ? `Note: nearest capture to ${(requested ?? '').slice(0, 8)} is ${info.timestamp}, ${String(Math.abs(offsetDays))} day${
            Math.abs(offsetDays) === 1 ? '' : 's'
          } ${offsetDays > 0 ? 'later' : 'earlier'}. There are no captures in between.`
        : '';

    return succeed(
      structured,
      summary([
        gapNotice,
        gapNotice === '' ? '' : '',
        `${url} is archived.`,
        `Closest capture: ${shortDateTime(info.timestamp)} (timestamp ${info.timestamp}, HTTP ${info.status ?? 'unknown'})`,
        info.snapshotUrl === undefined ? '' : `Replay: ${info.snapshotUrl}`,
        '',
        `Next: get_snapshot url="${url}" timestamp="${info.timestamp}" to read it.`,
      ]),
    );
  },
});
