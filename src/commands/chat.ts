import * as readline from 'node:readline';
import * as path from 'node:path';
import { formatTokenUsage, getOrchestrator, type Message } from '../client.js';
import { SWDEngine, parseActions, summarizeActions, snapshotFile, resolveSafePath, type SWDRunResult } from '../swd.js';
import { printSWDResults, dryRunSWD, printVerboseParse } from '../swd-cli.js';
import { saveSessionMetric } from '../metrics.js';
import { appendEntry, appendMetadataBlock, needsDream, getMemoryContext, printMemoryStatus, getEntryCount } from '../memory.js';
import { type EffortLevel, MAX_CORRECTION_RETRIES, MODELS, CAPYBARA_SYSTEM_PROMPT, validateApiKey } from '../config.js';
import { c, Spinner, BANNER, hr, error as logError, warn as logWarn, success as logSuccess, runTestCommand, renderSessionCard, renderBadgeRow, renderHelpScreen, renderExitSummary, theme, type SessionCardConfig, type ExitSummaryConfig } from '../utils.js';
import { SessionBudget } from '../budget.js';
import { buildSkillPrompt } from '../skills.js';
import { isGitRepo, hasUncommittedChanges, getCurrentBranch, commitChanges, getLatestHash, createAndCheckoutBranch } from '../git.js';
import { saveSession, loadSession, formatResumeInfo } from '../session.js';
import {
  createSWDReceipt,
  saveSWDReceipt,
  type ReceiptProvider,
  type ReceiptTestResult,
  type ReceiptTestStatus,
  type ReceiptUsage,
} from '../receipts.js';

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
  public allowFallback?: boolean;
  public timeoutMs?: number;
  public requiresTools?: boolean;
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
      const skillResult = buildSkillPrompt(CAPYBARA_SYSTEM_PROMPT, skills);
      this.finalSystemPrompt = skillResult.prompt;
      this.maxOutputTokens = skillResult.maxOutputTokens;
      this.forceProvider = skillResult.forceProvider;
      this.allowFallback = skillResult.allowFallback;
      this.timeoutMs = skillResult.timeoutMs;
      budgetMultiplier = skillResult.budgetMultiplier;

      // requiresTools is parsed but no providers implement tool_calling yet.
      // Warn and neutralize so the orchestrator doesn't reject all providers.
      if (skillResult.requiresTools) {
        this.ui.warn('Skill declares requires-tools, but tool calling is not yet implemented. This field is reserved for future use.');
        this.requiresTools = false;
      }

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

  private async enforceContextWindowGuard(): Promise<void> {
    let historyLength = 0;
    for (const msg of this.history) {
      historyLength += msg.content.length;
    }

    // 1. Token estimation with 1.2x safety multiplier
    const historyTokens = Math.ceil((historyLength / 4) * 1.2);
    const systemPromptTokens = Math.ceil(((this.finalSystemPrompt?.length ?? 0) / 4) * 1.2);

    // 3. System prompt inclusion safety buffer
    const RESPONSE_BUFFER = 8192;
    const effectiveLimit = 150_000 - systemPromptTokens - RESPONSE_BUFFER;

    // 2. Compression ceiling rule
    const MAX_MESSAGES = 120;
    const overTokenLimit = historyTokens > effectiveLimit;
    const overMessageLimit = this.history.length > MAX_MESSAGES;

    if (!overTokenLimit && !overMessageLimit) return;

    // At least 60%, or more if needed to get under the message cap
    const messagesToCompress = Math.max(
      Math.floor(this.history.length * 0.6),
      this.history.length - (MAX_MESSAGES - 1)
    );

    if (messagesToCompress < 2) return;

    const toCompress = this.history.slice(0, messagesToCompress);
    const toKeep = this.history.slice(messagesToCompress);

    const reason = overMessageLimit ? `message cap (> ${MAX_MESSAGES})` : '150k token limit';
    this.ui.warn(`\n${c.yellow}Context approaching ${reason}. Compressing oldest ${messagesToCompress} turns...${c.reset}`);

    const prompt = `Please summarize the following older conversation context into a dense, factual summary. Preserve all technical decisions, constraints, paths, and context needed to continue the work.\n\n<history>\n${JSON.stringify(toCompress, null, 2)}\n</history>`;

    try {
      const orchestrator = getOrchestrator();
      const response = await orchestrator.sendMessage(
        [{ role: 'user', content: prompt }],
        {
          systemPrompt: 'You are a core memory compression system. Be extremely dense and factual.',
          effort: 'low',
          maxTokens: 4096,
          deterministic: !!this.forceProvider,
          forceProvider: this.forceProvider
        }
      );

      this.budget.record(response.usage.inputTokens, response.usage.outputTokens);

      this.history = [
        { role: 'user', content: `[CONTEXT SUMMARY OF PREVIOUS TURNS]\n${response.text}` },
        { role: 'assistant', content: 'Acknowledged. I have the compressed context and will continue from here.' },
        ...toKeep
      ];

      appendEntry('Context Compression', `Summarized ${messagesToCompress} turns to prevent context overflow.`, this.options.dryRun);
    } catch (err: any) {
      this.ui.warn(`\n${c.red}Summarization failed (${err.message}). Falling back to hard truncation.${c.reset}`);
      this.history = toKeep;
      appendEntry('Context Compression', `Hard truncation of ${messagesToCompress} turns due to summary failure.`, this.options.dryRun);
    }
  }

  public async processInput(input: string): Promise<void> {
    if (!this.budget.check().ok) {
      this.ui.warn('Session budget exhausted. Please start a new session or increase limits.');
      return;
    }

    await this.enforceContextWindowGuard();

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
          forceProvider: this.forceProvider,
          allowFallback: this.allowFallback,
          timeoutMs: this.timeoutMs,
          requiresTools: this.requiresTools,
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

      await this.handleSWD(response.text, input, {
        provider: {
          providerId: response.metadata.providerId,
          modelId: response.metadata.modelId,
          fallbackTriggered: response.metadata.fallbackTriggered,
          incomplete: response.metadata.incomplete,
          latencyMs: response.usage.latencyMs,
        },
        usage: {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
        },
      });

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

  private async handleSWD(responseText: string, userInput: string, receiptContext: ReceiptContext): Promise<void> {
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

    let finalResult = result;
    if (!result.success) {
      finalResult = await this.runCorrectionLoop(result);
    }

    let testResult: ReceiptTestResult | undefined;
    if (this.options.testCmd) {
      if (!finalResult.success || finalResult.rolledBack) {
        this.ui.warn('Skipping test execution because SWD did not finish cleanly.');
        testResult = summarizeTestResult(this.options.testCmd, false, 0, 'skipped-swd-failed', '');
      } else {
        testResult = await this.runTestHealingLoop(this.options.testCmd);
      }
    }

    const status = finalResult.success ? '✅ verified' : `⚠️ ${finalResult.results.filter(r => r.status !== 'verified').length} issues`;
    const summary = summarizeActions(responseText, userInput);
    appendEntry(summary, status, false);

    // Append file metadata only after a fully successful, non-rolled-back SWD run.
    // This prevents stale hash metadata from being recorded after failed or rolled-back writes.
    if (finalResult.success && !finalResult.rolledBack) {
      this.appendFileMetadata(finalResult);
    }

    this.saveReceipt(userInput, summary, finalResult, receiptContext, testResult);
  }

  private saveReceipt(
    userInput: string,
    summary: string,
    result: SWDRunResult,
    receiptContext: ReceiptContext,
    testResult?: ReceiptTestResult,
  ): void {
    if (this.options.dryRun) return;

    try {
      const snap = this.budget.status();
      const receipt = createSWDReceipt({
        request: userInput,
        summary,
        result,
        provider: receiptContext.provider,
        usage: receiptContext.usage,
        budget: {
          sessionInputTokens: snap.inputTokens,
          sessionOutputTokens: snap.outputTokens,
          sessionTotalTokens: snap.totalTokens,
          sessionTurns: snap.turns,
          estimatedCostUSD: snap.estimatedCostUSD,
        },
        test: testResult,
      });
      saveSWDReceipt(receipt, false);
      this.ui.log(`${c.dim}Receipt: ${c.cyan}mythos receipts show ${receipt.id}${c.reset}`);
    } catch (err: any) {
      this.ui.warn(`Receipt save failed: ${err.message}`);
    }
  }

  private appendFileMetadata(result: SWDRunResult): void {
    if (this.options.dryRun || !result.success || result.rolledBack) return;

    for (const res of result.results) {
      if (res.status !== 'verified' && res.status !== 'noop') continue;

      const op = res.action.operation;
      if (op === 'READ') continue;

      try {
        const absPath = resolveSafePath(res.action.path);
        const snap = snapshotFile(absPath);
        const meta: Record<string, string> = {
          op,
          path: res.action.path,
          exists: snap.exists ? 'true' : 'false',
        };

        if (snap.exists) {
          meta.sha256 = snap.hash;
          meta.size = snap.size.toString();
        }

        appendMetadataBlock(meta, 'file', false);
      } catch {
        // Metadata is non-authoritative. It improves drift detection,
        // but must never break an otherwise successful SWD run.
      }
    }
  }

  private async runCorrectionLoop(lastResult: SWDRunResult): Promise<SWDRunResult> {
    for (let attempt = 1; attempt <= MAX_CORRECTION_RETRIES; attempt++) {
      const budgetCheck = this.budget.check();
      if (!budgetCheck.ok) {
        this.ui.warn('Correction aborted — budget exhausted.');
        return lastResult;
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
            forceProvider: this.forceProvider,
            allowFallback: this.allowFallback,
            timeoutMs: this.timeoutMs,
            requiresTools: this.requiresTools,
            onThinkingDelta: () => { }, // simple spinner
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
          return result;
        }

        if (attempt >= MAX_CORRECTION_RETRIES) {
          this.ui.error('Max corrections reached. Yielding to human.');
          return result;
        }
        lastResult = result;
      } catch (err: any) {
        this.ui.stopLoading();
        this.ui.error(`Correction failed: ${err.message}`);
        return lastResult;
      }
    }
    return lastResult;
  }

  private async runTestHealingLoop(cmd: string): Promise<ReceiptTestResult> {
    const maxRetries = parseInt(this.options.maxTestRetries || '3', 10);
    let lastOutput = '';
    let lastFailureCount = Infinity;
    let attempts = 0;

    // Targeted normalization for identical output detection
    const normalizeOutput = (str: string) =>
      str.replace(/\d+\.?\d*ms/g, '')
        .replace(/\d+\.?\d*s/g, '')
        .trim();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (!this.budget.check().ok) {
        this.ui.warn('TDD loop aborted — budget exhausted.');
        return summarizeTestResult(cmd, false, attempts, 'budget-exhausted', lastOutput);
      }

      this.ui.startLoading(`Running tests: ${c.cyan}${cmd}${c.reset}...`);
      const { passed, output } = await runTestCommand(cmd);
      attempts = attempt;

      if (passed) {
        this.ui.stopLoading();
        this.ui.success(`Tests passed!`);
        return summarizeTestResult(cmd, true, attempts, 'passed', output);
      }

      this.ui.stopLoading();
      this.ui.error(`Tests failed (Attempt ${attempt}/${maxRetries})`);

      // 1. Precise Thrashing Guard
      if (attempt > 1 && normalizeOutput(output) === normalizeOutput(lastOutput)) {
        this.ui.warn('Test output is effectively unchanged from previous attempt. Stopping loop to prevent token drain.');
        return summarizeTestResult(cmd, false, attempts, 'unchanged-output', output);
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
          forceProvider: this.forceProvider,
          allowFallback: this.allowFallback,
          timeoutMs: this.timeoutMs,
          requiresTools: this.requiresTools,
          onThinkingDelta: () => { },
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
        return summarizeTestResult(cmd, false, attempts, 'no-actions', lastOutput);
      }

      // 6. Execute Claude's fix via SWD
      this.ui.startLoading('Applying test fixes...');
      const fixResult = await this.engine.run(actions);
      this.ui.stopLoading();
      printSWDResults(fixResult);

      if (!fixResult.success) {
        this.ui.error('SWD failed while attempting to fix tests. Yielding.');
        return summarizeTestResult(cmd, false, attempts, 'swd-failed', lastOutput);
      }

      this.appendFileMetadata(fixResult);
    }

    this.ui.error(`Max test retries (${maxRetries}) reached. Yielding to human.`);
    this.ui.log(`\n${c.dim}--- Final Test Output ---${c.reset}\n${lastOutput}`);
    return summarizeTestResult(cmd, false, attempts, 'max-retries', lastOutput);
  }


  public async finalize(sandboxBranch: string | null) {
    let commitHash = 'none';
    const repo = isGitRepo();
    if (repo && !this.options.dryRun) {
      try {
        // Only auto-commit when running in a sandbox branch (--branch).
        // Without --branch, committing would capture the user's unrelated
        // uncommitted work under a generic "mythos: session end" message.
        if (sandboxBranch && hasUncommittedChanges()) {
          commitChanges('mythos: session end');
        }
        commitHash = getLatestHash();
      } catch (err: any) { logWarn(`Auto-commit failed: ${err.message}`); }
    }
    const metadata = { commit: commitHash, branch: sandboxBranch || (repo ? getCurrentBranch() : 'none'), timestamp_end: new Date().toISOString() };
    appendMetadataBlock(metadata, 'meta', this.options.dryRun || false);

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

    // Persist session for --resume
    if (this.history.length > 0 && !this.options.dryRun) {
      try {
        saveSession(this.history, {
          inputTokens: snap.inputTokens,
          outputTokens: snap.outputTokens,
          turns: snap.turns,
        }, path.basename(process.cwd()));
      } catch (err: any) {
        logWarn(`Session save failed: ${err.message}`);
      }
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
  resume?: boolean;
}

interface ReceiptContext {
  provider?: ReceiptProvider;
  usage?: Omit<ReceiptUsage, 'totalTokens'>;
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  validateApiKey();
  const ui = new TerminalUI(new Spinner());
  const session = new ChatSession(options, ui);

  ui.log(BANNER);

  // ── Resume previous session if requested ────────────────
  if (options.resume) {
    const saved = loadSession();
    if (saved) {
      session.history = saved.history;
      // Re-record previous budget usage so the limiter is aware
      session.budget.restore(saved.budget.inputTokens, saved.budget.outputTokens, saved.budget.turns);
      ui.success(formatResumeInfo(saved));
    } else {
      ui.warn('No resumable session found. Starting fresh.');
    }
  }

  let sandboxBranch: string | null = null;
  try {
    sandboxBranch = await session.setupSandbox();
    await session.initialize();
  } catch (err: any) {
    ui.error(err.message);
    process.exit(1);
  }

  // ── Session Card ────────────────────────────────────────
  const repo = isGitRepo();
  const snap = session.budget.status();
  const cardConfig: SessionCardConfig = {
    provider: session.forceProvider ?? 'auto',
    model: MODELS[options.effort ?? 'high'] || MODELS.high,
    dryRun: options.dryRun === true,
    budgetEnabled: options.budget !== false,
    branch: sandboxBranch || (repo ? getCurrentBranch() : 'none'),
    memoryEntries: getEntryCount(),
    memoryActive: getEntryCount() > 0,
    tokensUsed: snap.totalTokens,
    maxTokens: snap.maxTokens,
    turnsUsed: snap.turns,
    maxTurns: snap.maxTurns,
  };
  ui.log(renderSessionCard(cardConfig));

  // ── Badge Row ──────────────────────────────────────────
  const badges = renderBadgeRow({
    dryRun: options.dryRun,
    verbose: options.verbose,
    branch: sandboxBranch || undefined,
    resume: options.resume,
    noBudget: options.budget === false,
  });
  if (badges) ui.log(badges);

  ui.log(`${theme.muted}  Type /help for commands. Press Ctrl+C to save and exit.${c.reset}`);
  ui.divider();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${c.magenta}${c.bold}mythos > ${c.reset}`,
  });

  // Track starting memory count for exit summary delta
  const startMemoryEntries = getEntryCount();
  const startTime = Date.now();

  let finalized = false;
  const safeExit = async (code = 0) => {
    if (finalized) return;
    finalized = true;
    try {
      await session.finalize(sandboxBranch);
    } catch (err: any) {
      logWarn(`Finalize failed: ${err.message}`);
    }

    // ── Exit Summary ──────────────────────────────────────
    const snap = session.budget.status();
    const exitConfig: ExitSummaryConfig = {
      duration: formatElapsedMs(Date.now() - startTime),
      turns: snap.turns,
      maxTurns: snap.maxTurns,
      tokens: snap.totalTokens,
      maxTokens: snap.maxTokens,
      cost: snap.estimatedCostUSD,
      memoryEntriesAdded: Math.max(0, getEntryCount() - startMemoryEntries),
      saved: !options.dryRun && session.history.length > 0,
    };
    if (snap.totalTokens > 0) {
      ui.log('\n' + renderExitSummary(exitConfig));
    }

    process.exit(code);
  };

  process.on('SIGINT', () => safeExit(0));
  process.on('SIGTERM', () => safeExit(0));
  process.on('uncaughtException', async (err) => {
    logError(`Unexpected error: ${err.stack || err.message}`);
    await safeExit(1);
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    const cmd = input.toLowerCase();

    // ── Exit commands ───────────────────────────────────
    if (['exit', 'quit', '/q'].includes(cmd)) { rl.close(); return; }

    // ── Slash commands ──────────────────────────────────
    if (cmd === '/help') {
      ui.log('\n' + renderHelpScreen());
      rl.prompt();
      return;
    }

    if (cmd === '/status') {
      const currentRepo = isGitRepo();
      const currentSnap = session.budget.status();
      const statusCard: SessionCardConfig = {
        provider: session.forceProvider ?? 'auto',
        model: MODELS[options.effort ?? 'high'] || MODELS.high,
        dryRun: options.dryRun === true,
        budgetEnabled: options.budget !== false,
        branch: sandboxBranch || (currentRepo ? getCurrentBranch() : 'none'),
        memoryEntries: getEntryCount(),
        memoryActive: getEntryCount() > 0,
        tokensUsed: currentSnap.totalTokens,
        maxTokens: currentSnap.maxTokens,
        turnsUsed: currentSnap.turns,
        maxTurns: currentSnap.maxTurns,
      };
      ui.log('\n' + renderSessionCard(statusCard));
      rl.prompt();
      return;
    }

    if (cmd === '/budget') {
      ui.log('\n' + session.budget.formatBar());
      const warning = session.budget.formatWarning();
      if (warning) ui.warn(warning);
      rl.prompt();
      return;
    }

    if (cmd === '/memory') {
      printMemoryStatus();
      rl.prompt();
      return;
    }

    if (cmd.startsWith('/clear')) {
      if (cmd === '/clear confirm') {
        const prevLen = session.history.length;
        session.history = [];
        ui.success(`Cleared ${prevLen} messages from conversation history.`);
      } else {
        ui.warn(`To clear conversation history, type: ${c.cyan}/clear confirm${c.reset}`);
      }
      rl.prompt();
      return;
    }

    await session.processInput(input);
    ui.divider();
    rl.prompt();
  });

  rl.on('close', safeExit);
}

// ── Local Helpers ────────────────────────────────────────────
function formatElapsedMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes < 60) return `${minutes}m ${secs}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}

function summarizeTestResult(
  command: string,
  passed: boolean,
  attempts: number,
  status: ReceiptTestStatus,
  output: string,
): ReceiptTestResult {
  const trimmed = output.trim();
  const result: ReceiptTestResult = {
    command,
    passed,
    attempts,
    status,
  };
  if (trimmed) result.outputTail = trimmed.slice(-1000);
  return result;
}
