# 待答問題面板

供 LAT 主控在 Herdr 使用 `lat.panel` 外掛時讀取：綁定、寫題、處理 `lat-panel` 通知、解除綁定與安裝更新。面板只是作答介面；`.lat/decisions/<ID>.md` 仍是唯一的權威紀錄，SKILL.md「使用者待決事項」的規則全部照舊適用。

## 是否啟用

主控 shell 有 `HERDR_WORKSPACE_ID`，且 `herdr plugin list` 列出 `lat.panel` 時才啟用本程序。任一條件不成立（沒有 Herdr、外掛未安裝或未啟用），跳過本檔，照舊在聊天提問與記錄答覆；LAT 其他流程不受影響。

## 指令與變數

`lat_dir`、`workspace`、`client` 與主控恢復程序相同。`workspace` 是存放 `.lat/` 的專案根目錄。每個主控各用一份 `$workspace/.lat/questions-<hcom-name>.md`；檔名會把 HCOM 名稱轉小寫，將英數字、`_`、`-` 以外的連續字元換成 `-`，並移除開頭與結尾的 `-`、`_`。正常 HCOM 名稱不會改變。面板紀錄為 `$workspace/.lat/panel-journal.jsonl`。歸檔檔名由問題檔推導為同目錄下的 `<問題檔名不含副檔名>-archive.md`。

```bash
lat_dir=/absolute/path/to/installed/lat
workspace=/absolute/path/to/project-root
client=codex           # Claude 主控改為 claude
hcom_name=<主控自己的 HCOM 名稱>
session_id="$CODEX_THREAD_ID"   # Claude：$CLAUDE_CODE_SESSION_ID
questions="$workspace/.lat/questions-$hcom_name.md"  # 正常 HCOM 名稱；以 bind 輸出的 questions_path 為準
```

shell 狀態不跨呼叫保留時，每次執行前重新設定上述變數。`question` 子指令一律加 `--questions`，不依賴目前目錄。

## 綁定

activate 成功後立即綁定，記下目前主控所在的 Herdr workspace、tab 與 pane，讓 F2 面板依所在 tab 開啟對應主控的問題檔並通知該主控：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" bind \
  --hcom-name "$hcom_name" --client "$client" \
  --session-id "$session_id" --workspace "$workspace"
```

`--herdr-workspace`、`--herdr-tab`、`--herdr-pane` 分別預設取 `HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`、`HERDR_PANE_ID`。綁定以 session ID 為鍵；同一 session 重綁只更新自己，不會覆蓋同 workspace 的其他主控。輸出 JSON 的 `replaced` 不是 `null` 時，表示更新了自己上一筆綁定。任一必要 ID 缺少時不綁定、不猜測。

按 F2 時，外掛先用 Herdr 0.9.3 的即時 pane/tab 快照找「主控 pane 現在位於目前 tab」的綁定；只有查詢失敗時才採用綁定時記下的 tab。若目前 tab 沒有主控，但 workspace 只有一個綁定，就直接開啟；有兩個以上則先顯示單行數字選單，按數字選檔，無效按鍵不動作，Ctrl+Q 關閉。每頁最多九個主控，超過時用左右方向鍵換頁後再按單一數字；完全沒有綁定才顯示「此 workspace 沒有綁定的 LAT 中控」。通知送出前會依問題檔自己的 session 再查一次綁定，不借用同 workspace 的其他主控。

舊版 `bindings.json` 以 workspace 為鍵，正式版不會拿來路由；讀取時會回報 `legacy bindings ignored`。第一個主控重新綁定時會建立 v2 資料並回報 `legacy_ignored` 數量，其他主控再逐一綁定。既有 `.lat/questions.md` 不會自動搬移或刪除；由主控按實際待決內容手動移入自己的新問題檔。

## 寫題

依「使用者待決事項」先建立 `.lat/decisions/<ID>.md`，再把同一題寫入問題檔；題號即決策紀錄 ID。先將單題寫成暫存檔：

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

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question upsert \
  --questions "$questions" --id "<ID>" --file /path/to/section.md
```

