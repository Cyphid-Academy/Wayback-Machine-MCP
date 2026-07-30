import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  BODIES,
  CAPTURES,
  GAP_CAPTURES,
  GAP_URL,
  ITEM_IDENTIFIER,
  ITEM_METADATA,
  MIXED_STATUS_CAPTURES,
  MIXED_STATUS_URL,
  NONCE_CAPTURES,
  NONCE_URL,
  PREFIX_CAPTURES,
  PREFIX_ORIGINALS,
  PREFIX_SLUG_A,
  PREFIX_STEM,
  REDIRECT_ONLY_CAPTURES,
  REDIRECT_ONLY_URL,
  SEARCH_DOCS,
  TARGET_URL,
  noncePageHtml,
  type FixtureCapture,
} from './pages.js';

/**
 * Every URL the fixture archive knows about. `prefixOf` lets one entry answer a
 * `matchType=prefix` query for a stem that has no captures of its own (F1).
 */
interface FixtureSite {
  readonly url: string;
  readonly captures: readonly FixtureCapture[];
  /** Overrides the reported `original` per capture, for multi-slug prefix matches. */
  readonly originals?: ReadonlyMap<string, string>;
  /** A stem that should match this site under matchType=prefix. */
  readonly prefixOf?: string;
  /** Generates a body per timestamp; falls back to the digest-keyed BODIES map. */
  readonly bodyFor?: (timestamp: string) => string;
}

const SITES: readonly FixtureSite[] = [
  { url: TARGET_URL, captures: CAPTURES },
  { url: PREFIX_SLUG_A, captures: PREFIX_CAPTURES, originals: PREFIX_ORIGINALS, prefixOf: PREFIX_STEM },
  { url: REDIRECT_ONLY_URL, captures: REDIRECT_ONLY_CAPTURES },
  { url: MIXED_STATUS_URL, captures: MIXED_STATUS_CAPTURES },
  { url: GAP_URL, captures: GAP_CAPTURES },
  { url: NONCE_URL, captures: NONCE_CAPTURES, bodyFor: noncePageHtml },
];

/**
 * A stand-in for web.archive.org and archive.org, good enough to exercise the CDX
 * contract, the availability API, capture fetching (including the redirect to the
 * nearest capture), the sparkline, Advanced Search, item metadata and Save Page Now.
 *
 * Unit and integration tests point WEB_ARCHIVE_BASE/ARCHIVE_BASE at this, so
 * nothing in the suite touches the real Internet Archive.
 */
export interface FixtureUpstream {
  readonly origin: string;
  readonly requests: string[];
  readonly userAgents: string[];
  close(): Promise<void>;
  /** Makes the next `count` CDX requests fail with the given status. */
  failNext(count: number, status: number, retryAfterSeconds?: number): void;
  /** Makes one capture permanently unfetchable, as archive.org sometimes does (F7). */
  breakCapture(timestamp: string): void;
  repairCaptures(): void;
}

