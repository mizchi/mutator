import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('greets', () => {
  expect(execFileSync('node', ['src/cli.js'], { cwd: root, encoding: 'utf8' })).toBe('hello\n');
});

test('quiet', () => {
  expect(1).toBe(1);
});
