# Agent Invoke V1 — Acceptance Evidence

**Verdict: V1 does NOT pass.** A-3 fails. The eight-case installed smoke cannot
produce authoritative evidence in this harness, and the `lifecycle` hard gate is
therefore unproven. Nothing under `agent-invoke/` was modified to work around
any failure, and no assertion in the test tree was removed or weakened.

- Plan: `docs/superpowers/plans/2026-08-03-agent-invoke-v1.md`
- Spec: `docs/superpowers/specs/2026-08-03-agent-invoke-v1-design.md`
- Product baseline: `6031333` — `agent-invoke/` is at zero diff against it.
- Executors: `code_executor_1` (Tasks 1, 3, 4, and Task 5 Step 1), `code_executor_2` (E-4, the installed smoke, the proxy re-runs, and this note).

---

## 1. Deterministic suites (Plan Task 5 Step 1)

Re-run in full after the E-4 and `--verbose` commits.

| Target | Result |
|---|---|
| `route-integration-test.sh` | PASS — route lifecycle matrix |
| `session-reference-test.sh` | PASS — exact session reference resolver |
| `exec-client-test.sh` | PASS — exact external exec client |
| `monitor-session-test.sh` | PASS — authoritative external completion monitor |
| `state-manager-test.sh` | PASS — secure state manager |
| `skill-contract-test.sh` | PASS — agent-invoke skill contract |
| `installed-evidence-validator-test.sh` | PASS — installed evidence validators |
| ShellCheck (e2e, integration, product scripts) | silent |
| `agentskills validate agent-invoke` | `Valid skill: agent-invoke` |
| `git diff --check` | silent |
| `git diff --exit-code 6031333 -- agent-invoke/` | zero diff (A-1) |
| `git diff --exit-code main -- lat-dispatch/` | zero diff (A-5) |
| `grep -rn 'lat-dispatch' agent-invoke/` | no reference in the package (A-5b) |

## 2. Decision proxy (Plan Task 4, plus the Task 5 re-runs)

The live set is the eight V1 cases at one repetition. Codex ran once, Claude five
times in total. `state_unchanged` was `true` in every run, and `~/.agent-invoke`
was never created — the proxy is decision-only.

| Case | Codex (1 run) | Claude (5 runs) |
|---|---|---|
| `generic-native` | pass | 5/5 |
| `cross-client` | pass | 5/5 |
| `explicit-exec` | pass | 5/5 |
| `reference-resume` | pass | 5/5 |
| `stop` | pass | 5/5 |
| `full-LAT` | pass | 5/5 |
| `non-delegation-request` | pass | 5/5 |
| `direct-work` | pass | **3/5** |

### `direct-work` instability

`direct-work` is the QA-6 negative that a "do it yourself" request must not be
delegated. Across five Claude-side observations it failed twice, both times with
`failures[].reason == "envelope-mismatch"` — a decision mismatch, never
`client-exit`, so it is not quota or transport related.

| Observation | Executor | `direct-work` | Reason |
|---|---|---|---|
| 1 | `code_executor_1` | fail | `envelope-mismatch` |
| 2 | `code_executor_1` | pass | — |
| 3 | `code_executor_2` | fail | `envelope-mismatch` |
| 4 | `code_executor_2` | pass | — |
| 5 | `code_executor_2` | pass | — |

Roughly a 40% failure rate on a required negative case. This was **not** fixed:
`direct-work` failing is product decision behaviour, and the product is not to be
touched under this TASK_ID. A-2 therefore does not hold cleanly and needs
adjudication. The other seven cases were stable at 5/5 on Claude and 8/8 on Codex.

## 3. Installed smoke (Plan Task 5 Steps 2 and 3) — FAILED

Two of the eight cases were run to completion. Neither produced authoritative
evidence, and the causes are structural rather than incidental, so the remaining
six were not run — see the quota note below.

| Case | Host | Ran | Verdict | Reason code |
|---|---|---|---|---|
| `claude-native` | Claude | yes, twice | unverified | `AUTHORITATIVE_EVIDENCE_INCOMPLETE` |
| `codex-native` | Codex | yes | unverified | `SKILL_ACTIVATION_NOT_OBSERVED` |
| `claude-to-codex-exec` | Claude | no | not run | blocked by the findings below |
| `codex-to-claude-exec` | Codex | no | not run | blocked |
| `same-host-exec` | Codex | no | not run | blocked |
| `native-unavailable` | Codex | no | not run | blocked |
| `managed-exec-resume` | Codex | no | not run | blocked |
| `lifecycle` | Codex | no | **not run** | blocked — hard gate unproven |

