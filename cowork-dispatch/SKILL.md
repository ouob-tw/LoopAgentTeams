---
name: cowork-dispatch
description: "協調 CoWork 協作流程：規格撰寫、計劃審查、任務派發、狀態監控與結果驗收。支援多種 Code Agent Client。"
compatibility: "需要 git、zmx。依設定的 client 需要對應的 CLI 工具。"
---

# CoWork Dispatch

協調 CoWork 協作流程：規格準備、計劃審查、YAML 佇列管理、任務派發、工作階段監控、結果清理。

## 適用時機

使用者提及 CoWork、多 agent 協作、規格/計劃撰寫、任務派發、佇列狀態查詢、或結果清理時使用。

## Client 設定

可用 client、指令格式、解析優先序、內建預設、config.yaml 格式參見 `references/client.md`。

## 預設流程

使用者啟動 CoWork 時，**自動執行**，僅在 spec 階段需使用者確認（依 `spec_review_flow`）：

進度檢查清單 — 每次啟動 CoWork 時建立追蹤，逐項完成後才進入下一階段：

```
- [ ] init：建立 .cowork/ 目錄與佇列檔案
- [ ] spec：腦力激盪 → 草稿 → 審查（依 spec_review_flow）→ 使用者確認
- [ ] plan：產生計劃 → 審查迴圈 → 規格與計劃一起提交
- [ ] dispatch：建立任務寫入 tasks.yaml → 啟動 code_executor
- [ ] monitor：健康檢查 + 完成監控 → 確認 results.yaml 有結果
- [ ] test：test_executor 寫+跑整合與 E2E 測試修到綠 → qa_executor 拿 QA 清單真跑 app 黑箱驗收（附證據）→ 失敗回饋 test_executor 修，迴圈到全過或達上限
- [ ] report：向使用者報告最終狀態
```

- 每個階段轉換以一句話報告進度。
- **不得推斷完成狀態。** 只有實際執行該階段的檢查步驟後，才可勾選完成。
- **不得跳步。** 除非使用者明確要求跳過特定步驟。

**暫停條件：** 設計歧義需使用者決策、審查發現多解的重大問題、不可恢復的錯誤、執行結果 `failed`。

**不暫停：** 小修正（直接修正後繼續）、計劃缺漏（回饋再審）、503 錯誤（自動重試）、單帳號配額耗盡（自動切換）、測試失敗（executor 自行處理）。

## 指令

### init

1. 在專案根目錄建立 `.cowork/`（如不存在）。
2. 確保 `.gitignore` 排除 `.cowork/`；若無則新增並提交。
3. 建立 `tasks.yaml` 和 `results.yaml`，初始內容為 `[]`。不覆寫已有內容的檔案。
4. 建立 `logs/` 子目錄（如不存在）。

### spec

**審查流程（`spec_review_flow`）：**

| 關鍵詞 | 流程 |
|--------|------|
| `ai-first`（預設） | 腦力激盪 → 草稿 → AI 審查迴圈 → 使用者確認 |
| `user-first` | 腦力激盪 → 草稿 → 使用者審查草稿 → AI 審查迴圈 → 使用者確認 |

解析優先序同其他維度：使用者 prompt > `.cowork/config.yaml` > 內建預設（`ai-first`）。

1. 先使用 Superpowers 腦力激盪工作流。
2. 使用 Superpowers 撰寫計劃工作流產出規格文件。
3. `spec_writer` 撰寫初稿。
4. spec 必須包含「驗收清單（QA）」章節，分層列出（例如功能/整合/端對端層級）。每條為 Q（使用者必須達成的目標，用可觀察的使用者行為描述，不用實作字眼）+ A（如何解決 + 由哪個測試或證據驗證）。這份清單是使用者的驗收合約，須在使用者確認規格時一併確認。
5. **若 `user-first`：** 暫停，向使用者呈現草稿全文，等待使用者同意。使用者可要求修改，修改後重新呈現直到同意。
6. 依 `spec_reviewer` 的 client 類型呼叫審查。
7. exec client 執行時依 `references/client.md` 的 log 擷取方式記錄輸出，依監控方式章節執行監控。
8. 小問題由 reviewer 直接修正；重大問題由 writer 修正後重新送審。
9. 迴圈直到審查通過。不將審查工作寫入 `tasks.yaml`。
10. 向使用者呈現最終規格，等待確認後視為規格核准。
11. 中斷時依 `references/client.md` 的中斷防護與 Session 恢復流程處理。

