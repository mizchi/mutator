import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginError, defineIgnorer, defineMutator, definePlugin } from '@mizchi/mutator-core';
import { afterEach, describe, expect, test } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { type PluginSpec, loadPlugins } from '../src/plugins.ts';
import { runMutation } from '../src/run.ts';

const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const core = fileURLToPath(new URL('../../core/src/index.ts', import.meta.url));
const roots: string[] = [];

const PLUGIN = `import { defineMutator, definePlugin } from ${JSON.stringify(core)};
export default definePlugin({
  name: 'fallbacks',
  mutators: [
    defineMutator({
      name: 'DropFallback',
      visit(node, ctx) {
        if (node.type === 'LogicalExpression' && node.operator === '??') return [{ replacement: ctx.text(node.left) }];
      },
    }),
  ],
  aridCallees: ['metrics.*'],
});
`;

function project(files: Record<string, string>): string {
  const root = join(tmpRoot, `plugins-${process.pid}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const all: Record<string, string> = {
    'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n",
    'src/a.ts': 'declare const metrics: { count(n: number): void };\nexport function port(env?: string): string {\n  return env ?? "8080";\n}\nexport function track(n: number): void {\n  metrics.count(n + 1);\n}\n',
    'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { port } from '../src/a.ts';\ntest('port', () => { expect(port()).toBe('8080'); });\n",
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('plugins', { timeout: 60_000 }, () => {
  const dropFallback = (r: Awaited<ReturnType<typeof runMutation>>) => r.entries.find((e) => e.mutant.mutator === 'DropFallback');

  test('without plugins only built-in mutators run', async () => {
    const report = await runMutation({ root: project({}), concurrency: 1 });
    expect(dropFallback(report)).toBeUndefined();
  });

  test('a local plugin file adds mutators and arid callees', async () => {
    const root = project({ 'mutators/fallbacks.ts': PLUGIN });
    const report = await runMutation({ root, concurrency: 1, plugins: ['./mutators/fallbacks.ts'] });
    expect(dropFallback(report)).toMatchObject({ status: 'Killed', mutant: { original: 'env ?? "8080"', replacement: 'env' } });
    expect(report.entries.find((e) => e.mutant.original === 'n + 1')!.status).toBe('Ignored');
  });

  test('a plugin from node_modules resolves like a package', async () => {
    const root = project({
      'node_modules/mutator-plugin-fallbacks/package.json': JSON.stringify({ name: 'mutator-plugin-fallbacks', type: 'module', exports: './index.js' }),
      'node_modules/mutator-plugin-fallbacks/index.js': PLUGIN,
    });
    const report = await runMutation({ root, concurrency: 1, plugins: ['mutator-plugin-fallbacks'] });
    expect(dropFallback(report)).toBeDefined();
  });

  test('editing a plugin invalidates cached results', async () => {
    const root = project({ 'mutators/fallbacks.ts': PLUGIN });
    await runMutation({ root, concurrency: 1, plugins: ['./mutators/fallbacks.ts'] });
    const file = join(root, 'mutators/fallbacks.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace('ctx.text(node.left)', 'ctx.text(node.right)'));
    const report = await runMutation({ root, concurrency: 1, plugins: ['./mutators/fallbacks.ts'] });
    expect(dropFallback(report)).toMatchObject({ source: 'run', mutant: { replacement: '"8080"' } });
  });

  test('excludedMutators removes built-in and custom mutators by name', async () => {
    const root = project({ 'mutators/fallbacks.ts': PLUGIN });
    const report = await runMutation({ root, concurrency: 1, plugins: ['./mutators/fallbacks.ts'], excludedMutators: ['DropFallback', 'StringLiteral'] });
    expect(report.entries.some((e) => e.mutant.mutator === 'DropFallback' || e.mutant.mutator === 'StringLiteral')).toBe(false);
  });

  test('ignorers from a plugin (or a bare ignorer export) skip whole subtrees', async () => {
    const ignorer = `import { defineIgnorer } from ${JSON.stringify(core)};
export default defineIgnorer({
  name: 'no-env',
  shouldIgnore(node) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === 'port') return 'environment defaults';
  },
});
`;
    const root = project({ 'mutators/no-env.ts': ignorer });
    const report = await runMutation({ root, concurrency: 1, plugins: ['./mutators/no-env.ts'] });
    const inPort = report.entries.filter((e) => e.mutant.scope.id === 'port');
    expect(inPort.length).toBeGreaterThan(0);
    expect(inPort.every((e) => e.status === 'Ignored')).toBe(true);
    expect(report.executed).toBe(0);
  });

  test('a plugin module that exports nothing usable is a config error that says what is missing', async () => {
    const misnamed = `import { defineMutator } from ${JSON.stringify(core)};\nexport default defineMutator({ name: 'Drop', mutate() { return []; } });\n`;
    const root = project({ 'mutators/misnamed.ts': misnamed, 'mutators/nameless.ts': 'export default { mutators: [] };\n' });
    const misnamedRun = runMutation({ root, concurrency: 1, plugins: ['./mutators/misnamed.ts'] });
    await expect(misnamedRun).rejects.toThrow(ConfigError);
    await expect(misnamedRun).rejects.toThrow('plugin ./mutators/misnamed.ts: Drop has no visit (a mutator), shouldIgnore (an ignorer), or mutators / ignorers / aridCallees (a plugin)');
    await expect(runMutation({ root, concurrency: 1, plugins: ['no-such-mutator-plugin'] })).rejects.toThrow(new ConfigError(`plugin no-such-mutator-plugin: cannot resolve it from ${root}`));
    await expect(runMutation({ root, concurrency: 1, plugins: ['./mutators/nameless.ts'] })).rejects.toThrow(
      'plugin ./mutators/nameless.ts: expected a plugin, a mutator, an ignorer or an array of them as the default export, each with a name',
    );
  });
});

describe('loadPlugins', () => {
  const drop = defineMutator({ name: 'Drop', visit: () => undefined });
  const skip = defineIgnorer({ name: 'skip', shouldIgnore: () => undefined });

  test('plugin objects are used as they are, with no module for other processes', async () => {
    const loaded = await loadPlugins(tmpRoot, [definePlugin({ name: 'p', mutators: [drop], aridCallees: ['metrics.*'] }), skip]);
    expect(loaded).toMatchObject({ mutators: [drop], ignorers: [skip], aridCallees: ['metrics.*'], modules: [], hasObjects: true });
    expect((await loadPlugins(tmpRoot, [])).hasObjects).toBe(false);
  });

  test('an unusable plugin object is a config error naming it as an object, caused by the plugin error', async () => {
    const error = await loadPlugins(tmpRoot, [{ name: 'Drop' } as never]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('plugin object: Drop has no visit (a mutator), shouldIgnore (an ignorer), or mutators / ignorers / aridCallees (a plugin)');
    expect((error as Error).cause).toBeInstanceOf(PluginError);
    expect(((error as Error).cause as Error).message).toBe((error as Error).message);
  });

  test('a relative plugin path is read from the root, not resolved as a package', async () => {
    const root = project({});
    await expect(loadPlugins(root, ['./mutators/missing.ts'])).rejects.toThrow(join(root, 'mutators/missing.ts'));
  });

  test('the fingerprint of plugin objects changes with their code and arid callees', async () => {
    const print = async (...specs: PluginSpec[]) => (await loadPlugins(tmpRoot, specs)).fingerprint;
    const otherDrop = defineMutator({ name: 'Drop', visit: () => [] });
    const otherSkip = defineIgnorer({ name: 'skip', shouldIgnore: () => 'always' });
    expect(await print(drop)).toBe(await print(drop));
    expect(await print(drop)).not.toBe(await print(otherDrop));
    expect(await print(skip)).not.toBe(await print(otherSkip));
    expect(await print(definePlugin({ name: 'p', aridCallees: ['ab', 'c'] }))).not.toBe(await print(definePlugin({ name: 'p', aridCallees: ['a', 'bc'] })));
  });
});
