export function fill(n: number): number {
  const step = n > 0 ? 1 : 0;
  const out: number[][] = [];
  for (let i = 0; i < n; i += step) out.push(new Array(100_000).fill(i));
  return out.length;
}
