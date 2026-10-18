import { defineConfig } from '@playwright/test';

export default defineConfig({ testDir: 'tests', outputDir: 'test-results', projects: [{ name: 'a' }, { name: 'b' }] });
