export interface Person {
  age: number;
}

export function add(a: number, b: number): number {
  return a + b;
}

export function isAdult(person: Person): boolean {
  return person.age >= 18;
}

export const LIMIT: number = 10 * 2;
