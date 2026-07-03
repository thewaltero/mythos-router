import { parseActions, type FileAction } from './swd.js';
import { assertSafeRelativePathShape, isSafeRelativePathShape, normalizeRelativePath } from './path-safety.js';
import { matchesPolicyPattern, normalizePolicyPath } from './project-policy.js';

export const EXTERNAL_AGENT_ACTION_SCHEMA_VERSION = 1;
export const EXTERNAL_AGENT_ACTION_SCHEMA_ID = 'https://mythos-router.local/schemas/external-agent-actions.schema.json';
export const MAX_AGENT_INPUT_BYTES = 1_000_000;

const VALID_OPERATIONS = new Set<FileAction['operation']>(['CREATE', 'MODIFY', 'DELETE', 'READ']);
const VALID_INTENTS = new Set<FileAction['intent']>(['MUTATE', 'NOOP', 'UNKNOWN']);
const MAX_PATH_LENGTH = 500;
const MAX_CONTRACT_PATTERNS = 100;
const MAX_CONTRACT_PATTERN_LENGTH = 240;

export interface TaskContract {
  allowedPaths?: string[];
  blockedPaths?: string[];
  requiredPaths?: string[];
  expectedOutputs?: string[];
}

export interface ExternalAgentActionEnvelope {
  actions: FileAction[];
  request?: string;
  summary?: string;
  agent?: {
    id?: string;
    model?: string;
  };
  metadata?: Record<string, unknown>;
  contract?: TaskContract;
  format: 'json-envelope' | 'json-action-array' | 'file-action-text';
}

export interface TaskContractValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  expectedOutputs: string[];
}

export interface ExternalAgentValidation {
  ok: boolean;
  format: ExternalAgentActionEnvelope['format'] | 'unknown';
  actionCount: number;
  errors: string[];
  warnings: string[];
  contract?: TaskContractValidation;
}

export const EXTERNAL_AGENT_ACTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: EXTERNAL_AGENT_ACTION_SCHEMA_ID,
  title: 'Mythos external-agent action envelope',
  description:
    'Input accepted by `mythos swd apply` / `mythos swd validate` and the MCP swd_* tools. ' +
    'Three shapes are accepted: (1) an object with an `actions` array, (2) an object carrying ' +
    'raw FILE_ACTION text in `output` or `text`, or (3) a bare array of action objects.',
  oneOf: [
    { $ref: '#/$defs/actionsEnvelope' },
    { $ref: '#/$defs/textEnvelope' },
    { $ref: '#/$defs/actionArray' },
  ],
  $defs: {
    pathPatterns: pathPatternArraySchema(),
    agent: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', maxLength: 120 },
        model: { type: 'string', maxLength: 120 },
      },
    },
    contract: {
      type: 'object',
      additionalProperties: false,
      properties: {
        allowedPaths: { $ref: '#/$defs/pathPatterns' },
        blockedPaths: { $ref: '#/$defs/pathPatterns' },
        requiredPaths: { $ref: '#/$defs/pathPatterns' },
        expectedOutputs: { $ref: '#/$defs/pathPatterns' },
      },
    },
    action: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'operation'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
        operation: { type: 'string', enum: ['CREATE', 'MODIFY', 'DELETE', 'READ'] },
        intent: { type: 'string', enum: ['MUTATE', 'NOOP', 'UNKNOWN'] },
        description: { type: 'string', maxLength: 500 },
        content: { type: 'string' },
        contentHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      },
    },
    actionsEnvelope: {
      type: 'object',
      additionalProperties: false,
      required: ['actions'],
      properties: {
        request: { type: 'string', maxLength: 500 },
        summary: { type: 'string', maxLength: 500 },
        agent: { $ref: '#/$defs/agent' },
        metadata: { type: 'object' },
        contract: { $ref: '#/$defs/contract' },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: { $ref: '#/$defs/action' },
        },
      },
    },
    textEnvelope: {
      type: 'object',
      additionalProperties: false,
      anyOf: [{ required: ['output'] }, { required: ['text'] }],
      properties: {
        request: { type: 'string', maxLength: 500 },
        summary: { type: 'string', maxLength: 500 },
        agent: { $ref: '#/$defs/agent' },
        metadata: { type: 'object' },
        contract: { $ref: '#/$defs/contract' },
        output: { type: 'string' },
        text: { type: 'string' },
      },
    },
    actionArray: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { $ref: '#/$defs/action' },
    },
  },
} as const;

function pathPatternArraySchema(): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: MAX_CONTRACT_PATTERNS,
    items: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_CONTRACT_PATTERN_LENGTH,
    },
  };
}

