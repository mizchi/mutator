import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError } from './config.ts';

export const SKILL_NAME = 'mutation-test-loop';
export const DEFAULT_SKILL_DIR = join('.claude', 'skills');

/** The skill shipped in the package: `skills/` sits next to both `src/` and `dist/`. */
export const SHIPPED_SKILL = fileURLToPath(new URL(`../skills/${SKILL_NAME}/SKILL.md`, import.meta.url));

export type InitSkillResult = { path: string; status: 'written' | 'unchanged' };

/**
 * Copies the shipped skill to `<dir>/mutation-test-loop/SKILL.md`. An identical copy is left alone;
 * a different one is overwritten only with `force`.
 */
export function initSkill(dir: string, force = false): InitSkillResult {
  const path = join(dir, SKILL_NAME, 'SKILL.md');
  const content = readFileSync(SHIPPED_SKILL);
  if (existsSync(path)) {
    if (readFileSync(path).equals(content)) return { path, status: 'unchanged' };
    if (!force) throw new ConfigError(`init-skill: ${path} differs from the shipped skill; rerun with --force to overwrite it`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return { path, status: 'written' };
}
