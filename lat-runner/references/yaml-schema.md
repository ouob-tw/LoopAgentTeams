# LAT YAML 結構定義

`.lat/tasks.yaml` 與 `.lat/results.yaml` 的完整結構、錯誤處理規則與狀態摘要。

## 識別碼

| 名稱 | 說明 | 範例 |
|------|------|------|
| `task_id` | Spec 檔名（不含 `.md`），整輪 teamwork 的共用識別碼 | `2026-05-18-user-api-spec` |
| `agent_id` | `<phase>_<round>_<task_id>`，兼作 session 名稱供 TUI 恢復用 | `code_executor_1_2026-05-18-user-api-spec` |

一個 `task_id` 下會有多筆不同 `agent_id` 的紀錄，代表同一輪 teamwork 中各階段 executor 的產出。

### agent_id 命名規則

格式：`<phase>_<round>_<task_id>`。phase 對應 config 名稱，round 固定帶（從 1 起算）。

| 階段 | agent_id | 重試 |
|------|----------|------|
| code_executor | `code_executor_1_<task_id>` | `code_executor_2_<task_id>` |
| test_executor | `test_executor_1_<task_id>` | `test_executor_2_<task_id>` |
| qa_executor | `qa_executor_1_<task_id>` | `qa_executor_2_<task_id>` |

## tasks.yaml

YAML 列表，包含已核准的實作任務。Runner 由上而下處理。

```yaml
- task_id: "2026-05-18-user-api-spec"
  agent_id: "code_executor_1_2026-05-18-user-api-spec"
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
| `task_id` | 是 | string | Spec 檔名（不含 `.md`），整輪 teamwork 共用 |
| `agent_id` | 是 | string | Executor 識別碼 |
| `goal` | 是 | string | 實作目標 |
| `context` | 否 | object | 執行輔助資訊 |
| `context.plan_file` | 否 | string | 專案根目錄相對路徑，指向已核准計劃 |
| `context.spec_file` | 否 | string | 專案根目錄相對路徑，指向已核准規格 |
| `context.related_files` | 否 | string[] | 相關檔案或目錄 |
| `constraints` | 否 | string[] | 實作約束 |
| `created_by` | 是 | string | 建立此任務的 agent 識別名稱 |
| `created_at` | 是 | ISO 8601 | 建立時間 |

## results.yaml

YAML 列表，最新結果置頂。所有階段的 executor（code、test、qa）完成時都寫入此檔。

```yaml
- task_id: "2026-05-18-user-api-spec"
  agent_id: "qa_executor_1_2026-05-18-user-api-spec"
  goal: "驗收 User API 功能"
  status: completed
  summary: "全部驗收項 PASS"
  outputs:
    - "tests/qa_e2e/test_user_api.py"
  errors: []
  completed_at: "2026-05-18T10:20:00Z"

- task_id: "2026-05-18-user-api-spec"
  agent_id: "test_executor_1_2026-05-18-user-api-spec"
  goal: "整合與 E2E 測試 User API"
  status: completed
  summary: "12 項測試全數通過，無回歸"
  outputs:
    - "tests/e2e/test_user_api.py"
  errors: []
  completed_at: "2026-05-18T10:15:00Z"

- task_id: "2026-05-18-user-api-spec"
  agent_id: "code_executor_1_2026-05-18-user-api-spec"
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
| `task_id` | 是 | string | Spec 檔名（不含 `.md`），對應整輪 teamwork |
| `agent_id` | 是 | string | 產出此結果的 executor 識別碼 |
| `goal` | 是 | string | 該 executor 的執行目標 |
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

任務：`task_id` → `agent_id` → `goal` → `context` → `constraints` → `created_by` → `created_at`

結果：`task_id` → `agent_id` → `goal` → `status` → `summary` → `outputs` → `errors` → `completed_at`
