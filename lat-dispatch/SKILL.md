---
name: lat-dispatch
description: "You MUST use this when the user mentions lat, loop, loopagentteams, dispatch, or when brainstorming skill is loaded. Also use for multi-agent spec/plan/test workflows."
compatibility: "Linux or macOS with Bash 3.2+. Requires git, zmx, jq, uuidgen, trash-put, and each configured client CLI."
---

# LAT Dispatch

## Client 設定

可用 client、指令格式、解析優先序、內建預設、config.yaml 格式參見 `references/clients.md`。

## Available scripts

- `scripts/monitor-session.sh` — 監控 Codex／Claude 原始 Session JSONL 並提取最新 turn 的 Final Answer
- `scripts/run-exec-client.sh` — 啟動 exec client、以 `$!` 保存 PID、等待退出並清理 PID file

## 預設流程

使用者啟動 LoopAgentTeams 時，**自動執行**，僅在 spec 階段需使用者確認（依 `spec_review_flow`）：

進度檢查清單 — 每次啟動 LoopAgentTeams 時建立追蹤，逐項完成後才進入下一階段：

```
- [ ] init：建立 `.lat/logs/` 與 `.lat/workspace/`，遷移舊全域 ledger
- [ ] spec：腦力激盪 → 草稿／確定 TASK_ID → 初始化 task workspace 與空 ledger → 審查（依 spec_review_flow）→ 使用者確認
- [ ] plan：產生計劃 → 審查迴圈 → 規格與計劃一起提交
- [ ] dispatch：驗證既有 `.lat/workspace/<TASK_ID>/` ledger → 附加 code task → 啟動 code_executor
- [ ] monitor：以 client 原始 Session JSONL 做健康與 turn 完成監控 → 將 Final Answer 交給 Dispatch；executor 另確認 task ledger
- [ ] test：test_executor 寫+跑整合與 E2E 測試修到綠 → qa_executor 依 QA 清單寫驗收測試至 qa_e2e/ → 失敗回饋 test_executor 修，迴圈到全過或達上限
- [ ] report：向使用者報告最終狀態
```

- 每個階段轉換以一句話報告進度。
- **不得推斷完成狀態。** 只有實際執行該階段的檢查步驟後，才可勾選完成。
- **不得跳步。** 除非使用者明確要求跳過特定步驟。

### Monitor 完成契約

- 執行監控時從本技能目錄呼叫 `scripts/monitor-session.sh`；不要在 prompt 或臨時 shell 中重寫監控迴圈。client 啟動與 session 定位方式見 `references/clients.md`。
- Codex 監控只傳 `agent_id` 時由腳本自動定位 JSONL；定位 STALL 時，Dispatch 擴大搜尋並人工確認後，以 `--jsonl-path "$JSONL_PATH"` 重啟 Monitor。
- Claude exec 與 TUI 都監控 Project transcript；最新人類 prompt 之後的 `assistant` text 加 `stop_reason: "end_turn"` 表示該 turn 完成，`last-prompt` 不得視為完成標記。
- Codex exec 與 TUI 都監控原生 Session JSONL；同一 turn 必須同時有 `response_item` 的 `phase: "final_answer"` 與 `event_msg.payload.type: "task_complete"` 或 `"turn_complete"`。
- `COMPLETED` 只代表最新 turn 已輸出 Final Answer 並結束，不代表 exec OS 程序已 EOF／退出或 exit code 為 0。
- Codex 最新 turn 已有 `task_complete`／`turn_complete` 卻沒有 Final Answer 時，Monitor 立即回報 `INCOMPLETE`；Dispatch 不得從 rollout 欄位猜測原因，須依 `references/clients.md` 先驗證帳號配額，再檢查 client 對應的診斷來源。
- Monitor 不建立、自訂或重新導向 exec log；四種 client 模式皆直接讀 CLI 原始 Session JSONL，並將 Final Answer 原文交給 Dispatch Agent。
- 監控來源的修改時間有變動表示仍有活動，超過該階段 `stall` 秒未變才回報 `STALL`。
- review 階段的內建值為 `stall: 600`、`drift: 1800`；同一 client turn 的初次 Monitor 與 re-arm 必須重用同一組已解析值。
- Claude Code Dispatch 呼叫 Monitor 時固定使用 `timeout_ms: 3600000`、`persistent: true`；生命週期由 bundled script 的終端事件控制。
- 單一 `STALL` 只觸發診斷，不授權 kill。exec 依 `references/clients.md` 使用啟動時保存的 PID；TUI 仍使用 zmx session handle。
- `spec_reviewer`、`plan_writer`、`plan_reviewer` 等工作不寫 task ledger；Dispatch 使用 Monitor 回傳的 Final Answer 進行審查裁決。
- `code_executor`、`test_executor`、`qa_executor` 不論使用 exec 或 tui，都須寫 `.lat/workspace/<TASK_ID>/results.yaml` 並更新同目錄 `tasks.yaml` 的精確 `agent_id` 狀態。流程狀態以 ledger 為準，Final Answer 僅供摘要與診斷。
- ledger 出現結果不能單獨代表 turn 已完成；executor 仍須等 Monitor 回傳 `COMPLETED` 才能進入下一階段。

