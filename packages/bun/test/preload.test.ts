// The preload runs inside Bun, where the ESM core is not imported: it writes core's runtime
// state out. This keeps it equal to what every other adapter installs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_GLOBAL } from '@mizchi/mutator-core';
import { expect, test } from 'vitest';
import { PRELOAD } from '../src/session.ts';

const hasBun = !spawnSync('bun', ['--version']).error;

test.skipIf(!hasBun)('the preload installs the runtime state every adapter installs, and numbers the running test', () => {
  const root = fileURLToPath(new URL('./fixtures/state', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'mutator-bun-state-'));
  try {
    const out = join(dir, 'state.json');
    const run = spawnSync('bun', ['test', '--isolate', '--preload', PRELOAD], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MUTATOR_ACTIVE: 'k1', MUTATOR_HIT_LIMIT: '42', MUTATOR_STATE_OUT: out },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(RUNTIME_GLOBAL).toBe('__mutator__');
    const { installed, during } = JSON.parse(readFileSync(out, 'utf8'));
    expect(JSON.parse(installed)).toEqual({
      active: 'k1',
      collect: false,
      modules: [],
      cov: { static: {}, perTest: {} },
      inf: { static: {}, perTest: {} },
      testId: null,
      hits: 0,
      hitLimit: 42,
    });
    expect(during).toBe('0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
