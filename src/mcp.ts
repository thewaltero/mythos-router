import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyExternalAgentActions, resolveSandboxChecks } from './commands/swd.js';
import { validateExternalAgentInput } from './action-schema.js';
import { formatReceiptMarkdown } from './receipt-markdown.js';
import {
  listReceipts,
  readReceipt,
  readReceipts,
  verifyReceipt,
  verifyReceiptIntegrity,
} from './receipts.js';
import { planUndo, executeUndo } from './receipt-undo.js';
import { runDoctor } from './doctor.js';
import { suggestProjectPolicy } from './policy-suggestions.js';
import { listRuns, readRun } from './runs.js';
import {
  analyzeReceiptsForSkill,
  DEFAULT_LEARNED_SKILL_NAME,
  DEFAULT_MIN_OCCURRENCES,
} from './skill-learning.js';
import {
  checkSkills,
  ensureSkillsDir,
  getGlobalSkillsDir,
  getProjectSkillsDir,
  listSkills,
  loadSkill,
  validateSkill,
} from './skills.js';
import { resolveWorkspace, type WorkspaceContext, type WorkspaceInput } from './workspace.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: Record<string, unknown>;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Server → client JSON-RPC notification (no id). Used for progress streaming. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export type ProgressToken = string | number;

export type ProgressReporter = (
  progress: number,
  total?: number,
  message?: string,
) => void | Promise<void>;

export interface HandleMCPMessageOptions {
  /**
   * Invoked for server→client notifications emitted while handling a request
   * (e.g. notifications/progress when the client supplied a progressToken).
   * The stdio server writes these to the same output stream before the final response.
   */
  onNotification?: (notification: JsonRpcNotification) => void | Promise<void>;
}

