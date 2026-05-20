# CoWork 協作系統 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目標：** 建立符合 agentskills.io 規格的 `cowork-dispatch` 與 `cowork-runner` 兩個 skill，讓 Claude Code 負責規劃、審核、派發與啟動外部 Codex CLI session，Codex CLI 負責從 YAML 佇列執行任務並寫回結果。

**架構：** `cowork-dispatch` 是 Claude Code 使用的派發 skill，處理初始化、spec/plan 流程、任務派發、`zmx` session 啟動、健康檢查、狀態查詢與清理。`cowork-runner` 是 Codex CLI 使用的執行 skill，在 `zmx` session 中讀取 `.cowork/tasks.yaml`，執行任務後寫入 `.cowork/results.yaml` 並移除已處理任務。詳細 YAML 欄位與錯誤處理放在 `references/yaml-schema.md`，讓 `SKILL.md` 維持短小並符合漸進揭露原則。

**技術棧：** Markdown、agentskills.io `SKILL.md` 格式、YAML、Codex CLI、Claude Code、Superpowers skills、`zmx`、`codex-multi-auth`。

---

## 全域規範

1. 所有 skill 目錄必須遵循 agentskills.io：每個 skill 根目錄至少包含 `SKILL.md`，`SKILL.md` 以 YAML frontmatter 開頭，接著是 Markdown 指令本文。
2. `name` 欄位必須與父目錄相同，只能使用小寫英文字母、數字與 hyphen，不能以 hyphen 開頭或結尾，不能有連續 hyphen。
3. `description` 欄位必須以 `Use when...` 開頭，並說明 skill 做什麼、何時使用，包含容易被代理辨識的關鍵字。
4. `references/` 只放需要時才讀取的詳細文件；若未使用腳本，不建立 `scripts/`。
5. `SKILL.md` 必須使用相對路徑引用同 skill 內檔案，例如 `references/yaml-schema.md`；不得使用 `${CLAUDE_SKILL_DIR}`。
6. 兩個 `SKILL.md` 都必須明確低於 500 行；詳細 schema、錯誤案例與範例移到 reference，避免主 skill 過長。
7. 不使用 YAML 佇列做 spec/plan 審核；YAML 佇列只用於外部 Codex CLI 執行任務。
8. 外部 Codex CLI 必須透過 `zmx` 持久化 session 啟動，session 名稱格式為 `cx-<簡短英文任務名>`。
9. `cowork-dispatch` 啟動外部 session 前必須使用 `zmx list` 檢查同名 session。
10. `cowork-dispatch` 啟動外部 session 後必須等待 3 分鐘並檢查 `zmx history`，處理 503 重送與帳號額度不足切換。
11. `.cowork/tasks.yaml` 的 task 欄位只包含 `id`、`goal`、`context`、`constraints`、`created_by`、`created_at`。
12. `.cowork/results.yaml` 的 result 欄位包含 `task_id`、`goal`、`status`、`summary`、`outputs`、`errors`、`completed_at`。

---

## 檔案結構

本計畫只要求建立下列三個產物：

```text
cowork-dispatch/
└── SKILL.md

cowork-runner/
├── SKILL.md
└── references/
    └── yaml-schema.md
```

---

### 任務 1：建立 Claude Code 派發 skill

**檔案：**
- 建立：`cowork-dispatch/SKILL.md`

**內容說明：**

此檔案定義 Claude Code 端的工作流程，必須是完整的 agentskills.io skill。內容應包含：

1. YAML frontmatter：

```yaml
---
name: cowork-dispatch
description: Use when coordinating CoWork collaboration from Claude Code: creating or reviewing specs and implementation plans, initializing .cowork queues, dispatching approved execution tasks through zmx, checking cowork status, or cleaning results.
compatibility: Designed for Claude Code. Requires git, zmx, codex, codex-multi-auth, and a project workspace with shell access.
---
```

2. 啟用條件：
   - 使用者要求 CoWork、Claude Code + Codex CLI 協作、任務派發、`.cowork` 初始化、查看佇列、清理結果時使用。
   - 使用者要求撰寫 spec 或 plan 並希望由 Codex plugin 審核時使用。
   - 使用者要求啟動外部 Codex CLI 執行核准計畫時使用。

