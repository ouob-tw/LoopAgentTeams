# 整套測試閘門（suite-gate）

整套測試一律透過 `scripts/suite-gate.py` 執行。同一份程式內容用同一個指令跑過且通過時直接回報上次結果；相同請求同時送出只跑一次；整個主機同時最多跑 2 套，其餘排隊。只跑單一檔案或指定範圍的測試不必經過閘門。

專案登記檔有對照表時，每張票改用 `affected` 只跑這次改動影響到的測試，整套只在整批合併後與發布前跑，並且要標明用途（見[受影響測試與對照表](#受影響測試與對照表)）。

推送到 main 或推送標籤前，可以用 Git pre-push 檢查確認這份內容已有每一套整套的通過紀錄（見[推送前把關](#推送前把關pre-push)）。

整套跑完後，距上次整理太久或整套明顯變慢時，閘門會開整理票或提醒（見[定期整理觸發](#定期整理觸發)）。

以下 `<skill>` 指本技能安裝後的目錄。只用標準函式庫，只支援 Linux。

## 跑整套測試

```bash
uv run --no-project python <skill>/scripts/suite-gate.py run -- <整套測試指令>
uv run --no-project python <skill>/scripts/suite-gate.py run --rerun "<原因>" -- <整套測試指令>
```

- `--` 之後可以是一整串 shell 指令（一個引號包住的字串，以 `sh -c` 執行），也可以是拆開的參數。指令文字會原樣算進指紋，引號或寫法不同就算不同指令；同一個整套測試請固定用同一種寫法。
- 測試的輸出與結束碼原樣轉出。閘門自己的訊息印在 stderr，開頭是 `suite-gate:`。
- 已通過時不執行，印出上次的執行者、時間、耗時、指令與輸出結尾，以 0 結束，並提醒把這筆當作結果回報：別人要求「再跑一次」本身不是重跑的理由，有具體原因（環境變了、在查偶發失敗等）才用 `--rerun`。
- 資料庫、外部服務或沒進版控的設定改了、需要重跑時，用 `--rerun` 寫原因；原因會記進紀錄。`--rerun` 同樣要排隊。
- 有對照表的專案，`run` 必須標明用途，否則不執行、以結束碼 2 回覆 `affected` 指令：

  ```bash
  uv run --no-project python <skill>/scripts/suite-gate.py run --purpose post-merge -- '<整套測試指令>'  # 整批合併後
  uv run --no-project python <skill>/scripts/suite-gate.py run --purpose release -- '<整套測試指令>'     # 發布前
  uv run --no-project python <skill>/scripts/suite-gate.py run --reason "<為什麼需要整套>" -- '<整套測試指令>'
  ```

  用途與原因寫進紀錄，不進指紋：整批合併後的通過紀錄，發布前可以直接沿用。帶用途的執行沿用了上次結果時，另寫一筆沿用紀錄（`kind: "reuse"`，含用途、被沿用那筆的時間與執行者），本身不能再被沿用。`--rerun` 只管「要不要沿用」，不能代替用途。沒有對照表的專案不需要用途，可以照舊帶。

### 怎樣算「同一份內容」

指紋由三樣組成：工作區內容（追蹤檔加上沒被忽略的新檔，等同 `git add -A` 後的 tree，不動真正的索引）、指令文字、執行目錄相對於 repo 根的路徑。所以合併後 tree 沒變、或在另一個工作區內容相同，都會沿用。

- 只有結束碼 0 且執行前後內容相同的紀錄可以沿用。同一內容最近一次的結果是失敗時，照常執行。
- 執行期間內容改變：照樣寫紀錄，但標為「執行中內容改變，不可沿用」並提醒。測試期間不要改程式檔；改了又在跑完前改回原樣偵測不到。
- 排隊期間內容改變：拿到名額後會重算，放掉手上的名額與鎖，改用新內容從頭再來。
- 不在 Git 工作區時只排隊、不沿用。

### 等待與名額

1. 同一指紋有人正在跑時先等它（每隔一段時間印出對方名稱與已等時間）。它通過就沿用，失敗才自己跑。
2. 再排主機名額，等待時印出正在跑的是誰、前面還有幾個。順序固定是先指紋、後名額。
3. 名額以「這次測試的工作階段（session）是否還有程序活著」判斷。Ctrl-C 或終止訊號會先結束整個測試工作階段再退出，不寫紀錄；閘門被強制殺掉而測試還在跑時，名額繼續被佔用到測試結束。測試自己另開新工作階段的背景程式不計入。

## 查狀態與紀錄

```bash
uv run --no-project python <skill>/scripts/suite-gate.py status
uv run --no-project python <skill>/scripts/suite-gate.py status --fingerprint <開頭幾碼> --limit 20 --json
```

列出正在跑、排隊中與最近的紀錄。核對別人宣稱的整套測試結果時，用回報中的指紋查紀錄，不要自己重跑。

## 專案登記檔

repo 根目錄放 `.suite-gate.json`（進版控）：

```json
{
  "suites": ["uv run --no-project python -m unittest discover -s tests"],
  "fingerprint_include": [".env.test"]
}
```

- `suites`：整套測試指令的樣式，可用 `*`、`?` 萬用字元；比對時空白會先整理成一格。有登記時只以登記為準，不再用預設判斷。
- `fingerprint_include`：額外納入指紋的被忽略檔案（glob，相對 repo 根），例如測試用的環境變數檔。
- `cleanup`：整理票開在哪個 GitHub repo、用哪個標籤，見[定期整理觸發](#定期整理觸發)。

沒有登記檔時用預設判斷：pytest、`python -m unittest`、bun test、vitest、jest、npm／pnpm／yarn test、playwright test、go test、cargo test 等，沒有指定檔案、路徑或篩選參數（如 `-k`、`-t`、`-g`、`-run`）就算整套。寧可多算，被誤判時加原因重跑即可。這個判斷是 `is_full_suite()`，執行前的 hook 也用它。

判斷時換行與 `;`、`&&`、`|` 一樣當作分隔，轉向（`2>&1`、`> out.txt`）連同目標一起略過，引號外、位於字首的 `#` 到行尾當作註解；登記的樣式也照同樣方式整理後再比對。

## 受影響測試與對照表

在專案登記檔加上對照表後，用一條指令跑出這次改動影響到的測試：

```bash
uv run --no-project python <skill>/scripts/suite-gate.py affected
uv run --no-project python <skill>/scripts/suite-gate.py affected --base <commit>
```

- **這次改動**：工作區相對基準點的所有差異，包含已提交、已暫存、未暫存與沒被忽略的新檔，刪除的檔案也算。基準點預設是 HEAD 與 `integration_branch` 的共同祖先；`--base` 直接指定基準 commit。
- **怎麼挑**：每個改動檔依序判斷——
  1. 符合 `shared`：改跑整套。
  2. 本身符合任一規則的 `tests`（是測試檔）：選它自己；已刪除的測試檔不執行。
  3. 符合規則的 `paths`：選該規則 `tests` 對到的現有檔案。`tests` 是空清單代表不需要測試（例如文件）；不是空的卻一個檔案都對不到，改跑整套。
  4. 以上都不符合：沒列在表上，改跑整套。
- 選出的測試依所在目錄分組（取 `affected.commands` 中最長的符合目錄），把相對該目錄的路徑代入 `{tests}`，在該目錄以 `/bin/sh` 執行。沒有目錄涵蓋的測試，改跑整套。
- 輸出（stderr）列出基準點、改動檔、選出的測試與原因、每組執行的指令；測試輸出與結束碼原樣轉出，多組時回傳第一個非 0 的結束碼。
- 受影響測試不佔整套名額、不排隊、不沿用；每組寫一筆紀錄（`kind: "affected"`），含基準 commit、改動檔、該組選出的測試與原因。沒有選出任何測試時不執行、不寫紀錄。
- **改跑整套**（對照表退回整套）：列出觸發的檔案與原因，再對 `full_suites` 的每一套照 `run` 的規則經閘門執行——同樣排隊、佔名額、同內容沿用。紀錄的用途是 `map-fallback`，並記下觸發的檔案（`trigger_files`）；沿用上次結果時寫在沿用紀錄裡。被觸發時把缺的檔案補進對照表；審查者核對對照表的變更。

### 對照表欄位

都寫在 repo 根的 `.suite-gate.json`，進版控。路徑一律相對 repo 根；樣式中 `*`、`?` 不跨目錄，`**` 跨任意層目錄。

| 欄位 | 內容 |
| ---- | ---- |
| `integration_branch` | 整合分支名稱，用來算基準點。 |
| `full_suites` | 每一套整套測試：`command`（一整串 shell 指令文字）與 `cwd`（執行目錄，預設 `.`）。對照表退回整套時跑的就是這些；手動跑時在該目錄用 `run -- '<command>'`（一個引號字串），指紋才會相同。 |
| `affected.commands` | 執行目錄 → 受影響測試指令樣板，`{tests}` 會換成選出的測試路徑（相對該目錄、已加引號）。 |
| `affected.map` | 對應規則清單：`paths`（程式路徑樣式）→ `tests`（測試檔或測試路徑樣式，任一層都可以）。`tests` 只能對到可以直接執行的測試檔，不要對到共用的輔助檔。 |
| `affected.shared` | 改到就改跑整套的路徑樣式，例如依賴鎖定檔、測試共用設定、建置設定。 |

`affected.map` 非空就算「有對照表」：`run` 要求用途、`affected` 可用。`affected` 與 `full_suites` 不影響指紋；`suites`（給 hook 判斷用）照舊另外列。

LoopAgentTeams 風格的例子：

```json
{
  "suites": ["bun run test", "uv run --no-project python -m unittest discover -s skills/local/*/tests"],
  "integration_branch": "dev",
  "full_suites": [
    {"cwd": "board", "command": "bun run test"},
    {"cwd": ".", "command": "uv run --no-project python -m unittest discover -s skills/local/lat/tests"},
    {"cwd": ".", "command": "uv run --no-project python -m unittest discover -s skills/local/three-tier-testing/tests"}
  ],
  "affected": {
    "commands": {
      "board": "bun test {tests}",
      "skills/local/lat": "uv run --no-project python -m unittest {tests}",
      "skills/local/three-tier-testing": "uv run --no-project python -m unittest {tests}"
    },
    "map": [
      {"paths": ["board/src/lib/server/**"], "tests": ["board/tests/server/**/*.test.ts"]},
      {"paths": ["board/src/routes/**"], "tests": ["board/tests/*-page.test.ts"]},
      {"paths": ["skills/local/lat/scripts/lat-watch.py"], "tests": ["skills/local/lat/tests/test_lat_watch.py"]},
      {"paths": ["skills/local/lat/scripts/_lat_common.py"], "tests": ["skills/local/lat/tests/test_*.py"]},
      {"paths": ["skills/local/three-tier-testing/scripts/**"], "tests": ["skills/local/three-tier-testing/tests/test_*.py"]},
      {"paths": ["**/*.md", "docs/**", ".suite-gate.json"], "tests": []}
    ],
    "shared": ["board/package.json", "board/bun.lock", "board/bunfig.toml", "board/vite.config.ts", "skills/local/lat/tests/fixtures/**"]
  }
}
```

改到 `skills/local/lat/scripts/lat-watch.py` 時，在 `skills/local/lat` 執行 `uv run --no-project python -m unittest tests/test_lat_watch.py`；改到 `board/bun.lock` 或沒列在表上的檔案時，經閘門跑（或沿用）三套整套。

## 執行前的 hook

`suite-gate.py hook` 是 Claude 與 Codex 的 PreToolUse hook（matcher `Bash`），讓 Agent 不經閘門就跑整套測試時被擋下：

- 指令裡有整套測試（照上面的判斷，以 hook 輸入的 `cwd` 找專案登記檔）且不是透過 `suite-gate.py run` 執行時擋下（結束碼 2），在 stderr 回覆可直接執行的改寫指令：只把整套測試那一個指令原地換成閘門指令，其餘（`cd`、`export`、管線、轉向、之後的 `echo`）照原樣保留，例如 `cd board && bun test 2>&1 | tail -30` 改寫為 `cd board && uv run --no-project python <skill>/scripts/suite-gate.py run -- 'bun test' 2>&1 | tail -30`。這樣紀錄的結束碼是測試自己的，不會被 `| tail` 或之後的 `echo` 蓋掉。包在 `bash -c '...'` 裡的整套測試，只改寫 `-c` 後面那段內容，外層 shell 與它前面的變數設定、選項照舊。包進閘門的那段以 `/bin/sh` 執行，只看得到已 export 的變數。只有登記檔的樣式要整串指令才對得上時，整串包進去。
- 有對照表的專案（登記檔的 `affected.map` 非空）：同樣擋下，但回覆的可直接執行指令是把整套測試那一個指令原地換成 `suite-gate.py affected`，其餘照原樣保留，例如 `cd board && bun test 2>&1 | tail -30` 改為 `cd board && uv run --no-project python <skill>/scripts/suite-gate.py affected 2>&1 | tail -30`。回覆另附整套的寫法：同樣原地改寫成 `run --reason '<why the full suite is needed>' -- '<整套指令>'`，並說明可改用 `--purpose post-merge` 或 `--purpose release`。
- 放行：透過 `suite-gate.py run` 的指令（含 `--rerun`、`--purpose`、`--reason`）、指定檔案或篩選範圍的測試、非測試指令。同一串指令裡另有沒包裝的整套測試時仍擋下。有對照表的專案中沒帶用途的 `run` 也會被 hook 放行，由 `run` 自己拒絕並回覆 `affected` 指令。
- Claude 送字串；Codex 送字串或 `["bash", "-lc", "<指令>"]`，兩種都讀。回覆方式兩邊相同。
- 讀不懂時比照派工把關與廣播攔截寧可多擋，但不讓 Agent 卡死：hook 輸入不是可讀的 JSON 就放行（無從判斷）；指令讀到一半出錯時，只要像測試執行器（pytest、jest、`npm test` 等）且不含 `suite-gate.py` 就擋下。被擋下時照回覆的改寫指令執行一定會放行；被誤擋時同樣改用閘門，或改成指定檔案的寫法。
- 使用者在終端機自己打的指令不經 hook。

## 安裝與移除 hook

技能檔案安裝不會註冊 hook。比照 LAT hook-setup 與派工把關：先預覽、備份、保留其他 entries，重跑不重複。

```bash
uv run --no-project python <skill>/scripts/suite-gate.py install --client claude --preview
uv run --no-project python <skill>/scripts/suite-gate.py install --client claude
uv run --no-project python <skill>/scripts/suite-gate.py install --client codex --preview
uv run --no-project python <skill>/scripts/suite-gate.py install --client codex
```

- 寫入位置：Claude 預設 `$CLAUDE_CONFIG_DIR/settings.json`（沒設時 `~/.claude/settings.json`），可用 `--claude-settings <檔案>` 指定；Codex 預設 `$CODEX_HOME/hooks.json`（沒設時 `~/.codex/hooks.json`），可用 `--codex-home <目錄>` 指定。
- 在 `PreToolUse` 新增 matcher `Bash` 的獨立 group，command 為 `uv run --no-project python <skill>/scripts/suite-gate.py hook`；Codex 的 group 另帶 `"name": "suite-gate"`。派工把關、廣播攔截等其他 entries 與未知欄位保留。
- 已裝過時不重複；技能搬了位置，重跑 `install` 會就地更新同一筆的路徑。同一檔案裡出現兩筆以上就停下，請手動檢查。
- `--preview` 只印差異、不寫入。寫入前備份為同目錄的 `<檔名>.suite-gate-backup-*`，寫入前確認檔案沒被同時改動，再原子替換。
- `uninstall --client claude|codex`（同樣可加 `--preview` 與路徑參數）只移除這筆 hook，清空後的 group 與 `PreToolUse` 一併移除；與其他 handler 共用的 group 保留其他 handler。
- Claude Code 重啟後在 `/hooks` 確認；Codex 重啟後須在 `/hooks` 檢查並信任這個 command，搬動技能或更新 command 後要重新信任。已在執行的 Agent 重啟後才生效。

驗證：在 Agent 內執行一個整套測試指令（例如 `pytest`），應被擋下並收到改寫指令；照改寫指令執行會跑測試，第二次同內容會直接拿到上次結果。

## 推送前把關（pre-push）

有登記檔的 repo 可以裝 Git pre-push 檢查：推送到 `main` 或推送任何標籤時，要求被推送的 commit 在閘門已有 `full_suites` 每一套的可沿用通過紀錄，缺任何一套就擋下推送。只查紀錄、不跑測試；內容相同時沿用，例如整批合併後（`post-merge`）的通過紀錄，發布前推送直接可用。

- 指紋與閘門相同：被推送 commit 的 tree，加上**推送當下工作區**中 `fingerprint_include` 列的檔案，連同該套的指令文字與執行目錄。所以測試後改了 `.env.test` 等檔案會被擋下，照補跑指令重跑後就能推送。登記檔（`full_suites`、`fingerprint_include`）也讀工作區的。
- 被擋下時列出缺紀錄的參照、commit 與每一套，以及可直接執行的補跑指令：`cd <執行目錄> && uv run --no-project python <skill>/scripts/suite-gate.py run --purpose release -- '<整套指令>'`。指令要在那個 commit 的乾淨內容下執行；工作區內容和它不同時會另外提醒（例如先 `git switch --detach <commit>`）。
- 推送其他分支、刪除遠端參照都不檢查。緊急時 `git push --no-verify` 可略過，屬使用者自行選擇。
- 登記檔讀不到或 `full_suites` 有誤時一律擋下並說明。

### 安裝與移除

```bash
uv run --no-project python <skill>/scripts/suite-gate.py install-pre-push --repo <repo> --preview
uv run --no-project python <skill>/scripts/suite-gate.py install-pre-push --repo <repo>
uv run --no-project python <skill>/scripts/suite-gate.py uninstall-pre-push --repo <repo>
```

- 只裝在命令列指定的 repo，而且 repo 根要有登記檔、`full_suites` 正確，否則拒絕。
- 寫進該 repo 自己的 `<git-common-dir>/hooks/pre-push`（同一 repo 的所有工作區共用）。`--preview` 只印差異。
- 已有 pre-push 時保留原內容：在第一行（須是 sh、bash 等 shell 的 `#!`）之後插入一段有標記的區塊，原 hook 照樣收到推送的參照；寫入前備份為同目錄的 `pre-push.suite-gate-backup-*`。原 hook 不是 shell 腳本或沒有執行權限時拒絕（結束碼 1，檔案一個位元組都不動）：自動串接任意程式或啟用原本被 Git 忽略的 hook 都會改變既有行為。要串接時，手動把原 hook 改名，讓 `pre-push` 成為以 `"$@"` 呼叫它（並傳下 stdin）的 shell 腳本，再重新安裝。標記區塊不完整（缺開頭或結尾、重複或順序顛倒）時，安裝與移除都拒絕、不改檔案。
- 重跑不重複；技能搬了位置，重跑會就地更新區塊中的路徑。`uninstall-pre-push` 只移除這段區塊；檔案原本就是安裝時新建的（區塊內有記號）才整個刪掉，原本就存在的 hook 一律保留其餘內容。
- 設了 `core.hooksPath`（例如全主機共用的 hooks 目錄）時，Git 只跑那個目錄裡的 hook。安裝仍只寫 repo 自己的 hooks 目錄、絕不改共用目錄，照常以 0 結束，但安裝、預覽與重跑時都會明白印出 `Installed but NOT active: core.hooksPath=<目錄> ...`：共用目錄的 `pre-push` 要轉交給 repo 自己的 hook，檢查才會執行，例如：

  ```sh
  local_hook="$(git rev-parse --git-common-dir)/hooks/pre-push"
  [ -x "$local_hook" ] && exec "$local_hook" "$@"
  exit 0
  ```

## 定期整理觸發

每次整套實際跑完（經 `run` 或對照表退回整套），閘門檢查這個專案是否該整理測試；達門檻時在專案 tracker 開整理票，或在已開著的整理票留言更新數字。整理的做法見 [cleanup.md](cleanup.md)。受影響測試（`kind: "affected"`）與沿用上次結果的執行都不檢查。

- **單位**：專案（主 repo 根；同一 repo 的各工作區算同一個）＋整套指令文字＋執行目錄（相對 repo 根）。狀態存在閘門狀態目錄的 `state.json`（`cleanup` 欄位）：上次整理日、統計視窗起點、基準、視窗內最近的耗時樣本與累計數、當天是否已處理。第一次看到某個單位時，當天記為上次整理日並開始新視窗。
- **日期檢查**：每次實際執行完成都檢查，不論通過、失敗或執行中內容改變。距上次整理日**超過** 30 天即觸發（剛好 30 天不觸發）。
- **速度檢查**：樣本只取視窗內「可沿用的通過」（結束碼 0、執行中內容沒變、不是受影響測試）的耗時。視窗內第一筆是基準；之後再累積至少 3 筆才判斷，取最新至多 5 筆的中位數，**大於或等於**基準 × 1.3 即觸發。因為至少取 3 筆的中位數，單次變慢不會觸發；整理完成後舊樣本全部捨棄。基準還沒有時只做日期檢查。
- **tracker**：登記檔的 `cleanup` 欄位指定 GitHub repo 與整理票標籤（標籤預設 `test-cleanup`，須先在該 repo 建好）：

  ```json
  {"cleanup": {"github_repo": "<owner>/<repo>", "label": "test-cleanup"}}
  ```

  觸發時用 `gh issue list --state open --label <標籤>` 找開著的整理票：有就 `gh issue comment` 更新數字，沒有就 `gh issue create`（標題 `Test cleanup: <專案目錄名>`，內文列出觸發原因、上次整理日、基準、目前中位數，並指向本技能的 `references/cleanup.md` 與 `cleanup-done`）。每個單位每天最多一次開票或留言，同一天再觸發只印一行提醒。
- **不影響測試結果**：檢查在測試結束、紀錄寫入、名額釋放之後才做，每次 `gh` 呼叫最多等 10 秒。沒設 tracker、`gh` 失敗或逾時，只在 stderr 印出提醒與應開票的標題和內文，測試輸出與結束碼不變；失敗不算當天已處理，下次執行會再試。
- 只支援 GitHub；其他 tracker 不設 `cleanup`，照 stderr 的內容手動開票。

### 整理完成

```bash
uv run --no-project python <skill>/scripts/suite-gate.py cleanup-done
cd <執行目錄> && uv run --no-project python <skill>/scripts/suite-gate.py cleanup-done --command '<整套指令>' --baseline <秒數>
```

- 在專案內執行（任一工作區皆可）。不帶參數時，這個專案的每個單位都以今天為上次整理日、開始新視窗，基準留給新視窗的第一筆可沿用通過。
- `--command` 只重設在目前目錄執行的那一套（指令文字要和經閘門跑的一樣）；還沒見過時直接建立。`--baseline` 直接指定新基準（秒），須搭配 `--command`。
- 整理票關閉時執行；整理票的收尾步驟見 [cleanup.md](cleanup.md)。

`status` 列出每個單位的整理狀態（上次整理日、視窗起點、基準、目前中位數、是否已達門檻與原因）；`status --json` 在 `cleanup` 欄位列出同樣內容（`median`、`due`）。

`SUITE_GATE_TEST_TODAY=YYYY-MM-DD` 會取代「今天」，只供測試使用。

## 紀錄與設定位置

| 項目 | 預設位置 | 改用其他位置 |
| ---- | -------- | ------------ |
| 紀錄、名額、鎖與整理狀態 | `$XDG_STATE_HOME/suite-gate/`（預設 `~/.local/state/suite-gate/`） | 環境變數 `SUITE_GATE_STATE_DIR` |
| 設定 | `$XDG_CONFIG_HOME/suite-gate/config.json`（預設 `~/.config/suite-gate/config.json`） | 環境變數 `SUITE_GATE_CONFIG` |

整台主機的所有專案與工作區共用同一份紀錄（`ledger.jsonl`，每行一筆）。每筆紀錄有：指紋、tree、repo、指令、執行目錄、結束碼、耗時、輸出結尾、執行者（HCOM 名稱或 session ID，取不到記 `unknown`）、開始與結束時間、`--rerun` 原因、是否執行中內容改變、是否可沿用，以及用途（`purpose`：`post-merge`、`release`、`map-fallback`、`reason` 或 `null`）與自填原因（`purpose_reason`）；對照表退回整套另有 `trigger_files`。受影響測試的紀錄標 `kind: "affected"`，另有 `base`、`changed_files`、`selected_tests` 與 `why`（每個測試被選的原因），一律不可沿用。帶用途的執行沿用上次結果時的沿用紀錄標 `kind: "reuse"`，另有 `reused_time`、`reused_agent`。

設定檔欄位（都可省略）：

```json
{"max_slots": 2, "poll_seconds": 1, "report_seconds": 30}
```

`max_slots` 是主機同時可跑的整套測試數；`poll_seconds` 是排隊時多久檢查一次；`report_seconds` 是多久印一次等待狀況。

## 限制

- 只認程式檔內容；資料庫、外部服務、容器狀態與被忽略的設定檔（除非列入 `fingerprint_include`）不在指紋內，需要時用 `--rerun` 寫原因。
- 測試期間改檔又改回原樣偵測不到。
- 測試自己產生的檔案（例如 `__pycache__/`、`.pytest_cache/`、建置輸出）要列進 `.gitignore`，否則每次都會被當成「執行中內容改變」而無法沿用；被標成這樣時，用 `git status --porcelain` 查是哪些檔案變了。
- 測試自己另開新工作階段的背景程式不算名額。
- 預設判斷只看指令文字，可能誤判；專案登記可讓判斷準確。
