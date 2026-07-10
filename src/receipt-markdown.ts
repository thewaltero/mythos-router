import type { SWDReceipt } from './receipts.js';

export function formatReceiptMarkdown(receipt: SWDReceipt): string {
  const provider = receipt.provider
    ? `${receipt.provider.providerId}/${receipt.provider.modelId}`
    : 'unknown';
  const usage = receipt.usage
    ? `${receipt.usage.totalTokens.toLocaleString()} tokens`
    : 'unknown';
  const cost = receipt.budget
    ? `~$${receipt.budget.estimatedCostUSD.toFixed(4)}`
    : 'unknown';
  const git = `${receipt.git?.branch ?? 'none'} @ ${receipt.git?.commit?.slice(0, 12) ?? 'none'}`;
  const skills = receipt.skills && receipt.skills.length > 0
    ? receipt.skills.map((skill) => `${skill.id}@${skill.version} (${skill.source})`).join(', ')
    : 'none';
  const test = receipt.test
    ? `${receipt.test.command} -> ${receipt.test.status}`
    : 'none';

  const lines: string[] = [
    '### Mythos SWD Receipt',
    '',
    '| Field | Value |',
    '|---|---|',
    `| Receipt | ${mdCode(receipt.id)} |`,
    `| Status | ${mdText(formatMarkdownStatus(receipt))} |`,
    `| Time | ${mdText(formatDate(receipt.timestamp))} |`,
    `| Summary | ${mdText(receipt.summary)} |`,
    `| Provider | ${mdCode(provider)} |`,
    `| Usage | ${mdText(`${usage} / ${cost}`)} |`,
    `| Git | ${mdCode(git)} |`,
    `| Skills | ${mdText(skills)} |`,
    `| Test | ${mdText(test)} |`,
    '',
    '#### Files',
    '',
    '| Status | Operation | Path | Detail | Expected |',
    '|---|---|---|---|---|',
  ];

  if (receipt.files.length === 0) {
    lines.push('| none | none | none | No file results were recorded. | none |');
  } else {
    for (const file of receipt.files) {
      const expected = file.expected?.sha256
        ? `${file.expectedSource} ${file.expected.sha256.slice(0, 12)}`
        : file.expectedSource;
      lines.push(
        `| ${mdText(file.status)} | ${mdText(file.operation)} | ${mdCode(file.path)} | ${mdText(truncate(file.detail, 160))} | ${mdText(expected)} |`,
      );
    }
  }

  const swdErrors = receipt.swd.errors ?? [];
  const rollbackErrors = receipt.swd.rollbackErrors ?? [];

  if (swdErrors.length > 0) {
    lines.push('', '#### SWD Errors', '');
    for (const err of swdErrors) {
      lines.push(`- ${mdText(err)}`);
    }
  }

  if (rollbackErrors.length > 0) {
    lines.push('', '#### Rollback Errors', '');
    for (const err of rollbackErrors) {
      lines.push(`- ${mdText(err)}`);
    }
  }

  lines.push(
    '',
    '#### Local Verification',
    '',
    `- Inspect: ${mdCode(`mythos receipts show ${receipt.id}`)}`,
    `- Verify drift: ${mdCode(`mythos receipts verify ${receipt.id}`)}`,
  );

  return `${lines.join('\n')}\n`;
}

function formatMarkdownStatus(receipt: SWDReceipt): string {
  const status = receipt.swd.success ? 'verified' : 'failed';
  switch (receipt.swd.rollbackStatus) {
    case 'complete': return `${status} (rollback complete)`;
    case 'partial': return `${status} (rollback partial; recovery required)`;
    case 'failed': return `${status} (rollback failed; recovery required)`;
    case 'disabled': return `${status} (rollback disabled; recovery required)`;
    default: return receipt.swd.rolledBack ? `${status} (rolled back)` : status;
  }
}

function formatDate(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function mdText(value: string): string {
  const text = value
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .trim();
  return text.length > 0 ? text : 'none';
}

function mdCode(value: string): string {
  // Escape backslashes first so input cannot neutralize the markdown escapes below.
  const text = value
    .replace(/\r?\n/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\|/g, '\\|')
    .trim();
  return text.length > 0 ? `\`${text}\`` : '`none`';
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}
