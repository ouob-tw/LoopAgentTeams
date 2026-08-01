
# Agent Invoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone `agent-invoke` skill that invokes or resumes one Codex/Claude agent through the exact native, external exec, or external TUI route required by the approved specification, without loading or changing LAT Dispatch.

**Architecture:** At continuation baseline `be8d4a8`, `agent-invoke/SKILL.md` is the sole route selector and deterministic fake-carrier suites pass, but real-schema review proved the flat state engine, external turn ownership/completion, cleanup, cross-client default, and trigger evaluator do not satisfy the approved Spec. The continuation replaces only those demonstrated boundaries with the Spec 7.8 operation tree and exact real-client turn binding, then runs the fixed behavior proxy and installed E2E gates. All tests and evidence remain under repo-level `tests/agent-invoke/`, outside the installed package.

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
- Raw transcripts are not committed. Evidence retains only case ID, candidate SHA, route, actual tool/carrier event, authoritative completion event, model/session identity, exit status, and filesystem delta; it does not persist result prose.
- Use `trash-put` for ordinary removal, `shred` for sensitive temp files, `uv`/`uvx` instead of direct Python, and `gh` for GitHub operations.
- Preserve unrelated dirty work. Stage only task paths and inspect `git status --short` before every commit.
- Stop after real `#dev` evidence and user confirmation request. This plan does not release or integrate into `main`.

## Continuation Baseline

- Start from `dev@be8d4a8d50f647a67679f1007074c9bdc00a0f0d`. Do not reset, replay, or rebuild the already reviewed package work.
- Preserve all four existing `code_executor_1` through `code_executor_4` task/result rows as `PARTIAL`; they are historical execution records, not unchecked tasks to rerun.
- The package, deterministic fake contract/integration suites, installed runner skeleton, and missing-source fail-closed gate already exist, but they contain demonstrated false assumptions about flat state, real Codex/Claude completion schemas, exec owner lifecycle, and cross-client default routing. Replace only those proven defects and retain unrelated implementation.
- The obsolete trigger blocker is closed by the approved Spec change: raw client JSONL, Skill activation events, `Read` events, and `SKILL.md` path events are no longer acceptance evidence.
- The residual installed-E2E blockers remain open: Spec-tree state, exact live/resumed carrier ownership, completion-event-to-session/handle/turn correlation, route-specific model recovery, structured refusal evidence, lifecycle/prune validation, and all real local/remote installed runs.
- Before any edit, verify `git rev-parse HEAD` equals `be8d4a8d50f647a67679f1007074c9bdc00a0f0d`, `git diff --name-only -- lat-dispatch` is empty, and the only pre-existing dirty path is the approved Spec unless Dispatch has recorded a newer reviewed docs commit.

## File Responsibilities and Stable Interfaces

### Installed package (already present at `be8d4a8`; modify only for a demonstrated regression)

- `agent-invoke/SKILL.md` — new/resume parser and sole route owner.
- `agent-invoke/references/{native,external-common,exec,tui,monitoring,resume,lifecycle}.md` — focused selected-route instructions.
- `agent-invoke/scripts/manage-run-state.sh` — registry, launch identity sealing, and lifecycle transaction engine; never selects a route or calls a host-native tool.
- `agent-invoke/scripts/resolve-session-reference.sh` — exact Claude/Codex UUID/path validator; never creates state.
- `agent-invoke/scripts/run-exec-client.sh` — exact child launcher/capture owner; never chooses client/session.
- `agent-invoke/scripts/monitor-session.sh` — exact transcript/baseline verifier and Final Answer extractor; never launches/stops a carrier.

Obsolete `be8d4a8` helper snapshot, retained only to identify what Task 6 must replace. These commands and the flat schema below are not the executable post-correction interface:

~~~text
manage-run-state.sh bootstrap-launch OPERATION CLIENT WORKSPACE [PROVISIONAL_SESSION_ID] [native|exec|tui]
manage-run-state.sh seal-session OPERATION TURN_TOKEN SEAL_TOKEN SESSION_ID OWNER_JSON
manage-run-state.sh begin-turn OPERATION KIND TURN_TOKEN
manage-run-state.sh complete-turn OPERATION TURN_TOKEN
manage-run-state.sh prepare-native-stop OPERATION TURN_TOKEN HANDLE OWNER_TOKEN
manage-run-state.sh confirm-native-stop OPERATION TURN_TOKEN HANDLE OWNER_TOKEN STOP_TOKEN stopped|failed|uncertain
manage-run-state.sh finalize-native-stop OPERATION TURN_TOKEN HANDLE OWNER_TOKEN STOP_TOKEN
manage-run-state.sh stop-external OPERATION TURN_TOKEN OWNER_TOKEN
manage-run-state.sh clean-one OPERATION --dry-run|--confirm
manage-run-state.sh reuse-zmx OPERATION TURN_TOKEN SESSION_ID OWNER_TOKEN
manage-run-state.sh replace-zmx OPERATION TURN_TOKEN SESSION_ID OLD_OWNER_TOKEN REPLACEMENT_OWNER_JSON
manage-run-state.sh prune [--dry-run]
manage-run-state.sh prune --confirm OPERATION

