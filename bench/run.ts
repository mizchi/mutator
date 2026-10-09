// Benchmark harness: mutator vs StrykerJS on pinned real-world projects.
//
// usage: node bench/run.ts [--phase setup,ours,stryker,callgraph] [--reps 2] bench/projects/<name>.json...
//
// For every project spec it keeps two clones under .tmp/bench2/ (gitignored):
//   <name>          vitest 5 (what our tool runs against)
//   <name>-stryker  vitest 4 + Stryker 10 (Stryker's vitest-runner is broken on vitest 5)
// Separate clones also keep Stryker's .stryker-tmp sandboxes out of the clone our tool
// scans (Vitest would pick up the duplicated tests).
//
// Every timed command is preceded by a preflight: 1-minute load average < 3 and no busy
// node process; orphaned vitest/stryker workers (ppid 1) left by earlier bench runs are
// killed and logged. Results go to .tmp/bench2/results/<name>.json; `node bench/report.ts`
// turns them into the tables of docs/benchmark.md.
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface Edit {
  file: string;
  from: string;
  to: string;
  /** refactor: same behaviour; semantic: behaviour changes but the suite still passes */
  kind: 'refactor' | 'semantic';
  note: string;
}

export interface Spec {
  name: string;
  repo: string;
  commit: string;
  /** Globs relative to the project root; passed as --include to ours and as `mutate` to Stryker. */
  mutate: string[];
  install?: string;
  vitestOurs?: string;
  vitestStryker?: string;
  /** Edit used for the timed "after one edit" runs. */
  edit: Edit;
  /** Edits for bench/callgraph-experiment.ts (scripts/callgraph-experiment.ts + mutate globs). */
  callgraphEdits: Edit[];
}

export interface Counts {
  total: number;
  executed: number | null;
  reused: number | null;
  statuses: Record<string, number>;
  score: number;
}

export interface Measurement {
  tool: 'ours' | 'stryker';
  run: string;
  rep: number;
  wallMs: number;
  exitCode: number | null;
  counts: Counts | null;
  load: number;
  log: string;
}

const REPO = resolve(import.meta.dirname, '..');
const WORK = join(REPO, '.tmp', 'bench2');
const CLI = join(REPO, 'packages', 'cli', 'src', 'cli.ts');
const DETECTED = ['Killed', 'Timeout', 'RuntimeError', 'CompileError'];
const UNDETECTED = ['Survived', 'NoCoverage'];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    phase: { type: 'string', default: 'setup,ours,stryker,callgraph' },
    reps: { type: 'string', default: '2' },
  },
});
const phases = new Set(values.phase.split(','));
const reps = Number(values.reps);

function log(message: string): void {
  console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function sh(cmd: string, cwd: string, allowFail = false): SpawnSyncReturns<string> {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} (in ${cwd}) failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------- preflight ----------

interface Proc {
  pid: number;
  ppid: number;
  pcpu: number;
  args: string;
}

function processes(): Proc[] {
  const out = sh('ps -Ao pid=,ppid=,pcpu=,args=', REPO).stdout;
  return out
    .split('\n')
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pcpu: Number(m[3]), args: m[4]! }));
}

const preflightLog: string[] = [];

/** Waits for an idle machine; returns the 1-minute load average at start. */
function preflight(label: string): number {
  for (let attempt = 0; ; attempt++) {
    const procs = processes();
    const ours = procs.filter((p) => p.ppid === 1 && /node/.test(p.args) && /vitest|stryker|bench2|mutator/.test(p.args) && p.pid !== process.pid);
    for (const p of ours) {
      const note = `${label}: killed orphan pid=${p.pid} cpu=${p.pcpu} ${p.args.slice(0, 120)}`;
      log(note);
      preflightLog.push(note);
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {}
    }
    const busy = procs.filter((p) => p.pcpu > 20 && /node/.test(p.args) && p.pid !== process.pid && !ours.some((o) => o.pid === p.pid));
    const load = loadavg()[0]!;
    if (load < 3 && busy.length === 0) return load;
    if (attempt % 6 === 0) log(`${label}: waiting (load ${load.toFixed(2)}, busy node: ${busy.map((p) => `${p.pid}:${p.pcpu}% ${p.args.slice(0, 60)}`).join(' | ') || 'none'})`);
    sleep(10_000);
  }
}

// ---------- setup ----------

