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

/** Mutant key -> reason; empty when the file does not exist. */
export function readAccepted(file: string): Map<string, string> {
  if (!existsSync(file)) return new Map();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`${file}: ${(error as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ConfigError(`${file}: expected an object keyed by mutant key`);
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(data)) {
    const reason = (value as Partial<AcceptedEntry> | null)?.reason;
    if (typeof reason !== 'string') throw new ConfigError(`${file}: ${key}: expected { "reason": string }`);
    out.set(key, reason);
  }
  return out;
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
 * mutant no longer exists.
 */
export function applyAcceptance(entries: readonly ReportEntry[], accepted: ReadonlyMap<string, string>): { entries: ReportEntry[]; killed: string[]; stale: string[] } {
  const killed: string[] = [];
  const out = entries.map((e) => {
    const reason = accepted.get(e.mutant.key);
    if (reason === undefined) return e;
    if (isUndetected(e.status)) return { ...e, status: 'Ignored' as const, accepted: reason };
    if (e.status === 'Killed' || e.status === 'Timeout' || e.status === 'RuntimeError') killed.push(e.mutant.key);
    return e;
  });
  const present = new Set(entries.map((e) => e.mutant.key));
  return { entries: out, killed, stale: [...accepted.keys()].filter((k) => !present.has(k)) };
}
