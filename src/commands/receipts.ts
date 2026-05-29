import {
  listReceipts,
  readReceipt,
  verifyReceipt,
  verifyReceiptIntegrity,
  type ReceiptSummary,
  type SWDReceipt,
} from '../receipts.js';
import { formatReceiptMarkdown } from '../receipt-markdown.js';
import { c, error, heading, hr, info, success, theme, warn } from '../utils.js';

interface ReceiptsOptions {
  limit?: string;
  json?: boolean;
  format?: string;
  markdown?: boolean;
  pr?: boolean;
}

export async function receiptsCommand(
  action?: string,
  target?: string,
  options: ReceiptsOptions = {},
): Promise<void> {
  const normalizedAction = (action ?? 'list').toLowerCase();
  if (options.format && options.format !== 'json' && options.format !== 'markdown') {
    error('Receipt format must be json or markdown.');
    process.exitCode = 1;
    return;
  }

  if (normalizedAction === 'list') {
    printReceiptList(parseLimit(options.limit), wantsJson(options));
    return;
  }

  if (normalizedAction === 'latest') {
    printReceipt('latest', options);
    return;
  }

  if (normalizedAction === 'show') {
    printReceipt(target ?? 'latest', options);
    return;
  }

  if (normalizedAction === 'verify') {
    printReceiptVerification(target ?? 'latest', wantsJson(options));
    return;
  }

  warn(`Unknown receipts action: ${normalizedAction}`);
  info('Usage: mythos receipts | mythos receipts show latest [--markdown|--format markdown] | mythos receipts verify latest');
}

function printReceiptList(limit: number, asJson?: boolean): void {
  const receipts = listReceipts(limit);

  if (asJson) {
    console.log(JSON.stringify(receipts, null, 2));
    return;
  }

  console.log(heading('SWD Receipts'));
  if (receipts.length === 0) {
    info('No SWD receipts found yet.');
    return;
  }

  for (const receipt of receipts) {
    const status = formatStatus(receipt);
    const provider = receipt.provider ? `${receipt.provider}/${receipt.model ?? 'unknown'}` : 'unknown';
    console.log(
      `  ${status} ${c.bold}${receipt.id}${c.reset} ${theme.muted}${formatDate(receipt.timestamp)}${c.reset} ` +
      `${theme.info}${receipt.fileCount}${theme.muted} file(s)${c.reset}`,
    );
    console.log(`     ${c.dim}${receipt.summary}${c.reset}`);
    console.log(`     ${c.dim}provider: ${provider} | branch: ${receipt.branch ?? 'none'}${c.reset}`);
    if (receipt.skills && receipt.skills.length > 0) {
      console.log(`     ${c.dim}skills: ${receipt.skills.join(', ')}${c.reset}`);
    }
  }
}

function printReceipt(target: string, options: ReceiptsOptions = {}): void {
  const receipt = readReceipt(target);
  if (!receipt) {
    error(`Receipt not found: ${target}`);
    return;
  }

  if (wantsJson(options)) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }

  if (wantsMarkdown(options)) {
    console.log(formatReceiptMarkdown(receipt));
    return;
  }

  console.log(heading(`SWD Receipt ${receipt.id}`));
  printReceiptHeader(receipt);
  console.log(hr());
  console.log(`${c.bold}Files${c.reset}`);

  for (const file of receipt.files) {
    const icon = file.status === 'verified' || file.status === 'noop'
      ? `${theme.success}OK${c.reset}`
      : `${theme.warning}${file.status.toUpperCase()}${c.reset}`;
    const expectedHash = file.expected?.sha256 ? file.expected.sha256.slice(0, 12) : 'none';
    console.log(`  ${icon} ${c.cyan}${file.operation}${c.reset} ${file.path}`);
    console.log(`     ${c.dim}${file.detail}${c.reset}`);
    console.log(`     ${c.dim}expected: ${file.expectedSource} ${expectedHash}${c.reset}`);
  }
}

function printReceiptVerification(target: string, asJson?: boolean): void {
  const receipt = readReceipt(target);
  if (!receipt) {
    error(`Receipt not found: ${target}`);
    return;
  }

  const verification = verifyReceipt(receipt);
  const integrityOk = verifyReceiptIntegrity(receipt);

  if (asJson) {
    console.log(JSON.stringify({ ...verification, integrityOk }, null, 2));
    return;
  }

  console.log(heading(`Verify Receipt ${receipt.id}`));
  printReceiptHeader(receipt);
  console.log(hr());

  if (integrityOk) {
    success('Receipt integrity hash matches.');
  } else {
    warn('Receipt integrity hash does not match. The receipt file may have been edited.');
  }

  for (const file of verification.files) {
    if (file.status === 'ok') {
      success(`${file.path} - ${file.detail}`);
    } else if (file.status === 'unknown') {
      warn(`${file.path} - ${file.detail}`);
    } else {
      error(`${file.path} - ${file.detail}`);
    }
  }

  console.log();
  if (verification.ok && integrityOk) {
    success('Receipt verification passed.');
  } else {
    warn('Receipt verification found drift or integrity issues.');
  }
}

function printReceiptHeader(receipt: SWDReceipt): void {
  const provider = receipt.provider
    ? `${receipt.provider.providerId}/${receipt.provider.modelId}`
    : 'unknown';
  const tokens = receipt.usage
    ? `${receipt.usage.totalTokens.toLocaleString()} tokens`
    : 'unknown';
  const cost = receipt.budget
    ? `~$${receipt.budget.estimatedCostUSD.toFixed(4)} session`
    : 'unknown';

  console.log(`  ${c.dim}Time:${c.reset}     ${formatDate(receipt.timestamp)}`);
  console.log(`  ${c.dim}Status:${c.reset}   ${receipt.swd.success ? theme.success + 'verified' : theme.warning + 'issues'}${c.reset}${receipt.swd.rolledBack ? ` ${theme.warning}(rolled back)${c.reset}` : ''}`);
  console.log(`  ${c.dim}Summary:${c.reset}  ${receipt.summary}`);
  console.log(`  ${c.dim}Provider:${c.reset} ${provider}`);
  console.log(`  ${c.dim}Usage:${c.reset}    ${tokens} | ${cost}`);
  console.log(`  ${c.dim}Git:${c.reset}      ${receipt.git?.branch ?? 'none'} @ ${receipt.git?.commit?.slice(0, 12) ?? 'none'}`);
  if (receipt.skills && receipt.skills.length > 0) {
    const skills = receipt.skills.map((skill) => `${skill.id}@${skill.version} (${skill.source})`).join(', ');
    console.log(`  ${c.dim}Skills:${c.reset}   ${skills}`);
  }
  if (receipt.test) {
    console.log(`  ${c.dim}Test:${c.reset}     ${receipt.test.command} -> ${receipt.test.status}`);
  }
}

function formatStatus(receipt: ReceiptSummary): string {
  if (receipt.rolledBack) return `${theme.warning}ROLLBACK${c.reset}`;
  return receipt.success ? `${theme.success}VERIFIED${c.reset}` : `${theme.warning}ISSUES${c.reset}`;
}

function wantsJson(options: ReceiptsOptions): boolean {
  return options.json === true || options.format === 'json';
}

function wantsMarkdown(options: ReceiptsOptions): boolean {
  return options.markdown === true || options.pr === true || options.format === 'markdown';
}

function formatDate(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function parseLimit(raw?: string): number {
  const parsed = parseInt(raw ?? '10', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 100);
}
