# LAT YAML 結構定義

`.lat/tasks.yaml` 與 `.lat/results.yaml` 的完整結構、錯誤處理規則與狀態摘要。

## tasks.yaml

YAML 列表，包含已核准的實作任務。Runner 由上而下處理。

```yaml
- task_id: "task-1747536000000-a3f"
  goal: "在 src/models/user.py 實作 SQLAlchemy User 模型"
  context:
    plan_file: "docs/plans/2026-05-18-user-api-plan.md"
    spec_file: "docs/specs/2026-05-18-user-api-spec.md"
    related_files:
      - "src/models/"
      - "src/db.py"
  constraints:
    - "遵循 FastAPI 慣例"
    - "使用 async SQLAlchemy"
  created_by: dispatch-agent
  created_at: "2026-05-18T10:00:00Z"
```

### 欄位定義

| 欄位 | 必填 | 類型 | 說明 |
|------|:----:|------|------|
| `task_id` | 是 | string | 唯一識別碼，格式 `task-{unix_ms}-{random_hex_3}` |
| `goal` | 是 | string | 實作目標 |
| `context` | 否 | object | 執行輔助資訊 |
| `context.plan_file` | 否 | string | 專案根目錄相對路徑，指向已核准計劃 |
| `context.spec_file` | 否 | string | 專案根目錄相對路徑，指向已核准規格 |
| `context.related_files` | 否 | string[] | 相關檔案或目錄 |
| `constraints` | 否 | string[] | 實作約束 |
| `created_by` | 是 | string | 建立此任務的 agent 識別名稱 |
| `created_at` | 是 | ISO 8601 | 建立時間 |

## results.yaml

YAML 列表，最新結果置頂。

```yaml
- task_id: "task-1747536000000-a3f"
  goal: "在 src/models/user.py 實作 SQLAlchemy User 模型"
  status: completed
  summary: "建立 User 模型，包含 id、email、name、created_at 欄位。"
  outputs:
    - "src/models/user.py"
  errors: []
  completed_at: "2026-05-18T10:05:00Z"
```

### 欄位定義

| 欄位 | 必填 | 類型 | 說明 |
|------|:----:|------|------|
| `task_id` | 是 | string | 對應任務的 `task_id` |
| `goal` | 是 | string | 原始任務目標 |
| `status` | 是 | string | `completed`、`partial`、`failed` |
| `summary` | 是 | string | 執行摘要。`partial` 須說明已完成與未完成範圍 |
| `outputs` | 否 | string[] | 建立或修改的檔案 |
| `errors` | 否 | object[] | 每個物件含 `code` 和 `message` |
| `completed_at` | 是 | ISO 8601 | 完成時間 |

### 錯誤物件

```yaml
errors:
  - code: "test_failure"
    message: "tests/test_user.py 的單元測試失敗。"
```

## 空狀態

- 標準空內容為 `[]`。
- 檔案遺失或空字串時視為 `[]`。
- 寫回時正規化為 `[]`。

## 解析錯誤處理

### tasks.yaml 解析失敗

1. 輸出錯誤訊息。
2. 備份為 `.lat/tasks.yaml.bad`（已存在則用時間戳命名，如 `.lat/tasks.yaml.20260520T120000Z.bad`）。
3. 重建 `tasks.yaml` 內容為 `[]`。
4. 正常退出，讓使用者檢查壞檔。

### results.yaml 解析失敗

1. 輸出警告。
2. 備份為 `.lat/results.yaml.bad`（已存在則用時間戳命名）。
3. 建立新 `results.yaml`，僅含當前結果。
4. 安全時繼續處理。

## 狀態摘要規則

| 狀態 | 來源 |
|------|------|
| `pending` | `tasks.yaml` 中的任務 |
| `completed` | `results.yaml` 中 `status: completed` |
| `failed` | `results.yaml` 中 `status: failed` |
| `partial` | `results.yaml` 中 `status: partial` |
| `running` | `zmx list` 中匹配的 `cx-` 或 `cc-` 工作階段 |

## 欄位順序

任務：`task_id` → `goal` → `context` → `constraints` → `created_by` → `created_at`

結果：`task_id` → `goal` → `status` → `summary` → `outputs` → `errors` → `completed_at`
