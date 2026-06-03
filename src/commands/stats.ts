import { loadSessionMetrics, SessionMetric } from '../metrics.js';
import { c, hr, BANNER, theme } from '../utils.js';

interface StatsOptions {
  days?: string;
  json?: boolean;
}

export async function statsCommand(options: StatsOptions): Promise<void> {
  const allMetrics = loadSessionMetrics();
  const asJson = options.json === true;

  if (allMetrics.length === 0) {
    if (asJson) {
      console.log(JSON.stringify({ sessions: 0, totalCostUSD: 0, byCommand: {}, byProject: {} }, null, 2));
      return;
    }
    console.log(BANNER);
    console.log(`  ${c.dim}No metrics found yet. Start chatting to log some metrics!${c.reset}`);
    return;
  }

  // Filter by days if provided
  let metrics = allMetrics;
  if (options.days) {
    const days = parseInt(options.days, 10);
    if (!isNaN(days)) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      metrics = allMetrics.filter(m => new Date(m.timestamp) >= cutoff);
    }
  }

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTurns = 0;
  const costByCommand: Record<string, number> = {};
  const costByProject: Record<string, number> = {};

  for (const m of metrics) {
    totalCost += m.costUSD;
    totalInputTokens += m.inputTokens;
    totalOutputTokens += m.outputTokens;
    totalTurns += m.turns;

    costByCommand[m.command] = (costByCommand[m.command] || 0) + m.costUSD;
    costByProject[m.project] = (costByProject[m.project] || 0) + m.costUSD;
  }

  if (asJson) {
    console.log(JSON.stringify({
      windowDays: options.days ? parseInt(options.days, 10) : null,
      sessions: metrics.length,
      totalTurns,
      totalInputTokens,
      totalOutputTokens,
      totalCostUSD: Number(totalCost.toFixed(6)),
      byCommand: costByCommand,
      byProject: costByProject,
    }, null, 2));
    return;
  }

  console.log(BANNER);
  console.log(`  ${c.cyan}Budget Analytics & Cost Profiling${c.reset}`);
  if (options.days) {
    console.log(`  ${c.dim}Showing data for the last ${options.days} days${c.reset}`);
  } else {
    console.log(`  ${c.dim}Showing all-time data${c.reset}`);
  }
  console.log(hr());

  // Overall Stats
  console.log(`${c.bold}Overall Usage${c.reset}`);
  console.log(`  Total Sessions : ${theme.info}${metrics.length}${c.reset}`);
  console.log(`  Total Turns    : ${theme.info}${totalTurns}${c.reset}`);
  console.log(`  Input Tokens   : ${theme.info}${totalInputTokens.toLocaleString()}${c.reset}`);
  console.log(`  Output Tokens  : ${theme.info}${totalOutputTokens.toLocaleString()}${c.reset}`);
  console.log(`  Total Cost     : ${theme.warning}$${totalCost.toFixed(4)}${c.reset}`);
  console.log('');

  // Cost by Command
  console.log(`${c.bold}Cost by Command${c.reset}`);
  const sortedCommands = Object.entries(costByCommand).sort((a, b) => b[1] - a[1]);
  for (const [cmd, cost] of sortedCommands) {
    const percentage = totalCost > 0 ? ((cost / totalCost) * 100).toFixed(1) : '0.0';
    console.log(`  ${cmd.padEnd(14)} : ${theme.info}$${cost.toFixed(4)}${c.reset} ${theme.muted}(${percentage}%)${c.reset}`);
  }
  console.log('');

  // Cost by Project
  console.log(`${c.bold}Cost by Project${c.reset}`);
  const sortedProjects = Object.entries(costByProject).sort((a, b) => b[1] - a[1]);
  for (const [proj, cost] of sortedProjects) {
    const percentage = totalCost > 0 ? ((cost / totalCost) * 100).toFixed(1) : '0.0';
    console.log(`  ${proj.padEnd(14)} : ${theme.info}$${cost.toFixed(4)}${c.reset} ${theme.muted}(${percentage}%)${c.reset}`);
  }
  console.log(hr());
}
