import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { runMutation } from '../src/run.ts';

test('a budgeted multi-project run resumes from the saved project-specific test index', { timeout: 30_000 }, async () => {
  const parent = fileURLToPath(new URL('../../../.tmp', import.meta.url));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'multi-project-'));
  try {
    cpSync(fileURLToPath(new URL('../../vitest/test/fixtures/multi-project', import.meta.url)), root, { recursive: true });
    const options = { root, typecheck: false, weakMutation: false, concurrency: 2 };
    const budgeted = await runMutation({ ...options, timeBudget: 0 });
    expect(budgeted.entries.some((e) => e.status === 'Pending')).toBe(true);
    const resumed = await runMutation(options);
    expect(resumed.dryRunFiles).toEqual([]);
    const addition = resumed.entries.find((e) => e.mutant.original === 'a + b' && e.mutant.replacement === 'a - b');
    expect(addition?.status).toBe('Killed');
    expect(addition?.killedBy.some((id) => id.includes('[unit]') || id.includes('[integration]'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
