# Native Subagent Host Capability Smoke

本 smoke 驗證實際宿主工具事件，不以文件 grep 取代。從目標宿主啟動測試；測試 child 不修改檔案，不得啟動同模型家族 CLI、zmx、PID runner 或 `monitor-session.sh`。

每次執行保存：宿主、model、canonical `agent_id`、runtime handle、起訖時間、工具事件順序、Final Answer marker，以及 repo `git status --short`。結果寫入 `native-subagent-smoke-results-<date>.md`。

## Codex：完成通知

1. 以 `spawn_agent` 建立 read-only child，要求回覆唯一 marker `CODEX_NATIVE_COMPLETION_OK`。
2. 直接呼叫 `wait_agent` 等待通知，不呼叫 `list_agents`。
3. 記錄 `spawn_agent → wait_agent → completion notification` 與 child Final Answer。
4. 確認期間沒有 `codex exec`、Codex TUI、zmx、PID file 或 Session Monitor。

## Codex：等待逾時後恢復

1. 以 `spawn_agent` 建立需超過第一個 wait window 才完成的 read-only child，marker 為 `CODEX_NATIVE_REWAIT_OK`。
2. 第一次 `wait_agent` 使用最短支援 window，確認回傳 timeout。
3. 只呼叫一次 `list_agents` 診斷同一 runtime handle，然後重新呼叫 blocking `wait_agent`。
4. 記錄 `spawn_agent → wait timeout → one diagnostic → wait_agent → completion notification`；確認只有一個 child 與一份 Final Answer。

## Claude Code：完成通知

1. 從 `claude-fable-5` Claude Code 宿主以內建 `Agent` 建立 read-only background child，明確傳入 `model: fable`；canonical `agent_id` 保留在 child prompt 的 `[<agent_id>]` 前綴，要求回覆唯一 marker `CLAUDE_NATIVE_COMPLETION_OK`。
2. 等待 completion notification；若需取回輸出，只使用 blocking `TaskOutput`，不使用 non-blocking status polling。
3. 記錄 `Agent(async_launched) → completion notification`、runtime `agentId` 與 Final Answer。
4. 確認 child 的 `resolvedModel` 為 Fable；宿主未回傳該欄位時，以 child transcript 的 model 欄位驗證。另確認期間沒有 `claude --print`、Claude TUI、zmx、PID file 或 Session Monitor。

## Terra 真實 E2E

以 `gpt-5.6-terra` 作為獨立 E2E harness，載入 repo 的 `lat-dispatch`，實際驅動一個同宿主 Codex worker 完成 read-only 任務。驗證：

- 使用內建 `spawn_agent`／`wait_agent`，不得啟動同模型家族 CLI。
- 從 runtime evidence 驗證 native child 的實際 model 為 `gpt-5.6-terra`；若宿主工具無法保證或驗證，該項 FAIL。
- 等待期間沒有固定 `list_agents` 輪詢。
- Final Answer 後仍檢查 canonical `agent_id` 與 runtime handle 分離。
- repo 無非預期修改，CLI Monitor scripts 無 diff。

Terra 必須輸出逐項 PASS／FAIL、工具事件順序與具體證據；任一 FAIL 均阻止提交與第二輪 Reviewer。

若 parent 工具結果未公開 child model 或工具 trace，QA 可用 parent／child 的持久化 Codex Session JSONL 補充裁決；必須以 `session_meta.source.subagent.thread_spawn.parent_thread_id` 建立親子關係，再從 child `turn_context.model` 與工具事件驗證，不得只採信 parent 自述。
