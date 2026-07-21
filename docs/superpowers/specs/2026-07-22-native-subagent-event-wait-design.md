# 內建 Subagent 事件驅動等待設計

## 背景

LoopAgentTeams 目前已處理外部 CLI client 的啟動、Session Monitor 與等待節奏。本次不再修改 CLI Monitor。

剩餘問題是：當 Dispatch 所在宿主本身就能以內建 subagent 呼叫相同模型家族時，不應再透過 CLI 建立另一個 agent session，也不應在派發後頻繁查詢 subagent 狀態。

本設計將同宿主派發改為內建 subagent，並採事件驅動等待：Dispatch 派發工作後直接等待完成訊息或 mailbox 通知；只有等待機制明確失敗或逾時時，才執行一次診斷性狀態檢查。

## 目標

- Codex Dispatch 呼叫 GPT／Codex worker 時，使用 Codex 內建 subagent 系統。
- Claude Code Dispatch 呼叫 Claude worker 時，使用 Claude Code 內建 subagent 系統。
- Dispatch 派發內建 subagent 後直接等待通知，不固定週期查詢狀態。
- 保留既有 phase、agent identity、prompt、ledger、審查裁決與結果驗證契約。
- 外部 CLI client 的啟動、監控、Session JSONL 與等待節奏保持不變。

## 非目標

- 不修改 `monitor-session.sh` 或 `run-exec-client.sh`。
- 不改變外部 `codex-exec`、`codex-tui`、`claude-exec`、`claude-tui` 的監控契約。
- 不新增固定五分鐘輪詢。
- 不改變 executor 寫入 `tasks.yaml`、`results.yaml` 或 `qa-results.md` 的責任。
- 不改變各 phase 的 model、effort、permission 預設值。

## 派發路由

Dispatch 在每次啟動 worker 前，先比較目前宿主與目標模型家族：

| Dispatch 宿主 | 目標 worker | 派發方式 |
| --- | --- | --- |
| Codex | GPT／Codex | Codex 內建 subagent |
| Claude Code | Claude | Claude Code 內建 subagent |
| Codex | Claude | 既有 Claude CLI client |
| Claude Code | GPT／Codex | 既有 Codex CLI client |

同宿主派發時，內建 subagent 優先於同模型家族的 CLI client。跨宿主派發仍依既有 client 設定與 CLI 流程執行。

## 等待契約

### Codex

1. Dispatch 以內建 subagent 工具建立 worker，保留既有 `agent_id` 與英文任務 prompt。
2. 派發後呼叫內建等待機制，等待 mailbox 更新或 worker Final Answer。
3. 等待期間不以 `list_agents` 或其他狀態工具固定輪詢。
4. worker 完成訊息抵達後，Dispatch 讀取結果，並依角色契約繼續審查、ledger 交叉確認或下一 phase。

### Claude Code

1. Dispatch 以內建 Agent／subagent 工具建立 worker，保留既有 `agent_id` 與英文任務 prompt。
2. 若以前景模式執行，Dispatch 直接等待 Agent 呼叫完成。
3. 若以背景模式執行，Dispatch 使用內建 completion notification 或 blocking output wait 等待結果。
4. 等待期間不固定查詢 task status。

### 禁止行為

- 不因「想知道是否還在執行」而反覆列出 agent 狀態。
- 不在等待期間改讀外部 CLI Session JSONL 推測內建 subagent 是否完成。
- 不把五分鐘設為正常輪詢週期；內建等待應在通知抵達時立即返回。

## 完成與結果判定

內建 subagent 的完成通知只代表該 turn 已結束。不同角色仍維持原有完成權威：

- `spec_reviewer`、`plan_writer`、外部 `plan_reviewer`：以 subagent Final Answer 交回 Dispatch 處理。
- `code_executor`、`test_executor`、`qa_executor`：Dispatch 收到完成通知後，仍須精確比對該 `task_id`／`agent_id` 的 ledger 狀態。
- `qa_executor`：除 ledger 外仍須讀取 `qa-results.md`，不得只根據通知宣告 QA 通過。

