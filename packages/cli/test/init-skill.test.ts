import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { DEFAULT_SKILL_DIR, initSkill } from '../src/init-skill.ts';
import { parseInitSkillCli } from '../src/options.ts';

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

test('the default directory is the one Claude Code reads project skills from', () => {
  expect(DEFAULT_SKILL_DIR).toBe(join('.claude', 'skills'));
});

test('initSkill writes under the given directory', () =>
  withProject((dir) => {
    const result = initSkill(join(dir, 'agents/skills'));
    expect(result).toEqual({ path: join(dir, 'agents/skills/mutation-test-loop/SKILL.md'), status: 'written' });
    expect(readFileSync(result.path, 'utf8')).toBe(readFileSync(shipped, 'utf8'));
  }));

test('initSkill leaves an up-to-date copy alone', () =>
  withProject((dir) => {
    const skills = join(dir, DEFAULT_SKILL_DIR);
    initSkill(skills);
    expect(initSkill(skills)).toEqual({ path: join(skills, 'mutation-test-loop/SKILL.md'), status: 'unchanged' });
  }));

test('initSkill refuses to overwrite a changed copy unless forced', () =>
  withProject((dir) => {
    const skills = join(dir, DEFAULT_SKILL_DIR);
    const target = join(skills, 'mutation-test-loop/SKILL.md');
    mkdirSync(join(skills, 'mutation-test-loop'), { recursive: true });
    writeFileSync(target, 'my edits\n');
    expect(() => initSkill(skills)).toThrow(new ConfigError(`init-skill: ${target} differs from the shipped skill; rerun with --force to overwrite it`));
    expect(readFileSync(target, 'utf8')).toBe('my edits\n');
    expect(initSkill(skills, true)).toEqual({ path: target, status: 'written' });
    expect(readFileSync(target, 'utf8')).toBe(readFileSync(shipped, 'utf8'));
  }));

test('parseInitSkillCli reads --dir, --force and --help, and rejects anything else', () => {
  expect(parseInitSkillCli([])).toEqual({});
  expect(parseInitSkillCli(['--dir', 'x', '--force', '-h'])).toEqual({ dir: 'x', force: true, help: true });
  expect(() => parseInitSkillCli(['--bogus'])).toThrow(ConfigError);
  expect(() => parseInitSkillCli(['extra'])).toThrow(/^init-skill: /);
});

test('the init-skill command refuses a changed copy with exit 1, and --force overwrites it', () =>
  withProject((dir) => {
    const target = join(dir, '.claude/skills/mutation-test-loop/SKILL.md');
    mkdirSync(join(dir, '.claude/skills/mutation-test-loop'), { recursive: true });
    writeFileSync(target, 'my edits\n');
    const refused = run(dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('init-skill: .claude/skills/mutation-test-loop/SKILL.md differs');
    const forced = run(dir, '--force');
    expect(forced.status).toBe(0);
    expect(forced.stdout).toContain('wrote .claude/skills/mutation-test-loop/SKILL.md');
    expect(run(dir).stdout).toContain('.claude/skills/mutation-test-loop/SKILL.md is up to date');
  }));
