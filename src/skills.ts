// -----------------------------------------------------------------------------
//  mythos-router :: skills.ts
//  Skill packs for repo-specific agent rules and reusable expert instructions.
//
//  Resolution order:
//    1. Project-local skills: .mythos/skills/<name>/SKILL.md
//    2. User-global skills:  ~/.mythos-router/skills/<name>/SKILL.md
//    3. Explicit file or directory paths
//
//  Project-local skills intentionally win over global skills. That lets teams
//  commit a repo operating manual without forcing users to edit their home dir.
// -----------------------------------------------------------------------------

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export type SkillScope = 'project' | 'global' | 'path';

export interface SkillMeta {
  name: string;
  version: string;
  description: string;
  priority: number;
  requiresTools: string[];
  incompatibleWith: string[];
  forceProvider?: string;
  allowFallback: boolean;
  maxOutputTokens?: number;
  timeoutMs?: number;
  budgetMultiplier: number;
}

export interface Skill {
  id: string;
  meta: SkillMeta;
  instructions: string;
  filePath: string;
  scope: SkillScope;
}

export interface SkillListEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  path: string;
  scope: SkillScope;
  shadowed: boolean;
}

export interface SkillValidation {
  valid: boolean;
  errors: string[];
}

export interface SkillCheckIssue {
  level: 'error' | 'warning';
  scope: SkillScope;
  path: string;
  message: string;
}

export interface SkillCheckResult {
  ok: boolean;
  checked: number;
  issues: SkillCheckIssue[];
}

export interface CreateSkillOptions {
  scope?: Exclude<SkillScope, 'path'>;
  force?: boolean;
  cwd?: string;
}

export interface ParseSkillContentOptions {
  id?: string;
  filePath: string;
  scope: SkillScope;
}

const PROJECT_SKILLS_DIR = path.join('.mythos', 'skills');
const GLOBAL_SKILLS_ENV = 'MYTHOS_SKILLS_DIR';
const SKILL_FILE = 'SKILL.md';

export function getProjectSkillsDir(cwd = process.cwd()): string {
  return path.join(cwd, PROJECT_SKILLS_DIR);
}

export function getGlobalSkillsDir(): string {
  const override = process.env[GLOBAL_SKILLS_ENV]?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), '.mythos-router', 'skills');
}

// Backwards-compatible alias used by older code and docs.
export function getSkillsDir(): string {
  return getGlobalSkillsDir();
}

export function ensureSkillsDir(scope: Exclude<SkillScope, 'path'> = 'global', cwd = process.cwd()): string {
  const dir = scope === 'project' ? getProjectSkillsDir(cwd) : getGlobalSkillsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const sections = parseFrontmatterSections(content);
  if (!sections) {
    return { meta: {}, body: content.trim() };
  }

  const { yamlBlock, body } = sections;
  const meta: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const rawLine of yamlBlock.split('\n')) {
    const line = stripTrailingCarriageReturn(rawLine);

    const arrayItem = parseYamlArrayItem(line);
    if (arrayItem !== null && currentKey && currentArray) {
      const value = arrayItem.trim();
      currentArray.push(String(parseYamlValue(value)));
      continue;
    }

    if (currentKey && currentArray) {
      meta[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    if (line.trim().startsWith('#') || line.trim() === '') continue;

    const parsed = parseYamlKeyValue(line);
    if (!parsed) continue;

    const { key, rawValue } = parsed;

    if (rawValue === '' || rawValue === undefined) {
      currentKey = key;
      currentArray = [];
      continue;
    }

    meta[key] = parseYamlValue(rawValue);
  }

  if (currentKey && currentArray) {
    meta[currentKey] = currentArray;
  }

  return { meta, body };
}

function parseFrontmatterSections(content: string): { yamlBlock: string; body: string } | null {
  const lines = content.split('\n');
  if (lines.length === 0 || stripTrailingCarriageReturn(lines[0]!) !== '---') {
    return null;
  }

  for (let index = 1; index < lines.length; index++) {
    if (stripTrailingCarriageReturn(lines[index]!) === '---') {
      return {
        yamlBlock: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n').trim(),
      };
    }
  }

  return null;
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseYamlArrayItem(line: string): string | null {
  let index = 0;
  while (index < line.length && isYamlWhitespace(line[index]!)) index++;

  if (line[index] !== '-') return null;
  index++;

  if (index >= line.length || !isYamlWhitespace(line[index]!)) return null;
  while (index < line.length && isYamlWhitespace(line[index]!)) index++;

  return line.slice(index);
}

function parseYamlKeyValue(line: string): { key: string; rawValue: string } | null {
  const colonIndex = line.indexOf(':');
  if (colonIndex <= 0) return null;

  const key = line.slice(0, colonIndex);
  if (!isYamlMetaKey(key)) return null;

  return {
    key,
    rawValue: line.slice(colonIndex + 1).trim(),
  };
}

function isYamlMetaKey(key: string): boolean {
  for (const char of key) {
    const code = char.charCodeAt(0);
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    if (!isUpper && !isLower && char !== '_' && char !== '-') {
      return false;
    }
  }
  return key.length > 0;
}

function isYamlWhitespace(char: string): boolean {
  return char === ' ' || char === '\t';
}

function parseYamlValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const numberValue = parseYamlNumber(raw);
  if (numberValue !== null) return numberValue;

  return stripWrappingQuotes(raw);
}

function parseYamlNumber(raw: string): number | null {
  let index = raw.startsWith('-') ? 1 : 0;
  let hasIntegerDigits = false;

  while (index < raw.length && isDigit(raw[index]!)) {
    hasIntegerDigits = true;
    index++;
  }

  if (index < raw.length && raw[index] === '.') {
    index++;
    let hasFractionDigits = false;
    while (index < raw.length && isDigit(raw[index]!)) {
      hasFractionDigits = true;
      index++;
    }
    if (!hasFractionDigits) return null;
  }

  if (!hasIntegerDigits || index !== raw.length) return null;
  return Number(raw);
}

function stripWrappingQuotes(raw: string): string {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return raw.slice(1, -1);
  }
  return raw;
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isPathLike(nameOrPath: string): boolean {
  return (
    path.isAbsolute(nameOrPath) ||
    nameOrPath.startsWith('.') ||
    nameOrPath.includes('/') ||
    nameOrPath.includes('\\') ||
    nameOrPath.endsWith('.md')
  );
}

function skillIdFromPath(skillPath: string): string {
  const parent = path.basename(path.dirname(skillPath));
  return parent && parent !== '.' ? parent : path.basename(skillPath, path.extname(skillPath));
}

function resolvePathLikeSkill(nameOrPath: string): string {
  const resolved = path.resolve(nameOrPath);

  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    return stat.isDirectory() ? path.join(resolved, SKILL_FILE) : resolved;
  }

  if (path.basename(resolved) === SKILL_FILE || resolved.endsWith('.md')) {
    return resolved;
  }

  return path.join(resolved, SKILL_FILE);
}

