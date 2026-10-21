import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, test } from 'vitest';
import { acquireServers } from '../src/server.ts';
import { freePort } from './port.ts';

const node = JSON.stringify(process.execPath);
// Every server these tests start carries this tag, so afterAll stops them even when the code
// under test (a mutant of it, say) leaves them running.
const tag = `mutator-server-test-${process.pid}-${Date.now()}`;
afterAll(() => {
  spawnSync('pkill', ['-f', tag]);
});
/** A command serving http (or plain tcp) on `port` until killed. */
const http = (port: number) => `${node} -e "require('node:http').createServer((q, s) => s.end('ok')).listen(${port})" ${tag}`;
const tcp = (port: number) => `${node} -e "require('node:net').createServer((c) => c.end()).listen(${port})" ${tag}`;
const options = { configDir: tmpdir(), env: {} };
const answers = async (port: number) =>
  fetch(`http://localhost:${port}/`).then(
    () => true,
    () => false,
  );

describe('acquireServers', { timeout: 30_000 }, () => {
  test('waits for the url, shares the servers per key, and stops them on the last release', async () => {
    const port = await freePort();
    const servers = [{ command: http(port), url: `http://localhost:${port}/` }];
    const first = await acquireServers('k1', servers, options);
    const second = await acquireServers('k1', servers, options);
    expect(await answers(port)).toBe(true);
    await first();
    expect(await answers(port)).toBe(true);
    await second();
    expect(await answers(port)).toBe(false);
  });

  test('a server with only a port is ready once the port accepts connections', async () => {
    const port = await freePort();
    const release = await acquireServers('k2', [{ command: tcp(port), port }], options);
    const { connect } = await import('node:net');
    const open = await new Promise<boolean>((done) => {
      const socket = connect(port, 'localhost');
      socket.once('connect', () => (socket.destroy(), done(true)));
      socket.once('error', () => done(false));
    });
    expect(open).toBe(true);
    await release();
  });

  test('a server with neither url nor port is an error, not one that already answers', async () => {
    await expect(acquireServers('k6', [{ command: 'sleep 30' }], options)).rejects.toThrow('mutator: webServer `sleep 30` has neither url nor port');
  });

  test('refuses to start when something already answers on the url', async () => {
    const port = await freePort();
    const other = createServer((_, res) => res.end('not mutator')).listen(port);
    try {
      await expect(acquireServers('k3', [{ command: http(port), url: `http://localhost:${port}/` }], options)).rejects.toThrow(`http://localhost:${port}/ already answers`);
    } finally {
      other.close();
    }
  });

  test('a server exiting before it answers, or not answering in time, is an error that stops the ones started', async () => {
    const [port, other, silent] = [await freePort(), await freePort(), await freePort()];
    await expect(
      acquireServers('k4', [{ command: http(port), url: `http://localhost:${port}/` }, { command: 'echo broken >&2; exit 3', url: `http://localhost:${other}/` }], options),
    ).rejects.toThrow(/exited before http:\/\/localhost:\d+\/ answered\nbroken/);
    // The first server was started, then stopped when the second failed.
    expect(await answers(port)).toBe(false);
    await expect(acquireServers('k5', [{ command: 'sleep 5', port: silent, timeout: 300 }], options)).rejects.toThrow(`port ${silent} did not answer within 300 ms`);
    // A failed key starts again from scratch.
    const release = await acquireServers('k4', [{ command: http(port), url: `http://localhost:${port}/` }], options);
    expect(await answers(port)).toBe(true);
    await release();
  });
});
