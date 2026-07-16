# LAT Plan Reviewer 預設 Self 設計

## 目標

將 `plan_reviewer` 的預設 client 改為 `self`，由目前執行 LAT 的 Dispatch Agent 親自完整審查外部 `plan_writer` 產出的 Plan，同時保留使用者覆蓋為外部 client 的能力。

## 設計

- `plan_reviewer.client` 的內建預設改為 `self`。
- self 模式下，Dispatch 讀取 approved Spec、Plan、使用者決策及相關程式碼，執行完整 Plan review。
- Dispatch 不直接修改 Plan；finding 必須包含穩定 ID、嚴重度、主張、具體證據與建議，並交回原 `plan_writer` Session 修正。
- writer 修正並自檢後，Dispatch 重新完整審查，直到通過或遇到需要使用者決策的問題。
- self 模式不建立 `plan_reviewer` Agent ID、prompt file、PID、Session 或 Monitor，也不寫 task ledger。
- 使用者將 `plan_reviewer.client` 覆蓋為 `codex-exec`、`claude-exec` 或其他外部 client 時，沿用既有 report-only reviewer、Monitor、finding adjudication 與 review round 流程。
- config 中既有 model、effort、permission 在 self 模式忽略，僅供外部 client override 使用。
- `spec_reviewer` 維持獨立外部 client，不在本次變更範圍。

## QA

1. 未設定覆蓋時，contract 顯示 `plan_reviewer.client: self`，Dispatch 完整審查且不啟動外部 reviewer 資源。
2. 使用者指定外部 plan reviewer 時，既有 external prompt、report-only、Monitor、finding 與修正迴圈仍可使用。
3. self 與 external 模式都不得由 reviewer 直接修改 Plan，也不得把 review 工作寫入 task ledger。
4. 既有 spec review、plan writer、Monitor、PID 與 Context7 契約沒有退化。