export function parseExternalAgentEnvelope(rawInput: string): ExternalAgentActionEnvelope {
  if (Buffer.byteLength(rawInput, 'utf8') > MAX_AGENT_INPUT_BYTES) {
    throw new Error(`External agent input exceeds ${MAX_AGENT_INPUT_BYTES} bytes.`);
  }

  const trimmed = rawInput.trim();

  // Raw FILE_ACTION text also begins with '[', so it must be detected BEFORE
  // the JSON branch — otherwise JSON.parse throws on valid FILE_ACTION blocks
  // and the legacy text protocol (the model-free BYOA pipe) is unreachable.
  if (trimmed.startsWith('[FILE_ACTION')) {
    return {
      format: 'file-action-text',
      actions: parseActions(rawInput),
    };
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON input: ${detail}`);
    }

    if (Array.isArray(parsed)) {
      return {
        format: 'json-action-array',
        actions: parsed.map(normalizeJsonAction),
      };
    }

    if (!isRecord(parsed)) {
      throw new Error('Invalid JSON input: expected an object or action array.');
    }

    return normalizeJsonEnvelope(parsed);
  }

  return {
    format: 'file-action-text',
    actions: parseActions(rawInput),
  };
}

export function validateExternalAgentInput(rawInput: string): ExternalAgentValidation {
  try {
    const parsed = parseExternalAgentEnvelope(rawInput);
    const warnings: string[] = [];
    const errors: string[] = [];

    if (parsed.actions.length === 0) {
      errors.push('No valid file actions were found.');
    }

    const contract = parsed.contract
      ? validateTaskContractForActions(parsed.actions, parsed.contract)
      : undefined;
    if (contract && !contract.ok) errors.push(...contract.errors);

    return {
      ok: errors.length === 0,
      format: parsed.format,
      actionCount: parsed.actions.length,
      errors,
      warnings,
      ...(contract ? { contract } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      format: 'unknown',
      actionCount: 0,
      errors: [err instanceof Error ? err.message : String(err)],
      warnings: [],
    };
  }
}

export function validateTaskContractForActions(actions: FileAction[], contract?: TaskContract): TaskContractValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!contract) {
    return { ok: true, errors, warnings, expectedOutputs: [] };
  }

  errors.push(...validateContractShape(contract));
  if (errors.length > 0) {
    return {
      ok: false,
      errors,
      warnings,
      expectedOutputs: normalizedPatternList(contract.expectedOutputs),
    };
  }

  const actionPaths = actions.map((action) => normalizePolicyPath(action.path));
  const allowedPaths = normalizedPatternList(contract.allowedPaths);
  const blockedPaths = normalizedPatternList(contract.blockedPaths);
  const requiredPaths = normalizedPatternList(contract.requiredPaths);
  const expectedOutputs = normalizedPatternList(contract.expectedOutputs);

  if (allowedPaths.length > 0) {
    for (const action of actions) {
      const normalizedPath = normalizePolicyPath(action.path);
      if (!allowedPaths.some((pattern) => matchesPolicyPattern(pattern, normalizedPath))) {
        errors.push(`Task contract blocks ${action.path}: not matched by allowedPaths.`);
      }
    }
  }

  for (const action of actions) {
    const normalizedPath = normalizePolicyPath(action.path);
    const match = blockedPaths.find((pattern) => matchesPolicyPattern(pattern, normalizedPath));
    if (match) {
      errors.push(`Task contract blocks ${action.path}: matched blockedPaths pattern ${match}.`);
    }
  }

  for (const pattern of requiredPaths) {
    if (!actionPaths.some((filePath) => matchesPolicyPattern(pattern, filePath))) {
      errors.push(`Task contract required path pattern was not among the declared action paths: ${pattern}.`);
    }
  }

  for (const pattern of expectedOutputs) {
    if (!actionPaths.some((filePath) => matchesPolicyPattern(pattern, filePath))) {
      errors.push(`Task contract expected output pattern was not among the declared action paths: ${pattern}.`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    expectedOutputs,
  };
}

function normalizeJsonEnvelope(obj: Record<string, unknown>): ExternalAgentActionEnvelope {
  const allowedKeys = new Set(['request', 'summary', 'agent', 'metadata', 'contract', 'actions', 'output', 'text']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown external-agent envelope key: ${key}`);
    }
  }

  if (!Array.isArray(obj.actions)) {
    if (typeof obj.output === 'string' || typeof obj.text === 'string') {
      const text = typeof obj.output === 'string' ? obj.output : obj.text as string;
      const agent = isRecord(obj.agent) ? obj.agent : undefined;
      // Preserve and validate the contract here too — dropping it would let an
      // agent declare a per-run boundary that is then silently not enforced.
      const contract = obj.contract === undefined ? undefined : normalizeTaskContract(obj.contract);
      return {
        format: 'file-action-text',
        actions: parseActions(text),
        request: optionalString(obj.request),
        summary: optionalString(obj.summary),
        agent: {
          id: optionalString(agent?.id),
          model: optionalString(agent?.model),
        },
        metadata: isRecord(obj.metadata) ? obj.metadata : undefined,
        ...(contract ? { contract } : {}),
      };
    }

    throw new Error('Invalid JSON input: expected { actions: [...] }, { output: "..." }, or an action array.');
  }

  const agent = isRecord(obj.agent) ? obj.agent : undefined;
  const contract = obj.contract === undefined ? undefined : normalizeTaskContract(obj.contract);

  return {
    format: 'json-envelope',
    actions: obj.actions.map(normalizeJsonAction),
    request: optionalString(obj.request),
    summary: optionalString(obj.summary),
    agent: {
      id: optionalString(agent?.id),
      model: optionalString(agent?.model),
    },
    metadata: isRecord(obj.metadata) ? obj.metadata : undefined,
    ...(contract ? { contract } : {}),
  };
}

