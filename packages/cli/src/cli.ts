#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from './config.ts';
import { qualityGate } from './gate.ts';
import { formatHtml, formatMutationTestingJson } from './mte-report.ts';
import { parseCli, resolveValues } from './options.ts';
import { formatAnnotations, formatSummary } from './report.ts';
import { BaselineError, runMutation } from './run.ts';

const USAGE = `usage: mutator [options]

  --since <ref>        only run mutants inside \`git diff <ref>\` (+ those covered by changed tests)
  --scope node|scope   diff granularity: changed nodes, or whole enclosing functions (default: node)
  --include <glob>     sources to mutate, repeatable (default: src/**/*.{ts,tsx,js,...})
  --exclude <glob>     sources to skip, repeatable
  --config <file>      vitest config file
  --config-file <file> mutator config (default: <root>/mutator.config.{ts,mts,mjs,js,json})
  --root <dir>         project root (default: cwd)
  -j, --concurrency <n>  parallel Vitest instances (default: half the CPUs)
  --full-dry-run       collect coverage from every test file (ignore the cached coverage)
  --experimental-callgraph  after edits, re-run only survivors connected to changed code
                       in the static call graph (faster, may miss value flows through tests)
  --no-arid            also run mutants in logging-only code (console.*, logger.*, *.debug, ...)
  --[no-]typecheck     type-check mutants with the project's TypeScript first (default: auto)
  --plugin <module>    plugin with custom mutators (path relative to root, or package), repeatable
  --exclude-mutator <name>  skip a mutator (built-in or custom), repeatable
  --arid-callee <pat>  logging call pattern, repeatable (replaces the defaults), e.g. 'metrics.*'
  --reporter <name>    text (default), json, html; repeatable
  --report-dir <dir>   where json/html reports go (default: <root>/.mutator/report)
  --threshold-break <n>  exit 2 when the mutation score (%) is below n
  --fail-on-survived   exit 2 when a mutant survives
  -h, --help

Boolean flags can be negated (--no-fail-on-survived) to override the config file.

exit codes:
  0  ok
  1  invalid options or config file
  2  quality gate failed (score below --threshold-break, or a survivor with --fail-on-survived)
  4  tests fail without mutants (baseline)`;

try {
  const values = parseCli(process.argv.slice(2));
  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const options = await resolveValues(values, process.cwd());
  const { root, reporters } = options;
  if (options.configPath) console.error(`config: ${options.configPath}`);
  const report = await runMutation({
    root,
    ...options.run,
    ...(options.typecheck !== undefined ? { typecheck: options.typecheck } : {}),
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