interface MCPTool {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

type ToolHandler = (
  args: Record<string, unknown>,
  workspace: WorkspaceContext,
  reportProgress?: ProgressReporter,
) => Promise<ToolResult> | ToolResult;

const textInputSchema: Record<string, Record<string, unknown>> = {
  input: {
    type: 'string',
    description: 'Raw JSON action envelope, JSON action array, or FILE_ACTION text from an external agent.',
  },
  actions: {
    type: 'array',
    description: 'Structured file actions. Used when input is not provided.',
    items: { type: 'object' },
  },
  request: {
    type: 'string',
    description: 'Optional receipt request label.',
  },
  summary: {
    type: 'string',
    description: 'Optional receipt summary override.',
  },
  agentId: {
    type: 'string',
    description: 'External agent identifier recorded in receipts.',
  },
  modelId: {
    type: 'string',
    description: 'External model identifier recorded in receipts.',
  },
  metadata: {
    type: 'object',
    description: 'Optional external-agent metadata included in the input envelope.',
  },
  contract: {
    type: 'object',
    description: 'Optional per-run task contract with allowedPaths, blockedPaths, requiredPaths, and expectedOutputs.',
  },
};

export const MCP_TOOLS: MCPTool[] = [
  {
    name: 'swd_validate',
    title: 'Validate external-agent action input',
    description:
      'Validates Mythos external-agent JSON or FILE_ACTION input without writing files, receipts, or run history.',
    inputSchema: {
      type: 'object',
      properties: textInputSchema,
    },
    annotations: {
      title: 'SWD validate',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'swd_dry_run',
    title: 'Preview external-agent file actions through SWD',
    description:
      'Validates external-agent file actions through Mythos Strict Write Discipline without writing files or receipts. Use before swd_apply.',
    inputSchema: {
      type: 'object',
      properties: {
        ...textInputSchema,
        allowRisky: {
          type: 'boolean',
          description: 'Preview high-impact command-surface actions that normally require explicit opt-in. Sensitive files remain blocked.',
        },
      },
    },
    annotations: {
      title: 'SWD dry-run',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'swd_apply',
    title: 'Apply external-agent file actions through SWD',
    description:
      'Applies external-agent file actions through Mythos Strict Write Discipline, verifies filesystem state, rolls back failed verification, and writes receipts by default.',
    inputSchema: {
      type: 'object',
      properties: {
        ...textInputSchema,
        dryRun: {
          type: 'boolean',
          description: 'If true, preview the plan without writing files or receipts.',
        },
        allowRisky: {
          type: 'boolean',
          description: 'Allow high-impact command-surface actions and deletes. Sensitive files remain blocked.',
        },
        check: {
          type: 'array',
          description: 'Trusted shell command(s) to run in an isolated copy before applying. Changes are applied only if every check passes.',
          items: { type: 'string' },
        },
        runChecks: {
          type: 'boolean',
          description: 'Run trusted checks declared in .mythos/policy.json in an isolated copy before applying. Declared checks never run unless this is true.',
        },
        saveReceipt: {
          type: 'boolean',
          description: 'Write a local SWD receipt for successful non-dry-run applies. Defaults to true.',
        },
        saveRun: {
          type: 'boolean',
          description: 'Write a local run history record for non-dry-run applies. Defaults to true.',
        },
        rollback: {
          type: 'boolean',
          description: 'Roll back writes when SWD verification fails. Defaults to true.',
        },
      },
    },
    annotations: {
      title: 'SWD apply',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'receipts_list',
    title: 'List SWD receipts',
    description: 'List recent local SWD receipts for the current repository.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of receipts to return. Defaults to 10, capped at 100.',
        },
      },
    },
    annotations: {
      title: 'List receipts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'receipts_show',
    title: 'Show an SWD receipt',
    description: 'Read a local SWD receipt by id, file path, or latest.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Receipt id, receipt JSON path, or latest. Defaults to latest.',
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown'],
          description: 'Return raw receipt JSON or PR-ready Markdown. Defaults to json.',
        },
      },
    },
    annotations: {
      title: 'Show receipt',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'receipts_verify',
    title: 'Verify an SWD receipt',
    description: 'Verify current filesystem state and receipt integrity against a local SWD receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Receipt id, receipt JSON path, or latest. Defaults to latest.',
        },
      },
    },
    annotations: {
      title: 'Verify receipt',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'skills_list',
    title: 'List Mythos skills',
    description: 'List project-local and user-global Mythos SKILL.md packs visible to this repository.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      title: 'List skills',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'skills_check',
    title: 'Validate Mythos skills',
    description: 'Validate all discovered skills or one named skill/path without writing files.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Optional skill name or path to validate. If omitted, all discovered skills are checked.',
        },
      },
    },
    annotations: {
      title: 'Check skills',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'receipts_undo',
    title: 'Undo an SWD receipt',
    description:
      'Plan (default) or apply reversal of a verified SWD receipt. Preview by default; set apply=true to execute. ' +
      'Only CREATE actions are fully auto-reversible; MODIFY/DELETE need manual restore. Sensitive paths stay blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Receipt id, receipt JSON path, or latest. Defaults to latest.',
        },
        apply: {
          type: 'boolean',
          description: 'When true, apply reversible undo actions. Defaults to false (preview only).',
        },
        force: {
          type: 'boolean',
          description: 'Allow undo even if the receipt drifted or its integrity hash fails. Defaults to false.',
        },
      },
    },
    annotations: {
      title: 'Undo receipt',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'doctor',
    title: 'Workspace health doctor',
    description:
      'Inspect local Mythos workspace health (policy, receipts, sessions, telemetry, transaction journals). ' +
      'Set repair=true to recover inactive interrupted SWD transaction journals.',
    inputSchema: {
      type: 'object',
      properties: {
        repair: {
          type: 'boolean',
          description: 'Recover inactive interrupted SWD journals. Defaults to false (inspect only).',
        },
      },
    },
    annotations: {
      title: 'Doctor',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'policy_suggest',
    title: 'Suggest project SWD policy',
    description:
      'Inspect the repository and suggest .mythos/policy.json block/confirm patterns. Read-only; never writes policy files.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    annotations: {
      title: 'Policy suggest',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'skills_suggest',
    title: 'Suggest skills from SWD receipts',
    description:
      'Mine recent SWD receipts for recurring verification failures and propose a SKILL.md. ' +
      'Read-only by default; set write=true to persist (force required to overwrite).',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Skill name to propose or write. Defaults to the learned-skill default name.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of recent receipts to analyze. Defaults to 50, capped at 100.',
        },
        minOccurrences: {
          type: 'number',
          description: 'Minimum recurrence before a failure becomes a rule. Defaults to 2.',
        },
        write: {
          type: 'boolean',
          description: 'When true, write the generated SKILL.md. Defaults to false.',
        },
        force: {
          type: 'boolean',
          description: 'Allow overwriting an existing skill when write=true. Defaults to false.',
        },
        global: {
          type: 'boolean',
          description: 'Write to the user-global skills directory instead of project-local. Defaults to false.',
        },
      },
    },
    annotations: {
      title: 'Skills suggest',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'runs_list',
    title: 'List external-agent SWD runs',
    description: 'List recent local external-agent SWD run outcomes for this repository.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of runs to return. Defaults to 10, capped at 100.',
        },
      },
    },
    annotations: {
      title: 'List runs',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'runs_show',
    title: 'Show an external-agent SWD run',
    description: 'Read a local external-agent SWD run by id or latest.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Run id or latest. Defaults to latest.',
        },
      },
    },
    annotations: {
      title: 'Show run',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  swd_validate: (args) => {
    const rawInput = externalAgentInputFromArgs(args);
    const output = validateExternalAgentInput(rawInput);
    return toolResult(output, !output.ok);
  },

  swd_dry_run: async (args, workspace, reportProgress) => {
    await reportProgress?.(10, 100, 'Validating external-agent actions (dry-run)…');
    const rawInput = externalAgentInputFromArgs(args);
    await reportProgress?.(40, 100, 'Previewing SWD plan without writing files…');
    const output = await applyExternalAgentActions({
      rawInput,
      dryRun: true,
      saveReceipt: false,
      allowRisky: optionalBoolean(args.allowRisky, 'allowRisky') ?? false,
      request: optionalString(args.request, 'request'),
      summary: optionalString(args.summary, 'summary'),
      agentId: optionalString(args.agentId, 'agentId'),
      modelId: optionalString(args.modelId, 'modelId'),
      workspace,
    });
    await reportProgress?.(100, 100, output.ok ? 'Dry-run complete.' : 'Dry-run finished with errors.');
    return toolResult(output, !output.ok);
  },

  swd_apply: async (args, workspace, reportProgress) => {
    await reportProgress?.(5, 100, 'Parsing external-agent actions…');
    const rawInput = externalAgentInputFromArgs(args);
    const dryRun = optionalBoolean(args.dryRun, 'dryRun') ?? false;
    const checks = dryRun ? [] : resolveSandboxChecks({
      check: optionalStringArray(args.check, 'check'),
      runChecks: optionalBoolean(args.runChecks, 'runChecks') ?? false,
    }, workspace);
    if (checks.length > 0) {
      await reportProgress?.(25, 100, `Running ${checks.length} isolated sandbox check(s)…`);
    } else {
      await reportProgress?.(25, 100, dryRun ? 'Dry-run mode — skipping sandbox checks…' : 'No sandbox checks requested…');
    }
    await reportProgress?.(55, 100, dryRun ? 'Previewing SWD apply…' : 'Applying actions through Strict Write Discipline…');
    const output = await applyExternalAgentActions({
      rawInput,
      dryRun,
      saveReceipt: dryRun ? false : optionalBoolean(args.saveReceipt, 'saveReceipt') ?? true,
      allowRisky: optionalBoolean(args.allowRisky, 'allowRisky') ?? false,
      enableRollback: optionalBoolean(args.rollback, 'rollback') ?? true,
      saveRun: dryRun ? false : optionalBoolean(args.saveRun, 'saveRun') ?? true,
      request: optionalString(args.request, 'request'),
      summary: optionalString(args.summary, 'summary'),
      agentId: optionalString(args.agentId, 'agentId'),
      modelId: optionalString(args.modelId, 'modelId'),
      checks,
      workspace,
    });
    await reportProgress?.(
      100,
      100,
      output.ok
        ? (dryRun ? 'Dry-run apply complete.' : 'SWD apply complete.')
        : 'SWD apply finished with errors.',
    );
    return toolResult(output, !output.ok);
  },

  receipts_list: (args, workspace) => {
    const limit = boundedLimit(args.limit);
    return toolResult({
      ok: true,
      receipts: listReceipts(limit, workspace.rootDir),
    });
  },

  receipts_show: (args, workspace) => {
    const target = optionalString(args.target, 'target') ?? 'latest';
    const format = optionalString(args.format, 'format') ?? 'json';
    if (format !== 'json' && format !== 'markdown') {
      throw new Error('format must be json or markdown.');
    }
    const receipt = readReceipt(target, workspace.rootDir);
    if (!receipt) {
      return toolError(`Receipt not found: ${target}`, { target });
    }
    if (format === 'markdown') {
      const markdown = formatReceiptMarkdown(receipt);
      return {
        content: [{ type: 'text', text: markdown }],
        structuredContent: {
          ok: true,
          receiptId: receipt.id,
          format,
          markdown,
        },
        isError: false,
      };
    }
    return toolResult({ ok: true, receipt });
  },

  receipts_verify: (args, workspace) => {
    const target = optionalString(args.target, 'target') ?? 'latest';
    const receipt = readReceipt(target, workspace.rootDir);
    if (!receipt) {
      return toolError(`Receipt not found: ${target}`, { target });
    }
    const verification = verifyReceipt(receipt, workspace.rootDir);
    const integrityOk = verifyReceiptIntegrity(receipt);
    return toolResult({
      ok: verification.ok && integrityOk,
      receiptId: receipt.id,
      verification,
      integrityOk,
    }, !(verification.ok && integrityOk));
  },

  skills_list: (_args, workspace) => toolResult({
    ok: true,
    projectDir: getProjectSkillsDir(workspace.rootDir),
    globalDir: getGlobalSkillsDir(),
    skills: listSkills(workspace.rootDir),
  }),

  skills_check: (args, workspace) => {
    const name = optionalString(args.name, 'name');
    const result = checkSkills(name, workspace.rootDir);
    return toolResult({ ok: result.ok, result }, !result.ok);
  },

  receipts_undo: async (args, workspace, reportProgress) => {
    const target = optionalString(args.target, 'target') ?? 'latest';
    const apply = optionalBoolean(args.apply, 'apply') ?? false;
    const force = optionalBoolean(args.force, 'force') ?? false;
    await reportProgress?.(10, 100, `Loading receipt ${target}…`);
    const receipt = readReceipt(target, workspace.rootDir);
    if (!receipt) {
      return toolError(`Receipt not found: ${target}`, { target });
    }

    await reportProgress?.(40, 100, apply ? 'Planning and applying undo…' : 'Planning undo (preview)…');
    const plan = planUndo(receipt, { force, workspace });
    // Fail closed on integrity unless force is set — mirrors CLI --force.
    if (!plan.integrityOk && !force) {
      return toolResult({
        ok: false,
        applied: false,
        receiptId: receipt.id,
        plan,
        error: 'Receipt integrity check failed. Pass force=true to plan/apply anyway.',
      }, true);
    }

    const execution = await executeUndo(plan, { apply, workspace });
    const ok = apply
      ? execution.ok && execution.applied
      : execution.blocked.length === 0;
    await reportProgress?.(100, 100, ok ? 'Undo finished.' : 'Undo finished with errors.');
    return toolResult({
      ok,
      applied: execution.applied,
      receiptId: receipt.id,
      plan,
      execution,
    }, !ok);
  },

  doctor: async (args, workspace, reportProgress) => {
    const repair = optionalBoolean(args.repair, 'repair') ?? false;
    await reportProgress?.(20, 100, repair ? 'Running doctor with repair…' : 'Running workspace health checks…');
    const report = runDoctor({ workspace, repair });
    await reportProgress?.(100, 100, report.ok ? 'Doctor checks passed.' : 'Doctor found issues.');
    return toolResult({ ok: report.ok, report }, !report.ok);
  },

  policy_suggest: (_args, workspace) => {
    const result = suggestProjectPolicy(workspace.rootDir);
    return toolResult({ ok: true, result });
  },

  skills_suggest: (args, workspace) => {
    const limit = boundedLimit(args.limit === undefined ? 50 : args.limit);
    const minOccurrences = optionalPositiveInt(args.minOccurrences, 'minOccurrences') ?? DEFAULT_MIN_OCCURRENCES;
    const skillName = optionalString(args.name, 'name') ?? DEFAULT_LEARNED_SKILL_NAME;
    const write = optionalBoolean(args.write, 'write') ?? false;
    const force = optionalBoolean(args.force, 'force') ?? false;
    const global = optionalBoolean(args.global, 'global') ?? false;

    const receipts = readReceipts(limit, workspace.rootDir);
    const result = analyzeReceiptsForSkill(receipts, { minOccurrences, skillName });

    if (!write) {
      return toolResult({ ok: true, written: null, result });
    }

    if (!result.skillMarkdown) {
      return toolResult({
        ok: false,
        written: null,
        result,
        error: 'No skill rules were derived from the analyzed receipts.',
      }, true);
    }

    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(skillName)) {
      return toolError(
        'Skill names must use letters, numbers, dots, dashes, or underscores, and start with a letter or number.',
        { name: skillName },
      );
    }

    const scope = global ? 'global' : 'project';
    const root = ensureSkillsDir(scope, workspace.rootDir);
    const dir = pathJoin(root, skillName);
    const filePath = pathJoin(dir, 'SKILL.md');

    if (existsSync(filePath) && !force) {
      return toolError(
        `Skill already exists: ${filePath}. Pass force=true to overwrite.`,
        { path: filePath },
      );
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, result.skillMarkdown, 'utf-8');
    const errors = validateSkill(loadSkill(filePath, workspace.rootDir))
      .filter((issue) => issue.level === 'error');
    if (errors.length > 0) {
      return toolError(
        `Generated skill failed validation: ${errors.map((issue) => issue.message).join('; ')}`,
        { path: filePath },
      );
    }

    return toolResult({
      ok: true,
      written: filePath,
      result,
    });
  },

  runs_list: (args, workspace) => {
    const limit = boundedLimit(args.limit);
    return toolResult({
      ok: true,
      runs: listRuns(limit, workspace.rootDir),
    });
  },

  runs_show: (args, workspace) => {
    const target = optionalString(args.target, 'target') ?? 'latest';
    const run = readRun(target, workspace.rootDir);
    if (!run) {
      return toolError(`Run not found: ${target}`, { target });
    }
    return toolResult({ ok: true, run });
  },
};

