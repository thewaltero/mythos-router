import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_POLICY_FILE } from './config.js';
import { MAX_WRITABLE_ACTION_CONTENT_BYTES, type FileAction } from './swd.js';

export const PROJECT_POLICY_VERSION = 1;

export type ProjectPolicyOperation = FileAction['operation'];

export interface ProjectPolicyLimits {
  allowDeletes?: boolean;
  maxActions?: number;
  maxActionContentBytes?: number;
  allowedOperations?: ProjectPolicyOperation[];
}

export interface ProjectPolicyCheck {
  name: string;
  command: string;
}

export interface ProjectPolicy {
  version?: typeof PROJECT_POLICY_VERSION;
  block?: string[];
  confirm?: string[];
  limits?: ProjectPolicyLimits;
  checks?: ProjectPolicyCheck[];
}

export interface ProjectPolicyState {
  found: boolean;
  path: string;
  policy?: ProjectPolicy;
  errors: string[];
}

export interface ProjectPolicyDecision {
  risk: 'confirm' | 'block';
  reason: string;
}

const VALID_OPERATIONS = new Set<ProjectPolicyOperation>(['CREATE', 'MODIFY', 'DELETE', 'READ']);
const MAX_POLICY_PATTERNS = 200;
const MAX_PATTERN_LENGTH = 240;
const MAX_POLICY_ACTIONS = 500;
const MAX_POLICY_CHECKS = 20;
const MAX_CHECK_NAME_LENGTH = 60;
const MAX_CHECK_COMMAND_LENGTH = 500;

export const DEFAULT_PROJECT_POLICY: ProjectPolicy = {
  version: PROJECT_POLICY_VERSION,
  block: [],
  confirm: [],
  limits: {
    allowDeletes: true,
    maxActionContentBytes: MAX_WRITABLE_ACTION_CONTENT_BYTES,
  },
};

export function projectPolicyTemplate(): string {
  return `${JSON.stringify(DEFAULT_PROJECT_POLICY, null, 2)}\n`;
}

export function getProjectPolicyPath(rootDir = process.cwd()): string {
  return resolve(rootDir, PROJECT_POLICY_FILE);
}

export function loadProjectPolicy(rootDir = process.cwd()): ProjectPolicyState {
  const policyPath = getProjectPolicyPath(rootDir);
  if (!existsSync(policyPath)) {
    return { found: false, path: policyPath, errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { found: true, path: policyPath, errors: [`Invalid JSON in ${PROJECT_POLICY_FILE}: ${message}`] };
  }

  const errors = validateProjectPolicy(parsed);
  if (errors.length > 0) {
    return { found: true, path: policyPath, errors };
  }

  return {
    found: true,
    path: policyPath,
    policy: normalizeProjectPolicy(parsed as ProjectPolicy),
    errors: [],
  };
}

export function evaluateProjectPolicyBatch(actions: FileAction[], state: ProjectPolicyState): ProjectPolicyDecision | null {
  const failure = projectPolicyFailure(state);
  if (failure) return failure;

  const maxActions = state.policy?.limits?.maxActions;
  if (maxActions !== undefined && actions.length > maxActions) {
    return {
      risk: 'block',
      reason: `Project policy blocks this batch: ${actions.length} actions exceeds maxActions ${maxActions}`,
    };
  }

  return null;
}

export function evaluateProjectPolicyAction(action: FileAction, state: ProjectPolicyState): ProjectPolicyDecision | null {
  const failure = projectPolicyFailure(state);
  if (failure) return failure;

  const policy = state.policy;
  if (!policy) return null;

  const limits = policy.limits;
  if (limits?.allowedOperations && !limits.allowedOperations.includes(action.operation)) {
    return {
      risk: 'block',
      reason: `Project policy blocks ${action.operation} operations: ${action.path}`,
    };
  }

  if (limits?.allowDeletes === false && action.operation === 'DELETE') {
    return {
      risk: 'block',
      reason: `Project policy blocks deletes: ${action.path}`,
    };
  }

  const maxBytes = limits?.maxActionContentBytes;
  if (maxBytes !== undefined && isWritableAction(action)) {
    const bytes = Buffer.byteLength(action.content ?? '', 'utf8');
    if (bytes > maxBytes) {
      return {
        risk: 'block',
        reason: `Project policy blocks large writes for ${action.path}: ${bytes} bytes exceeds ${maxBytes}`,
      };
    }
  }

  const normalizedPath = normalizePolicyPath(action.path);
  const blockMatch = firstMatchingPattern(policy.block ?? [], normalizedPath);
  if (blockMatch) {
    return {
      risk: 'block',
      reason: `Project policy blocks ${action.path} (matched ${blockMatch})`,
    };
  }

  const confirmMatch = firstMatchingPattern(policy.confirm ?? [], normalizedPath);
  if (confirmMatch) {
    return {
      risk: 'confirm',
      reason: `Project policy requires confirmation for ${action.path} (matched ${confirmMatch})`,
    };
  }

  return null;
}

function projectPolicyFailure(state: ProjectPolicyState): ProjectPolicyDecision | null {
  if (state.errors.length === 0) return null;
  return {
    risk: 'block',
    reason: `Project policy is invalid: ${state.errors.join('; ')}`,
  };
}

function validateProjectPolicy(value: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(value)) {
    return [`${PROJECT_POLICY_FILE} must contain a JSON object.`];
  }

  if (value.version !== undefined && value.version !== PROJECT_POLICY_VERSION) {
    errors.push(`version must be ${PROJECT_POLICY_VERSION}.`);
  }

  errors.push(...validatePatternList(value.block, 'block'));
  errors.push(...validatePatternList(value.confirm, 'confirm'));
  errors.push(...validateChecks(value.checks));

  if (value.limits !== undefined) {
    if (!isRecord(value.limits)) {
      errors.push('limits must be an object.');
    } else {
      errors.push(...validateLimits(value.limits));
    }
  }

  return errors;
}

