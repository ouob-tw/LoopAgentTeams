# CoWork YAML Schema

This file is the complete reference for `.cowork/tasks.yaml`, `.cowork/results.yaml`, parse errors, empty states, and status summaries used by `cowork-runner`.

## tasks.yaml

`tasks.yaml` is a YAML list of approved implementation tasks. The runner processes tasks from top to bottom.

```yaml
- id: "task-1747536000000-a3f"
  goal: "Implement the User model in src/models/user.py with SQLAlchemy"
  context:
    plan_file: "docs/plans/2026-05-18-user-api-plan.md"
    related_files:
      - "src/models/"
      - "src/db.py"
  constraints:
    - "Follow FastAPI conventions"
    - "Use async SQLAlchemy"
  created_by: claude-code
  created_at: "2026-05-18T10:00:00Z"
```

### tasks.yaml Fields

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | string | Unique ID in `task-{unix_ms}-{random_hex_3}` format. |
| `goal` | yes | string | Implementation goal. |
| `context` | no | object | Supporting context for execution. |
| `context.plan_file` | no | string | Project-root-relative path to the approved plan. |
| `context.related_files` | no | string array | Project-root-relative files or directories relevant to the task. |
| `constraints` | no | string array | Rules the runner must preserve while implementing. |
| `created_by` | yes | string | `claude-code` for dispatch-created tasks or `codex` for runner-created follow-up tasks. |
| `created_at` | yes | ISO 8601 string | Task creation timestamp. |

## results.yaml

`results.yaml` is a YAML list of execution results. Newest results are inserted at the top.

```yaml
- task_id: "task-1747536000000-a3f"
  goal: "Implement the User model in src/models/user.py with SQLAlchemy"
  status: completed
  summary: "Created the User model with id, email, name, and created_at fields."
  outputs:
    - "src/models/user.py"
  errors: []
  completed_at: "2026-05-18T10:05:00Z"
```

### results.yaml Fields

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `task_id` | yes | string | Original task ID. |
| `goal` | yes | string | Original task goal copied into the result. |
| `status` | yes | string | `completed`, `failed`, or `partial`. |
| `summary` | yes | string | What happened. For `partial`, include completed and incomplete scope. |
| `outputs` | no | string array | Project-root-relative files created or modified. |
| `errors` | no | object array | Failure details. Each object contains `code` and `message`. |
| `completed_at` | yes | ISO 8601 string | Result completion timestamp. |

### Error Object

```yaml
errors:
  - code: "test_failure"
    message: "Unit tests failed in tests/test_user.py."
```

## Empty State

- Standard empty `tasks.yaml` content is `[]`.
- Standard empty `results.yaml` content is `[]`.
- Missing files and empty strings are treated as `[]` when reading.
- When writing back, normalize empty queue or result files to `[]`.

## Parse Error Handling

### tasks.yaml Parse Failure

1. Output an error that `.cowork/tasks.yaml` could not be parsed.
2. Back up the bad file as `.cowork/tasks.yaml.bad`.
3. If `.cowork/tasks.yaml.bad` already exists, use a timestamped or otherwise unique filename such as `.cowork/tasks.yaml.20260520T120000Z.bad`.
4. Recreate `.cowork/tasks.yaml` with `[]`.
5. Stop the current runner execution and exit normally so the user can inspect the bad file.

### results.yaml Parse Failure

1. Output a warning that `.cowork/results.yaml` could not be parsed.
2. Back up the bad file as `.cowork/results.yaml.bad`.
3. If `.cowork/results.yaml.bad` already exists, use a timestamped or otherwise unique filename such as `.cowork/results.yaml.20260520T120000Z.bad`.
4. Create a new `.cowork/results.yaml` containing only the current result.
5. Continue processing if it is safe to do so.

## Status Summary Rules

- `pending`: tasks still present in `.cowork/tasks.yaml`.
- `completed`: results with `status: completed`.
- `failed`: results with `status: failed`.
- `partial`: results with `status: partial`.
- `running`: matching `cx-` session state from `zmx list`.

## Stable Field Order

Use stable ordering to keep diffs small.

Task order:

```yaml
id: ...
goal: ...
context: ...
constraints: ...
created_by: ...
created_at: ...
```

Result order:

```yaml
task_id: ...
goal: ...
status: ...
summary: ...
outputs: ...
errors: ...
completed_at: ...
```