export async function handleMCPMessage(
  message: unknown,
  workspaceInput?: WorkspaceInput,
  options: HandleMCPMessageOptions = {},
): Promise<JsonRpcResponse | null> {
  const workspace = resolveWorkspace(workspaceInput);
  if (!isRecord(message) || Array.isArray(message)) {
    return jsonRpcError(null, -32600, 'Invalid JSON-RPC request.');
  }

  if (message.jsonrpc !== '2.0') {
    return jsonRpcError(null, -32600, 'Invalid JSON-RPC version.');
  }

  const requestId = message.id;
  if (requestId !== undefined && !isJsonRpcRequestId(requestId)) {
    return jsonRpcError(null, -32600, 'Invalid JSON-RPC id.');
  }

  const request: JsonRpcRequest = {
    jsonrpc: '2.0',
    method: message.method,
    ...(requestId !== undefined ? { id: requestId } : {}),
    ...(message.params !== undefined ? { params: message.params } : {}),
  };
  const method = request.method;
  const id = request.id ?? null;

  if (typeof method !== 'string') {
    return id === null ? null : jsonRpcError(id, -32600, 'Invalid JSON-RPC request.');
  }

  if (request.id === undefined) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, initializeResult(request.params));
      case 'ping':
        return jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, { tools: MCP_TOOLS });
      case 'tools/call':
        return jsonRpcResult(
          id,
          await callTool(request.params, workspace, options.onNotification),
        );
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonRpcError(id, -32602, message);
  }
}

