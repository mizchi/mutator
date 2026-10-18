import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Each test's copy has its own port (in ./port), so parallel runs do not collide.
const portFile = new URL('./port', import.meta.url);
const port = Number(existsSync(portFile) ? readFileSync(portFile, 'utf8') : (process.env.MUTATOR_TEST_PORT ?? 5180));
const vite = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');

export default defineConfig({
  testDir: 'tests',
  use: { baseURL: `http://localhost:${port}` },
  webServer: { command: `node ${vite} --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: false },
});
