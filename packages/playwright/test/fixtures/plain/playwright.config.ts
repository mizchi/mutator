import { readFileSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

// The tests break this config on purpose: under the mutant `break-config`, or in the dry run
// with MUTATOR_TEST_BREAK_DRY_RUN set.
const file = process.env.MUTATOR_PLAYWRIGHT_RUN_FILE;
const run = file ? (JSON.parse(readFileSync(file, 'utf8')) as { active: string | null }) : undefined;
if (run && (run.active === 'break-config' || (run.active === null && process.env.MUTATOR_TEST_BREAK_DRY_RUN))) {
  throw new Error('the config broke');
}

// outputDir: inside the copy, not next to the package.json above it.
export default defineConfig({ testDir: 'tests', outputDir: 'test-results' });
