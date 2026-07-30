import { z } from 'zod';
import { saveStatusResponseSchema, saveSubmitResponseSchema, saveUrlInput, saveUrlOutput } from '../schemas.js';
import { CACHE_TTL } from '../lib/cache.js';
import { failure } from '../lib/errors.js';
import { absoluteUrl, normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { shortDateTime, summary } from './format.js';

type Input = z.infer<typeof saveUrlInput>;
type Output = z.infer<typeof saveUrlOutput>;

/** Poll schedule for waitForCompletion, in milliseconds. Total ~18s. */
const POLL_DELAYS = [3_000, 4_000, 5_000, 6_000];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export const saveUrlTool: ToolModule = defineTool<Input, Output>({
  name: 'save_url',
  title: 'Archive a URL now (Save Page Now)',
  description:
    'Asks the Wayback Machine to capture a URL right now, via Save Page Now, and reports whether the capture succeeded and at what timestamp. This is the only tool here that writes to the Internet Archive: it creates a new public capture of the page. Captures take seconds to minutes, and Save Page Now is rate-limited — use ifNotArchivedWithin (e.g. "1d") to avoid re-capturing something that was just saved, and check with check_availability before calling. Use captureOutlinks sparingly; it multiplies the work.',
  annotations: {
    title: 'Archive a URL now (Save Page Now)',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: saveUrlInput,
  output: saveUrlOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = absoluteUrl(normalized.value);

    const form = new URLSearchParams();
    form.set('url', url);
    if (input.captureScreenshot) form.set('capture_screenshot', '1');
    if (input.captureOutlinks) form.set('capture_outlinks', '1');
    if (input.forceGet) form.set('force_get', '1');
    if (input.delayWbAvailability) form.set('delay_wb_availability', '1');
    if (input.ifNotArchivedWithin !== undefined) form.set('if_not_archived_within', input.ifNotArchivedWithin);
    if (input.jsBehaviorTimeout !== undefined) form.set('js_behavior_timeout', String(input.jsBehaviorTimeout));

    const headers: Record<string, string> = {};
    if (ctx.config.iaAccessKey !== undefined && ctx.config.iaSecretKey !== undefined) {
      headers['authorization'] = `LOW ${ctx.config.iaAccessKey}:${ctx.config.iaSecretKey}`;
    }

    const submitted = await ctx.upstream.post(`${ctx.config.webArchiveBase}/save/`, {
      body: form.toString(),
      contentType: 'application/x-www-form-urlencoded',
      accept: 'application/json',
      headers,
      what: 'Save Page Now',
    });
    if (!submitted.ok) return fail(submitted.failure);

    const parsed = ctx.upstream.parseJson(submitted.body, saveSubmitResponseSchema, false, 'Save Page Now');
    if (!parsed.ok) return fail(parsed.failure);

    const jobId = parsed.value.job_id ?? null;
    const submitMessage = parsed.value.message ?? null;

    if (jobId === null) {
      const detail = submitMessage ?? 'Save Page Now did not return a job id.';
      return fail(
        failure('upstream_error', detail, {
          hint: ctx.config.iaAccessKey === undefined
            ? 'Anonymous Save Page Now quotas are small. Set IA_ACCESS_KEY / IA_SECRET_KEY, or retry later.'
            : 'Check the URL is publicly reachable, or retry with forceGet=true.',
        }),
      );
    }

    const statusUrl = `${ctx.config.webArchiveBase}/save/status/${jobId}`;
    if (!input.waitForCompletion) {
      const structured: Output = {
        url,
        jobId,
        status: 'submitted',
        timestamp: null,
        snapshotUrl: null,
        message: submitMessage,
        statusUrl,
        durationSec: null,
      };
      return succeed(
        structured,
        summary([
          `Save job submitted for ${url}.`,
          `Job id: ${jobId}`,
          'Next: call check_availability in a minute or two to confirm the capture landed.',
        ]),
      );
    }

    let status = 'pending';
    let timestamp: string | null = null;
    let message: string | null = submitMessage;
    let durationSec: number | null = null;

    for (const delay of POLL_DELAYS) {
      await sleep(delay);
      const poll = await ctx.upstream.get(statusUrl, { ttlMs: CACHE_TTL.saveStatus, accept: 'application/json', what: 'the Save Page Now job status' });
      if (!poll.ok) break;
      const state = ctx.upstream.parseJson(poll.body, saveStatusResponseSchema, poll.fromCache, 'the Save Page Now job status');
      if (!state.ok) break;
      status = state.value.status ?? status;
      timestamp = state.value.timestamp ?? timestamp;
      message = state.value.message ?? state.value.exception ?? message;
      durationSec = state.value.duration_sec ?? durationSec;
      if (status === 'success' || status === 'error') break;
    }

    const resolvedStatus: Output['status'] = status === 'success' ? 'success' : status === 'error' ? 'error' : 'pending';
    const structured: Output = {
      url,
      jobId,
      status: resolvedStatus,
      timestamp,
      snapshotUrl: timestamp === null ? null : waybackCaptureUrl(ctx.config.webArchiveBase, timestamp, url),
      message,
      statusUrl,
      durationSec,
    };

    if (resolvedStatus === 'success' && timestamp !== null) {
      return succeed(
        structured,
        summary([
          `Captured ${url}.`,
          `Timestamp ${timestamp} (${shortDateTime(timestamp)})${durationSec === null ? '' : `, took ${String(Math.round(durationSec))}s`}`,
          `Replay: ${structured.snapshotUrl ?? ''}`,
        ]),
      );
    }
    if (resolvedStatus === 'error') {
      return fail(
        failure('upstream_error', `Save Page Now failed for ${url}: ${message ?? 'no reason given'}.`, {
          hint: 'Try forceGet=true, or confirm the page is publicly reachable without JavaScript.',
        }),
      );
    }
    return succeed(
      structured,
      summary([
        `Save job for ${url} is still running after ~18s.`,
        `Job id: ${jobId}`,
        'Next: call check_availability shortly to see whether the capture landed.',
      ]),
    );
  },
});
