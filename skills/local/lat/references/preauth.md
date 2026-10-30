# 預先授權

使用者事先寫好、程式查得到的常設授權（實驗）。主控做合併、推送、部署、更新主機技能前，先以 `check` 查詢：結果 `allow` 才可不問直接做，做完以 `record` 記一筆；`ask` 就照「使用者待決事項」提問。工具只回答能不能做，不執行動作本身。

## 查詢

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" check --action <動作> [--branch <分支>] [--commit <版本>] [--json]
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" show
```

- `check` 印一行 `allow <動作> <標的> — basis: …`（每個生效值來自哪一層、哪一段與 `source`）或 `ask <動作> <標的> — reasons: …`；結束碼 `allow` 為 0、`ask` 為 1、工具出錯為 2。`--json` 輸出 `verdict`、`action`、`target`、`basis`、`reasons`，以及與 `reasons` 同順序的 `reason_kinds`，每個原因一個類別：`allow-false`（某層明寫 `allow = false`）、`condition`（不在下方「時段」內，或下方「固定條件」不成立，含沒寫 `target` 或整合分支）、`unset`（沒有任何層寫 `allow` 或 `branches`）、`always-ask`（任何設定都不能預先授權）、`error`（設定讀不出、參數缺漏等 `check` 無法判斷）。參謀免諮詢類別 `exempt preauth-ask` 依這個欄位判斷，見 [參謀](advisors.md)。
- `deploy-test`、`deploy-prod`、`install-host` 得到 `allow` 時另印 `Next steps:`（`--json` 增加 `next_steps`）：用 `notice --text '<內容>'` 發動作前通知並記下它印的事件編號，再記下帶時區的 `--started`、執行動作、同樣發動作後通知，最後 `record --kind auto … --notice-before <id> --notice-after <id> --started <time>`。`notice` 沒印編號就是沒送出，不可執行動作；沒有其他在線主控時它不發訊息，改印 `none-<n>`，可原樣給 `--notice-before`／`--notice-after`。合併、推送與 `ask` 的輸出不變。
- `notice --text '<內容>' [--to <名稱>…]` 代主控以 `@名稱` 發 `--intent inform` 通知，成功時只印這則訊息的 HCOM 事件編號。收件人預設是本專案其他進行中的主控（由 session 紀錄查得），或用 `--to` 點名；只發給 `hcom list --json` 目前還在的（紀錄裡已離線的主控略過並提示；`--to` 點名的不在線就整則不送），不能是自己，不廣播。沒有 `--to` 且沒有其他在線主控時，不發訊息、寫入本輪 `.lat/preauth-records/<session>-r<輪數>-no-recipient.jsonl`（發送者、時間、當時記錄的其他主控都已離線），印 `none-<n>` 並以 0 結束，不需隨便點名無關的 Agent。送出後以發送者、內容完全相同、開始發送之後的時間到 `hcom events` 找出這則訊息；`--to` 的收件人都不在線、HCOM 讀不到、發送失敗、找不到訊息或找到多則相同的，都以非 0 結束並說明原因，不印編號。
- `show` 印兩層位置與是否生效、合併後的有效設定，以及每個值的出處；專案檔寫了 `[advisor]` 時在該段註明「專案層的 [advisor] 不生效」；設定有錯時列出錯誤。
- 在要動作的工作區執行（或給 `--workspace`）。`check` 以 `--session-id` 或 client 的 session 環境變數（`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`）找本輪工作總表。

## 兩層與合併

| 層 | 位置 |
| --- | --- |
| 專案 | 主工作區 `.lat/preauth.toml`（不提交） |
| 全域 | `$XDG_CONFIG_HOME/lat/preauth.toml`（預設 `~/.config/lat/`） |

- 逐段落、逐鍵由窄到寬取第一個有寫的值：專案 > 全域。整段沒寫就往上一層找；兩層都沒寫 `allow` 就是 `ask`。專案層可放寬也可收緊。
- 例外：`target` 只取專案層，`[advisor]` 只取全域層；寫在另一層不生效，但仍會檢查格式。
- 想只放寬一段時間，就改設定檔，做完再改回來。
- 任一層讀不出、TOML 格式錯、未知鍵、未知動作、值的型別錯、時段或時區有誤，或寫了永遠要問的類別，每個 `check` 都回 `ask` 並列出錯誤，不會因錯誤而放寬。

## 設定檔格式

```toml
version = 1
integration_branch = "dev"

[actions.merge]
allow = true
branches = ["dev"]
source = "<待決紀錄 ID>"

[actions.push]
allow = true
branches = ["dev"]
hours = "01:00-08:00"
timezone = "Asia/Taipei"

[actions.deploy-test]
target = "<測試環境說明或位置>"

