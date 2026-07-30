import { HTMLElement, TextNode, parse, type Node } from 'node-html-parser';

export type ExtractMode = 'text' | 'markdown';

export interface ExtractResult {
  readonly text: string;
  readonly title: string | undefined;
  /** How many elements the chrome stripper removed. Useful for diagnosing bad extractions. */
  readonly removedElements: number;
}

/** Newlines and leading spaces inside <pre> are protected from the whitespace collapser. */
const NEWLINE_SENTINEL = '\u0001';
const SPACE_SENTINEL = '\u0002';

/**
 * Chrome that never carries page content. `header`/`footer`/`nav` are in here on
 * purpose (build spec §5): the pages this server was built to diff put a
 * language switcher and a support-site masthead on every capture, and leaving
 * them in swamps the diff.
 */
const STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'iframe',
  'object',
  'embed',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'link',
  'meta',
  'nav',
  'header',
  'footer',
  'aside',
  '[role=navigation]',
  '[role=banner]',
  '[role=contentinfo]',
  '[role=search]',
  '[aria-hidden=true]',
  // Wayback's own injected banner, in case a capture was fetched without `id_`.
  '#wm-ipp-base',
  '#wm-ipp',
  '#donato',
  '#playback',
  '.wb-autocomplete-suggestions',
];

const CHROME_TOKENS = new Set([
  'nav',
  'navbar',
  'navigation',
  'menu',
  'megamenu',
  'cookie',
  'cookies',
  'consent',
  'gdpr',
  'banner',
  'breadcrumb',
  'breadcrumbs',
  'sidebar',
  'skip',
  'social',
  'share',
  'sharing',
  'subscribe',
  'newsletter',
  'language',
  'languages',
  'locale',
  'lang',
  'i18n',
  'translation',
  'translations',
  'masthead',
  'topbar',
  'toolbar',
  'modal',
  'popup',
  'overlay',
  'cookiebanner',
]);

/** Text that is long enough to be content is never dropped by the class heuristic. */
const CHROME_TEXT_GUARD = 1200;

const LANGUAGE_LABELS = new Set([
  'english',
  'español',
  'espanol',
  'français',
  'francais',
  'deutsch',
  'italiano',
  'português',
  'portugues',
  'português (br)',
  'nederlands',
  'polski',
  'русский',
  'українська',
  '日本語',
  '한국어',
  '中文',
  '中文(简体)',
  '简体中文',
  '繁體中文',
  'türkçe',
  'turkce',
  'svenska',
  'dansk',
  'norsk',
  'suomi',
  'čeština',
  'cestina',
  'română',
  'romana',
  'magyar',
  'ελληνικά',
  'עברית',
  'العربية',
  'हिन्दी',
  'ไทย',
  'tiếng việt',
  'bahasa indonesia',
  'bahasa melayu',
  'català',
  'euskara',
  'galego',
  'slovenčina',
  'hrvatski',
  'srpski',
  'български',
  'filipino',
  'spanish',
  'french',
  'german',
  'japanese',
  'korean',
  'chinese',
  'portuguese',
  'italian',
  'dutch',
  'polish',
  'russian',
  'turkish',
  'swedish',
  'danish',
  'norwegian',
  'finnish',
  'czech',
  'romanian',
  'hungarian',
  'greek',
  'hebrew',
  'arabic',
  'hindi',
  'thai',
  'vietnamese',
  'indonesian',
  'ukrainian',
]);

const INLINE_TAGS = new Set([
  'a',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'code',
  'small',
  'sub',
  'sup',
  'abbr',
  'cite',
  'q',
  'mark',
  'time',
  'label',
  's',
  'del',
  'ins',
  'kbd',
  'var',
  'font',
  'big',
  'tt',
  'bdi',
  'bdo',
  'wbr',
  'nobr',
]);

const ENTITIES = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['#39', "'"],
]);

