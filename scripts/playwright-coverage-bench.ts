// Compare existing mutant probes with optional V8 + source-map coverage.
// pkf run bench:playwright-coverage -- --samples 3 --case all
import { execFile, spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cpus } from 'node:os';
import { parseArgs, promisify } from 'node:util';
import { createPlaywrightSession } from '../packages/playwright/src/session.ts';
import { assignPort } from '../packages/playwright/test/port.ts';

const { values } = parseArgs({ options: {
  worker: { type: 'string' }, samples: { type: 'string', default: '3' },
  case: { type: 'string', default: 'all' }, output: { type: 'string', default: '.tmp/playwright-coverage-bench.json' },
  workers: { type: 'string', default: '1' },
} });
const configurations = {
  small: { modules: 8, functions: 8, tests: 8, iterations: 300 },
  medium: { modules: 64, functions: 16, tests: 24, iterations: 1000 },
  large: { modules: 128, functions: 32, tests: 32, iterations: 3000 },
};
type Workload = typeof configurations.small;
interface WorkerInput { root: string; targets: string[]; enabled: boolean; result: string }

async function worker(input: WorkerInput) {
  const session = await createPlaywrightSession({ root: input.root, targets: input.targets, sourceCoverage: input.enabled });
  try {
    const mutants = session.mutants().length;
    const start = performance.now();
    const dry = await session.dryRun();
    const dryRunMs = performance.now() - start;
    if (dry.failed.length) throw new Error(dry.failed.join('\n'));
    const sourceIndex = Object.fromEntries(dry.sourceCoverage ?? []);
    if (input.enabled && (dry.sourceCoverageIncomplete?.size || Object.keys(sourceIndex).some((key) => /#never\d+$/.test(key)))) throw new Error('incomplete or incorrectly attributed source coverage in benchmark');
    const sourceIndexBytes = Buffer.byteLength(JSON.stringify(sourceIndex));
    const base = { tests: dry.tests, coverage: Object.fromEntries(dry.coverage), deps: Object.fromEntries(dry.deps) };
    writeFileSync(input.result, JSON.stringify({
      dryRunMs, testMs: dry.tests.reduce((n, test) => n + test.durationMs, 0),
      tests: dry.tests.length, mutants, scopes: Object.keys(sourceIndex).length,
      sourceEdges: [...(dry.sourceCoverage?.values() ?? [])].reduce((n, ids) => n + ids.length, 0),
      incompleteTests: dry.sourceCoverageIncomplete?.size ?? 0,
      sourceIndexBytes: input.enabled ? sourceIndexBytes : 0,
      recordedBytes: Buffer.byteLength(JSON.stringify({ ...base, ...(input.enabled ? { sourceCoverage: sourceIndex, sourceCoverageIncomplete: [...(dry.sourceCoverageIncomplete ?? [])] } : {}) })),
    }));
  } finally { await session.close(); }
}

async function generate(root: string, workload: Workload, workers: number) {
  cpSync(new URL('../packages/playwright/test/fixtures/app', import.meta.url), root, { recursive: true });
  await assignPort(root);
  const config = join(root, 'playwright.config.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace('defineConfig({', `defineConfig({ workers: ${workers},`));
  rmSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'tests'));
  const targets: string[] = [];
  const imports: string[] = [];
  for (let module = 0; module < workload.modules; module++) {
    const name = `module-${module}.ts`;
    const file = join(root, 'src', name);
    // The second half stays uncalled, exposing accidental attribution of a
    // module's top-level execution to every function it contains.
    writeFileSync(file, Array.from({ length: workload.functions }, (_, i) => `export function work${i}(n: number) { return n + ${i + 1}; }\nexport function never${i}(n: number) { return n - ${i + 1}; }`).join('\n'));
    targets.push(file);
    imports.push(`import * as m${module} from './${name}';`);
  }
  writeFileSync(join(root, 'src/main.ts'), imports.join('\n') + `
const modules = [${Array.from({ length: workload.modules }, (_, i) => `m${i}`).join(',')}];
globalThis.work = (which, iterations) => {
  let total = 0;
  for (let i = 0; i < iterations; i++) for (const module of modules) total += module['work' + which](i);
  return total;
};
`);
  targets.push(join(root, 'src/main.ts'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><script type="module" src="/src/main.ts"></script>');
  for (let i = 0; i < workload.tests; i++) {
    writeFileSync(join(root, `tests/case-${i}.spec.ts`), `import { expect, test } from '@mizchi/mutator-playwright';
test('work ${i}', async ({ page }) => {
  await page.goto('/');
  const total = await page.evaluate(() => globalThis.work(${i % workload.functions}, ${workload.iterations}));
  expect(total).toBe(${workload.modules * (workload.iterations * (workload.iterations - 1) / 2 + workload.iterations * (i % workload.functions + 1))});
});\n`);
  }
  return targets;
}

const execute = promisify(execFile);
const cpuMs = (time: string) => {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time];
  return Number(days) * 86_400_000 + clock!.split(':').reverse().reduce((sum, part, index) => sum + Number(part) * 60 ** index * 1000, 0);
};

/** Sample just this trial's process tree, including Vite and Chromium. Summed
 * RSS counts shared pages more than once; CPU misses processes shorter than a
 * 200 ms sample. These are comparable estimates, not physical-memory totals. */
async function trial(input: WorkerInput) {
  const start = performance.now();
  const child = spawn(process.execPath, [import.meta.filename, '--worker', JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (data: Buffer) => { log += data.toString(); });
  child.stderr.on('data', (data: Buffer) => { log += data.toString(); });
  const closed = new Promise<number | null>((done, reject) => { child.on('close', done); child.on('error', reject); });
  const seen = new Set([child.pid!]);
  const cpu = new Map<number, number>();
  let peakTreeRssKiB = 0;
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss=,time=']);
      const rows = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/)).map(([pid, parent, rss, time]) => ({ pid: Number(pid), parent: Number(parent), rss: Number(rss), time: cpuMs(time!) }));
      // Discovery in repeated passes does not depend on ps's row order.
      let added = true;
      while (added) {
        added = false;
        for (const row of rows) if (seen.has(row.parent) && !seen.has(row.pid)) { seen.add(row.pid); added = true; }
      }
      let rss = 0;
      for (const row of rows) if (seen.has(row.pid)) {
        rss += row.rss;
        cpu.set(row.pid, Math.max(row.time, cpu.get(row.pid) ?? 0));
      }
      peakTreeRssKiB = Math.max(peakTreeRssKiB, rss);
    } finally { sampling = false; }
  };
  await sample();
  const interval = setInterval(() => { void sample().catch(() => {}); }, 200);
  let code: number | null;
  try { code = await closed; }
  finally { clearInterval(interval); }
  if (code !== 0) throw new Error(`benchmark worker exited ${code}\n${log}`);
  return { ...JSON.parse(readFileSync(input.result, 'utf8')), wallMs: performance.now() - start, sampledCpuMs: [...cpu.values()].reduce((a, b) => a + b, 0), peakTreeRssMiB: peakTreeRssKiB / 1024 };
}

if (values.worker) {
  await worker(JSON.parse(values.worker) as WorkerInput);
} else {
  const samples = Number(values.samples);
  const workers = Number(values.workers);
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer');
  if (!Number.isSafeInteger(workers) || workers < 1) throw new Error('--workers must be a positive integer');
  const selected = values.case === 'all' ? Object.entries(configurations) : Object.entries(configurations).filter(([name]) => name === values.case);
  if (!selected.length) throw new Error('--case must be small, medium, large, or all');
  const output = resolve(values.output);
  mkdirSync(dirname(output), { recursive: true });
  const temporary = resolve('packages/playwright/.tmp', `coverage-bench-${process.pid}`);
  mkdirSync(temporary, { recursive: true });
  const rows: object[] = [];
  try {
    for (const [name, workload] of selected) {
      const root = join(temporary, name);
      const targets = await generate(root, workload, workers);
      for (let sample = 0; sample < samples; sample++) {
        // Alternate ordering to reduce temperature/load drift between modes.
        for (const enabled of sample % 2 ? [true, false] : [false, true]) {
          const row = { name, workload, workers, sample, enabled, ...await trial({ root, targets, enabled, result: join(temporary, 'result.json') }) };
          rows.push(row);
          console.log(JSON.stringify(row));
          writeFileSync(output, JSON.stringify({ date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, rows }, null, 2) + '\n');
        }
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  console.error(`saved ${output}`);
}
