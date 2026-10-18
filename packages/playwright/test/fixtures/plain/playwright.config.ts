import { defineConfig } from '@playwright/test';

// outputDir: inside the copy, not next to the package.json above it.
export default defineConfig({ testDir: 'tests', outputDir: 'test-results' });
