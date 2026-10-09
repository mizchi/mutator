// mutation-testing-elements report (the format StrykerJS writes to reports/mutation/mutation.json).
// Schema: https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema
import { readFileSync } from 'node:fs';
import { extname, relative } from 'node:path';
import type { Position } from '@mizchi/mutator-core';
import { type Report, TOOL_VERSION } from './run.ts';

/** mutation-testing-elements release loaded by the HTML report (and the schema version tests validate against). */
export const MTE_VERSION = '3.9.0';

export interface MteMutant {
  id: string;
  mutatorName: string;
  replacement: string;
  /** 1-based line and column; end is exclusive. */
  location: { start: Position; end: Position };
  /** Our statuses (including Pending) are a subset of the schema's. */
  status: string;
  killedBy: string[];
  coveredBy: string[];
  statusReason?: string;
}

export interface MteReport {
  schemaVersion: '2';
  thresholds: { high: number; low: number };
  projectRoot: string;
  framework: { name: string; version: string };
  files: Record<string, { language: string; source: string; mutants: MteMutant[] }>;
  testFiles: Record<string, { tests: { id: string; name: string }[] }>;
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export function formatMutationTestingJson(report: Report, root: string): MteReport {
  const files: MteReport['files'] = {};
  const tests = new Set<string>();
  for (const { mutant, status, killedBy, coveredBy } of report.entries) {
    const path = relative(root, mutant.file);
    files[path] ??= {
      language: TS_EXTENSIONS.has(extname(path)) ? 'typescript' : 'javascript',
      source: readFileSync(mutant.file, 'utf8'),
      mutants: [],
    };
    const { start, end } = mutant.location;
    files[path].mutants.push({
      id: mutant.key,
      mutatorName: mutant.mutator,
      replacement: mutant.replacement,
      location: { start: { line: start.line, column: start.column + 1 }, end: { line: end.line, column: end.column + 1 } },
      status,
      killedBy,
      coveredBy,
      ...(mutant.ignored ? { statusReason: mutant.ignored } : {}),
    });
    for (const id of [...coveredBy, ...killedBy]) tests.add(id);
  }

  // Test ids are `<file>#<full name>`.
  const testFiles: MteReport['testFiles'] = {};
  for (const id of [...tests].sort()) {
    const hashAt = id.indexOf('#');
    const file = hashAt < 0 ? '' : id.slice(0, hashAt);
    (testFiles[file] ??= { tests: [] }).tests.push({ id, name: id.slice(hashAt + 1) });
  }

  return {
    schemaVersion: '2',
    thresholds: { high: 80, low: 60 },
    projectRoot: root,
    framework: { name: 'mutator', version: TOOL_VERSION },
    files,
    testFiles,
  };
}

/** Self-contained page: the JSON is inlined and the web component comes from a pinned CDN build. */
export function formatHtml(json: MteReport): string {
  // `<` keeps `</script>` inside sources from terminating the inline script.
  const data = JSON.stringify(json).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mutator report</title>
<script src="https://www.unpkg.com/mutation-testing-elements@${MTE_VERSION}/dist/mutation-test-elements.js"></script>
</head>
<body>
<mutation-test-report-app title-postfix="mutator">
  Your browser doesn't support custom elements. Please use a modern browser.
</mutation-test-report-app>
<script>
  const app = document.querySelector('mutation-test-report-app');
  app.report = ${data};
  function updateTheme() { document.body.style.backgroundColor = app.themeBackgroundColor; }
  app.addEventListener('theme-changed', updateTheme);
  updateTheme();
</script>
</body>
</html>
`;
}
