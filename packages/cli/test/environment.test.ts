import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { ENV_FILES, environmentHash } from '../src/reuse.ts';

const roots: string[] = [];
function workspace(marker = 'pnpm-workspace.yaml') {
  const repo = mkdtempSync(join(tmpdir(), 'mutator-env-'));
  roots.push(repo);
  const root = join(repo, 'packages/app');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(repo, marker), marker.endsWith('.json') ? JSON.stringify({ workspaces: ['packages/*'] }) : 'packages: [packages/*]\n');
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  };
  return { repo, root, write, fingerprint: () => environmentHash(root, 'settings', ENV_FILES) };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workspace environment', () => {
  test('a parent pnpm lockfile change invalidates a package snapshot', () => {
    const p = workspace();
    p.write('pnpm-lock.yaml', 'before');
    const before = p.fingerprint();
    p.write('pnpm-lock.yaml', 'after');
    expect(p.fingerprint()).not.toBe(before);
  });

  test('notices a newly created workspace lockfile', () => {
    const p = workspace();
    const before = p.fingerprint();
    p.write('pnpm-lock.yaml', 'new');
    expect(p.fingerprint()).not.toBe(before);
  });

  test('npm workspaces also include the root manifest and lockfile', () => {
    const p = workspace('package.json');
    const before = p.fingerprint();
    p.write('package-lock.json', 'new');
    expect(p.fingerprint()).not.toBe(before);
  });

  test('workspace configuration changes invalidate the snapshot', () => {
    const p = workspace();
    const before = p.fingerprint();
    p.write('pnpm-workspace.yaml', 'packages: [packages/*, tools/*]\n');
    expect(p.fingerprint()).not.toBe(before);
  });

  test('does not use a workspace beyond a nested repository boundary', () => {
    const p = workspace();
    p.write('packages/app/.git', 'gitdir: somewhere\n');
    const before = p.fingerprint();
    p.write('pnpm-lock.yaml', 'unrelated');
    expect(p.fingerprint()).toBe(before);
  });

  test('fingerprints stay portable between checkouts', () => {
    const a = workspace();
    const b = workspace();
    a.write('pnpm-lock.yaml', 'same');
    b.write('pnpm-lock.yaml', 'same');
    expect(a.fingerprint()).toBe(b.fingerprint());
  });
});
