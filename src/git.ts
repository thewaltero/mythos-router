// ─────────────────────────────────────────────────────────────
//  mythos-router :: git.ts
//  Primitive Git operations (zero-dependency)
// ─────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';

/**
 * Checks if the current working directory is inside a Git repository.
 */
export function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
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
    const status = execSync('git status --porcelain', { encoding: 'utf-8' }).trim();
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
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Creates and checks out a new Git branch.
 * Throws on failure.
 */
export function createAndCheckoutBranch(name: string): void {
  try {
    execSync(`git checkout -b ${name}`, { stdio: 'ignore' });
  } catch (err: any) {
    throw new Error(`Git checkout failed: ${err.message}`);
  }
}

/**
 * Commits all changes in the working tree.
 * Runs 'git add -A' and 'git commit -m <message>'.
 */
export function commitChanges(message: string): void {
  try {
    execSync('git add -A', { stdio: 'ignore' });
    execSync(`git commit -m "${message}"`, { stdio: 'ignore' });
  } catch (err: any) {
    throw new Error(`Git commit failed: ${err.message}`);
  }
}

/**
 * Returns the current HEAD commit hash.
 */
export function getLatestHash(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}
