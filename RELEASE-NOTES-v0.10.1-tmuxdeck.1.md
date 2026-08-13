# v0.10.1-tmuxdeck.1

GitHub-only maintenance release of the Pi adapter. This is not an official npm release.

## Provenance

- Upstream base tag: `v0.10.0`
- Upstream base commit: `85c118453a15b3631b2a1eb289b66a65d1ac6ab2`
- Upstream base tree: `bd9d387ff647692b4cde708d29d127a0e05275bb`
- Published `@dataforxyz/agent-intercom-pi@0.10.0` tarball SHA-1: `68a734062fbc2467a61293b5c76aceb2ce8a2d1c`
- The 27 files in that npm tarball matched the upstream base commit byte-for-byte by SHA-256.

## Changes

- Discovery, status counts, `/intercom`, Alt+M, and the picker default to the canonical current workspace: Git root when available, canonical cwd otherwise.
- Explicit `scope: "machine"` restores machine-wide list/status and name or ID-prefix lookup.
- Exact full session IDs remain the intentional cross-workspace route.
- Unresolved scoped names and prefixes fail closed and are never forwarded raw to the machine-global broker.
- Supervisor exact full IDs can cross workspaces; supervisor name lookup remains current-workspace scoped.
- Ordinary same-sender message batches reply to the latest context.
- Reply context survives provider/tool loops and failed delivery attempts for one agent run, then clears after success or `agent_end`.
- A new inbound batch received during an active run waits for the next run.

## Verification

- `npm run typecheck`
- `npm run test:ci`: 145 passed, 0 failed in a Linux-compatible environment
- Entry import passed
- `git diff --check` passed
- Package dry run and actual tarball inspection passed
- Package includes license/notices, `cwd.ts`, and `reply-tracker.ts`, and excludes tests

## Security boundary

Current-workspace filtering is client-side discovery and fail-closed routing. It is not a broker security boundary. The protocol-v3 broker remains machine-global for the same OS user. Broker-enforced isolation would require a future scoped protocol.

## Upgrade

```bash
pi install git:github.com/ctliz/agent-intercom-pi@v0.10.1-tmuxdeck.1
```

Run `/reload` in every open Pi session and restart every companion Codex, Claude, or OpenCode adapter. All participants must use compatible protocol-v3 adapters to share the broker.

## Known limits

- Other adapters are unchanged and still expose their existing machine-global discovery behavior.
- Exact full IDs intentionally allow cross-workspace contact.
- Workspace calculation is best-effort client behavior based on registered cwd and local Git metadata.
- This release is distributed from the maintenance fork as a Git tag, not through the official npm package.
