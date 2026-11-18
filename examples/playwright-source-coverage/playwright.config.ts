import { defineConfig } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_SAMPLE_PORT ?? 4180);

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
