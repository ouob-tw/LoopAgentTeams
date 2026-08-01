# External exec handoff

`run-exec-client.sh` accepts exactly one launch or resume operation. Launch
bootstraps an `exec` record; Claude retains its caller-preallocated UUID until
one matching authoritative init event confirms it, while fresh Codex seals the
single authoritative `thread.started` ID. The seal includes the PID, start
time, executable, and private owner token.

The launcher uses Bash arrays for the client argv and a redirected prompt file.
It captures one per-turn stream, waits for that exact child, then refuses a
missing, duplicate, or mismatched start identity. A successful launch leaves
the active turn in place for the completion monitor. Resume first verifies the
sealed client, workspace, exact session, and immutable settings, then begins
the caller's exact turn token.
