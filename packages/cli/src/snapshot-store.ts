// Snapshot namespaces keep independent include scopes and worktree environments apart.
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '@mizchi/mutator-core';
import { runGit } from './git.ts';
import { ConfigError } from './config.ts';
import type { RunOptions } from './run.ts';
import { shardName } from './ci-shard.ts';
import { DEFAULT_INCLUDE } from './setup.ts';

/** Whether `include` / `exclude` select what the defaults select: the same globs, in any order. */
function isDefaultSelection(options: RunOptions): boolean {
  const include = [...new Set(options.include ?? DEFAULT_INCLUDE)].sort();
  return (options.exclude ?? []).length === 0 && include.length === DEFAULT_INCLUDE.length && include.every((glob, i) => glob === [...DEFAULT_INCLUDE].sort()[i]);
}

export function snapshotFiles(root: string, options: RunOptions, environment?: string): string[] {
  if (options.snapshotPath) return [options.snapshotPath];
  // Writing the default include out (in a config file, say) keeps the default scope and its cache.
  const selection = !isDefaultSelection(options)
    ? hash(JSON.stringify([[...new Set(options.include ?? [])].sort(), [...new Set(options.exclude ?? [])].sort()])) : 'snapshot';
  const scope = options.shard ? `${selection}-${shardName(options.shard)}` : selection;
  if (!options.sharedCache) {
    const path = join(root, '.mutator/scopes', `${scope}.json`);
    return scope === 'snapshot' ? [path, join(root, '.mutator/snapshot.json')] : [path];
  }
  let directory: string;
  try {
    const git = (...args: string[]) => runGit(root, ['rev-parse', ...args]).trim();
    const common = resolve(root, git('--path-format=absolute', '--git-common-dir'));
    directory = join(common, 'mutator', hash(git('--show-prefix')));
  } catch { throw new ConfigError('--shared-cache requires a Git repository'); }
  if (environment) return [join(directory, `${scope}-${environment}.json`)];
  try { return readdirSync(directory).filter((file) => file.startsWith(`${scope}-`) && file.endsWith('.json')).sort().map((file) => join(directory, file)); }
  catch { return []; }
}
