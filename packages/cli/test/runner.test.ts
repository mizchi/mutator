import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { detectRunner } from '../src/runner.ts';

// Inside the workspace: `vitest` resolves from the root node_modules, `jest` does not.
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const runnerModule = fileURLToPath(new URL('../src/runner.ts', import.meta.url));
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>, root = tmpRoot): string {
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'runner-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function detectIsolated(root: string): string {
  const { NODE_PATH: _, ...env } = process.env;
  const script = `import { detectRunner } from ${JSON.stringify(runnerModule)}; process.stdout.write(detectRunner(${JSON.stringify(root)}));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
  return result.stdout || result.stderr;
}

describe('detectRunner', () => {
  test('a vitest config selects vitest', () => {
    expect(detectRunner(project({ 'vitest.config.ts': '', 'jest.config.js': '' }))).toBe('vitest');
  });

  test('a jest config (file or package.json field) selects jest', () => {
    expect(detectRunner(project({ 'jest.config.mjs': '' }))).toBe('jest');
    expect(detectRunner(project({ 'package.json': JSON.stringify({ jest: {} }) }))).toBe('jest');
  });


  test('a playwright config selects playwright, unless a vitest or jest config is there too', () => {
    expect(detectRunner(project({ 'playwright.config.ts': '' }))).toBe('playwright');
    expect(detectRunner(project({ 'playwright.config.ts': '', 'vitest.config.ts': '' }))).toBe('vitest');
  });

  test('without configs, the resolvable runner is used', () => {
    expect(detectRunner(project({}))).toBe('vitest');
  });

  // Outside the workspace and without the NODE_PATH that pnpm's bin shims set (vitest's own
  // included), only what the project installs resolves.
  test('vite-plus, which bundles vitest, selects vitest', () => {
    const vitePlus = JSON.stringify({ name: 'vite-plus', exports: { './package.json': './package.json' } });
    expect(detectIsolated(project({ 'node_modules/vite-plus/package.json': vitePlus }, tmpdir()))).toBe('vitest');
  });
});
