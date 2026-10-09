#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatAnnotations, formatSummary } from './report.ts';
import { BaselineError, runMutation } from './run.ts';

const USAGE = `usage: mutator [options]

  --since <ref>        only run mutants inside \`git diff <ref>\` (+ those covered by changed tests)
  --scope node|scope   diff granularity: changed nodes, or whole enclosing functions (default: node)
  --include <glob>     sources to mutate, repeatable (default: src/**/*.{ts,tsx,js,...})
  --exclude <glob>     sources to skip, repeatable
  --config <file>      vitest config file
  --root <dir>         project root (default: cwd)
  -j, --concurrency <n>  parallel Vitest instances (default: half the CPUs)
  --full-dry-run       collect coverage from every test file (ignore the cached coverage)
  --no-arid            also run mutants in logging-only code (console.*, logger.*, *.debug, ...)
  --arid-callee <pat>  logging call pattern, repeatable (replaces the defaults), e.g. 'metrics.*'
  --fail-on-survived   exit 2 when a mutant survives
  -h, --help`;

const { values } = parseArgs({
  options: {
    since: { type: 'string' },
    scope: { type: 'string', default: 'node' },
    include: { type: 'string', multiple: true },
    exclude: { type: 'string', multiple: true },
    config: { type: 'string' },
    root: { type: 'string', default: process.cwd() },
    concurrency: { type: 'string', short: 'j' },
    'fail-on-survived': { type: 'boolean', default: false },
    'full-dry-run': { type: 'boolean', default: false },
    'no-arid': { type: 'boolean', default: false },
    'arid-callee': { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}
if (values.scope !== 'node' && values.scope !== 'scope') {
  console.error(`invalid --scope: ${values.scope}\n\n${USAGE}`);
  process.exit(1);
}

const root = resolve(values.root);
try {
  const report = await runMutation({
    root,
    scope: values.scope,
    ...(values.since ? { since: values.since } : {}),
    ...(values.include ? { include: values.include } : {}),
    ...(values.exclude ? { exclude: values.exclude } : {}),
    ...(values.config ? { configFile: resolve(values.config) } : {}),
    ...(values.concurrency ? { concurrency: Number(values.concurrency) } : {}),
    fullDryRun: values['full-dry-run'],
    ...(values['no-arid'] ? { arid: false as const } : values['arid-callee'] ? { arid: { callees: values['arid-callee'] } } : {}),
    log: (message) => console.error(message),
  });
  console.log(formatSummary(report, root));
  if (process.env.GITHUB_ACTIONS) {
    const annotations = formatAnnotations(report, root);
    if (annotations) console.log(annotations);
  }
  process.exit(values['fail-on-survived'] && report.entries.some((e) => e.status === 'Survived') ? 2 : 0);
} catch (error) {
  if (error instanceof BaselineError) {
    console.error(error.message);
    process.exit(4);
  }
  throw error;
}
