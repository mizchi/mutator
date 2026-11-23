#!/usr/bin/env node
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, resolve } from 'node:path';
import { RunnerSetupError, relativePath as relative } from '@mizchi/mutator-core';
import { formatAgentReport } from './agent-report.ts';
import { ACCEPTED_FILE, acceptMutants, readAccepted, readAcceptedFiles } from './accepted.ts';
import { ConfigError } from './config.ts';
import { criticalMutants } from './critical.ts';
import { qualityGate } from './gate.ts';
import { DEFAULT_SKILL_DIR, initSkills, shippedSkills } from './init-skill.ts';
import { formatHtml, formatMutationTestingJson } from './mte-report.ts';
import { parseAcceptCli, parseCli, parseInitSkillCli, parseSelectCli, parseSkippedCli, resolveValues } from './options.ts';
import { formatSkipped, listSkipped } from './skipped.ts';
import { terminalProgress } from './progress.ts';
import { formatAnnotations, formatSummary, oneLine } from './report.ts';
import { SnapshotError } from './reuse.ts';
import { BaselineError, listMutants, runMutation } from './run.ts';
import { selectTestsSince, selectionFiles } from './select-tests.ts';
import { reapOrphans, recordProcesses } from './orphans.ts';
import { stopDescendantsOnTermination } from './terminate.ts';
import { formatSimplify, simplifyCandidates } from './simplify.ts';
import { VERSION } from './version.ts';

const USAGE = `usage: mutator [options]
       mutator accept <key>... --reason <text>   record undetected mutants as accepted (${ACCEPTED_FILE})
       mutator select-tests --since <ref> [--format files|json]   rank the tests a change can break,
                       using static imports on a first run or a cached ranking: killers of mutants in
                       the changed functions, other tests covering them, then changed test files
       mutator skipped [--format text|json]   list the candidates skip rules removed (duplicates,
                       subsumed call removals, ...) with the rule and the mutant that justifies each; runs no test
       mutator init-skill [--dir <dir>] [--force]   copy the agent skills shipped with mutator
                       (${shippedSkills().join(', ')}) into <dir>/<skill>/ (default dir:
                       ${DEFAULT_SKILL_DIR}); --force overwrites copies that differ from the shipped ones

  --watch              rerun on edits (Git defaults: --since HEAD --include-test-changes)
  --watch-throttle <ms>  wait before the first run and batch changes in fixed intervals (default: 1000)
  --since <ref>        only run and report mutants inside \`git diff <ref>\` (+ those whose killing tests are gone)
  --scope node|scope   diff granularity: changed nodes, or whole enclosing functions (default: node)
  --include-test-changes  with --since, also check code covered or imported by changed tests
  --shared-cache       reuse snapshots across worktrees through Git's common directory
  --include <glob>     sources to mutate, repeatable (default: src/**/*.{ts,tsx,js,...})
  --exclude <glob>     sources to skip, repeatable
  --runner <name>      vitest, jest (experimental, native ESM only), bun (experimental),
                       playwright (experimental, opt-in, slower browser E2E through Vite)
                       or auto (default: Vitest/Jest/Bun only)
  --config <file>      test runner config file (vitest or jest)
  --jest-config <file>  jest config file (implies --runner jest)
  --bun-config <file>  bunfig.toml for bun test (implies --runner bun)
  --playwright-config <file>  playwright config file (implies --runner playwright)
  --config-file <file> mutator config (default: <root>/mutator.config.{ts,mts,mjs,js,json})
  --root <dir>         project root (default: cwd)
  -j, --concurrency <n>  parallel test-runner sessions (default: half the CPUs)
  --max-workers <n>    total test workers across sessions, including the dry run
  --shard <index/count>  CI partition of mutant keys, e.g. 1/4 (one-based; independent cache/report)
  --full-dry-run       collect coverage from every test file (ignore the cached coverage)
  --experimental-callgraph  after edits, re-run only survivors connected to changed code
                       in the static call graph (faster, may miss value flows through tests)
  --no-arid            also run mutants in logging-only code (console.*, logger.*, *.debug, ...)
  --[no-]typecheck     type-check mutants with the project's TypeScript first (default: auto)
  --no-weak-mutation   run covered mutants even when no test reaches them with a different value
  --plugin <module>    plugin with custom mutators (path relative to root, or package), repeatable
  --exclude-mutator <name>  skip a mutator (built-in or custom), repeatable
  --arid-callee <pat>  logging call pattern, repeatable (replaces the defaults), e.g. 'metrics.*'
  --mutants-per-line <n>  run at most n mutants per source line, most productive
                       mutators first (the rest stay pending; default: unlimited)
  --time-budget <s>    after s seconds, type-check and start no further mutant (default: unlimited)
  --kill-matrix        run every covering test for every mutant (no early exit) and report tests
                       that kill nothing or whose kills another test subsumes (slower; occasional use)
  --only <key>         run and report only this mutant (key: the id in mutation.json), repeatable
  --reporter <name>    text (default), json, html, agent (JSON for coding agents, on stdout),
                       simplify (code no test observes the removal of: it may be unnecessary;
                       no effect on the score or the gate); repeatable
  --report-dir <dir>   where json/html reports go (default: <root>/.mutator/report)
  --threshold-break <n>  exit 2 when the mutation score (%) is below n
  --fail-on-survived   exit 2 when a mutant survives
  --critical <glob>    critical sources, repeatable: exit 2 on any undetected mutant there
                       that is not accepted (also \`// mutator-critical\` before a function)
  -h, --help
  -v, --version

Boolean flags can be negated (--no-fail-on-survived) to override the config file.
After the baseline, estimated mutant execution time is shown; large runs show progress and ETA.
After interruption, repeat the command to reuse completed mutant verdicts.

exit codes:
  0  ok
  1  invalid options or config file
  2  quality gate failed (score below --threshold-break, a survivor with --fail-on-survived, or an undetected critical mutant)
  4  tests fail without mutants (baseline)`;

