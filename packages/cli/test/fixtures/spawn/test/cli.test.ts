import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

test('greets', () => {
  expect(execFileSync('node', ['src/cli.js', 'x'], { cwd: root, encoding: 'utf8' })).toBe('hello x\n');
});
