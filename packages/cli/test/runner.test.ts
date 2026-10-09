import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { detectRunner } from '../src/runner.ts';

// Inside the workspace: `vitest` resolves from the root node_modules, `jest` does not.
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'runner-'));
  created.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe('detectRunner', () => {
  test('a vitest config selects vitest', () => {
    expect(detectRunner(project({ 'vitest.config.ts': '', 'jest.config.js': '' }))).toBe('vitest');
  });

  test('a jest config (file or package.json field) selects jest', () => {
    expect(detectRunner(project({ 'jest.config.mjs': '' }))).toBe('jest');
    expect(detectRunner(project({ 'package.json': JSON.stringify({ jest: {} }) }))).toBe('jest');
  });


  test('without configs, the resolvable runner is used', () => {
    expect(detectRunner(project({}))).toBe('vitest');
  });
});
