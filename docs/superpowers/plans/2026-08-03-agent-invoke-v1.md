# Agent Invoke V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the already review-clean `agent-invoke` package on `dev` by narrowing its acceptance to a scale a single executor can complete: six deterministic suites, a twelve-turn decision proxy, and a six-case installed smoke on both Claude and Codex.

**Architecture:** The product package `agent-invoke/` is not touched. All work is in the repository-only test tree and in the user's skill install locations. Two existing runners are reused: `run-trigger-eval.sh` (retargeted to a six-case prompt set at one repetition) and `run-installed-e2e.sh` (invoked for six of its fourteen existing case IDs, unmodified).

**Tech Stack:** Bash 5, `jq`, `bwrap` (Bubblewrap), `shred`, `trash-put`, `uvx --from skills-ref agentskills`, ShellCheck, Claude Code CLI, Codex CLI.

**Spec:** `docs/superpowers/specs/2026-08-03-agent-invoke-v1-design.md`

## Global Constraints

- Do not modify any file under `agent-invoke/`. If verification reveals a real regression, the fix requires a failing test first and must be listed in the evidence.
- Do not modify `tests/agent-invoke/e2e/run-installed-e2e.sh`, `validate-installed-evidence.sh`, or `installed-evidence-validator-test.sh`.
- Do not delete any existing file under `tests/agent-invoke/`.
- Do not touch `lat-dispatch/`. It must stay at zero diff against `main`.
- Do not modify or push `main`. Do not rewrite `dev` history.
- Do not modify or clear the old ledger `.lat/workspace/2026-08-01-agent-invoke-design/`.
- Use `uv` / `uvx`, never a bare `python`.
- Delete ordinary files with `trash-put`; shred secrets with `shred`.
- Never store raw client output, credentials, prompts, or session JSONL as repository evidence.
- Codex quota exhaustion (`thread.started` → `turn.started` → `error` → `turn.failed` with no agent message) is **not** an acceptable outcome. The response is to switch Codex accounts and re-run. It must never be recorded as `blocked`, substituted with Claude-side evidence, or downgraded to deterministic-only.
- LAT review rounds reuse the existing reviewer instance via `SendMessage`. Only spawn a fresh reviewer if the previous instance has terminated.

## File Structure

**Modified**

- `tests/agent-invoke/e2e/trigger-prompts.json` — becomes the V1 six-case decision set.
- `tests/agent-invoke/e2e/run-trigger-eval.sh` — constants retargeted to six cases at one repetition.
- `tests/agent-invoke/integration/skill-contract-test.sh` — the one literal assertion that pins `runs == 2`.

**Created**

- `tests/agent-invoke/e2e/trigger-prompts-full.json` — verbatim copy of today's fourteen-case set, preserved for V1.1. Not read by any runner.
- `docs/superpowers/plans/2026-08-03-agent-invoke-v1.md` — this file.

**Untouched but exercised**

- `agent-invoke/**` — the product.
- `tests/agent-invoke/integration/{route-integration,session-reference,exec-client,monitor-session,state-manager,skill-contract}-test.sh` — the deterministic gate.
- `tests/agent-invoke/e2e/run-installed-e2e.sh` and `validate-installed-evidence.sh` — the installed smoke.

---

### Task 1: Retarget the decision proxy to the V1 six-case set

The current runner hard-codes fourteen case IDs and two repetitions per case, which is the 56-turn scale the spec rejects. Preserve the full set as a separate file, then narrow the live set to six cases at one repetition.

**Files:**
- Create: `tests/agent-invoke/e2e/trigger-prompts-full.json`
- Modify: `tests/agent-invoke/e2e/trigger-prompts.json`
- Modify: `tests/agent-invoke/e2e/run-trigger-eval.sh:10` (`CASE_IDS`), `:48` (`length == 14`), `:316` (`for repetition in 1 2`), `:334` (`runs:2`), `:344` (`.runs == 2`)
- Test: `tests/agent-invoke/integration/skill-contract-test.sh:206`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `bash tests/agent-invoke/e2e/run-trigger-eval.sh --client codex|claude --skill-root ABS --output ABS_JSON`, writing `{client, cases: [{id, runs, passed, passed_runs, failures}], state_unchanged}` with exactly six case entries at `runs: 1`. Task 4 consumes this summary shape.

