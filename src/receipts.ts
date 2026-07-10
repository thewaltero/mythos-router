import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import type { SWDRollbackStatus, SWDRunResult } from './swd.js';

export const RECEIPTS_DIR = '.mythos/receipts';


export const RECEIPT_OUTPUT_TAIL_MAX_CHARS = 500;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi,
];

const SECRET_ASSIGNMENT_PATTERN = /\b([A-Z][A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*=\s*)(["']?)([^\s"'`]+)(\2)/gi;

export function redactReceiptSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  return redacted.replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, quote: string, _value: string, closingQuote: string) => {
    return `${prefix}${quote}[REDACTED_SECRET]${closingQuote}`;
  });
}

export function sanitizeReceiptOutputTail(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) return '';
  return redactReceiptSecrets(trimmed.slice(-RECEIPT_OUTPUT_TAIL_MAX_CHARS));
}

export interface ReceiptProvider {
  providerId: string;
  modelId: string;
  fallbackTriggered?: boolean;
  incomplete?: boolean;
  latencyMs?: number;
}

export interface ReceiptUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ReceiptBudget {
  sessionInputTokens: number;
  sessionOutputTokens: number;
  sessionTotalTokens: number;
  sessionTurns: number;
  estimatedCostUSD: number;
}

export interface ReceiptSkill {
  id: string;
  name: string;
  version: string;
  source: 'project' | 'global' | 'path';
  path?: string;
}

export type ReceiptTestStatus = string;

export interface ReceiptTestResult {
  command: string;
  passed: boolean;
  attempts: number;
  status: ReceiptTestStatus;
  outputTail?: string;
}

export interface ReceiptSnapshot {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  sha256: string;
}

export interface ReceiptFileResult {
  path: string;
  operation: string;
  intent: string;
  status: string;
  detail: string;
  before?: ReceiptSnapshot;
  after?: ReceiptSnapshot;
  expected?: ReceiptSnapshot;
  expectedSource: 'before' | 'after' | 'none';
}

export interface ReceiptFileVerification {
  path: string;
  status: 'ok' | 'drifted' | 'missing' | 'unknown';
  detail: string;
  expected?: ReceiptSnapshot;
  actual?: ReceiptSnapshot;
}

export interface ReceiptVerification {
  ok: boolean;
  files: ReceiptFileVerification[];
}

export interface ReceiptSummary {
  id: string;
  timestamp: string;
  summary: string;
  fileCount: number;
  success: boolean;
  rolledBack: boolean;
  rollbackStatus?: SWDRollbackStatus;
  recoveryRequired?: boolean;
  provider?: string;
  model?: string;
  branch?: string;
  skills?: string[];
}

export interface SWDReceiptInput {
  request: string;
  summary: string;
  result: SWDRunResult;
  provider?: ReceiptProvider;
  usage?: Omit<ReceiptUsage, 'totalTokens'> | ReceiptUsage;
  budget?: ReceiptBudget;
  skills?: ReceiptSkill[];
  test?: ReceiptTestResult;
  git?: {
    branch?: string;
    commit?: string;
  };
}

export interface SWDReceipt {
  id: string;
  version: 1;
  timestamp: string;
  request: string;
  summary: string;
  fileCount: number;
  files: ReceiptFileResult[];
  swd: {
    success: boolean;
    rolledBack: boolean;
    rollbackStatus?: SWDRollbackStatus;
    recoveryRequired?: boolean;
    errors: string[];
    rollbackErrors: string[];
  };
  provider?: ReceiptProvider;
  usage?: ReceiptUsage;
  budget?: ReceiptBudget;
  skills?: ReceiptSkill[];
  git?: {
    branch?: string;
    commit?: string;
  };
  test?: ReceiptTestResult;
  /**
   * Append-only hash-chain linkage. `seq` is the receipt's position in the
   * chain (genesis = 0); `prevHash` is the integrity hash of the receipt at
   * `seq - 1` (empty string for genesis). Both fields are part of the hashed
   * payload, so editing either one breaks `integrity.sha256` — which is what
   * makes deletion, reordering, and forgery detectable rather than just
   * in-place edits.
   */
  chain?: ReceiptChain;
  integrity?: {
    sha256: string;
  };
}

