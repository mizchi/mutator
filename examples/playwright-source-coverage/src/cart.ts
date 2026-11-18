import { normalizeQuantity } from './normalize-quantity.ts';

export function calculateTotal(quantity: number): number {
  return normalizeQuantity(quantity) * 10;
}
