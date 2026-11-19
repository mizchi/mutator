import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { expect, test, vi } from 'vitest';
import { snapshotFiles } from '../src/snapshot-store.ts';
import { fixtureGit } from './fixture-git.ts';
import { changedFiles, gitEnvironment } from '../src/git.ts';

test('Git subprocesses use their cwd even when a hook exports repository paths', () => {
  const inherited = {
    GIT_DIR: 'hook/git', GIT_WORK_TREE: 'hook/tree', GIT_COMMON_DIR: 'hook/common',
    GIT_INDEX_FILE: 'hook/index', GIT_OBJECT_DIRECTORY: 'hook/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: 'hook/alternate', GIT_PREFIX: 'hook/',
    PATH: 'bin', GIT_AUTHOR_NAME: 'fixture', GIT_CONFIG_NOSYSTEM: '1',
  };
  expect(gitEnvironment(inherited)).toEqual({ PATH: 'bin', GIT_AUTHOR_NAME: 'fixture', GIT_CONFIG_NOSYSTEM: '1' });
  expect(inherited.GIT_DIR).toBe('hook/git');
});

test('fixtures, diff selection and shared cache all address the requested repository', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mutator-git-env-')));
  try {
    fixtureGit(root, 'init', '-q');
    fixtureGit(root, 'commit', '--allow-empty', '-qm', 'base');
    writeFileSync(join(root, 'local.txt'), 'untracked');
    // Read-only Git operations below must still see the fixture under a hook environment.
    vi.stubEnv('GIT_DIR', join(root, 'absent-git-dir'));
    vi.stubEnv('GIT_INDEX_FILE', join(root, 'absent-index'));
    expect(fixtureGit(root, 'rev-parse', '--is-inside-work-tree').trim()).toBe('true');
    expect(changedFiles(root, 'HEAD', { untracked: true })).toEqual(['local.txt']);
    const [snapshot] = snapshotFiles(root, { root, sharedCache: true }, 'env');
    expect(snapshot?.startsWith(join(root, '.git', 'mutator') + sep)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
