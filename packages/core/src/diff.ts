// Unified diff parsing and diff-scoped mutant selection. Pure: callers supply diff text and sources.
import type { Range } from './types.ts';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw lines with their ' ' / '+' / '-' prefix. "\ No newline" markers are dropped. */
  lines: string[];
}

export interface FileDiff {
  /** null = /dev/null */
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  binary: boolean;
}

export type SelectMode = 'node' | 'scope';

const DEV_NULL = '/dev/null';
const MNEMONIC_PREFIX = /^[abciwo]\//;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// ---- parsing ----------------------------------------------------------------

interface RawFile {
  header: [string, string] | null;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  binaryPaths: [string, string] | null;
  created: boolean;
  deleted: boolean;
  binary: boolean;
  hunks: DiffHunk[];
}

function emptyRaw(header: [string, string] | null): RawFile {
  return {
    header,
    minus: null,
    plus: null,
    renameFrom: null,
    renameTo: null,
    binaryPaths: null,
    created: false,
    deleted: false,
    binary: false,
    hunks: [],
  };
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const lines = text.split(/\r?\n/);
  const raws: RawFile[] = [];
  let cur: RawFile | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      cur = emptyRaw(splitGitHeader(line.slice('diff --git '.length)));
      raws.push(cur);
    } else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      if (!cur || cur.minus !== null || cur.hunks.length > 0) {
        cur = emptyRaw(null);
        raws.push(cur);
      }
      cur.minus = headerPath(line.slice(4));
      cur.plus = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    } else if (cur) {
      const hunk = HUNK_HEADER.exec(line);
      if (hunk) {
        i = readHunk(lines, i + 1, hunk, cur.hunks);
        continue;
      }
      readExtendedHeader(line, cur);
    }
    i++;
  }
  return raws.map(toFileDiff);
}

function readHunk(lines: string[], from: number, m: RegExpExecArray, out: DiffHunk[]): number {
  const hunk: DiffHunk = {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    lines: [],
  };
  out.push(hunk);
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let i = from;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('\\')) continue;
    if (oldLeft <= 0 && newLeft <= 0) break;
    if (line === '' && i === lines.length - 1) break;
    const kind = line === '' ? ' ' : line[0];
    if (kind === ' ') {
      oldLeft--;
      newLeft--;
      hunk.lines.push(line === '' ? ' ' : line);
    } else if (kind === '-') {
      oldLeft--;
      hunk.lines.push(line);
    } else if (kind === '+') {
      newLeft--;
      hunk.lines.push(line);
    } else {
      break;
    }
  }
  return i;
}

function readExtendedHeader(line: string, cur: RawFile): void {
  if (line.startsWith('rename from ')) cur.renameFrom = unquote(line.slice('rename from '.length));
  else if (line.startsWith('rename to ')) cur.renameTo = unquote(line.slice('rename to '.length));
  else if (line.startsWith('new file mode ')) cur.created = true;
  else if (line.startsWith('deleted file mode ')) cur.deleted = true;
  else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    cur.binary = true;
    const m = /^Binary files (.*) and (.*) differ$/.exec(line);
    if (m) cur.binaryPaths = [unquote(m[1]!), unquote(m[2]!)];
  }
}

function toFileDiff(raw: RawFile): FileDiff {
  let pair: [string, string] | null = null;
  let prefixed = false;
  if (raw.renameFrom !== null && raw.renameTo !== null) {
    pair = [raw.renameFrom, raw.renameTo];
  } else {
    const candidate =
      raw.minus !== null && raw.plus !== null ? ([raw.minus, raw.plus] as [string, string]) : (raw.binaryPaths ?? raw.header);
    if (candidate) {
      pair = candidate;
      prefixed = hasPrefixes(raw.header ?? candidate);
    }
  }
  const [oldRaw, newRaw] = pair ?? [DEV_NULL, DEV_NULL];
  const norm = (p: string) => (p === DEV_NULL ? null : prefixed ? p.replace(MNEMONIC_PREFIX, '') : p);
  return {
    oldPath: raw.created ? null : norm(oldRaw),
    newPath: raw.deleted ? null : norm(newRaw),
    hunks: raw.hunks,
    binary: raw.binary,
  };
}

/** Prefixes are stripped only when every non-/dev/null side carries one. */
function hasPrefixes([a, b]: [string, string]): boolean {
  const sides = [a, b].filter((p) => p !== DEV_NULL);
  return sides.length > 0 && sides.every((p) => MNEMONIC_PREFIX.test(p));
}

