# Codex 主控恢復

只供 Codex 的 LAT 主控使用。閱讀／審查 LAT、安裝技能與執行 Agent 不啟用。Claude 維持原流程。helper 只用 Python 標準函式庫，以 `uv run --no-project python` 執行。

## 主控啟動與結束

1. 讀完專案設定後，先選定既有進度索引與共用待決目錄。沒有索引時，先建立短檔案，指向 tracker／Spec 與現有整合摘要；不要重建清單。確認待決目錄存在。
2. 在建立本次進度清單之前執行 activate。`lat_dir` 必須是本次實際載入的 LAT 技能目錄；以下路徑由專案設定取得，不照抄範例。

```bash
lat_dir=/absolute/path/to/installed/lat
workspace=/absolute/path/to/git-worktree
progress=/absolute/path/to/existing-progress.md
decisions=/absolute/path/to/shared/decisions
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" activate \
  --workspace "$workspace" --progress "$progress" --decisions "$decisions"
```

activate 直接讀取主控 shell 的 `CODEX_THREAD_ID`，不接受指定 ID；缺少時停止並回報，不猜 ID、不用 HCOM 名稱替代。成功會印出 `.lat/sessions/<session-id>.json` 絕對路徑，紀錄 client、session、主控角色、工作區、active 狀態與恢復路徑。已有不同紀錄時拒絕覆寫；相同內容可重跑。每個檢查點更新同一進度索引，保留 tracker 連結及下一步。

3. 每次收到恢復提示，先讀紀錄，再完整讀 `skill_dir` 的 `SKILL.md`、`references/agents.md`、`references/task-cards.md`，以及 `progress_path` 與 `decisions_path` 內的待決紀錄。核對 tracker 與真人授權再續作；索引可能落後，以查證結果更新既有清單。缺檔／損壞時停止相依工作並回報。
4. 交付前停用為 completed；取消時停用為 cancelled。成功後紀錄保留，後續 compact／resume 不再提示。

```bash
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" deactivate \
  --workspace "$workspace" --status completed
# 取消則改為 --status cancelled。
```

手動停用遺留的 active 紀錄：確認指定對話已結束／取消，再加 `--session-id <record-session-id>`，只改該筆紀錄。沒有列舉／自動清理功能。

## Hook 安裝與移除

技能檔案安裝不會註冊 hook。先確認有效 `CODEX_HOME`（預設 `~/.codex`），檢查 preview 後，在既有授權範圍內執行同一指令去掉 `--preview`。以下示範隔離目錄：

```bash
codex_home=/absolute/path/to/isolated-codex-home
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" install \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" install \
  --codex-home "$codex_home"
```

只在該目錄的 `hooks.json` 合併獨立 `lat-codex-recovery` group，事件只有 SessionStart，matcher 只有 compact／resume。command 使用 helper 所在技能的實際絕對路徑。HCOM／第三方 entries 與未知欄位保留；同版本重跑不重複。變更前備份為 `hooks.json.lat-backup-*`，寫入前檢查內容是否同期變動，再原子替換；偵測到變動便停止，檢查後重跑。安裝期間避免同時由其他工具改設定，檢查不是跨工具的檔案鎖。

在該隔離 `CODEX_HOME` 啟動 Codex，透過正常 `/hooks` 介面檢查並信任此 command；helper 不寫信任設定、不 bypass。更新 command 或搬動技能後需重新檢查。hook 的執行環境須能找到 `uv` 與 Python。

install 將 LAT group 放在 HCOM SessionStart group 前方，避免 HCOM 重設 hooks 時搬動自己的 group，造成 LAT 的位置式信任 key 失效。舊版安裝重跑 install 會調整位置，須重新以 `/hooks` 信任 LAT；HCOM 由正常啟動流程恢復自己的信任。HCOM／Codex 更新或重設 hooks 後，仍應在 `/hooks` 確認 LAT 為啟用且已信任。

```bash
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" uninstall \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" uninstall \
  --codex-home "$codex_home"
```

移除僅刪 LAT command，保留其他 handlers／未知欄位；不刪 session 紀錄、備份或信任設定。

## 邊界與限制

- v1 僅支援 Git 工作區。activate 要求正規化後的 worktree 根目錄；子目錄 cwd 可恢復，但 hook 只查最近 `.git` 邊界的工作區，另一 worktree／巢狀 repo 不繼承。非 Git 的 activate 報錯，hook 靜默。
- hook 使用 payload `session_id`（hook process 沒有 `CODEX_THREAD_ID`），只匹配自己的紀錄。client=codex、role=orchestrator、workspace、session_id、active 全部相符才提示。這是流程提醒，不是防惡意 Agent 的安全門禁。
- 沒有該 ID 的紀錄或已知條件不符：exit 0、零輸出。精確 ID 的紀錄損壞，或匹配後所需檔案缺失：輸出短恢復錯誤，不推定授權。
- `/clear` 與 fork／新 session 不繼承標記。`/clear` 不改舊紀錄；日後 resume 舊對話仍可恢復，直到明確停用。沒有 clear handler；SessionEnd 也不刪紀錄。SubagentStart／Stop 不掛此 hook（其 payload ID 是父 session）。
- 每次 compact／resume 都重新匹配，不設永久「已提示」旗標；不累積全文、不呼叫模型、不掃 transcript、不連網、不觸發 compact。
- 啟用前發生的壓縮無法恢復；遺漏停用可能留下 active。移動工作區、session 移交、版本漂移偵測與 plugin 包裝不在 v1。

## 驗證

單元／CLI 合約測試（僅暫存檔，沒有模型或真實 Codex）：

```bash
uv run --no-project python -m unittest discover -s "$lat_dir/tests"
```

實機測試使用專用 Git 工作區、隔離 `CODEX_HOME`、技能副本與假進度／待決檔，保留原始 transcript 與 hook 設定。若複製 auth，限制權限為 0600，禁止輸出內容；測試完成以 `shred -u` 清除。測試程序結束後清理自己的非機密暫存資源。

1. install preview → install → 正常 `/hooks` 信任；核對其他 command 保留。啟動 Codex 主控載入 `$lat`，讀設定後 activate，完整讀 references 與假進度。
2. `/compact` 後要求繼續。從工具紀錄核對：首個相依動作之前完整重讀紀錄、SKILL、兩份 references、進度與待決紀錄，並核對 tracker；截斷讀取與模型自稱記得均不算通過。
3. 同 session 再 compact 一次，確認同樣恢復並有進度，沒有全文累積或無進度迴圈。完成後 deactivate，再 compact／resume 應零注入。
4. 另一次真實 auto compact：僅對測試程序設定 `-c model_auto_compact_token_limit=<基礎context加餘量>`，用有限假工具輸出跨過門檻；確認真實 auto boundary 的提示在當次 continuation 前，以及首個相依動作前重讀。無法觸發記 NOT_EXECUTED，不用模擬 hook 取代。
5. 行為核對：已授權工作繼續；沒有真人答覆的 pending 仍阻擋；缺獨立 review 不宣告完成。負向核對同 repo 的 no-LAT session、執行 Agent、completed session 零注入。記錄 PASS／FAIL／UNPROVEN／NOT_EXECUTED。

提示 token 數以 `o200k_base` 為代理，目標 ≤300；計入實際紀錄路徑。tokenizer 僅供驗證，不是 helper 依賴。hook 契約與信任機制見 [Codex 官方 hooks 文件](https://learn.chatgpt.com/docs/hooks)；已實測基準為 Codex 0.158.0。
