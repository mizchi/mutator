import { execFileSync } from 'node:child_process';
import { changedLines, parseUnifiedDiff } from './diff.ts';

// A Git hook exports paths for the invoking repository. Child commands here target the
// repository discovered from their own cwd, including linked worktrees and test fixtures.
const repositoryVariables = new Set([
  'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
  'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_NO_REPLACE_OBJECTS',
  'GIT_NAMESPACE', 'GIT_QUARANTINE_PATH', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
]);

export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !repositoryVariables.has(key.toUpperCase())));
}

export function runGit(root: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd: root, env: gitEnvironment(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Unified diff of the working tree against the merge base of `since` and HEAD. */
export function gitDiff(root: string, since: string): string {
  return runGit(root, ['diff', '--relative', '--src-prefix=a/', '--dst-prefix=b/', '--no-ext-diff', '--no-color', '-M', '--unified=0', mergeBase(root, since), '--', '.']);
}

/** Paths relative to `root` that differ from `since` (optionally including untracked files). */
export function changedFiles(root: string, since: string, { untracked = false } = {}): string[] {
  const tracked = runGit(root, ['diff', '--name-only', '--relative', '-M', mergeBase(root, since), '--', '.']).split('\n');
  const others = untracked ? runGit(root, ['ls-files', '--others', '--exclude-standard', '--', '.']).split('\n') : [];
  return [...new Set([...tracked, ...others].filter(Boolean))];
}

function mergeBase(root: string, since: string): string {
  if (!since || since.startsWith('-')) throw new Error('Expected a Git revision');
  try {
    return runGit(root, ['merge-base', since, 'HEAD']).trim();
  } catch {
    return since;
  }
}

/** Working-tree edits relative to root. null covers the whole file, including deleted paths. */
export function changesSince(root: string, since: string): Record<string, number[] | null> {
  const changes = new Map<string, number[] | null>();
  for (const file of parseUnifiedDiff(gitDiff(root, since))) {
    if (file.oldPath && file.oldPath !== file.newPath) changes.set(file.oldPath, null);
    if (!file.newPath) continue;
    const whole = file.binary || file.oldPath !== file.newPath || file.hunks.some(h => h.newLines === 0 || h.oldLines > h.newLines);
    changes.set(file.newPath, whole ? null : changedLines(file));
  }
  for (const file of runGit(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']).split('\0')) {
    if (file) changes.set(file, null);
  }
  return Object.fromEntries(changes);
}