## 審查裁決（Dispatch Independent Adjudication）

Reviewer 的 verdict 與 finding 都是待驗證主張，不是 phase 的最終權威。Dispatch 不得只閱讀 Reviewer Final Answer 或因其回覆 `PASS`／`NEEDS_REVISION` 就直接決定下一步。

作者送審前先自檢完整性、使用者已確認需求、QA 對應、placeholder 與內部矛盾。Reviewer 完成後，Dispatch 必須重新讀取目前文件、使用者決策、QA 清單，以及 finding 引用的程式碼、設定、測試或官方資料，逐項分類：

- `ACCEPT`：證據成立，交回原作者修正。
- `REJECT`：證據不成立，記錄具體駁回理由。
- `USER_DECISION`：涉及多解的產品或架構決策，暫停並詢問使用者。

Reviewer 回覆 `PASS` 時，Dispatch 仍須執行 focused gap scan，至少檢查需求範圍、已確認決策、QA 可測試性及高風險假設。這不是完整重做作者自檢；只有發現矛盾、重大風險或證據不足時才升級為完整審查。

Reviewer 為 report-only，不得直接修改 Spec／Plan。若有 accepted findings，原作者修正並再次自檢，再啟動下一 round Reviewer 與新的 Dispatch 裁決。Reviewer verdict 與 Dispatch adjudication 都完成後，phase 才能通過；若 Reviewer 回覆 `NEEDS_REVISION` 但所有 finding 均被 Dispatch 以證據 `REJECT`，focused gap scan 通過後仍可批准。

**暫停條件：** 設計歧義需使用者決策、審查發現多解的重大問題、不可恢復的錯誤、執行結果 `failed`。

**不暫停：** 小修正（直接修正後繼續）、計劃缺漏（回饋再審）、503 錯誤（自動重試）、單帳號配額耗盡（自動切換）、測試失敗（executor 自行處理）。

## 指令

### init

1. 在專案根目錄建立 `.lat/`（如不存在）。
2. 確保 `.gitignore` 排除 `.lat/`；若無則新增並提交。
3. 建立 `logs/` 和 `workspace/` 子目錄（如不存在）。不建立全域 `.lat/tasks.yaml` 或 `.lat/results.yaml`。
4. 若存在舊的全域 `.lat/tasks.yaml` 或 `.lat/results.yaml`，依 `lat-runner/references/yaml-schema.md` 的遷移流程按 `task_id` 分組；完整驗證後才用 `trash-put` 移除舊檔。

### spec

**審查流程（`spec_review_flow`）：**

| 關鍵詞             | 流程                                                        |
| ------------------ | ----------------------------------------------------------- |
| `ai-first`（預設） | 腦力激盪 → 草稿 → AI 審查迴圈 → 使用者確認                  |
| `user-first`       | 腦力激盪 → 草稿 → 使用者審查草稿 → AI 審查迴圈 → 使用者確認 |

解析優先序同其他維度：使用者 prompt > `.lat/config.yaml` > 內建預設（`ai-first`）。

