import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Server as McpServerInstance } from '@modelcontextprotocol/sdk/server/index.js';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, mcpPath, resourceBasePath, type Config } from './config.js';
import { buildAuthProvider, isOriginAllowed, type AuthProvider } from './auth.js';
import { SERVER_NAME, SERVER_VERSION, createMcpServer } from './server.js';
import { buildToolRegistry, type ToolContext, type ToolModule } from './tools/index.js';
import { InMemoryCache, type CacheBackend } from './lib/cache.js';
import { InMemoryTokenBucket, type RateLimiter } from './lib/ratelimit.js';
import { FetchUpstreamClient, type UpstreamClient } from './lib/http.js';
import { createLogger, type Logger } from './lib/log.js';
import { buildDiff } from './lib/diff.js';
import type { Failure } from './lib/errors.js';
import { fetchCapture, fetchCaptureText, resolveTimestamp } from './lib/wayback.js';

export interface Runtime {
  readonly config: Config;
  readonly cache: CacheBackend;
  readonly limiter: RateLimiter;
  readonly upstream: UpstreamClient;
  readonly logger: Logger;
  readonly tools: readonly ToolModule[];
  readonly auth: AuthProvider;
}

const IMMUTABLE_CACHE_HEADER = 'public, max-age=86400';

/** Single-value header read. Express types allow arrays for repeated headers. */
function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Single-value route param read, for the same reason as `header`. */
function pathParam(req: Request, name: string): string | undefined {
  const value = req.params[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Interop shim for one incompatibility in the SDK's own type declarations:
 * `StreamableHTTPServerTransport` types its optional callbacks as
 * `(() => void) | undefined`, while the `Transport` interface it is passed to
 * types them `?: () => void`. Under `exactOptionalPropertyTypes` (build spec §12)
 * those are different types, so the SDK's concrete transport is not assignable to
 * the SDK's own interface. The runtime shapes are identical; this is the only
 * suppressed check in the codebase. See DECISIONS-MADE.md.
 */
async function connectTransport(server: McpServerInstance, transport: StreamableHTTPServerTransport): Promise<void> {
  // @ts-ignore -- dependency type-declaration mismatch described above.
  await server.connect(transport);
}

/** Wires the in-memory cache, rate limiter and upstream client for a config. */
export function createRuntime(config: Config): Runtime {
  const logger = createLogger(config);
  const cache = new InMemoryCache();
  const limiter = new InMemoryTokenBucket({
    capacity: config.rateLimitPerMinute,
    refillPerMinute: config.rateLimitPerMinute,
  });
  const upstream = new FetchUpstreamClient({ config, cache, limiter, logger });
  return { config, cache, limiter, upstream, logger, tools: buildToolRegistry(config), auth: buildAuthProvider(config) };
}

function toolContext(runtime: Runtime): ToolContext {
  return {
    config: runtime.config,
    cache: runtime.cache,
    limiter: runtime.limiter,
    upstream: runtime.upstream,
    logger: runtime.logger,
  };
}

function statusForFailure(failureValue: Failure): number {
  switch (failureValue.code) {
    case 'invalid_input':
      return 400;
    case 'not_found':
    case 'no_captures':
      return 404;
    case 'rate_limited':
      return 429;
    case 'timeout':
      return 504;
    case 'upstream_error':
    case 'network_error':
      return 502;
    case 'unsupported':
      return 415;
    case 'internal':
      return 500;
  }
}

function sendFailure(res: Response, failureValue: Failure): void {
  const status = statusForFailure(failureValue);
  if (failureValue.retryAfterMs !== undefined) {
    res.setHeader('retry-after', String(Math.ceil(failureValue.retryAfterMs / 1000)));
  }
  res
    .status(status)
    .type('text/plain; charset=utf-8')
    .send(`${failureValue.code}: ${failureValue.message}${failureValue.hint === undefined ? '' : `\n${failureValue.hint}`}\n`);
}

/**
 * Rebuilds the target URL from the tail of a resource path. Handles a
 * percent-encoded URL in one segment and an un-encoded one spread across several,
 * and lets an explicit `?url=` override both.
 */
function targetUrlFromSegments(segments: readonly string[], query: unknown): string | undefined {
  if (typeof query === 'string' && query.trim().length > 0) return query.trim();
  if (segments.length === 0) return undefined;
  const joined = segments.join('/');
  let decoded: string;
  try {
    decoded = decodeURIComponent(joined);
  } catch {
    decoded = joined;
  }
  return decoded.replace(/^(https?):\/(?!\/)/i, '$1://');
}

function isTextualContentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.startsWith('text/') || type.includes('json') || type.includes('xml') || type.includes('javascript');
}

async function handleSnapshotResource(runtime: Runtime, req: Request, res: Response, segments: readonly string[]): Promise<void> {
  const timestamp = segments[0];
  const target = targetUrlFromSegments(segments.slice(1), req.query['url']);
  if (timestamp === undefined || target === undefined) {
    res.status(400).type('text/plain').send('Expected /r/{secret}/snapshot/{timestamp}/{encodedUrl}\n');
    return;
  }

  const rawFormat = req.query['format'];
  const format = typeof rawFormat === 'string' && rawFormat.length > 0 ? rawFormat : 'text';
  if (format !== 'text' && format !== 'markdown' && format !== 'raw') {
    res.status(400).type('text/plain').send('format must be one of: text, markdown, raw\n');
    return;
  }

  const deps = { config: runtime.config, upstream: runtime.upstream };
  const resolved = await resolveTimestamp(deps, target, timestamp);
  if (!resolved.ok) {
    sendFailure(res, resolved.failure);
    return;
  }

  if (format === 'raw') {
    const capture = await fetchCapture(deps, target, resolved.value);
    if (!capture.ok) {
      sendFailure(res, capture.failure);
      return;
    }
    // Binary captures are handed back to archive.org rather than re-encoded here.
    if (!isTextualContentType(capture.value.mimeType)) {
      res.setHeader('cache-control', IMMUTABLE_CACHE_HEADER);
      res.redirect(302, capture.value.resolvedUrl);
      return;
    }
    res.setHeader('cache-control', IMMUTABLE_CACHE_HEADER);
    res.setHeader('x-wayback-timestamp', capture.value.timestamp);
    res.status(200).type(capture.value.mimeType).send(capture.value.body);
    return;
  }

  const capture = await fetchCaptureText(deps, target, resolved.value, format);
  if (!capture.ok) {
    sendFailure(res, capture.failure);
    return;
  }
  res.setHeader('cache-control', IMMUTABLE_CACHE_HEADER);
  res.setHeader('x-wayback-timestamp', capture.value.timestamp);
  res
    .status(200)
    .type(format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8')
    .send(capture.value.text);
}

async function handleDiffResource(runtime: Runtime, req: Request, res: Response, segments: readonly string[]): Promise<void> {
  const timestampA = segments[0];
  const timestampB = segments[1];
  const target = targetUrlFromSegments(segments.slice(2), req.query['url']);
  if (timestampA === undefined || timestampB === undefined || target === undefined) {
    res.status(400).type('text/plain').send('Expected /r/{secret}/diff/{timestampA}/{timestampB}/{encodedUrl}\n');
    return;
  }
  const rawGranularity = req.query['granularity'];
  const granularity = rawGranularity === 'word' ? 'word' : 'line';

  const deps = { config: runtime.config, upstream: runtime.upstream };
  const [resolvedA, resolvedB] = await Promise.all([
    resolveTimestamp(deps, target, timestampA),
    resolveTimestamp(deps, target, timestampB),
  ]);
  if (!resolvedA.ok) {
    sendFailure(res, resolvedA.failure);
    return;
  }
  if (!resolvedB.ok) {
    sendFailure(res, resolvedB.failure);
    return;
  }

  const [captureA, captureB] = await Promise.all([
    fetchCaptureText(deps, target, resolvedA.value, 'text'),
    fetchCaptureText(deps, target, resolvedB.value, 'text'),
  ]);
  if (!captureA.ok) {
    sendFailure(res, captureA.failure);
    return;
  }
  if (!captureB.ok) {
    sendFailure(res, captureB.failure);
    return;
  }

  const diff = buildDiff(captureA.value.text, captureB.value.text, {
    granularity,
    labelA: `${target} @ ${captureA.value.timestamp}`,
    labelB: `${target} @ ${captureB.value.timestamp}`,
  });
  res.setHeader('cache-control', IMMUTABLE_CACHE_HEADER);
  res
    .status(200)
    .type('text/plain; charset=utf-8')
    .send(diff.identical ? '(no differences in the extracted text of these two captures)\n' : `${diff.unified}\n`);
}

/**
 * Builds the Express app. Exported so tests can drive it against a fixture
 * upstream without going near archive.org.
 */
export function createApp(runtime: Runtime): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Must answer instantly and touch nothing: Autoscale health checks are impatient.
  app.get('/healthz', (_req, res) => {
    res.status(200).type('text/plain; charset=utf-8').send('ok');
  });

  app.get('/', (_req, res) => {
    res.status(200).json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      transport: 'streamable-http',
      protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      mcpEndpoint: '/mcp/{MCP_PATH_SECRET}',
      resourceEndpoint: '/r/{MCP_PATH_SECRET}/...',
      health: '/healthz',
      tools: runtime.tools.map((tool) => tool.name),
      saveEnabled: runtime.config.enableSave,
      authRequired: runtime.config.authToken !== undefined,
    });
  });

  const guard = (req: Request, res: Response, pathSecret: string | undefined): boolean => {
    const origin = header(req, 'origin');
    if (!isOriginAllowed(origin, runtime.config)) {
      runtime.logger.warn('rejected origin', { origin });
      res.status(403).json({ error: 'forbidden_origin', message: 'This Origin is not allowed to call this server.' });
      return false;
    }
    const auth = runtime.auth.check({ pathSecret, authorization: header(req, 'authorization') });
    if (!auth.ok) {
      if (auth.wwwAuthenticate !== undefined) res.setHeader('www-authenticate', auth.wwwAuthenticate);
      res.status(auth.status).json({ error: auth.code, message: auth.message });
      return false;
    }
    return true;
  };

  const mcpHandler = async (req: Request, res: Response): Promise<void> => {
    if (!guard(req, res, pathParam(req, 'secret'))) return;

    // Absent header means 2025-03-26 per spec; present but unknown is a 400.
    const declared = header(req, 'mcp-protocol-version');
    if (declared !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: `Unsupported MCP-Protocol-Version: ${declared}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
        },
        id: null,
      });
      return;
    }

    // Stateless: a fresh server and transport per request, so no session is ever
    // pinned to an instance that Autoscale may have scaled away.
    const server = createMcpServer(toolContext(runtime), runtime.tools);
    // Stateless mode: no sessionIdGenerator. The SDK reads
    // `options?.sessionIdGenerator`, so omitting it and passing `undefined` are
    // the same thing — a session pinned to an instance Autoscale has scaled away
    // is a dead session, so sessions are never issued.
    const transportOptions: StreamableHTTPServerTransportOptions = {
      enableJsonResponse: runtime.config.jsonResponse,
    };
    const transport = new StreamableHTTPServerTransport(transportOptions);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await connectTransport(server, transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      runtime.logger.error('mcp request failed', { message: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error handling the MCP request.' },
          id: null,
        });
      }
    }
  };

  app.post('/mcp/:secret', express.json({ limit: '4mb' }), mcpHandler);
  app.get('/mcp/:secret', mcpHandler);
  app.delete('/mcp/:secret', (req, res) => {
    if (!guard(req, res, pathParam(req, 'secret'))) return;
    res.status(405).json({ error: 'method_not_allowed', message: 'This server is stateless; there is no session to delete.' });
  });

  // Resource routes are parsed by hand so that an un-encoded target URL in the
  // path tail works as well as a percent-encoded one.
  app.get(/^\/r\//, async (req, res) => {
    const segments = req.path.split('/').filter((segment) => segment.length > 0);
    // ['r', secret, kind, ...rest]
    const secret = segments[1];
    if (!guard(req, res, secret)) return;

    const kind = segments[2];
    const rest = segments.slice(3);
    if (kind === 'snapshot') {
      await handleSnapshotResource(runtime, req, res, rest);
      return;
    }
    if (kind === 'diff') {
      await handleDiffResource(runtime, req, res, rest);
      return;
    }
    res.status(404).type('text/plain').send('Unknown resource. Expected /snapshot/... or /diff/...\n');
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such route.' });
  });

  // Replaces Express's default handler, which would render a stack trace.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    runtime.logger.error('unhandled route error', { message: error instanceof Error ? error.message : String(error) });
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(500).json({ error: 'internal_error', message: 'The server failed to handle this request.' });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime = createRuntime(config);
  const app = createApp(runtime);

  for (const warning of config.warnings) runtime.logger.warn(warning);

  const server = app.listen(config.port, config.host, () => {
    runtime.logger.info('listening', { host: config.host, port: config.port, tools: runtime.tools.length });
    // The only place a secret is printed: the connector URL, once, at boot.
    console.log(`
  MCP endpoint:      ${config.deployUrl}${mcpPath(config)}
  Resource base:     ${config.deployUrl}${resourceBasePath(config)}
  Health check:      ${config.deployUrl}/healthz
  Add this to claude.ai → Settings → Connectors → Add custom connector:
      ${config.deployUrl}${mcpPath(config)}
${config.pathSecretGenerated ? '  (MCP_PATH_SECRET was generated for this process and will change on restart.)\n' : ''}`);
  });

  const shutdown = (signal: string): void => {
    runtime.logger.info('shutting down', { signal });
    server.close(() => {
      process.exit(0);
    });
    // Autoscale sends SIGTERM before reclaiming the instance; do not hang.
    setTimeout(() => {
      process.exit(0);
    }, 5_000).unref();
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('unhandledRejection', (reason) => {
    runtime.logger.error('unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  });
}

/** True only when this file is the process entry point, so tests can import freely. */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) void main();
