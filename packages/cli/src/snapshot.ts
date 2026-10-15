import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { MutantResult, MutantStatus, ResultReason, RunSnapshot } from '@mizchi/mutator-core';

// On disk, results are stored as rows referring to tables: test ids, files and
// scope ids repeat across thousands of mutants (a 141k-mutant project wrote a
// 333 MB snapshot as plain objects). File paths are relative to the project root
// so a snapshot can be restored in another checkout (e.g. a CI cache).

type Row = [key: string, file: number, scope: number, scopeHash: string, status: MutantStatus, killedBy: number[], coveredBy: number[], durationMs?: number | null, reason?: 1 | string];

interface Compact {
  format: 2;
  /** Test ids referenced by rows: current tests first, then ids of removed tests. */
  ids: string[];
  /** Files (relative) and scope ids referenced by rows. */
  strings: string[];
  rows: Row[];
}

export function readSnapshot(path: string, root: string): RunSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as RunSnapshot & Partial<Compact>;
    if (!Array.isArray(data.tests)) return undefined;
    const absolute = (file: string) => (isAbsolute(file) ? file : join(root, file));
    if (data.format === 2 && data.rows && data.ids && data.strings) {
      const { format: _format, rows, ids, strings, ...rest } = data;
      const results = rows.map(([key, file, scope, scopeHash, status, killedBy, coveredBy, durationMs, reason]): MutantResult => ({
        key,
        file: absolute(strings[file]!),
        scopeId: strings[scope]!,
        scopeHash,
        status,
        killedBy: killedBy.map((i) => ids[i]!),
        coveredBy: coveredBy.map((i) => ids[i]!),
        ...(durationMs !== undefined && durationMs !== null ? { durationMs } : {}),
        // 1: `notInfected`, the common case; other reasons are stored as text.
        ...(reason ? { reason: reason === 1 ? 'notInfected' : (reason as ResultReason) } : {}),
      }));
      return { ...rest, results } as RunSnapshot;
    }
    if (!Array.isArray(data.results)) return undefined;
    return { ...data, results: data.results.map((r) => ({ ...r, file: absolute(r.file) })) };
  } catch {
    return undefined;
  }
}

export function writeSnapshot(path: string, snapshot: RunSnapshot, root: string): void {
  const { results, ...rest } = snapshot;
  const ids = new Map(snapshot.tests.map((t, i) => [t.id, i]));
  const strings = new Map<string, number>();
  const id = (test: string) => ids.get(test) ?? (ids.set(test, ids.size), ids.size - 1);
  const str = (s: string) => strings.get(s) ?? (strings.set(s, strings.size), strings.size - 1);
  const rows = results.map((r): Row => {
    const row: Row = [r.key, str(relative(root, r.file)), str(r.scopeId), r.scopeHash, r.status, r.killedBy.map(id), r.coveredBy.map(id)];
    if (r.durationMs !== undefined || r.reason) row.push(r.durationMs !== undefined ? Math.round(r.durationMs * 10) / 10 : null);
    if (r.reason) row.push(r.reason === 'notInfected' ? 1 : r.reason);
    return row;
  });
  const compact: Compact = { format: 2, ids: [...ids.keys()], strings: [...strings.keys()], rows };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...rest, ...compact })}\n`);
}
