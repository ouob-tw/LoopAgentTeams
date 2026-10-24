# 預先授權

使用者事先寫好、程式查得到的常設授權（實驗）。主控做合併、推送、部署、更新主機技能前，先以 `check` 查詢：結果 `allow` 才可不問直接做；`ask` 就照「使用者待決事項」提問。工具只回答能不能做，不執行動作本身。

## 查詢

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" check --action <動作> [--branch <分支>] [--commit <版本>] [--json]
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" show
```

- `check` 印一行 `allow <動作> <標的> — basis: …`（每個生效值來自哪一層、哪一段與 `source`）或 `ask <動作> <標的> — reasons: …`；結束碼 `allow` 為 0、`ask` 為 1、工具出錯為 2。`--json` 輸出 `verdict`、`action`、`target`、`basis`、`reasons`。
- `show` 印三層位置與是否生效、合併後的有效設定，以及每個值的出處；設定有錯時列出錯誤。
- 在要動作的工作區執行（或給 `--workspace`）。主控層以 `--session-id` 或 client 的 session 環境變數（`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`）找本輪 session 紀錄。

## 三層與合併

| 層 | 位置 |
| --- | --- |
| 主控 | 本輪 session 紀錄（主工作區 `.lat/sessions/<session>.json`）的 `preauth` 欄位：`{"round": <輪數>, "settings": {…與設定檔同結構…}}` |
| 專案 | 主工作區 `.lat/preauth.toml`（不提交） |
| 全域 | `$XDG_CONFIG_HOME/lat/preauth.toml`（預設 `~/.config/lat/`） |

- 逐段落、逐鍵由窄到寬取第一個有寫的值：主控 > 專案 > 全域。整段沒寫就往上一層找；三層都沒寫 `allow` 就是 `ask`。窄層可放寬也可收緊。
- 主控層只在 session 為 `active` 且 `round` 等於目前輪數時生效；停用或開新一輪即失效。
- 任一層讀不出、TOML 格式錯、未知鍵、未知動作、值的型別錯，或寫了永遠要問的類別，每個 `check` 都回 `ask` 並列出錯誤，不會因錯誤而放寬。

## 設定檔格式

```toml
version = 1
experiment = true

[actions.merge]
allow = true
branches = ["dev"]
source = "<待決紀錄 ID>"

[actions.deploy-test]
target = "<測試環境說明或位置>"

[advisor]
extended = true
may_settle = ["…"]
must_ask = ["…"]
source = "<待決紀錄 ID>"
```

- 動作段 `[actions.<動作>]` 的鍵：`allow`（true／false）、`branches`（字串清單）、`target`（字串）、`source`（字串）。`[advisor]` 的鍵：`extended`、`may_settle`、`must_ask`、`source`。`source` 是出處，不參與判斷，`show` 與 `check` 附在該層的值旁。
- 動作固定五種：`merge`（合併到整合分支）、`push`（推送到遠端）、`deploy-test`、`deploy-prod`、`install-host`（更新主機上安裝的 Skills 與 hooks）。
- 修改或縮減已確認驗收（`change-acceptance`）、花錢或動帳號額度（`spend`）、刪使用者資料或 shred（`delete-user-data`）、開新票擴大工作量（`new-ticket`）永遠要問：查詢一律 `ask`，寫進設定算錯誤。

## 固定條件

工具強制，設定沒有鍵能拿掉：

- `merge`、`push`：要給 `--branch`，且分支在有效的 `branches` 清單內；沒有任何層寫 `branches` 就 `ask`。
- `deploy-test`、`deploy-prod`、`install-host`：在主工作區執行，且 HEAD 等於整合分支（本輪工作總表的 `integration_branch`）的最新版本。`deploy-test` 另要求專案層寫了 `target`。
- `push`、`deploy-test`、`deploy-prod`、`install-host` 的整套測試閘門核對尚未接上，目前一律 `ask`，原因為 `full-suite gate check is not wired yet`。
