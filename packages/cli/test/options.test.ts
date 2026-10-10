import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { resolveOptions } from '../src/options.ts';

function project(config?: object): string {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-options-'));
  if (config) writeFileSync(join(dir, 'mutator.config.json'), JSON.stringify(config));
  return dir;
}

const resolve = (root: string, ...argv: string[]) => resolveOptions(['--root', root, ...argv], root);

describe('resolveOptions', () => {
  test('defaults', async () => {
    const root = project();
    const options = await resolve(root);
    expect(options).toMatchObject({
      root,
      reporters: new Set(['text']),
      reportDir: join(root, '.mutator', 'report'),
      thresholds: { high: 80, low: 60, break: null },
      failOnSurvived: false,
      run: { scope: 'node', fullDryRun: false, callGraph: false },
    });
    expect(options.configPath).toBeUndefined();
    expect(options.typecheck).toBeUndefined();
  });

  test('config file fields map onto run options', async () => {
    const root = project({
      include: ['lib/**'],
      exclude: ['lib/x.ts'],
      since: 'main',
      scope: 'scope',
      concurrency: 3,
      vitestConfig: 'vitest.unit.ts',
      arid: { callees: ['metrics.*'] },
      experimentalCallgraph: true,
      fullDryRun: true,
      reporters: ['json'],
      reportDir: 'out',
      thresholds: { break: 70 },
      failOnSurvived: true,
      typecheck: 'auto',
    });
    const options = await resolve(root);
    expect(options).toMatchObject({
      configPath: join(root, 'mutator.config.json'),
      reporters: new Set(['json']),
      reportDir: join(root, 'out'),
      thresholds: { high: 80, low: 60, break: 70 },
      failOnSurvived: true,
      typecheck: 'auto',
      run: {
        include: ['lib/**'],
        exclude: ['lib/x.ts'],
        since: 'main',
        scope: 'scope',
        concurrency: 3,
        configFile: join(root, 'vitest.unit.ts'),
        arid: { callees: ['metrics.*'] },
        callGraph: true,
        fullDryRun: true,
      },
    });
  });

  test('typecheck: config value, overridden by --no-typecheck', async () => {
    const root = project({ typecheck: true });
    expect((await resolve(root)).typecheck).toBe(true);
    expect((await resolve(root, '--no-typecheck')).typecheck).toBe(false);
    expect((await resolve(project())).typecheck).toBeUndefined();
  });

  test('CLI flags override the config file', async () => {
    const root = project({ since: 'main', scope: 'scope', reporters: ['json'], failOnSurvived: true, arid: false, thresholds: { break: 70, high: 95 } });
    const options = await resolve(root, '--since', 'dev', '--scope', 'node', '--reporter', 'html', '--no-fail-on-survived', '--arid-callee', 'x.*', '--threshold-break', '40');
    expect(options).toMatchObject({
      reporters: new Set(['html']),
      failOnSurvived: false,
      thresholds: { high: 95, low: 60, break: 40 },
      run: { since: 'dev', scope: 'node', arid: { callees: ['x.*'] } },
    });
  });

  test('--no-arid still disables arid suppression', async () => {
    expect((await resolve(project(), '--no-arid')).run.arid).toBe(false);
  });

  test('--config-file picks an explicit config', async () => {
    const root = project({ since: 'a' });
    writeFileSync(join(root, 'ci.json'), '{"since":"b"}');
    const options = await resolve(root, '--config-file', join(root, 'ci.json'));
    expect(options.run.since).toBe('b');
    expect(options.configPath).toBe(join(root, 'ci.json'));
  });

  test('invalid flags are ConfigErrors naming the flag', async () => {
    const root = project();
    await expect(resolve(root, '--scope', 'file')).rejects.toThrow(ConfigError);
    await expect(resolve(root, '--scope', 'file')).rejects.toThrow('command line: --scope must be one of "node", "scope"');
    await expect(resolve(root, '--reporter', 'xml')).rejects.toThrow('--reporter[0] must be one of');
    await expect(resolve(root, '-j', 'many')).rejects.toThrow('--concurrency must be integer');
    await expect(resolve(root, '--threshold-break', 'x')).rejects.toThrow('--threshold-break must be number');
    await expect(resolve(root, '--bogus')).rejects.toThrow(ConfigError);
  });

  test('merged thresholds stay consistent', async () => {
    await expect(resolve(project({ thresholds: { low: 90 } }))).rejects.toThrow('thresholds.high (80) must be >= thresholds.low (90)');
  });
});

