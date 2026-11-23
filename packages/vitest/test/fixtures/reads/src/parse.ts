export function total(values: number[]): number {
  return values.reduce((sum, n) => sum + n, 0);
}
