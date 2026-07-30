import { z } from 'zod';
import { clearCacheInput, clearCacheOutput } from '../schemas.js';
import { defineTool, succeed, type ToolModule, type WithoutSummary } from './define.js';
import { count } from './format.js';

type Input = z.infer<typeof clearCacheInput>;
type Output = z.infer<typeof clearCacheOutput>;
type Structured = WithoutSummary<Output>;

export const clearCacheTool: ToolModule = defineTool<Input, Output>({
  name: 'clear_cache',
  title: 'Clear cached archive.org responses',
  description:
    'Drops this server\'s in-memory cache of archive.org responses. Captures are cached for 24 hours and index queries for 1 hour, so reach for this only when you suspect you are seeing stale data — for example after using save_url and wanting the new capture to show up immediately. It does not touch anything at archive.org.',
  annotations: {
    title: 'Clear cached archive.org responses',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: clearCacheInput,
  output: clearCacheOutput,
  async run(_input, ctx) {
    const cleared = await ctx.cache.clear();
    const structured: Structured = { cleared, remaining: ctx.cache.size() };
    return succeed(structured, `Cleared ${count(cleared)} cached upstream response${cleared === 1 ? '' : 's'}.`);
  },
});
