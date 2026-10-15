// Without strictNullChecks a type never says whether a value can be nullish.
interface Box {
  value: { name: string };
}

export function present(box: Box): string {
  return box?.value?.name;
}
