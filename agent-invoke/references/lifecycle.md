# Lifecycle state

All state lives below `$HOME/.agent-invoke` only. Its registry directories are
`0700`; JSON files and same-directory temporary files are `0600`. A symlink,
foreign owner, malformed JSON, duplicate operation ID, or pre-existing lock is
a refusal. A lock is never inferred stale or removed by recovery.

## Bootstrap and seal

`manage-run-state.sh bootstrap-launch <operation> <client> <workspace> <provisional-id> <mode>` writes one atomic record:

```json
{"schema":1,"operation_id":"...","client":"claude|codex","workspace":"canonical path","mode":"native|exec|tui","status":"active","session":{"id":"UUID or null","sealed":false},"owner":null,"stop_intent":null,"active_turn":{"kind":"launch","token":"exact turn token","seal_token":"exact seal token"}}
```

Claude may carry its preallocated UUID in the unsealed record. Codex starts
with a null identity. Neither is resumable until the launch turn returns the
authoritative identity and calls `seal-session` with both exact tokens. A native
seal also records the exact native owner in that one atomic replacement.
Existing seals, rebind attempts, token mismatch, partial writes, or uncertainty
leave the prior unsealed record intact and refuse.

`begin-turn` requires a sealed identity, no `active_turn`, and no
`stop_intent`. `complete-turn` requires the exact active turn token. Owner
checks compare the current active-turn token and the stored exec, ZMX, or native
owner token/handle exactly.

## Stop and cleanup

For an external owner, record explicit stop intent only after its exact active
turn and owner token match. This blocks future resume, cleanup, and prune.

Native stop has three phases:

1. `prepare-native-stop <operation> <turn-token> <native-handle>` records a
   private `prepared` intent.
2. The host calls its native stop tool directly with that exact handle.
3. After private confirmation, `finalize-native-stop` accepts the same turn and
   handle and records `finalized` / `stopped`.

Failed or uncertain host-tool calls do not finalize or replace the handle; the
prepared record remains fail-closed. No shell signal emulates the native tool.

`clean-one <operation> --dry-run` reports only `recoverable-clean` sealed
records. `--confirm` securely deletes that one state record. There is no
age-based cleanup and no unrestricted `clean --all`.
