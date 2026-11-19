import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { watchCommand } from '../src/watch.ts';

const { fork, watch } = vi.hoisted(() => ({ fork: vi.fn(), watch: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), fork }));
vi.mock('chokidar', () => ({ watch }));
vi.mock('../src/git.ts', () => ({ runGit: () => { throw new Error('no repository'); } }));

test('watch uses a trailing throttle, including startup and changes during a slow run', async () => {
  vi.useFakeTimers();
  const watcher = Object.assign(new EventEmitter(), { close: vi.fn() });
  watch.mockReturnValue(watcher);
  const child = new EventEmitter();
  fork.mockReturnValue(child);
  const root = process.cwd();
  const edit = () => watcher.emit('all', 'change', join(root, 'src.ts'));
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const running = watchCommand(root, 'cli', [], 2000);
  const stopped = expect(running).rejects.toThrow('watch stopped');
  try {
    watcher.emit('ready');
    await tick(0);
    await tick(1900);
    edit();
    expect(fork).not.toHaveBeenCalled();
    await tick(100);
    expect(fork).toHaveBeenCalledTimes(1);
    child.emit('close');
    await tick(3000);
    expect(fork).toHaveBeenCalledTimes(1);

    edit();
    await tick(1000);
    edit();
    await tick(999);
    expect(fork).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(fork).toHaveBeenCalledTimes(2);

    edit();
    await tick(3000);
    edit();
    expect(fork).toHaveBeenCalledTimes(2);
    child.emit('close');
    await tick(0);
    expect(fork).toHaveBeenCalledTimes(3);
    child.emit('close');
    await tick(3000);
    expect(fork).toHaveBeenCalledTimes(3);
  } finally {
    watcher.emit('error', new Error('watch stopped'));
    child.emit('close');
    await stopped;
    vi.useRealTimers();
  }
});
