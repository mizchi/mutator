import { reported } from './gate.ts';
import { type Gap, gapOf } from './report.ts';
import type { Report } from './run.ts';
import type { DetectionRegression } from './test-impact.ts';

/** Additive, machine-readable findings; warnings never imply that a test can be deleted. */
export type WorkflowFinding =
  | { kind: 'criticalGap' | 'mutationGap'; severity: 'error' | 'warning'; key: string; gap: Gap | 'notRun'; message: string }
  | ({ kind: 'detectionRegression'; severity: 'warning'; message: string } & DetectionRegression)
  | { kind: 'newTestNoKills'; severity: 'warning'; test: string; measured: number; message: string }
  | { kind: 'testNotMeasured'; severity: 'info'; test: string; reason: 'notReached' | 'incomplete'; message: string };

export function workflowFindings(report: Report): WorkflowFinding[] {
  const critical = new Set(report.criticalMutants);
  const findings: WorkflowFinding[] = [];
  for (const entry of reported(report)) {
    const gap = gapOf(entry) ?? (entry.status === 'Pending' && critical.has(entry.mutant.key) ? 'notRun' : undefined);
    if (!gap) continue;
    const required = critical.has(entry.mutant.key);
    findings.push({ kind: required ? 'criticalGap' : 'mutationGap', severity: required ? 'error' : 'warning', key: entry.mutant.key, gap,
      message: required ? 'Critical mutant must be detected or explicitly accepted; pending work must run.' : 'Review this undetected mutant; strengthen a test or record why it is equivalent.' });
  }
  for (const regression of report.regressions ?? []) findings.push({ kind: 'detectionRegression', severity: 'warning', ...regression,
    message: 'Previously detected in unchanged code, now undetected: review the changed tests and their dependencies.' });
  const added = new Set(report.testChanges?.added);
  for (const observation of report.killMatrix?.observations ?? []) {
    if (!added.has(observation.test)) continue;
    if (observation.status === 'noKills') findings.push({ kind: 'newTestNoKills', severity: 'warning', test: observation.test, measured: observation.measured,
      message: 'New test detects none of the measured mutants; review its assertions and the enabled mutation rules.' });
    else if (observation.status === 'notReached' || observation.status === 'incomplete') findings.push({ kind: 'testNotMeasured', severity: 'info', test: observation.test, reason: observation.status,
      message: 'Detection power is not established by this run; check the selected code, mutation rules and incomplete work.' });
  }
  return findings;
}
