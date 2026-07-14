import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  WorkspaceContext,
  createWorkspaceContext,
} from '../src/workspace.js';
import {
  appendEntry,
  closeMemoryDatabase,
  initMemory,
  readMemory,
} from '../src/memory.js';
import { getSessionPaths, loadSession, saveSession, serializeSessionData } from '../src/session.js';
import { applyExternalAgentActions } from '../src/commands/swd.js';
import { handleMCPMessage } from '../src/mcp.js';
import { runActionsInSandbox } from '../src/sandbox.js';
import {
  getCurrentBranch,
  getLatestHash,
  hasUncommittedChanges,
  isGitRepo,
} from '../src/git.js';

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  // macOS exposes /var through the canonical /private/var path. process.cwd()
  // returns the canonical path after chdir(), so canonicalize temporary roots
  // at creation time before comparing or deriving workspace identities.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function sameNamedWorkspace(parentPrefix: string, homeDir: string): WorkspaceContext {
  const parent = tempDir(parentPrefix);
  const root = join(parent, 'shared-project-name');
  mkdirSync(root);
  return new WorkspaceContext({ rootDir: root, homeDir });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorkspaceContext', () => {
  it('normalizes hyphen-heavy project names without a backtracking trim regex', () => {
    const home = tempDir('mythos-workspace-slug-home-');
    const parent = tempDir('mythos-workspace-slug-parent-');
    const root = join(parent, `${'-'.repeat(200)}project${'-'.repeat(40)}`);
    mkdirSync(root);

    const workspace = new WorkspaceContext({ rootDir: root, homeDir: home });

    assert.equal(workspace.projectName, `${'-'.repeat(200)}project${'-'.repeat(40)}`);
    assert.match(workspace.projectId, /^project-[a-f0-9]{16}$/);
  });

  it('captures a canonical immutable root and separates same-named projects', () => {
    const home = tempDir('mythos-workspace-home-');
    const a = sameNamedWorkspace('mythos-workspace-a-', home);
    const b = sameNamedWorkspace('mythos-workspace-b-', home);

    assert.equal(a.projectName, b.projectName);
    assert.notEqual(a.rootDir, b.rootDir);
    assert.notEqual(a.projectId, b.projectId);
    assert.notEqual(a.sessionsDir, b.sessionsDir);

    const original = process.cwd();
    const elsewhere = tempDir('mythos-workspace-elsewhere-');
    process.chdir(elsewhere);
    try {
      assert.equal(a.resolve('src', 'file.ts'), join(a.rootDir, 'src', 'file.ts'));
      assert.equal(createWorkspaceContext(a.rootDir).rootDir, a.rootDir);
    } finally {
      process.chdir(original);
    }
  });

  it('keeps memory databases and session files isolated per canonical root', () => {
    const home = tempDir('mythos-workspace-state-home-');
    const a = sameNamedWorkspace('mythos-memory-a-', home);
    const b = sameNamedWorkspace('mythos-memory-b-', home);

    initMemory(false, a);
    initMemory(false, b);
    appendEntry('workspace-a action', 'a result', false, a);
    appendEntry('workspace-b action', 'b result', false, b);

    assert.match(readMemory(a).raw, /workspace-a action/);
    assert.doesNotMatch(readMemory(a).raw, /workspace-b action/);
    assert.match(readMemory(b).raw, /workspace-b action/);
    assert.doesNotMatch(readMemory(b).raw, /workspace-a action/);

    saveSession(
      [{ role: 'user', content: 'session a' }],
      { inputTokens: 1, outputTokens: 2, turns: 1 },
      a.projectName,
      a,
    );
    saveSession(
      [{ role: 'user', content: 'session b' }],
      { inputTokens: 3, outputTokens: 4, turns: 1 },
      b.projectName,
      b,
    );

    assert.equal(loadSession(a)?.history[0]?.content, 'session a');
    assert.equal(loadSession(b)?.history[0]?.content, 'session b');
    assert.notEqual(getSessionPaths(a).file, getSessionPaths(b).file);

    closeMemoryDatabase(a);
    closeMemoryDatabase(b);
  });

  it('migrates only a matching legacy global session into scoped storage', () => {
    const home = tempDir('mythos-workspace-legacy-home-');
    const workspace = sameNamedWorkspace('mythos-legacy-root-', home);
    const paths = getSessionPaths(workspace);
    mkdirSync(join(workspace.userStateDir, 'sessions'), { recursive: true });
    writeFileSync(paths.legacyFile, serializeSessionData({
      timestamp: new Date().toISOString(),
      project: workspace.projectName,
      history: [{ role: 'user', content: 'legacy context' }],
      budget: { inputTokens: 1, outputTokens: 2, turns: 1 },
    }));

    assert.equal(loadSession(workspace)?.history[0]?.content, 'legacy context');
    assert.equal(existsSync(paths.file), true);
  });

  it('runs git inspection against the explicit workspace root', () => {
    const root = tempDir('mythos-workspace-git-');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Mythos Test'], { cwd: root });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: root, stdio: 'ignore' });

    const original = process.cwd();
    const elsewhere = tempDir('mythos-workspace-git-cwd-');
    process.chdir(elsewhere);
    try {
      assert.equal(isGitRepo(root), true);
      assert.notEqual(getCurrentBranch(root), 'unknown');
      assert.match(getLatestHash(root), /^[a-f0-9]{40}$/);
      assert.equal(hasUncommittedChanges(root), false);
      assert.equal(process.cwd(), elsewhere);
    } finally {
      process.chdir(original);
    }
  });

  it('applies external-agent actions to explicit workspaces without cwd coupling', async () => {
    const home = tempDir('mythos-workspace-apply-home-');
    const a = sameNamedWorkspace('mythos-apply-a-', home);
    const b = sameNamedWorkspace('mythos-apply-b-', home);
    const original = process.cwd();
    const elsewhere = tempDir('mythos-apply-cwd-');
    process.chdir(elsewhere);

    try {
      const makeInput = (name: string) => JSON.stringify({
        request: `create ${name}`,
        actions: [{
          path: `${name}.txt`,
          operation: 'CREATE',
          intent: 'MUTATE',
          description: `Create ${name}`,
          content: name,
        }],
      });

      const [resultA, resultB] = await Promise.all([
        applyExternalAgentActions({ rawInput: makeInput('alpha'), workspace: a }),
        applyExternalAgentActions({ rawInput: makeInput('beta'), workspace: b }),
      ]);

      assert.equal(resultA.ok, true);
      assert.equal(resultB.ok, true);
      assert.equal(readFileSync(join(a.rootDir, 'alpha.txt'), 'utf8'), 'alpha');
      assert.equal(readFileSync(join(b.rootDir, 'beta.txt'), 'utf8'), 'beta');
      assert.equal(existsSync(join(a.rootDir, 'beta.txt')), false);
      assert.equal(existsSync(join(b.rootDir, 'alpha.txt')), false);
      assert.equal(existsSync(join(elsewhere, 'alpha.txt')), false);
      assert.equal(process.cwd(), elsewhere);
      assert.ok(resultA.receipt?.path.startsWith(a.rootDir));
      assert.ok(resultB.receipt?.path.startsWith(b.rootDir));
      assert.ok(resultA.run?.path.startsWith(a.rootDir));
      assert.ok(resultB.run?.path.startsWith(b.rootDir));
    } finally {
      process.chdir(original);
    }
  });

  it('routes MCP writes through the supplied workspace instead of process.cwd()', async () => {
    const home = tempDir('mythos-workspace-mcp-home-');
    const workspace = sameNamedWorkspace('mythos-mcp-root-', home);
    const original = process.cwd();
    const elsewhere = tempDir('mythos-mcp-cwd-');
    process.chdir(elsewhere);

    try {
      const response = await handleMCPMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'swd_apply',
          arguments: {
            saveReceipt: false,
            saveRun: false,
            actions: [{
              path: 'mcp.txt',
              operation: 'CREATE',
              intent: 'MUTATE',
              description: 'MCP workspace test',
              content: 'workspace-bound',
            }],
          },
        },
      }, workspace);

      assert.ok(response && 'result' in response);
      assert.equal(response.result.isError, false);
      assert.equal(readFileSync(join(workspace.rootDir, 'mcp.txt'), 'utf8'), 'workspace-bound');
      assert.equal(existsSync(join(elsewhere, 'mcp.txt')), false);
      assert.equal(process.cwd(), elsewhere);
    } finally {
      process.chdir(original);
    }
  });

  it('runs parallel sandboxes without changing the host process cwd', async () => {
    const home = tempDir('mythos-workspace-sandbox-home-');
    const a = sameNamedWorkspace('mythos-sandbox-a-', home);
    const b = sameNamedWorkspace('mythos-sandbox-b-', home);
    const original = process.cwd();

    const action = (path: string, content: string) => [{
      path,
      operation: 'CREATE' as const,
      intent: 'MUTATE' as const,
      description: 'sandbox workspace test',
      content,
    }];

    const [resultA, resultB] = await Promise.all([
      runActionsInSandbox(action('a.txt', 'a'), { cwd: a.rootDir, checks: [] }),
      runActionsInSandbox(action('b.txt', 'b'), { cwd: b.rootDir, checks: [] }),
    ]);

    assert.equal(resultA.ok, true);
    assert.equal(resultB.ok, true);
    assert.equal(process.cwd(), original);
    assert.equal(existsSync(join(a.rootDir, 'a.txt')), false);
    assert.equal(existsSync(join(b.rootDir, 'b.txt')), false);
  });
});
