# HCOM 建立 HERDR Agent 的 workspace 路由研究

後續已完成 wrapper 修改與模擬測試；目前安裝方式見 [設定教學](hcom-herdr-setup.md)。以下保留修改前研究紀錄。

研究日期：2026-09-18。範圍是確認現況與提出修改方式；未修改執行環境，未建立 Agent 或分頁。

## 結論

HERDR 已支援 `tab create --workspace <ID>`。建議沿用目前 HCOM 的 `HERDR_WS` 明確指定機制，補上 workspace ID 的精確比對，保留既有名稱與編號相容性。未提供 `HERDR_WS` 時，不傳 `--workspace`，由 HERDR 使用當下的 active workspace。

不要自動改用 `HERDR_WORKSPACE_ID` 作為 fallback：HERDR 會將這個環境變數注入其終端，代表呼叫來源的 workspace；若直接繼承，就會把「未指定」解讀成「回到呼叫來源」，不符合本次要求的「使用者當前激活 workspace」。此環境變數的注入行為由主研究者查閱本機 `herdr --skill` 確認。

## 已確認的現況

- 本機 HCOM 版本為 `0.7.25`，可執行檔是 `/home/swy/.local/bin/hcom`；`/home/swy/hcom` 目前為空目錄。
- `/home/swy/.hcom/config.toml:62–66` 的 `herdr` preset 呼叫 `/home/swy/.hcom/herdr-ws.sh`，傳入 `--cwd {cwd}` 與 `--label {instance_name}`。
- `/home/swy/.hcom/herdr-ws.sh:4–14` 執行 `herdr tab create --no-focus`；有 `HERDR_WS` 時，先查詢 workspace 清單，以不分大小寫的名稱或編號尋找目標，再傳入其 ID。目前沒有比對 `.workspace_id`，因此不能直接以 ID 選取。
- 既有 wrapper 找不到名稱或編號會報錯退出；重複名稱則以 `head -1` 取第一筆。
- 本機 `hcom 1 codex --help --name tomo` 列出 `--terminal`、`--dir` 等選項，未提供 HCOM 專用的 `--workspace`。`hcom config terminal --info --name tomo` 亦未列出 workspace placeholder。
- 主研究者確認 HERDR client 與 server 均為 `0.9.0`。官方 [CLI `tab create` 定義](https://github.com/herdrdev/herdr/blob/v0.9.0/src/cli/tab.rs#L53-L69) 支援 workspace 參數；[API 選取邏輯](https://github.com/herdrdev/herdr/blob/v0.9.0/src/app/api/tabs.rs#L47-L64) 優先採用明確 workspace，否則使用 server 的 active workspace，沒有 active workspace 時回傳錯誤。
- [API focus 處理](https://github.com/herdrdev/herdr/blob/v0.9.0/src/app/api/tabs.rs#L116-L118) 依 focus 參數決定是否切換焦點。因此選取建立位置與是否切換焦點是分開的行為。

## 最小修改方案

僅調整既有 wrapper 的 workspace 選取邏輯：

1. `HERDR_WS` 非空時，先精確比對 `.workspace_id`。
2. ID 未命中時，再沿用名稱或編號查找，維持相容性。
3. 找不到目標就報錯；禁止退回 active workspace，以免明確指定失敗後建立到錯誤位置。
4. `HERDR_WS` 未設定或為空時，省略 `--workspace`。
5. 保留 `--no-focus`、`--cwd`、`--label` 等既有參數。

預期使用方式如下；**ID 寫法需完成上述修改後才支援**，`wV` 僅為示例，應替換為實際 ID：

```bash
HERDR_WS=wV hcom 1 codex --terminal herdr --name tomo
```

預設行為則不指定 `HERDR_WS`；必須確定父層 shell 沒有殘留這個選擇值。工作目錄 `--dir` 與 HERDR workspace 是不同設定，不應以目錄推測視窗位置。

## 驗證計畫與目前限制

| 情境 | 預期結果 |
| --- | --- |
| 明確指定 A 的 ID，但使用者焦點在 B | Agent 建立於 A |
| 未設定或設為空的 `HERDR_WS`，B 為 active | Agent 建立於 B |
| 指定不存在的 ID | 報錯，任何 workspace 都不建立分頁 |
| 以既有名稱或編號指定 | 保留原有相容行為 |
| workspace A 搭配不同的 `--dir` | 分頁位於 A，程序工作目錄符合 `--dir` |
| 保留 `--no-focus` | 建立完成後不切走使用者原有焦點 |
| 多 Agent 指定同一 ID，期間切換焦點 | 所有 Agent 均建立於指定 workspace |

目前只有唯讀指令、現有設定與官方原始碼證據。尚未執行 Agent 建立，HCOM 到 wrapper 的 `HERDR_WS` 環境變數傳遞仍需 live smoke test；不可把預期用法描述成已通過實測。未指定 workspace 的預設值以 HERDR server 當下的 active workspace 為準。
