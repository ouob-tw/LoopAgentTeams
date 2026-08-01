# External completion evidence

`monitor-session.sh` accepts an operation, exact active-turn token, exact exec
owner token, and an owned regular transcript. It first verifies the sealed
state and the immutable settings manifest.

Claude completion requires the sealed session ID, the selected model, and the
newest matching user-to-assistant `end_turn` result. Codex completion requires
the sealed `session_meta` ID and workspace, a matching resumed-turn model, a
`response_item` with `phase=final_answer`, and `task_complete` or
`turn_complete` in that turn. The monitor prints the one Final Answer before
calling `complete-turn` with the exact token. Missing or conflicting evidence
returns exit 70 and leaves the turn active.
