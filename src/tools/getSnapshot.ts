import { z } from 'zod';
import { getSnapshotInput, getSnapshotOutput } from '../schemas.js';
import { fetchCaptureText, resolveTimestamp } from '../lib/wayback.js';
import { normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { timestampToIso } from '../lib/timestamps.js';
import { mimeTypeForFormat, resourceLink, snapshotResourceUri, textPayload, type ResourceLinkBlock } from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule } from './define.js';
import { bytes, count, shortDateTime } from './format.js';

type Input = z.infer<typeof getSnapshotInput>;
type Output = z.infer<typeof getSnapshotOutput>;

export const getSnapshotTool: ToolModule = defineTool<Input, Output>({
  name: 'get_snapshot',
  title: 'Read one archived capture',
  description:
    'Fetches one capture of a URL and returns it as chrome-stripped text or markdown: navigation, headers, footers, cookie banners and language switchers are removed, so what comes back is the page content. The capture is fetched with the id_ modifier, i.e. the original bytes, not the Wayback-wrapped replay page. Small pages come back in full; anything over 8,000 characters returns a 2,000-character preview plus a resource link to the whole thing, because a full page capture will not fit in a tool result. timestamp accepts "latest", "earliest", or any date — partial dates resolve to the closest capture. format="raw" never inlines the bytes and only returns a resource link. Use check_availability or list_revisions first to pick a timestamp worth reading.',
  annotations: { title: 'Read one archived capture', readOnlyHint: true, openWorldHint: true },
  input: getSnapshotInput,
  output: getSnapshotOutput,
  async run(input, ctx) {
    const normalized = normalizeTargetUrl(input.url);
    if (!normalized.ok) return fail(normalized.failure);
    const url = normalized.value;
    const deps = { config: ctx.config, upstream: ctx.upstream };

    const resolved = await resolveTimestamp(deps, url, input.timestamp);
    if (!resolved.ok) return fail(resolved.failure);

    // `raw` is still extracted for the preview: build spec §2 forbids putting raw
    // HTML in `content`, so the bytes themselves are only reachable via the link.
    const extractMode = input.format === 'markdown' ? 'markdown' : 'text';
    const capture = await fetchCaptureText(deps, url, resolved.value, extractMode, input.modifier ?? 'id_');
    if (!capture.ok) return fail(capture.failure);

    const value = capture.value;
    const payload = textPayload(value.text);
    const inlineFull = input.format !== 'raw' && payload.inline !== undefined;
    const needsLink = !inlineFull;
    const uri = needsLink ? snapshotResourceUri(ctx.config, value.timestamp, url, input.format) : null;

    const structured: Output = {
      url,
      timestamp: value.timestamp,
      timestampIso: timestampToIso(value.timestamp),
      requestedTimestamp: input.timestamp,
      resolvedUrl: value.resolvedUrl,
      captureUrl: waybackCaptureUrl(ctx.config.webArchiveBase, value.timestamp, url),
      mimeType: value.mimeType,
      title: value.title ?? null,
      format: input.format,
      totalChars: payload.totalChars,
      truncated: needsLink,
      resourceUri: uri,
      bodyTruncated: value.bodyTruncated,
    };

    const links: ResourceLinkBlock[] = [];
    if (uri !== null) {
      links.push(
        resourceLink({
          uri,
          name: `${url} @ ${value.timestamp}`,
          title: value.title ?? `Capture of ${url} at ${shortDateTime(value.timestamp)}`,
          description:
            input.format === 'raw'
              ? `Original bytes of the ${shortDateTime(value.timestamp)} capture (${value.mimeType}).`
              : `Full ${input.format} extraction of the ${shortDateTime(value.timestamp)} capture, ${count(payload.totalChars)} characters.`,
          mimeType: input.format === 'raw' ? value.mimeType.split(';')[0] ?? 'application/octet-stream' : mimeTypeForFormat(input.format),
          size: payload.totalChars,
        }),
      );
    }

    const header = [
      `${url}`,
      `Capture ${value.timestamp} (${shortDateTime(value.timestamp)}), ${value.mimeType}${value.wasHtml ? '' : ' — not HTML, returned as plain text'}`,
      value.title === undefined ? '' : `Title: ${value.title}`,
      `Extracted ${count(payload.totalChars)} characters${value.bodyTruncated ? ' (upstream body hit the server byte cap)' : ''}`,
    ].filter((line) => line.length > 0);

    if (input.format === 'raw') {
      return succeed(
        structured,
        [
          ...header,
          '',
          'format="raw" never inlines the capture. The resource link below serves the original bytes.',
          '',
          'Text preview (first 2,000 characters of the extracted text):',
          payload.preview,
        ].join('\n'),
        links,
      );
    }

    if (inlineFull) {
      return succeed(structured, [...header, '', payload.inline ?? ''].join('\n'), links);
    }

    return succeed(
      structured,
      [
        ...header,
        `Too large to inline (limit 8,000 characters); full ${input.format} is behind the resource link below.`,
        '',
        `Preview (first ${count(payload.preview.length)} characters):`,
        payload.preview,
        '',
        `Full text: ${uri ?? ''} (${bytes(payload.totalChars)})`,
      ].join('\n'),
      links,
    );
  },
});
