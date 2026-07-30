import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCdxUrl, groupRevisions, parseCdxJson, type CdxRow } from '../src/lib/cdx.js';
import { normalizeTargetUrl, absoluteUrl, waybackCaptureUrl, preferHttps } from '../src/lib/urls.js';

const HEADER = ['timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'];

function row(timestamp: string, digest: string, extra: Partial<CdxRow> = {}): string[] {
  return [
    timestamp,
    extra.original ?? 'https://example.com/page',
    extra.mimetype ?? 'text/html',
    extra.statuscode ?? '200',
    digest,
    extra.length ?? '1234',
  ];
}

describe('buildCdxUrl', () => {
  it('always requests JSON and an explicit field list', () => {
    const url = new URL(buildCdxUrl('https://web.archive.org', { url: 'example.com' }));
    assert.equal(url.pathname, '/cdx/search/cdx');
    assert.equal(url.searchParams.get('output'), 'json');
    assert.equal(url.searchParams.get('fl'), 'timestamp,original,mimetype,statuscode,digest,length');
  });

  it('repeats collapse and filter parameters instead of joining them', () => {
    const url = new URL(
      buildCdxUrl('https://web.archive.org', {
        url: 'example.com',
        collapse: ['digest'],
        filter: ['statuscode:200', '!mimetype:image.*'],
      }),
    );
    assert.deepEqual(url.searchParams.getAll('collapse'), ['digest']);
    assert.deepEqual(url.searchParams.getAll('filter'), ['statuscode:200', '!mimetype:image.*']);
  });

  it('passes paging and range parameters through', () => {
    const url = new URL(
      buildCdxUrl('https://web.archive.org', {
        url: 'example.com',
        from: '20230101000000',
        to: '20231231235959',
        limit: -1,
        offset: 50,
        page: 2,
        pageSize: 100,
        matchType: 'prefix',
        resolveRevisits: true,
        fastLatest: true,
      }),
    );
    assert.equal(url.searchParams.get('from'), '20230101000000');
    assert.equal(url.searchParams.get('to'), '20231231235959');
    assert.equal(url.searchParams.get('limit'), '-1');
    assert.equal(url.searchParams.get('offset'), '50');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('pageSize'), '100');
    assert.equal(url.searchParams.get('matchType'), 'prefix');
    assert.equal(url.searchParams.get('resolveRevisits'), 'true');
    assert.equal(url.searchParams.get('fastLatest'), 'true');
  });

  it('omits optional parameters that were not supplied', () => {
    const url = new URL(buildCdxUrl('https://web.archive.org', { url: 'example.com' }));
    for (const key of ['from', 'to', 'limit', 'offset', 'page', 'pageSize', 'resolveRevisits', 'fastLatest']) {
      assert.equal(url.searchParams.has(key), false, `${key} should be absent`);
    }
  });
});

describe('parseCdxJson', () => {
  it('maps columns by header name, not by position', () => {
    const body = JSON.stringify([
      ['digest', 'timestamp', 'statuscode', 'original', 'length', 'mimetype'],
      ['DIGESTA', '20230101120000', '200', 'https://example.com/', '99', 'text/html'],
    ]);
    const parsed = parseCdxJson(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.rows, [
      {
        timestamp: '20230101120000',
        original: 'https://example.com/',
        mimetype: 'text/html',
        statuscode: '200',
        digest: 'DIGESTA',
        length: '99',
      },
    ]);
  });

  it('tolerates extra columns, such as those resolveRevisits adds', () => {
    const body = JSON.stringify([
      [...HEADER, 'robotflags', 'offset'],
      [...row('20230101120000', 'D1'), '-', '4096'],
    ]);
    const parsed = parseCdxJson(body);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.rows.length, 1);
  });

  it('treats an empty body as no captures rather than an error', () => {
    for (const body of ['', '   ', '\n']) {
      const parsed = parseCdxJson(body);
      assert.equal(parsed.ok, true);
      if (parsed.ok) assert.deepEqual(parsed.rows, []);
    }
  });

  it('returns no rows when only the header row is present', () => {
    const parsed = parseCdxJson(JSON.stringify([HEADER]));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.rows, []);
  });

  it('coerces numeric cells and nulls to strings', () => {
    const body = JSON.stringify([HEADER, ['20230101120000', 'https://example.com/', 'text/html', 200, null, 1234]]);
    const parsed = parseCdxJson(body);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.rows[0]?.statuscode, '200');
    assert.equal(parsed.rows[0]?.digest, '');
    assert.equal(parsed.rows[0]?.length, '1234');
  });

  it('reports an HTML error page as a structured upstream failure', () => {
    const parsed = parseCdxJson('<html><body>503 Service Unavailable</body></html>');
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.equal(parsed.failure.code, 'upstream_error');
    assert.match(parsed.failure.message, /HTML error page/);
  });

  it('rejects JSON that is not a table', () => {
    const parsed = parseCdxJson(JSON.stringify({ error: 'nope' }));
    assert.equal(parsed.ok, false);
  });
});