export interface ReceiptChain {
  seq: number;
  prevHash: string;
}

/** Pointer to the chain tip, stored alongside receipts so a deleted/replaced
 *  latest receipt is also detectable. Not itself a receipt. */
export interface ChainHead {
  id: string;
  seq: number;
  hash: string;
  updatedAt: string;
}

export interface ChainVerification {
  /** True when at least one chained receipt exists on disk. */
  present: boolean;
  /** True when the chain is intact (no edits, gaps, or broken links). */
  ok: boolean;
  /** Number of chained receipts inspected. */
  length: number;
  /** seq at which a break was detected, if any. */
  brokenAt?: number;
  /** Human-readable explanation of the break, if any. */
  reason?: string;
  /** Whether the HEAD pointer matches the latest receipt (undefined if no HEAD). */
  headMatches?: boolean;
}

/** prevHash value for the genesis receipt (seq 0). */
export const GENESIS_PREV_HASH = '';

/** Filename of the chain-tip pointer inside the receipts dir. */
export const CHAIN_HEAD_FILE = 'chain-head.json';

type SnapshotLike = {
  path: string;
  exists: boolean;
  size: number;
  mtime: number;
  hash: string;
};

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function toNativePath(filePath: string): string {
  return filePath.split(/[\\/]/g).join(path.sep);
}

function toPortablePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function realPathForComparison(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    const parentDir = path.dirname(filePath);
    try {
      return path.join(realpathSync(parentDir), path.basename(filePath));
    } catch {
      return filePath;
    }
  }
}

function toReceiptPath(rootDir: string, filePath: string): string {
  if (!filePath) return filePath;

  const nativePath = toNativePath(filePath);
  const absoluteRoot = path.resolve(rootDir);
  const absoluteFile = path.isAbsolute(nativePath)
    ? path.normalize(nativePath)
    : path.resolve(absoluteRoot, nativePath);
  const canonicalRoot = realPathForComparison(absoluteRoot);
  const canonicalFile = realPathForComparison(absoluteFile);
  const relativePath = path.relative(canonicalRoot, canonicalFile);

  if (relativePath && !path.isAbsolute(relativePath)) {
    return toPortablePath(relativePath);
  }

  return toPortablePath(filePath);
}

function toProjectReceiptPath(rootDir: string, filePath: string): string | undefined {
  if (!filePath) return undefined;

  const nativePath = toNativePath(filePath);
  const absoluteRoot = path.resolve(rootDir);
  const absoluteFile = path.isAbsolute(nativePath)
    ? path.normalize(nativePath)
    : path.resolve(absoluteRoot, nativePath);
  const canonicalRoot = realPathForComparison(absoluteRoot);
  const canonicalFile = realPathForComparison(absoluteFile);
  const relativePath = path.relative(canonicalRoot, canonicalFile);

  const escapesProject = relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
  if (!relativePath || escapesProject || path.isAbsolute(relativePath)) {
    return undefined;
  }

  return toPortablePath(relativePath);
}

function resolveReceiptPath(rootDir: string, filePath: string): string {
  const nativePath = toNativePath(filePath);
  return path.isAbsolute(nativePath) ? nativePath : path.resolve(rootDir, nativePath);
}

function getCurrentRoot(): string {
  return process.cwd();
}

export function getReceiptsDir(rootDir = getCurrentRoot()): string {
  return path.join(rootDir, RECEIPTS_DIR);
}