/** Minimal decoder for the raw text inside <pre>, which the parser hands back undecoded. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    const key = body.toLowerCase();
    const mapped = ENTITIES.get(key);
    if (mapped !== undefined) return mapped;
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function tagOf(element: HTMLElement): string {
  return (element.rawTagName ?? '').toLowerCase();
}

function classTokens(element: HTMLElement): string[] {
  const raw = `${element.getAttribute('class') ?? ''} ${element.getAttribute('id') ?? ''}`.toLowerCase();
  return raw.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
}

function looksLikeChrome(element: HTMLElement): boolean {
  if (element.text.trim().length > CHROME_TEXT_GUARD) return false;
  return classTokens(element).some((token) => CHROME_TOKENS.has(token));
}

/**
 * A language switcher is a small container that is mostly links whose labels are
 * language names or bare locale codes.
 */
function looksLikeLanguageList(element: HTMLElement): boolean {
  const anchors = element.querySelectorAll('a');
  if (anchors.length < 5) return false;
  let languageLinks = 0;
  let labelled = 0;
  for (const anchor of anchors) {
    const label = anchor.text.trim().toLowerCase();
    if (label.length === 0) continue;
    labelled += 1;
    if (LANGUAGE_LABELS.has(label) || /^[a-z]{2}(-[a-z]{2})?$/.test(label)) languageLinks += 1;
  }
  if (labelled === 0) return false;
  return languageLinks >= 5 && languageLinks / labelled >= 0.6;
}

function stripChrome(root: HTMLElement): number {
  let removed = 0;
  for (const element of root.querySelectorAll(STRIP_SELECTORS.join(','))) {
    element.remove();
    removed += 1;
  }
  for (const element of root.querySelectorAll('ul,ol,div,section,span,p,dl')) {
    if (looksLikeLanguageList(element) || looksLikeChrome(element)) {
      element.remove();
      removed += 1;
    }
  }
  return removed;
}

function collapseInline(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function renderPre(element: HTMLElement, mode: ExtractMode): string {
  // `rawText` is undecoded, so tags are stripped before entities are decoded —
  // the other order would turn `&lt;token&gt;` into `<token>` and then delete it.
  const raw = element.rawText.length > 0 ? element.rawText : element.text;
  const lines = decodeEntities(raw.replace(/<[^>]*>/g, '')).split('\n');
  while (lines.length > 0 && (lines[0] ?? '').trim().length === 0) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim().length === 0) lines.pop();
  const protectedText = lines
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
      return SPACE_SENTINEL.repeat(indent.length) + line.slice(indent.length).trimEnd();
    })
    .join(NEWLINE_SENTINEL);
  if (protectedText.length === 0) return '';
  return mode === 'markdown'
    ? `\n\n\`\`\`${NEWLINE_SENTINEL}${protectedText}${NEWLINE_SENTINEL}\`\`\`\n\n`
    : `\n\n${protectedText}\n\n`;
}

function renderTable(element: HTMLElement, mode: ExtractMode): string {
  const rows: string[] = [];
  const trs = element.querySelectorAll('tr');
  for (const [index, tr] of trs.entries()) {
    const cells = tr.querySelectorAll('th,td').map((cell) => collapseInline(cell.text).trim());
    if (cells.length === 0) continue;
    if (mode === 'markdown') {
      rows.push(`| ${cells.join(' | ')} |`);
      if (index === 0) rows.push(`| ${cells.map(() => '---').join(' | ')} |`);
    } else {
      rows.push(cells.join(' | '));
    }
  }
  return rows.length === 0 ? '' : `\n\n${rows.join('\n')}\n\n`;
}

function renderChildren(node: HTMLElement, mode: ExtractMode, depth: number): string {
  let out = '';
  for (const child of node.childNodes) out += renderNode(child, mode, depth);
  return out;
}

