import { spawn } from 'node:child_process';
import { expect, test } from 'vitest';
import { descendants } from '../src/terminate.ts';

test('descendants lists children and their children, not unrelated processes', async () => {
  // A shell that starts a grandchild (sleep) and waits for it.
  const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
  try {
    await expect.poll(() => descendants(child.pid!).length, { timeout: 5000 }).toBe(1);
    const all = descendants(process.pid);
    expect(all).toContain(child.pid);
    expect(all).toEqual(expect.arrayContaining(descendants(child.pid!)));
    expect(all).not.toContain(process.pid);
    expect(descendants(process.ppid)).toContain(process.pid);
  } finally {
    for (const pid of [...descendants(child.pid!), child.pid!]) process.kill(pid, 'SIGKILL');
  }
});
