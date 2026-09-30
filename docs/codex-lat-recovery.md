# Codex LAT 壓縮後恢復：使用方式

此功能供 Codex 的 LAT 主控使用。安裝一次後，在專案對 Codex 說「用 LAT 處理這個任務」即可；主控會登記目前對話，結束或取消時停用。Claude 沿用原流程。

## 安裝一次

先依 README 安裝 LAT 技能，確認 `uv` 可執行。以下使用預設技能位置；若位置不同，修改 `lat_dir`。`codex_home` 須指向實際使用的 Codex 設定目錄。

```bash
lat_dir="$HOME/.agents/skills/lat"
codex_home="${CODEX_HOME:-$HOME/.codex}"
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" install \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" install \
  --codex-home "$codex_home"
```

檢查 preview 只有 LAT group，再執行安裝。helper 會備份原本的 `hooks.json`，保留其他 hooks；重跑不會重複新增。

重新啟動 Codex，輸入 `/hooks`，進入 `SessionStart`，選中 command 結尾為 `codex-lat-session.py hook`、matcher 為 `^(compact|resume)$` 的項目，按 `t` 信任。只核准這一項；確認它顯示 `[x]`。不要使用略過信任檢查的啟動參數。

## 平常怎麼用

LAT 主控讀完專案設定後，先登記對話，再建立進度清單。可請主控提供 `.lat/sessions/<session-id>.json` 路徑，確認 `status` 是 `active`，且 `skill_dir` 指向已安裝 LAT。只閱讀技能或擔任執行 Agent 不會啟用。

手動 `/compact`、自動壓縮或接回同一對話時，hook 會提示主控先完整重讀 LAT 規則、進度與待決紀錄，再核對 tracker 與既有授權，接著繼續原任務。沒有真人答覆的決策仍然等待，缺少獨立審查的工作不能宣告完成。可做一次 `/compact` 後說「繼續」，查看工具紀錄是否先重讀上述檔案。

啟用前發生的壓縮不受保護。`/clear`、fork 與新對話不繼承主控標記；`/clear` 不會停用舊紀錄，日後接回舊對話仍可恢復。正常交付／取消會停用該筆紀錄。

出現 `LAT recovery error` 時，主控應停止相依工作並回報；先檢查指定紀錄及其指向的技能、進度與待決目錄是否存在，不自行重建授權或進度。

## 停用遺留紀錄

確認舊任務已取消，從紀錄檔名取得 session ID，再指定該專案 Git 工作區根目錄：

```bash
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" deactivate \
  --workspace /absolute/path/to/project \
  --session-id '<舊紀錄的 session ID>' --status cancelled
```

已完成的任務改用 `--status completed`。只停用指定紀錄，保留檔案供核對。

## 移除 hook

```bash
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" uninstall \
  --codex-home "$codex_home" --preview
uv run --no-project python "$lat_dir/scripts/codex-lat-session.py" uninstall \
  --codex-home "$codex_home"
```

重新啟動 Codex 後生效。只移除 LAT command；技能、session 紀錄、備份及信任設定仍保留。詳細主控程序見 [Codex 恢復參考](../skills/local/lat/references/codex-recovery.md)。
