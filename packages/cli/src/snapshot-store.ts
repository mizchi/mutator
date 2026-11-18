// Snapshot namespaces keep independent include scopes and worktree environments apart.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '@mizchi/mutator-core';
import { ConfigError } from './config.ts';
import type { RunOptions } from './run.ts';
import { shardName } from './ci-shard.ts';

export function snapshotFiles(root: string, options: RunOptions, environment?: string): string[] {
  if (options.snapshotPath) return [options.snapshotPath];
  const selection = options.include !== undefined || options.exclude !== undefined
    ? hash(JSON.stringify([[...new Set(options.include ?? [])].sort(), [...new Set(options.exclude ?? [])].sort()])) : 'snapshot';
  const scope = options.shard ? `${selection}-${shardName(options.shard)}` : selection;
  if (!options.sharedCache) {
    const path = join(root, '.mutator/scopes', `${scope}.json`);
    return scope === 'snapshot' ? [path, join(root, '.mutator/snapshot.json')] : [path];
  }
  let directory: string;
  try {
    const git = (...args: string[]) => execFileSync('git', ['rev-parse', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const common = resolve(root, git('--path-format=absolute', '--git-common-dir'));
    directory = join(common, 'mutator', hash(git('--show-prefix')));
  } catch { throw new ConfigError('--shared-cache requires a Git repository'); }
  if (environment) return [join(directory, `${scope}-${environment}.json`)];
  try { return readdirSync(directory).filter((file) => file.startsWith(`${scope}-`) && file.endsWith('.json')).sort().map((file) => join(directory, file)); }
  catch { return []; }
}
