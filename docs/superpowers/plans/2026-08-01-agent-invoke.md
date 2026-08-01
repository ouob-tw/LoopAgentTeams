
# Agent Invoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `agent-invoke` skill that invokes or resumes one Codex/Claude agent through the exact native, external exec, or external TUI route required by the approved specification, without loading or changing LAT Dispatch.

**Architecture:** `agent-invoke/SKILL.md` is the only route selector and remains at or below 150 lines; after selecting one route it loads only that route's focused reference. Four small Bash helpers own registry transactions, exact external-session validation, exec process ownership, and authoritative transcript completion. All contract, fake-carrier, trigger, installed E2E, QA, and evidence files live under repo-level `tests/agent-invoke/`, outside the installed package.

**Tech Stack:** Agent Skills Markdown, Bash 3.2+, jq, uuidgen, coreutils, shred, trash-cli, ripgrep, ZMX, Codex CLI, Claude Code CLI, Skills CLI via `/home/swy/.bun/bin/bunx`, `uvx --from skills-ref agentskills`, ShellCheck, Git/GitHub CLI.

## Global Constraints

- Work only on `dev`. Do not modify, merge, reset, tag, or push `main`; verify `main` remains at `5a8e76c`.
- Do not modify any file under `lat-dispatch/` and do not link, mirror, import, or runtime-read its references or scripts.
- Do not create or mutate `.lat/`, `.lat/workspace`, `tasks.yaml`, or `results.yaml` as product behavior. Every installed E2E snapshots `.lat` before and after.
- Phase one supports only Codex and Claude Code. Ambiguous targets require clarification; unsupported targets fail before any carrier or state mutation.
- Route order is exact resume → explicit external override → same-family native → cross-family external exec → explicit interactive/persistent TUI. Missing native capability fails closed until the user explicitly approves an external route.
- Preserve explicitly requested client/agent/model. Resume replays recorded route, client, mode, model, effort, permission, workspace, and exact session identity; a client/model change is a new invoke.
- Never select with `--last`, `--continue`, newest mtime, name prefix, glob, prompt substring, or `pgrep`.
- Native runs never start Codex/Claude CLI, ZMX, PID state, external transcript monitors, or external-route references. They wait through host blocking completion and may save only exact native handle metadata needed for resume.
- External prompts/messages use a private `mktemp -d` directory under `/tmp`, are passed through stdin or `zmx send` without shell interpolation, and are shredded after confirmed delivery or a proven not-delivered launch failure.
- State lives only at `$HOME/.agent-invoke`: directories `0700`, files `0600`, same-directory atomic replacement, no followed symlinks, and atomic `mkdir` transaction locks. Tests isolate `HOME`; production has no alternate state-root override.
- Carrier owner state and active-turn state are separate. Releasing the transaction lock does not permit a second turn while `runtime/active-turn.json` exists. Fresh launch state remains provisional/unresumable until the first authoritative session ID or native handle is sealed exactly once under that turn token.
- External stop acts only on a fully verified exact PID/start/executable or ZMX handle. Native stop is prepare intent → exact host `interrupt_agent`/`TaskStop` → token-matched finalize; the Bash helper never calls a native tool. Successful finalize atomically clears the matching stop-intent with its owner/active-turn so `clean` can proceed; every failed, uncertain, or mismatched finalize retains all three. `clean` uses `trash-put` only after sealed identity, carrier, active-turn, and stop-intent checks; `prune` is dry-run until exact confirmation. Never delete a Claude/Codex native session.
- `agent-invoke/SKILL.md` and references use Traditional Chinese; scripts, tests, fixture labels, commits, and this plan use English.
- `SKILL.md` frontmatter contains only `name` and `description`, describes user intent, and is at most 150 physical lines. Every reference is one hop from `SKILL.md` with an explicit load condition.
- The installed package contains only `agent-invoke/SKILL.md`, `agent-invoke/references/`, and `agent-invoke/scripts/`. Tests, fixtures, raw traces, screenshots, and generated evidence remain under `tests/agent-invoke/` or disposable temp directories.
- Do not add a README, changelog, compatibility mirror, generic evaluator, archive schema, evidence database, third-party client adapter, or release automation.
- Raw transcripts are not committed. Evidence retains only case ID, candidate SHA, route, actual tool/carrier event, authoritative completion event, model/session identity, exit status, filesystem delta, and a short result excerpt.
- Use `trash-put` for ordinary removal, `shred` for sensitive temp files, `uv`/`uvx` instead of direct Python, and `gh` for GitHub operations.
- Preserve unrelated dirty work. Stage only task paths and inspect `git status --short` before every commit.
- Stop after real `#dev` evidence and user confirmation request. This plan does not release or integrate into `main`.

## File Responsibilities and Stable Interfaces

### Installed package

- Create `agent-invoke/SKILL.md` — new/resume parser and sole route owner.
- Create `agent-invoke/references/native.md` — Codex `spawn_agent`/`wait_agent`/`interrupt_agent`, Claude `Agent`/blocking completion/`TaskStop`, target verification, exact native follow-up, split-phase stop, and fail-closed behavior.
- Create `agent-invoke/references/external-common.md` — dependency preflight, disclosure sentence, private prompt handoff, immutable settings, and external failure classification.
- Create `agent-invoke/references/exec.md` — exact Claude/Codex exec launch/resume argv and launcher handoff.
- Create `agent-invoke/references/tui.md` — exact tokenized ZMX wrapper, prompt/message delivery, wrapper reuse/replacement, and idle semantics.
- Create `agent-invoke/references/monitoring.md` — client-specific session/model/completion evidence and Final Answer extraction.
- Create `agent-invoke/references/resume.md` — managed/imported/native exact resume and immutable-setting replay.
- Create `agent-invoke/references/lifecycle.md` — registry/seal schema, transaction lock, owner/active-turn/stop-intent separation, external stop, native prepare/finalize stop, `clean`, and confirmed `prune`.
- Create `agent-invoke/scripts/manage-run-state.sh` — registry, launch identity sealing, and lifecycle transaction engine; never selects a route or calls a host-native tool.
- Create `agent-invoke/scripts/resolve-session-reference.sh` — exact Claude/Codex UUID/path validator; never creates state.
- Create `agent-invoke/scripts/run-exec-client.sh` — exact child launcher/capture owner; never chooses client/session.
- Create `agent-invoke/scripts/monitor-session.sh` — exact transcript/baseline verifier and Final Answer extractor; never launches/stops a carrier.

Stable helper CLIs:

