# Hook 安裝與移除

先將 `lat_dir` 設為本次實際安裝的 LAT 技能目錄絕對路徑。

技能檔案安裝不會註冊 hook。Claude 使用者層級設定：`install --client claude --claude-settings <settings.json>`（預設 `~/.claude/settings.json`），於 SessionStart 新增 matcher `^(compact|resume)$`、command 結尾為 `hook --client claude` 的 group，在 Stop 與 UserPromptSubmit 新增同一 command（無 matcher），PreToolUse 新增 matcher `Bash` 的同一 command；同樣先 preview、備份、保留其他設定，重跑不重複，`uninstall` 加相同參數移除。使用者層級 hook 不需信任步驟；重啟 Claude Code 後在 `/hooks` 確認。

Codex：先確認有效 `CODEX_HOME`（預設 `~/.codex`），檢查 preview 後，在既有授權範圍內執行同一指令去掉 `--preview`。以下示範隔離目錄：

```bash
codex_home=/absolute/path/to/isolated-codex-home
uv run --no-project python "$lat_dir/scripts/lat-session.py" install \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/lat-session.py" install \
  --codex-home "$codex_home"
```

只在該目錄的 `hooks.json` 合併獨立 `lat-codex-recovery` group，SessionStart 的 matcher 只有 compact／resume，Stop 與 UserPromptSubmit 使用同一 command、無 matcher，PreToolUse 的 matcher 為 `Bash`；四個事件一起安裝與移除。command 使用 helper 所在技能的實際絕對路徑。HCOM／第三方 entries 與未知欄位保留；同版本重跑不重複。變更前備份為 `hooks.json.lat-backup-*`，寫入前檢查內容是否同期變動，再原子替換；偵測到變動便停止，檢查後重跑。安裝期間避免同時由其他工具改設定，檢查不是跨工具的檔案鎖。

在該隔離 `CODEX_HOME` 啟動 Codex，透過正常 `/hooks` 介面檢查並信任此 command；helper 不寫信任設定、不 bypass。更新 command 或搬動技能後需重新檢查。hook 的執行環境須能找到 `uv` 與 Python。

Codex 更新或重設 hooks 後，仍應在 `/hooks` 確認 LAT 為啟用且已信任；未受信任時，重新信任此 command。

```bash
uv run --no-project python "$lat_dir/scripts/lat-session.py" uninstall \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/lat-session.py" uninstall \
  --codex-home "$codex_home"
```

移除四個事件中的 LAT command，保留其他 handlers／未知欄位；不刪 session 紀錄、備份或信任設定。

