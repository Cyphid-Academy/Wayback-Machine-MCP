import type { z } from 'zod';
import type { Config } from '../config.js';
import { failure, fromUnknown, type Failure } from './errors.js';
import type { CacheBackend } from './cache.js';
import type { RateLimiter } from './ratelimit.js';
import type { Logger } from './log.js';

export interface HttpSuccess {
  readonly ok: true;
  readonly status: number;
  readonly body: string;
  readonly contentType: string | undefined;
  /** Exact bytes read from the wire. The artifact size, as opposed to character count. */
  readonly byteLength: number;
  /** URL after redirects — Wayback redirects to the nearest capture, which we need. */
  readonly finalUrl: string;
  readonly fromCache: boolean;
  /** True when the response body hit the byte cap and was cut short. */
  readonly truncated: boolean;
}

export interface HttpFailure {
  readonly ok: false;
  readonly failure: Failure;
}

export type HttpOutcome = HttpSuccess | HttpFailure;

export type JsonOutcome<T> = { readonly ok: true; readonly value: T; readonly fromCache: boolean } | HttpFailure;

export interface GetOptions {
  readonly ttlMs?: number;
  readonly accept?: string;
  readonly maxBytes?: number;
  /** Extra label used in error messages, e.g. "CDX index". */
  readonly what?: string;
  /** Overrides how long a caller will queue for a rate-limit slot. */
  readonly maxWaitMs?: number;
  /**
   * Shapes failure messages. 'capture' means one specific archived capture, which
   * may simply be unavailable upstream — never blame local networking for that.
   * 'service' means archive.org itself, where a connect failure is meaningful.
   */
  readonly errorSubject?: 'capture' | 'service';
}

export interface PostOptions {
  readonly body: string;
  readonly contentType: string;
  readonly accept?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly what?: string;
}

export interface UpstreamClient {
  get(url: string, options?: GetOptions): Promise<HttpOutcome>;
  post(url: string, options: PostOptions): Promise<HttpOutcome>;
  getJson<T>(url: string, schema: z.ZodType<T>, options?: GetOptions): Promise<JsonOutcome<T>>;
  /** Validates a body already fetched with `get`/`post`, with the same error shape. */
  parseJson<T>(body: string, schema: z.ZodType<T>, fromCache: boolean, what: string): JsonOutcome<T>;
}

