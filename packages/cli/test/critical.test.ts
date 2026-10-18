import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type AgentReport, formatAgentReport } from '../src/agent-report.ts';
import { criticalMutants } from '../src/critical.ts';
import { qualityGate } from '../src/gate.ts';
import { formatMutationTestingJson } from '../src/mte-report.ts';
import { formatAnnotations, formatSummary } from '../src/report.ts';
import type { Report, ReportEntry } from '../src/run.ts';

const thresholds = { high: 80, low: 60, break: null };
const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } };

function entry(key: string, file: string, status: ReportEntry['status'], extra: Partial<ReportEntry> & { critical?: true } = {}): ReportEntry {
  const { critical, ...rest } = extra;
  return {
    mutant: {
      key,
      file,
      mutator: 'ArithmeticOperator',
      range: { start: 0, end: 1 },
      location,
      original: 'a + b',
      replacement: 'a - b',
      scope: { id: 's', hash: 'h', range: { start: 0, end: 1 }, location },
      ...(critical ? { critical } : {}),
    },
    status,
    source: 'run',
    killedBy: [],
    coveredBy: [],
    ...rest,
  };
}

function report(entries: ReportEntry[], extra: Partial<Report> = {}): Report {
  return { entries, executed: entries.length, dryRunFiles: [], scope: 'all', score: 0.5, durationMs: 1, notRun: { sampled: 0, budget: 0 }, ...extra };
}

describe('criticalMutants', () => {
  test('mutants in files matching a glob (relative to the root), or marked by a comment', () => {
    const entries = [
      entry('auth', '/p/src/auth/login.ts', 'Survived'),
      entry('deep', '/p/src/auth/deep/token.ts', 'Killed'),
      entry('other', '/p/src/util.ts', 'Survived'),
      entry('marked', '/p/src/util.ts', 'Survived', { critical: true }),
    ];
    expect(criticalMutants(entries, '/p', ['src/auth/**'])).toEqual(['auth', 'deep', 'marked']);
    expect(criticalMutants(entries, '/p', [])).toEqual(['marked']);
  });
});

describe('qualityGate with critical regions', () => {
  const gate = (r: Report, failOnSurvived = false) => qualityGate(r, { thresholds, failOnSurvived });

  test('any undetected critical mutant fails, whatever the thresholds and --fail-on-survived', () => {
    const r = report([entry('a', '/p/a.ts', 'Survived'), entry('b', '/p/a.ts', 'NoCoverage'), entry('c', '/p/a.ts', 'Survived', { reason: 'notInfected' }), entry('d', '/p/b.ts', 'Survived')], {
      criticalMutants: ['a', 'b', 'c'],
    });
    expect(gate(r)).toEqual(['3 undetected mutant(s) in critical regions: each must be killed or accepted']);
  });

  test('killed, accepted, compile errors and ignored mutants pass', () => {
    const r = report(
      [
        entry('a', '/p/a.ts', 'Killed'),
        entry('b', '/p/a.ts', 'Ignored', { accepted: 'equivalent' }),
        entry('d', '/p/a.ts', 'CompileError'),
        entry('e', '/p/a.ts', 'Ignored'),
        entry('f', '/p/a.ts', 'Timeout'),
      ],
      { criticalMutants: ['a', 'b', 'd', 'e', 'f'] },
    );
    expect(gate(r)).toEqual([]);
  });

  test('a critical mutant left pending (time budget, sampling) fails: every one must run', () => {
    const r = report([entry('a', '/p/a.ts', 'Killed'), entry('c', '/p/a.ts', 'Pending')], { criticalMutants: ['a', 'c'] });
    expect(gate(r)).toEqual(['1 mutant(s) in critical regions not run (--time-budget, --mutants-per-line): each must run']);
    // Outside --since, a pending mutant is not reported, so it does not count.
    const since = report([entry('a', '/p/a.ts', 'Killed', { focus: 'diff' }), entry('c', '/p/a.ts', 'Pending')], { scope: 'diff', criticalMutants: ['a', 'c'] });
    expect(gate(since)).toEqual([]);
  });

  test('mutants possibly reached in a child process still count', () => {
    const r = report([entry('a', '/p/a.ts', 'Survived')], { criticalMutants: ['a'], childProcessMutants: ['a'] });
    expect(gate(r)).toEqual(['1 undetected mutant(s) in critical regions: each must be killed or accepted']);
    // ...while --fail-on-survived does not count them.
    expect(gate(report([entry('a', '/p/a.ts', 'Survived')], { childProcessMutants: ['a'] }), true)).toEqual([]);
  });

  test('with --since, only the reported mutants count', () => {
    const r = report([entry('a', '/p/a.ts', 'Survived'), entry('b', '/p/a.ts', 'Survived', { focus: 'diff' }), entry('c', '/p/a.ts', 'Killed', { focus: 'diff' })], {
      scope: 'diff',
      criticalMutants: ['a', 'c'],
    });
    expect(gate(r)).toEqual([]);
    expect(gate({ ...r, criticalMutants: ['a', 'b'] })).toEqual(['1 undetected mutant(s) in critical regions: each must be killed or accepted']);
  });
});

