import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config.ts';

export const DEFAULT_SKILL_DIR = join('.claude', 'skills');

/** The skills shipped in the package (skills-npm layout): `skills/` sits next to both `src/` and `dist/`. */
export const SHIPPED_SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));

export type InitSkillResult = { skill: string; path: string; status: 'written' | 'unchanged' };

/** Names of the shipped skills: the directories under skills/ with a SKILL.md. */
export function shippedSkills(): string[] {
  return readdirSync(SHIPPED_SKILLS)
    .filter((name) => existsSync(join(SHIPPED_SKILLS, name, 'SKILL.md')))
    .sort();
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => (statSync(join(dir, entry)).isDirectory() ? filesUnder(join(dir, entry)).map((f) => join(entry, f)) : [entry]))
    .sort();
}

/**
 * Copies every shipped skill, with all its files, to `<dir>/<skill>/`. Identical copies are left
 * alone. A file that differs from the shipped one stops the whole copy before anything is
 * written, unless `force`.
 */
export function initSkills(dir: string, force = false): InitSkillResult[] {
  const plan = shippedSkills().map((skill) => {
    const files = filesUnder(join(SHIPPED_SKILLS, skill)).map((file) => ({
      target: join(dir, skill, file),
      content: readFileSync(join(SHIPPED_SKILLS, skill, file)),
    }));
    const stale = files.filter(({ target, content }) => !existsSync(target) || !readFileSync(target).equals(content));
    return { skill, path: join(dir, skill), files, stale };
  });
  if (!force) {
    for (const { target } of plan.flatMap((p) => p.stale)) {
      if (existsSync(target)) throw new ConfigError(`init-skill: ${target} differs from the shipped skill; rerun with --force to overwrite it`);
    }
  }
  return plan.map(({ skill, path, stale }) => {
    for (const { target, content } of stale) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    return { skill, path, status: stale.length > 0 ? 'written' : 'unchanged' };
  });
}