The six V1 cases and their spec mapping:

| case id | V1 behavior |
|---|---|
| `generic-native` | V1-A native-first routing |
| `cross-client` | V1-B cross-family exec |
| `explicit-exec` | V1-C explicit external override |
| `reference-resume` | V1-D exact external session resume |
| `stop` | V1-E lifecycle stop |
| `clean` | V1-E lifecycle clean |

V1-F (registry shape) is not a routing decision; it is covered by `state-manager-test.sh` and by the installed smoke in Task 3.

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

- [ ] **Step 4: Narrow the live prompt set to six cases**

```bash
cd /home/swy/LoopAgentTeams
jq '[.[] | select(.id | IN("generic-native","cross-client","explicit-exec","reference-resume","stop","clean"))]' \
  tests/agent-invoke/e2e/trigger-prompts-full.json > tests/agent-invoke/e2e/trigger-prompts.json.tmp
mv tests/agent-invoke/e2e/trigger-prompts.json.tmp tests/agent-invoke/e2e/trigger-prompts.json
jq -e 'length == 6 and ([.[].id] | sort) == ["clean","cross-client","explicit-exec","generic-native","reference-resume","stop"]' \
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
readonly CASE_IDS='["clean","cross-client","explicit-exec","generic-native","reference-resume","stop"]'
```

In `validate_prompt_set`, line 48, replace `length == 14 and` with `length == 6 and`.

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

- [ ] **Step 7: Run static checks on the changed shell**

```bash
bash -n tests/agent-invoke/e2e/run-trigger-eval.sh
shellcheck tests/agent-invoke/e2e/run-trigger-eval.sh tests/agent-invoke/integration/skill-contract-test.sh
```

Expected: both silent, exit 0.

- [ ] **Step 8: Confirm the product package is untouched**

```bash
git diff --stat -- agent-invoke/
```

Expected: no output.

- [ ] **Step 9: Commit**

```bash
git add tests/agent-invoke/e2e/trigger-prompts.json tests/agent-invoke/e2e/trigger-prompts-full.json \
        tests/agent-invoke/e2e/run-trigger-eval.sh tests/agent-invoke/integration/skill-contract-test.sh
git commit -m "test(agent-invoke): narrow decision proxy to V1 six-case set

Twelve turns replace fifty-six. The fourteen-case set is preserved
verbatim as trigger-prompts-full.json for V1.1."
```

---

### Task 2: Install the candidate to both hosts and verify triggering

Install the current package to the three real locations using the machine's existing convention, then prove each host can actually activate it. This is what turns a repository package into installed capability, and its absence is the single largest gap in the handover.

**Files:**
- Create: `~/.agents/skills/agent-invoke/` (real directory)
- Create: `~/.claude/skills/agent-invoke` (symlink to `../../.agents/skills/agent-invoke`)
- Create: `~/.codex/skills/agent-invoke/` (real directory; Codex does not follow the symlink convention)
- Test: no repository test file; verification is by direct observation, recorded in the task result.

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: an installed package at `$HOME/.agents/skills/agent-invoke` whose content is byte-identical to `agent-invoke/`. Task 3 passes `--source` pointing at the repository, and Task 4 asserts the install state.

- [ ] **Step 1: Confirm nothing is currently installed**

```bash
ls -d ~/.agents/skills/agent-invoke ~/.claude/skills/agent-invoke ~/.codex/skills/agent-invoke 2>&1
```

Expected: three "No such file or directory" errors. If any path exists, stop and report — an unexpected prior install invalidates the smoke.

- [ ] **Step 2: Validate the package before installing**

```bash
cd /home/swy/LoopAgentTeams
uvx --from skills-ref agentskills validate agent-invoke
awk 'END{print NR}' agent-invoke/SKILL.md
```

