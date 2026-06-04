// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/init.ts
//  Project initialization — single-command onboarding
//
//  Creates .mythosignore, MEMORY.md, skills directory, and project policy.
//  Validates environment, detects providers, prints next steps.
// ─────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { c, BANNER, hr, heading, success, warn, error as logError } from '../utils.js';
import { DEFAULT_IGNORE_PATTERNS, MYTHOSIGNORE_FILE, PROJECT_POLICY_FILE, detectProviders } from '../config.js';
import { initMemory, getMemoryPath } from '../memory.js';
import { ensureSkillsDir, getProjectSkillsDir, listSkills } from '../skills.js';
import { projectPolicyTemplate } from '../project-policy.js';

// ── Constants ────────────────────────────────────────────────
const MIN_NODE_MAJOR = 20;

// ── Environment Validation ───────────────────────────────────
interface EnvCheck {
  label: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

function checkEnvironment(): EnvCheck[] {
  const checks: EnvCheck[] = [];

  // 1. Node version
  const nodeVersion = process.version;
  const major = parseInt(nodeVersion.slice(1).split('.')[0]!, 10);
  const minor = parseInt(nodeVersion.split('.')[1]!, 10);
  checks.push({
    label: 'Node.js',
    ok: major >= MIN_NODE_MAJOR,
    detail: nodeVersion,
    hint: major < MIN_NODE_MAJOR
      ? `Requires Node.js >= ${MIN_NODE_MAJOR}. Current: ${nodeVersion}. Upgrade: https://nodejs.org`
      : undefined,
  });

  // 2. SQLite availability (for FTS5 memory index)
  let sqliteOk = false;
  try {
    // node:sqlite is available from Node 22.5+
    require('node:sqlite');
    sqliteOk = true;
  } catch {
    try {
      // Dynamic import check for ESM
      // We just check if the module resolves without actually importing
      sqliteOk = major > 22 || (major === 22 && minor >= 5);
    } catch {
      sqliteOk = false;
    }
  }
  checks.push({
    label: 'SQLite (node:sqlite)',
    ok: sqliteOk,
    detail: sqliteOk ? 'available' : 'not available',
    hint: !sqliteOk
      ? 'Optional. Memory search and caching use SQLite. Upgrade to Node 22.5+ for full functionality.'
      : undefined,
  });

  // 3. Git repo detection
  const isGit = existsSync(resolve(process.cwd(), '.git'));
  checks.push({
    label: 'Git repository',
    ok: isGit,
    detail: isGit ? 'detected' : 'not a git repo',
    hint: !isGit
      ? 'Optional. Git enables --branch sandboxing and auto-commit.'
      : undefined,
  });

  return checks;
}

// ── Provider Detection ───────────────────────────────────────
interface ProviderCheck {
  name: string;
  ok: boolean;
  envVar: string;
  required: boolean;
}

function checkProviders(): ProviderCheck[] {
  const detected = detectProviders();
  return [
    {
      name: 'Anthropic (Claude)',
      ok: !!detected.anthropic,
      envVar: 'ANTHROPIC_API_KEY',
      required: false,
    },
    {
      name: 'OpenAI (GPT)',
      ok: !!detected.openai,
      envVar: 'OPENAI_API_KEY',
      required: false,
    },
    {
      name: 'DeepSeek',
      ok: !!detected.deepseek,
      envVar: 'DEEPSEEK_API_KEY',
      required: false,
    },
    {
      name: 'Surplus (marketplace)',
      ok: !!detected.surplus,
      envVar: 'SURPLUS_API_KEY',
      required: false,
    },
  ];
}

// ── Scaffold Files ───────────────────────────────────────────
interface ScaffoldResult {
  file: string;
  action: 'created' | 'exists' | 'skipped' | 'missing';
}

function scaffoldIgnoreFile(force: boolean): ScaffoldResult {
  const target = resolve(process.cwd(), MYTHOSIGNORE_FILE);

  if (existsSync(target) && !force) {
    return { file: MYTHOSIGNORE_FILE, action: 'exists' };
  }

  const content =
    `# .mythosignore — Paths excluded from mythos scanning\n` +
    `# One pattern per line. Supports exact names and simple *.ext ignores.\n` +
    `# Regenerate defaults: mythos init --force\n\n` +
    DEFAULT_IGNORE_PATTERNS.join('\n') + '\n';

  writeFileSync(target, content, 'utf-8');
  return { file: MYTHOSIGNORE_FILE, action: 'created' };
}

function scaffoldMemory(force: boolean): ScaffoldResult {
  const memPath = getMemoryPath();

  if (existsSync(memPath) && !force) {
    return { file: 'MEMORY.md', action: 'exists' };
  }

  initMemory(false);
  return { file: 'MEMORY.md', action: existsSync(memPath) ? 'created' : 'skipped' };
}

function scaffoldSkillsDir(): ScaffoldResult {
  const dir = getProjectSkillsDir();
  const existed = existsSync(dir);
  ensureSkillsDir('project');
  return { file: '.mythos/skills/', action: existed ? 'exists' : 'created' };
}

function scaffoldProjectPolicy(force: boolean): ScaffoldResult {
  const target = resolve(process.cwd(), PROJECT_POLICY_FILE);

  if (existsSync(target) && !force) {
    return { file: PROJECT_POLICY_FILE, action: 'exists' };
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, projectPolicyTemplate(), 'utf-8');
  return { file: PROJECT_POLICY_FILE, action: 'created' };
}

function inspectScaffoldState(): ScaffoldResult[] {
  return [
    {
      file: MYTHOSIGNORE_FILE,
      action: existsSync(resolve(process.cwd(), MYTHOSIGNORE_FILE)) ? 'exists' : 'missing',
    },
    {
      file: 'MEMORY.md',
      action: existsSync(getMemoryPath()) ? 'exists' : 'missing',
    },
    {
      file: '.mythos/skills/',
      action: existsSync(getProjectSkillsDir()) ? 'exists' : 'missing',
    },
    {
      file: PROJECT_POLICY_FILE,
      action: existsSync(resolve(process.cwd(), PROJECT_POLICY_FILE)) ? 'exists' : 'missing',
    },
  ];
}

// ── Format Helpers ───────────────────────────────────────────
function badge(ok: boolean): string {
  return ok ? `${c.green}✔${c.reset}` : `${c.red}✗${c.reset}`;
}

function dimBadge(ok: boolean): string {
  return ok ? `${c.green}✔${c.reset}` : `${c.yellow}○${c.reset}`;
}

// ── Command Interface ────────────────────────────────────────
interface InitOptions {
  force?: boolean;
  check?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const force = options.force ?? false;
  const checkOnly = options.check ?? false;