function validatePatternList(value: unknown, key: 'block' | 'confirm'): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return [`${key} must be an array of glob patterns.`];
  if (value.length > MAX_POLICY_PATTERNS) return [`${key} must contain ${MAX_POLICY_PATTERNS} patterns or fewer.`];

  const errors: string[] = [];
  for (const pattern of value) {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      errors.push(`${key} patterns must be non-empty strings.`);
      continue;
    }
    if (pattern.length > MAX_PATTERN_LENGTH) {
      errors.push(`${key} pattern is too long: ${pattern.slice(0, 40)}...`);
    }
  }
  return errors;
}

function validateChecks(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['checks must be an array of { name, command } objects.'];
  if (value.length > MAX_POLICY_CHECKS) return [`checks must contain ${MAX_POLICY_CHECKS} entries or fewer.`];

  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      errors.push('each check must be an object with name and command.');
      continue;
    }
    const name = entry.name;
    const command = entry.command;
    if (typeof name !== 'string' || name.trim().length === 0) {
      errors.push('check.name must be a non-empty string.');
    } else if (name.length > MAX_CHECK_NAME_LENGTH) {
      errors.push(`check.name is too long: ${name.slice(0, 20)}...`);
    } else if (seen.has(name.trim())) {
      errors.push(`duplicate check name: ${name.trim()}`);
    } else {
      seen.add(name.trim());
    }
    if (typeof command !== 'string' || command.trim().length === 0) {
      errors.push('check.command must be a non-empty string.');
    } else if (command.length > MAX_CHECK_COMMAND_LENGTH) {
      errors.push('check.command is too long.');
    }
  }
  return errors;
}