Expected: validation passes; line count prints `55` (must be ≤ 150).

- [ ] **Step 3: Install to the canonical location**

```bash
cd /home/swy/LoopAgentTeams
mkdir -p ~/.agents/skills
cp -a agent-invoke ~/.agents/skills/agent-invoke
diff -r agent-invoke ~/.agents/skills/agent-invoke
```

Expected: `diff` prints nothing.

- [ ] **Step 4: Link the Claude host and copy to the Codex host**

```bash
ln -s ../../.agents/skills/agent-invoke ~/.claude/skills/agent-invoke
mkdir -p ~/.codex/skills
cp -a ~/.agents/skills/agent-invoke ~/.codex/skills/agent-invoke
readlink ~/.claude/skills/agent-invoke
diff -r ~/.agents/skills/agent-invoke ~/.codex/skills/agent-invoke
```

Expected: `readlink` prints `../../.agents/skills/agent-invoke`; `diff` prints nothing.

- [ ] **Step 5: Confirm only the skill directory shipped**

```bash
find ~/.agents/skills/agent-invoke -mindepth 1 -maxdepth 1 | sort
grep -rn 'docs/superpowers\|\.\./\.\./docs' ~/.agents/skills/agent-invoke || echo 'no repo-doc links'
```

Expected: exactly `SKILL.md`, `references`, `scripts`. No `tests`, no fixtures. The grep prints `no repo-doc links`.

- [ ] **Step 6: Verify Claude can activate the installed skill**

```bash
claude -p --no-session-persistence --output-format stream-json --verbose \
  'List the routing rules that the agent-invoke skill defines, naming each route. Do not delegate any work.' \
  </dev/null | jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' | head -40
```

Expected: the response names the routes defined in `SKILL.md` (`exact resume`, `override`, `native`, `cross-family exec`, `TUI`). If the skill is not activated the response will be generic or will state the skill is unknown — that is a failure, not a pass.

- [ ] **Step 7: Verify Codex can activate the installed skill**

```bash
codex exec --skip-git-repo-check --sandbox read-only \
  'List the routing rules that the agent-invoke skill defines, naming each route. Do not delegate any work.' \
  </dev/null | tail -40
```

Expected: same five routes named. On a quota failure (`turn.failed` with no agent message), switch Codex accounts with `codex login` and re-run this step — do not proceed past it.

- [ ] **Step 8: Record the install state**

```bash
{ ls -ld ~/.agents/skills/agent-invoke ~/.claude/skills/agent-invoke ~/.codex/skills/agent-invoke
  find ~/.agents/skills/agent-invoke -type f -exec sha256sum {} + | sort -k2; } 
```

Expected: three entries (one symlink), and a stable digest list. Paste this into the task result. Nothing is committed to the repository in this task.

---

### Task 3: Run the twelve-turn decision proxy on both clients

**Files:**
- Modify: none.
- Test: `tests/agent-invoke/e2e/run-trigger-eval.sh` (executed, not edited)

**Interfaces:**
- Consumes: the six-case runner from Task 1; the installed package from Task 2 is *not* used here — the runner copies `--skill-root` into an isolated Bubblewrap home.
- Produces: two summary JSON files whose union is the twelve-turn evidence Task 4 asserts on.

- [ ] **Step 1: Confirm the runner preconditions**

```bash
for tool in jq bwrap shred trash-put; do command -v "$tool" >/dev/null || echo "MISSING: $tool"; done
stat -c '%a %U' ~/.codex/auth.json ~/.claude/.credentials.json
```

Expected: no `MISSING` lines; both credentials are `600` and owned by the current user. The runner fails closed otherwise.

- [ ] **Step 2: Run the Claude side (six turns)**

```bash
cd /home/swy/LoopAgentTeams
out=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/trigger-claude.json
rm -f "$out"
bash tests/agent-invoke/e2e/run-trigger-eval.sh \
  --client claude --skill-root "$PWD/agent-invoke" --output "$out"
jq '{client, state_unchanged, cases: [.cases[] | {id, passed, passed_runs}]}' "$out"
```