resolve-session-reference.sh resolve claude|codex UUID_OR_ABSOLUTE_PATH \
  WORKSPACE exec|tui MODEL EFFORT PERMISSION

run-exec-client.sh launch|resume OPERATION claude|codex WORKSPACE PROMPT_FILE \
  MODEL EFFORT PERMISSION [SESSION_ID] [TURN_TOKEN]

monitor-session.sh OPERATION TURN_TOKEN OWNER_TOKEN ABSOLUTE_TRANSCRIPT_JSONL
~~~

`monitor-session.sh` exits `0` only after printing one Final Answer and clearing the exact turn. Usage or any missing, unsealed, foreign, incomplete, identity/model, or completion evidence exits `70`; continuation tests must assert observed current exit behavior rather than invent additional codes.

At `be8d4a8`, state is one private flat JSON record at `$HOME/.agent-invoke/runs/<operation>.json`; external immutable settings are a separate current-user-owned `0600` regular file at `$HOME/.agent-invoke/runs/<operation>.manifest`. Task 6 Step 1 explicitly rejects this as incompatible with the approved Spec:

~~~json
{"schema":1,"operation_id":"op-1","client":"codex","workspace":"/tmp/work","mode":"exec","status":"active","session":{"id":"exact-session-id","sealed":true},"owner":{"type":"exec","pid":12345,"started":"stable-process-start","executable":"/absolute/bin/codex","token":"owner-token"},"stop_intent":null,"active_turn":{"kind":"resume","token":"turn-token","seal_token":null}}
{"client":"codex","workspace":"/tmp/work","model":"gpt-5.6-terra","effort":"medium","permission":"read-only"}
~~~

Fresh managed launches create the flat state with an unsealed session and launch turn. Claude may carry a provisional UUID; Codex must not. The first authoritative session event or native runtime handle calls positional `seal-session` with the same turn/seal tokens and owner JSON. A second seal, mismatch, crash before seal, or uncertain identity stays fail-closed. The `.manifest` is created by `run-exec-client.sh` for external launch and is the immutable source for client/workspace/model/effort/permission; resume requires exact manifest equality.

Native stop is split-phase in the same state record: `prepare-native-stop` sets `.stop_intent` and returns its token; `confirm-native-stop` writes `<operation>.json.stop-confirmation.json`; `finalize-native-stop` verifies matching operation/turn/handle/owner/stop tokens and `status:"stopped"`, then clears `.stop_intent`, `.owner`, and `.active_turn`. Failed, uncertain, or mismatched finalize retains the state. `stop-external` verifies the exact exec PID/start/executable or ZMX owner before mutation; `clean-one --confirm` trashes only the exact recoverable state JSON; `prune --confirm OPERATION` revalidates one ID.

### Repository-only test/evidence tree

- `tests/agent-invoke/fixtures/bin/{claude,codex,zmx}` — observable fake carriers logging argv/stdin and deterministic client-native events.
- `tests/agent-invoke/fixtures/sessions/{claude,codex}/` — valid, ambiguous, missing-metadata, escaped, symlink, non-regular, completed, incomplete, and resumed fixtures.
- `tests/agent-invoke/integration/skill-contract-test.sh` — package shape, line budget, route order, progressive disclosure, standalone boundary, forbidden shortcuts.
- `tests/agent-invoke/integration/state-manager-test.sh` — modes, atomic mutation, locks, active turns, owner verification, stop/clean/prune, path/symlink attacks.
- `tests/agent-invoke/integration/session-reference-test.sh` — client-specific exact import validation and immutable setting sources.
- `tests/agent-invoke/integration/exec-client-test.sh` — fake launch/resume, argv fidelity, prompt stdin, owner identity, failures.
- `tests/agent-invoke/integration/monitor-session-test.sh` — exact baseline completion, identity/model verification, Final Answer, incomplete turns.
- `tests/agent-invoke/integration/route-integration-test.sh` — fresh-host fake-carrier route matrix and concurrency.
- `tests/agent-invoke/e2e/trigger-prompts.json` and `run-trigger-eval.sh` — fixed 11-positive/3-negative, two-run-per-client decision-only behavior proxy.
- `tests/agent-invoke/e2e/run-installed-e2e.sh` and `evidence-summary.json` — fixed real `#dev` case runner and concise evidence.
- Reserve `tests/agent-invoke/qa_e2e/` for independent `qa_executor` tests and `qa-results.md`. Code/test executors must not author or weaken them.

---

### Historical Task 1: RED baseline and native-first route entry (already implemented; do not execute)

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

### Historical Task 2: Secure registry, lock, active turn, and exact resume validation (already implemented; do not execute)

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

### Historical Task 3: External exec ownership and authoritative completion (already implemented; do not execute)

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

### Historical Task 4: External TUI and precise lifecycle safety (already implemented; do not execute)

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
- Modify: `tests/agent-invoke/e2e/trigger-prompts.json`
- Modify: `tests/agent-invoke/e2e/run-trigger-eval.sh`
- Modify: `tests/agent-invoke/integration/skill-contract-test.sh`
- Modify: `agent-invoke/SKILL.md`

