import { describe, expect, test } from 'vitest';
import { type RunReport, classifyRun } from '../src/classify.ts';
import { HIT_LIMIT_MESSAGE } from '../src/runtime.ts';

const HIT = `Error: ${HIT_LIMIT_MESSAGE} (1001)`;
const run = (report: Partial<RunReport>): RunReport => ({ tests: [], fileErrors: [], runErrors: [], selected: new Set(['a#x', 'a#y']), ...report });

describe('classifyRun', () => {
  test('nothing failed: survived', () => {
    expect(classifyRun(run({ tests: [{ id: 'a#x', failed: false, messages: [] }] }))).toEqual({ status: 'Survived', killedBy: [] });
  });

  test('a selected test failing kills, named once', () => {
    const tests = [
      { id: 'a#x', failed: true, messages: ['expected 1'] },
      { id: 'a#x', failed: true, messages: ['expected 1'] },
      { id: 'a#y', failed: false, messages: [] },
    ];
    expect(classifyRun(run({ tests }))).toEqual({ status: 'Killed', killedBy: ['a#x'] });
  });

  test('a test that was not selected does not count', () => {
    expect(classifyRun(run({ tests: [{ id: 'b#z', failed: true, messages: ['boom'] }] }))).toEqual({ status: 'Survived', killedBy: [] });
    expect(classifyRun(run({ tests: [{ id: 'b#z', failed: true, messages: ['boom'] }], selected: new Set() }))).toEqual({ status: 'Survived', killedBy: [] });
  });

  test('failures stopped only by the hit limit are a timeout naming no test', () => {
    const tests = [
      { id: 'a#x', failed: true, messages: [HIT] },
      { id: 'a#y', failed: true, messages: [HIT, HIT] },
    ];
    expect(classifyRun(run({ tests }))).toEqual({ status: 'Timeout', timeoutCause: 'hitLimit', killedBy: [] });
    // A file whose loading loops is stopped by it too.
    expect(classifyRun(run({ fileErrors: [{ file: 'a', message: HIT }] }))).toEqual({ status: 'Timeout', timeoutCause: 'hitLimit', killedBy: [] });
  });

  test('any other failure, or one without a message, makes it a kill', () => {
    expect(classifyRun(run({ tests: [{ id: 'a#x', failed: true, messages: [HIT] }, { id: 'a#y', failed: true, messages: ['expected 1'] }] }))).toEqual({ status: 'Killed', killedBy: ['a#x', 'a#y'] });
    expect(classifyRun(run({ tests: [{ id: 'a#x', failed: true, messages: [HIT, 'afterEach broke'] }] }))).toMatchObject({ status: 'Killed' });
    expect(classifyRun(run({ tests: [{ id: 'a#x', failed: true, messages: [] }] }))).toMatchObject({ status: 'Killed' });
    expect(classifyRun(run({ tests: [{ id: 'a#x', failed: true, messages: [HIT] }], fileErrors: [{ file: 'b', message: 'cannot load' }] }))).toEqual({ status: 'Killed', killedBy: ['a#x', 'b'] });
  });

  test('test files that fail to load with no test failing are a runtime error naming the files', () => {
    const fileErrors = [
      { file: 'a', message: 'cannot load' },
      { file: 'a', message: 'and more' },
      { file: 'b', message: 'cannot load' },
    ];
    expect(classifyRun(run({ fileErrors }))).toEqual({ status: 'RuntimeError', killedBy: ['a', 'b'] });
  });

  test('errors outside any test file are a runtime error only when nothing else failed', () => {
    expect(classifyRun(run({ runErrors: ['config broke'] }))).toEqual({ status: 'RuntimeError', killedBy: [] });
    expect(classifyRun(run({ runErrors: ['unhandled'], tests: [{ id: 'a#x', failed: true, messages: ['expected 1'] }] }))).toEqual({ status: 'Killed', killedBy: ['a#x'] });
    expect(classifyRun(run({ runErrors: ['unhandled'], tests: [{ id: 'a#x', failed: true, messages: [HIT] }] }))).toMatchObject({ status: 'Timeout', timeoutCause: 'hitLimit' });
  });
});
