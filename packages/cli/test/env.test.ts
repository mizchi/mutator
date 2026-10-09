import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from 'vitest';
import { exposeProjectBin } from '../src/run.ts';

test('the project node_modules/.bin is prepended to PATH while running, then restored', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-bin-'));
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: ['/usr/bin', '/bin'].join(delimiter) };
  const restore = exposeProjectBin(root, env);
  expect(env.PATH!.split(delimiter)[0]).toBe(join(root, 'node_modules/.bin'));
  expect(exposeProjectBin(root, env)()).toBeUndefined(); // already present: no-op
  restore();
  expect(env.PATH).toBe(['/usr/bin', '/bin'].join(delimiter));
});