**Interfaces:**
- Consumes: the approved 14-case, five-field truth table and the existing concise Skill.
- Produces: a decision-only behavior proxy with exactly 14 cases × 2 clients × 2 repetitions, deterministic `jq` comparison, no product side effects, and no raw retained output.

- [ ] **Step 1: Replace the obsolete prompt fixture and prove the old runner rejects it.** Each object contains only `id`, a concrete host-rendered `prompt` source, and complete `expected.codex`/`expected.claude` envelopes. Use the 11 positive/safe-refusal cases `generic-native`, `exact-claude-model`, `cross-client`, `explicit-exec`, `explicit-tui`, `unsupported-client`, `operation-resume`, `reference-resume`, `stop`, `clean`, `prune`, plus `full-LAT`, `non-delegation-request`, and `direct-work`. Assert exact case IDs, five fields, allowed enums, and both client expectations before starting a client.

~~~bash
(
  set -e
  RED_TMP=$(mktemp -d /tmp/agent-invoke-trigger-red.XXXXXX)
  cleanup() { trash-put -- "$RED_TMP" >/dev/null 2>&1 || :; }
  trap cleanup EXIT
  jq -e '
    length == 14 and
    ([.[].id] | unique | length) == 14 and
    all(.[]; (.expected | keys | sort) == ["claude","codex"] and
      all(.expected[];
        (keys | sort) == ["decision_scope","intent","reason_code","route","target_client"]
      )
    )
  ' tests/agent-invoke/e2e/trigger-prompts.json
  set +e
  bash tests/agent-invoke/e2e/run-trigger-eval.sh \
    --client codex --skill-root "$PWD/agent-invoke" \
    --output "$RED_TMP/obsolete.json"
  RED_STATUS=$?
  set -e
  test "$RED_STATUS" -eq 65
  test ! -e "$RED_TMP/obsolete.json"
)
~~~

Expected: fixture validation passes; the obsolete 18-case activation/read runner exits nonzero before invoking a client.

- [ ] **Step 2: Implement the minimal decision-only runner.** Keep the existing CLI. Add focused functions `validate_prompt_set`, `render_case`, `create_isolated_client_home`, `run_decision_turn`, `extract_single_envelope`, `reject_tool_events`, `compare_expected`, and `write_summary`. The parent reads expectations before entering isolation and passes the child only the rendered request, the allowed enum values, and the five-field output contract.

For Claude, use `--print --output-format stream-json --no-session-persistence --strict-mcp-config`, an empty MCP config, and `--tools ""`; do not use `--disable-slash-commands`, because that disables the candidate Skill itself. For Codex, use `exec --ephemeral --ignore-user-config --ignore-rules --sandbox read-only --json`, `agents.enabled=false`, `web_search="disabled"`, and a temporary `--output-schema`; current Codex has no complete local-tool-disable flag, so any command/file/MCP/web/agent/plan tool event is a hard failure. Do not claim that read-only mode disables tools.

Before each turn, the parent validates `--skill-root` with Agent Skills validation and copies only that package into the client-visible isolated skill location (`$CASE_WORKSPACE/.agents/skills/agent-invoke` for Codex or `$CASE_CLAUDE_CONFIG/skills/agent-invoke` for Claude), then makes the copied package read-only. This candidate package is the only project content visible to the child; it contains neither prompt fixtures nor expected envelopes. The parent accepts authentication only from the current-user-owned, regular, non-symlink `0600` Codex/Claude credential file and mounts only that exact file read-only; an unsafe or missing credential exits 69 before any client turn.

Run both clients inside Bubblewrap with a read-only root, the real home hidden, isolated client config/HOME/workspace/tmp writable, and only the exact authentication file mounted read-only into the isolated client config. Hide the repository path and do not mount the prompt fixture, expectations, real `~/.agent-invoke`, or real session roots. Resume prompts use synthetic UUIDs and metadata that cannot resolve outside the case workspace. Snapshot the real registry and repository before/after the complete client run and fail on any delta.

Parse transient client streams only to reject tool/permission events and extract exactly one final envelope. Timeout, nonzero status, non-JSON final output, extra final text, unknown enum, mismatch, state delta, or any tool event fails closed. Persist only case ID, `passed_runs`, repetition count, and structured reason/status without raw model text. `shred -u` every prompt, schema, stream, and final-output temp file, then `trash-put` the empty case directory. Never upload those files as artifacts.

- [ ] **Step 3: Correct the observed cross-client default before spending client turns.** Add a RED contract proving Codex→Claude and Claude→Codex choose external exec without requiring native unavailability or a second consent prompt, while same-family native-unavailable still requires explicit external consent. Also require the description to cover exact `clean` and `prune` lifecycle intent. Make only the corresponding route sentence and description correction in `SKILL.md`; do not add examples, a second route table, or evaluation instructions.

~~~bash
bash tests/agent-invoke/integration/skill-contract-test.sh
uvx --from skills-ref agentskills validate ./agent-invoke
test "$(wc -l < agent-invoke/SKILL.md)" -le 150
~~~

Expected: contract, validator, and line budget PASS; `lat-dispatch/` remains unchanged.

- [ ] **Step 4: Run static RED/GREEN checks before spending client turns.**

