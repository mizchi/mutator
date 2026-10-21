import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { detectRunner } from '../src/runner.ts';

// Inside the workspace: `vitest` resolves from the root node_modules, `jest` does not.
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
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

// pnpm's bin shims (vitest's own included) put the hoisted store on NODE_PATH, so every runner
// resolves from anywhere. Outside the workspace and without it, only what the project installs
// resolves: Node reads NODE_PATH again on `_initPaths`.
function withoutNodePath<T>(fn: () => T): T {
  const saved = process.env.NODE_PATH;
  const initPaths = () => (Module as unknown as { _initPaths(): void })._initPaths();
  delete process.env.NODE_PATH;
  initPaths();
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.NODE_PATH = saved;
    initPaths();
  }
}

/** A project outside the workspace that installs just these packages. */
function installing(...names: string[]): string {
  return project(
    Object.fromEntries(names.map((name) => [`node_modules/${name}/package.json`, JSON.stringify({ name, exports: { './package.json': './package.json' } })])),
    tmpdir(),
  );
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

  test('without configs, vite-plus (which bundles vitest) selects vitest', () => {
    expect(withoutNodePath(() => detectRunner(installing('vite-plus')))).toBe('vitest');
  });

  test('without configs, an installed jest or @playwright/test selects that runner', () => {
    expect(withoutNodePath(() => detectRunner(installing('jest')))).toBe('jest');
    expect(withoutNodePath(() => detectRunner(installing('@playwright/test')))).toBe('playwright');
  });

  test('without configs or an installed runner, detection fails naming the root', () => {
    const root = installing();
    expect(() => withoutNodePath(() => detectRunner(root))).toThrow(`no test runner found: none of vitest (or vite-plus), jest or @playwright/test resolves from ${root}`);
  });
});
