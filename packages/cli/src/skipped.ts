// `mutator skipped`: the candidates skip rules removed before they became mutants. No test runs.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Mutant, type SkippedCandidate, relativePath as relative } from '@mizchi/mutator-core';
import { oneLine } from './report.ts';
import type { RunOptions } from './run.ts';
import { collectSources, resolveSetup } from './setup.ts';

/** Skipped candidates (files relative to the root) and the mutants that justify them. */
export async function listSkipped(options: RunOptions): Promise<{ skipped: SkippedCandidate[]; mutants: Mutant[] }> {
  const root = realpathSync.native(resolve(options.root));
  const { files, instrumentOptions } = await resolveSetup(root, options, options.log ?? (() => {}));
  const { skipped, mutants } = collectSources(root, files, instrumentOptions);
  return { skipped: skipped.map((s) => ({ ...s, file: relative(root, s.file) })), mutants };
}

export function formatSkipped(skipped: readonly SkippedCandidate[]): string {
  const byRule = new Map<string, number>();
  const lines = skipped.map((s) => {
    byRule.set(s.rule, (byRule.get(s.rule) ?? 0) + 1);
    const kind = `${s.category}${s.heuristic ? ', heuristic' : ''}`;
    return `${s.file}:${s.location.start.line} ${s.mutator} ${oneLine(s.original)} -> ${oneLine(s.replacement)}  ${s.rule} (${kind})${s.by ? ` by ${s.by}` : ''}`;
  });
  const counts = [...byRule].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([rule, n]) => `${rule} ${n}`);
  return `${[...lines, `skipped: ${skipped.length}${counts.length ? ` (${counts.join(', ')})` : ''}`].join('\n')}\n`;
}
