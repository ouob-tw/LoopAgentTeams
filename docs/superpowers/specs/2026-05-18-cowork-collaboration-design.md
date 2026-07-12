# CoWork：Claude Code + Codex CLI 協作系統

> **歷史文件：** 本文件記錄 2026-05-18 的舊 `.cowork` 設計，已被現行 `lat-dispatch`／`lat-runner` 的 `.lat/workspace/<TASK_ID>/` 永久 ledger 契約取代，不得作為目前執行依據。

## 概述

Claude Code 與 Codex CLI 之間的兩階段協作系統。第一階段（內部）：Claude Code 撰寫 spec/plan，並使用 Codex plugin 反覆審核直到無錯誤。第二階段（外部）：將確認過的執行任務派發到 YAML 佇列，由獨立的 Codex CLI 執行。

## 目標

- Claude Code 負責規劃 + 審核（透過 Codex plugin 審核，省去手動操作）
- Codex CLI 負責程式碼執行（使用獨立的 OpenAI 額度，節省 Claude $20 預算）
- YAML 任務佇列僅用於執行交接 — 審核在 Claude Code 內部完成
- 透過 zmx 持久化 session 啟動 Codex CLI，使用者可隨時 attach 查看進度

## 架構

### 原始碼結構（本 repo）

遵循 [agentskills.io/specification](https://agentskills.io/specification) 規範。

```
coWorkCLIAgent/
├── cowork-dispatch/                    # Claude Code skill
│   └── SKILL.md
├── cowork-runner/                      # Codex skill
│   ├── SKILL.md
│   └── references/
│       └── yaml-schema.md             # YAML schema 詳細文件
└── docs/
    └── superpowers/
        ├── specs/                      # 設計規格
        └── plans/                      # 實作計劃
```

### 安裝後路徑

透過 `npx skills add` 安裝後：
- Claude Code：`~/.claude/skills/cowork-dispatch/`
- Codex：`~/.agents/skills/cowork-runner/`

Skill 內部使用**相對路徑**引用自身檔案（agent 自動解析）。

### 專案執行時資料

由 `cowork-dispatch init` 在使用者的專案目錄下建立：

```
<project-root>/.cowork/
├── tasks.yaml                          # 執行任務佇列
└── results.yaml                        # 執行結果（最新在最上面）
```

### 外部工具依賴

| 工具 | 用途 | 安裝 |
|------|------|------|
| `zmx` | 持久化 terminal session，背景執行 Codex CLI | `brew install neurosnap/tap/zmx` |
| `codex` | OpenAI Codex CLI，執行程式碼任務 | 已安裝 |
| `codex-multi-auth` | 管理多個 OpenAI 帳號，額度不足時切換 | 已安裝 |

## 兩種 Codex 使用方式

| | 審核（內部） | 執行（外部） |
|---|---|---|
| **觸發方式** | Claude Code 自動呼叫 Codex plugin | Claude Code 透過 zmx 啟動 Codex CLI |
| **Codex 形式** | Plugin（在 Claude Code session 內） | 獨立 Codex CLI（zmx session 中） |
| **使用 YAML？** | 否 — 直接 plugin 呼叫 | 是 — tasks.yaml / results.yaml |
| **用途** | 審核 spec/plan 直到無錯誤 | 執行程式碼實作 |

## 協作流程

cowork-dispatch skill 提供兩個獨立功能：

### 功能一：Spec & Plan 撰寫（內部，Claude Code session 內）

前置條件：先載入 Superpowers skills（brainstorming、writing-plans）。

```
  Claude Code 使用 Superpowers skills 撰寫 spec 初稿
      │
      ▼
  呼叫 Codex plugin 審核 spec
      │
      ├─ 小問題 → Codex plugin 直接修正（不重新審核）
      ├─ 大問題 → 回報給 Claude Code
      │              │
      │              ▼
      │          Claude Code 修正 → 重新提交 Codex 審核（循環）
      └─ 通過
      │
      ▼
  呼叫 Codex plugin 撰寫實作計劃（implementation plan）
      │
      ▼
  Claude Code 審核計劃（比對是否符合 spec 意圖）
      │
      ├─ 有問題 → Claude Code 回報給 Codex → Codex 修正 → Claude Code 再審（循環）
      └─ 通過
      │
      ▼
  Spec 和 Plan 完成
      │
      ▼
  Claude Code 提交 git commit（遵循 Conventional Commits）
  可進入功能二派發任務
```

**Commit 規則：** Spec 和 Plan 皆審核通過後，Claude Code 將兩份文件一起提交一個 git commit，遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式：
- `docs: add <feature-name> spec and implementation plan`

**原則：交叉審核，不自己審自己。重活（撰寫）給 Codex，輕活（審核）給 Claude。**

**角色分工：**
- **Claude Code**：撰寫 spec 初稿、修正 spec 大問題、審核 plan
- **Codex plugin**：審核 spec（小問題直接修）、撰寫 plan、依 Claude 回饋修正 plan

### 功能二：任務派發與執行（透過 zmx session）

使用 [zmx](https://github.com/neurosnap/zmx) 建立持久化 terminal session，Claude Code 直接啟動 Codex，使用者可隨時 attach 查看進度。

**Session 命名規則：** `cx-<簡短英文任務名>`，例如 `cx-user-api`、`cx-auth-module`。

```
  Claude Code dispatch
      │
      ├─ 1. 寫入 tasks.yaml
      ├─ 2. zmx list → 檢查 cx-<name> 是否已存在（重複則報錯）
      ├─ 3. zmx run cx-<name> "cd $PROJECT_DIR && codex --approval-mode full-auto '...'"
      │
      ▼
  固定 sleep 180
      │
      ▼
  健康檢查：zmx history cx-<name> | tail -20
      │
      ├─ 正常運行 → 回報使用者「Codex 已在 cx-<name> 中執行」
      │
      ├─ 顯示 503 錯誤
      │     → zmx send cx-<name> "GO"
      │     → 回報使用者「遇到 503，已重試」
      │
      └─ 帳號額度不足
            → codex-multi-auth check
            → codex-multi-auth switch <有額度的帳號編號>
            → zmx send cx-<name> "GO"
            → 回報使用者「已切換帳號並重試」
```

**使用者可隨時操作：**
- `zmx attach cx-<name>` — 即時查看 Codex 執行過程
- `zmx history cx-<name>` — 查看輸出歷史
- `zmx list` — 列出所有進行中的 session
- `Ctrl+\` — 從 session 中 detach（不會終止 Codex）

## YAML Schema

### tasks.yaml

執行任務的 YAML 列表。Codex 從上到下處理。

**標準空狀態：** 檔案內容為 `[]`（空陣列）。檔案不存在或內容為空字串也視為無任務。

```yaml
- task_id: "task-1747536000000-a3f"
  goal: "在 src/models/user.py 使用 SQLAlchemy 實作 User model"
  context:                     # 選填
    plan_file: "docs/plans/2026-05-18-user-api-plan.md"  # 字串，相對於專案根目錄的路徑
    related_files:             # 字串列表，相對於專案根目錄的路徑
      - "src/models/"
      - "src/db.py"
  constraints:                 # 選填，字串列表
    - "遵循 FastAPI 慣例"
    - "使用 async SQLAlchemy"
  created_by: claude-code      # claude-code | codex
  created_at: "2026-05-18T10:00:00Z"
```

欄位說明：

| 欄位 | 必填 | 型別 | 說明 |
|------|------|------|------|
| `task_id` | 是 | string | `task-{unix_ms}-{random_hex_3}` 格式（毫秒時間戳 + 3 位隨機 hex），唯一值 |
| `goal` | 是 | string | 要實作的內容（來自核准的計劃） |
| `context` | 否 | object | `plan_file`（string）、`related_files`（string[]）— 相對於專案根目錄的路徑 |
| `constraints` | 否 | string[] | Codex 實作時必須遵守的規則 |
| `created_by` | 是 | string | `claude-code`：由 dispatch skill 建立；`codex`：由 runner 拆解子任務時建立 |
| `created_at` | 是 | string | ISO 8601 時間戳記 |

### results.yaml

YAML 列表。最新結果插入頂部。

**標準空狀態：** 檔案內容為 `[]`（空陣列）。

```yaml
- task_id: "task-1747536000000-a3f"
  goal: "在 src/models/user.py 使用 SQLAlchemy 實作 User model"
  status: completed            # completed | failed | partial
  summary: "建立 User model，包含 id、email、name、created_at 欄位"
  outputs:                     # 選填 — 建立或修改的檔案
    - "src/models/user.py"
  errors: []                   # 失敗時填入，見下方格式
  completed_at: "2026-05-18T10:05:00Z"

# --- 更早的結果在下方 ---
```

欄位說明：

| 欄位 | 必填 | 型別 | 說明 |
|------|------|------|------|
| `task_id` | 是 | string | 與原始任務的 `task_id` 相同 |
| `goal` | 是 | string | 從原始任務複製 |
| `status` | 是 | string | `completed`、`failed` 或 `partial` |
| `summary` | 是 | string | 完成了什麼 |
| `outputs` | 否 | string[] | 建立或修改的檔案路徑 |
| `errors` | 否 | object[] | 格式：`[{code: "string", message: "string"}]` |
| `completed_at` | 是 | string | ISO 8601 時間戳記 |

## YAML 錯誤處理

### tasks.yaml

| 情境 | 行為 |
|------|------|
| 檔案不存在 | 視為空佇列，不報錯 |
| 檔案內容為空字串 | 視為空佇列，不報錯 |
| 檔案內容為 `[]` | 標準空狀態，不報錯 |
| YAML 解析失敗 | 輸出錯誤訊息，備份為 `tasks.yaml.bad`，建立空的 `tasks.yaml`（`[]`），等待使用者處理 |

### results.yaml

| 情境 | 行為 |
|------|------|
| 檔案不存在 | 建立新檔，內容為 `[]` |
| 檔案內容為空字串 | 視為 `[]`，正常寫入 |
| 檔案內容為 `[]` | 正常寫入 |
| YAML 解析失敗（寫入結果時） | 備份為 `results.yaml.bad`，建立新的 `results.yaml` 僅包含本次結果，輸出警告 |

## 失敗處理策略

**不自動重試。** 失敗的任務直接寫入 results.yaml 並從 tasks.yaml 移除。使用者檢視 results.yaml 後自行決定是否透過 cowork-dispatch 重新派發。

## Skill 職責

### cowork-dispatch（Claude Code）

提供兩個功能：Spec/Plan 撰寫流程 + 任務派發。

**功能一指令（Spec & Plan）：**

| 指令 | 動作 |
|------|------|
| init | 建立 `.cowork/` 目錄，含空的 tasks.yaml 和 results.yaml |
| spec | 載入 Superpowers skills → Claude Code 撰寫 spec 初稿 → 提交 Codex plugin 審核 |
| plan | spec 通過後 → Codex plugin 撰寫 plan → Claude Code 審核 plan |

**Spec 審核（Codex 審 Claude 的 spec）：**
- 小問題（錯字、缺欄位、不一致）→ Codex plugin 直接修正（不重新審核）
- 大問題（設計方向、缺需求、架構疑慮）→ 回報給 Claude Code → Claude Code 修正後重新提交 Codex 審核
- 全部通過 → 進入 `plan`

**Plan 審核（Claude 審 Codex 的 plan）：**
- 有問題 → Claude Code 回報給 Codex → Codex 修正 → Claude Code 再審
- 通過 → 可進入 `dispatch`

**功能二指令（任務派發）：**

| 指令 | 動作 |
|------|------|
| dispatch | 從核准的 plan 產出執行任務寫入 tasks.yaml → 透過 zmx 啟動 Codex CLI session → 固定 `sleep 180` 後健康檢查 |
| status | 顯示 tasks.yaml + results.yaml 摘要，以及 `zmx list` session 狀態 |
| clean | 清空 results.yaml |

### cowork-runner（Codex CLI）

從 YAML 佇列讀取並執行任務。在 zmx session 中由 Codex CLI 自動執行。

- 讀取 tasks.yaml
- 從上到下處理任務，依複雜度選擇執行方式：
  - **簡單任務**（單一檔案、明確目標）→ Codex 直接執行
  - **複雜任務**（跨多檔案、需要多步驟）→ Codex 生成 sub-agent 分工執行
- 每個任務完成後：
  1. 將結果插入 results.yaml 頂部
  2. 從 tasks.yaml 移除該任務
- 失敗時：插入 `status: failed` 和 `errors` 的結果，仍從 tasks.yaml 移除
- 可追加新的執行子任務到 tasks.yaml（如拆解大任務時，`created_by: codex`）
- 全部完成後正常退出

## 規則

1. **審核在內部完成** — spec/plan 審核透過 Codex plugin 在 Claude Code 內進行，不經過 tasks.yaml
2. **tasks.yaml 僅限執行任務** — 只有執行任務，沒有審核任務
3. **`task_id` 格式** — `task-{unix_ms}-{random_hex_3}` 毫秒時間戳 + 隨機值避免衝突
4. **results.yaml 只在頂部插入** — 最新在上，完整歷史保留到手動清空
5. **派發完成判定** — dispatch 後續監控必須解析 `.cowork/results.yaml`，只有第一個 YAML list item 是 dict 且 `task_id` 等於本次派發任務的 `task_id` 時，才表示 Codex 已完成該任務
6. **完成即移除任務** — Codex 完成任務後從 tasks.yaml 移除，不論成功或失敗
7. **不自動重試** — 失敗任務由使用者決定是否重新派發
8. **zmx session 命名** — `cx-<簡短英文任務名>`，dispatch 前先 `zmx list` 檢查不重複
9. **健康檢查一次** — dispatch 後執行固定 `sleep 180`，再用 `zmx history cx-<name> | tail -20` 檢查一次；不得解析 `zmx list created=`、`date +%s`、`created_at` 或 `completed_at` 來計算等待時間。503 則 `zmx send cx-<name> "GO"`，額度不足則 `codex-multi-auth check` 後 `codex-multi-auth switch`
10. **Conventional Commits** — spec + plan 完成後一起提交：`docs: add <feature-name> spec and implementation plan`
