// mutator.config.{ts,mjs,js,json}: same fields as the CLI flags, validated against
// `configSchema` (also published as schema/mutator.config.schema.json).
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Reporter = 'text' | 'json' | 'html';

export interface Thresholds {
  /** Score (%) at or above which the result is "high". */
  high: number;
  /** Score (%) at or above which the result is "low"; below it is "danger". */
  low: number;
  /** Exit 2 when the score (%) is below this; `null` disables the gate. */
  break: number | null;
}

export interface MutatorConfig {
  $schema?: string;
  include?: string[];
  exclude?: string[];
  since?: string;
  scope?: 'node' | 'scope';
  concurrency?: number;
  /** Test runner (default 'auto': vitest or jest, from the project's config files / dependencies). */
  runner?: 'vitest' | 'jest' | 'auto';
  /** Vitest config file, relative to the project root. */
  vitestConfig?: string;
  /** Jest config file, relative to the project root (experimental Jest support). */
  jestConfig?: string;
  arid?: boolean | { callees?: string[] };
  experimentalCallgraph?: boolean;
  fullDryRun?: boolean;
  reporters?: Reporter[];
  /** Relative to the project root. */
  reportDir?: string;
  thresholds?: Partial<Thresholds>;
  failOnSurvived?: boolean;
  typecheck?: boolean | 'auto';
  /** Plugin modules: paths relative to the root, or package names. */
  plugins?: string[];
  /** Mutators to skip (built-in or custom names). */
  excludedMutators?: string[];
  /** Run at most this many mutants per source line (most productive mutators first); default unlimited. */
  mutantsPerLine?: number;
  /** Seconds from the start of the run after which no new mutant run starts; default unlimited. */
  timeBudget?: number;
}

/** Typing helper for mutator.config.ts. */
export function defineConfig(config: MutatorConfig): MutatorConfig {
  return config;
}

export const DEFAULT_THRESHOLDS: Thresholds = { high: 80, low: 60, break: null };

export const CONFIG_FILES = ['mutator.config.ts', 'mutator.config.mts', 'mutator.config.mjs', 'mutator.config.js', 'mutator.config.json'];

export class ConfigError extends Error {}

/** The subset of JSON Schema the validator understands. */
export interface Schema {
  $schema?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  additionalProperties?: false;
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
}

const strings = (description: string): Schema => ({ description, type: 'array', items: { type: 'string' } });
const percent = (description: string, type: string | string[] = 'number'): Schema => ({ description, type, minimum: 0, maximum: 100 });

const properties = {
  $schema: { type: 'string' },
  include: strings('Globs (relative to the root) of sources to mutate.'),
  exclude: strings('Globs of sources to skip.'),
  since: { description: 'Git ref: only run mutants inside `git diff <since>`.', type: 'string' },
  scope: { description: 'Diff granularity: changed nodes, or whole enclosing functions.', enum: ['node', 'scope'] },
  concurrency: { description: 'Parallel test-runner sessions.', type: 'integer', minimum: 1 },
  runner: { description: 'Test runner; auto picks vitest or jest from config files and installed packages.', enum: ['vitest', 'jest', 'auto'] },
  vitestConfig: { description: 'Vitest config file, relative to the root.', type: 'string' },
  jestConfig: { description: 'Jest config file, relative to the root (experimental, native ESM only).', type: 'string' },
  arid: {
    description: 'Arid (logging-only) code suppression: false runs those mutants too; callees replaces the logging call patterns.',
    anyOf: [{ type: 'boolean' }, { type: 'object', additionalProperties: false, properties: { callees: strings('Logging call patterns, e.g. "metrics.*".') } }],
  },
  experimentalCallgraph: { description: 'Re-run only survivors connected to changed code in the static call graph.', type: 'boolean' },
  fullDryRun: { description: 'Collect coverage from every test file.', type: 'boolean' },
  reporters: { description: 'Reporters to run.', type: 'array', items: { enum: ['text', 'json', 'html'] } },
  reportDir: { description: 'Where json/html reports go, relative to the root.', type: 'string' },
  thresholds: {
    description: 'Mutation score thresholds in percent.',
    type: 'object',
    additionalProperties: false,
    properties: {
      high: percent('Score at or above which the result is high (default 80).'),
      low: percent('Score at or above which the result is low; below is danger (default 60).'),
      break: percent('Exit 2 when the score is below this (default null: never).', ['number', 'null']),
    },
  },
  failOnSurvived: { description: 'Exit 2 when a mutant survives.', type: 'boolean' },
  typecheck: { description: 'Type-check mutants before running them.', enum: [true, false, 'auto'] },
  plugins: strings('Plugin modules (relative paths or package names) providing custom mutators.'),
  excludedMutators: strings('Mutators to skip, built-in or custom, by name.'),
  mutantsPerLine: { description: 'Run at most this many mutants per source line, most productive mutators first (default: unlimited).', type: 'integer', minimum: 1 },
  timeBudget: { description: 'Seconds from the start of the run after which no new mutant run starts; the rest stay pending (default: unlimited).', type: 'number', minimum: 0 },
} satisfies Record<keyof MutatorConfig, Schema>;

