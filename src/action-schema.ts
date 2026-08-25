import { parseActions, type FileAction } from './swd.js';
import { assertSafeRelativePathShape, isSafeRelativePathShape, normalizeRelativePath } from './path-safety.js';
import { matchesPolicyPattern, normalizePolicyPath } from './project-policy.js';
import { assertKnownProperties } from './object-validation.js';

export const EXTERNAL_AGENT_ACTION_SCHEMA_VERSION = 1;
export const EXTERNAL_AGENT_ACTION_SCHEMA_ID = 'https://mythos-router.local/schemas/external-agent-actions.schema.json';
export const MAX_AGENT_INPUT_BYTES = 1_000_000;
export const MAX_EXTERNAL_AGENT_ACTIONS = 500;
export const MAX_ACTION_PATH_LENGTH = 500;
export const MAX_ACTION_DESCRIPTION_LENGTH = 500;
export const MAX_ENVELOPE_TEXT_LENGTH = 500;
export const MAX_AGENT_ID_LENGTH = 120;
export const MAX_AGENT_MODEL_LENGTH = 120;
export const MAX_CONTRACT_PATTERNS = 100;
export const MAX_CONTRACT_PATTERN_LENGTH = 240;

const VALID_OPERATIONS = new Set<FileAction['operation']>(['CREATE', 'MODIFY', 'DELETE', 'READ', 'PATCH']);
const VALID_INTENTS = new Set<FileAction['intent']>(['MUTATE', 'NOOP', 'UNKNOWN']);
const ENVELOPE_COMMON_KEYS = ['request', 'summary', 'agent', 'metadata', 'contract'] as const;
const ACTION_ENVELOPE_KEYS = [...ENVELOPE_COMMON_KEYS, 'actions'] as const;
const TEXT_ENVELOPE_KEYS = [...ENVELOPE_COMMON_KEYS, 'output', 'text'] as const;
const ACTION_KEYS = ['path', 'operation', 'intent', 'description', 'content', 'contentHash', 'old', 'new', 'beforeHash'] as const;
const AGENT_KEYS = ['id', 'model'] as const;
const CONTRACT_KEYS = ['allowedPaths', 'blockedPaths', 'requiredPaths', 'expectedOutputs'] as const;

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

/**
 * Published schema and runtime parsing intentionally share these exported
 * limits. A conformance test verifies that the checked-in JSON schema is
 * byte-for-byte equivalent after JSON parsing.
 */
export const EXTERNAL_AGENT_ACTION_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: EXTERNAL_AGENT_ACTION_SCHEMA_ID,
  title: 'Mythos external-agent action envelope',
  description:
    'Input accepted by `mythos swd apply` / `mythos swd validate` and the MCP swd_* tools. ' +
    'Three shapes are accepted: (1) an object with an `actions` array, (2) an object carrying ' +
    'raw FILE_ACTION text in `output` or `text`, or (3) a bare array of action objects. JSON ' +
    'operation and intent values are uppercase and case-sensitive.',
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
        id: { type: 'string', maxLength: MAX_AGENT_ID_LENGTH },
        model: { type: 'string', maxLength: MAX_AGENT_MODEL_LENGTH },
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
        path: { type: 'string', minLength: 1, maxLength: MAX_ACTION_PATH_LENGTH },
        operation: { type: 'string', enum: ['CREATE', 'MODIFY', 'DELETE', 'READ', 'PATCH'] },
        intent: { type: 'string', enum: ['MUTATE', 'NOOP', 'UNKNOWN'] },
        description: { type: 'string', maxLength: MAX_ACTION_DESCRIPTION_LENGTH },
        content: { type: 'string' },
        contentHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
        old: { type: 'string', description: 'Exact text to find for PATCH (must appear once).' },
        new: { type: 'string', description: 'Replacement text for PATCH.' },
        beforeHash: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' },
      },
    },
    actionsEnvelope: {
      type: 'object',
      additionalProperties: false,
      required: ['actions'],
      properties: {
        request: { type: 'string', maxLength: MAX_ENVELOPE_TEXT_LENGTH },
        summary: { type: 'string', maxLength: MAX_ENVELOPE_TEXT_LENGTH },
        agent: { $ref: '#/$defs/agent' },
        metadata: { type: 'object' },
        contract: { $ref: '#/$defs/contract' },
        actions: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_EXTERNAL_AGENT_ACTIONS,
          items: { $ref: '#/$defs/action' },
        },
      },
    },
    textEnvelope: {
      type: 'object',
      additionalProperties: false,
      anyOf: [{ required: ['output'] }, { required: ['text'] }],
      properties: {
        request: { type: 'string', maxLength: MAX_ENVELOPE_TEXT_LENGTH },
        summary: { type: 'string', maxLength: MAX_ENVELOPE_TEXT_LENGTH },
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
      maxItems: MAX_EXTERNAL_AGENT_ACTIONS,
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
  // the JSON branch — otherwise JSON.parse throws on valid FILE_ACTION blocks.
  if (trimmed.startsWith('[FILE_ACTION')) {
    return normalizeTextActions(rawInput);
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
      const actions = parsed.map(normalizeJsonAction);
      assertActionCount(actions);
      return {
        format: 'json-action-array',
        actions,
      };
    }

    if (!isRecord(parsed)) {
      throw new Error('Invalid JSON input: expected an object or action array.');
    }

    return normalizeJsonEnvelope(parsed);
  }

  return normalizeTextActions(rawInput);
}

