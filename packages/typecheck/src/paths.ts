import { normalize, sep } from 'node:path';

/** TypeScript uses normalized forward-slash paths at its host boundary. */
export const compilerPath = (file: string): string => normalize(file).split(sep).join('/');
