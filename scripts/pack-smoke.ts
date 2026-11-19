// Install the publishable tarballs outside the workspace and exercise each adapter.
// Run through `pnpm run pack-smoke` so npm_execpath identifies pnpm's real entrypoint
// (rather than launching a POSIX .bin shim or a Windows .cmd file).
import assert from 'node:assert/strict';
import { fixtureGit } from '../packages/cli/test/fixture-git.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
// Windows tmpdir() may contain an 8.3 alias such as RUNNER~1. Installing through
// that alias embeds it in pnpm's junctions and can load two copies of Vitest.
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'mutator pack-')));
const pack = join(work, 'pack');
mkdirSync(pack);
const packages = ['test-impact', 'core', 'vitest', 'jest', 'bun', 'playwright', 'typecheck', 'cli'];
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const manifest = (name: string) => json(join(repo, 'packages', name, 'package.json'));
const pnpm = process.env.npm_execpath;
assert(pnpm, 'Run this check with pnpm run pack-smoke');
const pnpmCommand = /\.[cm]?js$/.test(pnpm) ? process.execPath : pnpm;
const pnpmArgs = pnpmCommand === process.execPath ? [pnpm] : [];
const tarballs = new Map(packages.map((name) => {
  const { name: pkg, version } = manifest(name);
  const file = join(pack, `${pkg.replace('@', '').replace('/', '-')}-${version}.tgz`);
  // Forward slashes also work in Windows file: dependencies and YAML strings.
  return [pkg, `file:${file.replaceAll('\\', '/')}`];
}));

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, quiet = false, timeout = 300_000): string {
  try {
    const out = execFileSync(command, args, {
      cwd, env: { ...process.env, ...env }, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 8 * 1024 * 1024,
    });
    if (!quiet) process.stdout.write(out);
    return out;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    process.stdout.write(failure.stdout ?? '');
    process.stderr.write(failure.stderr ?? '');
    throw error;
  }
}

function install(cwd: string): void {
  console.log(`pack-smoke: installing ${cwd}`);
  run(pnpmCommand, [...pnpmArgs, 'install', '--prefer-offline'], cwd, {}, true);
}

function app(name: string, fixture: string, files: string[], dependencies: Record<string, string>, settings = ''): string {
  const cwd = join(work, name);
  mkdirSync(cwd);
  for (const file of files) cpSync(join(repo, fixture, file), join(cwd, file), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: `pack-smoke-${name}`, private: true, type: 'module', devDependencies: dependencies }, null, 2));
  const overrides = [...tarballs].filter(([name]) => name !== '@mizchi/mutator').map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join('\n');
  writeFileSync(join(cwd, 'pnpm-workspace.yaml'), `packages: []\noverrides:\n${overrides}\n${settings}`);
  install(cwd);
  return cwd;
}

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  const pkg = join(cwd, 'node_modules', '@mizchi', 'mutator');
  const entry = join(pkg, json(join(pkg, 'package.json')).bin.mutator);
  return run(process.execPath, [entry, ...args], cwd, { NODE_DEBUG: [process.env.NODE_DEBUG, 'mutator'].filter(Boolean).join(','), ...env });
}

function mutation(cwd: string, args: string[], survivor: string, env: NodeJS.ProcessEnv = {}): void {
  const out = cli(cwd, args, env);
  assert(out.includes(survivor), `Expected survivor: ${survivor}`);
  assert.match(out, /Killed [1-9]\d*/, 'At least one mutant must be detected, not just discovered');
}

function sameDirectory(actual: string, expected: string): void {
  assert.deepEqual(readdirSync(actual).sort(), readdirSync(expected).sort());
  for (const entry of readdirSync(expected, { withFileTypes: true })) {
    const a = join(actual, entry.name), b = join(expected, entry.name);
    if (entry.isDirectory()) sameDirectory(a, b);
    else assert.deepEqual(readFileSync(a), readFileSync(b), b);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done, fail) => server.close((error) => error ? fail(error) : done()));
  return port;
}

