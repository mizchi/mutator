// strict without noUncheckedIndexedAccess: `xs[0]` is typed string, yet undefined for [].
interface Box {
  value: { name: string };
}

export function present(box: Box): string {
  return box?.value?.name;
}

export function first(xs: string[]): boolean | undefined {
  const head = xs[0];
  return xs[0]?.startsWith('/') || head?.startsWith('.');
}