~~~text
manage-run-state.sh bootstrap-launch --operation-id ID --metadata-json FILE --turn-json FILE [--preallocated-session-ref-json FILE]
manage-run-state.sh seal-session --operation-id ID --turn-token TOKEN --seal-token TOKEN --session-ref-json FILE [--owner-json FILE]
manage-run-state.sh import --operation-id ID --metadata-json FILE --session-ref-json FILE
manage-run-state.sh show --operation-id ID
manage-run-state.sh begin-turn --operation-id ID --action launch|resume --turn-json FILE
manage-run-state.sh complete-turn --operation-id ID --turn-token TOKEN --status completed|not-delivered|interrupted
manage-run-state.sh set-owner --operation-id ID --owner-json FILE
manage-run-state.sh clear-owner --operation-id ID --owner-token TOKEN
manage-run-state.sh stop-external --operation-id ID
manage-run-state.sh prepare-native-stop --operation-id ID
manage-run-state.sh finalize-native-stop --operation-id ID --stop-token TOKEN --host-confirmation-json FILE
manage-run-state.sh clean --operation-id ID
manage-run-state.sh prune
manage-run-state.sh prune --confirm-operation-id ID

resolve-session-reference.sh --client claude|codex --reference UUID_OR_ABSOLUTE_PATH \
  [--workspace ABSOLUTE_PATH] [--model MODEL] [--effort EFFORT] [--permission PERMISSION]

run-exec-client.sh --client claude|codex --action launch|resume \
  --operation-id ID --run-dir ABSOLUTE_RUN_DIR --prompt-file ABSOLUTE_PROMPT_FILE \
  --workspace ABSOLUTE_PATH --model MODEL --effort EFFORT --permission PERMISSION \
  [--session-id UUID]

monitor-session.sh --client claude|codex --operation-id ID \
  --transcript ABSOLUTE_JSONL --after-line NONNEGATIVE_INTEGER --turn-token TOKEN
~~~

`monitor-session.sh` exit codes: `0` completed and Final Answer on stdout; `64` usage; `65` identity/state refusal; `69` missing dependency; `70` authoritative turn ended without Final Answer; `73` filesystem failure; `75` active turn not yet complete. Exit `75` does not authorize kill or route switching.

Registry schemas:

~~~json
{"schema_version":1,"operation_id":"cx-native-20260801T120000Z-1234abcd","route":"native","client":"codex","mode":"native","model":"gpt-5.6-terra","effort":"medium","permission":"workspace-write","workspace":"/tmp/agent-invoke-workspace","origin":"managed","settings_source":{"model":"user-supplied","effort":"user-supplied","permission":"user-supplied","workspace":"user-supplied"},"created_at":"2026-08-01T12:00:00Z","last_resumed_at":null,"last_turn_status":null}
{"kind":"provisional","operation_id":"cx-native-20260801T120000Z-1234abcd","seal_token":"random-seal-token","preallocated_session_id":null}
{"kind":"native-handle","runtime_handle":"exact-host-handle","sealed_by_turn_token":"random-turn-token"}
{"owner_token":"random-token","kind":"exec","pid":12345,"start_identity":"stable-process-start","executable":"/absolute/bin/codex"}
{"turn_token":"random-turn-token","action":"launch","session_identity":{"status":"provisional","seal_token":"random-seal-token","sealed_ref_hash":null},"baseline":null,"created_at":"2026-08-01T12:01:00Z"}
{"stop_token":"random-stop-token","owner_token":"random-token","runtime_handle":"exact-host-handle","turn_token":"random-turn-token","host":"codex","stop_primitive":"interrupt_agent"}
{"stop_token":"random-stop-token","owner_token":"random-token","turn_token":"random-turn-token","runtime_handle":"exact-host-handle","host":"codex","tool":"interrupt_agent","stopped":true,"tool_result_id":"host-result-identity"}
~~~

Fresh managed launches atomically create metadata, a launch turn, and an operation-local provisional `session-ref`; they do not require an identity that the host/client has not returned. Claude may place its preallocated UUID in the provisional record. The first authoritative Codex `thread.started`, Claude session-start confirmation, or native runtime handle calls `seal-session` with the same turn/seal tokens; the helper binds the final native handle or external client session ID plus canonical transcript exactly once. A second seal, mismatch, crash before seal, or uncertain identity leaves fail-closed state that cannot resume, clean, or prune. TUI/exec share sealed client-session identity; mode belongs in metadata.

Native stop is split-phase. `prepare-native-stop` locks and validates the exact native owner/turn, writes `runtime/stop-intent.json`, and prints its stop/owner/turn tokens plus host/runtime handle; the intent blocks resume and clean. `SKILL.md`/`native.md` then calls Codex `interrupt_agent` or Claude `TaskStop` with that exact handle and writes the authoritative tool result to a private confirmation JSON. `finalize-native-stop` re-locks, verifies the same stop/owner/turn tokens and a confirmed stopped result, then atomically removes that matching `runtime/stop-intent.json` together with owner/active-turn and records interruption; the resulting state has no stop-intent and permits `clean`. Failed, uncertain, or mismatched finalize retains owner, active-turn, and stop-intent unchanged. `stop-external` remains a single helper transaction that verifies an exact exec PID/start/executable or exact ZMX handle before stopping it.

### Repository-only test/evidence tree

- `tests/agent-invoke/fixtures/bin/{claude,codex,zmx}` — observable fake carriers logging argv/stdin and deterministic client-native events.
- `tests/agent-invoke/fixtures/sessions/{claude,codex}/` — valid, ambiguous, missing-metadata, escaped, symlink, non-regular, completed, incomplete, and resumed fixtures.
- `tests/agent-invoke/integration/skill-contract-test.sh` — package shape, line budget, route order, progressive disclosure, standalone boundary, forbidden shortcuts.
- `tests/agent-invoke/integration/state-manager-test.sh` — modes, atomic mutation, locks, active turns, owner verification, stop/clean/prune, path/symlink attacks.
- `tests/agent-invoke/integration/session-reference-test.sh` — client-specific exact import validation and immutable setting sources.
- `tests/agent-invoke/integration/exec-client-test.sh` — fake launch/resume, argv fidelity, prompt stdin, owner identity, failures.
- `tests/agent-invoke/integration/monitor-session-test.sh` — exact baseline completion, identity/model verification, Final Answer, incomplete turns.
- `tests/agent-invoke/integration/route-integration-test.sh` — fresh-host fake-carrier route matrix and concurrency.
- `tests/agent-invoke/e2e/trigger-prompts.json` and `run-trigger-eval.sh` — fixed 12-positive/6-negative, three-run trigger gate.
- `tests/agent-invoke/e2e/run-installed-e2e.sh` and `evidence-summary.json` — fixed real `#dev` case runner and concise evidence.
- Reserve `tests/agent-invoke/qa_e2e/` for independent `qa_executor` tests and `qa-results.md`. Code/test executors must not author or weaken them.

