import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { DIFF_INLINE_CAP } from '../src/lib/diff.js';
import {
  INLINE_TEXT_LIMIT,
  MAX_INLINE_CHARS,
  MAX_TABLE_ROWS,
  PREVIEW_CHARS,
  diffResourceUri,
  isEphemeralHost,
  mimeTypeForFormat,
  resourceLink,
  snapshotResourceUri,
  textPayload,
  truncationNotice,
} from '../src/lib/resources.js';

const config = loadConfig({
  DEPLOY_URL: 'https://wayback.example.test/',
  MCP_PATH_SECRET: 'secret123',
  CONTACT_EMAIL: 'test@example.org',
});

const base = { baseUrl: config.deployUrl, pathSecret: config.pathSecret };

describe('textPayload — the 8,000 character threshold', () => {
  it('inlines text at or below the limit', () => {
    const text = 'a'.repeat(INLINE_TEXT_LIMIT);
    const payload = textPayload(text);
    assert.equal(payload.truncated, false);
    assert.equal(payload.inline, text);
    assert.equal(payload.totalChars, INLINE_TEXT_LIMIT);
    assert.equal(payload.preview.length, PREVIEW_CHARS);
  });

  it('withholds text one character over the limit and previews 2,000 characters', () => {
    const text = 'a'.repeat(INLINE_TEXT_LIMIT + 1);
    const payload = textPayload(text);
    assert.equal(payload.truncated, true);
    assert.equal(payload.inline, undefined);
    assert.equal(payload.preview.length, PREVIEW_CHARS);
    assert.equal(payload.totalChars, INLINE_TEXT_LIMIT + 1);
  });

  it('previews short text in full', () => {
    const payload = textPayload('short');
    assert.equal(payload.preview, 'short');
    assert.equal(payload.inline, 'short');
  });

  it('uses the documented constants', () => {
    assert.equal(INLINE_TEXT_LIMIT, 8_000);
    assert.equal(PREVIEW_CHARS, 2_000);
    assert.equal(MAX_TABLE_ROWS, 250);
  });
});

describe('resource URIs', () => {
  it('builds a snapshot URI under the path secret with the URL encoded', () => {
    const uri = snapshotResourceUri(base, '20230901120000', 'support.example.org/en/articles/1?x=1', 'markdown');
    assert.equal(
      uri,
      'https://wayback.example.test/r/secret123/snapshot/20230901120000/support.example.org%2Fen%2Farticles%2F1%3Fx%3D1?format=markdown',
    );
    assert.ok(!uri.includes('//r/'), 'no double slash from a trailing-slash DEPLOY_URL');
  });

  it('builds a diff URI with both timestamps and the granularity', () => {
    const uri = diffResourceUri(base, '20230901120000', '20260101120000', 'example.com/p', 'line');
    assert.equal(uri, 'https://wayback.example.test/r/secret123/diff/20230901120000/20260101120000/example.com%2Fp?granularity=line');
  });

  it('round-trips an encoded URL', () => {
    const original = 'https://example.com/a b/c?d=e&f=g';
    const uri = snapshotResourceUri(base, '20230901120000', original, 'text');
    const encoded = uri.split('/snapshot/20230901120000/')[1]?.split('?')[0] ?? '';
    assert.equal(decodeURIComponent(encoded), original);
  });
});

describe('resource base resolution (F5)', () => {
  it('flags a Replit workspace host as ephemeral', () => {
    assert.equal(isEphemeralHost('https://something-kirk.replit.dev'), true);
    assert.equal(isEphemeralHost('https://wayback-machine-mcp.replit.app'), false);
    assert.equal(isEphemeralHost('http://localhost:3000'), false);
    assert.equal(isEphemeralHost('not a url'), false);
  });

  it('builds URIs from whatever base it is handed, not from configuration', () => {
    const deployed = { baseUrl: 'https://wayback-machine-mcp.replit.app', pathSecret: 'sec' };
    const uri = snapshotResourceUri(deployed, '20240101000000', 'example.com/p', 'text');
    assert.ok(uri.startsWith('https://wayback-machine-mcp.replit.app/r/sec/snapshot/'));
    assert.ok(!uri.includes('replit.dev'));
  });
});

