# Hook 安裝與移除

先將 `lat_dir` 設為本次實際安裝的 LAT 技能目錄絕對路徑。

技能檔案安裝不會註冊 hook。Claude 使用者層級設定：`install --client claude --claude-settings <settings.json>`（預設 `~/.claude/settings.json`），於 SessionStart 新增 matcher `^(compact|resume)$`、command 結尾為 `hook --client claude` 的 group；同樣先 preview、備份、保留其他設定，重跑不重複，`uninstall` 加相同參數移除。使用者層級 hook 不需信任步驟；重啟 Claude Code 後在 `/hooks` 確認。以下 Codex 說明的 HCOM 排序與信任機制不適用於 Claude。

Codex：先確認有效 `CODEX_HOME`（預設 `~/.codex`），檢查 preview 後，在既有授權範圍內執行同一指令去掉 `--preview`。以下示範隔離目錄：

```bash
codex_home=/absolute/path/to/isolated-codex-home
uv run --no-project python "$lat_dir/scripts/lat-session.py" install \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/lat-session.py" install \
  --codex-home "$codex_home"
```

只在該目錄的 `hooks.json` 合併獨立 `lat-codex-recovery` group，事件只有 SessionStart，matcher 只有 compact／resume。command 使用 helper 所在技能的實際絕對路徑。HCOM／第三方 entries 與未知欄位保留；同版本重跑不重複。變更前備份為 `hooks.json.lat-backup-*`，寫入前檢查內容是否同期變動，再原子替換；偵測到變動便停止，檢查後重跑。安裝期間避免同時由其他工具改設定，檢查不是跨工具的檔案鎖。

在該隔離 `CODEX_HOME` 啟動 Codex，透過正常 `/hooks` 介面檢查並信任此 command；helper 不寫信任設定、不 bypass。更新 command 或搬動技能後需重新檢查。hook 的執行環境須能找到 `uv` 與 Python。

install 將 LAT group 放在 HCOM SessionStart group 前方，避免 HCOM 重設 hooks 時搬動自己的 group，造成 LAT 的位置式信任 key 失效。舊版安裝重跑 install 會調整位置，須重新以 `/hooks` 信任 LAT；HCOM 由正常啟動流程恢復自己的信任。HCOM／Codex 更新或重設 hooks 後，仍應在 `/hooks` 確認 LAT 為啟用且已信任。

```bash
uv run --no-project python "$lat_dir/scripts/lat-session.py" uninstall \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/lat-session.py" uninstall \
  --codex-home "$codex_home"
```

移除僅刪 LAT command，保留其他 handlers／未知欄位；不刪 session 紀錄、備份或信任設定。
