# 待答問題面板

供 LAT 主控在 Herdr 使用 `lat.panel` 外掛時讀取。面板只是使用者的作答介面；`.lat/decisions/<ID>.md` 仍是唯一的權威紀錄，SKILL.md「使用者待決事項」的規則全部適用。

## 是否啟用

主控 shell 有 `HERDR_WORKSPACE_ID`，且 `herdr plugin list` 成功列出已啟用的 `lat.panel` 時才啟用。沒有 workspace、找不到 `herdr` 指令，或外掛未啟用時照舊在聊天提問與記錄答覆；已有 workspace 但查詢失敗時停止並依錯誤處理，不得當成未啟用略過。

## 變數

`lat_dir`、`workspace`、`client` 與主控恢復程序相同；`workspace` 是存放 `.lat/` 的專案根目錄。shell 狀態不跨呼叫保留時，每次執行前重新設定。

```bash
lat_dir=/absolute/path/to/installed/lat
workspace=/absolute/path/to/project-root
client=codex           # Claude 主控改為 claude
hcom_name=<主控自己的 HCOM 名稱>
session_id="$CODEX_THREAD_ID"   # Claude：$CLAUDE_CODE_SESSION_ID
decisions=/absolute/path/to/shared/decisions
lat="$workspace/.lat"   # 在 worktree 裡的主控改用主工作區的 .lat
questions=<activate 或 bind 輸出的 questions_path>
```

每個主控各用一份問題檔。新綁定的問題檔在 `$lat/questions/<名稱>.md`，名稱是 HCOM 名稱轉成小寫、非英數字元換成 `-`；歸檔檔是問題檔同目錄的 `<問題檔名不含副檔名>-archive.md`，鎖檔是同目錄的 `.<問題檔名>.lock`。所有 worktree 共用主工作區的 `.lat`。面板紀錄固定在 `$lat/panel-journal.jsonl`，每筆以問題檔的絕對路徑標記是哪一份。

根目錄的舊問題檔 `.lat/questions-<名稱>.md` 與它的歸檔檔、鎖檔留在原處，不搬也不改；其中已送出未記錄的答覆、已記錄題目的歸檔照舊以舊路徑運作。下列情況繼續綁定舊檔：

- 本輪開始時就綁定舊檔的主控，到本輪 deactivate 前都沿用（恢復時重綁也一樣）。
- 同一名稱的舊檔仍有「待答」題目（含已送出、還沒記錄的），新一輪仍綁定舊檔，直到那些題目處理完。

任何指令都沒有預設問題檔，`--questions` 一律明確給。

## 綁定

`lat-session.py activate --hcom-name "$hcom_name"` 會自動綁定並印出問題檔路徑。只有自動綁定失敗且錯誤要求補做時，才執行下列備用指令：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" bind \
  --hcom-name "$hcom_name" --client "$client" \
  --session-id "$session_id" --workspace "$workspace"
