// ─────────────────────────────────────────────────────────────
//  mythos-router :: git.ts
//  Primitive Git operations (zero-dependency)
//
//  Security: All commands use execFileSync with argument arrays
//  to prevent shell injection. No shell interpolation allowed.
// ─────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';

// ── Branch Name Validation ─────────────────────────────────
// Git ref names: no space, ~, ^, :, ?, *, [, \, control chars, "..", "@{", trailing ".", leading "-"
const BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*[a-zA-Z0-9]$/;

function validateBranchName(name: string): void {
  if (!name || name.length > 255) {
    throw new Error(`Invalid branch name: too ${name ? 'long' : 'short'}.`);
  }
  if (!BRANCH_NAME_RE.test(name)) {
    throw new Error(
      `Invalid branch name: "${name}". ` +
      `Only alphanumeric, dots, hyphens, underscores, and forward slashes allowed. ` +
      `Must start and end with an alphanumeric character.`,
    );
  }
  if (name.includes('..') || name.includes('@{')) {
    throw new Error(`Invalid branch name: "${name}" contains forbidden sequence.`);
  }
}

function validateCommitMessage(message: string): void {
  if (!message || message.length > 1000) {
    throw new Error(`Invalid commit message: too ${message ? 'long' : 'short'}.`);
  }
}

/**
 * Checks if the current working directory is inside a Git repository.
 */
export function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the current working directory has uncommitted changes.
 * Returns true if 'git status --porcelain' is non-empty.
 */
export function hasUncommittedChanges(): boolean {
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' }).trim();
    return status.length > 0;
  } catch {
    // If git status fails, consider it dirty/unsafe
    return true;
  }
}

/**
 * Returns the name of the current active Git branch.
 */
export function getCurrentBranch(): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Creates and checks out a new Git branch.
 * Validates branch name before execution. Throws on failure.
 */
export function createAndCheckoutBranch(name: string): void {
  validateBranchName(name);
  try {
    execFileSync('git', ['checkout', '-b', name], { stdio: 'ignore' });
  } catch (err: any) {
    throw new Error(`Git checkout failed: ${err.message}`);
  }
}

function normalizeGitPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw new Error(`Unsafe git path: ${filePath}`);
  }
  return normalized;
}

/**
 * Commits changes in the working tree.
 *
 * When paths are provided, only those paths are staged. This avoids capturing
 * unrelated user work during Mythos sandbox auto-commits. If no paths are
 * provided, falls back to the legacy full-tree behavior.
 */
export function commitChanges(message: string, paths?: string[]): void {
  validateCommitMessage(message);
  try {
    if (paths && paths.length > 0) {
      const uniquePaths = Array.from(new Set(paths.map(normalizeGitPath)));
      execFileSync('git', ['add', '--', ...uniquePaths], { stdio: 'ignore' });
    } else {
      execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
    }
    execFileSync('git', ['commit', '-m', message], { stdio: 'ignore' });
  } catch (err: any) {
    throw new Error(`Git commit failed: ${err.message}`);
  }
}

/**
 * Returns the current HEAD commit hash.
 */
export function getLatestHash(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}
