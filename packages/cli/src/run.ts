import { existsSync, globSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  type Mutant,
  type MutantResult,
  type MutantStatus,
  type PlanEntry,
  type Range,
  type RunSnapshot,
  type SelectMode,
  changedLines,
  hash,
  instrument,
  lineRanges,
  parseUnifiedDiff,
  plan,
  selectMutants,
  toResult,
} from '@mizchi/mutator-core';
import { createSession } from '@mizchi/mutator-vitest';
import { changedFiles, gitDiff } from './git.ts';
import { oneLine } from './report.ts';
import { readSnapshot, writeSnapshot } from './snapshot.ts';

export const TOOL_VERSION = '0.0.0';

export interface RunOptions {
  root: string;
  /** Globs (relative to root) of sources to mutate. */
  include?: readonly string[];
  exclude?: readonly string[];
  /** Git ref: only mutants inside `git diff <since>` (plus mutants covered by changed tests) are executed. */
  since?: string;
  scope?: SelectMode;
  snapshotPath?: string;
  configFile?: string;
  timeoutFactor?: number;
  timeoutMs?: number;
  /** Parallel Vitest instances running mutants (default: half the CPUs). */
  concurrency?: number;
  log?: (message: string) => void;
}

export interface ReportEntry {
  mutant: Mutant;
  status: MutantStatus | 'Pending';
  /** run: executed now, reuse: taken from the snapshot, skipped: outside --since and no cached result */
  source: 'run' | 'reuse' | 'static' | 'skipped';
  killedBy: string[];
}

export interface Report {
  entries: ReportEntry[];
  executed: number;
  /** detected / (detected + undetected), ignoring Ignored and Pending */
  score: number;
  durationMs: number;
}

export class BaselineError extends Error {}

const DEFAULT_INCLUDE = ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
const DEFAULT_EXCLUDE = ['**/node_modules/**', '**/*.d.ts', '**/*.{test,spec}.*', '**/__tests__/**'];
const ENV_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'tsconfig.json', 'vitest.config.ts', 'vitest.config.mts', 'vite.config.ts'];

export async function runMutation(options: RunOptions): Promise<Report> {
  const started = performance.now();
  const root = resolve(options.root);
  const log = options.log ?? (() => {});
  const snapshotPath = options.snapshotPath ?? join(root, '.mutator', 'snapshot.json');
  const files = globSync([...(options.include ?? DEFAULT_INCLUDE)], {
    cwd: root,
    exclude: [...DEFAULT_EXCLUDE, ...(options.exclude ?? [])],
  }).map((f) => join(root, f));
  const targets = new Set(files);

  const sessionOptions = {
    root,
    include: (file: string) => targets.has(file),
    ...(options.configFile ? { configFile: options.configFile } : {}),
  };
  const session = await createSession(sessionOptions);
  const sessions = [session];
  try {
    log(`dry run (${files.length} source files)`);
    const dry = await session.dryRun();
    if (dry.failed.length > 0) throw new BaselineError(`tests fail without mutants: ${dry.failed.join(', ')}`);

    const mutants = collectMutants(session.mutants(), files);
    const envHash = hash([process.version, ...ENV_FILES.map((f) => readIfExists(join(root, f)))].join('\0'));
    const previous = readSnapshot(snapshotPath);
    const entries = plan({
      mutants,
      tests: dry.tests,
      coverage: dry.coverage,
      staticKeys: dry.staticKeys,
      previous,
      toolVersion: TOOL_VERSION,
      envHash,
      options: { ...(options.timeoutFactor ? { timeoutFactor: options.timeoutFactor } : {}), ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) },
    });

    const inScope = options.since ? diffScope(root, options.since, mutants, dry, options.scope ?? 'node') : undefined;
    const report: ReportEntry[] = [];
    const results: MutantResult[] = [];
  
    const jobs: { index: number; entry: Extract<PlanEntry, { kind: 'run' }> }[] = [];
    for (const entry of entries) {
      const { mutant } = entry;
      switch (entry.kind) {
        case 'ignored':
          results.push(toResult(mutant, 'Ignored', [], []));
          report.push({ mutant, status: 'Ignored', source: 'static', killedBy: [] });
          break;
        case 'noCoverage':
          results.push(toResult(mutant, 'NoCoverage', [], []));
          report.push({ mutant, status: 'NoCoverage', source: 'static', killedBy: [] });
          break;
        case 'reuse':
          results.push(entry.result);
          report.push({ mutant, status: entry.result.status, source: 'reuse', killedBy: entry.result.killedBy });
          break;
        case 'run':
          if (inScope && !inScope.has(mutant.key)) {
            report.push({ mutant, status: 'Pending', source: 'skipped', killedBy: [] });
          } else {
            jobs.push({ index: report.length, entry });
            report.push({ mutant, status: 'Pending', source: 'run', killedBy: [] });
          }
          break;
      }
    }

    log(`${mutants.length} mutants, ${jobs.length} to run`);
    const concurrency = Math.max(1, Math.min(options.concurrency ?? defaultConcurrency(), jobs.length));
    const extra = await Promise.all(
      Array.from({ length: concurrency - 1 }, () => createSession({ ...sessionOptions, maxWorkers: 1 })),
    );
    sessions.push(...extra);
    for (const s of extra) s.useTestIndex(dry.index);
    let executed = 0;
    let next = 0;
    await Promise.all(
      sessions.slice(0, concurrency).map(async (worker) => {
        while (next < jobs.length) {
          const { index, entry } = jobs[next++]!;
          const { mutant } = entry;
          const outcome = await worker.runMutant(mutant.key, entry.tests, {
            timeoutMs: entry.timeoutMs,
            isStatic: entry.isStatic,
            hitLimit: Math.max(10_000, (dry.hits.get(mutant.key) ?? 0) * 100),
          });
          executed++;
          log(`[${executed}/${jobs.length}] ${outcome.status.padEnd(8)} ${relative(root, mutant.file)}:${mutant.location.start.line} ${oneLine(mutant.original)} -> ${oneLine(mutant.replacement)}`);
          results.push(toResult(mutant, outcome.status, outcome.killedBy, dry.coverage.get(mutant.key) ?? [], outcome.durationMs));
          report[index] = { mutant, status: outcome.status, source: 'run', killedBy: outcome.killedBy };
        }
      }),
    );

    writeSnapshot(snapshotPath, mergeSnapshot(previous, { toolVersion: TOOL_VERSION, envHash, results, tests: dry.tests }, mutants));
    return { entries: report, executed, score: score(report), durationMs: performance.now() - started };
  } finally {
    await Promise.all(sessions.map((s) => s.close()));
  }
}