function applyEdit(dir: string, edit: Edit): () => void {
  const path = join(dir, edit.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(edit.from).length - 1;
  if (count !== 1) throw new Error(`${edit.file}: expected exactly one occurrence of ${JSON.stringify(edit.from)}, found ${count}`);
  writeFileSync(path, original.replace(edit.from, edit.to));
  return () => writeFileSync(path, original);
}

function setupClone(spec: Spec, variant: 'ours' | 'stryker'): string {
  const dir = join(WORK, variant === 'ours' ? spec.name : `${spec.name}-stryker`);
  if (existsSync(join(dir, '.bench-ready'))) return dir;
  rmSync(dir, { recursive: true, force: true });
  log(`${spec.name}: cloning ${variant} clone`);
  sh(`git clone -q ${spec.repo} ${dir}`, WORK);
  sh(`git checkout -q ${spec.commit} && git switch -q -c bench`, dir);

  // Standalone pnpm project (otherwise pnpm joins the mutator workspace) and a local
  // vitest config (otherwise Vitest walks up into mutator's own config).
  if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n# do not run dependency build scripts (esbuild etc. ship prebuilt binaries)\nstrictDepBuilds: false\n');
  const configs = readdirSync(dir).filter((f) => /^(vitest|vite)\.config\.(ts|mts|js|mjs|cjs)$/.test(f));
  if (configs.length === 0) writeFileSync(join(dir, 'vitest.config.mts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n");

  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  delete pkg.packageManager; // use the installed pnpm, not a per-project download
  pkg.devDependencies ??= {};
  for (const name of Object.keys(pkg.devDependencies)) if (name.startsWith('@vitest/')) delete pkg.devDependencies[name];
  pkg.devDependencies.vitest = variant === 'ours' ? (spec.vitestOurs ?? '5.0.3') : (spec.vitestStryker ?? '4.1.5');
  if (variant === 'stryker') {
    pkg.devDependencies['@stryker-mutator/core'] = '10.0.0';
    pkg.devDependencies['@stryker-mutator/vitest-runner'] = '10.0.0';
  }
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  if (variant === 'stryker') {
    const config = {
      testRunner: 'vitest',
      plugins: ['@stryker-mutator/vitest-runner'],
      mutate: spec.mutate,
      coverageAnalysis: 'perTest',
      reporters: ['clear-text', 'json', 'progress-append-only'],
      jsonReporter: { fileName: 'reports/mutation/mutation.json' },
      incrementalFile: 'reports/stryker-incremental.json',
    };
    writeFileSync(join(dir, 'stryker.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  }
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'node_modules/\n.mutator/\nreports/\n.stryker-tmp/\n.bench-ready\n');
  log(`${spec.name}: installing ${variant} clone`);
  sh(spec.install ?? 'pnpm install --no-frozen-lockfile', dir);
  sh('git add -A && git -c user.name=bench -c user.email=bench@localhost commit -q -m "bench setup" --no-verify', dir);

  const r = sh('node_modules/.bin/vitest run', dir, true);
  if (r.status !== 0) throw new Error(`${spec.name} (${variant}): vitest run fails at the pinned commit\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  writeFileSync(join(dir, '.bench-ready'), `${spec.commit}\n`);
  return dir;
}

/** Every edit must keep the suite green: the point is changes a PR could actually merge. */
function verifyEdits(spec: Spec, dir: string, edits: Edit[]): void {
  for (const edit of edits) {
    const revert = applyEdit(dir, edit);
    try {
      const r = sh('node_modules/.bin/vitest run', dir, true);
      if (r.status !== 0) throw new Error(`${spec.name}: vitest run fails after edit ${edit.file}: ${edit.note}\n${r.stdout.slice(-3000)}`);
      log(`${spec.name}: suite passes with edit (${edit.kind}) ${edit.note}`);
    } finally {
      revert();
    }
  }
}

// ---------- measurement ----------

function score(statuses: Record<string, number>): number {
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (statuses[k] ?? 0), 0);
  const d = sum(DETECTED);
  const u = sum(UNDETECTED);
  return d + u === 0 ? 1 : d / (d + u);
}

function parseOurs(stdout: string): Counts | null {
  const head = stdout.match(/^mutants: (\d+) \(executed (\d+), reused (\d+)\)\n(.*)$/m);
  if (!head) return null;
  const statuses: Record<string, number> = {};
  for (const m of head[4]!.matchAll(/(\w+) (\d+)/g)) statuses[m[1]!] = Number(m[2]);
  return { total: Number(head[1]), executed: Number(head[2]), reused: Number(head[3]), statuses, score: score(statuses) };
}

function parseStryker(dir: string, stdout: string): Counts | null {
  const file = join(dir, 'reports', 'mutation', 'mutation.json');
  if (!existsSync(file)) return null;
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const statuses: Record<string, number> = {};
  let total = 0;
  for (const f of Object.values<any>(report.files)) {
    for (const m of f.mutants) {
      statuses[m.status] = (statuses[m.status] ?? 0) + 1;
      total++;
    }
  }
  // "Result: 99 of 103 mutant result(s) are reused." (absent on a cold run). Stryker does
  // not print how many mutants it ran, so executed = not reused and not statically decided.
  const reusedMatch = stdout.match(/(\d+) of \d+ mutant result\(s\) are reused/);
  const reused = reusedMatch ? Number(reusedMatch[1]) : 0;
  const executed = reusedMatch ? total - reused : total - (statuses.NoCoverage ?? 0) - (statuses.Ignored ?? 0);
  return { total, executed, reused, statuses, score: score(statuses) };
}

function makeRunner(spec: Spec, measurements: Measurement[]) {
  const logDir = join(WORK, 'logs', spec.name);
  mkdirSync(logDir, { recursive: true });
  return (tool: 'ours' | 'stryker', run: string, rep: number, cmd: string, cwd: string): Measurement => {
    const label = `${spec.name} ${tool} ${run} #${rep}`;
    const load = preflight(label);
    log(`${label} (load ${load.toFixed(2)})`);
    const t0 = performance.now();
    const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
    const wallMs = performance.now() - t0;
    const logFile = join(logDir, `${tool}-${run}-${rep}.log`);
    writeFileSync(logFile, `$ ${cmd}\n# exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''} wall ${(wallMs / 1000).toFixed(2)}s load ${load.toFixed(2)}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
    const counts = tool === 'ours' ? parseOurs(r.stdout) : parseStryker(cwd, r.stdout);
    const m: Measurement = { tool, run, rep, wallMs, exitCode: r.status, counts, load, log: logFile };
    log(`  -> ${(wallMs / 1000).toFixed(2)}s exit ${r.status}${r.signal ? ` (${r.signal})` : ''} ${counts ? `${counts.total} mutants, executed ${counts.executed}, score ${(counts.score * 100).toFixed(1)}%` : 'no counts'}`);
    if (r.status !== 0) log(`  !! non-zero exit, see ${logFile}`);
    measurements.push(m);
    return m;
  };
}

function measureOurs(spec: Spec, dir: string, measurements: Measurement[]): void {
  const run = makeRunner(spec, measurements);
  const state = join(WORK, 'state', spec.name);
  mkdirSync(state, { recursive: true });
  const snapshot = join(dir, '.mutator', 'snapshot.json');
  const include = spec.mutate.map((g) => `--include '${g}'`).join(' ');
  const base = `node ${CLI} --root ${dir} ${include} --reporter text --reporter json`;
  const reset = (from?: string) => {
    rmSync(join(dir, '.mutator'), { recursive: true, force: true });
    if (from) {
      mkdirSync(join(dir, '.mutator'), { recursive: true });
      copyFileSync(from, snapshot);
    }
  };
  const cold = join(state, 'cold.json');
  const cgCold = join(state, 'cold-callgraph.json');

  for (let i = 1; i <= reps; i++) {
    reset();
    run('ours', 'cold', i, base, dir);
    copyFileSync(snapshot, cold);
    copyFileSync(join(dir, '.mutator', 'report', 'mutation.json'), join(state, `cold-${i}.mutation.json`));
  }
  for (let i = 1; i <= reps; i++) run('ours', 'warm', i, base, dir);

  let revert = applyEdit(dir, spec.edit);
  try {
    for (let i = 1; i <= reps; i++) {
      reset(cold);
      run('ours', 'edit-full', i, base, dir);
      reset(cold);
      run('ours', 'edit-since', i, `${base} --since HEAD`, dir);
    }
  } finally {
    revert();
  }

  // The call graph mode is part of the env hash, so it needs its own cold snapshot.
  for (let i = 1; i <= reps; i++) {
    reset();
    run('ours', 'cold-callgraph', i, `${base} --experimental-callgraph`, dir);
    copyFileSync(snapshot, cgCold);
  }
  revert = applyEdit(dir, spec.edit);
  try {
    for (let i = 1; i <= reps; i++) {
      reset(cgCold);
      run('ours', 'edit-callgraph', i, `${base} --experimental-callgraph`, dir);
    }
  } finally {
    revert();
  }
  reset(cold);
}

function measureStryker(spec: Spec, dir: string, measurements: Measurement[]): void {
  const run = makeRunner(spec, measurements);
  const state = join(WORK, 'state', spec.name);
  mkdirSync(state, { recursive: true });
  const incremental = join(dir, 'reports', 'stryker-incremental.json');
  const stryker = 'node_modules/.bin/stryker run';
  const clean = () => {
    rmSync(join(dir, '.stryker-tmp'), { recursive: true, force: true });
    rmSync(join(dir, 'reports', 'mutation'), { recursive: true, force: true });
  };
  const saved = join(state, 'stryker-incremental.json');

  for (let i = 1; i <= reps; i++) {
    clean();
    rmSync(incremental, { force: true });
    run('stryker', 'cold', i, `${stryker} --incremental`, dir);
    copyFileSync(incremental, saved);
    copyFileSync(join(dir, 'reports', 'mutation', 'mutation.json'), join(state, `stryker-cold-${i}.mutation.json`));
  }
  for (let i = 1; i <= reps; i++) {
    clean();
    copyFileSync(saved, incremental);
    run('stryker', 'warm', i, `${stryker} --incremental`, dir);
  }
  const revert = applyEdit(dir, spec.edit);
  try {
    for (let i = 1; i <= reps; i++) {
      clean();
      copyFileSync(saved, incremental);
      run('stryker', 'edit', i, `${stryker} --incremental`, dir);
    }
  } finally {
    revert();
  }
  clean();
}

function callgraph(spec: Spec, dir: string): string {
  const args = spec.callgraphEdits.flatMap((e) => [e.file, e.from, e.to]);
  const load = preflight(`${spec.name} callgraph-experiment`);
  log(`${spec.name}: callgraph experiment (${spec.callgraphEdits.length} edits, load ${load.toFixed(2)})`);
  rmSync(join(dir, '.mutator'), { recursive: true, force: true });
  const r = spawnSync('node', [join(REPO, 'bench', 'callgraph-experiment.ts'), dir, spec.mutate.join(','), ...args], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 30 });
  const logDir = join(WORK, 'logs', spec.name);
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'callgraph.log'), `--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`);
  // Only fail when an edit is missing from the output.
  const reported = r.stdout.split('\n== ').length - 1;
  if (reported !== spec.callgraphEdits.length) throw new Error(`callgraph experiment failed for ${spec.name} (exit ${r.status}):\n${r.stderr.slice(-3000)}`);
  if (r.status !== 0) log(`${spec.name}: callgraph experiment exited ${r.status} after reporting every edit`);
  const summary = r.stdout.split('\n').filter((l) => /^(==|sound:|  MISSED)/.test(l)).join('\n');
  log(summary);
  return summary;
}

// ---------- main ----------

mkdirSync(join(WORK, 'results'), { recursive: true });
for (const specPath of positionals) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Spec;
  const resultPath = join(WORK, 'results', `${spec.name}.json`);
  const previous = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : {};
  const result: Record<string, unknown> = { ...previous, spec, node: process.version, date: new Date().toISOString() };
  const save = () => writeFileSync(resultPath, `${JSON.stringify({ ...result, preflight: [...((previous.preflight as string[]) ?? []), ...preflightLog] }, null, 2)}\n`);

  const oursDir = phases.has('setup') || phases.has('ours') || phases.has('callgraph') ? setupClone(spec, 'ours') : '';
  const strykerDir = phases.has('setup') || phases.has('stryker') ? setupClone(spec, 'stryker') : '';
  if (phases.has('setup')) {
    verifyEdits(spec, oursDir, [spec.edit, ...spec.callgraphEdits]);
    verifyEdits(spec, strykerDir, [spec.edit]);
  }
  if (phases.has('ours')) {
    const m: Measurement[] = [];
    measureOurs(spec, oursDir, m);
    result.ours = m;
    save();
  }
  if (phases.has('stryker')) {
    const m: Measurement[] = [];
    measureStryker(spec, strykerDir, m);
    result.stryker = m;
    save();
  }
  if (phases.has('callgraph')) {
    result.callgraph = callgraph(spec, oursDir);
    save();
  }
  save();
}
