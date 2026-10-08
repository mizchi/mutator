// Small, dependency free regex pattern mutator (a subset of weapon-regex level 1).
// The pattern is tokenized just enough to know which characters are anchors,
// quantifiers, predefined classes and character classes; escapes and the inside
// of character classes are never edited (except for the class negation itself).

interface Edit {
  start: number;
  end: number;
  text: string;
}

const PREDEFINED: Record<string, string> = { d: 'D', D: 'd', w: 'W', W: 'w', s: 'S', S: 's' };
const BRACE_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

function collectEdits(pattern: string, flags: string): Edit[] {
  const edits: Edit[] = [];
  const unicodeSets = flags.includes('v');
  const n = pattern.length;
  /** Whether the previous token can take a quantifier. */
  let atom = false;
  let i = 0;
  const skipTo = (close: string) => {
    const end = pattern.indexOf(close, i);
    i = end < 0 ? n : end + 1;
  };
  while (i < n) {
    const c = pattern[i]!;
    if (c === '\\') {
      const start = i;
      const next = pattern[i + 1];
      i += 2;
      if (next !== undefined && 'pPku'.includes(next) && (pattern[i] === '{' || pattern[i] === '<')) {
        skipTo(pattern[i] === '{' ? '}' : '>');
      } else if (next !== undefined && Object.hasOwn(PREDEFINED, next)) {
        edits.push({ start: start + 1, end: start + 2, text: PREDEFINED[next]! });
      }
      atom = true;
      continue;
    }
    if (c === '[') {
      const start = i;
      i++;
      const negated = pattern[i] === '^';
      let depth = 1;
      while (i < n && depth > 0) {
        const ch = pattern[i]!;
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[' && unicodeSets) depth++;
        else if (ch === ']') depth--;
        i++;
      }
      edits.push(negated ? { start: start + 1, end: start + 2, text: '' } : { start: start + 1, end: start + 1, text: '^' });
      atom = true;
      continue;
    }
    if (c === '(') {
      i++;
      if (pattern[i] === '?') {
        i++;
        const kind = pattern[i];
        if (kind === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') skipTo('>');
        else if (kind === '<') i += 2;
        else if (kind === ':' || kind === '=' || kind === '!') i++;
        else skipTo(':'); // modifiers: (?i:...)
      }
      atom = false;
      continue;
    }
    if (c === ')') {
      i++;
      atom = true;
      continue;
    }
    if (c === '^' || c === '$') {
      edits.push({ start: i, end: i + 1, text: '' });
      i++;
      atom = false;
      continue;
    }
    if (c === '|') {
      i++;
      atom = false;
      continue;
    }
    if (c === '*' || c === '+' || c === '?') {
      const start = i;
      i++;
      if (pattern[i] === '?') i++;
      if (atom) edits.push({ start, end: i, text: '' });
      atom = false;
      continue;
    }
    if (c === '{') {
      const m = BRACE_QUANTIFIER.exec(pattern.slice(i));
      if (m && atom) {
        if (m[2] !== undefined) edits.push({ start: i, end: i + m[0].length, text: `{${m[1]}}` });
        i += m[0].length;
        if (pattern[i] === '?') i++;
        atom = false;
        continue;
      }
    }
    i++;
    atom = true;
  }
  return edits;
}

function isValid(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/** Mutated variants of `pattern`; every result is a valid regex under `flags` and differs from the input. */
export function regexMutations(pattern: string, flags: string): string[] {
  const out: string[] = [];
  for (const e of collectEdits(pattern, flags)) {
    const mutated = pattern.slice(0, e.start) + e.text + pattern.slice(e.end);
    if (mutated === pattern || out.includes(mutated) || !isValid(mutated, flags)) continue;
    out.push(mutated);
  }
  return out;
}
