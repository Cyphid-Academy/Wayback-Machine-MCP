import { diffWords, structuredPatch } from 'diff';

export type Granularity = 'line' | 'word';

export interface DiffResult {
  readonly unified: string;
  readonly addedChars: number;
  readonly removedChars: number;
  readonly addedLines: number;
  readonly removedLines: number;
  /** Number of distinct changed regions (hunks for line mode, change runs for word mode). */
  readonly changedSections: number;
  readonly identical: boolean;
  readonly totalChars: number;
  /** Set when the diff algorithm gave up on very large, very different inputs. */
  readonly degraded: boolean;
}

export interface DiffOptions {
  readonly granularity?: Granularity;
  readonly labelA?: string;
  readonly labelB?: string;
  readonly contextLines?: number;
  /** Milliseconds before the diff algorithm gives up. */
  readonly timeoutMs?: number;
}

export interface CappedText {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalChars: number;
}

/** Hard cap from build spec §2: diffs never exceed this many characters inline. */
export const DIFF_INLINE_CAP = 15_000;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CONTEXT_LINES = 3;

/** Truncates on a line boundary and says so, instead of cutting mid-token. */
export function capText(text: string, cap: number): CappedText {
  const totalChars = text.length;
  if (totalChars <= cap) return { text, truncated: false, totalChars };
  const slice = text.slice(0, cap);
  const lastBreak = slice.lastIndexOf('\n');
  const body = lastBreak > cap * 0.5 ? slice.slice(0, lastBreak) : slice;
  return { text: body, truncated: true, totalChars };
}

function lineDiff(a: string, b: string, options: Required<Pick<DiffOptions, 'labelA' | 'labelB' | 'contextLines' | 'timeoutMs'>>): DiffResult {
  const patch = structuredPatch(options.labelA, options.labelB, a, b, undefined, undefined, {
    context: options.contextLines,
    timeout: options.timeoutMs,
  });

  if (patch === undefined) {
    return {
      unified: '',
      addedChars: Math.max(0, b.length - a.length),
      removedChars: Math.max(0, a.length - b.length),
      addedLines: 0,
      removedLines: 0,
      changedSections: 0,
      identical: false,
      totalChars: 0,
      degraded: true,
    };
  }

  const out: string[] = [`--- ${options.labelA}`, `+++ ${options.labelB}`];
  let addedChars = 0;
  let removedChars = 0;
  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of patch.hunks) {
    out.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
    );
    for (const line of hunk.lines) {
      out.push(line);
      const marker = line.slice(0, 1);
      if (marker === '+') {
        addedLines += 1;
        addedChars += line.length - 1;
      } else if (marker === '-') {
        removedLines += 1;
        removedChars += line.length - 1;
      }
    }
  }

  const identical = patch.hunks.length === 0;
  const unified = identical ? '' : out.join('\n');
  return {
    unified,
    addedChars,
    removedChars,
    addedLines,
    removedLines,
    changedSections: patch.hunks.length,
    identical,
    totalChars: unified.length,
    degraded: false,
  };
}

/** Distance in unchanged characters below which two edits count as one section. */
const WORD_SECTION_GAP = 30;
const WORD_CONTEXT_CHARS = 60;

function wordDiff(a: string, b: string, options: Required<Pick<DiffOptions, 'labelA' | 'labelB' | 'timeoutMs'>>): DiffResult {
  const changes = diffWords(a, b, { timeout: options.timeoutMs });
  if (changes === undefined) {
    return {
      unified: '',
      addedChars: Math.max(0, b.length - a.length),
      removedChars: Math.max(0, a.length - b.length),
      addedLines: 0,
      removedLines: 0,
      changedSections: 0,
      identical: false,
      totalChars: 0,
      degraded: true,
    };
  }

  let addedChars = 0;
  let removedChars = 0;
  const sections: string[] = [];
  let current: string[] = [];
  let pendingContext = '';
  let unchangedSinceChange = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    sections.push(current.join('\n'));
    current = [];
  };

  for (const change of changes) {
    if (!change.added && !change.removed) {
      if (current.length > 0) {
        unchangedSinceChange += change.value.length;
        if (unchangedSinceChange > WORD_SECTION_GAP) {
          current.push(`  ${collapse(change.value.slice(0, WORD_CONTEXT_CHARS))}`);
          flush();
        } else {
          current.push(`  ${collapse(change.value)}`);
        }
      }
      pendingContext = change.value.slice(-WORD_CONTEXT_CHARS);
      continue;
    }

    if (current.length === 0 && pendingContext.length > 0) {
      current.push(`  ${collapse(pendingContext)}`);
    }
    unchangedSinceChange = 0;
    if (change.added) {
      addedChars += change.value.length;
      current.push(`+ ${collapse(change.value)}`);
    } else {
      removedChars += change.value.length;
      current.push(`- ${collapse(change.value)}`);
    }
  }
  flush();

  const identical = addedChars === 0 && removedChars === 0;
  const unified = identical
    ? ''
    : [`--- ${options.labelA}`, `+++ ${options.labelB}`, ...sections.map((section, index) => `@@ change ${String(index + 1)} @@\n${section}`)].join(
        '\n',
      );

  return {
    unified,
    addedChars,
    removedChars,
    addedLines: 0,
    removedLines: 0,
    changedSections: sections.length,
    identical,
    totalChars: unified.length,
    degraded: false,
  };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Unified diff plus the statistics that make a capped diff still useful. */
export function buildDiff(a: string, b: string, options: DiffOptions = {}): DiffResult {
  const labelA = options.labelA ?? 'a';
  const labelB = options.labelB ?? 'b';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (a === b) {
    return {
      unified: '',
      addedChars: 0,
      removedChars: 0,
      addedLines: 0,
      removedLines: 0,
      changedSections: 0,
      identical: true,
      totalChars: 0,
      degraded: false,
    };
  }

  if ((options.granularity ?? 'line') === 'word') {
    return wordDiff(a, b, { labelA, labelB, timeoutMs });
  }
  return lineDiff(a, b, {
    labelA,
    labelB,
    contextLines: options.contextLines ?? DEFAULT_CONTEXT_LINES,
    timeoutMs,
  });
}
