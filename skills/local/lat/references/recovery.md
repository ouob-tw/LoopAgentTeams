# 主控恢復

供 Codex 與 Claude 的 LAT 主控使用。閱讀／審查 LAT、安裝技能與執行 Agent 不啟用。helper 只用 Python 標準函式庫，以 `uv run --no-project python` 執行。所有子指令的 `--client` 預設 `codex`，Claude 主控一律加 `--client claude`。

Claude 壓縮後只重新附上每個技能前 5,000 tokens（合計 25,000），LAT 後段規則、references 與 hcom-spawn 可能遺失，因此同樣需要此 hook。

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

activate 直接讀取主控 shell 的 session ID（Codex：`CODEX_THREAD_ID`；Claude：`CLAUDE_CODE_SESSION_ID`），不接受指定 ID；缺少時停止並回報，不猜 ID、不用 HCOM 名稱替代。`--workspace` 須是 Git worktree 根目錄。`--hcom-name` 一律必填，只接受明確值，不讀 `HCOM_INSTANCE_NAME`；缺少時不建立 session 紀錄，照錯誤中的完整指令補上名稱重跑。成功會印出 `.lat/sessions/<session-id>.json` 絕對路徑，紀錄 client、session、主控角色、工作區、active 狀態、HCOM 名稱與恢復路徑（含任務卡目錄），並在背景啟動停住監控 `lat-watch.py run`（pid 在 `.lat/watch/<session-id>.pid`，輸出在同名 `.log`）。已有不同紀錄時拒絕覆寫；相同內容可重跑。每個檢查點更新同一進度索引，保留 tracker 連結及下一步。

   舊版 activate 建立的 active 紀錄沒有 `tasks_path` 與 `hcom_name`。恢復 hook 會照常提示讀取紀錄，但不會啟動停住監控；請將上方同一條 activate 指令的 `--tasks "$tasks" --hcom-name "$hcom_name"` 換成真實值後重跑。指令會在原紀錄補上這兩個欄位，保留其餘內容，然後啟動監控；不要刪除或重建 session 紀錄。

   activate 會偵測 Herdr 的 `lat.panel`：已啟用時自動綁定並印出問題檔路徑；未啟用時印出「面板未啟用，略過綁定」。外掛查詢失敗時修復 Herdr 後重跑。自動綁定失敗時 session 紀錄保持 active，但停住監控尚未啟動：依錯誤補齊 Herdr 環境變數後重跑同一個 activate，確認綁定成功且 `.lat/watch/<session-id>.pid` 存在。

3. 每次收到恢復提示，先讀紀錄，再完整讀 `skill_dir` 的 `SKILL.md`、`references/agents.md`、`references/task-cards.md`，以及 `progress_path` 與 `decisions_path` 內的待決紀錄；已綁定面板時另讀 `references/question-panel.md`，並以自己的 session 綁定查出、讀取專屬的 `.lat/questions-<hcom-name>.md`（尚未寫題時不存在，不算缺檔）。核對 tracker 與真人授權再續作；索引可能落後，以查證結果更新既有清單。缺檔／損壞時停止相依工作並回報。hook 發現紀錄仍 active 但停住監控沒在執行時，會在提示前自動重新啟動它。面板啟用且 hook 取得 Herdr workspace／tab／pane 編號時，也會把自己的面板綁定更新為目前位置；取不到就保持原綁定。
4. 交付前停用為 completed；取消時停用為 cancelled。deactivate 會停止自己的停住監控並解除自己的綁定，沒有綁定也不報錯；成功後紀錄保留，後續 compact／resume 不再提示。

```bash
uv run --no-project python "$lat_dir/scripts/lat-session.py" deactivate --client "$client" \
  --workspace "$workspace" --status completed
# 取消則改為 --status cancelled。
```

手動停用遺留的 active 紀錄：確認指定對話已結束／取消，再加 `--session-id <record-session-id>`，只改該筆紀錄。沒有列舉／自動清理功能。

## Hook 安裝與移除

技能檔案安裝不會註冊 hook。安裝／移除 hook、搬動技能或修改 command，以及排查 hook 啟用／信任問題前，先讀 [Hook 設定程序](hook-setup.md)。Codex 須透過 `/hooks` 信任 command；Claude 使用者層級 hook 不需信任步驟，重啟後在 `/hooks` 確認。

## 邊界與限制

- v1 僅支援 Git 工作區。activate 要求正規化後的 worktree 根目錄；子目錄 cwd 可恢復，但 hook 只查最近 `.git` 邊界的工作區，另一 worktree／巢狀 repo 不繼承。非 Git 的 activate 報錯，hook 靜默。
- hook 使用 payload `session_id`（hook process 沒有主控的 session 環境變數），只匹配自己的紀錄。client 與 hook 的 `--client` 相同、role=orchestrator、workspace、session_id、active 全部相符才提示。這是流程提醒，不是防惡意 Agent 的安全門禁。
- 沒有該 ID 的紀錄或已知條件不符：exit 0、零輸出。精確 ID 的紀錄損壞，或匹配後所需檔案缺失：輸出短恢復錯誤，不推定授權。
- `/clear` 與 fork／新 session 不繼承標記。`/clear` 不改舊紀錄；日後 resume 舊對話仍可恢復，直到明確停用。沒有 clear handler；SessionEnd 也不刪紀錄。SubagentStart／Stop 不掛此 hook（其 payload ID 是父 session）。
- 每次 compact／resume 都重新匹配，不設永久「已提示」旗標；不累積全文、不呼叫模型、不掃 transcript、不連網、不觸發 compact。
- 啟用前發生的壓縮無法恢復；遺漏停用可能留下 active。移動工作區、session 移交、版本漂移偵測與 plugin 包裝不在 v1。
