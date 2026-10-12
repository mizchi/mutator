import { createRequire } from 'node:module';

/** The package version; `src/` and the published `dist/` both sit next to package.json. */
export const VERSION: string = createRequire(import.meta.url)('../package.json').version;
