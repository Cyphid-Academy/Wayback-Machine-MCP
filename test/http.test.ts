import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { loadConfig, type Config } from '../src/config.js';
import { FetchUpstreamClient, type FetchImpl } from '../src/lib/http.js';
import { InMemoryCache } from '../src/lib/cache.js';
import { InMemoryTokenBucket } from '../src/lib/ratelimit.js';

interface Harness {
  readonly client: FetchUpstreamClient;
  readonly calls: { url: string; init: RequestInit }[];
  readonly cache: InMemoryCache;
  readonly slept: number[];
  readonly config: Config;
}

function harness(
  responder: (url: string, attempt: number) => Response,
  options: { readonly env?: Record<string, string>; readonly rateLimit?: number } = {},
): Harness {
  const config = loadConfig({
    CONTACT_EMAIL: 'bot@example.org',
    DEPLOY_URL: 'https://wayback.example.test',
    MCP_PATH_SECRET: 'secret',
    RATE_LIMIT_PER_MINUTE: String(options.rateLimit ?? 600),
    ...options.env,
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const slept: number[] = [];
  const cache = new InMemoryCache();
  const fetchImpl: FetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, calls.length);
  };
  const client = new FetchUpstreamClient({
    config,
    cache,
    limiter: new InMemoryTokenBucket({
      capacity: options.rateLimit ?? 600,
      refillPerMinute: options.rateLimit ?? 600,
      now: () => 0,
      sleep: async () => {},
    }),
    fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  return { client, calls, cache, slept, config };
}

/** Reads a header from a RequestInit without a type assertion. */
function headerValue(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    return headers.find((entry) => (entry[0] ?? '').toLowerCase() === name)?.[1];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

function ok(body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('FetchUpstreamClient — request shape', () => {
  it('sends the Internet Archive bots-policy User-Agent', async () => {
    const test = harness(() => ok('body'));
    await test.client.get('https://web.archive.org/x');
    const init = test.calls[0]?.init;
    assert.ok(init !== undefined);
    assert.equal(headerValue(init, 'user-agent'), 'wayback-mcp/1.0 (+https://wayback.example.test; bot@example.org)');
  });

  it('applies an abort signal so a hung upstream cannot stall a tool call', async () => {
    const test = harness(() => ok('body'));
    await test.client.get('https://web.archive.org/x');
    assert.ok(test.calls[0]?.init.signal !== undefined, 'every request carries a timeout signal');
  });

  it('reports the exact artifact byte length, not a character count (F6)', async () => {
    // 'Pricing' is 7 chars; the artifact is the whole HTML document.
    const html = '<html><body><h1>Pricing</h1>' + 'x'.repeat(5_000) + '</body></html>';
    const test = harness(() => ok(html, 'text/html'));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.byteLength, Buffer.byteLength(html, 'utf8'));
    assert.ok(result.byteLength > 5_000);
  });

  it('counts bytes rather than characters for multi-byte content (F6)', async () => {
    const text = '日本語のページ';
    const test = harness(() => ok(text, 'text/plain; charset=utf-8'));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.byteLength, 21, 'seven three-byte characters');
    assert.equal(result.body.length, 7);
  });

  it('preserves the byte length through the cache', async () => {
    const html = '<html>' + 'y'.repeat(3_000) + '</html>';
    const test = harness(() => ok(html, 'text/html'));
    await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    const cached = await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    assert.equal(cached.ok && cached.byteLength, Buffer.byteLength(html, 'utf8'));
  });

  it('returns the body, status, content type and final URL', async () => {
    const test = harness(
      () =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    );
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.body, 'hello');
    assert.equal(result.contentType, 'text/html; charset=utf-8');
    assert.equal(result.fromCache, false);
    assert.equal(result.truncated, false);
  });
});

describe('FetchUpstreamClient — caching', () => {
  it('serves a second identical GET from cache without another fetch', async () => {
    const test = harness(() => ok('cached-body'));
    const first = await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    const second = await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    assert.equal(test.calls.length, 1);
    assert.equal(first.ok && first.fromCache, false);
    assert.equal(second.ok && second.fromCache, true);
    assert.equal(second.ok ? second.body : '', 'cached-body');
  });

  it('preserves the content type and final URL through the cache', async () => {
    const test = harness(
      () => new Response('<html>x</html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
    );
    await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    const cached = await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    assert.equal(cached.ok, true);
    if (!cached.ok) return;
    assert.equal(cached.fromCache, true);
    assert.equal(cached.body, '<html>x</html>');
    assert.equal(cached.contentType, 'text/html; charset=utf-8', 'a cached capture must not look like opaque bytes');
    assert.equal(test.calls.length, 1);
  });

  it('round-trips a body containing newlines through the cache envelope', async () => {
    const body = 'line one\nline two\n\nline four';
    const test = harness(() => ok(body));
    await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    const cached = await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    assert.equal(cached.ok && cached.body, body);
  });

  it('does not cache when no TTL is given', async () => {
    const test = harness(() => ok('body'));
    await test.client.get('https://web.archive.org/x');
    await test.client.get('https://web.archive.org/x');
    assert.equal(test.calls.length, 2);
    assert.equal(test.cache.size(), 0);
  });

  it('keys the cache on the full URL', async () => {
    const test = harness((url) => ok(url));
    await test.client.get('https://web.archive.org/a', { ttlMs: 60_000 });
    await test.client.get('https://web.archive.org/b', { ttlMs: 60_000 });
    assert.equal(test.calls.length, 2);
    assert.equal(test.cache.size(), 2);
  });

  it('does not cache an error response', async () => {
    const test = harness(() => new Response('nope', { status: 404 }));
    await test.client.get('https://web.archive.org/x', { ttlMs: 60_000 });
    assert.equal(test.cache.size(), 0);
  });
});

describe('FetchUpstreamClient — failures', () => {
  it('does not retry a 404 and explains what to do instead', async () => {
    const test = harness(() => new Response('missing', { status: 404 }));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'upstream_error');
    assert.equal(result.failure.status, 404);
    assert.match(result.failure.hint ?? '', /search_snapshots/);
    assert.equal(test.calls.length, 1, '404 is not retried');
  });

  it('retries a transient failure on the documented schedule and succeeds later (F7)', async () => {
    const test = harness((_url, attempt) => (attempt < 3 ? new Response('boom', { status: 500 }) : ok('recovered')));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.body, 'recovered');
    assert.equal(test.calls.length, 3);
    assert.deepEqual(test.slept, [250, 1_000], 'backoff is 250ms then 1s');
  });

  it('retries three times before surfacing an error (F7)', async () => {
    const test = harness(() => new Response('boom', { status: 502 }));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, 'upstream_error');
    assert.equal(test.calls.length, 4, 'one attempt plus three retries');
    assert.deepEqual(test.slept, [250, 1_000, 3_000]);
  });

  it('recovers a capture that fails twice then succeeds, without surfacing an error (F7)', async () => {
    const test = harness((_url, attempt) => {
      if (attempt <= 2) throw new TypeError('fetch failed');
      return ok('<html>capture</html>', 'text/html');
    });
    const result = await test.client.get('https://web.archive.org/web/20240326065629id_/https://example.com/', {
      errorSubject: 'capture',
    });
    assert.equal(result.ok, true, 'two transient failures must not kill the call');
    if (result.ok) assert.match(result.body, /capture/);
    assert.equal(test.calls.length, 3);
  });

  it('never blames local networking for one unavailable capture (F7)', async () => {
    const test = harness(() => {
      throw new TypeError('fetch failed');
    });
    const result = await test.client.get('https://web.archive.org/web/1id_/https://example.com/', {
      what: 'Capture 20240326065629 of https://example.com/',
      errorSubject: 'capture',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'upstream_error');
    assert.match(result.failure.message, /could not be retrieved from the Wayback Machine/);
    assert.ok(!/outbound network access/.test(result.failure.hint ?? ''), 'must not blame the local host');
    assert.match(result.failure.hint ?? '', /unavailable upstream|neighbouring timestamp/);
  });

  it('still blames networking when archive.org itself is unreachable (F7)', async () => {
    const test = harness(() => {
      throw new TypeError('fetch failed');
    });
    const result = await test.client.get('https://web.archive.org/cdx/search/cdx', {
      what: 'the CDX capture index',
      errorSubject: 'service',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.code, 'network_error');
      assert.match(result.failure.hint ?? '', /outbound network access/);
    }
  });

  it('honours Retry-After on a 429 and surfaces a rate-limited failure', async () => {
    const test = harness(() => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.code, 'rate_limited');
      assert.equal(result.failure.retryAfterMs, 2_000);
    }
    assert.deepEqual(test.slept, [2_000, 2_000, 2_000], 'backoff follows Retry-After');
  });

  it('reports a timeout as a structured failure rather than throwing', async () => {
    const test = harness(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      throw error;
    });
    const result = await test.client.get('https://web.archive.org/x', { what: 'the CDX capture index' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.code, 'timeout');
      assert.match(result.failure.message, /CDX capture index did not respond within 25s/);
    }
  });

  it('reports a network error as a structured failure', async () => {
    const test = harness(() => {
      throw new TypeError('fetch failed');
    });
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure.code, 'network_error');
  });

  it('queues rather than failing when the budget is momentarily exhausted (G4)', async () => {
    // Budget of 1/minute: the second request has to wait 60s, which is within the
    // queue budget, so the server absorbs it as latency instead of erroring.
    const test = harness(() => ok('body'), { rateLimit: 1 });
    assert.equal((await test.client.get('https://web.archive.org/a')).ok, true);
    const queued = await test.client.get('https://web.archive.org/b');
    assert.equal(queued.ok, true, 'a caller should not absorb a failure the server could absorb as delay');
  });

  it('only reports rate_limited when the projected wait exceeds the queue budget (G4)', async () => {
    const test = harness(() => ok('body'), { rateLimit: 1 });
    await test.client.get('https://web.archive.org/a');
    await test.client.get('https://web.archive.org/b');
    const denied = await test.client.get('https://web.archive.org/c');
    assert.equal(denied.ok, false);
    if (!denied.ok) {
      assert.equal(denied.failure.code, 'rate_limited');
      assert.match(denied.failure.message, /request budget \(1\/minute\) is saturated/);
      assert.match(denied.failure.message, /projected wait is \d+s/);
      assert.ok(denied.failure.retryAfterMs !== undefined);
      assert.match(denied.failure.hint ?? '', /ARCHIVE_RPM/);
    }
  });

  it('shares one upstream request between parallel callers asking for the same URL (G4)', async () => {
    const test = harness(() => ok('shared'));
    const [first, second, third] = await Promise.all([
      test.client.get('https://web.archive.org/same'),
      test.client.get('https://web.archive.org/same'),
      test.client.get('https://web.archive.org/same'),
    ]);
    assert.equal(test.calls.length, 1, 'three callers, one fetch, one rate-limit token');
    for (const result of [first, second, third]) {
      assert.equal(result.ok && result.body, 'shared');
    }
  });

  it('does not conflate different URLs when deduplicating', async () => {
    const test = harness((url) => ok(url));
    const [a, b] = await Promise.all([
      test.client.get('https://web.archive.org/a'),
      test.client.get('https://web.archive.org/b'),
    ]);
    assert.equal(test.calls.length, 2);
    assert.notEqual(a.ok && a.body, b.ok && b.body);
  });
});

