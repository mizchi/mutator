import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import { describe, expect, test } from 'vitest';
import { CONFIG_KEYS, ConfigError, configSchema, defineConfig, loadConfig, validateConfig } from '../src/config.ts';

const schemaFile = join(import.meta.dirname, '../schema/mutator.config.schema.json');

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-config-'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const full = {
  $schema: './node_modules/@mizchi/mutator/schema/mutator.config.schema.json',
  include: ['lib/**/*.ts'],
  exclude: ['lib/gen/**'],
  since: 'main',
  scope: 'scope',
  concurrency: 2,
  vitestConfig: 'vitest.unit.config.ts',
  arid: { callees: ['metrics.*'] },
  experimentalCallgraph: true,
  fullDryRun: false,
  reporters: ['text', 'html'],
  reportDir: 'reports/mutation',
  thresholds: { high: 90, low: 70, break: 50 },
  failOnSurvived: true,
  typecheck: 'auto',
  mutantsPerLine: 1,
  timeBudget: 600,
};

describe('validateConfig', () => {
  test('accepts every documented field', () => {
    expect(validateConfig(full, 'mutator.config.json')).toEqual(full);
    expect(validateConfig({}, 'x')).toEqual({});
    expect(validateConfig({ arid: false, typecheck: true, thresholds: { break: null } }, 'x')).toBeTruthy();
  });

  test.each([
    [{ foo: 1 }, 'unknown key "foo"'],
    [{ include: 'src/**' }, 'include must be array'],
    [{ include: ['a', 1] }, 'include[1] must be string'],
    [{ scope: 'file' }, 'scope must be one of "node", "scope"'],
    [{ concurrency: 1.5 }, 'concurrency must be integer'],
    [{ concurrency: 0 }, 'concurrency must be >= 1'],
    [{ reporters: ['xml'] }, 'reporters[0] must be one of "text", "json", "html"'],
    [{ thresholds: { break: '50' } }, 'thresholds.break must be number | null'],
    [{ thresholds: { high: 120 } }, 'thresholds.high must be <= 100'],
    [{ thresholds: { medium: 1 } }, 'unknown key "thresholds.medium"'],
    [{ arid: { callee: [] } }, 'unknown key "arid.callee"'],
    [{ arid: 'off' }, 'arid must be boolean | object'],
    [{ typecheck: 'yes' }, 'typecheck must be one of true, false, "auto"'],
    [[], 'config must be object'],
  ])('rejects %j', (input, message) => {
    expect(() => validateConfig(input, 'mutator.config.json')).toThrow(ConfigError);
    expect(() => validateConfig(input, 'mutator.config.json')).toThrow(`mutator.config.json: ${message}`);
  });

  test('reports high < low', () => {
    expect(() => validateConfig({ thresholds: { high: 50, low: 60 } }, 'c')).toThrow('c: thresholds.high (50) must be >= thresholds.low (60)');
  });

  test('defineConfig is an identity helper', () => {
    expect(defineConfig({ since: 'main' })).toEqual({ since: 'main' });
  });
});

describe('loadConfig', () => {
  test('no config file', async () => {
    expect(await loadConfig(project({}))).toBeUndefined();
  });

  test('mutator.config.json', async () => {
    const root = project({ 'mutator.config.json': JSON.stringify({ since: 'main' }) });
    expect(await loadConfig(root)).toEqual({ path: join(root, 'mutator.config.json'), config: { since: 'main' } });
  });

  test('mutator.config.ts with defineConfig', async () => {
    const index = pathToFileURL(join(import.meta.dirname, '../src/index.ts')).href;
    const root = project({
      'mutator.config.ts': `import { defineConfig } from '${index}';\nconst n: number = 3;\nexport default defineConfig({ concurrency: n });\n`,
    });
    expect((await loadConfig(root))?.config).toEqual({ concurrency: 3 });
  });

  test('mutator.config.mjs and .js', async () => {
    expect((await loadConfig(project({ 'mutator.config.mjs': 'export default { scope: "scope" };' })))?.config).toEqual({ scope: 'scope' });
    const js = project({ 'package.json': '{"type":"module"}', 'mutator.config.js': 'export default { fullDryRun: true };' });
    expect((await loadConfig(js))?.config).toEqual({ fullDryRun: true });
  });

  test('explicit path wins over the root lookup', async () => {
    const root = project({ 'mutator.config.json': '{"since":"a"}', 'conf/ci.json': '{"since":"b"}' });
    expect((await loadConfig(root, join(root, 'conf/ci.json')))?.config).toEqual({ since: 'b' });
  });

  test('errors name the file', async () => {
    const root = project({ 'mutator.config.json': '{"since": 1}' });
    await expect(loadConfig(root)).rejects.toThrow('mutator.config.json: since must be string');
    await expect(loadConfig(project({ 'mutator.config.json': '{' }))).rejects.toThrow(/mutator\.config\.json: invalid JSON/);
    await expect(loadConfig(root, join(root, 'missing.json'))).rejects.toThrow(/config file not found/);
    await expect(loadConfig(project({ 'mutator.config.mjs': 'export const x = 1;' }))).rejects.toThrow('mutator.config.mjs: config must be object');
  });
});

describe('JSON schema', () => {
  const published = JSON.parse(readFileSync(schemaFile, 'utf8'));

  test('schema file matches the schema the validator uses (UPDATE_SCHEMA=1 to regenerate)', () => {
    if (process.env.UPDATE_SCHEMA) writeFileSync(schemaFile, `${JSON.stringify(configSchema, null, 2)}\n`);
    expect(JSON.parse(readFileSync(schemaFile, 'utf8'))).toEqual(configSchema);
  });

  test('schema properties are exactly the MutatorConfig keys', () => {
    expect(Object.keys(published.properties).sort()).toEqual([...CONFIG_KEYS].sort());
  });

  test('ajv agrees with the validator', () => {
    const validate = new Ajv({ strict: true }).compile(published);
    expect(validate(full), JSON.stringify(validate.errors)).toBe(true);
    for (const bad of [{ foo: 1 }, { scope: 'file' }, { thresholds: { break: '1' } }, { arid: { callee: [] } }]) expect(validate(bad)).toBe(false);
  });
});
