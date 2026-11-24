import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { snapshotFiles } from '../src/snapshot-store.ts';

const root = '/p';
const defaults = [join(root, '.mutator/scopes/snapshot.json'), join(root, '.mutator/snapshot.json')];

describe('snapshot scopes', () => {
  test('no include / exclude: the default scope', () => {
    expect(snapshotFiles(root, { root })).toEqual(defaults);
  });

  test('the default include written out is still the default scope', () => {
    expect(snapshotFiles(root, { root, include: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'] })).toEqual(defaults);
    expect(snapshotFiles(root, { root, include: ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'], exclude: [] })).toEqual(defaults);
  });

  test('another include, or an exclude, is its own scope', () => {
    expect(snapshotFiles(root, { root, include: ['src/**/*.ts'] })[0]).not.toBe(defaults[0]);
    expect(snapshotFiles(root, { root, exclude: ['src/gen/**'] })[0]).not.toBe(defaults[0]);
  });
});
