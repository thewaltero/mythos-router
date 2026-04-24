// ─────────────────────────────────────────────────────────────
//  mythos-router :: commands/chat.ts
//  Interactive REPL with Capybara thinking protocol
//  + Budget Limiter + Dry-Run + Verbose modes
// ─────────────────────────────────────────────────────────────

import * as readline from 'node:readline';
import * as path from 'node:path';
import { streamMessage, formatTokenUsage, type Message, type MythosResponse } from '../client.js';
import { SWDEngine, parseActions, resolveSafePath, summarizeActions, type FileAction, type SWDRunResult } from '../swd.js';
import { printSWDResults, dryRunSWD, printVerboseParse } from '../swd-cli.js';
import { saveSessionMetric } from '../metrics.js';
import { appendEntry, appendMetadataBlock, needsDream, getMemoryContext, printMemoryStatus } from '../memory.js';
import { type EffortLevel, MAX_CORRECTION_RETRIES, MODELS, validateApiKey } from '../config.js';
import { c, Spinner, BANNER, hr, heading, dryRunBadge, error as logError, warn as logWarn, success as logSuccess, runTestCommand } from '../utils.js';
import { SessionBudget } from '../budget.js';
import { getOrchestrator } from '../client.js';
import { buildSkillPrompt, listSkills, ensureSkillsDir } from '../skills.js';
import { isGitRepo, hasUncommittedChanges, getCurrentBranch, commitChanges, getLatestHash, createAndCheckoutBranch } from '../git.js';

// ── UI Abstraction ──────────────────────────────────────────
export interface ChatUI {
  startLoading(msg: string): void;
  updateLoading(msg: string): void;
  stopLoading(msg?: string): void;
  write(text: string): void;   // Raw streaming output (no newline)
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
  divider(): void;
}

// ── Chat Session Manager ─────────────────────────────────────
class ChatSession {
  public history: Message[] = [];
  public budget: SessionBudget;
  public engine: SWDEngine;
  public options: ChatOptions;
  public finalSystemPrompt: string = '';
  public maxOutputTokens?: number;
  public forceProvider?: string;
  private ui: ChatUI;

  constructor(options: ChatOptions, ui: ChatUI) {
    this.options = options;
    this.ui = ui;
    // Parse budget config
    const baseMaxTokens = parseInt(options.maxTokens ?? '500000', 10) || 500_000;
    const maxTurns = parseInt(options.maxTurns ?? '25', 10) || 25;

    // Load Skills
    let budgetMultiplier = 1.0;
    try {
      const skills = typeof options.skill === 'string' ? [options.skill] : (options.skill || []);
      const skillResult = buildSkillPrompt(getMemoryContext() ? '' : '', skills); // We inject context later
      this.finalSystemPrompt = skillResult.prompt;
      this.maxOutputTokens = skillResult.maxOutputTokens;
      this.forceProvider = skillResult.forceProvider;
      budgetMultiplier = skillResult.budgetMultiplier;

      if (skillResult.skills.length > 0) {
        this.ui.divider();
        this.ui.log(`${c.cyan}${c.bold}⚡ ACTIVE SKILLS${c.reset}`);
        for (const skill of skillResult.skills) {
          this.ui.log(`  ${c.green}✔ ${skill.meta.name}${c.dim} (v${skill.meta.version}) - ${skill.meta.description}${c.reset}`);
        }
        this.ui.divider();
      }
    } catch (err: any) {
      this.ui.error(`Skill Error: ${err.message}`);
      process.exit(1);
    }

    this.budget = new SessionBudget(
      {
        maxTokens: Math.floor(baseMaxTokens * budgetMultiplier),
        maxTurns,
      },
      options.budget !== false,
    );
    
    this.engine = new SWDEngine({ 
      strict: true, 
      enableRollback: true,
      onAction: (a) => this.ui.updateLoading(`Executing: ${c.cyan}${a.operation}${c.reset} ${a.path}...`),
      onVerify: (r) => this.ui.updateLoading(`Verifying: ${r.action.path}...`),
      onRollback: (p, s, e) => {
        if (s) this.ui.updateLoading(`Rolled back: ${p}`);
        else this.ui.updateLoading(`${c.red}Rollback failed${c.reset}: ${p} (${e})`);
      }
    });
  }

  public async initialize() {
    const context = await getMemoryContext();
    if (context) {
      // Prepend context to the final system prompt (or inject as user message if skills modified it)
      if (this.finalSystemPrompt) {
        this.finalSystemPrompt = `[CONTEXT: RECENT MEMORY]\n${context}\n\n${this.finalSystemPrompt}`;
      } else {
        this.history.push({ role: 'user', content: `[CONTEXT: RECENT MEMORY]\n${context}` });
        this.history.push({ role: 'assistant', content: "Acknowledged. I have restored context from memory." });
      }
    }
  }

