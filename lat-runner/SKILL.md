---
name: lat-runner
description: "Execute one approved task from .lat/workspace/<TASK_ID>/tasks.yaml, persist its result and lifecycle status without deleting history, then exit. Use when the prompt contains lat-runner or names a LAT TASK_ID ledger. Typically launched by lat-dispatch."
compatibility: "Any Code Agent client with shell access and a project workspace containing .lat/workspace/<TASK_ID>/."
---

# LAT Runner

執行 `.lat/workspace/<TASK_ID>/tasks.yaml` 中一筆精確匹配 `agent_id` 的已核准實作任務，通常由 `lat-dispatch` 啟動。

## 執行邊界

- 僅執行已核准的實作任務。不處理規格審查或計劃審查。
- 一次只處理 prompt 指定的 `TASK_ID` 與 `agent_id`，不得掃描或執行其他 task directory。
- 完成後正常退出。不建立背景守護程序或長期監聽器。
- `TASK_ID` 必須符合安全 slug：只允許英數、`.`、`_`、`-`，不得為 `.`、`..`，不得含 `/`。

## 處理流程

1. 驗證 prompt 指定的 `TASK_ID` 與 `agent_id`，讀取 `.lat/workspace/<TASK_ID>/tasks.yaml` 與 `results.yaml`。
2. 任一 ledger 遺失、空字串、格式錯誤，或找不到精確 `agent_id` → 依 `references/yaml-schema.md` 回報非零錯誤，不建立或清空檔案。
3. 若已存在相同 `task_id + agent_id` 的 `completed` result，但 task 尚非 `completed`，只將 task 原子更新為 `completed`，不重做實作。
4. task 必須是 `pending` 或可恢復的 `running`；`partial`、`failed`、`completed` 不直接重做，交由 Dispatch 建立下一個 agent instance。
5. 將 task 原子更新為 `running`，再依以下檢查清單執行：

```
- [ ] 讀取任務的 goal、context、constraints
- [ ] 若有 plan_file → 讀取計劃檔案，確認階段順序
- [ ] 判斷是否匹配可用領域技能，匹配時載入
- [ ] 依計劃階段順序（或 goal）執行實作
- [ ] 以相同 task_id + agent_id 原子 upsert results.yaml
- [ ] 將 tasks.yaml 中同一筆 task 原子更新為相同最終 status
```

補充規則：
- 有 `context.plan_file` 時，**必須先讀取計劃**，依定義的階段順序執行。每個階段完成後專案應可執行。
- 無計劃檔案的簡單任務：依 `goal` 直接執行。
- 技能不得擴大任務範圍；與 `constraints` 衝突時以 `constraints` 為準。
- 不刪除任何 task 或 result 歷史。
- 每次寫回先在同目錄建立暫存檔，完整解析並驗證後以 `mv` 原子替換目標檔。
- result 先寫、task status 後寫；若兩步間中斷，下次依精確 completed result reconciliation，不重複執行。
- `partial` 或 `failed` 寫回後立即退出並保留該 task；Dispatch 決定是否新增下一個 agent instance。

## 結果狀態

| 狀態 | 意義 |
|------|------|
| `completed` | 任務目標完全實現 |
| `partial` | 部分實現；`summary` 須說明已完成與未完成範圍 |
| `failed` | 未完成；`errors` 須包含至少一個 `{code, message}` 物件 |

## 後續任務

- 僅在大型任務需拆分且剩餘工作可追蹤時才新增。
- 沿用相同 `task_id`（Spec 檔名），由 Dispatch 在同一 `tasks.yaml` 新增遞增 instance 的 `agent_id`（如 `code_executor_2_<task_id>`），`created_by` 填入 Dispatch 識別名稱。
- 僅限實作任務，不新增審查類任務。

## 完成輸出

- 精確 task 不存在或不可執行 → 輸出錯誤並非零退出。
- 有任務 → 輸出最終 status、修改檔案清單與 ledger 路徑。
- 處理完成後不保持 zmx 工作階段。

## 注意事項

- 不要跳過或重新排序計劃中的階段。
- ledger 寫入、reconciliation、遷移、欄位順序與解析錯誤流程皆參見 `references/yaml-schema.md`。