Expected: exit 0; `state_unchanged` is `true`; all six cases `passed: true` with `passed_runs: 1`.

- [ ] **Step 3: Run the Codex side (six turns)**

```bash
cd /home/swy/LoopAgentTeams
out=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/trigger-codex.json
rm -f "$out"
bash tests/agent-invoke/e2e/run-trigger-eval.sh \
  --client codex --skill-root "$PWD/agent-invoke" --output "$out"
jq '{client, state_unchanged, cases: [.cases[] | {id, passed, passed_runs}]}' "$out"
```

Expected: exit 0; `state_unchanged` is `true`; all six cases `passed: true`.

If any case reports `failures[].reason == "client-exit"` and the underlying stream showed `turn.failed` with no agent message, that is Codex quota. Switch accounts with `codex login` and re-run this whole step. Do not partially re-run, and do not record the result as blocked.

- [ ] **Step 4: Confirm no state leaked**

```bash
git status --short --branch
ls -d ~/.agent-invoke 2>&1
```

Expected: working tree shows only expected changes from Task 1; `~/.agent-invoke` is still absent (the proxy runs decision-only and creates no registry).

- [ ] **Step 5: Record the summaries**

Paste both `jq` outputs from Steps 2 and 3 into the task result. Do not commit the raw summary files — they are runner output, not repository evidence.

---

### Task 4: Run the six-case installed smoke, then gate and push `dev`

**Files:**
- Modify: none.
- Test: `tests/agent-invoke/e2e/run-installed-e2e.sh` (executed with six of its fourteen existing case IDs, unmodified)

**Interfaces:**
- Consumes: the install from Task 2 and the proxy evidence from Task 3.
- Produces: six evidence JSON files, each with `passed: true` and `verification.status == "verified"`; then the pushed `dev` branch.

- [ ] **Step 1: Run the full deterministic gate**

```bash
cd /home/swy/LoopAgentTeams
for t in route-integration session-reference exec-client monitor-session state-manager skill-contract; do
  printf '== %s\n' "$t"
  bash "tests/agent-invoke/integration/$t-test.sh" || printf 'FAILED: %s\n' "$t"
done
bash tests/agent-invoke/e2e/installed-evidence-validator-test.sh
shellcheck tests/agent-invoke/e2e/*.sh tests/agent-invoke/integration/*.sh agent-invoke/scripts/*.sh
uvx --from skills-ref agentskills validate agent-invoke
git diff --check
git diff --exit-code main -- lat-dispatch/ && echo 'lat-dispatch: zero diff'
```

Expected: no `FAILED:` lines, ShellCheck silent, validation passes, `git diff --check` silent, `lat-dispatch: zero diff` printed.

- [ ] **Step 2: Run the six installed cases**

```bash
cd /home/swy/LoopAgentTeams
ev=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/installed
mkdir -p "$ev"
for c in claude-native codex-native claude-to-codex-exec codex-to-claude-exec managed-exec-resume lifecycle; do
  printf '== %s\n' "$c"
  rm -f "$ev/$c.json"
  bash tests/agent-invoke/e2e/run-installed-e2e.sh \
    --source "$PWD" --case "$c" --evidence "$ev/$c.json" || printf 'FAILED: %s\n' "$c"
done
```

Expected: no `FAILED:` lines. Each case takes up to five minutes.

- [ ] **Step 3: Check every case verified**

```bash
ev=/tmp/claude-1000/-home-swy-LoopAgentTeams/8e6290e0-2ad4-4768-8249-6b4c4db20d71/scratchpad/installed
jq -s 'map({case_id, route, client, mode, passed, status: .verification.status,
            reason: .verification.reason_code, lat_unchanged, installed_package_unchanged})' "$ev"/*.json
jq -se 'length == 6 and all(.[]; .passed == true and .verification.status == "verified"
        and .lat_unchanged == true and .installed_package_unchanged == true)' "$ev"/*.json
```

Expected: the second command prints `true`.