1. 使用 Superpowers 腦力激盪工作流，與使用者討論目標、範圍與交付內容。
2. 腦力激盪完成後，`spec_writer` 撰寫規格初稿；Spec 檔名（不含 `.md`）同時確定本輪 `TASK_ID`。
3. 驗證 `TASK_ID` 是安全 slug，建立 `.lat/workspace/<TASK_ID>/` 與 `prompts/`，並將 `tasks.yaml`、`results.yaml` 初始化為 `[]`。若 workspace 已存在，須解析並驗證兩個 ledger；不得清空、覆寫或刪除既有 task/result 歷史，缺少或損壞時暫停請求人工處理。初始化完成後才啟動 reviewer。
4. spec 須含「驗收清單（QA）」章節。每條 Q 以可觀察的使用者行為描述目標（不用實作字眼），A 寫解法與對應測試／證據。隨規格一起確認。
5. `Dispatch/spec_writer` 完成送審前自檢：確認需求範圍、使用者決策、QA 對應、placeholder 與內部矛盾。
6. **若 `user-first`：** 暫停，向使用者呈現草稿全文，等待使用者同意。使用者可要求修改，修改後重新自檢，直到同意。
7. 依 `spec_reviewer` 的 client 類型呼叫 report-only 審查（`agent_id` = `spec_reviewer_<instance>_<task_id>`，instance 從 1 起算）。Reviewer 不修改檔案；每個 finding 須提供 finding ID、嚴重度、主張、具體證據與建議。

   spec_reviewer prompt：

   ```
   [<agent_id>] Review the spec at <spec_file>. Do not modify the spec file. Check completeness, ambiguity, missing edge cases, user-confirmed scope, and testability of every QA item. When current library, framework, SDK, API, CLI, or cloud-service documentation is needed, use the existing Context7 MCP; do not install a Context7 CLI or change permissions or other MCPs. Report VERDICT: PASS or NEEDS_REVISION. For every finding include a stable finding ID, severity, claim, concrete evidence with file/section references, and recommendation.
   ```

8. 依 `references/clients.md` 監控原始 Session JSONL；收到完成標記後，Dispatch 依「審查裁決」逐項驗證 finding，並在 Reviewer `PASS` 時執行 focused gap scan。
9. `ACCEPT` findings 由 `Dispatch/spec_writer` 修正後重新執行送審前自檢，再以新的 `spec_reviewer` instance 啟動下一 review round；`REJECT` 記錄證據後不採用；`USER_DECISION` 暫停詢問使用者。
10. 迴圈直到 Reviewer verdict 與 Dispatch adjudication 都允許通過。不將審查或裁決工作寫入 `tasks.yaml`。
11. 向使用者呈現最終規格，等待確認後視為規格核准。
12. 中斷時依 `references/clients.md` 的中斷防護與 Session 恢復流程處理。

### plan

1. 規格核准後才開始。
2. 使用 Superpowers 撰寫計劃工作流，依外部 `plan_writer` client 產生實作計劃（`agent_id` = `plan_writer_<instance>_<task_id>`）。instance 是邏輯 Agent 實例序號：首次指派為 1；恢復同一 Writer Session 修改時維持原 instance；只有原 Session 無法恢復或 Dispatch 明確改派新的 `plan_writer` Session 時，才以既有最大 Writer instance 加 1。Writer instance 與 `plan_reviewer` 的 review round 各自獨立。

   plan_writer prompt：

   ```
   [<agent_id>] Read the approved spec at <spec_file>. Write an implementation plan that covers all requirements and maps each QA acceptance item to concrete integration/E2E test targets and qa_executor verification methods. When current library, framework, SDK, API, CLI, or cloud-service documentation is needed, use the existing Context7 MCP; do not install a Context7 CLI or change permissions or other MCPs. Write test targets in English. Save the plan to <plan_file>. Before finishing, self-check scope coverage, QA mappings, placeholders, contradictions, and executable commands.
   ```

