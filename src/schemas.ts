import { z } from 'zod';

/**
 * Every tool's input and output shape. Zod is the single source of truth: the MCP
 * `inputSchema` and `outputSchema` are both derived from these, and the same
 * objects validate the values at runtime.
 */

export interface JsonSchemaObject {
  readonly type: 'object';
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
}

/** Derives a draft-07 JSON Schema object from a Zod schema. */
export function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaObject {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-7',
    io,
    unrepresentable: 'any',
    reused: 'inline',
  });
  const { $schema: _ignored, ...rest } = generated;
  return { ...rest, type: 'object' };
}

// ---------------------------------------------------------------------------
// Shared field definitions
// ---------------------------------------------------------------------------

/**
 * Present on every tool output. Some clients surface only `structuredContent`
 * and drop text blocks, so the human-readable summary is carried here too —
 * anything a caller must act on must be reachable from this channel (G0).
 */
const summaryField = {
  summary: z
    .string()
    .describe('Human-readable summary of this result, identical to the text block. Read this first.'),
};

const urlField = z
  .string()
  .min(1)
  .describe('Target URL. The scheme is optional: "example.com/page" and "https://example.com/page" both work.');

const dateField = z
  .string()
  .min(4)
  .describe('Date bound. Accepts YYYY, YYYYMM, YYYYMMDD, YYYY-MM-DD or a full YYYYMMDDhhmmss Wayback timestamp.');

const matchTypeField = z
  .enum(['exact', 'prefix', 'host', 'domain'])
  .describe(
    'exact = that one URL; prefix = that URL and everything under it; host = the whole host; domain = the host and its subdomains.',
  );

// ---------------------------------------------------------------------------
// archive_stats
// ---------------------------------------------------------------------------

export const archiveStatsInput = z.object({ url: urlField });

export const statusBreakdownSchema = z.object({
  total: z.number(),
  ok: z.number(),
  redirects: z.number(),
  clientErrors: z.number(),
  serverErrors: z.number(),
  other: z.number(),
});

export const archiveStatsOutput = z.object({
  ...summaryField,
  url: z.string(),
  totalCaptures: z.number(),
  firstCapture: z.string().nullable(),
  lastCapture: z.string().nullable(),
  firstCaptureIso: z.string().nullable(),
  lastCaptureIso: z.string().nullable(),
  /** Capture counts split by HTTP status class, so exclusions are never silent. */
  byStatusClass: statusBreakdownSchema,
  /** Range covering only HTTP 200 captures — the ones the reading tools can use. */
  contentFirstCapture: z.string().nullable(),
  contentLastCapture: z.string().nullable(),
  /** Share of captures that are redirects, 0-1. A high value means the page moved. */
  redirectShare: z.number(),
  byYear: z.record(z.string(), z.number()),
  /** 'sparkline' is the cheap aggregate endpoint; 'cdx' gives the status breakdown. */
  source: z.enum(['sparkline', 'cdx']),
  /** True when the capture list hit the query cap and the counts are lower bounds. */
  capturesTruncated: z.boolean(),
  calendarUrl: z.string(),
});

// ---------------------------------------------------------------------------
// check_availability
// ---------------------------------------------------------------------------

export const checkAvailabilityInput = z.object({
  url: urlField,
  timestamp: dateField.optional().describe('Target date to find the closest capture to. Defaults to the most recent capture.'),
});