function headerPath(s: string): string {
  if (s.startsWith('"')) return unquote(s);
  const tab = s.indexOf('\t');
  return tab === -1 ? s : s.slice(0, tab);
}

/** Splits `a/x b/x`. Unquoted paths with spaces are resolved by assuming both sides name the same file. */
function splitGitHeader(rest: string): [string, string] | null {
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest);
    const second = rest.slice(end + 1).trimStart();
    return [unquote(rest.slice(0, end)), unquote(second)];
  }
  const quotedSecond = rest.indexOf(' "');
  if (quotedSecond !== -1) return [rest.slice(0, quotedSecond), unquote(rest.slice(quotedSecond + 1))];
  const spaces = [...rest.matchAll(/ /g)].map((m) => m.index);
  if (spaces.length === 1) return [rest.slice(0, spaces[0]), rest.slice(spaces[0]! + 1)];
  for (const s of spaces) {
    const a = rest.slice(0, s);
    const b = rest.slice(s + 1);
    if (a === b || (hasPrefixes([a, b]) && a.slice(2) === b.slice(2))) return [a, b];
  }
  return null;
}

function quotedEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i + 1;
  }
  return s.length;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Decodes git's C-style quoted path (octal escapes are UTF-8 bytes). Unquoted input is returned as is. */
function unquote(s: string): string {
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, quotedEnd(s) - 1);
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      bytes.push(...encoder.encode(c));
      continue;
    }
    const next = body[++i] ?? '';
    const octal = /^[0-7]{3}/.exec(body.slice(i));
    if (octal) {
      bytes.push(parseInt(octal[0], 8));
      i += 2;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ---- line analysis ----------------------------------------------------------

/** 1-based new-side line where the hunk's first line sits. A "+k,0" hunk lies after line k. */
function firstNewLine(h: DiffHunk): number {
  return h.newLines === 0 ? h.newStart + 1 : h.newStart;
}

/**
 * Mirrors cargo-mutants `affected_lines`: '+' lines are changed; a '-' marks the new-side line
 * before it, and the "after delete" flag is cleared only by the next context line, which is also marked.
 */
export function changedLines(file: FileDiff): number[] {
  const out = new Set<number>();
  for (const h of file.hunks) {
    let lineno = firstNewLine(h);
    let afterDelete = false;
    for (const line of h.lines) {
      const kind = line[0];
      if (kind === '-') {
        if (lineno - 1 >= 1) out.add(lineno - 1);
        afterDelete = true;
        continue;
      }
      if (kind === '+' || afterDelete) out.add(lineno);
      if (kind === ' ') afterDelete = false;
      lineno++;
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function verifyDiff(
  file: FileDiff,
  newSource: string,
): { ok: true } | { ok: false; line: number; expected: string; actual: string } {
  const sourceLines = newSource.split(/\r?\n/);
  for (const h of file.hunks) {
    let lineno = firstNewLine(h);
    for (const line of h.lines) {
      if (line[0] === '-') continue;
      const expected = line.slice(1);
      const actual = sourceLines[lineno - 1] ?? '';
      if (expected !== actual) return { ok: false, line: lineno, expected, actual };
      lineno++;
    }
  }
  return { ok: true };
}

export function lineRanges(source: string, lines: readonly number[]): Range[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  const lineEnd = (n: number) => {
    const next = starts[n];
    if (next === undefined) return source.length;
    return source[next - 2] === '\r' ? next - 2 : next - 1;
  };
  const wanted = [...new Set(lines)].filter((n) => n >= 1 && n <= starts.length).sort((a, b) => a - b);
  const out: Range[] = [];
  let prev = -1;
  for (const n of wanted) {
    const last = out.at(-1);
    if (last && n === prev + 1) last.end = lineEnd(n);
    else out.push({ start: starts[n - 1]!, end: lineEnd(n) });
    prev = n;
  }
  return out;
}

export function renameMap(files: readonly FileDiff[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    if (f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath) map.set(f.oldPath, f.newPath);
  }
  return map;
}

// ---- selection --------------------------------------------------------------

function intersects(a: Range, b: Range): boolean {
  if (a.start === a.end) return b.start <= a.start && a.start <= b.end;
  if (b.start === b.end) return a.start <= b.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

export function selectMutants<M extends { file: string; range: Range; scope: { range: Range } }>(
  mutants: readonly M[],
  changed: ReadonlyMap<string, readonly Range[]>,
  mode: SelectMode,
): M[] {
  return mutants.filter((m) => {
    const ranges = changed.get(m.file);
    if (!ranges) return false;
    const target = mode === 'scope' ? m.scope.range : m.range;
    return ranges.some((r) => intersects(r, target));
  });
}