describe('groupRevisions', () => {
  const rows: CdxRow[] = [
    { timestamp: '20230101000000', original: 'u', mimetype: 'text/html', statuscode: '200', digest: 'D1', length: '10' },
    { timestamp: '20230201000000', original: 'u', mimetype: 'text/html', statuscode: '200', digest: 'D1', length: '10' },
    { timestamp: '20230301000000', original: 'u', mimetype: 'text/html', statuscode: '200', digest: 'D1', length: '10' },
    { timestamp: '20230401000000', original: 'u', mimetype: 'text/html', statuscode: '200', digest: 'D2', length: '20' },
    { timestamp: '20230501000000', original: 'u', mimetype: 'text/html', statuscode: '200', digest: 'D2', length: '20' },
    { timestamp: '20230601000000', original: 'u', mimetype: 'text/html', statuscode: '200', digest: 'D1', length: '10' },
  ];

  it('collapses consecutive identical digests into one run with first/last/count', () => {
    const runs = groupRevisions(rows);
    assert.equal(runs.length, 3, 'a reverted page produces three runs, not two');
    assert.deepEqual(
      runs.map((run) => [run.revisionIndex, run.digest, run.firstSeen, run.lastSeen, run.captureCount]),
      [
        [1, 'D1', '20230101000000', '20230301000000', 3],
        [2, 'D2', '20230401000000', '20230501000000', 2],
        [3, 'D1', '20230601000000', '20230601000000', 1],
      ],
    );
  });

  it('handles an empty capture list', () => {
    assert.deepEqual(groupRevisions([]), []);
  });
});

describe('url helpers', () => {
  it('accepts URLs with and without a scheme', () => {
    for (const input of ['example.com', 'example.com/page', 'https://example.com/page', ' <https://example.com/p> ']) {
      const result = normalizeTargetUrl(input);
      assert.equal(result.ok, true, `expected ${input} to be accepted`);
    }
  });

  it('rejects things that are not URLs', () => {
    for (const input of ['', 'not a url', 'localhost', 'https://exa mple.com']) {
      assert.equal(normalizeTargetUrl(input).ok, false, `expected ${input} to be rejected`);
    }
  });

  it('passes screenshot: pseudo-URLs through untouched', () => {
    const result = normalizeTargetUrl('screenshot:https://example.com/');
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value, 'screenshot:https://example.com/');
    assert.equal(absoluteUrl('screenshot:https://example.com/'), 'screenshot:https://example.com/');
  });

  it('defaults a missing scheme to https when building a capture URL', () => {
    assert.equal(
      waybackCaptureUrl('https://web.archive.org', '20230101000000', 'example.com/page', 'id_'),
      'https://web.archive.org/web/20230101000000id_/https://example.com/page',
    );
    assert.equal(
      waybackCaptureUrl('https://web.archive.org', '20230101000000', 'example.com/page'),
      'https://web.archive.org/web/20230101000000/https://example.com/page',
    );
  });

  it('upgrades http:// Wayback URLs from the availability API', () => {
    assert.equal(preferHttps('http://web.archive.org/web/1/x'), 'https://web.archive.org/web/1/x');
    assert.equal(preferHttps('http://example.com/x'), 'http://example.com/x');
  });
});