function resolveNamedSkill(name: string): { filePath: string; scope: Exclude<SkillScope, 'path'> } | null {
  const projectPath = path.join(getProjectSkillsDir(), name, SKILL_FILE);
  if (fs.existsSync(projectPath)) return { filePath: projectPath, scope: 'project' };

  const globalPath = path.join(getGlobalSkillsDir(), name, SKILL_FILE);
  if (fs.existsSync(globalPath)) return { filePath: globalPath, scope: 'global' };

  return null;
}

export function parseSkillContent(content: string, options: ParseSkillContentOptions): Skill {
  const { filePath, scope } = options;
  const id = options.id ?? skillIdFromPath(filePath);
  const { meta, body } = parseFrontmatter(content);

  return {
    id,
    meta: {
      name: String(meta.name ?? id),
      version: String(meta.version ?? '0.0.0'),
      description: String(meta.description ?? ''),
      priority: Number(meta.priority ?? 50),
      requiresTools: Array.isArray(meta['requires-tools']) ? meta['requires-tools'] as string[] : [],
      incompatibleWith: Array.isArray(meta['incompatible-with']) ? meta['incompatible-with'] as string[] : [],
      forceProvider: meta['force-provider'] ? String(meta['force-provider']) : undefined,
      allowFallback: meta['allow-fallback'] !== false,
      maxOutputTokens: meta['max-output-tokens'] ? Number(meta['max-output-tokens']) : undefined,
      timeoutMs: meta['timeout-ms'] ? Number(meta['timeout-ms']) : undefined,
      budgetMultiplier: Number(meta['budget-multiplier'] ?? 1.0),
    },
    instructions: body,
    filePath,
    scope,
  };
}

