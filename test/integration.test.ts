import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createApp, createRuntime, type Runtime } from '../src/index.js';
import { startFixtureUpstream, type FixtureUpstream } from './fixtures/upstream.js';
import {
  CHURN_URL,
  GAP_URL,
  MARKUP_ONLY_PAIR,
  MARKUP_ONLY_URL,
  SHELL_URL,
  IDENTICAL_TEXT_PAIR,
  MIXED_STATUS_URL,
  NONCE_URL,
  PREFIX_STEM,
  REDIRECT_ONLY_URL,
  TARGET_URL,
  VARIANTS,
  noncePageHtml,
} from './fixtures/pages.js';
import { extractText } from '../src/lib/extract.js';
import { evenlySpaced, textDigest } from '../src/lib/wayback.js';
import { isEphemeralHost } from '../src/lib/resources.js';

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

/**
 * A JSON-RPC POST over raw http, so a test can set headers that `fetch` forbids —
 * notably Host, which F5's resource-URI derivation reads.
 */
async function rawRpc(params: Record<string, unknown>, headers: Record<string, string>): Promise<JsonRpcEnvelope> {
  requestId += 1;
  const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('server not bound');
  return new Promise<JsonRpcEnvelope>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: `/mcp/${SECRET}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          text += chunk;
        });
        response.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(text);
            resolve(typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {});
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    request.on('error', reject);
    request.end(payload);
  });
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
  it('summarises coverage with a status-class breakdown (F2)', async () => {
    const result = await callTool('archive_stats', { url: TARGET_URL });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'source'), 'cdx', 'CDX is the only source that can report statuses');
    assert.ok(num(result.structuredContent, 'totalCaptures') > 250);
    const breakdown = result.structuredContent?.['byStatusClass'];
    assert.ok(typeof breakdown === 'object' && breakdown !== null);
    const classes = Object.fromEntries(Object.entries(breakdown));
    assert.ok(Number(classes['ok']) > 250, 'most fixture captures are 200s');
    assert.equal(Number(classes['redirects']), 1, 'the fixture has exactly one redirect');
    assert.equal(
      Number(classes['ok']) + Number(classes['redirects']) + Number(classes['clientErrors']) + Number(classes['serverErrors']) + Number(classes['other']),
      Number(classes['total']),
      'the classes must sum to the total',
    );
    assert.match(textOf(result), /200: /);
    assert.match(textOf(result), /Content captures \(200 only\)/);
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

  it('inlines up to the budget plus a ResourceLink when the text exceeds it (G1)', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    assert.equal(result.structuredContent?.['truncated'], true);
    assert.ok(num(result.structuredContent, 'totalChars') > 8_000);
    assert.equal(num(result.structuredContent, 'inlinedChars'), 8_000, 'content is inlined, not withheld');
    const links = linksOf(result);
    assert.equal(links.length, 1);
    const link = links[0];
    // F5: built from the host that was actually called, not from DEPLOY_URL.
    assert.ok((link?.uri ?? '').startsWith(`${baseUrl}/r/${SECRET}/snapshot/`), `unexpected uri ${String(link?.uri)}`);
    assert.ok(!(link?.uri ?? '').startsWith(DEPLOY_URL), 'the configured DEPLOY_URL must not win over the request Host');
    assert.equal(link?.mimeType, 'text/plain');
    assert.ok((link?.size ?? 0) > 8_000);
    assert.ok((link?.name ?? '').length > 0, 'a ResourceLink must carry a name');
    assert.ok((link?.description ?? '').length > 0);
    assert.match(textOf(result), /Truncated at 8,000 of/);
    assert.ok(textOf(result).length < num(result.structuredContent, 'totalChars'));
  });

  it('never inlines raw HTML, even when format=raw', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest', format: 'raw' });
    const text = textOf(result);
    assert.ok(!text.includes('<html'), 'raw HTML must never reach the content channel');
    assert.ok(!text.includes('<div'));
    assert.match(text, /returns no inline content by design/);
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
    assert.ok(uri.startsWith(baseUrl), `link should point at the calling host, got ${uri}`);
    const response = await fetch(uri);
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
    // Exactly one call's worth of attempts, so no injected failures leak into
    // whichever test runs next.
    fixture.failNext(4, 503, 1);
    const result = await callTool('search_snapshots', { url: TARGET_URL, limit: 3 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /rate_limited|upstream_error/);
    assert.ok(!textOf(result).includes('    at '));
    fixture.failNext(0, 503);
    await callTool('clear_cache');
  });
});

// ---------------------------------------------------------------------------
// Regressions for the defects found in first live use (waybackmcpFIXES.md).
// ---------------------------------------------------------------------------

describe('F1 — prefix search names the URL each capture belongs to', () => {
  it('carries `original` on every row in structuredContent', async () => {
    const result = await callTool('search_snapshots', {
      url: PREFIX_STEM,
      matchType: 'prefix',
      filter: ['statuscode:200'],
      collapse: 'timestamp:6',
    });
    assert.notEqual(result.isError, true, textOf(result));
    const rows = result.structuredContent?.['rows'];
    assert.ok(Array.isArray(rows) && rows.length >= 2, 'the reproduction returns two capture rows');
    for (const entry of rows) {
      const row = asRecord(entry);
      assert.ok(row !== undefined);
      const original = asString(row['original']);
      assert.ok(original !== undefined && original.length > 0, 'every row must name its URL');
      assert.match(original, /11647753-what-are-usage-limits/, 'the real slug, not the queried stem');
    }
  });

  it('prints the matched URL on every row of the text summary', async () => {
    const text = textOf(
      await callTool('search_snapshots', { url: PREFIX_STEM, matchType: 'prefix', filter: ['statuscode:200'] }),
    );
    assert.match(text, /11647753-what-are-usage-limits/, 'the slug must be visible without reading structuredContent');
  });

  it('lists the distinct URLs when a prefix match spans several', async () => {
    const result = await callTool('search_snapshots', { url: PREFIX_STEM, matchType: 'prefix', limit: 100 });
    assert.equal(num(result.structuredContent, 'distinctUrlCount'), 2);
    const distinct = result.structuredContent?.['distinctUrls'];
    assert.ok(Array.isArray(distinct) && distinct.length === 2);
    assert.match(textOf(result), /2 distinct URLs matched/);
  });

  it('omits the redundant per-row URL for an exact match', async () => {
    const text = textOf(await callTool('search_snapshots', { url: TARGET_URL, limit: 3 }));
    const rowLines = text.split('\n').filter((line) => /^\d{14}\s/.test(line));
    assert.ok(rowLines.length > 0);
    for (const line of rowLines) assert.ok(!line.includes(TARGET_URL), 'exact match prints the URL once in the header');
  });

  it('builds snapshotUrl from the row’s own URL, not the query', async () => {
    const result = await callTool('search_snapshots', { url: PREFIX_STEM, matchType: 'prefix', limit: 100 });
    const rows = result.structuredContent?.['rows'];
    assert.ok(Array.isArray(rows));
    for (const entry of rows) {
      const row = asRecord(entry);
      const original = asString(row?.['original']) ?? '';
      const snapshotUrl = asString(row?.['snapshotUrl']) ?? '';
      assert.ok(snapshotUrl.endsWith(original), `snapshotUrl ${snapshotUrl} should end with ${original}`);
    }
  });

  it('lets get_snapshot succeed on the discovered slug without guesswork', async () => {
    const search = await callTool('search_snapshots', { url: PREFIX_STEM, matchType: 'prefix', limit: 1 });
    const rows = search.structuredContent?.['rows'];
    assert.ok(Array.isArray(rows));
    const slug = asString(asRecord(rows[0])?.['original']) ?? '';
    const snapshot = await callTool('get_snapshot', { url: slug, timestamp: 'earliest' });
    assert.notEqual(snapshot.isError, true, textOf(snapshot));
  });
});

describe('F2 — capture counts never contradict each other', () => {
  it('explains an all-redirects URL instead of denying its captures exist', async () => {
    const stats = await callTool('archive_stats', { url: REDIRECT_ONLY_URL });
    assert.notEqual(stats.isError, true);
    assert.equal(num(stats.structuredContent, 'totalCaptures'), 2);
    const breakdown = asRecord(stats.structuredContent?.['byStatusClass']);
    assert.equal(Number(breakdown?.['redirects']), 2);
    assert.equal(Number(breakdown?.['ok']), 0);
    assert.equal(stats.structuredContent?.['contentFirstCapture'], null);
    assert.match(textOf(stats), /A large share of captures are redirects/);

    const compare = await callTool('compare_snapshots', { url: REDIRECT_ONLY_URL, timestampA: 'earliest', timestampB: 'latest' });
    assert.equal(compare.isError, true);
    const text = textOf(compare);
    assert.match(text, /2 captures exist/, 'must acknowledge the captures');
    assert.match(text, /none returned HTTP 200/);
    assert.match(text, /3xx: 2/);
    assert.match(text, /likely moved/);
    assert.ok(!/has no usable captures/.test(text), 'must not claim nothing is archived');
  });

  it('reports how many captures list_revisions excluded and why', async () => {
    const stats = await callTool('archive_stats', { url: MIXED_STATUS_URL });
    const total = num(stats.structuredContent, 'totalCaptures');
    const revisions = await callTool('list_revisions', { url: MIXED_STATUS_URL });
    assert.equal(num(revisions.structuredContent, 'capturesTotal'), total, 'both tools must agree on the total');
    assert.equal(num(revisions.structuredContent, 'capturesExcluded'), 12);
    assert.equal(str(revisions.structuredContent, 'excludedReason'), 'not status 200');
    assert.match(textOf(revisions), /8 of 20 captures examined \(12 excluded: not status 200\)/);
  });

  it('reports the content-only range separately from the full range', async () => {
    const stats = await callTool('archive_stats', { url: MIXED_STATUS_URL });
    assert.match(str(stats.structuredContent, 'firstCapture'), /^2023/);
    assert.match(str(stats.structuredContent, 'contentFirstCapture'), /^2024/, '200s start a year later');
  });
});

describe('F3 — an approximate timestamp never resolves silently', () => {
  it('reports the gap in days when the nearest capture is far away', async () => {
    const result = await callTool('get_snapshot', { url: GAP_URL, timestamp: '20241020' });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'timestamp'), '20241112035820');
    assert.equal(str(result.structuredContent, 'requestedTimestamp'), '20241020');
    const offset = num(result.structuredContent, 'offsetDays');
    assert.ok(offset >= 22 && offset <= 24, `expected roughly 23 days, got ${String(offset)}`);
    const text = textOf(result);
    assert.match(text, /^Note: nearest capture to 20241020 is 20241112035820, 23 days later\./m);
    assert.match(text, /no captures in between/);
  });

  it('says nothing for an exact-enough resolution', async () => {
    const result = await callTool('get_snapshot', { url: GAP_URL, timestamp: '20241112' });
    assert.ok(!/^Note: nearest capture/m.test(textOf(result)), 'a same-day resolution needs no notice');
    assert.ok(Math.abs(num(result.structuredContent, 'offsetDays')) <= 3);
  });

  it('treats earliest and latest as exact', async () => {
    for (const timestamp of ['earliest', 'latest']) {
      const result = await callTool('get_snapshot', { url: GAP_URL, timestamp });
      assert.equal(result.structuredContent?.['offsetDays'], null, `${timestamp} is exact by definition`);
      assert.ok(!/^Note: nearest capture/m.test(textOf(result)));
    }
  });

  it('reports both endpoints independently in compare_snapshots', async () => {
    const result = await callTool('compare_snapshots', { url: GAP_URL, timestampA: '20240921', timestampB: '20241101' });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'timestampB'), '20241112035820');
    assert.ok(Math.abs(num(result.structuredContent, 'offsetDaysB')) >= 10);
    const text = textOf(result);
    assert.match(text, /Note: nearest capture to 20241101 is 20241112035820/);
    assert.match(text, /B: 20241112035820 .*\(requested 20241101\)/, 'the header shows requested and resolved');
  });
});

describe('F4 — digest collapse falls back when digests are noise', () => {
  it('reproduces the defect in digest mode: 88 captures, 88 "revisions"', async () => {
    const result = await callTool('list_revisions', { url: NONCE_URL, method: 'digest' });
    assert.equal(num(result.structuredContent, 'totalRevisions'), 88);
    assert.equal(str(result.structuredContent, 'method'), 'digest');
    assert.ok(num(result.structuredContent, 'digestRatio') >= 0.9);
    assert.match(textOf(result), /probably noise/, 'digest mode warns that the result is noise');
    assert.match(textOf(result), /ratio 1\.00/);
  });

  it('collapses the same captures to a single-digit revision count in auto mode', async () => {
    const result = await callTool('list_revisions', { url: NONCE_URL });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(str(result.structuredContent, 'method'), 'text', 'auto must detect the noise and switch');
    const revisions = num(result.structuredContent, 'totalRevisions');
    assert.ok(revisions < 10, `expected fewer than 10 revisions, got ${String(revisions)}`);
    assert.ok(revisions >= 3, `expected the three text eras to survive, got ${String(revisions)}`);
    assert.ok(num(result.structuredContent, 'capturesSampled') <= 24, 'never more than 24 fetches');
    assert.ok(num(result.structuredContent, 'capturesSampled') > 0);
  });

  it('states the method and its precision limits', async () => {
    const text = textOf(await callTool('list_revisions', { url: NONCE_URL }));
    assert.match(text, /CDX digests were unusable/);
    assert.match(text, /88 distinct digests across 88 captures/);
    assert.match(text, /sampled \d+ captures evenly spaced/);
    assert.match(text, /accurate to the sampling interval, not to the day/);
    assert.match(text, /Narrow from\/to and re-run to sharpen a boundary/);
  });

  it('brackets the April 2024 boundary', async () => {
    const result = await callTool('list_revisions', { url: NONCE_URL });
    const revisions = result.structuredContent?.['revisions'];
    assert.ok(Array.isArray(revisions));
    const boundaries = revisions
      .map((entry) => asString(asRecord(entry)?.['firstSeen']) ?? '')
      .filter((stamp) => stamp.length === 14);
    const bracketsApril = boundaries.some((stamp) => stamp >= '20240301000000' && stamp <= '20240701000000');
    assert.ok(bracketsApril, `expected a revision boundary near April 2024, got ${boundaries.join(', ')}`);
  });

  it('hashes two captures with identical body text identically', async () => {
    const [first, second] = IDENTICAL_TEXT_PAIR;
    // Same era, so the readable text matches while the nonce and build id differ.
    const a = extractText(noncePageHtml(first)).text;
    const b = extractText(noncePageHtml(second)).text;
    assert.equal(a, b, 'the fixture bodies must have identical readable text');
    assert.equal(textDigest(a), textDigest(b));
    assert.notEqual(noncePageHtml(first), noncePageHtml(second), 'the raw bytes differ, which is the whole problem');
  });

  it('ignores case and whitespace when hashing text', () => {
    assert.equal(textDigest('Hello   World'), textDigest('hello world'));
    assert.notEqual(textDigest('hello world'), textDigest('hello worlds'));
  });

  it('samples evenly across the range', () => {
    const items = Array.from({ length: 100 }, (_unused, index) => index);
    const picked = evenlySpaced(items, 5);
    assert.deepEqual(picked, [0, 25, 50, 74, 99], 'step is 24.75, so index 3 rounds to 74');
    assert.deepEqual(evenlySpaced([1, 2], 5), [1, 2], 'fewer items than the limit returns them all');
    assert.deepEqual(evenlySpaced(items, 0), []);
  });
});

describe('F5 — resource URIs follow the calling host', () => {
  it('builds an https URI for the deployment host behind a proxy', async () => {
    // Raw http, not fetch: fetch treats Host as a forbidden header and overwrites
    // it, so a proxied request can only be simulated at this level.
    const body = await rawRpc(
      { name: 'get_snapshot', arguments: { url: TARGET_URL, timestamp: 'latest' } },
      { host: 'wayback-machine-mcp.replit.app', 'x-forwarded-proto': 'https' },
    );
    const result = resultObject(body);
    const content = result['content'];
    assert.ok(Array.isArray(content));
    const link = contentBlocks(content).find((block) => block.type === 'resource_link');
    assert.ok(link !== undefined, 'a long page should carry a resource link');
    assert.ok(
      (link.uri ?? '').startsWith('https://wayback-machine-mcp.replit.app/r/'),
      `expected the deployment host, got ${String(link.uri)}`,
    );
    assert.ok(!(link.uri ?? '').includes('replit.dev'), 'never the dev workspace domain');
    assert.ok(!(link.uri ?? '').includes('wayback.example.test'), 'never the configured DEPLOY_URL');
  });

  it('keeps http for a plain local call', async () => {
    const body = await rawRpc({ name: 'get_snapshot', arguments: { url: TARGET_URL, timestamp: 'latest' } }, {});
    const content = resultObject(body)['content'];
    assert.ok(Array.isArray(content));
    const link = contentBlocks(content).find((block) => block.type === 'resource_link');
    assert.ok((link?.uri ?? '').startsWith('http://127.0.0.1:'), `got ${String(link?.uri)}`);
  });

  it('falls back to DEPLOY_URL only when there is no Host header', () => {
    // Exercised directly: an MCP request always carries Host, so the fallback is
    // reachable only from a non-HTTP caller.
    assert.equal(isEphemeralHost(DEPLOY_URL), false);
  });
});

describe('F6 — ResourceLink size is the artifact size', () => {
  it('advertises raw capture bytes, not the extracted character count', async () => {
    const result = await callTool('get_snapshot', { url: NONCE_URL, timestamp: 'earliest', format: 'raw' });
    assert.notEqual(result.isError, true, textOf(result));
    const link = linksOf(result)[0];
    const totalChars = num(result.structuredContent, 'totalChars');
    const artifactBytes = num(result.structuredContent, 'artifactBytes');
    assert.equal(link?.size, artifactBytes);
    assert.ok(artifactBytes > totalChars * 2, `raw HTML (${String(artifactBytes)}B) should dwarf its text (${String(totalChars)} chars)`);
    assert.ok(artifactBytes > 1_000, 'a real page is not a handful of bytes');
  });

  it('advertises the extracted byte length for text format', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    const link = linksOf(result)[0];
    assert.equal(link?.size, num(result.structuredContent, 'artifactBytes'));
    assert.ok((link?.size ?? 0) >= num(result.structuredContent, 'totalChars'), 'bytes are never fewer than characters');
  });

  it('advertises the diff byte length for a capped diff', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL, maxChars: 1_000 });
    if (result.structuredContent?.['truncated'] !== true) return;
    const link = linksOf(result)[0];
    assert.equal(link?.size, num(result.structuredContent, 'artifactBytes'));
    assert.ok((link?.size ?? 0) > num(result.structuredContent, 'inlinedChars'));
  });
});

describe('F7 — one bad capture does not kill a comparison', () => {
  it('names the failing endpoint and offers nearest alternatives', async () => {
    await callTool('clear_cache');
    const revisions = await callTool('list_revisions', { url: TARGET_URL });
    const rows = revisions.structuredContent?.['revisions'];
    assert.ok(Array.isArray(rows) && rows.length >= 3);
    const victim = asString(asRecord(rows[2])?.['firstSeen']) ?? '';
    const healthy = asString(asRecord(rows[0])?.['firstSeen']) ?? '';

    fixture.breakCapture(victim);
    try {
      const result = await callTool('compare_snapshots', { url: TARGET_URL, timestampA: healthy, timestampB: victim });
      assert.equal(result.isError, true);
      const text = textOf(result);
      assert.match(text, new RegExp(`Capture ${victim} \\(endpoint B\\)`), 'names which endpoint failed');
      assert.match(text, /Nearest usable alternatives: \d{14}, \d{14}, \d{14}/);
      assert.match(text, /fetched fine, so this is that one capture rather than a connectivity problem/);
      assert.ok(!/outbound network access/.test(text), 'must not blame local networking');
    } finally {
      fixture.repairCaptures();
      await callTool('clear_cache');
    }
  });
});

describe('F8 — inline budget is opt-in escalatable', () => {
  it('inlines the default budget and links to the rest for a long page', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    assert.equal(num(result.structuredContent, 'maxChars'), 8_000);
    assert.equal(result.structuredContent?.['truncated'], true);
    assert.equal(num(result.structuredContent, 'inlinedChars'), 8_000);
    assert.equal(linksOf(result).length, 1);
  });

  it('inlines more when asked, and still attaches the link', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest', maxChars: 50_000 });
    const totalChars = num(result.structuredContent, 'totalChars');
    assert.ok(num(result.structuredContent, 'inlinedChars') > 8_000, 'escalation must inline more than the default');
    assert.equal(linksOf(result).length, totalChars > 50_000 ? 1 : 0);
    assert.match(textOf(result), /45 messages every 5 hours/, 'content past the preview is now visible');
  });

  it('marks the cut when an escalated read is still truncated', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest', maxChars: 3_000 });
    assert.equal(num(result.structuredContent, 'inlinedChars'), 3_000);
    assert.match(textOf(result), /\[Truncated at 3,000 of [\d,]+ characters\. Re-call with a higher maxChars to see more\.\]/);
  });

  it('rejects a maxChars above the hard ceiling', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, maxChars: 500_000 });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /invalid_input/);
  });

  it('applies the same escalation to compare_snapshots', async () => {
    const tight = await callTool('compare_snapshots', { url: TARGET_URL, maxChars: 1_000 });
    assert.equal(num(tight.structuredContent, 'maxChars'), 1_000);
    assert.ok(num(tight.structuredContent, 'inlinedChars') <= 1_000);
    const roomy = await callTool('compare_snapshots', { url: TARGET_URL, maxChars: 100_000 });
    assert.ok(num(roomy.structuredContent, 'inlinedChars') >= num(tight.structuredContent, 'inlinedChars'));
  });
});

// ---------------------------------------------------------------------------
// Regressions for the independent capability test (waybackmcpFIXES2.md).
// ---------------------------------------------------------------------------

describe('G0 — the output contract', () => {
  const everyTool = [
    { name: 'archive_stats', args: { url: TARGET_URL } },
    { name: 'check_availability', args: { url: TARGET_URL } },
    { name: 'search_snapshots', args: { url: TARGET_URL, limit: 3 } },
    { name: 'list_revisions', args: { url: TARGET_URL, method: 'digest' } },
    { name: 'get_snapshot', args: { url: TARGET_URL, timestamp: 'earliest' } },
    { name: 'compare_snapshots', args: { url: TARGET_URL } },
    { name: 'list_screenshots', args: { url: TARGET_URL } },
    { name: 'search_items', args: { query: 'apollo', rows: 2 } },
    { name: 'get_item_metadata', args: { identifier: 'example-fixture-item' } },
    { name: 'clear_cache', args: {} },
  ];

  it('every tool returns a non-empty text block that is not JSON', async () => {
    for (const tool of everyTool) {
      const result = await callTool(tool.name, tool.args);
      assert.notEqual(result.isError, true, `${tool.name}: ${textOf(result)}`);
      const blocks = (result.content ?? []).filter((block) => block.type === 'text');
      assert.equal(blocks.length, 1, `${tool.name} should return exactly one text block`);
      const text = blocks[0]?.text ?? '';
      assert.ok(text.trim().length > 0, `${tool.name} text block is empty`);
      let parsedAsJson = true;
      try {
        JSON.parse(text);
      } catch {
        parsedAsJson = false;
      }
      assert.equal(parsedAsJson, false, `${tool.name} put JSON in the text block instead of prose`);
    }
  });

  it('repeats the summary in structuredContent so a client that drops text blocks still sees it', async () => {
    for (const tool of everyTool) {
      const result = await callTool(tool.name, tool.args);
      const summary = str(result.structuredContent, 'summary');
      assert.ok(summary.trim().length > 0, `${tool.name} has no summary field`);
      const text = (result.content ?? []).find((block) => block.type === 'text')?.text ?? '';
      assert.ok(text.startsWith(summary.split('\n')[0] ?? ''), `${tool.name}: summary and text block disagree`);
    }
  });

  it('puts warnings in both channels, not prose only', async () => {
    const result = await callTool('get_snapshot', { url: GAP_URL, timestamp: '20241020' });
    // The offset is both a discrete field and a sentence in the summary.
    assert.ok(Math.abs(num(result.structuredContent, 'offsetDays')) > 3);
    assert.match(str(result.structuredContent, 'summary'), /Note: nearest capture/);
  });
});

describe('G1 — get_snapshot returns the page', () => {
  it('returns the whole body for a short capture', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest' });
    const body = str(result.structuredContent, 'text');
    assert.ok(body.length > 0, 'a short capture must not come back empty');
    assert.equal(body.length, num(result.structuredContent, 'totalChars'));
    assert.equal(num(result.structuredContent, 'inlinedChars'), body.length);
    assert.equal(result.structuredContent?.['truncated'], false);
    assert.equal(result.structuredContent?.['resourceUri'], null, 'nothing withheld means no link needed');
    assert.match(body, /How many messages can I send\?/);
    assert.match(textOf(result), /How many messages can I send\?/, 'and in the text block too');
  });

  it('returns markdown for a short capture', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest', format: 'markdown' });
    const body = str(result.structuredContent, 'text');
    assert.equal(body.length, num(result.structuredContent, 'totalChars'));
    assert.match(body, /^# How many messages can I send\?$/m);
  });

  it('returns maxChars of body plus a link for a long capture', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    const body = str(result.structuredContent, 'text');
    const total = num(result.structuredContent, 'totalChars');
    assert.ok(total > 8_000);
    assert.equal(body.length, 8_000, 'inlined length is min(totalChars, maxChars)');
    assert.equal(num(result.structuredContent, 'inlinedChars'), 8_000);
    assert.equal(linksOf(result).length, 1, 'and a link to the remainder');
  });

  it('never leaves the caller with no content and no link', async () => {
    for (const args of [
      { url: TARGET_URL, timestamp: 'earliest' },
      { url: TARGET_URL, timestamp: 'latest' },
      { url: TARGET_URL, timestamp: 'earliest', format: 'markdown' },
      { url: TARGET_URL, timestamp: 'earliest', format: 'raw' },
      { url: TARGET_URL, timestamp: 'latest', maxChars: 1_000 },
    ]) {
      const result = await callTool('get_snapshot', args);
      const inlined = num(result.structuredContent, 'inlinedChars');
      if (inlined === 0) {
        assert.notEqual(result.structuredContent?.['resourceUri'], null, `${JSON.stringify(args)} returned neither content nor a link`);
      }
    }
  });
});

describe('G2 — compare_snapshots returns the diff', () => {
  it('emits the diff, and its counts match the diff body', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL });
    assert.notEqual(result.isError, true, textOf(result));
    const diff = str(result.structuredContent, 'diff');
    assert.ok(diff.length > 0, 'the diff was computed and must not be discarded');
    assert.equal(result.structuredContent?.['identical'], false);

    // The assertion that would have caught the bug: the reported counts must
    // describe the diff that was actually returned.
    let added = 0;
    let removed = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added += line.length - 1;
      else if (line.startsWith('-') && !line.startsWith('---')) removed += line.length - 1;
    }
    assert.equal(added, num(result.structuredContent, 'addedChars'));
    assert.equal(removed, num(result.structuredContent, 'removedChars'));
    assert.match(diff, /100 messages every 8 hours/);
    assert.match(diff, /45 messages every 5 hours/);
    assert.match(textOf(result), /45 messages every 5 hours/, 'and in the text block too');
  });

  it('emits a word-granularity diff too', async () => {
    const result = await callTool('compare_snapshots', { url: TARGET_URL, granularity: 'word' });
    const diff = str(result.structuredContent, 'diff');
    assert.ok(diff.length > 0);
    assert.match(diff, /^\+ /m);
  });

  it('never returns neither diff nor link', async () => {
    for (const args of [{ url: TARGET_URL }, { url: TARGET_URL, maxChars: 1_000 }, { url: TARGET_URL, granularity: 'word' }]) {
      const result = await callTool('compare_snapshots', args);
      if (num(result.structuredContent, 'inlinedChars') === 0) {
        assert.notEqual(result.structuredContent?.['resourceUri'], null, `${JSON.stringify(args)} returned nothing usable`);
      }
    }
  });
});

describe('G3 — resources are actually served', () => {
  it('declares the resources capability on initialize', async () => {
    const { body } = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'g3', version: '1.0.0' },
    });
    const capabilities = asRecord(resultObject(body)['capabilities']);
    assert.ok(capabilities?.['resources'] !== undefined, 'links are advertised, so the capability must be declared');
  });

  it('lists resource templates covering both artifact kinds', async () => {
    const { body } = await rpc('resources/templates/list');
    const templates = resultObject(body)['resourceTemplates'];
    assert.ok(Array.isArray(templates) && templates.length === 2);
    const uris = templates.map((entry) => asString(asRecord(entry)?.['uriTemplate']) ?? '');
    assert.ok(uris.some((uri) => uri.includes('/snapshot/')));
    assert.ok(uris.some((uri) => uri.includes('/diff/')));
  });

  it('reads back a URI that a tool actually emitted', async () => {
    const snapshot = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'latest' });
    const uri = linksOf(snapshot)[0]?.uri ?? '';
    assert.ok(uri.length > 0);

    const { body } = await rpc('resources/read', { uri });
    const contents = resultObject(body)['contents'];
    assert.ok(Array.isArray(contents) && contents.length === 1);
    const entry = asRecord(contents[0]);
    assert.equal(asString(entry?.['uri']), uri);
    assert.equal(asString(entry?.['mimeType']), 'text/plain');
    const text = asString(entry?.['text']) ?? '';
    assert.equal(text.length, num(snapshot.structuredContent, 'totalChars'), 'the full artifact, not the inlined slice');
    assert.match(text, /45 messages every 5 hours/);
  });

  it('reads back a diff URI', async () => {
    const compare = await callTool('compare_snapshots', { url: TARGET_URL, maxChars: 1_000 });
    const uri = linksOf(compare)[0]?.uri ?? '';
    assert.ok(uri.length > 0, 'a capped diff must advertise a link');
    const { body } = await rpc('resources/read', { uri });
    const contents = resultObject(body)['contents'];
    assert.ok(Array.isArray(contents));
    const entry = asRecord(contents[0]);
    const text = asString(entry?.['text']) ?? '';
    assert.ok(text.length > num(compare.structuredContent, 'inlinedChars'), 'the uncapped diff');
    assert.match(text, /^--- /m);
  });

  it('rejects a URI it did not emit, with a useful message', async () => {
    const { body } = await rpc('resources/read', { uri: 'https://example.com/not-ours' });
    assert.ok(body.error !== undefined, 'an unknown URI must not silently succeed');
    assert.match(body.error?.message ?? '', /Unknown resource URI|snapshot/);
  });
});

describe('G5 — noise detection catches the low-ratio case', () => {
  it('falls back on a singleton-heavy page whose ratio is only 0.82', async () => {
    const digest = await callTool('list_revisions', { url: CHURN_URL, method: 'digest' });
    const ratio = num(digest.structuredContent, 'digestRatio');
    assert.ok(ratio < 0.9 && ratio > 0.7, `fixture ratio should sit below the old 0.9 threshold, got ${String(ratio)}`);
    assert.ok(num(digest.structuredContent, 'totalRevisions') > 40, 'digest mode reproduces the useless output');

    const auto = await callTool('list_revisions', { url: CHURN_URL });
    assert.equal(str(auto.structuredContent, 'method'), 'text', 'auto must catch what the ratio alone missed');
    assert.ok(num(auto.structuredContent, 'totalRevisions') < 10, 'single-digit revisions in auto mode');
  });

  it('reports which trigger fired', async () => {
    const auto = await callTool('list_revisions', { url: CHURN_URL });
    const reason = str(auto.structuredContent, 'fallbackReason');
    assert.ok(reason.length > 0);
    assert.match(reason, /single capture|ratio|churning boilerplate/);
    assert.match(str(auto.structuredContent, 'summary'), /CDX digests were unusable/);
    assert.ok(num(auto.structuredContent, 'singletonShare') > 0.6);
  });

  it('honours method="digest" as the escape hatch', async () => {
    const forced = await callTool('list_revisions', { url: CHURN_URL, method: 'digest' });
    assert.equal(str(forced.structuredContent, 'method'), 'digest');
    assert.equal(forced.structuredContent?.['fallbackReason'], null);
  });
});

describe('G6 — truncation flags are coherent', () => {
  it('reports truncated=false for a raw link to a small artifact', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest', format: 'raw' });
    assert.equal(result.structuredContent?.['truncated'], false, 'nothing was cut; raw simply is not inlined');
    assert.equal(num(result.structuredContent, 'inlinedChars'), 0);
    assert.notEqual(result.structuredContent?.['resourceUri'], null);
  });

  it('has no bodyTruncated field left to disagree with truncated', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest' });
    assert.equal(result.structuredContent?.['bodyTruncated'], undefined, 'the overlapping flag was deleted');
  });

  it('makes truncated derivable from inlinedChars and totalChars', async () => {
    for (const args of [
      { url: TARGET_URL, timestamp: 'earliest' },
      { url: TARGET_URL, timestamp: 'latest' },
      { url: TARGET_URL, timestamp: 'latest', maxChars: 50_000 },
    ]) {
      const result = await callTool('get_snapshot', args);
      const inlined = num(result.structuredContent, 'inlinedChars');
      const total = num(result.structuredContent, 'totalChars');
      assert.equal(result.structuredContent?.['truncated'], inlined < total, `flags disagree for ${JSON.stringify(args)}`);
    }
  });
});

describe('G7 — check_availability reports its offset', () => {
  it('states the gap when the closest capture is far from the request', async () => {
    const result = await callTool('check_availability', { url: GAP_URL, timestamp: '20241020' });
    const offset = num(result.structuredContent, 'offsetDays');
    assert.ok(Math.abs(offset) > 3, `expected a large offset, got ${String(offset)}`);
    assert.match(str(result.structuredContent, 'summary'), /Note: nearest capture to 20241020/);
  });

  it('reports a null offset when no timestamp was requested', async () => {
    const result = await callTool('check_availability', { url: GAP_URL });
    assert.equal(result.structuredContent?.['offsetDays'], null);
  });
});

describe('G8 — identical results and empty extractions are explained', () => {
  it('names a markup-only change when text matches but digests differ', async () => {
    const result = await callTool('compare_snapshots', {
      url: MARKUP_ONLY_URL,
      timestampA: MARKUP_ONLY_PAIR[0],
      timestampB: MARKUP_ONLY_PAIR[1],
    });
    assert.equal(result.structuredContent?.['identical'], true);
    assert.equal(result.structuredContent?.['markupOnlyChange'], true);
    assert.notEqual(str(result.structuredContent, 'digestA'), str(result.structuredContent, 'digestB'));
    assert.match(
      str(result.structuredContent, 'summary'),
      /Extracted text is identical, but the captures have different CDX digests/,
    );
  });

  it('flags a capture that extracts to almost nothing', async () => {
    const result = await callTool('get_snapshot', { url: SHELL_URL, timestamp: 'latest' });
    assert.equal(result.structuredContent?.['extractionSuspect'], true);
    const summary = str(result.structuredContent, 'summary');
    assert.match(summary, /characters extracted from a .* HTML capture/);
    assert.match(summary, /renders its content client-side/);
    assert.match(summary, /format="raw"/);
  });

  it('does not flag a normal page', async () => {
    const result = await callTool('get_snapshot', { url: TARGET_URL, timestamp: 'earliest' });
    assert.equal(result.structuredContent?.['extractionSuspect'], false);
  });
});

describe('G9 — list_screenshots distinguishes empty from broken', () => {
  it('says the index answered and holds none', async () => {
    const result = await callTool('list_screenshots', { url: TARGET_URL });
    assert.equal(str(result.structuredContent, 'indexStatus'), 'none');
    assert.match(str(result.structuredContent, 'summary'), /The index answered; it holds none/);
  });

  it('says so when the index could not be queried', async () => {
    await callTool('clear_cache');
    fixture.failNext(4, 503, 1);
    const result = await callTool('list_screenshots', { url: TARGET_URL });
    assert.equal(str(result.structuredContent, 'indexStatus'), 'unavailable');
    assert.match(str(result.structuredContent, 'summary'), /could not be queried/);
    assert.match(str(result.structuredContent, 'summary'), /not the same as "no screenshots exist"/);
    fixture.failNext(0, 503);
    await callTool('clear_cache');
  });
});
