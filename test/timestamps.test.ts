import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isFullTimestamp,
  normalizeTimestamp,
  timestampFromWaybackUrl,
  timestampToIso,
  timestampToMillis,
} from '../src/lib/timestamps.js';

function value(raw: string, bound: 'start' | 'end' = 'start'): string {
  const result = normalizeTimestamp(raw, bound);
  assert.equal(result.ok, true, `expected ${raw} to normalize`);
  return result.ok ? result.value : '';
}

describe('normalizeTimestamp', () => {
  it('pads a year down for a start bound and up for an end bound', () => {
    assert.equal(value('2023', 'start'), '20230101000000');
    assert.equal(value('2023', 'end'), '20231231235959');
  });

  it('pads a year-month using the real last day of the month', () => {
    assert.equal(value('202302', 'end'), '20230228235959');
    assert.equal(value('202402', 'end'), '20240229235959', 'leap year');
    assert.equal(value('202304', 'end'), '20230430235959');
  });

  it('accepts the documented input forms', () => {
    assert.equal(value('20230901'), '20230901000000');
    assert.equal(value('2023-09-01'), '20230901000000');
    assert.equal(value('2023-09-01T12:34:56Z'), '20230901123456');
    assert.equal(value('20230901123456'), '20230901123456');
    assert.equal(value('2023090112'), '20230901120000');
  });

  it('pads partial times upwards for an end bound', () => {
    assert.equal(value('20230901', 'end'), '20230901235959');
    assert.equal(value('2023090112', 'end'), '20230901125959');
  });

  it('rejects impossible dates and malformed input', () => {
    for (const bad of ['', 'yesterday', '2023-13-01', '20230230', '2023090199', '202309011', '1888', '2200']) {
      const result = normalizeTimestamp(bad, 'start');
      assert.equal(result.ok, false, `expected ${bad} to be rejected`);
      if (!result.ok) {
        assert.equal(result.failure.code, 'invalid_input');
        assert.ok(result.failure.hint !== undefined, 'rejections carry an actionable hint');
      }
    }
  });

  it('does not accept a 5 or 7 digit timestamp', () => {
    assert.equal(normalizeTimestamp('20239', 'start').ok, false);
    assert.equal(normalizeTimestamp('2023091', 'start').ok, false);
  });
});

describe('timestamp helpers', () => {
  it('converts to ISO 8601', () => {
    assert.equal(timestampToIso('20230115120000'), '2023-01-15T12:00:00Z');
    assert.equal(timestampToIso('2023'), '2023-01-01T00:00:00Z');
  });

  it('converts to millis for nearest-capture maths', () => {
    assert.equal(timestampToMillis('19700101000000'), 0);
    assert.ok(timestampToMillis('20240101000000') > timestampToMillis('20230101000000'));
  });

  it('recognises a full timestamp', () => {
    assert.equal(isFullTimestamp('20230115120000'), true);
    assert.equal(isFullTimestamp('202301'), false);
  });

  it('extracts the capture timestamp from a Wayback URL, with or without a modifier', () => {
    assert.equal(
      timestampFromWaybackUrl('https://web.archive.org/web/20230115120000id_/https://example.com/'),
      '20230115120000',
    );
    assert.equal(timestampFromWaybackUrl('https://web.archive.org/web/20230115120000/https://example.com/'), '20230115120000');
    assert.equal(timestampFromWaybackUrl('https://example.com/'), undefined);
  });
});
