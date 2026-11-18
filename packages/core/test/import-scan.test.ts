import { expect, test } from 'vitest';
import { scanImports } from '../src/index.ts';

test.each([
  'const load = (name: string) => import(name);',
  "const load = () => import(`./${name}.ts`);",
  "const x = require('./local.js');",
  "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url);",
  'const = ;',
])('marks module loads outside the static ESM graph: %s', (source) => {
  expect(scanImports('module.ts', source).opaqueLoads).toBe(true);
});

test('literal imports stay analyzable, and comments/strings do not look dynamic', () => {
  const source = "import './a.ts';\nconst load = () => import('./b.ts');\n// import(name)\nconst text = 'require(name)';";
  expect(scanImports('module.ts', source).opaqueLoads).toBeUndefined();
});
