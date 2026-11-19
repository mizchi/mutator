import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, test } from 'vitest';
import { fixtureGit } from './fixture-git.ts';

test('watch recovers after a failing baseline and reports the working-tree diff on the next save', { timeout: 120_000 }, async () => {
  const parent = join(import.meta.dirname, '../../../.tmp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'watch-'));
  cpSync(join(import.meta.dirname, '../../vitest/test/fixtures/basic'), root, { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.mutator/\nnode_modules/\nignored-data/\n');
  fixtureGit(root, 'init', '-q');
  fixtureGit(root, 'add', '.');
  fixtureGit(root, 'commit', '-qm', 'base');

  mkdirSync(join(root, '.mutator'), { recursive: true });
  const source = join(root, 'src/watch.ts');
  const spec = join(root, 'test/watch.test.ts');
  writeFileSync(source, 'export const twice = (n: number) => n * 2;\n');
  const specBody = (expected: number) => `import { test, expect } from 'vitest'; import { twice } from '../src/watch.ts'; test('twice', () => expect(twice(2)).toBe(${expected}));\n`;
  // Hold the first baseline open so the edits below arrive during execution.
  writeFileSync(spec, `
    import { test, expect } from 'vitest';
    import { existsSync, writeFileSync } from 'node:fs';
    import { setTimeout as delay } from 'node:timers/promises';
    test('wait for the edit', async () => {
      writeFileSync(new URL('../.mutator/started', import.meta.url), '');
      while (!existsSync(new URL('../.mutator/continue', import.meta.url))) await delay(30);
      expect(2).toBe(5);
    }, 45_000);
  `);
  const child = spawn(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), '--root', root, '--watch', '--watch-throttle', '150', '-j', '1', '--no-typecheck', '--reporter', 'agent', '--reporter', 'json', '--report-dir', join(root, 'reports')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  const closed = new Promise<void>((done) => child.once('close', () => done()));
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 35_000;
    while (!condition()) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(stderr);
      await delay(50);
    }
  };
  const runs = () => (stderr.match(/watch: waiting for changes/g) ?? []).length;
  try {
    await until(() => existsSync(join(root, '.mutator/started')));
    writeFileSync(spec, specBody(3));
    writeFileSync(spec, specBody(4));
    // Let the throttled notification reach the supervisor before the first child exits.
    await delay(350);
    writeFileSync(join(root, '.mutator/continue'), '');
    await until(() => runs() >= 2);
    expect(stderr).toContain('watch: ready (throttle 150 ms)');
    expect(stderr).toContain('tests fail without mutants');
    const report = JSON.parse(stdout.trim());
    expect(report.scope).toBe('diff');
    expect(report.counts.Killed).toBeGreaterThan(0);
    mkdirSync(join(root, 'ignored-data'));
    writeFileSync(join(root, 'ignored-data', 'generated.ts'), '');
    await delay(450);
    expect(runs()).toBe(2);
    expect(stderr.match(/watch: running mutation tests/g)).toHaveLength(2);
    // A commit alone clears the HEAD diff. Both successful cycles produce one JSON line.
    fixtureGit(root, 'add', 'src/watch.ts', 'test/watch.test.ts');
    fixtureGit(root, 'commit', '-qm', 'cover twice');
    await until(() => runs() >= 3);
    const reports = stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(reports).toHaveLength(2);
    expect(reports[1].counts).toEqual({});
  } finally {
    child.kill('SIGTERM');
    await closed;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
