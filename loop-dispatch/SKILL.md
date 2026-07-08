---
name: loop-dispatch
description: "協調 LoopAgentTeams 協作流程：規格撰寫、計劃審查、任務派發、狀態監控與結果驗收。支援多種 Code Agent Client。"
compatibility: "需要 git、zmx。依設定的 client 需要對應的 CLI 工具。"
---

# Loop Dispatch

## 適用時機

使用者提及 LoopAgentTeams、loop、多 agent 協作、規格/計劃撰寫、任務派發、佇列狀態查詢、或結果清理時使用。

## Client 設定

可用 client、指令格式、解析優先序、內建預設、config.yaml 格式參見 `references/client.md`。

## 預設流程

使用者啟動 LoopAgentTeams 時，**自動執行**，僅在 spec 階段需使用者確認（依 `spec_review_flow`）：

進度檢查清單 — 每次啟動 LoopAgentTeams 時建立追蹤，逐項完成後才進入下一階段：

```
- [ ] init：建立 .loop/ 目錄與佇列檔案
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

1. 在專案根目錄建立 `.loop/`（如不存在）。
2. 確保 `.gitignore` 排除 `.loop/`；若無則新增並提交。
3. 建立 `tasks.yaml` 和 `results.yaml`，初始內容為 `[]`。不覆寫已有內容的檔案。
4. 建立 `logs/` 和 `workspace/` 子目錄（如不存在）。

### spec

**審查流程（`spec_review_flow`）：**

| 關鍵詞 | 流程 |
|--------|------|
| `ai-first`（預設） | 腦力激盪 → 草稿 → AI 審查迴圈 → 使用者確認 |
| `user-first` | 腦力激盪 → 草稿 → 使用者審查草稿 → AI 審查迴圈 → 使用者確認 |

解析優先序同其他維度：使用者 prompt > `.loop/config.yaml` > 內建預設（`ai-first`）。

1. 使用 Superpowers 腦力激盪工作流，與使用者討論目標、範圍與交付內容。
2. 腦力激盪完成後，`spec_writer` 撰寫規格初稿。
3. spec 須含「驗收清單（QA）」章節。每條 Q 以可觀察的使用者行為描述目標（不用實作字眼），A 寫解法與對應測試／證據。隨規格一起確認。
4. **若 `user-first`：** 暫停，向使用者呈現草稿全文，等待使用者同意。使用者可要求修改，修改後重新呈現直到同意。
5. 依 `spec_reviewer` 的 client 類型呼叫審查。
6. exec client 執行時依 `references/client.md` 的 log 擷取方式記錄輸出，依監控方式章節執行監控。
7. 小問題由 reviewer 直接修正；重大問題由 writer 修正後重新送審。
8. 迴圈直到審查通過。不將審查工作寫入 `tasks.yaml`。
9. 向使用者呈現最終規格，等待確認後視為規格核准。
10. 中斷時依 `references/client.md` 的中斷防護與 Session 恢復流程處理。

### plan

1. 規格核准後才開始。
2. 使用 Superpowers 撰寫計劃工作流，依 `plan_writer` client 產生實作計劃 → `plan_reviewer` 對照規格審查。
3. 計劃須將 spec 的每一條 QA 驗收項對應到具體的整合／E2E 測試目標，以及 qa_executor 的驗收方式。測試目標以英文撰寫。
4. exec client 執行時依 `references/client.md` 的 log 擷取方式記錄輸出，依監控方式章節執行監控。
5. 有缺漏或偏離時，回饋 writer 修正後再審。
6. 中斷時依 `references/client.md` 的中斷防護與 Session 恢復流程處理。
7. 規格與計劃皆核准後一起提交：
   ```bash
   git commit -m "docs: add <feature-name> spec and implementation plan"
   ```
8. 不將計劃撰寫或審查工作寫入 `tasks.yaml`。

### dispatch

1. 確認計劃已通過完整審查迴圈（不是僅存在或看似完成）。
2. 建立**一個摘要任務**指向計劃檔案，不拆分為多個細粒度任務。
3. 附加任務至 `tasks.yaml`，欄位順序與格式參見 `loop-runner/references/yaml-schema.md`。
   - `task_id`：`task-{unix_ms}-{random_hex_3}`
   - `goal`：一句話描述完整實作範圍
   - `context.plan_file`、`context.spec_file`、`context.related_files`
   - `constraints`：保留計劃與使用者的實作約束
   - `created_by`：目前 agent 的識別名稱
4. 依解析出的 `code_executor` client，按 `references/client.md` 的指令格式啟動執行。

   Runner prompt：

   ```
   [<task_id>_code] You are the loop-runner. Read .loop/tasks.yaml, execute all pending implementation tasks following the loop-runner skill. Use sub-agents to parallelize independent development work when beneficial. Write .loop/results.yaml, remove completed tasks, then exit.
   ```

5. 依 `references/client.md` 的監控方式章節執行監控。`monitor.enabled: false` 或使用者說「不要監控」時跳過監控，直接告知使用者手動檢查。
6. 錯誤處理依 `references/client.md` 的錯誤處理章節。
7. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。

### test

1. 確認 code_executor 已完成且 results.yaml 狀態為 `completed`。
2. 依 `test_executor` 的 client 類型啟動測試 agent（zmx session）。

   首次 test_executor prompt（`agent_id` = `<task_id>_test`）：

   ```
   [<task_id>_test] Read the spec at <spec_file> and the test targets in <plan_file>. Following the three-tier-testing skill, write and run integration tests and E2E tests for the implemented code. Use sub-agents to parallelize independent test writing when beneficial. Do not write or modify unit tests. If tests fail, fix the implementation code and re-run until all tests pass. Run unit tests to confirm no regressions before finishing. E2E tests go in the project's E2E test directory (tests/e2e/ or <frontend>/tests/e2e/).
   ```

3. 依 `references/client.md` 的監控方式章節執行監控。
4. test_executor 全部通過後，依 `qa_executor` client 啟動驗收（新 zmx session，`agent_id` = `<task_id>_qa`，多輪時 `<task_id>_qa_<N>`）。

   qa_executor prompt：

   ```
   [<task_id>_qa] Read the spec at <spec_file> and its acceptance checklist (QA). Following the three-tier-testing skill, launch and drive the real application as a user would, and verify each acceptance item by observing actual behavior — do NOT rely on the existing test suite. Use sub-agents to parallelize independent checklist items when beneficial. For every checklist item, write an E2E test in tests/qa_e2e/ (or <frontend>/tests/qa_e2e/) that encodes the acceptance criterion, run it against the real application, and record the result. Do not modify implementation code or existing test files. Write your results to .loop/workspace/<task_id>/qa-results.md — report each item as PASS or FAIL with evidence (command + output/log/screenshot); for FAIL include expected versus observed.
   ```

5. 讀取 `.loop/workspace/<task_id>/qa-results.md`：
   - **全部 PASS** → 進入 report。
   - **有 FAIL** → 啟動 test_executor 修正（新 zmx session，`agent_id` = `<task_id>_test_<N>`，N 為輪次）。

   修正 test_executor prompt：

   ```
   [<task_id>_test_<N>] Acceptance verification failed. Read the spec at <spec_file> for requirements context, and read .loop/workspace/<task_id>/qa-results.md for the failed items and evidence. Fix the implementation code so the real application satisfies these items. Re-run the failing tests in tests/qa_e2e/ to verify your fix, then run unit tests to confirm no regressions. Do not modify test files in tests/qa_e2e/.
   ```

6. test_executor 修完後回到步驟 4（qa_executor 重新驗收）。
7. 迴圈直到 qa_executor 全部 PASS，或達到重試上限（`test.max_retries` / `test.max_retries_per_task`）。超過上限時暫停，向使用者報告失敗細節與證據。
8. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。
9. 中斷時依 `references/client.md` 的中斷防護與 Session 恢復流程處理。

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

## 注意事項

- Client 指令格式、監控、錯誤處理、Session 恢復參見 `references/client.md`。
- 佇列檔案規則參見 `loop-runner/references/yaml-schema.md`。
