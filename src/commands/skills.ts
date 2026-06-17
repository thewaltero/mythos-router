import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkSkills,
  createSkill,
  ensureSkillsDir,
  getGlobalSkillsDir,
  getProjectSkillsDir,
  listSkills,
  loadSkill,
  validateSkill,
  type Skill,
  type SkillCheckIssue,
  type SkillListEntry,
} from '../skills.js';
import { readReceipts } from '../receipts.js';
import {
  analyzeReceiptsForSkill,
  DEFAULT_LEARNED_SKILL_NAME,
  type LearnedRule,
  type SkillLearningResult,
} from '../skill-learning.js';
import { c, error, heading, hr, info, success, theme, warn } from '../utils.js';

interface SkillsOptions {
  global?: boolean;
  force?: boolean;
  json?: boolean;
  write?: boolean;
  minOccurrences?: string;
  limit?: string;
}

export async function skillsCommand(
  action?: string,
  name?: string,
  options: SkillsOptions = {},
): Promise<void> {
  const normalizedAction = (action ?? 'list').toLowerCase();

  if (normalizedAction === 'list') {
    printSkillsList(options.json);
    return;
  }

  if (normalizedAction === 'show') {
    if (!name) {
      error('Usage: mythos skills show <name>');
      process.exitCode = 1;
      return;
    }
    printSkill(name, options.json);
    return;
  }

  if (normalizedAction === 'new') {
    if (!name) {
      error('Usage: mythos skills new <name> [--global] [--force]');
      process.exitCode = 1;
      return;
    }
    createNewSkill(name, options);
    return;
  }

  if (normalizedAction === 'check') {
    printSkillCheck(name, options.json);
    return;
  }

  if (normalizedAction === 'suggest') {
    suggestSkillFromReceipts(name, options);
    return;
  }

  warn(`Unknown skills action: ${normalizedAction}`);
  info('Usage: mythos skills | mythos skills show <name> | mythos skills new <name> | mythos skills check [name] | mythos skills suggest [name] [--write]');
  process.exitCode = 1;
}

function printSkillsList(asJson?: boolean): void {
  const entries = listSkills();

  if (asJson) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  console.log(heading('Mythos Skills'));
  console.log(`${c.dim}Project:${c.reset} ${formatPath(getProjectSkillsDir())}`);
  console.log(`${c.dim}Global:${c.reset}  ${formatPath(getGlobalSkillsDir())}`);
  console.log();

  const project = entries.filter((entry) => entry.scope === 'project');
  const global = entries.filter((entry) => entry.scope === 'global');

  printSkillGroup('Project skills', project);
  printSkillGroup('Global skills', global);

  if (entries.length === 0) {
    info('No skills found yet. Create one with: mythos skills new repo');
  }
}

function printSkillGroup(title: string, entries: SkillListEntry[]): void {
  console.log(`${c.bold}${title}${c.reset}`);
  if (entries.length === 0) {
    console.log(`  ${c.dim}none${c.reset}`);
    console.log();
    return;
  }

  for (const entry of entries) {
    const shadowed = entry.shadowed ? ` ${theme.warning}(shadowed by project skill)${c.reset}` : '';
    const description = entry.description ? ` - ${entry.description}` : '';
    console.log(
      `  ${theme.info}${entry.id}${c.reset} ${c.dim}v${entry.version}${c.reset}${shadowed}${description}`,
    );
    console.log(`     ${c.dim}${formatPath(entry.path)}${c.reset}`);
  }
  console.log();
}

function printSkill(name: string, asJson?: boolean): void {
  let skill: Skill;
  try {
    skill = loadSkill(name);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(skill, null, 2));
    return;
  }

  console.log(heading(`Skill ${skill.id}`));
  console.log(`${c.dim}Name:${c.reset}        ${skill.meta.name}`);
  console.log(`${c.dim}Version:${c.reset}     ${skill.meta.version}`);
  console.log(`${c.dim}Source:${c.reset}      ${skill.scope}`);
  console.log(`${c.dim}Path:${c.reset}        ${formatPath(skill.filePath)}`);
  console.log(`${c.dim}Priority:${c.reset}    ${skill.meta.priority}`);
  console.log(`${c.dim}Budget:${c.reset}      ${skill.meta.budgetMultiplier}x`);
  console.log(`${c.dim}Fallback:${c.reset}    ${skill.meta.allowFallback ? 'allowed' : 'disabled'}`);
  if (skill.meta.forceProvider) {
    console.log(`${c.dim}Provider:${c.reset}    ${skill.meta.forceProvider}`);
  }
  if (skill.meta.requiresTools.length > 0) {
    console.log(`${c.dim}Tools:${c.reset}       ${skill.meta.requiresTools.join(', ')}`);
  }
  console.log(`${c.dim}Description:${c.reset} ${skill.meta.description || 'none'}`);
  console.log(hr());
  console.log(skill.instructions || `${c.dim}(empty)${c.reset}`);
}

