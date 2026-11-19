export function greet(name: string): string {
  return `hello ${name}`;
}

if (import.meta.main) console.log(greet(process.argv[2] ?? 'world'));