~~~bash
bash -n tests/agent-invoke/e2e/run-trigger-eval.sh
shellcheck tests/agent-invoke/e2e/run-trigger-eval.sh
jq -e 'length == 14 and all(.[]; has("expected"))' \
  tests/agent-invoke/e2e/trigger-prompts.json
bash tests/agent-invoke/integration/skill-contract-test.sh
uvx --from skills-ref agentskills validate ./agent-invoke
test "$(wc -l < agent-invoke/SKILL.md)" -le 150
~~~

Expected: all commands exit 0. Do not edit `SKILL.md` unless a concrete case fails and the smallest description/instruction correction is directly supported by that failure.

- [ ] **Step 5: Run the 56-turn behavior proxy on both clients.**

~~~bash
(
  set -e
  TRIGGER_TMP=$(mktemp -d /tmp/agent-invoke-trigger.XXXXXX)
  cleanup() { trash-put -- "$TRIGGER_TMP" >/dev/null 2>&1 || :; }
  trap cleanup EXIT
  bash tests/agent-invoke/e2e/run-trigger-eval.sh \
    --client codex --skill-root "$PWD/agent-invoke" \
    --output "$TRIGGER_TMP/codex.json"
  bash tests/agent-invoke/e2e/run-trigger-eval.sh \
    --client claude --skill-root "$PWD/agent-invoke" \
    --output "$TRIGGER_TMP/claude.json"
  jq -e -s '
    length == 2 and
    ([.[].client] | sort) == ["claude","codex"] and
    all(.[]; (.cases | length) == 14 and
      all(.cases[]; .passed == true and .runs == 2 and .passed_runs == 2)) and
    ([.[0].cases[].id] | sort) == ([.[1].cases[].id] | sort) and
    ([.[0].cases[].id] | sort) == ([
      "clean","cross-client","direct-work","exact-claude-model","explicit-exec",
      "explicit-tui","full-LAT","generic-native","non-delegation-request",
      "operation-resume","prune","reference-resume","stop","unsupported-client"
    ] | sort)
  ' "$TRIGGER_TMP/codex.json" "$TRIGGER_TMP/claude.json"
)
~~~

Expected: both summaries contain the same 14 case IDs and every case passes 2/2; total fresh turns are 56. This is behavior-proxy evidence only, not proof of Skill file loading and not installed route E2E.

- [ ] **Step 6: Run the existing package/integration regression without redesign.**

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

- [ ] **Step 7: Commit the behavior-proxy and approved minimal Skill correction.**

~~~bash
git status --short
git add agent-invoke/SKILL.md \
  tests/agent-invoke/integration/skill-contract-test.sh \
  tests/agent-invoke/e2e/trigger-prompts.json \
  tests/agent-invoke/e2e/run-trigger-eval.sh
test -z "$(git diff --cached --name-only | rg -v \
  '^(agent-invoke/SKILL\.md|tests/agent-invoke/integration/skill-contract-test\.sh|tests/agent-invoke/e2e/(trigger-prompts\.json|run-trigger-eval\.sh))$' || true)"
git diff --cached --check
git commit -m "test(agent-invoke): add decision-only trigger proxy"
~~~

### Task 6: Isolated local install and fourteen real `#dev` E2E groups

**Files:**
- Modify: `agent-invoke/scripts/manage-run-state.sh`
- Modify: `agent-invoke/scripts/run-exec-client.sh`
- Modify: `agent-invoke/scripts/monitor-session.sh`
- Modify: `agent-invoke/references/lifecycle.md`
- Modify: `agent-invoke/references/resume.md`
- Modify: `agent-invoke/references/exec.md`
- Modify: `agent-invoke/references/monitoring.md`
- Modify: `tests/agent-invoke/integration/state-manager-test.sh`
- Modify: `tests/agent-invoke/integration/exec-client-test.sh`
- Modify: `tests/agent-invoke/integration/monitor-session-test.sh`
- Create: `tests/agent-invoke/fixtures/sessions/codex/real-0.146-turn.jsonl`
- Create: `tests/agent-invoke/fixtures/sessions/claude/real-completed-turn.jsonl`
- Modify: `tests/agent-invoke/e2e/run-installed-e2e.sh`
- Create: `tests/agent-invoke/e2e/validate-installed-evidence.sh`
- Create: `tests/agent-invoke/e2e/installed-evidence-validator-test.sh`
- Create: `tests/agent-invoke/e2e/evidence-summary.json`
- Finish, review, and commit the scoped completion fix before collecting evidence; after collection starts, do not modify installed package files.

**Interfaces:**
- Consumes: local package, then exact remote `dev` commit.
- Produces: concise evidence for specification 9.3 groups `codex-native`, `claude-native`, `codex-to-claude-exec`, `claude-to-codex-exec`, `same-host-exec`, `same-host-tui`, `native-unavailable`, `unsupported-client`, `managed-exec-resume`, `managed-tui-resume`, `imported-resume`, `native-resume`, `lifecycle`, and `prune`.

