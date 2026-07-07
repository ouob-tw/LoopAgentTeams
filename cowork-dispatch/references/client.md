# Client 執行模式

所有階段呼叫外部 client 時，依本文件規則執行。指令中以 `phase`、`role` 標示該步驟的階段名稱與角色。

## 可用 Client

| Client ID  | 呼叫方式                         | 適用場景              |
| ---------- | -------------------------------- | --------------------- |
| claude-tui | zmx run + claude tui（detached） | 長時任務 + 能人工監控 |
| claude-exec | claude -p "\<prompt\>"           | agent 呼叫            |
| codex-exec | codex exec "\<prompt\>"          | agent 呼叫            |
| codex-tui  | zmx run + codex tui（detached）  | 長時任務 + 能人工監控 |

各維度可用值：

| 維度       | Claude Code                                              | Codex                                            |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------- |
| model      | `claude-opus-4-8`、`claude-sonnet-4-6`、`claude-haiku-4-5` | `gpt-5.5`                                             |
| effort     | `low`、`medium`、`high`、`xhigh`、`max`                    | `low`、`medium`、`high`、`xhigh`                        |
| permission | `plan`、`acceptEdits`、`bypassPermissions`                        | `read-only`、`workspace-write`、`danger-full-access`    |

## 解析優先序

所有維度（client、model、effort、permission、monitor）皆遵循同一優先序：

1. **使用者 prompt** — 最高優先。例如「spec 用 codex-exec 審查」「code 用 claude-tui effort max」「不要監控」。
2. **`.cowork/config.yaml`** — 專案預設（選用）。
3. **內建預設** — 兜底。

`.cowork/config.yaml` 格式（僅列出需覆蓋的欄位）：

```yaml
phases:
  spec_reviewer:
    client: codex-exec
    model: gpt-5.5
    effort: xhigh
    permission: workspace-write
  plan_writer:
    client: codex-exec
    model: gpt-5.5
    effort: xhigh
    permission: workspace-write
  code_executor:
    client: codex-tui
    model: gpt-5.5
    effort: medium
    permission: danger-full-access
monitor:
  enabled: true
  review:
    stall: 300
    drift: 1800
  code:
    stall: 900
    drift: 3600
```

## 內建預設

| 階段          | 角色     | 預設 Client | 預設 model | 預設 effort | 預設 permission    | 理由                                     |
| ------------- | -------- | ----------- | ---------- | ----------- | ------------------ | ---------------------------------------- |
| spec_writer   | 撰寫規格 | self        | —          | —           | —                  | —                                        |
| spec_reviewer | 審查規格 | codex-exec  | gpt-5.5    | xhigh       | workspace-write    | 僅需讀取原始碼與寫入審查結果             |
| plan_writer   | 撰寫計劃 | codex-exec  | gpt-5.5    | xhigh       | workspace-write    | 僅需讀取原始碼與寫入計劃文件             |
| plan_reviewer | 審查計劃 | self        | —          | —           | —                  | —                                        |
| code_executor | 執行實作 | codex-tui   | gpt-5.5    | medium      | danger-full-access | 需執行測試、安裝套件、完整系統存取       |

`self` = 目前執行此 skill 的 agent 自行處理，不委派外部 client。

## exec client

### codex-exec

```bash
codex exec --sandbox <permission> --approval-policy never --model=<model> -c model_reasoning_effort="<effort>" "<prompt>"
```

Log 擷取：

```bash
LOG=.cowork/logs/<phase>-$(date -u +%Y%m%dT%H%M%SZ).log
codex exec --sandbox <permission> --approval-policy never --model=<model> -c model_reasoning_effort="<effort>" "<prompt>" 2>>"$LOG" | tee -a "$LOG"
```

- stdout → terminal（AI 可見）+ log 檔
- stderr → 僅 log 檔
- log 格式：`<phase>-<ISO8601>.log`

### claude-exec

```bash
claude --model=<model> --effort <effort> --permission-mode <permission> -p "<prompt>" --output-format stream-json --verbose > <log_path>
```

Log 擷取：

```bash
LOG=.cowork/logs/<phase>-$(date -u +%Y%m%dT%H%M%SZ).jsonl
claude --model=<model> --effort <effort> --permission-mode <permission> -p "<prompt>" --output-format stream-json --verbose > "$LOG"
```

- stdout（stream-json）→ JSONL 檔
- stderr → terminal（AI 可見）
- **不可 `2>&1`**：stderr 含非 JSON 錯誤文字，混入會破壞 JSONL 格式
- log 格式：`<phase>-<ISO8601>.jsonl`