---

### Task 1: RED baseline and native-first route entry

**Files:**
- Create: `tests/agent-invoke/integration/skill-contract-test.sh`
- Create: `tests/agent-invoke/e2e/trigger-prompts.json`
- Create: `agent-invoke/SKILL.md`
- Create: `agent-invoke/references/native.md`

**Interfaces:**
- Consumes: approved route precedence and current host-native primitives.
- Produces: normalized `action,target_family,route,client,mode,model,effort,permission,workspace,resume_reference` and exactly one selected route.

- [ ] **Step 1: Write the failing contract.** Assert package existence, `SKILL.md <= 150`, ordered exact-resume/override/native/cross-family decision, native prohibitions, target transmission/verification, explicit-consent fallback, unsupported-client refusal, conditional reference reads, exact resume-only rules, provisional→sealed identity before resume, split-phase native stop using host tools rather than Bash, no `lat-dispatch` text/mirror, and no packaged test/evidence paths.

~~~bash
bash tests/agent-invoke/integration/skill-contract-test.sh
~~~

Expected: FAIL with `agent-invoke package is absent`.

- [ ] **Step 2: Record the historical RED behavior without modifying the tree.**

~~~bash
BASELINE_DIR=$(mktemp -d /tmp/agent-invoke-red.XXXXXX)
git archive 93d1d73 lat-client | tar -x -C "$BASELINE_DIR"
rg -n 'exec launch|ZMX TUI launch|先選模式' "$BASELINE_DIR/lat-client/SKILL.md"
! rg -n 'spawn_agent|wait_agent|內建 Agent|native route' "$BASELINE_DIR/lat-client/SKILL.md"
trash-put -- "$BASELINE_DIR"
~~~

Expected: external-only selectors are present and native primitives absent.

- [ ] **Step 3: Write minimal `SKILL.md` and `native.md`.** `SKILL.md` sections are `先正規化請求`, `路由決策`, `按選定路徑讀取`, `共同安全界線`, and `完成條件`. `native.md` defines: bootstrap before prompt delivery; Codex `spawn_agent` or Claude `Agent`; atomically seal the first returned exact runtime handle and native owner under the launch turn; then `wait_agent` or foreground/blocking completion. It also defines exact-handle follow-up/resume, invalid/unsealed-handle refusal without replacement, and native stop as `prepare-native-stop` → Codex `interrupt_agent(target=exact_handle)` or Claude `TaskStop(task_id=exact_handle)` → private confirmation JSON → `finalize-native-stop`. Bash never invokes or simulates the host-native stop primitive.

- [ ] **Step 4: Run GREEN and validate.**

~~~bash
bash tests/agent-invoke/integration/skill-contract-test.sh
uvx --from skills-ref agentskills validate ./agent-invoke
test "$(wc -l < agent-invoke/SKILL.md)" -le 150
~~~

Expected: PASS, validator exit 0, line gate exit 0.

- [ ] **Step 5: Commit.**

~~~bash
git status --short
git add agent-invoke/SKILL.md agent-invoke/references/native.md \
  tests/agent-invoke/integration/skill-contract-test.sh \
  tests/agent-invoke/e2e/trigger-prompts.json
git commit -m "feat(agent-invoke): add native-first route contract"
~~~

### Task 2: Secure registry, lock, active turn, and exact resume validation

**Files:**
- Create: `tests/agent-invoke/integration/state-manager-test.sh`
- Create: `tests/agent-invoke/integration/session-reference-test.sh`
- Create: `tests/agent-invoke/fixtures/sessions/{claude,codex}/`
- Create: `agent-invoke/scripts/manage-run-state.sh`
- Create: `agent-invoke/scripts/resolve-session-reference.sh`
- Create: `agent-invoke/references/lifecycle.md`
- Create: `agent-invoke/references/resume.md`

**Interfaces:**
- Consumes: normalized launch decision, or explicit client plus exact imported UUID/path.
- Produces: private atomic bootstrap state followed by one-time authoritative identity sealing, or one normalized imported session record; refusal never creates ambiguous resumable state.

- [ ] **Step 1: Write failing state tests.** Isolate `HOME` per case. Cover `0700/0600`, unsafe/duplicate IDs, symlink components, partial JSON, existing lock retention, active-turn exclusion after lock release, exact turn/owner token matching, atomic bootstrap with only an operation-local provisional identity, Claude preallocated UUID remaining unsealed until authoritative confirmation, Codex/native first-identity sealing exactly once, seal token/turn mismatch, rebind refusal, crash/uncertainty retaining unsealed fail-closed state, live/ambiguous owner refusal, external stop, native prepare/intent/finalize token matching, failed/uncertain native stop retaining state, recoverable clean, dry-run/confirmed prune, missing session/workspace candidates, no age-based deletion or unrestricted `clean --all`, and no workspace/`.lat` writes.

- [ ] **Step 2: Write failing session tests.** Cover Claude UUID↔canonical workspace slug↔transcript; Codex exact `session_meta.payload.id` and cwd; owned regular non-symlink path below native root; mismatch/escape/symlink/FIFO/duplicate UUID; missing settings requiring explicit values and recording `user-supplied`; immutable sealed managed resume; unsealed operation refusing resume/clean/prune; external resume never becoming native; invalid native handle without replacement; forbidden fuzzy selectors absent.

~~~bash
bash tests/agent-invoke/integration/state-manager-test.sh
bash tests/agent-invoke/integration/session-reference-test.sh
~~~

Expected: both fail because helpers are absent.

- [ ] **Step 3: Implement the minimum state engine.** Use functions `valid_operation_id`, `acquire_lock`, `release_owned_lock`, `atomic_json_replace`, `bootstrap_launch`, `seal_session_once`, `begin_turn`, `complete_turn`, `verify_exec_owner`, `verify_zmx_owner`, `verify_native_owner`, `stop_external_owner`, `prepare_native_stop`, `finalize_native_stop`, `clean_one_registry_entry`, and `classify_prune_candidate`. `bootstrap-launch` atomically creates metadata, provisional/preallocated-unsealed session-ref, and launch active-turn. `seal-session` requires the exact turn/seal tokens and, for native, may install the matching owner in the same atomic transaction. Any existing seal or mismatch returns 65 without changing bytes. `begin-turn` accepts resume only when identity is sealed and no active turn or stop-intent exists. Same-directory temp JSON is validated by `jq`, chmodded before `mv`, and shredded on failure. Never infer/remove a stale lock.

