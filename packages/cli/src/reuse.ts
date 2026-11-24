// Reusing the last run's snapshot: it is valid for the same tool version and environment
// (Node, lockfiles, tsconfig, runner config, mutation settings), and keeps the results of
// mutants this run did not decide.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { type InstrumentOptions, type Mutant, type MutantResult, type RunSnapshot, hash, relativePath as relative } from '@mizchi/mutator-core';
import { type CliSnapshot, type MergedDryRun, type SourceInfo, scopeTable } from './coverage-cache.ts';
import type { RunOptions } from './run.ts';
import type { Runner } from './runner.ts';
import { resolveSetup } from './setup.ts';
import { readSnapshot } from './snapshot.ts';
import { snapshotFiles } from './snapshot-store.ts';

// Bump whenever mutators or the snapshot format change (new mutants in unchanged code have
// no cached coverage), or when cached verdicts may be wrong (0.0.8: static mutants ran
// without the tests that reached them while running; 0.0.15: verdicts ignored the files and
// environment variables tests read; 0.0.16: MissingAwait and RegexFlag on by default), so old
// snapshots are not reused.
export const SNAPSHOT_VERSION = '0.0.16';

export const ENV_FILES = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb', 'tsconfig.json', 'pnpm-workspace.yaml'];

/** Environment files of this package and its enclosing workspaces, relative to the package. */
export function environmentFiles(root: string, extra: readonly string[] = []): string[] {
  const files = new Set([...ENV_FILES, ...extra]);
  let directory = resolve(root);
  while (!existsSync(join(directory, '.git'))) {
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
    const manifest = readIfExists(join(directory, 'package.json'));
    let workspace = existsSync(join(directory, 'pnpm-workspace.yaml'));
    try { workspace ||= Boolean(JSON.parse(manifest).workspaces); } catch { /* No workspace manifest. */ }
    if (workspace) for (const file of ENV_FILES) files.add(relative(root, join(directory, file)));
  }
  return [...files].sort();
}

/** Mutation settings change which mutants are placed (and thus covered): part of the environment. */
export function mutationSettings(options: RunOptions, setup: { runner: Runner; arid: InstrumentOptions['arid']; plugins: { fingerprint: unknown } }): string {
  const { runner, arid, plugins } = setup;
  return JSON.stringify({ runner, arid: arid ?? null, callGraph: options.callGraph ?? false, typecheck: options.typecheck ?? 'auto', plugins: plugins.fingerprint, excluded: options.excludedMutators ?? [], enabled: [...(options.enabledMutators ?? [])].sort(), skipSubsumed: options.skipSubsumed ?? false, skipHangs: options.skipHangs ?? false, minimalRelational: options.minimalRelational ?? false, ...(runner === 'playwright' ? { sourceCoverage: options.playwrightSourceCoverage ?? false } : {}) });
}

/** Node version, mutation settings, and the content of the environment files (relative to root). */
export function environmentHash(root: string, settings: string, envFiles: readonly string[]): string {
  return hash([process.version, settings, ...environmentFiles(root, envFiles).flatMap((f) => [f, readIfExists(join(root, f))])].join('\0'));
}

/** The snapshot cannot be used: missing, or written by another tool version or environment. */
export class SnapshotError extends Error {}

/**
 * The snapshot of the last run with the current mutants, without running anything. The
 * environment is re-hashed from the files the run recorded (the runner's config files are
 * only known to a runner session), so the snapshot must have been written by a run that
 * recorded them.
 */
export async function loadWarmSnapshot(options: RunOptions): Promise<{ snapshot: CliSnapshot; files: string[] } | undefined> {
  const root = resolve(options.root);
  const candidates = snapshotFiles(root, options);
  if (!candidates.some(path => existsSync(path))) return undefined;
  const setup = await resolveSetup(root, options, () => {});
  const settings = mutationSettings(options, setup);
  const snapshotPath = candidates.find((path) => {
    const cached = readSnapshot(path, root) as CliSnapshot | undefined;
    return cached?.toolVersion === SNAPSHOT_VERSION && cached.envFiles && cached.envHash === environmentHash(root, settings, cached.envFiles);
  }) ?? candidates[0] ?? join(root, '.mutator/snapshot.json');
  const snapshot = readSnapshot(snapshotPath, root) as CliSnapshot | undefined;
  const rel = relative(process.cwd(), snapshotPath) || snapshotPath;
  if (!snapshot) throw new SnapshotError(`no snapshot at ${rel}: run \`mutator\` once first`);
  if (snapshot.toolVersion !== SNAPSHOT_VERSION || !snapshot.envFiles || snapshot.index === undefined) {
    throw new SnapshotError(`${rel} was written by another mutator version: run \`mutator\` once first`);
  }
  if (snapshot.envHash !== environmentHash(root, mutationSettings(options, setup), snapshot.envFiles)) {
    throw new SnapshotError(`${rel} is from another environment (lockfile, tsconfig, runner config, node version or mutation options changed): run \`mutator\` once first`);
  }
  return { snapshot, files: setup.files };
}

/** The snapshot for the next run: this run's results over the reusable ones, plus the merged dry run's data. */
export function buildSnapshot(
  root: string,
  reusable: CliSnapshot | undefined,
  run: { envHash: string; envFiles: string[]; results: MutantResult[]; mutants: readonly Mutant[]; merged: MergedDryRun; testFiles: Record<string, string>; sources: ReadonlyMap<string, SourceInfo> },
): CliSnapshot {
  const { merged } = run;
  const core = mergeSnapshot(reusable, { toolVersion: SNAPSHOT_VERSION, envHash: run.envHash, results: run.results, tests: merged.tests }, run.mutants);
  const scopes = scopeTable(root, run.sources);
  const aliveScopes = merged.sourceCoverage ? new Set(Object.entries(scopes).flatMap(([file, entries]) => Object.keys(entries).map((id) => `${file}#${id}`))) : undefined;
  return {
    ...core,
    envFiles: run.envFiles,
    testFiles: run.testFiles,
    deps: Object.fromEntries(merged.deps),
    index: Object.fromEntries([...merged.index].map(([id, l]) => [id, { module: relative(root, l.moduleId), taskId: l.taskId, ...(l.projectName === undefined ? {} : { projectName: l.projectName }) }])),
    staticByFile: Object.fromEntries([...merged.staticByFile].map(([f, keys]) => [f, [...keys]])),
    hits: Object.fromEntries(merged.hits),
    spawns: Object.fromEntries(merged.spawns),
    ...(merged.reads.size ? { reads: Object.fromEntries(merged.reads) } : {}),
    ...(merged.env.size ? { env: Object.fromEntries(merged.env) } : {}),
    scopes,
    moduleLoads: Object.fromEntries([...run.sources].flatMap(([file, { loads }]) => loads?.length ? [[relative(root, file), loads]] : [])),
    ...(merged.sourceCoverage ? { sourceCoverage: Object.fromEntries([...merged.sourceCoverage].filter(([scope]) => aliveScopes!.has(scope))), sourceCoverageIncomplete: [...(merged.sourceCoverageIncomplete ?? [])] } : {}),
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