export const CONFIG_KEYS = Object.keys(properties) as (keyof MutatorConfig)[];

export const configSchema: Schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'mutator config',
  type: 'object',
  additionalProperties: false,
  properties,
};

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function describe(schema: Schema): string {
  if (schema.enum) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`;
  if (schema.anyOf) return schema.anyOf.map(describe).join(' | ');
  return [schema.type ?? 'any'].flat().join(' | ');
}

/** Errors as `path message`, e.g. `thresholds.break must be number | null`. */
export function schemaErrors(value: unknown, schema: Schema, path: string): string[] {
  const at = path || 'config';
  if (schema.anyOf) {
    const branches = schema.anyOf.map((s) => schemaErrors(value, s, path));
    if (branches.some((e) => e.length === 0)) return [];
    const sameType = schema.anyOf.findIndex((s) => s.type !== undefined && schemaErrors(value, { type: s.type }, path).length === 0);
    return sameType >= 0 ? branches[sameType]! : [`${at} must be ${describe(schema)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) return [`${at} must be ${describe(schema)}`];
  if (schema.type) {
    const actual = typeOf(value);
    const ok = [schema.type].flat().some((t) => t === actual || (t === 'number' && actual === 'integer'));
    if (!ok) return [`${at} must be ${describe(schema)}`];
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return [`${at} must be >= ${schema.minimum}`];
    if (schema.maximum !== undefined && value > schema.maximum) return [`${at} must be <= ${schema.maximum}`];
  }
  if (Array.isArray(value) && schema.items) {
    const items = schema.items;
    return value.flatMap((v, i) => schemaErrors(v, items, `${path}[${i}]`));
  }
  if (typeOf(value) === 'object' && schema.properties) {
    const props = schema.properties;
    return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
      const sub = props[key];
      const keyPath = path ? `${path}.${key}` : key;
      if (!sub) return schema.additionalProperties === false ? [`unknown key "${keyPath}"`] : [];
      return schemaErrors(v, sub, keyPath);
    });
  }
  return [];
}

export function thresholdErrors(thresholds: Partial<Thresholds> | undefined): string[] {
  const { high, low } = { ...DEFAULT_THRESHOLDS, ...thresholds };
  return high < low ? [`thresholds.high (${high}) must be >= thresholds.low (${low})`] : [];
}

export function fail(source: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new ConfigError(errors.map((e) => `${source}: ${e}`).join('\n'));
}

export function validateConfig(value: unknown, source: string): MutatorConfig {
  const errors = schemaErrors(value, configSchema, '');
  fail(source, errors.length > 0 ? errors : thresholdErrors((value as MutatorConfig).thresholds));
  return value as MutatorConfig;
}

/** Loads `file` (or the first CONFIG_FILES entry present in `root`). */
export async function loadConfig(root: string, file?: string): Promise<{ path: string; config: MutatorConfig } | undefined> {
  const path = file ?? CONFIG_FILES.map((name) => join(root, name)).find((p) => existsSync(p));
  if (!path) return undefined;
  if (!existsSync(path)) throw new ConfigError(`config file not found: ${path}`);
  const name = basename(path);
  let raw: unknown;
  if (path.endsWith('.json')) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new ConfigError(`${name}: invalid JSON (${(error as Error).message})`);
    }
  } else {
    // Node 24 strips types from .ts; `export default` holds the config.
    raw = ((await import(pathToFileURL(path).href)) as { default?: unknown }).default;
  }
  return { path, config: validateConfig(raw, name) };
}
