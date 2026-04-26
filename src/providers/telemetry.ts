// ─────────────────────────────────────────────────────────────
//  mythos-router :: providers/telemetry.ts
//  Observable Telemetry Backend — SQLite-powered event streaming
//
//  Separates state (metrics) from history (decisions, failures).
//  Uses an asynchronous batching queue to prevent I/O blocking.
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
// @ts-ignore - node:sqlite is experimental in some versions
import { DatabaseSync } from 'node:sqlite';

export interface ProviderState {
  id: string;
  successRate: number;
  avgLatency: number;
  prevSuccessRate: number;
  prevAvgLatency: number;
  totalCalls: number;
  totalFailures: number;
  degradedUntil: number;
}

export interface RoutingDecision {
  timestamp: number;
  selectedProvider: string;
  taskType: 'chat' | 'code' | 'analysis' | 'unknown';
  inputSizeBucket: string;
  reasoning: string;
}

export interface FailureEvent {
  timestamp: number;
  provider: string;
  errorType: string;
  shortMessage: string;
  fullStack: string;
}

const TELEMETRY_DIR = path.join(os.homedir(), '.mythos-router');
const TELEMETRY_DB_FILE = path.join(TELEMETRY_DIR, 'telemetry.db');
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_EVENT_COUNT = 10;
const RETENTION_LIMIT = 1000;

export class TelemetryStore {
  private static instance: TelemetryStore;
  private db: DatabaseSync;
  
  private metricUpdates = new Map<string, ProviderState>();
  private decisionQueue: RoutingDecision[] = [];
  private failureQueue: FailureEvent[] = [];
  
  private flushTimer: NodeJS.Timeout | null = null;
  private shuttingDown = false;

  private constructor() {
    if (!fs.existsSync(TELEMETRY_DIR)) {
      fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
    }

    this.db = new DatabaseSync(TELEMETRY_DB_FILE);
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec('PRAGMA synchronous=NORMAL;');
    this.initSchema();
    this.setupGracefulShutdown();
    this.startFlushTimer();
  }

