export function len(s: string): number {
  return s.length;
}

export function greet(name: string): string {
  return `hello ${name}`;
}

// A pre-existing error must not make every mutant of this file look broken.
export const broken: number = 'not a number';
