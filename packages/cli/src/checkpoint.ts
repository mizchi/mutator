// The finished snapshot remains the comparison baseline until the new run completes.
// SQLite commits each settled mutant independently, including across concurrent CLI processes.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { hash, type MutantRunResult } from '@mizchi/mutator-core';
import { resultOf, type Job, type Tally } from './tally.ts';

export class Checkpoint {
  private readonly db: DatabaseSync;
  private readonly store: StatementSync;
  private readonly inputs: string;
  private readonly promoted = new Set<string>();

  constructor(path: string, inputs: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.inputs = inputs;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS verdicts (
        inputs TEXT NOT NULL, job TEXT NOT NULL, outcome TEXT NOT NULL,
        PRIMARY KEY (inputs, job)
      ) WITHOUT ROWID;`);
    this.store = this.db.prepare('INSERT OR REPLACE INTO verdicts VALUES (?, ?, ?)');
  }

  restore(jobs: Job[], tally: Tally, killMatrix: boolean): Job[] {
    const rows = this.db.prepare('SELECT job, outcome FROM verdicts WHERE inputs = ?').all(this.inputs);
    if (!rows.length) return jobs;
    const outcomes = new Map(rows.map((row) => [String(row.job), String(row.outcome)]));
    return jobs.filter((job) => {
      const id = jobHash(job);
      const saved = outcomes.get(id);
      if (saved === undefined) return true;
      const { status, killedBy, durationMs }: MutantRunResult = JSON.parse(saved);
      const entry = {
        ...tally.report[job.index]!, status, killedBy, source: 'reuse' as const,
        ...(killMatrix && status === 'Killed' ? { matrix: true as const } : {}),
      };
      tally.settle(job.index, entry, resultOf(entry, { durationMs }));
      this.promoted.add(id);
      return false;
    });
  }

  save(job: Job, outcome: MutantRunResult): void {
    const id = jobHash(job);
    this.store.run(this.inputs, id, JSON.stringify(outcome));
    this.promoted.add(id);
  }

  /** Called only after the snapshot containing these verdicts has been published. */
  finish(): void {
    this.db.prepare('DELETE FROM verdicts WHERE inputs = ? AND job IN (SELECT value FROM json_each(?))')
      .run(this.inputs, JSON.stringify([...this.promoted]));
  }

  close(): void {
    this.db.close();
  }
}

function jobHash({ entry }: Job): string {
  // Test order varies with baseline timings. The selected set and static mode affect the verdict.
  return hash(JSON.stringify([entry.mutant.key, entry.isStatic, [...entry.tests].sort()]));
}
