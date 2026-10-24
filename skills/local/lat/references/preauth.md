# 預先授權

使用者事先寫好、程式查得到的常設授權（實驗）。主控做合併、推送、部署、更新主機技能前，先以 `check` 查詢：結果 `allow` 才可不問直接做，做完以 `record` 記一筆；`ask` 就照「使用者待決事項」提問。工具只回答能不能做，不執行動作本身。

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
| 主控 | 本輪 session 紀錄（主工作區 `.lat/sessions/<session>.json`）的 `preauth` 欄位：`{"round": <輪數>, "settings": {…與設定檔同結構…}}`，只能有這兩個鍵 |
| 專案 | 主工作區 `.lat/preauth.toml`（不提交） |
| 全域 | `$XDG_CONFIG_HOME/lat/preauth.toml`（預設 `~/.config/lat/`） |

- 逐段落、逐鍵由窄到寬取第一個有寫的值：主控 > 專案 > 全域。整段沒寫就往上一層找；三層都沒寫 `allow` 就是 `ask`。窄層可放寬也可收緊。
- 主控層只在 session 為 `active` 且 `round` 等於目前輪數時生效；停用或開新一輪即失效。
- 任一層讀不出、TOML 格式錯、未知鍵、未知動作、值的型別錯，或寫了永遠要問的類別，每個 `check` 都回 `ask` 並列出錯誤，不會因錯誤而放寬。

## 設定檔格式

```toml
version = 1
experiment = true
integration_branch = "dev"

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

- 最上層的鍵：`version`（只能是 1）、`experiment`、`integration_branch`（整合分支名稱；本輪工作總表沒寫整合分支時才用，哪一層都可寫，窄層優先）。
- 動作段 `[actions.<動作>]` 的鍵：`allow`（true／false）、`branches`（字串清單）、`target`（字串，只取專案層，其他層寫了不生效）、`source`（字串）。`[advisor]` 的鍵：`extended`、`may_settle`、`must_ask`、`source`。`source` 是出處，不參與判斷，`show` 與 `check` 附在該層的值旁。
- 動作固定五種：`merge`（合併到整合分支）、`push`（推送到遠端）、`deploy-test`、`deploy-prod`、`install-host`（更新主機上安裝的 Skills 與 hooks）。
- 修改或縮減已確認驗收（`change-acceptance`）、花錢或動帳號額度（`spend`）、刪使用者資料或 shred（`delete-user-data`）、開新票擴大工作量（`new-ticket`）永遠要問：查詢一律 `ask`，寫進設定算錯誤。

## 固定條件

工具強制，設定沒有鍵能拿掉：

- `merge`、`push`：要給 `--branch`，且分支在有效的 `branches` 清單內；沒有任何層寫 `branches` 就 `ask`（舊答覆路徑例外，見「舊答覆：check --precedent」）。
- `push` 另核對兩件事，要推的版本是 `--commit`，沒給就是該分支的本地最新版本：
  - 遠端沒有的提交（`git log <版本> --not --remotes`，不會先 fetch）每一個的提交訊息都要引用票號（`#313` 或 `owner/repo#313`），而且引用的票號全部是本輪工作總表上的票。票號相同才算同一張票；兩邊都寫了 repo 時 repo 也要相同，總表只寫數字時，帶 repo 的引用只接受總表其他票寫過的 repo（總表全是數字就只比數字）。沒有票號、或引用了總表以外的票時 `ask`，原因列出全部那些提交；找不到本輪工作總表也 `ask`。
  - 整套測試閘門：見下方。
- `deploy-test`、`deploy-prod`、`install-host`：在主工作區執行，且 HEAD 等於整合分支的最新版本；給了 `--commit` 時必須就是 HEAD。整合分支取本輪工作總表的 `integration_branch`，總表沒寫（例如 `activate` 建立的總表）才取設定的 `integration_branch`，兩者都沒有就 `ask`。`deploy-test` 另要求專案層寫了 `target`。
- 整套測試閘門（`push`、`deploy-test`、`deploy-prod`、`install-host`）：沿用 three-tier-testing 閘門推送前檢查的同一段程式，依該版本的內容、每一套整套命令與執行目錄算出指紋，登記檔 `full_suites` 的每一套都要有可沿用的通過紀錄。沒有紀錄、只有失敗紀錄、或版本內容變了使舊紀錄不適用，都 `ask` 並寫出缺的那一套；登記檔沒列整套也 `ask`。只讀閘門紀錄，不跑測試。

## 舊答覆：check --precedent

