# 預先授權

使用者事先寫好、程式查得到的常設授權（實驗）。主控做合併、推送、部署、更新主機技能時，用 `do` 一次做完查詢、執行與記錄：查詢結果 `allow` 才可不問直接做；`ask` 就照「使用者待決事項」提問。`check` 只回答能不能做，不執行動作。

## 查詢

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" check --action <動作> [--branch <分支>] [--commit <版本>] [--json]
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" show
```

- `check` 印一行 `allow <動作> <標的> — basis: …`（每個生效值來自哪一層、哪一段與 `source`）或 `ask <動作> <標的> — reasons: …`；結束碼 `allow` 為 0、`ask` 為 1、工具出錯為 2。`--json` 輸出 `verdict`、`action`、`target`、`basis`、`reasons`，以及與 `reasons` 同順序的 `reason_kinds`，每個原因一個類別：`allow-false`（某層明寫 `allow = false`）、`condition`（不在下方「時段」內，或下方「固定條件」不成立，含沒寫 `target` 或整合分支）、`unset`（沒有任何層寫 `allow` 或 `branches`）、`always-ask`（任何設定都不能預先授權）、`error`（設定讀不出、參數缺漏等 `check` 無法判斷）。參謀免諮詢類別 `exempt preauth-ask` 依這個欄位判斷，見 [參謀](advisors.md)。
- `deploy-test`、`deploy-prod`、`install-host` 得到 `allow` 時另印 `Next steps:`（`--json` 增加 `next_steps`）：用 `notice --text '<內容>'` 發動作前通知並記下它印的事件編號，再以 `now` 取得 `--started`、執行動作、同樣發動作後通知，最後 `record --kind auto … --notice-before <id> --notice-after <id> --started <time>`。`notice` 沒印編號就是沒送出，不可執行動作，步驟的串接見 [動作前後的步驟](#動作前後的步驟)；沒有其他在線主控時它不發訊息，改印 `none-<n>`，可原樣給 `--notice-before`／`--notice-after`。合併、推送與 `ask` 的輸出不變。
- `notice --text '<內容>' [--to <名稱>…]` 代主控以 `@名稱` 發 `--intent inform` 通知，成功時只印這則訊息的 HCOM 事件編號。收件人預設是本專案其他進行中的主控（由 session 紀錄查得；[跨 repo](#主控與動作不在同一個-repo) 時再加上動作所在 repo 的主控），或用 `--to` 點名；只發給 `hcom list --json` 目前還在的（紀錄裡已離線的主控略過並提示；`--to` 點名的不在線就整則不送），不能是自己，不廣播。沒有 `--to` 且沒有其他在線主控時，不發訊息、寫入本輪 `.lat/preauth-records/<session>-r<輪數>-no-recipient.jsonl`（發送者、時間、當時記錄的其他主控都已離線），印 `none-<n>` 並以 0 結束，不需隨便點名無關的 Agent。送出後以發送者、內容完全相同、開始發送之後的時間到 `hcom events` 找出這則訊息；`--to` 的收件人都不在線、HCOM 讀不到、發送失敗、找不到訊息或找到多則相同的，都以非 0 結束並說明原因，不印編號。
- `show` 印兩層位置與是否生效、合併後的有效設定，以及每個值的出處；專案檔寫了 `[advisor]` 時在該段註明「專案層的 [advisor] 不生效」；設定有錯時列出錯誤。
- 在要動作的工作區執行（或給 `--workspace`）。`check` 以 `--session-id` 或 client 的 session 環境變數（`CLAUDE_CODE_SESSION_ID`、`CODEX_THREAD_ID`）找本輪工作總表。
- `now` 印出現在時間（到微秒、帶時區），給 `record --started` 用。不要用 `date -Iseconds`：只到秒，不到一秒完成的動作會因後一則通知落在同一秒而被 `record` 拒絕。

## 動作前後的步驟

要發通知的動作用 `do` 一次跑完核對、前通知、動作、後通知與記錄，任何一步失敗就停下，不跑後面的步驟：

```bash
p() { uv run --no-project python "$lat_dir/scripts/lat-preauth.py" "$@"; }
p do --action install-host --commit <版本> [--to <名稱>…] -- <動作指令>
```

- 核對不是 `allow` 或前通知失敗時，不執行指令，以非 0 結束並說明。動作失敗仍發後通知並記 `failed`，結束碼為動作的結束碼。
- 記錄內容同手動串接；`--to` 指定的對象不在線照舊拒絕。後通知或記錄失敗時，動作已經做了，記錄可能缺漏，訊息會寫明。

## 合併、推送一律用 `do`

合併、推送一律用 `do`，不自己串 `check` 與 `git merge`／`git push`：用 `;` 串接，或把 `check` 接進管線（`| cut`、`| tail`），`check` 的結束碼就不見了，印 `ask` 也照樣推送。

```bash
p do --action merge|push --branch <分支> --commit <版本> [--question <待決 ID>] -- <指令>
```

- 不發通知。`check` 為 `allow` 就執行指令，記一筆 `kind: auto`，依據是工具自己印的 `check` 那一行。
- `check` 為 `ask`：給了 `--question`，且該題有真人答覆（在本主控的待決目錄、狀態 `answered` 或 `approved`、答覆段有 `- 來源：` 行），才執行指令並記一筆 `kind: manual` 與題號；否則不執行、不記錄，以非 0 結束並說明。
- 指令失敗照記 `failed`，結束碼為指令的結束碼。本輪 session 不是進行中時什麼都不執行；指令跑完但記錄寫不進去時以 2 結束並說明。
- `merge` 的 `--commit` 有一筆合併前受影響測試總結（`affected --purpose pre-merge`，同一提交或同一份內容）時，取最新那筆：其中重跑才通過（`PASSED ONLY ON RERUN`）的組，要本輪工作總表有一筆審查紀錄確認看過該組紀錄（`lat-ledger.py review-result --row <列> --reviewer <名稱> --clean --rerun-ack <指紋至少 12 碼> --note "<第一次失敗的原因>"`），否則 `ask` 並說明怎麼補。工作總表在另一個 repo 時 `check` 讀不到，這種情況一律 `ask`。
- `merge` 的 `--commit` 帶有本輪工作總表標為小改動的票（列的分支指向它，或整合分支沒有的提交提到該票）時，從該票任務卡的 base commit 跑小改動檢查：程式新增超過 30 行（不含測試與文件）、實作列是主控本人，或審查紀錄沒有四項界線的確認（`review-result --tiny-confirm`）、確認後內容又變了、確認沒涵蓋現在的提示，都 `ask`，並說明改走原流程（`lat-ledger.py tiny-off` 拿掉標記，當一般票重新派工，含 QA）。本輪有小改動票時，沒給 `--commit` 或給的版本不在這個 repo 也一律 `ask`。
- `do` 在指令的環境變數 `LAT_PREAUTH_DO` 記下動作、分支與完整版本。`push` 的 `--commit` 只解析一次，查詢、記號與紀錄都用同一個完整版本。推送前 hook 比對 Git 實際推送的分支與版本，跟 `do --action push` 查過的不同就擋下，所以 `--commit` 要寫這次推送的版本；`do --action merge` 不涵蓋推送。見 [全域推送前 hook](hook-setup.md#全域推送前-hook)。

## 主控與動作不在同一個 repo

主控的 session 紀錄在 A repo、動作在 B repo 時，`--workspace` 一律寫 B；`do`、`notice`、`record`、`report` 另加 `--controller-workspace <A>`。

```bash
p check --action merge --branch dev --workspace <B>
p do --action merge --branch dev --commit <版本> --workspace <B> --controller-workspace <A> -- <指令>
p notice --text '<內容>' --workspace <B> --controller-workspace <A>
p report --controller-workspace <A>
```

- 主控身分、本輪輪數與紀錄檔都來自 A 的 `.lat`，B 的 `.lat` 不會多出任何紀錄。沒給 `--controller-workspace` 時拒絕，訊息會提示這個選項。B 不在 Git 專案裡也拒絕，且不發訊息、不寫紀錄。
- `do` 與 `record` 把 B 的主工作區路徑寫進 `action_repo`，`report` 顯示在動作後面：`merge dev abc123（動作在 <B>）`。同一 repo（含它的 worktree）不寫這個欄位，舊紀錄照常讀取。
- `notice` 的預設收件人是 A 與 B 其他進行中的主控：動作影響 B，A 的主控也需要知道主控在做什麼。
- `check` 沒有這個選項，只看 B：
  - 設定取 B 的專案層與全域層。
  - 本輪工作總表在 A，`check` 找不到，所以 `push` 一律 `ask`（`no active round ledger`），要照「使用者待決事項」提問，答覆後以 `do --question <待決 ID>` 推送；部署與 `install-host` 的整合分支只取設定的 `integration_branch`。
- 待決紀錄的 `- action:` 重查（見 [接上提問](#接上提問)）在主控工作區 A 執行，結果可能與 `check --workspace <B>` 不同；B 的動作以 `check --workspace <B>` 為準，不要只憑重查的結論動手。

## 兩層與合併

| 層 | 位置 |
| --- | --- |
| 專案 | 主工作區 `.lat/preauth.toml`（不提交） |
| 全域 | `$XDG_CONFIG_HOME/lat/preauth.toml`（預設 `~/.config/lat/`） |

- 逐段落、逐鍵由窄到寬取第一個有寫的值：專案 > 全域。整段沒寫就往上一層找；兩層都沒寫 `allow` 就是 `ask`。專案層可放寬也可收緊。
- 例外：`target`、`rollback` 只取專案層，`[advisor]` 只取全域層；寫在另一層不生效，但仍會檢查格式。
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
rollback = "<退回上一版的方法：一句說明或指令>"

[advisor]
extended = true
may_settle = ["…"]
must_ask = ["…"]
source = "<待決紀錄 ID>"
```

