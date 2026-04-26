import { TelemetryStore, ProviderState } from '../providers/telemetry.js';
import { c, hr, BANNER } from '../utils.js';

interface ProvidersOptions {
  watch?: boolean;
  verbose?: boolean;
}

function calculateScore(m: ProviderState): number {
  let latencyWeight = 0.05;
  let successWeight = 100;
  return (m.successRate * successWeight) - (m.avgLatency * latencyWeight);
}

function getConfidence(totalCalls: number): string {
  if (totalCalls < 20) return `${c.red}Low${c.reset}`;
  if (totalCalls <= 100) return `${c.yellow}Medium${c.reset}`;
  return `${c.green}High${c.reset}`;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[\d+m/g, '');
}

function padAnsi(str: string, len: number): string {
  const visualLength = stripAnsi(str).length;
  if (visualLength < len) {
    return str + ' '.repeat(len - visualLength);
  }
  return str;
}

export async function providersCommand(options: ProvidersOptions): Promise<void> {
  const telemetry = TelemetryStore.getInstance();
  
  const render = () => {
    // Clear screen if watch mode
    if (options.watch) {
      console.clear();
    }
    
    console.log(BANNER);
    console.log(`  ${c.cyan}Provider Health & Orchestration State${c.reset}`);
    console.log(hr());
    
    const metrics = telemetry.getProviderMetrics();
    
    if (metrics.length === 0) {
      console.log(`  ${c.dim}No provider telemetry found yet. Run a chat session to collect metrics.${c.reset}`);
      if (!options.watch) return;
    } else {
      // Sort by score
      metrics.sort((a, b) => calculateScore(b) - calculateScore(a));
      const leader = metrics[0];
      const leaderScore = calculateScore(leader).toFixed(1);
      const confidence = getConfidence(leader.totalCalls);

      console.log(`  🏆 ${c.bold}Leader:${c.reset} ${c.cyan}${leader.id}${c.reset} (Score: ${leaderScore}) [${confidence} Confidence]`);
      console.log(hr());

      // Table Header
      const hProvider = padAnsi(`${c.bold}Provider${c.reset}`, 18);
      const hStatus   = padAnsi(`${c.bold}Status${c.reset}`, 35);
      const hLatency  = padAnsi(`${c.bold}EMA Latency${c.reset}`, 18);
      const hSuccess  = `${c.bold}Success Rate${c.reset}`;
      console.log(`  ${hProvider}| ${hStatus}| ${hLatency}| ${hSuccess}`);
      console.log(`  ` + '-'.repeat(85));

      const now = Date.now();
      for (const m of metrics) {
        // Status formatting
        let statusStr = `${c.green}🟢 Healthy${c.reset}`;
        if (m.degradedUntil > now) {
          const resetDate = new Date(m.degradedUntil);
          const timeStr = `${resetDate.getHours()}:${resetDate.getMinutes().toString().padStart(2, '0')}`;
          statusStr = `${c.yellow}🟡 Degraded${c.reset} ${c.dim}(until ~${timeStr})${c.reset}`;
        } else if (m.successRate < 0.85) {
          statusStr = `${c.yellow}🟡 Degraded${c.reset} ${c.dim}(Low Success Rate)${c.reset}`;
        }

        // Latency with trend
        const latDiff = m.prevAvgLatency ? (m.avgLatency - m.prevAvgLatency) / m.prevAvgLatency : 0;
        let latArrow = '';
        if (latDiff > 0.05) latArrow = ` ${c.red}↑${c.reset}`;
        else if (latDiff < -0.05) latArrow = ` ${c.green}↓${c.reset}`;
        const latStr = `${m.avgLatency.toFixed(0)}ms${latArrow}`;

        // Success Rate with trend
        const srDiff = m.successRate - m.prevSuccessRate;
        let srArrow = '';
        if (srDiff > 0.02) srArrow = ` ${c.green}↑${c.reset}`;
        else if (srDiff < -0.02) srArrow = ` ${c.red}↓${c.reset}`;
        const srStr = `${(m.successRate * 100).toFixed(1)}%${srArrow}`;

        console.log(`  ${padAnsi(m.id, 17)} | ${padAnsi(statusStr, 34)} | ${padAnsi(latStr, 17)} | ${srStr}`);
      }
    }

    console.log(hr());
    console.log(`  ${c.bold}Recent Routing Decisions${c.reset}`);
    const decisions = telemetry.getRecentDecisions(3);
    if (decisions.length === 0) {
      console.log(`  ${c.dim}No recent routing decisions.${c.reset}`);
    } else {
      for (const d of decisions) {
        const dDate = new Date(d.timestamp);
        const timeStr = `${dDate.getHours().toString().padStart(2, '0')}:${dDate.getMinutes().toString().padStart(2, '0')}:${dDate.getSeconds().toString().padStart(2, '0')}`;
        console.log(`  ${c.dim}[${timeStr}]${c.reset} ${c.cyan}${d.selectedProvider}${c.reset} chosen for "${d.taskType}" task (${d.inputSizeBucket} tokens):`);
        console.log(`         ↳ ${c.dim}${d.reasoning}${c.reset}`);
      }
    }

    console.log(hr());
    console.log(`  ${c.bold}Recent Failures${c.reset}`);
    const failures = telemetry.getRecentFailures(5);
    if (failures.length === 0) {
      console.log(`  ${c.dim}No recent failures recorded.${c.reset}`);
    } else {
      for (const f of failures) {
        const fDate = new Date(f.timestamp);
        const timeStr = `${fDate.getHours().toString().padStart(2, '0')}:${fDate.getMinutes().toString().padStart(2, '0')}:${fDate.getSeconds().toString().padStart(2, '0')}`;
        console.log(`  ${c.dim}[${timeStr}]${c.reset} ${c.red}${f.provider}${c.reset} | ${f.errorType} | ${f.shortMessage}`);
        if (options.verbose && f.fullStack) {
          console.log(`         ↳ ${c.dim}${f.fullStack.split('\\n')[0].slice(0, 120)}...${c.reset}`);
        }
      }
    }
    
    if (options.watch) {
      console.log(hr());
      console.log(`  ${c.dim}Watching for routing changes... (Ctrl+C to exit)${c.reset}`);
    } else {
      console.log('');
    }
  };

  if (!options.watch) {
    render();
    return;
  }

  // Watch Mode Loop
  render();
  let lastUpdated = telemetry.getLastUpdatedTime();
  
  setInterval(() => {
    const currentUpdated = telemetry.getLastUpdatedTime();
    if (currentUpdated !== lastUpdated) {
      lastUpdated = currentUpdated;
      render();
    }
  }, 2000);
  
  // Keep process alive for watch mode
  return new Promise(() => {});
}
