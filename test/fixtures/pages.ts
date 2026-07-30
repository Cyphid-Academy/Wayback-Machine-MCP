/**
 * Fixture pages and a synthetic capture history.
 *
 * The shape mirrors the driving use case from the build spec: a help-centre page
 * rewritten in place at a stable URL, wrapped in a masthead, a nav, a cookie
 * banner and a 13-language switcher. There are 8 distinct bodies across ~300
 * captures, and the message-limit sentence changes between the first and last.
 */

export const TARGET_URL = 'support.example.org/en/articles/8325612';

const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['zh', '中文'],
  ['tr', 'Türkçe'],
  ['id', 'Bahasa Indonesia'],
];

function languageSwitcher(): string {
  const items = LANGUAGES.map(
    ([code, label]) => `<li><a href="/${code ?? 'en'}/articles/8325612">${label ?? ''}</a></li>`,
  ).join('');
  return `<div class="lang-switcher"><ul>${items}</ul></div>`;
}

function chrome(): string {
  return `
<header class="site-header"><a class="logo" href="/">Example Help Center</a><span>Search</span></header>
<nav class="navbar"><ul>
  <li><a href="/en/collections/1">Getting started</a></li>
  <li><a href="/en/collections/2">Billing</a></li>
  <li><a href="/en/collections/3">Troubleshooting</a></li>
</ul></nav>
<div class="cookie-consent">We use cookies to improve your experience. <button>Accept all</button></div>
${languageSwitcher()}`;
}

function footer(): string {
  return `
<footer class="site-footer"><ul>
  <li><a href="/legal">Terms</a></li><li><a href="/privacy">Privacy</a></li>
</ul><p>© Example Inc.</p></footer>
<script>window.intercomSettings={app_id:"abc"};var x = 1 < 2;</script>
<style>.site-header{color:red}</style>`;
}

export interface PageVariant {
  readonly digest: string;
  /** The message-limit sentence that changes between revisions. */
  readonly limitSentence: string;
  readonly extraParagraph: string;
}

export const VARIANTS: readonly PageVariant[] = [
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1',
    limitSentence: 'Pro subscribers can send at least 100 messages every 8 hours.',
    extraParagraph: 'Usage limits depend on the length of your conversations and on current demand.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2',
    limitSentence: 'Pro subscribers can send at least 100 messages every 8 hours.',
    extraParagraph: 'Usage limits depend on conversation length and on how busy the service is.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3',
    limitSentence: 'Pro subscribers can send at least 90 messages every 8 hours.',
    extraParagraph: 'Longer conversations consume your limit faster because the whole thread is re-read.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4',
    limitSentence: 'Pro subscribers can send at least 90 messages every 8 hours.',
    extraParagraph: 'Longer conversations consume your limit faster. Attachments count towards it too.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA5',
    limitSentence: 'Pro subscribers can send at least 70 messages every 6 hours.',
    extraParagraph: 'Limits reset on a rolling window rather than at a fixed time of day.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6',
    limitSentence: 'Pro subscribers can send at least 60 messages every 6 hours.',
    extraParagraph: 'Limits reset on a rolling window. You can see your remaining usage in the app.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7',
    limitSentence: 'Pro subscribers can send at least 50 messages every 5 hours.',
    extraParagraph: 'Limits reset on a rolling window. Usage is shown in the app under Settings.',
  },
  {
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8',
    limitSentence: 'Pro subscribers can send at least 45 messages every 5 hours.',
    extraParagraph: 'Limits reset on a rolling window. Usage is shown in the app under Settings.',
  },
];

/** Filler that pushes a page past the 8,000-character inline limit. */
function filler(paragraphs: number, seed: string): string {
  const out: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    out.push(
      `<p>Section ${String(index + 1)} of the ${seed} guidance. ` +
        'This paragraph exists so the extracted text is long enough to exercise the resource-link threshold, and it says the same thing in every revision so it never shows up in a diff. '.repeat(
          2,
        ) +
        '</p>',
    );
  }
  return out.join('\n');
}

