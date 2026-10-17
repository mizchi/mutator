export function inc(n: number): number {
  return n + 1;
}

export function label(n: number): string {
  return n >= 10 ? 'many' : 'few';
}

export function unused(x: number): number {
  return x * 3;
}