3. 角色邊界：
   - Claude Code 負責 spec 初稿、修正 spec 大問題、審核 Codex 產出的 plan、派發已核准任務。
   - Codex plugin 只用於 Claude Code session 內部審核 spec 與撰寫 plan。
   - 外部 Codex CLI 只處理 `.cowork/tasks.yaml` 的執行任務。
   - `tasks.yaml` 不得放入 spec 審核任務或 plan 審核任務。

4. 指令工作流：
   - `init`：建立 `.cowork/`、`.cowork/tasks.yaml`、`.cowork/results.yaml`，空檔案內容使用 `[]`。
   - `spec`：先載入 Superpowers brainstorming 與 writing-plans 相關流程；Claude Code 撰寫 spec 初稿；呼叫 Codex plugin 審核；小問題可由 Codex plugin 直接修；大問題由 Claude Code 修後重新審核。
   - `plan`：spec 通過後，呼叫 Codex plugin 產出 implementation plan；Claude Code 比對 spec 審核 plan；有問題則回饋 Codex 修正；通過後與 spec 一起提交 commit。
   - `dispatch`：從已核准 plan 產出執行任務；寫入 `.cowork/tasks.yaml`；使用 `zmx list` 檢查同名 session；使用 `zmx run` 啟動外部 Codex CLI；等待 3 分鐘後做健康檢查。
   - `status`：讀取 `.cowork/tasks.yaml` 與 `.cowork/results.yaml`；顯示待處理、已完成、失敗、部分完成摘要；附上 `zmx list` 中 `cx-` session 狀態。
   - `clean`：將 `.cowork/results.yaml` 重設為 `[]`。

5. 任務產生規則：
   - 任務 ID 格式為 `task-{unix_ms}-{random_hex_3}`。
   - 每個任務包含 `id`、`goal`、`context`、`constraints`、`created_by: claude-code`、`created_at`。
   - `context.plan_file` 與 `context.related_files` 使用專案根目錄相對路徑。
   - `constraints` 必須保留 plan 中的實作限制與使用者限制。
   - 寫入前若 `.cowork/tasks.yaml` 不存在、空字串或 `[]`，視為空佇列。
   - 若 `.cowork/tasks.yaml` YAML 解析失敗，備份為 `tasks.yaml.bad`，建立新的 `tasks.yaml` 內容 `[]`，並回報使用者。

6. `zmx` 外部執行規則：
   - session 名稱使用 `cx-<簡短英文任務名>`，例如 `cx-user-api` 或 `cx-auth-module`。
   - 啟動前執行 `zmx list`，若同名 session 已存在，停止並回報使用者，不覆蓋既有 session。
   - 啟動命令格式：

```bash
zmx run cx-<name> "cd \"$PROJECT_DIR\" && codex --approval-mode full-auto 'You are the cowork-runner. Read .cowork/tasks.yaml, execute all pending implementation tasks following the cowork-runner skill, write .cowork/results.yaml, remove completed tasks, then exit.'"
```

   - 啟動後等待 3 分鐘，再執行 `zmx history cx-<name> | tail -20` 做健康檢查。
   - 若 history 顯示 503 類型錯誤，執行 `zmx send cx-<name> "GO"`，並回報「遇到 503，已重試」。
   - 若 history 顯示帳號額度不足，執行 `codex-multi-auth check`，找出有額度帳號後執行 `codex-multi-auth switch <帳號編號>`，再執行 `zmx send cx-<name> "GO"`，並回報「已切換帳號並重試」。
   - 若無法找到有額度帳號，回報使用者需要手動處理，不得刪除 `.cowork/tasks.yaml` 中已派發任務。

