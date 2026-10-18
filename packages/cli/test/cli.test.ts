import { spawn, spawnSync } from 'node:child_process';
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
  expect(stdout).toContain('simplify (code no test observes the removal of');
  expect(stdout).toContain('mutator select-tests --since <ref> [--format files|json]');
  expect(stdout).toContain('mutator init-skill [--dir <dir>] [--force]');
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

test('on GitHub Actions, --reporter agent keeps stdout pure JSON (no annotations)', () => {
  const root = join(import.meta.dirname, '../../../.tmp', `cli-agent-gha-${process.pid}`);
  cpSync(join(import.meta.dirname, '../../vitest/test/fixtures/basic'), root, { recursive: true });
  try {
    const { status, stdout, stderr } = spawnSync(process.execPath, [cli, '--root', root, '--reporter', 'agent'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' } });
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout).gaps.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

test('--reporter agent writes all of a large report to a pipe before exiting', async () => {
  const root = join(import.meta.dirname, '../../../.tmp', `cli-agent-pipe-${process.pid}`);
  cpSync(join(import.meta.dirname, '../../vitest/test/fixtures/basic'), root, { recursive: true });
  // Untested functions: hundreds of gaps, each with its source, far beyond a pipe's 64 KB buffer.
  writeFileSync(join(root, 'src/many.ts'), Array.from({ length: 300 }, (_, i) => `export function f${i}(x: number): number {\n  return x > ${i} ? x + ${i} : x - ${i};\n}\n`).join(''));
  try {
    const child = spawn(process.execPath, [cli, '--root', root, '--reporter', 'agent', '--no-typecheck'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const status = await new Promise<number | null>((done) => child.on('close', done));
    expect(status).toBe(0);
    expect(stdout.length).toBeGreaterThan(64 * 1024);
    expect(JSON.parse(stdout).gaps.filter((g: { file: string }) => g.file === 'src/many.ts').length).toBeGreaterThan(300);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

test('a reader that closes the pipe early (grep -q) does not crash the exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-cli-epipe-'));
  try {
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} init-skill --dir ${JSON.stringify(dir)}`;
    expect(spawnSync('sh', ['-c', command]).status).toBe(0);
    for (let i = 0; i < 5; i++) {
      const { stderr } = spawnSync('sh', ['-c', `${command} | grep -q 'is up to date'`], { encoding: 'utf8' });
      expect(stderr).not.toContain('EPIPE');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid config file exits 1 with the reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-cli-'));
  writeFileSync(join(root, 'mutator.config.json'), '{"concurency": 2}');
  const { status, stderr } = run('--root', root);
  expect(status).toBe(1);
  expect(stderr).toContain('mutator.config.json: unknown key "concurency"');
});
