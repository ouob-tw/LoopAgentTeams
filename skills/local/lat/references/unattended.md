# 無人模式

無人模式下主控在使用者事先給的授權（無人授權）內推進：授權勾選的幾類事由參謀代決，其他要使用者決定的事照人工模式發題，同時繼續做不受影響的工作。這份說明只講模式怎麼決定、授權怎麼建立與結束；主控與看板一律透過 `scripts/lat-unattended.py` 讀寫，不自己解析設定或授權檔。

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

activate 會印出本輪模式與來源層；預設就是無人模式時另印「尚待目標」與寫入第 1 版的指令；本輪沒有目標草稿、也沒有生效中的授權時（人工確認也一樣），另印一行提醒與完整的 `draft` 指令（見[草稿](#草稿)）。

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

## 草稿

```bash
lat-unattended.py draft --goal '<目標>' --done '<條件一>' [--done '<條件二>' …]
```

主控從使用者的話擬出的目標與做完條件先存成草稿；看板的「開啟無人模式」表單從它預填。草稿不是授權，`status` 的狀態不因它改變，`status --json` 以 `draft` 顯示。再寫一次會取代前一份。

回合結束檢查會提醒寫草稿與更新草稿，跟其他回合結束檢查一樣每回合第一次攔下、之後只警告放行：

- **沒有草稿**（沒寫過或讀不出）：提醒並附上 `draft` 指令；本輪有生效中的無人授權時不提醒。
- **草稿過時**：草稿寫入後工作總表又新增了列（新票），提醒核對目標與做完條件是否還涵蓋這些工作；有生效中的授權時照樣提醒。工作總表的時間只到秒，和草稿同一秒新增的列也算在草稿之後，所以在新增列的同一秒重寫的草稿仍會被提醒，隔一秒後再重寫一次即可。要改就寫新內容；不用改就照原內容再寫一次，表明已核對（提醒裡附有照原內容重寫的指令），之後到又有新列前不再提醒。

看板的設定頁另用 `settings [--project <資料夾>]…` 讀全域與各專案的 `[unattended]`，用 `settings-write` 寫入；寫入會蓋上 `board:<時間>` 並記進看板寫入紀錄，就是 `settings-default` 引用的那一筆。

## 建立、修改、關閉

```bash
lat-unattended.py create --goal '<目標>' --done '<條件一>' --done '<條件二>' \
  --scope ticket-confirmation assume-defaults prototype --max-hours 12 \
  --source <board-form|chat|settings-default> --evidence '<證據>'
lat-unattended.py create --source board-task --evidence board-task:<執行 ID>
lat-unattended.py update [--goal …] [--done …] [--scope …] [--max-hours N] \
  --source <user-edit|chat> --evidence '<證據>'
lat-unattended.py close --reason <off|quota|delivered|cancelled|handover>
```

- `create` 每一項都必填，缺任何一項拒絕且不寫檔；`--scope none` 表示不給代決。已有生效中的版本時拒絕，改用 `update`。
- 證據：
  - `chat`：使用者答過的面板題 `<待決 ID> r<版本>`，紀錄須是 answered／approved，且有那一版的 `## 答覆` 段與 `- 來源：` 行。
  - `settings-default`：看板寫入設定的紀錄（`board:<時間>`），須是目前模式所在那層最後一次把 `mode` 寫成 `unattended` 的那筆；只能寫本輪第 1 版，`--scope` 與 `--max-hours` 必須和 `status` 顯示的設定值相同，版本會註明「目標由主控擬出」。模式來自主控層時不能用，看板新建主控選「無人」的例外：證據改用 activate 印出的 `board-launch:<新建 ID>`。
  - `board-task`：看板自動化任務開主控時記下的執行紀錄 `board-task:<執行 ID>`（目標、做完條件、代決範圍與時間上限都取自它，不必再給，給了就必須相同）；它必須來自使用者最後一次在看板登入裝置（非測試登入）儲存這個任務的紀錄，任務檔之後沒被改過，主控的 HCOM 名稱以那次執行的 tag 開頭，60 分鐘內，而且沒被別的版本引用過。
  - `board-form`、`user-edit`：看板動作紀錄 `board-action:<ID>`，指向看板在登入裝置送出表單時寫進 `sent-log.jsonl` 的那一筆；須是同一個主控、同一種動作（建立或修改）、內容與這一版相同、10 分鐘內，而且沒被別的版本引用過，否則拒絕且不寫檔。
- `board-form`、`board-task` 與 `chat` 建立時把主控層的模式設為無人模式，不寫專案或全域設定。
- `update` 產生新版本並立即生效；沒給的欄位沿用目前版本，舊版本保留並記下結束時間。新的時間上限若已經過了就拒絕。
- `close`：`off` 是使用者關掉，主控層模式同時改回人工確認；`quota` 是額度用完；`delivered`、`cancelled`、`handover` 由 deactivate 依交付、`--force-unfinished`、`--successor` 自動帶入。
- 時間上限從本輪第 1 版開始算，到期時下一次讀取就把目前版本結束在到期時間，原因「時間上限到期」。設定改過而模式不再是無人模式時，下一次讀取也會結束目前版本，原因「模式改為人工確認」；設定寫錯而被視為人工確認時也一樣，原因記「設定有錯」。之後改回無人模式也不會復活，要重新建立。`status`、`versions`、`check` 讀取時都會先做這兩種結束。
- 授權只屬於一個 session 的一輪：新一輪 activate 或換主控都從沒有授權開始，依當下三層設定重新判斷。

## 開啟：擬目標與確認題

- **擬目標**：activate 後，先依使用者第一句話擬出這一輪的目標與做完條件，以 `lat-unattended.py draft --goal '<目標>' --done '<條件>' …` 存成草稿，看板表單據此預填。草稿不是授權。
- **預設啟動**（`status` 顯示「無人模式，尚待目標」；看板新建主控時選「無人」也是，activate 已把主控層模式寫好）：派發前用同一份目標與條件寫第 1 版 `create --source settings-default`（`--scope`、`--max-hours` 照 `status` 的設定值）；寫入前照人工確認的規則做事，不得使用任何代決狀態。
- **看板自動化任務開啟**：看板的 Agent 任務勾了無人模式時，開出的主控第一句話就附上 `create --source board-task` 的完整指令；activate 後先照做，建不起來就不做事，回覆 `FAILED: <原因>`。
- **聊天開啟**：使用者在聊天說「這輪不用問我」之類的話時，主控把同樣內容整理成一張確認題，用 `question ask --advisor 'exempt requirement-discussion'` 寫入，照常以 `DECIDE:` 提問：

  ```markdown
  ## 這輪改成無人模式嗎？

  目標：<一句話>
  做完條件：
  - <條件一>
  - <條件二>
  參謀可以替你決定：短流程票代確認、在固定清單內選預設、做樣品再決定（照設定值列出）
  何時停：額度用完；時間上限 <N> 小時
  開啟後參謀可以替你決定上面這幾類事；其他要你決定的事我照常發題問你，同時繼續做不受影響的工作；你隨時可以叫我關掉。

  - A. 確認開啟
  - B. 先不要
  - C. 要改內容（在備註寫改什麼）
  ```

  答覆記入待決紀錄後（面板自動記錄或 `question record-chat`），選 A 才以 `create --source chat --evidence '<待決 ID> r<版本>'` 照題目內容建立；選 C 就改版重問，選 B 不建立。

## 代決與提問

`status` 顯示「無人授權有效」時，原本要問使用者的事照 [參謀](advisors.md) 先記 `advising` 再諮詢，依結果寫成下列其中一種。

| 情況 | 紀錄狀態 |
|---|---|
| 屬下方「一定問使用者」 | 發待決題（`pending`）；屬參謀例外類別的不必諮詢，其他照人工模式諮詢後寫參謀行 |
| 參謀本來就能定案（引用已確認 Spec、真人答覆或 `may_settle`） | `advisor-resolved`，照舊，不需授權 |
| 短流程確認題，授權勾選「短流程票代確認」，兩位參謀逐條對照使用者原話與驗收條件都同意 | `proxy-confirmed`（代確認） |
| 落在下方固定清單，授權勾選「在固定清單內選預設」，兩位都同意 | `assumed`（假設） |
| 行為、版面、速度這類能做樣品比較的選擇，授權勾選「做樣品再決定」，派 /prototype 後兩位依樣品都同意 | `prototype-decided`（樣品決定） |
| 其他情況、任一位不同意、兩位依樣品看法不一 | 發待決題（`pending`） |

**一定問使用者**（檢查訊息沿用舊稱「一定擱置」）：需求討論、Spec 確認、`ticket-confirmation` 以外的所有參謀例外類別、預先授權結果為 `ask` 的動作、花錢或動帳號額度、刪除使用者資料、推送 main 或對外發布、大改或刪除已確認需求、只有使用者帳號或裝置能做的事、全域 `must_ask` 列到的事。已經問過使用者、仍待答的題目維持 `pending`，只有真人答覆能解除，不能改寫成代決。

**要問使用者的事**照人工模式處理：

- 用 `question ask` 寫成一般待決題，以 `DECIDE:`／`HELP:` 提問；題目、授權缺口、受阻工作的寫法與人工模式相同，參謀行寫諮詢結論或例外類別。回合結束檢查不因無人授權攔下 `DECIDE:`／`HELP:`。
- 無人授權有效時，`question ask` 自動在待決紀錄加 `- grant: r<輪> v<版本>`，回顧據此認定它屬哪一輪；人工確認時不加。
- 提問後只停住相依的工作，其他工作照做；只剩等待時照常用 `lat-watch wait`。
- 不再新寫 `- status: parked`：本輪授權開始後寫出的 `parked` 紀錄會被回合結束檢查攔下，改用 `question ask` 重發。
- 工作總表的擱置（`lat-ledger.py park`，見 SKILL.md「審查收斂」與 [Spec 審查](spec-review.md)）同時要對同一件事發一張待決題，`park --question <ID>` 帶上它；真人答覆前該列維持擱置，記下答覆後才能 `unpark`。

**固定清單**（`- assume-class:` 的值）：只限不改已確認驗收條件與範圍的事；會改驗收條件、範圍、存檔格式、既有資料、對外行為、登入權限與安全、花費的一律發題問使用者。清單不自行擴充。

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
- 代決選了什麼寫在 `- decision:`，回顧的「做了什麼」取這一行。
- `assumed` 另寫 `- assume-class:` 與 `- revert:`；`prototype-decided` 另寫 `- sample: <樣品位置>`，不寫前兩行。
- `proxy-confirmed` 另加 `## 驗收對照`，每條驗收條件一行：`- <驗收條件> ← 「<使用者原話>」 <session 與可定位的訊息來源>`。代確認的票照常只合併到整合分支；推送與部署仍只看預先授權，無人授權不放寬它。
- 回合結束檢查逐一核對本 session 的代決紀錄並逐項列出原因：引用的版本不存在、作成時間不在該版本生效期間或晚於現在、授權沒勾選對應的代決、缺任一位參謀的 `agree` 行或有 `disagree`、含 `## 答覆` 段落、有 `- action:`／`- exempt-basis:`／`- consensus:`／`- kind: help` 行或參謀行是 `exempt`、缺上述必填行，以及這題已問過使用者。作成時合法的紀錄在授權結束後照常通過；版本結束後才出現的紀錄（以檔案實際寫入時間判斷，不看 `decided-at`），或內容被改過的舊紀錄，一律攔下。其他 session 的紀錄不檢查。

**舊的擱置紀錄**（改版前寫的 `- status: parked`）照舊可讀：只擋相依工作，`lat-watch wait --for-pending` 把本 session 的擱置項一起列為等待對象，答覆照下一段記。

**回覆與推翻**：使用者對回顧項目按「回覆」或「推翻」、或在聊天說明時，照 [待答問題面板](question-panel.md#聊天答覆與更正) 以 `question record-chat` 記入那筆紀錄，再照常 `question approve`；舊的擱置項因此解除，授權已結束時歷史項目也一樣能記。

## 回顧

本輪有過無人授權時，`lat-unattended.py` 把擱置與代決整理成一份回顧檔 `.lat/unattended/<session>-r<輪>-review.md`，給看板的回顧分頁與接手主控讀。主控不手寫、不改這個檔。

```bash
lat-unattended.py review update             # 依來源重建；印出路徑
lat-unattended.py review show [--json]      # 重建後印出全文；--json 給看板用
```

- **來源**：本輪授權各版本、本 session 的擱置與代決紀錄（含之後從回顧頁回覆或推翻的）、工作總表（擱置的列；交付列（實作、審查、QA、整合）都結案的票，每張一行，參謀、研究、Spec 與其他列不算）。依預先授權自動做的合併、推送與部署不列入回顧，交付回報照舊附 `lat-preauth report` 的輸出。待決紀錄引用的 `- grant:` 輪數決定它屬哪一輪；沒寫的擱置紀錄算目前這一輪。
- **何時更新**：本輪第一次出現擱置或代決時建立，之後每次新增或改變項目都更新：工作總表 `park`／`unpark` 後立即重建；主控用檔案工具寫的待決紀錄在寫完當下（PostToolUse；萬一漏掉，主控下一個 shell 指令前與回合結束檢查都會再重建）。授權建立、修改、關閉與 deactivate 也會重建；內容沒變就不寫檔，都沒有項目時不建立。
- **版面**（順序固定）：檔頭的更新時間 → 擱置等你的事 → 本輪目標與做完條件（每一版與來源）→ 最該先看的幾項 → 假設 → 代確認的票 → 樣品決定 → 本輪完成的票。沒有內容的段落省略。改版前寫的回顧檔（狀態檔帶核對結論）不改寫，`review show` 照印原檔，`--json` 給的是依來源重建的項目。
- **項目**：每項是 `### <編號> <標題>`，下列 `- 種類：`、`- 狀態：`、`- 做了什麼：`、`- 為什麼：`、`- 證據：`、`- 怎麼推翻：`。編號取自來源，更新後不變：待決 ID、`row-<工作總表列>`。使用者從回顧回覆或推翻後（`question record-chat` 記下的答覆），狀態寫「已由你回覆／已由你推翻（時間）」；工作總表的列以 `unpark` 解除時寫「已解除擱置（時間）：<原因>」。
- **最該先看的幾項**：只列還沒處理的項目，最多 5 項，依序為擱置 → 代確認 → 牽涉驗收邊界的假設（`ui-detail`、`setting-default`）→ 其他。

換班時把 `review update` 印出的回顧檔路徑寫進交接（deactivate 也會印出）；接手主控用 `review show --session-id <前任 session>` 讀前任的回顧，自己這一輪從新的回顧開始。
