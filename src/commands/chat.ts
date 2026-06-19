import * as readline from 'node:readline';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { formatTokenUsage, getOrchestrator, type Message } from '../client.js';
import { SWDEngine, parseActions, summarizeActions, snapshotFile, resolveSafePath, type SWDRunResult, type FileAction } from '../swd.js';
import { printSWDResults, dryRunSWD, printVerboseParse } from '../swd-cli.js';
import { saveSessionMetric } from '../metrics.js';
import { appendEntry, appendMetadataBlock, needsDream, getMemoryContext, printMemoryStatus, getEntryCount } from '../memory.js';
import { type EffortLevel, MAX_CORRECTION_RETRIES, MODELS, CAPYBARA_SYSTEM_PROMPT, validateProviderKeys, getEffort } from '../config.js';
import { parseEscalationConfig, effortForCorrection, type EscalationConfig } from '../escalation.js';
import { c, Spinner, BANNER, error as logError, warn as logWarn, success as logSuccess, runTestCommand, countTestFailures, confirmPrompt, renderSessionCard, renderBadgeRow, renderHelpScreen, renderExitSummary, theme, type SessionCardConfig, type ExitSummaryConfig } from '../utils.js';
import { SessionBudget } from '../budget.js';
import { buildSkillPrompt, type Skill } from '../skills.js';
import { isGitRepo, hasUncommittedChanges, getCurrentBranch, commitChanges, getLatestHash, createAndCheckoutBranch } from '../git.js';
import { saveSession, loadSession, formatResumeInfo } from '../session.js';
import { reviewActions, touchesCommandSurface, touchedWritablePaths, type ActionRiskVerdict } from '../security-policy.js';
import {
  createSWDReceipt,
  saveSWDReceipt,
  type ReceiptSkill,
  type ReceiptTestResult,
} from '../receipts.js';

// ── Context Window Guard ─────────────────────────────────────
// Token-estimation + adaptive-compression math lives in ./context-guard.ts as
// pure, unit-tested helpers; ChatSession holds only the per-session calibration
// state (chars/token density + sample count) and delegates the math.
import {
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokens as estimateTokensFor,
  nextDensity,
  isCalibrated,
  planContextCompression,
} from '../context-guard.js';

// ── Extracted command-surface modules ───────────────────────
// chat.ts stays the orchestrator (turn loop + session lifecycle); these hold
// the render layer, shared option types, run-mode input plumbing, and the pure
// TDD-healing helpers, each independently unit-tested.
import { type ChatUI, TerminalUI, warnIfMalformedFileActionOutput } from './chat-ui.js';
import type { ChatOptions, RunOptions, ReceiptContext } from './chat-types.js';
import { resolveRunPrompt, normalizeRunOptions, formatElapsedMs } from './run-input.js';
import {
  normalizeTestOutput,
  getTestFailureHint,
  buildTestFailurePrompt,
  isTestOutputUnchanged,
  detectTestRegression,
  resolveTestTimeoutMs,
  summarizeTestResult,
} from './test-healing.js';

// Re-exported so the package entry point (index.ts) and any embedders keep
// importing the ChatUI type from this module unchanged.
export type { ChatUI } from './chat-ui.js';

