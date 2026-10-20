// What a mutant's status means for the score: detected (a test noticed it), undetected (a gap),
// or neither (accepted, not type-checking, not run), which the score leaves out.
import type { MutantStatus } from '@mizchi/mutator-core';

export const isDetected = (status: MutantStatus): boolean => status === 'Killed' || status === 'Timeout' || status === 'RuntimeError';

/** Survived (not detected or not infected) or NoCoverage (not reached); accepted ones are Ignored. */
export const isUndetected = (status: MutantStatus): boolean => status === 'Survived' || status === 'NoCoverage';

/** Detected over detected and undetected; 1 when there is neither. */
export function score(entries: readonly { status: MutantStatus }[]): number {
  const detected = entries.filter((e) => isDetected(e.status)).length;
  const undetected = entries.filter((e) => isUndetected(e.status)).length;
  return detected + undetected === 0 ? 1 : detected / (detected + undetected);
}