function readSkillFile(filePath: string, scope: SkillScope, id = skillIdFromPath(filePath)): Skill {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Skill file not found: ${filePath}`);
  }

  return parseSkillContent(fs.readFileSync(filePath, 'utf-8'), { id, filePath, scope });
}

export function loadSkill(nameOrPath: string): Skill {
  if (isPathLike(nameOrPath)) {
    const skillPath = resolvePathLikeSkill(nameOrPath);
    return readSkillFile(skillPath, 'path');
  }

  const resolved = resolveNamedSkill(nameOrPath);
  if (!resolved) {
    throw new Error(
      `Skill not found: ${nameOrPath}\n` +
      `  Project: ${path.join(getProjectSkillsDir(), nameOrPath, SKILL_FILE)}\n` +
      `  Global:  ${path.join(getGlobalSkillsDir(), nameOrPath, SKILL_FILE)}\n` +
      `  Create:  mythos skills new ${nameOrPath}`,
    );
  }

  return readSkillFile(resolved.filePath, resolved.scope, nameOrPath);
}

function listSkillFiles(scope: Exclude<SkillScope, 'path'>): Array<{ id: string; filePath: string; scope: Exclude<SkillScope, 'path'> }> {
  const root = scope === 'project' ? getProjectSkillsDir() : getGlobalSkillsDir();
  if (!fs.existsSync(root)) return [];

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      filePath: path.join(root, entry.name, SKILL_FILE),
      scope,
    }))
    .filter((entry) => fs.existsSync(entry.filePath));
}

export function listSkills(): SkillListEntry[] {
  const projectFiles = listSkillFiles('project');
  const globalFiles = listSkillFiles('global');
  const projectIds = new Set(projectFiles.map((entry) => entry.id));
  const entries: SkillListEntry[] = [];

  for (const entry of [...projectFiles, ...globalFiles]) {
    try {
      const skill = readSkillFile(entry.filePath, entry.scope, entry.id);
      entries.push({
        id: skill.id,
        name: skill.meta.name,
        description: skill.meta.description,
        version: skill.meta.version,
        path: skill.filePath,
        scope: skill.scope,
        shadowed: skill.scope === 'global' && projectIds.has(skill.id),
      });
    } catch {
      // `skills check` reports malformed skill files. Listing stays usable.
    }
  }

  return entries.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export function validateSkill(skill: Skill): SkillCheckIssue[] {
  const issues: SkillCheckIssue[] = [];
  const add = (level: SkillCheckIssue['level'], message: string) => {
    issues.push({ level, scope: skill.scope, path: skill.filePath, message });
  };

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skill.id)) {
    add('error', `Skill directory name "${skill.id}" is not portable. Use letters, numbers, dots, dashes, or underscores.`);
  }
  if (!skill.meta.name.trim()) add('error', 'Missing frontmatter: name');
  if (!skill.meta.version.trim() || skill.meta.version === '0.0.0') add('warning', 'Missing or default frontmatter: version');
  if (!skill.meta.description.trim()) add('warning', 'Missing frontmatter: description');
  if (!Number.isFinite(skill.meta.priority)) add('error', 'priority must be a number');
  if (!Number.isFinite(skill.meta.budgetMultiplier) || skill.meta.budgetMultiplier <= 0) {
    add('error', 'budget-multiplier must be a positive number');
  }
  if (skill.meta.maxOutputTokens !== undefined && (!Number.isFinite(skill.meta.maxOutputTokens) || skill.meta.maxOutputTokens <= 0)) {
    add('error', 'max-output-tokens must be a positive number');
  }
  if (skill.meta.timeoutMs !== undefined && (!Number.isFinite(skill.meta.timeoutMs) || skill.meta.timeoutMs <= 0)) {
    add('error', 'timeout-ms must be a positive number');
  }
  if (!skill.instructions.trim()) add('error', 'Skill instructions are empty');

  return issues;
}

export function checkSkills(nameOrPath?: string): SkillCheckResult {
  const skills: Skill[] = [];
  const issues: SkillCheckIssue[] = [];

  if (nameOrPath) {
    try {
      skills.push(loadSkill(nameOrPath));
    } catch (err) {
      issues.push({
        level: 'error',
        scope: isPathLike(nameOrPath) ? 'path' : 'project',
        path: nameOrPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    for (const entry of [...listSkillFiles('project'), ...listSkillFiles('global')]) {
      try {
        skills.push(readSkillFile(entry.filePath, entry.scope, entry.id));
      } catch (err) {
        issues.push({
          level: 'error',
          scope: entry.scope,
          path: entry.filePath,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  for (const skill of skills) {
    issues.push(...validateSkill(skill));
  }

  const loadedNames = new Map<string, Skill>();
  for (const skill of skills) {
    const previous = loadedNames.get(skill.meta.name);
    if (previous && previous.filePath !== skill.filePath) {
      issues.push({
        level: 'warning',
        scope: skill.scope,
        path: skill.filePath,
        message: `Duplicate skill name "${skill.meta.name}" also appears at ${previous.filePath}`,
      });
    }
    loadedNames.set(skill.meta.name, skill);
  }

  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    checked: skills.length,
    issues,
  };
}

export function validateSkills(skillNames: string[]): SkillValidation {
  const errors: string[] = [];
  const loaded: Skill[] = [];

  for (const name of skillNames) {
    try {
      const skill = loadSkill(name);
      const blockingIssues = validateSkill(skill).filter((issue) => issue.level === 'error');
      if (blockingIssues.length > 0) {
        errors.push(...blockingIssues.map((issue) => `${skill.id}: ${issue.message}`));
      }
      loaded.push(skill);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const nameSet = new Set(loaded.flatMap((skill) => [skill.id, skill.meta.name]));
  for (const skill of loaded) {
    for (const incompatible of skill.meta.incompatibleWith) {
      if (nameSet.has(incompatible)) {
        errors.push(
          `Skill conflict: "${skill.meta.name}" is incompatible with "${incompatible}". Remove one to proceed.`,
        );
      }
    }
  }

  const forcedProviders = loaded
    .filter((skill) => skill.meta.forceProvider)
    .map((skill) => ({ name: skill.meta.name, provider: skill.meta.forceProvider! }));

  if (forcedProviders.length > 1) {
    const unique = new Set(forcedProviders.map((item) => item.provider));
    if (unique.size > 1) {
      errors.push(
        `Provider conflict: Skills force different providers: ` +
        forcedProviders.map((item) => `"${item.name}" -> ${item.provider}`).join(', '),
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

export function buildSkillPrompt(basePrompt: string, skillNames: string[]): {
  prompt: string;
  skills: Skill[];
  budgetMultiplier: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  forceProvider?: string;
  allowFallback?: boolean;
} {
  if (skillNames.length === 0) {
    return { prompt: basePrompt, skills: [], budgetMultiplier: 1.0 };
  }

  const validation = validateSkills(skillNames);
  if (!validation.valid) {
    throw new Error(`Skill validation failed:\n${validation.errors.map((error) => `  - ${error}`).join('\n')}`);
  }

  const skills = skillNames.map((name) => loadSkill(name));
  skills.sort((a, b) => b.meta.priority - a.meta.priority);

  const skillBlocks = skills.map((skill) =>
    `## ACTIVE SKILL: ${skill.meta.name} (v${skill.meta.version})\n` +
    `Source: ${skill.scope} | Path: ${skill.filePath}\n` +
    `Priority: ${skill.meta.priority} | Budget Multiplier: ${skill.meta.budgetMultiplier}x\n\n` +
    skill.instructions,
  );

  const prompt = basePrompt + '\n\n' +
    '## ACTIVE SKILLS\n' +
    `The following ${skills.length} skill(s) are loaded. Follow their instructions.\n\n` +
    skillBlocks.join('\n\n---\n\n');

  const budgetMultiplier = skills.reduce((acc, skill) => acc * skill.meta.budgetMultiplier, 1.0);
  const maxOutputTokens = skills
    .filter((skill) => skill.meta.maxOutputTokens)
    .reduce((min, skill) => Math.min(min, skill.meta.maxOutputTokens!), Infinity);
  const timeoutMs = skills
    .filter((skill) => skill.meta.timeoutMs)
    .reduce((min, skill) => Math.min(min, skill.meta.timeoutMs!), Infinity);
  const forceProvider = skills.find((skill) => skill.meta.forceProvider)?.meta.forceProvider;
  const allowFallback = skills.every((skill) => skill.meta.allowFallback !== false);

  return {
    prompt,
    skills,
    budgetMultiplier,
    maxOutputTokens: maxOutputTokens === Infinity ? undefined : maxOutputTokens,
    timeoutMs: timeoutMs === Infinity ? undefined : timeoutMs,
    forceProvider,
    allowFallback,
  };
}

