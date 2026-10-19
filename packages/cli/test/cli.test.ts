import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('tests that run but reach no mutant are reported as a setup problem, not as missing tests', () => {
  const root = join(import.meta.dirname, '../../../.tmp', `cli-no-coverage-${process.pid}`);
  cpSync(join(import.meta.dirname, '../../vitest/test/fixtures/basic'), root, { recursive: true });
  // The tests import nothing from src/: as if the instrumentation never reached the code they run.
  rmSync(join(root, 'test'), { recursive: true, force: true });
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/other.test.ts'), "import { expect, test } from 'vitest';\ntest('other', () => { expect(1).toBe(1); });\n");
  try {
    const text = spawnSync(process.execPath, [cli, '--root', root, '--no-typecheck'], { encoding: 'utf8' });
    expect(text.stdout).toContain('warning: the tests ran but reached no mutant');
    const agent = spawnSync(process.execPath, [cli, '--root', root, '--no-typecheck', '--reporter', 'agent'], { encoding: 'utf8' });
    expect(JSON.parse(agent.stdout).warnings.map((w: { kind: string }) => w.kind)).toContain('noCoverage');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

/** Every process below `pid`, from `ps`. */
function descendantsOf(pid: number): number[] {
  const rows = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const out: number[] = [];
  const walk = (parent: number) => rows.filter(([, ppid]) => ppid === parent).forEach(([child]) => (out.push(child!), walk(child!)));
  walk(pid);
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test.each([
  ['SIGTERM', 143],
  ['SIGINT', 130],
] as const)('%s stops the run and the workers with it, also one stuck in a loop', async (signal, code) => {
  const root = join(import.meta.dirname, '../../../.tmp', `cli-signal-${signal}-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'vitest.config.ts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n");
  writeFileSync(join(root, 'src/three.ts'), 'export function three(): number {\n  return 1 + 2;\n}\n');
  // A loop in test code: no hit limit stops it, so under a mutant the worker spins until killed.
  writeFileSync(join(root, 'test/three.test.ts'), "import { expect, test } from 'vitest';\nimport { three } from '../src/three.ts';\ntest('three', () => {\n  const v = three();\n  let n = 0;\n  while (v !== 3) n++;\n  expect(n).toBe(0);\n});\n");
  try {
    const child = spawn(process.execPath, [cli, '--root', root, '--no-typecheck', '-j', '1'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const closed = new Promise<number | null>((done) => child.on('close', done));
    // Wait until a mutant run is stuck.
    for (let i = 0; i < 200 && !/to run/.test(stderr); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 2000));
    const workers = descendantsOf(child.pid!);
    expect(workers.length).toBeGreaterThan(0);
    child.kill(signal);
    expect(await closed).toBe(code);
    await expect.poll(() => workers.filter(alive), { timeout: 5000 }).toEqual([]);
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