function validateLimits(value: Record<string, unknown>): string[] {
  const errors: string[] = [];

  if (value.allowDeletes !== undefined && typeof value.allowDeletes !== 'boolean') {
    errors.push('limits.allowDeletes must be a boolean.');
  }

  if (value.maxActions !== undefined) {
    const maxActions = value.maxActions;
    if (typeof maxActions !== 'number' || !Number.isInteger(maxActions) || maxActions < 1 || maxActions > MAX_POLICY_ACTIONS) {
      errors.push(`limits.maxActions must be an integer from 1 to ${MAX_POLICY_ACTIONS}.`);
    }
  }

  if (value.maxActionContentBytes !== undefined) {
    const maxBytes = value.maxActionContentBytes;
    if (typeof maxBytes !== 'number' || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_WRITABLE_ACTION_CONTENT_BYTES) {
      errors.push(`limits.maxActionContentBytes must be an integer from 1 to ${MAX_WRITABLE_ACTION_CONTENT_BYTES}.`);
    }
  }

  if (value.allowedOperations !== undefined) {
    if (!Array.isArray(value.allowedOperations)) {
      errors.push('limits.allowedOperations must be an array.');
    } else {
      for (const op of value.allowedOperations) {
        if (typeof op !== 'string' || !VALID_OPERATIONS.has(op as ProjectPolicyOperation)) {
          errors.push('limits.allowedOperations may only include CREATE, MODIFY, DELETE, or READ.');
          break;
        }
      }
    }
  }

  return errors;
}

function normalizeProjectPolicy(policy: ProjectPolicy): ProjectPolicy {
  const normalized: ProjectPolicy = {
    version: policy.version ?? PROJECT_POLICY_VERSION,
    block: normalizePatterns(policy.block),
    confirm: normalizePatterns(policy.confirm),
  };

  if (policy.limits) {
    normalized.limits = {
      ...policy.limits,
      allowedOperations: policy.limits.allowedOperations
        ? [...new Set(policy.limits.allowedOperations)]
        : undefined,
    };
  }

  if (policy.checks) {
    normalized.checks = policy.checks.map((check) => ({
      name: check.name.trim(),
      command: check.command.trim(),
    }));
  }

  return normalized;
}

export function getDeclaredChecks(state: ProjectPolicyState): ProjectPolicyCheck[] {
  return state.policy?.checks ?? [];
}

function normalizePatterns(patterns?: string[]): string[] {
  return (patterns ?? []).map((pattern) => normalizePolicyPath(pattern)).filter(Boolean);
}

function firstMatchingPattern(patterns: string[], normalizedPath: string): string | null {
  for (const pattern of patterns) {
    if (matchesPolicyPattern(pattern, normalizedPath)) return pattern;
  }
  return null;
}

function matchesPolicyPattern(pattern: string, normalizedPath: string): boolean {
  const patternSegments = normalizePolicyPath(pattern).split('/').filter(Boolean);
  const pathSegments = normalizePolicyPath(normalizedPath).split('/').filter(Boolean);
  const memo = new Map<string, boolean>();

  const match = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let result: boolean;
    if (patternIndex === patternSegments.length) {
      result = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === '**') {
      result = match(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length && match(patternIndex, pathIndex + 1));
    } else {
      result = pathIndex < pathSegments.length &&
        matchSegment(patternSegments[patternIndex]!, pathSegments[pathIndex]!) &&
        match(patternIndex + 1, pathIndex + 1);
    }

    memo.set(key, result);
    return result;
  };

  return match(0, 0);
}

function matchSegment(pattern: string, text: string): boolean {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  let patternIndex = 0;
  let textIndex = 0;
  let starIndex = -1;
  let starTextIndex = 0;

  while (textIndex < t.length) {
    if (patternIndex < p.length && (p[patternIndex] === '?' || p[patternIndex] === t[textIndex])) {
      patternIndex++;
      textIndex++;
    } else if (patternIndex < p.length && p[patternIndex] === '*') {
      starIndex = patternIndex;
      starTextIndex = textIndex;
      patternIndex++;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starTextIndex++;
      textIndex = starTextIndex;
    } else {
      return false;
    }
  }

  while (patternIndex < p.length && p[patternIndex] === '*') {
    patternIndex++;
  }

  return patternIndex === p.length;
}

function normalizePolicyPath(filePath: string): string {
  let normalized = filePath.split('\\').join('/').trim();

  if (normalized.startsWith('./')) {
    let start = 2;
    while (normalized[start] === '/') start++;
    normalized = normalized.slice(start);
  }

  let end = normalized.length;
  while (end > 0 && normalized[end - 1] === '/') end--;
  return normalized.slice(0, end);
}

function isWritableAction(action: FileAction): boolean {
  return (action.operation === 'CREATE' || action.operation === 'MODIFY') && action.content !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