export function pageHtml(variant: PageVariant, options: { readonly large?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>How many messages can I send? | Example Help Center</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
${chrome()}
<main>
  <article class="article-body">
    <h1>How many messages can I send?</h1>
    <p>This article explains the usage limits that apply to each plan.</p>
    <h2>Plan limits</h2>
    <p>${variant.limitSentence}</p>
    <p>${variant.extraParagraph}</p>
    <ul>
      <li>Free plan: a small daily allowance.</li>
      <li>Pro plan: the limits described above.</li>
      <li>Team plan: higher limits per seat.</li>
    </ul>
    <table>
      <tr><th>Plan</th><th>Limit</th></tr>
      <tr><td>Free</td><td>Daily allowance</td></tr>
      <tr><td>Pro</td><td>${variant.limitSentence}</td></tr>
    </table>
    <pre><code>GET /v1/usage
  Authorization: Bearer &lt;token&gt;</code></pre>
    ${options.large === true ? filler(30, 'usage-limit') : ''}
  </article>
</main>
${footer()}
</body>
</html>`;
}

export interface FixtureCapture {
  readonly timestamp: string;
  readonly digest: string;
  readonly statuscode: string;
  readonly mimetype: string;
  readonly length: string;
}

function stamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

interface RevisionSpan {
  readonly variantIndex: number;
  readonly startIso: string;
  readonly endIso: string;
  readonly captures: number;
}

const SPANS: readonly RevisionSpan[] = [
  { variantIndex: 0, startIso: '2023-09-12T09:00:00Z', endIso: '2023-11-01T09:00:00Z', captures: 12 },
  { variantIndex: 1, startIso: '2023-11-02T09:00:00Z', endIso: '2024-02-15T09:00:00Z', captures: 40 },
  { variantIndex: 2, startIso: '2024-02-16T09:00:00Z', endIso: '2024-07-01T09:00:00Z', captures: 55 },
  { variantIndex: 3, startIso: '2024-07-02T09:00:00Z', endIso: '2024-12-01T09:00:00Z', captures: 30 },
  { variantIndex: 4, startIso: '2024-12-02T09:00:00Z', endIso: '2025-05-01T09:00:00Z', captures: 60 },
  { variantIndex: 5, startIso: '2025-05-02T09:00:00Z', endIso: '2025-11-01T09:00:00Z', captures: 45 },
  { variantIndex: 6, startIso: '2025-11-02T09:00:00Z', endIso: '2026-03-31T09:00:00Z', captures: 38 },
  { variantIndex: 7, startIso: '2026-04-01T09:00:00Z', endIso: '2026-07-20T09:00:00Z', captures: 22 },
];

function buildCaptures(): FixtureCapture[] {
  const captures: FixtureCapture[] = [];
  for (const span of SPANS) {
    const variant = VARIANTS[span.variantIndex];
    if (variant === undefined) continue;
    const start = Date.parse(span.startIso);
    const end = Date.parse(span.endIso);
    const step = span.captures === 1 ? 0 : (end - start) / (span.captures - 1);
    for (let index = 0; index < span.captures; index += 1) {
      captures.push({
        timestamp: stamp(new Date(start + step * index)),
        digest: variant.digest,
        statuscode: '200',
        mimetype: 'text/html',
        length: String(12_000 + span.variantIndex * 37),
      });
    }
  }
  // A redirect and a revisit row, so status filtering is exercised.
  captures.push({
    timestamp: '20240301120000',
    digest: 'REDIRECTREDIRECTREDIRECTREDIRECT',
    statuscode: '302',
    mimetype: 'text/html',
    length: '512',
  });
  captures.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return captures;
}

export const CAPTURES: readonly FixtureCapture[] = buildCaptures();

/** digest -> HTML body. The last revision is oversized to exercise ResourceLinks. */
export const BODIES: ReadonlyMap<string, string> = new Map(
  VARIANTS.map((variant, index) => [variant.digest, pageHtml(variant, { large: index === VARIANTS.length - 1 })]),
);

export const ITEM_IDENTIFIER = 'example-fixture-item';

export const ITEM_METADATA = {
  created: 1_700_000_000,
  dir: '/12/items/example-fixture-item',
  metadata: {
    identifier: ITEM_IDENTIFIER,
    title: 'Fixture Item: Field Recordings',
    creator: ['A. Recorder', 'B. Engineer'],
    date: '1969-07-20T00:00:00Z',
    mediatype: 'audio',
    collection: ['fixtures', 'opensource_audio'],
    description: '<p>A fixture item with <b>HTML</b> in its description.</p>',
    licenseurl: 'https://creativecommons.org/licenses/by/4.0/',
  },
  files: [
    { name: 'recording01.flac', format: 'Flac', size: '48211234', source: 'original' },
    { name: 'recording01.mp3', format: 'VBR MP3', size: '7211234', source: 'derivative' },
    { name: 'metadata.xml', format: 'Metadata', size: '1024', source: 'original' },
  ],
  item_size: 55_423_492,
};

export const SEARCH_DOCS = [
  { identifier: 'apollo-11-flight-plan', title: 'Apollo 11 Flight Plan', creator: 'NASA', date: '1969-07-01T00:00:00Z', mediatype: 'texts' },
  { identifier: 'apollo-11-audio', title: 'Apollo 11 Onboard Audio', creator: ['NASA', 'JSC'], date: '1969-07-20T00:00:00Z', mediatype: 'audio' },
  { identifier: 'apollo-13-report', title: 'Apollo 13 Review Board Report', creator: 'NASA', date: '1970-06-15T00:00:00Z', mediatype: 'texts' },
];


// ---------------------------------------------------------------------------
// Fixtures for the defects found in first live use (see waybackmcpFIXES.md).
// ---------------------------------------------------------------------------

/**
 * F1: a URL whose captures live under a longer slug, so a prefix search has to
 * report the matched URL or the caller cannot act on the result.
 */
export const PREFIX_STEM = 'support.example.org/en/articles/11647753';
export const PREFIX_SLUG_A = 'support.example.org/en/articles/11647753-what-are-usage-limits';
export const PREFIX_SLUG_B = 'support.example.org/en/articles/11647753-what-are-usage-limits/extra';

export const PREFIX_CAPTURES: readonly FixtureCapture[] = [
  { timestamp: '20250301120000', digest: 'PREFIXAAAAAAAAAAAAAAAAAAAAAAAAAA', statuscode: '200', mimetype: 'text/html', length: '9000' },
  { timestamp: '20250401120000', digest: 'PREFIXBBBBBBBBBBBBBBBBBBBBBBBBBB', statuscode: '200', mimetype: 'text/html', length: '9100' },
];

/** Which slug each prefix capture belongs to, by timestamp. */
export const PREFIX_ORIGINALS: ReadonlyMap<string, string> = new Map([
  ['20250301120000', `https://${PREFIX_SLUG_A}`],
  ['20250401120000', `https://${PREFIX_SLUG_B}`],
]);