- [ ] **Step 1: Correct the demonstrated persistent-state contract before adding evidence.** Extend `state-manager-test.sh` RED cases for the exact Spec 7.8 tree: `runs/<operation>/metadata.json`, `session-ref`, `runtime/owner.json`, and `runtime/active-turn.json`, plus token-bound `runtime/stop-intent.json` only while stopping. Assert `0700` directories, `0600` files, same-directory atomic replacement, no followed symlinks, and metadata fields `route,client,mode,model,effort,permission,workspace,origin,created_at,last_resumed_at`. All routes, including native, must have immutable model/settings in metadata. `clean-one --confirm` must `trash-put` the one inactive run directory; confirmed prune must revalidate and trash only one directory.

Replace the flat-state bootstrap interface with:

~~~text
manage-run-state.sh bootstrap-launch OPERATION ROUTE CLIENT MODE MODEL EFFORT PERMISSION WORKSPACE ORIGIN [PROVISIONAL_SESSION_ID]
manage-run-state.sh import OPERATION ROUTE CLIENT MODE MODEL EFFORT PERMISSION WORKSPACE imported NORMALIZED_SESSION_JSON_FILE
~~~

Keep the remaining positional command names, but make them read/write the Spec tree and separate runtime files. `session-ref` is absent while identity is provisional; sealing creates it once with only the exact client session ID, canonical transcript path, or native runtime handle. `runtime/owner.json` contains only carrier identity: exec PID/start/executable/token, exact ZMX handle/token, or native handle/token. `runtime/active-turn.json` contains turn token, action, provisional/sealed session identity, pre-turn baseline, client turn ID when exposed, and `created_at`. External immutable settings live in `metadata.json`; no new `.manifest` is created. `import` accepts only the owned `0600` regular JSON output of `resolve-session-reference.sh resolve`, re-verifies its client/mode/workspace/settings against the explicit immutable arguments, requires `origin=imported`, creates an identity-only session-ref with no owner or active turn, and refuses an existing ID. Tests cover managed/imported separation, mismatch, symlink, replay, and no carrier creation.

Existing legacy `runs/<operation>.json` and `.manifest` files are never deleted or guessed: every command detects them, exits 65 with `legacy flat state requires exact re-import`, and leaves bytes unchanged. A user may explicitly resolve the old exact native session reference and call the new `import` with a new operation ID; no automatic migration is allowed.

Update lifecycle/resume/exec references and all affected deterministic tests. Preserve lock ownership and fail-closed semantics. Run:

~~~bash
bash tests/agent-invoke/integration/state-manager-test.sh
bash tests/agent-invoke/integration/session-reference-test.sh
bash tests/agent-invoke/integration/route-integration-test.sh
bash -n agent-invoke/scripts/manage-run-state.sh
shellcheck agent-invoke/scripts/manage-run-state.sh
~~~

Expected: tree/schema/lifecycle tests PASS; legacy flat-state probes exit 65 byte-identically; syntax and ShellCheck exit 0. This correction supersedes the incompatible `be8d4a8` flat-state snapshot documented above.

- [ ] **Step 2: Write RED tests from sanitized real client schemas for exact external-turn ownership.** Build the Codex fixture from the observed 0.146 rollout shape: one `turn_context` carrying native `turn_id` and `model`, one final-answer `response_item` without invented model/turn-token fields, and one `task_complete` or `turn_complete` carrying `payload.turn_id`. Build the Claude fixture with one exact `sessionId`, a post-baseline user event, and the matching assistant `end_turn`/model event. Replace all prompt/result text with fixed non-user strings.

Tests must prove: fresh launch baseline is `0`; resume baseline is captured before client execution; both clients seal one canonical current-user-owned non-symlink transcript identity in `session-ref`; `active-turn.json` stores that turn's baseline and, for Codex, the one native client `turn_id`; exec owner remains PID/start/executable/token-only; a resume atomically rebinds only that carrier owner and active-turn for the same session; caller-supplied alternate paths, post-execution baselines, missing/duplicate turn contexts, wrong turn IDs, wrong models, same-session fabricated files, and completion before Final Answer all fail without clearing the active turn.

~~~bash
bash tests/agent-invoke/integration/state-manager-test.sh
bash tests/agent-invoke/integration/exec-client-test.sh
bash tests/agent-invoke/integration/monitor-session-test.sh
~~~

Expected: new real-schema cases FAIL because current Codex monitoring expects synthetic `payload.model`/`payload.turn_token`, launch baseline is post-turn, Claude path/baseline is unsealed, and resume cannot bind a new exact external owner.

- [ ] **Step 3: Implement the minimal exact-turn completion and carrier ownership fix.** Add one positional state command:

~~~text
manage-run-state.sh bind-external-turn OPERATION TURN_TOKEN SESSION_ID OWNER_JSON
~~~

It accepts only an `exec` operation whose identity-only `session-ref` and active turn refer to the same session, then atomically replaces `runtime/owner.json` with PID/start/executable/token while updating that same `runtime/active-turn.json` with sealed session identity reference, nonnegative pre-turn baseline, and client turn ID when exposed. Launch `seal-session` creates identity-only session ID/transcript path in `session-ref` and updates active-turn fields in the same transaction; resume uses `bind-external-turn` without changing session-ref. A mismatch leaves runtime files byte-identical.

