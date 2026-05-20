---
name: cowork-runner
description: Use when executing CoWork queued implementation tasks from .cowork/tasks.yaml with Codex CLI, updating results.yaml, creating follow-up tasks, or running inside a zmx session started by cowork-dispatch.
compatibility: Designed for Codex CLI. Requires shell access and a project workspace containing .cowork/.
---

# CoWork Runner

Execute approved CoWork implementation tasks from `.cowork/tasks.yaml` inside Codex CLI, usually from a `zmx` session started by `cowork-dispatch`.

Keep this `SKILL.md` under 500 lines. See `references/yaml-schema.md` for the complete YAML schema and error handling rules.

## When to Use

Use this skill when:

- A prompt says `cowork-runner`.
- A prompt asks Codex CLI to process `.cowork/tasks.yaml` or `.cowork/results.yaml`.
- Codex CLI is running inside a `zmx` session launched by `cowork-dispatch`.
- The task concerns CoWork queued implementation tasks.

## Execution Boundaries

- Do not create a background daemon or long-running watcher.
- Process the current queue, write results, update tasks, then exit normally.
- Do not handle spec review or plan review.
- Only execute approved implementation tasks.

## Task Execution Strategy

- Simple tasks: if the goal is clear, scoped to one file or a small localized change, Codex executes directly.
- Complex tasks: if the goal spans multiple files, has many constraints, or requires multiple coordinated steps, Codex may generate sub-agent work divisions when available.
- Complexity signals include `goal`, `context.related_files`, and the number or strictness of `constraints`.
- Sub-agent work must stay within the queued task's goal and constraints.

## Processing Flow

1. Read `.cowork/tasks.yaml` from the project root.
2. If the file is missing, empty, or `[]`, output `No pending tasks`, ensure normal exit code `0`, and exit.
3. If `tasks.yaml` cannot be parsed:
   1. Output an error.
   2. Back it up as `.cowork/tasks.yaml.bad`, using a timestamped unique name if needed.
   3. Write a fresh `.cowork/tasks.yaml` containing `[]`.
   4. Exit normally so the user can inspect the bad file.
4. Process tasks from top to bottom.
5. For each task, implement according to:
   - `goal`
   - `context.plan_file`
   - `context.related_files`
   - `constraints`
6. For every processed task, insert a result at the top of `.cowork/results.yaml`.
7. Remove the processed task from `.cowork/tasks.yaml` whether it completed, partially completed, or failed.
8. Preserve any unprocessed tasks.
9. Before exiting, print a terminal summary with:
   - processed count
   - completed count
   - partial count
   - failed count
   - modified file list

## Result Statuses

Use exactly one of these statuses:

- `completed`: the task goal was fully implemented.
- `partial`: part of the goal was implemented; `summary` must explain completed and incomplete scope.
- `failed`: implementation did not complete; `errors` must include at least one object with `code` and `message`.

## Result Write Rules

- Insert newest results at the top of `.cowork/results.yaml`.
- If `results.yaml` is missing or empty, treat it as `[]`.
- Empty result files should be normalized to `[]`.
- If `results.yaml` cannot be parsed:
  1. Back it up as `.cowork/results.yaml.bad`, using a timestamped unique name if needed.
  2. Create a new `results.yaml` containing only the current result.
  3. Output a warning.
- Write YAML with stable field order:
  `task_id`, `goal`, `status`, `summary`, `outputs`, `errors`, `completed_at`.

## Follow-Up Tasks

- Add follow-up tasks only when a large task must be split and the remaining work is still trackable.
- Follow-up task IDs use `task-{unix_ms}-{random_hex_3}`.
- Follow-up tasks use `created_by: codex`.
- Follow-up tasks must remain implementation tasks; never add spec review or plan review tasks.

## Completion Output

- If no task exists, output `No pending tasks` and exit with code `0`.
- If tasks were processed, output the count by status and the modified files.
- Do not keep the zmx session alive after the current queue has been processed.
