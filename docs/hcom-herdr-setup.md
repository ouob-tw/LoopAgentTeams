# HCOM 自動使用目前 HERDR workspace

HCOM 維持 auto 模式，由 Herdr preset 直接讀取呼叫端的 `HERDR_WORKSPACE_ID`；不必先查 workspace 清單或傳入 `HERDR_WS`。

## 設定

在 `~/.hcom/config.toml` 的既有 `[terminal]` 保留 `active = "default"`，並新增或替換以下 preset，保留其他設定：

```toml
[terminal.presets.herdr]
open = ["sh", "-c", "exec herdr tab create --no-focus --workspace \"$HERDR_WORKSPACE_ID\" \"$@\"", "hcom-herdr", "--cwd", "{cwd}", "--label", "{instance_name}"]
close = ["herdr", "pane", "close", "{pane_id}"]
binary = "herdr"
pane_id_env = "HERDR_PANE_ID"
```

`sh -c` 展開 workspace 環境變數；工作目錄與名稱透過獨立參數傳入，避免被當作 shell 程式執行。需要 `sh`、HCOM 與 Herdr，現行 preset 不再使用 `herdr-ws.sh` 或 jq。

Agent 照常執行 HCOM，模型與權限參數沿用 LAT 設定：

```bash
hcom 1 codex --name <自身名稱> <client參數>
```

HCOM auto 選到 Herdr 時，新分頁建立於呼叫端 workspace，並保留 UI 焦點。這裡的 workspace 是呼叫來源，不是 UI 當下有焦點的位置。手動指定 Herdr 卻沒有 `HERDR_WORKSPACE_ID` 時，建立會報錯。

舊 `scripts/herdr-ws.sh` 保留供既有設定使用；其 `HERDR_WS` 名稱／編號查詢行為不適用此 preset。
