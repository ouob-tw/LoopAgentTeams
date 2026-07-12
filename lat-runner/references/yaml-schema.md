# LAT YAML 結構定義

`.lat/workspace/<TASK_ID>/tasks.yaml` 與 `results.yaml` 的完整結構、生命週期、原子寫入、錯誤處理與舊格式遷移規則。

## 目錄與安全規則

每個 `TASK_ID` 使用獨立且永久保留的 ledger。Spec 草稿完成並確定 Spec 檔名後，LAT Dispatch Agent 在 spec phase、reviewer 啟動前，以該檔名（不含 `.md`）初始化 task workspace；進入 dispatch phase 時只驗證既有 ledger 並附加第一筆 code task，不重設內容：

```text
.lat/workspace/<TASK_ID>/
├── tasks.yaml
├── results.yaml
├── qa-results.md
└── prompts/
```

`TASK_ID` 只允許 `[A-Za-z0-9._-]+`，且不得為 `.` 或 `..`。驗證失敗時不得組合路徑或建立目錄。

新 workspace 的 `tasks.yaml` 與 `results.yaml` 初始內容為 `[]`，並建立 `prompts/`。若目錄已存在，須解析兩個 ledger 並保留所有歷史；不得以初始化為由清空、覆寫或重建。

目錄內每筆 `task_id` 必須等於目錄名稱；`agent_id` 在 tasks ledger 中唯一，且其 phase 前綴必須等於 `phase`。results ledger 的 `task_id + agent_id` 必須唯一。

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

YAML 列表，永久保存同一 TASK_ID 各 phase／round 的生命週期紀錄。完成後更新 status，不刪除項目。

```yaml
- task_id: "2026-05-18-user-api-spec"
  agent_id: "code_executor_1_2026-05-18-user-api-spec"
  phase: code_executor
  status: pending
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
  started_at: null
  completed_at: null
```

### 欄位定義

| 欄位 | 必填 | 類型 | 說明 |
|------|:----:|------|------|
| `task_id` | 是 | string | Spec 檔名（不含 `.md`），整輪 teamwork 共用 |
| `agent_id` | 是 | string | Executor 識別碼 |
| `phase` | 是 | string | `code_executor`、`test_executor`、`qa_executor` |
| `status` | 是 | string | `pending`、`running`、`completed`、`partial`、`failed` |
| `goal` | 是 | string | 實作目標 |
| `context` | 否 | object | 執行輔助資訊 |
| `context.plan_file` | 否 | string | 專案根目錄相對路徑，指向已核准計劃 |
| `context.spec_file` | 否 | string | 專案根目錄相對路徑，指向已核准規格 |
| `context.related_files` | 否 | string[] | 相關檔案或目錄 |
| `constraints` | 否 | string[] | 實作約束 |
| `created_by` | 是 | string | 建立此任務的 agent 識別名稱 |
| `created_at` | 是 | ISO 8601 | 建立時間 |
| `started_at` | 是 | ISO 8601 或 null | 首次開始時間；resume 不覆寫 |
| `completed_at` | 是 | ISO 8601 或 null | 最終狀態寫入時間 |

### 狀態轉換

```text
pending -> running -> completed
                   -> partial
                   -> failed
```

- `partial`、`failed`、`completed` 都是該 agent round 的最終狀態，不直接轉回 `running`。
- 重試須新增下一 round 的 `agent_id`，保留舊紀錄。
- `running` 且沒有 result 表示可 resume 的中斷工作。

## results.yaml

YAML 列表，最新結果置頂。所有 executor 完成時以 `task_id + agent_id` upsert；已存在時替換原項，不新增重複紀錄。

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
- 新建 task directory 時，兩個 ledger 初始內容都是 `[]`。
- Runner 執行時，任一 ledger 遺失或空字串都視為狀態損壞，非零退出；不得自行重建。
- `lat-dispatch init/status` 掃描不存在的 task directory 時可視為沒有任務。

## 原子寫入與 reconciliation

每次修改單一 ledger：

1. 讀取並解析目前檔案。
2. 以精確 `task_id + agent_id` 更新記憶體中的項目。
3. 在同目錄寫入暫存檔。
4. 重新解析暫存檔並驗證必填欄位、唯一鍵及狀態。
5. 以 `mv` 原子替換目標檔。

完成順序固定為：

1. upsert `results.yaml`。
2. 更新 `tasks.yaml` 的最終 status。

若中斷後 task 仍為 `running`，但已有精確匹配的 `completed` result，Runner 只把 task reconciliation 為 `completed`，不得重做實作。partial／failed result 不自動重跑，由 Dispatch 新增下一 round。

## 解析錯誤處理

### tasks.yaml 解析失敗

1. 輸出錯誤訊息。
2. 在相同 task directory 備份為 `tasks.yaml.bad`（已存在則用時間戳命名，如 `tasks.yaml.20260520T120000Z.bad`）。
3. 保留原始 `tasks.yaml` 不變，不建立替代 queue。
4. 以非零 exit code 結束，讓 Dispatch 暫停並要求人工處理。

### results.yaml 解析失敗

1. 輸出警告。
2. 在相同 task directory 備份為 `results.yaml.bad`（已存在則用時間戳命名）。
3. 保留原始 `results.yaml` 不變，不遺失舊結果。
4. 以非零 exit code 結束；不得在無法驗證舊結果時繼續。

備份是保留副本，不得用 destructive move 取代主要檔案。若需移除錯誤產物，使用 `trash-put`。

## 狀態摘要規則

| 狀態 | 來源 |
|------|------|
| `pending` / `running` | `tasks.yaml.status` |
| `completed` / `failed` / `partial` | tasks 與 results 的精確匹配 status；不一致時視為需 reconciliation |

`zmx list` 只提供程序診斷，不是 ledger status 的來源。

## 舊全域格式遷移

若存在 `.lat/tasks.yaml` 或 `.lat/results.yaml`：

1. 解析兩個舊檔；任一檔解析失敗即停止，不修改來源。
2. 收集兩檔所有 `task_id`，逐一驗證安全 slug。
3. 按 `task_id` 分組，寫入 `.lat/workspace/<TASK_ID>/tasks.yaml` 與 `results.yaml` 暫存檔。
4. 舊 task 必須已有唯一的 `agent_id`；由其 `<phase>_<round>_<task_id>` 格式解析 `phase`，且 task_id 尾段必須與該筆 `task_id` 完全相同。缺少 `agent_id`、格式無法唯一解析或重複時停止遷移，不猜測或生成識別碼。
5. 舊 task 沒有 status 時：有精確 `task_id + agent_id` result 就使用 result status，否則設為 `pending`；補上 `started_at`、`completed_at`。
6. 驗證每個來源 task／result 在對應的新 ledger 中恰好出現一次；新 tasks 總筆數須等於舊 tasks，新 results 總筆數須等於舊 results，兩者不要求彼此相等。
7. 寫入 `.lat/migration-report.md`，列出來源筆數、各 TASK_ID 筆數與驗證結果。
8. 所有驗證通過後，以 `trash-put` 移除舊全域檔案；任一步失敗都保留舊檔。

## 欄位順序

任務：`task_id` → `agent_id` → `phase` → `status` → `goal` → `context` → `constraints` → `created_by` → `created_at` → `started_at` → `completed_at`

結果：`task_id` → `agent_id` → `goal` → `status` → `summary` → `outputs` → `errors` → `completed_at`
