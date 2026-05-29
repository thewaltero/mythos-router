// ─────────────────────────────────────────────────────────────
//  mythos-router :: sandbox.ts
//  Isolated Runs — apply + check a batch in a throwaway copy
//  BEFORE it is allowed to touch the real working tree.
//
//  Security model:
//  - The sandbox is a mirror copy of the project in a 0700 temp dir.
//  - node_modules is symlinked (not copied) so checks run without a
//    reinstall; .git / dist are excluded as regenerable/irrelevant.
//  - Every write is jailed: the resolved real path of the target's
//    parent MUST stay inside the sandbox root, so a copied symlink
//    cannot redirect a write outside the jail.
//  - Check commands are NEVER derived from untrusted content. They are
//    only the explicit, caller-supplied commands (same trust level as
//    the existing --test-cmd escape hatch). A policy file alone never
//    causes command execution.
//  - The sandbox is always removed in a finally block. rmSync unlinks
//    the node_modules symlink itself; it never recurses into the real
//    node_modules.
// ─────────────────────────────────────────────────────────────

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runTestCommand } from './utils.js';
import type { FileAction } from './swd.js';

// Names skipped when mirroring the tree (regenerable or symlinked).
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', 'dist']);

// Guardrail against mirroring a pathological tree into temp.
const MAX_SANDBOX_FILES = 20_000;

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

export interface SandboxCheck {
  name: string;
  command: string;
}

export interface SandboxCheckResult {
  name: string;
  command: string;
  passed: boolean;
  outputTail: string;
}

export interface SandboxOptions {
  checks: SandboxCheck[];
  checkTimeoutMs?: number;
  cwd?: string;
}

export interface SandboxRunResult {
  ok: boolean;
  ranChecks: boolean;
  checks: SandboxCheckResult[];
  filesCopied: number;
  /** Populated only when the sandbox itself failed to set up or apply. */
  setupError?: string;
}

const CHECK_OUTPUT_TAIL_MAX = 1200;

/**
 * Resolve `relPath` strictly inside `root`. Rejects traversal and any
 * symlink whose parent escapes the jail. Mirrors swd.ts:resolveSafePath
 * but is rooted at the sandbox rather than process.cwd().
 */
function resolveWithinRoot(root: string, relPath: string): string {
  const abs = resolve(root, relPath);

  // Resolve the real path of the deepest existing ancestor so a symlink
  // planted in the mirrored tree cannot redirect the write outside root.
  let probe = abs;
  let realProbe = abs;
  while (true) {
    if (existsSync(probe)) {
      realProbe = realpathSync(probe);
      // Re-append the part of the path that does not yet exist.
      const tail = relative(probe, abs);
      realProbe = tail ? join(realProbe, tail) : realProbe;
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break; // reached filesystem root
    probe = parent;
  }

  const realRoot = realpathSync(root);
  const rel = relative(realRoot, realProbe);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Sandbox jail violation for '${relPath}'.`);
  }
  return abs;
}

/**
 * Recursively mirror `src` into `dest`, skipping excluded directory names.
 * Returns the number of files copied. Throws if the file cap is exceeded.
 */
function mirrorTree(src: string, dest: string): number {
  let copied = 0;

  const walk = (fromDir: string, toDir: string): void => {
    const entries = readdirSync(fromDir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;

      const fromPath = join(fromDir, entry.name);
      const toPath = join(toDir, entry.name);

      if (entry.isDirectory()) {
        mkdirSync(toPath, { recursive: true });
        walk(fromPath, toPath);
      } else if (entry.isFile()) {
        if (++copied > MAX_SANDBOX_FILES) {
          throw new Error(
            `Project exceeds the sandbox file cap (${MAX_SANDBOX_FILES}). ` +
            `Add large directories to .gitignore/.mythosignore or skip isolated runs.`,
          );
        }
        // cpSync preserves contents; symlinks are dereferenced into regular
        // files here, which is safe because we never write through them.
        cpSync(fromPath, toPath, { dereference: true });
      }
      // Sockets/FIFOs/devices are intentionally not mirrored.
    }
  };

  walk(src, dest);
  return copied;
}

/** Symlink the real node_modules into the sandbox so checks need no reinstall. */
function linkNodeModules(root: string, sandbox: string): void {
  const realModules = join(root, 'node_modules');
  if (!existsSync(realModules)) return;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    symlinkSync(realpathSync(realModules), join(sandbox, 'node_modules'), linkType);
  } catch {
    // Non-fatal: checks may still work, just slower / may need install.
  }
}

/** Apply approved actions inside the sandbox using the jailed resolver. */
function applyActionsInSandbox(sandbox: string, actions: FileAction[]): void {
  for (const action of actions) {
    const target = resolveWithinRoot(sandbox, action.path);
    switch (action.operation) {
      case 'CREATE':
      case 'MODIFY':
        if (action.content !== undefined) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, action.content);
        }
        break;
      case 'DELETE':
        if (existsSync(target)) unlinkSync(target);
        break;
      case 'READ':
        break;
    }
  }
}

/**
 * Mirror the project, apply `actions` in the copy, run `checks` there, and
 * report the outcome. The real working tree is never touched. The caller
 * decides whether to promote the change based on `result.ok`.
 */
export async function runActionsInSandbox(
  actions: FileAction[],
  options: SandboxOptions,
): Promise<SandboxRunResult> {
  const root = realpathSync(options.cwd ?? process.cwd());
  const checks = options.checks ?? [];
  const timeout = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  // mkdtempSync creates the dir with 0700 perms by default on POSIX.
  // realpath it so the jail comparison is immune to /tmp -> /private/tmp.
  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'mythos-sandbox-')));

  try {
    const filesCopied = mirrorTree(root, sandbox);
    linkNodeModules(root, sandbox);
    applyActionsInSandbox(sandbox, actions);

    const results: SandboxCheckResult[] = [];
    for (const check of checks) {
      const outcome = await runTestCommand(check.command, timeout, sandbox);
      results.push({
        name: check.name,
        command: check.command,
        passed: outcome.passed,
        outputTail: outcome.output.slice(-CHECK_OUTPUT_TAIL_MAX),
      });
      // Fail fast: stop at the first failing gate.
      if (!outcome.passed) break;
    }

    const ranChecks = checks.length > 0;
    const ok = results.every((r) => r.passed);
    return { ok, ranChecks, checks: results, filesCopied };
  } catch (err) {
    return {
      ok: false,
      ranChecks: checks.length > 0,
      checks: [],
      filesCopied: 0,
      setupError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (sandbox) {
      try {
        rmSync(sandbox, { recursive: true, force: true });
      } catch {
        // Best effort; OS temp reaping will reclaim it.
      }
    }
  }
}
