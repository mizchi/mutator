// Ctrl-C or a cancelled CI job (SIGINT / SIGTERM): stop every process the run started before
// exiting. A worker stuck in a mutant's loop cannot handle its parent going away, so without
// this it would keep spinning after mutator exited. (SIGKILL cannot be handled.)
import { descendantsIn, killAll, processTable } from './orphans.ts';

const SIGNALS = { SIGINT: 2, SIGTERM: 15 } as const;

/** Every process below `pid` (from `ps`); empty where `ps` is unavailable. */
export function descendants(pid: number): number[] {
  return descendantsIn(processTable(), pid).map((p) => p.pid);
}

/** On SIGINT / SIGTERM, kill the descendants and exit with 128 + the signal number. */
export function stopDescendantsOnTermination(): void {
  for (const [signal, number] of Object.entries(SIGNALS)) {
    process.once(signal, () => {
      killAll(descendants(process.pid));
      process.exit(128 + number);
    });
  }
}
