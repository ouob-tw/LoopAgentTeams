# Agent Invoke V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the already review-clean `agent-invoke` package on `dev` under an acceptance scale a single executor can finish: six deterministic suites, a sixteen-turn decision proxy, an eight-case installed smoke, and four additive evidence assertions that make the QA claims actually falsifiable.

**Architecture:** The product package `agent-invoke/` is not touched, with no exception. All work happens in the repository-only test tree and in the user's skill install locations. Two existing runners are reused: `run-trigger-eval.sh`, retargeted to an eight-case set at one repetition, and `run-installed-e2e.sh`, invoked for eight of its fourteen existing case IDs and extended additively so that three of its cases can distinguish a real pass from a reported one.

**Tech Stack:** Bash 5, `jq`, `bwrap` (Bubblewrap), `shred`, `trash-put`, `uvx --from skills-ref agentskills`, ShellCheck, Claude Code CLI, Codex CLI, `codex-multi-auth`.

**Spec:** `docs/superpowers/specs/2026-08-03-agent-invoke-v1-design.md` (approved after three review rounds, verdict PASS).

## Global Constraints

- **Never modify anything under `agent-invoke/`.** There is no regression exception. If verification exposes a product defect, V1 is FAIL: record the evidence, stop, and report. A separate product-fix TASK_ID handles it.
- **The test tree is additive-only.** You may add assertions, evidence fields, and appended prompt text under `tests/agent-invoke/`. You may not remove, weaken, reword, or restructure any existing assertion, existing prompt text, or existing validator logic. Every change must be a strict addition.
- Do not delete any existing file under `tests/agent-invoke/`.
- Do not touch `lat-dispatch/`. It stays at zero diff against `main`.
- Do not modify or push `main`. Do not rewrite `dev` history.
- Do not modify, clear, or reorder the old ledger `.lat/workspace/2026-08-01-agent-invoke-design/`. Its two YAML files must stay byte-identical.
- This TASK_ID skips the LAT `test_executor` and `qa_executor` phases by explicit user decision. The code executor runs the verification in section 6 of the spec; Dispatch checks the actual output.
- Use `uv` / `uvx`, never a bare `python`.
- Delete ordinary files with `trash-put`; shred secrets with `shred`.
- Never store raw client output, credentials, prompts, or session JSONL as repository evidence.
- **Codex account handling.** On a quota failure (`thread.started` → `turn.started` → `error` → `turn.failed` with no agent message), run `codex-multi-auth check`, then `codex-multi-auth switch <n>` to an account with quota, then re-run. After switching, confirm the new account supports the target model: a full-quota account can still return `The '<model>' model is not supported when using Codex with a ChatGPT account.` That is a different cause from exhaustion — switch again or use a model that account supports, and never record either as `blocked`, substitute Claude-side evidence, or downgrade to deterministic-only. As of 2026-08-04 account 1 is exhausted until Aug 8, account 3 rejects `gpt-5.6-sol`, and account 2 is the working one.
- LAT review rounds reuse the existing reviewer instance by resuming its session. Only start a fresh reviewer if the original session cannot be resumed.

## File Structure

**Modified (all additive)**

- `tests/agent-invoke/e2e/trigger-prompts.json` — narrowed to the V1 eight-case set.
- `tests/agent-invoke/e2e/run-trigger-eval.sh` — case constants and repetition count retargeted.
- `tests/agent-invoke/integration/skill-contract-test.sh` — the single literal that pins `runs == 2`.
- `tests/agent-invoke/e2e/run-installed-e2e.sh` — E-2 and E-3 additions.
- `tests/agent-invoke/e2e/validate-installed-evidence.sh` — E-4 additions.
- `tests/agent-invoke/e2e/installed-evidence-validator-test.sh` — three appended RED cases for E-2, E-3, and E-4. Appended only; every existing case keeps its exact text.

**Created**

- `tests/agent-invoke/e2e/trigger-prompts-full.json` — verbatim copy of today's fourteen-case set, kept for V1.1, read by nothing.
- `docs/superpowers/evidence/2026-08-03-agent-invoke-v1.md` — the acceptance evidence note.

**Untouched but exercised**

- `agent-invoke/**` — the product.
- `tests/agent-invoke/integration/{route-integration,session-reference,exec-client,monitor-session,state-manager}-test.sh`.

---

### Task 1: Retarget the decision proxy to the V1 eight-case set