/** Ends the process record of this run (set once the run starts). */
let stopRecording: (() => void) | undefined;

stopDescendantsOnTermination();

try {
  if (process.argv[2] === 'accept') {
    await accept(process.argv.slice(3));
    await exit(0);
  }
  if (process.argv[2] === 'select-tests') {
    await selectTestsCommand(process.argv.slice(3));
    await exit(0);
  }
  if (process.argv[2] === 'skipped') {
    await skippedCommand(process.argv.slice(3));
    await exit(0);
  }
  if (process.argv[2] === 'init-skill') {
    initSkillCommand(process.argv.slice(3));
    await exit(0);
  }
  const values = parseCli(process.argv.slice(2));
  if (values.help) {
    console.log(USAGE);
    await exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    await exit(0);
  }
  const watchChild = values.watch && process.send && process.env.MUTATOR_WATCH_PARENT === String(process.ppid);
  if (values.watch && !watchChild) {
    const { watchCommand } = await import('./watch.ts');
    await watchCommand(realpathSync.native(resolve(values.root ?? '.')), fileURLToPath(import.meta.url), process.argv.slice(2), values.watchThrottleMs);
    await exit(0);
  }
  if (watchChild) {
    delete process.env.MUTATOR_WATCH_PARENT;
    process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
  }
  const options = await resolveValues(values, process.cwd());
  const { reporters } = options;
  const root = realpathSync.native(options.root);
  // Workers a killed run (SIGKILL) left spinning; then record this run's, for the next one.
  // In the CLI process only: tests run it as a child process, never with mutated code.
  const processes = join(root, '.mutator');
  const reaped = reapOrphans(processes);
  if (reaped > 0) console.error(`stopped ${reaped} process(es) left by an interrupted run`);
  stopRecording = recordProcesses(processes);
  if (options.configPath) console.error(`config: ${options.configPath}`);
  const accepted = readAccepted(join(root, ACCEPTED_FILE));
  const terminal = process.stderr.isTTY && process.env.TERM !== 'dumb' ? terminalProgress(process.stderr) : undefined;
  const report = await runMutation({
    root,
    ...options.run,
    ...(accepted.size > 0 ? { accepted, acceptedFiles: readAcceptedFiles(join(root, ACCEPTED_FILE)) } : {}),
    log: (message) => console.error(message),
    ...terminal,
  });
  const critical = criticalMutants(report.entries, root, options.critical);
  if (critical.length > 0) report.criticalMutants = critical;
  if (reporters.has('text')) console.log(formatSummary(report, root, options.thresholds));
  if (reporters.has('simplify')) console.log(`${reporters.has('text') ? '\n' : ''}${formatSimplify(simplifyCandidates(report, root))}`);
  if (reporters.has('agent')) console.log(JSON.stringify(formatAgentReport(report, root), null, watchChild ? undefined : 2));
  if (reporters.has('json') || reporters.has('html')) {
    mkdirSync(options.reportDir, { recursive: true });
    if (watchChild) {
      const dir = realpathSync.native(options.reportDir);
      process.send?.([
        ...(reporters.has('json') ? [join(dir, 'mutation.json')] : []),
        ...(reporters.has('html') ? [join(dir, 'index.html')] : []),
      ]);
    }
    const json = formatMutationTestingJson(report, root, options.thresholds);
    if (reporters.has('json')) writeFileSync(join(options.reportDir, 'mutation.json'), JSON.stringify(json));
    if (reporters.has('html')) writeFileSync(join(options.reportDir, 'index.html'), formatHtml(json));
    console.error(`report written to ${options.reportDir}`);
  }
  // The agent reporter's stdout must stay one JSON document.
  if (process.env.GITHUB_ACTIONS && !reporters.has('agent')) {
    const annotations = formatAnnotations(report, root);
    if (annotations) console.log(annotations);
  }
  if (report.unknownKeys) {
    console.error(`--only: no mutant with key ${report.unknownKeys.join(', ')}`);
    await exit(1);
  }
  const failures = qualityGate(report, options);
  for (const failure of failures) console.error(`quality gate failed: ${failure}`);
  await exit(failures.length > 0 ? 2 : 0);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`${error.message}\n\nrun \`mutator --help\` for usage`);
    await exit(1);
  }
  if (error instanceof SnapshotError) {
    console.error(`select-tests: ${error.message}`);
    await exit(1);
  }
  if (error instanceof RunnerSetupError) {
    console.error(error.message);
    await exit(1);
  }
  if (error instanceof BaselineError) {
    console.error(error.message);
    await exit(4);
  }
  throw error;
}

