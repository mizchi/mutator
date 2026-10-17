export function add(a, b) {
  return a + b;
}

// A mutant here ends the Jest process in the middle of a test file.
export function exitOnError(code) {
  if (code !== 0) process.exit(code);
  return code;
}