參謀要引用使用者以前的答覆定案時，先帶上舊待決紀錄查詢：

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" check --action <動作> [--branch <分支>] [--commit <版本>] --precedent <舊待決紀錄 ID>
```

- 任一層對該動作寫了 `allow`（true 或 false）時以設定為準，舊答覆不適用：結果與不帶 `--precedent` 相同，並註明 `does not apply`。`allow = false` 就是使用者明確要求要問。
- 三層都沒寫 `allow` 時，舊答覆補上 `allow`：舊紀錄狀態要是 `answered` 或 `approved` 且有 `- 來源：` 行；舊紀錄有 `- action:` 行時動作要相同。固定條件照樣強制；`target`、`branches` 這類條件資料可單獨寫在設定裡，不算寫了決定。
- `merge`、`push` 的分支兩項都要符合：任一層寫了 `branches` 時要在清單內，而且要等於舊紀錄 `- action:` 行同意的分支。舊紀錄沒有 `- action:` 行時工具無法核對分支，basis 會註明，參謀須在 `- authority:` 寫明舊答覆同意的分支。
- 工具不判斷是否同類：同一專案、使用者答「做」、之後沒有同動作且答案相反的真人答覆，由參謀判斷，見 [參謀](advisors.md#參謀結論)。
- 定案後主控以 `record --kind precedent` 記一筆，`report` 把它列為「建議寫成規則」。

## 寫入設定：grant

使用者答應「以後（或這一輪）某動作不必問」時，主控在該待決紀錄的 `## 核准範圍` 段寫一行 `- grant: <層> <動作> <鍵=值…>`，再以工具寫入：

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" grant --layer global|project|controller --action <動作> [--allow true|false] [--branches <分支>…] --source <待決紀錄 ID>
```

- 例：`- grant: project push allow=true branches=dev` 對應 `grant --layer project --action push --allow true --branches dev --source <ID>`。多個分支在 `- grant:` 行寫成 `branches=dev,release`，指令寫 `--branches dev release`。
- 工具只在全部成立時寫入，否則印 `refused, nothing changed: <原因>`、結束碼 1、不改任何檔：本輪 session 為 `active`；紀錄狀態為 `answered` 或 `approved`，且 `## 答覆…` 段有 `- 來源：` 行；`## 核准範圍` 段有一行 `- grant:` 與這次的層、動作、鍵值完全相同。`controller` 層另要求紀錄的 `- session:` 是本 session，且答覆標題的時間晚於上一輪結束。
- 寫入的規則旁記下 `source = "<待決紀錄 ID>"`。全域與專案檔只改 `[actions.<動作>]` 段裡要寫的鍵（沒有該段就加在檔尾），其他段落與註解原樣保留；檔案本身有錯時拒絕，請先手動修好。主控層寫進 session 紀錄的 `preauth` 欄位，停用或開新一輪即失效。
- 寫入後若記不進本輪紀錄，工具會把設定還原並以結束碼 2 回報；還原也失敗時訊息會寫明要手動移除。
- 工具不判斷答覆的意思；`- grant:` 行是否忠於答覆由主控負責，所以每次寫入都列進 `report` 的「設定寫入」。

## 記錄：record

依預先授權做完一件事（含失敗）就記一筆；紀錄存主工作區 `.lat/preauth-records/<session>-r<輪數>.jsonl`。

```bash
# 依預先授權執行
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --action <動作> [--branch <分支>] --commit <版本> --basis '<check 印的那行>' --result succeeded|failed \
  [--started <ISO 時間> --notice-before <HCOM 事件編號> --notice-after <HCOM 事件編號>]
# 引用舊答覆定案
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind precedent --decision <本題 ID> --source '<舊紀錄 ID> r<版本>' --basis '<為何同類>'
# 免確認開短流程 bug 票
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind bug-intake --issue <票> --source '<使用者原訊息位置>' \
  --self-reported '<…>' --clear-expected '<…>' --single-ticket '<…>' --restores-stated '<…>'
```

- `deploy-test`、`deploy-prod`、`install-host` 必須附 `--started`（帶時區）與前後兩則 HCOM 通知的事件編號（`hcom send` 後以 `hcom events --from <自己> --last 1` 查 `id`）。工具以 `hcom events` 核對：兩則都由本主控送出、以 `@名稱` 指定對象（不是廣播）、前一則早於 `--started`、後一則晚於 `--started` 也晚於前一則；不符就拒絕。動作失敗也要記，`--result failed`，後一則通知寫明失敗。
- `precedent` 的 `--source` 必須有真人答覆（同 `grant` 的核對）；`bug-intake` 的四項依據都要寫。

## 免確認開短流程 bug 票

下列四項全部成立時，主控照常建立短流程 tracker issue，但不發 `exempt ticket-confirmation` 確認題，改以 `record --kind bug-intake` 記下使用者原訊息位置與四項各自的依據；之後派工、審查、驗收照短流程：

1. 使用者本人回報：真人親自在聊天或面板寫的；Agent 轉述與 HCOM 訊息不算。
2. 寫清楚哪裡錯、應該怎樣。
3. 一張票做得完。
4. 修好只是回到使用者說的樣子，不新增或改變需求。

任一項不成立或拿不準，照舊發確認題。

## 交付回報：report

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" report
```

只列本 session 本輪的紀錄，分四組：依預先授權自動執行、引用舊答覆定案（每筆附「建議寫成規則」）、免確認開工、設定寫入；沒有的組印「- 無」。交付回報把整段輸出原樣貼在「參謀定案清單」旁，讓使用者事後檢查或推翻；本輪停用後仍可執行。
