# Client 執行模式

所有階段呼叫外部 client 時，依本文件規則執行。指令中以 `phase`、`role` 標示該步驟的階段名稱與角色。

## 可用 Client

| Client ID  | 呼叫方式                         | 適用場景              |
| ---------- | -------------------------------- | --------------------- |
| claude-tui | zmx run + claude tui（detached） | 長時任務 + 能人工監控 |
| claude-exec | prompt 檔 + `claude --print`       | agent 呼叫            |
| codex-exec | prompt 檔 stdin + `codex exec -`    | agent 呼叫            |
| codex-tui  | zmx run + codex tui（detached）  | 長時任務 + 能人工監控 |

各維度可用值：

| 維度       | Claude Code                                              | Codex                                            |
| ---------- | -------------------------------------------------------- | ----------------------------------------------------- |
| model      | `claude-sonnet-5`、`claude-fable-5`、`claude-sonnet-4-6`、`claude-opus-4-6`、`claude-opus-4-8` | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna` |
| effort     | `low`、`medium`、`high`、`xhigh`、`max`                    | `low`、`medium`、`high`、`xhigh`、`max`                 |
| permission | `plan`、`acceptEdits`、`bypassPermissions`                        | `read-only`、`workspace-write`、`danger-full-access`    |

## 解析優先序

所有維度（client、model、effort、permission、monitor、spec_review_flow）皆遵循同一優先序：

1. **使用者 prompt** — 最高優先。例如「spec 用 codex-exec 審查」「code 用 claude-tui effort max」「不要監控」。
2. **`.lat/config.yaml`** — 專案預設（選用）。
3. **內建預設** — 兜底。

`.lat/config.yaml` 格式（僅列出需覆蓋的欄位）：

```yaml
spec_review_flow: ai-first  # ai-first | user-first
phases:
  spec_reviewer:
    client: codex-exec
    model: gpt-5.6-sol
    effort: xhigh
    permission: read-only
  plan_writer:
    client: codex-exec
    model: gpt-5.6-sol
    effort: xhigh
    permission: workspace-write
  plan_reviewer:
    client: codex-exec
    model: gpt-5.6-sol
    effort: xhigh
    permission: read-only
  code_executor:
    client: codex-tui
    model: gpt-5.6-luna
    effort: high
    permission: danger-full-access
  test_executor:
    client: codex-tui
    model: gpt-5.6-luna
    effort: high
    permission: danger-full-access
  qa_executor:
    client: codex-tui
    model: gpt-5.6-luna
    effort: high
    permission: danger-full-access
test:
  max_retries: 30
  max_retries_per_task: 7
prompts:
  retention_days: 7
logs:
  retention_days: 60
monitor:
  enabled: true
  review:
    stall: 300
    drift: 1800
  code:
    stall: 900
    drift: 3600
  test:
    stall: 600
    drift: 3600
```

## 內建預設

| 階段          | 角色     | 預設 Client | 預設 model | 預設 effort | 預設 permission    | 理由                                     |
| ------------- | -------- | ----------- | ---------- | ----------- | ------------------ | ---------------------------------------- |
| spec_writer   | 撰寫規格 | self        | —          | —           | —                  | —                                        |
| spec_reviewer | 審查規格 | codex-exec  | gpt-5.6-sol | xhigh       | read-only          | report-only，由 Dispatch 驗證 finding    |
| plan_writer   | 撰寫計劃 | codex-exec  | gpt-5.6-sol | xhigh       | workspace-write    | 僅需讀取原始碼與寫入計劃文件             |
| plan_reviewer | 審查計劃 | codex-exec  | gpt-5.6-sol | xhigh       | read-only          | report-only，由 Dispatch 驗證 finding    |
| code_executor | 執行實作 | codex-tui   | gpt-5.6-luna | high        | danger-full-access | 需執行測試、安裝套件、完整系統存取       |
| test_executor | 執行測試與修正 | codex-tui  | gpt-5.6-luna | high        | danger-full-access | 需寫測試、修改程式碼、使用者可介入         |
| qa_executor   | 驗收測試       | codex-tui  | gpt-5.6-luna | high        | danger-full-access | 驅動真實 app、依 QA 清單寫 E2E 測試驗收、不修改實作碼、使用者可介入 |

`self` = 目前執行此 skill 的 agent 自行處理，不委派外部 client。

## exec client

`codex exec` 無 `--ask-for-approval` 旗標——非互動模式本身就不詢問人類。

### codex-exec

```bash
codex exec --sandbox <permission> --model <model> --config model_reasoning_effort="<effort>" - < "$PROMPT_PATH"
```

### claude-exec

```bash
UUID=$(uuidgen)
AGENT_ID="<agent_id>"
claude --session-id "$UUID" --name "$AGENT_ID" \
  --model=<model> --effort <effort> --permission-mode <permission> \
  --print "$(cat -- "$PROMPT_PATH")"
