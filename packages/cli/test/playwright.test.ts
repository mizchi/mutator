import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { assignPort } from '../../playwright/test/port.ts';
import { runMutation } from '../src/run.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../../playwright/test/fixtures/app', import.meta.url));
// Inside packages/playwright, so the copy resolves @playwright/test, vite and the adapter.
const tmpRoot = fileURLToPath(new URL('../../playwright/.tmp', import.meta.url));

describe('runMutation with Playwright (E2E through a Vite dev server)', { timeout: 300_000 }, () => {
  let root: string;
  beforeEach(async () => {
    mkdirSync(tmpRoot, { recursive: true });
    root = join(tmpRoot, `cli-${process.pid}-${Math.random().toString(36).slice(2)}`);
    cpSync(fixture, root, { recursive: true });
    await assignPort(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('classifies mutants, then a second run reuses everything', async () => {
    // The app's vite.config.ts would make auto pick vitest.
    const first = await runMutation({ root, runner: 'playwright', concurrency: 2, typecheck: false });
    const status = (original: string, replacement: string) => first.entries.find((e) => e.mutant.original === original && e.mutant.replacement === replacement)?.status;
    expect(status('n + 1', 'n - 1')).toBe('Killed');
    expect(status('toUpperCase', 'toLowerCase')).toBe('Killed');
    expect(status('n >= 10', 'n > 10')).toBe('Survived');
    expect(status('x * 3', 'x / 3')).toBe('NoCoverage');
    expect(first.executed).toBeGreaterThan(0);

    const second = await runMutation({ root, runner: 'playwright', concurrency: 2, typecheck: false });
    expect(second.executed).toBe(0);
    expect(second.dryRunFiles).toEqual([]);
    expect(second.entries.map((e) => e.status)).toEqual(first.entries.map((e) => e.status));
  });

  test('a dev server port already in use is an error message with exit 1, not a crash', async () => {
    const port = Number(readFileSync(join(root, 'port'), 'utf8'));
    const other = createServer((_, res) => res.end('not mutator'));
    await new Promise<void>((done) => other.listen(port, 'localhost', done));
    try {
      // Not spawnSync: the server above must keep answering while mutator runs.
      const child = spawn(process.execPath, [cli, '--root', root, '--runner', 'playwright', '--no-typecheck'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      const status = await new Promise<number | null>((done) => child.on('close', done));
      expect(stderr).toContain(`mutator: http://localhost:${port} already answers; stop that server`);
      expect(stderr).not.toMatch(/\n\s+at /);
      expect(status).toBe(1);
    } finally {
      other.close();
    }
  });
});
