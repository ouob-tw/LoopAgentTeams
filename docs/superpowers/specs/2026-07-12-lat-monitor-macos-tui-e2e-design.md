# LAT Monitor macOS 相容與 TUI 端到端驗證設計

## 目標

讓 `lat-dispatch` 的統一 Session Monitor 同時支援 GNU/Linux 與 macOS，並以真實 Codex／Claude TUI 搭配 zmx 完成端到端驗證。四種 client 模式仍直接讀取各 CLI 的原始 Session JSONL，不建立或重新導向獨立 exec log。

## 平台相容設計

`monitor-session.sh` 保持單一 Bash 腳本，但不得要求 macOS 額外安裝 GNU coreutils 或新版 Bash：

- GNU/Linux 使用 `date -d yesterday` 與 GNU `stat`。
- macOS 使用 BSD `date -v-1d` 與 BSD `stat -f`。
- 移除未使用的 `tac` 相依檢查。
- 移除 `mapfile`、關聯陣列等 Bash 4 專屬語法，維持 macOS 內建 Bash 3.2 可執行的語法範圍。
- mtime 相同時維持候選不明，不依 glob 順序猜測 Session。

README 分別列出 GNU/Linux 與 macOS 的必要套件及安裝指令。macOS 不列 `bash`、`coreutils`、`gdate` 或 `gstat` 為必要套件；未在實際 macOS 主機驗證時，文件須明確標示驗證範圍。

## Prompt 傳遞

所有 client 的 prompt 原文都先寫入 `.lat/workspace/<TASK_ID>/prompts/<agent_id>.txt`，再由 `PROMPT_PATH` 讀取。依 CLI 介面使用兩種輸入方式：

- `codex exec` 以 `- < "$PROMPT_PATH"` 從 stdin 讀取。
- Codex TUI、Claude TUI 與 Claude `--print` 以 `"$(cat -- "$PROMPT_PATH")"` 傳入位置參數。

兩種寫法只反映 CLI 介面差異，不改變 prompt 來源與內容，也不得把原始 prompt 直接插入 shell command。

## Skill 內腳本引用

正式 skill 與 `references/*.md` 均以 skill root 相對路徑引用 bundled script：

```bash
scripts/monitor-session.sh codex --agent-id "$AGENT_ID"
```

不得使用可被照抄卻無法解析的 `"<skill-dir>/scripts/monitor-session.sh"` placeholder，也不得假設 skill 安裝在目標專案內。

## Monitor 訊號與結果

對外 runtime signal 保持三種：

- `COMPLETED`：最新 turn 符合 client 的完成契約並已提取 Final Answer。
- `STALL`：Session 尚未出現或 JSONL 修改時間超過門檻未變。
- `DRIFT_CHECK`：非終止通知，要求 Dispatch 檢查方向。

文件另列 exit outcomes，避免與 runtime signal 混淆：`0` 為完成、`2` 為 STALL、`64` 為參數錯誤、`65` 為資料邊界錯誤、`69` 為缺少相依工具。統一 Monitor 不恢復以 zmx 存活狀態為來源的 `ALERT: session gone`。

## Exec 程序完成待辦的邊界

repo root 的 `todo/exec-process-completion-monitoring.md` 可保留為維護待辦，但正式 `lat-dispatch` skill、runtime reference 與 README 架構不依賴或引用該 TODO。現行契約只判定 Session turn 完成；exec EOF 與 exit code 不在本次實作範圍。

## 真實 TUI + zmx 端到端驗證

在 repo root 建立唯一名稱的兩個 detached zmx Session：

1. Codex TUI：以 `[<agent_id>]` 開頭的 prompt 啟動，Monitor 只傳 `agent_id`，驗證自動定位 `~/.codex/sessions/.../*.jsonl`、同 turn 完成事件與原始 Final Answer。
2. Claude TUI：預先產生 UUID 並以 `--session-id` 啟動，Monitor 以明確路徑讀取 `~/.claude/projects/<project-slug>/<UUID>.jsonl`，驗證最新 user prompt 後的 assistant text 與 `stop_reason: end_turn`。

兩個流程都不得將 TUI 輸出重新導向成獨立 log，也不得用 `zmx history` 取代完成判定。Monitor 回傳 `COMPLETED` 與預期 Final Answer 後，直接執行 `zmx kill <session>`，並以 `zmx list` 確認測試 Session 已移除；不傳送 `/exit`。

## 測試與驗收

- Shell 合成測試涵蓋 Linux 與模擬 BSD/macOS 的日期、mtime command selection，以及既有 Codex／Claude 完成判定。
- `bash -n`、Monitor 測試、handoff verification、skill loader 與 `git diff --check` 全部通過。
- 真實 Codex TUI + zmx 與 Claude TUI + zmx 各完成一次，記錄 CLI 版本、Monitor envelope、Final Answer 與 zmx 清理結果。
- 修正後交由 Luna 進行第一輪測試；若發現問題，修正後再由 Luna 做第二輪獨立審查，最後重新檢查專案內全部 skills。
- 不修改或提交與本範圍無關的既有 dirty worktree 內容。

