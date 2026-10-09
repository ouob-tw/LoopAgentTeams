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
