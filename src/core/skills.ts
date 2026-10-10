/**
 * Agent Skills (https://agentskills.io): folders with a `SKILL.md` whose YAML
 * frontmatter carries `name` and `description`, followed by instructions.
 *
 * How Voicestage uses them, following the format's progressive disclosure:
 *   1. Every loaded skill's name and description are always in the system prompt.
 *   2. The body is loaded when the assistant decides the skill is relevant, by
 *      calling the built-in `load_skill` tool. (With `skillActivation: always`
 *      the bodies are placed in the system prompt instead, for models that do
 *      not call tools reliably.)
 *   3. Other files in the folder are read on request with `read_skill_file`.
 *
 * Scripts in a skill folder are never executed.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface LoadedSkill {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, unknown>;
  allowedTools?: string;
  body: string;
  /** Absolute folder path. */
  dir: string;
  /** Other files in the folder, relative to it. */
  files: string[];
  warnings: string[];
}

export class SkillError extends Error {}

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;
const NAME_RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_LISTED_FILES = 200;
const MAX_FILE_BYTES = 200_000;

/**
 * Put quotes around top-level plain values that contain a colon, the fallback
 * the Agent Skills guide for clients suggests for frontmatter that is not
 * strictly YAML. Quoted values, block scalars, lists and mappings are left alone.
 */
function quoteValuesWithColons(yaml: string): string {
  return yaml.replace(/^([A-Za-z][\w-]*):[ \t]+(?!["'|>[{&*!#])(.*:.*)$/gm, (_line, key: string, value: string) => `${key}: ${JSON.stringify(value.trim())}`);
}

/** Parse the text of a SKILL.md. `folder` is only used for messages and the name check. */
export function parseSkill(text: string, folder: string): Omit<LoadedSkill, 'dir' | 'files'> {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new SkillError(`${folder}/SKILL.md must start with YAML frontmatter between "---" lines.`);
  const warnings: string[] = [];
  let meta: unknown;
  try {
    meta = parseYaml(match[1]!);
  } catch (error) {
    // The most common mistake in the wild: `description: Use when: the user asks`.
    // Other clients read that, so read it too, and say so.
    try {
      meta = parseYaml(quoteValuesWithColons(match[1]!));
      warnings.push('the frontmatter is not valid YAML: a value contains a colon and is not quoted. It was read as if it were quoted.');
    } catch {
      throw new SkillError(`${folder}/SKILL.md has invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new SkillError(`${folder}/SKILL.md frontmatter must be a YAML mapping.`);
  const fields = meta as Record<string, unknown>;
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  const description = typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!name) throw new SkillError(`${folder}/SKILL.md frontmatter needs a "name".`);
  if (!description) throw new SkillError(`${folder}/SKILL.md frontmatter needs a "description".`);

  if (!NAME_RULE.test(name) || name.length > 64) warnings.push(`name "${name}" should be at most 64 lowercase letters, digits and single hyphens.`);
  if (basename(folder) !== name) warnings.push(`name "${name}" does not match the folder name "${basename(folder)}".`);
  if (description.length > 1024) warnings.push(`description is ${description.length} characters; the format allows 1024.`);

  return {
    name,
    description,
    license: typeof fields.license === 'string' ? fields.license : undefined,
    compatibility: typeof fields.compatibility === 'string' ? fields.compatibility : undefined,
    metadata: fields.metadata && typeof fields.metadata === 'object' ? (fields.metadata as Record<string, unknown>) : undefined,
    allowedTools: typeof fields['allowed-tools'] === 'string' ? (fields['allowed-tools'] as string) : undefined,
    body: match[2]!.trim(),
    warnings,
  };
}

function listFiles(dir: string, root: string = dir, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (found.length >= MAX_LISTED_FILES) break;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, root, found);
    else if (entry.isFile() && !(dir === root && entry.name === 'SKILL.md')) found.push(relative(root, full).split(sep).join('/'));
  }
  return found.sort();
}

function loadOne(dir: string): LoadedSkill {
  const parsed = parseSkill(readFileSync(join(dir, 'SKILL.md'), 'utf8'), dir);
  return { ...parsed, dir, files: listFiles(dir) };
}

/**
 * Load a skill folder, or every skill folder directly inside a parent folder.
 * Throws a `SkillError` that names the path when nothing can be loaded.
 */
export function loadSkills(path: string): LoadedSkill[] {
  const dir = resolve(path);
  if (!existsSync(dir)) throw new SkillError(`Skill path ${dir} does not exist.`);
  if (!statSync(dir).isDirectory()) throw new SkillError(`Skill path ${dir} is not a folder. Point at the folder that contains SKILL.md.`);
  if (existsSync(join(dir, 'SKILL.md'))) return [loadOne(dir)];
  const children = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'SKILL.md')))
    .map((entry) => loadOne(join(dir, entry.name)));
  if (children.length === 0) throw new SkillError(`No SKILL.md found in ${dir} or in the folders directly inside it.`);
  return children.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a file that ships with a skill. Stays inside the skill folder and refuses large or binary files. */
export function readSkillFile(skill: LoadedSkill, file: string): string {
  const target = resolve(skill.dir, file);
  if (target !== skill.dir && !target.startsWith(skill.dir + sep)) throw new SkillError(`"${file}" is outside the skill folder.`);
  if (!existsSync(target) || !statSync(target).isFile()) {
    throw new SkillError(`The skill "${skill.name}" has no file "${file}". Files: ${skill.files.join(', ') || 'none besides SKILL.md'}.`);
  }
  if (statSync(target).size > MAX_FILE_BYTES) throw new SkillError(`"${file}" is larger than ${MAX_FILE_BYTES / 1000} kB and was not read.`);
  const buffer = readFileSync(target);
  if (buffer.includes(0)) throw new SkillError(`"${file}" is not a text file.`);
  return buffer.toString('utf8');
}

/** The part of the system prompt that tells the assistant which skills exist. */
export function skillsPrompt(skills: LoadedSkill[], activation: 'tool' | 'always'): string {
  if (skills.length === 0) return '';
  if (activation === 'always') {
    return [
      '# Skills',
      'Follow these skills whenever they apply.',
      ...skills.map((skill) => `## Skill: ${skill.name}\n${skill.description}\n\n${skill.body}`),
    ].join('\n\n');
  }
  return [
    '# Skills',
    'You have skills: instructions written for particular kinds of request. Only their names and descriptions are listed here. When a request matches a description, call the `load_skill` tool with the skill name before doing anything else, then follow what it says. Load a skill once per conversation.',
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join('\n');
}

export const LOAD_SKILL_TOOL = 'load_skill';
export const READ_SKILL_FILE_TOOL = 'read_skill_file';

/** Definitions of the two built-in skill tools, in the same shape as an MCP tool. */
export function skillTools(skills: LoadedSkill[]): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => skill.name);
  const tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    {
      name: LOAD_SKILL_TOOL,
      description: 'Load the full instructions of one of your skills. Call this as soon as a request matches a skill description, before any other tool.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', enum: names, description: 'Name of the skill to load.' } }, required: ['name'], additionalProperties: false },
    },
  ];
  if (skills.some((skill) => skill.files.length > 0)) {
    tools.push({
      name: READ_SKILL_FILE_TOOL,
      description: 'Read a text file that ships with a skill, when the skill instructions point to it.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', enum: names, description: 'Name of the skill.' }, file: { type: 'string', description: 'Path of the file inside the skill folder.' } },
        required: ['name', 'file'],
        additionalProperties: false,
      },
    });
  }
  return tools;
}