function ensureReceiptsDir(): string {
  const dir = getReceiptsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeSnapshot(rootDir: string, snapshot?: SnapshotLike): ReceiptSnapshot | undefined {
  if (!snapshot) return undefined;

  return {
    path: toReceiptPath(rootDir, snapshot.path),
    exists: snapshot.exists,
    size: snapshot.size,
    mtime: snapshot.mtime,
    sha256: snapshot.hash,
  };
}

function expectedSnapshot(file: ReceiptFileResult): { expected?: ReceiptSnapshot; source: 'before' | 'after' | 'none' } {
  if (file.operation === 'DELETE') {
    return { expected: file.after, source: file.after ? 'after' : 'none' };
  }

  if (file.after) return { expected: file.after, source: 'after' };
  if (file.before) return { expected: file.before, source: 'before' };
  return { source: 'none' };
}

function normalizeFileResult(rootDir: string, result: SWDRunResult['results'][number]): ReceiptFileResult {
  const file: ReceiptFileResult = {
    path: toReceiptPath(rootDir, result.action.path),
    operation: result.action.operation,
    intent: result.action.intent,
    status: result.status,
    detail: redactReceiptSecrets(result.detail),
    before: normalizeSnapshot(rootDir, result.before),
    after: normalizeSnapshot(rootDir, result.after),
    expectedSource: 'none',
  };
  const expected = expectedSnapshot(file);
  file.expected = expected.expected;
  file.expectedSource = expected.source;
  return file;
}

function normalizeReceiptSkill(rootDir: string, skill: ReceiptSkill): ReceiptSkill {
  const projectPath = skill.path ? toProjectReceiptPath(rootDir, skill.path) : undefined;
  const normalized: ReceiptSkill = {
    id: skill.id,
    name: skill.name,
    version: skill.version,
    source: skill.source,
  };
  if (projectPath) normalized.path = projectPath;
  return normalized;
}

function receiptPayload(receipt: SWDReceipt): Omit<SWDReceipt, 'integrity'> {
  const { integrity: _integrity, ...payload } = receipt;
  return payload;
}

function integrityHash(receipt: SWDReceipt): string {
  return sha256(JSON.stringify(receiptPayload(receipt)));
}

function withIntegrity(receipt: Omit<SWDReceipt, 'integrity'>): SWDReceipt {
  const integrity = { sha256: '' };
  const next: SWDReceipt = {
    ...receipt,
    integrity,
  };
  integrity.sha256 = integrityHash(next);
  return next;
}

function createReceiptId(timestamp: string, request: string, files: ReceiptFileResult[]): string {
  const stamp = timestamp.replace(/[-:.TZ]/g, '').slice(0, 14);
  const digest = sha256(`${timestamp}\n${request}\n${JSON.stringify(files)}`).slice(0, 10);
  return `swd-${stamp}-${digest}`;
}

function normalizeUsage(usage?: SWDReceiptInput['usage']): ReceiptUsage | undefined {
  if (!usage) return undefined;
  const totalTokens = 'totalTokens' in usage
    ? usage.totalTokens
    : usage.inputTokens + usage.outputTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
  };
}

export function createSWDReceipt(input: SWDReceiptInput): SWDReceipt {
  const rootDir = getCurrentRoot();
  const timestamp = new Date().toISOString();
  const files = input.result.results.map((result) => normalizeFileResult(rootDir, result));
  const safeRequest = redactReceiptSecrets(input.request);
  const safeSummary = redactReceiptSecrets(input.summary);
  const base: Omit<SWDReceipt, 'integrity'> = {
    id: createReceiptId(timestamp, safeRequest, files),
    version: 1,
    timestamp,
    request: safeRequest,
    summary: safeSummary,
    fileCount: files.length,
    files,
    swd: {
      success: input.result.success,
      rolledBack: input.result.rolledBack,
      rollbackStatus: input.result.rollbackStatus,
      recoveryRequired: input.result.recoveryRequired,
      errors: input.result.errors.map(redactReceiptSecrets),
      rollbackErrors: input.result.rollbackErrors.map(redactReceiptSecrets),
    },
  };

  if (input.provider) base.provider = input.provider;
  const usage = normalizeUsage(input.usage);
  if (usage) base.usage = usage;
  if (input.budget) base.budget = input.budget;
  if (input.skills && input.skills.length > 0) {
    base.skills = input.skills.map((skill) => normalizeReceiptSkill(rootDir, skill));
  }
  if (input.git) base.git = input.git;
  if (input.test) base.test = input.test;

  return withIntegrity(base);
}

