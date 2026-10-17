import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const cli = join(import.meta.dirname, '../src/cli.ts');
const shipped = join(import.meta.dirname, '../skills/mutation-test-loop/SKILL.md');
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'init-skill', ...args], { cwd, encoding: 'utf8' });

function withProject(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-init-skill-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the repository's skill is the shipped one, byte for byte", () => {
  const repoCopy = join(import.meta.dirname, '../../../.claude/skills/mutation-test-loop/SKILL.md');
  expect(readFileSync(repoCopy).equals(readFileSync(shipped))).toBe(true);
});

test('the shipped skill is in the published files', () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8'));
  expect(pkg.files).toContain('skills');
});

test('init-skill copies the skill into .claude/skills and says where', () =>
  withProject((dir) => {
    const { status, stdout } = run(dir);
    expect(status).toBe(0);
    const target = join(dir, '.claude/skills/mutation-test-loop/SKILL.md');
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(shipped, 'utf8'));
    expect(stdout).toContain('wrote .claude/skills/mutation-test-loop/SKILL.md');
  }));

test('init-skill --dir writes under the given directory', () =>
  withProject((dir) => {
    const { status } = run(dir, '--dir', 'agents/skills');
    expect(status).toBe(0);
    expect(existsSync(join(dir, 'agents/skills/mutation-test-loop/SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  }));

test('init-skill is a no-op when the copy is already up to date', () =>
  withProject((dir) => {
    expect(run(dir).status).toBe(0);
    const again = run(dir);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain('.claude/skills/mutation-test-loop/SKILL.md is up to date');
  }));

test('init-skill refuses to overwrite a changed copy unless --force', () =>
  withProject((dir) => {
    const target = join(dir, '.claude/skills/mutation-test-loop/SKILL.md');
    mkdirSync(join(dir, '.claude/skills/mutation-test-loop'), { recursive: true });
    writeFileSync(target, 'my edits\n');
    const refused = run(dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('init-skill: .claude/skills/mutation-test-loop/SKILL.md differs');
    expect(refused.stderr).toContain('--force');
    expect(readFileSync(target, 'utf8')).toBe('my edits\n');
    const forced = run(dir, '--force');
    expect(forced.status).toBe(0);
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(shipped, 'utf8'));
    expect(forced.stdout).toContain('wrote .claude/skills/mutation-test-loop/SKILL.md');
  }));

test('init-skill rejects unknown options and stray arguments', () =>
  withProject((dir) => {
    for (const args of [['--bogus'], ['extra']]) {
      const { status, stderr } = run(dir, ...args);
      expect(status).toBe(1);
      expect(stderr).toContain('init-skill:');
    }
  }));
