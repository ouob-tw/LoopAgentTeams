# LAT Monitor macOS and TUI E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the unified LAT Session Monitor work with stock macOS Bash and native BSD utilities, document exact dependencies, and prove both Codex and Claude TUI workflows through real zmx sessions.

**Architecture:** Keep one `monitor-session.sh` interface for both clients and both execution modes. Isolate OS differences behind small date and stat helpers, retain raw client Session JSONL as the only turn-completion source, and treat zmx only as the TUI process host and cleanup boundary.

**Tech Stack:** Bash 3.2-compatible shell, jq, GNU/Linux core utilities, macOS BSD date/stat, zmx, Codex CLI, Claude Code CLI.

## Global Constraints

- Do not create or redirect independent exec or TUI log files.
- Do not require Homebrew Bash, GNU coreutils, `gdate`, or `gstat` on macOS.
- Keep `todo/exec-process-completion-monitoring.md` as repository backlog only; formal skill runtime documentation must not depend on it.
- Use skill-root-relative `scripts/monitor-session.sh` references inside `lat-dispatch`.
- Preserve all unrelated staged and unstaged changes.
- Use `zmx kill` after each live TUI smoke test; do not send `/exit`.

---

### Task 1: Add portable date and stat behavior with regression tests

**Files:**
- Modify: `lat-dispatch/tests/monitor-session-test.sh`
- Modify: `lat-dispatch/scripts/monitor-session.sh`

**Interfaces:**
- Consumes: `CODEX_HOME`, `HOME`, native `uname`, `date`, and `stat` commands.
- Produces: unchanged `monitor-session.sh codex|claude ...` CLI and completion envelope.

- [ ] **Step 1: Add a failing macOS command-selection test**

Add a test fixture PATH whose `uname` returns `Darwin`, whose `date` accepts only BSD `-v-1d` forms, and whose `stat` accepts only BSD `-f`. Create a matching synthetic Codex Session and assert that automatic resolution returns `COMPLETED`.

- [ ] **Step 2: Verify the new test fails for the expected GNU-only assumptions**

Run:

```bash
bash lat-dispatch/tests/monitor-session-test.sh
```

Expected: FAIL because the current script calls `date -d`, `stat -c`, or requires Bash 4-only features.

- [ ] **Step 3: Implement minimal platform helpers and Bash 3.2-compatible tracking**

Implement helpers with these contracts:

```bash
platform_name()        # prints Darwin or the current uname value
list_session_days()    # prints unique local/UTC today/yesterday paths
file_mtime PATH        # prints comparable native stat output
codex_path_seen PATH   # returns 0 only when PATH was already considered
```

Use `date -v-1d` and `stat -f` on Darwin; use `date -d yesterday` and `stat -c` elsewhere. Replace `mapfile` and associative arrays with Bash 3.2 indexed arrays and loops. Remove the stale `tac` dependency check.

- [ ] **Step 4: Verify portable and existing monitor behavior passes**

Run:

```bash
bash -n lat-dispatch/scripts/monitor-session.sh
bash -n lat-dispatch/tests/monitor-session-test.sh
bash lat-dispatch/tests/monitor-session-test.sh
```

Expected: both syntax checks exit 0 and the suite prints `PASS: monitor-session`.

### Task 2: Correct formal skill contracts and documentation

**Files:**
- Modify: `lat-dispatch/SKILL.md`
- Modify: `lat-dispatch/references/clients.md`
- Modify: `docs/monitor-script.md`
- Modify: `README.md`
- Preserve: `todo/exec-process-completion-monitoring.md`

**Interfaces:**
- Consumes: the unchanged Monitor CLI and the Task 1 platform dependency contract.
- Produces: executable path examples, platform installation guidance, and separated runtime-signal/exit-outcome documentation.

- [ ] **Step 1: Add failing documentation assertions**

Extend the handoff verification command or add shell assertions that fail while formal skill files contain `<skill-dir>/scripts/monitor-session.sh`, reference `todo/exec-process-completion-monitoring.md`, or advertise GNU/Linux-only compatibility.