function assertPortableSkillName(name: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error('Skill names must use letters, numbers, dots, dashes, or underscores, and start with a letter or number.');
  }
}

function templateForSkill(name: string): string {
  return `---
name: ${name}
version: 0.1.0
description: Project-specific operating rules for verified Mythos runs.
priority: 70
budget-multiplier: 1.0
allow-fallback: true
---

# ${name} Skill

## Purpose
Describe what this project or workflow needs Mythos to understand before it edits files.

## Read First
- package.json
- README.md
- docs/

## Rules
- Preserve existing public APIs unless the task explicitly asks for a breaking change.
- Keep edits focused on the requested files and behavior.
- Do not change install, CI, deploy, or secret-handling files unless the task explicitly requires it.
- Explain risk clearly when touching command-affecting files.

## Verification
- Prefer small, reviewable changes.
- If tests are relevant, suggest the narrowest command the human can run.
- Let SWD verify file claims before considering the task complete.
`;
}

export function createSkill(name: string, options: CreateSkillOptions = {}): Skill {
  const trimmed = name.trim();
  assertPortableSkillName(trimmed);

  const scope = options.scope ?? 'project';
  const root = ensureSkillsDir(scope, options.cwd ?? process.cwd());
  const dir = path.join(root, trimmed);
  const filePath = path.join(dir, SKILL_FILE);

  if (fs.existsSync(filePath) && !options.force) {
    throw new Error(`Skill already exists: ${filePath}. Use --force to overwrite.`);
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, templateForSkill(trimmed), 'utf-8');
  return readSkillFile(filePath, scope, trimmed);
}