function getReceiptGitContext(): { branch?: string; commit?: string } | undefined {
  if (!isGitRepo()) return undefined;

  const branch = getCurrentBranch();
  const commit = getLatestHash();
  const git = {
    ...(branch && branch !== 'unknown' ? { branch } : {}),
    ...(commit && commit !== 'unknown' ? { commit } : {}),
  };

  return Object.keys(git).length > 0 ? git : undefined;
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
  private escalation: EscalationConfig;
  private ui: ChatUI;
  private activeSkills: Skill[] = [];
  private touchedFiles = new Set<string>();
  private pendingTestCommandReview = false;
  // Calibrated tokenizer density (chars per token), refined from real provider
  // usage. Seeded with a rough default until enough real samples accumulate.
  private charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  private tokenCalibrationSamples = 0;

  constructor(options: ChatOptions, ui: ChatUI) {
    this.options = options;
    this.ui = ui;
    this.escalation = parseEscalationConfig(options);
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
      this.forceProvider = options.provider ?? skillResult.forceProvider;
      this.allowFallback = options.fallback === false ? false : skillResult.allowFallback;
      this.timeoutMs = skillResult.timeoutMs;
      this.activeSkills = skillResult.skills;
      budgetMultiplier = skillResult.budgetMultiplier;

      if (skillResult.skills.length > 0) {
        this.ui.divider();
        this.ui.log(`${c.cyan}${c.bold}⚡ ACTIVE SKILLS${c.reset}`);
        for (const skill of skillResult.skills) {
          this.ui.log(`  ${c.green}✔ ${skill.meta.name}${c.dim} (v${skill.meta.version}, ${skill.scope}) - ${skill.meta.description}${c.reset}`);
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

  /**
   * Estimate prompt tokens for a given character count using the calibrated
   * chars/token density (refined from real provider usage).
   */
  private estimateTokens(chars: number): number {
    return estimateTokensFor(chars, this.charsPerToken, isCalibrated(this.tokenCalibrationSamples));
  }

  /**
   * Refine the chars/token density from a real provider turn: we know exactly
   * how many characters were sent and how many input tokens the provider
   * charged for, so the ratio is this session's true tokenizer density. Only a
   * turn that yields a usable ratio counts toward the sample total.
   */
  private calibrateTokenEstimate(observedChars: number, reportedInputTokens: number): void {
    if (!Number.isFinite(reportedInputTokens) || reportedInputTokens <= 0) return;
    if (!Number.isFinite(observedChars) || observedChars <= 0) return;
    this.charsPerToken = nextDensity(
      this.charsPerToken,
      observedChars,
      reportedInputTokens,
      this.tokenCalibrationSamples,
    );
    this.tokenCalibrationSamples++;
  }

  private async enforceContextWindowGuard(): Promise<void> {
    const plan = planContextCompression(
      this.history.map((m) => m.content.length),
      this.finalSystemPrompt?.length ?? 0,
      this.charsPerToken,
      isCalibrated(this.tokenCalibrationSamples),
    );

    if (!plan) return;

    const { messagesToCompress, reason } = plan;

    const toCompress = this.history.slice(0, messagesToCompress);
    const toKeep = this.history.slice(messagesToCompress);

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

      this.budget.record(response.usage.inputTokens, response.usage.outputTokens, response.metadata.modelId, response.metadata.providerId);

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

  public async processInput(input: string): Promise<boolean> {
    if (!this.budget.check().ok) {
      this.ui.warn('Session budget exhausted. Please start a new session or increase limits.');
      return false;
    }

    await this.enforceContextWindowGuard();

    this.history.push({ role: 'user', content: input });
    this.ui.startLoading('Capybara is thinking...');

    // Characters actually sent this turn (system prompt + full history). Paired
    // with the provider's reported input tokens below, this is the ground-truth
    // tokenizer density used to calibrate the context-window guard.
    const requestChars = (this.finalSystemPrompt?.length ?? 0)
      + this.history.reduce((sum, m) => sum + m.content.length, 0);

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
      // In non-TTY contexts (piped output, CI), streamed deltas are suppressed,
      // so `mythos run "..." > out.txt` would otherwise print no answer at all.
      // Echo the final text once here for those cases.
      if (!process.stdout.isTTY && response.text.trim().length > 0) {
        this.ui.write(response.text + '\n');
      }
      this.history.push({ role: 'assistant', content: response.text });
      this.budget.record(response.usage.inputTokens, response.usage.outputTokens, response.metadata.modelId, response.metadata.providerId);
      // Calibrate the context-window guard from this turn's real token usage.
      this.calibrateTokenEstimate(requestChars, response.usage.inputTokens);

      if (this.options.verbose) printVerboseParse(response.text);

      const handled = await this.handleSWD(response.text, input, {
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
      return handled;
    } catch (err: any) {
      this.ui.stopLoading();
      this.ui.error(`API Error: ${err.message}`);
      this.history.pop();
      return false;
    }
  }

  private formatRiskVerdict(actionPath: string, verdict: ActionRiskVerdict): string {
    return `${c.yellow}${verdict.risk.toUpperCase()}${c.reset} ${actionPath} — ${verdict.reason}`;
  }

  private async approveActions(actions: FileAction[], contextLabel: string): Promise<FileAction[]> {
    const review = reviewActions(actions);
    const approved = [...review.approved];

    for (const { action, verdict } of review.blocked) {
      this.ui.warn(`Blocked ${action.operation} ${action.path}: ${verdict.reason}`);
    }

    for (const { action, verdict } of review.needsConfirmation) {
      this.ui.warn(this.formatRiskVerdict(action.path, verdict));
      const ok = await confirmPrompt(
        `${contextLabel}: apply ${action.operation} to ${c.cyan}${action.path}${c.reset}?`,
        false,
      );
      if (ok) {
        approved.push(action);
      } else {
        this.ui.warn(`Skipped ${action.operation} ${action.path}`);
      }
    }

    if (approved.length > 0 && touchesCommandSurface(approved)) {
      this.pendingTestCommandReview = true;
    }

    if (actions.length > 0 && approved.length === 0) {
      this.ui.warn('No file actions were approved after security review.');
    }

    return approved;
  }

  private trackTouchedActions(actions: FileAction[]): void {
    for (const filePath of touchedWritablePaths(actions)) {
      this.touchedFiles.add(filePath);
    }
  }

  private trackSuccessfulTouchedFiles(result: SWDRunResult): void {
    if (!result.success || result.rolledBack) return;
    const actions = result.results
      .filter((res) => res.status === 'verified' || res.status === 'noop')
      .map((res) => res.action);
    this.trackTouchedActions(actions);
  }

  private async ensureTestCommandIsStillTrusted(cmd: string): Promise<boolean> {
    if (!this.pendingTestCommandReview) return true;

    this.ui.warn(
      `The model changed files that can affect command execution. Running ${c.cyan}${cmd}${c.reset} may execute changed scripts.`,
    );
    const ok = await confirmPrompt('Run the test command anyway after reviewing the changes?', false);
    if (!ok) return false;

    this.pendingTestCommandReview = false;
    return true;
  }

  private async handleSWD(responseText: string, userInput: string, receiptContext: ReceiptContext): Promise<boolean> {
    const actions = parseActions(responseText);
    warnIfMalformedFileActionOutput(responseText, actions.length, this.ui);
    if (actions.length === 0) {
      const commandLabel = this.options.mode ?? 'chat';
      appendEntry(`${commandLabel}: ${userInput.slice(0, 80)}`, '✅ clear', this.options.dryRun);
      return true;
    }

    if (this.options.dryRun) {
      const dryResult = await dryRunSWD(actions);
      appendEntry(
        summarizeActions(responseText, userInput),
        `🛠️ dry-run: ${dryResult.accepted.length} accepted, ${dryResult.rejected.length} rejected`,
        true
      );
      return true;
    }

    const approvedActions = await this.approveActions(actions, 'SWD security review');
    if (approvedActions.length === 0) {
      appendEntry(summarizeActions(responseText, userInput), '⚠️ blocked by security policy', false);
      return false;
    }

    this.ui.startLoading('Verifying and applying changes...');
    const result = await this.engine.run(approvedActions);
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
    return finalResult.success && !finalResult.rolledBack && (!testResult || testResult.passed);
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
        git: getReceiptGitContext(),
        skills: this.receiptSkills(),
        test: testResult,
      });
      saveSWDReceipt(receipt, false);
      this.ui.log(`${c.dim}Receipt: ${c.cyan}mythos receipts show ${receipt.id}${c.reset}`);
    } catch (err: any) {
      this.ui.warn(`Receipt save failed: ${err.message}`);
    }
  }

  private receiptSkills(): ReceiptSkill[] | undefined {
    if (this.activeSkills.length === 0) return undefined;

    return this.activeSkills.map((skill) => ({
      id: skill.id,
      name: skill.meta.name,
      version: skill.meta.version,
      source: skill.scope,
      path: skill.scope === 'global' ? undefined : skill.filePath,
    }));
  }

  private appendFileMetadata(result: SWDRunResult): void {
    if (this.options.dryRun || !result.success || result.rolledBack) return;

    this.trackSuccessfulTouchedFiles(result);

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

      // Verified cost-router: when escalation is enabled, each correction turn
      // climbs one effort tier above the base (clamped to the ceiling). When
      // disabled, the base effort string is passed through unchanged so default
      // behavior is identical to before this feature existed.
      const baseEffort = getEffort(this.options.effort);
      const turnEffort: EffortLevel = this.escalation.enabled
        ? effortForCorrection(baseEffort, attempt, this.escalation)
        : (this.options.effort as EffortLevel);
      if (this.escalation.enabled && turnEffort !== baseEffort) {
        this.ui.log(`${c.dim}↑ Escalating to ${turnEffort}-effort (${MODELS[turnEffort]}) after verification failure${c.reset}`);
      }

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
            effort: turnEffort,
            maxTokens: this.maxOutputTokens,
            deterministic: !!this.forceProvider,
            forceProvider: this.forceProvider,
            allowFallback: this.allowFallback,
            timeoutMs: this.timeoutMs,
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
        this.budget.record(response.usage.inputTokens, response.usage.outputTokens, response.metadata.modelId, response.metadata.providerId);

        const correctionActions = parseActions(response.text);
        warnIfMalformedFileActionOutput(response.text, correctionActions.length, this.ui);
        const approvedCorrectionActions = await this.approveActions(correctionActions, 'SWD correction security review');
        if (approvedCorrectionActions.length === 0) {
          this.ui.warn('Correction stopped because no file actions were approved.');
          return lastResult;
        }

        this.ui.startLoading('Verifying corrected actions...');
        const result = await this.engine.run(approvedCorrectionActions);
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

  private async guardTestAttempt(cmd: string, attempts: number, lastOutput: string): Promise<ReceiptTestResult | null> {
    if (!this.budget.check().ok) {
      this.ui.warn('TDD loop aborted — budget exhausted.');
      return summarizeTestResult(cmd, false, attempts, 'budget-exhausted', lastOutput);
    }

    if (!(await this.ensureTestCommandIsStillTrusted(cmd))) {
      this.ui.warn('Skipping test command until the user reviews command-affecting changes.');
      return summarizeTestResult(cmd, false, attempts, 'skipped-command-surface-review', lastOutput);
    }

    return null;
  }

  private async runTestAttempt(cmd: string, attempt: number, maxRetries: number): Promise<{ passed: boolean; output: string }> {
    this.ui.startLoading(`Running tests: ${c.cyan}${cmd}${c.reset}...`);
    const result = await runTestCommand(cmd, resolveTestTimeoutMs(this.options.testTimeout));

    if (result.passed) {
      this.ui.stopLoading();
      this.ui.success('Tests passed!');
      return result;
    }

    this.ui.stopLoading();
    this.ui.error(`Tests failed (Attempt ${attempt}/${maxRetries})`);
    return result;
  }

  private warnIfTestRegression(attempt: number, output: string, lastFailureCount: number): number {
    const currentFailureCount = countTestFailures(output);

    if (detectTestRegression(attempt, currentFailureCount, lastFailureCount)) {
      this.ui.warn(`Regression detected: Failure count increased (${lastFailureCount} → ${currentFailureCount}). Be cautious.`);
    }

    return currentFailureCount;
  }

  private async requestTestFix(prompt: string): Promise<string> {
    this.history.push({ role: 'user', content: prompt });
    this.ui.startLoading('Capybara is fixing tests...');

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
    this.budget.record(response.usage.inputTokens, response.usage.outputTokens, response.metadata.modelId, response.metadata.providerId);
    return response.text;
  }

  private async applyTestFixResponse(responseText: string, cmd: string, attempts: number, lastOutput: string): Promise<ReceiptTestResult | null> {
    const actions = parseActions(responseText);
    warnIfMalformedFileActionOutput(responseText, actions.length, this.ui);

    if (actions.length === 0) {
      this.ui.warn('No actionable changes returned by the model. Stopping loop.');
      return summarizeTestResult(cmd, false, attempts, 'no-actions', lastOutput);
    }

    const approvedTestFixActions = await this.approveActions(actions, 'Test-fix security review');
    if (approvedTestFixActions.length === 0) {
      this.ui.warn('No approved test-fix actions remain after security review. Stopping loop.');
      return summarizeTestResult(cmd, false, attempts, 'no-approved-actions', lastOutput);
    }

    this.ui.startLoading('Applying test fixes...');
    const fixResult = await this.engine.run(approvedTestFixActions);
    this.ui.stopLoading();
    printSWDResults(fixResult);

    if (!fixResult.success) {
      this.ui.error('SWD failed while attempting to fix tests. Yielding.');
      return summarizeTestResult(cmd, false, attempts, 'swd-failed', lastOutput);
    }

    this.appendFileMetadata(fixResult);
    return null;
  }

  private async generateAndApplyTestFix(cmd: string, output: string, attempts: number): Promise<ReceiptTestResult | null> {
    const hint = getTestFailureHint(output);
    this.ui.log(`${c.dim}Analyzing failure and generating fix...${c.reset}`);

    const prompt = buildTestFailurePrompt(cmd, output, hint);
    const responseText = await this.requestTestFix(prompt);
    return this.applyTestFixResponse(responseText, cmd, attempts, output);
  }

  private async runTestHealingLoop(cmd: string): Promise<ReceiptTestResult> {
    const maxRetries = parseInt(this.options.maxTestRetries || '3', 10);
    let lastOutput = '';
    let lastFailureCount = Infinity;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const guardedResult = await this.guardTestAttempt(cmd, attempts, lastOutput);
      if (guardedResult) return guardedResult;

      const testResult = await this.runTestAttempt(cmd, attempt, maxRetries);
      attempts = attempt;

      if (testResult.passed) {
        return summarizeTestResult(cmd, true, attempts, 'passed', testResult.output);
      }

      if (isTestOutputUnchanged(attempt, testResult.output, lastOutput)) {
        this.ui.warn('Test output is effectively unchanged from previous attempt. Stopping loop to prevent token drain.');
        return summarizeTestResult(cmd, false, attempts, 'unchanged-output', testResult.output);
      }

      lastOutput = testResult.output;
      lastFailureCount = this.warnIfTestRegression(attempt, testResult.output, lastFailureCount);

      const fixResult = await this.generateAndApplyTestFix(cmd, testResult.output, attempts);
      if (fixResult) return fixResult;
    }

    this.ui.error(`Max test retries (${maxRetries}) reached. Yielding to human.`);
    this.ui.log(`\n${c.dim}--- Final Test Output ---${c.reset}\n${lastOutput}`);
    return summarizeTestResult(cmd, false, attempts, 'max-retries', lastOutput);
  }


  public async finalize(
    sandboxBranch: string | null,
    finalizeOptions: { command?: 'chat' | 'run'; saveSession?: boolean } = {},
  ) {
    const command = finalizeOptions.command ?? 'chat';
    const shouldSaveSession = finalizeOptions.saveSession ?? true;
    let commitHash = 'none';
    const repo = isGitRepo();
    if (repo && !this.options.dryRun) {
      try {
        // Only auto-commit when running in a sandbox branch (--branch).
        // Without --branch, committing would capture the user's unrelated
        // uncommitted work under a generic "mythos: session end" message.
        if (sandboxBranch && hasUncommittedChanges()) {
          const touchedFiles = Array.from(this.touchedFiles);
          if (touchedFiles.length > 0) {
            commitChanges('mythos: session end', touchedFiles);
          } else {
            logWarn('Auto-commit skipped: no Mythos-managed file paths were recorded.');
          }
        }
        commitHash = getLatestHash();
      } catch (err: any) { logWarn(`Auto-commit failed: ${err.message}`); }
    }
    const metadata = { commit: commitHash, branch: sandboxBranch || (repo ? getCurrentBranch() : 'none'), timestamp_end: new Date().toISOString() };
    appendMetadataBlock(metadata, 'meta', this.options.dryRun || false);

    const snap = this.budget.status();
    if (snap.totalTokens > 0) {
      saveSessionMetric({
        command,
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
    if (shouldSaveSession && this.history.length > 0 && !this.options.dryRun) {
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

export async function chatCommand(options: ChatOptions): Promise<void> {
  validateProviderKeys();
  const ui = new TerminalUI(new Spinner());
  const session = new ChatSession(options, ui);

  ui.log(BANNER);

  // ── Resume previous session if requested ────────────────
  if (options.resume) {
    const saved = loadSession();
    const currentProject = path.basename(process.cwd());
    if (saved && saved.project && saved.project !== currentProject) {
      ui.warn(
        `Last saved session was for project "${saved.project}", not "${currentProject}". Starting fresh to avoid cross-project context.`,
      );
    } else if (saved) {
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
    // Pause input while this turn is handled so a second pasted/typed line
    // cannot start a concurrent turn and interleave history/budget mutations.
    // Every terminal path below re-prompts (which resumes) or closes the stream.
    rl.pause();
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

// -- Run command and local helpers -----------------------------
export async function runCommand(prompt: string, options: RunOptions): Promise<void> {
  let input: string;
  try {
    input = await resolveRunPrompt(prompt, options);
  } catch (err: any) {
    logError(err.message);
    process.exitCode = 1;
    return;
  }

  validateProviderKeys();
  const runOptions = normalizeRunOptions(options);
  const ui = new TerminalUI(new Spinner());
  const session = new ChatSession(runOptions, ui);

  let sandboxBranch: string | null = null;
  try {
    sandboxBranch = await session.setupSandbox();
    await session.initialize();
  } catch (err: any) {
    ui.error(err.message);
    process.exitCode = 1;
    return;
  }

  const repo = isGitRepo();
  const snap = session.budget.status();
  const cardConfig: SessionCardConfig = {
    provider: session.forceProvider ?? 'auto',
    model: MODELS[runOptions.effort ?? 'high'] || MODELS.high,
    dryRun: runOptions.dryRun === true,
    budgetEnabled: runOptions.budget !== false,
    branch: sandboxBranch || (repo ? getCurrentBranch() : 'none'),
    memoryEntries: getEntryCount(),
    memoryActive: getEntryCount() > 0,
    tokensUsed: snap.totalTokens,
    maxTokens: snap.maxTokens,
    turnsUsed: snap.turns,
    maxTurns: snap.maxTurns,
  };
  ui.log(renderSessionCard(cardConfig));

  const badges = renderBadgeRow({
    dryRun: runOptions.dryRun,
    verbose: runOptions.verbose,
    branch: sandboxBranch || undefined,
    noBudget: runOptions.budget === false,
  });
  if (badges) ui.log(badges);
  ui.divider();

  const startMemoryEntries = getEntryCount();
  const startTime = Date.now();
  let ok = false;
  let finalized = false;

  try {
    ok = await session.processInput(input);
  } finally {
    try {
      await session.finalize(sandboxBranch, { command: 'run', saveSession: false });
      finalized = true;
    } catch (err: any) {
      logWarn(`Finalize failed: ${err.message}`);
    }
  }

  const finalSnap = session.budget.status();
  if (finalSnap.totalTokens > 0) {
    const status = ok && finalized ? `${c.green}Run complete${c.reset}` : `${c.yellow}Run finished with issues${c.reset}`;
    ui.log(`\n${status}`);
    ui.log(
      `${c.dim}Duration: ${formatElapsedMs(Date.now() - startTime)} | ` +
      `Turns: ${finalSnap.turns}/${finalSnap.maxTurns} | ` +
      `Tokens: ${finalSnap.totalTokens.toLocaleString()}/${finalSnap.maxTokens.toLocaleString()} | ` +
      `Cost: ~$${finalSnap.estimatedCostUSD.toFixed(4)} | ` +
      `Memory entries: +${Math.max(0, getEntryCount() - startMemoryEntries)}${c.reset}`,
    );
  }

  process.exitCode = ok && finalized ? 0 : 1;
}
