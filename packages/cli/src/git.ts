import { execFileSync } from 'node:child_process';

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
  return runGit(root, ['diff', '--relative', '--no-prefix', '--no-ext-diff', '--no-color', '-M', '--unified=0', mergeBase(root, since), '--', '.']);
}

/** Paths relative to `root` that differ from `since` (optionally including untracked files). */
export function changedFiles(root: string, since: string, { untracked = false } = {}): string[] {
  const tracked = runGit(root, ['diff', '--name-only', '--relative', '-M', mergeBase(root, since), '--', '.']).split('\n');
  const others = untracked ? runGit(root, ['ls-files', '--others', '--exclude-standard', '--', '.']).split('\n') : [];
  return [...new Set([...tracked, ...others].filter(Boolean))];
}

function mergeBase(root: string, since: string): string {
  try {
    return runGit(root, ['merge-base', since, 'HEAD']).trim();
  } catch {
    return since;
  }
}
