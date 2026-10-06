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
questions="$workspace/.lat/questions-$hcom_name.md"  # 以 bind 輸出的 questions_path 為準
```

每個主控各用一份問題檔。面板紀錄在 `$workspace/.lat/panel-journal.jsonl`，歸檔檔是問題檔同目錄的 `<問題檔名不含副檔名>-archive.md`。

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

1. 依「使用者待決事項」建立 `.lat/decisions/<ID>.md`；題號就是決策紀錄 ID。
2. 依下方「題目格式」把這一題寫成暫存檔，只放標題與內文：

   ```markdown
   ## 正式版要怎麼併入？

   審查和驗收都通過了，本機也已經裝好，現在只差要不要把它併進 dev。

   A. 合併到 dev，不推送（建議）
      本機安裝內容會與 dev 一致，但 GitHub 不會改變。
   B. 合併到 dev，並推送到 GitHub
      本機與遠端都會更新。
   C. 先不合併
      繼續保留在目前分支。
   ```

3. 寫入問題檔。一律用這個指令（與面板共用檔案鎖），不手動編輯 `$questions`：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question upsert \
     --questions "$questions" --id "<ID>" --file /path/to/section.md
   ```

4. 指令印出 `<ID> r<版本>`；用這個版本更新決策紀錄。升版規則見下方「版本」。
5. 發出 `DECIDE:` 前完成下方「待決題目檢查」，通過後依「聊天提問格式」列出題目；使用者可在面板或聊天作答。

### 題目格式

- 標題直接寫問題本身；內文先用一句話交代背景。不使用「問題／選項／建議／影響／批註」等欄位名稱。
- 單選題用 `A. 選項`、`B. 選項`；複選題用未勾選的 `- [ ] 選項`。兩種不可混用，混用或沒有選項時面板改成純文字輸入。
- 每個選項的影響寫在下一行，縮排至少一格（建議三格）。
- 建議方案只在選項文字結尾標「（建議）」。
- **選項字母**：面板與聊天使用相同字母。單選題用題目檔的字母，複選題依順序標 `A.`、`B.`…，最後一列「其他（自己輸入）」接續下一個字母。使用者按字母鍵 A–I（不分大小寫）選擇；游標在「其他」列或輸入框中時，字母照常當文字輸入。
- 每題盡量不超過九個選項（A–I），使用者才能直接按字母選；超過的選項仍可用方向鍵選。字母只到 Z：複選題第 27 項起與之後的「其他」列不標字母。
- 工具自動加入題號、版本、`待答`、空白作答區與 `- [ ] 送出`；既有題的答覆與勾選狀態不會被覆寫。

### 聊天提問格式

標題、背景句、選項文字（含結尾「（建議）」）與影響說明照題目原文，不改寫、不改成項目符號；字母依「題目格式」。建議理由只寫在 `➡️` 那一行。補做諮詢的參謀結論為 `late resolved` 或 `late self-check` 時，`➡️` 行另附參謀的建議做法與引用的授權來源。多題用 `---` 分隔：

```markdown
❓ **<ID> r<版本>** - **<標題>**

<背景句>

A. <選項>（建議）
   <影響說明>
B. <選項>
   <影響說明>

➡️ A：<為什麼建議>

---

❓ **<下一題 ID> r<版本>** - …
```

### 版本

新題從 r1 開始。標題或內文有任何改變時自動升版、狀態回到 `待答`、清除送出勾選，舊版作答區移入 `### 舊版 r<N>（不套用至 r<N+1>）`；內容完全相同時保留版本與答覆。版本改變就是新提案，依「使用者待決事項」保留舊紀錄並重新待決。

### 待決題目檢查

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question check-pending \
  --questions "$questions" --decisions "$decisions"