/**
 * process.exit once stdout and stderr are flushed: writes to a pipe are asynchronous, and
 * exiting drops what is still queued (a large --reporter agent document piped to jq).
 */
async function exit(code: number): Promise<never> {
  stopRecording?.();
  const flush = (stream: NodeJS.WriteStream) =>
    new Promise<void>((done) => {
      // A reader that went away (EPIPE, as after `grep -q`) needs nothing more.
      stream.once('error', () => done());
      stream.write('', () => done());
    });
  await Promise.all([flush(process.stdout), flush(process.stderr)]);
  process.exit(code);
}

/** `mutator accept <key>... --reason <text>`: records undetected mutants as accepted, with where they are. */
async function accept(argv: string[]): Promise<void> {
  const { keys, reason, values } = parseAcceptCli(argv);
  if (keys.length === 0 || !reason) throw new ConfigError('accept: give the mutant keys (from --reporter agent, or the `id`s in mutation.json) and --reason <text>');
  const { root: requestedRoot, run } = await resolveValues(values, process.cwd());
  const root = realpathSync.native(requestedRoot);
  const byKey = new Map((await listMutants({ root, ...run })).map((m) => [m.key, m]));
  const unknown = keys.filter((k) => !byKey.has(k));
  if (unknown.length > 0) throw new ConfigError(`accept: no mutant with key ${unknown.join(', ')}`);
  const where = new Map(
    keys.map((k) => {
      const m = byKey.get(k)!;
      return [k, `${relative(root, m.file)}:${m.location.start.line}:${m.location.start.column + 1} ${oneLine(m.original)} -> ${oneLine(m.replacement)}`];
    }),
  );
  acceptMutants(join(root, ACCEPTED_FILE), keys, reason, where);
  console.error(`accepted ${keys.length} mutant(s) in ${ACCEPTED_FILE}`);
}

/** `mutator select-tests --since <ref> [--format files|json]`: the tests a change can break, from the snapshot. */
async function selectTestsCommand(argv: string[]): Promise<void> {
  const { format, values } = parseSelectCli(argv);
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const { root: requestedRoot, run } = await resolveValues(values, process.cwd());
  const root = realpathSync.native(requestedRoot);
  const selection = await selectTestsSince({ root, ...run, since: values.since! });
  const files = selectionFiles(selection);
  if (format === 'json') console.log(JSON.stringify({ files, ...selection }, null, 2));
  else if (files.length > 0) console.log(files.join('\n'));
  const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  console.error(`select-tests: ${count(selection.killers.length, 'killer')}, ${count(selection.covering.length, 'other covering test')}, ${count(selection.changedTests.length, 'changed test file')} -> ${count(files.length, 'test file')}`);
}

/** `mutator skipped [--format text|json]`: what skip rules removed, from instrumentation alone. */
async function skippedCommand(argv: string[]): Promise<void> {
  const { format, values } = parseSkippedCli(argv);
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const { root, run } = await resolveValues(values, process.cwd());
  const { skipped } = await listSkipped({ root, ...run });
  if (format === 'json') console.log(JSON.stringify({ skipped }, null, 2));
  else process.stdout.write(formatSkipped(skipped));
}

/** `mutator init-skill [--dir <dir>] [--force]`: copies the shipped agent skills into the project. */
function initSkillCommand(argv: string[]): void {
  const values = parseInitSkillCli(argv);
  if (values.help) {
    console.log(USAGE);
    return;
  }
  for (const { path, status } of initSkills(values.dir ?? DEFAULT_SKILL_DIR, values.force ?? false)) {
    const shown = isAbsolute(path) ? path : relative('.', path);
    console.log(status === 'written' ? `wrote ${shown}` : `${shown} is up to date`);
  }
}
