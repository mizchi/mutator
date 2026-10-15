#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ACCEPTED_FILE, acceptMutants, readAccepted } from './accepted.ts';
import { ConfigError } from './config.ts';
import { qualityGate } from './gate.ts';
import { type MteReport, formatHtml, formatMutationTestingJson } from './mte-report.ts';
import { parseCli, resolveValues } from './options.ts';
import { formatAnnotations, formatSummary, oneLine } from './report.ts';
import { BaselineError, runMutation } from './run.ts';
import { VERSION } from './version.ts';

const USAGE = `usage: mutator [options]
       mutator accept <key>... --reason <text>   record undetected mutants as accepted (${ACCEPTED_FILE})

  --since <ref>        only run and report mutants inside \`git diff <ref>\` (+ those whose killing tests are gone)
  --scope node|scope   diff granularity: changed nodes, or whole enclosing functions (default: node)
  --include <glob>     sources to mutate, repeatable (default: src/**/*.{ts,tsx,js,...})
  --exclude <glob>     sources to skip, repeatable
  --runner <name>      vitest, jest (experimental, native ESM only) or auto (default)
  --config <file>      test runner config file (vitest or jest)
  --jest-config <file>  jest config file (implies --runner jest)
  --config-file <file> mutator config (default: <root>/mutator.config.{ts,mts,mjs,js,json})
  --root <dir>         project root (default: cwd)
  -j, --concurrency <n>  parallel test-runner sessions (default: half the CPUs)
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
  --time-budget <s>    start no new mutant run after s seconds (default: unlimited)
  --reporter <name>    text (default), json, html; repeatable
  --report-dir <dir>   where json/html reports go (default: <root>/.mutator/report)
  --threshold-break <n>  exit 2 when the mutation score (%) is below n
  --fail-on-survived   exit 2 when a mutant survives
  -h, --help
  -v, --version

Boolean flags can be negated (--no-fail-on-survived) to override the config file.

exit codes:
  0  ok
  1  invalid options or config file
  2  quality gate failed (score below --threshold-break, or a survivor with --fail-on-survived)
  4  tests fail without mutants (baseline)`;

try {
  if (process.argv[2] === 'accept') {
    accept(process.argv.slice(3));
    process.exit(0);
  }
  const values = parseCli(process.argv.slice(2));
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (values.version) {
    console.log(VERSION);
    process.exit(0);
  }
  const options = await resolveValues(values, process.cwd());
  const { root, reporters } = options;
  if (options.configPath) console.error(`config: ${options.configPath}`);
  const accepted = readAccepted(join(root, ACCEPTED_FILE));
  const report = await runMutation({
    root,
    ...options.run,
    ...(accepted.size > 0 ? { accepted } : {}),
    log: (message) => console.error(message),
  });
  if (reporters.has('text')) console.log(formatSummary(report, root, options.thresholds));
  if (reporters.has('json') || reporters.has('html')) {
    mkdirSync(options.reportDir, { recursive: true });
    const json = formatMutationTestingJson(report, root, options.thresholds);
    if (reporters.has('json')) writeFileSync(join(options.reportDir, 'mutation.json'), JSON.stringify(json));
    if (reporters.has('html')) writeFileSync(join(options.reportDir, 'index.html'), formatHtml(json));
    console.error(`report written to ${options.reportDir}`);
  }
  if (process.env.GITHUB_ACTIONS) {
    const annotations = formatAnnotations(report, root);
    if (annotations) console.log(annotations);
  }
  const failures = qualityGate(report, options);
  for (const failure of failures) console.error(`quality gate failed: ${failure}`);
  process.exit(failures.length > 0 ? 2 : 0);
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`${error.message}\n\nrun \`mutator --help\` for usage`);
    process.exit(1);
  }
  if (error instanceof BaselineError) {
    console.error(error.message);
    process.exit(4);
  }
  throw error;
}

/** `mutator accept <key>... --reason <text>`: records undetected mutants as accepted. */
function accept(argv: string[]): void {
  const { values, positionals } = parseArgs({ args: argv, options: { reason: { type: 'string' }, root: { type: 'string' }, 'report-dir': { type: 'string' } }, allowPositionals: true });
  if (positionals.length === 0 || !values.reason) throw new ConfigError('accept: give the mutant keys (the `id`s in mutation.json) and --reason <text>');
  const root = resolve(values.root ?? '.');
  // Describe each mutant from the last JSON report, when there is one.
  const where = new Map<string, string>();
  const reportFile = join(resolve(root, values['report-dir'] ?? join('.mutator', 'report')), 'mutation.json');
  if (existsSync(reportFile)) {
    const json = JSON.parse(readFileSync(reportFile, 'utf8')) as MteReport;
    for (const [file, { mutants }] of Object.entries(json.files)) {
      for (const m of mutants) where.set(m.id, `${file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName}: ${oneLine(m.replacement)}`);
    }
  }
  acceptMutants(join(root, ACCEPTED_FILE), positionals, values.reason, where);
  console.error(`accepted ${positionals.length} mutant(s) in ${ACCEPTED_FILE}`);
}