export function saveSWDReceipt(receipt: SWDReceipt, overwrite = true): string {
  const rootDir = getCurrentRoot();
  const dir = ensureReceiptsDir();
  const filePath = path.join(dir, `${receipt.id}.json`);
  const alreadyExists = existsSync(filePath);

  if (!overwrite && alreadyExists) {
    return filePath;
  }

  // Determine chain linkage.
  //  - New receipt: link it to the current tip (genesis if none) and advance HEAD.
  //  - Re-save of an existing receipt: preserve its stored chain and leave HEAD
  //    alone, so an idempotent rewrite never re-sequences or relinks the chain.
  let chain = receipt.chain;
  let advanceHead = false;
  if (alreadyExists) {
    const stored = readReceiptFile(filePath);
    chain = stored?.chain ?? receipt.chain;
  } else if (!chain) {
    const head = readChainHead(dir);
    chain = {
      seq: head ? head.seq + 1 : 0,
      prevHash: head ? head.hash : GENESIS_PREV_HASH,
    };
    advanceHead = true;
  }

  const payload: Omit<SWDReceipt, 'integrity'> = {
    ...receiptPayload(receipt),
    files: receipt.files.map((file) => normalizeStoredFile(rootDir, file)),
    skills: receipt.skills?.map((skill) => normalizeReceiptSkill(rootDir, skill)),
  };
  if (chain) payload.chain = chain;

  const normalized = withIntegrity(payload);
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');

  if (advanceHead && chain && normalized.integrity) {
    writeChainHead(dir, {
      id: normalized.id,
      seq: chain.seq,
      hash: normalized.integrity.sha256,
      updatedAt: new Date().toISOString(),
    });
  }

  return filePath;
}

function normalizeStoredFile(rootDir: string, file: ReceiptFileResult): ReceiptFileResult {
  const normalized: ReceiptFileResult = {
    ...file,
    path: toReceiptPath(rootDir, file.path),
    before: normalizeStoredSnapshot(rootDir, file.before),
    after: normalizeStoredSnapshot(rootDir, file.after),
    expected: normalizeStoredSnapshot(rootDir, file.expected),
  };
  return normalized;
}

function normalizeStoredSnapshot(rootDir: string, snapshot?: ReceiptSnapshot): ReceiptSnapshot | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    path: toReceiptPath(rootDir, snapshot.path),
  };
}

function receiptFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    // Receipt ids are always `swd-<stamp>-<digest>`, so this naturally excludes
    // the chain-head pointer and any other JSON that isn't a receipt.
    .filter((entry) => entry.startsWith('swd-') && entry.endsWith('.json'))
    .map((entry) => path.join(dir, entry))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function receiptFiles(): string[] {
  return receiptFilesIn(getReceiptsDir());
}

function chainHeadPath(dir: string): string {
  return path.join(dir, CHAIN_HEAD_FILE);
}

function readChainHead(dir: string): ChainHead | null {
  const filePath = chainHeadPath(dir);
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as ChainHead;
    if (typeof parsed?.seq === 'number' && typeof parsed?.hash === 'string' && typeof parsed?.id === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeChainHead(dir: string, head: ChainHead): void {
  writeFileSync(chainHeadPath(dir), `${JSON.stringify(head, null, 2)}\n`, 'utf-8');
}

function readReceiptFile(filePath: string): SWDReceipt | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as SWDReceipt;
  } catch {
    return null;
  }
}

