// Optional chaining over values whose type does or does not exclude null and undefined.
interface Box {
  value: { name: string };
  maybe?: { name: string };
  run(): number;
}

export function present(box: Box): string {
  return box?.value?.name;
}

export function absent(box: Box | undefined): string | undefined {
  return box?.maybe?.name;
}

export function calls(box: Box, fn: () => number, opt?: () => number): number {
  return fn?.() + box.run?.() + (opt?.() ?? 0);
}

export function narrowed(box: Box | null): number {
  if (box) return box?.run();
  return 0;
}

export function index(xs: string[], k: number): string | undefined {
  return xs?.[k];
}

export function loose<T>(x: T, y: any, z: unknown): unknown {
  return [x?.toString(), y?.name, (z as { a: number } | undefined)?.a];
}

export function nullish(a: string, b: string | null): string {
  return (a ?? 'x') + (b ?? 'y');
}
