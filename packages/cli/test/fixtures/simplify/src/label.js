export function label(name) {
  // Redundant: ''.trim() is '' already.
  if (name.length === 0) return '';
  return name.trim();
}

export function sign(n) {
  return n < 0 ? -1 : 1;
}
