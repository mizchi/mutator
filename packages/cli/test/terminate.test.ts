import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { descendants } from '../src/terminate.ts';

const kill = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
};

test('descendants lists children and their children, not the process itself', async () => {
  // A shell that starts a grandchild (sleep), prints its pid and waits for it. The test kills only
  // the pids it knows: under a mutant, descendants() may return anything.
  const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise<number>((done) => child.stdout.once('data', (chunk: Buffer) => done(Number(String(chunk).trim()))));
  try {
    expect(descendants(child.pid!)).toEqual([grandchild]);
    const all = descendants(process.pid);
    expect(all).toEqual(expect.arrayContaining([child.pid, grandchild]));
    expect(all).not.toContain(process.pid);
  } finally {
    kill(grandchild);
    kill(child.pid!);
  }
});
