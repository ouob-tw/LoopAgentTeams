---
name: lat-dispatch
description: >
  Use this skill to orchestrate LoopAgentTeams (LAT) multi-agent collaboration — spec writing,
  plan review, task dispatch, progress monitoring, and result acceptance. Use when the user
  mentions lat, loop, teamwork, loopagentteams, multi-agent collaboration, spec/plan authoring,
  task dispatch, queue status, or result cleanup, even if they don't name the skill directly.
  Supports multiple Code Agent clients (Claude Code, Codex CLI, etc.).
compatibility: "Requires git and zmx. Each configured client needs its corresponding CLI tool."
---

# LAT Dispatch

## Client 設定

可用 client、指令格式、解析優先序、內建預設、config.yaml 格式參見 `references/clients.md`。

## 預設流程

使用者啟動 LoopAgentTeams 時，**自動執行**，僅在 spec 階段需使用者確認（依 `spec_review_flow`）：

進度檢查清單 — 每次啟動 LoopAgentTeams 時建立追蹤，逐項完成後才進入下一階段：

```
- [ ] init：建立 .lat/ 目錄與佇列檔案
- [ ] spec：腦力激盪 → 草稿 → 審查（依 spec_review_flow）→ 使用者確認
- [ ] plan：產生計劃 → 審查迴圈 → 規格與計劃一起提交
- [ ] dispatch：建立任務寫入 tasks.yaml → 啟動 code_executor
- [ ] monitor：健康檢查 + 完成監控 → 確認 results.yaml 有結果
- [ ] test：test_executor 寫+跑整合與 E2E 測試修到綠 → qa_executor 依 QA 清單寫驗收測試至 qa_e2e/ → 失敗回饋 test_executor 修，迴圈到全過或達上限
- [ ] report：向使用者報告最終狀態
```

- 每個階段轉換以一句話報告進度。
- **不得推斷完成狀態。** 只有實際執行該階段的檢查步驟後，才可勾選完成。
- **不得跳步。** 除非使用者明確要求跳過特定步驟。

**暫停條件：** 設計歧義需使用者決策、審查發現多解的重大問題、不可恢復的錯誤、執行結果 `failed`。

**不暫停：** 小修正（直接修正後繼續）、計劃缺漏（回饋再審）、503 錯誤（自動重試）、單帳號配額耗盡（自動切換）、測試失敗（executor 自行處理）。

## 指令

### init

1. 在專案根目錄建立 `.lat/`（如不存在）。
2. 確保 `.gitignore` 排除 `.lat/`；若無則新增並提交。
3. 建立 `tasks.yaml` 和 `results.yaml`，初始內容為 `[]`。不覆寫已有內容的檔案。
4. 建立 `logs/` 和 `workspace/` 子目錄（如不存在）。

### spec

**審查流程（`spec_review_flow`）：**

| 關鍵詞             | 流程                                                        |
| ------------------ | ----------------------------------------------------------- |
| `ai-first`（預設） | 腦力激盪 → 草稿 → AI 審查迴圈 → 使用者確認                  |
| `user-first`       | 腦力激盪 → 草稿 → 使用者審查草稿 → AI 審查迴圈 → 使用者確認 |

解析優先序同其他維度：使用者 prompt > `.lat/config.yaml` > 內建預設（`ai-first`）。

1. 使用 Superpowers 腦力激盪工作流，與使用者討論目標、範圍與交付內容。
2. 腦力激盪完成後，`spec_writer` 撰寫規格初稿。
3. spec 須含「驗收清單（QA）」章節。每條 Q 以可觀察的使用者行為描述目標（不用實作字眼），A 寫解法與對應測試／證據。隨規格一起確認。
4. **若 `user-first`：** 暫停，向使用者呈現草稿全文，等待使用者同意。使用者可要求修改，修改後重新呈現直到同意。
5. 依 `spec_reviewer` 的 client 類型呼叫審查（`agent_id` = `spec_reviewer_1_<task_id>`）。

   spec_reviewer prompt：

   ```
   [spec_reviewer_1_<task_id>] Review the spec at <spec_file>. Check for completeness, ambiguity, missing edge cases, and testability of the acceptance checklist (QA). If you find minor issues, fix them directly in the file. If you find major issues that need design decisions, list them clearly and do not modify the file. Report your review result as PASS or NEEDS_REVISION with details.
   ```

6. exec client 執行時依 `references/clients.md` 的 log 擷取方式記錄輸出，依監控方式章節執行監控。
7. 小問題由 reviewer 直接修正；重大問題由 writer 修正後重新送審。
8. 迴圈直到審查通過。不將審查工作寫入 `tasks.yaml`。
9. 向使用者呈現最終規格，等待確認後視為規格核准。
10. 中斷時依 `references/clients.md` 的中斷防護與 Session 恢復流程處理。

### plan

