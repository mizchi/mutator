// A cycle of type imports only: Shape (shape.ts) is built from Kind, declared here.
import type { Shape } from './shape.js';

export const KINDS = ['a', 'b'] as const;
export type Kind = (typeof KINDS)[number];

export const first: Shape = { kind: KINDS[0] };
