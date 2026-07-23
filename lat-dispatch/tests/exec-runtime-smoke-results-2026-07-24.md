# Exec runtime logging smoke 結果（2026-07-24）

- 執行目錄：`/home/swy/LoopAgentTeams`
- Task ID：`lat-exec-runtime-smoke`
- 結果：`BLOCKED`
- 阻擋原因：真實 Codex exec 通過 PID pre-flight gate 後遇到 usage limit，沒有產生 Session JSONL Final Answer，launcher exit status 為 1。依 smoke brief「quota／auth 不可用即停止」規則，未啟動 Claude exec。
- Procedure correction：事後 review 發現原 gate 只用 `read` 取第一行，無法拒絕 live PID 後的尾隨內容；procedure 已改為驗證完整檔案。此修正沒有重跑 client，也不改變下列歷史 BLOCKED evidence。

## Codex exec

### 啟動與 Monitor trace

啟動使用原生 `codex exec --json`：

```bash
lat-dispatch/scripts/run-exec-client.sh --pid-file "$PID_FILE" \
  --stdout-log "$STDOUT_LOG" --stderr-log "$STDERR_LOG" \
  --agent-id "$AGENT_ID" --action launch --stdout-format codex-jsonl -- \
  codex exec --json --sandbox read-only --model gpt-5.6-sol \
    --config model_reasoning_effort="low" - < "$PROMPT_PATH" >/dev/null &
```

PID gate 在 Monitor 前完成，且當時沒有讀取 runtime logs：

```text
pid_gate=PASS launcher_pid=4111163 client_pid=4111184
```

Monitor 僅讀原始 Session JSONL，回傳：

```text
INCOMPLETE
client=codex
agent_id=code_executor_1_lat-exec-runtime-smoke
turn_id=019f90b8-975a-7ba1-8841-db8d10df7702
reason=turn_complete_without_final_answer
monitor_exit=3
exit=1
pid_file_after=absent
```

### 事後有限 runtime 摘錄

以下摘錄只在 Monitor 結束、launcher `wait` 完成後執行。

`head -n 3 "$STDOUT_LOG"`：

```jsonl
{"captured_at":"2026-07-23T20:44:03Z","stream":"meta","event":{"type":"lat.runtime_boundary","agent_id":"code_executor_1_lat-exec-runtime-smoke","action":"launch"}}
{"captured_at":"2026-07-23T20:44:04Z","stream":"stdout","event":{"type":"thread.started","thread_id":"019f90b8-96af-7582-a50f-e158e39fd20a"}}
{"captured_at":"2026-07-23T20:44:04Z","stream":"stdout","event":{"type":"turn.started"}}
```

錯誤尾端有限摘錄：

```jsonl
{"captured_at":"2026-07-23T20:44:07Z","stream":"stdout","event":{"type":"error","message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 29th, 2026 1:05 AM."}}
{"captured_at":"2026-07-23T20:44:08Z","stream":"stdout","event":{"type":"turn.failed","error":{"message":"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jul 29th, 2026 1:05 AM."}}}
```

`tail -n 7 "$STDERR_LOG"`（實際僅一行）：

```text
2026-07-23T20:44:03Z LAT_RUNTIME_BOUNDARY agent_id=code_executor_1_lat-exec-runtime-smoke action=launch
```

`jq -r 'select(.stream=="meta") | .event.action' "$STDOUT_LOG"`：

```text
launch
```

結構檢查：

```text
CODEX_STDOUT_ALL_ENVELOPES_OK
CODEX_FIRST_TYPE=lat.runtime_boundary
CODEX_FIRST_ACTION=launch
CODEX_STDERR_ALL_PREFIXED_OK
CODEX_STDERR_SENTINEL_OK
```

### Codex 五項準則

1. **FAIL** — Monitor 是 `INCOMPLETE`，且沒有含 `RUNTIME_SMOKE_OK` 的 Final Answer。
2. **FAIL** — PID file 已清除且 runtime logs 保留，但 launcher exit status 是 1，不是 0。
3. **PASS** — 第一行為 action=`launch` 的 `lat.runtime_boundary`；所有保存行皆有 RFC 3339 UTC `captured_at` 且原生資料位於 `event`。
4. **PASS** — stderr 第一行為 `LAT_RUNTIME_BOUNDARY` sentinel，所有現有行都有 UTC 前綴。
5. **FAIL** — trace 證明 Monitor 前未讀 runtime log，且只在失敗後做 bounded diagnosis；但此次沒有正常完成路徑，無法完成 Q4 正常路徑佐證。

## Claude exec

未啟動。Codex 回傳精確 quota 錯誤後，依 brief「任一真實 client 因 quota／auth 不可用即記錄、停止並回報」執行。

### Claude 五項準則

1. **FAIL** — 未執行，沒有 Session JSONL `COMPLETED` 或 Final Answer。
2. **FAIL** — 未執行，沒有 launcher exit status／PID cleanup 證據。
3. **FAIL** — 未執行，沒有 Claude native stream-json runtime stdout 證據。
4. **FAIL** — 未執行，沒有 timestamped stderr sentinel 證據。
5. **FAIL** — 未執行，沒有正常完成 trace。

## Task 6 installed-skill sync 證據

Task 6 報告記錄本任務開始前 `/home/swy/.agents/skills` 與 `/home/swy/.claude/skills` 的 `lat-dispatch`、`lat-code` 均 byte-identical；`/home/swy/.codex/skills` 沒有 LAT copy，未建立新 copy。

本 Task 7 新增 smoke 文件後的 fresh `diff -qr` 必須如實顯示新 evidence artifacts 尚未出現在先前同步的 installed copies；詳細輸出於本文件建立後的 final verification 補記。

```text
SYNC_ROOT=/home/swy/.agents/skills
只在 lat-dispatch/tests 存在：exec-runtime-smoke-results-2026-07-24.md
只在 lat-dispatch/tests 存在：exec-runtime-smoke.md
lat-dispatch diff_exit=1
lat-code diff_exit=0
SYNC_ROOT=/home/swy/.claude/skills
只在 lat-dispatch/tests 存在：exec-runtime-smoke-results-2026-07-24.md
只在 lat-dispatch/tests 存在：exec-runtime-smoke.md
lat-dispatch diff_exit=1
lat-code diff_exit=0
CODEX_ROOT_UNTOUCHED_NO_LAT_COPIES
```

因此，Task 6 的同步前置在 Task 7 開始時成立；本次 fresh diff 的差異只限 Task 7 自己新增的兩份 smoke artifacts。Task 7 沒有擴權重做 installed-skill staged swap。

## PID gate deterministic fixture（procedure correction）

先以舊 gate 重現 root cause：

```text
valid expected=ACCEPT actual=ACCEPT result=PASS
live-plus-junk expected=REJECT actual=ACCEPT result=RED_EXPECTED_FAILURE
extra-blank expected=REJECT actual=ACCEPT result=RED_EXPECTED_FAILURE
empty expected=REJECT actual=REJECT result=PASS
nondigit expected=REJECT actual=REJECT result=PASS
```

修正後 gate 要求 `wc -l == 1`、以 `cat` 捕捉完整內容、內容非空且全為十進位數字，最後才對該 PID 執行 `kill -0`。GREEN fixture：

```text
valid expected=ACCEPT actual=ACCEPT PASS
live-plus-junk expected=REJECT actual=REJECT PASS
extra-blank expected=REJECT actual=REJECT PASS
empty expected=REJECT actual=REJECT PASS
nondigit expected=REJECT actual=REJECT PASS
```

這是 deterministic procedure fixture，不是新的真實 client run；Q8 維持 `BLOCKED`。
