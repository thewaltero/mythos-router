import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SWDEngine, parseActions, type FileAction, type SWDOptions, type SWDRunResult } from '../swd.js';
import { reviewActions, type ActionRiskVerdict } from '../security-policy.js';
import { createSWDReceipt, saveSWDReceipt, redactReceiptSecrets, type ReceiptProvider } from '../receipts.js';
import { isGitRepo, getCurrentBranch, getLatestHash } from '../git.js';
import { runActionsInSandbox, type SandboxCheck } from '../sandbox.js';
import { loadProjectPolicy, getDeclaredChecks } from '../project-policy.js';
import {
  MAX_AGENT_INPUT_BYTES,
  parseExternalAgentEnvelope,
  validateExternalAgentInput,
  validateTaskContractForActions,
  type TaskContract,
  type TaskContractValidation,
} from '../action-schema.js';
import { saveRunRecord } from '../runs.js';
import { assertSafeRelativePathShape } from '../path-safety.js';
import { c, error as logError, success as logSuccess, warn as logWarn } from '../utils.js';

export interface ExternalAgentInput {
  actions: FileAction[];
  request?: string;
  summary?: string;
  agent?: {
    id?: string;
    model?: string;
  };
  metadata?: Record<string, unknown>;
  contract?: TaskContract;
}

export interface RejectedAction {
  path: string;
  operation: FileAction['operation'];
  risk: ActionRiskVerdict['risk'];
  reason: string;
}

export interface SandboxCheckSummary {
  name: string;
  command: string;
  passed: boolean;
  outputTail: string;
}

export interface SandboxSummary {
  ran: boolean;
  ok: boolean;
  checks: SandboxCheckSummary[];
  filesCopied?: number;
  setupError?: string;
}

export type TaskContractSummary = TaskContractValidation;

export interface SWDApplyResult {
  ok: boolean;
  mode: 'apply' | 'dry-run';
  actionCount: number;
  approvedCount: number;
  rejected: RejectedAction[];
  result: SWDRunResult;
  receipt?: {
    id: string;
    path: string;
  };
  agent: {
    id: string;
    model: string;
  };
  sandbox?: SandboxSummary;
  contract?: TaskContractSummary;
  run?: {
    id: string;
    path: string;
  };
  runLogError?: string;
}

interface SWDCommandOptions {
  stdin?: boolean;
  file?: string;
  json?: boolean;
  dryRun?: boolean;
  strict?: boolean;
  rollback?: boolean;
  receipt?: boolean;
  allowRisky?: boolean;
  request?: string;
  summary?: string;
  agent?: string;
  model?: string;
  check?: string[];
  runChecks?: boolean;
  runLog?: boolean;
}

interface ApplyExternalAgentOptions {
  rawInput: string;
  dryRun?: boolean;
  strict?: boolean;
  enableRollback?: boolean;
  saveReceipt?: boolean;
  allowRisky?: boolean;
  request?: string;
  summary?: string;
  agentId?: string;
  modelId?: string;
  checks?: SandboxCheck[];
  checkTimeoutMs?: number;
  saveRun?: boolean;
}

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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function summarizeFileActions(actions: FileAction[]): string {
  if (actions.length === 0) return 'No file actions';
  return actions.map((action) => `${action.operation}: ${action.path}`).join('; ');
}

function normalizeOperation(value: unknown): FileAction['operation'] | null {
  if (typeof value !== 'string') return null;
  const op = value.trim().toUpperCase();
  if (op === 'CREATE' || op === 'MODIFY' || op === 'DELETE' || op === 'READ') return op;
  return null;
}

function normalizeIntent(value: unknown, operation: FileAction['operation']): FileAction['intent'] {
  if (typeof value === 'string') {
    const intent = value.trim().toUpperCase();
    if (intent === 'MUTATE' || intent === 'NOOP' || intent === 'UNKNOWN') return intent;
  }
  return operation === 'READ' ? 'NOOP' : 'MUTATE';
}

function assertSafeRelativePath(filePath: unknown): string {
  return assertSafeRelativePathShape(filePath, 'action path', { maxLength: 500 });
}

