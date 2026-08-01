# Exact imported resume

Use `resolve-session-reference.sh resolve <client> <exact UUID-or-path> <workspace> <mode> <model> <effort> <permission>` to create one normalized imported record. It does not select a route.

Claude accepts an exact UUID or owned regular transcript path only below
`$HOME/.claude/projects/<canonical-workspace-slug>/`; its transcript must carry
that same UUID. Codex accepts an exact UUID/path only under
`$HOME/.codex/sessions`; exactly one regular, non-symlink transcript must have
one `session_meta.payload.id` equal to the UUID and a `cwd` equal to the
canonical workspace. FIFO files, symlink components, duplicate matches,
mismatched IDs/cwd, and path escape refuse.

`manage-run-state.sh import` accepts only the resolver's owned `0600` regular
JSON, rechecks client/mode/workspace/settings and requires `origin=imported`.
It creates immutable metadata and identity-only `session-ref.json`, with no
owner or active-turn; an existing ID, mismatch, symlink, or replay refuses.
The imported identity is sealed and immutable at import time:

```json
{"source":"imported","sealed":true,"immutable":true,"owner":{"type":"external"},"mode":"exec|tui","session_id":"exact UUID","session_path":"canonical path"}
```

Imported mode is `exec` unless the caller explicitly chose `tui`; `native` is
not an import mode. An external record never becomes native. Missing local
settings require explicit model, effort, and permission values, each marked
`user-supplied` in the normalized `settings` object.

Resume replays the immutable exact record only. A managed record whose identity
is unsealed, has an active turn, has stop intent, or has an invalid native
handle refuses resume, cleanup, and prune; it never searches for or creates a
replacement handle. UUIDs, paths, transcript content, and canonical workspace
are exact selectors: filename dates, modification time, prompt text, and fuzzy
matching are not inputs.
