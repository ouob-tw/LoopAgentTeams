# Agent 設定

## 模型與 effort

使用者指定優先；未指定時，前端任務預設使用 `claude-opus-5`，後端任務預設使用 `gpt-6-astra`。其他或混合任務由 Orchestrator 依任務與 client 能力選擇模型。明確傳入模型 ID 與 effort，不依賴隱含預設。

| 模型 ID | 起始 effort |
| --- | --- |
| `gpt-6-astra` | `low` |
| `gpt-5-sol` | `medium` |
| `claude-sonnet-5` | `medium` |
| `claude-opus-5` | `medium` |

這是常用預設，不是白名單。使用者指定列表外模型時，先用工具查 client 的可用模型，必要時查官方文件，確認正確 ID、可用性與支援的 effort。能唯一對應就使用；有歧義或無法使用才詢問，不擅自換模型。其他模型從 `medium` 起；不支援時使用已查證的可用預設並說明。

## 卡住時升級

- 有進展就維持目前 effort；單次測試失敗不算卡住。
- 同一問題試過兩種不同方法仍無新進展，由 Orchestrator 升一級：`low → medium → high → xhigh`，僅使用模型支援的級別。
- 升級時交付失敗證據、已排除的方法與下一個待驗證假設。client 無法原地調整時，帶交接資訊建立新 Agent。
- `xhigh` 或最高可用級別仍卡住，交回 Orchestrator 決定換模型、新 context 或拆小任務；使用者指定的模型不自行替換。
- 缺資訊、帳號、權限或環境問題，先處理阻礙，不靠增加 thinking 重試。新任務回到起始 effort；使用者明定的 effort 限制優先。

## 啟動設定

外部 Agent 經 HCOM 啟動，將以下參數傳給對應 client：

| Client | 模型與 effort | 預設權限參數 |
| --- | --- | --- |
| Codex | `--model <ID> -c 'model_reasoning_effort="<effort>"'` | `--yolo` |
| Claude Code | `--model <ID> --effort <effort>` | `--dangerously-skip-permissions` |

Codex 的 `--yolo` 同時關閉確認與 sandbox。這些啟動設定不擴大任務授權範圍。

原生 Subagent 使用 client 支援的模型、effort 與權限欄位；權限受宿主限制，不能把 CLI 參數寫進 prompt 就當作生效。原生機制無法套用必要設定時，改用可支援的 HCOM 外部 Agent；仍不可用則回報 Orchestrator。

啟動或升級後，從工具回傳、session 資訊或啟動紀錄核對模型、effort 與權限模式。未能確認的設定明確標示，不宣稱已生效；再委派時附上本文件。

## Codex 額度與換帳號

- **查額度與帳號**：`codex-multi-auth check` 即時查額度，再用 `codex-multi-auth status` 核對 current／pinned 帳號；須確認受影響 Agent 使用哪個帳號，不能將目前全域選擇當成舊程序的帳號。
- **辨識額度耗盡**：用 `hcom term <agent> --name <自身名稱>` 查看畫面。Codex 本輪顯示 `You've hit your usage limit` 即代表額度用完；Claude 完整訊息尚未確認，但 client 本輪錯誤含 `usage limit` 同樣視為額度耗盡，不把歷史殘留訊息當成本輪錯誤。
- **確認停止**：目前畫面同時出現 `0% left` 與 `usage limit`，即可確認 Agent 因額度耗盡停工，進入換帳號流程。只有 `0% left` 或 HCOM idle 時仍須核對本輪與工具執行狀態；仍在工作就繼續等，無法確認也不切換或重啟。下列帳號切換指令僅適用 Codex。
- **換帳號續接**：僅在本輪已明確停止、任務未完成且確認因額度無法續作時，記下 session ID、工作目錄、未提交成果及原 model／effort／權限；`codex-multi-auth switch <n>` 後核對帳號，再以 `hcom kill <agent> --name <自身名稱>` 結束舊程序，確認退出後用 `hcom r <session-id> --name <自身名稱> <原 client 參數>` 續接。明確指定原 session，不用 `--last`。
- **同帳號補額度**：確認額度恢復後，向已停工的 Agent 發送接續位置，先嘗試直接續作。兩種恢復方式都須確認實際工作進展，不能只看額度數字。
- **全部帳號無額度**：保留成果並回報使用者，等待處理。

## HERDR workspace

HCOM 使用 `--terminal herdr` 時，透過已安裝的 `herdr-ws.sh` 指定位置：

```bash
herdr workspace list
HERDR_WS=<workspace_id> hcom 1 codex --terminal herdr --name <自身名稱> <client參數>
```

- 使用清單中的 ID；亦支援名稱／編號，ID 優先。模型、effort 與權限參數沿用上方設定。
- 未設定或空字串（`HERDR_WS=`）會使用所連線 HERDR server 當下有焦點的 workspace；建立後不切換焦點。需要預設行為時先清除先前 export 的值。
- 找不到指定目標就報錯；`--dir` 只設定程序目錄，不決定 workspace。
- `HERDR_WS` 是 wrapper 的環境變數，不是 HCOM 的 `--workspace` 選項；不以代表呼叫端位置的 `HERDR_WORKSPACE_ID` 自動代入。

## HCOM 收尾

- Orchestrator 記錄本次 LAT 建立的 HCOM Agent 名稱，包含再委派建立的 Agents。
- 執行 Agent 保存成果、清理自己的測試資源並回報後待命，不自行關閉。
- Orchestrator 確認成果與交接完成、沒有後續任務後，用 `hcom kill` 關閉並確認結果。只關閉本次 LAT 建立的 Agents，保留使用者原有或其他流程的 Agents。
