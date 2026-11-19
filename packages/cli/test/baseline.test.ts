import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { formatBaselineFailure } from '../src/baseline.ts';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = join(tmpRoot, `baseline-${process.pid}-${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const config = `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n`;
  for (const [file, content] of Object.entries({ 'vitest.config.ts': config, ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

describe('formatBaselineFailure', () => {
  test('lists each failure with its first error message and a hint', () => {
    const text = formatBaselineFailure({
      failed: ['test/a.test.ts#adds', 'test/b.test.ts'],
      failures: new Map([
        ['test/a.test.ts#adds', 'AssertionError: expected 3 to be 4\n    at test/a.test.ts:3:20'],
        ['test/b.test.ts', 'Error: boom on import'],
      ]),
    });
    expect(text).toContain('tests fail without mutants (2):');
    expect(text).toContain('  test/a.test.ts#adds\n    AssertionError: expected 3 to be 4\n    at test/a.test.ts:3:20');
    expect(text).toContain('  test/b.test.ts\n    Error: boom on import');
    expect(text).toMatch(/hint: .*testTimeout/s);
  });

  test('keeps ids without a message and does not repeat a message equal to its id', () => {
    const text = formatBaselineFailure({ failed: ['x', 'Error: unhandled'], failures: new Map([['Error: unhandled', 'Error: unhandled']]) });
    expect(text).toContain('  x\n');
    expect(text.match(/Error: unhandled/g)).toHaveLength(1);
  });

  test('bounds the number of failures and the size of each message', () => {
    const failed = Array.from({ length: 30 }, (_, i) => `t#${i}`);
    const long = `Error: ${'x'.repeat(2000)}\n${Array.from({ length: 20 }, (_, i) => `    at frame${i}`).join('\n')}`;
    const text = formatBaselineFailure({ failed, failures: new Map(failed.map((id) => [id, long])) });
    expect(text).toContain('... and 20 more');
    expect(text).not.toContain('t#10\n');
    expect(text).not.toContain('frame5');
    expect(text.length).toBeLessThan(10_000);
  });

  test('strips ANSI colors from runner messages', () => {
    const text = formatBaselineFailure({ failed: ['a'], failures: new Map([['a', '\u001b[31mError: red\u001b[39m']]) });
    expect(text).toContain('    Error: red');
    expect(text).not.toContain('\u001b');
  });
});

describe('the CLI explains a failing baseline', { timeout: 120_000 }, () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test('prints the failing tests, module errors and their messages (Vitest)', () => {
    const root = project({
      'src/a.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { add } from '../src/a.ts';\ntest('adds', () => { expect(add(1, 2)).toBe(4); });\n",
      'test/b.test.ts': "import { test } from 'vitest';\nimport { add } from '../src/a.ts';\nthrow new Error('boom while importing b');\ntest('never', () => { add(1, 1); });\n",
    });
    const { status, stderr } = spawnSync(process.execPath, [cli, '--root', root, '--concurrency', '1', '--no-typecheck'], { encoding: 'utf8' });
    expect(status, stderr).toBe(4);
    expect(stderr).toContain('tests fail without mutants (2):');
    expect(stderr).toContain('test/a.test.ts#adds');
    expect(stderr).toMatch(/expected 3 to be 4/);
    expect(stderr).toContain('test/b.test.ts');
    expect(stderr).toContain('boom while importing b');
    expect(stderr).toContain('hint:');
    // Stack frames under the project are shown relative to it.
    expect(stderr).not.toContain(root);
  });
});
