// What Jest's processes are handed: the transformer settings the session serialises, the
// transformer instrumenting with them, and the runtime state the setup file installs.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { RUNTIME_GLOBAL, defineMutator, instrument } from '@mizchi/mutator-core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { transformerSettings } from '../src/config.ts';

const require = createRequire(import.meta.url);
const { createTransformer } = require('../src/transformer.cjs') as {
  createTransformer(config: unknown): Promise<{ process(source: string, file: string, options: unknown): { code: string } }>;
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mutator-jest-worker-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('the transformer settings carry every serialisable instrument option, and plugins only as modules', () => {
  const mutator = defineMutator({ name: 'Nothing', visit: () => undefined });
  const settings = transformerSettings({
    root: dir,
    targets: [join(dir, 'a.js')],
    pluginModules: [join(dir, 'plugin.js')],
    arid: false,
    excludedMutators: ['StringLiteral'],
    weak: false,
    mutators: [mutator],
  });
  expect(settings).toEqual({ root: dir, targets: [join(dir, 'a.js')], pluginModules: [join(dir, 'plugin.js')], arid: false, excludedMutators: ['StringLiteral'], weak: false });
  expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
});

const core = fileURLToPath(new URL('../../core/src/index.ts', import.meta.url));
const PLUGIN = `import { defineMutator, definePlugin } from ${JSON.stringify(core)};
export default definePlugin({
  name: 'fallbacks',
  mutators: [defineMutator({ name: 'DropFallback', visit(node, ctx) { if (node.type === 'LogicalExpression' && node.operator === '??') return [{ replacement: ctx.text(node.left) }]; } })],
});
`;
// A logging call (arid), a string (excluded) and a comparison (weak mutation) make each option change the output.
const SOURCE = 'export function host(env) {\n  console.log(env + "!");\n  return env ?? "localhost";\n}\nexport const big = (n) => n > 10;\n';

test("the transformer instruments targets with the session's options, as the session's own instrumentation does", async () => {
  const target = join(dir, 'src/a.js');
  writeFileSync(join(dir, 'fallbacks.mjs'), PLUGIN);
  const flags = { arid: false, excludedMutators: ['StringLiteral'], weak: false } as const;
  const transformer = await createTransformer({ ...transformerSettings({ root: dir, targets: [target], pluginModules: [join(dir, 'fallbacks.mjs')], ...flags }), inner: null });
  const out = transformer.process(SOURCE, target, {});
  const { mutators } = (await import(join(dir, 'fallbacks.mjs'))).default;
  const expected = instrument(target, SOURCE, { identity: 'src/a.js', ...flags, mutators });
  expect(out.code).toBe(expected.code);
  for (const drop of ['arid', 'excludedMutators', 'weak', 'mutators']) {
    expect(instrument(target, SOURCE, { identity: 'src/a.js', ...flags, mutators, [drop]: undefined }).code, drop).not.toBe(expected.code);
  }
  expect(transformer.process(SOURCE, join(dir, 'src/other.js'), {}).code).toBe(SOURCE);
});

test('the setup file installs the runtime state every adapter installs', () => {
  const context = vm.createContext({ process: { env: { MUTATOR_ACTIVE: 'k1', MUTATOR_HIT_LIMIT: '42' } } });
  vm.runInContext(readFileSync(fileURLToPath(new URL('../src/setup.cjs', import.meta.url)), 'utf8'), context);
  expect(context[RUNTIME_GLOBAL]).toEqual({
    active: 'k1',
    collect: false,
    modules: [],
    cov: { static: {}, perTest: {} },
    inf: { static: {}, perTest: {} },
    testId: null,
    hits: 0,
    hitLimit: 42,
  });
});
