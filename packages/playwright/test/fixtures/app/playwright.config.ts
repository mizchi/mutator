import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from '@playwright/test';

// The test sets the port, so parallel runs do not collide.
const port = Number(process.env.MUTATOR_TEST_PORT ?? 5180);
const vite = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: `http://localhost:${port}` },
  webServer: { command: `node ${vite} --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false },
});
