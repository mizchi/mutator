// An import cycle: the type of `n` comes back through cycle-dep.ts from the return type of `value`.
import { getValue } from './cycle-dep.js';

export function value() {
  return 1;
}

export const n: number = getValue();
