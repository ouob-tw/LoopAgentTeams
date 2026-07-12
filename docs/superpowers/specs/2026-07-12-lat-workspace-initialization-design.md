# LAT Workspace 提前初始化與 Code 預設模型設計

## 目標

Spec 草稿建立且檔名確定後，立即以 Spec 檔名（不含副檔名）作為 `TASK_ID`，建立 `.lat/workspace/<TASK_ID>/` 與空的 `tasks.yaml`、`results.yaml`、`prompts/`。Dispatch 不再建立或重設 ledger，只在已驗證的 `tasks.yaml` 加入第一筆 `code_executor` task。

`code_executor` 的內建預設改為 `codex-tui`、`gpt-5.6-luna`、`high`、`danger-full-access`。

## Ledger 語意

Ledger 沿用金融分類帳的核心含意：它是權威、持久且可追溯的紀錄。LAT 的 lifecycle ledger 並非嚴格不可變事件帳本；同一筆 executor task 可更新 status，但完成的 round 不刪除，新一輪以新的 `agent_id` 追加。

- `tasks.yaml` 保存 executor 各 round 的生命週期。
- `results.yaml` 保存 executor 各 round 的結果。
- Spec reviewer 與 plan writer 不加入 ledger；其 Final Answer 仍由 Session Monitor 交給 Dispatch。
- `prompts/` 是可依 retention 清理的暫存資料，不屬於 ledger。

## 初始化與恢復

Spec writer 完成草稿後：

1. 從 Spec 檔名取得並驗證安全 `TASK_ID`。
2. 若 task workspace 不存在，建立目錄、`prompts/`，並將兩個 ledger 初始化為 `[]`。
3. 若 task workspace 已存在，解析並驗證兩個 ledger；不得清空、覆寫或刪除既有歷史。
4. 初始化完成後才啟動 spec reviewer。

Dispatch 必須確認 workspace 與兩個 ledger 已存在且可解析，再以唯一 `agent_id` 附加 code task。缺少或損壞時暫停，不得自行重建以掩蓋狀態遺失。

## 驗收

- Skill contract test 證明 workspace 初始化位於 Spec 草稿與 spec review 之間。
- Dispatch 契約只驗證既有 ledger 並附加 task，不重設為 `[]`。
- Client config 範例與內建預設表的 code model/effort 均為 `gpt-5.6-luna`／`high`。
- README 與 YAML schema 對 ledger 的金融類比、可變範圍和初始化時點說法一致。
- Repo/installed skills 同步，Monitor regression tests 與 skill loader 全部通過。
