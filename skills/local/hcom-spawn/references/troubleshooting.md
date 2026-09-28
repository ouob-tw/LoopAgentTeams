# Agent 沉默、卡住、額度與身分恢復

召喚者用的處理程序。

## 存活檢查

Agent 久無回應時，依序：

1. `hcom list -v --name <自身名稱>` 看狀態與未讀數，分辨 active、listening、blocked。
2. `hcom term <名稱> --name <自身名稱>` 看畫面，確認是在工作、停在確認畫面，還是本輪出現錯誤。
3. 需要看它做了什麼就 `hcom transcript <名稱> --last 30 --name <自身名稱>`，不要整份讀完塞滿自己的上下文。
4. 仍不清楚就直接傳訊問進度（`--intent request`）。還在工作就繼續等，不重啟。

判斷依據取自畫面上**本輪**的內容，歷史殘留訊息不算。

## 卡住時升級 effort

- 有進展就維持目前 effort；單次測試失敗不算卡住。
- 同一問題試過兩種不同方法仍無新進展，升一級：`low → medium → high → xhigh`，只用該模型支援的級別。
- 升級時把失敗證據、已排除的方法與下一個待驗證假設交給新設定；client 無法原地改 effort 時，帶著這些資訊召喚新 Agent 接手。
- `xhigh` 或最高可用級別仍卡住，回報使用者決定換模型、換新上下文或拆小任務；使用者指定的模型不自行替換。
- 缺資訊、帳號、權限或環境問題，先處理阻礙，不靠加 thinking 重試。新任務回到起始 effort；使用者明定的 effort 上限優先。

## 召喚者身分掉線

自己的 HCOM 身分掉線時，用 `hcom start --as <自身名稱> --name <自身名稱>` 恢復，再從最後已處理的事件往後補讀 `hcom events` 與相關 transcript，核對哪些 Agent 還開著、哪些回報漏掉了，才繼續指揮。

## Codex 額度與換帳號

- **查額度與帳號**：`codex-multi-auth check` 查即時額度，`codex-multi-auth status` 核對 current／pinned 帳號。要確認受影響的 Agent 用的是哪個帳號，不能把目前的全域選擇當成它啟動時的帳號。
- **辨識額度耗盡**：`hcom term <名稱>` 的畫面上，Codex 本輪出現 `You've hit your usage limit` 就是額度用完；Claude 本輪錯誤含 `usage limit` 同樣視為額度耗盡。
- **確認停止**：畫面同時出現 `0% left` 與 `usage limit` 才算確認停工。只有 `0% left` 或 HCOM 顯示 idle 時，還要核對本輪與工具執行狀態；還在工作就繼續等，無法確認就不切換也不重啟。
- **等或換由使用者決定**：額度耗盡時先保存成果並回報使用者，等使用者選擇等待恢復、換帳號或其他做法。有適用的明確既有授權就遵照，不自行切換帳號。
- **換帳號續接**（僅 Codex 外部 Agent）：使用者已選擇換帳號、本輪已明確停止、任務未完成且確認是額度造成時，先記下 session ID、工作目錄、未提交成果與原本的 model／effort／權限參數；`codex-multi-auth switch <n>` 後核對帳號，`hcom kill <名稱> --name <自身名稱>` 結束舊程序，確認退出後依 SKILL.md 的「接回已關閉的 Agent」以原 session ID 續接。
- **同帳號補到額度**：確認額度恢復後，把接續位置傳給停工的 Agent，先試直接續作。
- 兩種恢復方式都要確認實際工作進展，不能只看額度數字。
- **全部帳號都沒額度**：保留成果並回報使用者，等處理。
