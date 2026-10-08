import type { MutatorName } from './types.ts';

export interface CommentLike {
  value: string;
  start: number;
  end: number;
}

interface Directive {
  kind: 'disable' | 'enable';
  /** undefined = all mutators */
  mutators: Set<string> | undefined;
  reason: string | undefined;
  /** 'line' applies to `line` only; 'region' applies from `offset` onwards. */
  scope: 'line' | 'region';
  line: number;
  offset: number;
}

// mutator-disable-next-line [Names][: reason] | mutator-disable-line ... | mutator-disable ... | mutator-enable ...
const OWN = /^\s*\*?\s*mutator-(disable-next-line|disable-line|disable|enable)\b([^:]*)(?::\s*(.*))?$/;
// Stryker disable|restore [next-line] names[: reason]
const STRYKER = /^\s*\*?\s*Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+?)\s*(?::\s*(.*))?$/;

function parseNames(text: string): Set<string> | undefined {
  const names = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length === 0 || names.some((n) => n.toLowerCase() === 'all') ? undefined : new Set(names);
}

function parse(comment: CommentLike, lineOf: (offset: number) => number): Directive | undefined {
  const line = lineOf(comment.start);
  const own = OWN.exec(comment.value);
  if (own) {
    const [, verb, names = '', reason] = own;
    const base = { mutators: parseNames(names), reason: reason?.trim() || undefined, offset: comment.end };
    switch (verb) {
      case 'disable-next-line':
        return { ...base, kind: 'disable', scope: 'line', line: lineOf(comment.end) + 1 };
      case 'disable-line':
        return { ...base, kind: 'disable', scope: 'line', line };
      case 'disable':
        return { ...base, kind: 'disable', scope: 'region', line };
      default:
        return { ...base, kind: 'enable', scope: 'region', line };
    }
  }
  const stryker = STRYKER.exec(comment.value);
  if (stryker) {
    const [, verb, nextLine, names = '', reason] = stryker;
    const base = { mutators: parseNames(names), reason: reason?.trim() || undefined, offset: comment.end };
    if (verb === 'disable' && nextLine) return { ...base, kind: 'disable', scope: 'line', line: lineOf(comment.end) + 1 };
    return { ...base, kind: verb === 'disable' ? 'disable' : 'enable', scope: 'region', line };
  }
  return undefined;
}

const matches = (d: Directive, mutator: string) => d.mutators === undefined || d.mutators.has(mutator);

/**
 * Build a lookup returning the ignore reason (`disabled` / `disabled: <reason>`)
 * for a mutant, or undefined when it is enabled.
 */
export function disabledBy(comments: readonly CommentLike[], lineOf: (offset: number) => number) {
  const directives = comments.map((c) => parse(c, lineOf)).filter((d): d is Directive => d !== undefined);
  if (directives.length === 0) return () => undefined;
  const regions = directives.filter((d) => d.scope === 'region').sort((a, b) => a.offset - b.offset);
  const lines = directives.filter((d) => d.scope === 'line');
  const label = (d: Directive) => (d.reason ? `disabled: ${d.reason}` : 'disabled');

  return (mutator: MutatorName, offset: number): string | undefined => {
    const line = lineOf(offset);
    const byLine = lines.find((d) => d.line === line && matches(d, mutator));
    if (byLine) return label(byLine);
    let active: Directive | undefined;
    for (const d of regions) {
      if (d.offset > offset) break;
      if (!matches(d, mutator)) continue;
      active = d.kind === 'disable' ? d : undefined;
    }
    return active && label(active);
  };
}