因此，事件通知取代的是「等待與頻繁查狀態」，不取代既有結果驗證。

## 異常處理

- 等待工具明確逾時：允許執行一次狀態檢查，判斷 worker 是否仍在執行、已失敗或通知遺失。
- 收到 worker 工具錯誤：沿用 Sub-Agent 異常診斷契約，不由 Dispatch 接手 worker 任務。
- worker 仍在執行且沒有確認錯誤：重新進入 blocking wait，不開始短週期輪詢。
- worker 已結束但沒有可用 Final Answer：依宿主的內建 subagent 診斷資料處理，不套用外部 CLI JSONL Monitor 契約。
- 內建 subagent 能力不可用：如實回報阻塞；不得靜默退回同宿主 CLI，除非使用者明確允許。

## 文件與契約邊界

`lat-dispatch/SKILL.md` 應描述宿主路由、內建等待與 phase 行為；`references/clients.md` 保留外部 CLI 細節，並清楚註明其監控章節不適用於內建 subagent。README 若描述 client／agent 呼叫方式，也應同步更新，避免繼續把同宿主派發描述成 CLI 呼叫。

既有 CLI scripts 不因本功能修改。Contract tests 應以靜態契約檢查與宿主能力測試，證明同宿主路由不會落入 CLI 啟動指令。

## 驗收清單（QA）

### Q1：Codex 同宿主派發

**使用者行為：** 在 Codex 中啟動一個目標為 GPT／Codex 的 LAT worker。

**預期：** worker 由 Codex 內建 subagent 建立；不啟動 `codex exec`、Codex TUI、zmx 或 Session Monitor。

**測試／證據：** 宿主能力測試記錄內建 spawn 呼叫與 worker Final Answer，並確認沒有 CLI 啟動指令或 PID／zmx session。

### Q2：Claude Code 同宿主派發

**使用者行為：** 在 Claude Code 中啟動一個目標為 Claude 的 LAT worker。

**預期：** worker 由 Claude Code 內建 Agent／subagent 建立；不啟動 `claude --print`、Claude TUI、zmx 或 Session Monitor。

**測試／證據：** 宿主能力測試記錄內建 Agent 呼叫與完成結果，並確認沒有 CLI 啟動指令或 PID／zmx session。

### Q3：等待期間不輪詢

**使用者行為：** 啟動一個需要數分鐘才完成的內建 subagent。

**預期：** Dispatch 在 subagent 完成前保持 blocking wait；期間沒有固定週期的 agent status 查詢，完成通知抵達後立即繼續。

**測試／證據：** 工具事件序列只包含 spawn、blocking wait、完成通知與後續結果處理；不含等待期間重複的 agent-list/status 呼叫。

### Q4：等待異常後恢復等待

**使用者行為：** 讓內建等待工具逾時，但 worker 仍正常執行。

**預期：** Dispatch 只做一次診斷性狀態檢查，確認 worker 存活後重新進入 blocking wait，不轉為短週期輪詢，也不重複派發 worker。

**測試／證據：** 工具事件序列顯示一次 timeout、一次狀態診斷、同一 worker 的下一次 blocking wait，以及唯一一份完成結果。

### Q5：Executor 結果仍由 ledger 驗證

**使用者行為：** 內建 executor 回傳 Final Answer，但尚未寫入正確的 ledger 完成狀態。

**預期：** Dispatch 不進入下一 phase，並依既有契約要求 executor 修正或回報失敗。

**測試／證據：** 驗收測試建立 Final Answer 與 ledger 不一致情境，證明流程停在目前 phase。

### Q6：跨宿主 CLI 行為不變

**使用者行為：** 在 Codex 中派發 Claude worker，或在 Claude Code 中派發 GPT／Codex worker。

**預期：** 沿用既有外部 CLI client、Monitor、完成與恢復契約。

**測試／證據：** 現有 CLI contract 與 Monitor 測試全部通過，且相關 scripts 無功能性 diff。