  public async setupSandbox(): Promise<string | null> {
    if (!this.options.branch) return null;
    
    if (!isGitRepo()) throw new Error('Not a git repository. Cannot use --branch flag.');
    if (hasUncommittedChanges()) throw new Error('Uncommitted changes detected. Please commit or stash before sandboxing.');

    const current = getCurrentBranch();
    if (current.startsWith('mythos/')) throw new Error(`Already inside a mythos branch: ${current}. Nested sandboxing blocked.`);

    const timestampStr = new Date().toISOString().replace(/[-T:]/g, '').slice(0, 12);
    const branchName = `mythos/${this.options.branch}-${timestampStr}`;
    
    logSuccess(`Creating sandbox branch: ${c.bold}${branchName}${c.reset}`);
    createAndCheckoutBranch(branchName);
    return branchName;
  }

  public async processInput(input: string): Promise<void> {
    this.history.push({ role: 'user', content: input });
    this.ui.startLoading('Capybara is thinking...');

    let thinkingTokens = 0;
    let streamStarted = false;

    try {
      const orchestrator = getOrchestrator();
      const response = await orchestrator.streamMessage(
        this.history,
        {
          systemPrompt: this.finalSystemPrompt || '',
          effort: this.options.effort as EffortLevel,
          maxTokens: this.maxOutputTokens,
          deterministic: !!this.forceProvider,
          onThinkingDelta: (delta) => {
            thinkingTokens += Math.ceil(delta.length / 4);
            this.ui.updateLoading(`Thinking... ${c.yellow}~${thinkingTokens} tokens${c.reset}`);
            if (process.stdout.isTTY) process.stdout.write(c.dim + delta + c.reset);
          },
          onTextDelta: (delta) => {
            if (!streamStarted) {
              this.ui.stopLoading(`${c.green}✔${c.reset} ${c.dim}Reasoning complete${c.reset}\n`);
              streamStarted = true;
            }
            if (process.stdout.isTTY) process.stdout.write(delta);
          },
        }
      );

      this.ui.write('\n');
      this.history.push({ role: 'assistant', content: response.text });
      this.budget.record(response.usage.inputTokens, response.usage.outputTokens);

      if (this.options.verbose) printVerboseParse(response.text);

      await this.handleSWD(response.text, input);

      // formatTokenUsage takes MythosResponse, so we map it here
      this.ui.log(`\n${formatTokenUsage({
        thinking: response.thinking,
        text: response.text,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        _orchestration: {
          ...response.metadata,
          latencyMs: response.usage.latencyMs
        },
      })}`);
      this.ui.log(this.budget.formatBar());
      
      const warning = this.budget.formatWarning();
      if (warning) this.ui.warn(`\n${warning}`);

      if (needsDream()) {
        this.ui.warn(`\n${c.yellow}💤 Memory approaching capacity. Run ${c.cyan}mythos dream${c.yellow} to compress.${c.reset}`);
      }
    } catch (err: any) {
      this.ui.stopLoading();
      this.ui.error(`API Error: ${err.message}`);
      this.history.pop();
    }
  }

  private async handleSWD(responseText: string, userInput: string): Promise<void> {
    const actions = parseActions(responseText);
    if (actions.length === 0) {
      appendEntry(`chat: ${userInput.slice(0, 80)}`, '✅ clear', this.options.dryRun);
      return;
    }

    if (this.options.dryRun) {
      const dryResult = await dryRunSWD(actions);
      appendEntry(
        summarizeActions(responseText, userInput), 
        `🛠️ dry-run: ${dryResult.accepted.length} accepted, ${dryResult.rejected.length} rejected`,
        true
      );
      return;
    }

    this.ui.startLoading('Verifying and applying changes...');
    const result = await this.engine.run(actions);
    this.ui.stopLoading();
    printSWDResults(result);

    if (!result.success) {
      await this.runCorrectionLoop(result);
    }

    if (this.options.testCmd) {
      if (this.options.dryRun) {
        this.ui.warn('Skipping test execution in dry-run mode.');
      } else {
        await this.runTestHealingLoop(this.options.testCmd);
      }
    }

    const status = result.success ? '✅ verified' : `⚠️ ${result.results.filter(r => r.status !== 'verified').length} issues`;
    appendEntry(summarizeActions(responseText, userInput), status, false);
  }

