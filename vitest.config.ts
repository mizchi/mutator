import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/fixtures/**'],
  },
});