### exec log 通則

- 多輪迴圈中每次呼叫產生獨立 log。
- 監控腳本以 `stat -c %Y` 偵測 log 檔修改時間，與內容格式無關。

## tui client

客戶端短名：claude → `cc`，codex → `cx`。

工作階段命名 `<短名>-<英文短名>`（如 `cx-user-api`）。先 `zmx list` 檢查同名 session 是否存在，已存在則加數字後綴（如 `cx-user-api-2`）。

### codex-tui

```bash
zmx run cx-<name> -d bash -c 'codex --sandbox <permission> --approval-policy never --model=<model> -c model_reasoning_effort="<effort>" "<prompt>"'
```

### claude-tui

```bash
zmx run cc-<name> -d bash -c 'claude --name <task_id> --model=<model> --effort <effort> --permission-mode <permission> "<prompt>"'
```

### tui 通則

- 必須使用 `zmx run -d`（detached）。沒有 `-d` 時 zmx 阻塞呼叫端，呼叫端退出時工作階段被終止。
- 必須用 `bash -c '...'` 包裹指令。不加時帶旗標的指令被視為單一執行檔名。
- codex-tui 用 `codex`（非 `codex exec`）。
- claude-tui 用 `claude`（互動模式）。`--name` 指定 session 名稱供恢復用。
- 向運行中的 session 傳送訊息：`zmx send <session> "<message>"`。不需終止 session，訊息直接送入 stdin。常見用途：503 卡住時送 `"GO"` 恢復、補充指示、催促回應。

## 監控方式

依 dispatch agent 的能力選擇。`monitor.enabled: false` 或使用者說「不要監控」時跳過監控。

### Claude Code dispatch

**必須**使用 Monitor 工具（`persistent: false`）。不得改用 timeout 或同步等待。

- exec client → Monitor 監控 log 檔（`.log` 或 `.jsonl`）
- tui client → Monitor 執行 tui 監控腳本

### Codex dispatch（或其他無 Monitor 的 agent）

以 `exec_command` 執行監控腳本，再以 `write_stdin` 等待輸出。

**`yield_time_ms` 必須等於該階段的 `stall` 值（毫秒）**，避免腳本 sleep 期間反覆檢查拿到空輸出。

- exec client（review）→ `exec_command` 執行 exec 監控腳本 → `write_stdin` yield_time_ms=300000
- tui client（code）→ `exec_command` 執行 tui 監控腳本 → `write_stdin` yield_time_ms=900000

### exec 監控腳本

腳本內包含 exec 啟動與監控迴圈。依 client 類型替換啟動指令：

```bash
LOG="<log_path>"

# codex-exec 啟動：
<codex_command> 2>>"$LOG" | tee -a "$LOG" &

# claude-exec 啟動（擇一）：
# claude ... --output-format stream-json --verbose > "$LOG" &

EXEC_PID=$!
START=$SECONDS
LAST_MOD=$(stat -c %Y "$LOG" 2>/dev/null || echo 0)
while sleep ${STALL:-300}; do
  kill -0 "$EXEC_PID" 2>/dev/null || { echo "COMPLETED"; break; }
  [ -f "$LOG" ] || continue
  CURRENT_MOD=$(stat -c %Y "$LOG")
  if [ "$CURRENT_MOD" -eq "$LAST_MOD" ]; then
    echo "STALL: log unchanged for ${STALL:-300}s"
    tail -20 "$LOG"; break
  fi
  LAST_MOD=$CURRENT_MOD
  if [ $(( SECONDS - START )) -ge ${DRIFT:-1800} ]; then
    echo "DRIFT_CHECK: $(( SECONDS - START ))s elapsed"
    tail -20 "$LOG"
    START=$SECONDS
  fi
done
```

Claude Code dispatch 使用時：以 `run_in_background: true` 啟動 exec 指令，Monitor 執行監控迴圈（不含啟動部分，僅 `while sleep` 段落）。DRIFT_CHECK 後 `START=$SECONDS` 重設繼續。

Codex dispatch 使用時：整段腳本（含 exec 啟動）以 `exec_command` 執行。DRIFT_CHECK 後 `break`，由 agent 決定是否 resume。

### tui 監控腳本

