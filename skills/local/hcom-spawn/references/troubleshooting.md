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

- 有進展就維持目前 effort；單次測試失敗不算卡住。同一問題試過兩種不同方法仍無新進展才算卡住。
- 後端預設（`gpt-6.1-sol`）卡住時：`medium` → `high`（接回同一個 session），`high` 仍卡住就換 `gpt-6-astra` `high`，不先試 Sol 更高級別。換模型照下方「換模型交接」。Astra `high` 仍卡住，回報使用者決定換新上下文或拆小任務。
- 其他模型卡住時升一級：`low → medium → high → xhigh`，只用該模型支援的級別。`xhigh` 或最高可用級別仍卡住，回報使用者決定換模型、換新上下文或拆小任務。
- 使用者指定的模型不自行替換，指定的 effort 上限優先。
- 缺資訊、帳號、權限或環境問題，先處理阻礙，不靠加 thinking 重試。新任務回到起始 effort；使用者明定的 effort 上限優先。

選定更高 effort 後，由召喚者保留原對話升級：

1. 記下 Agent 名稱、session ID、工作目錄、未提交成果及原 model／effort／權限，保存失敗證據、已排除的方法與下一個待驗證假設。
2. `hcom kill <名稱> --name <自身名稱>` 關閉該 Agent，確認舊程序已退出；只操作自己召喚的目標，不關整組。
3. 依 [接回已關閉的 Agent](../SKILL.md#接回已關閉的-agent) 的 client 指令，以新 effort 接回**同一個 session**，並完成該節的畫面、transcript 與對話延續核對。
4. 核對通過後，把步驟 1 的接續資訊送回原 Agent，繼續待驗證假設。只有接回失敗或新 effort 無法生效，才記錄錯誤與核對結果、確認失敗程序已退出，帶著成果位置、失敗證據、已排除方法及下一個假設召喚新 Agent 接手。

### 換模型交接

HCOM 接回同一個 session 時換模型尚未驗證，所以換模型改用新 Agent 接手：

1. 保存交接：目標與限制、任務／worktree 歸屬、原 session ID 與 transcript 位置、未提交成果、失敗證據、已排除的方法、下一個待驗證假設。
2. `hcom kill <名稱> --name <自身名稱>` 關閉舊 Agent，確認程序已退出。
3. 以新模型與 effort 啟動新 Agent，照「啟動後核對」確認模型、effort、權限，再送出交接，確認它從交接的下一步接續。

## 召喚者身分掉線

自己的 HCOM 身分掉線時，用 `hcom start --as <自身名稱> --name <自身名稱>` 恢復，再從最後已處理的事件往後補讀 `hcom events` 與相關 transcript，核對哪些 Agent 還開著、哪些回報漏掉了，才繼續指揮。

## Codex 額度與換帳號

- **查額度與帳號**：`codex-multi-auth check` 查即時額度，`codex-multi-auth status` 核對 current／pinned 帳號。要確認受影響的 Agent 用的是哪個帳號，不能把目前的全域選擇當成它啟動時的帳號。
- **辨識額度耗盡**：`hcom term <名稱>` 的畫面上，Codex 本輪出現 `You've hit your usage limit` 就是額度用完；Claude 本輪錯誤含 `usage limit` 同樣視為額度耗盡。
- **確認停止**：畫面同時出現 `0% left` 與 `usage limit` 才算確認停工。只有 `0% left` 或 HCOM 顯示 idle 時，還要核對本輪與工具執行狀態；還在工作就繼續等，無法確認就不切換也不重啟。
- **Codex 自動換帳號**：額度耗盡時不必等使用者選擇，直接換到另一個還有額度的訂閱帳號（`status` 標為 `OAUTH`）並續接，換完再回報使用者換了哪個帳號。不換到 API 計費帳號；不執行 `resets redeem`，也不把 `resets auto` 改成自動，兌換 reset 由使用者決定。
- **換帳號續接**（僅 Codex 外部 Agent）：本輪已明確停止、任務未完成且確認是額度造成時，先記下 session ID、工作目錄、未提交成果與原本的 model／effort／權限參數；`hcom kill <名稱> --name <自身名稱>` 結束舊程序並確認退出，再 `codex-multi-auth switch <n>` 並核對帳號，然後依 SKILL.md 的「接回已關閉的 Agent」以原 session ID 續接。
- **同帳號補到額度**：確認額度恢復後，把接續位置傳給停工的 Agent，先試直接續作。
- 兩種恢復方式都要確認實際工作進展，不能只看額度數字。
- **全部訂閱帳號都沒額度，或 Claude 額度耗盡**：保留成果並回報使用者，由使用者決定等待、兌換 reset 或其他做法。