The runner hard-codes fourteen case IDs at two repetitions, which is the 56-turn scale the spec rejects. Preserve the full set, then narrow the live set to eight cases at one repetition — five positive, three negative.

**Files:**
- Create: `tests/agent-invoke/e2e/trigger-prompts-full.json`
- Modify: `tests/agent-invoke/e2e/trigger-prompts.json`
- Modify: `tests/agent-invoke/e2e/run-trigger-eval.sh` at `:10` (`CASE_IDS`), `:48` (`length == 14`), `:316` (`for repetition in 1 2`), `:334` (`runs:2`), `:344` (`.runs == 2`)
- Test: `tests/agent-invoke/integration/skill-contract-test.sh:206`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `bash tests/agent-invoke/e2e/run-trigger-eval.sh --client codex|claude --skill-root ABS --output ABS_JSON`, writing `{client, cases: [{id, runs, passed, passed_runs, failures}], state_unchanged}` with exactly eight case entries at `runs: 1`. Task 4 asserts on this shape.

The eight V1 cases:

| case id | V1 behavior | QA |
|---|---|---|
| `generic-native` | V1-A native-first routing | QA-1 |
| `cross-client` | V1-B cross-family exec | QA-2 |
| `explicit-exec` | V1-C explicit external override | QA-3 |
| `reference-resume` | V1-D exact external session resume | QA-4 |
| `stop` | V1-E lifecycle stop | QA-5 |
| `full-LAT` | negative: must not take over a full LAT workflow | QA-6 |
| `non-delegation-request` | negative: information-only request must not delegate | QA-6 |
| `direct-work` | negative: "do it yourself" must not delegate | QA-6 |

All three negatives are required: QA-6 names three distinct situations, and `lat_unchanged` on the installed cases only proves `.lat` did not change, not that no wrong delegation happened. `clean` stays out — it is nearly the same decision as `stop` and is covered for real by the installed `lifecycle` case plus `state-manager-test.sh`.

- [ ] **Step 1: Preserve the full fourteen-case set**

```bash
cd /home/swy/LoopAgentTeams
cp tests/agent-invoke/e2e/trigger-prompts.json tests/agent-invoke/e2e/trigger-prompts-full.json
jq -e 'length == 14' tests/agent-invoke/e2e/trigger-prompts-full.json
```

Expected: prints `true`.

- [ ] **Step 2: Write the failing contract assertion**

In `tests/agent-invoke/integration/skill-contract-test.sh`, change line 206 from:

```bash
require_literal "$trigger_runner" 'all(.cases[]; .passed == true and .runs == 2)'
```

to:

```bash
require_literal "$trigger_runner" 'all(.cases[]; .passed == true and .runs == 1)'
```

- [ ] **Step 3: Run the contract test to verify it fails**

Run: `bash tests/agent-invoke/integration/skill-contract-test.sh`
Expected: FAIL, reporting the missing literal `all(.cases[]; .passed == true and .runs == 1)` in `run-trigger-eval.sh`.

- [ ] **Step 4: Narrow the live prompt set to eight cases**

```bash
cd /home/swy/LoopAgentTeams
jq '[.[] | select(.id | IN("generic-native","cross-client","explicit-exec","reference-resume","stop","full-LAT","non-delegation-request","direct-work"))]' \
  tests/agent-invoke/e2e/trigger-prompts-full.json > tests/agent-invoke/e2e/trigger-prompts.json.tmp
mv tests/agent-invoke/e2e/trigger-prompts.json.tmp tests/agent-invoke/e2e/trigger-prompts.json
jq -e 'length == 8 and ([.[].id] | sort) == ["cross-client","direct-work","explicit-exec","full-LAT","generic-native","non-delegation-request","reference-resume","stop"]' \
  tests/agent-invoke/e2e/trigger-prompts.json
```

Expected: prints `true`.

- [ ] **Step 5: Retarget the runner constants**

In `tests/agent-invoke/e2e/run-trigger-eval.sh`, line 10, replace:

```bash
readonly CASE_IDS='["clean","cross-client","direct-work","exact-claude-model","explicit-exec","explicit-tui","full-LAT","generic-native","non-delegation-request","operation-resume","prune","reference-resume","stop","unsupported-client"]'
```

with:

```bash
readonly CASE_IDS='["cross-client","direct-work","explicit-exec","full-LAT","generic-native","non-delegation-request","reference-resume","stop"]'
```