export async function runMCPServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  errorOutput: Writable = process.stderr,
  workspaceInput?: WorkspaceInput,
): Promise<void> {
  const workspace = resolveWorkspace(workspaceInput);
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      await writeJsonLine(output, jsonRpcError(null, -32700, 'Parse error.', {
        detail: err instanceof Error ? err.message : String(err),
      }));
      continue;
    }

    try {
      const response = await handleMCPMessage(parsed, workspace, {
        onNotification: async (notification) => {
          await writeJsonLine(output, notification);
        },
      });
      if (response) await writeJsonLine(output, response);
    } catch (err) {
      const detail = err instanceof Error ? err.stack ?? err.message : String(err);
      errorOutput.write(`[mythos mcp] ${detail}\n`);
      await writeJsonLine(output, jsonRpcError(null, -32603, 'Internal MCP server error.'));
    }
  }
}

function initializeResult(params: unknown): Record<string, unknown> {
  const requestedVersion = isRecord(params) && typeof params.protocolVersion === 'string'
    ? params.protocolVersion
    : undefined;
  const protocolVersion = requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion as typeof SUPPORTED_PROTOCOL_VERSIONS[number])
    ? requestedVersion
    : MCP_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: 'mythos-router',
      title: 'Mythos Router',
      version: packageVersion(),
    },
    instructions:
      'Mythos Router exposes model-free Strict Write Discipline tools plus receipts, runs, doctor, policy, and skill helpers over stdio. ' +
      'Use swd_dry_run before swd_apply when possible. receipts_undo previews by default (apply=true to execute). ' +
      'policy_suggest and skills_suggest are read-only unless skills_suggest write=true. ' +
      'Long-running tools emit notifications/progress when the client supplies params._meta.progressToken. ' +
      'Sensitive paths and repo-local project policy rules remain enforced by default.',
  };
}