7. 使用者可見操作：
   - 告知使用者可用 `zmx attach cx-<name>` 查看即時進度。
   - 告知使用者可用 `zmx history cx-<name>` 查看輸出歷史。
   - 告知使用者可用 `zmx list` 查看所有 session。
   - 告知使用者在 attach 後可用 `Ctrl+\` detach，不會終止 Codex。

8. git commit 規則：
   - spec 與 plan 都通過審核後，Claude Code 建立一個 Conventional Commits commit。
   - commit message 格式：`docs: add <feature-name> spec and implementation plan`。

**實作步驟：**

- [ ] 建立 `cowork-dispatch/` 目錄。
- [ ] 建立 `cowork-dispatch/SKILL.md`，加入上述 frontmatter。
- [ ] 寫入「何時使用」章節，明確列出 CoWork、dispatch、status、clean、spec、plan 等觸發情境。
- [ ] 寫入「角色分工」章節，禁止將審核任務寫入 YAML。
- [ ] 寫入 `init`、`spec`、`plan`、`dispatch`、`status`、`clean` 六個工作流，每個工作流都用有序步驟描述。
- [ ] 寫入任務 ID 與 task 欄位產生規則。
- [ ] 寫入 `.cowork/tasks.yaml` 讀取、空狀態與壞檔備份規則。
- [ ] 寫入 `dispatch` 的 `zmx list` 重名檢查、`zmx run` 啟動、3 分鐘後 `zmx history` 健康檢查。
- [ ] 寫入 503 錯誤時使用 `zmx send cx-<name> "GO"` 重送。
- [ ] 寫入帳號額度不足時使用 `codex-multi-auth check` 與 `codex-multi-auth switch <帳號編號>` 後重送。
- [ ] 寫入 `zmx attach`、`zmx history`、`zmx list` 與 `Ctrl+\` detach 的使用者提示。
- [ ] 檢查檔案低於 500 行。

**驗收標準：**

- `cowork-dispatch/SKILL.md` 存在，且第一段是有效 YAML frontmatter。
- frontmatter 的 `name` 等於 `cowork-dispatch`，符合 agentskills.io 命名規則。
- `description` 以 `Use when` 開頭，並同時描述能力與使用時機。
- 本文包含 `init`、`spec`、`plan`、`dispatch`、`status`、`clean` 六個指令。
- 本文明確寫出 `tasks.yaml` 僅限執行任務，不用於 spec/plan 審核。
- 本文明確寫出 `zmx` session 命名規則 `cx-<簡短英文任務名>`。
- 本文明確寫出啟動前需用 `zmx list` 檢查同名 session。
- 本文明確寫出使用 `zmx run` 啟動 `codex --approval-mode full-auto`，並在啟動後等待 3 分鐘檢查 `zmx history`。
- 本文明確寫出 503 錯誤時使用 `zmx send cx-<name> "GO"` 重試。
- 本文明確寫出帳號額度不足時使用 `codex-multi-auth check` 與 `codex-multi-auth switch <帳號編號>` 後重試。
- 本文明確寫出使用者可用 `zmx attach`、`zmx history`、`zmx list` 檢查外部 session。
- 本文明確寫出 `SKILL.md` 必須低於 500 行。
- `wc -l cowork-dispatch/SKILL.md` 顯示行數小於 500。

---

### 任務 2：建立 Codex CLI 執行 skill

**檔案：**
- 建立：`cowork-runner/SKILL.md`

**內容說明：**

此檔案定義 Codex CLI 端執行 YAML 佇列的行為。內容應保持精簡，詳細 schema 與錯誤案例引用 `references/yaml-schema.md`。

1. YAML frontmatter：

```yaml
---
name: cowork-runner
description: Use when executing CoWork queued implementation tasks from .cowork/tasks.yaml with Codex CLI, updating results.yaml, creating follow-up tasks, or running inside a zmx session started by cowork-dispatch.
compatibility: Designed for Codex CLI. Requires shell access and a project workspace containing .cowork/.
---
```

2. 啟用條件：
   - `cowork-dispatch` 透過 `zmx run` 啟動 Codex CLI 並要求執行 `.cowork/tasks.yaml`。
   - prompt 中提到 `cowork-runner`、`.cowork/tasks.yaml`、`.cowork/results.yaml` 或 CoWork queued tasks。

3. 執行邊界：
   - runner 不建立背景常駐程序；完成目前佇列中的任務後正常退出。
   - runner 不處理 spec/plan 審核；只處理已核准的執行任務。

4. 任務執行策略：
   - 依任務複雜度選擇執行方式：
     - **簡單任務**（單一檔案、明確目標）→ Codex 直接執行。
     - **複雜任務**（跨多檔案、需要多步驟）→ Codex 生成 sub-agent 分工執行。
   - 複雜度判斷依據：`goal` 涉及的檔案數量、`context.related_files` 範圍、`constraints` 的多寡。

5. 任務處理流程：
   - 讀取專案根目錄 `.cowork/tasks.yaml`。
   - 若檔案不存在、空字串或 `[]`，視為無任務並正常退出。
   - 若 YAML 解析失敗，輸出錯誤訊息，備份為 `tasks.yaml.bad`，建立新的 `tasks.yaml` 內容 `[]`，並正常退出等待使用者處理。
   - 從上到下處理任務。
   - 根據 `goal`、`context.plan_file`、`context.related_files`、`constraints` 實作。
   - 成功時在 `.cowork/results.yaml` 頂部插入 `status: completed` 結果。
   - 部分完成時插入 `status: partial`，摘要必須說明完成與未完成範圍。
   - 失敗時插入 `status: failed`，`errors` 必須包含 `code` 與 `message`。
   - 不論成功、部分完成或失敗，都從 `.cowork/tasks.yaml` 移除該任務。

6. 子任務規則：
   - 只有在大任務必須拆解且仍可保持可追蹤時，才追加新任務到 `tasks.yaml`。
   - 子任務 `created_by` 必須是 `codex`。
   - 子任務仍使用 `task-{unix_ms}-{random_hex_3}` ID 格式。
   - 子任務不得加入 spec/plan 審核工作。

7. 寫入規則：
   - `results.yaml` 最新結果插入頂部。
   - 空結果檔以 `[]` 表示。
   - `results.yaml` 不存在或空字串時視為 `[]`。
   - `results.yaml` 解析失敗時備份為 `results.yaml.bad`，建立只包含本次結果的新檔，並輸出警告。
   - 寫入 YAML 時保持穩定欄位順序，避免產生不必要的大型 diff。
   - 詳細欄位格式參考 `references/yaml-schema.md`。

8. 完成輸出：
   - 結束前在終端摘要已處理任務數、成功數、部分完成數、失敗數、修改檔案列表。
   - 若沒有任務，輸出「無待處理任務」並以退出碼 `0` 結束。

**實作步驟：**

- [ ] 建立 `cowork-runner/` 目錄。
- [ ] 建立 `cowork-runner/SKILL.md`，加入上述 frontmatter。
- [ ] 寫入「何時使用」章節，列出 `cowork-runner` prompt、`.cowork/tasks.yaml` 與 `zmx` session 觸發條件。
- [ ] 寫入「執行邊界」章節，明確表示 runner 不處理 spec/plan 審核，完成目前任務後退出。
- [ ] 寫入「任務執行策略」章節，說明簡單任務直接執行、複雜任務生成 sub-agent 分工執行。
- [ ] 寫入「任務處理流程」章節，完整描述讀取、執行、寫 results、移除 task 的順序。
- [ ] 寫入成功、失敗、部分完成三種結果格式。
- [ ] 寫入子任務追加規則。
- [ ] 加入相對路徑引用：`See references/yaml-schema.md for the complete YAML schema and error handling rules.`。
- [ ] 檢查檔案低於 500 行。

**驗收標準：**

- `cowork-runner/SKILL.md` 存在，且第一段是有效 YAML frontmatter。
- frontmatter 的 `name` 等於 `cowork-runner`，符合 agentskills.io 命名規則。
- `description` 以 `Use when` 開頭，並同時描述能力與使用時機。
- 本文明確寫出 runner 在 `zmx` session 中由 Codex CLI 執行。
- 本文明確寫出簡單任務直接執行、複雜任務生成 sub-agent 分工執行的策略。
- 本文明確寫出 completed、failed、partial 三種結果。
- 本文明確寫出完成後必須從 `tasks.yaml` 移除任務。
- 本文引用 `references/yaml-schema.md`，且引用使用 skill 根目錄相對路徑。
- 本文明確寫出 `SKILL.md` 必須低於 500 行。
- `wc -l cowork-runner/SKILL.md` 顯示行數小於 500。

---

### 任務 3：建立 YAML schema 與操作參考

**檔案：**
- 建立：`cowork-runner/references/yaml-schema.md`

**內容說明：**

此檔案是 `cowork-runner` 的詳細參考文件，放置完整 schema、範例、錯誤處理與狀態摘要規則。它讓 `cowork-runner/SKILL.md` 能保持低於 500 行。

1. 文件開頭：
   - 標題：`# CoWork YAML Schema`
   - 說明此文件是 `tasks.yaml`、`results.yaml` 與錯誤處理的完整參考。