function createNewSkill(name: string, options: SkillsOptions): void {
  try {
    const scope = options.global ? 'global' : 'project';
    const skill = createSkill(name, { scope, force: options.force });

    if (options.json) {
      console.log(JSON.stringify(skill, null, 2));
      return;
    }

    success(`Created ${scope} skill: ${skill.id}`);
    console.log(`  ${c.dim}${formatPath(skill.filePath)}${c.reset}`);
    console.log();
    console.log(`${c.dim}Use it:${c.reset} mythos run --file TASK.md -s ${skill.id}`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function printSkillCheck(name?: string, asJson?: boolean): void {
  const result = checkSkills(name);

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.log(heading(name ? `Check Skill ${name}` : 'Check Skills'));
  if (result.checked === 0 && result.issues.length === 0) {
    info('No skills found to check.');
    return;
  }

  if (result.issues.length === 0) {
    success(`Checked ${result.checked} skill(s). No issues found.`);
    return;
  }

  for (const issue of result.issues) {
    printIssue(issue);
  }

  console.log();
  if (result.ok) {
    warn(`Checked ${result.checked} skill(s). Warnings found.`);
  } else {
    error(`Checked ${result.checked} skill(s). Errors found.`);
    process.exitCode = 1;
  }
}

function printIssue(issue: SkillCheckIssue): void {
  const label = issue.level === 'error'
    ? `${theme.error}ERROR${c.reset}`
    : `${theme.warning}WARN${c.reset}`;
  console.log(`  ${label} ${c.bold}${issue.scope}${c.reset} ${formatPath(issue.path)}`);
  console.log(`       ${c.dim}${issue.message}${c.reset}`);
}

function suggestSkillFromReceipts(name: string | undefined, options: SkillsOptions): void {
  const limit = parsePositiveOption(options.limit, 50);
  const minOccurrences = parsePositiveOption(options.minOccurrences, 2);
  const skillName = (name && name.trim()) || DEFAULT_LEARNED_SKILL_NAME;

  let receipts;
  try {
    receipts = readReceipts(limit);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const result = analyzeReceiptsForSkill(receipts, { minOccurrences, skillName });

  if (options.write) {
    writeLearnedSkill(result, options, skillName);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printSkillSuggestions(result);
}

function writeLearnedSkill(result: SkillLearningResult, options: SkillsOptions, skillName: string): void {
  if (!result.skillMarkdown) {
    if (options.json) {
      console.log(JSON.stringify({ ...result, written: null }, null, 2));
    } else {
      printSkillSuggestions(result);
    }
    return;
  }

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
    error('Skill names must use letters, numbers, dots, dashes, or underscores, and start with a letter or number.');
    process.exitCode = 1;
    return;
  }

  const scope = options.global ? 'global' : 'project';
  const root = ensureSkillsDir(scope);
  const dir = path.join(root, skillName);
  const filePath = path.join(dir, 'SKILL.md');
  const exists = fs.existsSync(filePath);

  if (exists && !options.force) {
    error(`Skill already exists: ${formatPath(filePath)}. Re-run with --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, result.skillMarkdown, 'utf-8');
    // Confirm the generated file parses and validates like a hand-authored skill.
    const errors = validateSkill(loadSkill(filePath)).filter((issue) => issue.level === 'error');
    if (errors.length > 0) {
      error(`Generated skill failed validation: ${errors.map((issue) => issue.message).join('; ')}`);
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  const action = exists ? 'updated' : 'created';
  if (options.json) {
    console.log(JSON.stringify({ ...result, written: { path: filePath, action } }, null, 2));
    return;
  }

  success(`${action === 'created' ? 'Created' : 'Updated'} ${scope} skill: ${skillName}`);
  console.log(`  ${c.dim}${formatPath(filePath)}${c.reset}`);
  console.log();
  console.log(`${c.dim}Load it:${c.reset} mythos run --file TASK.md -s ${skillName}`);
}

function printSkillSuggestions(result: SkillLearningResult): void {
  console.log(heading('Skill Suggestions'));
  console.log(
    `${c.dim}Analyzed ${result.analyzedReceipts} receipt(s); found ${result.failureCount} failed/drifted action(s).${c.reset}`,
  );
  console.log();

  if (result.rules.length === 0) {
    for (const note of result.notes) {
      info(note);
    }
    return;
  }

  for (const rule of result.rules) {
    console.log(`  ${theme.warning}RULE${c.reset} ${c.bold}${rule.category}${c.reset} ${c.dim}(${rule.occurrences}x)${c.reset}`);
    console.log(`     ${rule.rule}`);
    console.log(`     ${c.dim}reason: ${rule.reason}${c.reset}`);
    console.log(`     ${c.dim}evidence: ${rule.evidence}${c.reset}`);
  }

  console.log();
  console.log(`${c.bold}Proposed skill: ${result.skillName}${c.reset}`);
  console.log(hr());
  console.log(result.skillMarkdown);
  console.log(hr());
  console.log();
  for (const note of result.notes) {
    console.log(`${c.dim}${note}${c.reset}`);
  }
}

function parsePositiveOption(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatPath(filePath: string): string {
  const home = os.homedir();
  if (filePath === home || filePath.startsWith(home + path.sep)) {
    return '~' + filePath.slice(home.length);
  }

  const relative = path.relative(process.cwd(), filePath);
  const escapesCwd = relative === '..' || relative.startsWith(`..${path.sep}`);
  if (relative && !escapesCwd && !path.isAbsolute(relative)) {
    return relative || '.';
  }

  return filePath;
}