```

- `--session-id "$UUID"`：預先指定 UUID，Project transcript 路徑可直接算出並交給 Monitor
- `--name <agent_id>`：指定 session 名稱供恢復用
- `agent_id` 格式為 `<phase>_<instance>_<task_id>`（如 `spec_reviewer_1_2026-05-18-user-api-spec`）。instance 是該 phase 在此 TASK_ID 下的邏輯 Agent 實例序號，從 1 起算。
- 繼續同一工作、修正 finding、錯誤恢復，或重新建立 zmx wrapper 但 resume 原 transcript 時，維持原 instance。只有建立不延續原 transcript 的新 Agent Session 時才增加 instance。
- Review round 是文件送審次數，與 instance 是不同概念。修正版交給新的 `spec_reviewer`／`plan_reviewer` 獨立審查時，開始新的 review round 與 reviewer instance；同一審查因中斷而 resume 時兩者都不增加。

### Prompt 安全傳遞

所有可重用 prompt template 都以 `[<agent_id>]` 開頭，並在同一 template 內以 `<agent_id>` 引用 ledger 目標。文件 placeholder 一律使用小寫角括號（如 `<agent_id>`、`<task_id>`、`<instance>`）；shell 變數才使用大寫 `$AGENT_ID`、`$TASK_ID`、`$INSTANCE`。寫入 `PROMPT_PATH` 前必須將 placeholder 解析為實際值，送給 client 的 prompt 不得殘留 `<agent_id>`。

不得把原始 prompt 插入 `export LAT_PROMPT="<prompt>"`、`bash -c` 或其他 shell command 字串，否則 `$()`、反引號與引號可能在啟動 client 前被 shell 展開。

Dispatch 先透過自身的檔案編輯 API（不是 shell interpolation）將完整 prompt 原文寫到 `.lat/workspace/<TASK_ID>/prompts/<agent_id>.txt`，設定絕對路徑 `PROMPT_PATH`，client 再從檔案讀取。prompt 檔不是執行 log，保留到該 turn 完成後由 `clean` 依 retention 用 `trash-put` 清理。

### 原始 Session JSONL

四種模式都直接讀 CLI 原始 Session JSONL，不建立或重新導向獨立 exec log：

| Client | 監控來源 | 定位方式 |
| --- | --- | --- |
| claude-exec / claude-tui | `~/.claude/projects/<project-slug>/<UUID>.jsonl` | 啟動時以 `--session-id` 指定 UUID，路徑直接算出 |
| codex-exec / codex-tui | `~/.codex/sessions/<YYYY>/<MM>/<DD>/<session>.jsonl` | Monitor 依 prompt 前綴 `[<agent_id>]` 搜尋本地與 UTC 的今天／前一天，選擇最新匹配檔案 |

完成標記與結果提取：

| Client | 完成標記 | 結果提取 |
| --- | --- | --- |
| Claude exec / TUI | 最新人類 prompt 之後有 assistant text 且 `stop_reason == "end_turn"` | 合併該 assistant record 的 text blocks |
| Codex exec / TUI | 同一 turn 同時有 assistant `phase == "final_answer"` 與 `payload.type == "task_complete"` 或 `"turn_complete"` | 完成事件的 `.payload.last_agent_message` |

`COMPLETED` 只表示 Session JSONL 中最新 turn 已產生 Final Answer 並結束，不保證 exec OS 程序已 EOF／退出或 exit code 為 0。`last-prompt` 不是完成標記。Monitor 必須把提取出的 Final Answer 原文交給 Dispatch Agent：

- `spec_reviewer`、`plan_writer`、`plan_reviewer` 等工作不寫 task ledger；Dispatch 依 `SKILL.md` 的審查裁決契約驗證 Final Answer 中的 finding。
- `code_executor`、`test_executor`、`qa_executor` 不論是 exec 或 tui 都仍須更新 `.lat/workspace/<TASK_ID>/tasks.yaml` 與 `results.yaml`；Monitor 同樣回傳 Final Answer，但流程狀態以精確匹配 `task_id`、`agent_id` 的 ledger status 為準。
- ledger 出現結果不代表 turn 已完成，不能取代上述 Session 完成契約。

## tui client

`codex` TUI 須加 `--ask-for-approval never`——detached session 無人值守，不加則模型會卡在等待審批。`never` 意為「自動執行所有指令，不詢問人類」。

客戶端短名：claude → `cc`，codex → `cx`。

工作階段命名 `<短名>-<英文短名>`（如 `cx-user-api`）。先 `zmx list` 檢查同名 session 是否存在，已存在則加數字後綴（如 `cx-user-api-2`）。

### codex-tui

```bash
export PROMPT_PATH
zmx run cx-<name> -d bash -c 'exec codex --sandbox <permission> --ask-for-approval never --model <model> --config model_reasoning_effort="<effort>" "$(cat -- "$PROMPT_PATH")"'
```

### claude-tui

```bash
UUID=$(uuidgen)
export PROMPT_PATH
zmx run cc-<name> -d bash -c 'exec claude --session-id '"$UUID"' --name <agent_id> --model=<model> --effort <effort> --permission-mode <permission> "$(cat -- "$PROMPT_PATH")"'
```

### tui 通則

- 必須使用 `zmx run -d`（detached）。沒有 `-d` 時 zmx 阻塞呼叫端，呼叫端退出時工作階段被終止。
- 必須用 `bash -c '...'` 包裹指令。不加時帶旗標的指令被視為單一執行檔名。
- codex-tui 用 `codex`（非 `codex exec`）。
- claude-tui 用 `claude`（互動模式）。`--name <agent_id>` 指定 session 名稱供恢復用。`agent_id` 格式為 `<phase>_<instance>_<task_id>`（如 `test_executor_1_2026-05-18-user-api-spec`），instance 固定帶（從 1 起算）。
- 向運行中的 session 傳送動態訊息時，先用檔案編輯 API 寫入安全的 `MESSAGE_PATH`，再執行 `zmx send <session> "$(cat -- "$MESSAGE_PATH")$(printf '\r')"`；不得把原始訊息插入 shell command。`zmx send` 是 raw input，不會自動附加 carriage return，必須手動加 `$(printf '\r')`。固定字串可直接使用，例如 503 卡住時送 `"Continue$(printf '\r')"`。

## 監控方式

依 Dispatch Agent 的能力選擇。`monitor.enabled: false` 或使用者說「不要監控」時跳過監控。

### Claude Code dispatch

**必須**使用 Monitor 工具（`persistent: false`）。不得改用 timeout 或同步等待。

- exec client → `run_in_background: true` 啟動 exec 指令，Monitor 執行 exec 監控腳本（不含啟動部分）
- tui client → Monitor 執行 tui 監控腳本

### Codex dispatch（或其他無 Monitor 的 agent）

以 `exec_command` 執行監控腳本，再以 `write_stdin` 等待輸出。

**`yield_time_ms` 必須等於該階段的 `stall` 值（毫秒）**，避免腳本 sleep 期間反覆檢查拿到空輸出。

- exec client（review）→ `exec_command` 執行 exec 監控腳本 → `write_stdin` yield_time_ms=300000
- tui client（code）→ `exec_command` 執行 tui 監控腳本 → `write_stdin` yield_time_ms=900000

### claude-exec 監控

Project transcript 路徑由啟動時的 UUID 直接算出。背景啟動 exec 後呼叫共用 Monitor：

```bash
JSONL_PATH="$HOME/.claude/projects/<project-slug>/<UUID>.jsonl"
scripts/monitor-session.sh claude \
  --agent-id "$AGENT_ID" --jsonl-path "$JSONL_PATH" \
  --stall "${STALL:-300}" --drift "${DRIFT:-1800}"
