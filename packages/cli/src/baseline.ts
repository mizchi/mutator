import { sep } from 'node:path';
import type { DryRunResult } from '@mizchi/mutator-core';

/** At most this many failures are listed; the rest are counted. */
const MAX_FAILURES = 10;
/** Lines and characters kept of each failure's message. */
const MAX_LINES = 4;
const MAX_LINE_CHARS = 300;

const ANSI = /\u001b\[[0-9;]*m/g;

export const BASELINE_HINT =
  'hint: if the tests pass on their own, timing-sensitive tests (async waits such as Testing Library findBy*/waitFor) ' +
  'can time out under instrumentation and parallel load: try --concurrency 1, or point --config at a mutator-only test config ' +
  'that raises testTimeout and the async util timeouts (set NODE_DEBUG=mutator for more detail).';

/** Drops the project root from paths in a message (native and `/` separated, as Vite reports on Windows). */
/** `message` with paths under `root` written relative to it. */
export function relativize(message: string, root: string | undefined): string {
  if (!root) return message;
  let out = message.split(`${root}${sep}`).join('');
  if (sep !== '/') out = out.split(`${root.replaceAll(sep, '/')}/`).join('');
  return out;
}

/** The first lines of a runner's error message, without colors, each line cut to a bounded length. */
function excerpt(message: string, id: string, root: string | undefined): string[] {
  const lines = relativize(message, root)
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  // An unhandled error is listed by its message: do not print it twice.
  const first = lines[0]?.trim();
  if (first !== undefined && (first === id || first.endsWith(`: ${id}`) || id.endsWith(`: ${first}`))) lines.shift();
  return lines.slice(0, MAX_LINES).map((line) => {
    const trimmed = line.trim();
    return trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}...` : trimmed;
  });
}

/** The baseline error: each failing test or module with its first error, bounded, and a hint. Paths under `root` are shown relative. */
export function formatBaselineFailure(dry: Pick<DryRunResult, 'failed' | 'failures'>, root?: string): string {
  const out = [`tests fail without mutants (${dry.failed.length}):`];
  for (const id of dry.failed.slice(0, MAX_FAILURES)) {
    out.push(`  ${id}`);
    const message = dry.failures?.get(id);
    if (message) for (const line of excerpt(message, id, root)) out.push(`    ${line}`);
  }
  if (dry.failed.length > MAX_FAILURES) out.push(`  ... and ${dry.failed.length - MAX_FAILURES} more`);
  out.push(BASELINE_HINT);
  return out.join('\n');
}
