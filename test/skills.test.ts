import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSkillPrompt,
  checkSkills,
  createSkill,
  getGlobalSkillsDir,
  getProjectSkillsDir,
  listSkills,
  loadSkill,
} from '../src/skills.js';

const originalCwd = process.cwd();
const originalSkillsDir = process.env.MYTHOS_SKILLS_DIR;
let tempDir = '';
let globalDir = '';

describe('Skill packs', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'mythos-skills-project-'));
    globalDir = mkdtempSync(join(tmpdir(), 'mythos-skills-global-'));
    process.env.MYTHOS_SKILLS_DIR = globalDir;
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSkillsDir === undefined) {
      delete process.env.MYTHOS_SKILLS_DIR;
    } else {
      process.env.MYTHOS_SKILLS_DIR = originalSkillsDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(globalDir, { recursive: true, force: true });
  });

  it('creates project-local skills by default', () => {
    const skill = createSkill('repo');

    assert.equal(skill.id, 'repo');
    assert.equal(skill.scope, 'project');
    assert.equal(skill.filePath, join(getProjectSkillsDir(), 'repo', 'SKILL.md'));

    const loaded = loadSkill('repo');
    assert.equal(loaded.scope, 'project');
    assert.equal(checkSkills('repo').ok, true);
  });

  it('lets project-local skills shadow global skills', () => {
    createSkill('repo', { scope: 'global' });
    createSkill('repo', { scope: 'project' });

    const loaded = loadSkill('repo');
    assert.equal(loaded.scope, 'project');

    const entries = listSkills().filter((entry) => entry.id === 'repo');
    assert.equal(entries.length, 2);
    assert.equal(entries.find((entry) => entry.scope === 'global')?.shadowed, true);
    assert.equal(entries.find((entry) => entry.scope === 'project')?.shadowed, false);
  });

  it('loads explicit skill file paths', () => {
    const skillDir = join(tempDir, 'custom-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, `---
name: custom
version: 1.0.0
description: Explicit path skill.
---

# Custom

Follow local project rules.
`, 'utf-8');

    const loaded = loadSkill(skillPath);
    assert.equal(loaded.scope, 'path');
    assert.equal(loaded.meta.name, 'custom');
  });

  it('parses skill frontmatter without regex-sensitive key matching', () => {
    const skillDir = join(tempDir, 'parser-skill');
    mkdirSync(skillDir, { recursive: true });
    const skillPath = join(skillDir, 'SKILL.md');
    writeFileSync(skillPath, `---
name: parser
version: 1.0.0
description: Safe parser skill.
requires-tools:
  - swd
  - receipts
-:${' '.repeat(10_000)}
---

# Parser

Follow local project rules.
`, 'utf-8');

    const loaded = loadSkill(skillPath);
    assert.equal(loaded.meta.name, 'parser');
    assert.deepEqual(loaded.meta.requiresTools, ['swd', 'receipts']);
  });

  it('reports malformed skills during check', () => {
    const badDir = join(getGlobalSkillsDir(), 'bad');
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, 'SKILL.md'), `---
name: bad
version: 1.0.0
description: Empty skill.
---
`, 'utf-8');

    const result = checkSkills('bad');
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((issue) => issue.level === 'error'));
  });

  it('reports a missing named skill as a check error', () => {
    const result = checkSkills('missing');

    assert.equal(result.ok, false);
    assert.equal(result.checked, 0);
    assert.ok(result.issues.some((issue) => issue.message.includes('Skill not found')));
  });

  it('rejects incompatible skills by id', () => {
    const firstDir = join(getProjectSkillsDir(), 'strict');
    const secondDir = join(getProjectSkillsDir(), 'fast');
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });

    writeFileSync(join(firstDir, 'SKILL.md'), `---
name: strict mode
version: 1.0.0
description: Strict workflow.
incompatible-with:
  - fast
---

# Strict

Be strict.
`, 'utf-8');

    writeFileSync(join(secondDir, 'SKILL.md'), `---
name: fast mode
version: 1.0.0
description: Fast workflow.
---

# Fast

Move quickly.
`, 'utf-8');

    assert.throws(
      () => buildSkillPrompt('base', ['strict', 'fast']),
      /Skill conflict/,
    );
  });
});
