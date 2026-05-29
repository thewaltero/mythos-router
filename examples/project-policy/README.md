# Project Policy Example

`.mythos/policy.json` is an enforced repo-local SWD policy.

It is not a prompt hint. It applies before filesystem mutation in:

- `mythos chat`
- `mythos run`
- `mythos swd apply`
- MCP `swd_apply`

Built-in sensitive path protection still wins. A project policy cannot allow `.env`, `.npmrc`, `.git`, private keys, wallet files, or secret-like paths.

## Install The Example Policy

From a disposable test directory:

```bash
cd examples/project-policy
TMP="$(mktemp -d)"
cp policy.json blocked-mainnet.json "$TMP/"
cd "$TMP"

mkdir -p .mythos
cp policy.json .mythos/policy.json
mythos init --check
```

## What This Policy Does

The example policy:

- blocks `contracts/mainnet/**`
- blocks `infra/prod/**`
- requires confirmation for `scripts/**`
- requires confirmation for `.github/workflows/**`
- requires confirmation for `src/payments/**`
- blocks deletes
- caps action batches at 20 actions
- caps single action content at 50,000 bytes

Path patterns are matched case-insensitively by path segment. `*` matches within one segment, and `**` matches across path segments.

## Try The Blocked Action

```bash
mythos swd apply --file blocked-mainnet.json --json
```

Expected behavior:

- returns `ok: false`
- reports that project policy blocked the write
- does not write `contracts/mainnet/Vault.sol`

## Isolated-Run Checks (opt-in)

The example policy also declares verification commands under `checks`:

```json
"checks": [
  { "name": "typecheck", "command": "npm run -s build" },
  { "name": "test", "command": "npm test" }
]
```

**Declaring a check never runs it.** Checks execute only when you opt in,
in a throwaway copy of the project. The change reaches the real working
tree only if every check passes:

```bash
# Run the policy-declared checks before applying
mythos swd apply --file actions.json --json --run-checks

# Or pass ad-hoc checks without a policy file (repeatable)
mythos swd apply --file actions.json --json --check "npm test"
```

If any check fails, the apply is rejected and the real tree is untouched.
Checks are skipped during `--dry-run`. This keeps a cloned untrusted repo's
policy file from triggering command execution on its own.
