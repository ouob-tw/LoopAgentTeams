# 整套測試閘門（suite-gate）

整套測試一律透過 `scripts/suite-gate.py` 執行。同一份程式內容用同一個指令跑過且通過時直接回報上次結果；相同請求同時送出只跑一次；排隊中的整套測試依主機剩餘的 CPU 與記憶體放行（至少同時 2 套、最多 8 套，可在設定檔調整），主機壓力過高時暫停放行。只跑單一檔案或指定範圍的測試不必經過閘門。

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
2. 再排主機名額，先來後到：只有排第一的可以開跑，排第一的放不下時後面較小的也要等。等待時每隔一段時間印出正在跑的是誰、前面還有幾個與卡住的原因。順序固定是先指紋、後名額。設定檔每次檢查都重讀，排隊中改設定，下一次檢查就套用。
3. 每套測試在自己的資源群組（systemd 使用者 scope，cgroup v2，名稱 `suite-gate-<編號>.scope`）中執行，測試另開新工作階段的背景程式也在群組裡。名額以「閘門還在，或群組內還有程序」判斷：
   - Ctrl-C 或終止訊號：先對群組內所有程序送 SIGTERM，5 秒內沒結束就以群組的 kill 結束全部，再退出，不寫紀錄。
   - 閘門被強制殺掉而測試還在跑：名額與指紋鎖繼續被佔用，直到群組內的程序全部結束。
   - 測試正常結束後群組內仍有程序：印出警告列出這些程序（PID 與指令），紀錄的 `profile.leftover_processes` 記下數量；閘門不殺它們，名額與鎖照常釋放。
   - 群組在閘門讀完最終用量前不會被回收（閘門在群組內留一個等待程序，讀完才讓它結束）。
4. 主機沒有 cgroup v2 或 systemd 使用者服務（例如沒有 `XDG_RUNTIME_DIR`、連不上使用者 bus）時，印出警告並退回舊做法：測試在新工作階段中執行，名額以這個工作階段是否還有程序判斷，另開新工作階段的程序不計入，也不量用量（`profile.fallback` 為 `true`），預約量一律用預設值：排隊前閘門先試開一個空的使用者 scope（`systemd-run --user --scope ... true`，名稱 `suite-gate-probe-<編號>`），開不起來就從排隊起用預設值；試開成功、開跑時才退回的，開跑後改回預設值。

### 放行計算

**預約量**：每套測試以「同一指令」最近 `profile_history` 筆有效用量紀錄中最高的 CPU 核數（`profile.cpu_peak_cores`）與最高的記憶體（`profile.mem_peak_bytes`）為預約量。「同一指令」的鍵是：repository（同一 repo 各 worktree 共用的 Git 共同目錄）、執行目錄相對於 worktree 根的路徑、指令文字；指令文字中出現的 worktree 根絕對路徑先換成 `<worktree>`，所以不同 worktree 對到同一鍵，不同專案不共用。退回模式或缺值的紀錄不算有效。沒有有效紀錄（第一次跑、不在 Git 工作區）或以退回模式執行時用 `default_cores` 核與 `default_mem_gb` GB。排隊中每次檢查若紀錄檔有變（例如同一指令的另一次執行剛結束），就重新計算預約量。

**每次檢查**（在共用狀態的鎖內，只有排第一的等待者）依序：

1. 執行中已達上限 `max_slots` → 等待。熱更新把上限調低時只是不再放行，已在跑的照跑。
2. 執行中少於有效下限 `min(min_slots, max_slots)` → 直接放行，不看下面任何條件。
3. 讀不到 `/proc/stat` 或 `/proc/meminfo` → 等待（只放行到下限為止）。
4. 煞車開啟 → 等待。
5. 以下兩條都成立才放行，否則等待：
   - 主機剩餘 CPU 核數 − 所有執行中測試的未用 CPU 預約 ≥ 候選的 CPU 預約量。剩餘核數是總核數乘以最近 10–20 秒的閒置比例（`/proc/stat`，閒置含 iowait）。
   - `MemAvailable`（`/proc/meminfo`）− 所有執行中測試的未用記憶體預約 − `mem_reserve_gb` ≥ 候選的記憶體預約量。