describe('reports', () => {
  const r = report(
    [
      entry('k', '/p/src/auth.ts', 'Killed'),
      entry('s', '/p/src/auth.ts', 'Survived'),
      entry('acc', '/p/src/auth.ts', 'Ignored', { accepted: 'log message only' }),
      entry('o', '/p/src/util.ts', 'Survived'),
    ],
    { criticalMutants: ['k', 's', 'acc'] },
  );

  test('the summary has a critical line and lists the undetected critical mutants first', () => {
    const summary = formatSummary(r, '/p', thresholds);
    expect(summary).toContain('critical regions: 50.0% (1 detected, 1 undetected, 1 accepted)');
    const lines = summary.split('\n');
    const critical = lines.indexOf('undetected in critical regions - kill or accept each:');
    const notDetected = lines.indexOf('not detected - tests run it, but none fails:');
    expect(critical).toBeGreaterThan(0);
    expect(critical).toBeLessThan(notDetected);
    expect(lines[critical + 1]).toContain('src/auth.ts:1:1');
    // Not listed twice.
    expect(lines[notDetected + 1]).toContain('src/util.ts');
    expect(lines[notDetected + 2]).toBe('');
    expect(summary).toContain('accepted in critical regions:');
    expect(summary).toContain('(log message only)');
  });

  test('the critical line counts the mutants left pending', () => {
    const pending = report([entry('k', '/p/src/auth.ts', 'Killed'), entry('p', '/p/src/auth.ts', 'Pending')], { criticalMutants: ['k', 'p'] });
    expect(formatSummary(pending, '/p', thresholds)).toContain('critical regions: 100.0% (1 detected, 0 undetected, 0 accepted, 1 not run)');
  });

  test('on GitHub, undetected critical mutants are errors, the others stay warnings', () => {
    const annotations = formatAnnotations(r, '/p').split('\n');
    expect(annotations.filter((a) => a.startsWith('::error ')).map((a) => /file=([^,]+).*title=([^:]+)::/.exec(a)?.slice(1))).toEqual([['src/auth.ts', 'Critical mutant not detected']]);
    expect(annotations.filter((a) => a.startsWith('::warning ')).map((a) => /file=([^,]+).*title=([^:]+)::/.exec(a)?.slice(1))).toEqual([['src/util.ts', 'Mutant not detected']]);
  });

  test('an unreached critical mutant is annotated even in a full run, where unreached code is not', () => {
    const full = report([entry('n', '/p/src/auth.ts', 'NoCoverage'), entry('m', '/p/src/util.ts', 'NoCoverage')], { criticalMutants: ['n'] });
    expect(formatAnnotations(full, '/p').split('\n').map((a) => /title=([^:]+)::/.exec(a)?.[1])).toEqual(['Critical mutant not reached']);
  });

  test('no critical line without critical mutants', () => {
    expect(formatSummary(report([entry('o', '/p/src/util.ts', 'Survived')]), '/p', thresholds)).not.toContain('critical');
  });

  test('agent gaps carry critical: true', () => {
    const gaps = formatAgentReport({ ...r, entries: r.entries.map((e) => ({ ...e, mutant: { ...e.mutant, file: import.meta.filename } })) }, '/').gaps;
    expect(gaps.map((g) => [g.key, g.critical])).toEqual([
      ['s', true],
      ['o', undefined],
    ]);
  });

  test('mutation.json mentions it in statusReason', () => {
    const json = formatMutationTestingJson({ ...r, entries: r.entries.map((e) => ({ ...e, mutant: { ...e.mutant, file: import.meta.filename } })) }, '/', thresholds);
    const mutants = Object.values(json.files).flatMap((f) => f.mutants);
    expect(mutants.find((m) => m.id === 's')?.statusReason).toBe('critical region: must be killed or accepted');
    expect(mutants.find((m) => m.id === 'o')?.statusReason).toBeUndefined();
    expect(mutants.find((m) => m.id === 'k')?.statusReason).toBeUndefined();
    expect(mutants.find((m) => m.id === 'acc')?.statusReason).toBe('accepted: log message only');
  });
});

describe('mutator with critical regions (e2e)', () => {
  const cli = join(import.meta.dirname, '../src/cli.ts');
  const run = (...args: string[]) => {
    const { GITHUB_ACTIONS: _, ...env } = process.env;
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
  };

  test('a survivor in a critical region exits 2 until it is accepted', () => {
    // Inside the workspace so the fixture resolves `vitest` from the root node_modules.
    const root = join(import.meta.dirname, '../../../.tmp', `critical-${process.pid}`);
    cpSync(join(import.meta.dirname, 'fixtures/critical'), root, { recursive: true });
    try {
      const first = run('--root', root, '-j', '1', '--reporter', 'agent');
      expect(first.status, first.stderr).toBe(2);
      expect(first.stderr).toMatch(/quality gate failed: \d+ undetected mutant\(s\) in critical regions/);
      const { gaps } = JSON.parse(first.stdout) as AgentReport;
      const critical = gaps.filter((g) => g.critical);
      // The glob (src/auth/**) and the comment (`total` in src/price.js) mark mutants; `label` stays outside.
      expect(new Set(critical.map((g) => g.file))).toEqual(new Set(['src/auth/roles.js', 'src/price.js']));
      expect(critical.filter((g) => g.file === 'src/price.js').every((g) => g.line <= 4)).toBe(true);
      expect(gaps.some((g) => !g.critical && g.file === 'src/price.js')).toBe(true);

      const accepted = run('accept', ...critical.map((g) => g.key), '--reason', 'covered elsewhere', '--root', root);
      expect(accepted.status, accepted.stderr).toBe(0);

      // Survivors outside the critical regions do not fail the run.
      const second = run('--root', root, '-j', '1');
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/critical regions: [\d.]+% \(\d+ detected, 0 undetected, \d+ accepted\)/);
      expect(second.stdout).toContain('accepted in critical regions:');
      expect(second.stdout).toContain('(covered elsewhere)');
      expect(second.stdout).toContain('not detected - tests run it, but none fails:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