1. 規格核准後才開始。
2. 使用 Superpowers 撰寫計劃工作流，依 `plan_writer` client 產生實作計劃（`agent_id` = `plan_writer_1_<task_id>`） → `plan_reviewer` 對照規格審查。

   plan_writer prompt：

   ```
   [plan_writer_1_<task_id>] Read the approved spec at <spec_file>. Write an implementation plan that covers all requirements and maps each QA acceptance item to concrete integration/E2E test targets and qa_executor verification methods. Write test targets in English. Save the plan to <plan_file>.
   ```

3. 計劃須將 spec 的每一條 QA 驗收項對應到具體的整合／E2E 測試目標，以及 qa_executor 的驗收方式。測試目標以英文撰寫。
4. exec client 執行時依 `references/clients.md` 的 log 擷取方式記錄輸出，依監控方式章節執行監控。
5. 有缺漏或偏離時，回饋 writer 修正後再審。
6. 中斷時依 `references/clients.md` 的中斷防護與 Session 恢復流程處理。
7. 規格與計劃皆核准後一起提交：
   ```bash
   git commit -m "docs: add <feature-name> spec and implementation plan"
   ```
8. 不將計劃撰寫或審查工作寫入 `tasks.yaml`。

### dispatch

1. 確認計劃已通過完整審查迴圈（不是僅存在或看似完成）。
2. 建立**一個摘要任務**指向計劃檔案，不拆分為多個細粒度任務。
3. 附加任務至 `tasks.yaml`，欄位順序與格式參見 `lat-runner/references/yaml-schema.md`。
   - `task_id`：Spec 檔名（不含 `.md`），如 `2026-07-09-user-api-spec`
   - `agent_id`：`code_executor_1_<task_id>`
   - `goal`：一句話描述完整實作範圍
   - `context.plan_file`、`context.spec_file`、`context.related_files`
   - `constraints`：保留計劃與使用者的實作約束
   - `created_by`：目前 agent 的識別名稱
4. 依解析出的 `code_executor` client，按 `references/clients.md` 的指令格式啟動執行。

   Runner prompt：

   ```
   [<agent_id>] You are the lat-runner. Read .lat/tasks.yaml, execute all pending implementation tasks following the lat-runner skill. Use sub-agents to parallelize independent development work when beneficial. Write .lat/results.yaml, remove completed tasks, then exit.
   ```

5. 依 `references/clients.md` 的監控方式章節執行監控。`monitor.enabled: false` 或使用者說「不要監控」時跳過監控，直接告知使用者手動檢查。
6. 錯誤處理依 `references/clients.md` 的錯誤處理章節。
7. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。

### test

1. 確認 code_executor 已完成且 results.yaml 狀態為 `completed`。
2. 依 `test_executor` 的 client 類型啟動測試 agent（zmx session）。

   首次 test_executor prompt（`agent_id` = `test_executor_1_<task_id>`）：

   ```
   [test_executor_1_<task_id>] Read the spec at <spec_file> and the test targets in <plan_file>. Following the three-tier-testing skill, write and run integration tests and E2E tests for the implemented code. Use sub-agents to parallelize independent test writing when beneficial. Do not write or modify unit tests. If tests fail, fix the implementation code and re-run until all tests pass. Run unit tests to confirm no regressions before finishing. E2E tests go in the project's E2E test directory (tests/e2e/ or <frontend>/tests/e2e/). When finished, prepend your result to .lat/results.yaml (newest first) following the yaml-schema — task_id is '<task_id>', agent_id is 'test_executor_1_<task_id>'.
   ```

3. 依 `references/clients.md` 的監控方式章節執行監控。
4. test_executor 全部通過後，依 `qa_executor` client 啟動驗收（新 zmx session，`agent_id` = `qa_executor_1_<task_id>`，多輪時 round 遞增）。

   qa_executor prompt：

   ```
   [qa_executor_1_<task_id>] Read the spec at <spec_file> and its acceptance checklist (QA). Following the three-tier-testing skill, launch and drive the real application as a user would, and verify each acceptance item by observing actual behavior — do NOT rely on the existing test suite. Use sub-agents to parallelize independent checklist items when beneficial. For every checklist item, write an E2E test in tests/qa_e2e/ (or <frontend>/tests/qa_e2e/) that encodes the acceptance criterion, run it against the real application, and record the result. Do not modify implementation code or existing test files. Write your results to .lat/workspace/<task_id>/qa-results.md — report each item as PASS or FAIL with evidence (command + output/log/screenshot); for FAIL include expected versus observed. Also prepend your result to .lat/results.yaml (newest first) following the yaml-schema — task_id is '<task_id>', agent_id is 'qa_executor_1_<task_id>'.
   ```

5. 讀取 `.lat/workspace/<task_id>/qa-results.md`：
   - **全部 PASS** → 進入 report。
   - **有 FAIL** → 啟動 test_executor 修正（新 zmx session，`agent_id` = `test_executor_<N>_<task_id>`，N 為輪次）。

   修正 test_executor prompt：

   ```
   [test_executor_<N>_<task_id>] Acceptance verification failed. Read the spec at <spec_file> for requirements context, and read .lat/workspace/<task_id>/qa-results.md for the failed items and evidence. Fix the implementation code so the real application satisfies these items. Re-run the failing tests in tests/qa_e2e/ to verify your fix, then run unit tests to confirm no regressions. Do not modify test files in tests/qa_e2e/. When finished, prepend your result to .lat/results.yaml (newest first) following the yaml-schema — task_id is '<task_id>', agent_id is 'test_executor_<N>_<task_id>'.
   ```

