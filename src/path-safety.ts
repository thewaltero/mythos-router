import { isAbsolute } from 'node:path';

export const DEFAULT_MAX_RELATIVE_PATH_LENGTH = 500;

export interface RelativePathSafetyOptions {
  maxLength?: number;
}

export function normalizeRelativePath(input: string): string {
  return input.replace(/\\/g, '/').trim();
}

/**
 * Shared path-shape guard for SWD action paths and contract/policy patterns.
 * Segment-based: real parent traversal (`..` as a full path segment) is
 * rejected, while normal filenames like `backup..old.ts` are allowed.
 */
export function isSafeRelativePathShape(input: string, options: RelativePathSafetyOptions = {}): boolean {
  const maxLength = options.maxLength ?? DEFAULT_MAX_RELATIVE_PATH_LENGTH;
  const normalized = normalizeRelativePath(input);

  if (normalized.length === 0) return false;
  if (normalized.length > maxLength) return false;
  if (normalized.includes('\0')) return false;

  // Reject POSIX absolutes, Windows drive absolutes, and UNC-style paths
  // regardless of the OS this validator is currently running on.
  if (normalized.startsWith('/') || normalized.startsWith('//')) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;
  if (isAbsolute(input) || isAbsolute(normalized)) return false;

  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) return false;

  return true;
}

export function assertSafeRelativePathShape(
  input: unknown,
  label = 'path',
  options: RelativePathSafetyOptions = {},
): string {
  if (typeof input !== 'string') {
    throw new Error(`Invalid ${label}: must be a string.`);
  }

  const normalized = normalizeRelativePath(input);
  if (!isSafeRelativePathShape(normalized, options)) {
    throw new Error(`Invalid ${label}: ${input}`);
  }

  return normalized;
}
