#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { formatHtml, formatMutationTestingJson } from './mte-report.ts';
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
  --reporter <name>    text (default), json, html; repeatable
  --report-dir <dir>   where json/html reports go (default: <root>/.mutator/report)
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
    reporter: { type: 'string', multiple: true, default: ['text'] },
    'report-dir': { type: 'string' },
    'fail-on-survived': { type: 'boolean', default: false },
    'full-dry-run': { type: 'boolean', default: false },
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
const REPORTERS = new Set(['text', 'json', 'html']);
const unknown = values.reporter.filter((r) => !REPORTERS.has(r));
if (unknown.length > 0) {
  console.error(`invalid --reporter: ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(1);
}

const root = resolve(values.root);
const reporters = new Set(values.reporter);
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
    log: (message) => console.error(message),
  });
  if (reporters.has('text')) console.log(formatSummary(report, root));
  if (reporters.has('json') || reporters.has('html')) {
    const dir = resolve(values['report-dir'] ?? join(root, '.mutator', 'report'));
    mkdirSync(dir, { recursive: true });
    const json = formatMutationTestingJson(report, root);
    if (reporters.has('json')) writeFileSync(join(dir, 'mutation.json'), JSON.stringify(json));
    if (reporters.has('html')) writeFileSync(join(dir, 'index.html'), formatHtml(json));
    console.error(`report written to ${dir}`);
  }
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