function normalizeKey(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function applyFilters(captures: readonly FixtureCapture[], filters: readonly string[]): FixtureCapture[] {
  let rows = [...captures];
  for (const filter of filters) {
    const negated = filter.startsWith('!');
    const body = negated ? filter.slice(1) : filter;
    const [field, ...rest] = body.split(':');
    const pattern = rest.join(':');
    if (field === undefined || pattern.length === 0) continue;
    const regex = new RegExp(`^${pattern}$`);
    rows = rows.filter((row) => {
      const value =
        field === 'statuscode'
          ? row.statuscode
          : field === 'mimetype'
            ? row.mimetype
            : field === 'digest'
              ? row.digest
              : row.timestamp;
      const matched = regex.test(value);
      return negated ? !matched : matched;
    });
  }
  return rows;
}

function applyCollapse(captures: readonly FixtureCapture[], collapses: readonly string[]): FixtureCapture[] {
  let rows = [...captures];
  for (const collapse of collapses) {
    const [field, widthRaw] = collapse.split(':');
    const width = widthRaw === undefined ? undefined : Number.parseInt(widthRaw, 10);
    const keyOf = (row: FixtureCapture): string => {
      const value = field === 'digest' ? row.digest : field === 'mimetype' ? row.mimetype : row.timestamp;
      return width === undefined || !Number.isFinite(width) ? value : value.slice(0, width);
    };
    const collapsed: FixtureCapture[] = [];
    let previous: string | undefined;
    for (const row of rows) {
      const key = keyOf(row);
      if (key === previous) continue;
      previous = key;
      collapsed.push(row);
    }
    rows = collapsed;
  }
  return rows;
}

/** Resolves a CDX query to a fixture site, honouring matchType=prefix. */
function siteFor(requested: string, matchType: string): FixtureSite | undefined {
  const key = normalizeKey(requested);
  const exact = SITES.find((site) => normalizeKey(site.url) === key);
  if (exact !== undefined) return exact;
  if (matchType === 'prefix' || matchType === 'host' || matchType === 'domain') {
    return SITES.find(
      (site) => normalizeKey(site.prefixOf ?? '') === key || normalizeKey(site.url).startsWith(key),
    );
  }
  return undefined;
}

function cdxResponse(params: URLSearchParams): string {
  const requested = params.get('url') ?? '';
  const site = siteFor(requested, params.get('matchType') ?? 'exact');
  if (site === undefined) return '';

  let rows = applyFilters(site.captures, params.getAll('filter'));
  const from = params.get('from');
  const to = params.get('to');
  if (from !== null) rows = rows.filter((row) => row.timestamp >= from.padEnd(14, '0'));
  if (to !== null) rows = rows.filter((row) => row.timestamp <= to.padEnd(14, '9'));
  rows = applyCollapse(rows, params.getAll('collapse'));

  const offset = Number.parseInt(params.get('offset') ?? '0', 10);
  if (Number.isFinite(offset) && offset > 0) rows = rows.slice(offset);

  const limitRaw = params.get('limit');
  if (limitRaw !== null) {
    const limit = Number.parseInt(limitRaw, 10);
    if (Number.isFinite(limit) && limit > 0) rows = rows.slice(0, limit);
    else if (Number.isFinite(limit) && limit < 0) rows = rows.slice(limit);
  }
  if (rows.length === 0) return '';

  const fields = (params.get('fl') ?? 'urlkey,timestamp,original,mimetype,statuscode,digest,length').split(',');
  const valueFor = (row: FixtureCapture, field: string): string => {
    switch (field) {
      case 'urlkey':
        return 'org,example,support)/fixture';
      case 'timestamp':
        return row.timestamp;
      case 'original':
        return site.originals?.get(row.timestamp) ?? `https://${site.url}`;
      case 'mimetype':
        return row.mimetype;
      case 'statuscode':
        return row.statuscode;
      case 'digest':
        return row.digest;
      case 'length':
        return row.length;
      default:
        return '';
    }
  };
  return JSON.stringify([fields, ...rows.map((row) => fields.map((field) => valueFor(row, field)))]);
}

function nearestCapture(timestamp: string, captures: readonly FixtureCapture[] = CAPTURES): FixtureCapture | undefined {
  const target = timestamp.padEnd(14, '0');
  let best: FixtureCapture | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const capture of captures) {
    if (capture.statuscode !== '200') continue;
    const distance = Math.abs(Number(capture.timestamp) - Number(target));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = capture;
    }
  }
  return best;
}

function sparkline(): string {
  const years: Record<string, number[]> = {};
  for (const capture of CAPTURES) {
    if (capture.statuscode !== '200') continue;
    const year = capture.timestamp.slice(0, 4);
    const month = Number.parseInt(capture.timestamp.slice(4, 6), 10) - 1;
    const bucket = years[year] ?? Array.from({ length: 12 }, () => 0);
    bucket[month] = (bucket[month] ?? 0) + 1;
    years[year] = bucket;
  }
  const live = CAPTURES.filter((capture) => capture.statuscode === '200');
  return JSON.stringify({
    years,
    first_ts: live[0]?.timestamp ?? null,
    last_ts: live[live.length - 1]?.timestamp ?? null,
    status: { 200: live.length },
  });
}

