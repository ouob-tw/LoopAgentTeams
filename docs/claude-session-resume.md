# Claude Session 恢復方案決策

`lat-dispatch` 需要在中斷後恢復 Claude Code session（見 clients.md 的「Session 恢復」）。本文記錄兩個候選方案、實測驗證過程，以及為什麼最終採用名稱方案。

## 候選方案

### 方案 A：Session ID（UUID）

啟動時指定 UUID，恢復時用同一 UUID：

```bash
# 啟動
SID=$(uuidgen)
claude --session-id "$SID" --name <agent_id> ... -p "<prompt>"

# 恢復
claude --resume "$SID" --permission-mode <permission> -p "繼續執行未完成的任務"
```

`--session-id <uuid>` 是官方旗標（claude 2.1.204 起確認存在），恢復目標完全確定，不依賴任何解析規則。

代價是 **UUID 記錄義務**：Dispatch Agent 必須在啟動當下記下 UUID 並保存到中斷之後。若 dispatch 自己的 context 也丟了（session 重啟、context 壓縮），就得從 log 檔或 `zmx history` 裡的啟動指令撈回 UUID，多一道容易失敗的工序。

### 方案 B：Session 名稱（採用）

啟動時用 `--name` 命名，恢復時直接用名稱：

```bash
# 啟動
claude --name <agent_id> ... -p "<prompt>"

# 恢復
claude --resume <agent_id> --permission-mode <permission> -p "繼續執行未完成的任務"
```

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

## 決策：採用名稱方案

關鍵差異在於**恢復憑證是否可重組**：

- `agent_id` 格式為 `<task_id>_<role>`（多輪加 `_test_2` 等後綴），是**確定性的** — task_id 在 `tasks.yaml`／`results.yaml` 裡都有，即使 Dispatch Agent 的 context 完全丟失，也能從佇列檔案直接重組出恢復指令，不需要任何額外記錄。
- UUID 是隨機的，丟了就得回頭翻 log。方案 A 的「確定性」優勢在自動化流程裡反而換來一個新的單點故障。

失敗模式也可接受：`-p` 模式名稱不存在時乾淨報錯（exit 1、訊息明確），Dispatch Agent 能立刻辨識並回報，不會靜默卡住。

## 名稱方案的前提條件

| 前提 | 現況 |
|------|------|
| 恢復指令須在同一專案目錄執行（名稱在專案 session 範圍內解析） | dispatch 的所有指令都在專案根目錄執行 ✓ |
| session 名稱須唯一 | `agent_id` 命名規則保證：task_id 含時間戳與隨機碼，多輪加後綴 ✓ |
| TUI 模式找不到名稱會開互動式選單 | 屬恢復流程的例外情境，`zmx attach` 可人工處理 ✓ |

## 何時改用 Session ID 方案

- 未來 CLI 版本移除 `-p --resume` 的 title 解析（升級後恢復失敗時先檢查此點）
- 需要跨專案目錄恢復 session
