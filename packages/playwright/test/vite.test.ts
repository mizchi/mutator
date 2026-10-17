import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instrument } from '@mizchi/mutator-core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { SETTINGS_ENV, type Settings } from '../src/env.ts';
import { mutatorVite } from '../src/vite.ts';

const code = 'export function inc(n: number): number {\n  return n + 1;\n}\n';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutator-vite-'));
});
afterEach(() => {
  delete process.env[SETTINGS_ENV];
  rmSync(dir, { recursive: true, force: true });
});

const transform = async (plugin: ReturnType<typeof mutatorVite>, source: string, id: string) =>
  (plugin.transform as (code: string, id: string) => Promise<{ code: string } | undefined>).call({}, source, id);

test('without mutator the plugin leaves every module alone', async () => {
  expect(await transform(mutatorVite(), code, join(dir, 'src/a.ts'))).toBeUndefined();
});

test("under mutator it instruments the targets with the CLI's mutant keys, and nothing else", async () => {
  const target = join(dir, 'src/a.ts');
  const settings: Settings = { root: dir, targets: [target], pluginModules: [] };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env[SETTINGS_ENV] = join(dir, 'settings.json');
  const plugin = mutatorVite();
  const out = await transform(plugin, code, `${target}?t=1`);
  const expected = instrument(target, code, { identity: 'src/a.ts' });
  expect(out?.code).toBe(expected.code);
  expect(await transform(plugin, code, join(dir, 'src/other.ts'))).toBeUndefined();
});
