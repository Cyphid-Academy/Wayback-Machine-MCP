import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { formatFailure, failure } from './lib/errors.js';
import { registerResourceHandlers } from './resources.js';
import type { ToolContext, ToolModule } from './tools/index.js';

export const SERVER_NAME = 'wayback-machine-mcp';
export const SERVER_VERSION = '1.0.0';

const INSTRUCTIONS = [
  'Tools for querying the Internet Archive: the Wayback Machine (archived web pages) and archive.org (items such as books, audio and film).',
  '',
  'Start cheap: archive_stats tells you how much history exists for a URL and over what period, for one request and no page content. check_availability answers "is this archived near this date".',
  'Then narrow: list_revisions collapses hundreds of captures into the handful of distinct content revisions of a page — this is the tool for reconstructing the edit history of a page that is rewritten in place at a stable URL. search_snapshots is the general capture-index query when you need raw enumeration or paging.',
  'Then read or diff: get_snapshot returns one capture as chrome-stripped text; compare_snapshots diffs two captures server-side and returns only what changed.',
  '',
  'Every result carries a human-readable summary and typed structured data. The summary is repeated in the `summary` field of structuredContent, and page text and diffs are returned inline in the `text` and `diff` fields — read those rather than expecting a separate text block.',
  '',
  'Results are deliberately bounded. Page text and diffs are inlined up to a maxChars budget (8,000 and 15,000 by default, up to 100,000) and cut with an explicit marker plus a resource link to the full artifact, because an oversized tool result fails outright rather than truncating.',
  '',
  'All archive.org requests share one per-server rate budget. Requests queue rather than fail, so prefer sequential calls over parallel ones; a burst just makes everything slower.',
].join('\n');

/**
 * Builds an MCP server exposing the tool registry. Construction is cheap and
 * does no I/O, so a fresh instance per request is fine — which is what stateless
 * operation on Autoscale requires.
 */
export function createMcpServer(ctx: ToolContext, tools: readonly ToolModule[]): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Internet Archive (Wayback Machine)' },
    // G3: `resources` is declared because the tools emit resource_link blocks.
    // Advertising links without the capability made them unresolvable by every
    // client, not just claude.ai.
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputJsonSchema,
      outputSchema: tool.outputJsonSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((candidate) => candidate.name === request.params.name);
    if (tool === undefined) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: formatFailure(
              failure('invalid_input', `No tool named "${request.params.name}".`, {
                hint: `Available tools: ${tools.map((candidate) => candidate.name).join(', ')}.`,
              }),
            ),
          },
        ],
      };
    }

    ctx.logger.info('tool call', { tool: tool.name });
    const payload = await tool.run(request.params.arguments, ctx);
    return {
      content: payload.content,
      ...(payload.structuredContent === undefined ? {} : { structuredContent: payload.structuredContent }),
      ...(payload.isError === true ? { isError: true } : {}),
    };
  });

  registerResourceHandlers(server, ctx);

  return server;
}