export const checkAvailabilityOutput = z.object({
  ...summaryField,
  url: z.string(),
  available: z.boolean(),
  timestamp: z.string().nullable(),
  timestampIso: z.string().nullable(),
  snapshotUrl: z.string().nullable(),
  status: z.string().nullable(),
  requestedTimestamp: z.string().nullable(),
  /** Signed days between the requested date and the closest capture (G7). */
  offsetDays: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// search_snapshots
// ---------------------------------------------------------------------------

export const searchSnapshotsInput = z.object({
  url: urlField,
  matchType: matchTypeField.default('exact'),
  from: dateField.optional().describe('Earliest capture date to include.'),
  to: dateField.optional().describe('Latest capture date to include.'),
  limit: z.number().int().min(1).max(1000).default(50).describe('Maximum captures to request from the CDX index.'),
  offset: z.number().int().min(0).optional().describe('Skip this many rows. Use with limit to page through results.'),
  page: z.number().int().min(0).optional().describe('CDX page number, an alternative to offset for very large result sets.'),
  pageSize: z.number().int().min(1).max(1000).optional().describe('Rows per CDX page when using `page`.'),
  collapse: z
    .string()
    .optional()
    .describe(
      'Collapse adjacent rows that share a field, e.g. "timestamp:8" for one capture per day or "digest" for one per identical body.',
    ),
  filter: z
    .array(z.string())
    .max(10)
    .optional()
    .describe('CDX filters, e.g. ["statuscode:200"] or ["!mimetype:image.*"]. Prefix with ! to negate.'),
  resolveRevisits: z
    .boolean()
    .default(true)
    .describe('Resolve revisit records to the capture whose content they point at. Leave on unless you need raw index rows.'),
});

export const snapshotRowSchema = z.object({
  timestamp: z.string(),
  timestampIso: z.string(),
  original: z.string(),
  statuscode: z.string(),
  mimetype: z.string(),
  digest: z.string(),
  length: z.string(),
  snapshotUrl: z.string(),
});

export const searchSnapshotsOutput = z.object({
  ...summaryField,
  url: z.string(),
  matchType: z.string(),
  rows: z.array(snapshotRowSchema),
  /** Distinct `original` URLs among the returned rows — the point of non-exact matching. */
  distinctUrls: z.array(z.string()),
  distinctUrlCount: z.number(),
  totalReturned: z.number(),
  hasMore: z.boolean(),
  /** True when rows were trimmed to keep the response inside the tool-result size cap. */
  rowsTruncated: z.boolean(),
  nextOffset: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// list_revisions
// ---------------------------------------------------------------------------

export const listRevisionsInput = z.object({
  url: urlField,
  from: dateField.optional().describe('Earliest capture date to consider.'),
  to: dateField.optional().describe('Latest capture date to consider.'),
  maxCaptures: z
    .number()
    .int()
    .min(10)
    .max(10_000)
    .default(3_000)
    .describe('Upper bound on captures examined. Raise for very heavily archived URLs; narrow from/to instead if you can.'),
  includeRedirects: z
    .boolean()
    .default(false)
    .describe('Include 3xx captures. Off by default so redirects do not read as content changes.'),
  method: z
    .enum(['auto', 'digest', 'text'])
    .default('auto')
    .describe(
      'auto (default) uses fast CDX digests and falls back to sampled text digests when those turn out to be noise; digest forces CDX-only (fast, but useless on pages with per-request tokens); text forces sampled text digesting.',
    ),
});

export const revisionRowSchema = z.object({
  revisionIndex: z.number(),
  digest: z.string(),
  firstSeen: z.string(),
  firstSeenIso: z.string(),
  lastSeen: z.string(),
  lastSeenIso: z.string(),
  captureCount: z.number(),
  mimeType: z.string(),
  length: z.string(),
  snapshotUrl: z.string(),
});

export const listRevisionsOutput = z.object({
  ...summaryField,
  url: z.string(),
  revisions: z.array(revisionRowSchema),
  totalRevisions: z.number(),
  distinctDigests: z.number(),
  capturesExamined: z.number(),
  /** Which grouping actually produced these revisions. */
  method: z.enum(['digest', 'text']),
  /** Every capture in range, before any status filtering. */
  capturesTotal: z.number(),
  /** How many captures were excluded, and why, so numbers never silently disagree. */
  capturesExcluded: z.number(),
  excludedReason: z.string().nullable(),
  /** distinctDigests / capturesExamined. At or above 0.9 the CDX digests are noise. */
  digestRatio: z.number(),
  /** Captures actually fetched in text mode. 0 in digest mode. */
  capturesSampled: z.number(),
  /** Which heuristic sent this into text-digest mode, or null in digest mode. */
  fallbackReason: z.string().nullable(),
  /** Share of revisions covering exactly one capture — a strong noise signal. */
  singletonShare: z.number(),
  /** True when the capture list hit maxCaptures and older/newer captures were not examined. */
  capturesTruncated: z.boolean(),
  revisionsTruncated: z.boolean(),
  firstCapture: z.string().nullable(),
  lastCapture: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// get_snapshot
// ---------------------------------------------------------------------------

export const getSnapshotInput = z.object({
  url: urlField,
  timestamp: z
    .string()
    .default('latest')
    .describe('A Wayback timestamp (YYYYMMDDhhmmss or shorter), or "latest" / "earliest". Partial dates resolve to the closest capture.'),
  format: z
    .enum(['text', 'markdown', 'raw'])
    .default('text')
    .describe(
      'text = chrome-stripped plain text (best for reading and diffing); markdown = same, with structure preserved; raw = original bytes, returned only as a resource link.',
    ),
  modifier: z
    .enum(['id_', 'if_', 'im_', 'js_', 'cs_'])
    .optional()
    .describe('Wayback content modifier. Defaults to id_ (the original, unrewritten capture), which is almost always what you want.'),
  maxChars: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .default(8_000)
    .describe(
      'Inline character budget. At the default 8000 a longer page returns a 2,000-character preview plus a resource link; raise it to inline more of the text directly, which is what you want if resource links are not being fetched.',
    ),
});

export const getSnapshotOutput = z.object({
  ...summaryField,
  url: z.string(),
  timestamp: z.string(),
  timestampIso: z.string(),
  requestedTimestamp: z.string(),
  resolvedUrl: z.string(),
  captureUrl: z.string(),
  mimeType: z.string(),
  title: z.string().nullable(),
  format: z.string(),
  /**
   * The extracted page content. This is the tool's actual output; everything else
   * is metadata about it. Empty only for format="raw", where the bytes are served
   * by the resource link instead.
   */
  text: z.string(),
  /** Characters of extracted text in the whole capture. Not a byte count. */
  totalChars: z.number(),
  /** Byte length of the artifact the resource link serves. */
  artifactBytes: z.number(),
  /** Characters actually delivered in `text`. With totalChars, makes `truncated` derivable. */
  inlinedChars: z.number(),
  maxChars: z.number(),
  /** True when `text` is shorter than the full artifact. False when the body was fully inlined, and false for format="raw". */
  truncated: z.boolean(),
  resourceUri: z.string().nullable(),
  /** Signed days between the requested date and the capture actually returned. */
  offsetDays: z.number().nullable(),
  /** True when an HTML capture yielded almost no text — usually a client-rendered page. */
  extractionSuspect: z.boolean(),
});

// ---------------------------------------------------------------------------
// compare_snapshots
// ---------------------------------------------------------------------------

export const compareSnapshotsInput = z.object({
  url: urlField,
  timestampA: z
    .string()
    .optional()
    .describe('Older capture. Accepts a timestamp, "earliest" or "latest". Defaults to the earliest capture.'),
  timestampB: z
    .string()
    .optional()
    .describe('Newer capture. Accepts a timestamp, "earliest" or "latest". Defaults to the latest capture.'),
  granularity: z
    .enum(['line', 'word'])
    .default('line')
    .describe('line = unified diff by paragraph/line (default, best for prose); word = inline word-level changes, better for small edits.'),
  maxChars: z
    .number()
    .int()
    .min(1_000)
    .max(100_000)
    .default(15_000)
    .describe('Inline budget for the unified diff. Raise it to see a long diff in full rather than following a resource link.'),
});

export const compareSnapshotsOutput = z.object({
  ...summaryField,
  url: z.string(),
  timestampA: z.string(),
  timestampB: z.string(),
  timestampAIso: z.string(),
  timestampBIso: z.string(),
  granularity: z.string(),
  /** What was asked for versus what was fetched, for each endpoint (F3). */
  requestedTimestampA: z.string(),
  requestedTimestampB: z.string(),
  offsetDaysA: z.number().nullable(),
  offsetDaysB: z.number().nullable(),
  identical: z.boolean(),
  addedChars: z.number(),
  removedChars: z.number(),
  addedLines: z.number(),
  removedLines: z.number(),
  changedSections: z.number(),
  charsA: z.number(),
  charsB: z.number(),
  /** The unified diff itself, up to maxChars. This is the tool's actual output. */
  diff: z.string(),
  diffTotalChars: z.number(),
  /** Byte length of the full diff artifact behind the resource link. */
  artifactBytes: z.number(),
  /** Characters of diff actually delivered in `diff`. */
  inlinedChars: z.number(),
  maxChars: z.number(),
  /** True when `diff` is shorter than the full diff. */
  truncated: z.boolean(),
  /** CDX content digests of the two captures, for telling markup-only changes apart. */
  digestA: z.string().nullable(),
  digestB: z.string().nullable(),
  /** True when the extracted text matches but the CDX digests differ — a markup-only change. */
  markupOnlyChange: z.boolean(),
  /** True when either side yielded almost no text from an HTML capture. */
  extractionSuspect: z.boolean(),
  resourceUri: z.string().nullable(),
  visualDiffUrl: z.string(),
  /** True when the diff algorithm timed out and only statistics are reliable. */
  degraded: z.boolean(),
});

// ---------------------------------------------------------------------------
// list_screenshots
// ---------------------------------------------------------------------------

export const listScreenshotsInput = z.object({
  url: urlField,
  from: dateField.optional(),
  to: dateField.optional(),
  limit: z.number().int().min(1).max(500).default(50),
});

export const screenshotRowSchema = z.object({
  timestamp: z.string(),
  timestampIso: z.string(),
  mimetype: z.string(),
  length: z.string(),
  screenshotUrl: z.string(),
  imageUrl: z.string(),
});

export const listScreenshotsOutput = z.object({
  ...summaryField,
  url: z.string(),
  screenshots: z.array(screenshotRowSchema),
  totalReturned: z.number(),
  hasMore: z.boolean(),
  /** 'none' = the index answered and holds no screenshots; 'unavailable' = the index could not be queried. */
  indexStatus: z.enum(['ok', 'none', 'unavailable']),
});

// ---------------------------------------------------------------------------
// search_items
// ---------------------------------------------------------------------------

export const searchItemsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe('Lucene-style query over archive.org items, e.g. `title:(apollo 11)` or `creator:"NASA" AND date:[1969 TO 1970]`.'),
  mediatype: z
    .enum(['texts', 'audio', 'movies', 'software', 'image', 'etree', 'data', 'web', 'collection'])
    .optional()
    .describe('Restrict to one media type. Cheaper and more precise than filtering afterwards.'),
  fields: z.array(z.string()).max(20).optional().describe('Metadata fields to return. Defaults to identifier, title, creator, date, mediatype.'),
  sort: z.string().optional().describe('Sort clause, e.g. "downloads desc" or "date asc".'),
  rows: z.number().int().min(1).max(100).default(20),
  page: z.number().int().min(1).default(1),
});

export const itemRowSchema = z.object({
  identifier: z.string(),
  title: z.string().nullable(),
  creator: z.string().nullable(),
  date: z.string().nullable(),
  mediatype: z.string().nullable(),
  detailsUrl: z.string(),
});

export const searchItemsOutput = z.object({
  ...summaryField,
  query: z.string(),
  items: z.array(itemRowSchema),
  numFound: z.number(),
  start: z.number(),
  page: z.number(),
  hasMore: z.boolean(),
});

// ---------------------------------------------------------------------------
// get_item_metadata
// ---------------------------------------------------------------------------

export const getItemMetadataInput = z.object({
  identifier: z.string().min(1).describe('archive.org item identifier, as returned by search_items.'),
  maxFiles: z.number().int().min(1).max(500).default(100).describe('Cap on file rows returned. The full listing is available via the resource link.'),
});

export const itemFileSchema = z.object({
  name: z.string(),
  format: z.string().nullable(),
  size: z.number().nullable(),
});

export const getItemMetadataOutput = z.object({
  ...summaryField,
  identifier: z.string(),
  title: z.string().nullable(),
  creator: z.string().nullable(),
  date: z.string().nullable(),
  mediatype: z.string().nullable(),
  collection: z.array(z.string()),
  description: z.string().nullable(),
  licenseUrl: z.string().nullable(),
  files: z.array(itemFileSchema),
  fileCount: z.number(),
  filesTruncated: z.boolean(),
  totalBytes: z.number(),
  detailsUrl: z.string(),
  metadataUrl: z.string(),
  resourceUri: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// save_url
// ---------------------------------------------------------------------------

export const saveUrlInput = z.object({
  url: urlField.describe('URL to capture now. Must include a resolvable host; the scheme defaults to https.'),
  captureScreenshot: z.boolean().default(false).describe('Also store a page screenshot.'),
  captureOutlinks: z.boolean().default(false).describe('Also capture links found on the page. Much slower.'),
  ifNotArchivedWithin: z
    .string()
    .optional()
    .describe('Skip if a capture already exists within this period, e.g. "1h", "3d". Saves quota on repeated calls.'),
  jsBehaviorTimeout: z.number().int().min(0).max(30).optional().describe('Seconds to run page JavaScript before capturing (max 30).'),
  forceGet: z.boolean().default(false).describe('Use a plain GET instead of the headless browser. Try this if a capture keeps failing.'),
  delayWbAvailability: z.boolean().default(false).describe('Let the capture appear in the Wayback Machine later rather than immediately.'),
  waitForCompletion: z.boolean().default(true).describe('Poll the job briefly and report the final status instead of returning just a job id.'),
});

export const saveUrlOutput = z.object({
  ...summaryField,
  url: z.string(),
  jobId: z.string().nullable(),
  status: z.enum(['success', 'pending', 'error', 'submitted']),
  timestamp: z.string().nullable(),
  snapshotUrl: z.string().nullable(),
  message: z.string().nullable(),
  statusUrl: z.string().nullable(),
  durationSec: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// clear_cache
// ---------------------------------------------------------------------------

export const clearCacheInput = z.object({});

export const clearCacheOutput = z.object({
  ...summaryField,
  cleared: z.number(),
  remaining: z.number(),
});

// ---------------------------------------------------------------------------
// Upstream response schemas (lenient: archive.org adds fields over time)
// ---------------------------------------------------------------------------

export const availabilityResponseSchema = z.looseObject({
  url: z.string().optional(),
  timestamp: z.string().optional(),
  archived_snapshots: z
    .looseObject({
      closest: z
        .looseObject({
          status: z.union([z.string(), z.number()]).optional(),
          available: z.boolean().optional(),
          url: z.string().optional(),
          timestamp: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export const sparklineResponseSchema = z.looseObject({
  years: z.record(z.string(), z.array(z.union([z.number(), z.string(), z.null()]))).optional(),
  first_ts: z.string().nullable().optional(),
  last_ts: z.string().nullable().optional(),
  status: z.record(z.string(), z.unknown()).optional(),
});

export const advancedSearchResponseSchema = z.looseObject({
  response: z.looseObject({
    numFound: z.number(),
    start: z.number(),
    docs: z.array(z.record(z.string(), z.unknown())),
  }),
});

export const itemMetadataResponseSchema = z.looseObject({
  metadata: z.record(z.string(), z.unknown()).optional(),
  files: z.array(z.record(z.string(), z.unknown())).optional(),
  item_size: z.number().optional(),
});

export const saveSubmitResponseSchema = z.looseObject({
  url: z.string().optional(),
  job_id: z.string().optional(),
  message: z.string().optional(),
  status: z.string().optional(),
  status_ext: z.string().optional(),
});

export const saveStatusResponseSchema = z.looseObject({
  status: z.string().optional(),
  job_id: z.string().optional(),
  original_url: z.string().optional(),
  timestamp: z.string().optional(),
  duration_sec: z.number().optional(),
  message: z.string().optional(),
  exception: z.string().optional(),
  status_ext: z.string().optional(),
});