The three `jq -se` gates of Step 3 — the whole-set gate, the E-1 zero-external-carrier
gate, and the E-2 `result_returned` gate — were never evaluated, because no case
reached `verification.status == "verified"`.

### Finding 1 — checkout permission drift (environment, resolved)

The runner compares the sandbox-installed package against a `git archive` of the
candidate commit, including file mode. In the working tree `agent-invoke/SKILL.md`
and `agent-invoke/references/native.md` were mode `600`, while git records both as
`100644`, so every case aborted at
`Codex installed package metadata differs from candidate contract`.

`bunx skills add --copy` was confirmed to preserve source modes exactly, so the
installed copy inherited the drift. The two files were restored to their
git-recorded mode with `chmod 644`. Content was untouched — both sha256 digests
are byte-identical before and after, and `git diff` against `6031333` stayed
empty. This is a dirty local checkout, not a product defect.

### Finding 2 — runner missing `--verbose` (test harness, fixed additively)

`run-installed-e2e.sh` invoked the Claude host as
`claude -p --output-format stream-json --permission-mode acceptEdits`. Claude Code
rejects that combination with
`Error: When using --print, --output-format=stream-json requires --verbose`,
exiting 1 with an empty trace. Every Claude-hosted case therefore reported
`SKILL_ACTIVATION_NOT_OBSERVED` for a reason that had nothing to do with skill
activation.

This is a harness defect, not a product defect: the product's own
`agent-invoke/scripts/run-exec-client.sh` already passes `--verbose`. The flag was
added to the runner. It weakens nothing — it is what makes the stream the runner
parses exist at all. After the fix `claude-native` exits 0 and the trace carries a
genuine `{"type":"tool_use","name":"Skill","skill":"agent-invoke"}` activation event.

### Finding 3 — the activation predicate reads the wrong field for Codex (harness, unresolved)

`run-installed-e2e.sh` gates every case on `skill_events` being non-empty. That
predicate matches objects with `.type == "skill"` or `.name == "Skill"`, and reads
the skill path out of `.path` or `.skill_path`. A direct probe of
`codex exec --json` showed its entire event vocabulary to be `thread.started`,
`turn.started`, `item.started`, `item.completed`, `command_execution`,
`agent_message`, `turn.completed` — there is no skill event type and no `.path`
field, so the predicate matched zero objects.

**Codex did activate the skill.** Both the `--json` stream and the Codex rollout
record show it reading the installed package directly:

```
completed  /bin/bash -lc "sed -n '1,240p' /home/swy/.codex/skills/agent-invoke/SKILL.md"
completed  /bin/bash -lc "sed -n '1,240p' /home/swy/.codex/skills/agent-invoke/references/native.md"
```

So the activation fact is present in the very stream the runner already parses; it
is carried in `command_execution.command` rather than in a `.path` field. This is a
field-mapping defect in the harness, not an unobservable host and not a product
defect — the install and the activation both work.

Six of the eight cases are Codex-hosted, including `lifecycle` and
`native-unavailable`, and all six fail at this same gate. The minimal correction is
to let the existing predicate also match a `command_execution` whose `.command`
names the installed `.../agent-invoke/SKILL.md` — which keeps the same strength,
since it still demands the installed SKILL.md path appear. It was **not** applied
here: it edits an existing predicate rather than adding to it, and under the
additive-only constraint that is Dispatch's call, not the executor's.

### Finding 4 — `claude-native` produces no operation record (product behaviour)

With Finding 2 fixed, `claude-native` activates the skill and reads its references,
but the run ends with `route`, `mode`, and `model` all empty, `identity_state` at
`unknown`, and `authoritative_outcome` false. No operation directory appears under
the sandbox `~/.agent-invoke/runs`, so the host answered in prose without
performing the native delegation the case asserts. Observed tool sequences were
`[Skill, Read, ...]` on both attempts — reproducible 2/2, not intermittent.

Per the global constraint this was recorded and not fixed. Whether it is a skill
instruction defect or a limitation of non-interactive `-p` mode is for the product
TASK_ID to determine; either way QA-1's installed half is unproven.

### Diagnostic method and a model-rule deviation

