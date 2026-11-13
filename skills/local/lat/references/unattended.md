# 無人模式

無人模式下主控在使用者事先給的授權（無人授權）內推進，不發題問使用者。這份說明只講模式怎麼決定、授權怎麼建立與結束；主控與看板一律透過 `scripts/lat-unattended.py` 讀寫，不自己解析設定或授權檔。

## 模式從哪來

三層由窄到寬，每個值各自取最窄一層有寫的那層，都沒寫就用初始值：

1. 主控：自己 session 紀錄裡的 `unattended`，只屬於這一輪。
2. 專案：主工作區 `.lat/preauth.toml` 的 `[unattended]`；`mode = "follow-global"` 表示模式跟全域，只有這一層能寫。
3. 全域：`$XDG_CONFIG_HOME/lat/preauth.toml` 的 `[unattended]`。

```toml
[unattended]
mode = "unattended"          # manual（人工確認）或 unattended；專案另可 follow-global
ticket_confirmation = true   # 短流程票代確認
assume_defaults = true       # 在固定清單內選預設
prototype_decide = true      # 做樣品再決定
max_hours = 12               # 時間上限（小時，整數）
source = "board:<時間>"       # 出處，看板寫入時自動蓋上，不參與判斷
```

初始值：人工確認、三項代決皆開、12 小時。額度用完一律停，不能關。任何一層的 `[unattended]` 寫錯時，模式一律視為人工確認，`status` 列出錯誤；這一段和預先授權共用檔案，寫錯也會讓預先授權查詢全部要問。

activate 會印出本輪模式與來源層；預設就是無人模式時另印「尚待目標」與寫入第 1 版的指令。

## 查詢

```bash
uv run --no-project python <lat 技能>/scripts/lat-unattended.py status [--json]
uv run --no-project python <lat 技能>/scripts/lat-unattended.py versions [--json]
uv run --no-project python <lat 技能>/scripts/lat-unattended.py check --version <N> [--round <輪>] [--at <ISO 時間>]
```

- `status`：模式、三項代決、時間上限，各附來源層（主控／專案／全域／初始值），以及授權狀態：
  - `無人授權有效`：本輪有生效中的版本，附到期時間。
  - `無人模式，尚待目標`：模式來自專案或全域預設，本輪還沒有第 1 版；這時不算有效授權，不得使用任何代決。
  - `無有效授權`：人工確認、授權已結束，或這一輪已停用；附最後一版的結束時間與原因。
- `versions`：本輪每一版的內容與生效期間。
- `check`：某一版在某個時間是否生效（預設現在、本輪），生效時結束碼 0，否則 1。回合結束檢查用同樣的判斷核對代決紀錄引用的版本。

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
  - `settings-default`：看板寫入設定的紀錄（`board:<時間>`），須是目前模式所在那層最後一次把 `mode` 寫成 `unattended` 的那筆；只能寫本輪第 1 版，`--scope` 與 `--max-hours` 必須和 `status` 顯示的設定值相同，版本會註明「目標由主控擬出」。模式來自主控層時不能用。
  - `board-form`、`user-edit`：看板動作紀錄；看板送出前自己核對登入裝置。
- `board-form` 與 `chat` 建立時把主控層的模式設為無人模式。
- `update` 產生新版本並立即生效；沒給的欄位沿用目前版本，舊版本保留並記下結束時間。新的時間上限若已經過了就拒絕。
- `close`：`off` 是使用者關掉，主控層模式同時改回人工確認；`quota` 是額度用完；`delivered`、`cancelled`、`handover` 由 deactivate 依交付、`--force-unfinished`、`--successor` 自動帶入。
- 時間上限從本輪第 1 版開始算，到期時下一次讀取就把目前版本結束在到期時間，原因「時間上限到期」。設定改過而模式不再是無人模式時，下一次讀取也會結束目前版本，原因「模式改為人工確認」；設定寫錯而被視為人工確認時也一樣，原因記「設定有錯」。之後改回無人模式也不會復活，要重新建立。`status`、`versions`、`check` 讀取時都會先做這兩種結束。
- 授權只屬於一個 session 的一輪：新一輪 activate 或換主控都從沒有授權開始，依當下三層設定重新判斷。

## 開啟：擬目標與確認題

- **擬目標**：activate 後，先依使用者第一句話擬出這一輪的目標與做完條件，以 `lat-unattended.py draft --goal '<目標>' --done '<條件>' …` 存成草稿，看板表單據此預填。草稿不是授權。
- **預設啟動**（`status` 顯示「無人模式，尚待目標」）：派發前用同一份目標與條件寫第 1 版 `create --source settings-default`（`--scope`、`--max-hours` 照 `status` 的設定值）；寫入前照人工確認的規則做事，不得使用任何代決狀態。
- **聊天開啟**：使用者在聊天說「這輪不用問我」之類的話時，主控把同樣內容整理成一張確認題，用 `question ask --advisor 'exempt requirement-discussion'` 寫入，照常以 `DECIDE:` 提問：

  ```markdown
  ## 這輪改成無人模式嗎？

  目標：<一句話>
  做完條件：
  - <條件一>
  - <條件二>
  參謀可以替你決定：短流程票代確認、在固定清單內選預設、做樣品再決定（照設定值列出）
  何時停：額度用完；時間上限 <N> 小時
  開啟後我不再發題問你，要你決定的事都放進回顧頁；你隨時可以叫我關掉。

  - A. 確認開啟
  - B. 先不要
  - C. 要改內容（在備註寫改什麼）
  ```

  答覆記入待決紀錄後（面板自動記錄或 `question record-chat`），選 A 才以 `create --source chat --evidence '<待決 ID> r<版本>'` 照題目內容建立；選 C 就改版重問，選 B 不建立。

