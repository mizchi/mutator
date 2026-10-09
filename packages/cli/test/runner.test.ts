import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { detectRunner } from '../src/runner.ts';

// Inside the workspace: `vitest` resolves from the root node_modules, `jest` does not.
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));

function project(files: Record<string, string>): string {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 'runner-'));
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

  test('an explicit runner config file decides by its name', () => {
    expect(detectRunner(project({}), 'jest.unit.config.js')).toBe('jest');
    expect(detectRunner(project({}), 'vitest.unit.ts')).toBe('vitest');
  });

  test('without configs, the resolvable runner is used', () => {
    expect(detectRunner(project({}))).toBe('vitest');
  });
});