function defaultConcurrency(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/** Instrument sources no test imported, so their mutants are reported (as NoCoverage). */
function collectMutants(seen: Mutant[], files: readonly string[]): Mutant[] {
  const byFile = new Map<string, Mutant[]>();
  for (const m of seen) byFile.set(m.file, [...(byFile.get(m.file) ?? []), m]);
  return files.flatMap((file) => byFile.get(file) ?? instrument(file, readFileSync(file, 'utf8')).mutants);
}

/** Mutants touched by the diff, plus mutants covered by tests in changed test files. */
function diffScope(root: string, since: string, mutants: readonly Mutant[], dry: { coverage: ReadonlyMap<string, readonly string[]> }, mode: SelectMode): Set<string> {
  const changed = new Map<string, readonly Range[]>();
  for (const fd of parseUnifiedDiff(gitDiff(root, since))) {
    if (!fd.newPath) continue;
    const file = join(root, fd.newPath);
    if (!existsSync(file)) continue;
    changed.set(file, lineRanges(readFileSync(file, 'utf8'), changedLines(fd)));
  }
  for (const rel of changedFiles(root, since, { untracked: true })) {
    const file = join(root, rel);
    if (!changed.has(file) && existsSync(file)) changed.set(file, [{ start: 0, end: readFileSync(file, 'utf8').length }]);
  }
  const selected = new Set(selectMutants(mutants, changed, mode).map((m) => m.key));
  const changedTestFiles = [...changed.keys()].map((f) => f.slice(root.length + 1));
  for (const [key, tests] of dry.coverage) {
    if (tests.some((t) => changedTestFiles.some((f) => t.startsWith(`${f}#`)))) selected.add(key);
  }
  return selected;
}

/** Keep cached results of mutants that still exist but were not part of this run (e.g. outside --since). */
function mergeSnapshot(previous: RunSnapshot | undefined, current: RunSnapshot, mutants: readonly Mutant[]): RunSnapshot {
  if (!previous || previous.toolVersion !== current.toolVersion || previous.envHash !== current.envHash) return current;
  const written = new Set(current.results.map((r) => r.key));
  const alive = new Map(mutants.map((m) => [m.key, m.scope.hash]));
  const kept = previous.results.filter((r) => !written.has(r.key) && alive.get(r.key) === r.scopeHash);
  return { ...current, results: [...current.results, ...kept] };
}

const DETECTED = new Set<string>(['Killed', 'Timeout', 'RuntimeError']);
const UNDETECTED = new Set<string>(['Survived', 'NoCoverage']);

function score(entries: readonly ReportEntry[]): number {
  const detected = entries.filter((e) => DETECTED.has(e.status)).length;
  const undetected = entries.filter((e) => UNDETECTED.has(e.status)).length;
  return detected + undetected === 0 ? 1 : detected / (detected + undetected);
}

function readIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
