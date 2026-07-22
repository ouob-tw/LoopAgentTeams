# pilotfish 與 LoopAgentTeams 比較審查

日期：2026-07-22

## 審查基準

- pilotfish：`Nanako0129/pilotfish`，審查 commit `4d65cc94b59acec2debec37983ad0a021440d643`，最新 release `v1.3.0`。
- LoopAgentTeams：本機 `HEAD` 為 `1f52921ea514437c8f9caa38af297c188f93ddc3`；比 `origin/main` 的 `543160864a212ea62dca1fcc9d2a2411a1cc6aee` 多 2 個提交，已包含 native subagent 完成事件等待設計。
- pilotfish 的 19 個 policy tests 在審查時通過。
- LoopAgentTeams 的 `skill-contract`、`monitor-session`、`exec-client` 與 `native-subagent-contract` 四套契約測試在保存本文件前重新執行並全部通過。

## 結論

pilotfish 並不是 LoopAgentTeams 的直接替代品：

- pilotfish 是 Claude Code 的全域角色、成本路由與驗證政策。
- LoopAgentTeams 是跨 Claude/Codex、可恢復、有持久化 ledger，涵蓋 Spec、Plan、實作、測試與 QA 的完整工作流引擎。

最適合的演進方向是保留 LoopAgentTeams 的狀態持久化、跨宿主、長任務監控與 QA 閉環，再吸收 pilotfish 的任務分級、最小權限、派發煞車、獨立驗證與公開 benchmark。

## 核心差異

| 面向 | pilotfish | LoopAgentTeams | 判定 |
| --- | --- | --- | --- |
| 定位 | 全域 orchestration policy | 完整 SDD 執行生命週期 | 不同層級 |
| 宿主 | Claude Code 為主 | Claude Code、Codex 與其他 skills host | LoopAgentTeams 勝 |
| 任務路由 | scout、mechanical、judgment、security、verifier | spec、code、test、QA 等固定 phase | pilotfish 分工更細 |
| 狀態保存 | 幾乎沒有；依賴 Claude harness | TASK_ID、tasks/results、原子寫入與 reconciliation | LoopAgentTeams 明顯勝 |
| 長任務 | 超過 10 分鐘交回 orchestrator | zmx、CLI session、JSONL monitor、resume | LoopAgentTeams 明顯勝 |
| 權限隔離 | read-only allowlist、leaf agent、禁止 verifier 修改 | reviewer 唯讀，但 code/test/QA 多為完整權限 | pilotfish 勝 |
| 品質閉環 | fresh-context verifier 嘗試推翻成果 | integration/E2E、獨立 QA 與修正迴圈 | 各有所長 |
| 小任務成本 | 有 dispatch brake，小任務直接執行 | 啟動 LAT 後原則上完整跑完流程 | pilotfish 勝 |
| 平行寫入 | writer 獨立 worktree，明確 harvest | 允許 executor 再派 subagent，但缺少統一隔離契約 | pilotfish 勝 |
| 安裝複雜度 | 三層全域設定，無 runtime code | 需要 jq、uuidgen、trash-cli、zmx 與 client CLI | pilotfish 較輕 |
| 專案污染 | 不寫入專案 | 每個專案建立 `.lat/` | 視需求 |
| 可稽核性 | 公開研究、benchmark 與失敗紀錄 | 契約測試強，但缺少公開成本與成功率資料 | pilotfish 勝 |
| 故障恢復 | 主要靠 model alias/fallback | transcript、PID、session、ledger 與 retry instance | LoopAgentTeams 勝 |

## pilotfish 值得吸收的優點

### P0：加入真正的最小權限角色

目前 LAT 的 `qa_executor` 在 prompt 中禁止修改實作，但預設仍使用 `danger-full-access`。這是「規則要求唯讀，能力卻允許寫入」。

建議將權限拆成能力 profile：

- `read_only_reviewer`
- `read_run_verifier`
- `workspace_writer`
- `full_system_executor`

QA/verifier 原則上只能讀檔、啟動應用、執行測試，以及寫入指定的 QA evidence/test 目錄，不得修改 implementation。應優先採用工具 allowlist 或 sandbox 強制邊界，而不是只靠 prompt。

### P0：加入 dispatch brake 與 LAT Lite

完整 LAT 適合重大功能，但對修字、單檔 bug 或已知修法的 finding 過重。建議提供兩條明確路徑：

- `LAT Full`：架構、跨模組、高風險、需求不明或需要正式 QA。
- `LAT Lite`：範圍明確、小型、低風險；省略獨立 Spec/Plan 文件，但仍保存 goal、done criteria、測試及結果紀錄。

派發前應比較模型成本、上下文保存、平行化與獨立驗證收益，是否大於上下文重建、協調與整合成本。

### P1：由 phase 選模型進化為工作型態選角色

建議增加以下邏輯角色：

- `scout`：低成本、唯讀搜尋。
- `mechanical_executor`：文件、rename、模式化修改。
- `judgment_executor`：需要局部設計判斷。
- `security_reviewer` / `security_executor`：安全分析與安全實作分離。
- `outcome_verifier`：只驗證，不修正。

流程文字只引用角色，角色再映射到 provider-specific model profile，避免模型名稱改版時同步修改多處契約：

```yaml
roles:
  scout:
    tier: cheap
    effort: low
    permission: read-only
  mechanical_executor:
    tier: standard
    effort: low
  judgment_executor:
    tier: strong
    effort: medium
```