describe('runner options', () => {
  test('runner and jestConfig from the config file; --runner overrides', async () => {
    const root = project({ runner: 'jest', jestConfig: 'jest.unit.js' });
    expect((await resolve(root)).run).toMatchObject({ runner: 'jest', jestConfigFile: join(root, 'jest.unit.js') });
    expect((await resolve(root, '--runner', 'vitest')).run.runner).toBe('vitest');
    expect((await resolve(project())).run.runner).toBe('auto');
  });

  test('an unknown runner is a ConfigError', async () => {
    await expect(resolve(project(), '--runner', 'mocha')).rejects.toThrow('--runner must be one of "vitest", "jest", "auto"');
  });
});

describe('plugins options', () => {
  test('config plugins / excludedMutators reach run options; CLI flags override', async () => {
    const root = project({ plugins: ['./a.ts'], excludedMutators: ['Regex'] });
    expect((await resolve(root)).run).toMatchObject({ plugins: ['./a.ts'], excludedMutators: ['Regex'] });
    expect((await resolve(root, '--plugin', './b.ts', '--exclude-mutator', 'FnValue')).run).toMatchObject({ plugins: ['./b.ts'], excludedMutators: ['FnValue'] });
  });
});

describe('large-run options', () => {
  test('mutantsPerLine / timeBudget from the config file; flags override', async () => {
    const root = project({ mutantsPerLine: 2, timeBudget: 300 });
    expect((await resolve(root)).run).toMatchObject({ mutantsPerLine: 2, timeBudget: 300 });
    expect((await resolve(root, '--mutants-per-line', '1', '--time-budget', '600')).run).toMatchObject({ mutantsPerLine: 1, timeBudget: 600 });
    const defaults = (await resolve(project())).run;
    expect(defaults.mutantsPerLine).toBeUndefined();
    expect(defaults.timeBudget).toBeUndefined();
  });

  test('invalid values are ConfigErrors naming the flag', async () => {
    const root = project();
    await expect(resolve(root, '--mutants-per-line', '0')).rejects.toThrow('--mutants-per-line must be >= 1');
    await expect(resolve(root, '--mutants-per-line', '1.5')).rejects.toThrow('--mutants-per-line must be integer');
    await expect(resolve(root, '--time-budget=-1')).rejects.toThrow('--time-budget must be >= 0');
    await expect(resolve(root, '--time-budget', 'soon')).rejects.toThrow('--time-budget must be number');
  });
});

describe('runner config files', () => {
  test('--config is the vitest config and --jest-config the jest config', async () => {
    const root = project();
    const options = await resolve(root, '--config', 'vitest.unit.ts', '--jest-config', 'jest.unit.mjs');
    expect(options.run).toMatchObject({ configFile: `${root}/vitest.unit.ts`, jestConfigFile: `${root}/jest.unit.mjs` });
  });
});

describe('weak mutation option', () => {
  test('config weakMutation: false, and --no-weak-mutation', async () => {
    expect((await resolve(project({ weakMutation: false }))).run).toMatchObject({ weakMutation: false });
    expect((await resolve(project(), '--no-weak-mutation')).run).toMatchObject({ weakMutation: false });
    expect((await resolve(project())).run.weakMutation).toBeUndefined();
  });
});