In `validate_prompt_set`, line 48, replace `length == 14 and` with `length == 8 and`.

At line 316, replace:

```bash
  for repetition in 1 2; do
```

with:

```bash
  for repetition in 1; do
```

At line 334, replace `'$ARGS.named + {runs:2,passed:($passed_runs == 2),passed_runs:$passed_runs,failures:$failures}'` with:

```bash
'$ARGS.named + {runs:1,passed:($passed_runs == 1),passed_runs:$passed_runs,failures:$failures}'
```

At line 344, replace the final assertion with:

```bash
jq -e '.state_unchanged == true and all(.cases[]; .passed == true and .runs == 1)' "$output" >/dev/null
```

- [ ] **Step 6: Run the contract test to verify it passes**

Run: `bash tests/agent-invoke/integration/skill-contract-test.sh`
Expected: PASS.

- [ ] **Step 7: Static checks**

```bash
cd /home/swy/LoopAgentTeams
bash -n tests/agent-invoke/e2e/run-trigger-eval.sh
shellcheck tests/agent-invoke/e2e/run-trigger-eval.sh tests/agent-invoke/integration/skill-contract-test.sh
git diff --stat -- agent-invoke/
```

Expected: first two silent and exit 0; `git diff --stat` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add tests/agent-invoke/e2e/trigger-prompts.json tests/agent-invoke/e2e/trigger-prompts-full.json \
        tests/agent-invoke/e2e/run-trigger-eval.sh tests/agent-invoke/integration/skill-contract-test.sh
git commit -m "test(agent-invoke): narrow decision proxy to V1 eight-case set

Sixteen turns replace fifty-six, keeping three negative cases so QA-6
has real coverage. The fourteen-case set is preserved verbatim as
trigger-prompts-full.json for V1.1."
```

---

### Task 2: Add the E-2, E-3, and E-4 evidence assertions

Three installed cases currently pass on state alone and cannot distinguish a real success from a reported one. These are strict additions: existing prompts, assertions, and validator logic keep their exact wording and meaning.

**Files:**
- Modify: `tests/agent-invoke/e2e/run-installed-e2e.sh` — `case_prompt()` near `:399-415`, the evidence assembly near `:454-480`, the `case_evidence_valid` block near `:718-750`, and the evidence JSON near `:756-790`
- Modify: `tests/agent-invoke/e2e/validate-installed-evidence.sh` — `validate_lifecycle_evidence()` near `:129`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: two new evidence JSON fields, `result_returned` (boolean) and `resume_turn_identities` (array of the observed per-turn session identities), plus three additional lifecycle assertions. Task 5 asserts on `result_returned` and on `E-1` over the existing `tool_events` field.

**Before writing anything, read these regions in full:** `run-installed-e2e.sh` lines 395–480 and 700–795, and `validate-installed-evidence.sh` lines 100–160. The exact variable names in those regions govern how the additions attach. Do not guess them.

- [ ] **Step 1: Write the failing assertions first**

Extend `tests/agent-invoke/e2e/installed-evidence-validator-test.sh` — that file is exempt from "do not modify" only in the additive sense; append new cases, change nothing existing. Add three cases:

1. An evidence fixture for `claude-to-codex-exec` whose `result_returned` is `false` must be rejected.
2. An evidence fixture for `managed-exec-resume` whose `resume_turn_identities` has fewer than two entries, or two entries that differ, must be rejected.
3. A lifecycle fixture in which the non-target operation snapshot differs before and after must be rejected.

- [ ] **Step 2: Run the validator test to verify the new cases fail**

Run: `bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh`
Expected: FAIL on the three new cases, because the assertions they describe do not exist yet. The pre-existing cases must still pass — if any of them breaks, you have modified rather than added, and must revert.

- [ ] **Step 3: Implement E-2 — prove the delegated result came back**

In `case_prompt()`, for `codex-to-claude-exec` and `claude-to-codex-exec` only, **append** to the end of the existing string, leaving every existing word in place:

```
 Instruct the delegated agent to end its reply with the exact token AGENTINVOKEV1RESULT, and include that token verbatim in your own final reply.
