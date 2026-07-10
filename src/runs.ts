import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { redactReceiptSecrets } from './receipts.js';
import type { FileAction, SWDRollbackStatus } from './swd.js';
import type { SandboxSummary, SWDApplyResult, TaskContractSummary } from './commands/swd.js';

export const RUNS_DIR = '.mythos/runs';
export const RUN_RECORD_VERSION = 1;

export interface RunFileSummary {
  path: string;
  operation: FileAction['operation'] | string;
  status: string;
  detail?: string;
}

export interface RunRecord {
  id: string;
  version: typeof RUN_RECORD_VERSION;
  timestamp: string;
  mode: SWDApplyResult['mode'];
  ok: boolean;
  actionCount: number;
  approvedCount: number;
  request?: string;
  summary?: string;
  agent: {
    id: string;
    model: string;
  };
  receipt?: {
    id: string;
    path: string;
  };
  contract?: TaskContractSummary;
  sandbox?: SandboxSummary;
  rejected: SWDApplyResult['rejected'];
  files: RunFileSummary[];
  rolledBack: boolean;
  rollbackStatus?: SWDRollbackStatus;
  recoveryRequired?: boolean;
  errors: string[];
  rollbackErrors: string[];
}

export interface RunSummary {
  id: string;
  timestamp: string;
  ok: boolean;
  mode: SWDApplyResult['mode'];
  actionCount: number;
  approvedCount: number;
  agent: string;
  model: string;
  receiptId?: string;
  checked: boolean;
  rolledBack: boolean;
  rollbackStatus?: SWDRollbackStatus;
  recoveryRequired?: boolean;
  summary?: string;
}

export function getRunsDir(rootDir = process.cwd()): string {
  return join(rootDir, RUNS_DIR);
}

export function saveRunRecord(
  output: SWDApplyResult,
  context: { request?: string; summary?: string } = {},
): { id: string; path: string } {
  const dir = getRunsDir();
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString();
  const files = summarizeRunFiles(output);
  const id = createRunId(timestamp, output, files);
  const record: RunRecord = {
    id,
    version: RUN_RECORD_VERSION,
    timestamp,
    mode: output.mode,
    ok: output.ok,
    actionCount: output.actionCount,
    approvedCount: output.approvedCount,
    request: context.request ? redactReceiptSecrets(context.request) : undefined,
    summary: context.summary ? redactReceiptSecrets(context.summary) : undefined,
    agent: output.agent,
    receipt: output.receipt,
    contract: output.contract,
    sandbox: sanitizeSandbox(output.sandbox),
    rejected: output.rejected.map((rejected) => ({
      ...rejected,
      reason: redactReceiptSecrets(rejected.reason),
    })),
    files,
    rolledBack: output.result.rolledBack,
    rollbackStatus: output.result.rollbackStatus,
    recoveryRequired: output.result.recoveryRequired,
    errors: output.result.errors.map(redactReceiptSecrets),
    rollbackErrors: output.result.rollbackErrors.map(redactReceiptSecrets),
  };

  const filePath = join(dir, `${id}.json`);
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  return { id, path: filePath };
}

export function listRuns(limit = 10): RunSummary[] {
  return runFiles()
    .slice(0, Math.max(1, Math.min(100, Math.floor(limit))))
    .map((filePath) => readRunFile(filePath))
    .filter((record): record is RunRecord => record !== null)
    .map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      ok: record.ok,
      mode: record.mode,
      actionCount: record.actionCount,
      approvedCount: record.approvedCount,
      agent: record.agent.id,
      model: record.agent.model,
      receiptId: record.receipt?.id,
      checked: record.sandbox?.ran === true,
      rolledBack: record.rolledBack,
      rollbackStatus: record.rollbackStatus,
      recoveryRequired: record.recoveryRequired,
      summary: record.summary,
    }));
}

export function readRun(target = 'latest'): RunRecord | null {
  const filePath = runPathFor(target);
  return filePath ? readRunFile(filePath) : null;
}

function summarizeRunFiles(output: SWDApplyResult): RunFileSummary[] {
  const files = output.result.results.map((result) => ({
    path: result.action.path,
    operation: result.action.operation,
    status: result.status,
    detail: redactReceiptSecrets(result.detail),
  }));

  if (files.length > 0) return files;

  return output.rejected.map((rejected) => ({
    path: rejected.path,
    operation: rejected.operation,
    status: rejected.risk,
    detail: redactReceiptSecrets(rejected.reason),
  }));
}

function sanitizeSandbox(sandbox?: SandboxSummary): SandboxSummary | undefined {
  if (!sandbox) return undefined;
  return {
    ...sandbox,
    setupError: sandbox.setupError ? redactReceiptSecrets(sandbox.setupError) : undefined,
    checks: sandbox.checks.map((check) => ({
      ...check,
      outputTail: redactReceiptSecrets(check.outputTail),
    })),
  };
}

function createRunId(timestamp: string, output: SWDApplyResult, files: RunFileSummary[]): string {
  const stamp = timestamp.replace(/[-:.TZ]/g, '').slice(0, 14);
  const digest = createHash('sha256')
    .update(`${timestamp}\n${output.agent.id}\n${output.agent.model}\n${JSON.stringify(files)}\n${output.ok}`)
    .digest('hex')
    .slice(0, 10);
  return `run-${stamp}-${digest}`;
}

function runFiles(): string[] {
  const dir = getRunsDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function runPathFor(target: string): string | null {
  const files = runFiles();
  if (target === 'latest') return files[0] ?? null;

  const id = target.endsWith('.json') ? target.slice(0, -5) : target;
  const direct = join(getRunsDir(), `${id}.json`);
  if (existsSync(direct)) return direct;
  if (existsSync(target)) return target;
  return null;
}

function readRunFile(filePath: string): RunRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as RunRecord;
  } catch {
    return null;
  }
}