```

### codex-exec 監控

Monitor 依 `agent_id` 自動定位 JSONL。Codex dispatch 時包含 exec 啟動；Claude Code dispatch 時 exec 已由 `run_in_background` 啟動，僅執行監控段。

```bash
AGENT_ID="<agent_id>"

# --- Exec 啟動（Codex dispatch 用；Claude Code dispatch 省略此段）---
codex exec --sandbox <permission> --model <model> --config model_reasoning_effort="<effort>" - < "$PROMPT_PATH" >/dev/null 2>&1 &

scripts/monitor-session.sh codex \
  --agent-id "$AGENT_ID" \
  --stall "${STALL:-300}" --drift "${DRIFT:-1800}"
```

Claude Code dispatch 使用時：Monitor 執行共用腳本（不含 exec 啟動）。

Codex dispatch 使用時：exec 啟動與共用監控腳本可在同一個無 PTY 的 `exec_command` session 執行。`codex exec` 必須在 `&` 前將 FD 1 與 FD 2 明確導向 `/dev/null`；Final Answer 改由 Monitor 從原始 Session JSONL 提取。Monitor 自身的 FD 1 與 FD 2 都保留給 Dispatch，Dispatch 以 `write_stdin` 接收 Monitor 的狀態、診斷、`DRIFT_CHECK` 或終端事件。

### claude-tui 監控

Project transcript 路徑由啟動時的 UUID 直接算出。Monitor 先定位最後一筆人類 user prompt，只接受其後含 text 且 `stop_reason == "end_turn"` 的 assistant record，避免把前一個已完成 turn 當成新 turn；這不表示仍在等待下一個 prompt 的 TUI 程序已退出。

```bash
JSONL_PATH="$HOME/.claude/projects/<project-slug>/<UUID>.jsonl"
scripts/monitor-session.sh claude \
  --agent-id "<agent_id>" --jsonl-path "$JSONL_PATH" \
  --stall "${STALL:-900}" --drift "${DRIFT:-3600}"