For both clients, `run-exec-client.sh` resolves the exact canonical transcript and captures its line count before a resume; a fresh transcript has baseline `0`. It starts the child, immediately records PID/start/executable/token, then watches only the private client stream until the authoritative session-start/turn identity appears. While the child is still live, launch seals the exact session ID/transcript path plus carrier owner and resume calls `bind-external-turn`; a bounded start-evidence timeout stops only that verified child and leaves the turn fail-closed. After the child exits successfully, the launcher re-resolves the same owned path. Codex extracts exactly one current native `turn_id` into active-turn state; Claude joins the sealed session-ref path with the active-turn baseline because its transcript schema has no equivalent turn ID.

`monitor-session.sh` joins identity-only `session-ref`, carrier-only `runtime/owner.json`, and turn-specific `runtime/active-turn.json`; it rejects any transcript argument unequal to the session-ref canonical path and reads only lines after the active-turn baseline. Codex requires one post-baseline `turn_context` whose `turn_id` equals the active-turn client turn ID and whose model equals immutable `metadata.json`, one subsequent final-answer `response_item`, and one subsequent `task_complete`/`turn_complete` with the same native `turn_id`. Claude requires the sealed session's post-baseline user→assistant `end_turn` and metadata model. Only then may it print the Final Answer and call `complete-turn` with the exact turn and owner tokens. For `exec`, successful completion verifies that the exact child is no longer live, removes `runtime/owner.json`, and removes `runtime/active-turn.json`; native and idle TUI ownership rules remain unchanged. `clean-one --confirm` can then remove the exact inactive run directory. Update `monitoring.md` to describe these real fields and prohibitions without adding a second route table.

~~~bash
for test_file in \
  tests/agent-invoke/integration/state-manager-test.sh \
  tests/agent-invoke/integration/exec-client-test.sh \
  tests/agent-invoke/integration/monitor-session-test.sh
do
  bash "$test_file" || exit $?
done
bash -n agent-invoke/scripts/manage-run-state.sh \
  agent-invoke/scripts/run-exec-client.sh agent-invoke/scripts/monitor-session.sh
shellcheck agent-invoke/scripts/manage-run-state.sh \
  agent-invoke/scripts/run-exec-client.sh agent-invoke/scripts/monitor-session.sh
~~~

Expected: all three focused suites PASS against sanitized real schemas; syntax and ShellCheck exit 0.

- [ ] **Step 4: Write focused RED tests for the remaining evidence blockers.** `installed-evidence-validator-test.sh` creates complete operation-directory snapshots, native start/child-model/completion event JSON, structured refusal JSON, and filesystem snapshots under a private `mktemp -d`. It must cover: two successful completion events where only one matches metadata, sealed session/native handle, owner, and active-turn token; zero/multiple matches; an unrelated successful `wait_agent`/monitor event; an external completion event with no model while immutable metadata contains one model; owner/session metadata conflicting with the operation; an event model conflicting with metadata; a native start tool use/result pair whose returned handle and requested model match sealed state; an authoritative child-model event for that same handle; missing or foreign child-model evidence; `native-unavailable` and `unsupported-client` structured refusal decisions with zero agent/CLI/ZMX/state/native-session deltas; refusal prose without the exact decision; successful lifecycle finalize followed by absent stop-intent/owner/active-turn and successful clean; failed/uncertain/mismatched finalize preserving those three files byte-for-byte; prune dry-run containing one exact candidate/reason; confirmed prune removing only that candidate; and ambiguous/active metadata remaining present.

~~~bash
bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh
~~~

Expected: FAIL because `validate-installed-evidence.sh` does not exist.

- [ ] **Step 5: Implement the focused validators and wire them into the installed runner.** `validate-installed-evidence.sh` exposes only:

~~~text
select_exact_completion_event OPERATION_DIR EVENTS_JSON
recover_external_model METADATA_JSON SESSION_REF_JSON OWNER_JSON ACTIVE_TURN_JSON COMPLETION_EVENT_JSON
recover_native_model METADATA_JSON SESSION_REF_JSON OWNER_JSON ACTIVE_TURN_JSON NATIVE_START_EVENT_JSON CHILD_MODEL_EVENT_JSON COMPLETION_EVENT_JSON
validate_preexecution_refusal CASE_ID DECISION_JSON TOOL_EVENTS_JSON BEFORE_DIR AFTER_DIR
validate_lifecycle_evidence BEFORE_DIR AFTER_FINALIZE_DIR AFTER_CLEAN_DIR FAILURE_DIR
validate_prune_evidence DRY_RUN_JSON CONFIRMED_ID BEFORE_DIR AFTER_DIR
~~~

`select_exact_completion_event` returns one event only when operation metadata, sealed session-ref, owner identity, and active-turn token all match; zero or multiple matches return 65. `recover_external_model` reads the one non-empty immutable model from metadata, requires client/workspace/session/owner consistency, uses the completion event only as a consistency check when it contains a model, and rejects missing, unsafe, ambiguous, or conflicting data. `recover_native_model` additionally requires one start tool use/result pair that returned the exact sealed native handle, one authoritative child event for that handle whose actual model equals metadata and the start request, and one completion for the same handle/turn; a requested model or successful wait alone is insufficient. If the host exposes no authoritative child-model event, the native case remains NOT RUN/PARTIAL and cannot publish PASS.

