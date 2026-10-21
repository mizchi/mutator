import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  PluginError,
  addPluginExport,
  defineIgnorer,
  defineMutator,
  definePlugin,
  emptyPluginParts,
  loadInstrumentFlags,
  loadPluginModules,
  portableFlags,
} from '../src/index.ts';

const core = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutator-plugins-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mutator = defineMutator({ name: 'Drop', visit: () => undefined });
const ignorer = defineIgnorer({ name: 'skip', shouldIgnore: () => undefined });

test('a plugin export may be a plugin, a mutator, an ignorer or an array of them', () => {
  const parts = emptyPluginParts();
  addPluginExport(parts, [definePlugin({ name: 'p', mutators: [mutator], ignorers: [ignorer], aridCallees: ['metrics.*'] }), mutator, ignorer], 'x');
  expect(parts).toEqual({ mutators: [mutator, mutator], ignorers: [ignorer, ignorer], aridCallees: ['metrics.*'] });
});

test('an export that is none of them says what is missing', () => {
  expect(() => addPluginExport(emptyPluginParts(), { name: 'Drop', mutate() {} }, './m.ts')).toThrow(
    new PluginError('plugin ./m.ts: Drop has no visit (a mutator), shouldIgnore (an ignorer), or mutators / ignorers / aridCallees (a plugin)'),
  );
  expect(() => addPluginExport(emptyPluginParts(), 42, './m.ts')).toThrow(
    new PluginError('plugin ./m.ts: expected a plugin, a mutator, an ignorer or an array of them as the default export, each with a name'),
  );
});

test('null and functions are not plugins, even with a visit, shouldIgnore or name', () => {
  const expected = new PluginError('plugin ./m.ts: expected a plugin, a mutator, an ignorer or an array of them as the default export, each with a name');
  const withVisit = Object.assign(function drop() {}, { visit: () => undefined });
  const withShouldIgnore = Object.assign(function skip() {}, { shouldIgnore: () => undefined });
  for (const value of [null, withVisit, withShouldIgnore, function named() {}]) {
    expect(() => addPluginExport(emptyPluginParts(), value, './m.ts')).toThrow(expected);
  }
});

test('a plugin without aridCallees adds none', () => {
  const parts = emptyPluginParts();
  addPluginExport(parts, definePlugin({ name: 'p', mutators: [mutator] }), 'x');
  expect(parts).toEqual({ mutators: [mutator], ignorers: [], aridCallees: [] });
});

test('plugin modules load from absolute paths, in order', async () => {
  writeFileSync(join(dir, 'a.mjs'), `import { defineMutator } from ${JSON.stringify(core)};\nexport default defineMutator({ name: 'A', visit() {} });\n`);
  writeFileSync(join(dir, 'b.mjs'), `import { defineIgnorer, definePlugin } from ${JSON.stringify(core)};\nexport default definePlugin({ name: 'b', ignorers: [defineIgnorer({ name: 'B', shouldIgnore() {} })] });\n`);
  const parts = await loadPluginModules([join(dir, 'b.mjs'), join(dir, 'a.mjs')]);
  expect([parts.mutators.map((m) => m.name), parts.ignorers.map((i) => i.name)]).toEqual([['A'], ['B']]);
});

test('portable flags drop what cannot cross a process; the runner side loads it back from the plugin modules', async () => {
  writeFileSync(join(dir, 'a.mjs'), `import { defineMutator } from ${JSON.stringify(core)};\nexport default defineMutator({ name: 'A', visit() {} });\n`);
  const portable = portableFlags({ arid: false, excludedMutators: ['StringLiteral'], weak: undefined, mutators: [mutator], ignorers: [ignorer] });
  expect(portable).toEqual({ arid: false, excludedMutators: ['StringLiteral'] });
  const flags = await loadInstrumentFlags({ ...portable, pluginModules: [join(dir, 'a.mjs')] });
  expect({ ...flags, mutators: flags.mutators?.map((m) => m.name) }).toEqual({ arid: false, excludedMutators: ['StringLiteral'], mutators: ['A'] });
  expect(await loadInstrumentFlags({ weak: false })).toEqual({ weak: false });
});
