// Keep the watcher alive across runs. A fresh CLI process reloads the project config,
// its imported helpers, the test runner and plugins, and uses the normal scoped snapshot.
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fstatSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import { gitEnvironment, runGit } from './git.ts';

const ignoredDirs = new Set(['.git', 'node_modules', '.mutator', '.tmp', '.next', '.cache', 'coverage', 'test-results', 'playwright-report']);

/** Changes to HEAD or the comparison ref can change the diff without a working-tree edit. */
function gitRefs(root: string): string[] {
  try {
    const [gitDir, common] = runGit(root, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trimEnd().split(/\r?\n/);
    return [join(gitDir!, 'HEAD'), join(common!, 'refs'), join(common!, 'packed-refs')];
  } catch { return []; }
}

function allIgnoredByGit(root: string, files: Set<string>): boolean {
  const { status, stdout } = spawnSync('git', ['check-ignore', '-z', '--stdin'], {
    cwd: root, env: gitEnvironment(process.env), input: [...files].join('\0') + '\0', encoding: 'utf8',
  });
  return status === 0 && stdout.split('\0').length - 1 === files.size;
}

export async function watchCommand(root: string, cli: string, argv: string[], throttleMs: number): Promise<void> {
  const refs = gitRefs(root);
  const reports = new Set<string>();
  const sinks = [1, 2].map((fd) => fstatSync(fd)).filter((s) => s.isFile());
  const files = watch(root, {
    ignoreInitial: true, followSymlinks: false,
    ignored: (path, stats) => relative(root, path).split(sep).some((part) => ignoredDirs.has(part))
      || reports.has(resolve(path)) || Boolean(stats && sinks.some((sink) => sink.dev === stats.dev && sink.ino === stats.ino)),
  });
  const git = refs.length ? watch(refs, { ignoreInitial: true, followSymlinks: false }) : undefined;
  let next = Promise.withResolvers<void>();
  let timer: NodeJS.Timeout | undefined;
  let error: unknown;
  const changed = new Set<string>();
  let refChanged = false;
  let initial = true;
  // Keep the same latch through the entire window, even when it expires during a run.
  const schedule = () => { timer ??= setTimeout(() => next.resolve(), throttleMs); };
  files.on('all', (event, path) => {
    if (event === 'addDir' || event === 'unlinkDir' || reports.has(resolve(path))) return;
    changed.add(relative(root, path));
    if (!initial) schedule();
  });
  git?.on('all', (event, path) => {
    if (event === 'addDir' || event === 'unlinkDir' || basename(path).endsWith('.lock')) return;
    refChanged = true;
    if (!initial) schedule();
  });
  const watchers = git ? [files, git] : [files];
  for (const watcher of watchers) {
    watcher.on('error', (cause) => { error = cause; next.resolve(); });
  }
  try {
    await Promise.all(watchers.map((watcher) => once(watcher, 'ready')));
    console.error(`watch: ready (throttle ${throttleMs} ms)`);
    schedule();
    for (;;) {
      await next.promise;
      if (error) throw error;
      for (const path of reports) changed.delete(relative(root, path));
      const shouldRun = initial || refChanged || (changed.size > 0 && (!git || !allIgnoredByGit(root, changed)));
      initial = false;
      refChanged = false;
      changed.clear();
      timer = undefined;
      next = Promise.withResolvers<void>();
      if (!shouldRun) continue;
      console.error('watch: running mutation tests');
      await runOnce(cli, argv, reports);
      console.error('watch: waiting for changes (Ctrl-C to stop)');
    }
  } finally {
    clearTimeout(timer);
    await Promise.all(watchers.map((watcher) => watcher.close()));
  }
}

function runOnce(cli: string, argv: string[], reports: Set<string>): Promise<void> {
  return new Promise<void>((done, reject) => {
    const child = fork(cli, argv, {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, MUTATOR_WATCH_PARENT: String(process.pid) },
    });
    child.on('message', (message: unknown) => {
      if (!Array.isArray(message) || !message.every((path) => typeof path === 'string')) return;
      reports.clear();
      for (const path of message) reports.add(resolve(path));
    });
    child.once('error', reject);
    child.once('close', () => done());
  });
}
