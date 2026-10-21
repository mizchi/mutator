import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const core = fileURLToPath(new URL('../../core/src/index.ts', import.meta.url));
const MUTATOR = `import { defineMutator, definePlugin } from ${JSON.stringify(core)};
export default definePlugin({
  name: 'fallbacks',
  mutators: [defineMutator({ name: 'DropFallback', visit(node, ctx) { if (node.type === 'LogicalExpression' && node.operator === '??') return [{ replacement: ctx.text(node.left) }]; } })],
});
`;
const IGNORER = `import { defineIgnorer, definePlugin } from ${JSON.stringify(core)};
export default [definePlugin({ name: 'env', ignorers: [defineIgnorer({ name: 'no-port', shouldIgnore(node) { if (node.type === 'FunctionDeclaration' && node.id?.name === 'port') return 'env'; } })] })];
`;
// A logging call (arid) and a comparison (weak mutation) make those options change the output.
const SOURCE = 'export function port(env: string | undefined): string {\n  return env ?? "8080";\n}\nexport function host(env: string | undefined): string {\n  console.log(env + "!");\n  return env ?? "localhost";\n}\nexport const big = (n: number) => n > 10;\n';

test("plugin modules and instrument options reach the dev server, as the CLI's session applies them", async () => {
  const target = join(dir, 'src/a.ts');
  writeFileSync(join(dir, 'fallbacks.ts'), MUTATOR);
  writeFileSync(join(dir, 'ignorers.ts'), IGNORER);
  const settings: Settings = { root: dir, targets: [target], pluginModules: [join(dir, 'fallbacks.ts'), join(dir, 'ignorers.ts')], arid: false, excludedMutators: ['StringLiteral'], weak: false };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env[SETTINGS_ENV] = join(dir, 'settings.json');
  const out = await transform(mutatorVite(), SOURCE, target);
  const fallbacks = (await import(join(dir, 'fallbacks.ts'))).default;
  const ignorers = (await import(join(dir, 'ignorers.ts'))).default[0].ignorers;
  const expected = instrument(target, SOURCE, { identity: 'src/a.ts', arid: false, excludedMutators: ['StringLiteral'], weak: false, mutators: fallbacks.mutators, ignorers });
  expect(out?.code).toBe(expected.code);
  // Each option changes the output, so a setting the dev server dropped would show.
  const without = (drop: string) =>
    instrument(target, SOURCE, { identity: 'src/a.ts', arid: false, excludedMutators: ['StringLiteral'], weak: false, mutators: fallbacks.mutators, ignorers, [drop]: undefined }).code;
  for (const option of ['arid', 'excludedMutators', 'weak', 'mutators', 'ignorers']) expect(without(option), option).not.toBe(expected.code);
  // Both plugin modules took effect: the custom mutator adds mutants, the ignorer marks port()'s.
  expect(expected.mutants.filter((m) => m.mutator === 'DropFallback').map((m) => m.original)).toEqual(['env ?? "8080"', 'env ?? "localhost"']);
  expect(expected.mutants.filter((m) => m.ignored).map((m) => m.scope.id)).toEqual(expected.mutants.filter((m) => m.scope.id === 'port').map(() => 'port'));
  expect(expected.mutants.some((m) => m.ignored)).toBe(true);
});

test('a plugin module without a plugin, mutator or ignorer fails the transform', async () => {
  writeFileSync(join(dir, 'nothing.ts'), 'export default 42;\n');
  const settings: Settings = { root: dir, targets: [join(dir, 'src/a.ts')], pluginModules: [join(dir, 'nothing.ts')] };
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(settings));
  process.env[SETTINGS_ENV] = join(dir, 'settings.json');
  await expect(transform(mutatorVite(), SOURCE, join(dir, 'src/a.ts'))).rejects.toThrow(
    `plugin ${join(dir, 'nothing.ts')}: expected a plugin, a mutator, an ignorer or an array of them as the default export, each with a name`,
  );
});