- 一律透過 `question upsert` 寫入（與面板共用檔案鎖），不手動編輯 `$questions`。暫存檔只放標題與自然書寫的內文；工具會加入題號、版本、`待答`、空白作答區與 `- [ ] 送出`。既有題的答覆與勾選狀態不會被 Agent 覆寫。
- 標題直接寫問題本身。內文先用一句話交代背景，再逐項列出選項與影響；建議方案標在選項名稱上。選項前不加 `-`，選項之間不留空行，影響說明縮排三個空白。不使用「問題／選項／建議／影響／批註」等欄位名稱。
- 新題從 r1 建立。既有題的標題或內文有任何改變時，指令自動升版、狀態回到 `待答`、清除送出勾選；舊版作答區移入 `### 舊版 r<N>（不套用至 r<N+1>）`。標題與內文完全相同時保留版本、答覆、狀態與勾選框。
- 指令印出 `<ID> r<版本>`；以此版本更新決策紀錄。版本改變即為新提案，依「使用者待決事項」保留舊紀錄並重新待決。
- 同時在聊天告知使用者題號與版本；使用者可在面板或聊天任一處作答。

## 收到 `lat-panel` 通知

通知只表示問題檔有變更，本身不是核准證據，也不代表使用者已作答。收到後先讀待決紀錄，再複製一份快照；所有題目與來源證據都只從這份快照讀取：

```bash
snapshot=$(mktemp)
cp "$questions" "$snapshot"
```

處理完以 `shred -u "$snapshot"` 清除快照。只看各題目前版本區段，`### 舊版` 以下一律不套用。

**面板來源核對**：對每個狀態為 `待答` 且已勾選 `- [x] 送出` 的題目執行下列指令，不自行解析區段或計算雜湊。未勾選時，`provenance` 會拒絕：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question provenance \
  --questions "$snapshot" --source-questions "$questions" \
  --journal "$workspace/.lat/panel-journal.jsonl" --id "<ID>"
```

成功時輸出 `"status": "ok"`、題號、來源問題檔、面板紀錄路徑、行號、時間與 `section_sha256`。`--questions` 是唯讀快照，`--source-questions` 是面板實際編輯的專屬問題檔，用來隔離同一專案其他主控的同名題號。這表示快照中該題目前版本區段，與面板最後一次變更該來源檔案中該題時記錄的區段相同；之後 Agent 修改其他題目或其他主控的問題檔不影響核對。沒有該來源檔案該題的面板紀錄、舊紀錄缺少逐題雜湊，或同一題之後又被修改時，指令失敗並說明原因，依第 2 點處理。

1. **已勾選送出、版本與決策紀錄相同、答覆指向明確，且通過面板來源核對**：寫入 `.lat/decisions/<ID>.md`：
   - 「答覆：」欄位原文，逐字複製，不摘要、不改寫；
   - 題號與版本 `<ID> r<版本>`；
   - 來源：面板，以及 `provenance` 輸出的面板紀錄路徑、行號、`time` 與 `section_sha256`；
   - 依答覆核准的方案與範圍。

   寫入後才標為 `已記錄`，並傳入 `provenance` 輸出的區段雜湊。CLI 的 `--status recorded` 參數名稱為了相容性維持不變。成功後狀態列會寫成 `已記錄 · <ISO 8601 本機時間>`；完整日期、秒數與 UTC offset 用來可靠計算五分鐘，不受跨日或時區影響。版本或區段雜湊不符時，表示同一題在快照後已變更；不可把目前內容標成已記錄，重新讀檔處理：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question set-status \
     --questions "$questions" --id "<ID>" --revision <版本> \
     --status recorded --expected-section-sha256 "<provenance 輸出的 section_sha256>"
   ```
