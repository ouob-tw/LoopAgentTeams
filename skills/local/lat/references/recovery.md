# 主控恢復

供 Codex 與 Claude 的 LAT 主控使用。閱讀／審查 LAT、安裝技能與執行 Agent 不啟用。helper 只用 Python 標準函式庫，以 `uv run --no-project python` 執行。所有子指令的 `--client` 預設 `codex`，Claude 主控一律加 `--client claude`。

Claude 壓縮後只重新附上每個技能前 5,000 tokens（合計 25,000），references 不會附回，因此同樣需要此 hook。Claude 的恢復提示直接附上 `references/agents.md` 與 `references/task-cards.md` 全文（壓縮後最常漏掉的派工與收尾規則），合計須低於 Claude 的 10,000 字上限；Codex 的提示上限約 2,500 tokens，仍只給路徑由主控自行重讀。

## 主控啟動與結束

1. 讀完專案設定後，先選定既有進度索引、共用待決目錄與任務卡目錄。沒有索引時，先建立短檔案，指向 tracker／Spec 與現有整合摘要；不要重建清單。確認待決目錄與任務卡目錄存在（任務卡目錄可以是空的）。
2. 在建立本次進度清單之前執行 activate。`lat_dir` 必須是本次實際載入的 LAT 技能目錄；以下路徑由專案設定取得，不照抄範例。

```bash
lat_dir=/absolute/path/to/installed/lat
workspace=/absolute/path/to/git-worktree
progress=/absolute/path/to/existing-progress.md
decisions=/absolute/path/to/shared/decisions
tasks=/absolute/path/to/shared/.lat/tasks
client=codex  # Claude 主控改為 claude
hcom_name=<主控自己的 HCOM 名稱>
uv run --no-project python "$lat_dir/scripts/lat-session.py" activate --client "$client" \
  --workspace "$workspace" --progress "$progress" --decisions "$decisions" \
  --tasks "$tasks" --hcom-name "$hcom_name"
```

activate 直接讀取主控 shell 的 session ID（Codex：`CODEX_THREAD_ID`；Claude：`CLAUDE_CODE_SESSION_ID`），不接受指定 ID；缺少時停止並回報，不猜 ID、不用 HCOM 名稱替代。`--workspace` 須是 Git worktree 根目錄。`--hcom-name` 一律必填，只接受明確值，不讀 `HCOM_INSTANCE_NAME`；缺少時不建立 session 紀錄，照錯誤中的完整指令補上名稱重跑。session 紀錄、監控 pid／log 與主控自己的等待聲明一律放在主工作區共用的 `.lat`；在 linked worktree 內 activate 也一樣，不在 worktree 內建 `.lat`（更新前已留在 worktree `.lat` 的紀錄照原位置讀取與停用，不搬移）。成功會印出 `.lat/sessions/<session-id>.json` 絕對路徑與「已開始第 N 輪」（沒有歷史的紀錄視為第 1 輪），紀錄 client、session、主控角色、工作區、active 狀態、HCOM 名稱與恢復路徑（含任務卡目錄），並在背景啟動停住監控 `lat-watch.py run`（pid 在 `.lat/watch/<session-id>.pid`，輸出在同名 `.log`）。active 紀錄內容不同時拒絕覆寫；相同內容可重跑。每個檢查點更新同一進度索引，保留 tracker 連結及下一步。

   同一對話在上一輪停用後，可在同一工作區用上方 activate 指令與本輪的路徑、HCOM 名稱開始新一輪。上一輪的狀態、結束時間、技能目錄、恢復路徑、HCOM 名稱與技能文字指紋依序保存在紀錄的 `history` 清單；目前欄位換成本輪內容（不帶結束時間），重新計算指紋，照常綁定面板、啟動監控與設定分頁名稱。deactivate、恢復 hook 與回合結束檢查只讀目前欄位；不清除或搬移共用的待決紀錄、任務卡、監控狀態與等待聲明。其他狀態或無法辨識的紀錄仍拒絕；不要刪除或手動重建 session 紀錄。

   舊版 activate 建立的 active 紀錄沒有 `tasks_path` 與 `hcom_name`。恢復 hook 會照常提示讀取紀錄，但不會啟動停住監控；請將上方同一條 activate 指令的 `--tasks "$tasks" --hcom-name "$hcom_name"` 換成真實值後重跑。指令會在原紀錄補上這兩個欄位，保留其餘內容，然後啟動監控；不要刪除或重建 session 紀錄。舊紀錄在升級前維持原有待決檢查，不寫主控回報；升級後才開始記錄，不推測 HCOM 名稱。

   activate 會偵測 Herdr 的 `lat.panel`：已啟用時自動綁定並印出問題檔路徑；未啟用時印出「面板未啟用，略過綁定」。外掛查詢失敗時修復 Herdr 後重跑。自動綁定失敗時 session 紀錄保持 active，但停住監控尚未啟動：依錯誤補齊 Herdr 環境變數後重跑同一個 activate，確認綁定成功且 `.lat/watch/<session-id>.pid` 存在。

   新一輪面板綁定或監控啟動失敗後，修復原因並以相同參數重跑 activate；已寫成 active 的本輪會直接重試，歷史不會再增加，輪數也不變。確認面板綁定與監控都成功後續作。

   安裝或更新技能後，從不同技能目錄執行 hook／deactivate 仍會辨認並沿用本輪既有的監控；需要重啟時，使用紀錄的 `skill_dir/scripts/lat-watch.py`，與本輪的技能文字更新基準一致。