3. 計劃須將 spec 的每一條 QA 驗收項對應到具體的整合／E2E 測試目標，以及 qa_executor 的驗收方式。測試目標以英文撰寫。
4. Monitor 回傳 writer Final Answer 後，Dispatch 確認原 `plan_writer` 已完成送審前自檢，再依外部 `plan_reviewer` client 啟動 report-only 審查（`agent_id` = `plan_reviewer_<instance>_<task_id>`，instance 從 1 起算）。Reviewer 不修改檔案；每個 finding 須提供 finding ID、嚴重度、主張、具體證據與建議。

   plan_reviewer prompt：

   ```
   [<agent_id>] Review <plan_file> against the approved spec at <spec_file>. Do not modify the plan file. Check complete requirement coverage, every QA-to-test mapping, sequencing, dependencies, rollback or failure handling where relevant, and command executability. When current library, framework, SDK, API, CLI, or cloud-service documentation is needed, use the existing Context7 MCP; do not install a Context7 CLI or change permissions or other MCPs. Report VERDICT: PASS or NEEDS_REVISION. For every finding include a stable finding ID, severity, claim, concrete evidence with file/section references, and recommendation.
   ```

5. 依 `references/clients.md` 監控 reviewer 原始 Session JSONL；完成後，Dispatch 依「審查裁決」逐項驗證 finding，並在 Reviewer `PASS` 時執行 focused gap scan。
6. `ACCEPT` findings 交回原 `plan_writer` Session 修正並維持原 instance；若無法恢復或 Dispatch 明確改派，才啟動新的 `plan_writer` Session 並將 instance 加 1。writer 修正後重新送審前自檢，再以新的 `plan_reviewer` instance 啟動下一 review round。`REJECT` 記錄證據後不採用；`USER_DECISION` 暫停詢問使用者。
7. 迴圈直到 Reviewer verdict 與 Dispatch adjudication 都允許通過。不將計劃撰寫、審查或裁決工作寫入 `tasks.yaml`。
8. 中斷時依 `references/clients.md` 的中斷防護與 Session 恢復流程處理。
9. 規格與計劃皆核准後一起提交：
   ```bash
   git commit -m "docs: add <feature-name> spec and implementation plan"
   ```

### dispatch

1. 確認計劃已通過完整審查迴圈（不是僅存在或看似完成）。
2. 建立**一個摘要任務**指向計劃檔案，不拆分為多個細粒度任務。
3. 驗證既有 `.lat/workspace/<TASK_ID>/`、`tasks.yaml` 與 `results.yaml` 均存在且可解析，並確認 task/result 內的 `task_id` 都匹配目錄名稱；缺少或損壞時暫停，不得自行重建或重設。確認 `code_executor_1_<task_id>` 尚未存在後，附加 code task 至 `tasks.yaml`，欄位順序與格式參見 `lat-runner/references/yaml-schema.md`。
   - `task_id`：Spec 檔名（不含 `.md`），如 `2026-07-09-user-api-spec`
   - `agent_id`：`code_executor_1_<task_id>`
   - `goal`：一句話描述完整實作範圍
   - `context.plan_file`、`context.spec_file`、`context.related_files`
   - `constraints`：保留計劃與使用者的實作約束
   - `created_by`：目前 agent 的識別名稱
4. 依解析出的 `code_executor` client，按 `references/clients.md` 的指令格式啟動執行。

   Runner prompt：

   ```
   [<agent_id>] You are the lat-runner for TASK_ID '<task_id>'. Read .lat/workspace/<task_id>/tasks.yaml and process only the exact pending task whose agent_id is '<agent_id>', following the lat-runner skill. Use sub-agents to parallelize independent development work when beneficial. Upsert the result into .lat/workspace/<task_id>/results.yaml, update the same task entry to its final status without deleting it, then exit.
   ```

5. 依 `references/clients.md` 的監控方式章節執行監控。Monitor 必須等 turn 完成並將 Final Answer 交給 Dispatch；Dispatch 再讀取 `.lat/workspace/<TASK_ID>/results.yaml` 中精確匹配 `task_id`、`agent_id` 的結果，並與 `tasks.yaml.status` 交叉確認後決定是否進入 test。`monitor.enabled: false` 或使用者說「不要監控」時跳過監控，直接告知使用者手動檢查。
6. 錯誤處理依 `references/clients.md` 的錯誤處理章節。
7. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。

