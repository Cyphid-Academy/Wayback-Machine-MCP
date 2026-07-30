import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CACHE_TTL, InMemoryCache } from '../src/lib/cache.js';
import { InMemoryTokenBucket } from '../src/lib/ratelimit.js';

describe('InMemoryCache', () => {
  it('stores and returns a value', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'v', 1_000);
    assert.equal(await cache.get('k'), 'v');
    assert.equal(cache.size(), 1);
  });

  it('expires entries once the TTL has passed', async () => {
    let now = 1_000;
    const cache = new InMemoryCache({ now: () => now });
    await cache.set('k', 'v', 500);
    now = 1_400;
    assert.equal(await cache.get('k'), 'v');
    now = 1_500;
    assert.equal(await cache.get('k'), undefined, 'expiry is inclusive');
    assert.equal(cache.size(), 0, 'the expired entry is dropped on read');
  });

  it('ignores a non-positive TTL', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'v', 0);
    assert.equal(await cache.get('k'), undefined);
  });

  it('evicts oldest entries when over the entry limit', async () => {
    const cache = new InMemoryCache({ maxEntries: 3 });
    for (const key of ['a', 'b', 'c', 'd']) await cache.set(key, key, 10_000);
    assert.equal(cache.size(), 3);
    assert.equal(await cache.get('a'), undefined, 'first inserted is evicted first');
    assert.equal(await cache.get('d'), 'd');
  });

  it('evicts when over the byte budget and refuses oversized values', async () => {
    const cache = new InMemoryCache({ maxBytes: 100 });
    await cache.set('a', 'x'.repeat(60), 10_000);
    await cache.set('b', 'y'.repeat(60), 10_000);
    assert.equal(await cache.get('a'), undefined);
    assert.equal(await cache.get('b'), 'y'.repeat(60));
    await cache.set('big', 'z'.repeat(500), 10_000);
    assert.equal(await cache.get('big'), undefined, 'a value larger than the budget is not stored');
  });

  it('tracks byte usage and releases it on overwrite and clear', async () => {
    const cache = new InMemoryCache();
    await cache.set('k', 'abcde', 10_000);
    assert.equal(cache.bytes(), 5);
    await cache.set('k', 'ab', 10_000);
    assert.equal(cache.bytes(), 2, 'overwriting releases the previous value');
    assert.equal(await cache.clear(), 1);
    assert.equal(cache.bytes(), 0);
    assert.equal(cache.size(), 0);
  });

  it('uses the asymmetric TTLs from the build spec', () => {
    assert.equal(CACHE_TTL.snapshot, 24 * 60 * 60 * 1000);
    assert.equal(CACHE_TTL.index, 60 * 60 * 1000);
    assert.equal(CACHE_TTL.saveStatus, 30 * 1000);
  });
});

describe('InMemoryTokenBucket', () => {
  it('grants immediately while tokens remain', async () => {
    const bucket = new InMemoryTokenBucket({ capacity: 3, refillPerMinute: 3, now: () => 0, sleep: async () => {} });
    for (let index = 0; index < 3; index += 1) {
      const outcome = await bucket.acquire(0);
      assert.equal(outcome.ok, true);
      if (outcome.ok) assert.equal(outcome.waitedMs, 0);
    }
  });

  it('denies rather than throwing when the wait exceeds the budget', async () => {
    const bucket = new InMemoryTokenBucket({ capacity: 1, refillPerMinute: 1, now: () => 0, sleep: async () => {} });
    assert.equal((await bucket.acquire(0)).ok, true);
    const denied = await bucket.acquire(1_000);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.ok(denied.retryAfterMs > 1_000, 'reports how long to wait');
  });

  it('waits for capacity when the wait fits the budget', async () => {
    const slept: number[] = [];
    const bucket = new InMemoryTokenBucket({
      capacity: 1,
      refillPerMinute: 60,
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    assert.equal((await bucket.acquire(0)).ok, true);
    const waited = await bucket.acquire(5_000);
    assert.equal(waited.ok, true);
    assert.deepEqual(slept, [1_000], 'one token per second at 60/minute');
  });

  it('queues concurrent callers instead of over-issuing the same token', async () => {
    const slept: number[] = [];
    const bucket = new InMemoryTokenBucket({
      capacity: 1,
      refillPerMinute: 60,
      now: () => 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    const outcomes = await Promise.all([bucket.acquire(10_000), bucket.acquire(10_000), bucket.acquire(10_000)]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.ok),
      [true, true, true],
    );
    assert.deepEqual(slept, [1_000, 2_000], 'each caller sleeps off its own deficit');
  });

  it('refills over time up to capacity', async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucket({ capacity: 2, refillPerMinute: 60, now: () => now, sleep: async () => {} });
    assert.equal((await bucket.acquire(0)).ok, true);
    assert.equal((await bucket.acquire(0)).ok, true);
    assert.equal((await bucket.acquire(0)).ok, false);
    now = 2_000;
    assert.equal((await bucket.acquire(0)).ok, true);
    now = 600_000;
    assert.ok(bucket.available() <= 2, 'never exceeds capacity');
  });

  it('blocks new requests for the penalty window after a 429', async () => {
    let now = 0;
    const bucket = new InMemoryTokenBucket({ capacity: 5, refillPerMinute: 60, now: () => now, sleep: async () => {} });
    bucket.penalize(30_000);
    const denied = await bucket.acquire(1_000);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.retryAfterMs, 30_000);
    now = 30_000;
    assert.equal((await bucket.acquire(0)).ok, true);
  });
});
