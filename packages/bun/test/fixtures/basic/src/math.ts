export function add(a: number, b: number): number {
  return a + b;
}

export function isAdult(age: number): boolean {
  return age >= 18;
}

export const LIMIT: number = 10 * 2;

export function unused(x: number): number {
  return x * 3;
}

export function countdown(n: number): number {
  let i = n;
  while (i > 0) i--;
  return i;
}