function isWithinReceiptsDir(dir: string, candidate: string): boolean {
  const realDir = realPathForComparison(dir);
  const realCandidate = realPathForComparison(candidate);
  const rel = path.relative(realDir, realCandidate);
  // Must resolve to a real file *inside* the receipts dir: non-empty, not a
  // parent-escape, and not an absolute path (which would mean a different root).
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function receiptPathFor(target: string): string | null {
  const files = receiptFiles();
  if (target === 'latest') return files[0] ?? null;

  const dir = getReceiptsDir();
  const id = target.endsWith('.json') ? target.slice(0, -5) : target;

  // Build candidates, then require each to resolve *inside* the receipts dir.
  // This blocks both `..` traversal smuggled into an id and arbitrary absolute
  // paths pointing elsewhere on disk (receipts are local artifacts by design).
  const candidates: string[] = [path.resolve(dir, `${toNativePath(id)}.json`)];
  const nativeTarget = toNativePath(target);
  if (path.isAbsolute(nativeTarget)) {
    candidates.unshift(path.normalize(nativeTarget));
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (!isWithinReceiptsDir(dir, candidate)) continue;
    return candidate;
  }

  return null;
}

export function readReceipt(target = 'latest'): SWDReceipt | null {
  const filePath = receiptPathFor(target);
  return filePath ? readReceiptFile(filePath) : null;
}

export function listReceipts(limit = 10): ReceiptSummary[] {
  return receiptFiles()
    .slice(0, limit)
    .map((filePath) => readReceiptFile(filePath))
    .filter((receipt): receipt is SWDReceipt => receipt !== null)
    .map((receipt) => ({
      id: receipt.id,
      timestamp: receipt.timestamp,
      summary: receipt.summary,
      fileCount: receipt.fileCount,
      success: receipt.swd.success,
      rolledBack: receipt.swd.rolledBack,
      rollbackStatus: receipt.swd.rollbackStatus,
      recoveryRequired: receipt.swd.recoveryRequired,
      provider: receipt.provider?.providerId,
      model: receipt.provider?.modelId,
      branch: receipt.git?.branch,
      skills: receipt.skills?.map((skill) => `${skill.id}@${skill.version}`),
    }));
}

/**
 * Read the most recent receipts as full records (newest first), bounded by
 * `limit`. Unlike `listReceipts`, this returns the complete file-action detail,
 * which callers such as skill-learning need to inspect verification outcomes.
 */
export function readReceipts(limit = 50): SWDReceipt[] {
  return receiptFiles()
    .slice(0, limit)
    .map((filePath) => readReceiptFile(filePath))
    .filter((receipt): receipt is SWDReceipt => receipt !== null);
}

function snapshotCurrentFile(rootDir: string, filePath: string): ReceiptSnapshot {
  const absolutePath = resolveReceiptPath(rootDir, filePath);
  if (!existsSync(absolutePath)) {
    return {
      path: filePath,
      exists: false,
      size: 0,
      mtime: 0,
      sha256: '',
    };
  }

  const stat = statSync(absolutePath);
  const content = readFileSync(absolutePath);
  return {
    path: filePath,
    exists: true,
    size: stat.size,
    mtime: stat.mtimeMs,
    sha256: sha256(content),
  };
}

export function verifyReceipt(receipt: SWDReceipt): ReceiptVerification {
  const rootDir = getCurrentRoot();
  const files = receipt.files.map((file): ReceiptFileVerification => {
    const expected = file.expected;

    if (!expected) {
      return {
        path: file.path,
        status: 'unknown',
        detail: 'No expected final snapshot was recorded.',
      };
    }

    const actual = snapshotCurrentFile(rootDir, file.path);
    if (expected.exists && !actual.exists) {
      return {
        path: file.path,
        status: 'missing',
        detail: 'Expected file is missing.',
        expected,
        actual,
      };
    }

    if (!expected.exists && actual.exists) {
      return {
        path: file.path,
        status: 'drifted',
        detail: 'Expected file to be absent, but it exists.',
        expected,
        actual,
      };
    }

    if (expected.exists && actual.exists && expected.sha256 !== actual.sha256) {
      return {
        path: file.path,
        status: 'drifted',
        detail: 'File hash differs from the receipt snapshot.',
        expected,
        actual,
      };
    }

    return {
      path: file.path,
      status: 'ok',
      detail: 'Current file matches the receipt snapshot.',
      expected,
      actual,
    };
  });

  return {
    ok: files.every((file) => file.status === 'ok'),
    files,
  };
}

export function verifyReceiptIntegrity(receipt: SWDReceipt): boolean {
  return receipt.integrity?.sha256 === integrityHash(receipt);
}

/**
 * Verify the append-only receipt chain in `dir`.
 *
 * Per-receipt `integrity.sha256` (which now covers the `chain` fields) catches
 * in-place edits. On top of that, the chain catches the things a self-hash
 * cannot:
 *   - **deletion / insertion** → a gap in the contiguous `seq` run;
 *   - **reordering / forgery**  → a `prevHash` that doesn't match the previous
 *     receipt's integrity hash;
 *   - **tip replacement**       → a HEAD pointer that doesn't match the latest
 *     receipt.
 *
 * Receipts written before chaining was introduced have no `chain` field and are
 * ignored, so upgrading an existing repo simply starts a fresh chain rather than
 * reporting every legacy receipt as broken.
 */
export function verifyReceiptChain(dir = getReceiptsDir()): ChainVerification {
  const chained = receiptFilesIn(dir)
    .map((filePath) => readReceiptFile(filePath))
    .filter((receipt): receipt is SWDReceipt => receipt !== null)
    .filter((receipt) => receipt.chain !== undefined)
    .sort((a, b) => a.chain!.seq - b.chain!.seq);

  if (chained.length === 0) {
    return { present: false, ok: true, length: 0 };
  }

  const broken = (brokenAt: number, reason: string, headMatches?: boolean): ChainVerification => ({
    present: true,
    ok: false,
    length: chained.length,
    brokenAt,
    reason,
    headMatches,
  });

  // The chain must begin at genesis; a non-zero first seq means the earliest
  // receipts were removed.
  const first = chained[0].chain!;
  if (first.seq !== 0) {
    return broken(0, `The earliest receipts are missing — the chain starts at seq ${first.seq} instead of genesis (seq 0).`);
  }
  if (first.prevHash !== GENESIS_PREV_HASH) {
    return broken(0, 'The genesis receipt has a non-empty prevHash, so it was not the true start of the chain.');
  }

  let prevHash: string | null = null;
  let expectedSeq = 0;
  for (const receipt of chained) {
    const seq = receipt.chain!.seq;

    if (!verifyReceiptIntegrity(receipt)) {
      return broken(seq, `Receipt ${receipt.id} (seq ${seq}) was edited after creation — its integrity hash no longer matches.`);
    }
    if (seq !== expectedSeq) {
      return broken(expectedSeq, `Chain gap at seq ${expectedSeq}: a receipt was deleted, reordered, or inserted.`);
    }
    if (prevHash !== null && receipt.chain!.prevHash !== prevHash) {
      return broken(seq, `Broken link at seq ${seq}: prevHash does not match the previous receipt's hash.`);
    }

    prevHash = receipt.integrity!.sha256;
    expectedSeq++;
  }

  const head = readChainHead(dir);
  const tip = chained[chained.length - 1];
  const headMatches = head !== null
    && head.id === tip.id
    && head.seq === tip.chain!.seq
    && head.hash === tip.integrity!.sha256;

  if (head !== null && !headMatches) {
    return broken(
      tip.chain!.seq,
      'The chain HEAD pointer does not match the latest receipt — the most recent receipt may have been deleted or replaced.',
      headMatches,
    );
  }

  return { present: true, ok: true, length: chained.length, headMatches };
}

export const createReceipt = createSWDReceipt;
export const saveReceipt = saveSWDReceipt;