describe('textPayload escalation (F8)', () => {
  it('inlines up to an escalated limit and reports the cut', () => {
    const text = 'a'.repeat(20_000);
    const payload = textPayload(text, 12_000);
    assert.equal(payload.truncated, true);
    assert.equal(payload.inline?.length, 12_000);
    assert.match(truncationNotice(12_000, 20_000), /Truncated at 12,000 of 20,000 characters/);
    assert.match(truncationNotice(12_000, 20_000), /higher maxChars/);
  });

  it('inlines nothing beyond the preview at the default limit', () => {
    const payload = textPayload('a'.repeat(20_000));
    assert.equal(payload.inline, undefined);
    assert.equal(payload.preview.length, PREVIEW_CHARS);
  });

  it('caps escalation at 100,000 characters', () => {
    assert.equal(MAX_INLINE_CHARS, 100_000);
  });
});

describe('resourceLink', () => {
  it('omits optional fields that were not supplied', () => {
    const link = resourceLink({ uri: 'https://example.test/x', name: 'x' });
    assert.deepEqual(link, { type: 'resource_link', uri: 'https://example.test/x', name: 'x' });
  });

  it('includes every supplied field', () => {
    const link = resourceLink({
      uri: 'https://example.test/x',
      name: 'x',
      title: 'Title',
      description: 'Description',
      mimeType: 'text/plain',
      size: 42,
    });
    assert.equal(link.type, 'resource_link');
    assert.equal(link.title, 'Title');
    assert.equal(link.description, 'Description');
    assert.equal(link.mimeType, 'text/plain');
    assert.equal(link.size, 42);
  });
});

describe('mimeTypeForFormat', () => {
  it('maps markdown and text', () => {
    assert.equal(mimeTypeForFormat('markdown'), 'text/markdown');
    assert.equal(mimeTypeForFormat('text'), 'text/plain');
  });
});

describe('config', () => {
  it('strips a trailing slash from DEPLOY_URL and builds the User-Agent', () => {
    assert.equal(config.deployUrl, 'https://wayback.example.test');
    assert.equal(config.userAgent, 'wayback-mcp/1.0 (+https://wayback.example.test; test@example.org)');
  });

  it('generates a 32-character path secret when none is supplied', () => {
    const generated = loadConfig({ CONTACT_EMAIL: 'a@b.test' });
    assert.equal(generated.pathSecretGenerated, true);
    assert.equal(generated.pathSecret.length, 32);
    assert.match(generated.pathSecret, /^[A-Za-z0-9_-]{32}$/);
    assert.notEqual(loadConfig({}).pathSecret, generated.pathSecret, 'not a constant');
  });

  it('infers DEPLOY_URL from the Replit environment', () => {
    assert.equal(loadConfig({ REPLIT_DOMAINS: 'my-app.replit.app,other' }).deployUrl, 'https://my-app.replit.app');
    assert.equal(loadConfig({ REPLIT_DEV_DOMAIN: 'dev.replit.dev' }).deployUrl, 'https://dev.replit.dev');
    assert.equal(loadConfig({ PORT: '4000' }).deployUrl, 'http://localhost:4000');
  });

  it('defaults to no bearer token, save disabled and JSON responses', () => {
    const defaults = loadConfig({});
    assert.equal(defaults.authToken, undefined);
    assert.equal(defaults.enableSave, false);
    assert.equal(defaults.jsonResponse, true);
    assert.equal(defaults.rateLimitPerMinute, 10);
    assert.equal(defaults.upstreamTimeoutMs, 25_000);
    assert.equal(defaults.host, '0.0.0.0');
    assert.equal(defaults.port, 3_000);
  });

  it('warns about a missing contact email and a generated secret', () => {
    const warnings = loadConfig({}).warnings.join('\n');
    assert.match(warnings, /CONTACT_EMAIL/);
    assert.match(warnings, /MCP_PATH_SECRET/);
  });

  it('parses ENABLE_SAVE and MCP_SSE truthiness', () => {
    assert.equal(loadConfig({ ENABLE_SAVE: 'true' }).enableSave, true);
    assert.equal(loadConfig({ ENABLE_SAVE: '1' }).enableSave, true);
    assert.equal(loadConfig({ ENABLE_SAVE: 'no' }).enableSave, false);
    assert.equal(loadConfig({ MCP_SSE: 'true' }).jsonResponse, false);
  });

  it('clamps out-of-range numeric settings', () => {
    assert.equal(loadConfig({ RATE_LIMIT_PER_MINUTE: '0' }).rateLimitPerMinute, 1);
    assert.equal(loadConfig({ RATE_LIMIT_PER_MINUTE: '99999' }).rateLimitPerMinute, 600);
    assert.equal(loadConfig({ UPSTREAM_TIMEOUT_MS: '10' }).upstreamTimeoutMs, 1_000);
  });
});

// Guards the hard limits from build spec §2 against drift.
describe('spec limits', () => {
  it('keeps the diff cap at 15,000 characters', () => {
    assert.equal(DIFF_INLINE_CAP, 15_000);
  });
});
