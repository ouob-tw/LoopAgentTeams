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

## 其他會讓 Agent 停住的狀態

- `blocked: approval pending`：該 Agent 在等使用者核准工具呼叫，到它的視窗處理。
- `listening: wake unacknowledged`（`detail` 為 `delivery paused; kill and resume this agent to retry`）：訊息投遞已暫停，需 `hcom kill <名稱>` 後 `hcom r <名稱>` 才會恢復。