- [ ] **Step 4: Implement the focused validator.** Use `canonical_existing_dir`, `assert_no_symlink_components`, `assert_owned_regular_file`, `derive_claude_project_slug`, `resolve_claude_uuid_or_path`, `resolve_codex_uuid_or_path`, `read_authoritative_settings`, and `emit_normalized_session_json`. Claude accepts exact UUID/path under its derived project slug. Codex requires exactly one content match for exact session ID under `~/.codex/sessions`. No filename date, mtime, or prompt lookup.

- [ ] **Step 5: Write lifecycle/resume references.** They document exact bootstrap/seal schemas and commands, native prepare/host-tool/finalize stop, explicit external stop, refusal states, and immutable resume replay without restating route selection. Imported mode defaults to exec unless TUI was explicit. Unsealed or stop-intent state cannot resume/clean/prune; invalid native handles fail without replacement.

- [ ] **Step 6: Run GREEN and static gates.**

~~~bash
bash tests/agent-invoke/integration/state-manager-test.sh
bash tests/agent-invoke/integration/session-reference-test.sh
bash -n agent-invoke/scripts/manage-run-state.sh \
  agent-invoke/scripts/resolve-session-reference.sh
shellcheck agent-invoke/scripts/manage-run-state.sh \
  agent-invoke/scripts/resolve-session-reference.sh \
  tests/agent-invoke/integration/state-manager-test.sh \
  tests/agent-invoke/integration/session-reference-test.sh
~~~

Expected: both suites PASS; syntax/ShellCheck exit 0.

- [ ] **Step 7: Commit.**

~~~bash
git add agent-invoke/scripts/manage-run-state.sh \
  agent-invoke/scripts/resolve-session-reference.sh \
  agent-invoke/references/lifecycle.md agent-invoke/references/resume.md \
  tests/agent-invoke/integration/state-manager-test.sh \
  tests/agent-invoke/integration/session-reference-test.sh \
  tests/agent-invoke/fixtures/sessions
git commit -m "feat(agent-invoke): secure exact resume state"
~~~

### Task 3: External exec ownership and authoritative completion

**Files:**
- Create: `tests/agent-invoke/fixtures/bin/{claude,codex}`
- Create: `tests/agent-invoke/integration/exec-client-test.sh`
- Create: `tests/agent-invoke/integration/monitor-session-test.sh`
- Create: `agent-invoke/scripts/run-exec-client.sh`
- Create: `agent-invoke/scripts/monitor-session.sh`
- Create: `agent-invoke/references/{external-common,exec,monitoring}.md`

**Interfaces:**
- Consumes: bootstrapped launch or sealed resume, immutable settings, private prompt file, exact session ID on resume, and active turn.
- Produces: exact PID/start/executable/token owner, one-time authoritative launch identity seal, separated client events, exact transcript identity, authoritative completion, one Final Answer, and exact-token turn completion.

- [ ] **Step 1: Write fake clients and RED tests.** Cover one selected exec, same-family explicit exec, prompt metacharacters through stdin, exact model/effort/permission/workspace replay, Claude preallocated UUID confirmation, fresh Codex provisional identity followed by its first exact `thread.started` seal, duplicate/mismatched `thread.started` refusal, crash before seal leaving no resumable identity, exact sealed UUID resume, no fuzzy flags, owner identity, reused PID/changed executable refusal, no alternate mode on dependency/auth/quota/permission failure, Claude matching session/model/end-turn, Codex matching thread/model/final-answer/turn-complete, baseline isolation, incomplete exit 70, and exact-token clearing.

~~~bash
bash tests/agent-invoke/integration/exec-client-test.sh
bash tests/agent-invoke/integration/monitor-session-test.sh
~~~

Expected: both fail because launcher/monitor are absent.

- [ ] **Step 2: Implement argv with arrays and prompt stdin.** Effective forms:

~~~bash
claude --print --output-format stream-json --verbose \
  --model "$MODEL" --effort "$EFFORT" --permission-mode "$PERMISSION" \
  --session-id "$SESSION_ID"

claude --print --output-format stream-json --verbose \
  --model "$MODEL" --effort "$EFFORT" --permission-mode "$PERMISSION" \
  --resume "$SESSION_ID"

codex exec --json --model "$MODEL" --sandbox "$PERMISSION" \
  --config "model_reasoning_effort=$EFFORT" -

codex exec --json --model "$MODEL" --sandbox "$PERMISSION" \
  --config "model_reasoning_effort=$EFFORT" resume "$SESSION_ID" -
~~~

Run from exact workspace; stdin comes only from prompt file. Record/verify exact child identity around capture and wait. For Claude, pass the bootstrap-preallocated UUID and seal only after authoritative session-start confirms it. For fresh Codex, capture the first authoritative `thread.started`, resolve exactly one matching native transcript, and call `seal-session` with the launch turn/seal tokens before monitoring; a second/mismatched event fails closed. Launcher never clears active turn.

- [ ] **Step 3: Implement completion.** Refuse an unsealed operation first. Claude requires matching sealed session/model and newest post-baseline user→assistant end-turn/non-error result. Codex requires matching sealed `session_meta` ID, resumed turn model, `response_item phase=final_answer`, and same-turn `task_complete` or `turn_complete`. Print Final Answer, then complete only the matching token.

- [ ] **Step 4: Write focused external references.** `external-common.md` owns preflight/disclosure/prompt lifecycle/failure rules; `exec.md` owns launcher/session handoff; `monitoring.md` owns evidence and exit meaning. None contains route table.

- [ ] **Step 5: Run GREEN/regression/static checks.**

~~~bash
bash tests/agent-invoke/integration/exec-client-test.sh
bash tests/agent-invoke/integration/monitor-session-test.sh
bash tests/agent-invoke/integration/state-manager-test.sh
bash tests/agent-invoke/integration/session-reference-test.sh
find agent-invoke/scripts tests/agent-invoke/integration tests/agent-invoke/fixtures/bin \
  -type f -name '*.sh' -exec bash -n {} +
find agent-invoke/scripts tests/agent-invoke/integration tests/agent-invoke/fixtures/bin \
  -type f -name '*.sh' -exec shellcheck {} +
~~~

Expected: four suites PASS; syntax/ShellCheck exit 0.

