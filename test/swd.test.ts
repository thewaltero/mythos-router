import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseFileActions,
  verifyAction,
  resolveSafePath,
  snapshotFile,
  snapshotFiles,
  runSWD,
  type FileAction,
  type FileSnapshot,
} from '../src/swd.js';


describe('parseFileActions', () => {
  it('parses a valid CREATE action block', () => {
    const output = `
[FILE_ACTION: src/hello.ts]
OPERATION: CREATE
CONTENT_HASH: abc123def456
DESCRIPTION: Create hello module
[/FILE_ACTION]
`;
    const actions = parseFileActions(output);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.path, 'src/hello.ts');
    assert.equal(actions[0]!.operation, 'CREATE');
    assert.equal(actions[0]!.contentHash, 'abc123def456');
    assert.equal(actions[0]!.description, 'Create hello module');
  });

  it('parses multiple action blocks', () => {
    const output = `
[FILE_ACTION: src/a.ts]
OPERATION: CREATE
DESCRIPTION: Create A
[/FILE_ACTION]

Some text in between.

[FILE_ACTION: src/b.ts]
OPERATION: MODIFY
DESCRIPTION: Modify B
[/FILE_ACTION]

[FILE_ACTION: src/c.ts]
OPERATION: DELETE
DESCRIPTION: Remove C
[/FILE_ACTION]
`;
    const actions = parseFileActions(output);
    assert.equal(actions.length, 3);
    assert.equal(actions[0]!.operation, 'CREATE');
    assert.equal(actions[1]!.operation, 'MODIFY');
    assert.equal(actions[2]!.operation, 'DELETE');
  });

  it('returns empty array when no actions are present', () => {
    const actions = parseFileActions('Just a normal response with no file actions.');
    assert.equal(actions.length, 0);
  });

  it('returns empty array for empty string', () => {
    const actions = parseFileActions('');
    assert.equal(actions.length, 0);
  });

  it('handles optional CONTENT_HASH field', () => {
    const output = `
[FILE_ACTION: src/test.ts]
OPERATION: MODIFY
DESCRIPTION: Update test file
[/FILE_ACTION]
`;
    const actions = parseFileActions(output);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.contentHash, undefined);
  });

  it('handles READ operations', () => {
    const output = `
[FILE_ACTION: src/config.ts]
OPERATION: READ
DESCRIPTION: Read configuration
[/FILE_ACTION]
`;
    const actions = parseFileActions(output);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.operation, 'READ');
  });

  it('is case-insensitive for operation names', () => {
    const output = `
[FILE_ACTION: src/test.ts]
OPERATION: create
DESCRIPTION: Test case insensitivity
[/FILE_ACTION]
`;
    const actions = parseFileActions(output);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.operation, 'CREATE');
  });

  it('parses CONTENT field correctly including multi-line text', () => {
    const output = `
[FILE_ACTION: src/app.ts]
OPERATION: CREATE
DESCRIPTION: New app entry
CONTENT:
import { Server } from 'node:http';
const s = new Server();
s.listen(8080);
[/FILE_ACTION]
`;
    const actions = parseFileActions(output);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.path, 'src/app.ts');
    assert.ok(actions[0]!.content?.includes('import { Server }'));
    assert.ok(actions[0]!.content?.includes('s.listen(8080)'));
  });
});


describe('resolveSafePath', () => {
  it('resolves a relative path within the project', () => {
    const result = resolveSafePath('src/hello.ts');
    assert.ok(result.endsWith('src/hello.ts') || result.endsWith('src\\hello.ts'));
  });

  it('blocks path traversal with ../', () => {
    assert.throws(
      () => resolveSafePath('../../../etc/passwd'),
      /SECURITY VIOLATION/,
    );
  });

  it('blocks path traversal disguised in nested paths', () => {
    assert.throws(
      () => resolveSafePath('src/../../outside'),
      /SECURITY VIOLATION/,
    );
  });

  it('accepts current directory paths', () => {
    const result = resolveSafePath('./src/config.ts');
    assert.ok(result.includes('src'));
  });
});