```bash
SESSION="<session>"
TID="<task_id>"
LAST_LINES=0
LAST_DRIFT=$SECONDS
while sleep ${STALL:-900}; do
  zmx list 2>/dev/null | grep -q "$SESSION" || {
    echo "ALERT: session gone"; zmx history "$SESSION" | tail -20; break
  }
  head -3 .cowork/results.yaml 2>/dev/null | grep -q "$TID" && {
    echo "DONE: $TID"; zmx history "$SESSION" | tail -20; break
  }
  CURRENT=$(zmx history "$SESSION" 2>/dev/null | wc -l)
  if [ "$CURRENT" -gt "$LAST_LINES" ]; then
    LAST_LINES=$CURRENT
  else
    echo "STALL: no new output for ${STALL:-900}s"
    zmx history "$SESSION" | tail -20
  fi
  if [ $(( SECONDS - LAST_DRIFT )) -ge ${DRIFT:-3600} ]; then
    echo "DRIFT_CHECK: ${SECONDS}s elapsed, verify direction"
    zmx history "$SESSION" | tail -20
    LAST_DRIFT=$SECONDS
  fi
done
```

完成判定：`results.yaml` 前幾行包含已派發的 `task_id`。

### 監控事件處理

| 事件 | 來源 | 處理 |
|------|------|------|
| `COMPLETED` | exec | 程序正常結束，進入下一階段 |
| `DONE` | tui | 任務完成，進入下一階段 |
| `STALL` | 兩者 | 檢查狀態，嘗試恢復或報告使用者 |
| `DRIFT_CHECK` | 兩者 | 判斷是否死循環、prompt 劫持或偏離目標。確認偏離時終止並報告 |
| `ALERT: session gone` | tui | zmx session 異常消失，檢查並報告 |

## 錯誤處理

### tui client

- **503 錯誤：** `zmx send <session> "Continue"`
- **codex 帳號配額耗盡：** `codex-multi-auth check` → `codex-multi-auth switch <n>` → `zmx kill <session>` → 依「Session 恢復」恢復
- **全部帳號無配額：** 報告需手動處理，不刪除 `tasks.yaml` 中的任務

### exec client

- **codex-exec 配額耗盡（STALL 觸發或 log 出現配額錯誤）：** `codex-multi-auth check` → `codex-multi-auth switch <n>` → `codex exec resume --sandbox <permission> --approval-policy never <session_id>` → 重新執行監控
- **claude-exec 配額耗盡：** 需手動處理
- **全部帳號無配額：** 報告需手動處理，不刪除 `tasks.yaml` 中的任務

### 中斷防護

exec 或 tui 執行中斷時，**不得自行編造輸出結果**。必須依「Session 恢復」流程恢復取得實際結果。

`codex-multi-auth` 僅適用於 Codex client。

## Session 恢復

Codex/Claude 對話保存在磁碟上，即使 zmx session 被 kill 或 exec 執行中斷，仍可恢復。

**不要使用 `codex exec resume --last`、`codex resume --last` 或 `claude --continue`。** 按工作目錄取最新 session，若中間有人類手動開過 session 會恢復到錯誤的對話。

### exec 恢復

#### codex-exec

查詢 session ID（從 log 檔擷取 stderr 輸出的 session ID）：

```bash
grep -oP 'session id: \K[0-9a-f-]+' "$LOG" | head -1
```

恢復：

```bash
codex exec resume --sandbox <permission> --approval-policy never <session_uuid> "繼續執行未完成的任務"
```

#### claude-exec

session ID 即啟動時 `--name` 指定的 `<task_id>`。

恢復：

```bash
claude --resume <task_id> --permission-mode <permission> -p "繼續執行未完成的任務"
```

### tui 恢復

先 `zmx kill <session>`（如 session 仍存在），再開新 zmx session 恢復對話。

#### codex-tui

查詢 session ID（從 session 檔案搜尋 task_id，UUID 從檔名取）：

```bash
grep -l "<task_id>" ~/.codex/sessions/$(date -u +%Y/%m/%d)/*.jsonl | head -1 | grep -oP '[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'
```

若跨日則搜前一天：`$(date -u -d yesterday +%Y/%m/%d)`。

恢復：

```bash
zmx run cx-<name> -d bash -c 'codex resume --include-non-interactive --sandbox <permission> --approval-policy never <session_uuid> "繼續執行未完成的任務"'
```

#### claude-tui

session ID 即啟動時 `--name` 指定的 `<task_id>`。

恢復：

```bash
zmx run cc-<name> -d bash -c 'claude --resume <task_id> --permission-mode <permission> -p "繼續執行未完成的任務"'
```

## 注意事項

- 不要從 `zmx list`、`created=...`、`date +%s` 或任何 zmx 時間戳計算經過時間。
- 不要在監控腳本之外額外執行 `zmx history` 檢查。
