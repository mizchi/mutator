import { describe, expect, it } from 'vitest';
import {
  changedLines,
  lineRanges,
  parseUnifiedDiff,
  renameMap,
  selectMutants,
  verifyDiff,
  type FileDiff,
} from '../src/diff.ts';
import type { Range } from '../src/types.ts';

const d = (...lines: string[]) => lines.join('\n') + '\n';

function single(text: string): FileDiff {
  const files = parseUnifiedDiff(text);
  expect(files).toHaveLength(1);
  return files[0]!;
}

function hunkFile(header: string, ...body: string[]): FileDiff {
  return single(d('--- a/f.ts', '+++ b/f.ts', header, ...body));
}

describe('parseUnifiedDiff', () => {
  it('parses a git diff with a/ b/ prefixes and hunk lines', () => {
    const f = single(
      d(
        'diff --git a/src/x.ts b/src/x.ts',
        'index 83db48f..bf269f4 100644',
        '--- a/src/x.ts',
        '+++ b/src/x.ts',
        '@@ -1,3 +1,3 @@ function foo() {',
        ' a',
        '-b',
        '+B',
        ' c',
      ),
    );
    expect(f).toEqual({
      oldPath: 'src/x.ts',
      newPath: 'src/x.ts',
      binary: false,
      hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' a', '-b', '+B', ' c'] }],
    });
  });

  it('defaults omitted hunk counts to 1', () => {
    const f = hunkFile('@@ -5 +5 @@', '-x', '+y');
    expect(f.hunks[0]).toMatchObject({ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 });
  });

  it('keeps hunk lines that look like file headers (--- / +++ inside a hunk)', () => {
    const f = hunkFile('@@ -1 +1 @@', '--- old', '+++ new');
    expect(f.hunks[0]!.lines).toEqual(['--- old', '+++ new']);
  });

  it('drops "\\ No newline at end of file" markers', () => {
    const f = hunkFile('@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file');
    expect(f.hunks[0]!.lines).toEqual(['-a', '+b']);
  });

  it('treats a bare empty line inside a hunk as an empty context line', () => {
    const f = hunkFile('@@ -1,3 +1,3 @@', ' a', '', '-b', '+c');
    expect(f.hunks[0]!.lines).toEqual([' a', ' ', '-b', '+c']);
  });

  it('parses multiple hunks and multiple files', () => {
    const files = parseUnifiedDiff(
      d(
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-1',
        '+2',
        '@@ -10 +10,2 @@',
        ' x',
        '+y',
        'diff --git a/b.ts b/b.ts',
        '--- a/b.ts',
        '+++ b/b.ts',
        '@@ -3 +3 @@',
        '-p',
        '+q',
      ),
    );
    expect(files.map((f) => [f.newPath, f.hunks.length])).toEqual([
      ['a.ts', 2],
      ['b.ts', 1],
    ]);
  });

  it('handles new files (/dev/null old side)', () => {
    const f = single(
      d(
        'diff --git a/n.ts b/n.ts',
        'new file mode 100644',
        'index 0000000..e69de29',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@ -0,0 +1,2 @@',
        '+a',
        '+b',
      ),
    );
    expect(f.oldPath).toBeNull();
    expect(f.newPath).toBe('n.ts');
  });

  it('handles empty new files with no hunks (path from diff --git header)', () => {
    const f = single(d('diff --git a/empty.ts b/empty.ts', 'new file mode 100644', 'index 0000000..e69de29'));
    expect(f).toEqual({ oldPath: null, newPath: 'empty.ts', hunks: [], binary: false });
  });

  it('handles deleted files (/dev/null new side)', () => {
    const f = single(
      d('diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1 +0,0 @@', '-x'),
    );
    expect(f.oldPath).toBe('gone.ts');
    expect(f.newPath).toBeNull();
  });

  it('handles pure renames without hunks', () => {
    const f = single(
      d('diff --git a/old/x.ts b/new/x.ts', 'similarity index 100%', 'rename from old/x.ts', 'rename to new/x.ts'),
    );
    expect(f).toEqual({ oldPath: 'old/x.ts', newPath: 'new/x.ts', hunks: [], binary: false });
  });

  it('handles renames with modifications', () => {
    const f = single(
      d(
        'diff --git a/o.ts b/n.ts',
        'similarity index 90%',
        'rename from o.ts',
        'rename to n.ts',
        'index 1..2 100644',
        '--- a/o.ts',
        '+++ b/n.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect([f.oldPath, f.newPath, f.hunks.length]).toEqual(['o.ts', 'n.ts', 1]);
  });

  it('marks binary files', () => {
    const f = single(d('diff --git a/img.png b/img.png', 'index 1..2 100644', 'Binary files a/img.png and b/img.png differ'));
    expect(f).toEqual({ oldPath: 'img.png', newPath: 'img.png', hunks: [], binary: true });
  });

  it('marks added binary files', () => {
    const f = single(
      d('diff --git a/img.png b/img.png', 'new file mode 100644', 'Binary files /dev/null and b/img.png differ'),
    );
    expect([f.oldPath, f.newPath, f.binary]).toEqual([null, 'img.png', true]);
  });

  it('supports --no-prefix output without stripping real directories', () => {
    const f = single(d('diff --git src/a.ts src/a.ts', '--- src/a.ts', '+++ src/a.ts', '@@ -1 +1 @@', '-a', '+b'));
    expect([f.oldPath, f.newPath]).toEqual(['src/a.ts', 'src/a.ts']);
  });

  it('strips when both sides carry a mnemonic-looking segment (indistinguishable from --no-prefix a/ dir)', () => {
    const f = single(d('diff --git a/x.ts a/x.ts', '--- a/x.ts', '+++ a/x.ts', '@@ -1 +1 @@', '-a', '+b'));
    expect(f.newPath).toBe('x.ts');
  });

  it('keeps paths whose leading segment is not a mnemonic prefix on both sides', () => {
    const f = single(d('diff --git src/a.ts b/src/a.ts', '--- src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-a', '+b'));
    expect([f.oldPath, f.newPath]).toEqual(['src/a.ts', 'b/src/a.ts']);
  });

  it('strips mnemonic prefixes (i/ w/ c/ o/)', () => {
    const f = single(d('diff --git i/x.ts w/x.ts', '--- i/x.ts', '+++ w/x.ts', '@@ -1 +1 @@', '-a', '+b'));
    expect([f.oldPath, f.newPath]).toEqual(['x.ts', 'x.ts']);
  });

  it('parses plain unified diffs (no diff --git) with timestamps', () => {
    const f = single(
      d('--- a/x.ts\t2024-01-01 00:00:00', '+++ b/x.ts\t2024-01-02 00:00:00', '@@ -1 +1 @@', '-a', '+b'),
    );
    expect([f.oldPath, f.newPath]).toEqual(['x.ts', 'x.ts']);
  });

  it('accepts CRLF input', () => {
    const text = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,2 @@', ' a', '-b', '+c', ''].join(
      '\r\n',
    );
    const f = single(text);
    expect(f.newPath).toBe('x.ts');
    expect(f.hunks[0]!.lines).toEqual([' a', '-b', '+c']);
  });

  it('handles paths with spaces (git appends a trailing tab)', () => {
    const f = single(
      d('diff --git a/my dir/x y.ts b/my dir/x y.ts', '--- a/my dir/x y.ts\t', '+++ b/my dir/x y.ts\t', '@@ -1 +1 @@', '-a', '+b'),
    );
    expect([f.oldPath, f.newPath]).toEqual(['my dir/x y.ts', 'my dir/x y.ts']);
  });

  it('handles paths with spaces in a header-only diff', () => {
    const f = single(d('diff --git a/my dir/e f.ts b/my dir/e f.ts', 'new file mode 100644', 'index 0000000..e69de29'));
    expect(f.newPath).toBe('my dir/e f.ts');
  });

  it('unquotes C-style quoted paths', () => {
    const f = single(
      d(
        'diff --git "a/t\\tab.ts" "b/\\346\\227\\245.ts"',
        '--- "a/t\\tab.ts"',
        '+++ "b/\\346\\227\\245.ts"',
        '@@ -1 +1 @@',
        '-a',
        '+b',
      ),
    );
    expect([f.oldPath, f.newPath]).toEqual(['t\tab.ts', '日.ts']);
  });

  it('does not read the trailing newline as a context line of a truncated hunk', () => {
    const f = hunkFile('@@ -1,3 +1,3 @@', ' a', '-b', '+c');
    expect(f.hunks[0]!.lines).toEqual([' a', '-b', '+c']);
  });

  it('returns [] for empty input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('changedLines (cargo-mutants semantics)', () => {
  it('single-line insert at i -> [i]', () => {
    expect(changedLines(hunkFile('@@ -1,2 +1,3 @@', ' a', '+X', ' b'))).toEqual([2]);
  });

  it('single-line delete before new line i -> [i-1, i]', () => {
    expect(changedLines(hunkFile('@@ -1,3 +1,2 @@', ' a', '-X', ' b'))).toEqual([1, 2]);
  });

  it('delete at file start -> [1] (line 0 is dropped)', () => {
    expect(changedLines(hunkFile('@@ -1,2 +1,1 @@', '-X', ' a'))).toEqual([1]);
  });

  it('delete at file end -> [last] only (no following line)', () => {
    expect(changedLines(hunkFile('@@ -1,2 +1,1 @@', ' a', '-X'))).toEqual([1]);
  });

  it('replace at i -> [i-1, i, i+1]: the "after delete" flag survives the insert and marks the next context line', () => {
    expect(changedLines(hunkFile('@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c'))).toEqual([1, 2, 3]);
  });

  it('multi-line replace marks the line before, all inserts, and the next context line', () => {
    expect(changedLines(hunkFile('@@ -1,4 +1,4 @@', ' a', '-b', '-c', '+B', '+C', ' d'))).toEqual([1, 2, 3, 4]);
  });

  it('insert followed by context does not mark the context line', () => {
    expect(changedLines(hunkFile('@@ -1,3 +1,4 @@', ' a', '+X', ' b', ' c'))).toEqual([2]);
  });

  it('pure-delete hunk with zero new lines uses newStart as the line before', () => {
    // "+2,0" means the deletion sits after new-side line 2
    expect(changedLines(hunkFile('@@ -3,1 +2,0 @@', '-X'))).toEqual([2]);
  });

  it('whole-file delete yields nothing', () => {
    expect(changedLines(hunkFile('@@ -1,2 +0,0 @@', '-a', '-b'))).toEqual([]);
  });

  it('new file marks every line', () => {
    expect(changedLines(hunkFile('@@ -0,0 +1,3 @@', '+a', '+b', '+c'))).toEqual([1, 2, 3]);
  });

  it('merges multiple hunks into a sorted unique list', () => {
    const f = single(
      d('--- a/f', '+++ b/f', '@@ -10,2 +10,2 @@', '-x', '+y', ' z', '@@ -1,2 +1,2 @@', ' a', '-b', '+c'),
    );
    expect(changedLines(f)).toEqual([1, 2, 9, 10, 11]);
  });

  it('is empty for renames and binaries', () => {
    expect(changedLines({ oldPath: 'a', newPath: 'b', hunks: [], binary: false })).toEqual([]);
  });
});

