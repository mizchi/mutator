// Runtime overhead of instrumented code with no mutant active.
// usage: node scripts/overhead-bench.ts
import vm from 'node:vm';
import { instrument } from '../packages/core/src/index.ts';

const source = `
function tokenize(input) {
  const out = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\\n') { i++; continue; }
    if (c >= '0' && c <= '9') {
      let j = i;
      while (j < input.length && input[j] >= '0' && input[j] <= '9') j++;
      out.push({ kind: 'num', value: Number(input.slice(i, j)) });
      i = j;
    } else if ('+-*/()'.includes(c)) { out.push({ kind: 'op', value: c }); i++; }
    else { let j = i; while (j < input.length && /[a-z]/.test(input[j])) j++; out.push({ kind: 'id', value: input.slice(i, j) || c }); i = Math.max(j, i + 1); }
  }
  return out;
}
function evaluate(tokens) {
  let total = 0, sign = 1;
  for (const t of tokens) {
    if (t.kind === 'num') total += sign * t.value;
    else if (t.kind === 'op') sign = t.value === '-' ? -1 : 1;
    else if (t.value.length > 3 && t.value !== 'skip') total += t.value.length % 7;
  }
  return total;
}
function sortBy(items, key) {
  return [...items].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}
exports.work = (n) => {
  let acc = 0;
  const text = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? 'alpha ' : i % 3 === 1 ? '12 + 7 - ' : 'beta * ')).join('');
  for (let k = 0; k < n; k++) {
    acc += evaluate(tokenize(text));
    acc += sortBy(tokenize(text).slice(0, 50), 'value').length;
  }
  return acc;
};
`;

const { code, mutants } = instrument('bench.js', source);
const run = (label: string, src: string, state: object | undefined, n = 300) => {
  const context = vm.createContext({ exports: {} as { work?: (n: number) => number }, ...(state ? { __mutator__: state } : {}) });
  // Wrap in a function: top-level vars of a vm script are slow global properties,
  // while in a real module they are module-scoped bindings.
  vm.runInContext(`(function (exports) {\n${src}\n})(exports);`, context);
  const work = context.exports.work!;
  work(20);
  const t0 = performance.now();
  const result = work(n);
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(34)} ${ms.toFixed(0).padStart(6)} ms  (result ${result})`);
  return ms;
};
const state = (collect: boolean) => ({ active: null, collect, cov: { static: {}, perTest: {} }, testId: collect ? 't1' : null, hits: 0, hitLimit: Infinity });
console.log(`${mutants.length} mutants`);
const base = run('original', source, undefined);
const dry = run('instrumented, collecting coverage', code, state(true));
const mut = run('instrumented, no coverage', code, state(false));
console.log(`overhead: dry run ${(dry / base).toFixed(2)}x, mutant runs ${(mut / base).toFixed(2)}x`);
