import { execFileSync } from 'node:child_process';

const git = (root: string, args: readonly string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** Unified diff of the working tree against the merge base of `since` and HEAD. */
export function gitDiff(root: string, since: string): string {
  return git(root, ['diff', '--no-prefix', '--no-ext-diff', '--no-color', '-M', '--unified=0', mergeBase(root, since), '--', '.']);
}

/** Paths relative to `root` that differ from `since` (optionally including untracked files). */
export function changedFiles(root: string, since: string, { untracked = false } = {}): string[] {
  const tracked = git(root, ['diff', '--name-only', '--relative', '-M', mergeBase(root, since), '--', '.']).split('\n');
  const others = untracked ? git(root, ['ls-files', '--others', '--exclude-standard', '--', '.']).split('\n') : [];
  return [...new Set([...tracked, ...others].filter(Boolean))];
}

function mergeBase(root: string, since: string): string {
  try {
    return git(root, ['merge-base', since, 'HEAD']).trim();
  } catch {
    return since;
  }
}
