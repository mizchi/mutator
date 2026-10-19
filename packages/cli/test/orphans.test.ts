import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { type ProcessInfo, type RunRecord, descendantsIn, orphansToKill, processTable, readRecords, writeRecord } from '../src/orphans.ts';

const proc = (pid: number, ppid: number, start: string): ProcessInfo => ({ pid, ppid, start });

test('only workers of a run whose CLI is gone, still orphaned and started when recorded, are killed', () => {
  const records: RunRecord[] = [
    // The CLI is gone: its orphaned worker goes, one re-parented elsewhere stays, a reused pid stays.
    { cli: proc(100, 1, 'T0'), workers: [proc(101, 100, 'T1'), proc(102, 100, 'T2'), proc(103, 100, 'T3')] },
    // Still running (same pid and start): untouched.
    { cli: proc(200, 1, 'T0'), workers: [proc(201, 200, 'T1')] },
    // The CLI's pid was reused by another process: the run is over; its orphan goes.
    { cli: proc(300, 1, 'T0'), workers: [proc(301, 300, 'T1')] },
  ];
  const table = [proc(101, 1, 'T1'), proc(102, 55, 'T2'), proc(103, 1, 'other start'), proc(200, 1, 'T0'), proc(201, 1, 'T1'), proc(300, 1, 'later'), proc(301, 1, 'T1')];
  expect(orphansToKill(records, table)).toEqual([101, 301]);
});

test('descendants follow children of children, not siblings or the process itself', () => {
  const table = [proc(10, 1, 'a'), proc(11, 10, 'b'), proc(12, 11, 'c'), proc(13, 10, 'd'), proc(20, 1, 'e'), proc(21, 20, 'f')];
  expect(descendantsIn(table, 10).map((p) => p.pid).sort()).toEqual([11, 12, 13]);
  expect(descendantsIn(table, 12)).toEqual([]);
});

test('records are written per run and read back; unreadable ones are skipped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-orphans-'));
  try {
    expect(readRecords(dir)).toEqual([]);
    writeRecord(dir, { cli: proc(1, 0, 'a'), workers: [proc(2, 1, 'b')] });
    writeFileSync(join(dir, 'processes/3.json'), '{ not json');
    expect(readdirSync(join(dir, 'processes')).sort()).toEqual(['1.json', '3.json']);
    expect(readRecords(dir)).toEqual([{ file: join(dir, 'processes/1.json'), record: { cli: proc(1, 0, 'a'), workers: [proc(2, 1, 'b')] } }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('processTable lists this process with its parent and its start time (lstart: weekday, month, day, time, year)', () => {
  const me = processTable().find((p) => p.pid === process.pid);
  expect(me).toMatchObject({ pid: process.pid, ppid: process.ppid });
  expect(me?.start).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
});