/** F2: a retired article whose only captures are redirects to its successor. */
export const REDIRECT_ONLY_URL = 'support.example.org/en/articles/8325612-retired';

export const REDIRECT_ONLY_CAPTURES: readonly FixtureCapture[] = [
  { timestamp: '20251022120000', digest: 'RED1RED1RED1RED1RED1RED1RED1RED1', statuscode: '301', mimetype: 'text/html', length: '512' },
  { timestamp: '20260131120000', digest: 'RED2RED2RED2RED2RED2RED2RED2RED2', statuscode: '301', mimetype: 'text/html', length: '515' },
];

/** F2: a URL with a mix of 200s and redirects, so exclusions must be reported. */
export const MIXED_STATUS_URL = 'example.org/pricing';

function buildMixedStatus(): FixtureCapture[] {
  const rows: FixtureCapture[] = [];
  // 2023: redirects only. 2024-2025: readable captures.
  for (let index = 0; index < 12; index += 1) {
    rows.push({
      timestamp: `2023${String(index + 1).padStart(2, '0')}15120000`,
      digest: `MIXEDREDIRECT${String(index).padStart(19, '0')}`,
      statuscode: '302',
      mimetype: 'text/html',
      length: '480',
    });
  }
  for (let index = 0; index < 8; index += 1) {
    rows.push({
      timestamp: `2024${String(index + 1).padStart(2, '0')}15120000`,
      digest: `MIXEDOK${String(index).padStart(25, '0')}`,
      statuscode: '200',
      mimetype: 'text/html',
      length: '11000',
    });
  }
  return rows;
}

export const MIXED_STATUS_CAPTURES: readonly FixtureCapture[] = buildMixedStatus();

