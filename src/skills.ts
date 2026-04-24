// ─────────────────────────────────────────────────────────────
//  mythos-router :: skills.ts
//  Mythos Skill Protocol — modular expert plugins
//
//  Skills are SKILL.md files with YAML frontmatter that inject
//  specialized instructions into the system prompt at runtime.
//  Zero external dependencies — custom frontmatter parser.
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Types ────────────────────────────────────────────────────
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
  meta: SkillMeta;
  instructions: string;   // The markdown body after frontmatter
  filePath: string;
}

export interface SkillValidation {
  valid: boolean;
  errors: string[];
}

// ── Constants ────────────────────────────────────────────────
const SKILLS_DIR = path.join(os.homedir(), '.mythos-router', 'skills');
const SKILL_FILE = 'SKILL.md';

// ── YAML Frontmatter Parser (minimal, zero-dep) ─────────────
// Handles: strings, numbers, booleans, and simple arrays (- item)
function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: content };
  }

  const yamlBlock = match[1];
  const body = match[2].trim();
  const meta: Record<string, unknown> = {};

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const rawLine of yamlBlock.split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    // Array item: "  - value"
    if (/^\s+-\s+/.test(line) && currentKey && currentArray) {
      const value = line.replace(/^\s+-\s+/, '').trim();
      currentArray.push(value);
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray) {
      meta[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    // Key-value pair: "key: value"
    const kvMatch = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].trim();
    const rawValue = kvMatch[2].trim();

    // Empty value means upcoming array
    if (rawValue === '' || rawValue === undefined) {
      currentKey = key;
      currentArray = [];
      continue;
    }

    // Parse value types
    meta[key] = parseYamlValue(rawValue);
  }

  // Flush trailing array
  if (currentKey && currentArray) {
    meta[currentKey] = currentArray;
  }

  return { meta, body };
}

function parseYamlValue(raw: string): string | number | boolean {
  // Boolean
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  // Number (integer or float)
  if (/^-?\d+(\.\d+)?$/.test(raw)) return parseFloat(raw);

  // String (strip optional quotes)
  return raw.replace(/^["']|["']$/g, '');
}

// ── Skill Loader ─────────────────────────────────────────────
export function loadSkill(nameOrPath: string): Skill {
  let skillPath: string;

  // Check if it's a direct path or a skill name
  if (nameOrPath.includes(path.sep) || nameOrPath.includes('/')) {
    skillPath = path.resolve(nameOrPath);
  } else {
    skillPath = path.join(SKILLS_DIR, nameOrPath, SKILL_FILE);
  }

  if (!fs.existsSync(skillPath)) {
    throw new Error(
      `Skill not found: ${nameOrPath}\n` +
      `  Expected at: ${skillPath}\n` +
      `  Create it:   mkdir -p ${path.dirname(skillPath)} && touch ${skillPath}`
    );
  }

  const content = fs.readFileSync(skillPath, 'utf-8');
  const { meta, body } = parseFrontmatter(content);

  const skill: Skill = {
    meta: {
      name: String(meta.name ?? nameOrPath),
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
    filePath: skillPath,
  };

  return skill;
}

// ── List Available Skills ────────────────────────────────────
export function listSkills(): Array<{ name: string; description: string; version: string; path: string }> {
  if (!fs.existsSync(SKILLS_DIR)) return [];

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: Array<{ name: string; description: string; version: string; path: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, SKILL_FILE);
    if (!fs.existsSync(skillFile)) continue;

    try {
      const skill = loadSkill(entry.name);
      skills.push({
        name: skill.meta.name,
        description: skill.meta.description,
        version: skill.meta.version,
        path: skillFile,
      });
    } catch {
      // Skip malformed skills
    }
  }

  return skills;
}

// ── Validate Skill Compatibility ─────────────────────────────
export function validateSkills(skillNames: string[]): SkillValidation {
  const errors: string[] = [];
  const loaded: Skill[] = [];

  // Load all requested skills
  for (const name of skillNames) {
    try {
      loaded.push(loadSkill(name));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Check for incompatibilities
  const nameSet = new Set(loaded.map(s => s.meta.name));
  for (const skill of loaded) {
    for (const incompatible of skill.meta.incompatibleWith) {
      if (nameSet.has(incompatible)) {
        errors.push(
          `Skill conflict: "${skill.meta.name}" is incompatible with "${incompatible}". ` +
          `Remove one to proceed.`
        );
      }
    }
  }

  // Check for conflicting force-provider directives
  const forcedProviders = loaded
    .filter(s => s.meta.forceProvider)
    .map(s => ({ name: s.meta.name, provider: s.meta.forceProvider! }));

  if (forcedProviders.length > 1) {
    const unique = new Set(forcedProviders.map(fp => fp.provider));
    if (unique.size > 1) {
      errors.push(
        `Provider conflict: Skills force different providers: ` +
        forcedProviders.map(fp => `"${fp.name}" → ${fp.provider}`).join(', ')
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Build System Prompt with Skills ──────────────────────────
export function buildSkillPrompt(basePrompt: string, skillNames: string[]): {
  prompt: string;
  skills: Skill[];
  budgetMultiplier: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  forceProvider?: string;
} {
  if (skillNames.length === 0) {
    return { prompt: basePrompt, skills: [], budgetMultiplier: 1.0 };
  }

  const validation = validateSkills(skillNames);
  if (!validation.valid) {
    throw new Error(`Skill validation failed:\n${validation.errors.map(e => `  • ${e}`).join('\n')}`);
  }

  const skills = skillNames.map(name => loadSkill(name));

  // Sort by priority (higher priority = loaded first)
  skills.sort((a, b) => b.meta.priority - a.meta.priority);

  // Build the augmented prompt
  const skillBlocks = skills.map(s =>
    `## ACTIVE SKILL: ${s.meta.name} (v${s.meta.version})\n` +
    `Priority: ${s.meta.priority} | Budget Multiplier: ${s.meta.budgetMultiplier}x\n\n` +
    s.instructions
  );

  const prompt = basePrompt + '\n\n' +
    '## ACTIVE SKILLS\n' +
    `The following ${skills.length} skill(s) are loaded. Follow their instructions.\n\n` +
    skillBlocks.join('\n\n---\n\n');

  // Aggregate execution boundaries
  const budgetMultiplier = skills.reduce((acc, s) => acc * s.meta.budgetMultiplier, 1.0);
  const maxOutputTokens = skills
    .filter(s => s.meta.maxOutputTokens)
    .reduce((min, s) => Math.min(min, s.meta.maxOutputTokens!), Infinity);
  const timeoutMs = skills
    .filter(s => s.meta.timeoutMs)
    .reduce((min, s) => Math.min(min, s.meta.timeoutMs!), Infinity);
  const forceProvider = skills.find(s => s.meta.forceProvider)?.meta.forceProvider;

  return {
    prompt,
    skills,
    budgetMultiplier,
    maxOutputTokens: maxOutputTokens === Infinity ? undefined : maxOutputTokens,
    timeoutMs: timeoutMs === Infinity ? undefined : timeoutMs,
    forceProvider,
  };
}

// ── Initialize Skills Directory ──────────────────────────────
export function ensureSkillsDir(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}

// ── Get Skills Directory Path ────────────────────────────────
export function getSkillsDir(): string {
  return SKILLS_DIR;
}
