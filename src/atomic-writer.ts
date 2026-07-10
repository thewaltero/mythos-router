import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const TEMP_FILE_PREFIX = '.mythos-atomic-';
const MAX_TEMP_NAME_ATTEMPTS = 16;

export interface AtomicWriteOptions {
  /**
   * CREATE semantics: atomically publish the new file without replacing a
   * destination that appeared after preflight. MODIFY uses atomic replacement.
   */
  createOnly: boolean;
  /** Existing permission bits to preserve when replacing a file. */
  mode?: number;
  /** Validate the exclusively-created staging path before content is written. */
  afterTempCreated?: (tempPath: string) => void;
  /** Re-run path and concurrency guards immediately before the commit. */
  beforeCommit?: () => void;
  /** Called immediately after the target path has been committed. */
  onCommitted?: () => void;
}

/**
 * Same-directory atomic writer used by SWD CREATE and MODIFY operations.
 *
 * Content is written to an exclusive temporary file, flushed, and then
 * committed in one filesystem operation. CREATE uses link(2) + unlink so an
 * concurrently-created destination is never replaced; MODIFY uses rename(2)
 * for atomic replacement on the same filesystem.
 */
export class AtomicFileWriter {
  public write(targetPath: string, content: string | Buffer, options: AtomicWriteOptions): void {
    const directory = dirname(targetPath);
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const { fd, tempPath } = this.openTemporaryFile(directory, basename(targetPath), options.mode);
    let openFd: number | null = fd;
    let tempExists = true;

    try {
      options.afterTempCreated?.(tempPath);
      writeAll(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      openFd = null;

      options.beforeCommit?.();

      if (options.createOnly) {
        // linkSync is the no-replace commit primitive: unlike rename, it fails
        // with EEXIST if another process created the destination meanwhile.
        linkSync(tempPath, targetPath);
        options.onCommitted?.();
        unlinkSync(tempPath);
        tempExists = false;
      } else {
        renameSync(tempPath, targetPath);
        tempExists = false;
        options.onCommitted?.();
      }

      syncDirectoryBestEffort(directory);
    } catch (error: unknown) {
      if (openFd !== null) {
        try {
          closeSync(openFd);
        } catch {
          // Preserve the primary write/commit error.
        }
      }
      if (tempExists) {
        try {
          unlinkSync(tempPath);
        } catch {
          // A cleanup failure is intentionally secondary. The caller receives
          // the commit failure; stale temp files are independently detectable
          // by their reserved prefix.
        }
      }

      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Atomic write failed for ${targetPath}: ${detail}`, { cause: error });
    }
  }

  private openTemporaryFile(
    directory: string,
    targetName: string,
    mode?: number,
  ): { fd: number; tempPath: string } {
    for (let attempt = 0; attempt < MAX_TEMP_NAME_ATTEMPTS; attempt += 1) {
      const nonce = randomBytes(12).toString('hex');
      const tempPath = join(
        directory,
        `${TEMP_FILE_PREFIX}${process.pid}-${nonce}-${sanitizeTargetName(targetName)}.tmp`,
      );

      try {
        const fd = openSync(
          tempPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
          mode ?? 0o666,
        );
        if (mode !== undefined) fchmodSync(fd, mode & 0o7777);
        return { fd, tempPath };
      } catch (error: unknown) {
        if (isAlreadyExistsError(error)) continue;
        throw error;
      }
    }

    throw new Error(`Unable to allocate an exclusive temporary file in ${directory}.`);
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset, null);
    if (written <= 0) throw new Error('Filesystem write made no forward progress.');
    offset += written;
  }
}

function syncDirectoryBestEffort(directory: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The data and rename are already durable to the extent supported by
        // the platform. A directory-handle close failure is not actionable.
      }
    }
  }
}

function sanitizeTargetName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return sanitized || 'target';
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = String(error.code);
  if (['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(code)) return true;
  return process.platform === 'win32' && ['EACCES', 'EPERM'].includes(code);
}