```

### codex-tui 監控

Monitor 依 `agent_id` 自動定位 JSONL。

```bash
AGENT_ID="<agent_id>"

scripts/monitor-session.sh codex \
  --agent-id "$AGENT_ID" \
  --stall "${STALL:-900}" --drift "${DRIFT:-3600}"
```

Codex 與 Claude 的 exec／TUI 都依各自原始 Session JSONL 判定 turn 完成。若 phase 是 executor，完成後由 Dispatch 另外解析 `.lat/workspace/<TASK_ID>/` ledger；Monitor 仍將 Final Answer 交給 Dispatch。

上述命令都從目前載入的 `lat-dispatch` skill root 執行；不得假設 skill 位於目標專案內。

`STALL` 只結束監控腳本，不終止 exec 或 zmx session。若 Codex 回報 `STALL: session file not found`，Dispatch 依「Session 恢復」的定位方式擴大搜尋並人工確認正確 JSONL，再以 `--jsonl-path "$JSONL_PATH"` 重啟 Monitor。TUI 發生其他 `STALL` 後，Dispatch 再以 `zmx list` 診斷 session 是否消失，決定 `zmx send`、resume 或重新監控。

恢復既有 Session 前必須記錄 `BASELINE_LINES=$(wc -l < "$JSONL_PATH")`，恢復後 Monitor 加上 `--after-line "$BASELINE_LINES"`，避免把前一個已完成 turn 當成本次結果。

### 監控事件處理

| 事件 | 來源 | 處理 |
|------|------|------|
| `COMPLETED` | exec / tui | 對應 client 的完成契約成立；將 Final Answer 交給 Dispatch，再依角色契約決定下一階段 |
| `INCOMPLETE` | Codex exec / tui | 最新 turn 已結束但沒有 Final Answer；依下方流程先驗證配額，再檢查 client 診斷來源，不得推斷完成或原因 |
| `STALL` | 兩者 | 檢查狀態，嘗試恢復或報告使用者 |
| `DRIFT_CHECK` | 兩者 | 判斷是否死循環、prompt 劫持或偏離目標。確認偏離時終止並報告 |

## 錯誤處理

### Codex `INCOMPLETE`

1. 執行 `codex-multi-auth check` → `codex-multi-auth status`，以即時檢查結果及 current／pinned 帳號確認該 Session 是否因配額耗盡而停止；不得只因任一其他帳號顯示 `quota-exhausted` 就判定本 Session 的原因。
2. 若確認是目前帳號配額耗盡，依 client 類型執行下方切換與恢復流程。
3. 若不是配額問題且 client 是 tui，在任何 `zmx send`、`zmx kill` 或 resume 前立即檢查最後畫面：
   ```bash
   zmx history <session> | tail -7
   ```
   若因終端寬度換行而缺少錯誤開頭，改用 `tail -30`。這是人工診斷來源，不以固定行數或字串自動分類錯誤。
4. 若不是配額問題且 client 是 exec，rollout JSONL 不保證保存 transient error，且 client FD 1／FD 2 已導向 `/dev/null`；回報 `INCOMPLETE` 與現有證據並保留 task ledger 原狀，不得猜測原因。

### tui client

- **503 錯誤：** `zmx send <session> "Continue$(printf '\r')"`
- **已確認 codex 帳號配額耗盡：** `codex-multi-auth switch <n>` → `zmx kill <session>` → 依「Session 恢復」恢復
- **全部帳號無配額：** 報告需手動處理，保留 task ledger 原狀

### exec client

- **已確認 codex-exec 帳號配額耗盡：** `codex-multi-auth switch <n>` → `codex exec resume <session_uuid>` → 重新執行監控
- **claude-exec 配額耗盡：** 需手動處理
- **全部帳號無配額：** 報告需手動處理，保留 task ledger 原狀

### 中斷防護

exec 或 tui 執行中斷時，**不得自行編造輸出結果**。必須依「Session 恢復」流程恢復取得實際結果。

`codex-multi-auth` 僅適用於 Codex client。

## Session 恢復

Codex/Claude 對話保存在磁碟上，即使 zmx session 被 kill 或 exec 執行中斷，仍可恢復。

**不要使用 `codex exec resume --last`、`codex resume --last` 或 `claude --continue`。** 按工作目錄取最新 session，若中間有人類手動開過 session 會恢復到錯誤的對話。

### exec 恢復

#### codex-exec

先嚴格列出 prompt 以 `[<agent_id>]` 開頭的候選；不得用只搜尋 agent ID 子字串的 `grep ... | head -1` 自動選取：

```bash
AGENT_ID="<agent_id>"
case "$(uname -s)" in
  Darwin)
    YESTERDAY=$(date -v-1d +%Y/%m/%d)
    UTC_YESTERDAY=$(date -u -v-1d +%Y/%m/%d)
    print_mtime() { stat -f '%m %N' "$1"; }
    ;;
  *)
    YESTERDAY=$(date -d yesterday +%Y/%m/%d)
    UTC_YESTERDAY=$(date -u -d yesterday +%Y/%m/%d)
    print_mtime() { stat -c '%y %n' "$1"; }
    ;;
