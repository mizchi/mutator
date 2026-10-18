import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ConfigError } from '../src/config.ts';
import { DEFAULT_SKILL_DIR, initSkills, shippedSkills } from '../src/init-skill.ts';
import { parseInitSkillCli } from '../src/options.ts';

const cli = join(import.meta.dirname, '../src/cli.ts');
const shipped = join(import.meta.dirname, '../skills');
const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [cli, 'init-skill', ...args], { cwd, encoding: 'utf8' });

function withProject(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mutator-init-skill-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the repository's mutation-test-loop skill is the shipped one, byte for byte", () => {
  const repoCopy = join(import.meta.dirname, '../../../.claude/skills/mutation-test-loop/SKILL.md');
  expect(readFileSync(repoCopy).equals(readFileSync(join(shipped, 'mutation-test-loop/SKILL.md')))).toBe(true);
});

test('the shipped skills are every directory under skills/', () => {
  expect(shippedSkills()).toEqual(['mutation-test-loop', 'mutator']);
});

test('the default directory is the one Claude Code reads project skills from', () => {
  expect(DEFAULT_SKILL_DIR).toBe(join('.claude', 'skills'));
});

test('initSkills copies every shipped skill with all its files under the given directory', () =>
  withProject((dir) => {
    const target = join(dir, 'agents/skills');
    expect(initSkills(target)).toEqual([
      { skill: 'mutation-test-loop', path: join(target, 'mutation-test-loop'), status: 'written' },
      { skill: 'mutator', path: join(target, 'mutator'), status: 'written' },
    ]);
    for (const file of ['mutation-test-loop/SKILL.md', 'mutator/SKILL.md', 'mutator/references/config.md']) {
      expect(readFileSync(join(target, file), 'utf8'), file).toBe(readFileSync(join(shipped, file), 'utf8'));
    }
  }));

test('initSkills leaves up-to-date copies alone', () =>
  withProject((dir) => {
    const skills = join(dir, DEFAULT_SKILL_DIR);
    initSkills(skills);
    expect(initSkills(skills).map((r) => r.status)).toEqual(['unchanged', 'unchanged']);
  }));

test('initSkills writes nothing while a copy differs, unless forced', () =>
  withProject((dir) => {
    const skills = join(dir, DEFAULT_SKILL_DIR);
    const edited = join(skills, 'mutator/references/ci.md');
    mkdirSync(join(skills, 'mutator/references'), { recursive: true });
    writeFileSync(edited, 'my edits\n');
    expect(() => initSkills(skills)).toThrow(new ConfigError(`init-skill: ${edited} differs from the shipped skill; rerun with --force to overwrite it`));
    expect(readFileSync(edited, 'utf8')).toBe('my edits\n');
    // All or nothing: the other skill was not written either.
    expect(existsSync(join(skills, 'mutation-test-loop'))).toBe(false);
    expect(initSkills(skills, true).map((r) => r.status)).toEqual(['written', 'written']);
    expect(readFileSync(edited, 'utf8')).toBe(readFileSync(join(shipped, 'mutator/references/ci.md'), 'utf8'));
  }));

test('parseInitSkillCli reads --dir, --force and --help, and rejects anything else', () => {
  expect(parseInitSkillCli([])).toEqual({});
  expect(parseInitSkillCli(['--dir', 'x', '--force', '-h'])).toEqual({ dir: 'x', force: true, help: true });
  expect(() => parseInitSkillCli(['--bogus'])).toThrow(ConfigError);
  expect(() => parseInitSkillCli(['extra'])).toThrow(/^init-skill: /);
});

test('the init-skill command says what it wrote, refuses a changed copy with exit 1, and --force overwrites it', () =>
  withProject((dir) => {
    const first = run(dir);
    expect(first.status).toBe(0);
    expect(first.stdout).toBe('wrote .claude/skills/mutation-test-loop\nwrote .claude/skills/mutator\n');
    writeFileSync(join(dir, '.claude/skills/mutator/SKILL.md'), 'my edits\n');
    const refused = run(dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('init-skill: .claude/skills/mutator/SKILL.md differs');
    const forced = run(dir, '--force');
    expect(forced.status).toBe(0);
    expect(forced.stdout).toBe('.claude/skills/mutation-test-loop is up to date\nwrote .claude/skills/mutator\n');
  }));