6. test_executor 修完後回到步驟 4（qa_executor 重新驗收）。
7. 迴圈直到 qa_executor 全部 PASS，或達到重試上限（`test.max_retries` / `test.max_retries_per_task`）。超過上限時暫停，向使用者報告失敗細節與證據。
8. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。
9. 中斷時依 `references/clients.md` 的中斷防護與 Session 恢復流程處理。

### report

向使用者報告最終狀態：需求摘要、交付內容、`git diff` 變更範圍、逐條 QA 驗收項的結果與證據（指令 + 輸出）、測試結果、變更檔案清單。

### status

1. 讀取 `tasks.yaml` 和 `results.yaml`（遺失、空字串、`[]` 均視為空）。
2. 摘要報告：待處理任務、已完成/失敗/部分完成結果。
3. 執行 `zmx list`，顯示 `cx-` / `cc-` 工作階段狀態。

### clean

1. 重設 `results.yaml` 為 `[]`。不修改 `tasks.yaml`。
2. 清理 `workspace/`：刪除修改時間超過 `workspace.retention_days`（預設 60）天的子目錄。
3. 清理 `logs/`：刪除修改時間超過 `logs.retention_days`（預設 60）天的 log 檔案。

## Sub-Agent 異常診斷

任何 phase 的 sub-agent（spec_reviewer、plan_writer、code_executor、test_executor、qa_executor）回報工具相關錯誤時，適用本流程。

### 核心原則

- **不信 sub-agent 的自我診斷。** Sub-agent 回報「沒有權限」「沒有此工具」「工具不可用」時，視為待驗證，不視為事實。常見原因是工具呼叫參數錯誤，sub-agent 誤判為權限問題。
- **不代做。** Dispatch 絕對不接手 sub-agent 的任務。即使 sub-agent 看起來卡住，也只能診斷與通知，不可自行執行該 phase 的工作內容。

### 診斷流程

```
1. 驗指令 → 確認 Dispatch 下的啟動指令正確
2. 查 log  → 讀取 sub-agent 的 log，找到實際錯誤訊息
3. 通知    → 把真正的錯誤原因告訴 sub-agent，讓它自行修正
```

**步驟 1 — 驗指令：**
確認啟動指令的 permission / sandbox flag、model、prompt 格式皆正確。若指令本身有誤，修正後重新啟動 sub-agent。

**步驟 2 — 查 log：**
`.lat/logs/` 的 log 可能不完整（尤其 tui client 不經過 `.lat/logs/`）。必須直接讀取主機上 CLI 工具的完整 session JSONL。

每個 phase 的啟動 prompt 皆以 `[<agent_id>]` 開頭（如 `[test_executor_1_2026-07-09-user-api-spec]`），因此可用 `agent_id` 在 session 目錄中精確定位對應的 session 檔案。

定位 session 檔案：

- **Codex：**
  ```bash
  grep -rl "<agent_id>" ~/.codex/sessions/$(date -u +%Y/%m/%d)/*.jsonl | head -1
  ```
  跨日加查前一天：`$(date -u -d yesterday +%Y/%m/%d)`。

- **Claude Code：**
  session 索引在 `~/.claude/sessions/<pid>.json`，內含 `name`（即 `agent_id`）與 `sessionId`。
  ```bash
  grep -rl "<agent_id>" ~/.claude/sessions/*.json | head -1
  ```
  取得 `sessionId` 後，讀取對應的 JSONL：
  ```bash
  ~/.claude/projects/<project-slug>/<sessionId>.jsonl
  ```
  `<project-slug>` 為工作目錄路徑以 `-` 取代 `/`（如 `/home/swy/myapp` → `-home-swy-myapp`）。

在 JSONL 中搜尋工具呼叫錯誤：
```bash
grep -i "error\|failed\|permission\|denied\|invalid" <session-jsonl>
```

找到實際錯誤訊息後，判斷真正原因（參數格式錯誤、schema 不符、真的權限不足等）。

**步驟 3 — 通知 sub-agent：**
依 client 類型通知：
- tui → `zmx send <session> "<問題描述與修正指引>"`
- exec → 依 `references/clients.md` 的 Session 恢復流程 resume，在 prompt 中帶入問題描述

通知內容須包含：實際錯誤訊息、錯誤原因、修正方向。

### 重試上限

同一 sub-agent 因同類工具錯誤被通知 **3 次**後仍未解決，暫停該 phase，向使用者報告：
- sub-agent 的角色與 agent_id
- 實際錯誤訊息
- 已嘗試的修正指引
- 建議的人工處理方式

## 注意事項

- Client 指令格式、監控、錯誤處理、Session 恢復參見 `references/clients.md`。
- 佇列檔案規則參見 `lat-runner/references/yaml-schema.md`。
