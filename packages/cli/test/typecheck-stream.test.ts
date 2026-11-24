// Type checking alongside mutant execution: verdicts arrive per batch, and a job waits only for its own.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mutant } from '@mizchi/mutator-core';
import type { TypecheckBatch } from '@mizchi/mutator-typecheck';
import { afterEach, describe, expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';
import { streamTypecheck } from '../src/typecheck.ts';

const tmpRoot = fileURLToPath(new URL('../../../.tmp', import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const mutant = (n: number) => ({ key: `k${n}`, file: `/nowhere/src/m${n}.ts`, range: { start: 0, end: 1 }, replacement: 'x' }) as unknown as Mutant;
const INPUTS = { files: [], directories: [], directoryChecks: [], searches: [] };

/** A worker stand-in: releases one batch per `step()`. */
function fakeWorker(verdicts: Record<string, string>) {
  const steps: (() => void)[] = [];
  let calls = 0;
  const check = async (_options: unknown, mutants: readonly { key: string }[], { onBatch }: { onBatch?: (b: TypecheckBatch) => void } = {}) => {
    calls++;
    const errors = new Map<string, string>();
    for (const m of mutants) {
      await new Promise<void>((resolve) => steps.push(resolve));
      const batch = { keys: [m.key], errors: new Map(m.key in verdicts ? [[m.key, verdicts[m.key]!]] : []), equivalent: new Map<string, string>() };
      for (const [k, v] of batch.errors) errors.set(k, v);
      onBatch?.(batch);
    }
    return { version: 'fake', errors, equivalent: new Map<string, string>(), inputs: INPUTS };
  };
  return { check, step: () => steps.shift()?.(), calls: () => calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('streamTypecheck', () => {
  test('a verdict resolves once its batch is checked, before the whole check ends', async () => {
    const worker = fakeWorker({ k1: 'TS2322 bad' });
    const stream = streamTypecheck('/nowhere', [0, 1, 2].map(mutant), () => {}, { checkInWorker: worker.check });
    let first: unknown = 'pending';
    void stream.verdict('k1').then((v) => { first = v; });
    await flush();
    worker.step();
    await flush();
    expect(first).toBe('pending');
    worker.step();
    await flush();
    expect(first).toEqual({ status: 'CompileError' });
    worker.step();
    const done = await stream.done;
    expect([...done.errors]).toEqual([['k1', 'TS2322 bad']]);
    expect(await stream.verdict('k0')).toBeUndefined();
  });

  test('keys not given to the check, and JS files, resolve to no verdict at once', async () => {
    const worker = fakeWorker({});
    const js = { ...mutant(9), file: '/nowhere/src/m9.js' } as Mutant;
    const stream = streamTypecheck('/nowhere', [mutant(0), js], () => {}, { checkInWorker: worker.check });
    expect(await stream.verdict('unknown')).toBeUndefined();
    expect(await stream.verdict('k9')).toBeUndefined();
    worker.step();
    await stream.done;
  });

  test('a failing worker leaves every mutant to run as a test', async () => {
    const logs: string[] = [];
    const stream = streamTypecheck('/nowhere', [0, 1].map(mutant), (m) => logs.push(m), { checkInWorker: async () => { throw new Error('boom'); } });
    expect(await stream.verdict('k0')).toBeUndefined();
    const done = await stream.done;
    expect(done.errors.size).toBe(0);
    expect(done.cache).toBeUndefined();
    expect(logs).toEqual(['typecheck failed: boom; mutants that do not compile run as tests instead']);
  });

  test('without a checker, says why and runs everything', async () => {
    const logs: string[] = [];
    const stream = streamTypecheck('/nowhere', [mutant(0)], (m) => logs.push(m), { checkInWorker: async () => undefined });
    expect(await stream.verdict('k0')).toBeUndefined();
    await stream.done;
    expect(logs).toEqual([expect.stringMatching(/^typecheck skipped: needs a tsconfig\.json/)]);
  });
});

describe('a cold run type-checks alongside mutant execution', { timeout: 120_000 }, () => {
  function project(): string {
    const root = join(tmpRoot, `tcs-${process.pid}-${Math.random().toString(36).slice(2)}`);
    roots.push(root);
    const files = {
      'vitest.config.ts': `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['test/**/*.test.ts'] } });\n`,
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', allowImportingTsExtensions: true }, include: ['src'] }),
      'src/a.ts': 'export function size(o?: { n: number }): number | undefined {\n  return o?.n;\n}\nexport function clamp(n: number, max: number): number {\n  return n > max && n >= 0 ? max : n + 0;\n}\nexport function label(n: number): string {\n  return n > 0 ? "pos" : "neg";\n}\n',
      'test/a.test.ts': "import { expect, test } from 'vitest';\nimport { clamp, label, size } from '../src/a.ts';\ntest('a', () => { expect(size({ n: 1 })).toBe(1); expect(size()).toBe(undefined); expect(clamp(5, 3)).toBe(3); expect(clamp(1, 3)).toBe(1); expect(label(1)).toBe('pos'); });\n",
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return root;
  }
  const statuses = (entries: { mutant: { key: string }; status: string; source: string }[]) =>
    Object.fromEntries(entries.map((e) => [e.mutant.key, `${e.status}/${e.source}`]));

  test('same verdicts as checking first, and mutants that do not type-check never run', async () => {
    const root = project();
    const logs: string[] = [];
    const overlapped = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/a.json'), log: (m) => logs.push(m) });
    // A time budget keeps the check-first path.
    const first = await runMutation({ root, concurrency: 1, snapshotPath: join(root, '.mutator/b.json'), timeBudget: 3600 });
    const compileErrors = overlapped.entries.filter((e) => e.status === 'CompileError').length;
    expect(compileErrors).toBeGreaterThan(0);
    expect(statuses(overlapped.entries)).toEqual(statuses(first.entries));
    expect(overlapped.executed).toBe(first.executed);
    expect(logs.some((m) => /^typecheck \(TypeScript .*\): \d+ mutants in [\d.]+s, alongside mutant execution$/.test(m))).toBe(true);
  });

  test('mutants no test reaches are type-checked too: an uncompilable one is CompileError, not a gap', async () => {
    const root = project();
    writeFileSync(join(root, 'src/b.ts'), 'export function kind(n: number): "pos" | "neg" {\n  return n > 0 ? "pos" : "neg";\n}\n');
    for (const typecheck of [undefined, 3600] as const) {
      const report = await runMutation({ root, concurrency: 1, snapshotPath: join(root, `.mutator/nc-${typecheck}.json`), ...(typecheck ? { timeBudget: typecheck } : {}) });
      const uncovered = report.entries.filter((e) => e.mutant.file.endsWith('src/b.ts'));
      // "pos" -> "" does not type-check against the literal union; nothing covers src/b.ts.
      expect(uncovered.find((e) => e.mutant.original === '"pos"')?.status).toBe('CompileError');
      expect(uncovered.some((e) => e.status === 'NoCoverage')).toBe(true);
    }
  });

  test('an unchanged rerun counts cached CompileErrors as decided, not as mutants to run', async () => {
    const root = project();
    const first = await runMutation({ root, concurrency: 1 });
    const compileErrors = first.entries.filter((e) => e.status === 'CompileError').length;
    expect(compileErrors).toBeGreaterThan(0);
    const logs: string[] = [];
    const again = await runMutation({ root, concurrency: 1, log: (m) => logs.push(m) });
    expect(again.executed).toBe(0);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`, 0 to run \\(${compileErrors} decided by the cached type check\\)$`)));
    expect(logs.filter((m) => /^\[\d+\/\d+\]/.test(m))).toEqual([]);
    expect(again.entries.filter((e) => e.status === 'CompileError').length).toBe(compileErrors);
  });
});
