import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, test } from 'vitest';
import { resolveTestRuntime } from '../src/runtime.ts';
import { createSession } from '../src/session.ts';

const tmp = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function project(...packages: ('vitest' | 'vite-plus')[]): string {
  mkdirSync(tmp, { recursive: true });
  const root = mkdtempSync(join(tmp, 'test-runtime-'));
  roots.push(root);
  for (const name of packages) {
    const dir = join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    const exports = name === 'vite-plus'
      ? { './test/node': './node.js', './test': './test.js' }
      : { './node': './node.js', '.': './test.js' };
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports }));
    for (const file of ['node.js', 'test.js']) writeFileSync(join(dir, file), '');
  }
  return root;
}

/** A directory outside this repository, where neither runner resolves by walking up. */
function bare(): string {
  const root = mkdtempSync(join(tmpdir(), 'mutator-test-runtime-'));
  roots.push(root);
  return root;
}

test('resolves standalone Vitest and its setup API from the target project', () => {
  const root = project('vitest');
  expect(resolveTestRuntime(root)).toEqual({
    node: join(root, 'node_modules/vitest/node.js'),
    setup: 'vitest',
    importer: join(root, 'package.json'),
  });
});

test('accepts a project root relative to the working directory', () => {
  const root = project('vitest');
  expect(resolveTestRuntime(relative(process.cwd(), root)).node).toBe(join(root, 'node_modules/vitest/node.js'));
});

test('prefers Vite+ exports over another installed Vitest, as vp test does', () => {
  const root = project('vite-plus', 'vitest');
  expect(resolveTestRuntime(root)).toEqual({
    node: join(root, 'node_modules/vite-plus/node.js'),
    setup: 'vite-plus/test',
    importer: join(root, 'package.json'),
  });
});

test('ignores a Vite+ installation available only through NODE_PATH', () => {
  const root = project('vitest');
  const other = project('vite-plus');
  const runtime = new URL('../src/runtime.ts', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
    import { resolveTestRuntime } from ${JSON.stringify(runtime)};
    console.log(JSON.stringify(resolveTestRuntime(process.argv[1])));
  `, root], { encoding: 'utf8', env: { ...process.env, NODE_PATH: join(other, 'node_modules') } });
  expect(JSON.parse(output)).toEqual({ node: join(root, 'node_modules/vitest/node.js'), setup: 'vitest', importer: join(root, 'package.json') });
});

test('Vite+ does not need a directly resolvable vitest peer', () => {
  const root = project('vite-plus');
  // Fail loudly if resolution ever falls back to a different Vitest copy.
  const blocked = join(root, 'node_modules/vitest/package.json');
  mkdirSync(dirname(blocked), { recursive: true });
  writeFileSync(blocked, JSON.stringify({ name: 'vitest', exports: {} }));
  expect(resolveTestRuntime(root).node).toBe(join(root, 'node_modules/vite-plus/node.js'));
});

test('an unavailable Node API reports the target root', () => {
  const root = project('vite-plus', 'vitest');
  for (const name of ['vite-plus', 'vitest']) {
    writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, exports: {} }));
  }
  expect(() => resolveTestRuntime(root)).toThrow(`neither vite-plus/test/node nor vitest/node resolves from ${root}`);
});

test('a failing Vite+ import propagates instead of falling back to the adapter peer', async () => {
  const root = project('vite-plus', 'vitest');
  writeFileSync(join(root, 'node_modules/vite-plus/node.js'), "throw new Error('broken Vite+ runtime');");
  await expect(createSession({ root, include: () => false })).rejects.toThrow('broken Vite+ runtime');
});

test('falls back to the Vitest config directory when the toolchain is kept out of the root', () => {
  const root = bare();
  const runner = project('vitest');
  expect(resolveTestRuntime(root, join(runner, 'vitest.config.ts'))).toEqual({
    node: join(runner, 'node_modules/vitest/node.js'),
    setup: 'vitest',
    importer: join(runner, 'package.json'),
  });
});

test('a runner installed in the root wins over the config directory', () => {
  const root = project('vitest');
  const runner = project('vite-plus');
  expect(resolveTestRuntime(root, join(runner, 'vitest.config.ts'))).toEqual({
    node: join(root, 'node_modules/vitest/node.js'),
    setup: 'vitest',
    importer: join(root, 'package.json'),
  });
});

test('an unresolvable runner reports the root and the config directory', () => {
  const root = bare();
  const runner = bare();
  expect(() => resolveTestRuntime(root, join(runner, 'vitest.config.ts')))
    .toThrow(`neither vite-plus/test/node nor vitest/node resolves from ${root} or ${runner}`);
});
