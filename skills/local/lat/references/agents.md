# Agent 設定

模型與 effort 預設、卡住時升級、啟動參數與核對、tag、存活檢查與身分恢復、Codex 額度與換帳號、HERDR workspace、HCOM 關閉指令，一律呼叫 /hcom-spawn，這裡不重複。原生 Subagent、HCOM 外部 Agent 與各階段內部再委派都適用。本文件只放 LAT 在 hcom-spawn 之上多加的規則。

hcom-spawn 裡的「自身名稱」就是發起委派的那一方：主控派工時是主控自己的 HCOM 名稱，執行 Agent 再委派時是執行 Agent 自己的名稱。

## 派工

- 外部 Agent 的第一則任務訊息照 /hcom-spawn 的固定欄位寫，再補上 SKILL.md「交接」要求的 Spec／Ticket 位置、驗收條件、授權、任務卡與決策目錄路徑。
- 執行 Agent 卡住時，依 /hcom-spawn 的升級規則處理；到最高可用 effort 仍卡住，交回主控決定換模型、新 context 或拆小任務，主控在既有授權內裁決，超出授權才問使用者。

## 存活與恢復

- Agent 沉默時，先讀它的任務卡，確認已完成工作、下一步及資源歸屬，再依 /hcom-spawn 查執行狀態。
- 內建 Agent 沒有 HCOM 畫面：查 client 提供的狀態與任務卡，仍不清楚就直接傳訊詢問，不讀取完整 subagent transcript 檔案，以免塞滿主控 context。
- 主控的 HCOM 身分掉線時，依 /hcom-spawn 恢復並補讀漏掉的事件後，再核對任務卡與 `.lat/decisions/` 待決紀錄才續作。

## 收尾

hcom-spawn 預設等使用者說「收掉」才關 Agent；LAT 改由流程決定時機：

- 主控記錄本次 LAT 建立的 HCOM Agent 名稱，包含執行 Agent 再委派建立的 Agents；執行 Agent 再委派後，把新 Agent 名稱回報主控。
- 執行 Agent 保存成果、清理自己的測試資源並回報後待命，不自行關閉。
- 主控依 [任務收尾](task-cards.md#任務收尾) 的時機，用 /hcom-spawn 的關閉方式逐一關閉該任務記錄的 Agents 並核對已停止，同步完成清理與歸檔。
- 只關閉本次 LAT 建立的 Agents。名稱前綴相同但不在本次紀錄裡的（例如同一主控先前的 LAT 或 hcom-spawn 協作），以及使用者原有或其他流程的 Agents，一律保留。