`validate_preexecution_refusal` applies only to the two refusal cases and requires exact final JSON `{case_id,decision:"refused",reason_code}` with reason `native-unavailable` or `unsupported-client`, an empty tool/carrier event list, no operation directory, and byte-identical Agent state, native client session roots, ZMX, process, and `.lat` manifests. The `native-unavailable` Codex case must launch the isolated host with documented `agents.enabled=false`; its prompt requests an ordinary same-family delegation and never asks the model to pretend native is unavailable. `unsupported-client` requests one concrete unsupported family. Completion/model validators apply only to invoked routes. Lifecycle validation proves the successful finalize removed exact stop-intent/owner/active-turn files before clean and proves each failed finalize retained all three byte-for-byte. Prune validation binds dry-run reason and explicit confirmation to one operation ID, proves only that run directory changed, and rejects active, ambiguous, unsealed, or non-listed targets.

The installed runner must retain structured tool inputs/results needed for operation ID, turn token, session/native handle, client, model, and tool-use/result correlation rather than flattening events to names and command strings. Invoked routes must pass completion/model validation; refusal routes must pass `validate_preexecution_refusal`; lifecycle/prune cases must pass their focused validators before setting corresponding evidence fields or `passed`. It must not infer success from a tool name, command substring, requested model without child confirmation, prose result, or an unrelated successful event.

~~~bash
bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh
bash -n tests/agent-invoke/e2e/validate-installed-evidence.sh \
  tests/agent-invoke/e2e/run-installed-e2e.sh
shellcheck tests/agent-invoke/e2e/validate-installed-evidence.sh \
  tests/agent-invoke/e2e/installed-evidence-validator-test.sh \
  tests/agent-invoke/e2e/run-installed-e2e.sh
~~~

Expected: focused validator suite PASS; syntax and ShellCheck exit 0.

- [ ] **Step 6: Review and commit the complete scoped product/evidence fix before any local install.** Run every deterministic suite, Agent Skills validation, syntax, ShellCheck, line budget, Dispatch/main boundary, and a read-only code review focused on the Spec-tree state conversion, exact external completion, live/resumed exec ownership, cleanup, legacy refusal, and evidence binding. Fix all critical/important findings and rerun the affected gates.

