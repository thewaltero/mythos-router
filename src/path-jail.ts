import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { assertSafeRelativePathShape } from './path-safety.js';

function isContainedRelativePath(relativePath: string): boolean {
  return relativePath === '' || (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !relativePath.startsWith('../') &&
    !isAbsolute(relativePath)
  );
}

function securityViolation(message: string): Error {
  return new Error(`SECURITY VIOLATION: ${message}`);
}

/**
 * A canonical, immutable filesystem boundary for SWD operations.
 *
 * The jail deliberately rejects symbolic links in every existing component of
 * an action path. That policy is stricter than merely checking the final
 * realpath, but it prevents a writable ancestor from redirecting a later
 * CREATE/MODIFY/DELETE outside the repository.
 */
export class PathJail {
  public readonly root: string;
  private readonly requestedRoot: string;

  constructor(rootDir: string = process.cwd()) {
    this.requestedRoot = resolve(rootDir);

    try {
      this.root = realpathSync(this.requestedRoot);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to establish SWD root '${rootDir}': ${detail}`);
    }

    try {
      if (!statSync(this.root).isDirectory()) {
        throw new Error('root is not a directory');
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to establish SWD root '${rootDir}': ${detail}.`);
    }
  }

  /**
   * Resolve an action path inside the canonical root and reject every existing
   * symbolic-link component. Missing suffixes are allowed for CREATE actions;
   * their existing prefix is still fully checked.
   */
  public resolve(unsafePath: string): string {
    const rawPath = unsafePath.trim();
    if (rawPath.length === 0 || rawPath.includes('\0')) {
      throw securityViolation(`Path traversal detected on '${unsafePath}'.`);
    }

    let candidate: string;
    if (isAbsolute(rawPath)) {
      candidate = this.translateAbsolutePath(rawPath, unsafePath);
    } else {
      let safeRelativePath: string;
      try {
        safeRelativePath = assertSafeRelativePathShape(rawPath.replace(/\\/g, '/'), 'action path');
      } catch {
        throw securityViolation(`Path traversal detected on '${unsafePath}'.`);
      }
      candidate = resolve(this.root, safeRelativePath);
    }

    this.assertContained(candidate, unsafePath);
    this.assertNoSymlinkComponents(candidate, unsafePath);
    return candidate;
  }

  /**
   * Create missing parent directories one component at a time. Each component
   * is checked before and after creation, so recursive mkdir never follows an
   * already-present symlink. Returned paths are deepest-first for rollback.
   */
  public ensureParentDirectories(
    targetPath: string,
    onCreated?: (directory: string) => void,
  ): string[] {
    const safeTarget = this.resolve(targetPath);
    const parentRelative = relative(this.root, resolve(safeTarget, '..'));
    if (parentRelative === '') return [];

    const created: string[] = [];
    let current = this.root;

    for (const segment of parentRelative.split(sep).filter(Boolean)) {
      current = resolve(current, segment);
      this.assertContained(current, targetPath);

      try {
        const entry = lstatSync(current);
        if (entry.isSymbolicLink()) {
          throw securityViolation(`Symlink traversal is not allowed for '${targetPath}' at '${current}'.`);
        }
        if (!entry.isDirectory()) {
          throw securityViolation(`Parent component is not a directory for '${targetPath}' at '${current}'.`);
        }
        continue;
      } catch (error: unknown) {
        if (!isMissingPathError(error)) throw error;
      }

      try {
        mkdirSync(current);
        created.push(current);
        onCreated?.(current);
      } catch (error: unknown) {
        // Another process may have created the component after our lstat.
        if (!isAlreadyExistsError(error)) throw error;
      }

      const createdEntry = lstatSync(current);
      if (createdEntry.isSymbolicLink() || !createdEntry.isDirectory()) {
        throw securityViolation(`Unsafe parent component appeared for '${targetPath}' at '${current}'.`);
      }
    }

    // Re-check the complete target after creating parents. This catches a
    // symlink introduced into any component between preflight and mutation.
    this.resolve(safeTarget);
    return created.reverse();
  }

  private translateAbsolutePath(rawPath: string, originalPath: string): string {
    const absolutePath = resolve(rawPath);
    const fromCanonicalRoot = relative(this.root, absolutePath);
    if (isContainedRelativePath(fromCanonicalRoot)) return absolutePath;

    // If rootDir itself was reached through a symlink, callers may still pass
    // an absolute path using that original spelling. Translate it into the
    // canonical root before applying the component checks.
    const fromRequestedRoot = relative(this.requestedRoot, absolutePath);
    if (isContainedRelativePath(fromRequestedRoot)) {
      return resolve(this.root, fromRequestedRoot);
    }

    throw securityViolation(`Path traversal detected on '${originalPath}'.`);
  }

  private assertContained(candidate: string, originalPath: string): void {
    const fromRoot = relative(this.root, candidate);
    if (!isContainedRelativePath(fromRoot) || fromRoot === '') {
      throw securityViolation(`Path traversal detected on '${originalPath}'.`);
    }
  }

  private assertNoSymlinkComponents(candidate: string, originalPath: string): void {
    const fromRoot = relative(this.root, candidate);
    let current = this.root;
    const segments = fromRoot.split(sep).filter(Boolean);

    for (let index = 0; index < segments.length; index += 1) {
      current = resolve(current, segments[index]!);
      try {
        const entry = lstatSync(current);
        if (entry.isSymbolicLink()) {
          throw securityViolation(`Symlink traversal is not allowed for '${originalPath}' at '${current}'.`);
        }
        if (index < segments.length - 1 && !entry.isDirectory()) {
          throw securityViolation(`Parent component is not a directory for '${originalPath}' at '${current}'.`);
        }
      } catch (error: unknown) {
        if (isMissingPathError(error)) return;
        throw error;
      }
    }
  }
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
