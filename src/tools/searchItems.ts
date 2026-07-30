import { z } from 'zod';
import { advancedSearchResponseSchema, searchItemsInput, searchItemsOutput } from '../schemas.js';
import { CACHE_TTL } from '../lib/cache.js';
import { MAX_TABLE_ROWS } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { count, summary } from './format.js';

type Input = z.infer<typeof searchItemsInput>;
type Output = z.infer<typeof searchItemsOutput>;
type Row = z.infer<typeof searchItemsOutput>['items'][number];

const DEFAULT_FIELDS = ['identifier', 'title', 'creator', 'date', 'mediatype'];
const TEXT_ROWS = 10;

/** archive.org returns a string, a number or an array depending on the field. */
function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => asText(entry)).filter((entry): entry is string => entry !== null);
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

export const searchItemsTool: ToolModule = defineTool<Input, Output>({
  name: 'search_items',
  title: 'Search archive.org items',
  description:
    'Searches archive.org items — books, audio, film, software, datasets — via Advanced Search, and returns one compact row per item (identifier, title, creator, date, mediatype). This is the archive.org library catalogue, not the Wayback Machine: for archived web pages use search_snapshots or list_revisions instead. Follow up with get_item_metadata on an identifier to see the item\'s files.',
  annotations: { title: 'Search archive.org items', readOnlyHint: true, openWorldHint: true },
  input: searchItemsInput,
  output: searchItemsOutput,
  async run(input, ctx) {
    const query = input.mediatype === undefined ? input.query : `(${input.query}) AND mediatype:(${input.mediatype})`;
    const fields = input.fields ?? DEFAULT_FIELDS;

    const params = new URLSearchParams();
    params.set('q', query);
    for (const field of fields) params.append('fl[]', field);
    if (input.sort !== undefined) params.append('sort[]', input.sort);
    params.set('rows', String(input.rows));
    params.set('page', String(input.page));
    params.set('output', 'json');
    const endpoint = `${ctx.config.archiveBase}/advancedsearch.php?${params.toString()}`;

    const response = await ctx.upstream.getJson(endpoint, advancedSearchResponseSchema, {
      ttlMs: CACHE_TTL.index,
      what: 'archive.org Advanced Search',
    });
    if (!response.ok) return fail(response.failure);

    const body = response.value.response;
    const items: Row[] = body.docs.slice(0, MAX_TABLE_ROWS).flatMap((doc) => {
      const identifier = asText(doc['identifier']);
      if (identifier === null) return [];
      return [
        {
          identifier,
          title: asText(doc['title']),
          creator: asText(doc['creator']),
          date: asText(doc['date']),
          mediatype: asText(doc['mediatype']),
          detailsUrl: `${ctx.config.archiveBase}/details/${encodeURIComponent(identifier)}`,
        },
      ];
    });

    const structured: Output = {
      query,
      items,
      numFound: body.numFound,
      start: body.start,
      page: input.page,
      hasMore: body.start + body.docs.length < body.numFound,
    };

    if (items.length === 0) {
      return succeed(
        structured,
        summary([
          `No archive.org items matched: ${query}`,
          'Next: loosen the query, drop the mediatype filter, or search a single field, e.g. title:(apollo).',
        ]),
      );
    }

    const lines = [
      `${count(body.numFound)} item${body.numFound === 1 ? '' : 's'} match ${query} — showing ${count(items.length)} (page ${String(input.page)})`,
      '',
      ...items.slice(0, TEXT_ROWS).map((item) => {
        const meta = [item.mediatype, item.date?.slice(0, 10), item.creator].filter((part) => part !== null && part !== undefined && part.length > 0);
        return `${item.identifier}\n  ${item.title ?? '(untitled)'}${meta.length === 0 ? '' : `\n  ${meta.join(' · ')}`}`;
      }),
    ];
    if (items.length > TEXT_ROWS) lines.push(`… ${count(items.length - TEXT_ROWS)} more in structuredContent.`);
    if (structured.hasMore) lines.push(`More results available; request page ${String(input.page + 1)}.`);
    lines.push('', 'Next: get_item_metadata identifier="<identifier>" for the file listing.');

    return succeed(structured, summary(lines));
  },
});