describe('verifyDiff', () => {
  const f = hunkFile('@@ -2,3 +2,3 @@', ' b', '-c', '+C', ' d');

  it('accepts a source matching the new side', () => {
    expect(verifyDiff(f, 'a\nb\nC\nd\ne\n')).toEqual({ ok: true });
  });

  it('accepts CRLF sources', () => {
    expect(verifyDiff(f, 'a\r\nb\r\nC\r\nd\r\n')).toEqual({ ok: true });
  });

  it('reports the first mismatching line', () => {
    expect(verifyDiff(f, 'a\nb\nc\nd\n')).toEqual({ ok: false, line: 3, expected: 'C', actual: 'c' });
  });

  it('reports lines past EOF with an empty actual', () => {
    expect(verifyDiff(f, 'a\nb\nC\n')).toEqual({ ok: false, line: 4, expected: 'd', actual: '' });
  });

  it('accepts binary / hunkless diffs', () => {
    expect(verifyDiff({ oldPath: 'x', newPath: 'x', hunks: [], binary: true }, 'anything')).toEqual({ ok: true });
  });
});

describe('lineRanges', () => {
  const src = 'ab\ncde\n\nfg';

  it('maps a single line to [start, end) excluding the newline', () => {
    expect(lineRanges(src, [2])).toEqual([{ start: 3, end: 6 }]);
  });

  it('merges adjacent lines across the newline', () => {
    expect(lineRanges(src, [1, 2])).toEqual([{ start: 0, end: 6 }]);
  });

  it('keeps non-adjacent lines separate and sorts/dedupes input', () => {
    expect(lineRanges(src, [4, 1, 1])).toEqual([
      { start: 0, end: 2 },
      { start: 8, end: 10 },
    ]);
  });

  it('gives an empty line a zero-length range', () => {
    expect(lineRanges(src, [3])).toEqual([{ start: 7, end: 7 }]);
  });

  it('excludes \\r of CRLF line endings', () => {
    expect(lineRanges('ab\r\ncd\r\n', [1, 2])).toEqual([{ start: 0, end: 6 }]);
  });

  it('ignores out-of-range line numbers', () => {
    expect(lineRanges(src, [0, 99])).toEqual([]);
  });
});

