# 無人模式

無人模式下主控在使用者事先給的授權（無人授權）內推進，不發題問使用者。這份說明只講模式怎麼決定、授權怎麼建立與結束；主控與看板一律透過 `scripts/lat-unattended.py` 讀寫，不自己解析設定或授權檔。

## 模式從哪來

三層由窄到寬，每個值各自取最窄一層有寫的那層，都沒寫就用初始值：

1. 主控：自己 session 紀錄裡的 `unattended`，只屬於這一輪。
2. 專案：主工作區 `.lat/preauth.toml` 的 `[unattended]`；`mode = "follow-global"` 表示模式跟全域。
3. 全域：`$XDG_CONFIG_HOME/lat/preauth.toml` 的 `[unattended]`。

```toml
[unattended]
mode = "unattended"          # manual（人工確認）或 unattended；專案另可 follow-global
ticket_confirmation = true   # 短流程票代確認
assume_defaults = true       # 在固定清單內選預設
prototype_decide = true      # 做樣品再決定
max_hours = 12               # 時間上限（小時，整數）
```

初始值：人工確認、三項代決皆開、12 小時。額度用完一律停，不能關。任何一層的 `[unattended]` 寫錯時，模式一律視為人工確認，`status` 列出錯誤；這一段和預先授權共用檔案，寫錯也會讓預先授權查詢全部要問。

activate 會印出本輪模式與來源層；預設就是無人模式時另印「尚待目標」與寫入第 1 版的指令。

## 查詢

```bash
uv run --no-project python <lat 技能>/scripts/lat-unattended.py status [--json]
uv run --no-project python <lat 技能>/scripts/lat-unattended.py versions [--json]
uv run --no-project python <lat 技能>/scripts/lat-unattended.py check --version <N> [--at <ISO 時間>]
```

- `status`：模式、三項代決、時間上限，各附來源層（主控／專案／全域／初始值），以及授權狀態：
  - `無人授權有效`：本輪有生效中的版本，附到期時間。
  - `無人模式，尚待目標`：模式來自專案或全域預設，本輪還沒有第 1 版；這時不算有效授權，不得使用任何代決。
  - `無有效授權`：人工確認、授權已結束，或這一輪已停用；附最後一版的結束時間與原因。
- `versions`：本輪每一版的內容與生效期間。
- `check`：某一版在某個時間是否生效（預設現在），生效時結束碼 0，否則 1。代決紀錄引用版本時用它核對。

## 建立、修改、關閉

```bash
lat-unattended.py create --goal '<目標>' --done '<條件一>' --done '<條件二>' \
  --scope ticket-confirmation assume-defaults prototype --max-hours 12 \
  --source <board-form|chat|settings-default> --evidence '<證據>'
lat-unattended.py update [--goal …] [--done …] [--scope …] [--max-hours N] \
  --source <user-edit|chat> --evidence '<證據>'
lat-unattended.py close --reason <off|quota|delivered|cancelled|handover>
```

- `create` 每一項都必填，缺任何一項拒絕且不寫檔；`--scope none` 表示不給代決。已有生效中的版本時拒絕，改用 `update`。
- 證據：
  - `chat`：使用者答過的面板題 `<待決 ID> r<版本>`，紀錄須是 answered／approved，且有那一版的 `## 答覆` 段與 `- 來源：` 行。
  - `settings-default`：看板寫入設定的紀錄（`board:<時間>`），須是目前模式所在那層最後一次把 `mode` 寫成 `unattended` 的那筆；只能寫本輪第 1 版，版本會註明「目標由主控擬出」。模式來自主控層時不能用。
  - `board-form`、`user-edit`：看板動作紀錄；看板送出前自己核對登入裝置。
- `board-form` 與 `chat` 建立時把主控層的模式設為無人模式。
- `update` 產生新版本並立即生效；沒給的欄位沿用目前版本，舊版本保留並記下結束時間。
- `close`：`off` 是使用者關掉，主控層模式同時改回人工確認；`quota` 是額度用完；`delivered`、`cancelled`、`handover` 由 deactivate 依交付、`--force-unfinished`、`--successor` 自動帶入。
- 時間上限從本輪第 1 版開始算，到期時下一次讀取就把目前版本結束在到期時間，原因「時間上限到期」。
- 授權只屬於一個 session 的一輪：新一輪 activate 或換主控都從沒有授權開始，依當下三層設定重新判斷。
