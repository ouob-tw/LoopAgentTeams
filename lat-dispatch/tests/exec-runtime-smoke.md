# Exec runtime logging 手動 smoke 驗證

真實 Codex 與 Claude exec 各跑一個最小任務，驗證 runtime logs、Session JSONL Final Answer 與 exit status 同時可得（Spec Q8）。結果記錄到 `exec-runtime-smoke-results-<date>.md`。

## 前置

- 專案根目錄執行；`.lat/` 已 init。
- `TASK_ID=lat-exec-runtime-smoke`；若 `.lat/workspace/$TASK_ID/` 已存在，停止並依既有規則驗證其 ledger，不得清空、覆寫或重設。不存在時才以 shell 建立目錄：`mkdir -p ".lat/workspace/$TASK_ID/prompts" ".lat/workspace/$TASK_ID/runtime"`。
- `tasks.yaml` 與 `results.yaml` 的初始內容 `[]`，以及 prompt 檔內容，一律用 Agent 的檔案編輯 API 寫入，不用 shell `printf >` 或 redirection。
- Prompt 檔寫到 `.lat/workspace/$TASK_ID/prompts/<agent_id>.txt`，內容：`[<agent_id>] Reply with exactly: RUNTIME_SMOKE_OK`。

## 共用啟動 gate

launcher 背景啟動後，Monitor 前必須同時確認：

1. launcher 仍存活；
2. PID file 非空，且完整內容只有一個十進位 PID；
3. 該 client PID 仍存活。

等待期間只檢查 process handle 與 PID file，不讀 runtime logs。若 PID file 尚未有效時 launcher 已先退出，立刻 `wait "$LAUNCHER_PID"` 記錄 exit status，僅摘錄 launcher stderr 與已存在 runtime logs 的有限範圍後停止；不得啟動 Monitor 等待 stall。

```bash
while :; do
  if ! kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    wait "$LAUNCHER_PID"
    LAUNCHER_STATUS=$?
    echo "launcher_pre_monitor_exit=$LAUNCHER_STATUS"
    [ ! -f "$STDERR_LOG" ] || tail -n 7 "$STDERR_LOG"
    [ ! -f "$STDOUT_LOG" ] || head -n 3 "$STDOUT_LOG"
    exit "$LAUNCHER_STATUS"
  fi

  if [ -s "$PID_FILE" ] && [ "$(wc -l < "$PID_FILE")" -eq 1 ]; then
    CLIENT_PID=$(cat -- "$PID_FILE")
    if [ -n "$CLIENT_PID" ] &&
       [[ "$CLIENT_PID" =~ ^[0-9]+$ ]] &&
       kill -0 "$CLIENT_PID" 2>/dev/null; then
      break
    fi
  fi
  sleep 0.05
done
```

`wc -l == 1` 要求檔案恰有一個 newline-terminated line；`cat` 必須捕捉完整內容，不能只用 `read` 讀第一行而忽略尾隨垃圾。修改 gate 後先跑 deterministic fixture，不啟動真實 client：

```bash
FIXTURE_DIR=$(mktemp -d /tmp/lat-pid-gate.XXXXXX) || exit 1
sleep 30 &
LIVE_PID=$!
cleanup_fixture() {
  kill "$LIVE_PID" 2>/dev/null || true
  wait "$LIVE_PID" 2>/dev/null || true
  [ ! -d "$FIXTURE_DIR" ] || trash-put "$FIXTURE_DIR"
}
trap cleanup_fixture EXIT

pid_gate_accepts() {
  local pid_file=$1 client_pid
  [ -s "$pid_file" ] && [ "$(wc -l < "$pid_file")" -eq 1 ] || return 1
  client_pid=$(cat -- "$pid_file")
  [ -n "$client_pid" ] &&
    [[ "$client_pid" =~ ^[0-9]+$ ]] &&
    kill -0 "$client_pid" 2>/dev/null
}

printf '%s\n' "$LIVE_PID" >"$FIXTURE_DIR/valid"
printf '%s\njunk\n' "$LIVE_PID" >"$FIXTURE_DIR/live-plus-junk"
printf '%s\n\n' "$LIVE_PID" >"$FIXTURE_DIR/extra-blank"
: >"$FIXTURE_DIR/empty"
printf 'not-a-pid\n' >"$FIXTURE_DIR/nondigit"

for CASE_NAME in valid live-plus-junk extra-blank empty nondigit; do
  if pid_gate_accepts "$FIXTURE_DIR/$CASE_NAME"; then
    ACTUAL=ACCEPT
  else
    ACTUAL=REJECT
  fi
  case "$CASE_NAME" in
    valid) EXPECTED=ACCEPT ;;
    *) EXPECTED=REJECT ;;
  esac
  [ "$ACTUAL" = "$EXPECTED" ] || exit 1
  echo "$CASE_NAME expected=$EXPECTED actual=$ACTUAL PASS"
done
```

