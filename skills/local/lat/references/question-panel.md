# 待答問題面板

供 LAT 主控在 Herdr 使用 `lat.panel` 外掛時讀取：綁定、寫題、處理 `lat-panel` 通知、解除綁定與安裝更新。面板只是作答介面；`.lat/decisions/<ID>.md` 仍是唯一的權威紀錄，SKILL.md「使用者待決事項」的規則全部照舊適用。

## 是否啟用

主控 shell 有 `HERDR_WORKSPACE_ID`，且 `herdr plugin list` 列出 `lat.panel` 時才啟用本程序。任一條件不成立（沒有 Herdr、外掛未安裝或未啟用），跳過本檔，照舊在聊天提問與記錄答覆；LAT 其他流程不受影響。

## 指令與變數

`lat_dir`、`workspace`、`client` 與主控恢復程序相同。`workspace` 是存放 `.lat/` 的專案根目錄，問題檔固定為 `$workspace/.lat/questions.md`，面板紀錄為 `$workspace/.lat/panel-journal.jsonl`。

```bash
lat_dir=/absolute/path/to/installed/lat
workspace=/absolute/path/to/project-root
client=codex           # Claude 主控改為 claude
hcom_name=<主控自己的 HCOM 名稱>
session_id="$CODEX_THREAD_ID"   # Claude：$CLAUDE_CODE_SESSION_ID
```

shell 狀態不跨呼叫保留時，每次執行前重新設定上述變數。`question` 子指令一律加 `--questions`，不依賴目前目錄。

## 綁定

activate 成功後立即綁定，讓目前 Herdr workspace 的 F2 面板開啟本專案問題檔並通知自己：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" bind \
  --hcom-name "$hcom_name" --client "$client" \
  --session-id "$session_id" --workspace "$workspace"
```

`--herdr-workspace` 預設取 `HERDR_WORKSPACE_ID`。輸出 JSON 的 `replaced` 不是 `null` 時，表示取代了同一 workspace 的舊綁定；把舊綁定的 HCOM 名稱與 session 記入進度索引。session ID 缺少時不綁定、不猜測。Herdr server 重建使 workspace ID 改變時，重新執行綁定。

## 寫題

依「使用者待決事項」先建立 `.lat/decisions/<ID>.md`，再把同一題寫入問題檔；題號即決策紀錄 ID。先將單題寫成暫存檔：

```markdown
## <ID> | r<版本> | pending
問題：
選項：
建議：
影響：
答覆：
批註：
```

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question upsert \
  --questions "$workspace/.lat/questions.md" --id "<ID>" --file /path/to/section.md
```

- 一律透過 `question upsert` 寫入（與面板共用檔案鎖），不手動編輯 `questions.md`。暫存檔中的「答覆」「批註」會被忽略，使用者已填內容保留。
- 新題依暫存檔的版本建立。既有題改了「問題」或「選項」時，指令自動升版、狀態回到 `pending`，舊版答覆與批註移入 `### 舊版 r<N>（不套用至 r<N+1>）`。只改「建議」「影響」不升版。
- 指令印出 `<ID> r<版本>`；以此版本更新決策紀錄。版本改變即為新提案，依「使用者待決事項」保留舊紀錄並重新待決。
- 同時在聊天告知使用者題號與版本；使用者可在面板或聊天任一處作答。

## 收到 `lat-panel` 通知

通知只表示問題檔有變更，本身不是核准證據，也不代表使用者已作答。收到後先讀待決紀錄，再複製一份快照；所有題目與來源證據都只從這份快照讀取：

```bash
snapshot=$(mktemp)
cp "$workspace/.lat/questions.md" "$snapshot"
```

處理完以 `shred -u "$snapshot"` 清除快照。只看各題目前版本區段，`### 舊版` 以下一律不套用。

**面板來源核對**：對每個 `ready` 題目執行下列指令，不自行解析區段或計算雜湊：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question provenance \
  --questions "$snapshot" --journal "$workspace/.lat/panel-journal.jsonl" --id "<ID>"
```

成功時輸出 `"status": "ok"`、題號、面板紀錄路徑、行號、時間與 `section_sha256`。這表示快照中該題目前版本區段，與面板最後一次變更該題時記錄的區段相同；之後 Agent 修改其他題目不影響核對。沒有該題的面板紀錄、舊紀錄缺少逐題雜湊，或同一題之後又被修改時，指令失敗並說明原因，依第 2 點處理。

1. **`ready`、版本與決策紀錄相同、答覆指向明確，且通過面板來源核對**：寫入 `.lat/decisions/<ID>.md`：
   - 「答覆：」欄位原文，逐字複製，不摘要、不改寫；
   - 題號與版本 `<ID> r<版本>`；
   - 來源：面板，以及 `provenance` 輸出的面板紀錄路徑、行號、`time` 與 `section_sha256`；
   - 依答覆核准的方案與範圍。

   寫入後才標為 `recorded`，並傳入 `provenance` 輸出的區段雜湊。版本或區段雜湊不符時，表示同一題在快照後已變更；不可把目前內容標成已記錄，重新讀檔處理：

   ```bash
   uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" question set-status \
     --questions "$workspace/.lat/questions.md" --id "<ID>" --revision <版本> \
     --status recorded --expected-section-sha256 "<provenance 輸出的 section_sha256>"
   ```
2. **未通過面板來源核對、版本不符、答覆有歧義，或一段答覆含糊涵蓋多題**：不放行，維持待決；在聊天說明不能採用的原因，請使用者釐清，或在面板再存檔一次、改在聊天回答。
3. **`pending` 題的答覆、任何批註**：都是草稿，不是核准。批註作為討論輸入回應；需要時修改題目並依「寫題」升版。
4. **沒有 `ready` 題的變更**：只更新理解，不改變授權；處理完結束回合等待。

使用者在聊天回答 `<ID> r<版本>：…` 時，照 SKILL.md 規則保存聊天原文與來源，不附面板紀錄。標記前先對同一份快照執行 `question section-hash --questions "$snapshot" --id "<ID>"`，再把輸出的 `section_sha256` 傳給上述 `set-status`，讓面板反映狀態；不需要偽造面板來源。

面板紀錄與檔案權限只是來源證據，不是防偽機制：能寫 `.lat/` 的 Agent 理論上能偽造答覆或紀錄。

## 解除綁定

交付或取消前、deactivate 之前，只解除自己的綁定：

```bash
uv run --no-project python "$lat_dir/herdr-panel/lat_panel.py" unbind --session-id "$session_id"
```

`removed` 為 0 表示自己已無綁定（例如已被新中控取代），不去動其他 session 的綁定。

## 安裝與更新

外掛隨 LAT 技能安裝在 `$lat_dir/herdr-panel/`；只從技能的安裝位置連結，不連結 repo 工作區或 worktree。只在使用者授權的安裝或更新任務中執行。

1. 連結外掛並確認路徑：

   ```bash
   herdr plugin link "$lat_dir/herdr-panel" --enabled
   herdr plugin list   # lat.panel 指向 $lat_dir/herdr-panel
   ```

   以 `lat.panel` 取代舊版或原型外掛時，在 QA 驗收通過後的授權安裝任務中才執行 `herdr plugin unlink <舊外掛 ID>`；舊外掛的問題檔保留原樣不刪，`.lat/questions.md` 是另一份新檔。

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