function normalizeJsonAction(value: unknown): FileAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid action: expected an object.');
  }

  const raw = value as Record<string, unknown>;
  const operation = normalizeOperation(raw.operation);
  if (!operation) {
    throw new Error(`Invalid action operation: ${String(raw.operation)}`);
  }

  const path = assertSafeRelativePath(raw.path);
  const description = typeof raw.description === 'string' && raw.description.trim().length > 0
    ? raw.description.trim()
    : `${operation} ${path}`;

  const action: FileAction = {
    path,
    operation,
    intent: normalizeIntent(raw.intent, operation),
    description,
  };

  if (raw.content !== undefined) {
    if (typeof raw.content !== 'string') {
      throw new Error(`Invalid action content for ${path}: content must be a string.`);
    }
    action.content = raw.content;
  }

  if (raw.contentHash !== undefined) {
    if (typeof raw.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.contentHash.trim())) {
      throw new Error(`Invalid action contentHash for ${path}: expected 64 hex characters.`);
    }
    action.contentHash = raw.contentHash.trim().toLowerCase();
  }

  return action;
}

function parseJsonAgentInput(rawInput: string): ExternalAgentInput | null {
  const trimmed = rawInput.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (Array.isArray(parsed)) {
    return { actions: parsed.map(normalizeJsonAction) };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid JSON input: expected an object or action array.');
  }

  const obj = parsed as Record<string, unknown>;

  if (Array.isArray(obj.actions)) {
    const agent = obj.agent && typeof obj.agent === 'object' && !Array.isArray(obj.agent)
      ? obj.agent as Record<string, unknown>
      : undefined;

    return {
      actions: obj.actions.map(normalizeJsonAction),
      request: typeof obj.request === 'string' ? obj.request : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
      agent: {
        id: typeof agent?.id === 'string' ? agent.id : undefined,
        model: typeof agent?.model === 'string' ? agent.model : undefined,
      },
      metadata: obj.metadata && typeof obj.metadata === 'object' && !Array.isArray(obj.metadata)
        ? obj.metadata as Record<string, unknown>
        : undefined,
    };
  }

  if (typeof obj.output === 'string' || typeof obj.text === 'string') {
    const text = typeof obj.output === 'string' ? obj.output : obj.text as string;
    return {
      actions: parseActions(text),
      request: typeof obj.request === 'string' ? obj.request : undefined,
      summary: typeof obj.summary === 'string' ? obj.summary : undefined,
    };
  }

  throw new Error('Invalid JSON input: expected { actions: [...] }, { output: "..." }, or an action array.');
}

export function parseExternalAgentInput(rawInput: string): ExternalAgentInput {
  const parsed = parseExternalAgentEnvelope(rawInput);
  return {
    actions: parsed.actions,
    request: parsed.request,
    summary: parsed.summary,
    agent: parsed.agent,
    metadata: parsed.metadata,
    contract: parsed.contract,
  };
}

function rejectedFromReview(review: ReturnType<typeof reviewActions>): RejectedAction[] {
  return [
    ...review.blocked.map(({ action, verdict }) => ({
      path: action.path,
      operation: action.operation,
      risk: verdict.risk,
      reason: verdict.reason,
    })),
    ...review.needsConfirmation.map(({ action, verdict }) => ({
      path: action.path,
      operation: action.operation,
      risk: verdict.risk,
      reason: verdict.reason,
    })),
  ];
}

function providerForAgent(agentId: string, modelId: string): ReceiptProvider {
  return {
    providerId: `external:${agentId}`,
    modelId,
  };
}

