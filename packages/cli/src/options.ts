// Command line + config file -> options. Precedence: CLI flags > config file > defaults.
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ConfigError, DEFAULT_THRESHOLDS, type MutatorConfig, type Reporter, type Thresholds, configSchema, fail, loadConfig, schemaErrors } from './config.ts';
import type { RunOptions } from './run.ts';

export interface ResolvedOptions {
  root: string;
  /** The config file that was loaded, if any. */
  configPath?: string;
  run: Omit<RunOptions, 'root' | 'log'>;
  typecheck?: boolean | 'auto';
  reporters: Set<Reporter>;
  reportDir: string;
  thresholds: Thresholds;
  failOnSurvived: boolean;
}

const OPTIONS = {
  since: { type: 'string' },
  scope: { type: 'string' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  config: { type: 'string' },
  'jest-config': { type: 'string' },
  runner: { type: 'string' },
  'config-file': { type: 'string' },
  root: { type: 'string' },
  concurrency: { type: 'string', short: 'j' },
  reporter: { type: 'string', multiple: true },
  'report-dir': { type: 'string' },
  'fail-on-survived': { type: 'boolean' },
  'full-dry-run': { type: 'boolean' },
  arid: { type: 'boolean' },
  'experimental-callgraph': { type: 'boolean' },
  typecheck: { type: 'boolean' },
  'weak-mutation': { type: 'boolean' },
  plugin: { type: 'string', multiple: true },
  'exclude-mutator': { type: 'string', multiple: true },
  'arid-callee': { type: 'string', multiple: true },
  'threshold-break': { type: 'string' },
  'mutants-per-line': { type: 'string' },
  'time-budget': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Config key -> flag, for error messages about command line values. */
const FLAGS: Record<string, string> = {
  since: '--since',
  scope: '--scope',
  include: '--include',
  exclude: '--exclude',
  concurrency: '--concurrency',
  vitestConfig: '--config',
  jestConfig: '--jest-config',
  runner: '--runner',
  reporters: '--reporter',
  reportDir: '--report-dir',
  'thresholds.break': '--threshold-break',
  plugins: '--plugin',
  excludedMutators: '--exclude-mutator',
  mutantsPerLine: '--mutants-per-line',
  timeBudget: '--time-budget',
};

export type CliValues = ReturnType<typeof parseCli>;

export function parseCli(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowNegative: true }).values;
  } catch (error) {
    throw new ConfigError(`command line: ${(error as Error).message}`);
  }
}

/** Numeric flags stay strings when they don't parse, so validation reports them. */
function numeric(value: string | undefined): number | string | undefined {
  return value === undefined || value.trim() === '' || Number.isNaN(Number(value)) ? value : Number(value);
}

function cliConfig(values: CliValues, cwd: string): MutatorConfig {
  const entries = {
    include: values.include,
    exclude: values.exclude,
    since: values.since,
    scope: values.scope,
    concurrency: numeric(values.concurrency),
    runner: values.runner,
    vitestConfig: values.config && resolve(cwd, values.config),
    jestConfig: values['jest-config'] && resolve(cwd, values['jest-config']),
    arid: values.arid === false ? false : values['arid-callee'] ? { callees: values['arid-callee'] } : undefined,
    experimentalCallgraph: values['experimental-callgraph'],
    typecheck: values.typecheck,
    weakMutation: values['weak-mutation'],
    plugins: values.plugin,
    excludedMutators: values['exclude-mutator'],
    fullDryRun: values['full-dry-run'],
    mutantsPerLine: numeric(values['mutants-per-line']),
    timeBudget: numeric(values['time-budget']),
    reporters: values.reporter,
    reportDir: values['report-dir'] && resolve(cwd, values['report-dir']),
    thresholds: values['threshold-break'] === undefined ? undefined : { break: numeric(values['threshold-break']) },
    failOnSurvived: values['fail-on-survived'],
  };
  const config = Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined));
  fail(
    'command line',
    schemaErrors(config, configSchema, '').map((e) => e.replace(/^[\w.]+/, (key) => FLAGS[key] ?? key)),
  );
  return config as MutatorConfig;
}

export async function resolveOptions(argv: string[], cwd: string): Promise<ResolvedOptions> {
  return resolveValues(parseCli(argv), cwd);
}

export async function resolveValues(values: CliValues, cwd: string): Promise<ResolvedOptions> {
  const root = resolve(cwd, values.root ?? '.');
  const cli = cliConfig(values, cwd);
  const loaded = await loadConfig(root, values['config-file'] && resolve(cwd, values['config-file']));
  const file = loaded?.config ?? {};
  const config: MutatorConfig = { ...file, ...cli, thresholds: { ...file.thresholds, ...cli.thresholds } };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };

  const { arid } = config;
  return {
    root,
    ...(loaded ? { configPath: loaded.path } : {}),
    run: {
      scope: config.scope ?? 'node',
      ...(config.since !== undefined ? { since: config.since } : {}),
      ...(config.include ? { include: config.include } : {}),
      ...(config.exclude ? { exclude: config.exclude } : {}),
      runner: config.runner ?? 'auto',
      ...(config.vitestConfig ? { configFile: resolve(root, config.vitestConfig) } : {}),
      ...(config.jestConfig ? { jestConfigFile: resolve(root, config.jestConfig) } : {}),
      ...(config.concurrency !== undefined ? { concurrency: config.concurrency } : {}),
      fullDryRun: config.fullDryRun ?? false,
      callGraph: config.experimentalCallgraph ?? false,
      ...(arid === false ? { arid } : typeof arid === 'object' ? { arid } : {}),
      ...(config.plugins?.length ? { plugins: config.plugins } : {}),
      ...(config.weakMutation === false ? { weakMutation: false } : {}),
      ...(config.excludedMutators?.length ? { excludedMutators: config.excludedMutators } : {}),
      ...(config.mutantsPerLine !== undefined ? { mutantsPerLine: config.mutantsPerLine } : {}),
      ...(config.timeBudget !== undefined ? { timeBudget: config.timeBudget } : {}),
    },
    ...(config.typecheck !== undefined ? { typecheck: config.typecheck } : {}),
    reporters: new Set(config.reporters ?? ['text']),
    reportDir: resolve(root, config.reportDir ?? join('.mutator', 'report')),
    thresholds,
    failOnSurvived: config.failOnSurvived ?? false,
  };
}
