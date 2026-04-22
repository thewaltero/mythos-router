import { loadSessionMetrics, SessionMetric } from '../metrics.js';
import { c, hr, BANNER } from '../utils.js';

interface StatsOptions {
  days?: string;
}

export async function statsCommand(options: StatsOptions): Promise<void> {
  const allMetrics = loadSessionMetrics();
  
  if (allMetrics.length === 0) {
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
  console.log(`  Total Sessions : ${metrics.length}`);
  console.log(`  Total Turns    : ${totalTurns}`);
  console.log(`  Input Tokens   : ${totalInputTokens.toLocaleString()}`);
  console.log(`  Output Tokens  : ${totalOutputTokens.toLocaleString()}`);
  console.log(`  Total Cost     : ${c.green}$${totalCost.toFixed(4)}${c.reset}`);
  console.log('');

  // Cost by Command
  console.log(`${c.bold}Cost by Command${c.reset}`);
  const sortedCommands = Object.entries(costByCommand).sort((a, b) => b[1] - a[1]);
  for (const [cmd, cost] of sortedCommands) {
    const percentage = totalCost > 0 ? ((cost / totalCost) * 100).toFixed(1) : '0.0';
    console.log(`  ${cmd.padEnd(14)} : ${c.green}$${cost.toFixed(4)}${c.reset} ${c.dim}(${percentage}%)${c.reset}`);
  }
  console.log('');

  // Cost by Project
  console.log(`${c.bold}Cost by Project${c.reset}`);
  const sortedProjects = Object.entries(costByProject).sort((a, b) => b[1] - a[1]);
  for (const [proj, cost] of sortedProjects) {
    const percentage = totalCost > 0 ? ((cost / totalCost) * 100).toFixed(1) : '0.0';
    console.log(`  ${proj.padEnd(14)} : ${c.green}$${cost.toFixed(4)}${c.reset} ${c.dim}(${percentage}%)${c.reset}`);
  }
  console.log(hr());
}
