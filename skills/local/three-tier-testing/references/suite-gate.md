# 整套測試閘門（suite-gate）

整套測試一律透過 `scripts/suite-gate.py` 執行。同一份程式內容用同一個指令跑過且通過時直接回報上次結果；相同請求同時送出只跑一次；整個主機同時最多跑 2 套，其餘排隊。只跑單一檔案或指定範圍的測試不必經過閘門。

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

### 怎樣算「同一份內容」

指紋由三樣組成：工作區內容（追蹤檔加上沒被忽略的新檔，等同 `git add -A` 後的 tree，不動真正的索引）、指令文字、執行目錄相對於 repo 根的路徑。所以合併後 tree 沒變、或在另一個工作區內容相同，都會沿用。

- 只有結束碼 0 且執行前後內容相同的紀錄可以沿用。同一內容最近一次的結果是失敗時，照常執行。
- 執行期間內容改變：照樣寫紀錄，但標為「執行中內容改變，不可沿用」並提醒。測試期間不要改程式檔；改了又在跑完前改回原樣偵測不到。
- 排隊期間內容改變：拿到名額後會重算，放掉手上的名額與鎖，改用新內容從頭再來。
- 不在 Git 工作區時只排隊、不沿用。

### 等待與名額

1. 同一指紋有人正在跑時先等它（每隔一段時間印出對方名稱與已等時間）。它通過就沿用，失敗才自己跑。
2. 再排主機名額，等待時印出正在跑的是誰、前面還有幾個。順序固定是先指紋、後名額。
3. 每套測試在自己的資源群組（systemd 使用者 scope，cgroup v2，名稱 `suite-gate-<編號>.scope`）中執行，測試另開新工作階段的背景程式也在群組裡。名額以「閘門還在，或群組內還有程序」判斷：
   - Ctrl-C 或終止訊號：先對群組內所有程序送 SIGTERM，5 秒內沒結束就以群組的 kill 結束全部，再退出，不寫紀錄。
   - 閘門被強制殺掉而測試還在跑：名額與指紋鎖繼續被佔用，直到群組內的程序全部結束。
   - 測試正常結束後群組內仍有程序：印出警告列出這些程序（PID 與指令），紀錄的 `profile.leftover_processes` 記下數量；閘門不殺它們，名額與鎖照常釋放。
   - 群組在閘門讀完最終用量前不會被回收（閘門在群組內留一個等待程序，讀完才讓它結束）。
4. 主機沒有 cgroup v2 或 systemd 使用者服務（例如沒有 `XDG_RUNTIME_DIR`、連不上使用者 bus）時，印出警告並退回舊做法：測試在新工作階段中執行，名額以這個工作階段是否還有程序判斷，另開新工作階段的程序不計入，也不量用量（`profile.fallback` 為 `true`）。

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

沒有登記檔時用預設判斷：pytest、`python -m unittest`、bun test、vitest、jest、npm／pnpm／yarn test、playwright test、go test、cargo test 等，沒有指定檔案、路徑或篩選參數（如 `-k`、`-t`、`-g`、`-run`）就算整套。寧可多算，被誤判時加原因重跑即可。這個判斷是 `is_full_suite()`，執行前的 hook 也用它。

判斷時換行與 `;`、`&&`、`|` 一樣當作分隔，轉向（`2>&1`、`> out.txt`）連同目標一起略過，引號外、位於字首的 `#` 到行尾當作註解；登記的樣式也照同樣方式整理後再比對。

## 執行前的 hook

`suite-gate.py hook` 是 Claude 與 Codex 的 PreToolUse hook（matcher `Bash`），讓 Agent 不經閘門就跑整套測試時被擋下：