Stop 在主控訊息顯示後才執行；未通過 DECIDE／HELP 檢查會要求主控繼續補做，原訊息仍在。再次未通過與工具錯誤只留使用者可見的警告；判斷範圍與補做順序見 [回合結束檢查](recovery.md#回合結束檢查)。

UserPromptSubmit 在主控收到使用者訊息時列出自己仍待答的題目，提示撤回或改版；只附加內容、不擋訊息，見 [撤回過時題目](question-panel.md#撤回過時題目)。新增此事件後，已安裝的使用者須重跑 install，Codex 另到 `/hooks` 信任新項目，Claude 與 Codex 主控重開後才生效。

PreToolUse 只對啟用中的主控生效：要執行 `gh issue close` 時先用 `gh issue view` 讀票的內文，還有未勾選的 `- [ ]` 項目就擋下並列出。關閉留言（`-c`／`--comment`）引用 `<待決 ID> r<版本>`、且該紀錄有這版的真人答覆（`## 答覆` 段落與 `- 來源：` 行）時放行；引用的紀錄沒有真人答覆仍擋。讀不到票時只警告、不擋；指令無法解析時擋下，請把 `gh issue close` 單獨執行。檢查在指令執行前進行，所以打勾（`gh issue edit`）與關票要分兩條指令執行；同一條指令裡兩者並存而被擋時，擋下訊息會提醒這點。本輪有過無人授權時，每條指令執行前也會重建回顧檔，讓主控剛寫的擱置或代決紀錄不必等回合結束（見 [回顧](unattended.md#回顧)）；重建失敗只警告。新增此事件後須重跑 install，Codex 另到 `/hooks` 信任。

## 提交訊息票號檢查

`scripts/lat-commit-ref.py` 是 Git commit-msg hook：分支名稱帶票號（`fix/370`、`fix/issue-366-x`、`issue-366`）時，提交訊息沒有 `#<票號>`（可寫 `owner/repo#<票號>`；`#<別的號碼>` 不算）就拒絕並說明缺哪個號碼。分支名看不出票號（`dev`、`main`、分離 HEAD）與合併提交不檢查；`git commit --no-verify` 可略過。

```bash
uv run --no-project python "$lat_dir/scripts/lat-commit-ref.py" install --repo /absolute/path/to/repo --preview
uv run --no-project python "$lat_dir/scripts/lat-commit-ref.py" install --repo /absolute/path/to/repo
```

寫入該 repo 共用的 `hooks/commit-msg`（Git worktree 共用同一份），已有的 sh hook 內容保留，區塊以標記包住，重跑不重複；`uninstall` 移除。若全域 `core.hooksPath` 指向別的目錄，Git 不會讀 repo 自己的 hooks，安裝指令會印出要在該目錄放的 `commit-msg` 轉交檔（與 pre-commit、pre-push 的轉交寫法相同）。

## 全域推送前 hook

主機以全域 `core.hooksPath`（例如 `~/.config/git/hooks`）共用 hook 時，Git 不會讀 repo 自己的 `pre-push`，所以由共用目錄的 `pre-push` 先擋[保留中的提交](preauth.md#保留不推送的提交)與沒經 `do` 的主控推送，再轉交 repo 自己的 hook。內容如下，寫到 `"$(git config --global core.hooksPath)/pre-push"` 並 `chmod +x`；已有的 `pre-push` 先看內容，只是轉交 repo hook 的那三行就整個換掉，有其他內容時把轉交段換成下面的寫法並保留其他部分：

<!-- global-pre-push -->
```sh
#!/bin/sh
# 推送含保留提交時拒絕；接著執行版本庫自己的推送前鉤子（如果有），沒有就放行
lat_preauth="$HOME/.agents/skills/lat/scripts/lat-preauth.py"
refs=$(cat)
feed() { if [ -n "$refs" ]; then printf '%s\n' "$refs"; fi; }
if [ -f "$lat_preauth" ]; then
  feed | uv run --no-project python "$lat_preauth" pre-push "$@" || exit 1
fi
local_hook="$(git rev-parse --git-common-dir)/hooks/pre-push"
if [ -x "$local_hook" ]; then
  feed | "$local_hook" "$@"
  exit $?
fi
exit 0
```

- 擋的範圍：每個被推送的參照，從要推的版本可達、但遠端那個參照原本的版本不可達的提交（新分支就是要推版本的全部歷史）；其中有未解除的保留就以非 0 結束，列出提交與決策編號，repo 自己的 hook 不再執行。
- repo 沒有主工作區 `.lat/preauth-holds.json`、或主機沒裝 LAT 技能時不檢查，行為和原本的轉交一樣。保留檔讀不出時拒絕推送，修好再推。
- 主控推送：環境裡的 session 編號（`CLAUDE_CODE_SESSION_ID` 或 `CODEX_THREAD_ID`）是這個 repo 主工作區 `.lat/sessions` 裡進行中的主控時，推送分支只接受 `do --action push` 發起、且推送的分支與版本就是 `do` 查過的那一個，其他分支推送都拒絕並印出該用的 `do` 指令（見 [合併、推送一律用 `do`](preauth.md#合併推送一律用-do)）。刪除遠端分支照常通過；標籤等其他參照只要沒帶出「遠端都沒有、`do` 也沒查過」的提交就照常通過，否則拒絕，請先用 `do` 推送含這些提交的分支，或在同一個 `do` 一起推。worktree 共用主工作區的 `.lat`，在 worktree 推送同樣檢查。部署與更新主機技能的 `do` 指令裡的推送照常通過。
- 照常通過：沒有 session 環境變數、session 不是這個 repo 的主控（使用者自己、實作者）、主控已停用。
- 這項主控檢查自己出錯（例如 session 紀錄讀不出）時，只在 stderr 警告並照常推送；保留提交的檢查照舊不放行。
- 已知限制：主控的 session 紀錄在別的 repo（跨 repo 推送）時不擋。`do` 的記號可以偽造：這項檢查防的是手滑，不防蓄意繞過。
- `git push --no-verify` 會略過整個 hook；主控一律不用 `--no-verify`。