- [ ] **Step 2: Verify documentation assertions fail**

Run the repository handoff verification command and confirm it reports the current placeholder/TODO/platform mismatch.

- [ ] **Step 3: Apply the minimum documentation corrections**

Inside `lat-dispatch`, use `scripts/monitor-session.sh` relative to the skill root. In top-level repo docs, use the exact repo path `lat-dispatch/scripts/monitor-session.sh`. Remove formal runtime references to the TODO while leaving the backlog file untouched. Document three runtime signals separately from exit codes. Add Linux and macOS dependency/install sections and explicitly state that macOS compatibility is covered by simulated BSD command tests unless a real macOS host was used.

- [ ] **Step 4: Verify documentation and loader checks pass**

Run:

```bash
/home/swy/.bun/bin/bunx skills add . --list
git diff --check
```

Expected: all three project skills are discovered and no whitespace errors are reported.

### Task 3: Run real Codex and Claude TUI workflows through zmx

**Files:**
- Create at runtime only: `.lat/workspace/tui-monitor-smoke/prompts/<agent_id>.txt`
- Read only: native Codex and Claude Session JSONL files under the user's home directory.

**Interfaces:**
- Consumes: `zmx run -d`, Codex TUI, Claude TUI, and `lat-dispatch/scripts/monitor-session.sh`.
- Produces: two real `COMPLETED` envelopes with exact expected Final Answers and no surviving smoke-test zmx sessions.

- [ ] **Step 1: Start and monitor a real Codex TUI**

Write a prompt beginning with a unique `[<agent_id>]` marker and requesting exactly `CODEX_TUI_ZMX_OK`. Start `codex` (not `codex exec`) in a unique detached `cx-...` session. Run the Monitor with only `--agent-id`, assert its envelope contains the expected answer, then run `zmx kill` and confirm the session is absent from `zmx list`.

- [ ] **Step 2: Start and monitor a real Claude TUI**

Generate a UUID, write a prompt requesting exactly `CLAUDE_TUI_ZMX_OK`, and start interactive `claude` in a unique detached `cc-...` session with `--session-id` and `--name`. Monitor the corresponding Project transcript path, assert the expected answer, then run `zmx kill` and confirm cleanup.

- [ ] **Step 3: Record evidence without redirecting client logs**

Capture CLI versions, Monitor envelopes, Session JSONL paths, and zmx cleanup checks in the final report. Do not persist zmx history or client stdout as a separate log artifact.

### Task 4: Independent Luna testing and final skill verification

**Files:**
- Modify only files implicated by verified Luna findings.
- Sync after acceptance: `/home/swy/.agents/skills/lat-dispatch/` and other changed installed skill copies.

**Interfaces:**
- Consumes: the completed implementation, tests, live smoke evidence, and full dirty-worktree diff.
- Produces: first Luna test result, post-fix second Luna independent review, installed-skill synchronization evidence, and final verification output.

- [ ] **Step 1: Dispatch Luna for independent test/review**

Ask a Luna sub-agent to inspect scope-specific diffs, run syntax/tests/loader checks, verify macOS compatibility logic, and validate both live-smoke evidence paths. Require concrete file/line findings or `PASS`.

- [ ] **Step 2: Reproduce and fix every valid finding with RED-GREEN tests**

For each finding, reproduce it locally, add or adjust a failing regression test, apply the minimum fix, and rerun the focused suite.

- [ ] **Step 3: Dispatch a fresh second Luna review**

Require an independent second pass over the corrected files and all formal LAT skill contracts. Do not accept the first review report as proof.

- [ ] **Step 4: Synchronize installed skills and run the full final gate**

Run:

```bash
bash -n lat-dispatch/scripts/monitor-session.sh
bash -n lat-dispatch/tests/monitor-session-test.sh
bash lat-dispatch/tests/monitor-session-test.sh
/home/swy/.bun/bin/bunx skills add . --list
git diff --check
```

Compare repository and installed skill copies after synchronization. Expected: all commands exit 0, both Luna rounds report no unresolved findings, and installed files match the accepted repository versions.
