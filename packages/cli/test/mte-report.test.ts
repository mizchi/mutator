import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mutant, MutantStatus } from '@mizchi/mutator-core';
import { Ajv } from 'ajv';
import { schema } from 'mutation-testing-report-schema';
import { describe, expect, test } from 'vitest';
import { MTE_VERSION, formatHtml, formatMutationTestingJson } from '../src/mte-report.ts';
import type { Report, ReportEntry } from '../src/run.ts';
import { TOOL_VERSION } from '../src/run.ts';

const root = mkdtempSync(join(tmpdir(), 'mutator-mte-'));
const source = 'export function add(a, b) {\n  return a + b;\n}\n';
writeFileSync(join(root, 'add.ts'), source);
writeFileSync(join(root, 'util.js'), 'export const x = 1;\n');

function entry(file: string, key: string, status: MutantStatus, extra: Partial<ReportEntry> = {}, mutant: Partial<Mutant> = {}): ReportEntry {
  return {
    mutant: {
      key,
      file: join(root, file),
      mutator: 'ArithmeticOperator',
      range: { start: 38, end: 43 },
      location: { start: { line: 2, column: 9 }, end: { line: 2, column: 14 } },
      original: 'a + b',
      replacement: 'a - b',
      scope: { id: 'add', hash: 'h', range: { start: 0, end: 46 }, location: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } } },
      ...mutant,
    },
    status,
    source: 'run',
    killedBy: [],
    coveredBy: [],
    ...extra,
  };
}

const report: Report = {
  entries: [
    entry('add.ts', 'k1', 'Killed', { killedBy: ['add.test.ts#add > sums'], coveredBy: ['add.test.ts#add > sums', 'add.test.ts#add > zero'] }),
    entry('add.ts', 'k2', 'Survived', { coveredBy: ['add.test.ts#add > zero'] }),
    entry('add.ts', 'k3', 'Ignored', { source: 'static' }, { ignored: 'disabled by comment' }),
    entry('add.ts', 'k4', 'Pending', { source: 'skipped' }),
    entry('util.js', 'k5', 'NoCoverage', { source: 'static' }, { location: { start: { line: 1, column: 17 }, end: { line: 1, column: 18 } } }),
  ],
  executed: 2,
  dryRunFiles: [],
  score: 0.5,
  durationMs: 10,
};

describe('formatMutationTestingJson', () => {
  const json = formatMutationTestingJson(report, root);

  test('validates against the published mutation-testing-report-schema', () => {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const validate = ajv.compile(schema);
    expect(validate(json), JSON.stringify(validate.errors)).toBe(true);
  });

  test('top-level metadata', () => {
    expect(json).toMatchObject({
      schemaVersion: '2',
      thresholds: { high: 80, low: 60 },
      projectRoot: root,
      framework: { name: 'mutator', version: TOOL_VERSION },
    });
  });

  test('files keyed by relative path with language and source', () => {
    expect(Object.keys(json.files).sort()).toEqual(['add.ts', 'util.js']);
    expect(json.files['add.ts']).toMatchObject({ language: 'typescript', source });
    expect(json.files['util.js']?.language).toBe('javascript');
  });

  test('mutants use 1-based columns and map statuses', () => {
    const [killed, survived, ignored, pending] = json.files['add.ts']!.mutants;
    expect(killed).toEqual({
      id: 'k1',
      mutatorName: 'ArithmeticOperator',
      replacement: 'a - b',
      location: { start: { line: 2, column: 10 }, end: { line: 2, column: 15 } },
      status: 'Killed',
      killedBy: ['add.test.ts#add > sums'],
      coveredBy: ['add.test.ts#add > sums', 'add.test.ts#add > zero'],
    });
    expect(survived?.status).toBe('Survived');
    expect(ignored).toMatchObject({ status: 'Ignored', statusReason: 'disabled by comment' });
    expect(pending?.status).toBe('Pending');
    expect(json.files['util.js']!.mutants[0]).toMatchObject({ status: 'NoCoverage', location: { start: { line: 1, column: 18 } } });
  });

  test('testFiles lists every referenced test once', () => {
    expect(json.testFiles).toEqual({
      'add.test.ts': {
        tests: [
          { id: 'add.test.ts#add > sums', name: 'add > sums' },
          { id: 'add.test.ts#add > zero', name: 'add > zero' },
        ],
      },
    });
  });
});

describe('formatHtml', () => {
  test('embeds the report and loads mutation-testing-elements from a pinned CDN url', () => {
    const json = formatMutationTestingJson(report, root);
    const html = formatHtml(json);
    expect(html).toContain(`https://www.unpkg.com/mutation-testing-elements@${MTE_VERSION}/dist/mutation-test-elements.js`);
    expect(html).toContain('<mutation-test-report-app');
    expect(html).toContain('"schemaVersion":"2"');
  });

  test('escapes `<` so sources cannot close the script tag', () => {
    const json = formatMutationTestingJson(report, root);
    json.files['add.ts']!.source = '</script><script>alert(1)</script>';
    const html = formatHtml(json);
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });
});