2. **未通過面板來源核對、版本不符、答覆有歧義，或一段答覆含糊涵蓋多題**：不放行，維持待決；在聊天說明不能採用的原因，請使用者釐清，或在面板再存檔一次、改在聊天回答。
3. **未勾選送出的答覆**：包含使用者寫在作答區的任何批註，全部都是草稿，不是核准。內容可作為討論輸入回應；需要時修改題目並依「寫題」升版。
4. **沒有已勾選送出的題目變更**：只更新理解，不改變授權；處理完結束回合等待。

使用者在聊天回答 `<ID> r<版本>：…` 時，照 SKILL.md 規則保存聊天原文與來源，不附面板紀錄。標記前先對同一份快照執行 `question section-hash --questions "$snapshot" --id "<ID>"`，再把輸出的 `section_sha256` 傳給上述 `set-status`，讓面板反映狀態；不需要偽造面板來源。

面板紀錄與檔案權限只是來源證據，不是防偽機制：能寫 `.lat/` 的 Agent 理論上能偽造答覆或紀錄。

## 清理已記錄題目

面板開啟時會立即檢查，開啟期間也會定期檢查；已記錄超過 300 秒且內容自記錄後未變的整題，連同題內的舊版區塊一起附加到衍生出的歸檔檔，並從問題檔移除。這次清理沿用問題檔鎖與條件式替換，寫入 `panel-journal.jsonl` 的 `archive-recorded` 紀錄，但不建立或送出 HCOM 通知。剛好 300 秒尚不搬移；必須超過 300 秒。

若題目在標記後又被修改、面板仍有未存內容或衝突草稿，面板不會靜默搬移。舊資料只有 `已記錄`、沒有時間或缺少相符的 `set-status` 紀錄時也會安全保留，需由主控重新確認，不以檔案時間猜測。

沒有開啟面板時，主控可執行同一套清理：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question archive-recorded \
  --questions "$questions" --older-than 300
```

指令輸出 JSON 的 `archived` 題號列表；問題檔若在快照後改變，指令拒絕寫入並要求重試。歸檔檔只做附加，不會改寫既有內容。

## 解除綁定

交付或取消前、deactivate 之前，只解除自己的綁定：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" unbind --session-id "$session_id"
```

`removed` 為 0 表示自己的 session 已無綁定；同一 workspace 的其他 session 不受影響。

## 安裝與更新

外掛隨 LAT 技能安裝在 `$lat_dir/herdr-panel/`；只從技能的安裝位置連結，不連結 repo 工作區或 worktree。只在使用者授權的安裝或更新任務中執行。

1. 連結外掛並確認路徑：

   ```bash
   herdr plugin link "$lat_dir/herdr-panel" --enabled
   herdr plugin list   # lat.panel 指向 $lat_dir/herdr-panel
   ```

   以 `lat.panel` 取代舊版或原型外掛時，在 QA 驗收通過後的授權安裝任務中才執行 `herdr plugin unlink <舊外掛 ID>`；舊外掛與舊版 `.lat/questions.md` 都保留原樣，不自動刪除或搬移；正式使用的是各主控自己的 `.lat/questions-<hcom-name>.md`。

   更新技能檔案但安裝位置不變時，不需重新連結；搬動技能目錄後重新連結。
2. 備份 Herdr 設定檔（`HERDR_CONFIG_PATH`，未設定時為 `~/.config/herdr/config.toml`）為同目錄的 `config.toml.lat-backup-<時間>`。
3. 只修改 `prefix+f2` 這一個 `[[keys.command]]` 區塊，其他設定（含使用者自己的修改）保持原樣；已有 `prefix+f2` 時只改它的 `command`：

   ```toml
   [[keys.command]]
   key = "prefix+f2"
   type = "plugin_action"
   command = "lat.panel.open"
   description = "LAT 待答問題"
   ```

4. 與備份比對差異只剩上述區塊，再執行 `herdr server reload-config` 套用。不重啟或停止 Herdr server。
