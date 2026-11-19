import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, expect, test } from 'vitest';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
// Native realpath: tmpdir() is a symlink on macOS (/tmp) and an 8.3 short path on Windows runners.
const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mutator-installed-')));
afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const link = (target: string, path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path, 'junction');
};

// pnpm installs one Vitest per set of resolved optional peers. An installed adapter links only one
// of them as its own peer, while the project under test may resolve another copy.
test('an installed adapter runs a project whose Vitest is another copy than its own peer', { timeout: 60_000 }, () => {
  const peer = realpathSync.native(join(pkg, 'node_modules', 'vitest'));

  // The adapter as installed: compiled, under node_modules, with its own vitest peer.
  const adapter = join(base, 'adapter', 'node_modules', '@mizchi', 'mutator-vitest');
  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  execFileSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json'), '--outDir', join(adapter, 'dist'), '--declaration', 'false', '--sourceMap', 'false']);
  writeFileSync(join(adapter, 'package.json'), JSON.stringify({ name: '@mizchi/mutator-vitest', type: 'module', exports: { '.': './dist/index.js' } }));
  link(fileURLToPath(new URL('../../core', import.meta.url)), join(base, 'adapter', 'node_modules', '@mizchi', 'mutator-core'));
  link(peer, join(base, 'adapter', 'node_modules', 'vitest'));

  // Another copy of the same Vitest version, laid out like a pnpm peer variant.
  const variant = join(base, 'variant', 'node_modules');
  cpSync(peer, join(variant, 'vitest'), { recursive: true, filter: path => basename(path) !== 'node_modules' });
  const peerRequire = createRequire(join(peer, 'package.json'));
  const manifest = peerRequire('./package.json');
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    // Look up each package from the original peer, including hoisted packages and scoped junctions.
    const target = peerRequire.resolve.paths(name)?.map(dir => join(dir, name)).find(dir => existsSync(join(dir, 'package.json')));
    if (target) link(realpathSync.native(target), join(variant, name));
    else if (!manifest.peerDependenciesMeta?.[name]?.optional) throw new Error(`Missing Vitest fixture dependency: ${name}`);
  }

  const root = join(base, 'project');
  link(join(variant, 'vitest'), join(root, 'node_modules', 'vitest'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'project', private: true, type: 'module' }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src/a.ts'), 'export const a = (n: number) => n + 1;\n');
  writeFileSync(join(root, 'test/a.test.ts'), "import { expect, test } from 'vitest';\nimport { a } from '../src/a.ts';\ntest('a', () => expect(a(2)).toBe(3));\n");
  writeFileSync(join(root, 'vitest.config.ts'), "export default { test: { include: ['test/**/*.test.ts'] } };\n");

  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    const { createSession } = await import(${JSON.stringify(pathToFileURL(join(adapter, 'dist', 'index.js')).href)});
    const session = await createSession({ root: process.argv[1], include: (file) => file.includes('src') });
    try {
      const dry = await session.dryRun();
      const mutant = session.mutants().find((m) => m.original === 'n + 1');
      const tests = mutant && dry.coverage.get(mutant.key);
      const outcome = tests?.length && await session.runMutant(mutant.key, tests, { timeoutMs: 10_000 });
      console.log(JSON.stringify({ failed: dry.failed, tests: dry.tests.map((t) => t.id), status: outcome?.status }));
      // Vitest sets a failure exit code for the test that correctly kills the mutant.
      if (dry.failed.length === 0 && outcome?.status === 'Killed') process.exitCode = 0;
    } finally { await session.close(); }
  `, root], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(child.status, child.stderr).toBe(0);
  const result = child.stdout.trim().split('\n').at(-1);
  expect(result ? JSON.parse(result) : child.stderr).toEqual({ failed: [], tests: ['test/a.test.ts#a'], status: 'Killed' });
});