export async function applyExternalAgentActions(options: ApplyExternalAgentOptions): Promise<SWDApplyResult> {
  const input = parseExternalAgentInput(options.rawInput);
  const actions = input.actions;
  const agentId = options.agentId ?? input.agent?.id ?? 'bring-your-own-agent';
  const modelId = options.modelId ?? input.agent?.model ?? 'external';
  const dryRun = options.dryRun ?? false;
  const saveReceipt = options.saveReceipt ?? !dryRun;
  const saveRun = options.saveRun ?? !dryRun;
  const request = options.request ?? input.request ?? `external-agent:${agentId}:${sha256(options.rawInput).slice(0, 12)}`;
  const summary = options.summary ?? input.summary ?? summarizeFileActions(actions);

  if (actions.length === 0) {
    throw new Error('No valid file actions were found in external agent input.');
  }

  const contractSummary = input.contract
    ? validateTaskContractForActions(actions, input.contract)
    : undefined;

  const finalize = (output: SWDApplyResult): SWDApplyResult => {
    if (contractSummary) output.contract = contractSummary;
    if (saveRun && !dryRun) {
      try {
        output.run = saveRunRecord(output, { request, summary });
      } catch (err) {
        output.runLogError = redactReceiptSecrets(err instanceof Error ? err.message : String(err));
      }
    }
    return output;
  };

  if (contractSummary && !contractSummary.ok) {
    return finalize({
      ok: false,
      mode: dryRun ? 'dry-run' : 'apply',
      actionCount: actions.length,
      approvedCount: 0,
      rejected: [],
      result: {
        success: false,
        results: [],
        rolledBack: false,
        rollbackErrors: [],
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: contractSummary.errors,
      },
      agent: { id: agentId, model: modelId },
    });
  }

  const review = reviewActions(actions);
  const rejected = rejectedFromReview(review);
  const approved = options.allowRisky ? [...review.approved, ...review.needsConfirmation.map(({ action }) => action)] : review.approved;

  if (review.blocked.length > 0) {
    return finalize({
      ok: false,
      mode: dryRun ? 'dry-run' : 'apply',
      actionCount: actions.length,
      approvedCount: approved.length,
      rejected,
      result: {
        success: false,
        results: [],
        rolledBack: false,
        rollbackErrors: [],
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: review.blocked.map(({ verdict }) => verdict.reason),
      },
      agent: { id: agentId, model: modelId },
    });
  }

  if (!options.allowRisky && review.needsConfirmation.length > 0) {
    return finalize({
      ok: false,
      mode: dryRun ? 'dry-run' : 'apply',
      actionCount: actions.length,
      approvedCount: approved.length,
      rejected,
      result: {
        success: false,
        results: [],
        rolledBack: false,
        rollbackErrors: [],
        rollbackStatus: 'not-needed',
        recoveryRequired: false,
        errors: review.needsConfirmation.map(({ verdict }) => verdict.reason),
      },
      agent: { id: agentId, model: modelId },
    });
  }

    // ── Isolated-run gate ────────────────────────────────────────
  // When checks are requested, apply the batch in a throwaway copy and run
  // the checks there FIRST. If they fail, the real working tree is never
  // touched (fail-closed). Checks never run during a dry-run, since dry-run
  // must remain a pure, side-effect-free preview.
  const checks = options.checks ?? [];
  let sandboxSummary: SandboxSummary | undefined;
  if (!dryRun && checks.length > 0 && approved.length > 0) {
    const sandboxResult = await runActionsInSandbox(approved, {
      checks,
      checkTimeoutMs: options.checkTimeoutMs,
    });
    sandboxSummary = {
      ran: true,
      ok: sandboxResult.ok,
      checks: sandboxResult.checks.map((check) => ({
        name: check.name,
        command: check.command,
        passed: check.passed,
        outputTail: redactReceiptSecrets(check.outputTail),
      })),
      filesCopied: sandboxResult.filesCopied,
      setupError: sandboxResult.setupError ? redactReceiptSecrets(sandboxResult.setupError) : undefined,
    };

    if (!sandboxResult.ok) {
      const failureMessages = [
        ...sandboxSummary.checks.filter((check) => !check.passed).map((check) => `Sandbox check failed: ${check.name}`),
        ...(sandboxSummary.setupError ? [`Sandbox setup failed: ${sandboxSummary.setupError}`] : []),
      ];
      return finalize({
        ok: false,
        mode: 'apply',
        actionCount: actions.length,
        approvedCount: approved.length,
        rejected,
        result: {
          success: false,
          results: [],
          rolledBack: false,
          rollbackErrors: [],
          rollbackStatus: 'not-needed',
          recoveryRequired: false,
          errors: failureMessages.length > 0 ? failureMessages : ['Sandbox checks did not pass.'],
        },
        agent: { id: agentId, model: modelId },
        sandbox: sandboxSummary,
      });
    }
  }

  const engineOptions: SWDOptions = {
    dryRun,
    strict: options.strict ?? true,
    enableRollback: options.enableRollback ?? true,
  };
  const engine = new SWDEngine(engineOptions);
  const result = await engine.run(approved);

  const output: SWDApplyResult = {
    ok: result.success && !result.rolledBack,
    mode: dryRun ? 'dry-run' : 'apply',
    actionCount: actions.length,
    approvedCount: approved.length,
    rejected: options.allowRisky
      ? review.blocked.map(({ action, verdict }) => ({
        path: action.path,
        operation: action.operation,
        risk: verdict.risk,
        reason: verdict.reason,
      }))
      : rejected,
    result,
    agent: { id: agentId, model: modelId },
  };

  if (sandboxSummary) output.sandbox = sandboxSummary;

  if (saveReceipt) {
    const receipt = createSWDReceipt({
      request,
      summary: options.summary ?? input.summary ?? summarizeFileActions(approved),
      result,
      provider: providerForAgent(agentId, modelId),
      git: getReceiptGitContext(),
    });
    output.receipt = {
      id: receipt.id,
      path: saveSWDReceipt(receipt, false),
    };
  }

  return finalize(output);
}

