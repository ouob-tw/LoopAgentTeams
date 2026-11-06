# 全員廣播攔截 hook

`scripts/block-broadcast.py` 是 PreToolUse hook：Agent 要執行的指令裡有不帶 `@` 對象的 `hcom send` 時擋下，並回覆改用 `@<名稱>` 或 `@<tag>-`。帶 `--thread` 的訊息只發給討論串成員，照常放行。HCOM 本身沒有關閉廣播的設定，所以由 hook 把關。

判斷時寧可多擋：`env echo hcom send` 這類被前綴包住的文字，或與 shell 同一行但其實沒被執行的 heredoc，也可能被擋。被誤擋時改寫指令即可，例如把文字加上引號。腳本讀不懂或出錯時，只要內容含 `hcom send` 就擋下。

先將 `skill_dir` 換成本技能實際安裝目錄的絕對路徑，再把下列 group 併入各 client 的 `PreToolUse` 陣列，保留既有 entries。

Claude Code（`~/.claude/settings.json` 的 `hooks`）與 Codex（`$CODEX_HOME/hooks.json` 的 `hooks`）寫法相同：

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "uv run --no-project python <skill_dir>/scripts/block-broadcast.py"
    }
  ]
}
```

- Claude Code 重啟後在 `/hooks` 確認。
- Codex 重啟後須在 `/hooks` 檢查並信任此 command；搬動技能或更新 command 後要重新信任。
- 已在執行的 Agent 不會套用，重啟後才生效。

驗證：在 Agent 內執行 `hcom send --name <自身名稱> -- test`，應被擋下且沒有訊息送出。

## 丟掉 listen 輸出的攔截

同一支 `scripts/block-broadcast.py` 也擋下輸出被丟掉的 `hcom listen`：listen 一收到訊息就返回並把訊息標為已讀，輸出沒被讀到，訊息就消失了。被擋的寫法：

- stdout 導向 `/dev/null`：`hcom listen 2 >/dev/null`、`hcom listen 2 > /dev/null 2>&1`、`&>/dev/null`。
- 只接 `tail`、`head` 或 `wc`：`hcom listen 2 | tail -1`。
- 包在 `$( )` 或反引號裡卻沒用到結果：當 `:`、`true` 的參數，或存進之後沒展開的變數。

輸出完整顯示、存到檔案或只丟 stderr（`2>/dev/null`）的 listen 照常放行；包在 `bash -c` 裡的不檢查。被擋時，要等訊息就直接跑 `hcom listen N` 並讀完輸出，要固定延遲就用 `sleep N`。不需另外安裝，裝了上面的 hook 就生效。

驗證：在 Agent 內執行 `hcom listen 1 --name <自身名稱> >/dev/null`，應被擋下並提示 `sleep N`。

## 開工確認攔截 hook

`scripts/block-start-ack.py` 也是 PreToolUse hook：被召喚的 Agent 對召喚它的主控（環境變數 `HCOM_LAUNCHED_BY`）發「收到」「開始做」這類只確認、沒有內容的訊息時擋下，並提示完成、卡住或有問題時再回報。主控閒置時每則訊息都會叫醒它，這類確認只會白花一輪。

擋下條件全部成立才擋：

- 收件人只有召喚者本人（`@<名稱>` 或其短名）；發給別人、群組、討論串或多個收件人都放行。
- 訊息文字寫在 `--` 後面；用 `--file`、`--base64` 或 stdin 送的不檢查。
- `--intent` 不是 `request`。`ack` 不算擋下理由，因為不少成果回報也用 `ack` 送。
- 文字只有確認詞（`Received`、`ok`、`收到`），或以開工、計畫的說法開頭（`Starting`、`I will`、`Accepted`、`Re-reviewing`、`開始`），且全文沒有成果、卡住或提問的字眼（`PASS`、`FAIL`、`done`、`blocked`、`found`、`no findings`、`quota`、`?`、`完成`、`卡住`、`確認` 等）。完整清單在腳本開頭。

判斷時寧可放行：讀不懂的指令、包在 `bash -c` 裡的指令、腳本出錯，一律放行。指令文字任何地方有 `ACK_GUARD=off` 就放行，所以被誤擋時，在指令前加 `ACK_GUARD=off` 重送即可，例如 `ACK_GUARD=off hcom send @<主控> --name <自身名稱> -- '<訊息>'`。

安裝方式同上，`PreToolUse` 再加一組 `matcher` 為 `Bash`、command 為 `uv run --no-project python <skill_dir>/scripts/block-start-ack.py` 的 group。

驗證：在被召喚的 Agent 內執行 `hcom send @<主控> --name <自身名稱> -- 'Starting now.'`，應被擋下且沒有訊息送出。