  console.log(BANNER);
  console.log(heading(checkOnly ? 'PROJECT CHECK' : 'PROJECT INITIALIZATION'));
  console.log();

  // ── 1. Environment Validation ──────────────────────────────
  console.log(`${c.cyan}${c.bold}  Environment${c.reset}`);
  const envChecks = checkEnvironment();
  let envFatal = false;

  for (const check of envChecks) {
    const icon = check.ok ? badge(true) : dimBadge(false);
    console.log(`  ${icon} ${c.bold}${check.label}${c.reset} ${c.dim}${check.detail}${c.reset}`);
    if (check.hint) {
      console.log(`    ${c.dim}→ ${check.hint}${c.reset}`);
    }
    if (!check.ok && check.label === 'Node.js') envFatal = true;
  }

  if (envFatal) {
    logError(`\nNode.js >= ${MIN_NODE_MAJOR} is required. Aborting.`);
    process.exit(1);
  }

  if (checkOnly && force) {
    warn(`--force is ignored in read-only check mode.`);
  }

  console.log();

  // ── 2. Provider Detection ──────────────────────────────────
  console.log(`${c.cyan}${c.bold}  Providers${c.reset}`);
  const providers = checkProviders();
  let hasAnyProvider = false;

  for (const p of providers) {
    const icon = badge(p.ok);
    const tag = p.required ? `${c.red}required${c.reset}` : `${c.dim}optional${c.reset}`;
    const status = p.ok
      ? `${c.green}configured${c.reset}`
      : `${c.dim}not set → set ${c.yellow}${p.envVar}${c.dim} to enable${c.reset}`;
    console.log(`  ${icon} ${c.bold}${p.name}${c.reset} ${c.dim}(${c.reset}${tag}${c.dim})${c.reset}  ${status}`);
    if (p.ok) hasAnyProvider = true;
  }