  private async runCorrectionLoop(lastResult: SWDRunResult): Promise<void> {
    for (let attempt = 1; attempt <= MAX_CORRECTION_RETRIES; attempt++) {
      const budgetCheck = this.budget.check();
      if (!budgetCheck.ok) {
        this.ui.warn('Correction aborted — budget exhausted.');
        return;
      }

      this.ui.log(`\n${c.yellow}⟲ SWD Correction Turn ${attempt}/${MAX_CORRECTION_RETRIES}${c.reset}`);
      
      const failures = lastResult.results
        .filter(r => ['failed', 'drift'].includes(r.status))
        .map(r => `- [${r.status.toUpperCase()}] ${r.action.operation} ${r.action.path}: ${r.detail}`)
        .join('\n');

      const prompt = `[SWD CORRECTION TURN]\nFile actions failed verification:\n${failures}\n\nPlease correct your response. Attempts remaining: ${MAX_CORRECTION_RETRIES - (attempt - 1)}`;
      
      this.history.push({ role: 'user', content: prompt });
      this.ui.startLoading(`Correction attempt ${attempt}...`);

      let streamStarted = false;
      try {
        const orchestrator = getOrchestrator();
        const response = await orchestrator.streamMessage(
          this.history,
          {
            systemPrompt: this.finalSystemPrompt || '',
            effort: this.options.effort as EffortLevel,
            maxTokens: this.maxOutputTokens,
            deterministic: !!this.forceProvider,
            onThinkingDelta: () => {}, // simple spinner
            onTextDelta: (delta) => {
              if (!streamStarted) {
                this.ui.stopLoading('\n');
                streamStarted = true;
              }
              this.ui.write(delta);
            }
          }
        );

        this.ui.write('\n');
        this.history.push({ role: 'assistant', content: response.text });
        this.budget.record(response.usage.inputTokens, response.usage.outputTokens);

        this.ui.startLoading('Verifying corrected actions...');
        const result = await this.engine.run(parseActions(response.text));
        this.ui.stopLoading();
        printSWDResults(result);

        if (result.success) {
          this.ui.success('Correction successful.');
          return;
        }

        if (attempt >= MAX_CORRECTION_RETRIES) {
          this.ui.error('Max corrections reached. Yielding to human.');
          return;
        }
        lastResult = result;
      } catch (err: any) {
        this.ui.stopLoading();
        this.ui.error(`Correction failed: ${err.message}`);
        return;
      }
    }
  }

  private async runTestHealingLoop(cmd: string): Promise<void> {
    const maxRetries = parseInt(this.options.maxTestRetries || '3', 10);
    let lastOutput = '';
    let lastFailureCount = Infinity;
    
    // Targeted normalization for identical output detection
    const normalizeOutput = (str: string) => 
      str.replace(/\d+\.?\d*ms/g, '')
         .replace(/\d+\.?\d*s/g, '')
         .trim();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!this.budget.check().ok) {
        this.ui.warn('TDD loop aborted — budget exhausted.');
        return;
      }

      this.ui.startLoading(`Running tests: ${c.cyan}${cmd}${c.reset}...`);
      const { passed, output } = await runTestCommand(cmd);
      
      if (passed) {
        this.ui.stopLoading();
        this.ui.success(`Tests passed!`);
        return;
      }

      this.ui.stopLoading();
      this.ui.error(`Tests failed (Attempt ${attempt}/${maxRetries})`);
      
      // 1. Precise Thrashing Guard
      if (attempt > 1 && normalizeOutput(output) === normalizeOutput(lastOutput)) {
         this.ui.warn('Test output is effectively unchanged from previous attempt. Stopping loop to prevent token drain.');
         return;
      }
      lastOutput = output;

      // 2. Regression Detection
      const currentFailureCount = (output.match(/fail|error/gi) || []).length;
      if (attempt > 1 && currentFailureCount > lastFailureCount) {
         this.ui.warn(`Regression detected: Failure count increased (${lastFailureCount} → ${currentFailureCount}). Be cautious.`);
      }
      lastFailureCount = currentFailureCount;

      // 3. Regex Issue Hinting
      let hint = '';
      if (/TypeError|ReferenceError/i.test(output)) {
        hint = 'Runtime error detected.';
      } else if (/TS\d+|error TS/i.test(output)) {
        hint = 'TypeScript compilation issue detected.';
      }

      this.ui.log(`${c.dim}Analyzing failure and generating fix...${c.reset}`);

      // 4. Structured Prompting
      const prompt = `[TEST FAILURE]\n\nCommand:\n${cmd}\n\nSummary:\nThe test suite failed. Analyze the error output below and fix the code.\n${hint ? `Hint: ${hint}\n` : ''}\nError Output:\n\`\`\`text\n${output}\n\`\`\`\n\nInstructions:\n- Fix only what is necessary to make the test pass.\n- Do not rewrite unrelated files.\n- Keep fixes minimal and targeted.`;
      