- [ ] **Step 6: Commit.**

~~~bash
git add agent-invoke/scripts/run-exec-client.sh \
  agent-invoke/scripts/monitor-session.sh \
  agent-invoke/references/external-common.md \
  agent-invoke/references/exec.md agent-invoke/references/monitoring.md \
  tests/agent-invoke/fixtures/bin/claude tests/agent-invoke/fixtures/bin/codex \
  tests/agent-invoke/integration/exec-client-test.sh \
  tests/agent-invoke/integration/monitor-session-test.sh
git commit -m "feat(agent-invoke): add exact external exec handling"
~~~

### Task 4: External TUI and precise lifecycle safety

**Files:**
- Create: `tests/agent-invoke/fixtures/bin/zmx`
- Create: `tests/agent-invoke/integration/route-integration-test.sh`
- Modify: `tests/agent-invoke/integration/state-manager-test.sh`
- Create: `agent-invoke/references/tui.md`
- Modify: `agent-invoke/references/lifecycle.md`
- Modify: `agent-invoke/scripts/manage-run-state.sh`

**Interfaces:**
- Consumes: explicit TUI route, exact client session/settings, owner token, operation lock.
- Produces: one tokenized exact ZMX wrapper, safe prompt/message delivery, same-session wrapper recovery, exact external stop, split-phase host-native stop, and recoverable clean/prune.

- [ ] **Step 1: Write RED tests.** Cover explicit TUI only; tokenized handle; stdin message delivery; live wrapper reuse; dead wrapper replacement with same sealed client session; wrong ZMX/native handle refusal; live exec/TUI/native clean refusal; exact exec/TUI `stop-external`; native `prepare-native-stop` writing an intent that blocks resume/clean; Codex `interrupt_agent` and Claude `TaskStop` host-tool call records with the exact prepared handle; finalize accepting only the same stop/owner/turn tokens plus confirmed termination, atomically removing the matching intent/owner/active-turn, and allowing immediate `clean`; failed, uncertain, or mismatched finalize retaining all three state records byte-for-byte; one-entry `trash-put` clean; dry-run/confirmed prune; broken/unsealed metadata manual-only; simultaneous resume; resume-vs-clean; active-turn blocking after lock release; non-target carrier unchanged.

~~~bash
bash tests/agent-invoke/integration/state-manager-test.sh
bash tests/agent-invoke/integration/route-integration-test.sh
~~~

Expected: new cases fail because TUI/lifecycle behavior is absent.

- [ ] **Step 2: Implement lifecycle branches.** `stop-external` locks, verifies a complete exec PID/start/executable or exact ZMX handle, performs only that external stop, confirms carrier absence, records interrupted active turn, and clears exact tokens. `prepare-native-stop` only validates state, writes/returns a token-bound stop intent, and releases the lock; it never calls or emulates a host tool. `SKILL.md`/`native.md` calls Codex `interrupt_agent(target=runtime_handle)` or Claude `TaskStop(task_id=runtime_handle)`, stores the exact returned stopped/error status in a private `0600` confirmation JSON, then calls `finalize-native-stop`. Finalize re-locks and, only when all intent/owner/turn/handle fields still match and termination is confirmed, atomically removes the matching `runtime/stop-intent.json`, owner, and active-turn before recording interruption; otherwise it retains all three state records unchanged and fail-closed. The successful transaction therefore leaves no stop-intent and makes the next `clean` eligible. `clean` refuses active, unsealed, stop-intent, or ambiguous state, then calls `trash-put -- "$RUN_DIR"`. `prune` lists exact IDs/reasons by default and rechecks one explicitly confirmed entry under its lock.

- [ ] **Step 3: Write `tui.md`.** Handle shape is `ai-OPERATION_ID-TOKENPREFIX`. A fresh TUI bootstraps before prompt delivery; Claude confirms and seals its preallocated UUID, while Codex seals the first authoritative session-start identity before the operation becomes resumable. Launch one detached TUI, deliver bytes via stdin to `zmx send` and a separate carriage return, shred message file, reuse a live saved handle, or create a new tokenized wrapper that resumes the same exact sealed client session. Persistent idle wrapper keeps owner but no active-turn token.

- [ ] **Step 4: Run GREEN and integration regression.**

