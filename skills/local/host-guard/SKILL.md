---
name: host-guard
description: Use when a command was blocked by host-guard, or before running a CPU load or stress test (busy loops, stress-ng, sysbench), searching for files across the whole filesystem, or deleting a path built from a variable on a host shared with other agents. Covers how to pin load to a few cores, how to search narrowly, how to write heredocs that stay literal, how to delete safely, how to install LoopAgentTeams skills when `bunx skills add` was blocked, and how to install the hook.
---

# 共用主機保護（host-guard）

多個 Agent 共用同一台主機時，一個人的指令就能拖慢所有人。`scripts/host-guard.py hook` 是 Claude 與 Codex 的 PreToolUse hook，擋下五類指令。以下 `<skill>` 指本技能安裝後的目錄。只用標準函式庫。

## 從根目錄搜尋整個磁碟

`find`、`bfs`、`fd`、`du`、`rg`、`tree`、`grep -r`、`ls -R` 以 `/`、`/mnt`、`/media` 或設定的其他路徑為起點時擋下；Claude 的 Grep／Glob 工具指定這些路徑也擋。包在 `sudo`、`timeout`、`bash -c "…"`、`$(…)` 裡同樣會擋。

改用較小的範圍：專案資料夾、`$HOME` 底下的資料夾、`/etc`、`/usr`、`/opt`。找 PATH 上的程式用 `command -v NAME`。`find / -maxdepth 3` 以內放行。

## 吃滿 CPU 的壓力測試

`while :; do :; done`、`while true; do :; done`、`stress`／`stress-ng --cpu`、`sysbench cpu`、`yes > /dev/null` 沒有限制核心時擋下。指令執行的 `.sh` 腳本（`bash x.sh`、`./x.sh`）也會讀內容檢查。

限制在少數核心（預設上限為主機核心數的 1/4）：

```bash
taskset -c 0-3 bash loadcmp.sh          # 子程序繼承限制，包住啟動腳本即可
systemd-run --user --scope -p AllowedCPUs=0-3 stress-ng --cpu 4 -t 60
```

`taskset -c` 指定的核心數超過上限也會擋。要模擬「主機很忙」，在限制的核心上製造負載，並把被測程式放在同一組核心上跑。

## 會執行指令的 heredoc

結束標記沒加引號的 heredoc（`<<EOF`），內文裡的反引號與 `$(…)` 會在寫檔當下被 shell 執行。寫任務說明或訊息時，內文提到的 `` `bun run build` `` 就會真的跑起來。內文含反引號或 `$(` 且標記沒加引號時擋下；前面加反斜線跳脫的不算。

- 內文照字面保留：標記加引號，`<<'EOF'`。
- 長文字：先用 Write 工具寫檔，再以 `--file` 傳。
- 真的要放指令結果：先存進變數（`now=$(date)`），heredoc 裡只用 `$now`。

## 可能刪錯資料夾的刪除

`rm`、`trash-put`、`trash`、`gio trash` 遇到下列兩種路徑時擋下：

- **最後一段只有變數或指令結果**，例如 `"$T/$name"`、`dir/$(cut …)`。值是空的時候，刪掉的會是上一層整個資料夾。2026-10-23 就有 Agent 因此把自己的整個對話紀錄資料夾丟進垃圾桶。改法：先確認值不是空的，或寫成 `${name:?}`，值是空的時 shell 會直接停下。
- **Agent 對話紀錄與狀態資料夾本身，或它們的上層**：`~/.claude`、`~/.claude/projects` 與其中任一個專案資料夾、`~/.codex`、`~/.codex/sessions`、`~/.codex/archived_sessions`、`~/.hcom`、`~/.local/state/lat`（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`XDG_STATE_HOME` 有設定時依設定），以及 `~` 等上層資料夾。刪裡面的單一檔案照常放行，例如 session-manager 刪一個 `.jsonl`。前面有 `cd` 時，也照刪除時可能所在的每個資料夾檢查。

這條規則只看指令文字，用來接住手誤，不能完整解析 shell；`eval`、腳本檔裡的刪除或刻意繞過都不會被擋。

## 直接從 LoopAgentTeams 安裝技能

`bunx skills add`（`npx`、`bun x`、`pnpm dlx` 也算）的來源是 LoopAgentTeams 的本地 clone 或其 worktree 時擋下，包含其中的子資料夾、`~`、`$HOME` 與 `cd <repo> && bunx skills add .` 的寫法。判斷依據是來源資料夾往上找得到 `scripts/install-skills.py`。其他來源（`mattpocock/skills`、GitHub 上的 `ouob-tw/LoopAgentTeams`）不擋。

指令依 shell 的引號與註解規則拆開：引號裡的文字只是資料（`echo "bunx skills add ~/LoopAgentTeams"` 不擋）；`bash -c '…'` 的內容當成指令讀；`VAR=值`、`env`、`sudo`、`timeout` 等前綴會跳過。這條規則是提醒 Agent 改用腳本，不是安全邊界，以下寫法不解析：雙引號裡的 `$(…)` 或反引號、`eval` 或 `xargs` 組出來的指令。

改用 repo 的安裝腳本：

```bash
uv run --no-project python <repo>/scripts/install-skills.py [--skill NAME ...]
```

腳本只在每個要裝的技能資料夾目前內容都有通過的整套測試紀錄時才安裝；被拒時照它列出的指令透過 suite-gate 跑完測試再裝。不要繞過 hook 改用其他寫法直接安裝。

## 設定

`$XDG_CONFIG_HOME/host-guard/config.json`（預設 `~/.config/host-guard/config.json`，環境變數 `HOST_GUARD_CONFIG` 可改位置）：

```json
{"extra_scan_roots": ["/mnt/raid"], "max_load_cores": 4}
```

- `extra_scan_roots`：再加上要保護的路徑，例如大型或慢速磁碟的掛載點。
- `max_load_cores`：壓力測試最多可用的核心數。

檔案不存在或讀不懂時用預設值。

## 安裝與移除 hook

技能檔案安裝不會註冊 hook。比照 suite-gate：先預覽、備份、保留其他 entries，重跑不重複。

```bash
uv run --no-project python <skill>/scripts/host-guard.py install --client claude --preview
uv run --no-project python <skill>/scripts/host-guard.py install --client claude
uv run --no-project python <skill>/scripts/host-guard.py install --client codex --preview
uv run --no-project python <skill>/scripts/host-guard.py install --client codex
```

- 寫入位置：Claude 預設 `$CLAUDE_CONFIG_DIR/settings.json`（沒設時 `~/.claude/settings.json`），可用 `--claude-settings <檔案>` 指定；Codex 預設 `$CODEX_HOME/hooks.json`（沒設時 `~/.codex/hooks.json`），可用 `--codex-home <目錄>` 指定。
- 在 `PreToolUse` 新增獨立 group：Claude 的 matcher 是 `Bash|Grep|Glob`，Codex 是 `Bash` 並帶 `"name": "host-guard"`。寫入前備份為同目錄的 `<檔名>.host-guard-backup-*`。
- `uninstall --client claude|codex` 只移除這筆 hook。
- Claude Code 重啟後在 `/hooks` 確認；Codex 重啟後須在 `/hooks` 信任這個 command。已在執行的 Agent 重啟後才生效。
- 使用者在終端機自己打的指令不經 hook。
