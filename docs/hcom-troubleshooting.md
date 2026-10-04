# HCOM 排查：整組 Agent 閒置

## 輸入框有未送出的文字，訊息送不進去

現象：實作與審查的 Agent 都已回報完成並停在 `listening`，主控卻沒有接著動，整組停住。

原因：某個 Agent 的輸入框留著未送出的文字（例如誤按的一個字母）。HCOM 為了不蓋掉使用者正在打的字，這段期間不會把其他 Agent 的訊息送進去，該 Agent 因此收不到回報。

確認：

```bash
hcom list -v
```

該 Agent 會顯示 `listening: uncommitted text`，`detail` 為 `uncommitted text in prompt`。用 `hcom term <名稱>` 可看到 `prompt_empty=false` 與 `input_text` 的內容。

處理：到該 Agent 的視窗把輸入框清空或送出。也可由另一個 Agent 代為刪除，每個字元送一次退格：

```bash
hcom term inject <名稱> $'\x7f'
```

輸入框清空後，積壓的訊息會立刻送達。刪除前先確認那段文字不是使用者要送出的答覆。

實例：2026-10-03 主控輸入框留著一個「A」，實作者的第六輪審查結果約 14 分鐘送不進去；刪除後立即恢復。

## 狀態卡在「執行中」，訊息排隊送不進去

現象：Agent 其實已停在空的輸入框，HCOM 卻一直顯示 `active`。HCOM 以為它還在忙，不把新訊息送進去；等它回覆的一方也只會繼續等。

原因：Agent 回合結束後，又有工具或指令以它的名義改了 HCOM 狀態，之後沒有任何事件把狀態改回 `listening`。已知兩種觸發：

- **Codex 回合後的記憶整理**：Codex 結束可見的回合後自動整理記憶，整理用的工具把狀態改成 `active`，整理結束後沒有回到閒置的事件。
- **背景指令在回合結束後才 `hcom send`**：回合中開的背景指令比回合活得久，之後執行 `hcom send` 時把已經 `listening` 的狀態改成 `active tool:send`，但沒有新的回合會再把它改回來。

確認：

```bash
hcom list --json          # 該 Agent 為 active，紀錄很久沒變，unread_count 可能 > 0
hcom term <名稱> --json   # ready=true、prompt_empty=true、input_text 為空
```

處理：重送訊息沒有用，要直接在它的視窗輸入一句催促把它叫醒：

```bash
hcom term inject <名稱> 'You have unread hcom messages. Read them and continue.' --enter
```

送出後用 `hcom term <名稱>` 確認它開始新的一輪、讀了排隊的訊息。LAT 啟用時，停住監控（`lat-watch`）會在 `active` 且紀錄 20 分鐘沒變、畫面停在空輸入框時自動做這一步。

兩種觸發都已在 HCOM 0.7.27、Codex CLI 0.160.0 隔離重現，並回報上游（aannoo/hcom issue 151）。

實例：

- 2026-10-03 一位 Codex 審查者送出第一輪審查結果後跑了記憶整理，狀態停在 `active tool:Bash`。實作者的第二輪審查請求排隊約 33 分鐘沒送進去，主控重送也沒用；實作者用 `hcom term inject` 送一句催促後，它立即讀到請求並開始審查。
- 2026-09-30 一位 Codex 實作者回報「完整測試正在重跑，結果稍後回報」後結束回合，背景測試跑完時自己 `hcom send` 了一則完成通知，狀態因此變成 `active tool:send`。之後沒有新的回合，HCOM 顯示它在執行中約 75 分鐘，直到主控查看測試紀錄並 inject 催促，它才讀結果送出最終回報。

## 其他會讓 Agent 停住的狀態

- `blocked: approval pending`：該 Agent 在等使用者核准工具呼叫，到它的視窗處理。
- `listening: wake unacknowledged`（`detail` 為 `delivery paused; kill and resume this agent to retry`）：訊息投遞已暫停，需 `hcom kill <名稱>` 後 `hcom r <名稱>` 才會恢復。
