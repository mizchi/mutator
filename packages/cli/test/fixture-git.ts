import { execFileSync } from 'node:child_process';

// Keep fixture setup independent of the production Git wrapper: the self-mutation
// suite may be actively mutating that wrapper while a test creates a repository.
const local = new Set(execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' }).trim().split(/\r?\n/));
local.add('GIT_NAMESPACE');
local.add('GIT_QUARANTINE_PATH');

export function fixtureGit(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !local.has(key.toUpperCase())));
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
    env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
}
