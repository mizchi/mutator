import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { greet } from '../src/cli.ts';

test('greets in process', () => {
  expect(greet('a')).toBe('hello a');
});

test('greets through Bun.spawnSync', () => {
  const { stdout } = Bun.spawnSync([process.execPath, 'src/cli.ts', 'b']);
  expect(stdout.toString().trim()).toBe('hello b');
});

test('greets through child_process', () => {
  const { stdout } = spawnSync(process.execPath, ['src/cli.ts', 'c'], { encoding: 'utf8' });
  expect(stdout.trim()).toBe('hello c');
});