export function validateExternalAgentInput(rawInput: string): ExternalAgentValidation {
  try {
    const parsed = parseExternalAgentEnvelope(rawInput);
    const warnings: string[] = [];
    const errors: string[] = [];

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
  const hasActions = Object.prototype.hasOwnProperty.call(obj, 'actions');
  const hasOutput = Object.prototype.hasOwnProperty.call(obj, 'output');
  const hasText = Object.prototype.hasOwnProperty.call(obj, 'text');

  if (hasActions) {
    assertKnownProperties(obj, ACTION_ENVELOPE_KEYS, 'external-agent envelope');
    if (!Array.isArray(obj.actions)) {
      throw new Error('Invalid JSON input: actions must be an array.');
    }
    if (hasOutput || hasText) {
      throw new Error('Invalid JSON input: an actions envelope cannot also contain output or text.');
    }

    const actions = obj.actions.map(normalizeJsonAction);
    assertActionCount(actions);
    return {
      format: 'json-envelope',
      actions,
      ...normalizeCommonEnvelopeFields(obj),
    };
  }

  assertKnownProperties(obj, TEXT_ENVELOPE_KEYS, 'external-agent envelope');
  if (!hasOutput && !hasText) {
    throw new Error('Invalid JSON input: expected { actions: [...] }, { output: "..." }, or an action array.');
  }
  if (hasOutput && typeof obj.output !== 'string') {
    throw new Error('Invalid external-agent envelope output: must be a string.');
  }
  if (hasText && typeof obj.text !== 'string') {
    throw new Error('Invalid external-agent envelope text: must be a string.');
  }

  const text = typeof obj.output === 'string' ? obj.output : obj.text as string;
  const parsed = normalizeTextActions(text);
  return {
    ...parsed,
    ...normalizeCommonEnvelopeFields(obj),
  };
}

function normalizeCommonEnvelopeFields(obj: Record<string, unknown>): Omit<ExternalAgentActionEnvelope, 'actions' | 'format'> {
  const request = optionalBoundedString(obj.request, 'request', MAX_ENVELOPE_TEXT_LENGTH);
  const summary = optionalBoundedString(obj.summary, 'summary', MAX_ENVELOPE_TEXT_LENGTH);
  const agent = normalizeAgent(obj.agent);
  const metadata = normalizeMetadata(obj.metadata);
  const contract = obj.contract === undefined ? undefined : normalizeTaskContract(obj.contract);

  return {
    ...(request !== undefined ? { request } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(contract !== undefined ? { contract } : {}),
  };
}

function normalizeAgent(value: unknown): ExternalAgentActionEnvelope['agent'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('agent must be an object.');
  assertKnownProperties(value, AGENT_KEYS, 'agent');

  const id = optionalBoundedString(value.id, 'agent.id', MAX_AGENT_ID_LENGTH);
  const model = optionalBoundedString(value.model, 'agent.model', MAX_AGENT_MODEL_LENGTH);
  return {
    ...(id !== undefined ? { id } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function normalizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('metadata must be an object.');
  return value;
}

function normalizeJsonAction(value: unknown): FileAction {
  if (!isRecord(value)) {
    throw new Error('Invalid action: expected an object.');
  }
  assertKnownProperties(value, ACTION_KEYS, 'action');

  const operation = requireEnumString(value.operation, 'action operation', VALID_OPERATIONS);
  if (typeof value.path === 'string' && value.path.length > MAX_ACTION_PATH_LENGTH) {
    throw new Error(`Invalid action path: exceeds ${MAX_ACTION_PATH_LENGTH} characters.`);
  }
  const path = assertSafeRelativePathShape(value.path, 'action path', { maxLength: MAX_ACTION_PATH_LENGTH });
  const description = optionalBoundedString(value.description, `action description for ${path}`, MAX_ACTION_DESCRIPTION_LENGTH)
    ?? `${operation} ${path}`;
  const intent = value.intent === undefined
    ? (operation === 'READ' ? 'NOOP' : 'MUTATE')
    : requireEnumString(value.intent, `action intent for ${path}`, VALID_INTENTS);

  const action: FileAction = {
    path,
    operation,
    intent,
    description,
  };

  if (value.content !== undefined) {
    if (typeof value.content !== 'string') {
      throw new Error(`Invalid action content for ${path}: content must be a string.`);
    }
    action.content = value.content;
  }

  if (value.contentHash !== undefined) {
    if (typeof value.contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.contentHash)) {
      throw new Error(`Invalid action contentHash for ${path}: expected 64 hex characters.`);
    }
    action.contentHash = value.contentHash.toLowerCase();
  }

  if (value.old !== undefined) {
    if (typeof value.old !== 'string') {
      throw new Error(`Invalid action old for ${path}: old must be a string.`);
    }
    action.old = value.old;
  }

  if (value.new !== undefined) {
    if (typeof value.new !== 'string') {
      throw new Error(`Invalid action new for ${path}: new must be a string.`);
    }
    action.new = value.new;
  }

  if (value.beforeHash !== undefined) {
    if (typeof value.beforeHash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.beforeHash)) {
      throw new Error(`Invalid action beforeHash for ${path}: expected 64 hex characters.`);
    }
    action.beforeHash = value.beforeHash.toLowerCase();
  }

  if (operation === 'PATCH') {
    if (action.old === undefined || action.new === undefined) {
      throw new Error(`Invalid PATCH action for ${path}: both old and new are required.`);
    }
    if (action.old.length === 0) {
      throw new Error(`Invalid PATCH action for ${path}: old must be non-empty.`);
    }
  }

  return action;
}

function normalizeTextActions(text: string): ExternalAgentActionEnvelope {
  const actions = parseActions(text).map(validateParsedTextAction);
  assertActionCount(actions);
  return {
    format: 'file-action-text',
    actions,
  };
}

function validateParsedTextAction(action: FileAction): FileAction {
  const path = assertSafeRelativePathShape(action.path, 'action path', { maxLength: MAX_ACTION_PATH_LENGTH });
  const description = action.description ?? `${action.operation} ${path}`;
  if (description.length > MAX_ACTION_DESCRIPTION_LENGTH) {
    throw new Error(
      `Invalid action description for ${path}: exceeds ${MAX_ACTION_DESCRIPTION_LENGTH} characters.`,
    );
  }
  if (action.contentHash !== undefined && !/^[a-f0-9]{64}$/i.test(action.contentHash)) {
    throw new Error(`Invalid action contentHash for ${path}: expected 64 hex characters.`);
  }
  if (action.beforeHash !== undefined && !/^[a-f0-9]{64}$/i.test(action.beforeHash)) {
    throw new Error(`Invalid action beforeHash for ${path}: expected 64 hex characters.`);
  }
  if (action.operation === 'PATCH') {
    if (action.old === undefined || action.new === undefined) {
      throw new Error(`Invalid PATCH action for ${path}: both old and new are required.`);
    }
    if (action.old.length === 0) {
      throw new Error(`Invalid PATCH action for ${path}: old must be non-empty.`);
    }
  }
  return {
    ...action,
    path,
    description,
    contentHash: action.contentHash?.toLowerCase(),
    beforeHash: action.beforeHash?.toLowerCase(),
  };
}

function assertActionCount(actions: FileAction[]): void {
  if (actions.length === 0) {
    throw new Error('No valid file actions were found.');
  }
  if (actions.length > MAX_EXTERNAL_AGENT_ACTIONS) {
    throw new Error(`External agent input contains ${actions.length} actions; maximum is ${MAX_EXTERNAL_AGENT_ACTIONS}.`);
  }
}

function requireEnumString<T extends string>(value: unknown, label: string, allowed: ReadonlySet<T>): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new Error(`Invalid ${label}: ${String(value)}. Expected one of: ${[...allowed].join(', ')}.`);
  }
  return value as T;
}

function normalizeTaskContract(value: unknown): TaskContract {
  if (!isRecord(value)) {
    throw new Error('contract must be an object.');
  }
  assertKnownProperties(value, CONTRACT_KEYS, 'task contract');

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
    if (pattern.length > MAX_CONTRACT_PATTERN_LENGTH) {
      errors.push(`${name} contains an unsafe pattern: ${pattern}`);
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

function optionalBoundedString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  if (value.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
