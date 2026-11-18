import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  test: {
    projects: [
      { root, test: { name: 'unit', include: ['test/**/*.test.ts'], setupFiles: ['test/setup-unit.ts'], provide: { role: 'unit' } } },
      { extends: false, root, test: { name: 'integration', include: ['test/**/*.test.ts'], setupFiles: ['test/setup-integration.ts'], provide: { role: 'integration' } } },
    ],
  },
});
