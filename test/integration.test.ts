import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createApp, createRuntime, type Runtime } from '../src/index.js';
import { startFixtureUpstream, type FixtureUpstream } from './fixtures/upstream.js';
import { TARGET_URL, VARIANTS } from './fixtures/pages.js';

const SECRET = 'integration-path-secret';
const DEPLOY_URL = 'https://wayback.example.test';
const PROTOCOL_VERSION = '2025-11-25';

let fixture: FixtureUpstream;
let runtime: Runtime;
let httpServer: Server;
let baseUrl: string;
let requestId = 0;

interface JsonRpcEnvelope {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface TextBlock {
  readonly type: string;
  readonly text: string | undefined;
  readonly uri: string | undefined;
  readonly name: string | undefined;
  readonly mimeType: string | undefined;
  readonly size: number | undefined;
  readonly description: string | undefined;
}

interface ToolResult {
  readonly content?: readonly TextBlock[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface ToolDescriptor {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly inputSchema: Record<string, unknown> | undefined;
  readonly outputSchema: Record<string, unknown> | undefined;
  readonly annotations: Record<string, unknown> | undefined;
}

/** Narrows unknown JSON to a plain record without a type assertion. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

before(async () => {
  fixture = await startFixtureUpstream();
  const config = loadConfig({
    PORT: '0',
    DEPLOY_URL,
    CONTACT_EMAIL: 'integration@example.org',
    MCP_PATH_SECRET: SECRET,
    ENABLE_SAVE: 'true',
    WEB_ARCHIVE_BASE: fixture.origin,
    ARCHIVE_BASE: fixture.origin,
    RATE_LIMIT_PER_MINUTE: '600',
  });
  runtime = createRuntime(config);
  httpServer = createApp(runtime).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => {
    httpServer.once('listening', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('test server failed to bind');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    httpServer.close(() => {
      resolve();
    });
  });
  await fixture.close();
});

async function rpc(method: string, params?: Record<string, unknown>, options: { readonly path?: string; readonly headers?: Record<string, string> } = {}): Promise<{ status: number; body: JsonRpcEnvelope }> {
  requestId += 1;
  const response = await fetch(`${baseUrl}${options.path ?? `/mcp/${SECRET}`}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...options.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, ...(params === undefined ? {} : { params }) }),
  });
  const text = await response.text();
  let body: JsonRpcEnvelope = {};
  if (text.length > 0) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) body = parsed;
  }
  return { status: response.status, body };
}

function resultObject(envelope: JsonRpcEnvelope): Record<string, unknown> {
  assert.equal(envelope.error, undefined, `unexpected JSON-RPC error: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result;
  assert.ok(typeof result === 'object' && result !== null, 'expected a result object');
  return Object.fromEntries(Object.entries(result));
}

function toolList(envelope: JsonRpcEnvelope): ToolDescriptor[] {
  const raw = resultObject(envelope)['tools'];
  assert.ok(Array.isArray(raw), 'tools must be an array');
  const tools: ToolDescriptor[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    assert.ok(record !== undefined, 'each tool must be an object');
    const name = asString(record['name']);
    assert.ok(name !== undefined, 'each tool must have a name');
    tools.push({
      name,
      title: asString(record['title']),
      description: asString(record['description']),
      inputSchema: asRecord(record['inputSchema']),
      outputSchema: asRecord(record['outputSchema']),
      annotations: asRecord(record['annotations']),
    });
  }
  return tools;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const { body } = await rpc('tools/call', { name, arguments: args });
  const result = resultObject(body);
  const content = result['content'];
  const structured = result['structuredContent'];
  return {
    ...(Array.isArray(content) ? { content: contentBlocks(content) } : {}),
    ...(typeof structured === 'object' && structured !== null ? { structuredContent: Object.fromEntries(Object.entries(structured)) } : {}),
    ...(result['isError'] === true ? { isError: true } : {}),
  };
}

function contentBlocks(raw: readonly unknown[]): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    assert.ok(record !== undefined, 'each content block must be an object');
    blocks.push({
      type: asString(record['type']) ?? '',
      text: asString(record['text']),
      uri: asString(record['uri']),
      name: asString(record['name']),
      mimeType: asString(record['mimeType']),
      size: asNumber(record['size']),
      description: asString(record['description']),
    });
  }
  return blocks;
}

function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

function linksOf(result: ToolResult): TextBlock[] {
  return (result.content ?? []).filter((block) => block.type === 'resource_link');
}

function num(structured: Record<string, unknown> | undefined, key: string): number {
  const value = structured?.[key];
  assert.equal(typeof value, 'number', `${key} should be a number, got ${typeof value}`);
  return typeof value === 'number' ? value : Number.NaN;
}

function str(structured: Record<string, unknown> | undefined, key: string): string {
  const value = structured?.[key];
  assert.equal(typeof value, 'string', `${key} should be a string, got ${typeof value}`);
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------

describe('transport and handshake', () => {
  it('answers /healthz instantly with no upstream traffic', async () => {
    const before = fixture.requests.length;
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
    assert.equal(fixture.requests.length, before, 'the health check touches nothing');
  });

  it('serves a root document that leaks no secret', async () => {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(SECRET), 'the path secret is never published');
    assert.match(text, /streamable-http/);
    assert.match(text, /\{MCP_PATH_SECRET\}/);
  });

  it('completes an initialize handshake at the latest protocol version', async () => {
    const { status, body } = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '1.0.0' },
    });
    assert.equal(status, 200);
    const result = resultObject(body);
    assert.equal(result['protocolVersion'], PROTOCOL_VERSION);
    const serverInfo = result['serverInfo'];
    assert.ok(typeof serverInfo === 'object' && serverInfo !== null);
    assert.match(JSON.stringify(serverInfo), /wayback-machine-mcp/);
    assert.match(JSON.stringify(result['capabilities']), /tools/);
  });

  it('issues no session id, so no request is pinned to an instance', async () => {
    const response = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
  });

  it('serves tools/list without a prior initialize on the same connection', async () => {
    const { body } = await rpc('tools/list');
    assert.ok(toolList(body).length > 0, 'statelessness means each request stands alone');
  });

  it('rejects an unsupported MCP-Protocol-Version with 400', async () => {
    const { status, body } = await rpc('tools/list', undefined, { headers: { 'mcp-protocol-version': '1999-01-01' } });
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /Unsupported MCP-Protocol-Version/);
  });

  it('accepts a request with no MCP-Protocol-Version header', async () => {
    const response = await fetch(`${baseUrl}/mcp/${SECRET}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1_000, method: 'tools/list' }),
    });
    assert.equal(response.status, 200);
  });

  it('rejects a wrong path secret as 404, and requires the secret at all', async () => {
    for (const path of [`/mcp/wrong-secret`, `/mcp/`, `/mcp`]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(response.status, 404, `expected 404 for ${path}`);
    }
  });

  it('allows a request with no Origin header', async () => {
    const { status } = await rpc('tools/list');
    assert.equal(status, 200);
  });

  it('allows claude.ai and localhost origins but rejects an unknown one', async () => {
    for (const origin of ['https://claude.ai', 'http://localhost:6274']) {
      const { status } = await rpc('tools/list', undefined, { headers: { origin } });
      assert.equal(status, 200, `expected ${origin} to be allowed`);
    }
    const { status, body } = await rpc('tools/list', undefined, { headers: { origin: 'https://evil.example' } });
    assert.equal(status, 403);
    assert.match(JSON.stringify(body), /forbidden_origin/);
  });

  it('answers DELETE with 405 because there is no session to end', async () => {
    const response = await fetch(`${baseUrl}/mcp/${SECRET}`, { method: 'DELETE' });
    assert.equal(response.status, 405);
  });

  it('returns a JSON 404 for an unknown route', async () => {
    const response = await fetch(`${baseUrl}/nope`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /not_found/);
  });
});

describe('tools/list', () => {
  it('lists every registered tool with save_url present when enabled', async () => {
    const tools = toolList((await rpc('tools/list')).body);
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'archive_stats',
      'check_availability',
      'clear_cache',
      'compare_snapshots',
      'get_item_metadata',
      'get_snapshot',
      'list_revisions',
      'list_screenshots',
      'save_url',
      'search_items',
      'search_snapshots',
    ]);
  });

  it('gives every tool a title, a description, an input schema and an output schema', async () => {
    for (const tool of toolList((await rpc('tools/list')).body)) {
      assert.ok((tool.title ?? '').length > 0, `${tool.name} needs a title`);
      assert.ok((tool.description ?? '').length > 40, `${tool.name} needs a useful description`);
      assert.equal(tool.inputSchema?.['type'], 'object', `${tool.name} input schema`);
      assert.equal(tool.outputSchema?.['type'], 'object', `${tool.name} output schema`);
      assert.ok(tool.outputSchema?.['properties'] !== undefined, `${tool.name} output properties`);
    }
  });

  it('annotates query tools readOnly and openWorld, and save_url as a write', async () => {
    const tools = toolList((await rpc('tools/list')).body);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of [
      'archive_stats',
      'check_availability',
      'search_snapshots',
      'list_revisions',
      'get_snapshot',
      'compare_snapshots',
      'list_screenshots',
      'search_items',
      'get_item_metadata',
    ]) {
      const annotations = byName.get(name)?.annotations;
      assert.equal(annotations?.['readOnlyHint'], true, `${name} readOnlyHint`);
      assert.equal(annotations?.['openWorldHint'], true, `${name} openWorldHint`);
      assert.equal(typeof annotations?.['title'], 'string', `${name} annotation title`);
    }
    const save = byName.get('save_url')?.annotations;
    assert.equal(save?.['readOnlyHint'], false);
    assert.equal(save?.['destructiveHint'], false);
    assert.equal(save?.['openWorldHint'], true);
  });

  it('marks required inputs and documents each property', async () => {
    const tools = toolList((await rpc('tools/list')).body);
    const stats = tools.find((tool) => tool.name === 'archive_stats');
    assert.deepEqual(stats?.inputSchema?.['required'], ['url']);
    const snapshots = tools.find((tool) => tool.name === 'search_snapshots');
    const properties = asRecord(snapshots?.inputSchema?.['properties']) ?? {};
    for (const key of ['url', 'matchType', 'from', 'to', 'limit', 'collapse', 'filter', 'resolveRevisits']) {
      assert.ok(key in properties, `search_snapshots should expose ${key}`);
    }
  });
});

describe('archive_stats', () => {
  it('summarises coverage from the sparkline endpoint', async () => {
    const result = await callTool('archive_stats', { url: TARGET_URL });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'source'), 'sparkline');
    assert.ok(num(result.structuredContent, 'totalCaptures') > 250);
    assert.match(str(result.structuredContent, 'firstCapture'), /^20230912/);
    const byYear = result.structuredContent?.['byYear'];
    assert.ok(typeof byYear === 'object' && byYear !== null);
    assert.match(textOf(result), /Captures per year/);
    assert.match(textOf(result), /Next: list_revisions/);
  });

  it('keeps the summary inside the 2,000 character budget', async () => {
    const result = await callTool('archive_stats', { url: TARGET_URL });
    assert.ok(textOf(result).length <= 2_000, `summary was ${String(textOf(result).length)} chars`);
  });

  it('reports an unarchived URL as zero captures, not as an error', async () => {
    const result = await callTool('archive_stats', { url: 'never-archived.example/nothing' });
    assert.notEqual(result.isError, true);
    assert.equal(num(result.structuredContent, 'totalCaptures'), 0);
    assert.match(textOf(result), /No captures found/);
  });

  it('rejects a malformed URL with an actionable error', async () => {
    const result = await callTool('archive_stats', { url: 'not a url' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid_input/);
    assert.match(textOf(result), /example\.com/);
  });

  it('rejects a missing url argument', async () => {
    const result = await callTool('archive_stats', {});
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid_input/);
  });
});

describe('check_availability', () => {
  it('finds the closest capture to a date', async () => {
    const result = await callTool('check_availability', { url: TARGET_URL, timestamp: '2024-07-01' });
    assert.equal(result.structuredContent?.['available'], true);
    assert.match(str(result.structuredContent, 'timestamp'), /^\d{14}$/);
    assert.match(str(result.structuredContent, 'snapshotUrl'), /^https:\/\//, 'http:// is upgraded');
    assert.match(textOf(result), /Next: get_snapshot/);
  });

  it('defaults to the most recent capture when no timestamp is given', async () => {
    const result = await callTool('check_availability', { url: TARGET_URL });
    assert.match(str(result.structuredContent, 'timestamp'), /^2026/);
  });

  it('reports an unarchived URL as unavailable and points at the CDX tools', async () => {
    const result = await callTool('check_availability', { url: 'never-archived.example/nothing' });
    assert.equal(result.structuredContent?.['available'], false);
    assert.equal(result.structuredContent?.['timestamp'], null);
    assert.match(textOf(result), /search_snapshots/);
  });

  it('rejects an impossible date', async () => {
    const result = await callTool('check_availability', { url: TARGET_URL, timestamp: '2023-13-45' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Could not read/);
  });
});

describe('search_snapshots', () => {
  it('returns structured rows rather than raw CDX text', async () => {
    const result = await callTool('search_snapshots', { url: TARGET_URL, limit: 5 });
    const rows = result.structuredContent?.['rows'];
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 5);
    const first = rows[0];
    assert.ok(typeof first === 'object' && first !== null);
    for (const key of ['timestamp', 'original', 'statuscode', 'mimetype', 'digest', 'length', 'snapshotUrl']) {
      assert.ok(key in first, `row should carry ${key}`);
    }
    assert.equal(result.structuredContent?.['hasMore'], true);
    assert.equal(num(result.structuredContent, 'nextOffset'), 5);
  });

  it('honours a date range', async () => {
    const result = await callTool('search_snapshots', { url: TARGET_URL, from: '2024-01-01', to: '2024-12-31', limit: 1000 });
    const rows = result.structuredContent?.['rows'];
    assert.ok(Array.isArray(rows));
    for (const row of rows) {
      assert.ok(typeof row === 'object' && row !== null);
      const timestamp = Object.fromEntries(Object.entries(row))['timestamp'];
      assert.match(String(timestamp), /^2024/);
    }
  });

  it('applies status filters', async () => {
    const all = await callTool('search_snapshots', { url: TARGET_URL, limit: 1000, filter: ['statuscode:302'] });
    const rows = all.structuredContent?.['rows'];
    assert.ok(Array.isArray(rows) && rows.length === 1, 'the fixture has exactly one redirect capture');
  });

  it('trims very large row sets and says how to page', async () => {
    const result = await callTool('search_snapshots', { url: TARGET_URL, limit: 1000 });
    assert.equal(result.structuredContent?.['rowsTruncated'], true);
    assert.equal(num(result.structuredContent, 'totalReturned'), 250);
    assert.match(textOf(result), /Trimmed to 250 rows/);
  });

  it('supports collapse for one capture per day', async () => {
    const collapsed = await callTool('search_snapshots', { url: TARGET_URL, collapse: 'timestamp:8', limit: 1000 });
    const uncollapsed = await callTool('search_snapshots', { url: TARGET_URL, limit: 1000 });
    assert.ok(
      num(collapsed.structuredContent, 'totalReturned') <= num(uncollapsed.structuredContent, 'totalReturned'),
    );
  });

  it('returns an empty result set without erroring', async () => {
    const result = await callTool('search_snapshots', { url: TARGET_URL, from: '1999', to: '2000' });
    assert.notEqual(result.isError, true);
    assert.equal(num(result.structuredContent, 'totalReturned'), 0);
    assert.match(textOf(result), /No captures matched/);
  });

  it('rejects a limit above the documented maximum', async () => {
    const result = await callTool('search_snapshots', { url: TARGET_URL, limit: 5_000 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid_input/);
  });
});

describe('list_revisions — the driving use case', () => {
  it('collapses hundreds of captures into the handful of real revisions', async () => {
    const result = await callTool('list_revisions', { url: TARGET_URL });
    assert.notEqual(result.isError, true, textOf(result));
    const revisions = result.structuredContent?.['revisions'];
    assert.ok(Array.isArray(revisions));
    assert.equal(revisions.length, VARIANTS.length, 'one row per distinct body');
    assert.ok(revisions.length >= 5 && revisions.length <= 20, 'acceptance criterion: 5-20 rows, not hundreds');
    assert.ok(num(result.structuredContent, 'capturesExamined') > 250, 'derived from the full capture list');
  });

  it('carries revisionIndex, digest, firstSeen, lastSeen and captureCount per row', async () => {
    const result = await callTool('list_revisions', { url: TARGET_URL });
    const revisions = result.structuredContent?.['revisions'];
    assert.ok(Array.isArray(revisions));
    let previousLastSeen = '';
    let totalCaptures = 0;
    for (const [index, entry] of revisions.entries()) {
      assert.ok(typeof entry === 'object' && entry !== null);
      const row = Object.fromEntries(Object.entries(entry));
      assert.equal(row['revisionIndex'], index + 1);
      assert.match(String(row['digest']), /^\S+$/);
      assert.match(String(row['firstSeen']), /^\d{14}$/);
      assert.match(String(row['lastSeen']), /^\d{14}$/);
      assert.ok(String(row['firstSeen']) <= String(row['lastSeen']), 'firstSeen precedes lastSeen');
      assert.ok(String(row['firstSeen']) > previousLastSeen, 'revisions are chronological and non-overlapping');
      previousLastSeen = String(row['lastSeen']);
      assert.ok(Number(row['captureCount']) >= 1);
      totalCaptures += Number(row['captureCount']);
      assert.match(String(row['snapshotUrl']), /\/web\/\d{14}\//);
    }
    assert.equal(totalCaptures, num(result.structuredContent, 'capturesExamined'), 'every capture belongs to a revision');
  });

  it('excludes redirects by default and can include them', async () => {
    const withoutRedirects = await callTool('list_revisions', { url: TARGET_URL });
    const withRedirects = await callTool('list_revisions', { url: TARGET_URL, includeRedirects: true });
    assert.ok(
      num(withRedirects.structuredContent, 'capturesExamined') > num(withoutRedirects.structuredContent, 'capturesExamined'),
    );
  });

  it('honours a date range', async () => {
    const result = await callTool('list_revisions', { url: TARGET_URL, from: '2023-09-01', to: '2024-01-01' });
    const revisions = result.structuredContent?.['revisions'];
    assert.ok(Array.isArray(revisions));
    assert.ok(revisions.length < VARIANTS.length, 'a narrower window sees fewer revisions');
  });

  it('reports when the capture list hit the cap', async () => {
    const result = await callTool('list_revisions', { url: TARGET_URL, maxCaptures: 20 });
    assert.equal(result.structuredContent?.['capturesTruncated'], true);
    assert.match(textOf(result), /maxCaptures/);
  });

  it('suggests the compare_snapshots call to run next', async () => {
    const result = await callTool('list_revisions', { url: TARGET_URL });
    assert.match(textOf(result), /Next: compare_snapshots .*timestampA="\d{14}" timestampB="\d{14}"/);
  });

  it('keeps its summary inside the 2,000 character budget', async () => {
    const result = await callTool('list_revisions', { url: TARGET_URL });
    assert.ok(textOf(result).length <= 2_000);
  });
});

describe('get_snapshot', () => {
  it('returns chrome-stripped text inline for a small capture', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest' });
    assert.notEqual(result.isError, true, textOf(result));
    const text = textOf(result);
    assert.match(text, /How many messages can I send\?/);
    assert.match(text, /100 messages every 8 hours/);
    assert.ok(!text.includes('Español'), 'the language switcher is stripped');
    assert.ok(!text.includes('We use cookies'));
    assert.equal(result.structuredContent?.['truncated'], false);
    assert.equal(result.structuredContent?.['resourceUri'], null);
    assert.equal(linksOf(result).length, 0, 'small captures need no resource link');
  });

  it('reports the resolved capture, mime type, title and character count', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest' });
    assert.match(str(result.structuredContent, 'timestamp'), /^20230912/);
    assert.match(str(result.structuredContent, 'mimeType'), /text\/html/);
    assert.match(str(result.structuredContent, 'title'), /How many messages/);
    assert.ok(num(result.structuredContent, 'totalChars') > 100);
    assert.match(str(result.structuredContent, 'resolvedUrl'), /id_\//, 'fetched with the id_ modifier');
  });

  it('returns a preview plus a ResourceLink when the text exceeds 8,000 characters', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    assert.equal(result.structuredContent?.['truncated'], true);
    assert.ok(num(result.structuredContent, 'totalChars') > 8_000);
    const links = linksOf(result);
    assert.equal(links.length, 1);
    const link = links[0];
    assert.ok((link?.uri ?? '').startsWith(`${DEPLOY_URL}/r/${SECRET}/snapshot/`), `unexpected uri ${String(link?.uri)}`);
    assert.equal(link?.mimeType, 'text/plain');
    assert.ok((link?.size ?? 0) > 8_000);
    assert.ok((link?.name ?? '').length > 0, 'a ResourceLink must carry a name');
    assert.ok((link?.description ?? '').length > 0);
    assert.match(textOf(result), /Preview \(first/);
    assert.ok(textOf(result).length < num(result.structuredContent, 'totalChars'));
  });

  it('never inlines raw HTML, even when format=raw', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest', format: 'raw' });
    const text = textOf(result);
    assert.ok(!text.includes('<html'), 'raw HTML must never reach the content channel');
    assert.ok(!text.includes('<div'));
    assert.match(text, /never inlines the capture/);
    assert.equal(linksOf(result).length, 1);
  });

  it('renders markdown with headings and links', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest', format: 'markdown' });
    assert.match(textOf(result), /^# How many messages can I send\?$/m);
    assert.equal(str(result.structuredContent, 'format'), 'markdown');
  });

  it('resolves a partial date to the nearest capture', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: '2025-01' });
    assert.match(str(result.structuredContent, 'timestamp'), /^\d{14}$/);
    assert.match(textOf(result), /70 messages every 6 hours/);
  });

  it('follows the upstream redirect to a neighbouring capture', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: '20240401123456' });
    const resolved = str(result.structuredContent, 'timestamp');
    assert.match(resolved, /^\d{14}$/);
    assert.notEqual(resolved, '20240401123456', 'the fixture redirects to the real capture');
    assert.equal(str(result.structuredContent, 'requestedTimestamp'), '20240401123456');
  });

  it('reports a URL with no captures as an actionable error', async () => {
    const result = await callTool('get_snapshot', { url: 'never-archived.example/nothing' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /no_captures|not_found|upstream_error/);
    assert.ok(!textOf(result).includes('    at '), 'no stack traces in tool errors');
  });

  it('rejects an unknown modifier', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, modifier: 'zz_' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid_input/);
  });
});

describe('compare_snapshots — the reason the server exists', () => {
  it('diffs earliest against latest and surfaces the changed sentence', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL });
    assert.notEqual(result.isError, true, textOf(result));
    const text = textOf(result);
    assert.equal(result.structuredContent?.['identical'], false);
    assert.match(text, /^-.*100 messages every 8 hours/m, 'the older wording is removed');
    assert.match(text, /^\+.*45 messages every 5 hours/m, 'the newer wording is added');
  });

  it('produces a diff free of navigation and language-switcher noise', async () => {
    const text = textOf(await callTool('compare_snapshots', { url: TARGET_URL }));
    for (const noise of ['Español', 'Français', '日本語', 'We use cookies', 'Getting started', '© Example Inc.']) {
      assert.ok(!text.includes(noise), `diff should not contain chrome: ${noise}`);
    }
  });

  it('reports statistics and the Wayback visual diff URL', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL });
    assert.ok(num(result.structuredContent, 'addedChars') > 0);
    assert.ok(num(result.structuredContent, 'removedChars') > 0);
    assert.ok(num(result.structuredContent, 'changedSections') >= 1);
    assert.ok(num(result.structuredContent, 'charsA') > 0);
    assert.ok(num(result.structuredContent, 'charsB') > 0);
    assert.match(str(result.structuredContent, 'visualDiffUrl'), /\/web\/diff\/\d{14}\/\d{14}\//);
    assert.match(str(result.structuredContent, 'timestampAIso'), /^2023-09/);
  });

  it('diffs two specific revisions from list_revisions', async () => {
    const revisions = (await callTool('list_revisions', { url: TARGET_URL })).structuredContent?.['revisions'];
    assert.ok(Array.isArray(revisions));
    const readFirstSeen = (index: number): string => {
      const entry = revisions[index];
      assert.ok(typeof entry === 'object' && entry !== null);
      return String(Object.fromEntries(Object.entries(entry))['firstSeen']);
    };
    const result = await callTool('compare_snapshots', {
      url: TARGET_URL,
      timestampA: readFirstSeen(2),
      timestampB: readFirstSeen(4),
    });
    assert.equal(result.structuredContent?.['identical'], false);
    assert.match(textOf(result), /90 messages every 8 hours/);
    assert.match(textOf(result), /70 messages every 6 hours/);
  });

  it('caps the inline diff at 15,000 characters and links to the rest', async () => {
    const revisions = (await callTool('list_revisions', { url: TARGET_URL })).structuredContent?.['revisions'];
    assert.ok(Array.isArray(revisions));
    const last = revisions[revisions.length - 1];
    assert.ok(typeof last === 'object' && last !== null);
    const latest = String(Object.fromEntries(Object.entries(last))['firstSeen']);
    const result = await callTool('compare_snapshots', { url: TARGET_URL, timestampA: 'earliest', timestampB: latest });
    const text = textOf(result);
    if (result.structuredContent?.['truncated'] === true) {
      assert.ok(text.length <= 17_000, 'capped diff plus header stays small');
      const links = linksOf(result);
      assert.equal(links.length, 1);
      assert.ok((links[0]?.uri ?? '').startsWith(`${DEPLOY_URL}/r/${SECRET}/diff/`));
    } else {
      assert.ok(num(result.structuredContent, 'diffTotalChars') <= 15_000);
    }
  });

  it('supports word granularity', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL, granularity: 'word' });
    assert.equal(str(result.structuredContent, 'granularity'), 'word');
    assert.match(textOf(result), /^\+ /m);
    assert.match(textOf(result), /^- /m);
  });

  it('explains when both timestamps resolve to the same capture', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL, timestampA: 'latest', timestampB: 'latest' });
    assert.equal(result.structuredContent?.['identical'], true);
    assert.match(textOf(result), /same capture/);
    assert.match(textOf(result), /list_revisions/);
  });

  it('reports two different captures with identical text as unchanged', async () => {
    const rows = (await callTool('search_snapshots', { url: TARGET_URL, from: '2023-09-12', to: '2023-10-01', limit: 5 }))
      .structuredContent?.['rows'];
    assert.ok(Array.isArray(rows) && rows.length >= 2);
    const stampAt = (index: number): string => {
      const entry = rows[index];
      assert.ok(typeof entry === 'object' && entry !== null);
      return String(Object.fromEntries(Object.entries(entry))['timestamp']);
    };
    const result = await callTool('compare_snapshots', { url: TARGET_URL, timestampA: stampAt(0), timestampB: stampAt(1) });
    assert.equal(result.structuredContent?.['identical'], true);
    assert.match(textOf(result), /identical/);
  });
});

describe('list_screenshots', () => {
  it('returns an empty list rather than an error when there are none', async () => {
    const result = await callTool('list_screenshots', { url: TARGET_URL });
    assert.notEqual(result.isError, true);
    assert.equal(num(result.structuredContent, 'totalReturned'), 0);
    assert.match(textOf(result), /No screenshot captures/);
    assert.match(textOf(result), /Save Page Now/);
  });
});

describe('archive.org item tools', () => {
  it('searches items and returns compact rows', async () => {
    const result = await callTool('search_items', { query: 'title:(apollo)', rows: 3 });
    assert.notEqual(result.isError, true, textOf(result));
    const items = result.structuredContent?.['items'];
    assert.ok(Array.isArray(items) && items.length === 3);
    const first = items[0];
    assert.ok(typeof first === 'object' && first !== null);
    const row = Object.fromEntries(Object.entries(first));
    assert.equal(row['identifier'], 'apollo-11-flight-plan');
    assert.match(String(row['detailsUrl']), /\/details\/apollo-11-flight-plan$/);
    assert.equal(num(result.structuredContent, 'numFound'), 137);
    assert.equal(result.structuredContent?.['hasMore'], true);
  });

  it('joins multi-valued creator fields into one string', async () => {
    const result = await callTool('search_items', { query: 'apollo', rows: 3 });
    const items = result.structuredContent?.['items'];
    assert.ok(Array.isArray(items));
    const audio = items
      .map((entry) => (typeof entry === 'object' && entry !== null ? Object.fromEntries(Object.entries(entry)) : {}))
      .find((row) => row['identifier'] === 'apollo-11-audio');
    assert.equal(audio?.['creator'], 'NASA, JSC');
  });

  it('adds a mediatype filter to the query', async () => {
    const result = await callTool('search_items', { query: 'apollo', mediatype: 'audio' });
    assert.match(str(result.structuredContent, 'query'), /AND mediatype:\(audio\)/);
  });

  it('returns item metadata with a file listing but no file contents', async () => {
    const result = await callTool('get_item_metadata', { identifier: 'example-fixture-item' });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'title'), 'Fixture Item: Field Recordings');
    assert.equal(str(result.structuredContent, 'creator'), 'A. Recorder, B. Engineer');
    assert.equal(num(result.structuredContent, 'fileCount'), 3);
    assert.ok(num(result.structuredContent, 'totalBytes') > 55_000_000);
    const collection = result.structuredContent?.['collection'];
    assert.ok(Array.isArray(collection) && collection.includes('fixtures'));
    assert.equal(str(result.structuredContent, 'description'), 'A fixture item with HTML in its description.');
    assert.match(textOf(result), /recording01\.flac/);
    assert.ok(!textOf(result).includes('<p>'), 'HTML is stripped from the description');
  });

  it('caps the file listing on request', async () => {
    const result = await callTool('get_item_metadata', { identifier: 'example-fixture-item', maxFiles: 1 });
    const files = result.structuredContent?.['files'];
    assert.ok(Array.isArray(files) && files.length === 1);
    assert.equal(result.structuredContent?.['filesTruncated'], true);
    assert.equal(linksOf(result).length, 1, 'a truncated listing gets a link to the full metadata');
  });

  it('reports an unknown identifier as not found', async () => {
    const result = await callTool('get_item_metadata', { identifier: 'no-such-item' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /not_found/);
  });

  it('rejects an identifier with illegal characters', async () => {
    const result = await callTool('get_item_metadata', { identifier: '../../etc/passwd' });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid_input|not a valid/);
  });
});

describe('save_url and clear_cache', () => {
  it('submits a save job without waiting when asked', async () => {
    const result = await callTool('save_url', { url: TARGET_URL, waitForCompletion: false });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'jobId'), 'fixture-job-1');
    assert.equal(str(result.structuredContent, 'status'), 'submitted');
    assert.match(textOf(result), /check_availability/);
  });

  it('clears the cache and reports how many entries went', async () => {
    await callTool('archive_stats', { url: TARGET_URL });
    assert.ok(runtime.cache.size() > 0, 'something should be cached by now');
    const result = await callTool('clear_cache');
    assert.ok(num(result.structuredContent, 'cleared') > 0);
    assert.equal(num(result.structuredContent, 'remaining'), 0);
    assert.equal(runtime.cache.size(), 0);
  });

  it('rejects an unknown tool name with the list of real ones', async () => {
    const result = await callTool('no_such_tool');
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No tool named "no_such_tool"/);
    assert.match(textOf(result), /archive_stats/);
  });
});

describe('HTTP resource routes', () => {
  it('serves extracted text for a snapshot with a long cache lifetime', async () => {
    const response = await fetch(
      `${baseUrl}/r/${SECRET}/snapshot/earliest/${encodeURIComponent(TARGET_URL)}?format=text`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=86400');
    assert.match(response.headers.get('x-wayback-timestamp') ?? '', /^\d{14}$/);
    const text = await response.text();
    assert.match(text, /100 messages every 8 hours/);
    assert.ok(!text.includes('Español'));
    assert.ok(!text.includes('<html'));
  });

  it('serves markdown when asked', async () => {
    const response = await fetch(
      `${baseUrl}/r/${SECRET}/snapshot/earliest/${encodeURIComponent(TARGET_URL)}?format=markdown`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(await response.text(), /^# How many messages/m);
  });

  it('serves the original bytes for format=raw', async () => {
    const response = await fetch(`${baseUrl}/r/${SECRET}/snapshot/earliest/${encodeURIComponent(TARGET_URL)}?format=raw`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html lang="en">/, 'the raw route may serve markup; the MCP channel may not');
  });

  it('resolves the URI a get_snapshot ResourceLink actually hands out', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    const uri = linksOf(result)[0]?.uri ?? '';
    assert.ok(uri.startsWith(DEPLOY_URL));
    const response = await fetch(uri.replace(DEPLOY_URL, baseUrl));
    assert.equal(response.status, 200, 'the advertised resource link must resolve');
    const text = await response.text();
    assert.equal(text.length, num(result.structuredContent, 'totalChars'), 'the link serves the full text');
    assert.match(text, /45 messages every 5 hours/);
  });

  it('serves the full diff behind a compare_snapshots ResourceLink', async () => {
    const response = await fetch(
      `${baseUrl}/r/${SECRET}/diff/earliest/latest/${encodeURIComponent(TARGET_URL)}?granularity=line`,
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /^--- /m);
    assert.match(text, /100 messages every 8 hours/);
    assert.match(text, /45 messages every 5 hours/);
  });

  it('accepts an un-encoded URL in the path tail', async () => {
    const response = await fetch(`${baseUrl}/r/${SECRET}/snapshot/earliest/https://${TARGET_URL}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /How many messages/);
  });

  it('accepts the target URL as a query parameter', async () => {
    const response = await fetch(`${baseUrl}/r/${SECRET}/snapshot/earliest/x?url=${encodeURIComponent(TARGET_URL)}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /How many messages/);
  });

  it('requires the path secret', async () => {
    const response = await fetch(`${baseUrl}/r/wrong-secret/snapshot/earliest/${encodeURIComponent(TARGET_URL)}`);
    assert.equal(response.status, 404);
  });

  it('rejects an unknown format and an unknown resource kind', async () => {
    const badFormat = await fetch(`${baseUrl}/r/${SECRET}/snapshot/earliest/${encodeURIComponent(TARGET_URL)}?format=pdf`);
    assert.equal(badFormat.status, 400);
    const badKind = await fetch(`${baseUrl}/r/${SECRET}/mystery/earliest/x`);
    assert.equal(badKind.status, 404);
  });

  it('maps a missing capture to 404 in plain text with no stack trace', async () => {
    const response = await fetch(`${baseUrl}/r/${SECRET}/snapshot/earliest/${encodeURIComponent('never-archived.example/x')}`);
    assert.ok(response.status === 404 || response.status === 502, `got ${String(response.status)}`);
    const text = await response.text();
    assert.ok(!text.includes('    at '), 'no stack traces on the resource routes');
  });
});

describe('upstream discipline', () => {
  it('sends the bots-policy User-Agent on every upstream request', () => {
    assert.ok(fixture.userAgents.length > 0);
    for (const [index, agent] of fixture.userAgents.entries()) {
      assert.match(
        agent,
        /^wayback-mcp\/1\.0 \(\+https:\/\/wayback\.example\.test; integration@example\.org\)$/,
        `request ${fixture.requests[index] ?? '(unknown)'} carried User-Agent ${agent}`,
      );
    }
  });

  it('requests captures with the id_ modifier', () => {
    const captureRequests = fixture.requests.filter((entry) => entry.includes('/web/'));
    assert.ok(captureRequests.length > 0);
    for (const entry of captureRequests) {
      assert.match(entry, /\/web\/\d{14}[a-z]{2}_\//, `capture request should carry a modifier: ${entry}`);
      assert.ok(entry.includes('id_/') || entry.includes('im_/'), `unexpected modifier in ${entry}`);
    }
  });

  it('reuses cached upstream responses across tool calls', async () => {
    await callTool('clear_cache');
    const before = fixture.requests.length;
    await callTool('list_revisions', { url: TARGET_URL });
    const afterFirst = fixture.requests.length;
    await callTool('list_revisions', { url: TARGET_URL });
    const afterSecond = fixture.requests.length;
    assert.ok(afterFirst > before, 'the first call queries upstream');
    assert.equal(afterSecond, afterFirst, 'the second identical call is served from cache');
  });

  it('surfaces an upstream 503 as a structured tool error after retries', async () => {
    await callTool('clear_cache');
    fixture.failNext(9, 503, 1);
    const result = await callTool('search_snapshots', { url: TARGET_URL, limit: 3 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /rate_limited|upstream_error/);
    assert.ok(!textOf(result).includes('    at '));
  });
});
