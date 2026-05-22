---
name: cowork-dispatch
description: "Use when coordinating CoWork collaboration from Claude Code: creating or reviewing specs and implementation plans, initializing .cowork queues, dispatching approved execution tasks through zmx, checking cowork status, or cleaning results."
compatibility: "Designed for Claude Code. Requires git, zmx, codex, codex-multi-auth, and a project workspace with shell access."
---

# CoWork Dispatch

Coordinate the Claude Code side of CoWork: spec and plan preparation, YAML queue setup, approved task dispatch, session health checks, status reporting, and result cleanup.

Keep this `SKILL.md` under 500 lines. Use relative paths for bundled files.

## When to Use

Use this skill when the user asks for any of the following:

- CoWork, Claude Code + Codex CLI collaboration, or Codex task dispatch.
- Initializing `.cowork/`, `.cowork/tasks.yaml`, or `.cowork/results.yaml`.
- Writing or reviewing a spec or implementation plan with Codex plugin assistance.
- Dispatching approved execution work to an external Codex CLI session.
- Checking CoWork queue status, result status, or `cx-` zmx sessions.
- Cleaning CoWork results.

## Role Boundaries

- Claude Code drafts specs, fixes major spec issues, reviews Codex-produced plans against the spec, and dispatches approved execution tasks.
- Codex plugin is used only inside the Claude Code session for spec review and implementation plan drafting or correction.
- External Codex CLI is used only for execution tasks from `.cowork/tasks.yaml`.
- `tasks.yaml` is only for approved execution work. Never put spec review, plan review, or planning tasks into YAML.

## Default Execution Mode

When the user says "cowork", "CoWork", or activates the collaboration flow, run the **full pipeline end-to-end** without pausing between phases:

```
init → spec (brainstorm + draft + Codex review loop) → plan (Codex draft + Claude review loop + commit) → dispatch → monitor → verify results → report
```

**Continue by default.** Do not ask for confirmation between phases. After each phase completes, immediately proceed to the next. Report progress in one sentence per phase transition (e.g., "Spec approved, proceeding to plan.").

**Pause only when:**

- A design choice or ambiguity requires user decision (e.g., approach A vs B during brainstorm).
- Codex review raises a major issue that has multiple valid resolutions.
- An unrecoverable error occurs (quota exhausted on all accounts, zmx session conflict).
- Codex execution fails with `status: failed` in results.

**Do not pause for:**

- Spec minor corrections — Codex or Claude Code fixes them and continues.
- Plan gaps or contradictions — send feedback to Codex, re-review, continue.
- 503 errors — auto-retry with `zmx send "GO"` and continue.
- Quota exhaustion on one account — auto-switch with `codex-multi-auth` and continue.
- Test failures during Codex execution — Codex handles them per the plan.

**After Codex completes:** read `.cowork/results.yaml`, review the diff (`git diff`), run the full test suite, and report the final status to the user. If all tests pass, the flow is done. If tests fail or results show `partial`/`failed`, diagnose and report.

## Commands

### init

1. Create `.cowork/` in the project root if missing.
2. Create `.cowork/tasks.yaml` with `[]` if missing.
3. Create `.cowork/results.yaml` with `[]` if missing.
4. Do not overwrite non-empty existing queue or result files.

### spec

1. Use the Superpowers brainstorming workflow before drafting requirements.
2. Use the Superpowers writing-plans workflow when turning requirements into a durable spec or plan-ready artifact.
3. Claude Code writes the initial spec draft.
4. Call the Codex plugin to review the spec.
5. If Codex finds small issues, Codex may directly correct them.
6. If Codex finds major design, missing-requirement, or architecture issues, Claude Code fixes the spec and resubmits it for review.
7. Repeat until the spec is approved.
8. Do not write any spec review task to `.cowork/tasks.yaml`.

### plan

1. Start only after the spec is approved.
2. Call the Codex plugin to produce an implementation plan.
3. Claude Code reviews the plan against the approved spec.
4. If the plan has gaps, contradictions, or scope drift, send feedback to Codex and review the corrected plan again.
5. When the spec and plan are both approved, commit them together with:

   ```bash
   git commit -m "docs: add <feature-name> spec and implementation plan"
   ```

6. Do not write plan drafting or plan review work to `.cowork/tasks.yaml`.

### dispatch

1. Confirm the implementation plan is approved.
2. Create **one summary task** that points to the plan file. Do not split the plan into multiple granular tasks — Codex reads the plan itself and executes phases in order.
3. Read `.cowork/tasks.yaml` using the queue rules below.
4. Append the task with stable field order:
   `id`, `goal`, `context`, `constraints`, `created_by`, `created_at`.
   - `goal`: a single sentence describing the full feature implementation.
   - `context.plan_file`: path to the approved plan.
   - `context.spec_file`: path to the approved spec (if any).
   - `context.related_files`: key files Codex should be aware of.
   - `constraints`: preserve user instructions and implementation constraints from the plan.
