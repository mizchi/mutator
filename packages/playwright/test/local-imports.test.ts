import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { localImports } from '../src/session.ts';

test('follows relative imports transitively, resolving extensions and index files the way bundlers do', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-imports-'));
  try {
    const files: Record<string, string> = {
      'spec.ts': [
        "import { expect } from '@playwright/test';", // a package: not followed
        "import { p } from 'pkg';", // a package, even with a local pkg.ts next to the spec
        "import { a } from './exact.ts';",
        "import { b } from './b';",
        "import { c } from './c';",
        "import { d } from './d';",
        "import { e } from './e';",
        "import { f } from './f';",
        "import { g } from './g';",
        "import { h } from './h';",
        "import { i } from './dir';", // a directory without an index: nothing
        "import { j } from './missing';",
        '',
      ].join('\n'),
      'exact.ts': "import { back } from './spec.ts';\nexport const a = 1;\n", // a cycle back to the spec
      'b.tsx': "import { n } from './nested/deep';\nexport const b = 1;\n",
      'nested/deep.ts': 'export const n = 1;\n',
      'c.mts': 'export const c = 1;\n',
      'd.js': 'export const d = 1;\n',
      'e.jsx': 'export const e = <;\n', // unparsable: listed, not followed
      'f.mjs': 'export const f = 1;\n',
      'g/index.ts': 'export const g = 1;\n',
      'h/index.js': 'export const h = 1;\n',
      'dir/readme.md': '',
      'pkg.ts': 'export const p = 1;\n',
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    expect(localImports(join(dir, 'spec.ts')).map((f) => f.slice(dir.length + 1)).sort()).toEqual([
      'b.tsx',
      'c.mts',
      'd.js',
      'e.jsx',
      'exact.ts',
      'f.mjs',
      'g/index.ts',
      'h/index.js',
      'nested/deep.ts',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
