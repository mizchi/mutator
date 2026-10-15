import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { acceptMutants, applyAcceptance, readAccepted } from '../src/accepted.ts';
import type { ReportEntry } from '../src/run.ts';

const entry = (key: string, status: ReportEntry['status']) => ({ mutant: { key }, status, source: 'run', killedBy: [], coveredBy: [] }) as unknown as ReportEntry;

describe('applyAcceptance', () => {
  const accepted = new Map([
    ['s', 'equivalent: never nullish'],
    ['n', 'unreachable guard'],
    ['k', 'thought equivalent'],
    ['p', 'out of the diff'],
    ['gone', 'removed code'],
  ]);
  const entries = [entry('s', 'Survived'), entry('n', 'NoCoverage'), entry('k', 'Killed'), entry('p', 'Pending'), entry('other', 'Survived')];
  const result = applyAcceptance(entries, accepted);

  test('accepted undetected mutants become Ignored with their reason', () => {
    expect(result.entries.map((e) => [e.mutant.key, e.status, e.accepted])).toEqual([
      ['s', 'Ignored', 'equivalent: never nullish'],
      ['n', 'Ignored', 'unreachable guard'],
      ['k', 'Killed', undefined],
      ['p', 'Pending', undefined],
      ['other', 'Survived', undefined],
    ]);
  });

  test('lists accepted mutants that are killed now, and entries whose mutant no longer exists', () => {
    expect(result.killed).toEqual(['k']);
    expect(result.stale).toEqual(['gone']);
  });

  test('does not change the given entries', () => {
    expect(entries[0]!.status).toBe('Survived');
  });
});

describe('accepted file', () => {
  test('a missing file accepts nothing', () => {
    expect(readAccepted(join(mkdtempSync(join(tmpdir(), 'mutator-acc-')), 'mutator.accepted.json')).size).toBe(0);
  });

  test('acceptMutants adds entries, keeps the others and sorts by key', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mutator-acc-')), 'mutator.accepted.json');
    writeFileSync(file, JSON.stringify({ b: { reason: 'old' } }));
    acceptMutants(file, ['c', 'a'], 'equivalent', new Map([['a', 'src/a.ts:3:1 a?.b -> a.b']]));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      a: { reason: 'equivalent', where: 'src/a.ts:3:1 a?.b -> a.b' },
      b: { reason: 'old' },
      c: { reason: 'equivalent' },
    });
    expect(readAccepted(file)).toEqual(new Map([['a', 'equivalent'], ['b', 'old'], ['c', 'equivalent']]));
  });

  test('an invalid file is an error naming the file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mutator-acc-')), 'mutator.accepted.json');
    writeFileSync(file, JSON.stringify({ a: 'no reason object' }));
    expect(() => readAccepted(file)).toThrow(/mutator\.accepted\.json: a: expected \{ "reason": string \}/);
  });
});
