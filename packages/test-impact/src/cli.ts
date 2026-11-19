#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { selectAffectedTests } from './index.ts';

try {
  const { values } = parseArgs({ options: {
    since: { type: 'string' }, root: { type: 'string' }, test: { type: 'string', multiple: true },
    coverage: { type: 'string' }, format: { type: 'string', default: 'files' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('test-impact --since <ref> [--root <dir>] [--test <file> ...] [--coverage <observations.json>] [--format files|json]');
  } else {
    if (!values.since) throw Error('--since <ref> is required');
    if (values.format !== 'files' && values.format !== 'json') throw Error('--format must be files or json');
    const result = await selectAffectedTests({
      root: resolve(values.root ?? '.'), since: values.since,
      ...(values.test ? { testFiles: values.test } : {}),
      ...(values.coverage ? { observations: JSON.parse(readFileSync(values.coverage, 'utf8')) } : {}),
    });
    if (values.format === 'json') console.log(JSON.stringify(result, null, 2));
    else if (result.files.length) console.log(result.files.join('\n'));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
