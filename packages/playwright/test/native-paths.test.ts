import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { instrument } from '@mizchi/mutator-core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { SETTINGS_ENV } from '../src/env.ts';
import { createProcessRunner } from '../src/runner.ts';
import { createSourceCoverageMapper } from '../src/source-coverage.ts';
import { acquireServers } from '../src/server.ts';
import { mutatorVite } from '../src/vite.ts';
import { freePort } from './port.ts';

let root: string;
const code = 'export function inc(n) {\n  return n + 1;\n}\ninc(1);\n';
beforeEach(() => {
  const parent = fileURLToPath(new URL('../.tmp', import.meta.url));
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(join(parent, 'native-paths-'));
});
afterEach(() => {
  delete process.env[SETTINGS_ENV];
  rmSync(root, { recursive: true, force: true });
});

test('Vite module ids match native targets with the same mutant identity as the CLI', async () => {
  const target = join(root, 'app.js');
  const settings = join(root, 'settings.json');
  writeFileSync(settings, JSON.stringify({ root, targets: [target], pluginModules: [] }));
  process.env[SETTINGS_ENV] = settings;
  const result = await mutatorVite().transform(code, target.replaceAll('\\', '/') + '?t=1');
  expect(result?.code).toBe(instrument(target, code, { identity: relative(root, target) }).code);
});

test.each(['absolute', 'file URL', 'Vite fs URL', 'Vite fs URL without extra slash'])('source coverage maps %s sources to native target paths', (kind) => {
  const target = join(root, 'app.js');
  writeFileSync(target, code);
  const name = kind === 'file URL' ? pathToFileURL(target).href
    : kind === 'Vite fs URL without extra slash' ? `http://localhost:4173/@fs/${target.replaceAll('\\', '/').replace(/^\//, '')}`
    : kind === 'Vite fs URL' ? `http://localhost:4173/@fs/${target.replaceAll('\\', '/')}`
    : target.replaceAll('\\', '/');
  const map = { version: 3, sources: [name], sourcesContent: [code], names: [], mappings: 'AAAA;AACA;AACA;AACA' };
  const script = {
    url: 'http://localhost:4173/app.js',
    source: code + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(JSON.stringify(map)).toString('base64'),
    functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }] }],
  };
  expect(createSourceCoverageMapper({ root, targets: [target] })([script])).toEqual({ complete: true, scopes: ['app.js#inc'] });
});

test('a native test location runs the requested Playwright test', { timeout: 30_000 }, async () => {
  cpSync(fileURLToPath(new URL('./fixtures/plain', import.meta.url)), root, { recursive: true });
  const runFile = join(root, 'run.json');
  const results = join(root, 'results.json');
  writeFileSync(runFile, JSON.stringify({ active: null, hitLimit: 1, results }));
  const cli = createRequire(join(root, 'package.json')).resolve('@playwright/test/cli');
  const runner = createProcessRunner({ cli, config: join(root, 'playwright.config.ts'), cwd: root, runFile, outputDir: join(root, 'test-results') });
  const outcome = await runner.run({ locations: [`${join(root, 'tests', 'plain.spec.ts')}:10`], projects: [], results, workers: 1 }, 20_000);
  expect(outcome.timedOut).toBe(false);
  expect(outcome.results?.tests.map((t) => [t.titles, t.outcome])).toEqual([[['passes'], 'expected']]);
});

test('releasing a dev server stops both the shell and its Node process', { timeout: 15_000 }, async () => {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const pidFile = join(root, 'server.pid');
  const script = join(root, 'serve.cjs');
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nrequire('node:http').createServer((q,s) => s.end('ok')).listen(${port});\n`);
  try {
    const release = await acquireServers(root, [{ command: `"${process.execPath}" "${script}"`, url }], { configDir: root, env: {} });
    await release();
    await expect.poll(async () => {
      try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); return true; }
      catch { return false; }
    }, { timeout: 2000 }).toBe(false);
  } finally {
    // Keep a failing cleanup implementation from leaking this test's server.
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
        else process.kill(pid, 'SIGKILL');
      } catch { /* already stopped */ }
    }
  }
});
