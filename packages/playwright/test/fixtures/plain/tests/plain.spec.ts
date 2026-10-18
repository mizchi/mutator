import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// Under the mutant `break-file` this file fails to load.
const file = process.env.MUTATOR_PLAYWRIGHT_RUN_FILE;
if (file && (JSON.parse(readFileSync(file, 'utf8')) as { active: string | null }).active === 'break-file') throw new Error('the test file broke');

test('passes', () => {
  // While ../leave-process exists: start a process that outlives the test, and write its pid there.
  const marker = new URL('../leave-process', import.meta.url);
  if (existsSync(marker)) writeFileSync(marker, String(spawn('sleep', ['30'], { stdio: 'ignore' }).pid));
  expect(1 + 1).toBe(2);
});

test('fails', () => {
  expect(1 + 1).toBe(3);
});

// Satisfied only after 1.5 s: it passes in a mutant run only if the expect bound follows what
// this test took in the dry run (the 1 s floor alone would fail it).
test('waits', async () => {
  const started = Date.now();
  await expect.poll(() => Date.now() - started > 1500).toBe(true);
});
