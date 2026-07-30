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