```

- Herdr 的 workspace、tab、pane 預設取 `HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`、`HERDR_PANE_ID`；缺任何一個就報錯、不猜測，補齊後再執行錯誤印出的手動指令。
- 綁定以 session ID 為鍵，重綁只更新自己。輸出的 `replaced` 不是 `null` 表示更新了自己上一筆綁定。
- compact／resume 時，恢復 hook 會以 hook 當下的 `HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`、`HERDR_PANE_ID` 自動重綁自己（接回後 Herdr 的 tab／pane 編號會變）。三個缺任何一個、面板未啟用或查詢失敗時不改動綁定，也不輸出訊息。接回後面板仍落到選單時，才手動執行上方備用指令。
- 使用者在沒有主控的 tab 開面板、而同 workspace 有多個主控時，面板顯示選單：一列一個主控，列出 HCOM 名稱、專案資料夾、所在 Herdr 分頁（有名稱顯示名稱）、待答題數與第一題標題；pane 已不存在的綁定標示「視窗已不存在」。使用者以 ↑↓／Enter 或數字鍵選擇。
- 輸出 `legacy bindings ignored` 或 `legacy_ignored` 表示有舊版綁定資料被略過；舊的 `.lat/questions.md` 不會自動搬移，仍待決的題目由主控重新寫入自己的問題檔。

## 寫題

1. 依下方「題目格式」把這一題寫成暫存檔，只放標題與內文：

   ```markdown
   ## 正式版要怎麼併入？

   審查和驗收都通過了，本機也已經裝好，現在只差要不要把它併進 dev。

   - A. 合併到 dev，不推送（建議）
     本機安裝內容會與 dev 一致，但 GitHub 不會改變。
   - B. 合併到 dev，並推送到 GitHub
     本機與遠端都會更新。

     - 推送前會再跑一次完整測試。
   - C. 先不合併
     繼續保留在目前分支。

   ➡️ A：先讓本機版本一致，確認使用情況後再決定是否推送。

   【詳細資訊】
   dev 是本機安裝所依據的分支；推送會讓 GitHub 上的 dev 一起更新。
   【詳細資訊結束】
   ```

2. 一個指令建立待決紀錄、寫入問題檔並做遺漏檢查；題號就是決策紀錄 ID：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question ask \
     --questions "$questions" --decisions "$decisions" --id "<ID>" --file /path/to/section.md \
     --advisor "<參謀結論>" [--help-question] \
     [--question "<問題>"] [--authority-gap "<授權缺口>"] [--blocked-work "<受阻工作>"] \
     [--visual "<示意網址>"]
   ```

   - 紀錄不存在時建立 `.lat/decisions/<ID>.md`：`pending` 狀態、參謀行、session、版本、問題、選項、授權缺口與受阻工作。`--advisor` 必填，寫法見 [參謀](advisors.md#待決紀錄的狀態與參謀行)；session 取問題檔綁定的 session，沒有綁定時取 client 的 session 環境變數，可用 `--session-id` 指定。問題預設為標題、選項取自題目；授權缺口預設「需使用者決定」、受阻工作預設「未指定」，只適合簡單題，有實際缺口或受阻工作時明確給。
   - `--help-question` 標成求助題：紀錄寫 `- kind: help`，題目沒有單選「已完成」選項時拒絕，不改任何檔。
   - 紀錄已存在時就是改版：只接受 `--help-question`（把紀錄的 `- kind:` 改成或補上 `help`），其他紀錄欄位參數一律拒絕。寫入後紀錄的版本行改為面板版本。紀錄已非 `pending`（例如答覆含糊要重問）時，題目內容須有改變，寫入後狀態改回 `pending`，舊答覆保留；內容相同則拒絕，除非上次已寫入面板、但紀錄還停在較舊版本（同步中斷），這時重跑同一指令會補完。題目已從問題檔歸檔時，從紀錄版本的下一版開始。
   - 寫題的其餘行為與下方 `question upsert` 相同（清理、印 `<ID> r<版本>`、確認題職責提醒、預先授權重查、側欄）；寫入失敗時剛建立的紀錄會移除。最後執行與「待決題目檢查」相同的檢查（帶綁定的 session），有問題時以非零結束，依該節表格處理。
   - `--visual`（可重複，`question upsert` 也接受）寫入示意連結，只接受 http／https，其他一律拒絕寫題，不改任何檔。連結存成題目內文最後的 `【示意】<網址>` 行，所以換連結算改題、會升版；同一題重寫時要再帶一次，沒帶就是拿掉。面板在背景句之後顯示 `[看示意] <網址>`，點擊或按 Enter 開啟；主機沒有圖形環境或開啟工具時，狀態列另外提示請自行開啟該網址。看板的待決題卡片與主控頁的待決題列顯示「看示意」按鈕，在新分頁開啟。聊天顯示的題目列出 `看示意：<網址>`。
   - Spec 確認題寫題後另跑共識檢查工具寫入共識行，見 [Spec 共識](consensus.md)。

3. 檢查通過後依「聊天提問格式」提問；使用者可在面板或聊天作答。

### 手動寫題

舊步驟仍可用：

1. 依「使用者待決事項」建立 `.lat/decisions/<ID>.md`。求助題（HELP）在紀錄加 `- kind: help`。
2. 寫入問題檔。一律用這個指令（與面板共用檔案鎖），不手動編輯 `$questions`：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question upsert \
     --questions "$questions" --decisions "$decisions" --id "<ID>" --file /path/to/section.md
   ```

3. 寫入前會自動清理同一份問題檔，條件見下方「清理題目」；正在寫入的同一題號保留，維持升版行為。`--decisions` 必填，缺少或目錄不存在時拒絕寫入。指令印出 `<ID> r<版本>`；用這個版本更新決策紀錄。確認題（參謀行為 `exempt ticket-confirmation` 或 `exempt spec-confirmation`）會多印一行目前職責與覆蓋指令；任務改變就照著覆蓋。實際寫入新題或升版時，另在 `panel-journal.jsonl` 寫一筆 `upsert`，記錄題號、版本與時間；內容相同而沒有寫入時不寫。升版規則見下方「版本」。紀錄有 `- action:` 的授權題，寫入前會依當下設定重查預先授權：尚未送出且可直接做時拒絕寫入；已送出的照常寫入並提醒，見 [預先授權](preauth.md#接上提問)。
4. 發出 `DECIDE:`／`HELP:` 前完成下方「待決題目檢查」，通過後依「聊天提問格式」提問。

### 題目格式

- 標題直接寫問題本身；內文先用一句話交代背景。不使用「問題／選項／建議／影響／批註」等欄位名稱。
- **詳細資訊**（選填）：背景句講不完的來由、方法、解釋，寫在題末 `➡️` 段落之後，用各自獨占一行的 `【詳細資訊】` 與 `【詳細資訊結束】` 包住；區塊內可寫多段，裡面的選項寫法或 `➡️` 開頭的行不算選項或推薦段落。面板與看板把原文直接顯示在題目最後（`➡️` 段落之後），不折疊。舊題把區塊寫在背景句之後、選項之前的，讀法相同，同樣顯示在最後。每題最多一個區塊；標記不成對、順序顛倒、出現兩組或區塊沒有內容時，`question upsert` 拒絕寫入。和這題有關的說明都放進題目，不寫在題目外面。
- 單選題的每個選項寫成一行 Markdown 清單項目 `- A. 選項`、`- B. 選項`；複選題用未勾選的 `- [ ] 選項`。兩種不可混用，混用或沒有選項時面板改成純文字輸入。
- 選項底下縮排兩格的內容都屬於這個選項，照 Markdown 自由寫：可分段、加子清單、粗體、程式碼框，空行後仍縮排的內容也算在內；下一個沒有縮排的行就結束這個選項。題目其他部分（背景、詳細資訊、`➡️` 段落）照一般 Markdown 寫。
- 舊寫法 `A. 選項` 加縮排影響說明仍可讀取，新題不用。
- 建議方案在選項文字結尾標「（建議）」；完整推薦答案與理由在所有選項後另起一段，寫成 `➡️ A：<為什麼建議>`，多行理由也放在這個題末段落。面板將原文顯示於選項（含自動加入的「其他」列）之後；沒有推薦段落的題目維持原樣。
- **選項字母**：面板與聊天使用相同字母。單選題用題目檔的字母，複選題依順序標 `A.`、`B.`…，最後一列「其他（自己輸入）」接續下一個字母。使用者按字母鍵 A–I（不分大小寫）選擇；游標在「其他」列或輸入框中時，字母照常當文字輸入。
- 每題盡量不超過九個選項（A–I），使用者才能直接按字母選；超過的選項仍可用方向鍵選。字母只到 Z：複選題第 27 項起與之後的「其他」列不標字母。
- 工具自動加入題號、版本、`待答`、空白作答區與 `- [ ] 送出`；既有題的答覆與勾選狀態不會被覆寫。
- **求助題**：紀錄有 `- kind: help` 時，題目須是單選題且有一個選項文字是 `已完成`（可加「（建議）」），否則 `question upsert` 拒絕寫入；使用者做不到或改變主意時寫在自動加入的「其他」。

### 聊天提問格式

**已綁定面板**：聊天不照抄題目。訊息只寫必要的背景說明（可省略）與最後一行 `DECIDE: <ID> r<版本> …` 或 `HELP: …`；多題依想呈現的順序列在同一行。Spec 確認題仍須在訊息裡寫 `共識 v<N>`。回合結束檢查通過或只警告放行時，hook 依最後一行的順序從自己的問題檔讀出各題目前版本，在訊息之後以純文字顯示（灰字、不套 Markdown；模型下一回合看不到這段）：

```text
❓ <ID> r<版本> - <標題>

<背景>

A. <選項>（建議）
  <選項內容>
B. <選項>

➡️ A：<為什麼建議>

【詳細資訊】
<詳細資訊>
【詳細資訊結束】

────────────────────

❓ <下一題 ID> r<版本> - …
```

顯示時去掉粗體、斜體與刪除線標記（`**`、`__`、`*`、`_`、`~~`）、反引號、程式碼框標記、標題的 `#` 與連結語法，程式碼內的文字照原樣，保留文字、選項字母、清單縮排與 emoji；複選題依順序標字母，選項前加一行「（複選題，可選多項）」。檢查攔下時不顯示；讀不到題目時只附一行警告，不改變檢查結果。要讓使用者看到的內容都寫進題目：補做諮詢的參謀結論為 `late resolved` 或 `late self-check` 時，必要的參謀建議做法與引用授權來源寫入題目內的 `➡️` 段落。

**未綁定面板**：hook 不代為顯示，在聊天寫出整題：標題、背景句、選項文字（含結尾「（建議）」）、選項底下的內容、題末 `➡️` 推薦段落及最後的詳細資訊區塊（含兩行標記），字母依「題目格式」。多題用 `---` 分隔：

```markdown
❓ **<ID> r<版本>** - **<標題>**

<背景句>

- A. <選項>（建議）
  <選項內容>
- B. <選項>
  <選項內容>

➡️ A：<為什麼建議>

【詳細資訊】
<詳細資訊原文>
【詳細資訊結束】

---

❓ **<下一題 ID> r<版本>** - …
```

### 版本

新題從 r1 開始。標題或內文（含詳細資訊）有任何改變時自動升版、狀態回到 `待答`、清除送出勾選，舊版作答區移入 `### 舊版 r<N>（不套用至 r<N+1>）`；內容完全相同時保留版本與答覆。版本改變就是新提案，依「使用者待決事項」保留舊紀錄並重新待決。

### 待決題目檢查

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question check-pending \
  --questions "$questions" --decisions "$decisions" --session-id "$session_id"
```

帶 `--session-id` 時略過確定屬於其他主控的決策紀錄：題號不在 `--questions` 指定的問題檔或它的歸檔檔，且紀錄的 `- session:` 是別的 session ID，或題號出現在其他主控的問題檔或歸檔檔。`- session:` 等於這個 session ID、題號在自己的問題檔，或看不出屬於誰的紀錄都照常檢查。不帶時檢查目錄內全部紀錄。檢查會搜尋 `.lat` 根目錄的 `questions-*.md`（舊位置）與 `.lat/questions/*.md`（新位置），以及兩處的 `-archive.md` 歸檔檔；在 Git 專案中另含各 worktree 自己 `.lat` 根目錄的舊問題檔，確認 pending 決策都有待答題；反向檢查只看 `--questions` 指定的問題檔，列出待答題的決策已非 pending 或找不到決策紀錄。回合結束的 DECIDE／HELP 檢查沿用帶自己 session ID 的結果。有問題時以非零結束，不印「沒有遺漏」；依輸出處理後重跑：

| 輸出 | 處理 |
| --- | --- |
| 沒有遺漏 | 所有 pending 決策都有待答題，自己的待答題也沒有反向問題，可繼續。 |
| 遺漏待答題目 | 先補題。 |
| 狀態不一致 | 決策仍是 pending，但題目已記錄或已歸檔；依列出的檔案核對並修正決策紀錄。 |
| 待答題目需處理：決策已非 pending | 未送出者執行下方 `question cleanup`；已勾選送出者先處理使用者答覆，再標為已記錄。 |
| 待答題目需處理：找不到決策紀錄 | 補同名決策紀錄；已勾選送出者同時核對並處理使用者答覆。 |
| 讀不出狀態 | 依逐檔列出的原因修正決策紀錄；指令以非零結束碼結束，不印「沒有遺漏」。 |

決策紀錄與停住監控共用以下狀態讀法：

- 取第一行以 `- status:` 開頭的行；鍵名不分大小寫、冒號後空白可多可少。
- 值的第一個字不分大小寫：`pending` 是待決，其餘視為已處理。
- 沒有狀態行、值為空或只有空白，或第一個字不是 `pending` 但後面含有 `pending`，均為「讀不出狀態」。停住監控將其視為仍在待決，並在監控紀錄留說明。

參謀諮詢中的 `advising` 與參謀結案的 `advisor-resolved` 都不是 `pending`，不寫面板；`pending` 紀錄發出 `DECIDE:`／`HELP:` 前須先有參謀行，見 [參謀](advisors.md#待決紀錄的狀態與參謀行)。

## 側欄與通知

`question upsert`、`set-status`、`cleanup`、`resolve-help`、`withdraw`，以及 activate、恢復時重綁與 deactivate，都會自動更新綁定窗格在 Herdr 側欄的名稱，主控不需另外執行：

- 有待答時顯示 `<短名> ⚠待答{n}求助{n}`，短名是 HCOM 名稱最後一個連字號後的部分（與分頁名稱 `lat-<短名>` 相同，沒有連字號時用全名）；數字是自己問題檔中狀態為「待答」、決策紀錄仍未結案的題目，依 `- kind: help` 分成求助與其他，數字為 0 的那一項不顯示（例：`tene ⚠待答1`、`tene ⚠求助2`）；兩者都是 0 或 deactivate 後恢復原名。
- `question upsert` 寫入新題或升版時，另發一則同樣文字的 Herdr 內建通知；Herdr 因發太快或忙碌沒顯示時不重試。
- 問題檔沒有綁定，或 shell 不在 Herdr workspace、`lat.panel` 未啟用時略過；改綁到新窗格時，舊窗格先恢復原名；Herdr 呼叫失敗只在標準錯誤留一行 `lat-panel: sidebar not updated: …`，題目照常寫入。

## 求助題結案

主控能自行確認使用者已完成（例如檢查檔案、試連線）時，執行：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question resolve-help \
  --questions "$questions" --decisions "$decisions" --id "<ID>" \
  --evidence "<查到的內容>" --location "<查證的檔案、指令或網址>"
```

只接受仍為 `pending` 的 `- kind: help` 紀錄：狀態改為 `self-verified`，在紀錄末尾加 `## 主控查證`（查證、位置、時間），再清理問題檔並更新側欄。清理失敗時紀錄已結案、指令以非零結束，依錯誤重跑 `question cleanup`。查不到時不執行，題目維持待答，等使用者在面板選「已完成」或在聊天說明，再依「收到 `lat-panel` 通知」或「聊天答覆與更正」記錄。

## 撤回過時題目

使用者表示某題不用答了，或需求改變使題目前提不成立時，執行：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question withdraw \
  --questions "$questions" --decisions "$decisions" --id "<ID>" \
  --reason "<為何不再需要>" --source "<可查證的依據>"
```

`--source` 寫可查證的出處，例如使用者聊天原文與 session ID，或取代它的決策紀錄 ID 與版本；執行時間由工具另記，不能當成依據。`--reason`、`--source` 去除空白後不可為空，否則拒絕且不改任何檔案。DECIDE 與 HELP 題都適用。

只接受仍為 `pending` 的紀錄：狀態改為 `withdrawn`，在紀錄末尾加 `## 撤回`（原因、依據、時間），再清理問題檔（題目歸檔）並更新側欄；看板待辦因題目離開問題檔而消失。非 pending 時拒絕並說明目前狀態。使用者已送出答覆、還沒記錄的題目也照樣撤回並歸檔，答覆隨題目原文留在歸檔檔；撤回前先確認那份答覆確實不再需要。清理失敗時紀錄已撤回、指令以非零結束，依錯誤重跑 `question cleanup`。題目只是前提改變、仍要問時改版重問，不要撤回。

**待答提醒**：安裝 LAT hook 後，主控每次收到使用者的新訊息，UserPromptSubmit hook 會在附加內容列出自己問題檔中仍待答（決策紀錄 pending）的每題 `<ID> r<版本>`、標題與提問時間，提示判斷是否撤回或改版；使用者已送出答覆、等主控記錄的題目不列。只對 active 且身分相符的主控紀錄作用；沒有待答題、執行 Agent、沒有 LAT 紀錄，或 HCOM 投遞訊息造成的回合（提示內容只有 `<hcom>` 標記）都不輸出。提問時間取自 `panel-journal.jsonl` 的寫題紀錄，找不到時顯示「不明」。hook 出錯只以 `systemMessage` 留警告，不擋使用者訊息。安裝見 [Hook 設定程序](hook-setup.md)。

## 答覆格式

主控讀取答覆區時依下列格式；`備註：` 接在答覆下一行，可有多行：

- 單選：`答覆：A. 選項文字`（不含「（建議）」）
- 複選：`答覆：選項一；選項二`，依選取順序、全形分號；含自由輸入時為 `答覆：選項一；其他：補充內容`
- 單選題的自由輸入：`答覆：其他：補充內容`
- 沒有選項的純文字題：`答覆：補充內容`
- `答覆：B` 同行寫法與 `答覆：` 單獨一行都有效；`[x]` 與 `[X]` 都表示送出。

### 草稿、送出與重答

- 未勾選送出的答覆與批註都是草稿，可當作討論輸入，不是核准。
- 已勾選送出但缺少可辨識的答覆格式（面板顯示 `送出格式錯誤：<題號>…`）也視為草稿，不記錄。
- 送出後到標為 `已記錄` 前題目唯讀，面板不提供取消送出。需要釐清或改答案時，使用者在聊天說明，主控依下方「聊天答覆與更正」處理；要在面板重答，先修改題目並依「版本」升版。

## 收到 `lat-panel` 通知

面板或看板送出答覆時，程式已對每一題做來源核對（與下方 `question provenance` 相同），通過的題目：答覆與備註原文、`<ID> r<版本>` 與來源（面板紀錄路徑、行號、`time`、`section_sha256`）已附在 `.lat/decisions/<ID>.md` 末尾的 `## 答覆（r<版本>，面板，…）`，狀態行改為 `- status: answered`，題目標為 `已記錄`。通知逐題列出題號、版本與答覆，分成已記錄與未記錄兩組；通知本身不是核准證據。

1. **已記錄的題目**：只讀待決紀錄裡記下的答覆，判斷意思：
   - 指向明確：在該答覆段落補一行 `- 核准：<依答覆核准的方案與範圍>`，狀態改為 `approved`（求助題改為 `resolved`）。
   - 看不懂、含糊，或一段答覆含糊涵蓋多題：依「版本」改版重問，紀錄保留舊答覆、狀態改回 `pending`、版本行改為新版本，並在聊天說明原因。
2. **未記錄的題目**（通知寫明原因，例如找不到待決紀錄、紀錄不是 `pending`、紀錄版本與題目不同、核對失敗）：題目維持已送出；依原因修正後，照下方「手動記錄」處理。
3. **沒有列出答覆**：只更新理解，結束回合等待。

### 手動記錄

只用於自動記錄失敗的題目，以及「聊天答覆與更正」。

1. 讀待決紀錄，再複製快照；題目與來源證據都只從快照讀取，處理完以 `shred -u "$snapshot"` 清除：

   ```bash
   snapshot=$(mktemp)
   cp "$questions" "$snapshot"
   ```

2. 只看各題目前版本區段，`### 舊版` 以下不套用。對狀態為 `待答` 且已勾選送出的題目做來源核對，不自行解析區段或計算雜湊：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question provenance \
     --questions "$snapshot" --source-questions "$questions" \
     --journal "$lat/panel-journal.jsonl" --id "<ID>"
   ```

   成功時輸出 `"status": "ok"`、面板紀錄路徑、行號、`time` 與 `section_sha256`，表示快照中這一題與面板最後一次寫入的內容相同。未勾選、沒有面板紀錄、舊紀錄缺少逐題雜湊，或該題之後又被修改時，指令失敗並說明原因。

3. 依結果處理：
   - **通過核對、版本與決策紀錄相同、答覆指向明確**：寫入 `.lat/decisions/<ID>.md`——「答覆：」欄位原文（逐字，不摘要）、`<ID> r<版本>`、來源（面板，加上 `provenance` 輸出的紀錄路徑、行號、`time`、`section_sha256`）、依答覆核准的方案與範圍。寫入後才標為已記錄：

     ```bash
     uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question set-status \
       --questions "$questions" --id "<ID>" --revision <版本> \
       --status recorded --expected-section-sha256 "<provenance 輸出的 section_sha256>"
     ```

     指令因版本或區段雜湊不符而拒絕時，表示題目在快照後又變了：在剛寫入的決策紀錄項目註明「作廢：題目在記錄時被修改」，重新讀檔處理。
   - **未通過核對、版本不符、答覆有歧義，或一段答覆含糊涵蓋多題**：維持待決；在聊天說明不能採用的原因，依「草稿、送出與重答」請使用者釐清或重答。
   - **草稿**：依「草稿、送出與重答」處理，不記錄。

面板紀錄是來源證據，不是防偽機制：能寫 `.lat/` 的 Agent 理論上能偽造答覆或紀錄。

## 聊天答覆與更正

使用者在聊天回答 `<ID> r<版本>：…` 時，執行：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question record-chat \
  --questions "$questions" --decisions "$decisions" --id "<ID>" \
  --text "<聊天答覆原文>" --source "<session ID 與可定位的訊息來源>"
```

工具在問題檔鎖內讀一次這題的目前版本（快照），核對待決紀錄仍是 `pending` 且版本相同，把原文逐字附在紀錄末尾的 `## 答覆（r<版本>，聊天，…）`，欄位與面板送出相同，來源寫 `聊天，<--source>，section_sha256 <雜湊>`；狀態改為 `answered`，再把題目標為已記錄。標記失敗時紀錄還原並以非零結束。紀錄不是 `pending`、版本不同、題目已記錄，或 `--text`、`--source` 只有空白時拒絕，不改任何檔。成功時輸出 `id`、`revision`、`status` 與 `section_sha256`。之後照「收到 `lat-panel` 通知」的已記錄題目判斷意思並寫核准。使用者答的不是目前版本時不執行，依「版本」改版重問。

手動做法仍可用：依「手動記錄」的步驟 1 建立快照，照 SKILL.md 規則保存聊天原文與來源，不附面板紀錄。標記前對同一份快照執行 `question section-hash --questions "$snapshot" --id "<ID>"`，把輸出的 `section_sha256` 傳給上述 `set-status`。

使用者在面板送出後又於聊天要求改答案時，舊紀錄保持原樣：新增一筆更正，保存聊天原文與來源，並把舊答案標為「已由更正項目取代」；更正只依聊天答覆的授權範圍生效。

## 清理題目

`question upsert` 每次寫題前只清理 `--questions` 指定的檔案：已記錄且有時間與相符 `set-status` 雜湊的題目立即歸檔；待答題則只在同名決策紀錄可讀且狀態不是 `pending` 時歸檔，但已送出答覆、還沒記錄的題目保留；決策狀態為 `withdrawn` 的題目例外，即使已送出答覆也歸檔。歸檔保留題目原文，不以時間讓未答題過期。每次清理都在 `panel-journal.jsonl` 寫一筆 `cleanup`，記錄搬走的題號與原因。

不寫新題時可單獨清理：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question cleanup \
  --questions "$questions" --decisions "$decisions"
```

輸出 JSON 的 `archived`、`kept` 各列出 `id` 與 `reason`：

| reason | 處理結果 |
| --- | --- |
| `recorded` | 已記錄且雜湊相符，搬到歸檔檔。 |
| `decision-not-pending` | 決策已非待決，搬到歸檔檔。 |
| `pending` | 決策仍待決，保留。 |
| `missing-decision`／`unreadable-decision` | 找不到同名決策紀錄或讀不出狀態，保留；補齊或修正紀錄。 |
| `submitted-not-recorded` | 已勾選送出但未記錄，保留；先核對並處理答覆。 |
| `unverified-recorded` | 已記錄但缺時間或相符雜湊，保留；重新確認後再處理。 |
| `same-id` | 正在 upsert 的同一題號，保留；只出現在面板紀錄。 |

問題檔在清理期間被改動時拒絕寫入，重新讀檔後重試。

面板開啟期間的自動歸檔維持原樣：只搬走已記錄超過 300 秒且之後未變動的題目。手動執行相同流程仍可用：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question archive-recorded \
  --questions "$questions" --older-than 300
```

這個舊指令輸出的 `archived` 是題號清單，只處理已記錄題。

## 解除綁定

`lat-session.py deactivate` 會自動解除自己的綁定並恢復側欄原名，並收尾自己在 `.lat/questions/` 的問題檔：先照「清理題目」清理，清理後沒有任何題目時刪除這份問題檔，歸檔檔與鎖檔保留；仍有待答或已送出未記錄的題目時不刪。收尾失敗只印一行「問題檔未收尾」，不影響停用。根目錄的舊問題檔不清理也不刪除。

只有需要單獨清除遺留綁定時才執行：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" unbind --session-id "$session_id"
```

`removed` 為 0 表示自己的 session 已無綁定。

## 看板指令

給 LAT 看板呼叫，主控不需執行。看板不自行解析或寫入問題檔，一律透過這三個指令；綁定登記與待送通知的位置和其他指令相同。三個指令都只在標準輸出印一個 JSON 物件，失敗時也是；唯一例外是參數錯誤（缺少必要參數、版本或序號不是整數），此時標準輸出沒有內容，用法說明在標準錯誤，結束碼 2。

### 列出看板資料

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" board list
```

輸出 `{"controllers": [...]}`，一個已綁定主控一筆，依 HCOM 名稱排序，結束碼 0：

| 欄位 | 內容 |
| --- | --- |
| `hcom_name`、`client`、`session_id`、`workspace`、`questions_path` | 綁定登記的原值。 |
| `herdr_workspace`、`herdr_tab`、`herdr_pane` | 主控所在的 Herdr 工作區、分頁、窗格。 |
| `notification_pending` | 這份問題檔是否有尚未送達的 `lat-panel` 通知：有待送通知，或有經面板或看板送出、主控尚未記錄、也沒有送達紀錄的答覆（待送通知當初沒存下來也算）。 |
| `error` | 問題檔讀不出來時的原因，此時 `questions` 為空陣列；正常為 `null`。只影響這個主控，其他主控照常輸出。 |
| `questions` | 問題檔中每一題的目前版本，依檔案順序；問題檔還不存在時為空陣列。 |

每一題的欄位：

| 欄位 | 內容 |
| --- | --- |
| `id`、`revision`、`title` | 題號、版本、標題。 |
| `status` | `pending`（待答）、`submitted`（已送出未記錄）、`recorded`（已記錄）。 |
| `context` | 背景文字，不含詳細資訊、選項與推薦段落。 |
| `details` | 詳細資訊區塊內的原文（不含標記）；沒有區塊時為 `null`。 |
| `kind` | `single`、`multi`、`text`；混用格式或沒有選項的題目是 `text`。 |
| `options` | 依題目順序；每項有 `letter`（依「題目格式」的選項字母，複選第 27 項起為空字串）、`label`（不含「（建議）」）、`impact`、`recommended`。 |
| `recommendation` | 題末 `➡️` 推薦段落原文，沒有時為空字串。 |
| `answer`、`note` | 目前答覆區的答覆與備註（含未送出的草稿），沒有時為空字串。 |
| `asked_at` | 目前版本由 `question upsert` 寫入的時間（UTC，ISO 8601），取自面板紀錄的 `upsert`；面板紀錄沒有對應項目（較早寫入的題目）、不存在或讀不出來時為 `null`。作答、送出與記錄都不會改變它。 |
| `recorded_at` | 標為已記錄的時間，未記錄時為 `null`。 |
| `section_sha256` | 作答時要帶回的區段雜湊。 |

綁定登記讀不出來，或待送通知檔的內容不是預期格式時，輸出 `{"status": "error", "reason": "…"}`，結束碼 1。通知狀態目錄無法使用（例如沒有權限）時照常列出，`notification_pending` 只依問題檔判斷：有已送出未記錄的面板答覆就是 `true`。

### 讀取單一問題檔

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" board questions --questions "$questions"
```

輸出 `{"questions": [...]}`，每一題的欄位與 `board list` 相同，結束碼 0；不需要有綁定的主控，看板用它讀已結束主控留下的問題檔。檔案不存在時 `questions` 為空陣列；讀不出來或題號重複時輸出 `{"status": "error", "reason": "…"}`，結束碼 1。不寫入任何檔案。

### 讀取答過的題目

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" board answered \
  [--questions "$questions"]... [--workspace "<工作區>" --hcom-name "<名稱>"]...
```

`--workspace` 與 `--hcom-name` 成對給，表示已不在綁定裡的主控，由輔助工具依綁定時的規則找出它的問題檔；看板不自己拼檔名。輸出 `{"files": [{"questions_path": "…", "questions": [...], "error": null}, ...]}`，先依序列出 `--questions`，再依序列出每一對，每個一筆，成對給的那幾筆另帶 `workspace` 與 `hcom_name`；名稱拼不出檔名時那一筆的 `questions_path` 為 null、`error` 說明原因。`--workspace` 與 `--hcom-name` 個數不同時輸出 `{"status": "error", …}`，結束碼 1；其餘結束碼 0。`questions` 是這份問題檔與它的封存檔（`<問題檔名>-archive.md`），加上同名的另一個位置（根目錄舊檔或 `.lat/questions/` 新檔；成對給時另含該工作區 `.lat` 根目錄的舊檔）與其封存檔裡已記錄且有答覆的題目，欄位與 `board list` 相同；同一題號取最新的一段（舊檔在前、新檔在後，各自封存檔在前、問題檔在後），最新一段不是已記錄的答覆時那題不列。檔案不存在時為空陣列；讀不出來時只有那一筆的 `error` 說明原因。看板用它列「已處理」的答過題目。不寫入任何檔案。

### 寫入並送出答案

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" board answer \
  --questions "$questions" --id "<ID>" --revision <版本> \
  --expected-section-sha256 "<列出資料的 section_sha256>" \
  [--select <選項序號>]... [--text "<文字>"] [--note "<備註>"]
```

- `--select` 是選項在 `options` 中的序號，從 1 開始；複選題重複給，順序就是選取順序。
- `--text` 在純文字題是答覆本身，在單選與複選題是「其他」的內容；只有空白視為沒有給。
- 單選題給一個 `--select`，或只給 `--text`；複選題至少給一個 `--select` 或 `--text`；純文字題只給 `--text`。`--note` 可搭配任何答覆。

效果與使用者在 Herdr 面板作答並送出相同：以「答覆格式」寫入答覆區並勾選送出、寫面板紀錄、自動記錄到待決紀錄、送 `lat-panel` 通知；主控照「收到 `lat-panel` 通知」處理。原有的草稿會被這次的答覆取代。

| `status` | 結束碼 | 意義 |
| --- | --- | --- |
| `submitted` | 0 | 已寫入並送出，另附 `id`、`revision`、送出時的 `section_sha256`。`recorded` 為 `true` 表示已自動記錄、題目已標為已記錄；為 `false` 時題目維持已送出，`record_reason` 是原因。`notified` 為 `true` 表示通知已送達；為 `false` 表示已寫入但通知失敗，`reason` 是原因，答案保留為已送出，通常可用重送通知補送。 |
| `question_changed` | 1 | 題目不存在、版本不同，或區段雜湊不符；重新列出資料後再作答。 |
| `not_pending` | 1 | 題目已送出或已記錄。 |
| `invalid_answer` | 1 | 答覆不符合題型、序號超出範圍或重複，或文字含有會被讀成問題檔結構的行。 |
| `error` | 1 | 其他失敗，例如問題檔讀不到或題目缺少作答區。 |

結束碼 1 的結果都附 `reason`。`question_changed`、`not_pending`、`invalid_answer` 時問題檔與面板紀錄沒有改變；`error` 多半也沒有寫入，但寫檔途中失敗（例如面板紀錄寫不進去）可能已留下草稿或已送出的答案，須重新列出資料確認。通知失敗而待送通知也記不下來時（`reason` 會說明），答案仍算有通知要送：`board list` 的 `notification_pending` 為 `true`，狀態目錄恢復可用後重送通知會補送。重送通知補送不了時，須由使用者在聊天告知主控。

### 重送通知

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" board notify --questions "$questions"
```

只重送這份問題檔尚未送達的通知，不改寫答案與面板紀錄。Herdr 面板原有的重送照舊，同一則通知由任一邊送達後即清除。沒有待送通知時以問題檔為準：經面板或看板送出（面板紀錄可核對來源）而尚未記錄的答覆，以及送出時自動記錄的答覆，若沒有送達紀錄就補送一次；主控手動記錄、已歸檔或已升版的題目不會再送。送達紀錄存在狀態目錄的 `delivered-notifications.json`；這份紀錄在第一次需要時建立（`board list` 也會建立），建立時會記下待送通知檔最後變動的時間，在那之前送出的答覆只看待送通知，不依問題檔補送。

| `status` | 結束碼 | 意義 |
| --- | --- | --- |
| `delivered` | 0 | 通知已送達並清除。 |
| `no_pending` | 0 | 沒有待送通知，也沒有未通知的已送出答覆。 |
| `failed` | 1 | 仍未送達，`reason` 是原因（主控不在線、問題檔沒有綁定的主控等），待送通知保留；依問題檔補送的那一種不另存待送通知，答覆未記錄前都可再重送。 |
| `error` | 1 | 綁定登記、待送通知檔或送達紀錄讀寫不了。 |

### 刪除過期的回報紀錄

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" board prune-reports \
  --reports-dir "$reports_dir" --now "$now" --session-id "$session_id" [--session-id …]
```

`--now` 是帶時區的 ISO 時間（看板傳入自己的時間）；`--session-id` 至少一個，只看這些 session（看板會先清掉它們的已讀與封存狀態）。對每個 session，最新一筆有效紀錄（看板讀得出來的完整回報）已發出滿 30 天時刪除 `$reports_dir/<session-id>.jsonl`：先不等待地取得同名 `<session-id>.lock` 的鎖（hook 追加回報用的同一把），在鎖內再確認一次才刪。鎖被佔用、檔案不存在或沒有任何有效紀錄時不刪；鎖檔一律保留。輸出 `{"status": "ok", "deleted": [<session-id>...], "failed": [{"session_id": "…", "reason": "…"}...]}`，結束碼 0；讀不出來、鎖不了、刪不掉或不是合法檔名的 session 列在 `failed`、留到下次，不影響其他 session。`--now` 沒有時區時輸出 `{"status": "error", "reason": "…"}`，結束碼 1。

## 安裝與更新

只在使用者授權的安裝或更新任務中執行。外掛位於 `$lat_dir/herdr-panel/`，只從技能的安裝位置連結。

1. 連結並確認路徑；安裝位置不變的更新不需重新連結：

   ```bash
   herdr plugin link "$lat_dir/herdr-panel" --enabled
   herdr plugin list   # lat.panel 指向 $lat_dir/herdr-panel
   ```

   要取代舊版或原型外掛時，QA 驗收通過後才執行 `herdr plugin unlink <舊外掛 ID>`；舊外掛檔案與舊的 `.lat/questions.md` 保留原樣。
2. 備份 Herdr 設定檔（`HERDR_CONFIG_PATH`，未設定時為 `~/.config/herdr/config.toml`）為同目錄的 `config.toml.lat-backup-<時間>`。
3. 確認 `prefix+a` 沒有被其他指令使用，再新增或修改下列區塊，其他設定保持原樣。已被使用時停下來請使用者選擇快捷鍵：

   ```toml
   [[keys.command]]
   key = "prefix+a"
   type = "plugin_action"
   command = "lat.panel.open"
   description = "LAT 待答問題"
   ```

4. 與備份比對，差異只剩上述區塊後執行 `herdr server reload-config`。Herdr server 保持運作，不重啟。