async function readStdinBounded(): Promise<string> {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input, 'utf8') > MAX_AGENT_INPUT_BYTES) {
      throw new Error(`stdin input exceeds ${MAX_AGENT_INPUT_BYTES} bytes.`);
    }
  }
  return input;
}

async function resolveInput(options: SWDCommandOptions): Promise<string> {
  if (options.file && options.stdin) {
    throw new Error('Use either --file or --stdin, not both.');
  }

  if (options.file) {
    const content = readFileSync(options.file, 'utf-8');
    if (Buffer.byteLength(content, 'utf8') > MAX_AGENT_INPUT_BYTES) {
      throw new Error(`Input file exceeds ${MAX_AGENT_INPUT_BYTES} bytes.`);
    }
    return content;
  }

  if (options.stdin || !process.stdin.isTTY) {
    return readStdinBounded();
  }

  throw new Error('No input provided. Use --stdin with piped agent output or --file <path>.');
}

function printHumanResult(output: SWDApplyResult): void {
  if (output.rejected.length > 0) {
    for (const rejected of output.rejected) {
      const label = rejected.risk === 'block' ? 'blocked' : 'needs explicit --allow-risky';
      logWarn(`${label}: ${rejected.operation} ${rejected.path} — ${rejected.reason}`);
    }
  }

  if (output.sandbox?.ran) {
    const verb = output.sandbox.ok ? `${c.green}passed${c.reset}` : `${c.red}failed${c.reset}`;
    console.log(`${c.dim}Isolated run:${c.reset} checks ${verb} ${c.dim}(${output.sandbox.filesCopied ?? 0} files mirrored)${c.reset}`);
    for (const check of output.sandbox.checks) {
      const mark = check.passed ? `${c.green}✔${c.reset}` : `${c.red}✗${c.reset}`;
      console.log(`  ${mark} ${check.name} ${c.dim}(${check.command})${c.reset}`);
    }
    if (output.sandbox.setupError) {
      logError(`Sandbox setup failed: ${output.sandbox.setupError}`);
    }
  }

  if (output.contract) {
    if (output.contract.ok) {
      console.log(`${c.dim}Task contract:${c.reset} ${c.green}passed${c.reset}`);
    } else {
      console.log(`${c.dim}Task contract:${c.reset} ${c.red}failed${c.reset}`);
      for (const err of output.contract.errors) logError(err);
    }
  }

  for (const result of output.result.results) {
    const ok = result.status === 'verified' || result.status === 'noop';
    const prefix = ok ? `${c.green}✔${c.reset}` : `${c.red}✗${c.reset}`;
    console.log(`${prefix} ${result.detail}`);
  }

  if (output.receipt) {
    console.log(`${c.dim}Receipt: ${c.cyan}mythos receipts show ${output.receipt.id}${c.reset}`);
  }

  if (output.run) {
    console.log(`${c.dim}Run: ${c.cyan}mythos runs show ${output.run.id}${c.reset}`);
  } else if (output.runLogError) {
    logWarn(`Run record was not saved: ${output.runLogError}`);
  }

  if (output.ok) {
    logSuccess(`SWD ${output.mode === 'dry-run' ? 'dry-run' : 'apply'} verified (${output.approvedCount}/${output.actionCount} actions).`);
  } else {
    logError(`SWD ${output.mode === 'dry-run' ? 'dry-run' : 'apply'} failed.`);
    for (const err of output.result.errors) logError(err);
  }
}