```

`result_excerpt` is truncated to 240 characters at `:478`, so the token can fall off the end. Capture the untruncated value into a new variable **before** that truncation line, leaving the truncation itself untouched:

```bash
result_excerpt_full=$result_excerpt
```

Then, after the truncation, set:

```bash
result_returned=false
case $case_id in
  codex-to-claude-exec|claude-to-codex-exec)
    grep -Fq 'AGENTINVOKEV1RESULT' <<<"$result_excerpt_full" && result_returned=true ;;
  *) result_returned=true ;;
esac
```

Add `--argjson result_returned "$result_returned"` and `result_returned:$result_returned` to the evidence JSON, and add `&& [[ $result_returned == true ]]` to the pass predicate branch that already covers `codex-to-claude-exec|claude-to-codex-exec|same-host-exec|managed-exec-resume|imported-resume`.

- [ ] **Step 4: Implement E-3 — prove the resume continued the same session**

For `managed-exec-resume`, record the session identity observed at each authoritative completion into an array, emit it as `resume_turn_identities`, and require for that case only:

```bash
managed-exec-resume)
  [[ $route == external && $mode == exec && -n $model && $authoritative_outcome == true &&
     $result_returned == true ]] &&
    jq -e 'length >= 2 and (unique | length) == 1 and .[0] != ""' <<<"$resume_turn_identities" >/dev/null &&
    case_evidence_valid=true
  ;;
```

placed as a new branch **before** the existing shared branch, so the shared branch keeps its current text and simply stops matching this one case. Removing `managed-exec-resume` from the shared branch's pattern would be a modification — do not do that; adding an earlier, more specific branch is the additive form.

- [ ] **Step 5: Implement E-4 — three bounded lifecycle assertions**

In `validate_lifecycle_evidence()`, after the existing assertions and without touching them, add:

```bash
cmp -s "$before/bystander/metadata.json" "$after_clean/bystander/metadata.json" ||
  evidence_die 'clean changed a non-target operation'
[[ -f $after_finalize/success/resume-turn.json ]] ||
  evidence_die 'stop did not leave a resumable identity'
jq -e --slurpfile ref "$success_before/session-ref.json" '.[0] == $ref[0]' \
  "$after_finalize/success/resume-turn.json" >/dev/null ||
  evidence_die 'resume after stop did not reuse the exact session identity'
cmp -s "$before/native-sentinel" "$after_clean/native-sentinel" ||
  evidence_die 'clean removed or altered the native session'
