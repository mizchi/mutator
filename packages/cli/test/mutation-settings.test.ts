import { describe, expect, test } from 'vitest';
import { mutationSettings } from '../src/reuse.ts';

const setup = { runner: 'vitest' as const, arid: undefined, plugins: { fingerprint: null } };
const settings = (options: Record<string, unknown>) => mutationSettings({ root: '/p', ...options }, setup);

describe('mutationSettings', () => {
  // A setting that changes which mutants are placed must change the environment: mutants placed
  // only under the new setting have no cached coverage.
  test.each([
    ['skipSubsumed', { skipSubsumed: true }],
    ['skipHangs', { skipHangs: true }],
    ['minimalRelational', { minimalRelational: true }],
    ['enabledMutators', { enabledMutators: ['ArrayElement'] }],
  ])('%s changes the environment', (_name, options) => {
    expect(settings(options)).not.toBe(settings({}));
  });

  test('an absent flag and its default give the same environment', () => {
    expect(settings({ skipHangs: false, skipSubsumed: false, minimalRelational: false, enabledMutators: [] })).toBe(settings({}));
  });

  test('the order of enabled mutators does not matter', () => {
    expect(settings({ enabledMutators: ['ObjectProperty', 'ArrayElement'] })).toBe(settings({ enabledMutators: ['ArrayElement', 'ObjectProperty'] }));
  });
});