esac
for day in "$(date +%Y/%m/%d)" "$YESTERDAY" \
           "$(date -u +%Y/%m/%d)" "$UTC_YESTERDAY"; do
  for candidate in "$HOME/.codex/sessions/$day"/*.jsonl; do
    [ -f "$candidate" ] || continue
    jq -ne --arg marker "[$AGENT_ID]" 'first(inputs | select(
      .type == "response_item" and
      .payload.type == "message" and
      .payload.role == "user" and
      any(.payload.content[]?; .type == "input_text" and (.text | startswith($marker)))
    ))' "$candidate" >/dev/null && print_mtime "$candidate"
  done
done
```

Dispatch 依 mtime、prompt 與狀態人工確認唯一的 `JSONL_PATH` 後，從 `session_meta` 取得 ID：

```bash
SESSION_UUID=$(jq -r 'select(.type == "session_meta") | .payload.id' "$JSONL_PATH" | head -1)
[[ "$SESSION_UUID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || { echo "invalid session UUID" >&2; exit 65; }
BASELINE_LINES=$(wc -l < "$JSONL_PATH")
```

恢復：

```bash
codex exec resume "$SESSION_UUID" - < "$PROMPT_PATH" >/dev/null 2>&1 &
```

恢復後以明確路徑監控：

```bash
scripts/monitor-session.sh codex \
  --agent-id "$AGENT_ID" --jsonl-path "$JSONL_PATH" \
  --after-line "$BASELINE_LINES" --stall "${STALL:-300}" --drift "${DRIFT:-1800}"
```

#### claude-exec

session 名稱即啟動時 `--name` 指定的 `<agent_id>`。`-p` 模式的 `--resume` 接受 session ID 或 session 名稱（在同一專案目錄下依名稱解析）；名稱不存在時直接報錯退出（exit 1），不會卡住。

恢復前以原本 UUID 或 session index 確認 `JSONL_PATH`，並記錄：

```bash
BASELINE_LINES=$(wc -l < "$JSONL_PATH")
```

恢復：

```bash
claude --resume <agent_id> --permission-mode <permission> --print "$(cat -- "$PROMPT_PATH")"
```

恢復後使用原本 UUID 對應的 `JSONL_PATH` 重新呼叫共用 Monitor；不建立 resume 專用 log：

```bash
scripts/monitor-session.sh claude \
  --agent-id "$AGENT_ID" --jsonl-path "$JSONL_PATH" \
  --after-line "$BASELINE_LINES" --stall "${STALL:-300}" --drift "${DRIFT:-1800}"
```

### tui 恢復

先 `zmx kill <session>`（如 session 仍存在），再開新 zmx session 恢復對話。

#### codex-tui

依 `codex-exec` 的嚴格候選流程確認 `JSONL_PATH` 並取得 `SESSION_UUID`。

```bash
BASELINE_LINES=$(wc -l < "$JSONL_PATH")
```

恢復：

```bash
export PROMPT_PATH SESSION_UUID
zmx run cx-<name> -d bash -c 'exec codex resume --include-non-interactive --sandbox <permission> --ask-for-approval never "$SESSION_UUID" "$(cat -- "$PROMPT_PATH")"'
```

以相同 `JSONL_PATH` 加 `--after-line "$BASELINE_LINES"` 重新啟動 Monitor。

#### claude-tui

session 名稱即啟動時 `--name` 指定的 `<agent_id>`，在同一專案目錄下以名稱恢復。TUI 模式下名稱不存在時會開啟互動式選單並帶入搜尋詞，此時 `zmx attach` 人工處理，或 kill 後確認名稱重試。

從 session index 確認 `JSONL_PATH` 後，先記錄 `BASELINE_LINES=$(wc -l < "$JSONL_PATH")`。

恢復（互動模式，不加 `-p`）：

```bash
export PROMPT_PATH
zmx run cc-<name> -d bash -c 'exec claude --resume <agent_id> --permission-mode <permission> "$(cat -- "$PROMPT_PATH")"'
```

以相同 `JSONL_PATH` 加 `--after-line "$BASELINE_LINES"` 重新啟動 Monitor。

## 注意事項

- 不要從 `zmx list`、`created=...`、`date +%s` 或任何 zmx 時間戳計算經過時間。
- 正常完成判定只呼叫共用 Monitor，不在外部重寫監控邏輯。只有依 `SKILL.md` 執行異常診斷或人工 fallback 時，才可直接讀取 Session JSONL。
