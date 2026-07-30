import { timestampToIso } from '../lib/timestamps.js';
import { SUMMARY_CHARS } from '../lib/resources.js';

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** 20230912134501 -> 2023-09-12 */
export function shortDate(timestamp: string): string {
  return timestampToIso(timestamp).slice(0, 10);
}

/** 20230912134501 -> 2023-09-12 13:45 */
export function shortDateTime(timestamp: string): string {
  const iso = timestampToIso(timestamp);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 || unit === 0 ? Math.round(scaled).toString() : scaled.toFixed(1)} ${units[unit] ?? 'B'}`;
}

/**
 * Keeps the human-readable `content` block inside the budget from build spec §2.
 * The structured output and resource links carry the detail.
 */
export function summary(lines: readonly string[], limit: number = SUMMARY_CHARS): string {
  const text = lines.filter((line) => line.length > 0).join('\n');
  if (text.length <= limit) return text;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > limit - 60) break;
    kept.push(line);
    used += line.length + 1;
  }
  kept.push('… summary truncated; see structuredContent for the full result.');
  return kept.join('\n');
}