  public static getInstance(): TelemetryStore {
    if (!TelemetryStore.instance) {
      TelemetryStore.instance = new TelemetryStore();
    }
    return TelemetryStore.instance;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_metrics (
        id TEXT PRIMARY KEY,
        success_rate REAL NOT NULL,
        avg_latency REAL NOT NULL,
        prev_success_rate REAL NOT NULL,
        prev_avg_latency REAL NOT NULL,
        total_calls INTEGER NOT NULL,
        total_failures INTEGER NOT NULL,
        degraded_until INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        selected_provider TEXT NOT NULL,
        task_type TEXT NOT NULL,
        input_size_bucket TEXT NOT NULL,
        reasoning TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        error_type TEXT NOT NULL,
        short_message TEXT NOT NULL,
        full_stack TEXT NOT NULL
      );
    `);
  }

  public updateMetrics(state: ProviderState): void {
    this.metricUpdates.set(state.id, state);
    this.checkFlushQueue();
  }

  public logDecision(decision: RoutingDecision): void {
    this.decisionQueue.push(decision);
    this.checkFlushQueue();
  }

  public logFailure(failure: FailureEvent): void {
    this.failureQueue.push(failure);
    this.checkFlushQueue();
  }

  private checkFlushQueue(): void {
    if (this.shuttingDown) return;
    const totalEvents = this.metricUpdates.size + this.decisionQueue.length + this.failureQueue.length;
    if (totalEvents >= FLUSH_EVENT_COUNT) {
      this.flush();
    }
  }

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  public flush(): void {
    if (this.metricUpdates.size === 0 && this.decisionQueue.length === 0 && this.failureQueue.length === 0) {
      return;
    }

    try {
      this.db.exec('BEGIN;');
      
      const now = Date.now();

      // Upsert Metrics (State)
      const stmtMetrics = this.db.prepare(`
        INSERT OR REPLACE INTO provider_metrics 
        (id, success_rate, avg_latency, prev_success_rate, prev_avg_latency, total_calls, total_failures, degraded_until, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [_, state] of this.metricUpdates) {
        stmtMetrics.run(
          state.id, state.successRate, state.avgLatency, 
          state.prevSuccessRate, state.prevAvgLatency, 
          state.totalCalls, state.totalFailures, state.degradedUntil, now
        );
      }

      // If there were decisions/failures but NO metric updates, we MUST update the global updated_at 
      // so the UI watch mode detects the change.
      if (this.metricUpdates.size === 0 && (this.decisionQueue.length > 0 || this.failureQueue.length > 0)) {
        this.db.exec(`UPDATE provider_metrics SET updated_at = ${now}`);
      }

      // Append Decisions (Events)
      const stmtDecisions = this.db.prepare(`
        INSERT INTO routing_decisions (timestamp, selected_provider, task_type, input_size_bucket, reasoning)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const d of this.decisionQueue) {
        stmtDecisions.run(d.timestamp, d.selectedProvider, d.taskType, d.inputSizeBucket, d.reasoning);
      }

      // Append Failures (Events)
      const stmtFailures = this.db.prepare(`
        INSERT INTO failures (timestamp, provider, error_type, short_message, full_stack)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const f of this.failureQueue) {
        // Truncate full stack to 4KB max
        const stack = f.fullStack.slice(0, 4096);
        stmtFailures.run(f.timestamp, f.provider, f.errorType, f.shortMessage, stack);
      }

      this.db.exec('COMMIT;');

      this.metricUpdates.clear();
      this.decisionQueue = [];
      this.failureQueue = [];

      this.enforceRetention();

    } catch (err) {
      this.db.exec('ROLLBACK;');
    }
  }

  private enforceRetention(): void {
    try {
      this.db.exec(`
        DELETE FROM routing_decisions 
        WHERE id < (SELECT MAX(id) - ${RETENTION_LIMIT} FROM routing_decisions);
      `);

      this.db.exec(`
        DELETE FROM failures 
        WHERE id < (SELECT MAX(id) - ${RETENTION_LIMIT} FROM failures);
      `);
    } catch (e) {
      // Ignore
    }
  }

  private setupGracefulShutdown(): void {
    const handleExit = () => {
      this.shuttingDown = true;
      if (this.flushTimer) clearInterval(this.flushTimer);
      this.flush();
    };

    process.on('exit', handleExit);
    process.on('SIGINT', () => { handleExit(); process.exit(0); });
    process.on('SIGTERM', () => { handleExit(); process.exit(0); });
  }

  public getProviderMetrics(): ProviderState[] {
    try {
      const rows = this.db.prepare('SELECT * FROM provider_metrics').all() as any[];
      return rows.map(r => ({
        id: r.id,
        successRate: r.success_rate,
        avgLatency: r.avg_latency,
        prevSuccessRate: r.prev_success_rate,
        prevAvgLatency: r.prev_avg_latency,
        totalCalls: r.total_calls,
        totalFailures: r.total_failures,
        degradedUntil: r.degraded_until
      }));
    } catch {
      return [];
    }
  }

  public getRecentDecisions(limit: number = 3): RoutingDecision[] {
    try {
      const rows = this.db.prepare('SELECT * FROM routing_decisions ORDER BY id DESC LIMIT ?').all(limit) as any[];
      return rows.map(r => ({
        timestamp: r.timestamp,
        selectedProvider: r.selected_provider,
        taskType: r.task_type,
        inputSizeBucket: r.input_size_bucket,
        reasoning: r.reasoning
      }));
    } catch {
      return [];
    }
  }

  public getRecentFailures(limit: number = 5): FailureEvent[] {
    try {
      const rows = this.db.prepare('SELECT * FROM failures ORDER BY id DESC LIMIT ?').all(limit) as any[];
      return rows.map(r => ({
        timestamp: r.timestamp,
        provider: r.provider,
        errorType: r.error_type,
        shortMessage: r.short_message,
        fullStack: r.full_stack
      }));
    } catch {
      return [];
    }
  }

  public getLastUpdatedTime(): number {
    try {
      const row = this.db.prepare('SELECT MAX(updated_at) as last_ts FROM provider_metrics').get() as { last_ts: number | null };
      return row?.last_ts || 0;
    } catch {
      return 0;
    }
  }
}
