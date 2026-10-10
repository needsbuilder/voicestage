import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSkills, parseSkill, readSkillFile, SkillError, skillsPrompt, skillTools } from '../src/core/skills.js';

function skillFolder(name: string, frontmatter: string, body = '# Instructions\n\nDo the thing.'): string {
  const root = mkdtempSync(join(tmpdir(), 'voicestage-skills-'));
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

describe('Agent Skills', () => {
  it('parses frontmatter and body', () => {
    const skill = parseSkill('---\nname: pay-bills\ndescription: Pays bills safely.\nlicense: MIT\ncompatibility: Needs the pay tools.\nmetadata:\n  version: "1.2"\nallowed-tools: pay check\n---\n\n# Pay bills\n\nCall `check` first.\n', '/skills/pay-bills');
    expect(skill).toMatchObject({ name: 'pay-bills', description: 'Pays bills safely.', license: 'MIT', compatibility: 'Needs the pay tools.', metadata: { version: '1.2' }, allowedTools: 'pay check', warnings: [] });
    expect(skill.body).toBe('# Pay bills\n\nCall `check` first.');
  });

  it('requires frontmatter with a name and a description', () => {
    expect(() => parseSkill('# No frontmatter', '/s/x')).toThrow(/must start with YAML frontmatter/);
    expect(() => parseSkill('---\ndescription: d\n---\nbody', '/s/x')).toThrow(/needs a "name"/);
    expect(() => parseSkill('---\nname: x\n---\nbody', '/s/x')).toThrow(/needs a "description"/);
    expect(() => parseSkill('---\nname: x\ndescription: [a, b\n---\nbody', '/s/x')).toThrow(SkillError);
    expect(() => parseSkill('---\nname: x\ndescription: [a, b\n---\nbody', '/s/x')).toThrow(/invalid YAML frontmatter/);
    expect(() => parseSkill('---\n- a\n- b\n---\nbody', '/s/x')).toThrow(/must be a YAML mapping/);
  });

  it('reads a description with an unquoted colon, which is not valid YAML but common, and says so', () => {
    const skill = parseSkill('---\nname: pdf-help\ndescription: Use this skill when: the user asks about PDFs\nlicense: "MIT"\nmetadata:\n  author: example-org\n---\nbody', '/skills/pdf-help');
    expect(skill.description).toBe('Use this skill when: the user asks about PDFs');
    expect(skill.license).toBe('MIT');
    expect(skill.metadata).toEqual({ author: 'example-org' });
    expect(skill.warnings).toEqual([expect.stringMatching(/not valid YAML: a value contains a colon and is not quoted/)]);
    // Valid frontmatter is never rewritten.
    expect(parseSkill('---\nname: x\ndescription: "Use when: asked"\n---\nbody', '/s/x')).toMatchObject({ description: 'Use when: asked', warnings: [] });
    expect(parseSkill('---\nname: x\ndescription: >\n  Use when: asked\n---\nbody', '/s/x')).toMatchObject({ description: 'Use when: asked', warnings: [] });
  });

  it('warns about names the format does not allow, without refusing the skill', () => {
    const skill = parseSkill('---\nname: Pay_Bills\ndescription: d\n---\nbody', '/skills/other-folder');
    expect(skill.warnings).toEqual([expect.stringMatching(/lowercase letters, digits and single hyphens/), expect.stringMatching(/does not match the folder name "other-folder"/)]);
  });

  it('loads one skill folder, listing its other files', () => {
    const dir = skillFolder('timer-help', 'name: timer-help\ndescription: Helps with timers.');
    mkdirSync(join(dir, 'references'));
    writeFileSync(join(dir, 'references', 'units.md'), 'A minute is 60 seconds.');
    writeFileSync(join(dir, '.hidden'), 'x');
    const [skill] = loadSkills(dir);
    expect(skill).toMatchObject({ name: 'timer-help', dir, files: ['references/units.md'], warnings: [] });
  });

  it('loads every skill inside a parent folder', () => {
    const first = skillFolder('beta', 'name: beta\ndescription: Second.');
    const parent = resolve(first, '..');
    mkdirSync(join(parent, 'alpha'));
    writeFileSync(join(parent, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: First.\n---\nA');
    mkdirSync(join(parent, 'not-a-skill'));
    expect(loadSkills(parent).map((skill) => skill.name)).toEqual(['alpha', 'beta']);
  });

  it('says so when a path has no skills', () => {
    expect(() => loadSkills('/nope/skills')).toThrow(/does not exist/);
    expect(() => loadSkills(mkdtempSync(join(tmpdir(), 'voicestage-empty-')))).toThrow(/No SKILL.md found/);
  });

  it('reads files that ship with a skill, and nothing outside its folder', () => {
    const dir = skillFolder('timer-help', 'name: timer-help\ndescription: Helps with timers.');
    writeFileSync(join(dir, 'notes.md'), 'Notes.');
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0, 1, 2]));
    writeFileSync(join(resolve(dir, '..'), 'secret.txt'), 'secret');
    const [skill] = loadSkills(dir);
    expect(readSkillFile(skill!, 'notes.md')).toBe('Notes.');
    expect(() => readSkillFile(skill!, '../secret.txt')).toThrow(/outside the skill folder/);
    expect(() => readSkillFile(skill!, '/etc/hosts')).toThrow(/outside the skill folder/);
    expect(() => readSkillFile(skill!, 'missing.md')).toThrow(/has no file "missing.md"/);
    expect(() => readSkillFile(skill!, 'image.bin')).toThrow(/not a text file/);
  });

  it('puts only names and descriptions in the prompt by default, and bodies when asked to', () => {
    const skills = loadSkills(skillFolder('timer-help', 'name: timer-help\ndescription: Helps with timers.', 'SECRET BODY'));
    const listed = skillsPrompt(skills, 'tool');
    expect(listed).toContain('- timer-help: Helps with timers.');
    expect(listed).toContain('load_skill');
    expect(listed).not.toContain('SECRET BODY');
    expect(skillsPrompt(skills, 'always')).toContain('SECRET BODY');
    expect(skillsPrompt([], 'tool')).toBe('');
  });

  it('offers load_skill, and read_skill_file only when a skill has files', () => {
    const plain = loadSkills(skillFolder('timer-help', 'name: timer-help\ndescription: Helps with timers.'));
    expect(skillTools(plain).map((tool) => tool.name)).toEqual(['load_skill']);
    expect(skillTools(plain)[0]!.inputSchema).toMatchObject({ properties: { name: { enum: ['timer-help'] } }, required: ['name'] });
    const dir = skillFolder('with-files', 'name: with-files\ndescription: Has files.');
    writeFileSync(join(dir, 'notes.md'), 'Notes.');
    expect(skillTools(loadSkills(dir)).map((tool) => tool.name)).toEqual(['load_skill', 'read_skill_file']);
    expect(skillTools([])).toEqual([]);
  });

  it('loads the example skill that ships with the project', () => {
    const [skill] = loadSkills(resolve(import.meta.dirname, '../examples/skills/kitchen-helper'));
    expect(skill).toMatchObject({ name: 'kitchen-helper', warnings: [] });
    expect(skill!.description.length).toBeLessThanOrEqual(1024);
  });
});