describe('renameMap', () => {
  it('maps old -> new for renames only', () => {
    const files: FileDiff[] = [
      { oldPath: 'a.ts', newPath: 'b.ts', hunks: [], binary: false },
      { oldPath: 'c.ts', newPath: 'c.ts', hunks: [], binary: false },
      { oldPath: null, newPath: 'd.ts', hunks: [], binary: false },
      { oldPath: 'e.ts', newPath: null, hunks: [], binary: false },
    ];
    expect(renameMap(files)).toEqual(new Map([['a.ts', 'b.ts']]));
  });
});

describe('selectMutants', () => {
  const m = (file: string, range: Range, scope: Range) => ({ file, range, scope: { range: scope } });
  const fn: Range = { start: 0, end: 100 };
  const changed = new Map<string, Range[]>([['x.ts', [{ start: 10, end: 20 }]]]);

  it('node mode keeps mutants intersecting a changed range (half-open)', () => {
    const inside = m('x.ts', { start: 15, end: 16 }, fn);
    const overlapping = m('x.ts', { start: 5, end: 11 }, fn);
    const touchingBefore = m('x.ts', { start: 5, end: 10 }, fn);
    const touchingAfter = m('x.ts', { start: 20, end: 25 }, fn);
    expect(selectMutants([inside, overlapping, touchingBefore, touchingAfter], changed, 'node')).toEqual([
      inside,
      overlapping,
    ]);
  });

  it('node mode ignores mutants of other files', () => {
    expect(selectMutants([m('y.ts', { start: 15, end: 16 }, fn)], changed, 'node')).toEqual([]);
  });

  it('zero-length changed range counts when within [start, end] of the mutant', () => {
    const point = new Map([['x.ts', [{ start: 10, end: 10 }]]]);
    const atEnd = m('x.ts', { start: 5, end: 10 }, fn);
    const atStart = m('x.ts', { start: 10, end: 12 }, fn);
    const outside = m('x.ts', { start: 11, end: 12 }, fn);
    expect(selectMutants([atEnd, atStart, outside], point, 'node')).toEqual([atEnd, atStart]);
  });

  it('scope mode selects every mutant whose enclosing scope intersects (signature change)', () => {
    const sig = new Map([['x.ts', [{ start: 0, end: 5 }]]]);
    const a = m('x.ts', { start: 50, end: 51 }, fn);
    const b = m('x.ts', { start: 150, end: 151 }, { start: 120, end: 200 });
    expect(selectMutants([a, b], sig, 'node')).toEqual([]);
    expect(selectMutants([a, b], sig, 'scope')).toEqual([a]);
  });
});