Findings 3 and 4 were confirmed by reading the Codex rollout JSONL under
`~/.codex/sessions/` and the captured `--json` stream, rather than by re-running
cases. That is both faster and cheaper in quota, and it is what produced the
`sed ... SKILL.md` evidence above. Note that neither runner leaves such a record
for its own cases: `run-installed-e2e.sh` shreds its traces on exit, and
`run-trigger-eval.sh` runs with an isolated `CODEX_HOME` and
`--no-session-persistence`, so only the ad-hoc probe was inspectable.

Deviation to record: that probe was launched as a bare `codex exec` with no
`--model`, so it ran on `gpt-5.6-sol`. The LAT `code_executor` default is
`gpt-5.6-terra` / medium, and the probe should have pinned it. The conclusion is
unaffected — a host's JSON event vocabulary does not vary by model, and the
`command_execution` shape shown above is structural — but the run was not
model-pinned as the LAT client rules require.

### Codex quota

Account 2 was pinned and healthy throughout (`codex-multi-auth check`: live session
OK, quota 100%). No quota failure occurred and no run was recorded as blocked. The
six unrun cases were skipped because Finding 3 makes their outcome structurally
determined at the same gate, not because quota ran out.

## 4. Install and activation (Plan Task 3)

Recorded by `code_executor_1` and re-confirmed here.

| Path | State |
|---|---|
| `~/.agents/skills/agent-invoke` | real directory |
| `~/.claude/skills/agent-invoke` | symlink to `../../.agents/skills/agent-invoke` |
| `~/.codex/skills/agent-invoke` | real directory |

The installed tree ships only `SKILL.md`, `references`, and `scripts`, with no
tests, no fixtures, and no links to repository docs. Activation was proven from a
temporary directory outside the repository on both hosts: Claude produced an
explicit skill-activation event for `agent-invoke`, and Codex produced an explicit
read of the installed `~/.agents/skills/agent-invoke/SKILL.md`. Codex consumed the
shared path rather than its own `~/.codex/` copy, which the plan's evidence
standard accepts.

Note that the host installs were made with `cp -a` from the drifted working tree,
so they carry the same `600` modes described in Finding 1. Contents are identical;
only the mode differs.

## 5. State integrity

- `agent-invoke/` is at zero diff against `6031333`, by content and by git-recorded mode.
- `lat-dispatch/` is at zero diff against `main`, and is not referenced by the package.
- The old ledger `.lat/workspace/2026-08-01-agent-invoke-design/` is byte-identical, still six `partial` rows in each file.
- `main` and `origin/main` were not touched, and `dev` was not pushed.
- No raw client output, credential, prompt, or session JSONL is stored in the repository.

## 6. Not verified in V1

These behaviors are shipped but **not** covered by any evidence above. Treat them
as unproven.

- **TUI resume** — the `same-host-tui` and `managed-tui-resume` paths. No installed case ran.
- **`prune`** — dry-run and confirmed removal. Covered only by the validator unit test, never end to end.
- **Persistent native handles** — native owner records surviving across turns.
- **Arbitrary session import** — `imported-resume`, importing a session the skill did not create.

In addition, and beyond the plan's original list, V1 leaves these unverified
because the smoke did not complete:

- Every QA claim whose installed half depends on `run-installed-e2e.sh`: QA-1's native routing, QA-2's cross-family result return (E-2), QA-3's explicit-external and refusal cases, QA-4's resume identity (E-3), and QA-5's lifecycle isolation (E-4).
- E-4 exists and is unit-tested in `installed-evidence-validator-test.sh`, but has never been exercised against a real lifecycle run.

## 7. Acceptance conditions

| Condition | Status | Evidence |
|---|---|---|
| A-1 deterministic PASS, `agent-invoke/` zero diff vs `6031333` | **holds** | Section 1 |
| A-2 sixteen proxy turns PASS on both clients | **does not hold cleanly** | Section 2 — `direct-work` is 3/5 on Claude |
| A-3 eight installed cases verified, `lifecycle` with no fallback | **FAILS** | Section 3 — two cases unverified, six unrun, hard gate unproven |
| A-4 three install paths correct, activation proven outside the repo | holds | Section 4 |
| A-5 `lat-dispatch` zero diff and unreferenced | holds | Section 1 |
| A-6 experimental behaviors marked unverified | holds | Section 6 |
| A-7 E-1 to E-4 implemented, zero removals in the test tree | **partially** | E-2, E-3, E-4 implemented; E-1 written but never evaluated against real evidence |
| A-8 new ledger terminal, old ledger byte-identical | holds | Section 5 |
| A-9 reviewer PASS, every finding adjudicated | not reached | Review not requested; V1 fails earlier |

**`dev` must not be pushed on this evidence.**
