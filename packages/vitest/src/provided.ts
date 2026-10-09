// Values the session provides to the worker-side setup file.
declare module 'vitest' {
  interface ProvidedContext {
    mutator: { active: string | null; hitLimit: number; earlyExit: boolean };
  }
}

export {};