2. `tasks.yaml` schema：

```yaml
- id: "task-1747536000000-a3f"
  goal: "在 src/models/user.py 使用 SQLAlchemy 實作 User model"
  context:
    plan_file: "docs/plans/2026-05-18-user-api-plan.md"
    related_files:
      - "src/models/"
      - "src/db.py"
  constraints:
    - "遵循 FastAPI 慣例"
    - "使用 async SQLAlchemy"
  created_by: claude-code
  created_at: "2026-05-18T10:00:00Z"
```

3. `tasks.yaml` 欄位表：
   - `id`：必填，string，格式 `task-{unix_ms}-{random_hex_3}`。
   - `goal`：必填，string，執行目標。
   - `context`：選填，object。
   - `context.plan_file`：選填，string，專案相對路徑。
   - `context.related_files`：選填，string array，專案相對路徑。
   - `constraints`：選填，string array。
   - `created_by`：必填，`claude-code` 或 `codex`。
   - `created_at`：必填，ISO 8601 string。

4. `results.yaml` schema：

```yaml
- task_id: "task-1747536000000-a3f"
  goal: "在 src/models/user.py 使用 SQLAlchemy 實作 User model"
  status: completed
  summary: "建立 User model，包含 id、email、name、created_at 欄位"
  outputs:
    - "src/models/user.py"
  errors: []
  completed_at: "2026-05-18T10:05:00Z"
```