async function callTool(
  params: unknown,
  workspace: WorkspaceContext,
  onNotification?: HandleMCPMessageOptions['onNotification'],
): Promise<ToolResult> {
  if (!isRecord(params) || typeof params.name !== 'string') {
    throw new Error('tools/call requires params.name.');
  }

  const handler = TOOL_HANDLERS[params.name];
  if (!handler) {
    throw new Error(`Unknown tool: ${params.name}`);
  }

  const toolArgs = isRecord(params.arguments) ? params.arguments : {};
  const progressToken = extractProgressToken(params);
  const reportProgress = createProgressReporter(progressToken, onNotification);

  try {
    if (reportProgress) {
      await reportProgress(0, 100, `Starting ${params.name}…`);
    }
    const result = await handler(toolArgs, workspace, reportProgress);
    if (reportProgress) {
      await reportProgress(100, 100, `Finished ${params.name}`);
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (reportProgress) {
      await reportProgress(100, 100, `Failed ${params.name}: ${message}`);
    }
    return toolError(message);
  }
}

/**
 * Clients opt into progress streaming by setting params._meta.progressToken on
 * tools/call (MCP progress utility). Token may be a string or integer and must
 * be unique across in-flight requests on the client side.
 */
function extractProgressToken(params: Record<string, unknown>): ProgressToken | undefined {
  const meta = params._meta;
  if (!isRecord(meta)) return undefined;
  const token = meta.progressToken;
  if (typeof token === 'string') {
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof token === 'number' && Number.isFinite(token)) return token;
  return undefined;
}

function createProgressReporter(
  progressToken: ProgressToken | undefined,
  onNotification?: HandleMCPMessageOptions['onNotification'],
): ProgressReporter | undefined {
  if (progressToken === undefined || !onNotification) return undefined;

  let lastProgress = -1;
  return async (progress: number, total = 100, message?: string) => {
    const normalizedTotal = Number.isFinite(total) && total > 0 ? total : 100;
    const clamped = Math.max(0, Math.min(normalizedTotal, Number.isFinite(progress) ? progress : 0));
    if (clamped === lastProgress && message === undefined) return;
    lastProgress = clamped;
    const params: Record<string, unknown> = {
      progressToken,
      progress: clamped,
      total: normalizedTotal,
    };
    if (message !== undefined && message.length > 0) params.message = message;
    await onNotification({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params,
    });
  };
}

function externalAgentInputFromArgs(args: Record<string, unknown>): string {
  const directInput = optionalString(args.input, 'input');
  if (directInput !== undefined) return directInput;

  if (!Array.isArray(args.actions)) {
    throw new Error('Provide either input (string) or actions (array).');
  }

  return JSON.stringify({
    request: optionalString(args.request, 'request'),
    summary: optionalString(args.summary, 'summary'),
    agent: {
      id: optionalString(args.agentId, 'agentId'),
      model: optionalString(args.modelId, 'modelId'),
    },
    metadata: optionalRecord(args.metadata, 'metadata'),
    contract: optionalRecord(args.contract, 'contract'),
    actions: args.actions,
  });
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalPositiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a positive finite number.`);
  }
  return Math.floor(value);
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value as string[];
}

function optionalRecord(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value;
}

function boundedLimit(value: unknown): number {
  if (value === undefined || value === null) return 10;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('limit must be a finite number.');
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function toolResult(value: object, isError = false): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value as Record<string, unknown>,
    isError,
  };
}

function toolError(message: string, data?: Record<string, unknown>): ToolResult {
  return toolResult({ ok: false, error: message, ...(data ? { data } : {}) }, true);
}

function jsonRpcResult(id: JsonRpcId, result: object): JsonRpcSuccessResponse {
  return { jsonrpc: '2.0', id, result: result as Record<string, unknown> };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpcRequestId(value: unknown): value is Exclude<JsonRpcId, null> {
  return typeof value === 'string' || typeof value === 'number';
}

function writeJsonLine(
  output: Writable,
  message: JsonRpcResponse | JsonRpcNotification,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const payload = `${JSON.stringify(message)}\n`;
    const onError = (err: Error) => {
      output.off('drain', onDrain);
      reject(err);
    };
    const onDrain = () => {
      output.off('error', onError);
      resolvePromise();
    };

    output.once('error', onError);
    if (output.write(payload, 'utf-8')) {
      output.off('error', onError);
      resolvePromise();
    } else {
      output.once('drain', onDrain);
    }
  });
}

function packageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(resolve(dir, '..', 'package.json'), 'utf-8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