[advisor]
extended = true
may_settle = ["…"]
must_ask = ["…"]
source = "<待決紀錄 ID>"
```

- 最上層的鍵：`version`（只能是 1）、`integration_branch`（整合分支名稱；本輪工作總表沒寫整合分支時才用，哪一層都可寫，專案層優先）。
- 動作段 `[actions.<動作>]` 的鍵：`allow`（true／false）、`branches`（字串清單）、`target`（字串，只取專案層，全域層寫了不生效）、`source`（字串）、`hours` 與 `timezone`（見「時段」）。`[advisor]` 只取全域層，鍵：`extended`、`may_settle`、`must_ask`、`source`。`source` 是出處，不參與判斷，`show` 與 `check` 附在該層的值旁。
- 動作固定五種：`merge`（合併到整合分支）、`push`（推送到遠端）、`deploy-test`、`deploy-prod`、`install-host`（更新主機上安裝的 Skills 與 hooks）。
- 修改或縮減已確認驗收（`change-acceptance`）、花錢或動帳號額度（`spend`）、刪使用者資料或 shred（`delete-user-data`）、開新票擴大工作量（`new-ticket`）永遠要問：查詢一律 `ask`，寫進設定算錯誤。這只限制 `check`；參謀能否定案改驗收與開新票，依 `[advisor]` 段判斷，見 [參謀](advisors.md#參謀結論)。

## 時段

動作段可寫 `hours = "HH:MM-HH:MM"`（24 小時制）與 `timezone`（時區名稱，如 `Asia/Taipei`），限定只在該時段內 `allow`。

- 合併兩層後缺任一個鍵、格式錯、起訖相同、時區認不得或寫 `localtime`，都算設定錯誤，每個 `check` 都回 `ask`。
- 起始時間算在內，結束時間不算；起始晚於結束就是跨午夜的連續區間（`22:00-06:00` 含 23:00 與 05:59，不含 06:00）。
- 時段外回 `ask`，類別 `condition`，原因寫出當地現在時間與時段；時段內 `basis` 同樣寫出。`allow` 的其他條件照常判斷，時段不放寬固定條件。
- 分層同 `allow`：兩個鍵各自取專案層，沒寫才取全域層，可放寬也可收緊。`grant` 不寫時段，要手動改設定。

## 固定條件

工具強制，設定沒有鍵能拿掉：

- `merge`、`push`：要給 `--branch`，且分支在有效的 `branches` 清單內；沒有任何層寫 `branches` 就 `ask`。
- `push` 另核對兩件事，要推的版本是 `--commit`，沒給就是該分支的本地最新版本：
  - 遠端沒有的提交（`git log <版本> --not --remotes`，不會先 fetch）每一個的提交訊息都要引用票號（`#313` 或 `owner/repo#313`），而且引用的票號全部是本輪工作總表上的票。票號相同才算同一張票；兩邊都寫了 repo 時 repo 也要相同，總表只寫數字的票代表本專案自己的 tracker（`docs/agents/issue-tracker.md` 裡 `gh issue` 指令帶的那一個 `-R owner/repo`，`gh pr` 指令的不算；檔案不在、沒寫或寫了不只一個就當認不出），帶 repo 的引用接受本專案 tracker 與總表其他票寫過的 repo（總表全是數字就只比數字）。沒有票號、或引用了總表以外的票時 `ask`，原因列出全部那些提交；找不到本輪工作總表也 `ask`。
  - 整套測試閘門：見下方。
- `deploy-test`、`deploy-prod`、`install-host`：在主工作區執行，且 HEAD 等於整合分支的最新版本；給了 `--commit` 時必須就是 HEAD。整合分支取本輪工作總表的 `integration_branch`，總表沒寫（例如 `activate` 建立的總表）才取設定的 `integration_branch`，兩者都沒有就 `ask`。`deploy-test` 另要求專案層寫了 `target`。
- 整套測試閘門（`push`、`deploy-test`、`deploy-prod`、`install-host`）：沿用 three-tier-testing 閘門推送前檢查的同一段程式，依該版本的內容、每一套整套命令與執行目錄算出指紋，登記檔 `full_suites` 的每一套都要有可沿用的通過紀錄。沒有紀錄、只有失敗紀錄、或版本內容變了使舊紀錄不適用，都 `ask` 並寫出缺的那一套；登記檔沒列整套也 `ask`。只讀閘門紀錄，不跑測試。
  - `install-host` 例外：只看 `skills/` 下各技能資料夾（有 `SKILL.md` 的資料夾，略過點開頭的目錄）裡登記的整套，與安裝腳本共用閘門的同一段判斷：該套最近一次「這個資料夾內容與現在相同」的執行通過才算數，資料夾外的改動（例如看板）不影響。缺的那一套寫在原因裡，並註明所在技能資料夾與「沒有這份內容的執行」或「最近一次執行失敗」。專案沒有任何技能資料夾時，照上面的規則看全部整套。

## 寫入設定：grant

