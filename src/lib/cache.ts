/**
 * Cache abstraction. Only an in-memory implementation ships (see README
 * "Limitations" and DECISIONS-MADE.md: archive.org is the durable store, so
 * there is deliberately no database). The async interface exists so a shared
 * backend could be dropped in without touching call sites.
 */
export interface CacheBackend {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
  /** Drops every entry and returns how many were removed. */
  clear(): Promise<number>;
  size(): number;
  bytes(): number;
}

interface Entry {
  readonly value: string;
  readonly expiresAt: number;
  readonly bytes: number;
}

export interface InMemoryCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * FIFO-with-expiry cache. Insertion order (Map order) drives eviction; reads do
 * not promote entries, which keeps behaviour easy to reason about and test.
 */
export class InMemoryCache implements CacheBackend {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private totalBytes = 0;

  constructor(options: InMemoryCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.drop(key, entry);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > this.maxBytes) return;
    const existing = this.entries.get(key);
    if (existing !== undefined) this.drop(key, existing);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  async clear(): Promise<number> {
    const count = this.entries.size;
    this.entries.clear();
    this.totalBytes = 0;
    return count;
  }

  size(): number {
    return this.entries.size;
  }

  bytes(): number {
    return this.totalBytes;
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  private evict(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.drop(key, entry);
    }
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.entries().next();
      if (oldest.done === true) return;
      this.drop(oldest.value[0], oldest.value[1]);
    }
  }
}

/** TTLs are deliberately asymmetric — see §7 of the build spec. */
export const CACHE_TTL = {
  /** Captures are immutable once written. */
  snapshot: 24 * 60 * 60 * 1000,
  /** CDX / availability / sparkline are append-only. */
  index: 60 * 60 * 1000,
  /** Save Page Now job status changes while the job runs. */
  saveStatus: 30 * 1000,
} as const;