```

The runner must produce the `bystander` operation, the `resume-turn.json` capture, and the `native-sentinel` file. Follow the existing snapshot helpers in the runner rather than inventing a new mechanism — that would cross into the new-machinery ban in spec section 6.5.

- [ ] **Step 6: Run the validator test to verify all cases now pass**

Run: `bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh`
Expected: PASS, including the three new cases and every pre-existing case.

- [ ] **Step 7: Prove the change was additive**

```bash
cd /home/swy/LoopAgentTeams
git diff -U0 -- tests/agent-invoke/e2e/ | grep '^-' | grep -v '^---'
```

Expected: no output, or only lines that are re-emitted verbatim elsewhere in the same hunk (for example a `case` pattern line that moved). Any removed assertion, removed prompt text, or weakened condition violates the additive-only constraint and must be reverted.

- [ ] **Step 8: Static checks and commit**

```bash
cd /home/swy/LoopAgentTeams
bash -n tests/agent-invoke/e2e/run-installed-e2e.sh tests/agent-invoke/e2e/validate-installed-evidence.sh
shellcheck tests/agent-invoke/e2e/*.sh
git diff --stat -- agent-invoke/
git add tests/agent-invoke/e2e/
git commit -m "test(agent-invoke): make three installed cases falsifiable

E-2 proves the delegated result reached the host, E-3 proves the
resume continued the same session rather than starting a new one, and
E-4 adds three bounded lifecycle assertions. All strictly additive."
```

Expected: syntax and ShellCheck silent; `git diff --stat -- agent-invoke/` prints nothing.

---

### Task 3: Install to both hosts and prove activation from outside the repository

Installing is what turns a repository package into capability, and it has never been done. The activation check must run outside the repository: inside it, a host can read `agent-invoke/SKILL.md` directly and answer correctly without ever loading the installed skill.

**Files:**
- Create: `~/.agents/skills/agent-invoke/` (real directory)
- Create: `~/.claude/skills/agent-invoke` (symlink to `../../.agents/skills/agent-invoke`)
- Create: `~/.codex/skills/agent-invoke/` (real directory; Codex does not follow the symlink convention)

**Interfaces:**
- Consumes: nothing from Tasks 1 and 2.
- Produces: an installed package byte-identical to `agent-invoke/`, plus activation evidence for both hosts. Task 5 records both.

- [ ] **Step 1: Confirm nothing is installed yet**

```bash
ls -d ~/.agents/skills/agent-invoke ~/.claude/skills/agent-invoke ~/.codex/skills/agent-invoke 2>&1
```

Expected: three "No such file or directory" errors. If any path exists, stop and report — a prior install invalidates the smoke.

- [ ] **Step 2: Validate the package before installing**

```bash
cd /home/swy/LoopAgentTeams
uvx --from skills-ref agentskills validate agent-invoke
awk 'END{print NR}' agent-invoke/SKILL.md
```

Expected: validation passes; the line count prints `55`, which is under the 150 limit.

- [ ] **Step 3: Install to all three locations**

```bash
cd /home/swy/LoopAgentTeams
mkdir -p ~/.agents/skills ~/.codex/skills
cp -a agent-invoke ~/.agents/skills/agent-invoke
ln -s ../../.agents/skills/agent-invoke ~/.claude/skills/agent-invoke
cp -a ~/.agents/skills/agent-invoke ~/.codex/skills/agent-invoke
diff -r agent-invoke ~/.agents/skills/agent-invoke
diff -r agent-invoke ~/.codex/skills/agent-invoke
readlink ~/.claude/skills/agent-invoke
```

Expected: both `diff` runs print nothing; `readlink` prints `../../.agents/skills/agent-invoke`.

- [ ] **Step 4: Confirm only the skill directory shipped**

```bash
find ~/.agents/skills/agent-invoke -mindepth 1 -maxdepth 1 | sort
grep -rn 'docs/superpowers\|\.\./\.\./docs' ~/.agents/skills/agent-invoke || echo 'no repo-doc links'
```

Expected: exactly `SKILL.md`, `references`, `scripts`. No `tests`, no fixtures. The grep prints `no repo-doc links`.

- [ ] **Step 5: Prepare a clean workspace outside the repository**

```bash
work=$(mktemp -d /tmp/agent-invoke-activation.XXXXXX)
git -C "$work" init -q .
printf 'placeholder\n' > "$work/NOTES.md"
echo "$work"
```

Expected: a temporary directory with no relation to `/home/swy/LoopAgentTeams`.

Note the path it prints. Each of the next two steps runs in its own shell, so pass that path explicitly with `cd` at the start of the command rather than relying on a working directory carrying over.

- [ ] **Step 6: Prove Claude activates the installed skill**

```bash
cd "$work"
claude -p --no-session-persistence --output-format stream-json --verbose \
  'Delegate a read-only task to a Claude agent. Before doing anything, state which skill you are using and which route it selects.' \
  </dev/null > /tmp/agent-invoke-activation-claude.jsonl
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' \
  /tmp/agent-invoke-activation-claude.jsonl | head -30
grep -c 'agent-invoke' /tmp/agent-invoke-activation-claude.jsonl
```

Expected: the transcript shows the host loading the `agent-invoke` skill — a skill-activation event or an explicit read of `~/.agents/skills/agent-invoke/SKILL.md`, not a route list produced from nowhere. The workspace holds no copy of the package, so a correct answer without an activation event is a failure, not a pass. Record which of the two forms of evidence you observed.

- [ ] **Step 7: Prove Codex activates the installed skill**

```bash
cd "$work"
codex exec --skip-git-repo-check --sandbox read-only --json \
  'Delegate a read-only task to a Codex agent. Before doing anything, state which skill you are using and which route it selects.' \
  </dev/null > /tmp/agent-invoke-activation-codex.jsonl
grep -c 'agent-invoke' /tmp/agent-invoke-activation-codex.jsonl
tail -20 /tmp/agent-invoke-activation-codex.jsonl
```

Expected: the same standard of evidence. On a quota failure, apply the account handling in Global Constraints and re-run this step; do not continue past it.

- [ ] **Step 8: Record the install state**

```bash
ls -ld ~/.agents/skills/agent-invoke ~/.claude/skills/agent-invoke ~/.codex/skills/agent-invoke
find ~/.agents/skills/agent-invoke -type f -exec sha256sum {} + | sort -k2
```

Expected: three entries, one of them a symlink, and a stable digest list. Paste this into the task result. Then remove the temporary workspace with `trash-put`. Nothing is committed in this task.

---

### Task 4: Run the sixteen-turn decision proxy on both clients

**Files:** none modified. `tests/agent-invoke/e2e/run-trigger-eval.sh` is executed, not edited.

**Interfaces:**
- Consumes: the eight-case runner from Task 1. The installed package from Task 3 is not used here — the runner copies `--skill-root` into an isolated Bubblewrap home.
- Produces: two summary JSON files whose union is the sixteen-turn evidence Task 5 asserts on.

- [ ] **Step 1: Confirm the runner preconditions**

```bash
for tool in jq bwrap shred trash-put; do command -v "$tool" >/dev/null || echo "MISSING: $tool"; done
stat -c '%a %U' ~/.codex/auth.json ~/.claude/.credentials.json
codex-multi-auth status | head -8
```

Expected: no `MISSING` lines; both credentials are `600` and owned by the current user; the pinned Codex account is one with quota. The runner fails closed otherwise.

- [ ] **Step 2: Run the Claude side (eight turns)**

```bash
cd /home/swy/LoopAgentTeams
out=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/trigger-claude.json
rm -f "$out"
bash tests/agent-invoke/e2e/run-trigger-eval.sh \
  --client claude --skill-root "$PWD/agent-invoke" --output "$out"
jq '{client, state_unchanged, cases: [.cases[] | {id, passed, passed_runs}]}' "$out"
```

Expected: exit 0; `state_unchanged` is `true`; all eight cases `passed: true` with `passed_runs: 1`.

- [ ] **Step 3: Run the Codex side (eight turns)**

```bash
cd /home/swy/LoopAgentTeams
out=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/trigger-codex.json
rm -f "$out"
bash tests/agent-invoke/e2e/run-trigger-eval.sh \
  --client codex --skill-root "$PWD/agent-invoke" --output "$out"
jq '{client, state_unchanged, cases: [.cases[] | {id, passed, passed_runs}]}' "$out"
```

Expected: exit 0; `state_unchanged` is `true`; all eight cases `passed: true`.

A case reporting `failures[].reason == "client-exit"` with `turn.failed` and no agent message in the underlying stream is Codex quota. Apply the account handling in Global Constraints and re-run this whole step. Do not partially re-run, and do not record it as blocked.

- [ ] **Step 4: Confirm no state leaked**

```bash
cd /home/swy/LoopAgentTeams
git status --short --branch
ls -d ~/.agent-invoke 2>&1
```

Expected: the working tree shows only the committed changes from Tasks 1 and 2; `~/.agent-invoke` is still absent, because the proxy is decision-only and creates no registry.

- [ ] **Step 5: Record the summaries**

Paste both `jq` outputs into the task result. Do not commit the raw summary files — they are runner output, not repository evidence.

---

### Task 5: Run the eight installed cases, then gate and push `dev`

**Files:**
- Create: `docs/superpowers/evidence/2026-08-03-agent-invoke-v1.md`
- `tests/agent-invoke/e2e/run-installed-e2e.sh` is executed for eight of its fourteen existing case IDs.

**Interfaces:**
- Consumes: the additive assertions from Task 2, the install from Task 3, and the proxy evidence from Task 4.
- Produces: eight evidence JSON files, each with `passed: true` and `verification.status == "verified"`, then the pushed `dev` branch.

- [ ] **Step 1: Run the full deterministic gate**

```bash
cd /home/swy/LoopAgentTeams
for t in route-integration session-reference exec-client monitor-session state-manager skill-contract; do
  printf '== %s\n' "$t"
  bash "tests/agent-invoke/integration/$t-test.sh" || printf 'FAILED: %s\n' "$t"
done
bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh || echo 'FAILED: validator'
shellcheck tests/agent-invoke/e2e/*.sh tests/agent-invoke/integration/*.sh agent-invoke/scripts/*.sh
uvx --from skills-ref agentskills validate agent-invoke
git diff --check
git diff --exit-code 6031333 -- agent-invoke/ && echo 'A-1: agent-invoke zero diff'
git diff --exit-code main -- lat-dispatch/ && echo 'A-5: lat-dispatch zero diff'
```

Expected: no `FAILED:` lines, ShellCheck silent, validation passes, `git diff --check` silent, and both zero-diff lines printed.

- [ ] **Step 2: Run the eight installed cases**

```bash
cd /home/swy/LoopAgentTeams
ev=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/installed
mkdir -p "$ev"
for c in claude-native codex-native claude-to-codex-exec codex-to-claude-exec \
         same-host-exec native-unavailable managed-exec-resume lifecycle; do
  printf '== %s\n' "$c"
  rm -f "$ev/$c.json"
  bash tests/agent-invoke/e2e/run-installed-e2e.sh \
    --source "$PWD" --case "$c" --evidence "$ev/$c.json" || printf 'FAILED: %s\n' "$c"
done
```

Expected: no `FAILED:` lines. Each case takes up to five minutes.

`lifecycle` is a hard gate with no fallback. If it fails for any reason, including a TUI sub-step, V1 does not pass: record the exact failure point and stop. Do not edit the runner to make it pass, and do not substitute deterministic evidence.

- [ ] **Step 3: Check every case verified, including E-1 and E-2**

```bash
ev=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/installed
jq -s 'map({case_id, route, mode, passed, status: .verification.status,
            reason: .verification.reason_code, result_returned, lat_unchanged})' "$ev"/*.json

# whole-set gate
jq -se 'length == 8 and all(.[]; .passed == true and .verification.status == "verified"
        and .lat_unchanged == true and .installed_package_unchanged == true)' "$ev"/*.json

# E-1: the two native cases must show zero external carrier
jq -se 'map(select(.case_id | IN("claude-native","codex-native")))
        | length == 2
        and all(.[]; [.tool_events[]? | (.command // "")]
                     | map(select(test("zmx|codex exec|claude -p|claude --print")))
                     | length == 0)' "$ev"/*.json

# E-2: the two cross-family cases must show the delegated result came back
jq -se 'map(select(.case_id | IN("claude-to-codex-exec","codex-to-claude-exec")))
        | length == 2 and all(.[]; .result_returned == true)' "$ev"/*.json
```

Expected: the three `jq -se` commands each print `true`.

- [ ] **Step 4: Confirm the product and the old ledger never changed**

```bash
cd /home/swy/LoopAgentTeams
git diff --exit-code 6031333 -- agent-invoke/ && echo 'product unchanged'
git status --short
uv run --with pyyaml python - <<'PY'
import yaml, pathlib
old = pathlib.Path('.lat/workspace/2026-08-01-agent-invoke-design')
for n in ('tasks.yaml', 'results.yaml'):
    rows = yaml.safe_load((old / n).read_text())
    print('old ledger', n, len(rows), sorted({r['status'] for r in rows}))
PY
```

Expected: `product unchanged` printed; the working tree shows only the intended changes; the old ledger still reports six rows of `partial` in each file.

- [ ] **Step 5: Write the V1 evidence note**

Create `docs/superpowers/evidence/2026-08-03-agent-invoke-v1.md` containing, in prose plus tables: the deterministic results from Step 1; the sixteen proxy turns from Task 4 broken down per client and per case; the eight installed case verdicts from Step 3 including `result_returned` and the E-1 result; the install state and both activation observations from Task 3; and a clearly headed section listing the four experimental behaviors — TUI resume, `prune`, persistent native handles, arbitrary session import — as **not verified in V1**. Include no raw client output, credentials, prompts, or session JSONL.

- [ ] **Step 6: Commit the evidence note**

```bash
cd /home/swy/LoopAgentTeams
git add docs/superpowers/evidence/2026-08-03-agent-invoke-v1.md
git commit -m "docs(agent-invoke): record V1 acceptance evidence"
```

- [ ] **Step 7: Walk the acceptance conditions**

State, one line each, which artifact satisfies A-1 through A-9 in spec section 8. A-5's second half needs an explicit check:

```bash
cd /home/swy/LoopAgentTeams
grep -rn 'lat-dispatch\|lat_dispatch' agent-invoke/ || echo 'A-5b: no lat-dispatch reference in the package'
```

Expected: the line prints.

- [ ] **Step 8: Request review**

Use `superpowers:requesting-code-review` on the branch diff. Resume the existing reviewer session rather than starting a new instance, unless that session cannot be resumed. Adjudicate each finding yourself — a reviewer verdict is not final authority. Re-review covers prior findings and direct regressions only.

- [ ] **Step 9: Push `dev`**

Only after A-1 through A-9 all hold and review is PASS:

```bash
cd /home/swy/LoopAgentTeams
git status --short --branch
git push origin dev
git rev-parse main origin/main
```

Expected: `dev` pushed; `main` and `origin/main` both still `5a8e76c6712ba130799b481d09d63f2de067eafa`.

---

## QA Acceptance Mapping

Spec section 9 acceptance items, each mapped to a concrete test target and to how it is verified against the real installed skill.

| QA | Test target | Verification |
|---|---|---|
| QA-1 same-family delegation spawns no external process | installed `claude-native`, `codex-native`; proxy `generic-native`; `route-integration-test.sh` | Task 5 Step 3's E-1 assertion: the two native cases' `tool_events` contain no `zmx` or exec carrier command, on top of `route == native`, `mode == native`, and an authoritative completion. |
| QA-2 cross-family delegation returns the result | installed `claude-to-codex-exec`, `codex-to-claude-exec`; proxy `cross-client`; `exec-client-test.sh` | Task 5 Step 3's E-2 assertion: `result_returned == true`, meaning the `AGENTINVOKEV1RESULT` token added by Task 2 Step 3 reached the host's final reply. |
| QA-3 external only when asked; no silent downgrade | installed `same-host-exec`, `native-unavailable`; proxy `explicit-exec` | `same-host-exec` proves exactly one external carrier ran when explicitly requested. `native-unavailable` goes through the existing `validate_preexecution_refusal`, which already asserts an empty `tools` array and a `diff -qr`-identical protected state. |
| QA-4 resume continues the same conversation | installed `managed-exec-resume`; proxy `reference-resume`; `session-reference-test.sh` | Task 2 Step 4's E-3 branch: `resume_turn_identities` has at least two entries that are all identical and non-empty. |
| QA-5 stop and clean affect only the named operation | installed `lifecycle`; proxy `stop`; `state-manager-test.sh` | Task 2 Step 5's E-4 assertions: the bystander operation is unchanged, the post-stop resume reuses the exact session identity, and the native sentinel survives clean. |
| QA-6 does not take over what it should not | proxy `full-LAT`, `non-delegation-request`, `direct-work`; `skill-contract-test.sh` | All three negative cases pass on both clients in Task 4. `lat_unchanged` on the installed cases is supporting evidence only. |
| QA-7 installed and usable on both hosts | Task 3 Steps 5–8 | Activation runs from a temporary directory outside the repository, and the evidence is a host skill-activation event or a read of the installed `SKILL.md` — not a route list the host could have produced from the repository copy. |
| QA-8 unverified behaviors are labelled | Task 5 Step 5 | The evidence note names TUI resume, `prune`, persistent native handles, and arbitrary session import as not verified in V1. |

Process gates (spec section 8):

| Spec | Satisfied by |
|---|---|
| A-1 deterministic PASS, `agent-invoke/` zero diff vs `6031333` | Task 5 Steps 1 and 4 |
| A-2 sixteen proxy turns PASS on both clients | Task 4 Steps 2–3 |
| A-3 eight installed cases verified, `lifecycle` with no fallback | Task 5 Steps 2–3 |
| A-4 three install paths correct, activation proven outside the repo | Task 3 Steps 3–8 |
| A-5 `lat-dispatch` zero diff and unreferenced | Task 5 Steps 1 and 7 |
| A-6 experimental behaviors marked unverified | Task 5 Step 5 |
| A-7 E-1 to E-4 done, zero removals or weakenings in the test tree | Task 2 Steps 6–7 |
| A-8 new ledger terminal, old ledger byte-identical | Task 5 Step 4 |
| A-9 reviewer PASS and every finding adjudicated | Task 5 Step 8 |

## Final Verification Gate

Before claiming completion, run and paste the output of:

```bash
cd /home/swy/LoopAgentTeams
git status --short --branch
git rev-parse HEAD main origin/main origin/dev
git diff --exit-code 6031333 -- agent-invoke/ && echo 'product unchanged'
git diff --exit-code main -- lat-dispatch/ && echo 'lat-dispatch zero diff'
git diff -U0 main..dev -- tests/agent-invoke/ | grep '^-' | grep -v '^---' | head
ls -ld ~/.agents/skills/agent-invoke ~/.claude/skills/agent-invoke ~/.codex/skills/agent-invoke
```

The `grep '^-'` output must contain no removed assertion. `git diff --stat main..dev -- agent-invoke/` will show the package as added relative to `main`, which is expected because the package is new on `dev`; what must be zero is its diff against `6031333`.

Never claim a step passed without pasting the command output that shows it.