5. `results.yaml` 欄位表：
   - `task_id`：必填，string，對應原始任務 ID。
   - `goal`：必填，string，從原始任務複製。
   - `status`：必填，`completed`、`failed` 或 `partial`。
   - `summary`：必填，string。
   - `outputs`：選填，string array。
   - `errors`：選填，object array，每個物件含 `code` 與 `message`。
   - `completed_at`：必填，ISO 8601 string。

6. 空狀態：
   - `tasks.yaml` 標準空狀態為 `[]`。
   - `results.yaml` 標準空狀態為 `[]`。
   - 檔案不存在或空字串在讀取時視為 `[]`，但寫回時應正規化為 `[]`。

7. YAML 錯誤處理：
   - `tasks.yaml` 解析失敗：備份為 `tasks.yaml.bad`，重建 `tasks.yaml` 為 `[]`，輸出錯誤並停止本次執行。
   - `results.yaml` 解析失敗：備份為 `results.yaml.bad`，建立只包含本次結果的新檔，輸出警告。
   - 備份檔若已存在，應使用時間戳或安全的唯一檔名避免覆蓋。

8. 狀態摘要規則：
   - pending：`tasks.yaml` 中尚未移除的 task。
   - completed：results 中 `status: completed`。
   - failed：results 中 `status: failed`。
   - partial：results 中 `status: partial`。
   - running：由 `zmx list` 中對應的 `cx-` session 判定。

**實作步驟：**

- [ ] 建立 `cowork-runner/references/` 目錄。
- [ ] 建立 `cowork-runner/references/yaml-schema.md`。
- [ ] 寫入 `tasks.yaml` 完整範例。
- [ ] 寫入 `tasks.yaml` 欄位表，逐欄說明必填、型別與語意。
- [ ] 寫入 `results.yaml` 完整範例。
- [ ] 寫入 `results.yaml` 欄位表，逐欄說明必填、型別與語意。
- [ ] 寫入空狀態與正規化規則。
- [ ] 寫入 YAML 解析錯誤處理。
- [ ] 寫入狀態摘要規則，running 狀態需來自 `zmx list`。

