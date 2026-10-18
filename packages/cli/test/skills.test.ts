// The agent skills the packages ship (skills-npm convention: <package>/skills/<name>/SKILL.md,
// `skills` in package.json `files`), checked against the Agent Skills specification and against
// the CLI they describe.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { BUILTIN_MUTATOR_NAMES, DEFAULT_ARID_CALLEES } from '@mizchi/mutator-core';
import { CONFIG_KEYS } from '../src/config.ts';

const packages = join(import.meta.dirname, '../..');
const cli = join(import.meta.dirname, '../src/cli.ts');

interface Skill {
  pkg: string;
  name: string;
  dir: string;
  frontmatter: Record<string, string>;
  /** SKILL.md and every Markdown file under the skill directory. */
  files: { path: string; text: string }[];
}

function markdownUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownUnder(path);
    return path.endsWith('.md') ? [path] : [];
  });
}

/** Top-level `key: value` lines of the YAML frontmatter (the fields the spec defines are scalars). */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return {};
  return Object.fromEntries(
    match[1]!
      .split('\n')
      .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
      .filter((m) => m !== null)
      .map((m) => [m[1]!, m[2]!.trim()]),
  );
}

const skills: Skill[] = readdirSync(packages).flatMap((pkg) => {
  const root = join(packages, pkg, 'skills');
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => {
    const dir = join(root, name);
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    return { pkg, name, dir, frontmatter: frontmatter(text), files: markdownUnder(dir).map((path) => ({ path, text: readFileSync(path, 'utf8') })) };
  });
});

test('the packages ship the skills for using mutator', () => {
  expect(skills.map((s) => `${s.pkg}/${s.name}`).sort()).toEqual(['cli/mutation-test-loop', 'cli/mutator', 'playwright/mutator-playwright']);
});

describe.each(skills)('$pkg/skills/$name', (skill) => {
  test('follows the Agent Skills specification', () => {
    const { name, description, compatibility } = skill.frontmatter;
    expect(name).toBe(skill.name);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(name!.length).toBeLessThanOrEqual(64);
    expect(description?.length).toBeGreaterThan(0);
    expect(description!.length).toBeLessThanOrEqual(1024);
    if (compatibility !== undefined) expect(compatibility.length).toBeLessThanOrEqual(500);
    // Progressive disclosure: details belong in references/.
    expect(readFileSync(join(skill.dir, 'SKILL.md'), 'utf8').split('\n').length).toBeLessThanOrEqual(500);
  });

  test('is published: the package lists skills in its files', () => {
    const manifest = JSON.parse(readFileSync(join(packages, skill.pkg, 'package.json'), 'utf8')) as { files: string[] };
    expect(manifest.files).toContain('skills');
  });

  test('links only to files inside the skill', () => {
    for (const { path, text } of skill.files) {
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        const file = resolve(dirname(path), target!);
        expect(existsSync(file), `${path}: ${target}`).toBe(true);
        expect(file.startsWith(skill.dir), `${path}: ${target} leaves the skill`).toBe(true);
      }
    }
  });
});

test('every mutator option the skills mention exists in the CLI', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' }).stdout;
  const known = new Set([...help.matchAll(/--(?:\[no-\])?([a-z][a-z-]*)/g)].map((m) => m[1]!));
  for (const option of [...known]) known.add(`no-${option}`);
  const mentioned = new Set<string>();
  for (const skill of skills) {
    for (const { text } of skill.files) {
      // Options on the lines that run mutator (commands, and the flags column of the config table).
      for (const line of text.split('\n').filter((l) => /\bmutator\b/.test(l) || /^\| `[a-zA-Z]+` \| `--/.test(l))) {
        for (const [, option] of line.matchAll(/(?<![\w-])--(?:\[no-\])?([a-z][a-z-]*)/g)) mentioned.add(option!);
      }
    }
  }
  // Options of other tools that appear on the same lines.
  for (const other of ['project', 'max-failures', 'retries', 'workers', 'output']) known.add(other);
  expect([...mentioned].filter((o) => !known.has(o)).sort()).toEqual([]);
});

test('the configuration reference documents every config key', () => {
  const reference = readFileSync(join(packages, 'cli/skills/mutator/references/config.md'), 'utf8');
  expect(CONFIG_KEYS.filter((key) => key !== '$schema' && !reference.includes(`| \`${key}\` |`))).toEqual([]);
});

test('the plugins reference lists every built-in mutator and the default logging patterns', () => {
  const reference = readFileSync(join(packages, 'cli/skills/mutator/references/plugins.md'), 'utf8');
  const listed = [...reference.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]);
  expect(listed).toEqual([...BUILTIN_MUTATOR_NAMES]);
  for (const reference of ['plugins.md', 'config.md']) {
    const text = readFileSync(join(packages, 'cli/skills/mutator/references', reference), 'utf8');
    for (const callee of DEFAULT_ARID_CALLEES) expect(text, `${reference}: ${callee}`).toContain(`\`${callee}\``);
  }
});
