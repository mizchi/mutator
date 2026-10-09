import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
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
});