~~~bash
for test_file in tests/agent-invoke/integration/*-test.sh; do
  bash "$test_file" || exit $?
done
bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh
find agent-invoke/scripts tests/agent-invoke -type f -name '*.sh' -exec bash -n {} +
find agent-invoke/scripts tests/agent-invoke -type f -name '*.sh' -exec shellcheck {} +
uvx --from skills-ref agentskills validate ./agent-invoke
test "$(wc -l < agent-invoke/SKILL.md)" -le 150
git diff --exit-code 5a8e76c -- lat-dispatch/
test "$(git rev-parse main)" = 5a8e76c
git diff --check
git add agent-invoke/scripts/manage-run-state.sh \
  agent-invoke/scripts/run-exec-client.sh agent-invoke/scripts/monitor-session.sh \
  agent-invoke/references/lifecycle.md agent-invoke/references/resume.md \
  agent-invoke/references/exec.md agent-invoke/references/monitoring.md \
  tests/agent-invoke/integration/state-manager-test.sh \
  tests/agent-invoke/integration/session-reference-test.sh \
  tests/agent-invoke/integration/exec-client-test.sh \
  tests/agent-invoke/integration/monitor-session-test.sh \
  tests/agent-invoke/integration/route-integration-test.sh \
  tests/agent-invoke/fixtures/sessions/codex/real-0.146-turn.jsonl \
  tests/agent-invoke/fixtures/sessions/claude/real-completed-turn.jsonl \
  tests/agent-invoke/e2e/run-installed-e2e.sh \
  tests/agent-invoke/e2e/validate-installed-evidence.sh \
  tests/agent-invoke/e2e/installed-evidence-validator-test.sh
git diff --cached --check
git commit -m "fix(agent-invoke): bind exact operation completion"
~~~

Expected: deterministic gates and scoped review PASS; one commit contains every listed product/test path and no `lat-dispatch/`, `.lat/`, raw trace, or unrelated file.

- [ ] **Step 7: Re-run the existing installed runner isolation/auth RED contract.** The runner accepts `--source LOCAL_REPO_OR_GIT_REF --case CASE_ID --evidence ABSOLUTE_JSON`. Before changing environment it records `REAL_HOME=$HOME`, `REAL_CODEX_AUTH=${CODEX_HOME:-$HOME/.codex}/auth.json`, and `REAL_CLAUDE_CREDENTIALS=${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`; each must be a current-user-owned regular non-symlink `0600` file. It requires `bwrap`, creates `CASE_ROOT`, `CASE_HOME`, `CASE_CODEX_HOME`, `CASE_CLAUDE_CONFIG`, `CASE_WORKSPACE`, `CASE_TMP`, and `CASE_ZMX_DIR`, and creates empty credential mount targets without copying secret bytes. Missing files, unsafe ownership/mode, unavailable Bubblewrap, failed read-only mount, or failed in-sandbox auth status exits 69 before install/invoke.

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
(
  set -e
  E2E_TMP=$(mktemp -d /tmp/agent-invoke-e2e-red.XXXXXX)
  cleanup() { trash-put -- "$E2E_TMP" >/dev/null 2>&1 || :; }
  trap cleanup EXIT
  set +e
  bash tests/agent-invoke/e2e/run-installed-e2e.sh \
    --source "$E2E_TMP/missing" --case codex-native \
    --evidence "$E2E_TMP/red.json"
  RED_STATUS=$?
  set -e
  test "$RED_STATUS" -eq 69
  test ! -e "$E2E_TMP/red.json"
  test ! -e "$E2E_TMP/.lat"
)
~~~

Expected: nonzero `agent-invoke is not installed`, no state/`.lat` side effect, and byte-identical real skill/credential manifests.

- [ ] **Step 8: Run local installed native/exec/TUI smoke from the committed local candidate.**

~~~bash
(
  set -e
  E2E_TMP=$(mktemp -d /tmp/agent-invoke-local-e2e.XXXXXX)
  cleanup() { trash-put -- "$E2E_TMP" >/dev/null 2>&1 || :; }
  trap cleanup EXIT
  for case_id in codex-native codex-to-claude-exec same-host-tui; do
    bash tests/agent-invoke/e2e/run-installed-e2e.sh \
      --source "$PWD" --case "$case_id" \
      --evidence "$E2E_TMP/$case_id.json"
  done
  jq -e -s 'length == 3 and all(.[]; .passed and .lat_unchanged and
    .identity_unambiguous and .real_skill_roots_unchanged and .real_credentials_unchanged and
    (.lat_dispatch_installed|not))' \
    "$E2E_TMP"/*.json
)
~~~

Expected: all three routes work with only the standalone installed package.

- [ ] **Step 9: Push only the reviewed local candidate to `dev`.**

~~~bash
test "$(git rev-parse main)" = 5a8e76c
git push origin dev
REMOTE_DEV=$(gh api repos/ouob-tw/LoopAgentTeams/git/ref/heads/dev --jq .object.sha)
test "$REMOTE_DEV" = "$(git rev-parse HEAD)"
~~~

Expected: remote `dev` equals local HEAD; `main` is unchanged.

- [ ] **Step 10: Run all 14 remote groups against one pinned `dev` SHA.**

~~~bash
(
  set -e
  E2E_TMP=$(mktemp -d /tmp/agent-invoke-dev-e2e.XXXXXX)
  cleanup() { trash-put -- "$E2E_TMP" >/dev/null 2>&1 || :; }
  trap cleanup EXIT
  REMOTE_DEV=$(gh api repos/ouob-tw/LoopAgentTeams/git/ref/heads/dev --jq .object.sha)
  [[ $REMOTE_DEV =~ ^[0-9a-f]{40}$ ]]
  for case_id in \
    codex-native claude-native codex-to-claude-exec claude-to-codex-exec \
    same-host-exec same-host-tui native-unavailable unsupported-client \
    managed-exec-resume managed-tui-resume imported-resume native-resume \
    lifecycle prune
  do
    bash tests/agent-invoke/e2e/run-installed-e2e.sh \
      --source "ouob-tw/LoopAgentTeams#$REMOTE_DEV" --case "$case_id" \
      --evidence "$E2E_TMP/$case_id.json"
  done
  jq -e -s --arg candidate "$REMOTE_DEV" 'length == 14 and
    all(.[]; .candidate_sha == $candidate and .passed and .lat_unchanged and
    .identity_unambiguous and .real_skill_roots_unchanged and .real_credentials_unchanged and
    (.lat_dispatch_installed|not) and .authoritative_outcome and
    (if .case_id == "lifecycle" then
      .stop_intent_absent_after_finalize and .clean_after_stop_succeeded
     else true end))' "$E2E_TMP"/*.json
  jq -s --arg candidate "$REMOTE_DEV" '{candidate_sha:$candidate,cases:map({
    case_id,route,client,mode,model,session_id,tool_events,
    outcome_event,exit_status,identity_state,identity_unambiguous,installed_manifest_sha256,
    real_skill_roots_unchanged,real_credentials_unchanged,lat_unchanged,
    stop_intent_absent_after_finalize,clean_after_stop_succeeded,passed
  })}' "$E2E_TMP"/*.json > tests/agent-invoke/e2e/evidence-summary.json
)
~~~

Expected: 14 groups PASS. Grouped resume/lifecycle cases include both Claude and Codex subcases and every negative probe in spec 9.3; successful native stop leaves no stop-intent and permits clean, while every failed/uncertain/mismatched finalize stays fail-closed.

- [ ] **Step 11: Bind evidence to candidate and verify boundaries.**

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

- [ ] **Step 12: Commit concise evidence to `dev` and stop.**

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
| QA-6 concise skill | ≤150 lines, direct conditional refs, no mirror/package evidence | Decision-only behavior proxy: 11 positive/safe-refusal + 3 negative, 2/2 per client; no raw JSONL/read-event claim | Run line/validator/manifest gates; inspect both 14-case summaries and confirm 56 total turns, no tool events/state delta, no raw retained output, and no claim that a Skill file was observed loading. Real installed route evidence remains under QA-7. |
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