function printValidationResult(validation: ReturnType<typeof validateExternalAgentInput>): void {
  if (validation.ok) {
    logSuccess(`External-agent input is valid (${validation.actionCount} action${validation.actionCount === 1 ? '' : 's'}, ${validation.format}).`);
  } else {
    logError('External-agent input is invalid.');
    for (const err of validation.errors) logError(err);
  }

  if (validation.contract) {
    const status = validation.contract.ok ? `${c.green}passed${c.reset}` : `${c.red}failed${c.reset}`;
    console.log(`${c.dim}Task contract:${c.reset} ${status}`);
    if (validation.contract.expectedOutputs.length > 0) {
      console.log(`${c.dim}Expected outputs:${c.reset} ${validation.contract.expectedOutputs.join(', ')}`);
    }
  }

  for (const warning of validation.warnings) {
    logWarn(warning);
  }
}

export function resolveSandboxChecks(options: Pick<SWDCommandOptions, 'check' | 'runChecks'>): SandboxCheck[] {
  const checks: SandboxCheck[] = [];

  const adHoc = Array.isArray(options.check) ? options.check : [];
  adHoc.forEach((command, index) => {
    const trimmed = typeof command === 'string' ? command.trim() : '';
    if (trimmed.length > 0) checks.push({ name: `check-${index + 1}`, command: trimmed });
  });

  if (options.runChecks) {
    const policy = loadProjectPolicy();
    if (policy.errors.length > 0) {
      throw new Error(`Cannot run declared checks: ${policy.errors.join('; ')}`);
    }
    for (const declared of getDeclaredChecks(policy)) {
      checks.push({ name: declared.name, command: declared.command });
    }
  }

  return checks;
}

export async function swdCommand(action = 'apply', options: SWDCommandOptions): Promise<void> {
  if (action !== 'apply' && action !== 'validate') {
    const message = `Unknown swd action "${action}". Supported: apply, validate.`;
    if (options.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else logError(message);
    process.exitCode = 1;
    return;
  }

  try {
    const rawInput = await resolveInput(options);

    if (action === 'validate') {
      const validation = validateExternalAgentInput(rawInput);
      if (options.json) {
        console.log(JSON.stringify(validation, null, 2));
      } else {
        printValidationResult(validation);
      }
      if (!validation.ok) process.exitCode = 1;
      return;
    }

    const checks = resolveSandboxChecks(options);
    if (checks.length > 0 && options.dryRun) {
      logWarn('Checks are skipped in --dry-run (no commands are executed during a preview).');
    }
    const result = await applyExternalAgentActions({
      rawInput,
      dryRun: options.dryRun ?? false,
      strict: options.strict ?? true,
      enableRollback: options.rollback ?? true,
      saveReceipt: options.dryRun ? false : options.receipt ?? true,
      allowRisky: options.allowRisky ?? false,
      request: options.request,
      summary: options.summary,
      agentId: options.agent,
      modelId: options.model,
      checks,
      saveRun: options.dryRun ? false : options.runLog ?? true,
    });

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanResult(result);
    }

    if (!result.ok) process.exitCode = 1;
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      logError(message);
    }
    process.exitCode = 1;
  }
}