function normalizeJsonAction(value: unknown): FileAction {
  if (!isRecord(value)) {
    throw new Error('Invalid action: expected an object.');
  }

  const allowedKeys = new Set(['path', 'operation', 'intent', 'description', 'content', 'contentHash']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown action key: ${key}`);
    }
  }

  const operation = normalizeOperation(value.operation);
  if (!operation) {
    throw new Error(`Invalid action operation: ${String(value.operation)}`);
  }

  const path = assertSafeRelativePath(value.path);
  const description = typeof value.description === 'string' && value.description.trim().length > 0
    ? value.description.trim()
    : `${operation} ${path}`;

  const action: FileAction = {
    path,
    operation,
    intent: normalizeIntent(value.intent, operation),
    description,
  };

  if (value.content !== undefined) {
    if (typeof value.content !== 'string') {
      throw new Error(`Invalid action content for ${path}: content must be a string.`);
    }
    action.content = value.content;
  }

  if (value.contentHash !== undefined) {
    if (typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.contentHash.trim())) {
      throw new Error(`Invalid action contentHash for ${path}: expected 64 hex characters.`);
    }
    action.contentHash = value.contentHash.trim().toLowerCase();
  }

  return action;
}

function normalizeOperation(value: unknown): FileAction['operation'] | null {
  if (typeof value !== 'string') return null;
  const op = value.trim().toUpperCase();
  if (!VALID_OPERATIONS.has(op as FileAction['operation'])) return null;
  return op as FileAction['operation'];
}

function normalizeIntent(value: unknown, operation: FileAction['operation']): FileAction['intent'] {
  if (typeof value === 'string') {
    const intent = value.trim().toUpperCase();
    if (VALID_INTENTS.has(intent as FileAction['intent'])) return intent as FileAction['intent'];
  }
  return operation === 'READ' ? 'NOOP' : 'MUTATE';
}

function assertSafeRelativePath(filePath: unknown): string {
  return assertSafeRelativePathShape(filePath, 'action path', { maxLength: MAX_PATH_LENGTH });
}

function normalizeTaskContract(value: unknown): TaskContract {
  if (!isRecord(value)) {
    throw new Error('contract must be an object.');
  }

  const allowedKeys = new Set(['allowedPaths', 'blockedPaths', 'requiredPaths', 'expectedOutputs']);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown task contract key: ${key}`);
    }
  }

  return {
    allowedPaths: optionalPatternList(value.allowedPaths, 'contract.allowedPaths'),
    blockedPaths: optionalPatternList(value.blockedPaths, 'contract.blockedPaths'),
    requiredPaths: optionalPatternList(value.requiredPaths, 'contract.requiredPaths'),
    expectedOutputs: optionalPatternList(value.expectedOutputs, 'contract.expectedOutputs'),
  };
}

function validateContractShape(contract: TaskContract): string[] {
  const errors: string[] = [];
  errors.push(...validatePatternList(contract.allowedPaths, 'contract.allowedPaths'));
  errors.push(...validatePatternList(contract.blockedPaths, 'contract.blockedPaths'));
  errors.push(...validatePatternList(contract.requiredPaths, 'contract.requiredPaths'));
  errors.push(...validatePatternList(contract.expectedOutputs, 'contract.expectedOutputs'));
  return errors;
}

function optionalPatternList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const errors = validatePatternList(value, name);
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return normalizedPatternList(value as string[]);
}

function validatePatternList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${name} must be an array of path patterns.`];
  if (value.length > MAX_CONTRACT_PATTERNS) return [`${name} must contain ${MAX_CONTRACT_PATTERNS} patterns or fewer.`];

  const errors: string[] = [];
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      errors.push(`${name} entries must be non-empty strings.`);
      continue;
    }
    const normalized = normalizeRelativePath(pattern);
    if (!isSafeRelativePathShape(normalized, { maxLength: MAX_CONTRACT_PATTERN_LENGTH })) {
      errors.push(`${name} contains an unsafe pattern: ${pattern}`);
    }
  }
  return errors;
}

function normalizedPatternList(patterns?: string[]): string[] {
  return (patterns ?? []).map((pattern) => normalizePolicyPath(pattern)).filter(Boolean);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
