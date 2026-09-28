# Agent 設定

召喚 Agent、選模型與 effort、啟動與核對、存活、額度與關閉的做法一律呼叫 /hcom-spawn，這裡不重複。本文件只放 LAT 在 hcom-spawn 之上改動或多加的規則。

hcom-spawn 裡的「自身名稱」就是發起委派的那一方：主控派工時是主控自己的 HCOM 名稱；執行 Agent 再委派時同樣呼叫 /hcom-spawn，自身名稱是執行 Agent 自己的名稱。

## 在 LAT 內與 hcom-spawn 不同之處

- hcom-spawn 要求「回報使用者」的地方，執行 Agent（含再委派時）改回報召喚它的一方，最終到主控；主控在既有授權內處理，超出授權才依 SKILL.md 的使用者待決規則詢問使用者。額度耗盡後等待或換帳號仍由使用者決定。主控向使用者回報時照樣附上還開著的 Agent。
- hcom-spawn 開頭「改呼叫 /lat」的指引不適用，已經在 LAT 流程內。
- 關閉時機不等使用者說「收掉」，改依下方「收尾」。

## 派工

- 外部 Agent 的第一則任務訊息照 /hcom-spawn 的固定欄位寫，再補上 SKILL.md「交接」要求的項目。
- 每項任務用自己的 tag 主題，同一個 tag 不跨任務共用，關閉整組時才不會誤關其他任務的 Agents。
- 執行 Agent 卡住時，由召喚它的一方（通常是主控）依 /hcom-spawn 的升級規則提高 effort；到最高可用 effort 仍卡住，交回主控決定換模型、新 context 或拆小任務。

## 存活與恢復

- Agent 沉默時，先讀它的任務卡，確認已完成工作、下一步及資源歸屬，再依 /hcom-spawn 查執行狀態。
- 內建 Agent 沒有 HCOM 畫面：查 client 提供的狀態與任務卡，仍不清楚就直接傳訊詢問，不讀取完整 subagent transcript 檔案，以免塞滿主控 context。
- 主控的 HCOM 身分掉線時，依 /hcom-spawn 恢復並補讀漏掉的事件後，再核對任務卡與 `.lat/decisions/` 待決紀錄才續作。

## 收尾

- 主控記錄本次 LAT 建立的 HCOM Agent 名稱與 tag。執行 Agent 再委派後，把新 Agent 的名稱與 tag 回報主控；這些 Agent 以執行 Agent 的名稱開頭，主控只能靠回報的紀錄找到它們。
- 執行 Agent 保存成果、清理自己的測試資源並回報後待命，不自行關閉。
- 主控依 [任務收尾](task-cards.md#任務收尾) 的時機，依 /hcom-spawn 以 tag 逐組關閉該任務記錄的 Agents（含再委派的），核對都已停止，同步完成清理與歸檔。
- 只關閉本次 LAT 記錄的 Agents；名稱前綴相同但不在紀錄裡的（例如同一主控先前的 LAT 或 hcom-spawn 協作）一律保留。
