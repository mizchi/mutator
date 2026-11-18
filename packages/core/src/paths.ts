import { relative, sep } from 'node:path';

/** Stable relative keys for test IDs, mutant identities, snapshots and reports. */
export function relativePath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}
