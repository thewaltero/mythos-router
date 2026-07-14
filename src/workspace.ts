// ─────────────────────────────────────────────────────────────
//  mythos-router :: workspace.ts
//  Immutable, canonical project identity for all repository-scoped state.
// ─────────────────────────────────────────────────────────────

import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export interface WorkspaceContextOptions {
  rootDir?: string;
  homeDir?: string;
}

export type WorkspaceInput = WorkspaceContext | string | undefined;

/**
 * Captures a repository root exactly once so embedded or parallel Mythos
 * operations never depend on later process.cwd() changes.
 */
export class WorkspaceContext {
  public readonly rootDir: string;
  public readonly projectName: string;
  public readonly projectId: string;
  public readonly homeDir: string;
  public readonly userStateDir: string;
  public readonly sessionsDir: string;

  constructor(options: WorkspaceContextOptions = {}) {
    const requestedRoot = resolve(options.rootDir ?? process.cwd());
    const stat = lstatSync(requestedRoot);
    if (!stat.isDirectory()) {
      throw new Error(`Workspace root is not a directory: ${requestedRoot}`);
    }

    this.rootDir = realpathSync(requestedRoot);
    this.projectName = basename(this.rootDir) || 'workspace';
    this.projectId = createProjectId(this.projectName, this.rootDir);
    this.homeDir = resolve(options.homeDir ?? homedir());
    this.userStateDir = join(this.homeDir, '.mythos-router');
    this.sessionsDir = join(this.userStateDir, 'sessions', this.projectId);
  }

  public resolve(...segments: string[]): string {
    return resolve(this.rootDir, ...segments);
  }
}

export function createWorkspaceContext(
  rootDir = process.cwd(),
  options: Omit<WorkspaceContextOptions, 'rootDir'> = {},
): WorkspaceContext {
  return new WorkspaceContext({ ...options, rootDir });
}

export function resolveWorkspace(input?: WorkspaceInput): WorkspaceContext {
  if (input instanceof WorkspaceContext) return input;
  return new WorkspaceContext({ rootDir: input });
}

function trimBoundaryHyphens(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value.charCodeAt(start) === 45) {
    start += 1;
  }

  while (end > start && value.charCodeAt(end - 1) === 45) {
    end -= 1;
  }

  if (start === 0 && end === value.length) {
    return value;
  }

  return value.slice(start, end);
}

function createProjectId(projectName: string, canonicalRoot: string): string {
  const normalizedName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  const slug = trimBoundaryHyphens(normalizedName).slice(0, 48) || 'workspace';
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
  return `${slug}-${digest}`;
}
