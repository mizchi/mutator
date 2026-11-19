// Reads the JUnit XML `bun test --reporter=junit` writes. Only the subset Bun emits is
// understood: nested <testsuite> elements (a file, then its describe blocks) holding
// <testcase> elements with optional <failure>, <error> and <skipped> children.

export interface JunitTest {
  /** Describe blocks and test name joined by spaces: what `--test-name-pattern` matches. */
  fullName: string;
  state: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  /** Failure and error messages. */
  messages: string[];
}

export interface JunitFile {
  /** The test file as Bun names it (relative to the working directory). */
  file: string;
  /** In report order, which is declaration order. */
  tests: JunitTest[];
}

const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>/g;
const ATTRIBUTE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

function attributes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(ATTRIBUTE)) out[m[1]!] = decodeEntities(m[2] ?? m[3] ?? '');
  return out;
}

export function parseJunit(xml: string): JunitFile[] {
  const files: JunitFile[] = [];
  // Open <testsuite> names, outermost (the file) first.
  const suites: string[] = [];
  let file: JunitFile | undefined;
  let test: JunitTest | undefined;
  // The <failure> / <error> being read: its message attribute, then its text.
  let failure: { message: string; text: string } | undefined;
  let last = 0;
  const close = (name: string) => {
    if (name === 'testsuite') {
      suites.pop();
      if (suites.length === 0) file = undefined;
    } else if (name === 'testcase') test = undefined;
    else if ((name === 'failure' || name === 'error') && failure) {
      test?.messages.push(failure.text.trim() || failure.message);
      failure = undefined;
    }
  };
  for (const m of xml.matchAll(TAG)) {
    if (failure) failure.text += decodeEntities(xml.slice(last, m.index)) + (m[5] ?? '');
    last = m.index + m[0].length;
    const [, closing, name, attrs = '', selfClosing] = m;
    if (!name) continue;
    if (closing) {
      close(name);
      continue;
    }
    const a = attributes(attrs);
    if (name === 'testsuite') {
      if (suites.length === 0) {
        file = { file: a.file ?? a.name ?? '', tests: [] };
        files.push(file);
      }
      suites.push(a.name ?? '');
    } else if (name === 'testcase' && file) {
      const fullName = [...suites.slice(1), a.name ?? ''].join(' ');
      const seconds = Number(a.time);
      test = { fullName, state: 'passed', durationMs: Number.isFinite(seconds) ? seconds * 1000 : 0, messages: [] };
      file.tests.push(test);
    } else if (name === 'skipped' && test) {
      test.state = 'skipped';
    } else if ((name === 'failure' || name === 'error') && test) {
      test.state = 'failed';
      failure = { message: a.message ?? '', text: '' };
    }
    if (selfClosing) close(name);
  }
  return files;
}
