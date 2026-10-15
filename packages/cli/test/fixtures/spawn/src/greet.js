// Reached only through the CLI the test runs in a child process.
export function greet(name) {
  return name ? `hello ${name}` : 'hello';
}
