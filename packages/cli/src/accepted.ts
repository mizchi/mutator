// Accepted survivors: mutants judged equivalent (or not worth a test), recorded by key in
// mutator.accepted.json instead of disable comments in the source. Keys do not depend on
// position, so an entry survives edits that move the code.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ConfigError } from './config.ts';
import type { ReportEntry } from './run.ts';
import { isUndetected } from './status.ts';

export const ACCEPTED_FILE = 'mutator.accepted.json';

interface AcceptedEntry {
  reason: string;
  /** Where the mutant was when it was accepted (informational). */
  where?: string;
}

/** The entries of the file, checked; empty when the file does not exist. */
function readEntries(file: string): [key: string, entry: AcceptedEntry][] {
  if (!existsSync(file)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ConfigError(`${file}: expected an object keyed by mutant key`);
  return Object.entries(data).map(([key, value]) => {
    if (typeof (value as Partial<AcceptedEntry> | null)?.reason !== 'string') throw new ConfigError(`${file}: ${key}: expected { "reason": string }`);
    return [key, value as AcceptedEntry];
  });
}

/** Mutant key -> reason; empty when the file does not exist. */
export function readAccepted(file: string): Map<string, string> {
  return new Map(readEntries(file).map(([key, entry]) => [key, entry.reason]));
}

const posix = (file: string) => file.replaceAll('\\', '/');

/**
 * Mutant key -> source file (relative to the root, `/`-separated) from the `where` that
 * `mutator accept` records. Entries without one, or with one that has no `file:line:col`, are left out.
 */
export function readAcceptedFiles(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, { where }] of readEntries(file)) {
    const source = typeof where === 'string' ? /^(.+?):\d+:\d+(?: |$)/.exec(where)?.[1] : undefined;
    if (source) out.set(key, posix(source));
  }
  return out;
}

/**
 * Whether a run can tell that the mutant of an accepted entry is gone. A run of some files
 * (`--include`) holds no mutant of the other files, so their entries are not judged; an entry is
 * judged when its file is in the run, no longer exists, or is not recorded.
 */
export function staleJudge({ fileOf, mutated, exists }: {
  /** Mutant key -> source file, as `readAcceptedFiles` gives it. */
  fileOf: ReadonlyMap<string, string>;
  /** Files (relative to the root) the run mutates. */
  mutated: Iterable<string>;
  exists: (file: string) => boolean;
}): (key: string) => boolean {
  const inRun = new Set([...mutated].map(posix));
  return (key) => {
    const file = fileOf.get(key);
    if (file === undefined) return true;
    const source = posix(file);
    return inRun.has(source) || !exists(source);
  };
}

/** Adds (or replaces) entries for `keys`, keeping the others; `where` describes each mutant when known. */
export function acceptMutants(file: string, keys: readonly string[], reason: string, where: ReadonlyMap<string, string> = new Map()): void {
  const data: Record<string, AcceptedEntry> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  for (const key of keys) {
    const at = where.get(key);
    data[key] = { reason, ...(at ? { where: at } : {}) };
  }
  const sorted = Object.fromEntries(Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(file, `${JSON.stringify(sorted, null, 2)}\n`);
}

/**
 * Accepted mutants that went undetected become `Ignored` (out of the score and the gate).
 * `killed`: accepted mutants some test detects now, whose entry can go. `stale`: entries whose
 * mutant no longer exists, among those the run can judge (`judged`, see `staleJudge`).
 */
export function applyAcceptance(entries: readonly ReportEntry[], accepted: ReadonlyMap<string, string>, judged: (key: string) => boolean = () => true): { entries: ReportEntry[]; killed: string[]; stale: string[] } {
  const killed: string[] = [];
  const out = entries.map((e) => {
    const reason = accepted.get(e.mutant.key);
    if (reason === undefined) return e;
    if (isUndetected(e.status)) return { ...e, status: 'Ignored' as const, accepted: reason };
    if (e.status === 'Killed' || e.status === 'Timeout' || e.status === 'RuntimeError') killed.push(e.mutant.key);
    return e;
  });
  const present = new Set(entries.map((e) => e.mutant.key));
  return { entries: out, killed, stale: [...accepted.keys()].filter((k) => !present.has(k) && judged(k)) };
}
