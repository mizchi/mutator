import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const cli = join(import.meta.dirname, '../src/cli.ts');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('--help documents config files and exit codes', () => {
  const { status, stdout } = run('--help');
  expect(status).toBe(0);
  expect(stdout).toContain('--config-file <file>');
  expect(stdout).toContain('--threshold-break <n>');
  expect(stdout).toMatch(/exit codes:\s+0 [^\n]+\n\s+1 [^\n]+\n\s+2 [^\n]+\n\s+4 /);
});

test('an invalid config file exits 1 with the reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'mutator-cli-'));
  writeFileSync(join(root, 'mutator.config.json'), '{"concurency": 2}');
  const { status, stderr } = run('--root', root);
  expect(status).toBe(1);
  expect(stderr).toContain('mutator.config.json: unknown key "concurency"');
});
