// Ctrl-C or a cancelled CI job (SIGINT / SIGTERM): stop every process the run started before
// exiting. A worker stuck in a mutant's loop cannot handle its parent going away, so without
// this it would keep spinning after mutator exited. (SIGKILL cannot be handled.)
import { execFileSync } from 'node:child_process';

const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;

/** Every process below `pid` (from `ps`); empty where `ps` is unavailable. */
export function descendants(pid: number): number[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of table.trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (child === undefined || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const out: number[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    for (const child of children.get(pending.pop()!) ?? []) out.push(child), pending.push(child);
  }
  return out;
}

/** On SIGINT / SIGTERM, kill the descendants and exit with 128 + the signal number. */
export function stopDescendantsOnTermination(): void {
  for (const [signal, number] of Object.entries(SIGNALS)) {
    process.once(signal, () => {
      for (const pid of descendants(process.pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      process.exit(128 + number);
    });
  }
}