```

檢查會搜尋 `--questions` 同目錄下所有 `questions-*.md` 與 `questions-*-archive.md`，並列出找到每個題號的檔案。依輸出處理，修正後重跑；只有印出「沒有遺漏」才繼續提問：

| 輸出 | 處理 |
| --- | --- |
| 沒有遺漏 | 所有 pending 決策都有待答題，可繼續。 |
| 遺漏待答題目 | 先補題。 |
| 狀態不一致 | 決策仍是 pending，但題目已記錄或已歸檔；依列出的檔案核對並修正決策紀錄。 |
| 讀不出狀態 | 依逐檔列出的原因修正決策紀錄；指令以非零結束碼結束，不印「沒有遺漏」。 |

決策紀錄與停住監控共用以下狀態讀法：

- 取第一行以 `- status:` 開頭的行；鍵名不分大小寫、冒號後空白可多可少。
- 值的第一個字不分大小寫：`pending` 是待決，其餘視為已處理。
- 沒有狀態行、值為空或只有空白，或第一個字不是 `pending` 但後面含有 `pending`，均為「讀不出狀態」。停住監控將其視為仍在待決，並在監控紀錄留說明。

參謀諮詢中的 `advising` 與參謀結案的 `advisor-resolved` 都不是 `pending`，不寫面板；`pending` 紀錄發出 `DECIDE:` 前須先有參謀行，見 [參謀](advisors.md#待決紀錄的狀態與參謀行)。

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

通知表示問題檔有題目被勾選送出；通知本身不是核准證據，也不代表每一題都已作答。

1. 讀待決紀錄，再複製快照；題目與來源證據都只從快照讀取，處理完以 `shred -u "$snapshot"` 清除：

   ```bash
   snapshot=$(mktemp)
   cp "$questions" "$snapshot"
   ```

2. 只看各題目前版本區段，`### 舊版` 以下不套用。對每個狀態為 `待答` 且已勾選送出的題目做來源核對，不自行解析區段或計算雜湊：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question provenance \
     --questions "$snapshot" --source-questions "$questions" \
     --journal "$workspace/.lat/panel-journal.jsonl" --id "<ID>"
   ```

   成功時輸出 `"status": "ok"`、面板紀錄路徑、行號、`time` 與 `section_sha256`，表示快照中這一題與面板最後一次寫入的內容相同。未勾選、沒有面板紀錄、舊紀錄缺少逐題雜湊，或該題之後又被修改時，指令失敗並說明原因。

3. 依結果處理每一題：
   - **通過核對、版本與決策紀錄相同、答覆指向明確**：寫入 `.lat/decisions/<ID>.md`——「答覆：」欄位原文（逐字，不摘要）、`<ID> r<版本>`、來源（面板，加上 `provenance` 輸出的紀錄路徑、行號、`time`、`section_sha256`）、依答覆核准的方案與範圍。寫入後才標為已記錄：

     ```bash
     uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question set-status \
       --questions "$questions" --id "<ID>" --revision <版本> \
       --status recorded --expected-section-sha256 "<provenance 輸出的 section_sha256>"
     ```

     指令因版本或區段雜湊不符而拒絕時，表示題目在快照後又變了：在剛寫入的決策紀錄項目註明「作廢：題目在記錄時被修改」，重新讀檔處理。
   - **未通過核對、版本不符、答覆有歧義，或一段答覆含糊涵蓋多題**：維持待決；在聊天說明不能採用的原因，依「草稿、送出與重答」請使用者釐清或重答。
   - **草稿**：依「草稿、送出與重答」處理，不記錄。
   - **沒有已勾選送出的題目**：只更新理解，結束回合等待。

面板紀錄是來源證據，不是防偽機制：能寫 `.lat/` 的 Agent 理論上能偽造答覆或紀錄。

## 聊天答覆與更正

使用者在聊天回答 `<ID> r<版本>：…` 時，依「收到 `lat-panel` 通知」的步驟 1 建立快照，照 SKILL.md 規則保存聊天原文與來源，不附面板紀錄。標記前對同一份快照執行 `question section-hash --questions "$snapshot" --id "<ID>"`，把輸出的 `section_sha256` 傳給上述 `set-status`。

使用者在面板送出後又於聊天要求改答案時，舊紀錄保持原樣：新增一筆更正，保存聊天原文與來源，並把舊答案標為「已由更正項目取代」；更正只依聊天答覆的授權範圍生效。

## 清理已記錄題目

面板開啟期間會自動把已記錄超過 300 秒且之後未變動的題目搬到歸檔檔。面板沒開時，主控執行同一套清理：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question archive-recorded \
  --questions "$questions" --older-than 300
```

輸出 JSON 的 `archived` 是搬走的題號。問題檔在執行中被改動時指令拒絕寫入，重試即可。只有 `已記錄` 卻沒有時間或沒有相符 `set-status` 紀錄的舊題會被保留，由主控重新確認後再處理。

## 解除綁定

`lat-session.py deactivate` 會自動解除自己的綁定。只有需要單獨清除遺留綁定時才執行：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" unbind --session-id "$session_id"
```

`removed` 為 0 表示自己的 session 已無綁定。

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