      this.history.push({ role: 'user', content: prompt });
      this.ui.startLoading(`Capybara is fixing tests...`);

      let streamStarted = false;
      const orchestrator = getOrchestrator();
      const response = await orchestrator.streamMessage(
        this.history,
        {
          systemPrompt: this.finalSystemPrompt || '',
          effort: this.options.effort as EffortLevel,
          maxTokens: this.maxOutputTokens,
          deterministic: !!this.forceProvider,
          onThinkingDelta: () => {}, 
          onTextDelta: (delta) => {
            if (!streamStarted) {
              this.ui.stopLoading('\n');
              streamStarted = true;
            }
            this.ui.write(delta);
          }
        }
      );
      
      this.ui.write('\n');
      this.history.push({ role: 'assistant', content: response.text });
      this.budget.record(response.usage.inputTokens, response.usage.outputTokens);

      // 5. No-Op Guard
      const actions = parseActions(response.text);
      if (actions.length === 0) {
        this.ui.warn('No actionable changes returned by the model. Stopping loop.');
        break;
      }

      // 6. Execute Claude's fix via SWD
      this.ui.startLoading('Applying test fixes...');
      const fixResult = await this.engine.run(actions);
      this.ui.stopLoading();
      printSWDResults(fixResult);
      
      if (!fixResult.success) {
         this.ui.error('SWD failed while attempting to fix tests. Yielding.');
         break;
      }
    }
    
    this.ui.error(`Max test retries (${maxRetries}) reached. Yielding to human.`);
    this.ui.log(`\n${c.dim}--- Final Test Output ---${c.reset}\n${lastOutput}`);
  }


  public async finalize(sandboxBranch: string | null) {
    let commitHash = 'none';
    const repo = isGitRepo();
    if (repo && !this.options.dryRun) {
      try {
        if (hasUncommittedChanges()) commitChanges('mythos: session end');
        commitHash = getLatestHash();
      } catch (err: any) { logWarn(`Auto-commit failed: ${err.message}`); }
    }
    const metadata = { commit: commitHash, branch: sandboxBranch || (repo ? getCurrentBranch() : 'none'), timestamp_end: new Date().toISOString() };
    appendMetadataBlock(metadata, this.options.dryRun || false);

    const snap = this.budget.status();
    if (snap.totalTokens > 0) {
      saveSessionMetric({
        command: 'chat',
        project: path.basename(process.cwd()),
        inputTokens: snap.inputTokens,
        outputTokens: snap.outputTokens,
        turns: snap.turns,
        costUSD: snap.estimatedCostUSD,
        durationMs: snap.elapsedMs,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// ── Terminal Implementation of ChatUI ────────────────────────
class TerminalUI implements ChatUI {
  private spinner: Spinner;

  constructor(spinner: Spinner) {
    this.spinner = spinner;
  }

  startLoading(msg: string) { this.spinner.start(msg); }
  updateLoading(msg: string) { this.spinner.update(msg); }
  stopLoading(msg?: string) { this.spinner.stop(msg); }
  write(text: string) { process.stdout.write(text); }
  log(msg: string) { console.log(msg); }
  warn(msg: string) { logWarn(msg); }
  error(msg: string) { logError(msg); }
  success(msg: string) { logSuccess(msg); }
  divider() { console.log(hr()); }
}

// ── Command Interface ────────────────────────────────────────
interface ChatOptions {
  effort?: string;
  maxTokens?: string;
  maxTurns?: string;
  budget?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  branch?: string;
  testCmd?: string;
  maxTestRetries?: string;
  skill?: string | string[];
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  validateApiKey();
  const ui = new TerminalUI(new Spinner());
  const session = new ChatSession(options, ui);

  ui.log(BANNER);
  ui.log(heading(`CHAT SESSION :: ${MODELS.high.toUpperCase()}`));
  if (options.dryRun) ui.log(`  ${c.bgYellow}${c.black}${c.bold} DRY-RUN MODE ACTIVE ${c.reset}\n`);

  let sandboxBranch: string | null = null;
  try {
    sandboxBranch = await session.setupSandbox();
    await session.initialize();
  } catch (err: any) {
    ui.error(err.message);
    process.exit(1);
  }

  printMemoryStatus();
  ui.divider();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.magenta}${c.bold}mythos > ${c.reset}`,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (['exit', 'quit', '/q'].includes(input.toLowerCase())) { rl.close(); return; }

    await session.processInput(input);
    ui.divider();
    rl.prompt();
  });

  rl.on('close', async () => {
    await session.finalize(sandboxBranch);
    process.exit(0);
  });
}