function renderNode(node: Node, mode: ExtractMode, depth: number): string {
  if (node instanceof TextNode) return collapseInline(node.text);
  if (!(node instanceof HTMLElement)) return '';
  if (depth > 100) return collapseInline(node.text);

  const tag = tagOf(node);
  switch (tag) {
    case 'br':
      return '\n';
    case 'hr':
      return mode === 'markdown' ? '\n\n---\n\n' : '\n\n';
    case 'img': {
      if (mode !== 'markdown') return '';
      const src = node.getAttribute('src');
      if (src === undefined || src.length === 0) return '';
      return `![${collapseInline(node.getAttribute('alt') ?? '').trim()}](${src})`;
    }
    case 'pre':
      return renderPre(node, mode);
    case 'table':
      return renderTable(node, mode);
    case 'a': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      const href = node.getAttribute('href');
      if (mode !== 'markdown' || href === undefined || href.length === 0 || inner.length === 0) return inner;
      return `[${inner}](${href})`;
    }
    case 'strong':
    case 'b': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      return mode === 'markdown' && inner.length > 0 ? `**${inner}**` : inner;
    }
    case 'em':
    case 'i': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      return mode === 'markdown' && inner.length > 0 ? `*${inner}*` : inner;
    }
    case 'code': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      return mode === 'markdown' && inner.length > 0 ? `\`${inner}\`` : inner;
    }
    case 'li': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      if (inner.length === 0) return '';
      return mode === 'markdown' ? `\n- ${inner}\n` : `\n${inner}\n`;
    }
    case 'blockquote': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      if (inner.length === 0) return '';
      if (mode !== 'markdown') return `\n\n${inner}\n\n`;
      return `\n\n${inner
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const inner = renderChildren(node, mode, depth + 1).trim();
      if (inner.length === 0) return '';
      const level = Number.parseInt(tag.slice(1), 10);
      return mode === 'markdown' ? `\n\n${'#'.repeat(level)} ${inner}\n\n` : `\n\n${inner}\n\n`;
    }
    default: {
      const inner = renderChildren(node, mode, depth + 1);
      if (INLINE_TAGS.has(tag)) return inner;
      return `\n\n${inner}\n\n`;
    }
  }
}

function finalize(raw: string, mode: ExtractMode): string {
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
  const collapsed = mode === 'markdown' ? lines.replace(/\n{3,}/g, '\n\n') : lines.replace(/\n{2,}/g, '\n');
  return collapsed
    .split(NEWLINE_SENTINEL)
    .join('\n')
    .split(SPACE_SENTINEL)
    .join(' ')
    .trim();
}

/**
 * HTML in, readable text or markdown out, with navigation chrome, language
 * switchers and cookie banners removed first.
 */
export function extract(html: string, mode: ExtractMode): ExtractResult {
  const root = parse(html, {
    comment: false,
    // script/style/noscript text is dropped at parse time; `pre` keeps its raw
    // text so indentation survives (renderPre strips the tags inside it).
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  });

  const rawTitle = root.querySelector('title')?.text;
  const title = rawTitle === undefined ? undefined : collapseInline(rawTitle).trim();
  const removedElements = stripChrome(root);
  const body = root.querySelector('body') ?? root;
  const text = finalize(renderNode(body, mode, 0), mode);

  return { text, title: title === undefined || title.length === 0 ? undefined : title, removedElements };
}

export function extractText(html: string): ExtractResult {
  return extract(html, 'text');
}

export function extractMarkdown(html: string): ExtractResult {
  return extract(html, 'markdown');
}

/** Decides whether a capture should go through the HTML extractor at all. */
export function isHtmlLike(contentType: string | undefined, body: string): boolean {
  if (contentType !== undefined) {
    const type = contentType.toLowerCase();
    if (type.includes('html') || type.includes('xhtml')) return true;
    if (type.startsWith('text/') || type.includes('json') || type.includes('xml')) return false;
  }
  const head = body.slice(0, 2000).toLowerCase();
  return head.includes('<html') || head.includes('<!doctype html') || head.includes('<body');
}

/** Collapses whitespace in already-plain text so non-HTML captures diff cleanly. */
export function normalizePlainText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
