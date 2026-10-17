import { defineConfig } from 'vitest/config';

// Two projects: `a` excludes skipped/ on purpose, `b` keeps the default exclude.
export default defineConfig({
  test: {
    projects: [
      { root: './a', test: { name: 'a', include: ['**/*.test.ts'], exclude: ['**/node_modules/**', '**/skipped/**'] } },
      { root: './b', test: { name: 'b', include: ['*.test.ts'] } },
    ],
  },
});