describe('FetchUpstreamClient — body handling', () => {
  it('caps a very large body and flags it as truncated', async () => {
    const huge = 'x'.repeat(5_000);
    const test = harness(() => ok(huge));
    const result = await test.client.get('https://web.archive.org/x', { maxBytes: 1_000 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.truncated, true);
    assert.equal(result.body.length, 1_000);
  });

  it('does not cache a truncated body', async () => {
    const test = harness(() => ok('x'.repeat(5_000)));
    await test.client.get('https://web.archive.org/x', { maxBytes: 100, ttlMs: 60_000 });
    assert.equal(test.cache.size(), 0);
  });

  it('decodes a non-UTF-8 charset from the content type', async () => {
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // café in latin-1
    const test = harness(() => new Response(latin, { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1' } }));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.body, 'café');
  });

  it('falls back to UTF-8 for an unknown charset label', async () => {
    const test = harness(() => new Response('plain', { status: 200, headers: { 'content-type': 'text/html; charset=not-a-charset' } }));
    const result = await test.client.get('https://web.archive.org/x');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.body, 'plain');
  });
});

describe('FetchUpstreamClient — JSON', () => {
  const schema = z.object({ value: z.number() });

  it('parses and validates JSON', async () => {
    const test = harness(() => ok('{"value":42}', 'application/json'));
    const result = await test.client.getJson('https://archive.org/x', schema);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, { value: 42 });
  });

  it('reports invalid JSON as an upstream error, not a crash', async () => {
    const test = harness(() => ok('<html>503</html>', 'text/html'));
    const result = await test.client.getJson('https://archive.org/x', schema, { what: 'the availability API' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.failure.code, 'upstream_error');
      assert.match(result.failure.message, /not valid JSON/);
    }
  });

  it('reports a schema mismatch with the offending field', async () => {
    const test = harness(() => ok('{"value":"not a number"}', 'application/json'));
    const result = await test.client.getJson('https://archive.org/x', schema);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.failure.message, /unexpected shape \(at value\)/);
  });
});

describe('FetchUpstreamClient — POST', () => {
  it('sends the body and content type, and never retries', async () => {
    const test = harness(() => new Response('boom', { status: 500 }));
    const result = await test.client.post('https://web.archive.org/save/', {
      body: 'url=https%3A%2F%2Fexample.com',
      contentType: 'application/x-www-form-urlencoded',
      headers: { authorization: 'LOW key:secret' },
    });
    assert.equal(result.ok, false);
    assert.equal(test.calls.length, 1, 'a save request is never replayed');
    const call = test.calls[0];
    assert.equal(call?.init.method, 'POST');
    assert.equal(call?.init.body, 'url=https%3A%2F%2Fexample.com');
  });
});
