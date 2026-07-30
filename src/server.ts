import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { formatFailure, failure } from './lib/errors.js';
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
  'Results are deliberately small. Page text over 8,000 characters and diffs over 15,000 characters come back as a preview plus a resource link rather than inline, because oversized tool results fail outright rather than truncating.',
].join('\n');

/**
 * Builds an MCP server exposing the tool registry. Construction is cheap and
 * does no I/O, so a fresh instance per request is fine — which is what stateless
 * operation on Autoscale requires.
 */
export function createMcpServer(ctx: ToolContext, tools: readonly ToolModule[]): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Internet Archive (Wayback Machine)' },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
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

  return server;
}
