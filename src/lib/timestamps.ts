import { failure, type Failure } from './errors.js';

export type Bound = 'start' | 'end';

export type Normalized = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly failure: Failure };

const ACCEPTED_LENGTHS = [4, 6, 8, 10, 12, 14];

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function reject(raw: string, reason: string): Normalized {
  return {
    ok: false,
    failure: failure('invalid_input', `Could not read "${raw}" as a date: ${reason}`, {
      hint: 'Accepted forms: YYYY, YYYYMM, YYYYMMDD, YYYY-MM-DD, YYYYMMDDhhmmss, or an ISO date such as 2023-09-01T12:00:00Z.',
    }),
  };
}

/**
 * Normalises any accepted date form to a 14-digit Wayback timestamp.
 * `bound: 'start'` pads downwards (2023 -> 20230101000000);
 * `bound: 'end'` pads upwards (2023 -> 20231231235959).
 */
export function normalizeTimestamp(raw: string, bound: Bound = 'start'): Normalized {
  const digits = raw.trim().replace(/[-:/T\sZz.]/g, '');
  if (digits.length === 0) return reject(raw, 'no digits found.');
  if (!/^\d+$/.test(digits)) return reject(raw, 'it contains characters that are not digits or separators.');
  if (!ACCEPTED_LENGTHS.includes(digits.length)) {
    return reject(raw, `expected 4, 6, 8, 10, 12 or 14 digits but got ${String(digits.length)}.`);
  }

  const year = Number.parseInt(digits.slice(0, 4), 10);
  if (year < 1990 || year > 2100) return reject(raw, `year ${String(year)} is outside 1990-2100.`);

  const hasMonth = digits.length >= 6;
  const month = hasMonth ? Number.parseInt(digits.slice(4, 6), 10) : bound === 'start' ? 1 : 12;
  if (month < 1 || month > 12) return reject(raw, `month ${String(month)} is not between 01 and 12.`);

  const hasDay = digits.length >= 8;
  const lastDay = daysInMonth(year, month);
  const day = hasDay ? Number.parseInt(digits.slice(6, 8), 10) : bound === 'start' ? 1 : lastDay;
  if (day < 1 || day > lastDay) {
    return reject(raw, `day ${String(day)} does not exist in ${String(year)}-${String(month).padStart(2, '0')}.`);
  }

  const hour = digits.length >= 10 ? Number.parseInt(digits.slice(8, 10), 10) : bound === 'start' ? 0 : 23;
  if (hour > 23) return reject(raw, `hour ${String(hour)} is greater than 23.`);
  const minute = digits.length >= 12 ? Number.parseInt(digits.slice(10, 12), 10) : bound === 'start' ? 0 : 59;
  if (minute > 59) return reject(raw, `minute ${String(minute)} is greater than 59.`);
  const second = digits.length >= 14 ? Number.parseInt(digits.slice(12, 14), 10) : bound === 'start' ? 0 : 59;
  if (second > 59) return reject(raw, `second ${String(second)} is greater than 59.`);

  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return { ok: true, value: `${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}${pad(hour, 2)}${pad(minute, 2)}${pad(second, 2)}` };
}

export function isFullTimestamp(value: string): boolean {
  return /^\d{14}$/.test(value);
}

/** 20230115120000 -> 2023-01-15T12:00:00Z. Short inputs are padded first. */
export function timestampToIso(timestamp: string): string {
  const normalized = normalizeTimestamp(timestamp, 'start');
  const value = normalized.ok ? normalized.value : timestamp.padEnd(14, '0').slice(0, 14);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
}

/** Milliseconds since epoch for a Wayback timestamp, for nearest-capture maths. */
export function timestampToMillis(timestamp: string): number {
  return Date.parse(timestampToIso(timestamp));
}

/** Pulls the capture timestamp back out of a Wayback URL after redirects. */
export function timestampFromWaybackUrl(url: string): string | undefined {
  const match = /\/web\/(\d{4,14})(?:[a-z]{2}_)?\//i.exec(url);
  const captured = match?.[1];
  if (captured === undefined) return undefined;
  return captured.padEnd(14, '0').slice(0, 14);
}