describe('snapshotFile', () => {
  const testDir = join(process.cwd(), 'test', '.tmp-swd');
  const testFile = join(testDir, 'snapshot-test.txt');

  it('returns exists=false for non-existent file', () => {
    const snap = snapshotFile('/this/path/does/not/exist.txt');
    assert.equal(snap.exists, false);
    assert.equal(snap.size, 0);
    assert.equal(snap.hash, '');
  });

  it('returns correct data for an existing file', () => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testFile, 'hello world', 'utf-8');

    try {
      const snap = snapshotFile(testFile);
      assert.equal(snap.exists, true);
      assert.equal(snap.size, 11); // 'hello world' is 11 bytes
      assert.ok(snap.hash.length === 64); // SHA-256 hex is 64 chars
      assert.ok(snap.mtime > 0);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});


describe('snapshotFiles', () => {
  it('returns a Map of snapshots', () => {
    const result = snapshotFiles(['/nonexistent/a.txt', '/nonexistent/b.txt']);
    assert.ok(result instanceof Map);
    assert.equal(result.size, 2);
  });
});


describe('verifyAction', () => {
  const makeSnap = (overrides: Partial<FileSnapshot> = {}): FileSnapshot => ({
    path: '/test/file.ts',
    exists: true,
    size: 100,
    mtime: Date.now(),
    hash: 'aabbccdd',
    content: null,
    ...overrides,
  } as FileSnapshot);

  it('verifies a successful CREATE', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'CREATE',
      description: 'Create test file',
    };
    const before = makeSnap({ exists: false, size: 0, hash: '' });
    const after = makeSnap({ exists: true, size: 50, hash: 'newfilehash' });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'verified');
  });

  it('fails CREATE when file does not exist afterward', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'CREATE',
      description: 'Create test file',
    };
    const before = makeSnap({ exists: false, size: 0, hash: '' });
    const after = makeSnap({ exists: false, size: 0, hash: '' });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'failed');
  });

  it('detects drift when CREATE targets existing file', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'CREATE',
      description: 'Create test file',
    };
    const before = makeSnap({ exists: true });
    const after = makeSnap({ exists: true });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'drift');
  });

  it('verifies a successful MODIFY', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'MODIFY',
      description: 'Update file',
    };
    const before = makeSnap({ hash: 'oldhash', size: 100 });
    const after = makeSnap({ hash: 'newhash', size: 150 });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'verified');
  });

  it('detects drift when MODIFY produces no change', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'MODIFY',
      description: 'Update file',
    };
    const before = makeSnap({ hash: 'samehash' });
    const after = makeSnap({ hash: 'samehash' });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'drift');
  });

  it('verifies a successful DELETE', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'DELETE',
      description: 'Remove file',
    };
    const before = makeSnap({ exists: true });
    const after = makeSnap({ exists: false, size: 0, hash: '' });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'verified');
  });

  it('fails DELETE when file still exists', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'DELETE',
      description: 'Remove file',
    };
    const before = makeSnap({ exists: true });
    const after = makeSnap({ exists: true });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'failed');
  });

  it('verifies a successful READ', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'READ',
      description: 'Read file',
    };
    const before = makeSnap({ exists: true });
    const after = makeSnap({ exists: true });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'verified');
  });

  it('fails READ when file does not exist', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'READ',
      description: 'Read file',
    };
    const before = makeSnap({ exists: false });
    const after = makeSnap({ exists: false });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'failed');
  });

  it('detects content hash mismatch on CREATE', () => {
    const action: FileAction = {
      path: 'test/file.ts',
      operation: 'CREATE',
      contentHash: 'expectedhash1234',
      description: 'Create with hash',
    };
    const before = makeSnap({ exists: false, size: 0, hash: '' });
    const after = makeSnap({ exists: true, hash: 'differenthash999' });

    const result = verifyAction(action, before, after);
    assert.equal(result.status, 'drift');
  });
});


describe('runSWD', () => {
  it('returns verified=true when no FILE_ACTION blocks are found', () => {
    const result = runSWD('Just a normal response.', new Map());
    assert.equal(result.verified, true);
    assert.equal(result.actions.length, 0);
  });

  it('performs atomic rollbacks on failed verification', () => {
    const testDir = join(process.cwd(), 'test', '.tmp-swd-rollback');
    mkdirSync(testDir, { recursive: true });
    
    // Create pre-existing file state
    const file1Path = join(testDir, 'file1.txt');
    const file2Path = join(testDir, 'file2.txt');
    writeFileSync(file1Path, 'original file 1', 'utf-8');
    writeFileSync(file2Path, 'original file 2', 'utf-8');

    // Simulate taking the "before" snapshot
    const beforeSnapshots = snapshotFiles([file1Path, file2Path]);

    // Simulate "agent or user" modifying the files during the turn
    writeFileSync(file1Path, 'modified file 1', 'utf-8'); // Drift
    writeFileSync(file2Path, 'modified file 2', 'utf-8'); // Will fail because size/hash mismatch for say file 2

    // Provide model output that triggers runSWD
    const output = `
[FILE_ACTION: ${file1Path}]
OPERATION: MODIFY
DESCRIPTION: Modify 1
[/FILE_ACTION]

[FILE_ACTION: ${file2Path}]
OPERATION: MODIFY
CONTENT_HASH: badhash123
DESCRIPTION: Modify 2
[/FILE_ACTION]
`;

    // runSWD should fail verification because file2 has badhash123,
    // and both file1 and file2 should be rolled back to "original"
    const result = runSWD(output, beforeSnapshots);

    assert.equal(result.verified, false);
    assert.equal(result.rollbacks?.length, 2, 'Should have rolled back both files');

    // Read files back to ensure they were restored
    const f1 = readFileSync(file1Path, 'utf-8');
    const f2 = readFileSync(file2Path, 'utf-8');

    assert.equal(f1, 'original file 1');
    assert.equal(f2, 'original file 2');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('rolls back newly created hallucinated files', () => {
    const testDir = join(process.cwd(), 'test', '.tmp-swd-rollback-new');
    mkdirSync(testDir, { recursive: true });
    
    const newFilePath = join(testDir, 'newfile.txt');

    // Simulate taking the "before" snapshot (does not exist)
    const beforeSnapshots = snapshotFiles([newFilePath]);

    // Simulate "agent or user" creating the file during the turn
    writeFileSync(newFilePath, 'new hallucinated file', 'utf-8');

    // Provide model output
    const output = `
[FILE_ACTION: ${newFilePath}]
OPERATION: CREATE
CONTENT_HASH: badhash123
DESCRIPTION: Create new
[/FILE_ACTION]
`;

    // runSWD should fail verification and rollback the new file by deleting it
    const result = runSWD(output, beforeSnapshots);

    assert.equal(result.verified, false);
    assert.equal(result.rollbacks?.length, 1);

    // Read files back to ensure it was deleted
    const exists = existsSync(newFilePath);
    assert.equal(exists, false, 'File should have been deleted during rollback');

    rmSync(testDir, { recursive: true, force: true });
  });
});