## Codex exec

```bash
TASK_ID=lat-exec-runtime-smoke
AGENT_ID=code_executor_1_$TASK_ID
PID_FILE=".lat/workspace/$TASK_ID/runtime/$AGENT_ID.pid"
STDOUT_LOG=".lat/logs/$TASK_ID/$AGENT_ID.stdout.jsonl"
STDERR_LOG=".lat/logs/$TASK_ID/$AGENT_ID.stderr.log"
PROMPT_PATH=".lat/workspace/$TASK_ID/prompts/$AGENT_ID.txt"

lat-dispatch/scripts/run-exec-client.sh --pid-file "$PID_FILE" \
  --stdout-log "$STDOUT_LOG" --stderr-log "$STDERR_LOG" \
  --agent-id "$AGENT_ID" --action launch --stdout-format codex-jsonl -- \
  codex exec --json --sandbox read-only --model gpt-5.6-sol \
    --config model_reasoning_effort="low" - < "$PROMPT_PATH" >/dev/null &
LAUNCHER_PID=$!

# 執行「共用啟動 gate」後才可啟動 Monitor。
lat-dispatch/scripts/monitor-session.sh codex --agent-id "$AGENT_ID" --stall 600 --drift 1800
wait "$LAUNCHER_PID"; echo "exit=$?"
```

記錄：Monitor `COMPLETED` envelope 與 Final Answer 原文、`echo exit=`、`tail -n 7 "$STDERR_LOG"`、
`head -n 3 "$STDOUT_LOG"`（boundary + 前兩筆 event）、
`jq -r 'select(.stream=="meta") | .event.action' "$STDOUT_LOG"`。
不得貼上完整 runtime log，只保留有限範圍。

## Claude exec

同上，改用 `AGENT_ID=code_executor_2_$TASK_ID`、新 prompt 檔，並以：

```bash
UUID=$(uuidgen)
lat-dispatch/scripts/run-exec-client.sh --pid-file "$PID_FILE" \
  --stdout-log "$STDOUT_LOG" --stderr-log "$STDERR_LOG" \
  --agent-id "$AGENT_ID" --action launch --stdout-format claude-stream-json -- \
  claude --session-id "$UUID" --name "$AGENT_ID" \
    --model=claude-sonnet-5 --effort low --permission-mode plan \
    --print --output-format stream-json --verbose "$(cat -- "$PROMPT_PATH")" >/dev/null &
LAUNCHER_PID=$!

# 執行「共用啟動 gate」後才可啟動 Monitor。
JSONL_PATH="$HOME/.claude/projects/-home-swy-LoopAgentTeams/$UUID.jsonl"
lat-dispatch/scripts/monitor-session.sh claude --agent-id "$AGENT_ID" \
  --jsonl-path "$JSONL_PATH" --stall 600 --drift 1800
wait "$LAUNCHER_PID"; echo "exit=$?"
```

## 通過準則（每個 client 都須成立）

1. Monitor 回報 `COMPLETED` 且 Final Answer 含 `RUNTIME_SMOKE_OK`（來源是 Session JSONL，不是 runtime log）。
2. launcher exit status 為 0，PID file 已被 trash-put 清除，runtime logs 保留。
3. `$STDOUT_LOG` 第一行是 `lat.runtime_boundary`（action=launch），其後每行都有 RFC 3339 UTC `captured_at`，原生 event 保存在 `event` 欄位。
4. `$STDERR_LOG` 第一行是 `LAT_RUNTIME_BOUNDARY` sentinel，每行都有 UTC 前綴。
5. 正常完成路徑上，診斷用的 `tail` 只在事後驗證時執行；Dispatch trace 中沒有 runtime log 讀取（Q4 佐證）。

## 清理

驗證完成並記錄結果後：`trash-put .lat/workspace/lat-exec-runtime-smoke .lat/logs/lat-exec-runtime-smoke`（等同 `purge <TASK_ID>`）。
