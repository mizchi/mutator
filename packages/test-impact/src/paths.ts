import { normalize, relative, sep } from 'node:path';

/** Stable relative keys for test IDs, mutant identities, snapshots and reports. */
export function relativePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/** Canonical key for a path supplied relative to the project root. */
export function normalizeRelativePath(file: string): string {
  return normalize(file).split(sep).join('/');
}