### plan

1. 規格核准後才開始。
2. 依 `plan_writer` 的 client 類型呼叫產生實作計劃 → `plan_reviewer` 對照規格審查。
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
3. 附加任務至 `tasks.yaml`，欄位順序與格式參見 `cowork-runner/references/yaml-schema.md`。
   - `task_id`：`task-{unix_ms}-{random_hex_3}`
   - `goal`：一句話描述完整實作範圍
   - `context.plan_file`、`context.spec_file`、`context.related_files`
   - `constraints`：保留計劃與使用者的實作約束
   - `created_by`：目前 agent 的識別名稱
4. 依解析出的 `code_executor` client，按 `references/client.md` 的指令格式啟動執行。

   Runner prompt：

   ```
   [<task_id>] You are the cowork-runner. Read .cowork/tasks.yaml, execute all pending implementation tasks following the cowork-runner skill. Use sub-agents to parallelize independent development work when beneficial. Write .cowork/results.yaml, remove completed tasks, then exit.
   ```

5. 依 `references/client.md` 的監控方式章節執行監控。`monitor.enabled: false` 或使用者說「不要監控」時跳過監控，直接告知使用者手動檢查。
6. 錯誤處理依 `references/client.md` 的錯誤處理章節。
7. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。

### test

1. 確認 code_executor 已完成且 results.yaml 狀態為 `completed`。
2. 依 `test_executor` 的 client 類型啟動測試 agent（zmx session）。

   首次 test_executor prompt：

   ```
   [<task_id>] Read the spec at <spec_file> and the test targets in <plan_file>. Following the three-tier-testing skill, write and run integration tests and E2E tests for the implemented code. Do not write or modify unit tests. If tests fail, fix the implementation code and re-run until all tests pass. Run unit tests to confirm no regressions before finishing.
   ```

3. 依 `references/client.md` 的監控方式章節執行監控。
4. test_executor 全部通過後，依 `qa_executor` 的 client 類型啟動獨立黑箱驗收（新 zmx session）。qa_executor **不修改任何程式碼或測試檔案**，也**不重跑實作者寫的測試**。它拿 spec 的 QA 驗收清單，實際啟動並驅動真實 app，逐條用觀察到的行為確認，且**每一條都附上證據（執行的指令 + 真實輸出／log／截圖）**。

   qa_executor prompt：

   ```
   [<task_id>] Read the spec at <spec_file> and its acceptance checklist (QA). Launch and drive the real application as a user would, and verify each acceptance item by observing actual behavior — do NOT rely on the existing test suite. For every checklist item, record the exact command(s) you ran and the real output/log/screenshot as evidence. Do not modify any code or test files. Report each item as PASS or FAIL with its evidence; for FAIL include what you expected versus what you observed.
   ```

5. 讀取 qa_executor 結果：
   - **全部 PASS** → 進入 report。
   - **有 FAIL** → 將失敗項與證據交給 test_executor 修正（新 zmx session）。

   修正 test_executor prompt：

   ```
   [<task_id>] Acceptance verification failed on the following items. Read the spec at <spec_file> for requirements context. Fix the implementation code so the real application satisfies these items. Re-run the failing integration/E2E tests to verify your fix, then run unit tests to confirm no regressions. Do not modify the test files in tests/integration/ or tests/e2e/.

   Failed items:
   <item + expected vs observed + evidence>
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

重設 `results.yaml` 為 `[]`。不修改 `tasks.yaml`。

## 注意事項

- Client 指令格式、監控、錯誤處理、Session 恢復參見 `references/client.md`。
- 佇列檔案規則參見 `cowork-runner/references/yaml-schema.md`。
