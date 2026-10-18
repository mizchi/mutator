// The dev server(s) of the Playwright config's `webServer`, started by mutator instead of
// Playwright: once, with the instrumentation enabled, and shared by every run and session.
import { type ChildProcess, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { RunnerSetupError } from '@mizchi/mutator-core';

/** `webServer` as the Playwright config gives it. */
export interface WebServerConfig {
  command: string;
  url?: string;
  port?: number;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

interface Shared {
  refs: number;
  started: Promise<ChildProcess[]>;
}

const shared = new Map<string, Shared>();

/**
 * Starts the servers (or joins the ones already started under the same key) and resolves once
 * all answer. The returned function releases them; the last release stops them (and resolves once they exited).
 */
export async function acquireServers(key: string, servers: readonly WebServerConfig[], options: { configDir: string; env: Record<string, string> }): Promise<() => Promise<void>> {
  let entry = shared.get(key);
  if (!entry) {
    entry = { refs: 0, started: startAll(servers, options) };
    shared.set(key, entry);
  }
  entry.refs++;
  const current = entry;
  const release = async () => {
    if (--current.refs > 0) return;
    shared.delete(key);
    const children = await current.started.catch(() => [] as ChildProcess[]);
    await Promise.all(children.map(stop));
  };
  try {
    await current.started;
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/** One after another; when one fails, the ones already started are stopped. */
async function startAll(servers: readonly WebServerConfig[], options: { configDir: string; env: Record<string, string> }): Promise<ChildProcess[]> {
  const started: ChildProcess[] = [];
  try {
    for (const server of servers) started.push(await start(server, options));
  } catch (error) {
    await Promise.all(started.map(stop));
    throw error;
  }
  return started;
}

async function start(server: WebServerConfig, options: { configDir: string; env: Record<string, string> }): Promise<ChildProcess> {
  // Playwright requires one of them too: without either there is nothing to wait for.
  if (server.url === undefined && server.port === undefined) throw new RunnerSetupError(`mutator: webServer \`${server.command}\` has neither url nor port`);
  const where = server.url ?? `port ${server.port}`;
  if (await answers(server)) {
    throw new RunnerSetupError(`mutator: ${where} already answers; stop that server, so mutator can start the dev server with the instrumentation`);
  }
  const child = spawn(server.command, {
    shell: true,
    cwd: resolve(options.configDir, server.cwd ?? '.'),
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, ...server.env, ...options.env },
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderr.length < 16 * 1024) stderr += chunk.toString();
  });
  let exited = false;
  child.on('exit', () => (exited = true));
  const deadline = performance.now() + (server.timeout ?? DEFAULT_TIMEOUT_MS);
  while (!(await answers(server))) {
    if (exited) throw new RunnerSetupError(`mutator: the dev server (${server.command}) exited before ${where} answered\n${stderr}`);
    if (performance.now() > deadline) {
      await stop(child);
      throw new RunnerSetupError(`mutator: ${where} did not answer within ${server.timeout ?? DEFAULT_TIMEOUT_MS} ms (${server.command})\n${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return child;
}

/** Ready as Playwright defines it: an url answering 2xx, 3xx or 400-403, or a port accepting connections. */
async function answers(server: WebServerConfig): Promise<boolean> {
  if (server.url) {
    try {
      const response = await fetch(server.url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      return response.status <= 403;
    } catch {
      return false;
    }
  }
  return new Promise((done) => {
    const socket = connect(server.port!, 'localhost');
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  try {
    // The shell and the server it started share the process group.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    return;
  }
  await exited;
}
