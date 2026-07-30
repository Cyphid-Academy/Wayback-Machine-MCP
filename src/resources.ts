import {
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server as McpServerInstance } from '@modelcontextprotocol/sdk/server/index.js';
import { buildDiff } from './lib/diff.js';
import { fetchCapture, fetchCaptureText, resolveTimestamp } from './lib/wayback.js';
import { mimeTypeForFormat } from './lib/resources.js';
import { formatFailure } from './lib/errors.js';
import type { ToolContext } from './tools/index.js';

/**
 * G3: the server used to advertise `resource_link` blocks while declaring no
 * `resources` capability and implementing no `resources/read`, so **no** MCP
 * client could resolve them — it was never a claude.ai limitation. These handlers
 * serve exactly the artifacts the HTTP `/r/...` routes serve, keyed by the same
 * URIs the tools hand out, so a link now resolves in-protocol as well as over HTTP.
 */

interface ParsedResourceUri {
  readonly kind: 'snapshot' | 'diff';
  readonly timestampA: string;
  readonly timestampB: string | undefined;
  readonly target: string;
  readonly format: string;
  readonly granularity: string;
}

/** Parses a URI this server previously emitted. Shape mirrors the HTTP routes. */
export function parseResourceUri(uri: string, pathSecret: string): ParsedResourceUri | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  // ['r', secret, kind, ...rest]
  if (segments[0] !== 'r' || segments[1] !== pathSecret) return undefined;
  const kind = segments[2];
  const rest = segments.slice(3);

  const decodeTail = (parts: readonly string[]): string | undefined => {
    const queryUrl = parsed.searchParams.get('url');
    if (queryUrl !== null && queryUrl.trim().length > 0) return queryUrl.trim();
    if (parts.length === 0) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(parts.join('/'));
    } catch {
      decoded = parts.join('/');
    }
    return decoded.replace(/^(https?):\/(?!\/)/i, '$1://');
  };

  const rawFormat = parsed.searchParams.get('format');
  const format = rawFormat === 'markdown' || rawFormat === 'raw' ? rawFormat : 'text';
  const granularity = parsed.searchParams.get('granularity') === 'word' ? 'word' : 'line';

  if (kind === 'snapshot') {
    const timestampA = rest[0];
    const target = decodeTail(rest.slice(1));
    if (timestampA === undefined || target === undefined) return undefined;
    return { kind: 'snapshot', timestampA, timestampB: undefined, target, format, granularity };
  }
  if (kind === 'diff') {
    const timestampA = rest[0];
    const timestampB = rest[1];
    const target = decodeTail(rest.slice(2));
    if (timestampA === undefined || timestampB === undefined || target === undefined) return undefined;
    return { kind: 'diff', timestampA, timestampB, target, format, granularity };
  }
  return undefined;
}

export interface ResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/** Re-derives a resource's content from archive.org, exactly as the HTTP route does. */
export async function readResource(uri: string, ctx: ToolContext): Promise<ResourceContents> {
  const parsed = parseResourceUri(uri, ctx.config.pathSecret);
  if (parsed === undefined) {
    throw new Error(
      `Unknown resource URI. This server serves resources emitted by its own tools, of the form ${ctx.resourceBase.baseUrl}/r/{secret}/snapshot/{timestamp}/{encodedUrl} or /r/{secret}/diff/{a}/{b}/{encodedUrl}.`,
    );
  }
  const deps = { config: ctx.config, upstream: ctx.upstream };

  if (parsed.kind === 'snapshot') {
    const resolved = await resolveTimestamp(deps, parsed.target, parsed.timestampA);
    if (!resolved.ok) throw new Error(formatFailure(resolved.failure));

    if (parsed.format === 'raw') {
      const capture = await fetchCapture(deps, parsed.target, resolved.value.timestamp);
      if (!capture.ok) throw new Error(formatFailure(capture.failure));
      return { uri, mimeType: capture.value.mimeType.split(';')[0] ?? 'text/plain', text: capture.value.body };
    }
    const mode = parsed.format === 'markdown' ? 'markdown' : 'text';
    const capture = await fetchCaptureText(deps, parsed.target, resolved.value.timestamp, mode);
    if (!capture.ok) throw new Error(formatFailure(capture.failure));
    return { uri, mimeType: mimeTypeForFormat(parsed.format), text: capture.value.text };
  }

  const [resolvedA, resolvedB] = await Promise.all([
    resolveTimestamp(deps, parsed.target, parsed.timestampA),
    resolveTimestamp(deps, parsed.target, parsed.timestampB ?? 'latest'),
  ]);
  if (!resolvedA.ok) throw new Error(formatFailure(resolvedA.failure));
  if (!resolvedB.ok) throw new Error(formatFailure(resolvedB.failure));

  const [captureA, captureB] = await Promise.all([
    fetchCaptureText(deps, parsed.target, resolvedA.value.timestamp, 'text'),
    fetchCaptureText(deps, parsed.target, resolvedB.value.timestamp, 'text'),
  ]);
  if (!captureA.ok) throw new Error(formatFailure(captureA.failure));
  if (!captureB.ok) throw new Error(formatFailure(captureB.failure));

  const diff = buildDiff(captureA.value.text, captureB.value.text, {
    granularity: parsed.granularity === 'word' ? 'word' : 'line',
    labelA: `${parsed.target} @ ${captureA.value.timestamp}`,
    labelB: `${parsed.target} @ ${captureB.value.timestamp}`,
  });
  return {
    uri,
    mimeType: 'text/plain',
    text: diff.identical ? '(no differences in the extracted text of these two captures)\n' : diff.unified,
  };
}

/**
 * Resource templates rather than a fixed list: the addressable set is every
 * capture in the Wayback Machine, which cannot be enumerated. `resources/list`
 * is therefore empty by design and the templates describe what is readable.
 */
export function registerResourceHandlers(server: McpServerInstance, ctx: ToolContext): void {
  const base = ctx.resourceBase;

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: `${base.baseUrl}/r/${base.pathSecret}/snapshot/{timestamp}/{encodedUrl}`,
        name: 'Archived capture',
        title: 'Archived capture as text, markdown or original bytes',
        description:
          'One Wayback Machine capture. {timestamp} accepts a 14-digit timestamp, a partial date, "earliest" or "latest". Add ?format=text|markdown|raw. Emitted by get_snapshot.',
        mimeType: 'text/plain',
      },
      {
        uriTemplate: `${base.baseUrl}/r/${base.pathSecret}/diff/{timestampA}/{timestampB}/{encodedUrl}`,
        name: 'Capture diff',
        title: 'Full unified diff between two captures',
        description:
          'The complete unified diff between two captures of one URL, uncapped. Add ?granularity=line|word. Emitted by compare_snapshots.',
        mimeType: 'text/plain',
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const contents = await readResource(request.params.uri, ctx);
    return { contents: [contents] };
  });
}
