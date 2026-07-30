import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DIFF_INLINE_CAP, buildDiff, capText } from '../src/lib/diff.js';

describe('buildDiff (line granularity)', () => {
  it('reports identical inputs as identical with an empty diff', () => {
    const result = buildDiff('same\ntext\n', 'same\ntext\n');
    assert.equal(result.identical, true);
    assert.equal(result.unified, '');
    assert.equal(result.addedChars, 0);
    assert.equal(result.removedChars, 0);
    assert.equal(result.changedSections, 0);
  });

  it('produces a unified diff with headers and hunks', () => {
    const result = buildDiff('alpha\nbravo\ncharlie\n', 'alpha\nbravo CHANGED\ncharlie\n', {
      labelA: 'A',
      labelB: 'B',
    });
    assert.equal(result.identical, false);
    assert.match(result.unified, /^--- A\n\+\+\+ B\n/);
    assert.match(result.unified, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    assert.match(result.unified, /^-bravo$/m);
    assert.match(result.unified, /^\+bravo CHANGED$/m);
    assert.equal(result.addedLines, 1);
    assert.equal(result.removedLines, 1);
    assert.equal(result.changedSections, 1);
  });

  it('counts characters excluding the +/- marker', () => {
    const result = buildDiff('one\n', 'one\ntwo\n');
    assert.equal(result.addedChars, 'two'.length);
    assert.equal(result.removedChars, 0);
  });

  it('counts separated edits as separate sections', () => {
    const before = Array.from({ length: 40 }, (_unused, index) => `line ${String(index)}`).join('\n');
    const after = before.replace('line 1\n', 'line 1 EDITED\n').replace('line 30', 'line 30 EDITED');
    const result = buildDiff(before, after);
    assert.equal(result.changedSections, 2);
  });

  it('surfaces the message-limit style change that the acceptance test looks for', () => {
    const older = 'Plan limits\nPro subscribers can send at least 100 messages every 8 hours.\nMore text.';
    const newer = 'Plan limits\nPro subscribers can send at least 45 messages every 5 hours.\nMore text.';
    const result = buildDiff(older, newer);
    assert.match(result.unified, /^-.*100 messages every 8 hours/m);
    assert.match(result.unified, /^\+.*45 messages every 5 hours/m);
  });
});

describe('buildDiff (word granularity)', () => {
  it('reports word-level additions and removals', () => {
    const result = buildDiff('the quick brown fox', 'the slow brown fox', { granularity: 'word' });
    assert.equal(result.identical, false);
    assert.ok(result.addedChars > 0);
    assert.ok(result.removedChars > 0);
    assert.match(result.unified, /^\+ slow$/m);
    assert.match(result.unified, /^- quick$/m);
    assert.equal(result.changedSections, 1);
  });

  it('groups distant word edits into separate sections', () => {
    const filler = ' padding words that do not change at all in this sentence and continue for a while '.repeat(2);
    const result = buildDiff(`alpha${filler}omega`, `ALPHA${filler}OMEGA`, { granularity: 'word' });
    assert.ok(result.changedSections >= 2, `expected multiple sections, got ${String(result.changedSections)}`);
  });

  it('reports identical text as identical', () => {
    const result = buildDiff('unchanged text', 'unchanged text', { granularity: 'word' });
    assert.equal(result.identical, true);
  });
});

describe('capText', () => {
  it('leaves text under the cap untouched', () => {
    const result = capText('short', 100);
    assert.equal(result.truncated, false);
    assert.equal(result.text, 'short');
    assert.equal(result.totalChars, 5);
  });

  it('truncates at a line boundary and reports the original length', () => {
    const text = Array.from({ length: 200 }, (_unused, index) => `line ${String(index)}`).join('\n');
    const result = capText(text, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.totalChars, text.length);
    assert.ok(result.text.length <= 100);
    assert.ok(!result.text.endsWith('\n'));
    assert.ok(text.startsWith(result.text));
  });

  it('caps a long diff at the 15,000-character limit from the spec', () => {
    const before = Array.from({ length: 4_000 }, (_unused, index) => `old line ${String(index)}`).join('\n');
    const after = Array.from({ length: 4_000 }, (_unused, index) => `new line ${String(index)}`).join('\n');
    const diff = buildDiff(before, after);
    assert.ok(diff.totalChars > DIFF_INLINE_CAP, 'fixture should exceed the cap');
    const capped = capText(diff.unified, DIFF_INLINE_CAP);
    assert.equal(capped.truncated, true);
    assert.ok(capped.text.length <= DIFF_INLINE_CAP);
    assert.equal(capped.totalChars, diff.totalChars);
  });

  it('still reports statistics for a capped diff', () => {
    const before = Array.from({ length: 2_000 }, (_unused, index) => `old ${String(index)}`).join('\n');
    const after = Array.from({ length: 2_000 }, (_unused, index) => `new ${String(index)}`).join('\n');
    const diff = buildDiff(before, after);
    assert.equal(diff.addedLines, 2_000);
    assert.equal(diff.removedLines, 2_000);
    assert.ok(diff.addedChars > 0 && diff.removedChars > 0);
  });
});