3. 每次收到恢復提示，先讀紀錄，再完整讀 `skill_dir` 的 `SKILL.md`、`references/agents.md`、`references/task-cards.md`（Claude 的提示已附這兩份全文，不必另讀），以及 `progress_path` 與 `decisions_path` 內的待決紀錄；已綁定面板時另讀 `references/question-panel.md`，並以自己的 session 綁定查出、讀取專屬的問題檔（綁定的 `questions_path`；新綁定在 `.lat/questions/`，見 [待答問題面板](question-panel.md#變數)；尚未寫題時不存在，不算缺檔）。核對 tracker 與真人授權再續作；索引可能落後，以查證結果更新既有清單。缺檔／損壞時停止相依工作並回報。hook 發現紀錄仍 active 但停住監控沒在執行時（包括主控掉線 60 分鐘後監控自停、紀錄留有 `watcher_stopped` 的情況，見 [停住監控](stall-watch.md#主控掉線時自停)），會在提示前自動重新啟動它。面板啟用且 hook 取得 Herdr workspace／tab／pane 編號時，也會把自己的面板綁定更新為目前位置；取不到就保持原綁定。
4. 交付、取消或換班時停用，紀錄狀態一律改為 `ended`（舊紀錄的 `completed`／`cancelled` 視同 `ended`）。換班時加 `--successor <新主控 HCOM 名稱>` 記下接手者。deactivate 會停止自己的停住監控並解除自己的綁定，沒有綁定也不報錯；自己在 `.lat/questions/` 的問題檔清理後沒有題目時刪除（歸檔檔與鎖檔保留，根目錄舊問題檔不動，見 [解除綁定](question-panel.md#解除綁定)），並在紀錄寫入結束時間 `ended_at_utc`（已結束的紀錄再停用不改寫；沒有結束時間的舊紀錄不補）；成功後紀錄保留，後續 compact／resume 不再提示。

```bash
uv run --no-project python "$lat_dir/scripts/lat-session.py" deactivate --client "$client" \
  --workspace "$workspace"
# 換班時加上 --successor <新主控 HCOM 名稱>。
```

手動停用遺留的 active 紀錄：確認指定對話已結束／取消，再加 `--session-id <record-session-id>`，只改該筆紀錄。session 紀錄永不清理；已結束 session 留下的監控檔由 [清理指令](cleanup.md) 列給使用者確認。

## 技能文字更新

activate 也在紀錄中保存技能文字指紋；active 紀錄已有指紋時重跑會保留本輪基準，停用後開始新一輪則以當下技能文字重新計算。停住監控依自己的 `skill_dir` 比對並用 HCOM 通知主控重讀，舊紀錄沒有指紋時由監控建立基準，詳見 [技能文字更新通知](stall-watch.md#技能文字更新通知)。這項提醒不需要重新啟用 LAT，也不代替 compact／resume 的恢復提示。

## 回合結束檢查

Stop hook 與恢復 hook 共用主控身分比對；Claude 與 Codex 的 DECIDE／HELP 檢查只看 active、client／session／角色／工作區相符的紀錄。最後一則訊息的最後一個非空行以 `DECIDE:` 或 `HELP:` 開頭時，擷取每個 `❓ **<ID> r<版本>**` 標題行，以及標籤後的 `<ID> r<數字>`；兩種標籤做相同的檢查。ID 由英數字與 `-_.` 組成；其他位置提到的題號及沒接版本的字詞不算。

沒寫題號、任一題號沒有同名待決紀錄或狀態不是 pending、任何決策紀錄讀不出狀態，都會不通過；`HELP:` 列出的題號紀錄另須有 `- kind: help`。以上都通過、但最後一行列出的題號與版本（沒列時改看標題行）全都已在本 session 先前的 `DECIDE:`／`HELP:` 回報（見下方「主控回報紀錄」）出現過時，同樣擋下，要求把新題號寫進最後一行，或改以 `NO REPLY:` 結尾；有任一新題或新版本就通過。回報紀錄讀不到時視為沒問過。狀態使用遺漏檢查的共用讀法；缺狀態行、空值、純空白、第一字不是 pending 但後面含 pending，都算讀不出狀態。已有自己的 session 面板綁定時，另逐題核對自己的問題檔中有同版本「待答」題目，並要求遺漏檢查通過；不比對聊天裡有沒有題目全文。未綁定時不要求面板。

每個寫出的題號還須有參謀行，取第一行以 `- advisor:` 開頭的行，鍵名不分大小寫，值去除前後空白並以空白分詞。第一字接受 `needs-human`；`exempt` 的第二字限 `spec-confirmation`、`ticket-confirmation`、`requirement-discussion`、`account-quota`；`late` 的第二字限 `needs-human`、`resolved`、`self-check`。後續字詞可加註記（如 `same-family-degraded`）。缺行、空值、未知第一字或缺少／未知第二字，都逐題列出原因。未被 DECIDE／HELP 引用的 `advising`／`advisor-resolved` 紀錄不算面板漏題；被引用仍須符合 pending 與面板版本檢查。

參謀行為 `exempt spec-confirmation` 時，另要求唯一一行格式正確的 `- consensus: v<N> <64 位小寫十六進位 sha256>`，且最後一則訊息出現相同版本的 `共識 v<N>`；缺共識行、格式錯、訊息沒寫版本、版本不同或出現多個不同版本，皆逐題列出原因。其他類別不要求共識。舊紀錄重新提問也適用；[Spec 共識](consensus.md) 說明適用範圍。

已寫入面板或問過使用者的題目補做諮詢後，維持 pending 並寫 `- advisor: late <結論>`；參謀建議定案或自行查證時，重列題目的 ➡️ 行附建議與授權來源，由真人解除待答。

首次未通過會輸出原因並要求主控繼續，重複標籤以外的補做順序是：寫待決紀錄 → 諮詢參謀或註明例外 → 更新 Spec 共識 → 跑檢查工具 → 確認題寫明共識版本（以上三步限 Spec 確認題） → 寫入面板（已綁定時） → 遺漏檢查 → 依聊天提問格式重新提問。若 payload 的 `stop_hook_active` 表示本回合已因 hook 繼續，不再攔下，只以 `systemMessage` 留使用者可見的警告；修正後重新提問能通過，不留舊警告，新回合可再次攔下。紀錄損壞、檔案讀取失敗等工具錯誤也只警告，讓回合結束。

**題目代送**：已綁定面板時，檢查通過或只警告放行（含上述 `stop_hook_active` 與工具錯誤）後，依最後一行列出的題號與版本（沒列時改看標題行）的順序，從自己的問題檔讀出同版本待答題目，套成純文字放進 `systemMessage`，格式見 [聊天提問格式](question-panel.md#聊天提問格式)。同一次 Stop 只輸出一個 JSON 物件：題目在前，警告接在後面。首次攔下時不代送；未綁定、主控已停用時也不代送。讀不到綁定或問題檔、綁定與紀錄不符、題目不在問題檔或套版出錯時，只附一行「LAT 題目代送失敗」警告，不改變檢查結果。回報紀錄只存模型寫的訊息，不含代送的題目。

**啟用檢查**：工作區沒有本 session 的 `.lat/sessions/<session-id>.json` 時，Stop hook 改查對話紀錄。紀錄裡有叫出 LAT 技能就擋下並要求依本程序 activate：Claude 是使用者訊息含 `<command-name>/lat</command-name>`，或主控用 Skill 工具叫出 `lat`／`<命名空間>:lat`；Codex 是使用者打 `$lat` 時注入、`<name>lat</name>` 的 `<skill>` 區塊。用讀檔或指令看 SKILL.md 不算，所以 Codex 自行讀技能檔不會被擋。只是閱讀或審查技能而被擋時，在回覆說明原因即可結束。

以下情況不擋：紀錄檔存在（不論狀態或內容能否辨識，照舊只做上方的身分比對與 DECIDE／HELP 檢查）、不在 Git 專案內、`HCOM_LAUNCHED_BY` 不是空值或 `user`（被其他 Agent 派出的執行 Agent）、`stop_hook_active` 為 true（同一回合只擋一次，下一回合結束會再擋）。對話紀錄優先用 payload 的 `transcript_path`，沒有時依 session ID 找 `CLAUDE_CONFIG_DIR`（預設 `~/.claude`）的 `projects/*/<session>.jsonl` 或 `CODEX_HOME`（預設 `~/.codex`）的 `sessions/`、`archived_sessions/`；找不到、讀不出或沒有一行符合該 client 的紀錄格式時不擋，只在標準錯誤留一則 `LAT activation check warning:`。

Stop 在訊息已顯示後才執行，無法撤回原訊息。DECIDE／HELP 檢查不連網、不讀對話紀錄（重複標籤只看回報紀錄），無法發現工具通過後 tracker 上的 Spec 又被修改；每次修改 Spec 都須重跑工具。檢查只核對寫出的題號，無法判斷提問內容是否真的對應該題；寫了既有待答題號卻問別的事仍會通過。

## 主控回報紀錄

Claude 與 Codex 主控的既有 Stop hook 會在回合真正結束時自動追加回報，不需主控另跑指令。回報放在使用者層級的 `$XDG_STATE_HOME/lat/reports/`；未設定 XDG_STATE_HOME 或其值不是絕對路徑時，使用 `~/.local/state/lat/reports/`。不放在專案 `.lat/`。`LAT_REPORTS_DIR` 可指定另一個絕對目錄（測試必須指定暫存目錄）。

每個對話一份 `<session-id>.jsonl`，每行是一個 JSON 物件：`time`（UTC 時間）、`session_id`、`hcom_name`、`client`、`workspace`、`round`（第幾輪，從 1 開始）、`tag`、`summary`、`message`（最後一則訊息全文）、`final`（是否為本輪停用後最後一筆）。最後一個非空行符合 `DECIDE:`、`HELP:`、`DONE:` 或 `NO REPLY:` 時，`tag` 記錄該標籤，`summary` 記錄冒號後去除開頭空白的文字；不符合時兩欄都是空字串，全文照存。空訊息也照存。

待決檢查攔下並要求繼續的 Stop 不寫回報；通過、只警告放行或檢查工具出錯放行的 Stop 才追加一筆。寫入失敗只在標準錯誤輸出留一則警告，不改變原本檢查結果。hook 只追加回報，不改寫；同目錄的 `<session-id>.lock` 防止同時追加互相干擾。LAT 看板會刪除最新一筆有效紀錄已發出滿 30 天的回報檔（在同一把鎖內再確認後才刪，鎖檔保留），之後同一對話再追加時重新建立檔案。

deactivate 保留本輪最後回報的資格，停用後第一次 Stop 仍追加 `final: true`，之後不再追加；重跑 deactivate 不會重新取得資格。若寫入失敗，下一次 Stop 可重試；部分寫入留下的損壞行保持原樣，追加前補上換行，讀取回報時須略過無效行。最後一筆已完整寫入但同步失敗時，下次只重試同步，不追加重複回報。activate 開始新一輪後恢復記錄，舊回報保持原樣。非主控角色、沒有 LAT 紀錄或身分不符的對話不產生回報。舊版紀錄缺少 HCOM 名稱時，須先照上方說明重跑 activate 升級，才開始記錄，不推測名稱。

回報可能含本機路徑或私人訊息，目錄應留在專案之外。此紀錄只代表 hook 收到的回合結束訊息；暫存目錄測試不等於已驗證真實 client 的 hook 輸入。

## Hook 安裝與移除

技能檔案安裝不會註冊 hook。安裝／移除 hook、搬動技能或修改 command，以及排查 hook 啟用／信任問題前，先讀 [Hook 設定程序](hook-setup.md)。Codex 須透過 `/hooks` 信任 command；Claude 使用者層級 hook 不需信任步驟，重啟後在 `/hooks` 確認。

## 邊界與限制

- v1 僅支援 Git 工作區。activate 要求正規化後的 worktree 根目錄；子目錄 cwd 可恢復，但 hook 只查最近 `.git` 邊界的工作區，另一 worktree／巢狀 repo 不繼承。非 Git 的 activate 報錯，hook 靜默。
- hook 使用 payload `session_id`（hook process 沒有主控的 session 環境變數），只匹配自己的紀錄。client 與 hook 的 `--client` 相同、role=orchestrator、workspace、session_id、active 全部相符才提示。這是流程提醒，不是防惡意 Agent 的安全門禁。
- 沒有該 ID 的紀錄或已知條件不符：exit 0、零輸出。精確 ID 的紀錄損壞，或匹配後所需檔案缺失：輸出短恢復錯誤，不推定授權。
- `/clear` 與 fork／新 session 不繼承標記。`/clear` 不改舊紀錄；日後 resume 舊對話仍可恢復，直到明確停用。沒有 clear handler；SessionEnd 也不刪紀錄。SubagentStart／SubagentStop 不掛此 hook（其 payload ID 是父 session）；主控 Stop 使用上述回合結束檢查；UserPromptSubmit 以相同身分比對列出待答題目，見 [撤回過時題目](question-panel.md#撤回過時題目)。
- 每次 compact／resume 都重新匹配，不設永久「已提示」旗標；恢復提示不累積全文、不呼叫模型、不掃 transcript、不連網、不觸發 compact。
- 啟用前發生的壓縮無法恢復；遺漏停用可能留下 active。移動工作區、session 移交與 plugin 包裝不在 v1。
