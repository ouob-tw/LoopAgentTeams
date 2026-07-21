# 同宿主內建 Subagent

只有 Dispatch 宿主與目標模型家族相同時才讀取本文件。跨宿主派發沿用 `references/clients.md` 的外部 CLI 流程。

| Dispatch 宿主 | 目標模型家族 | 派發方式 |
| --- | --- | --- |
| Codex | GPT／Codex | Codex 內建 subagent |
| Claude Code | Claude | Claude Code 內建 subagent |
| Codex | Claude | 既有 Claude CLI client |
| Claude Code | GPT／Codex | 既有 Codex CLI client |

同宿主仍保留已解析的 phase、model、effort、permission、`agent_id` 與 prompt 契約，但以宿主支援的內建欄位傳遞。內建 subagent 不建立 prompt file、PID、zmx session 或 CLI Session JSONL，也不啟動 `monitor-session.sh`。

## Model 保真

派發前先解析 phase 的目標 model，並用內建工具可接受的欄位明確傳入；不得以不同 model 靜默執行。

- Claude Code：將設定 ID 映射到 `Agent.model` alias：`claude-fable-5` → `fable`、`claude-sonnet-5`／`claude-sonnet-4-6` → `sonnet`、`claude-opus-4-6`／`claude-opus-4-8` → `opus`。完成後檢查回傳的 `resolvedModel`；若宿主版本未回傳該欄位，改查 child transcript 的 model 欄位。若不屬於目標 model，phase 失敗並如實回報。
- Codex：內建工具若提供 model／reasoning effort 欄位，必須明確傳入。若工具只允許繼承宿主 model，派發前必須確認宿主 model 與 phase 目標相同，並從可用的 runtime evidence 驗證 child 實際 model；無法保證時回報阻塞，不得未經授權改走同宿主 CLI。

## 身分對應

canonical `agent_id` 與內建 runtime handle 是不同識別值。canonical `agent_id` 固定保留在 prompt、`tasks.yaml`、`results.yaml` 與 QA evidence；內建工具回傳的 agent ID／path 只用於等待、續傳與通知，不得寫回 ledger 取代 canonical `agent_id`。

- Codex：`spawn_agent.task_name` 由 canonical `agent_id` 正規化，將非 `[a-z0-9_]` 字元轉成 `_`；若名稱已存在則加數字後綴。保存 spawn 回傳的 runtime agent ID／path，且不得用正規化後的 task name 改寫 ledger `agent_id`。
- Claude Code：在 `Agent.description` 與 prompt 前綴保留 canonical `agent_id`，並保存 `Agent` 回傳的 `agentId` 供 background wait、resume 或診斷使用；不得假設該 `agentId` 等於 canonical `agent_id`。

## Codex 內建等待

1. 以 `spawn_agent` 建立 subagent；task name 使用上述安全正規化值，prompt 維持以 `[<agent_id>]` 開頭。
2. 派發後以 `wait_agent` 等待 mailbox 更新或完成通知。使用該工具支援的長等待時間，通知抵達時立即返回。
3. 等待期間不以 `list_agents` 固定輪詢。只有 `wait_agent` 明確逾時或回報異常時，才只做一次診斷性狀態檢查；subagent 仍在執行且沒有確認錯誤時，重新進入 blocking wait。
4. 收到 Final Answer 後依角色契約處理；executor 仍須交叉確認精確匹配的 task/result ledger。

## Claude Code 內建等待

1. 以 Claude Code 內建 `Agent` 建立 subagent；傳入上節映射後的 `model`，description 與 prompt 維持 canonical `[<agent_id>]`，runtime `agentId` 另行保存。
2. 前景 Agent 直接等待工具完成。背景 Agent 等待 completion notification；需要主動取得輸出時使用 blocking `TaskOutput`。
3. 等待期間不以 non-blocking `TaskOutput` 固定輪詢。只有內建等待明確逾時或回報異常時，才只做一次診斷性狀態檢查；subagent 仍在執行且沒有確認錯誤時，重新進入 blocking wait。
4. 收到 Final Answer 後先依 Model 保真章節驗證 child model，再依角色契約處理；executor 仍須交叉確認精確匹配的 task/result ledger。

內建 subagent 的完成通知取代外部 Session Monitor 的等待與完成判定，但不取代 Reviewer adjudication、executor ledger 或 QA evidence。內建工具不可用時如實回報阻塞；除非使用者明確允許，不得靜默退回同宿主 CLI。
