---
name: cowork-dispatch
description: Use when coordinating CoWork collaboration from Claude Code: creating or reviewing specs and implementation plans, initializing .cowork queues, dispatching approved execution tasks through zmx, checking cowork status, or cleaning results.
compatibility: Designed for Claude Code. Requires git, zmx, codex, codex-multi-auth, and a project workspace with shell access.
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
2. Convert approved execution work into one or more tasks.
3. Read `.cowork/tasks.yaml` using the queue rules below.
4. Append new execution tasks with stable field order:
   `id`, `goal`, `context`, `constraints`, `created_by`, `created_at`.
5. Use a zmx session name in the form `cx-<short-english-task-name>`, such as `cx-user-api` or `cx-auth-module`.
6. Run `zmx list` before starting. If the target session already exists, stop and report the conflict; do not overwrite it.
7. Start Codex CLI with:

   ```bash
   zmx run cx-<name> "cd \"$PROJECT_DIR\" && codex --approval-mode full-auto 'You are the cowork-runner. Read .cowork/tasks.yaml, execute all pending implementation tasks following the cowork-runner skill, write .cowork/results.yaml, remove completed tasks, then exit.'"
   ```

8. Wait 3 minutes.
9. Run:

   ```bash
   zmx history cx-<name> | tail -20
   ```

10. If history shows a 503-style error, run:

    ```bash
    zmx send cx-<name> "GO"
    ```

    Report: `Encountered 503; retried.`

11. If history shows account quota exhaustion:
    1. Run `codex-multi-auth check`.
    2. Find an account with available quota.
    3. Run `codex-multi-auth switch <account-number>`.
    4. Run `zmx send cx-<name> "GO"`.
    5. Report: `Switched account and retried.`

12. If no account has quota, report that manual action is required. Do not delete dispatched tasks from `.cowork/tasks.yaml`.
13. Tell the user:
    - `zmx attach cx-<name>` shows live progress.
    - `zmx history cx-<name>` shows output history.
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

- Task IDs use `task-{unix_ms}-{random_hex_3}`, for example `task-1747536000000-a3f`.
- Each task contains only:
  - `id`
  - `goal`
  - `context`
  - `constraints`
  - `created_by: claude-code`
  - `created_at`
- `context.plan_file` and `context.related_files` use project-root-relative paths.
- `constraints` must preserve implementation constraints from the approved plan and user instructions.
- Do not include spec review, plan review, or planning-only work.

## Queue File Rules

- If `.cowork/tasks.yaml` is missing, an empty string, or `[]`, treat it as an empty queue.
- If `.cowork/tasks.yaml` cannot be parsed as YAML:
  1. Back it up as `.cowork/tasks.yaml.bad`, using a timestamped unique name if that file already exists.
  2. Create a new `.cowork/tasks.yaml` containing `[]`.
  3. Report the backup and reset to the user.
- Write YAML with stable field order to avoid unnecessary large diffs.