### P1：限制 subagent 深度並隔離平行寫入

LAT 允許 executor 在有利時再派 subagent，但目前缺少一致的最大深度、檔案 ownership、worktree 隔離、harvest 與衝突整合契約。

建議預設：

- executor 最多派一層 worker，worker 不得再派。
- 每個 writing worker 必須有 exclusive owned paths。
- 兩個以上 writing workers 必須使用獨立 worktree。
- Dispatch 明確負責 harvest、衝突判定與最終 diff。

### P1：在 QA 之外增加反證型 verifier

LAT 的 QA 強項是逐條驗收規格，但仍可能漏掉 Spec 本身錯誤、非預期 regression、安全繞過、跨模組資料邊界或只覆蓋 happy path 的測試。

建議在高風險或非 trivial 任務加入 fresh-context outcome verifier：

```text
test_executor -> qa_executor -> outcome_verifier -> report
```

verifier 只輸出 `CONFIRMED` 或 `REFUTED` 以及證據，不允許自行修正。小任務應跳過此階段，避免驗證成本高於風險。

### P2：建立可重現 benchmark 與現場數據

建議建立固定 fixtures，比較：

- inline 單 agent
- LAT Lite
- LAT Full
- 同宿主 native subagent
- 跨宿主 CLI
- 中斷後 resume
- QA fail -> repair -> pass

每次至少記錄成功率、總時間、token/cost、重試數、人工介入次數及 ledger 完整性，並保留失敗 run 與未覆蓋範圍，避免把 contract test 說成完整 runtime E2E 證明。

## pilotfish 不宜照搬的缺點

1. **Claude Code 綁定太深**：model alias、`~/.claude/agents`、`CLAUDE.md` 與 Agent tool allowlist 都是 Claude-specific；LAT 不應犧牲跨 Claude/Codex 的優勢。
2. **大量關鍵行為仍是 policy prose**：worktree、dispatch brake、結果收集與 long-process handoff 多半依賴模型遵守文字；policy tests 不等於所有 runtime 路徑都已實測。
3. **沒有 durable execution state**：缺少 LAT 的 `task_id + agent_id`、results-first reconciliation、歷史 instance 與 QA evidence。
4. **沒有自動修復閉環**：verifier 回覆 `REFUTED` 後仍需主 agent 自行重新規劃，不像 LAT 已定義 QA FAIL、修正與重新驗收流程。
5. **全域安裝風險**：修改 `~/.claude/settings.json`、`~/.claude/agents/` 與全域 `CLAUDE.md`，可能發生角色名稱衝突、managed policy 覆蓋或影響所有專案。
6. **長任務處理弱於 LAT**：超過十分鐘就交回 orchestrator，沒有 zmx attach、JSONL completion contract、STALL/DRIFT、PID 與 session resume。
7. **成本主張具有供應商時效性**：Sonnet quota、`best` alias 與各模型成本差異可能隨 Anthropic 計費及 Claude Code 行為改變。

## LoopAgentTeams 優先改進清單

1. 收緊 `qa_executor` 與 verifier 權限。
2. 增加小任務快速路徑，避免完整 LAT 對簡單修改過重。
3. 補齊 subagent 深度、ownership、worktree 與 harvest 契約。
4. 將 phase/model 綁定改為 `scout/mechanical/judgment/security` 等角色路由。
5. 在高風險任務加入獨立反證型 outcome verifier。
6. 增加 `lat doctor` preflight，一次檢查 CLI、版本、zmx、jq、trash-put 與 native-subagent 支援。
7. 建立公開的成本、時間、成功率與 resume benchmark。
8. 若要發布目前尚未推送的 native-subagent 設計，先確認本機提交範圍並完成遠端同步與 release 驗證。

## 建議架構

```text
Task classifier
|-- small/stable -> LAT Lite / inline
`-- material/risky
    |-- cheap read-only scout
    |-- Spec + Plan + adjudication
    |-- role-based executor
    |   |-- mechanical
    |   |-- judgment
    |   `-- security
    |-- integration/E2E repair loop
    |-- independent QA
    |-- fresh-context outcome verifier
    `-- durable ledger + report
```

## 一句話總評

pilotfish 比 LAT 更擅長節省模型成本、角色分工、權限限制與控制派發成本；LoopAgentTeams 比 pilotfish 更擅長可靠完成、恢復、測試、修正大型任務並留下可稽核紀錄。LAT 應吸收前者的決策層，而不應放棄自己的執行層。

## 參考資料

- [pilotfish repository](https://github.com/Nanako0129/pilotfish)
- [pilotfish roles and workflow](https://github.com/Nanako0129/pilotfish/blob/4d65cc94b59acec2debec37983ad0a021440d643/README.md#L49-L102)
- [pilotfish design rationale](https://github.com/Nanako0129/pilotfish/blob/4d65cc94b59acec2debec37983ad0a021440d643/docs/design.md)
- [pilotfish orchestration policy](https://github.com/Nanako0129/pilotfish/blob/4d65cc94b59acec2debec37983ad0a021440d643/templates/claude-md.orchestration.md)
- [pilotfish benchmarks](https://github.com/Nanako0129/pilotfish/tree/4d65cc94b59acec2debec37983ad0a021440d643/benchmarks)
- [LoopAgentTeams workflow](../lat-dispatch/SKILL.md)
- [LoopAgentTeams ledger schema](../lat-runner/references/yaml-schema.md)
- [LoopAgentTeams native subagent contract](../lat-dispatch/references/native-subagents.md)
