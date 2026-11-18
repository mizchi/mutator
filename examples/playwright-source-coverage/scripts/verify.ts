// Exercise the public CLIs in a disposable copy. The checked-in app is never edited.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, findPackageJSON } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const sample = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
mkdirSync(join(sample, '.tmp'), { recursive: true });
const directory = mkdtempSync(join(sample, '.tmp/verify-'));
const project = join(directory, 'project');
mkdirSync(project);

interface Metrics { collected: number; totalTestFiles: number; executed: number; reused: number }
interface Step { name: string; durationMs: number; metrics?: Metrics }
interface MutationReport { files: Record<string, { mutants: { id: string; status: string }[] }> }
interface Snapshot { sourceCoverage: Record<string, string[]>; sourceCoverageIncomplete: string[] }
const steps: Step[] = [];
const checks: string[] = [];
let succeeded = false;

const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(project, file), 'utf8')) as T;
const report = () => readJson<MutationReport>('.mutator/report/mutation.json');
const snapshot = () => readJson<Snapshot>('.mutator/snapshot.json');
const verdicts = (data: MutationReport) => Object.entries(data.files).flatMap(([file, info]) => info.mutants.map((mutant) => [`${file}#${mutant.id}`, mutant.status])).sort((a, b) => a[0]!.localeCompare(b[0]!));

function mutatorCli(): string {
  const manifest = findPackageJSON('@mizchi/mutator', import.meta.url);
  assert(manifest, 'install workspace dependencies first');
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: { mutator: string } };
  return resolve(dirname(manifest), pkg.bin.mutator);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
  return address.port;
}

