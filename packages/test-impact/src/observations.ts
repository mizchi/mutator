import { normalizeRelativePath } from './paths.ts';
import type { SourceObservation } from './source-coverage.ts';

function record(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Expected an object at ${location}`);
  }
  return value as Record<string, unknown>;
}

/** Both paths and IDs may contain '#'. Match the file against the actual edits
 * before normalizing, leaving the remainder of the opaque scope ID intact. */
function changedScopes(keys: string[], changes: ReadonlyMap<string, unknown>): string[] {
  const result = new Set<string>();
  for (const key of keys) {
    for (let i = key.indexOf('#'); i >= 0; i = key.indexOf('#', i + 1)) {
      const file = normalizeRelativePath(key.slice(0, i));
      if (changes.has(file)) result.add(file + key.slice(i));
    }
  }
  return [...result];
}

export function readObservations(value: unknown, changes: ReadonlyMap<string, unknown>) {
  const groups = new Map<string, Map<string, SourceObservation>>();
  for (const [file, group] of Object.entries(record(value, 'observations'))) {
    const path = normalizeRelativePath(file);
    const tests = groups.get(path) ?? new Map<string, SourceObservation>();
    groups.set(path, tests);
    const location = `observations[${JSON.stringify(file)}]`;
    for (const [id, input] of Object.entries(record(group, location))) {
      const at = location + '[' + JSON.stringify(id) + ']';
      const { complete, scopes } = record(input, at);
      if (typeof complete !== 'boolean') throw new TypeError(`Expected a boolean at ${at}.complete`);
      if (!Array.isArray(scopes) || !scopes.every((scope): scope is string => typeof scope === 'string')) {
        throw new TypeError(`Expected an array of strings at ${at}.scopes`);
      }
      const previous = tests.get(id);
      const normalized = changedScopes(scopes, changes);
      tests.set(id, previous
        ? { scopes: [...new Set([...previous.scopes, ...normalized])], complete: previous.complete && complete }
        : { scopes: normalized, complete });
    }
  }
  return groups;
}