**驗收標準：**

- `cowork-runner/references/yaml-schema.md` 存在。
- 文件包含 `tasks.yaml` 與 `results.yaml` 的完整 YAML 範例。
- 文件包含 `tasks.yaml` 與 `results.yaml` 的欄位表。
- 文件明確定義 `task-{unix_ms}-{random_hex_3}` ID 格式。
- 文件明確定義 `completed`、`failed`、`partial` 三種結果狀態。
- 文件明確定義 `[]` 是標準空狀態。
- 文件明確定義 YAML 解析失敗時的 `.bad` 備份行為。
- 文件明確定義 running 狀態由 `zmx list` 判定。

---

### 任務 4：整體一致性驗證

**檔案：**
- 建立：無
- 修改：無
- 驗證對象：`cowork-dispatch/SKILL.md`、`cowork-runner/SKILL.md`、`cowork-runner/references/yaml-schema.md`

**內容說明：**

此任務不建立新檔案，只驗證三個產物彼此一致，且符合設計規格與 agentskills.io 慣例。

**實作步驟：**

- [ ] 驗證兩個 skill 的 frontmatter：

```bash
sed -n '1,20p' cowork-dispatch/SKILL.md
sed -n '1,20p' cowork-runner/SKILL.md
```

- [ ] 驗證兩個 skill 行數低於 500：

```bash
wc -l cowork-dispatch/SKILL.md cowork-runner/SKILL.md
```

- [ ] 驗證三個必要產物都存在：

```bash
test -f cowork-dispatch/SKILL.md
test -f cowork-runner/SKILL.md
test -f cowork-runner/references/yaml-schema.md
```

- [ ] 搜尋必要關鍵字：

```bash
rg "tasks.yaml|results.yaml|--approval-mode full-auto|zmx list|zmx run|zmx history|zmx send|codex-multi-auth" cowork-dispatch cowork-runner
```

- [ ] 依照設計規格中的移除清單搜尋舊架構關鍵字，確認無結果。

**驗收標準：**

- 三個必要產物都存在。
- 兩個 `SKILL.md` 都有 `name` 與 `description` frontmatter。
- 兩個 `description` 都以 `Use when` 開頭。
- `cowork-dispatch/SKILL.md` 與 `cowork-runner/SKILL.md` 都低於 500 行。
- 搜尋結果顯示三個產物涵蓋 `tasks.yaml`、`results.yaml`、`--approval-mode full-auto`、`zmx list`、`zmx run`、`zmx history`、`zmx send` 與 `codex-multi-auth`。
- 舊架構關鍵字搜尋無結果。
- `cowork-dispatch/SKILL.md` 不指示把 spec/plan 審核工作寫入 YAML。
- `cowork-runner/SKILL.md` 引用 `references/yaml-schema.md`。

---

## 自我審核清單

- [x] 計畫涵蓋 `cowork-dispatch/SKILL.md`。
- [x] 計畫涵蓋 `cowork-runner/SKILL.md`。
- [x] 計畫涵蓋 `cowork-runner/references/yaml-schema.md`。
- [x] 每個任務都有檔案路徑、內容說明與驗收標準。
- [x] `cowork-dispatch/SKILL.md` 設計包含 `zmx list` 重名檢查、`zmx run` session 啟動、3 分鐘 `zmx history` 健康檢查、503 時 `zmx send` 重送與 `codex-multi-auth` 額度切換。
- [x] `cowork-runner/SKILL.md` 設計包含從 `tasks.yaml` 讀取任務、執行、寫入 `results.yaml`、移除已處理任務與正常退出。
- [x] `cowork-runner/SKILL.md` 設計包含任務執行策略：簡單任務直接執行、複雜任務生成 sub-agent 分工執行。
- [x] `yaml-schema.md` 的 `tasks.yaml` 欄位只包含 zmx 架構需要的任務資料。
- [x] 兩個 `SKILL.md` 都明確要求低於 500 行。
- [x] 所有 skill 檔案遵循 agentskills.io frontmatter、目錄、相對路徑與漸進揭露慣例。
- [x] YAML 佇列只處理外部執行任務，不處理 spec/plan 審核。