### test

1. 確認 `.lat/workspace/<TASK_ID>/` 中 code_executor 的 task 與 result 狀態皆為 `completed`。
2. 依 `test_executor` 的 client 類型啟動測試 agent（zmx session）。

   首次 test_executor prompt（`agent_id` = `test_executor_1_<task_id>`）：

   ```
   [<agent_id>] Read the spec at <spec_file> and the test targets in <plan_file>. Following the three-tier-testing skill, write and run integration tests and E2E tests for the implemented code. Use sub-agents to parallelize independent test writing when beneficial. Do not write or modify unit tests. If tests fail, fix the implementation code and re-run until all tests pass. Run unit tests to confirm no regressions before finishing. E2E tests go in the project's E2E test directory (tests/e2e/ or <frontend>/tests/e2e/). When finished, upsert your result into .lat/workspace/<task_id>/results.yaml and update your exact entry in .lat/workspace/<task_id>/tasks.yaml to the same final status following the yaml-schema — task_id is '<task_id>', agent_id is '<agent_id>'.
   ```

3. 先將 test task 以 `status: running` 附加到該 task ledger，再依 `references/clients.md` 監控；接收 Final Answer，並以 tasks/results 中精確匹配的狀態判斷成功、部分完成或失敗。
4. test_executor 全部通過後，將 qa task 以 `status: running` 附加到同一 ledger，再依 `qa_executor` client 啟動獨立驗收（`agent_id` = `qa_executor_<instance>_<task_id>`；首次 instance 為 1，每次修正後重新驗收時啟動新的 Agent Session 並增加 instance）。

   qa_executor prompt：

   ```
   [<agent_id>] Read the spec at <spec_file> and its acceptance checklist (QA). Following the three-tier-testing skill, launch and drive the real application as a user would, and verify each acceptance item by observing actual behavior — do NOT rely on the existing test suite. Use sub-agents to parallelize independent checklist items when beneficial. For every checklist item, write an E2E test in tests/qa_e2e/ (or <frontend>/tests/qa_e2e/) that encodes the acceptance criterion, run it against the real application, and record the result. Do not modify implementation code or existing test files. Write your results to .lat/workspace/<task_id>/qa-results.md — report each item as PASS or FAIL with evidence (command + output/log/screenshot); for FAIL include expected versus observed. Also upsert your result into .lat/workspace/<task_id>/results.yaml and update your exact tasks.yaml entry to the same final status — task_id is '<task_id>', agent_id is '<agent_id>'.
   ```

5. 讀取 `.lat/workspace/<task_id>/qa-results.md`：
   - **全部 PASS** → 進入 report。
   - **有 FAIL** → 啟動新的 `test_executor` Agent Session 修正（`agent_id` = `test_executor_<instance>_<task_id>`，instance 使用該 phase 的下一個序號）。

   修正 test_executor prompt：

   ```
   [<agent_id>] Acceptance verification failed. Read the spec at <spec_file> for requirements context, and read .lat/workspace/<task_id>/qa-results.md for the failed items and evidence. Fix the implementation code so the real application satisfies these items. Re-run the failing tests in tests/qa_e2e/ to verify your fix, then run unit tests to confirm no regressions. Do not modify test files in tests/qa_e2e/. When finished, upsert your result into .lat/workspace/<task_id>/results.yaml and update your exact tasks.yaml entry to the same final status — task_id is '<task_id>', agent_id is '<agent_id>'.
   ```