- 指令裡有整套測試（照上面的判斷，以 hook 輸入的 `cwd` 找專案登記檔）且不是透過 `suite-gate.py run` 執行時擋下（結束碼 2），在 stderr 回覆可直接執行的改寫指令：只把整套測試那一個指令原地換成閘門指令，其餘（`cd`、`export`、管線、轉向、之後的 `echo`）照原樣保留，例如 `cd board && bun test 2>&1 | tail -30` 改寫為 `cd board && uv run --no-project python <skill>/scripts/suite-gate.py run -- 'bun test' 2>&1 | tail -30`。這樣紀錄的結束碼是測試自己的，不會被 `| tail` 或之後的 `echo` 蓋掉。包在 `bash -c '...'` 裡的整套測試，只改寫 `-c` 後面那段內容，外層 shell 與它前面的變數設定、選項照舊。包進閘門的那段以 `/bin/sh` 執行，只看得到已 export 的變數。只有登記檔的樣式要整串指令才對得上時，整串包進去。
- 放行：透過 `suite-gate.py run` 的指令（含 `--rerun`）、指定檔案或篩選範圍的測試、非測試指令。同一串指令裡另有沒包裝的整套測試時仍擋下。
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

## 紀錄與設定位置

| 項目 | 預設位置 | 改用其他位置 |
| ---- | -------- | ------------ |
| 紀錄、名額與鎖 | `$XDG_STATE_HOME/suite-gate/`（預設 `~/.local/state/suite-gate/`） | 環境變數 `SUITE_GATE_STATE_DIR` |
| 設定 | `$XDG_CONFIG_HOME/suite-gate/config.json`（預設 `~/.config/suite-gate/config.json`） | 環境變數 `SUITE_GATE_CONFIG` |

整台主機的所有專案與工作區共用同一份紀錄（`ledger.jsonl`，每行一筆）。每筆紀錄有：指紋、tree、repo、指令、執行目錄、結束碼、耗時、輸出結尾、執行者（HCOM 名稱或 session ID，取不到記 `unknown`）、開始與結束時間、`--rerun` 原因、是否執行中內容改變、是否可沿用，以及這次的用量 `profile`：

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

執行中的測試，`status` 顯示目前的 CPU 核數與記憶體，`status --json` 在 `running` 每一筆的 `usage`（`cpu_cores`、`mem_bytes`）。CPU 核數取自閘門最近一次取樣，閘門不在時為空；記憶體讀群組當下的值。名額持有者紀錄有資源群組路徑 `cgroup` 與測試主工作階段 `sid`。

設定檔欄位（都可省略）：

```json
{"max_slots": 2, "poll_seconds": 1, "report_seconds": 30, "sample_seconds": 2}
```

`max_slots` 是主機同時可跑的整套測試數；`poll_seconds` 是排隊時多久檢查一次；`report_seconds` 是多久印一次等待狀況；`sample_seconds` 是執行中多久讀一次群組的 CPU 與記憶體。

測試用的環境變數：`SUITE_GATE_CGROUP_ROOT` 改指 cgroup 檔案的根目錄（預設 `/sys/fs/cgroup`），`SUITE_GATE_UNIT_PREFIX` 改資源群組名稱的開頭（預設 `suite-gate`）。

## 限制

- 只認程式檔內容；資料庫、外部服務、容器狀態與被忽略的設定檔（除非列入 `fingerprint_include`）不在指紋內，需要時用 `--rerun` 寫原因。
- 測試期間改檔又改回原樣偵測不到。
- 測試自己產生的檔案（例如 `__pycache__/`、`.pytest_cache/`、建置輸出）要列進 `.gitignore`，否則每次都會被當成「執行中內容改變」而無法沿用；被標成這樣時，用 `git status --porcelain` 查是哪些檔案變了。
- 測試執行期間另開新工作階段的背景程式算在名額與用量內；測試正常結束後還留著的，閘門只警告、不殺，也不再佔名額，但它們仍吃主機資源。退回模式下這類程式不算名額。
- 預設判斷只看指令文字，可能誤判；專案登記可讓判斷準確。
