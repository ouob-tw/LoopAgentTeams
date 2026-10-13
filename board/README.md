# LAT 看板

在一個網頁看所有專案的 LAT 主控：名冊、狀態、目前階段與待決題數，資料變動後自動更新。電腦與手機共用同一個網址。

連線沒有加密，裝置配對只擋得住沒有配對碼的人；只應在內網或私人網路使用，需要加密時請自行在前面加反向代理。

## 需要

- Bun（安裝套件、執行主機指令與測試）與 Node 22 以上（執行伺服器）。
- 已安裝的 LAT 技能，以及它使用的 `uv` 與 Python：看板不自己讀寫問題檔，一律呼叫技能裡的面板輔助工具。

## 啟動

在本目錄執行：

```bash
bun install
bun run build
bun run board start --port 7100   # 預設監聽 0.0.0.0:7100，可加 --host
```

## 配對與撤銷

每台裝置第一次開啟會看到配對畫面。在主機上執行：

```bash
bun run board pair            # 印出一組配對碼：只能用一次，5 分鐘內有效
bun run board devices         # 列出已配對的裝置（ID、配對時間、瀏覽器）
bun run board revoke <ID>     # 撤銷一台裝置，它會回到配對畫面
```

## 設定

都是環境變數，啟動伺服器與執行主機指令時要一致。

| 變數 | 用途 | 預設 |
| --- | --- | --- |
| `HOST`、`PORT` | 監聽位址與連接埠（也可用 `start` 的 `--host`、`--port`） | `0.0.0.0`、`7100` |
| `LAT_BOARD_LAT_DIR` | LAT 技能目錄 | `~/.agents/skills/lat` |
| `LAT_BOARD_HELPER_COMMAND` | 直接指定輔助工具指令（JSON 字串陣列），看板會在後面加上 `board list` 等參數 | 由技能目錄組出 |
| `LAT_BOARD_STATE_DIR` | 看板自己的狀態目錄（已配對裝置、配對碼） | `$XDG_STATE_HOME/lat/board` |
| `LAT_REPORTS_DIR` | 主控回報紀錄目錄，須與 LAT hook 寫入的位置相同 | `$XDG_STATE_HOME/lat/reports` |
| `LAT_BOARD_FALLBACK_SECONDS` | 沒有偵測到檔案變動時，隔多久重讀一次；上限 60 | `60` |
| `LAT_BOARD_HELPER_TIMEOUT_SECONDS` | 輔助工具多久沒回應就放棄 | `15` |
| `LAT_BOARD_PAIRING_TTL_SECONDS` | 配對碼有效時間 | `300` |

`XDG_STATE_HOME` 未設定時是 `~/.local/state`。

## 資料怎麼更新

伺服器監看面板綁定登記、各主控的問題檔與回報紀錄目錄，有變動才重讀，正常在 5 秒內推到所有開著的頁面。漏掉變動時由保底重讀補上，最慢 60 秒；畫面上的「重新整理」會立即重讀。連線中斷時畫面會提示，並自動重連。

## 開發與測試

```bash
bun run dev -- --host 0.0.0.0 --port 7110
bun run check
bun run test        # 先 build，再以暫存目錄與假的輔助工具啟動伺服器
```

測試不讀寫真實的 `.lat/`、綁定登記或回報紀錄。測試伺服器使用 7110 起的連接埠，可用 `LAT_BOARD_TEST_PORT_BASE` 更改。