未用預約是每套執行中測試的「預約量 − 目前用量」，最少 0：CPU 用閘門最近一次取樣，記憶體讀群組當下的 `memory.current`。目前用量不知道時（閘門已不在、還沒取樣、退回模式、舊版留下沒有資源群組的名額）保留整份預約量；舊版的名額沒有預約量，以預設值計。

**煞車**：讀主機的 `/proc/pressure/io` 與 `/proc/pressure/cpu` 的 `some avg10`。硬碟等待 > `brake_io_high` 或 CPU 等待 > `brake_cpu_high` 時開啟；開啟後要兩者都 < `brake_io_low` 與 `brake_cpu_low` 才關閉。煞車狀態存在共用狀態（`state.json` 的 `brake`），所有閘門看到的一樣；每次檢查與 `status` 都會更新。讀不到某個壓力檔時，該項不觸發也不阻擋煞車，印出警告，`status` 也會列出。

**卡住原因**：放不下時把原因寫成一句存進該等待者的紀錄（`reason`），等待訊息與 `status` 都會顯示。例如：

| 原因 | 訊息 |
| ---- | ---- |
| 前面還有人 | `2 suite(s) queued ahead` |
| 已達上限 | `host cap reached: 8/8 suites running` |
| 讀不到主機資料 | `host data unreadable: /proc/meminfo` |
| 煞車剛開啟或仍在高門檻之上 | `brake on: disk wait 45%, above 40%` |
| 煞車中、還沒降到低門檻 | `brake on until disk wait < 20% and CPU wait < 25% (now disk wait 30%, CPU wait 5%)` |
| CPU 不足 | `not enough CPU: needs 4 cores, 2.5 available` |
| 記憶體不足 | `not enough memory: needs 12 GiB, 9 GiB available` |

CPU 與記憶體都不足時兩句以 `; ` 連接。訊息中的 GB 都是 GiB（1024³ 位元組）；「available」是已扣掉未用預約（記憶體另扣保留量）後的值。

## 查狀態與紀錄

```bash
uv run --no-project python <skill>/scripts/suite-gate.py status
uv run --no-project python <skill>/scripts/suite-gate.py status --fingerprint <開頭幾碼> --limit 20 --json
```

列出主機狀況、正在跑、排隊中與最近的紀錄。核對別人宣稱的整套測試結果時，用回報中的指紋查紀錄，不要自己重跑。

