# LAT Monitor Stall and Exec Process Control Implementation Plan

> Scope note: preserve the user's existing Terra model-default edits in `README.md`, `lat-dispatch/references/clients.md`, and `lat-dispatch/tests/skill-contract-test.sh`. Do not commit while unrelated user changes remain mixed in the worktree.

## Goal

Implement the approved monitor lifecycle, review stall, exec PID lifecycle, and additive Context7 MCP capability contracts without changing Session completion semantics, ledgers, TUI process control, or existing permissions.

## Task 1: Add RED tests for the exec PID lifecycle

**Files:**

- Create: `lat-dispatch/tests/exec-client-test.sh`
- Create later: `lat-dispatch/scripts/run-exec-client.sh`

1. Add integration cases that launch a disposable child through the missing runner and assert the PID file contains the child's live PID.
2. Assert the runner propagates the child exit status and removes the PID file through `trash-put` after normal completion.
3. Assert `kill -TERM` against the recorded PID terminates only that child and the runner removes the PID file.
4. Run the new test and confirm it fails because the runner does not exist.

## Task 2: Add RED contract tests for the dispatch rules

**Files:**

- Modify: `lat-dispatch/tests/skill-contract-test.sh`

1. Assert review defaults and examples use `stall: 600` / `--stall 600` and Codex waits use `yield_time_ms=600000`.
2. Assert Claude Monitor calls use `timeout_ms: 3600000` and `persistent: true`.
3. Assert Monitor re-arm reuses the resolved values and STALL remains advisory with no automatic kill.
4. Assert exec launch and resume examples use the bundled PID runner and `.lat/workspace/<TASK_ID>/runtime/<agent_id>.pid`.
5. Assert writer/reviewer prompts can use the existing Context7 MCP without strict MCP, other-MCP disabling, CLI installation, or permission changes.
6. Run the contract test and confirm the new assertions fail against the current documentation.

## Task 3: Implement the PID runner and contracts

**Files:**

- Create: `lat-dispatch/scripts/run-exec-client.sh`
- Modify: `lat-dispatch/references/clients.md`
- Modify: `lat-dispatch/SKILL.md`
- Modify: `docs/monitor-script.md`

1. Implement a Bash 3.2-compatible runner accepting `--pid-file <path> -- <command> [args...]`.
2. Start the exact client command in the background, capture `$!`, write only that decimal PID, wait for it, preserve its exit status, and trash the PID file on exit.
3. Update initial and resumed Claude/Codex exec examples to use the runner before starting Monitor.
4. Document the diagnosis-only STALL flow: validate the recorded positive PID with `kill -0`, never fall back to `pgrep`, and send only SIGTERM after failure is confirmed.
5. Change the review stall default to 600 seconds, keep drift at 1800 seconds, and require identical resolved values on every re-arm.
6. Document Claude Monitor `timeout_ms: 3600000` plus `persistent: true` and the bundled script's terminal events.
7. Add Context7 MCP guidance to the three writer/reviewer role prompts while explicitly preserving their current permissions and other MCP/tools.

## Task 4: Verify and independently test

1. Run `bash lat-dispatch/tests/exec-client-test.sh`.
2. Run `bash lat-dispatch/tests/skill-contract-test.sh`.
3. Run `bash lat-dispatch/tests/monitor-session-test.sh`.
4. Run `bash -n` and ShellCheck on changed shell files.
5. Run the repository's skill loader/validation command discovered from existing tests or package scripts.
6. Run `git diff --check`, review staged and unstaged diffs separately, and confirm unrelated user changes were preserved.
7. Launch one built-in subagent with an English test-only prompt, ask it to inspect and run the relevant suites without modifying files, then wait for its final report.
