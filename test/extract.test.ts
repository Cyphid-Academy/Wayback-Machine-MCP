import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMarkdown, extractText, isHtmlLike, normalizePlainText } from '../src/lib/extract.js';
import { VARIANTS, pageHtml } from './fixtures/pages.js';

const FIRST = VARIANTS[0];
if (FIRST === undefined) throw new Error('fixture variants missing');

describe('extractText', () => {
  const page = pageHtml(FIRST);
  const result = extractText(page);

  it('keeps the article content', () => {
    assert.match(result.text, /How many messages can I send\?/);
    assert.match(result.text, /Pro subscribers can send at least 100 messages every 8 hours\./);
    assert.match(result.text, /Team plan: higher limits per seat\./);
  });

  it('strips the language switcher, so a 13-language list cannot swamp a diff', () => {
    for (const label of ['Español', 'Français', '日本語', '한국어', 'Bahasa Indonesia']) {
      assert.ok(!result.text.includes(label), `expected the language label ${label} to be stripped`);
    }
  });

  it('strips nav, masthead, footer and cookie banner', () => {
    for (const chrome of ['Getting started', 'Troubleshooting', 'We use cookies', 'Accept all', '© Example Inc.', 'Privacy']) {
      assert.ok(!result.text.includes(chrome), `expected chrome text "${chrome}" to be stripped`);
    }
  });

  it('strips script and style contents', () => {
    assert.ok(!result.text.includes('intercomSettings'));
    assert.ok(!result.text.includes('color:red'));
    assert.ok(!result.text.includes('site-header{'));
  });

  it('never leaks markup into the extracted text', () => {
    // `<token>` in the code sample is content, so this looks for real tags only.
    for (const tag of ['<div', '<p>', '</p>', '<ul', '<li', '<table', '<tr', '<code>', '</code>', '<script', '<html']) {
      assert.ok(!result.text.includes(tag), `expected no ${tag} in the extracted text`);
    }
  });

  it('reports the page title separately from the body', () => {
    assert.equal(result.title, 'How many messages can I send? | Example Help Center');
  });

  it('decodes entities inside <pre> and keeps its line structure', () => {
    assert.match(result.text, /GET \/v1\/usage/);
    assert.match(result.text, /Authorization: Bearer <token>/);
    assert.ok(!result.text.includes('&lt;token&gt;'));
    assert.ok(!result.text.includes('<code>'));
  });

  it('collapses whitespace and leaves no protection sentinels behind', () => {
    assert.ok(!/\n\n/.test(result.text), 'text mode collapses blank lines');
    assert.ok(!/[\u0000-\u0008]/.test(result.text), 'the <pre> whitespace sentinels are restored, not leaked');
    for (const line of result.text.split('\n')) {
      assert.ok(!/\S {2,}\S/.test(line), `unexpected run of spaces inside: ${line}`);
    }
  });

  it('counts the elements it removed', () => {
    assert.ok(result.removedElements > 0);
  });
});

describe('extractMarkdown', () => {
  const result = extractMarkdown(pageHtml(FIRST));

  it('keeps heading levels', () => {
    assert.match(result.text, /^# How many messages can I send\?$/m);
    assert.match(result.text, /^## Plan limits$/m);
  });

  it('renders list items and tables', () => {
    assert.match(result.text, /^- Free plan: a small daily allowance\.$/m);
    assert.match(result.text, /^\| Plan \| Limit \|$/m);
    assert.match(result.text, /^\| --- \| --- \|$/m);
  });

  it('renders fenced code blocks with the original newlines', () => {
    assert.match(result.text, /```\nGET \/v1\/usage\n {2}Authorization: Bearer <token>\n```/);
  });

  it('still strips chrome and language switchers', () => {
    assert.ok(!result.text.includes('Español'));
    assert.ok(!result.text.includes('We use cookies'));
  });
});

describe('extraction edge cases', () => {
  it('does not drop a large container just because its class says "banner"', () => {
    const long = 'This is real article content that happens to live in a wrapper. '.repeat(40);
    const html = `<html><body><div class="banner-wrapper"><p>${long}</p></div></body></html>`;
    const result = extractText(html);
    assert.ok(result.text.length > 1200, 'content longer than the guard is kept');
    assert.match(result.text, /real article content/);
  });

  it('drops a small container whose class says "cookie"', () => {
    const html = '<html><body><div class="cookie-bar">Accept cookies</div><p>Body text.</p></body></html>';
    const result = extractText(html);
    assert.equal(result.text, 'Body text.');
  });

  it('keeps a short list of ordinary links', () => {
    const html =
      '<html><body><ul><li><a href="/a">Pricing</a></li><li><a href="/b">Docs</a></li><li><a href="/c">Support</a></li></ul></body></html>';
    assert.match(extractText(html).text, /Pricing/);
  });

  it('drops a list of bare locale codes', () => {
    const codes = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja']
      .map((code) => `<li><a href="/${code}">${code}</a></li>`)
      .join('');
    const html = `<html><body><ul class="locales">${codes}</ul><p>Body text.</p></body></html>`;
    assert.equal(extractText(html).text, 'Body text.');
  });

  it('handles an empty document and a fragment without a body', () => {
    assert.equal(extractText('').text, '');
    assert.match(extractText('<p>Just a fragment</p>').text, /Just a fragment/);
  });

  it('handles a wayback-wrapped page by removing the injected banner', () => {
    const html =
      '<html><body><div id="wm-ipp-base">INTERNET ARCHIVE toolbar</div><main><p>Real content.</p></main></body></html>';
    const result = extractText(html);
    assert.equal(result.text, 'Real content.');
  });
});

describe('isHtmlLike', () => {
  it('trusts an HTML content type', () => {
    assert.equal(isHtmlLike('text/html; charset=utf-8', ''), true);
    assert.equal(isHtmlLike('application/xhtml+xml', ''), true);
  });

  it('rejects plain text, JSON and XML content types', () => {
    assert.equal(isHtmlLike('text/plain', '<html>'), false);
    assert.equal(isHtmlLike('application/json', '{}'), false);
  });

  it('sniffs the body when there is no content type', () => {
    assert.equal(isHtmlLike(undefined, '<!DOCTYPE html><html><body>x</body></html>'), true);
    assert.equal(isHtmlLike(undefined, 'timestamp,value\n1,2\n'), false);
  });
});

describe('normalizePlainText', () => {
  it('collapses trailing whitespace and long blank runs', () => {
    assert.equal(normalizePlainText('a  \n\n\n\nb   \t\n'), 'a\n\nb');
  });
});
