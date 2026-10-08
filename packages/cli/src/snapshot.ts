import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import type { MutantResult, RunSnapshot } from '@mizchi/mutator-core';

// Result paths are stored relative to the project root so a snapshot can be
// restored in another checkout (e.g. a CI cache).
const mapFiles = <T extends RunSnapshot>(snapshot: T, f: (file: string) => string): T => ({
  ...snapshot,
  results: snapshot.results.map((r: MutantResult) => ({ ...r, file: f(r.file) })),
});

export function readSnapshot(path: string, root: string): RunSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as RunSnapshot;
    if (!Array.isArray(data.results) || !Array.isArray(data.tests)) return undefined;
    return mapFiles(data, (file) => (isAbsolute(file) ? file : join(root, file)));
  } catch {
    return undefined;
  }
}

export function writeSnapshot(path: string, snapshot: RunSnapshot, root: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(mapFiles(snapshot, (file) => relative(root, file)))}\n`);
}
