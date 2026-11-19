// Helpers shared by the bench harnesses (bench/run.ts, bench/bun-vs-vitest.ts). No side
// effects on import: run.ts parses its arguments at top level, so it cannot be imported.
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edit, Spec } from './run.ts';

export function log(message: string): void {
  console.error(`[bench ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

export function sh(cmd: string, cwd: string, allowFail = false): SpawnSyncReturns<string> {
  const r = spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} (in ${cwd}) failed:\n${r.stdout}\n${r.stderr}`);
  return r;
}

/** Applies the edit (its `from` must occur exactly once) and returns the revert. */
export function applyEdit(dir: string, edit: Edit): () => void {
  const path = join(dir, edit.file);
  const original = readFileSync(path, 'utf8');
  const count = original.split(edit.from).length - 1;
  if (count !== 1) throw new Error(`${edit.file}: expected exactly one occurrence of ${JSON.stringify(edit.from)}, found ${count}`);
  writeFileSync(path, original.replace(edit.from, edit.to));
  return () => writeFileSync(path, original);
}

export interface OurCounts {
  total: number;
  executed: number;
  reused: number;
  statuses: Record<string, number>;
}

/** The CLI summary's head: `mutants: N (executed E, reused R)`, or with --since `mutants: N in the diff (T in total; executed E, reused R)`. */
export function parseOurCounts(stdout: string): OurCounts | null {
  const head = stdout.match(/^mutants: (\d+)(?: in the diff)?(?:, \d+ rechecked)? \((?:\d+ in total; )?executed (\d+), reused (\d+)\)\n(.*)$/m);
  if (!head) return null;
  const statuses: Record<string, number> = {};
  for (const m of head[4]!.matchAll(/(\w+) (\d+)/g)) statuses[m[1]!] = Number(m[2]);
  return { total: Number(head[1]), executed: Number(head[2]), reused: Number(head[3]), statuses };
}

export interface CloneOptions {
  /** Vitest for the `ours` clone when the spec pins none. */
  vitest?: string;
  /** Commands that must pass at the pinned commit (default: `vitest run`). */
  checks?: string[];
}

/**
 * A clone of the spec's pinned commit under `work`, set up once: a standalone pnpm project
 * (otherwise pnpm joins the mutator workspace), a local vitest config (otherwise Vitest walks
 * up into mutator's own config), Vitest pinned, and the setup committed so that
 * `git diff HEAD` holds only a bench edit.
 */
export function setupClone(work: string, spec: Spec, variant: 'ours' | 'stryker', options: CloneOptions = {}): string {
  const dir = join(work, variant === 'ours' ? spec.name : `${spec.name}-stryker`);
  const vitest = variant === 'ours' ? (spec.vitestOurs ?? options.vitest ?? '5.0.3') : (spec.vitestStryker ?? '4.1.5');
  // What the setup depends on: a clone set up for other values is set up again.
  const stamp = `${JSON.stringify({ commit: spec.commit, vitest, install: spec.install, checks: options.checks })}\n`;
  const ready = join(dir, '.bench-ready');
  if (existsSync(ready) && readFileSync(ready, 'utf8') === stamp) return dir;
  rmSync(dir, { recursive: true, force: true });
  log(`${spec.name}: cloning ${variant} clone`);
  sh(`git clone -q ${spec.repo} ${dir}`, work);
  sh(`git checkout -q ${spec.commit} && git switch -q -c bench`, dir);

  if (!existsSync(join(dir, 'pnpm-workspace.yaml'))) writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "."\n# do not run dependency build scripts (esbuild etc. ship prebuilt binaries)\nstrictDepBuilds: false\n');
  const configs = readdirSync(dir).filter((f) => /^(vitest|vite)\.config\.(ts|mts|js|mjs|cjs)$/.test(f));
  if (configs.length === 0) writeFileSync(join(dir, 'vitest.config.mts'), "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: {} });\n");

  const pkgPath = join(dir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  delete pkg.packageManager; // use the installed pnpm, not a per-project download
  pkg.devDependencies ??= {};
  for (const name of Object.keys(pkg.devDependencies)) if (name.startsWith('@vitest/')) delete pkg.devDependencies[name];
  pkg.devDependencies.vitest = vitest;
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

  for (const check of options.checks ?? ['node_modules/.bin/vitest run']) {
    const r = sh(check, dir, true);
    if (r.status !== 0) throw new Error(`${spec.name} (${variant}): ${check} fails at the pinned commit\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`);
  }
  writeFileSync(ready, stamp);
  return dir;
}
