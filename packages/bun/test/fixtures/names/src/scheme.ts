export function stripNul(input: string): string {
  if (input.startsWith('\0')) return input.slice(1);
  return input;
}