~~~bash
for test_file in tests/agent-invoke/integration/*-test.sh; do
  bash "$test_file" || exit $?
done
~~~

Expected: every suite PASS, including concurrency/stale-owner cases.

- [ ] **Step 5: Commit.**

~~~bash
git add agent-invoke/references/tui.md agent-invoke/references/lifecycle.md \
  agent-invoke/scripts/manage-run-state.sh \
  tests/agent-invoke/fixtures/bin/zmx \
  tests/agent-invoke/integration/state-manager-test.sh \
  tests/agent-invoke/integration/route-integration-test.sh
git commit -m "feat(agent-invoke): add safe TUI lifecycle"
~~~

### Task 5: Progressive disclosure, trigger evaluation, and full integration gate

**Files:**
- Modify: `agent-invoke/SKILL.md`
- Modify: `tests/agent-invoke/integration/skill-contract-test.sh`
- Create: `tests/agent-invoke/e2e/run-trigger-eval.sh`
- Modify: integration files only for a demonstrated failing requirement.

**Interfaces:**
- Consumes: complete focused references/helpers.
- Produces: ≤150-line route owner, fixed 18-prompt fresh-agent trigger gate, complete specification 9.2 fake integration evidence.

- [ ] **Step 1: Extend RED contract.** Assert direct conditional link to every reference, native decision before external reference reads, no full route table in references, no mirror, no packaged test/evidence paths, no generic Bash-native stop, required prepare→host tool→finalize sequence, and bootstrap→single seal before any managed resume.

- [ ] **Step 2: Write fixed trigger runner.** `trigger-prompts.json` has exactly 12 positives: generic delegation, exact model, same host, cross family, explicit exec, explicit TUI, unsupported client, operation-ID resume, exact-reference resume, stop, clean, prune. Six near-misses: full LAT, docs-only, generic shell, no delegation, pure Git, current-agent editing. Runner accepts only `--client codex|claude --skill-root ABSOLUTE_PATH --output SUMMARY_JSON`, uses three fresh sessions per prompt, and retains only counts/short failures.

- [ ] **Step 3: Run RED once, adjust only observed description/read failures, then GREEN on both hosts.**

~~~bash
TRIGGER_TMP=$(mktemp -d /tmp/agent-invoke-trigger.XXXXXX)
bash tests/agent-invoke/e2e/run-trigger-eval.sh \
  --client codex --skill-root "$PWD/agent-invoke" \
  --output "$TRIGGER_TMP/codex.json"
bash tests/agent-invoke/e2e/run-trigger-eval.sh \
  --client claude --skill-root "$PWD/agent-invoke" \
  --output "$TRIGGER_TMP/claude.json"
jq -e 'all(.cases[]; .passed == true and .runs == 3)' \
  "$TRIGGER_TMP/codex.json" "$TRIGGER_TMP/claude.json"
trash-put -- "$TRIGGER_TMP"
~~~

Expected GREEN: all 18 cases pass 3/3 on both hosts; raw traces never enter Git.

- [ ] **Step 4: Complete the fake-carrier matrix, then run package/integration/static gates.** `route-integration-test.sh` must include fresh Codex/native provisional sealing, Claude preallocated confirmation, rebind/crash refusal, unsealed resume/clean refusal, exact exec/TUI stops, Codex/Claude split-phase native stops, successful token-matched finalize leaving no stop-intent and allowing `clean`, failed/uncertain/mismatched finalize retaining intent/owner/active-turn, and non-target integrity in addition to every specification 9.2 route case.

~~~bash
for test_file in tests/agent-invoke/integration/*-test.sh; do bash "$test_file" || exit $?; done
find agent-invoke/scripts tests/agent-invoke -type f -name '*.sh' -exec bash -n {} +
find agent-invoke/scripts tests/agent-invoke -type f -name '*.sh' -exec shellcheck {} +
uvx --from skills-ref agentskills validate ./agent-invoke
test "$(wc -l < agent-invoke/SKILL.md)" -le 150
test -z "$(find agent-invoke -type f | rg '/(tests|fixtures|traces|evidence|reports)/' || true)"
test ! -e agent-invoke/references/clients.md
! rg -n --fixed-strings 'lat-dispatch' agent-invoke
git diff --exit-code 5a8e76c -- lat-dispatch/
git diff --check
~~~

Expected: all exit 0. Label these as contract/integration evidence, not real E2E.

- [ ] **Step 5: Commit.**

~~~bash
git add agent-invoke/SKILL.md tests/agent-invoke/integration \
  tests/agent-invoke/e2e/run-trigger-eval.sh
git commit -m "test(agent-invoke): verify routes and disclosure"
~~~

### Task 6: Isolated local install and fourteen real `#dev` E2E groups

**Files:**
- Create: `tests/agent-invoke/e2e/run-installed-e2e.sh`
- Create: `tests/agent-invoke/e2e/evidence-summary.json`
- Do not modify installed package files while collecting evidence.

**Interfaces:**
- Consumes: local package, then exact remote `dev` commit.
- Produces: concise evidence for specification 9.3 groups `codex-native`, `claude-native`, `codex-to-claude-exec`, `claude-to-codex-exec`, `same-host-exec`, `same-host-tui`, `native-unavailable`, `unsupported-client`, `managed-exec-resume`, `managed-tui-resume`, `imported-resume`, `native-resume`, `lifecycle`, and `prune`.

- [ ] **Step 1: Write RED installed runner with an explicit isolation/auth contract.** It accepts `--source LOCAL_REPO_OR_GIT_REF --case CASE_ID --evidence ABSOLUTE_JSON`. Before changing environment it records `REAL_HOME=$HOME`, `REAL_CODEX_AUTH=${CODEX_HOME:-$HOME/.codex}/auth.json`, and `REAL_CLAUDE_CREDENTIALS=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`; each must be a current-user-owned regular non-symlink `0600` file. It requires `bwrap`, creates `CASE_ROOT`, `CASE_HOME`, `CASE_CODEX_HOME`, `CASE_CLAUDE_CONFIG`, `CASE_WORKSPACE`, `CASE_TMP`, and `CASE_ZMX_DIR`, and creates empty credential mount targets without copying secret bytes. Missing files, unsafe ownership/mode, unavailable Bubblewrap, failed read-only mount, or failed in-sandbox auth status exits 69 before install/invoke.

The Skills CLI runs only with isolated `HOME=$CASE_HOME` and `--copy`; it records `skills list -g --json`, requires exactly `agent-invoke` for Codex and Claude Code and no `lat-dispatch`, resolves the local/remote candidate SHA, extracts `agent-invoke` from that SHA with `git archive`, and `diff -qr` compares every installed copy to those exact bytes. The runner records `candidate_sha` and a sorted installed-package SHA-256 manifest in each evidence record.

Every real client or ZMX command runs through this wrapper shape; the root filesystem and real skill/config trees are read-only, only the case root/workspace/temp/ZMX locations are writable, and the two credential files are mounted read-only into isolated client config roots:

~~~bash
bwrap --die-with-parent --new-session \
  --ro-bind / / --dev-bind /dev /dev --proc /proc \
  --bind "$CASE_ROOT" "$CASE_ROOT" \
  --ro-bind "$REAL_CODEX_AUTH" "$CASE_CODEX_HOME/auth.json" \
  --ro-bind "$REAL_CLAUDE_CREDENTIALS" "$CASE_CLAUDE_CONFIG/.credentials.json" \
  --setenv HOME "$CASE_HOME" --setenv CODEX_HOME "$CASE_CODEX_HOME" \
  --setenv CLAUDE_CONFIG_DIR "$CASE_CLAUDE_CONFIG" \
  --setenv TMPDIR "$CASE_TMP" --setenv ZMX_DIR "$CASE_ZMX_DIR" \
  --chdir "$CASE_WORKSPACE" -- "$@"
~~~

Before installation, create sorted manifests of `$REAL_HOME/.agents/skills`, `$REAL_HOME/.codex/skills`, and `$REAL_HOME/.claude/skills` containing relative path, file type, mode, owner, symlink target, and SHA-256 for regular files, plus temporary hash/stat records of both real credential files. Run `codex login status` and `claude auth status --json` inside the wrapper as read-only preflight. An EXIT trap recomputes and `cmp`s all real skill/credential manifests even on case failure; any change fails the case. Credential hashes remain temp-only and never enter evidence. Per case the runner also snapshots `.lat`, drives the real host/client, validates route/model/session/carrier/completion/seal/stop state, compares `.lat`, and writes one concise record. The `lifecycle` case records `stop_intent_absent_after_finalize` and `clean_after_stop_succeeded` only after a confirmed, token-matched native finalize removes the matching intent/owner/active-turn and the immediately following clean succeeds; its failed/uncertain/mismatched subcases must retain all three records. `identity_unambiguous` is true only when an invoked operation ends with `identity_state: sealed`, or a pre-execution refusal ends with `identity_state: not-created`; provisional/unknown state is always false.

~~~bash
E2E_TMP=$(mktemp -d /tmp/agent-invoke-e2e-red.XXXXXX)
bash tests/agent-invoke/e2e/run-installed-e2e.sh \
  --source "$E2E_TMP/missing" --case codex-native \
  --evidence "$E2E_TMP/red.json"
~~~

Expected: nonzero `agent-invoke is not installed`, no state/`.lat` side effect, and byte-identical real skill/credential manifests.

- [ ] **Step 2: Run local installed native/exec/TUI smoke.**

~~~bash
E2E_TMP=$(mktemp -d /tmp/agent-invoke-local-e2e.XXXXXX)
for case_id in codex-native codex-to-claude-exec same-host-tui; do
  bash tests/agent-invoke/e2e/run-installed-e2e.sh \
    --source "$PWD" --case "$case_id" \
    --evidence "$E2E_TMP/$case_id.json" || exit $?
done
jq -e -s 'length == 3 and all(.[]; .passed and .lat_unchanged and
  .identity_unambiguous and .real_skill_roots_unchanged and .real_credentials_unchanged and
  (.lat_dispatch_installed|not))' \
  "$E2E_TMP"/*.json
trash-put -- "$E2E_TMP"
~~~

Expected: all three routes work with only the standalone installed package.

- [ ] **Step 3: Commit runner and push only `dev`.**

~~~bash
git add tests/agent-invoke/e2e/run-installed-e2e.sh
git commit -m "test(agent-invoke): add installed E2E gate"
test "$(git rev-parse main)" = 5a8e76c
git push origin dev
REMOTE_DEV=$(gh api repos/ouob-tw/LoopAgentTeams/git/ref/heads/dev --jq .object.sha)
test "$REMOTE_DEV" = "$(git rev-parse HEAD)"
~~~

Expected: remote `dev` equals local HEAD; `main` is unchanged.

- [ ] **Step 4: Run all 14 remote `#dev` groups.**

~~~bash
E2E_TMP=$(mktemp -d /tmp/agent-invoke-dev-e2e.XXXXXX)
for case_id in \
  codex-native claude-native codex-to-claude-exec claude-to-codex-exec \
  same-host-exec same-host-tui native-unavailable unsupported-client \
  managed-exec-resume managed-tui-resume imported-resume native-resume \
  lifecycle prune
do
  bash tests/agent-invoke/e2e/run-installed-e2e.sh \
    --source 'ouob-tw/LoopAgentTeams#dev' --case "$case_id" \
    --evidence "$E2E_TMP/$case_id.json" || exit $?
done
jq -e -s 'length == 14 and all(.[]; .passed and .lat_unchanged and
  .identity_unambiguous and .real_skill_roots_unchanged and .real_credentials_unchanged and
  (.lat_dispatch_installed|not) and .authoritative_outcome and
  (if .case_id == "lifecycle" then
    .stop_intent_absent_after_finalize and .clean_after_stop_succeeded
   else true end))' "$E2E_TMP"/*.json
jq -s '{candidate_sha:.[0].candidate_sha,cases:map({
  case_id,route,client,mode,model,session_id,tool_events,
  outcome_event,exit_status,identity_state,identity_unambiguous,installed_manifest_sha256,
  real_skill_roots_unchanged,real_credentials_unchanged,lat_unchanged,
  stop_intent_absent_after_finalize,clean_after_stop_succeeded,passed
})}' "$E2E_TMP"/*.json > tests/agent-invoke/e2e/evidence-summary.json
trash-put -- "$E2E_TMP"
~~~

Expected: 14 groups PASS. Grouped resume/lifecycle cases include both Claude and Codex subcases and every negative probe in spec 9.3; successful native stop leaves no stop-intent and permits clean, while every failed/uncertain/mismatched finalize stays fail-closed.

- [ ] **Step 5: Bind evidence to candidate and verify boundaries.**

~~~bash
jq -e '.cases|length == 14 and all(.[];
  .passed and .identity_unambiguous and
  (.installed_manifest_sha256|type == "string" and length == 64) and
  .real_skill_roots_unchanged and .real_credentials_unchanged and
  (if .case_id == "lifecycle" then
    .stop_intent_absent_after_finalize and .clean_after_stop_succeeded
   else true end))' \
  tests/agent-invoke/e2e/evidence-summary.json
REMOTE_DEV=$(gh api repos/ouob-tw/LoopAgentTeams/git/ref/heads/dev --jq .object.sha)
CANDIDATE_SHA=$(jq -r .candidate_sha tests/agent-invoke/e2e/evidence-summary.json)
git merge-base --is-ancestor "$CANDIDATE_SHA" "$REMOTE_DEV"
git diff --exit-code "$CANDIDATE_SHA" "$REMOTE_DEV" -- agent-invoke/
test "$(jq -r .candidate_sha tests/agent-invoke/e2e/evidence-summary.json)" = \
  "$(git rev-parse HEAD)"
git diff --exit-code 5a8e76c -- lat-dispatch/
test "$(git rev-parse main)" = 5a8e76c
test -z "$(find agent-invoke -type f | rg '/(tests|fixtures|traces|evidence|reports)/' || true)"
~~~

Expected: evidence SHA equals tested commit, Dispatch/main unchanged, evidence outside package.

- [ ] **Step 6: Commit concise evidence to `dev` and stop.**

~~~bash
git add tests/agent-invoke/e2e/evidence-summary.json
git commit -m "test(agent-invoke): record dev candidate evidence"
git push origin dev
gh api repos/ouob-tw/LoopAgentTeams/git/ref/heads/dev --jq .object.sha
git status --short
~~~

Expected: only `dev` advances. Ask the user to install `#dev` and confirm observed behavior; do not release `main`.

## QA Acceptance Mapping

`qa_executor` must install the exact remote `dev` SHA in a fresh isolated HOME, create independent acceptance scripts only in `tests/agent-invoke/qa_e2e/`, drive real hosts/clients as a user, and record command plus concise output/event/process/filesystem evidence in `qa-results.md`. Integration PASS, test-executor E2E summaries, review verdicts, and agent self-reports are not substitutes.

| QA | Integration target | Installed E2E target | Independent real verification |
|---|---|---|---|
| QA-1 same-host native | Route integration: Codex→GPT/Codex and Claude→Claude native; returned handle seals once under launch token; fake CLI/ZMX empty; model passed; missing native refuses | `codex-native`, `claude-native`, `native-unavailable` | Cite Codex child linkage + child `turn_context.model` and Claude `Agent` event/model; prove the first returned runtime handle sealed the provisional operation exactly once before it became resumable; compare process, external session-root, ZMX, and state manifests; prove no CLI/ZMX/monitor/PID. Disable native and prove no fallback. |
| QA-2 cross-host exec | Exactly one correct fake exec for both directions; immutable settings/full result | `codex-to-claude-exec`, `claude-to-codex-exec` | Request opposite family from each real host; cite disclosure, exact child executable/argv, authoritative session model/ID, Final Answer, no TUI, unchanged `.lat`, no LAT phases. |
| QA-3 external only by condition | Explicit exec/TUI, missing native, unsupported client each choose zero/one expected carrier | `same-host-exec`, `same-host-tui`, `native-unavailable`, `unsupported-client` | Run four fresh user prompts; cite disclosure/carrier/model for overrides and before/after process/ZMX/session/state snapshots for refusals. |
| QA-4 Dispatch independent | Contract rejects dependency/mirror/`lat-dispatch` text | Every Bubblewrap-isolated install asserts Dispatch absent, candidate/installed hashes match, and real skill/auth manifests do not change; native/exec/TUI smoke | Capture real skill/credential manifests; set `HOME` to the case home for `/home/swy/.bun/bin/bunx skills add 'ouob-tw/LoopAgentTeams#dev' -g --agent codex claude-code --skill agent-invoke --copy -y`; require `skills list -g --json` contains only `agent-invoke`; compare installed bytes with `git archive "$REMOTE_DEV" agent-invoke`; run real clients only through the read-only-root/per-file-read-only-credential Bubblewrap command; complete all three routes; compare pre/post manifests and run `git diff --exit-code 5a8e76c -- lat-dispatch/`. If safe isolation/auth preflight is unavailable, report NOT RUN/TOOL_OR_ENVIRONMENT_FAILURE rather than using real HOME. |
| QA-5 no LAT lifecycle | State/route tests assert HOME-only state and no workspace `.lat` | Every group requires absent/byte-identical `.lat` | Hash `.lat` before/after successful native, exec, TUI; cite zero Spec/Plan/review/test/QA/ledger events. |
| QA-6 concise skill | ≤150 lines, direct conditional refs, no mirror/package evidence | Trigger eval 12+6 × 3; installed read traces | Run line/validator/manifest gates; cite SKILL plus only route-required reference reads for native/exec/TUI and no external refs on native. |
| QA-7 real evidence wins | Fake suite explicitly cannot satisfy QA-7 | All 14 real groups bound to remote SHA and installed-package hash | Independently rerun every group at exact dev SHA; accept only actual tool/carrier/session/completion/filesystem evidence, exact remote SHA, matching installed manifest SHA-256, and unchanged real skill/credential manifests. |
| QA-8 exact resume/import | Bootstrap/seal tests plus managed exec/TUI, imported Claude/Codex, native handle, unsafe/missing identity, no replacement | `managed-exec-resume`, `managed-tui-resume`, `imported-resume`, `native-resume` | For fresh Codex external/native launches, observe provisional state before prompt, bind the first authoritative `thread.started`/runtime handle once under the same turn/seal tokens, and reject rebind/mismatch/crash uncertainty with no resumable replacement. Confirm Claude preallocated UUID against authoritative start. For both clients compare sealed session ID/model/effort/permission/workspace across new turn; validate live/dead TUI wrappers, exact imports, and valid/invalid native handles; prove no replacement/fuzzy selector/route switch. |
| QA-9 predictable cleanup | Owner/token, active turn, concurrency, PID reuse/wrong handle, external stop, native prepare/host-tool/finalize stop, clean/prune, non-target integrity | `lifecycle`, `prune`; lifecycle evidence requires `stop_intent_absent_after_finalize` and `clean_after_stop_succeeded` | Against real exec/TUI/native carriers: active/unsealed/stop-intent clean refuses; `stop-external` targets one verified PID or ZMX handle; native prepare writes a blocking intent, then exact Codex `interrupt_agent` or Claude `TaskStop` result is required before finalize atomically removes that matching intent with owner/active-turn. Prove the successful state has no stop-intent and immediate clean trashes the registry only while the native session remains importable. Force failed/uncertain/mismatched finalize and prove all three records remain unchanged and fail-closed; PID reuse/wrong handles/concurrent mutations fail; prune dry-run then one confirmed safe entry; ambiguous active metadata stays manual-only. |

## Final Verification Gate

After every QA item is independently PASS, Dispatch runs this regression exactly once:

~~~bash
find agent-invoke/scripts tests/agent-invoke -type f -name '*.sh' -exec bash -n {} +
find agent-invoke/scripts tests/agent-invoke -type f -name '*.sh' -exec shellcheck {} +
uvx --from skills-ref agentskills validate ./agent-invoke
bash tests/agent-invoke/integration/skill-contract-test.sh
for test_file in tests/agent-invoke/integration/*-test.sh; do bash "$test_file" || exit $?; done
test "$(wc -l < agent-invoke/SKILL.md)" -le 150
test -z "$(find agent-invoke -type f | rg '/(tests|fixtures|traces|evidence|reports)/' || true)"
! rg -n --fixed-strings 'lat-dispatch' agent-invoke
git diff --exit-code 5a8e76c -- lat-dispatch/
test "$(git rev-parse main)" = 5a8e76c
jq -e '.cases|length == 14 and all(.[];
  .passed and .identity_unambiguous and
  (.installed_manifest_sha256|type == "string" and length == 64) and
  .real_skill_roots_unchanged and .real_credentials_unchanged and
  (if .case_id == "lifecycle" then
    .stop_intent_absent_after_finalize and .clean_after_stop_succeeded
   else true end))' \
  tests/agent-invoke/e2e/evidence-summary.json
REMOTE_DEV=$(gh api repos/ouob-tw/LoopAgentTeams/git/ref/heads/dev --jq .object.sha)
CANDIDATE_SHA=$(jq -r .candidate_sha tests/agent-invoke/e2e/evidence-summary.json)
git merge-base --is-ancestor "$CANDIDATE_SHA" "$REMOTE_DEV"
git diff --exit-code "$CANDIDATE_SHA" "$REMOTE_DEV" -- agent-invoke/
git diff --check
git status --short
~~~

Expected: syntax, ShellCheck, Agent Skills validation, contract, integration, package boundaries, Dispatch/main immutability, 14-case evidence, and whitespace gates pass. `git status` may show only explicitly preserved pre-existing user changes.
