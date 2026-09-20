# HCOM 指定 HERDR workspace

使用 wrapper 串接，無須修改 HCOM 或 HERDR 本體。需要 Bash、jq、HCOM，以及支援 `tab create --workspace` 的 HERDR（本機為 0.9.0）。

## 安裝

在本專案根目錄執行；已有同名腳本時先備份：

```bash
mkdir -p "$HOME/.hcom"
if [ -f "$HOME/.hcom/herdr-ws.sh" ]; then
  cp -p "$HOME/.hcom/herdr-ws.sh" "$HOME/.hcom/herdr-ws.sh.bak.$(date +%s)"
fi
install -m 755 scripts/herdr-ws.sh "$HOME/.hcom/herdr-ws.sh"
```

在 `~/.hcom/config.toml` 新增或修改以下區塊，保留其餘設定，勿重複新增同名區塊。將 `/home/swy` 換成實際家目錄的絕對路徑：

```toml
[terminal.presets.herdr]
open = ["/home/swy/.hcom/herdr-ws.sh", "--cwd", "{cwd}", "--label", "{instance_name}"]
close = ["herdr", "pane", "close", "{pane_id}"]
binary = "herdr"
pane_id_env = "HERDR_PANE_ID"
```

本機已完成以上設定。用法與預設行為見 [LAT Agent 設定](../skills/local/lat/references/agents.md#herdr-workspace)；範例中的名稱、ID 與 client 參數須替換後執行。

## 驗證

- `bash -n scripts/herdr-ws.sh`：檢查語法。
- 焦點在 B 時指定 A 的 ID，確認新 Agent 位於 A；`HERDR_WS=` 時確認位於 B。
- 無效目標須報錯，不能在其他 workspace 建立；建立時維持原焦點。

目前已通過語法與 7 項模擬測試（ID 優先、名稱、編號、未設定、空值、無效目標）；尚未建立實際 Agent 驗證 HCOM 完整流程。
