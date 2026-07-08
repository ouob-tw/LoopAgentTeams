---
name: loop-runner
description: "執行 LoopAgentTeams 佇列任務：讀取 tasks.yaml、依計劃實作、寫入 results.yaml、清除已處理任務。適用於任何 Code Agent Client。"
compatibility: "任何 Code Agent Client（Claude Code、Codex CLI 等）。需要 shell 存取與含 .loop/ 的專案工作區。"
---

# Loop Runner

執行 `.loop/tasks.yaml` 的已核准實作任務，通常由 `loop-dispatch` 啟動。

## 適用時機

- 提示詞包含 `loop-runner`
- 被要求處理 `.loop/tasks.yaml` 或 `.loop/results.yaml`
- 在 `loop-dispatch` 啟動的工作階段內執行

## 執行邊界

- 僅執行已核准的實作任務。不處理規格審查或計劃審查。
- 處理完當前佇列後正常退出。不建立背景守護程序或長期監聽器。

## 處理流程

1. 讀取 `.loop/tasks.yaml`。
2. 檔案遺失、空、或 `[]` → 輸出 `No pending tasks`，exit code `0` 退出。
3. YAML 解析失敗 → 依 `references/yaml-schema.md` 的解析錯誤處理流程。
4. 由上而下處理任務，每個任務依照以下檢查清單執行：

```
- [ ] 讀取任務的 goal、context、constraints
- [ ] 若有 plan_file → 讀取計劃檔案，確認階段順序
- [ ] 判斷是否匹配可用領域技能，匹配時載入
- [ ] 依計劃階段順序（或 goal）執行實作
- [ ] 在 results.yaml 頂部插入結果（使用相同 task_id）
- [ ] 從 tasks.yaml 移除此任務
```

補充規則：
- 有 `context.plan_file` 時，**必須先讀取計劃**，依定義的階段順序執行。每個階段完成後專案應可執行。
- 無計劃檔案的簡單任務：依 `goal` 直接執行。
- 技能不得擴大任務範圍；與 `constraints` 衝突時以 `constraints` 為準。
- 從 `tasks.yaml` 移除已處理任務（不論完成、部分完成、或失敗）。保留未處理任務。

## 結果狀態

| 狀態 | 意義 |
|------|------|
| `completed` | 任務目標完全實現 |
| `partial` | 部分實現；`summary` 須說明已完成與未完成範圍 |
| `failed` | 未完成；`errors` 須包含至少一個 `{code, message}` 物件 |

## 後續任務

- 僅在大型任務需拆分且剩餘工作可追蹤時才新增。
- `task_id` 格式：`task-{unix_ms}-{random_hex_3}`，`created_by` 填入目前 agent 的識別名稱。
- 僅限實作任務，不新增審查類任務。

## 完成輸出

- 無任務 → `No pending tasks`，exit code `0`。
- 有任務 → 輸出各狀態計數（processed / completed / partial / failed）與修改檔案清單。
- 處理完成後不保持 zmx 工作階段。

## 注意事項

- 不要跳過或重新排序計劃中的階段。
- 結果寫入規則、YAML 欄位順序、空狀態處理、解析錯誤備份流程皆參見 `references/yaml-schema.md`。
