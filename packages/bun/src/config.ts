// What the session needs from the project's Bun setup: the bunfig.toml (`[test]` root,
// preload and pathIgnorePatterns), and the test files `bun test` would collect. Bun has no
// list mode, so the files are found with Bun's own rules: `*.test.*`, `*_test.*`, `*.spec.*`
// and `*_spec.*` with a JavaScript / TypeScript extension, outside node_modules and hidden
// directories.
import { existsSync, globSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';

export interface Bunfig {
  /** The bunfig.toml in effect, if any (absolute). */
  path: string | undefined;
  /** `[test] root`: where Bun looks for test files (absolute). */
  testRoot: string | undefined;
  /** Preload modules, from `preload` and `[test] preload` (absolute). */
  preload: string[];
  /** `[test] pathIgnorePatterns`: globs of test files Bun leaves out, relative to the project root. */
  ignore: string[];
}

/** Reads the keys the session uses from bunfig.toml: an explicit file, else `<root>/bunfig.toml`. */
export function readBunfig(root: string, configFile?: string): Bunfig {
  const path = configFile ? resolve(root, configFile) : join(root, 'bunfig.toml');
  if (!existsSync(path)) {
    if (configFile) throw new Error(`mutator: bun config ${path} does not exist`);
    return { path: undefined, testRoot: undefined, preload: [], ignore: [] };
  }
  const values = tomlValues(readFileSync(path, 'utf8'));
  const base = dirname(path);
  const testRoot = values.get('test.root')?.[0];
  const preload = [...(values.get('preload') ?? []), ...(values.get('test.preload') ?? [])];
  return {
    path,
    testRoot: testRoot === undefined ? undefined : resolve(base, testRoot),
    // Package names (no leading `.` or `/`) are left out: they are not project files.
    preload: preload.filter((p) => /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(p)).map((p) => resolve(base, p)),
    ignore: values.get('test.pathIgnorePatterns') ?? [],
  };
}

/**
 * The string values of `key = "..."` and `key = ["...", ...]` entries, by `table.key` (top-level
 * keys without a table). Enough for the keys read here, not a TOML parser.
 */
export function tomlValues(text: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  let table = '';
  let pending: { key: string; text: string } | undefined;
  const strings = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[2] ?? decodeEscapes(m[1]!));
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (pending) {
      pending.text += ` ${line}`;
      if (line.includes(']')) {
        values.set(pending.key, strings(pending.text));
        pending = undefined;
      }
      continue;
    }
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      table = header[1]!;
      continue;
    }
    const entry = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = table ? `${table}.${entry[1]}` : entry[1]!;
    const value = entry[2]!;
    if (value.startsWith('[') && !value.includes(']')) pending = { key, text: value };
    else values.set(key, strings(value));
  }
  return values;
}

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/** A basic string's escapes decoded: TOML's \uXXXX, \UXXXXXXXX and \xXX too. An invalid one is kept as written. */
function decodeEscapes(s: string): string {
  return s.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|(.))/g, (escape, u?: string, U?: string, x?: string, c?: string) => {
    const hex = u ?? U ?? x;
    if (hex === undefined) return ESCAPES[c!] ?? escape;
    const code = Number.parseInt(hex, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : escape;
  });
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

const TEST_FILES = '**/*{.test,_test,.spec,_spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

/** The test files `bun test` collects under `dir` (absolute, sorted); `ignore` globs are relative to `root`. */
export function listTestFiles(dir: string, root = dir, ignore: readonly string[] = []): string[] {
  return globSync(TEST_FILES, { cwd: dir, exclude: ['**/node_modules/**', '**/.*/**'] })
    .map((file) => join(dir, file))
    .filter((file) => !ignore.some((pattern) => matchesGlob(relative(root, file), pattern)))
    .sort();
}