async function verify() {
  for (const file of ['package.json', 'tsconfig.json', '.gitignore', 'index.html', 'vite.config.ts', 'playwright.config.ts', 'mutator.config.ts', 'src', 'e2e']) {
    cpSync(join(sample, file), join(project, file), { recursive: true });
  }
  const port = await freePort();
  const env = {
    ...process.env, CI: '1', PLAYWRIGHT_SAMPLE_PORT: String(port),
    GIT_AUTHOR_NAME: 'mutator sample', GIT_AUTHOR_EMAIL: 'sample@example.com',
    GIT_COMMITTER_NAME: 'mutator sample', GIT_COMMITTER_EMAIL: 'sample@example.com',
  };
  const command = async (name: string, executable: string, args: string[]) => {
    const start = performance.now();
    const child = spawn(executable, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const code = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    writeFileSync(join(directory, `${name}.stdout.log`), stdout);
    writeFileSync(join(directory, `${name}.stderr.log`), stderr);
    steps.push({ name, durationMs: Math.round(performance.now() - start) });
    assert.equal(code, 0, `${name} failed; logs: ${directory}\n${stderr.slice(-2500)}\n${stdout.slice(-2500)}`);
    return { stdout, stderr };
  };
  const cli = mutatorCli();
  const mutation = async (name: string) => {
    const { stdout, stderr } = await command(name, process.execPath, [cli]);
    const collected = stderr.match(/dry run: (\d+)\/(\d+) test files/);
    const executed = stdout.match(/executed (\d+), reused (\d+)/);
    assert(collected && executed, `missing run metrics in ${name}; see logs`);
    const metrics = { collected: Number(collected[1]), totalTestFiles: Number(collected[2]), executed: Number(executed[1]), reused: Number(executed[2]) };
    steps.at(-1)!.metrics = metrics;
    console.log(`${name}: ${metrics.collected}/${metrics.totalTestFiles} E2E files, executed ${metrics.executed}, reused ${metrics.reused}`);
    const result = report();
    assert(verdicts(result).length > 0, 'the example must have mutants');
    assert(verdicts(result).every(([, status]) => status === 'Killed'), `${name}: every example mutant should be killed`);
    return { metrics, result };
  };
  const pass = (message: string) => { checks.push(message); console.log(`ok: ${message}`); };

  await command('git-init', 'git', ['init', '-q', '-b', 'main']);
  await command('git-add', 'git', ['add', '.']);
  await command('git-baseline', 'git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'sample baseline']);
  const playwright = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const baseline = await command('ordinary-e2e', process.execPath, [playwright, 'test', '--reporter=json']);
  const stats = (JSON.parse(baseline.stdout) as { stats: { expected: number; unexpected: number } }).stats;
  assert.equal(stats.expected, 2);
  assert.equal(stats.unexpected, 0);
  pass('ordinary Playwright E2Es pass without a mutation run');

  const cold = await mutation('cold');
  assert.equal(cold.metrics.collected, 2);
  assert(cold.metrics.executed > 0);
  const initial = snapshot();
  const cartTest = 'e2e/cart.spec.ts#calculates the total';
  const profileTest = 'e2e/profile.spec.ts#formats the display name';
  assert.deepEqual(initial.sourceCoverage['src/cart.ts#calculateTotal'], [cartTest]);
  assert.deepEqual(initial.sourceCoverage['src/normalize-quantity.ts#normalizeQuantity'], [cartTest]);
  assert.deepEqual(initial.sourceCoverage['src/profile.ts#formatDisplayName'], [profileTest]);
  assert.deepEqual(initial.sourceCoverageIncomplete, []);
  assert.equal(cold.result.files['src/normalize-quantity.ts']?.mutants.length ?? 0, 0);
  pass('source maps associate each function with its E2E, including a function with no mutants');

  const warm = await mutation('warm');
  assert.equal(warm.metrics.collected, 0);
  assert.equal(warm.metrics.executed, 0);
  assert.equal(warm.metrics.reused, verdicts(cold.result).length);
  pass('an unchanged rerun reuses coverage and every mutation verdict');

  const helper = join(project, 'src/normalize-quantity.ts');
  const original = readFileSync(helper, 'utf8');
  const edited = original.replace('=> quantity;', '=> Number(quantity);');
  assert.notEqual(edited, original, 'expected helper edit marker');
  writeFileSync(helper, edited);
  const selected = await command('select-tests', process.execPath, [cli, 'select-tests', '--since', 'HEAD', '--format', 'json']);
  const selectedFiles = (JSON.parse(selected.stdout) as { files: string[] }).files;
  assert.deepEqual(selectedFiles, ['e2e/cart.spec.ts']);
  pass('editing the source-only helper selects cart.spec.ts, without running E2Es');

  const incremental = await mutation('incremental');
  assert.equal(incremental.metrics.collected, 1);
  assert(incremental.metrics.executed > 0, 'affected mutation verdicts must be re-tested');
  assert(incremental.metrics.reused > 0, 'the unrelated profile verdicts should be reused');
  assert.equal(incremental.result.files['src/normalize-quantity.ts']?.mutants.length ?? 0, 0);
  assert.deepEqual(snapshot().sourceCoverageIncomplete, []);
  pass('the incremental run re-collects one E2E and re-tests its affected mutants');

  const editedWarm = await mutation('edited-warm');
  assert.equal(editedWarm.metrics.collected, 0);
  assert.equal(editedWarm.metrics.executed, 0);
  pass('the edited snapshot is reusable on the following run');

  // This directory belongs to the disposable copy, never the checked-in sample.
  rmSync(join(project, '.mutator'), { recursive: true, force: true });
  const editedCold = await mutation('edited-cold');
  assert.equal(editedCold.metrics.collected, 2);
  assert.deepEqual(verdicts(incremental.result), verdicts(editedCold.result));
  pass('incremental verdicts match a fresh full run of the edited project');

  succeeded = true;
  return { ok: true, checks, selectedFiles, initialSourceCoverage: initial.sourceCoverage, steps };
}

try {
  const result = await verify();
  writeFileSync(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`verified ${checks.length} checks; results and logs: ${directory}`);
} catch (error) {
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ ok: false, checks, steps, error: String(error) }, null, 2) + '\n');
  console.error(`verification failed; disposable project retained: ${project}`);
  throw error;
} finally {
  if (succeeded && !values.keep) rmSync(project, { recursive: true, force: true });
}
