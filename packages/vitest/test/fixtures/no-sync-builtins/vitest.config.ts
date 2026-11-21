import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    execArgv: ['--require', fileURLToPath(new URL('./preload.cjs', import.meta.url))],
  },
});