If `lifecycle` is the only failure and its recorded failure point is a TUI sub-step, apply the spec's documented fallback: record the exact failure point, treat stop/clean V1 coverage as satisfied by `state-manager-test.sh` alone, move `lifecycle` to V1.1, and say so explicitly in the result. Do not edit `run-installed-e2e.sh` to make it pass.

- [ ] **Step 4: Confirm the product package never changed**

```bash
cd /home/swy/LoopAgentTeams
git diff --stat -- agent-invoke/
git status --short
```

Expected: `agent-invoke/` has no diff; the working tree shows only Task 1's test changes (already committed) and no stray files.

- [ ] **Step 5: Write the V1 evidence note**

Create `docs/superpowers/evidence/2026-08-03-agent-invoke-v1.md` containing, in prose plus one table: the deterministic results from Step 1, the twelve proxy turns from Task 3 (per client, per case, pass/fail), the six installed case verdicts from Step 3, the install state from Task 2 Step 8, and an explicit section listing the four experimental behaviors — TUI resume, `prune`, persistent native handles, arbitrary session import — as **not verified in V1**. Include no raw client output, credentials, prompts, or session JSONL.

- [ ] **Step 6: Commit the evidence note**

```bash
cd /home/swy/LoopAgentTeams
git add docs/superpowers/evidence/2026-08-03-agent-invoke-v1.md
git commit -m "docs(agent-invoke): record V1 acceptance evidence"
```

- [ ] **Step 7: Check the acceptance conditions**

Walk A-1 through A-7 in the spec and state, one line each, which artifact satisfies it. A-5's second half needs an explicit check:

```bash
cd /home/swy/LoopAgentTeams
git diff --exit-code main -- lat-dispatch/ && echo 'A-5a: zero diff'
grep -rn 'lat-dispatch\|lat_dispatch' agent-invoke/ || echo 'A-5b: no lat-dispatch reference in the package'
```

Expected: both lines print.

- [ ] **Step 8: Request review**

Use `superpowers:requesting-code-review` on the branch diff. Reuse the existing reviewer instance via `SendMessage` if one is live; only spawn a fresh reviewer if it has terminated. Adjudicate each finding yourself — a reviewer verdict is not final authority. Re-review covers prior findings and direct regressions only.

- [ ] **Step 9: Push `dev`**

Only after A-1 through A-7 all hold and review is PASS:

```bash
cd /home/swy/LoopAgentTeams
git status --short --branch
git push origin dev
git rev-parse main origin/main
```

Expected: `dev` pushed; `main` and `origin/main` both still `5a8e76c6712ba130799b481d09d63f2de067eafa`.

---

## QA Acceptance Mapping

| Spec | Satisfied by |
|---|---|
| A-1 deterministic PASS, `agent-invoke/` unchanged | Task 4 Step 1, Task 4 Step 4 |
| A-2 twelve proxy turns PASS on both clients | Task 3 Steps 2–3 |
| A-3 six installed cases verified | Task 4 Steps 2–3 |
| A-4 three install paths correct, both hosts trigger | Task 2 Steps 3–8 |
| A-5 `lat-dispatch` zero diff and unreferenced | Task 4 Step 7 |
| A-6 experimental behaviors marked unverified | Task 4 Step 5 |
| A-7 reviewer PASS | Task 4 Step 8 |

## Final Verification Gate

Before claiming completion, run and paste the output of:

```bash
cd /home/swy/LoopAgentTeams
git status --short --branch
git rev-parse HEAD main origin/main origin/dev
git diff --exit-code main -- lat-dispatch/ && echo 'lat-dispatch: zero diff'
git diff --stat main..dev -- agent-invoke/
ls -ld ~/.agents/skills/agent-invoke ~/.claude/skills/agent-invoke ~/.codex/skills/agent-invoke
```

`git diff --stat main..dev -- agent-invoke/` will show the package as added relative to `main` — that is expected, since the package is new on `dev`. What must be zero is the diff between the package and its state at the start of this plan (`6031333`), checked in Task 4 Step 4.

Never claim a step passed without pasting the command output that shows it.