- 主機狀況：閒置 CPU 核數與扣掉未用預約後剩下的核數、`MemAvailable` 與扣掉未用預約和保留量後剩下的記憶體、煞車開關與目前的硬碟與 CPU 等待、上下限；讀不到的主機檔案另列一行。
- 每套執行中測試：預約量（`measured` 實測或 `default` 預設）、目前用量。
- 每個排隊者：卡住的原因與預約量。
- `--json`：`min_slots`（有效下限）、`max_slots`、`config`（實際套用的設定）、`host`（`cores`、`cpu_idle`、`cpu_free_cores`、`mem_available_bytes`、`unused_reservation`、`mem_reserve_bytes`、`cpu_left_cores`、`mem_left_bytes`、`pressure`、`brake`、`unreadable`）、`running`（每筆另有 `usage` 與 `reservation`）、`waiting`（每筆另有 `reason` 與 `reservation`）、`locks`、`records`、`cleanup`（見[定期整理觸發](#定期整理觸發)）。

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

- 在專案內執行（任一工作區皆可）。不帶參數時，這個專案的每個單位都以今天為上次整理日、開始新視窗，基準留給新視窗的第一筆實際執行的可沿用通過（沿用上次結果不算）。當天已開票或留言的單位，重設後當天仍不再動作。
- `--command` 只重設在目前目錄執行的那一套（指令文字要和經閘門跑的一樣）；還沒見過時直接建立。`--baseline` 直接指定新基準（秒），須搭配 `--command`。
- 整理票關閉時執行；整理票的收尾步驟見 [cleanup.md](cleanup.md)。

`status` 列出每個單位的整理狀態（上次整理日、視窗起點、基準、目前中位數、是否已達門檻與原因）；`status --json` 在 `cleanup` 欄位列出同樣內容（`median`、`due`）。

`SUITE_GATE_TEST_TODAY=YYYY-MM-DD` 會取代「今天」，只供測試使用。

## 紀錄與設定位置

| 項目 | 預設位置 | 改用其他位置 |
| ---- | -------- | ------------ |
| 紀錄、名額、鎖與整理狀態 | `$XDG_STATE_HOME/suite-gate/`（預設 `~/.local/state/suite-gate/`） | 環境變數 `SUITE_GATE_STATE_DIR` |
| 設定 | `$XDG_CONFIG_HOME/suite-gate/config.json`（預設 `~/.config/suite-gate/config.json`） | 環境變數 `SUITE_GATE_CONFIG` |

整台主機的所有專案與工作區共用同一份紀錄（`ledger.jsonl`，每行一筆）。每筆紀錄有：指紋、tree、repo、指令、執行目錄、結束碼、耗時、輸出結尾、執行者（HCOM 名稱或 session ID，取不到記 `unknown`）、開始與結束時間、`--rerun` 原因、是否執行中內容改變、是否可沿用、用途（`purpose`：`post-merge`、`release`、`map-fallback`、`reason` 或 `null`）與自填原因（`purpose_reason`）、預約量的鍵 `profile_key`（`repo`、`rel_cwd`、`command`，不在 Git 工作區時為 `null`），以及這次的用量 `profile`：

| 欄位 | 意思 |
| ---- | ---- |
| `cpu_peak_cores` | 每個取樣間隔的 CPU 使用核數中最高的一次（含結束前最後一段） |
| `cpu_avg_cores` | 整段執行的平均核數（CPU 總秒數除以耗時） |
| `cpu_seconds` | 群組的 CPU 總秒數 |
| `mem_peak_bytes` | 群組的記憶體高峰（`memory.peak`） |
| `sample_seconds` | 這次的取樣間隔 |
| `fallback` | 是否為退回模式（沒有資源群組，用量都不量） |
| `leftover_processes` | 正常結束後群組內遺留的程序數 |

讀不到的值記為 `null`，不記 0。

對照表退回整套另有 `trigger_files`。受影響測試的紀錄標 `kind: "affected"`，另有 `base`、`changed_files`、`selected_tests` 與 `why`（每個測試被選的原因），一律不可沿用。帶用途的執行沿用上次結果時的沿用紀錄標 `kind: "reuse"`，另有 `reused_time`、`reused_agent`。

執行中的測試，`status` 顯示目前的 CPU 核數與記憶體，`status --json` 在 `running` 每一筆的 `usage`（`cpu_cores`、`mem_bytes`）。CPU 核數取自閘門最近一次取樣，閘門不在時為空；記憶體讀群組當下的值。名額持有者紀錄有資源群組路徑 `cgroup` 與測試主工作階段 `sid`。

設定檔欄位（都可省略）：

```json
{"min_slots": 2, "max_slots": 8, "brake_io_high": 40, "brake_io_low": 20,
 "brake_cpu_high": 50, "brake_cpu_low": 25, "default_cores": 4, "default_mem_gb": 4,
 "mem_reserve_gb": 8, "profile_history": 5, "sample_seconds": 2,
 "poll_seconds": 1, "report_seconds": 30}
```

| 欄位 | 預設 | 意思 |
| ---- | ---- | ---- |
| `min_slots` | 2 | 下限：執行中少於這個數（且少於上限）時一律放行。整數，可為 0 |
| `max_slots` | 8 | 上限：同時執行的整套測試最多幾套。整數，至少 1。舊設定只寫這一項時照樣是上限（例如只寫 1 就同時只跑 1 套，下限也跟著是 1） |
| `brake_io_high`、`brake_io_low` | 40、20 | 硬碟等待（IO some avg10，%）的煞車開啟與關閉門檻 |
| `brake_cpu_high`、`brake_cpu_low` | 50、25 | CPU 等待（CPU some avg10，%）的煞車開啟與關閉門檻 |
| `default_cores`、`default_mem_gb` | 4、4 | 沒有實測紀錄時的預約量（核、GiB） |
| `mem_reserve_gb` | 8 | 放行時另外保留不用的記憶體（GiB） |
| `profile_history` | 5 | 預約量取最近幾筆有效紀錄的最大值。整數，至少 1 |
| `sample_seconds` | 2 | 執行中多久讀一次群組的 CPU 與記憶體 |
| `poll_seconds` | 1 | 排隊時多久檢查一次 |
| `report_seconds` | 30 | 多久印一次等待狀況 |

設定檔每次檢查都重讀。檔案讀不到或不是 JSON 物件時全部用預設；個別欄位型別不對、是負數（或低於上面寫的最小值）、整數欄位給了小數時，那一欄用預設；同一組煞車門檻的關閉門檻大於開啟門檻時，那一組兩欄都用預設。以上都印出警告（同一個警告每個閘門程序只印一次），閘門照常運作。

測試用的環境變數：`SUITE_GATE_PROC_ROOT` 改指 `pressure/`、`stat`、`meminfo` 的根目錄（預設 `/proc`；各程序的存活判斷仍讀真的 `/proc`），`SUITE_GATE_CGROUP_ROOT` 改指 cgroup 檔案的根目錄（預設 `/sys/fs/cgroup`），`SUITE_GATE_UNIT_PREFIX` 改資源群組名稱的開頭（預設 `suite-gate`）。主機負載的讀取（壓力、`/proc/stat`、`/proc/meminfo`、cgroup 檔案）都集中在 `suite-gate.py` 的「host readings」一節。

## 換版：暫停後切換

舊版看不到資源群組：閘門被殺而只剩測試另開工作階段的程序時，舊版會提早清掉名額與指紋鎖；舊版的 `status` 也會改寫名額紀錄。所以不長期讓新舊版混跑，安裝新版依下面五步。主機上 Claude、Codex 的 hook 與 Agent 直接呼叫都用同一份安裝目錄的程式，一次安裝就全部換新。

1. 以 HCOM 通知所有使用閘門的主控暫停執行所有閘門指令（含 `run` 與 `status`；舊版 `status` 也會改寫名額紀錄），取得目前活著的主控回覆。
2. 以程序清單（不是 `status`）確認主機上沒有任何 `suite-gate.py` 程序（`run`、`status` 等任何子指令），包含仍在計算指紋、尚未登記的 `run`；有就等它結束再查。Agent 每次執行 Bash 時 hook 會短暫啟動 `suite-gate.py hook`，它不讀寫名額，列出時隔幾秒再查即可。
3. 安裝新版，核對安裝目錄的檔案與交付版本相同，裝好立刻記下時間。
4. 再以程序清單確認沒有任何在安裝時間之前啟動的 `suite-gate.py` 程序（任何子指令）；若有人在步驟 2 之後仍啟動了舊版，等它結束後再查。
5. 通知恢復。

檢查指令（沒有輸出才算通過）：

```bash
# 步驟 2：列出所有 suite-gate.py 程序
pgrep -af 'suite-gate\.py'
# 步驟 3：安裝並核對後記下時間
installed=$(date +%s)
# 步驟 4：列出安裝時間之前就啟動、還在跑的 suite-gate.py 程序
ps -eo pid=,etimes=,args= | awk -v age="$(( $(date +%s) - installed ))" '$2 >= age && /suite-gate\.py/'
```

兩個指令的樣式都寫成 `suite-gate\.py`，所以不會列出執行檢查的 shell 自己。步驟 4 以整秒計，安裝同一秒內啟動的程序也會列出，寧可多等。

## 限制

- 只認程式檔內容；資料庫、外部服務、容器狀態與被忽略的設定檔（除非列入 `fingerprint_include`）不在指紋內，需要時用 `--rerun` 寫原因。
- 測試期間改檔又改回原樣偵測不到。
- 測試自己產生的檔案（例如 `__pycache__/`、`.pytest_cache/`、建置輸出）要列進 `.gitignore`，否則每次都會被當成「執行中內容改變」而無法沿用；被標成這樣時，用 `git status --porcelain` 查是哪些檔案變了。
- 測試執行期間另開新工作階段的背景程式算在名額與用量內；測試正常結束後還留著的，閘門只警告、不殺，也不再佔名額，但它們仍吃主機資源（會反映在主機剩餘量裡）。退回模式下這類程式不算名額。
- 預約量取過去實測的高峰；沒跑過的指令先用預設值，跑過一次才改用實測值。剛開跑、還沒爬到高峰的測試保留未用的那段，所以預約量偏大時會少放幾套。
- 未滿下限時不看預約、記憶體保留與煞車，主機極忙時仍會跑到下限套數。
- 硬碟讀寫量不列入預約（使用者 systemd 沒開放 IO 控制器），只用硬碟等待當煞車。
- 預設判斷只看指令文字，可能誤判；專案登記可讓判斷準確。
