// Reusing the last run's snapshot: it is valid for the same tool version and environment
// (Node, lockfiles, tsconfig, runner config, mutation settings), and keeps the results of
// mutants this run did not decide.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { type InstrumentOptions, type Mutant, type MutantResult, type RunSnapshot, hash } from '@mizchi/mutator-core';
import { type CliSnapshot, type MergedDryRun, type SourceInfo, scopeTable } from './coverage-cache.ts';
import type { RunOptions } from './run.ts';
import type { Runner } from './runner.ts';
import { collectSources, resolveSetup } from './setup.ts';
import { readSnapshot } from './snapshot.ts';

// Bump whenever mutators or the snapshot format change (new mutants in unchanged code have
// no cached coverage), or when cached verdicts may be wrong (0.0.8: static mutants ran
// without the tests that reached them while running), so old snapshots are not reused.
export const SNAPSHOT_VERSION = '0.0.8';

export const ENV_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'tsconfig.json'];

/** Mutation settings change which mutants are placed (and thus covered): part of the environment. */
export function mutationSettings(options: RunOptions, setup: { runner: Runner; arid: InstrumentOptions['arid']; plugins: { fingerprint: unknown } }): string {
  const { runner, arid, plugins } = setup;
  return JSON.stringify({ runner, arid: arid ?? null, callGraph: options.callGraph ?? false, typecheck: options.typecheck ?? 'auto', plugins: plugins.fingerprint, excluded: options.excludedMutators ?? [] });
}

/** Node version, mutation settings, and the content of the environment files (relative to root). */
export function environmentHash(root: string, settings: string, envFiles: readonly string[]): string {
  return hash([process.version, settings, ...envFiles.flatMap((f) => [f, readIfExists(join(root, f))])].join('\0'));
}

/** The snapshot cannot be used: missing, or written by another tool version or environment. */
export class SnapshotError extends Error {}

/**
 * The snapshot of the last run with the current mutants, without running anything. The
 * environment is re-hashed from the files the run recorded (the runner's config files are
 * only known to a runner session), so the snapshot must have been written by a run that
 * recorded them.
 */
export async function loadWarmSnapshot(options: RunOptions): Promise<{ snapshot: CliSnapshot; mutants: Mutant[] }> {
  const root = resolve(options.root);
  const snapshotPath = options.snapshotPath ?? join(root, '.mutator', 'snapshot.json');
  const setup = await resolveSetup(root, options, () => {});
  const snapshot = readSnapshot(snapshotPath, root) as CliSnapshot | undefined;
  const rel = relative(process.cwd(), snapshotPath) || snapshotPath;
  if (!snapshot) throw new SnapshotError(`no snapshot at ${rel}: run \`mutator\` once first`);
  if (snapshot.toolVersion !== SNAPSHOT_VERSION || !snapshot.envFiles || snapshot.index === undefined) {
    throw new SnapshotError(`${rel} was written by another mutator version: run \`mutator\` once first`);
  }
  if (snapshot.envHash !== environmentHash(root, mutationSettings(options, setup), snapshot.envFiles)) {
    throw new SnapshotError(`${rel} is from another environment (lockfile, tsconfig, runner config, node version or mutation options changed): run \`mutator\` once first`);
  }
  return { snapshot, mutants: collectSources(root, setup.files, setup.instrumentOptions).mutants };
}

/** The snapshot for the next run: this run's results over the reusable ones, plus the merged dry run's data. */
export function buildSnapshot(
  root: string,
  reusable: CliSnapshot | undefined,
  run: { envHash: string; envFiles: string[]; results: MutantResult[]; mutants: readonly Mutant[]; merged: MergedDryRun; testFiles: Record<string, string>; sources: ReadonlyMap<string, SourceInfo> },
): CliSnapshot {
  const { merged } = run;
  const core = mergeSnapshot(reusable, { toolVersion: SNAPSHOT_VERSION, envHash: run.envHash, results: run.results, tests: merged.tests }, run.mutants);
  return {
    ...core,
    envFiles: run.envFiles,
    testFiles: run.testFiles,
    deps: Object.fromEntries(merged.deps),
    index: Object.fromEntries([...merged.index].map(([id, l]) => [id, { module: relative(root, l.moduleId), taskId: l.taskId }])),
    staticByFile: Object.fromEntries([...merged.staticByFile].map(([f, keys]) => [f, [...keys]])),
    hits: Object.fromEntries(merged.hits),
    spawns: Object.fromEntries(merged.spawns),
    scopes: scopeTable(root, run.sources),
  };
}

/**
 * Keep cached results of mutants that still exist but were not part of this run.
 * `previous` must already be reusable (same tool version and environment as `current`).
 */
function mergeSnapshot(previous: RunSnapshot | undefined, current: RunSnapshot, mutants: readonly Mutant[]): RunSnapshot {
  if (!previous) return current;
  const written = new Set(current.results.map((r) => r.key));
  const alive = new Map(mutants.map((m) => [m.key, m.scope.hash]));
  const kept = previous.results.filter((r) => !written.has(r.key) && alive.get(r.key) === r.scopeHash);
  return { ...current, results: [...current.results, ...kept] };
}

function readIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}
