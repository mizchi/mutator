import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunSnapshot } from '@mizchi/mutator-core';

export function readSnapshot(path: string): RunSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as RunSnapshot;
    return Array.isArray(data.results) && Array.isArray(data.tests) ? data : undefined;
  } catch {
    return undefined;
  }
}

export function writeSnapshot(path: string, snapshot: RunSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
}