export async function startFixtureUpstream(): Promise<FixtureUpstream> {
  const requests: string[] = [];
  const userAgents: string[] = [];
  const brokenCaptures = new Set<string>();
  let failures = 0;
  let failureStatus = 500;
  let retryAfter: number | undefined;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://fixture.invalid');
    requests.push(`${req.method ?? 'GET'} ${url.pathname}${url.search}`);
    const agent = req.headers['user-agent'];
    if (typeof agent === 'string') userAgents.push(agent);

    const send = (status: number, body: string, contentType = 'application/json'): void => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(body);
    };

    if (failures > 0) {
      failures -= 1;
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter);
      res.writeHead(failureStatus, headers);
      res.end('injected failure');
      return;
    }

    if (url.pathname === '/cdx/search/cdx') {
      send(200, cdxResponse(url.searchParams), 'application/json');
      return;
    }

    if (url.pathname === '/wayback/available') {
      const target = url.searchParams.get('url') ?? '';
      const site = siteFor(target, 'exact');
      if (site === undefined) {
        send(200, JSON.stringify({ url: target, archived_snapshots: {} }));
        return;
      }
      const stampParam = url.searchParams.get('timestamp');
      const live = site.captures.filter((capture) => capture.statuscode === '200');
      const capture = stampParam === null ? live[live.length - 1] : nearestCapture(stampParam, live);
      if (capture === undefined) {
        send(200, JSON.stringify({ url: target, archived_snapshots: {} }));
        return;
      }
      send(
        200,
        JSON.stringify({
          url: target,
          archived_snapshots: {
            closest: {
              status: '200',
              available: true,
              url: `http://web.archive.org/web/${capture.timestamp}/https://${site.url}`,
              timestamp: capture.timestamp,
            },
          },
          ...(stampParam === null ? {} : { timestamp: stampParam }),
        }),
      );
      return;
    }

    if (url.pathname === '/__wb/sparkline') {
      const target = url.searchParams.get('url') ?? '';
      send(200, normalizeKey(target) === normalizeKey(TARGET_URL) ? sparkline() : JSON.stringify({ years: {} }));
      return;
    }

    // Lets a test make one specific capture unfetchable, for F7.
    if (url.pathname === '/__fixture/break-capture') {
      brokenCaptures.add(url.searchParams.get('timestamp') ?? '');
      send(200, JSON.stringify({ ok: true }));
      return;
    }

    // /web/{timestamp}{modifier}/{url}
    const capture = /^\/web\/(\d{4,14})([a-z]{2}_)?\/(.+)$/i.exec(url.pathname + url.search);
    if (capture !== null) {
      const timestamp = capture[1] ?? '';
      const modifier = capture[2] ?? '';
      const target = capture[3] ?? '';
      if (normalizeKey(target).startsWith('screenshot:')) {
        send(404, 'no screenshot', 'text/plain');
        return;
      }
      const site = siteFor(target, 'exact');
      if (site === undefined) {
        send(404, 'not in archive', 'text/plain');
        return;
      }
      if (brokenCaptures.has(timestamp)) {
        // Destroy the socket: the same shape as a capture that is simply gone (F7).
        res.destroy();
        return;
      }
      const exact = site.captures.find((row) => row.timestamp === timestamp && row.statuscode === '200');
      if (exact === undefined) {
        // Mirror the real behaviour: redirect to the nearest capture.
        const nearest = nearestCapture(timestamp, site.captures.filter((row) => row.statuscode === '200'));
        if (nearest === undefined) {
          send(404, 'not in archive', 'text/plain');
          return;
        }
        res.writeHead(302, { location: `/web/${nearest.timestamp}${modifier}/${target}` });
        res.end();
        return;
      }
      const body =
        site.bodyFor !== undefined
          ? site.bodyFor(exact.timestamp)
          : (BODIES.get(exact.digest) ?? '<html><body>missing fixture</body></html>');
      send(200, body, 'text/html; charset=utf-8');
      return;
    }

    if (url.pathname === '/advancedsearch.php') {
      const rows = Number.parseInt(url.searchParams.get('rows') ?? '20', 10);
      send(
        200,
        JSON.stringify({
          responseHeader: { status: 0, QTime: 3 },
          response: { numFound: 137, start: 0, docs: SEARCH_DOCS.slice(0, Number.isFinite(rows) ? rows : 20) },
        }),
      );
      return;
    }

    if (url.pathname === `/metadata/${ITEM_IDENTIFIER}`) {
      send(200, JSON.stringify(ITEM_METADATA));
      return;
    }
    if (url.pathname.startsWith('/metadata/')) {
      send(200, JSON.stringify({}));
      return;
    }

    if (url.pathname === '/save/' && req.method === 'POST') {
      send(200, JSON.stringify({ url: `https://${TARGET_URL}`, job_id: 'fixture-job-1' }));
      return;
    }
    if (url.pathname.startsWith('/save/status/')) {
      send(
        200,
        JSON.stringify({
          status: 'success',
          job_id: 'fixture-job-1',
          original_url: `https://${TARGET_URL}`,
          timestamp: '20260720090000',
          duration_sec: 4.2,
        }),
      );
      return;
    }

    send(404, 'fixture: unknown route', 'text/plain');
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture upstream failed to bind');

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    userAgents,
    failNext(count, status, retryAfterSeconds) {
      failures = count;
      failureStatus = status;
      retryAfter = retryAfterSeconds;
    },
    breakCapture(timestamp) {
      brokenCaptures.add(timestamp);
    },
    repairCaptures() {
      brokenCaptures.clear();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      }),
  };
}