/**
 * F3: captures with a wide gap, so requesting a date inside the gap resolves to a
 * capture ~23 days away and must say so.
 */
export const GAP_URL = 'support.example.org/en/articles/gap-article';

export const GAP_CAPTURES: readonly FixtureCapture[] = [
  { timestamp: '20240921110324', digest: 'GAPAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', statuscode: '200', mimetype: 'text/html', length: '14651' },
  { timestamp: '20241112035820', digest: 'GAPBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', statuscode: '200', mimetype: 'text/html', length: '14726' },
];

/**
 * F4: an Intercom-style page whose CDX digest changes on every capture because of
 * an embedded per-request nonce, while the readable text changes only twice.
 *
 * The three text eras bracket April 2024, mirroring the real two-stage edit to the
 * Claude Pro message allowance.
 */
export const NONCE_URL = 'support.example.org/en/articles/8325612-usage-limits';

export interface NonceEra {
  readonly from: string;
  readonly sentence: string;
}

export const NONCE_ERAS: readonly NonceEra[] = [
  { from: '20231001000000', sentence: 'Pro subscribers can send at least 100 messages every 8 hours, and we will warn you at 20 remaining.' },
  { from: '20240401000000', sentence: 'Pro subscribers can send at least 100 messages every 5 hours, and we will warn you at 10 remaining.' },
  { from: '20240420000000', sentence: 'Pro subscribers can send at least 45 messages every 5 hours, and we will warn you at 7 remaining.' },
];

function eraFor(timestamp: string): NonceEra {
  let chosen = NONCE_ERAS[0];
  for (const era of NONCE_ERAS) {
    if (timestamp >= era.from) chosen = era;
  }
  if (chosen === undefined) throw new Error('fixture eras missing');
  return chosen;
}

/** The capture body: stable readable text, plus a nonce that changes every time. */
export function noncePageHtml(timestamp: string): string {
  const era = eraFor(timestamp);
  return `<!doctype html>
<html lang="en">
<head><title>What are the usage limits? | Example Help Center</title>
<meta name="csrf-token" content="nonce-${timestamp}-${String(Number(timestamp) * 7919 % 1000003)}">
</head>
<body>
${chrome()}
<main><article class="article-body">
  <h1>What are the usage limits?</h1>
  <p>${era.sentence}</p>
  <p>Limits reset on a rolling window.</p>
</article></main>
${footer()}
<script>window.__NEXT_DATA__={buildId:"build-${timestamp}"};</script>
</body></html>`;
}

/** 88 captures, every one with a distinct CDX digest, across three text eras. */
function buildNonceCaptures(): FixtureCapture[] {
  const rows: FixtureCapture[] = [];
  const start = Date.parse('2023-10-01T00:00:00Z');
  const end = Date.parse('2025-07-01T00:00:00Z');
  const total = 88;
  const step = (end - start) / (total - 1);
  for (let index = 0; index < total; index += 1) {
    const timestamp = stamp(new Date(start + step * index));
    rows.push({
      timestamp,
      // Distinct on every capture — this is exactly what defeats digest collapsing.
      digest: `NONCE${timestamp}${String(index).padStart(9, '0')}`,
      statuscode: '200',
      mimetype: 'text/html',
      length: String(14_000 + index),
    });
  }
  return rows;
}

export const NONCE_CAPTURES: readonly FixtureCapture[] = buildNonceCaptures();

/** The two real captures the fix spec says must hash identically (F4). */
export const IDENTICAL_TEXT_PAIR: readonly [string, string] = ['20240308095154', '20240323002232'];

// ---------------------------------------------------------------------------
// Fixtures for the independent capability test (waybackmcpFIXES2.md).
// ---------------------------------------------------------------------------

/**
 * G5: python.org/about/ over 2014-2016 — 60 captures, 49 distinct digests, a
 * ratio of 0.82 that slipped under the original 0.9 threshold. The digests churn
 * because a success-story sidebar rotates; the readable body changes twice.
 * Sizes oscillate in a narrow band, matching the observed 7,946-8,285 bytes.
 */
export const CHURN_URL = 'example.org/about-churn';

export interface ChurnEra {
  readonly from: string;
  readonly sentence: string;
}