- 最上層的鍵：`version`（只能是 1）、`integration_branch`（整合分支名稱；本輪工作總表沒寫整合分支時才用，哪一層都可寫，專案層優先）。
- 動作段 `[actions.<動作>]` 的鍵：`allow`（true／false）、`branches`（字串清單）、`target`（字串，只取專案層，全域層寫了不生效）、`rollback`（字串，退回上一版的方法，只取專案層，空白算沒寫；只有 `deploy-test`、`deploy-prod` 會用到，見「固定條件」）、`source`（字串）、`hours` 與 `timezone`（見「時段」）。`[advisor]` 只取全域層，鍵：`extended`、`may_settle`、`must_ask`、`source`。`source` 是出處，不參與判斷，`show` 與 `check` 附在該層的值旁。
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
  - 遠端沒有的提交（`git log <版本> --not --remotes`，不會先 fetch）每一個的提交訊息都要引用票號（`#313` 或 `owner/repo#313`），而且引用的票號全部是本輪工作總表上的票。票號相同才算同一張票；兩邊都寫了 repo 時 repo 也要相同，總表只寫數字的票代表本專案自己的 tracker（`docs/agents/issue-tracker.md` 裡 `gh issue` 指令帶的那一個 `-R owner/repo`，`gh pr` 指令的不算；檔案不在、沒寫或寫了不只一個就當認不出），帶 repo 的引用接受本專案 tracker 與總表其他票寫過的 repo（總表全是數字就只比數字）。沒有票號、或引用了總表以外的票時 `ask`，原因列出全部那些提交；找不到本輪工作總表也 `ask`。同步用的合併提交（例如 `git merge dev` 產生的 `Merge branch …`）不需要票號：每個 parent 不是遠端已有、就是範圍內已通過檢查的提交，且至少一個是後者；併進沒檢查過的分支，或所有 parent 都在遠端時照舊列出。
  - 整套測試閘門：僅推送 `main` 時查，見下方。
  - 範圍內（同上，遠端沒有的提交）有[保留中的提交](#保留不推送的提交)就 `ask`。
- `deploy-test`、`deploy-prod`、`install-host`：在主工作區執行，且 HEAD 等於整合分支的最新版本；給了 `--commit` 時必須就是 HEAD。整合分支取本輪工作總表的 `integration_branch`，總表沒寫（例如 `activate` 建立的總表）才取設定的 `integration_branch`，兩者都沒有就 `ask`。`deploy-test` 另要求專案層寫了 `target`。
- `deploy-prod` 另核對：要部署的版本含有（本身或祖先）未解除的[保留中的提交](#保留不推送的提交)就 `ask`。
- 整套測試閘門（推送 `main`、`deploy-test`、`deploy-prod`、`install-host`；推送 `main` 以外的分支如 `dev` 不查這一項，只查上面的分支清單與提交票號）：沿用 three-tier-testing 閘門推送前檢查的同一段程式，依該版本的內容、每一套整套命令與執行目錄算出指紋，登記檔 `full_suites` 的每一套都要有可沿用的通過紀錄。沒有紀錄、只有失敗紀錄、或版本內容變了使舊紀錄不適用，都 `ask` 並寫出缺的那一套；登記檔沒列整套也 `ask`。只讀閘門紀錄，不跑測試。
  - `deploy-test`、`deploy-prod` 例外：專案層該動作段寫了 `rollback` 時，以下全部成立就不必有整套通過紀錄（`basis` 寫出 `rollback` 與採用的總結紀錄）；任一項不成立就照上面要求整套，`ask` 的原因同時寫出為什麼受影響測試不夠：
    - 部署歷史（見下一項）裡有「上一次成功部署」：同一動作、同一部署目標（設定的 `target` 原文；`deploy-prod` 沒寫時兩邊都是空）最近一筆 `result` 為 `succeeded` 的紀錄。沒有歷史檔、找不到成功紀錄、只有別的目標成功過（部署目標改了）都要整套。`deploy-test` 的紀錄不算 `deploy-prod` 的上一次部署，反之亦然。
    - 那筆成功之後，同動作同目標沒有失敗的部署；有的話線上版本不明（換上新版才失敗，或退回也失敗），要整套。失敗之後又成功一次，就以那次新的成功為準。
    - 它的提交在這個 repo 找得到，而且是要部署版本本身或祖先（退版或分歧都要整套）。
    - three-tier-testing 閘門有一筆 `post-merge` 的合併後受影響測試總結紀錄（`kind: affected-summary`）整體通過（`passed: true`），它的 `tree` 等於要部署版本的 tree，起點 `base` 是上一次成功部署的提交本身或它的祖先。只讀閘門紀錄，不跑測試。
    - 輸出明說結果：全部成立時 `basis` 寫「no full suite needed」並指出採用的總結紀錄；不成立時 `ask` 的原因寫出是哪一項不成立，並說明需要整套；沒設 `rollback` 的部署寫「no rollback method is set …; a full suite is required」。
  - 部署歷史：被部署專案主工作區的 `.lat/deploy-history.jsonl`，每行一筆：`at`（時間）、`action`、`target`（當時設定的部署目標原文，沒寫為 `null`）、`commit`（完整提交）、`result`、`approval`（`preauth` 依預先授權、`manual` 人工核准），人工核准另有 `question`（待決題號）。由 `record` 寫入，見「記錄：record」。
  - `install-host` 例外：只看 `skills/` 下各技能資料夾（有 `SKILL.md` 的資料夾，略過點開頭的目錄）裡登記的整套，與安裝腳本共用閘門的同一段判斷：該套最近一次「這個資料夾內容與現在相同」的執行通過才算數，資料夾外的改動（例如看板）不影響。缺的那一套寫在原因裡，並註明所在技能資料夾與「沒有這份內容的執行」或「最近一次執行失敗」。專案沒有任何技能資料夾時，照上面的規則看全部整套。

## 保留不推送的提交

使用者對合併題選「合併但不推送」（或其他「先不要推上去」的答覆）時，主控合併完立刻登記保留，之後別張票的推送、正式部署與全域 `pre-push` hook 都會擋下這些提交。工具不從決策紀錄自己推斷，沒登記就不擋。

```bash
p hold add --commit <提交>… --decision <該題的待決紀錄 ID> --by <主控 HCOM 名稱>
p hold list [--json]
p hold release --commit <提交>… --decision <允許推送的待決紀錄 ID> --by <主控 HCOM 名稱>
```

- 登記哪個提交：合併後整合分支上的那個提交（合併提交；快轉合併時是票的最後一個提交）。只要推送或部署的範圍含有它就擋。
- 紀錄在主工作區 `.lat/preauth-holds.json`，所有 worktree 與主控共用；每筆記提交（完整編號）、決策編號、登記者、時間，解除後另記解除的決策編號、解除者與時間，舊紀錄保留。同一提交已在保留中時再登記會拒絕；同一次給的多個名稱指向同一提交只記一筆。這個 repo 已找不到的保留提交（改寫歷史後被清掉）不在任何版本裡，不會擋。
- `push` 的 `check` 範圍（遠端沒有的提交）、`deploy-prod` 要部署的版本含有未解除的保留時回 `ask`，類別沿用 `condition`，原因以 `held commits` 開頭並列出 `<提交前 12 碼> (decision <ID>)`，參謀不能定案。保留檔讀不出或格式不對（缺欄位、提交不是完整編號、`released` 不是 null 也不是完整的解除紀錄），或 Git 判斷不出版本是否含保留提交（例如提交物件損壞）時，類別為 `error`。
- 解除只憑真人答覆：引用的待決紀錄要在本主控的待決目錄（沒有 session 紀錄時是主工作區 `.lat/decisions`），狀態為 `answered` 或 `approved` 且答覆段有 `- 來源：` 行，而且不能是登記保留的那一題。不成立就拒絕、不改檔。解除後的提交不再擋。
- 推送題和部署題要寫出範圍內被保留的提交與原決策編號（`hold list` 或 `check` 的原因），讓使用者知道這次會一起帶上它們；使用者同意帶上後才 `hold release`，再推送或部署。
- 全域 `pre-push` hook 也呼叫這份紀錄，見 [全域推送前 hook](hook-setup.md#全域推送前-hook)。

## 看板寫入

使用者在看板「設定」對話框改全域設定、在主控頁面改專案設定，都視同直接編輯檔案，不需要待決紀錄。看板透過 `lat_panel.py board preauth-read`、`preauth-write` 讀寫，只改被修改的鍵，其他段落與註解不變；寫入的段落記 `source = "board:<帶時區的時間>"`。檔案有錯、或讀取後被改過時拒絕；每次寫入在看板狀態資料夾的 `preauth-writes.jsonl` 記一筆，記不進去就還原設定並回報失敗。

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
# 依預先授權執行的部署與更新主機技能（`do` 會自己記；這是手動串接的寫法）
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --action <動作> --commit <版本> --basis '<check 印的那行>' --result succeeded|failed \
  --started <now 印的時間> --notice-before <HCOM 事件編號> --notice-after <HCOM 事件編號>
# 經使用者答覆才做的部署，補記到部署歷史
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind manual --action deploy-test|deploy-prod --commit <版本> --result succeeded|failed --question <待決題號>
# 經使用者答覆、沒經 `do` 就做了的合併或推送
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind manual --action push|merge --branch <分支> --commit <版本> --result succeeded|failed --question <待決題號>
# 更正本輪（或已結束那一輪）的一筆紀錄
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind correction --commit <版本> --note '<實際情況>' [--action <動作>] [--question <待決題號>] [--session-id <那個主控的 session>]
# 免確認開短流程 bug 票
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" record --kind bug-intake --issue <票> --source '<使用者原訊息位置>' \
  --self-reported '<…>' --clear-expected '<…>' --single-ticket '<…>' --restores-stated '<…>' --no-existing-guard '<查過哪些測試與文件>'
```

- `merge`、`push` 不收 `--kind auto`：拒絕、不寫檔，訊息指向 `do`。
- `deploy-test`、`deploy-prod`、`install-host` 必須附 `--started`（帶時區，用 `now` 取得）與前後兩則 HCOM 通知的事件編號（取自 `notice` 印出的編號）。工具以 `hcom events` 核對：兩則都由本主控送出（發送者等於工作階段紀錄的 HCOM 名稱，或 `hcom list --json` 給它的基本名；有 tag 的主控，HCOM 記的是基本名）、以 `@名稱` 指定對象（不是廣播）、依 `--started` 提供的小數秒位數比較（未提供小數就比較整秒）：前一則可早於或等於開始時間，後一則必須晚於開始時間，且原始時間也必須晚於前一則。只到秒的舊寫法仍接受，例如 `--started 2026-10-29T12:00:00+08:00` 接受前一則在 `12:00:00.4`，拒絕 `12:00:01.2`；後一則在 `12:00:00.9` 仍不合格；不符就拒絕。`--notice-*` 也可給 `notice` 印的 `none-<n>`：工具核對它是本輪由本主控的 `notice` 寫下的無人可通知紀錄，時間順序規則相同，兩則可一真一無；工具另核對該紀錄裡記錄的其他主控確實都不在線；`report` 顯示「無人可通知（none-1，未發訊息）」。HCOM 的 agent 清單格式異常時 `notice` 拒絕，不當作無人在線。事件的 `delivered_to` 為空（沒送到任何人）一律拒絕。動作失敗也要記，`--result failed`，後一則通知寫明失敗。
- `deploy-test`、`deploy-prod` 的 `record`（成功或失敗）寫入預先授權紀錄後，另在被部署專案（`--workspace`，[跨 repo](#主控與動作不在同一個-repo) 時是 B）主工作區的部署歷史追加一筆（見「固定條件」），所以不論從哪個主控部署，下一次 `check` 都讀得到。`--commit` 可給縮寫，歷史記完整提交；在該 repo 找不到就拒絕，兩邊都不寫。
- `--kind manual`：經使用者答覆才做的動作（`check` 是 `ask`），做完一樣要補記。要 `--commit`、`--result`、`--question`；預先授權紀錄記一筆 `kind: manual`，`report` 列在「人工核准（合併、推送、部署）」。不需通知。跨 repo 同樣加 `--workspace <B> --controller-workspace <A>`。
  - `deploy-test`、`deploy-prod`：待決紀錄要在本主控的待決目錄、狀態為 `answered` 或 `approved`。另在部署歷史記 `approval: manual` 與 `question`，否則下一次部署會因為找不到上一次部署而要整套。
  - `push`、`merge`：另要 `--branch`；待決紀錄同 `do --question` 要有真人答覆（含 `- 來源：` 行）。不寫部署歷史。
- `--kind correction`：只追加一筆更正，不改舊行。要 `--commit`（至少 7 碼，與紀錄裡的版本前段相同就算同一個）與 `--note`；`--action` 只更正那個動作的紀錄（同一版本有推送也有部署時用）；`--question` 的題要有真人答覆。該輪找不到這個版本的紀錄就拒絕。`--session-id` 可寫到已結束主控那一輪（它最後一輪），其他種類只能寫進行中的一輪。`report` 在被更正的那筆後面加「（已更正：<說明>；待決 <題號>，<時間>）」。
- `bug-intake` 的五項依據都要寫。

## 免確認開短流程 bug 票

下列五項全部成立時，主控照常建立短流程 tracker issue，但不發 `exempt ticket-confirmation` 確認題，改以 `record --kind bug-intake` 記下使用者原訊息位置與五項各自的依據；之後派工、審查、驗收照短流程：

1. 使用者本人回報：真人親自在聊天或面板寫的；Agent 轉述與 HCOM 訊息不算。
2. 寫清楚哪裡錯、應該怎樣。
3. 一張票做得完。
4. 修好只是回到使用者說的樣子，不新增或改變需求。
5. 要改的行為沒有既有測試或文件寫明本來就該這樣；有的話算改需求，發確認題。

任一項不成立或拿不準，照舊發確認題。

## 交付回報：report

```bash
uv run --no-project python "$lat_dir/scripts/lat-preauth.py" report
```

只列本 session 本輪的紀錄，分四組：依預先授權自動執行、人工核准（合併、推送、部署）、免確認開工、設定寫入（本輪的 `grant`，加上本輪開始以來對本專案層與全域層的看板寫入）；沒有的組印「- 無」。交付回報把整段輸出原樣貼在「參謀定案清單」旁，讓使用者事後檢查或推翻；本輪停用後仍可執行。

## 接上提問

要問的是上面五種動作之一時，待決紀錄加一行 `- action: <動作> [分支] [版本]`：`merge`、`push` 先寫分支再寫版本，例如 `- action: push dev`；其他三種沒有分支，第二個字就是版本，例如 `- action: deploy-test` 或 `- action: install-host 1a2b3c4`。版本可省略，意思同 `check` 不給 `--commit`。

面板寫題（`question ask`）與回合結束的 DECIDE／HELP 檢查遇到有 `- action:` 的紀錄，一律依當下設定與當下時間重跑 `check`，不採用紀錄裡先前寫的結論：

- **已送出**：題號曾在主控自己的問題檔或其歸檔出現，或曾出現在本 session 主控回報紀錄的 `DECIDE:`／`HELP:` 訊息（聊天提問）；任一成立即算，不論版本。
- **未送出且 `allow`**：`question ask` 拒絕寫入（結束碼 1，不改任何檔）；回合結束檢查首次擋下，同回合第二次只警告。不要提問：直接用 `do` 做，並在待決紀錄寫明改依預先授權處理。
- **已送出且 `allow`**：照常寫入與放行，只附一行提醒「此題目前已預先授權，可由使用者決定撤回」；送到使用者面前的題目仍只由真人解除。
- **`ask`**：照常寫入與放行。
- `question ask` 每次寫入都把當下結論寫成紀錄的 `- preauth: <check 印的那行>（重查於 <時間>）`，取代舊的那行，沒有時放在 `- action:` 下一行。這行只給人與參謀閱讀，工具不讀。
- 沒有 `- action:` 的紀錄不重查，行為不變；漏寫由參謀把關。重查本身出錯時照常寫入或放行，只印警告。
