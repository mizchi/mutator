// Workers left behind by a run that was killed (SIGKILL, a crashed CLI): a worker stuck in a
// mutant's loop cannot notice its parent going away and keeps spinning. A run records the
// processes it started (pid and start time) under .mutator/processes/; the next run kills
// those whose run is gone, that are still orphaned (parent 1) and started when recorded, so a
// reused pid or another project's process is never touched.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** As `ps` prints it (lstart): with the pid, identifies one process. */
  start: string;
}

export interface RunRecord {
  cli: ProcessInfo;
  workers: ProcessInfo[];
}

/** Every process with its parent and start time; empty where `ps` is unavailable. */
export function processTable(): ProcessInfo[] {
  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  } catch {
    return [];
  }
  return table
    .trim()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), start: m[3]! }));
}

/** The recorded workers to kill: their run is gone, and each is still the same orphaned process. */
export function orphansToKill(records: readonly RunRecord[], table: readonly ProcessInfo[]): number[] {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const same = (recorded: ProcessInfo) => byPid.get(recorded.pid)?.start === recorded.start;
  return records.filter((r) => !same(r.cli)).flatMap((r) => r.workers.filter((w) => same(w) && byPid.get(w.pid)!.ppid === 1).map((w) => w.pid));
}

/** The processes below `pid` in `table`. */
export function descendantsIn(table: readonly ProcessInfo[], pid: number): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    const parent = pending.pop()!;
    for (const p of table) if (p.ppid === parent) out.push(p), pending.push(p.pid);
  }
  return out;
}

const recordsDir = (dir: string) => join(dir, 'processes');

export function writeRecord(dir: string, record: RunRecord): void {
  mkdirSync(recordsDir(dir), { recursive: true });
  writeFileSync(join(recordsDir(dir), `${record.cli.pid}.json`), JSON.stringify(record));
}

export function readRecords(dir: string): { file: string; record: RunRecord }[] {
  let names: string[];
  try {
    names = readdirSync(recordsDir(dir));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(recordsDir(dir), name);
    try {
      return [{ file, record: JSON.parse(readFileSync(file, 'utf8')) as RunRecord }];
    } catch {
      return [];
    }
  });
}

/** Kills what interrupted runs left behind and drops their records; returns how many were killed. */
export function reapOrphans(dir: string): number {
  const records = readRecords(dir);
  if (records.length === 0) return 0;
  const table = processTable();
  const killed = orphansToKill(
    records.map((r) => r.record),
    table,
  );
  for (const pid of killed) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  const alive = new Map(table.map((p) => [p.pid, p.start]));
  for (const { file, record } of records) if (alive.get(record.cli.pid) !== record.cli.start) rmSync(file, { force: true });
  return killed.length;
}

/**
 * Records this process's descendants every `intervalMs` until the returned function is called,
 * which removes the record (a normal end leaves nothing to reap).
 */
export function recordProcesses(dir: string, intervalMs = 2000): () => void {
  const update = () => {
    const table = processTable();
    const me = table.find((p) => p.pid === process.pid);
    if (!me) return;
    writeRecord(dir, { cli: me, workers: descendantsIn(table, process.pid) });
  };
  update();
  const timer = setInterval(update, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    rmSync(join(recordsDir(dir), `${process.pid}.json`), { force: true });
  };
}
