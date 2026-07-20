# Claude Session 恢復方案決策

`lat-dispatch` 需要在中斷後恢復 Claude Code session（見 clients.md 的「Session 恢復」）。本文記錄兩個候選方案、實測驗證過程，以及為什麼最終採用「UUID 定位 transcript、名稱負責恢復」的混合方案。

下列片段只比較 Claude Session 參數。正式 LAT exec 啟動與恢復仍須依 `lat-dispatch/references/clients.md` 由 `scripts/run-exec-client.sh` 包裹，以保存並清理 client PID。

## 候選方案

### 方案 A：Session ID（UUID）

啟動時指定 UUID，恢復時用同一 UUID：

```bash
# 啟動
SID=$(uuidgen)
claude --session-id "$SID" --name <agent_id> ... -p "$(cat -- "$PROMPT_PATH")"

# 恢復
claude --resume "$SID" --model=<model> --effort <effort> \
  --permission-mode <permission> -p "繼續執行未完成的任務"
```

`--session-id <uuid>` 是官方旗標（claude 2.1.204 起確認存在），恢復目標完全確定，不依賴任何解析規則。

代價是 **UUID 記錄義務**：Dispatch Agent 必須在啟動當下記下 UUID 並保存到中斷之後。若 context 遺失，可從 Claude session index 精確比對 `name == agent_id` 取回 `sessionId`；不依賴自訂 exec log。

### 方案 B：Session 名稱（恢復端採用）

啟動時用 `--name` 命名，恢復時直接用名稱：

```bash
# 啟動
claude --name <agent_id> ... -p "$(cat -- "$PROMPT_PATH")"

# 恢復
claude --resume <agent_id> --model=<model> --effort <effort> \
  --permission-mode <permission> -p "繼續執行未完成的任務"
```

`model`、`effort` 與 `permission` 使用首次啟動時已解析的原始值，不在恢復時重新解析目前預設。即使 Claude Code 版本可自行還原部分 session 設定，LAT 仍明確傳入三者，避免 client 版本、環境變數或全域設定變更造成漂移。

補充實測：`--resume` 同時指定 `--model` 與 `--effort` 時，同 model／同 effort、同 model／不同 effort、不同 model／不同 effort皆可正常恢復，且不會丟失歷史對話。這表示顯式傳參本身是安全的；LAT 仍固定傳回首次啟動時解析的值，避免非預期切換。

## 實測驗證（claude 2.1.204）

1. **同一專案目錄下，`--resume <名稱>` 可成功恢復**：以 `--name` 建立 session 後，第二個 `-p` 呼叫用名稱 resume，確認拿回前一輪對話的上下文。
2. **名稱不存在時 `-p` 模式不會卡住**，直接報錯退出（exit 1）：

   ```
   Error: --resume requires a valid session ID or session title when used with --print.
   Usage: claude -p --resume <session-id|title>. Provided value "..." is not a UUID
   and does not match any session title.
   ```

   官方訊息明寫 `-p` 模式的 `--resume` 接受 session ID **或 session title**，名稱解析是文件化行為，不是巧合。
3. **只有 TUI 模式（無 `-p`）找不到名稱時才會開互動式選單**並帶入搜尋詞。此情境可 `zmx attach` 人工處理。

## 決策：UUID 定位 transcript，名稱負責恢復

關鍵差異在於**恢復憑證是否可重組**：

- `agent_id` 格式為 `<phase>_<instance>_<task_id>`，是**確定性的**；同一 TASK_ID 的 tasks/results ledger 位於 `.lat/workspace/<TASK_ID>/`，可重組名稱恢復指令。instance 代表邏輯 Agent 實例；resume 相同 transcript 時不增加。
- 啟動時仍指定 UUID，讓 Monitor 可直接計算 `~/.claude/projects/<project-slug>/<UUID>.jsonl`。恢復憑證使用名稱，因此不必把 UUID 寫進全域 queue。

失敗模式也可接受：`-p` 模式名稱不存在時乾淨報錯（exit 1、訊息明確），Dispatch Agent 能立刻辨識並回報，不會靜默卡住。

## 名稱方案的前提條件

| 前提 | 現況 |
|------|------|
| 恢復指令須在同一專案目錄執行（名稱在專案 session 範圍內解析） | dispatch 的所有指令都在專案根目錄執行 ✓ |
| session 名稱須唯一 | `<phase>_<instance>_<task_id>` 對同一 task 的 Agent instance 唯一 ✓ |
| TUI 模式找不到名稱會開互動式選單 | 屬恢復流程的例外情境，`zmx attach` 可人工處理 ✓ |

## 何時改用 Session ID 方案

- 未來 CLI 版本移除 `-p --resume` 的 title 解析（升級後恢復失敗時先檢查此點）
- 需要跨專案目錄恢復 session