## 代決與擱置

`status` 顯示「無人授權有效」時，主控不發 `DECIDE:`／`HELP:`，也不寫面板題目。原本要問使用者的事照 [參謀](advisors.md) 先記 `advising` 再諮詢，依結果寫成下列其中一種；回合以 `NO REPLY:` 或 `DONE:` 結尾。回合結束檢查遇到 `DECIDE:`／`HELP:` 時首次攔下。

| 情況 | 紀錄狀態 |
|---|---|
| 屬下方「一定擱置」 | `parked`，不必諮詢 |
| 參謀本來就能定案（引用已確認 Spec、真人答覆或 `may_settle`） | `advisor-resolved`，照舊，不需授權 |
| 短流程確認題，授權勾選「短流程票代確認」，兩位參謀逐條對照使用者原話與驗收條件都同意 | `proxy-confirmed`（代確認） |
| 落在下方固定清單，授權勾選「在固定清單內選預設」，兩位都同意 | `assumed`（假設） |
| 行為、版面、速度這類能做樣品比較的選擇，授權勾選「做樣品再決定」，派 /prototype 後兩位依樣品都同意 | `prototype-decided`（樣品決定） |
| 其他情況、任一位不同意、兩位依樣品看法不一 | `parked` |

**一定擱置**：需求討論、Spec 確認、`ticket-confirmation` 以外的所有參謀例外類別、預先授權結果為 `ask` 的動作、花錢或動帳號額度、刪除使用者資料、推送 main 或對外發布、大改或刪除已確認需求、只有使用者帳號或裝置能做的事、全域 `must_ask` 列到的事。已經問過使用者、仍待答的題目維持 `pending`，只有真人答覆能解除，不能改寫成代決。

**固定清單**（`- assume-class:` 的值）：只限不改已確認驗收條件與範圍的事；會改驗收條件、範圍、存檔格式、既有資料、對外行為、登入權限與安全、花費的一律擱置。清單不自行擴充。

| 值 | 範圍 |
|---|---|
| `naming` | 命名與程式內部結構、選用專案既有的元件或寫法 |
| `ui-detail` | 畫面上驗收條件沒有規定的文字、排版與樣式細節 |
| `test` | 測試的寫法與切入點 |
| `setting-default` | 以後使用者能在設定或設定檔改回的預設值 |
| `ordering` | 本輪各票的先後順序與平行方式 |

**代決紀錄**的格式（寫在共用待決目錄，不含 `## 答覆` 段落）：

```markdown
# <ID> <標題>

- status: assumed
- advisor: proxy assume-defaults
- session: <主控 session ID>
- grant: r<輪> v<版本>
- decided-at: <ISO 時間，含時區>
- assume-class: naming
- revert: <使用者可以改成什麼>
- version: r1
- question: <原本要問的事>

## 參謀意見

- <名稱>（<client> <模型>）：agree；<理由與依據>
- <名稱>（<client> <模型>）：agree；<理由與依據>
```

- 參謀行依狀態寫 `proxy ticket-confirmation`、`proxy assume-defaults` 或 `proxy prototype`；`grant` 與 `decided-at` 引用作成當下生效的版本（`status` 印出的版本與輪數）。
- `assumed` 另寫 `- assume-class:` 與 `- revert:`；`prototype-decided` 另寫 `- sample: <樣品位置>`，不寫前兩行。
- `proxy-confirmed` 另加 `## 驗收對照`，每條驗收條件一行：`- <驗收條件> ← 「<使用者原話>」 <session 與可定位的訊息來源>`。代確認的票照常只合併到整合分支；推送與部署仍只看預先授權，無人授權不放寬它。
- 回合結束檢查逐一核對本 session 的代決紀錄並逐項列出原因：引用的版本不存在、作成時間不在該版本生效期間或晚於現在、授權沒勾選對應的代決、缺任一位參謀的 `agree` 行或有 `disagree`、含 `## 答覆` 段落、有 `- action:`／`- exempt-basis:`／`- consensus:`／`- kind: help` 行或參謀行是 `exempt`、缺上述必填行，以及這題已問過使用者。作成時合法的紀錄在授權結束後照常通過，其他 session 的紀錄不檢查。

**擱置紀錄**寫 `- status: parked`、`- session:`、參謀行（諮詢結果或例外類別）、問題、擱置原因與受阻工作。擱置項不寫面板、不通知使用者，只擋相依工作，其他工作照做；只剩等待時，`lat-watch wait --for-pending` 會把本 session 的擱置項一起列為等待對象。

**回覆與推翻**：使用者對回顧項目按「回覆」或「推翻」、或在聊天說明時，照 [待答問題面板](question-panel.md#聊天答覆與更正) 以 `question record-chat` 記入那筆紀錄，再照常 `question approve`；擱置項因此解除，授權已結束時歷史項目也一樣能記。
