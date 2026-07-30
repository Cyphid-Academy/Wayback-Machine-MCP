import { z } from 'zod';
import { getSnapshotInput, getSnapshotOutput } from '../schemas.js';
import { fetchCaptureText, offsetNotice, resolveTimestamp } from '../lib/wayback.js';
import { normalizeTargetUrl, waybackCaptureUrl } from '../lib/urls.js';
import { timestampToIso } from '../lib/timestamps.js';
import {
  mimeTypeForFormat,
  resourceLink,
  snapshotResourceUri,
  textPayload,
  truncationNotice,
  type ResourceLinkBlock,
} from '../lib/resources.js';
import { defineTool, fail, succeed, type ToolModule, type WithoutSummary } from './define.js';
import { bytes, count, shortDateTime } from './format.js';

type Input = z.infer<typeof getSnapshotInput>;
type Output = z.infer<typeof getSnapshotOutput>;
type Structured = WithoutSummary<Output>;

/** Below this much text from an HTML capture, the page probably renders client-side (G8). */
const SUSPECT_TEXT_CHARS = 200;

export const getSnapshotTool: ToolModule = defineTool<Input, Output>({
  name: 'get_snapshot',
  title: 'Read one archived capture',
  description:
    'Fetches one capture of a URL and returns its content as chrome-stripped text or markdown: navigation, headers, footers, cookie banners and language switchers are removed, so what comes back is the page itself. The content is returned inline, in both the text block and the `text` field of structuredContent. The capture is fetched with the id_ modifier — the original bytes, not the Wayback-wrapped replay page. timestamp accepts "latest", "earliest", or any date; a partial date resolves to the nearest capture and the result reports which capture you actually got and how many days that is from what you asked for, so content is never misattributed. Text longer than maxChars (default 8,000, up to 100,000) is cut with a marker saying so, and a resource link to the full artifact is attached. format="raw" is the one case with no inline content: it returns metadata and a link to the original bytes. Capture fetches share a per-server archive.org request budget, so prefer one call to several in parallel.',
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

    const extractMode = input.format === 'markdown' ? 'markdown' : 'text';
    const capture = await fetchCaptureText(deps, url, resolved.value.timestamp, extractMode, {
      modifier: input.modifier ?? 'id_',
    });
    if (!capture.ok) return fail(capture.failure);

    const value = capture.value;
    const payload = textPayload(value.text, input.maxChars);
    const isRaw = input.format === 'raw';

    // G1: the content is the output. It is inlined unless this is a raw-bytes
    // request, and a link is attached whenever anything was left out.
    const inlined = isRaw ? '' : payload.inline;
    const wasCut = !isRaw && inlined.length < payload.totalChars;
    const needsLink = isRaw || wasCut;
    const uri = needsLink ? snapshotResourceUri(ctx.resourceBase, value.timestamp, url, input.format) : null;

    // F6: the link advertises the artifact's byte length, never a character count.
    const artifactBytes = isRaw ? value.byteLength : Buffer.byteLength(value.text, 'utf8');
    // G8: an HTML capture that extracts to nothing is usually a client-rendered shell.
    const extractionSuspect = value.wasHtml && payload.totalChars < SUSPECT_TEXT_CHARS;

    const structured: Structured = {
      url,
      timestamp: value.timestamp,
      timestampIso: timestampToIso(value.timestamp),
      requestedTimestamp: input.timestamp,
      resolvedUrl: value.resolvedUrl,
      captureUrl: waybackCaptureUrl(ctx.config.webArchiveBase, value.timestamp, url),
      mimeType: value.mimeType,
      title: value.title ?? null,
      format: input.format,
      text: inlined,
      totalChars: payload.totalChars,
      artifactBytes,
      inlinedChars: inlined.length,
      maxChars: input.maxChars,
      // G6: exactly one meaning — the text here is shorter than the whole artifact.
      truncated: wasCut,
      resourceUri: uri,
      offsetDays: resolved.value.offsetDays,
      extractionSuspect,
    };

    const links: ResourceLinkBlock[] = [];
    if (uri !== null) {
      links.push(
        resourceLink({
          uri,
          name: `${url} @ ${value.timestamp}`,
          title: value.title ?? `Capture of ${url} at ${shortDateTime(value.timestamp)}`,
          description: isRaw
            ? `Original bytes of the ${shortDateTime(value.timestamp)} capture (${value.mimeType}, ${bytes(artifactBytes)}).`
            : `Full ${input.format} extraction of the ${shortDateTime(value.timestamp)} capture, ${count(payload.totalChars)} characters.`,
          mimeType: isRaw ? (value.mimeType.split(';')[0] ?? 'application/octet-stream') : mimeTypeForFormat(input.format),
          size: artifactBytes,
        }),
      );
    }

    const notice = offsetNotice(resolved.value);
    const lines: string[] = [];
    if (notice !== undefined) lines.push(notice, '');
    lines.push(
      url,
      `Capture ${value.timestamp} (${shortDateTime(value.timestamp)}), ${value.mimeType}${value.wasHtml ? '' : ' — not HTML, returned as plain text'}`,
    );
    if (value.title !== undefined) lines.push(`Title: ${value.title}`);
    lines.push(`Extracted ${count(payload.totalChars)} characters, artifact ${bytes(artifactBytes)}`);

    if (extractionSuspect) {
      lines.push(
        '',
        `Only ${count(payload.totalChars)} characters extracted from a ${bytes(artifactBytes)} HTML capture. This page probably renders its content client-side; the Wayback capture may contain only the shell. Try format="raw" to inspect.`,
      );
    }

    if (isRaw) {
      lines.push(
        '',
        'format="raw" returns no inline content by design — the resource link below serves the original bytes. Use format="text" or "markdown" to read the page here.',
      );
      return succeed(structured, lines.join('\n'), { links });
    }

    if (wasCut) lines.push('', truncationNotice(inlined.length, payload.totalChars));

    return succeed(structured, lines.join('\n'), { payload: inlined, links });
  },
});
