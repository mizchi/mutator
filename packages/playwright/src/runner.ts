// One `playwright test` process per run, with mutator's reporter: it writes the run's results
// to the path the run file names. (Keeping Playwright's test-server across runs saved about
// 4% on the fixture app, where the process itself costs ~0.6 s: not worth an internal API.)
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RUN_FILE_ENV, type RunResults } from './env.ts';

/** Shipped as .cjs next to the sources; dist/ resolves it from src/. */
export const REPORTER = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './reporter.cjs' : '../src/reporter.cjs', import.meta.url));

export interface RunRequest {
  /** `file:line` filters. Empty: every test. */
  locations: readonly string[];
  projects: readonly string[];
  workers?: number;
  maxFailures?: number;
  /** Where the reporter writes (the run file's `results`). */
  results: string;
}

export interface RunnerOutcome {
  results: RunResults | undefined;
  timedOut: boolean;
  stderr: string;
  wallMs: number;
}

export interface TestRunner {
  run(request: RunRequest, timeoutMs: number): Promise<RunnerOutcome>;
}

export interface RunnerOptions {
  /** @playwright/test's cli.js. */
  cli: string;
  /** The generated config. */
  config: string;
  cwd: string;
  runFile: string;
}

export function createProcessRunner(options: RunnerOptions): TestRunner {
  return {
    async run(request, timeoutMs) {
      const args = [
        options.cli,
        'test',
        '--config',
        options.config,
        `--reporter=${REPORTER}`,
        '--retries=0',
        ...(request.workers ? [`--workers=${request.workers}`] : []),
        ...(request.maxFailures ? [`--max-failures=${request.maxFailures}`] : []),
        ...request.projects.map((p) => `--project=${p}`),
        ...request.locations,
      ];
      const started = performance.now();
      const child = spawn(process.execPath, args, {
        cwd: options.cwd,
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, [RUN_FILE_ENV]: options.runFile, FORCE_COLOR: '0' },
      });
      const stderr = collect(child);
      let timedOut = false;
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            timedOut = true;
            killGroup(child);
          }, timeoutMs)
        : undefined;
      await new Promise<void>((done) => child.on('close', () => done()));
      clearTimeout(timer);
      // Browsers and workers Playwright started are in the same group; make sure none outlives the run.
      killGroup(child);
      return { results: readResults(request.results), timedOut, stderr: stderr(), wallMs: performance.now() - started };
    },
  };
}

function readResults(path: string): RunResults | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunResults;
  } catch {
    return undefined;
  } finally {
    rmSync(path, { force: true });
  }
}

function collect(child: ChildProcess): () => string {
  let text = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (text.length < 64 * 1024) text += chunk.toString();
  });
  return () => text;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}