  if (!hasAnyProvider) {
    console.log(`\n  ${c.yellow}⚠${c.reset} ${c.dim}No model provider configured. Set at least one of ${c.reset}${c.bold}ANTHROPIC_API_KEY${c.reset}${c.dim}, ${c.reset}${c.bold}OPENAI_API_KEY${c.reset}${c.dim}, ${c.reset}${c.bold}DEEPSEEK_API_KEY${c.reset}${c.dim}, or ${c.reset}${c.bold}SURPLUS_API_KEY${c.reset}${c.dim} to use mythos chat/run.${c.reset}`);
  }

  console.log();

  // ── 3. Scaffold Project Files ──────────────────────────────
  console.log(`${c.cyan}${c.bold}  ${checkOnly ? 'Project files' : 'Scaffolding'}${c.reset}`);
  const results: ScaffoldResult[] = checkOnly
    ? inspectScaffoldState()
    : [
      scaffoldIgnoreFile(force),
      scaffoldMemory(force),
      scaffoldSkillsDir(),
      scaffoldProjectPolicy(force),
    ];

  for (const r of results) {
    const icon = r.action === 'created'
      ? `${c.green}+${c.reset}`
      : r.action === 'exists'
        ? `${c.dim}○${c.reset}`
        : `${c.yellow}~${c.reset}`;
    const label = r.action === 'created'
      ? `${c.green}created${c.reset}`
      : r.action === 'exists'
        ? `${c.dim}already exists${c.reset}`
        : `${c.yellow}skipped${c.reset}`;
    const displayIcon = r.action === 'missing' ? `${c.yellow}!${c.reset}` : icon;
    const displayLabel = r.action === 'missing' ? `${c.yellow}missing${c.reset}` : label;
    console.log(`  ${displayIcon} ${c.bold}${r.file}${c.reset}  ${displayLabel}`);
  }

  // Show existing skills if any
  const skills = listSkills();
  if (skills.length > 0) {
    console.log(`  ${c.dim}${skills.length} skill(s) available: ${skills.map(s => s.name).join(', ')}${c.reset}`);
  }

  console.log();

  // ── 4. Result ──────────────────────────────────────────────
  const created = results.filter(r => r.action === 'created').length;
  const existed = results.filter(r => r.action === 'exists').length;
  const missing = results.filter(r => r.action === 'missing').length;

  console.log(`${c.cyan}${c.bold}  Result${c.reset}`);

  if (checkOnly) {
    if (missing > 0) {
      console.log(`  ${c.yellow}!${c.reset} ${missing} project file(s) missing. Run ${c.cyan}mythos init${c.reset} to scaffold them.`);
    } else {
      console.log(`  ${c.green}✔${c.reset} Project scaffolding is present`);
    }
  } else if (created > 0) {
    console.log(`  ${c.green}✔${c.reset} Initialized in ${c.bold}${process.cwd()}${c.reset}`);
  } else if (existed === results.length) {
    console.log(`  ${c.green}✔${c.reset} Already initialized${force ? '' : ` ${c.dim}(use ${c.cyan}--force${c.dim} to re-scaffold)${c.reset}`}`);
  }

  // Status line
  const statusLabel = checkOnly && missing > 0
    ? `${c.yellow}setup incomplete${c.reset}`
    : hasAnyProvider ? `${c.green}ready${c.reset}` : `${c.yellow}ready for swd apply only (no model key set)${c.reset}`;
  console.log(`  ${c.dim}Status:${c.reset} ${statusLabel}`);

  console.log();

  // ── 5. Next Steps ──────────────────────────────────────────
  console.log(`${c.cyan}${c.bold}  Next steps${c.reset}`);
  if (checkOnly && missing > 0) {
    console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos init${c.reset}           ${c.dim}Create missing project files${c.reset}`);
  }
  console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos run "..."${c.reset}      ${c.dim}Run one prompt and exit${c.reset}`);
  console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos chat${c.reset}           ${c.dim}Start an interactive session${c.reset}`);
  console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos chat --dry-run${c.reset}  ${c.dim}Preview changes without applying${c.reset}`);
  console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos swd apply --stdin --json${c.reset} ${c.dim}Verify external-agent file actions without a model key${c.reset}`);
  console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos verify${c.reset}         ${c.dim}Scan codebase for memory drift${c.reset}`);
  console.log(`  ${c.dim}$${c.reset} ${c.bold}mythos providers${c.reset}      ${c.dim}View provider health dashboard${c.reset}`);
  console.log();
  console.log(hr());
}