try {
  for (const name of packages) {
    console.log(`pack-smoke: packing ${name}`);
    run(pnpmCommand, [...pnpmArgs, 'pack', '--pack-destination', pack], join(repo, 'packages', name), {}, true);
  }
  const impact = app('impact', 'packages/cli/test/fixtures/multi', ['src', 'test'], {
    '@mizchi/test-impact': tarballs.get('@mizchi/test-impact')!,
  });
  // This consumer has no test runner, mutation packages or snapshot.
  writeFileSync(join(impact, 'test/a.test.ts'), "import '../src/a.ts';");
  writeFileSync(join(impact, 'test/b.test.ts'), "import '../src/b.ts';");
  writeFileSync(join(impact, '.gitignore'), 'node_modules/\n');
  fixtureGit(impact, 'init', '-q');
  fixtureGit(impact, 'add', '.');
  fixtureGit(impact, 'commit', '-qm', 'base');
  writeFileSync(join(impact, 'src/a.ts'), 'export function double(n: number) { return n + n }');
  const impactOutput = run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { selectAffectedTests, createSourceCoverageMapper } from '@mizchi/test-impact';
    assert.equal(typeof createSourceCoverageMapper, 'function');
    console.log(JSON.stringify((await selectAffectedTests({ root: '.', since: 'HEAD' })).files));
  `], impact, {}, true);
  assert.deepEqual(JSON.parse(impactOutput), ['test/a.test.ts']);
  const impactManifest = join(impact, 'node_modules/@mizchi/test-impact/package.json');
  const impactCli = join(impact, 'node_modules/@mizchi/test-impact', json(impactManifest).bin['test-impact']);
  assert.equal(run(process.execPath, [impactCli, '--since', 'HEAD'], impact, {}, true).trim(), 'test/a.test.ts');
  const mutator = tarballs.get('@mizchi/mutator')!;
  const basic = app('vitest', 'packages/vitest/test/fixtures/basic', ['src', 'test', 'vitest.config.ts'], { '@mizchi/mutator': mutator, vitest: json(join(repo, 'package.json')).devDependencies.vitest });
  mutation(basic, ['-j', '1'], 'age >= 18 -> age > 18');

  // Check what actually shipped, and that init-skill copies it faithfully and is idempotent.
  const installed = join(basic, 'node_modules', '@mizchi', 'mutator', 'skills');
  for (const skill of ['mutator/SKILL.md', 'mutator/references/config.md', 'mutation-test-loop/SKILL.md']) assert(readFileSync(join(installed, skill)).length > 0);
  cli(basic, ['init-skill']);
  for (const skill of ['mutator', 'mutation-test-loop']) sameDirectory(join(basic, '.claude', 'skills', skill), join(repo, 'packages', 'cli', 'skills', skill));
  assert(cli(basic, ['init-skill']).includes('mutator is up to date'));

  const vp = app('vite-plus', 'packages/vitest/test/fixtures/vite-plus', ['src', 'test', 'vite.config.ts'], {
    '@mizchi/mutator': mutator, 'vite-plus': json(join(repo, 'packages/vitest/test/fixtures/vite-plus/package.json')).devDependencies['vite-plus'],
  }, 'autoInstallPeers: false\nhoist: false\n');
  run(pnpmCommand, [...pnpmArgs, 'exec', 'vp', 'test'], vp);
  const vpOut = cli(vp, ['--shard', '1/1', '-j', '1']);
  assert(vpOut.includes('shard: 1/1'));
  assert(vpOut.includes('age >= 18 -> age > 18'));
  assert.match(vpOut, /Killed [1-9]\d*/);

  const allowBuilds = 'allowBuilds:\n  "@parcel/watcher": false\n  unrs-resolver: false\n';
  const jest = app('jest', 'packages/jest/test/fixtures/esm', ['src', '__tests__', 'jest.config.js'], {
    '@mizchi/mutator': mutator, jest: manifest('jest').devDependencies.jest,
  }, allowBuilds);
  mutation(jest, ['-j', '2'], 'age >= 18 -> age > 18');

  // bun test is a separate binary: CI installs it, a local run without it skips this adapter.
  if ((spawnSync('bun', ['--version']).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') console.log('pack-smoke: bun not found, skipping the Bun adapter');
  else {
    const bun = app('bun', 'packages/bun/test/fixtures/basic', ['src', 'test'], { '@mizchi/mutator': mutator }, allowBuilds);
    mutation(bun, ['--runner', 'bun', '-j', '2'], 'age >= 18 -> age > 18');
  }

  const pw = app('playwright', 'packages/playwright/test/fixtures/app', ['src', 'tests', 'index.html', 'other.html', 'vite.config.ts', 'playwright.config.ts'], {
    '@mizchi/mutator': mutator, '@mizchi/mutator-playwright': tarballs.get('@mizchi/mutator-playwright')!,
    '@playwright/test': manifest('playwright').devDependencies['@playwright/test'], vite: manifest('playwright').devDependencies.vite,
  }, allowBuilds);
  assert(readFileSync(join(pw, 'node_modules', '@mizchi', 'mutator-playwright', 'skills', 'mutator-playwright', 'SKILL.md')).length > 0);
  if (process.argv.includes('--install-browser')) {
    console.log('pack-smoke: installing Chromium');
    run(pnpmCommand, [...pnpmArgs, 'exec', 'playwright', 'install', '--with-deps', 'chromium'], pw, {}, false, 900_000);
  }
  writeFileSync(join(pw, 'mutator.config.mjs'), "export default { runner: 'playwright', playwrightSourceCoverage: true };\n");
  mutation(pw, ['--runner', 'playwright', '-j', '2'], 'n >= 10 -> n > 10', { MUTATOR_TEST_PORT: String(await freePort()) });
  const snapshot = json(join(pw, '.mutator', 'snapshot.json'));
  const slash = (id: string) => id.replaceAll('\\', '/');
  assert(Object.entries(snapshot.sourceCoverage).some(([scope, tests]) => slash(scope) === 'src/counter.ts#inc' && (tests as string[]).length > 0), 'Packed Playwright source coverage missing');
  assert(snapshot.sourceCoverageIncomplete.map(slash).includes('tests/app.spec.ts#navigates'), 'Packed incomplete coverage marker missing');
  console.log('pack-smoke: ok');
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