6. qa_executor 監控同樣必須接收 Final Answer；驗收狀態以該 task directory 的 tasks/results ledger 與 `qa-results.md` 為準。test_executor 修完後回到步驟 4（qa_executor 重新驗收）。
7. 迴圈直到 qa_executor 全部 PASS，或達到重試上限（`test.max_retries` / `test.max_retries_per_task`）。超過上限時暫停，向使用者報告失敗細節與證據。
8. tui client 時告知使用者可用指令：`zmx attach <session>`（即時檢視）、`zmx list`（所有工作階段）、`Ctrl+\`（脫離 attach 不終止）。
9. 中斷時依 `references/clients.md` 的中斷防護與 Session 恢復流程處理。

### report

向使用者報告最終狀態：需求摘要、交付內容、`git diff` 變更範圍、逐條 QA 驗收項的結果與證據（指令 + 輸出）、測試結果、變更檔案清單。

### status

1. 掃描 `.lat/workspace/<TASK_ID>/`；task directory 不存在表示沒有該任務，既有 workspace 的 `tasks.yaml`／`results.yaml` 內容為 `[]` 視為正常空 ledger，任一 ledger 遺失、空字串或無法解析則回報狀態損壞，不得自行重建或重設。
2. 依 `task_id` 摘要 pending、running、completed、failed、partial 與結果歷史。
3. 執行 `zmx list`，顯示 `cx-` / `cc-` 工作階段狀態。

### clean

1. 不重設或刪除任何 task directory 的 `tasks.yaml`、`results.yaml` 或 `qa-results.md`。
2. 以 `trash-put` 清理 `.lat/workspace/*/prompts/` 中超過 `prompts.retention_days`（預設 7）天的暫存 prompt。
3. 以 `trash-put` 清理 `.lat/logs/` 中超過 `logs.retention_days`（預設 60）天的檔案。

### purge

只有使用者明確指定 `purge <TASK_ID>` 時，驗證 TASK_ID 後才可用 `trash-put` 刪除 `.lat/workspace/<TASK_ID>/`。一般 `clean` 永不刪除 task ledger。

## Sub-Agent 異常診斷

任何 phase 的 sub-agent（spec_reviewer、plan_writer、plan_reviewer、code_executor、test_executor、qa_executor）回報工具相關錯誤時，適用本流程。

### 核心原則

- **不信 sub-agent 的自我診斷。** Sub-agent 回報「沒有權限」「沒有此工具」「工具不可用」時，視為待驗證，不視為事實。常見原因是工具呼叫參數錯誤，sub-agent 誤判為權限問題。
- **不代做。** Dispatch 絕對不接手 sub-agent 的任務。即使 sub-agent 看起來卡住，也只能診斷與通知，不可自行執行該 phase 的工作內容。

### 診斷流程

```
1. 驗指令 → 確認 Dispatch 下的啟動指令正確
2. 查 Session → 讀取 sub-agent 的原始 Session JSONL，找到實際錯誤訊息
3. 通知    → 把真正的錯誤原因告訴 sub-agent，讓它自行修正
```

**步驟 1 — 驗指令：**
確認啟動指令的 permission / sandbox flag、model、prompt 格式皆正確。若指令本身有誤，修正後重新啟動 sub-agent。

**步驟 2 — 查 Session：**
`.lat/logs/` 不是完成或診斷的主要來源。必須直接讀取主機上 CLI 工具的完整原始 Session JSONL。

每個 phase 的啟動 prompt 皆以 `[<agent_id>]` 開頭（如 `[test_executor_1_2026-07-09-user-api-spec]`），因此可用 `agent_id` 在 session 目錄中精確定位對應的 session 檔案。

定位 session 檔案：

- **Codex：**
  依 `references/clients.md`「Session 恢復」中的嚴格候選流程，只接受 user prompt 以 `[<agent_id>]` 開頭的本地與 UTC 今天／前一天 JSONL，再人工確認唯一檔案；不得使用只搜尋 agent ID 子字串的 `grep ... | head -1`。

- **Claude Code：**
  session 索引在 `~/.claude/sessions/<pid>.json`，內含 `name`（即 `agent_id`）與 `sessionId`。
  ```bash
  AGENT_ID="<agent_id>"
  jq -r --arg name "$AGENT_ID" 'select(.name == $name) | .sessionId' ~/.claude/sessions/*.json
  ```
  人工確認唯一的 `sessionId` 後，讀取對應的 JSONL：
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

- tui → 先用檔案編輯 API 將訊息寫入安全的 `MESSAGE_PATH`，再執行 `zmx send <session> "$(cat -- "$MESSAGE_PATH")$(printf '\r')"`
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