export const CHURN_ERAS: readonly ChurnEra[] = [
  { from: '20140101000000', sentence: 'Python is a programming language that lets you work quickly.' },
  { from: '20150601000000', sentence: 'Python is a programming language that lets you work quickly and integrate systems effectively.' },
];

function churnEraFor(timestamp: string): ChurnEra {
  let chosen = CHURN_ERAS[0];
  for (const era of CHURN_ERAS) if (timestamp >= era.from) chosen = era;
  if (chosen === undefined) throw new Error('fixture eras missing');
  return chosen;
}

/** A rotating sidebar changes the bytes on most captures without changing the body. */
export function churnPageHtml(timestamp: string): string {
  const era = churnEraFor(timestamp);
  const slot = Number(timestamp.slice(4, 8)) % 5;
  return `<!doctype html>
<html lang="en"><head><title>About Python | python.org</title></head>
<body>
${chrome()}
<main><article>
  <h1>About Python</h1>
  <p>${era.sentence}</p>
  <p>It runs everywhere and is developed in the open.</p>
</article></main>
<div class="sidebar-success-story">Success story ${String(slot)}: organisation ${String(slot)} uses Python in production for workload ${String(slot)}.</div>
${footer()}
</body></html>`;
}

function buildChurnCaptures(): FixtureCapture[] {
  const rows: FixtureCapture[] = [];
  const start = Date.parse('2014-01-15T00:00:00Z');
  const end = Date.parse('2016-12-15T00:00:00Z');
  const total = 60;
  const step = (end - start) / (total - 1);
  for (let index = 0; index < total; index += 1) {
    const timestamp = stamp(new Date(start + step * index));
    // 49 distinct digests across 60 captures: every fourth capture repeats its
    // predecessor's digest, giving a ratio of ~0.82 with singleton-heavy runs.
    const bucket = index % 4 === 3 ? index - 1 : index;
    rows.push({
      timestamp,
      digest: `CHURN${String(bucket).padStart(10, '0')}AAAAAAAAAAAAAAAA`,
      statuscode: '200',
      mimetype: 'text/html',
      // Oscillates in a narrow band, as the real page's markup does.
      length: String(7_946 + ((index * 97) % 340)),
    });
  }
  return rows;
}

export const CHURN_CAPTURES: readonly FixtureCapture[] = buildChurnCaptures();

/**
 * G8: two captures with different CDX digests whose extracted text is identical —
 * the change was in a script tag. Mirrors the verified python.org pair.
 */
export const MARKUP_ONLY_URL = 'example.org/markup-only';
export const MARKUP_ONLY_PAIR: readonly [string, string] = ['20120919084854', '20121102221304'];

export const MARKUP_ONLY_CAPTURES: readonly FixtureCapture[] = [
  { timestamp: '20120919084854', digest: 'MARKUPONLYAAAAAAAAAAAAAAAAAAAAAA', statuscode: '200', mimetype: 'text/html', length: '4200' },
  { timestamp: '20121102221304', digest: 'MARKUPONLYBBBBBBBBBBBBBBBBBBBBBB', statuscode: '200', mimetype: 'text/html', length: '4260' },
];

/** Same visible body, different inline script — so the digests differ and the text does not. */
export function markupOnlyHtml(timestamp: string): string {
  return `<!doctype html>
<html lang="en"><head><title>Stable Page</title>
<script>var analyticsBuild="${timestamp}";</script>
</head>
<body>
${chrome()}
<main><article>
  <h1>Stable Page</h1>
  <p>This paragraph is byte-identical in both captures, which is the entire point of the fixture.</p>
</article></main>
${footer()}
</body></html>`;
}

/** G8: a client-rendered page whose capture is only a shell. */
export const SHELL_URL = 'example.org/client-rendered';

export const SHELL_CAPTURES: readonly FixtureCapture[] = [
  { timestamp: '20260101120000', digest: 'SHELLSHELLSHELLSHELLSHELLSHELLAA', statuscode: '200', mimetype: 'text/html', length: '12000' },
];

export function shellHtml(): string {
  const filler = '/*'.padEnd(6_000, ' bundled application code ') + '*/';
  return `<!doctype html>
<html lang="en"><head><title>Pricing</title></head>
<body>
<div id="root"></div>
<script>${filler}</script>
</body></html>`;
}
