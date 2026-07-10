import { listRuns, readRun, type RunRecord, type RunSummary } from '../runs.js';
import { c, error, heading, info, success, theme, warn } from '../utils.js';

interface RunsOptions {
  limit?: string;
  json?: boolean;
}

export async function runsCommand(
  action?: string,
  target?: string,
  options: RunsOptions = {},
): Promise<void> {
  const normalizedAction = (action ?? 'list').toLowerCase();

  if (normalizedAction === 'list') {
    printRunList(parseLimit(options.limit), options.json === true);
    return;
  }

  if (normalizedAction === 'latest') {
    printRun('latest', options.json === true);
    return;
  }

  if (normalizedAction === 'show') {
    printRun(target ?? 'latest', options.json === true);
    return;
  }

  warn(`Unknown runs action: ${normalizedAction}`);
  info('Usage: mythos runs | mythos runs show latest --json');
  process.exitCode = 1;
}

function printRunList(limit: number, asJson: boolean): void {
  const runs = listRuns(limit);
  if (asJson) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }

  console.log(heading('External Agent Runs'));
  if (runs.length === 0) {
    info('No run records found yet.');
    return;
  }

  for (const run of runs) {
    printRunSummary(run);
  }
}

function printRun(target: string, asJson: boolean): void {
  const run = readRun(target);
  if (!run) {
    error(`Run not found: ${target}`);
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }

  console.log(heading(`Run ${run.id}`));
  printRunHeader(run);
  console.log(`${c.bold}Files${c.reset}`);
  if (run.files.length === 0) {
    info('No file results were recorded.');
  } else {
    for (const file of run.files) {
      console.log(`  ${theme.info}${file.operation}${c.reset} ${file.path} ${c.dim}${file.status}${c.reset}`);
      if (file.detail) console.log(`     ${c.dim}${file.detail}${c.reset}`);
    }
  }

  if (run.sandbox?.ran) {
    console.log();
    console.log(`${c.bold}Checks${c.reset}`);
    for (const check of run.sandbox.checks) {
      const mark = check.passed ? `${theme.success}OK${c.reset}` : `${theme.error}FAIL${c.reset}`;
      console.log(`  ${mark} ${check.name} ${c.dim}${check.command}${c.reset}`);
    }
  }

  if (run.contract) {
    console.log();
    console.log(`${c.bold}Task Contract${c.reset}`);
    if (run.contract.ok) success('Contract passed.');
    else for (const err of run.contract.errors) error(err);
    if (run.contract.expectedOutputs.length > 0) {
      console.log(`  ${c.dim}expected outputs: ${run.contract.expectedOutputs.join(', ')}${c.reset}`);
    }
  }
}

function printRunSummary(run: RunSummary): void {
  const status = run.ok ? `${theme.success}PASS${c.reset}` : `${theme.error}FAIL${c.reset}`;
  const checked = run.checked ? 'checked' : 'not checked';
  console.log(
    `  ${status} ${c.bold}${run.id}${c.reset} ${c.dim}${formatDate(run.timestamp)}${c.reset} ` +
    `${theme.info}${run.approvedCount}/${run.actionCount}${c.reset} actions ${c.dim}${checked}${c.reset}`,
  );
  console.log(`     ${c.dim}agent: ${run.agent}/${run.model} | receipt: ${run.receiptId ?? 'none'}${c.reset}`);
  if (run.summary) console.log(`     ${c.dim}${run.summary}${c.reset}`);
}

function printRunHeader(run: RunRecord): void {
  console.log(`  ${c.dim}Time:${c.reset}      ${formatDate(run.timestamp)}`);
  console.log(`  ${c.dim}Status:${c.reset}    ${run.ok ? theme.success + 'passed' : theme.error + 'failed'}${c.reset}${formatRollbackSuffix(run.rollbackStatus, run.rolledBack)}`);
  console.log(`  ${c.dim}Mode:${c.reset}      ${run.mode}`);
  console.log(`  ${c.dim}Agent:${c.reset}     ${run.agent.id}/${run.agent.model}`);
  console.log(`  ${c.dim}Actions:${c.reset}   ${run.approvedCount}/${run.actionCount} approved`);
  console.log(`  ${c.dim}Receipt:${c.reset}   ${run.receipt?.id ?? 'none'}`);
  if (run.summary) console.log(`  ${c.dim}Summary:${c.reset}   ${run.summary}`);
  if (run.recoveryRequired) {
    console.log(`  ${c.dim}Recovery:${c.reset}  ${theme.warning}manual recovery required${c.reset}`);
  }
  if (run.errors.length > 0) {
    console.log(`  ${c.dim}Errors:${c.reset}`);
    for (const err of run.errors) console.log(`    ${theme.error}${err}${c.reset}`);
  }
}

function formatRollbackSuffix(status: RunRecord['rollbackStatus'], legacyRolledBack: boolean): string {
  switch (status) {
    case 'complete': return ` ${theme.warning}(rollback complete)${c.reset}`;
    case 'partial': return ` ${theme.error}(rollback partial)${c.reset}`;
    case 'failed': return ` ${theme.error}(rollback failed)${c.reset}`;
    case 'disabled': return ` ${theme.warning}(rollback disabled)${c.reset}`;
    default: return legacyRolledBack ? ` ${theme.warning}(rolled back)${c.reset}` : '';
  }
}

function formatDate(timestamp: string): string {
  return timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

function parseLimit(raw?: string): number {
  const parsed = parseInt(raw ?? '10', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.min(parsed, 100);
}
