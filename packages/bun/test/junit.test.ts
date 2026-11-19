import { expect, test } from 'vitest';
import { decodeEntities, parseJunit } from '../src/junit.ts';

// What `bun test --reporter=junit` writes (Bun 1.4): a suite per file, nested suites per describe.
const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="7" assertions="5" failures="1" skipped="2" time="0.01">
  <testsuite name="test/c.test.ts" file="test/c.test.ts" tests="1" assertions="1" failures="0" skipped="0" time="0.004" hostname="vm">
    <testcase name="c1" classname="" time="0.000103" file="test/c.test.ts" line="4" assertions="1" />
  </testsuite>
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="6" assertions="4" failures="1" skipped="2" time="0.005" hostname="vm">
    <testsuite name="add" file="test/a.test.ts" line="3" tests="5" assertions="3" failures="1" skipped="2" time="0" hostname="vm">
      <testcase name="one" classname="add" time="0.000021" file="test/a.test.ts" line="4" assertions="1" />
      <testsuite name="nested" file="test/a.test.ts" line="5" tests="1" assertions="1" failures="1" skipped="0" time="0.003" hostname="vm">
        <testcase name="two &lt;b&gt;" classname="nested &gt; add" time="0.003539" file="test/a.test.ts" line="6" assertions="1">
          <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 5">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 5&#10;      at test/a.test.ts:6:43&#10;</failure>
        </testcase>
      </testsuite>
      <testcase name="skipped" classname="add" time="0" file="test/a.test.ts" line="8" assertions="0">
        <skipped />
      </testcase>
      <testcase name="todo" classname="add" time="0" file="test/a.test.ts" line="9" assertions="0">
        <skipped message="TODO" />
      </testcase>
      <testcase name="each 1+2" classname="add" time="0.000065" file="test/a.test.ts" line="10" assertions="1" />
    </testsuite>
    <testcase name="top" classname="" time="0.000014" file="test/a.test.ts" line="12" assertions="1" />
  </testsuite>
</testsuites>
`;

test('files, full names in declaration order, states, durations and failure messages', () => {
  expect(parseJunit(REPORT)).toEqual([
    { file: 'test/c.test.ts', tests: [{ fullName: 'c1', state: 'passed', durationMs: 0.103, messages: [] }] },
    {
      file: 'test/a.test.ts',
      tests: [
        { fullName: 'add one', state: 'passed', durationMs: expect.closeTo(0.021, 6), messages: [] },
        { fullName: 'add nested two <b>', state: 'failed', durationMs: expect.closeTo(3.539, 6), messages: ['AssertionError: expect(received).toBe(expected)\n\nExpected: 5\n      at test/a.test.ts:6:43'] },
        { fullName: 'add skipped', state: 'skipped', durationMs: 0, messages: [] },
        { fullName: 'add todo', state: 'skipped', durationMs: 0, messages: [] },
        { fullName: 'add each 1+2', state: 'passed', durationMs: expect.closeTo(0.065, 6), messages: [] },
        { fullName: 'top', state: 'passed', durationMs: expect.closeTo(0.014, 6), messages: [] },
      ],
    },
  ]);
});

test('a self-closing failure keeps its message attribute; errors count as failures', () => {
  const xml = `<testsuites><testsuite name="t.test.ts" file="t.test.ts"><testcase name="x" time="0.001"><failure message="mutator: hit limit reached (1001)" /></testcase><testcase name="y"><error message="boom">Error: boom</error></testcase></testsuite></testsuites>`;
  expect(parseJunit(xml)[0]!.tests).toEqual([
    { fullName: 'x', state: 'failed', durationMs: 1, messages: ['mutator: hit limit reached (1001)'] },
    { fullName: 'y', state: 'failed', durationMs: 0, messages: ['Error: boom'] },
  ]);
});

test('other elements neither fail a test nor end a failure', () => {
  const xml = `<testsuites><testsuite name="t.test.ts" file="t.test.ts"><testcase name="p"><system-out>log</system-out></testcase><testcase name="f"><failure message="m">a <b>x</b> c</failure></testcase></testsuite></testsuites>`;
  expect(parseJunit(xml)[0]!.tests).toEqual([
    { fullName: 'p', state: 'passed', durationMs: 0, messages: [] },
    { fullName: 'f', state: 'failed', durationMs: 0, messages: ['a x c'] },
  ]);
});

test('an empty run has no files', () => {
  expect(parseJunit('<?xml version="1.0"?>\n<testsuites name="bun test" tests="0"></testsuites>')).toEqual([]);
});

test('entities', () => {
  expect(decodeEntities('&lt;a&gt; &amp; &quot;b&quot; &apos;c&apos; &#10;&#x41; &unknown;')).toBe('<a> & "b" \'c\' \nA &unknown;');
});
