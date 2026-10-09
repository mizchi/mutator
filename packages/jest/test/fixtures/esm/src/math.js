export function add(a, b) {
  return a + b;
}

export function isAdult(age) {
  return age >= 18;
}

export const LIMIT = 10 * 2;

export function unused(x) {
  return x * 3;
}

export function countdown(n) {
  let i = n;
  while (i > 0) i--;
  return i;
}
