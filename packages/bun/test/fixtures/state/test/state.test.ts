import { writeFileSync } from 'node:fs';
import { test } from 'bun:test';

// Written before the test touches the state: what the preload installed.
const installed = JSON.stringify(globalThis.__mutator__);

test('state', () => {
  writeFileSync(process.env.MUTATOR_STATE_OUT!, JSON.stringify({ installed, during: (globalThis as { __mutator__?: { testId: unknown } }).__mutator__?.testId }));
});