export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export interface UpstreamClientDeps {
  readonly config: Config;
  readonly cache: CacheBackend;
  readonly limiter: RateLimiter;
  readonly logger?: Logger;
  readonly fetchImpl?: FetchImpl;
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;
/** One initial attempt plus three retries (F7). */
const MAX_ATTEMPTS = 4;
const BACKOFF_SCHEDULE_MS = [250, 1_000, 3_000];
/**
 * G4: callers queue for a slot rather than being rejected — the server absorbs the
 * throttle as latency instead of handing the caller a failure it could have
 * avoided. Only a projected wait beyond this becomes a `rate_limited` error.
 */
const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number.parseInt(header.trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function charsetOf(contentType: string | undefined): string {
  if (contentType === undefined) return 'utf-8';
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  const label = match?.[1];
  return label === undefined || label.length === 0 ? 'utf-8' : label.toLowerCase();
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** Reads at most `maxBytes`, then abandons the rest instead of buffering a 40MB capture. */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean; byteLength: number }> {
  const label = charsetOf(response.headers.get('content-type') ?? undefined);
  const stream = response.body;
  if (stream === null) {
    const text = await response.text();
    return { body: text, truncated: false, byteLength: Buffer.byteLength(text, 'utf8') };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const next = await reader.read();
    if (next.done === true) break;
    const chunk = next.value;
    if (chunk === undefined) continue;
    if (total + chunk.byteLength > maxBytes) {
      chunks.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
      total = maxBytes;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  return { body: decode(Buffer.concat(chunks), label), truncated, byteLength: total };
}

/**
 * Cache envelope: one metadata line, then the body. Storing the bare body would
 * lose the content type, and a cached HTML capture would then look like opaque
 * bytes on the second request.
 */
function encodeEnvelope(contentType: string | undefined, finalUrl: string, byteLength: number, body: string): string {
  return `${encodeURIComponent(contentType ?? '')} ${encodeURIComponent(finalUrl)} ${String(byteLength)}\n${body}`;
}

function decodeEnvelope(stored: string): {
  contentType: string | undefined;
  finalUrl: string | undefined;
  byteLength: number | undefined;
  body: string;
} {
  const breakAt = stored.indexOf('\n');
  if (breakAt < 0) return { contentType: undefined, finalUrl: undefined, byteLength: undefined, body: stored };
  const [rawType, rawUrl, rawBytes] = stored.slice(0, breakAt).split(' ');
  const contentType = rawType === undefined || rawType.length === 0 ? undefined : decodeURIComponent(rawType);
  const finalUrl = rawUrl === undefined || rawUrl.length === 0 ? undefined : decodeURIComponent(rawUrl);
  const parsedBytes = rawBytes === undefined ? Number.NaN : Number.parseInt(rawBytes, 10);
  return {
    contentType,
    finalUrl,
    byteLength: Number.isFinite(parsedBytes) ? parsedBytes : undefined,
    body: stored.slice(breakAt + 1),
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function hintForStatus(status: number): string {
  if (status === 404) return 'Nothing is archived at that URL/timestamp. Use search_snapshots to see what exists.';
  if (status === 401 || status === 403) {
    return 'archive.org refused the request. If this server runs behind an egress proxy or firewall, check that web.archive.org and archive.org are both allowed.';
  }
  if (status === 400) return 'The Internet Archive rejected the query parameters. Try a simpler query — fewer filters, no collapse.';
  return 'Check the URL and parameters.';
}

/**
 * The single door to archive.org: descriptive User-Agent, per-attempt timeout,
 * token-bucket rate limiting, Retry-After handling, bounded retries and a
 * response cache. Returns outcomes; never throws at the caller.
 */
export class FetchUpstreamClient implements UpstreamClient {
  private readonly config: Config;
  private readonly cache: CacheBackend;
  private readonly limiter: RateLimiter;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: FetchImpl;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * G4: parallel callers asking for the same URL share one upstream request and
   * therefore one rate-limit token, instead of each spending one on the same bytes.
   */
  private readonly inFlight = new Map<string, Promise<HttpOutcome>>();

  constructor(deps: UpstreamClientDeps) {
    this.config = deps.config;
    this.cache = deps.cache;
    this.limiter = deps.limiter;
    this.logger = deps.logger;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async get(url: string, options: GetOptions = {}): Promise<HttpOutcome> {
    const ttlMs = options.ttlMs ?? 0;
    if (ttlMs > 0) {
      const cached = await this.cache.get(url);
      if (cached !== undefined) {
        const envelope = decodeEnvelope(cached);
        return {
          ok: true,
          status: 200,
          body: envelope.body,
          contentType: envelope.contentType,
          byteLength: envelope.byteLength ?? Buffer.byteLength(envelope.body, 'utf8'),
          finalUrl: envelope.finalUrl ?? url,
          fromCache: true,
          truncated: false,
        };
      }
    }

    const pending = this.inFlight.get(url);
    if (pending !== undefined) return pending;

    const attempt = this.requestAndCache(url, ttlMs, options);
    this.inFlight.set(url, attempt);
    try {
      return await attempt;
    } finally {
      this.inFlight.delete(url);
    }
  }

  private async requestAndCache(url: string, ttlMs: number, options: GetOptions): Promise<HttpOutcome> {
    const outcome = await this.request(url, {
      method: 'GET',
      accept: options.accept ?? '*/*',
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      attempts: MAX_ATTEMPTS,
      ...(options.what === undefined ? {} : { what: options.what }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      ...(options.errorSubject === undefined ? {} : { errorSubject: options.errorSubject }),
    });

    if (outcome.ok && ttlMs > 0 && !outcome.truncated) {
      await this.cache.set(
        url,
        encodeEnvelope(outcome.contentType, outcome.finalUrl, outcome.byteLength, outcome.body),
        ttlMs,
      );
    }
    return outcome;
  }

  async post(url: string, options: PostOptions): Promise<HttpOutcome> {
    return this.request(url, {
      method: 'POST',
      accept: options.accept ?? 'application/json',
      body: options.body,
      contentType: options.contentType,
      maxBytes: DEFAULT_MAX_BYTES,
      // A POST to Save Page Now is not idempotent: never replay it.
      attempts: 1,
      ...(options.headers === undefined ? {} : { extraHeaders: options.headers }),
      ...(options.what === undefined ? {} : { what: options.what }),
    });
  }

  async getJson<T>(url: string, schema: z.ZodType<T>, options: GetOptions = {}): Promise<JsonOutcome<T>> {
    const outcome = await this.get(url, { accept: 'application/json', ...options });
    if (!outcome.ok) return outcome;
    return this.parseJson(outcome.body, schema, outcome.fromCache, options.what ?? 'archive.org');
  }

  /** Exposed so POST responses can be validated with the same error shape. */
  parseJson<T>(body: string, schema: z.ZodType<T>, fromCache: boolean, what: string): JsonOutcome<T> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        failure: failure('upstream_error', `${what} returned a response that is not valid JSON.`, {
          hint: 'This is usually a transient archive.org error page. Retry in a moment.',
        }),
      };
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      const where = first === undefined ? 'unknown field' : first.path.join('.') || '(root)';
      return {
        ok: false,
        failure: failure('upstream_error', `${what} returned JSON in an unexpected shape (at ${where}).`, {
          hint: 'The upstream API may have changed. Try a different tool, or report this.',
        }),
      };
    }
    return { ok: true, value: result.data, fromCache };
  }

  private async request(
    url: string,
    options: {
      method: 'GET' | 'POST';
      accept: string;
      maxBytes: number;
      attempts: number;
      body?: string;
      contentType?: string;
      extraHeaders?: Readonly<Record<string, string>>;
      what?: string;
      maxWaitMs?: number;
      errorSubject?: 'capture' | 'service';
    },
  ): Promise<HttpOutcome> {
    const what = options.what ?? 'archive.org';
    const subject = options.errorSubject ?? 'service';
    let lastFailure: Failure | undefined;

    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      const slot = await this.limiter.acquire(options.maxWaitMs ?? MAX_RATE_LIMIT_WAIT_MS);
      if (!slot.ok) {
        const seconds = Math.ceil(slot.retryAfterMs / 1000);
        return {
          ok: false,
          failure: failure(
            'rate_limited',
            `This server's archive.org request budget (${String(this.config.rateLimitPerMinute)}/minute) is saturated: the projected wait is ${String(seconds)}s with ${String(this.limiter.queueDepth())} request(s) already queued.`,
            {
              retryAfterMs: slot.retryAfterMs,
              hint: 'Requests normally queue rather than fail, so this means sustained heavy use. Narrow the query (add from/to, lower limit), avoid parallel calls, or raise ARCHIVE_RPM.',
            },
          ),
        };
      }

      const headers: Record<string, string> = {
        'user-agent': this.config.userAgent,
        accept: options.accept,
        'accept-encoding': 'gzip, deflate',
        ...options.extraHeaders,
      };
      if (options.contentType !== undefined) headers['content-type'] = options.contentType;

      try {
        const response = await this.fetchImpl(url, {
          method: options.method,
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.config.upstreamTimeoutMs),
          ...(options.body === undefined ? {} : { body: options.body }),
        });

        if (response.status === 429 || response.status === 503) {
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          this.limiter.penalize(retryAfterMs ?? 30_000);
          lastFailure = failure('rate_limited', `${what} rate-limited this server (HTTP ${String(response.status)}).`, {
            status: response.status,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
            hint: 'archive.org throttles bursts. Wait and retry, or reduce the size of the query.',
          });
        } else if (!response.ok && isRetryableStatus(response.status)) {
          lastFailure = failure('upstream_error', `${what} returned HTTP ${String(response.status)}.`, {
            status: response.status,
            hint: 'A transient archive.org error. Retrying shortly usually works.',
          });
        } else if (!response.ok) {
          return {
            ok: false,
            failure: failure('upstream_error', `${what} returned HTTP ${String(response.status)}.`, {
              status: response.status,
              hint: hintForStatus(response.status),
            }),
          };
        } else {
          const { body, truncated, byteLength } = await readCapped(response, options.maxBytes);
          return {
            ok: true,
            status: response.status,
            body,
            contentType: response.headers.get('content-type') ?? undefined,
            byteLength,
            finalUrl: response.url.length > 0 ? response.url : url,
            fromCache: false,
            truncated,
          };
        }
      } catch (error) {
        const isAbort = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        if (isAbort) {
          lastFailure = failure(
            'timeout',
            `${what} did not respond within ${String(Math.round(this.config.upstreamTimeoutMs / 1000))}s.`,
            { hint: 'archive.org is slow or the capture is very large. Narrow the query and retry.' },
          );
        } else if (subject === 'capture') {
          // A specific capture failing says nothing about local networking (F7).
          lastFailure = failure('upstream_error', `${what} could not be retrieved from the Wayback Machine.`, {
            hint: 'That capture may be incomplete or unavailable upstream. Other captures of the same URL are usually still reachable — try a neighbouring timestamp.',
          });
        } else {
          lastFailure = failure(
            'network_error',
            `Could not reach ${what}: ${error instanceof Error ? error.message : String(error)}.`,
            { hint: 'This is a connect-level failure against archive.org itself. Check outbound network access from the host running this server.' },
          );
        }
      }

      if (attempt < options.attempts) {
        const scheduled = BACKOFF_SCHEDULE_MS[attempt - 1] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1] ?? 3_000;
        const backoff = lastFailure?.retryAfterMs ?? scheduled;
        this.logger?.warn('upstream retry', { url, attempt, backoffMs: Math.min(backoff, 5_000) });
        await this.sleep(Math.min(backoff, 5_000));
      }
    }

    return { ok: false, failure: lastFailure ?? fromUnknown(new Error('no attempts made'), 'upstream request') };
  }
}
