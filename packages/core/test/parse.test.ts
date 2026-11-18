import { parseSync } from 'oxc-parser';
import vm from 'node:vm';
import { expect, test } from 'vitest';
import { createParser } from '../src/parse.ts';

test.each([
  new RangeError('Array buffer allocation failed'),
  vm.runInNewContext("new RangeError('Array buffer allocation failed')"),
])('falls back after raw-transfer allocation failure across realms (%#)', (failure) => {
  const calls: boolean[] = [];
  const parse = createParser((file, source, options) => {
    const raw = (options as { experimentalRawTransfer?: boolean } | undefined)?.experimentalRawTransfer === true;
    calls.push(raw);
    if (raw) throw failure;
    return parseSync(file, source, options);
  }, true, 'linux');
  expect(parse('a.ts', 'export const a = 1;').errors).toEqual([]);
  expect(parse('b.ts', 'export const b = 2;').program.body).toHaveLength(1);
  expect(calls).toEqual([true, false, false]);
});

test('does not swallow unrelated parser exceptions', () => {
  const failure = new Error('parser failed');
  const parse = createParser(() => { throw failure; }, true);
  expect(() => parse('a.ts', '')).toThrow(failure);
});

test.each(['win32', 'linux', 'darwin'] as const)('avoids the large raw-transfer reservation on Windows (%s)', (platform) => {
  const calls: boolean[] = [];
  const parse = createParser((file, source, options) => {
    calls.push((options as { experimentalRawTransfer?: boolean } | undefined)?.experimentalRawTransfer === true);
    return parseSync(file, source);
  }, true, platform);
  expect(parse('a.ts', 'export const a = 1;').errors).toEqual([]);
  expect(calls).toEqual([platform !== 'win32']);
});
