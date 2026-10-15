// mutator-critical
export function total(price, qty) {
  return price * qty;
}

export function label(name) {
  return name ? `item ${name}` : 'item';
}
