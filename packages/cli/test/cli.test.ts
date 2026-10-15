import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { listMutants } from '../src/run.ts';

const cli = join(import.meta.dirname, '../src/cli.ts');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('--help documents config files and exit codes', () => {
  const { status, stdout } = run('--help');
  expect(status).toBe(0);
  expect(stdout).toContain('--config-file <file>');
  expect(stdout).toContain('--threshold-break <n>');
  expect(stdout).toContain('mutator select-tests --since <ref> [--format files|json]');
  expect(stdout).toMatch(/exit codes:\s+0 [^\n]+\n\s+1 [^\n]+\n\s+2 [^\n]+\n\s+4 /);
});

test('--version prints the package version', () => {
  const { status, stdout } = run('--version');
  expect(status).toBe(0);
  expect(stdout.trim()).toBe(JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).version);
});

test('accept records existing mutant keys with where they are, and rejects unknown ones', async () => {
  const root = join(import.meta.dirname, '../../../.tmp', `cli-accept-${process.pid}`);
  cpSync(join(import.meta.dirname, '../../vitest/test/fixtures/basic'), root, { recursive: true });
  try {
    const boundary = (await listMutants({ root })).find((m) => m.original === 'age >= 18' && m.replacement === 'age > 18')!;
    const { status, stderr } = run('accept', boundary.key, '--reason', 'equivalent', '--root', root);
    expect(status, stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'mutator.accepted.json'), 'utf8'))).toEqual({
      [boundary.key]: { reason: 'equivalent', where: 'src/math.ts:6:10 age >= 18 -> age > 18' },
    });
    const unknown = run('accept', 'nosuchkey', '--reason', 'x', '--root', root);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('accept: no mutant with key nosuchkey');
    expect(run('accept', boundary.key, '--root', root).status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('--only with a key no mutant has exits 1', () => {
  // Inside the workspace so the fixture resolves `vitest` from the root node_modules.
  const root = join(import.meta.dirname, '../../../.tmp', `cli-only-${process.pid}`);
  cpSync(join(import.meta.dirname, '../../vitest/test/fixtures/basic'), root, { recursive: true });
  try {
    const { status, stderr } = run('--root', root, '--only', 'nosuchkey');
    expect(status, stderr).toBe(1);
    expect(stderr).toContain('--only: no mutant with key nosuchkey');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('an invalid config file exits 1 with the reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-cli-'));
  writeFileSync(join(root, 'mutator.config.json'), '{"concurency": 2}');
  const { status, stderr } = run('--root', root);
  expect(status).toBe(1);
  expect(stderr).toContain('mutator.config.json: unknown key "concurency"');
});
