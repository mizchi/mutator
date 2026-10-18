import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

/** A port nothing listens on now (the OS picks it). */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, 'localhost', done));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

/**
 * Gives a copy of the app fixture its own dev server port, in a file its Playwright config
 * reads: environment variables are shared by test files that run on threads (as under mutator).
 */
export async function assignPort(root: string): Promise<number> {
  const port = await freePort();
  writeFileSync(join(root, 'port'), String(port));
  return port;
}