使用者答應「以後某動作不必問」時，主控在該待決紀錄的 `## 核准範圍` 段寫一行 `- grant: <層> <動作> <鍵=值…>`，再以工具寫入：

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" grant --layer global|project --action <動作> [--allow true|false] [--branches <分支>…] --source <待決紀錄 ID>
```

- 例：`- grant: project push allow=true branches=dev` 對應 `grant --layer project --action push --allow true --branches dev --source <ID>`。多個分支在 `- grant:` 行寫成 `branches=dev,release`，指令寫 `--branches dev release`。
- 工具只在全部成立時寫入，否則印 `refused, nothing changed: <原因>`、結束碼 1、不改任何檔：本輪 session 為 `active`；紀錄狀態為 `answered` 或 `approved`，且 `## 答覆…` 段有 `- 來源：` 行；`## 核准範圍` 段有一行 `- grant:` 與這次的層、動作、鍵值完全相同。
- 寫入的規則旁記下 `source = "<待決紀錄 ID>"`。全域與專案檔只改 `[actions.<動作>]` 段裡要寫的鍵（沒有該段就加在檔尾），其他段落與註解原樣保留；檔案本身有錯時拒絕，請先手動修好。
- 寫入後若記不進本輪紀錄，工具會把設定還原並以結束碼 2 回報；還原也失敗時訊息會寫明要手動移除。
- 工具不判斷答覆的意思；`- grant:` 行是否忠於答覆由主控負責，所以每次寫入都列進 `report` 的「設定寫入」。

## 記錄：record

依預先授權做完一件事（含失敗）就記一筆；紀錄存主工作區 `.lat/preauth-records/<session>-r<輪數>.jsonl`。

```bash
# 依預先授權執行
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --action <動作> [--branch <分支>] --commit <版本> --basis '<check 印的那行>' --result succeeded|failed \
  [--started <ISO 時間> --notice-before <HCOM 事件編號> --notice-after <HCOM 事件編號>]
# 免確認開短流程 bug 票
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind bug-intake --issue <票> --source '<使用者原訊息位置>' \
  --self-reported '<…>' --clear-expected '<…>' --single-ticket '<…>' --restores-stated '<…>'
```

- `deploy-test`、`deploy-prod`、`install-host` 必須附 `--started`（帶時區）與前後兩則 HCOM 通知的事件編號（取自 `notice` 印出的編號）。工具以 `hcom events` 核對：兩則都由本主控送出（發送者等於工作階段紀錄的 HCOM 名稱，或 `hcom list --json` 給它的基本名；有 tag 的主控，HCOM 記的是基本名）、以 `@名稱` 指定對象（不是廣播）、依 `--started` 提供的小數秒位數比較（未提供小數就比較整秒）：前一則可早於或等於開始時間，後一則必須晚於開始時間，且原始時間也必須晚於前一則。例如 `--started 2026-10-29T12:00:00+08:00` 接受前一則在 `12:00:00.4`，拒絕 `12:00:01.2`；後一則在 `12:00:00.9` 仍不合格；不符就拒絕。`--notice-*` 也可給 `notice` 印的 `none-<n>`：工具核對它是本輪由本主控的 `notice` 寫下的無人可通知紀錄，時間順序規則相同，兩則可一真一無；工具另核對該紀錄裡記錄的其他主控確實都不在線；`report` 顯示「無人可通知（none-1，未發訊息）」。HCOM 的 agent 清單格式異常時 `notice` 拒絕，不當作無人在線。事件的 `delivered_to` 為空（沒送到任何人）一律拒絕。動作失敗也要記，`--result failed`，後一則通知寫明失敗。
- `bug-intake` 的四項依據都要寫。

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

只列本 session 本輪的紀錄，分三組：依預先授權自動執行、免確認開工、設定寫入；沒有的組印「- 無」。交付回報把整段輸出原樣貼在「參謀定案清單」旁，讓使用者事後檢查或推翻；本輪停用後仍可執行。

## 接上提問

要問的是上面五種動作之一時，待決紀錄加一行 `- action: <動作> [分支] [版本]`：`merge`、`push` 先寫分支再寫版本，例如 `- action: push dev`；其他三種沒有分支，第二個字就是版本，例如 `- action: deploy-test` 或 `- action: install-host 1a2b3c4`。版本可省略，意思同 `check` 不給 `--commit`。

面板寫題（`question upsert`）與回合結束的 DECIDE／HELP 檢查遇到有 `- action:` 的紀錄，一律依當下設定與當下時間重跑 `check`，不採用紀錄裡先前寫的結論：

- **已送出**：題號曾在主控自己的問題檔或其歸檔出現，或曾出現在本 session 主控回報紀錄的 `DECIDE:`／`HELP:` 訊息（聊天提問）；任一成立即算，不論版本。
- **未送出且 `allow`**：`question upsert` 拒絕寫入（結束碼 1，不改任何檔）；回合結束檢查首次擋下，同回合第二次只警告。不要提問：直接做，做完以 `record` 記一筆，並在待決紀錄寫明改依預先授權處理。
- **已送出且 `allow`**：照常寫入與放行，只附一行提醒「此題目前已預先授權，可由使用者決定撤回」；送到使用者面前的題目仍只由真人解除。
- **`ask`**：照常寫入與放行。
- `question upsert` 每次寫入都把當下結論寫成紀錄的 `- preauth: <check 印的那行>（重查於 <時間>）`，取代舊的那行，沒有時放在 `- action:` 下一行。這行只給人與參謀閱讀，工具不讀。
- 沒有 `- action:` 的紀錄不重查，行為不變；漏寫由參謀把關。重查本身出錯時照常寫入或放行，只印警告。