5. Use a zmx session name in the form `cx-<short-english-task-name>`, such as `cx-user-api` or `cx-auth-module`.
6. Run `zmx list` before starting. If the target session already exists, stop and report the conflict; do not overwrite it.
7. Start Codex CLI in **detached mode** with `zmx run -d` and `bash -c` to avoid quoting issues:

   ```bash
   zmx run cx-<name> -d bash -c 'codex --dangerously-bypass-approvals-and-sandbox "You are the cowork-runner. Read .cowork/tasks.yaml, execute all pending implementation tasks following the cowork-runner skill, write .cowork/results.yaml, remove completed tasks, then exit."'
   ```

   **Important zmx notes:**
   - Always use `zmx run -d` (detached). Without `-d`, zmx blocks the calling terminal and the session is killed if the caller (e.g. Claude Code) exits.
   - Always wrap the codex command with `bash -c '...'`. zmx passes arguments as-is; without `bash -c`, a command string with flags is treated as a single executable name.
   - Use `codex --dangerously-bypass-approvals-and-sandbox` (not `codex exec`; the full client handles zmx sessions correctly).

8. **Initial error check** — wait 3 minutes, then run `zmx history cx-<name> | tail -20` once to detect startup failures (503, quota).

9. If history shows a 503-style error, run:

   ```bash
   zmx send cx-<name> "GO"
   ```

   Report: `Encountered 503; retried.`

10. If history shows account quota exhaustion:
    1. Run `codex-multi-auth check`.
    2. Find an account with available quota.
    3. Run `codex-multi-auth switch <account-number>`.
    4. Run `zmx send cx-<name> "GO"`.
    5. Report: `Switched account and retried.`

11. If no account has quota, report that manual action is required. Do not delete dispatched tasks from `.cowork/tasks.yaml`.

12. **Completion monitoring** — after the initial error check passes, use a single background file-based monitor. Do not repeatedly call `zmx history`.

    ```bash
    until [ -f .cowork/results.yaml ] && grep -q '^\[\]' .cowork/tasks.yaml 2>/dev/null; do
      sleep 30
    done
    zmx history cx-<name> | tail -60
    ```

    Rules:
    - Check file state (`tasks.yaml` → `[]` and `results.yaml` exists), not zmx history output (format is unstable: `Wrote` vs `Edited`).
    - Use `sleep 30`, not `sleep 10`.
    - Run this as a single background monitor. Do not manually call `zmx history` in a loop.
    - At most one additional mid-progress check at 3 minutes. No consecutive checks.
    - Only read `zmx history` once after the monitor signals completion.

13. Tell the user:
    - `zmx attach cx-<name>` shows live progress.
    - `zmx history cx-<name> | tail -30` shows recent output.
    - `zmx wait cx-<name>` blocks until the session task completes.
    - `zmx list` shows all sessions.
    - `Ctrl+\` detaches from an attached session without terminating Codex.

### status

1. Read `.cowork/tasks.yaml`; missing, empty string, or `[]` means no pending tasks.
2. Read `.cowork/results.yaml`; missing, empty string, or `[]` means no recorded results.
3. Summarize:
   - pending tasks from `tasks.yaml`
   - completed results
   - failed results
   - partial results
4. Run `zmx list` and include `cx-` session status when available.

### clean

1. Reset `.cowork/results.yaml` to `[]`.
2. Do not modify `.cowork/tasks.yaml`.

## Task Generation Rules

- **One task per dispatch.** Create a single summary task that covers the entire approved plan. Codex reads the plan file and executes phases autonomously. Do not decompose the plan into per-phase or per-file tasks.
- Task IDs use `task-{unix_ms}-{random_hex_3}`, for example `task-1747536000000-a3f`.
- Each task contains only:
  - `id`
  - `goal` — one sentence describing the full implementation scope
  - `context`
    - `plan_file` — path to the approved plan (Codex reads this to determine phases and steps)
    - `spec_file` — path to the approved spec (optional)
    - `related_files` — key files Codex should be aware of
  - `constraints` — preserve implementation constraints from the approved plan and user instructions
  - `created_by: claude-code`
  - `created_at`
- All paths use project-root-relative format.
- Do not include spec review, plan review, or planning-only work.

## Queue File Rules

- If `.cowork/tasks.yaml` is missing, an empty string, or `[]`, treat it as an empty queue.
- If `.cowork/tasks.yaml` cannot be parsed as YAML:
  1. Back it up as `.cowork/tasks.yaml.bad`, using a timestamped unique name if that file already exists.
  2. Create a new `.cowork/tasks.yaml` containing `[]`.
  3. Report the backup and reset to the user.
- Write YAML with stable field order to avoid unnecessary large diffs.
