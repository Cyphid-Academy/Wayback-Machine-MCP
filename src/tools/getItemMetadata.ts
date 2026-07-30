import { z } from 'zod';
import { getItemMetadataInput, getItemMetadataOutput, itemMetadataResponseSchema } from '../schemas.js';
import { CACHE_TTL } from '../lib/cache.js';
import { INLINE_TEXT_LIMIT, resourceLink, type ResourceLinkBlock } from '../lib/resources.js';
import { failure } from '../lib/errors.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { bytes, count, summary } from './format.js';

type Input = z.infer<typeof getItemMetadataInput>;
type Output = z.infer<typeof getItemMetadataOutput>;
type FileRow = z.infer<typeof getItemMetadataOutput>['files'][number];

const TEXT_ROWS = 12;
const DESCRIPTION_CHARS = 600;

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map((entry) => asText(entry)).filter((entry): entry is string => entry !== null);
    return parts.length === 0 ? null : parts.join(', ');
  }
  return null;
}

function asList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map((entry) => asText(entry)).filter((entry): entry is string => entry !== null);
  return [];
}

function asBytes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Strips HTML tags from archive.org description fields, which are often HTML. */
function plainDescription(value: string): string {
  const text = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= DESCRIPTION_CHARS ? text : `${text.slice(0, DESCRIPTION_CHARS)}…`;
}

export const getItemMetadataTool: ToolModule = defineTool<Input, Output>({
  name: 'get_item_metadata',
  title: 'archive.org item metadata',
  description:
    "Returns an archive.org item's metadata (title, creator, date, mediatype, collections, licence, description) plus a listing of its files with name, format and size — never file contents. Metadata blobs for large items can be enormous, so the description is trimmed, the file list is capped, and a resource link to the complete metadata JSON is attached when it does not fit. Get an identifier from search_items first.",
  annotations: { title: 'archive.org item metadata', readOnlyHint: true, openWorldHint: true },
  input: getItemMetadataInput,
  output: getItemMetadataOutput,
  async run(input, ctx) {
    const identifier = input.identifier.trim();
    if (!/^[A-Za-z0-9._@-]{1,256}$/.test(identifier)) {
      return fail(
        failure('invalid_input', `"${input.identifier}" is not a valid archive.org identifier.`, {
          hint: 'Identifiers contain letters, digits, dots, dashes and underscores. Get one from search_items.',
        }),
      );
    }

    const metadataUrl = `${ctx.config.archiveBase}/metadata/${encodeURIComponent(identifier)}`;
    const response = await ctx.upstream.get(metadataUrl, {
      ttlMs: CACHE_TTL.index,
      accept: 'application/json',
      what: `archive.org metadata for ${identifier}`,
    });
    if (!response.ok) return fail(response.failure);

    const parsed = ctx.upstream.parseJson(response.body, itemMetadataResponseSchema, response.fromCache, 'archive.org metadata');
    if (!parsed.ok) return fail(parsed.failure);

    const metadata = parsed.value.metadata ?? {};
    const rawFiles = parsed.value.files ?? [];
    if (Object.keys(metadata).length === 0 && rawFiles.length === 0) {
      return fail(
        failure('not_found', `archive.org has no item with identifier "${identifier}".`, {
          hint: 'Check the identifier with search_items — it is case-sensitive.',
        }),
      );
    }

    let totalBytes = 0;
    const allFiles: FileRow[] = [];
    for (const file of rawFiles) {
      const name = asText(file['name']);
      if (name === null) continue;
      const size = asBytes(file['size']);
      if (size !== null) totalBytes += size;
      allFiles.push({ name, format: asText(file['format']), size });
    }
    const files = allFiles.slice(0, input.maxFiles);
    const descriptionRaw = asText(metadata['description']);
    const needsLink = response.body.length > INLINE_TEXT_LIMIT || allFiles.length > files.length;

    const structured: Output = {
      identifier,
      title: asText(metadata['title']),
      creator: asText(metadata['creator']),
      date: asText(metadata['date']) ?? asText(metadata['publicdate']),
      mediatype: asText(metadata['mediatype']),
      collection: asList(metadata['collection']),
      description: descriptionRaw === null ? null : plainDescription(descriptionRaw),
      licenseUrl: asText(metadata['licenseurl']),
      files,
      fileCount: allFiles.length,
      filesTruncated: allFiles.length > files.length,
      totalBytes,
      detailsUrl: `${ctx.config.archiveBase}/details/${encodeURIComponent(identifier)}`,
      metadataUrl,
      resourceUri: needsLink ? metadataUrl : null,
    };

    // The upstream metadata endpoint is itself the artifact here: it is public,
    // immutable enough, and needs no server-side reduction beyond field picking.
    const links: ResourceLinkBlock[] = needsLink
      ? [
          resourceLink({
            uri: metadataUrl,
            name: `${identifier} metadata`,
            title: `Complete metadata JSON for ${identifier}`,
            description: `Full archive.org metadata and file listing (${count(allFiles.length)} files, ${bytes(response.byteLength)} of JSON).`,
            mimeType: 'application/json',
            size: response.byteLength,
          }),
        ]
      : [];

    const lines = [
      `${structured.title ?? identifier} (${identifier})`,
      [structured.mediatype, structured.date, structured.creator].filter((part) => part !== null && part.length > 0).join(' · '),
      structured.collection.length === 0 ? '' : `Collections: ${structured.collection.slice(0, 6).join(', ')}`,
      structured.licenseUrl === null ? '' : `Licence: ${structured.licenseUrl}`,
      structured.description === null ? '' : `\n${structured.description}`,
      '',
      `${count(allFiles.length)} file${allFiles.length === 1 ? '' : 's'}, ${bytes(totalBytes)} total:`,
      ...files.slice(0, TEXT_ROWS).map((file) => `  ${file.name}  ${file.format ?? ''} ${file.size === null ? '' : bytes(file.size)}`.trimEnd()),
    ];
    if (files.length > TEXT_ROWS) lines.push(`  … ${count(files.length - TEXT_ROWS)} more files in structuredContent.`);
    if (structured.filesTruncated) lines.push(`  File list capped at maxFiles=${String(input.maxFiles)} of ${count(allFiles.length)}.`);
    lines.push('', `Details page: ${structured.detailsUrl}`);

    return succeed(structured, summary(lines), links);
  },
});
