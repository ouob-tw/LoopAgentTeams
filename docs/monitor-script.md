# 監控腳本說明

Dispatch Agent 在 exec / tui client 階段共用 `lat-dispatch/scripts/monitor-session.sh`。腳本直接讀取 CLI 工具的原始 Session JSONL，以修改時間偵測停滯、以 client 對應的 turn 完成契約判定完成並提取 Final Answer。安裝成 skill 後，`lat-dispatch` 內的命令從 skill root 使用相對路徑 `scripts/monitor-session.sh`。

## 設計原則

Codex exec／TUI 直接監控原生 Session JSONL；Claude exec／TUI 直接監控 Project transcript。

- 不使用 `tee`、獨立 exec log、`.exit` 或 `.done` marker
- exec 與 TUI 使用相同的原始 Session 完成來源
- `COMPLETED` 只證明最新 turn 完成，不證明 exec OS 程序退出
- Codex turn 已結束但沒有 Final Answer 時回報 `INCOMPLETE`，不等到 STALL，也不從 rollout 欄位猜測失敗原因
- exec EOF／exit code 不屬於本 Monitor 的 turn 完成契約
- codex 以 `agent_id`（prompt 前綴 `[<agent_id>]`）搜尋定位

## 共通機制

### POLL 等待

`POLL` 是 Monitor 的檢查間隔，預設為 5 秒，可用 `--poll <秒數>` 覆蓋。它適用於所有外部 Agent 監控階段：`spec_reviewer`、`plan_writer`、`code_executor`、`test_executor`、`qa_executor`；由 Dispatch 自行處理的階段不使用 Monitor。

- 尚未找到 JSONL 時，每隔 `POLL` 秒重新定位一次。
- 監控中每輪檢查完成標記、mtime、STALL、DRIFT 後，等待 `POLL` 秒再檢查。
- Monitor 啟動時立即檢查，第一次檢查前不等待；Final Answer 通常最晚在下一個 POLL 週期被發現。
- `sleep "$POLL"` 只暫停 Monitor，不會暫停 Sub-Agent。

`POLL` 是檢查頻率；`STALL` 是多久沒有進展才視為停滯；`DRIFT` 是多久提醒 Dispatch 檢查方向；`yield_time_ms` 是 Dispatch 等待 Monitor 輸出的時間。

### 迴圈結構

所有腳本使用 `while true; do ... sleep; done`，`sleep` 在迴圈尾部，進入迴圈時立即做第一次檢查。如果 exec/tui 在等待階段就已完成，首次迭代即可偵測到完成標記。

### 停滯檢查

```bash
CURRENT_MOD=$(file_mtime "$JSONL_PATH" || echo 0)
if [ "$CURRENT_MOD" != "$LAST_MOD" ]; then
  LAST_MOD=$CURRENT_MOD
  LAST_CHANGE=$SECONDS
elif [ $((SECONDS - LAST_CHANGE)) -ge "$STALL" ]; then
  echo "STALL: JSONL unchanged for ${STALL:-N}s"
  exit 2
fi
```

`file_mtime` 在 GNU/Linux 使用 `stat -c %y`，在 macOS 使用 BSD `stat -f %m`。mtime 改變時重設 `LAST_CHANGE`，只有連續 `STALL` 秒沒有變化才回報停滯。STALL 只結束 Monitor，不終止 exec/tui 程序，dispatch agent 收到事件後決定介入。

### 偏離檢查

```bash
if [ $(( SECONDS - START )) -ge ${DRIFT:-N} ]; then
  echo "DRIFT_CHECK: $(( SECONDS - START ))s elapsed"
  START=$SECONDS
fi
```

每累計 `DRIFT` 秒輸出經過時間。Claude Code dispatch 以 Monitor 執行時重設繼續；Codex dispatch 以 `exec_command` 執行時，agent 收到輸出後自行決定是否中斷。

### 完成標記

| Client | 完成標記 | 檢查方式 | 結果提取 |
|--------|---------|---------|---------|
| Claude exec / TUI | Project transcript 的 `assistant` + text + `stop_reason == "end_turn"` | 先找最後一筆人類 user prompt，再找其後最後一筆符合條件的 assistant record | 合併該 record 的 text blocks |
| Codex exec / TUI | 同一 turn 有 assistant `phase == "final_answer"` 與 `payload.type == "task_complete"` 或 `"turn_complete"` | 以最新 `task_started.turn_id` 配對，不能假設是最後一行 | 完成事件的 `.payload.last_agent_message` |

Claude 的 `last-prompt` 是恢復／分支定位資料，不是完成標記。Project transcript 的 `stop_reason == "end_turn"` 表示模型自然完成該 turn，但不表示 exec 程序已退出。

Monitor 一律把 Final Answer 原文交給 Dispatch。reviewer/writer 不寫 ledger；executor 更新 `.lat/workspace/<TASK_ID>/tasks.yaml` 與 `results.yaml`，但 ledger 不能取代 Session turn 完成標記。

## 共用腳本

四種執行模式都呼叫 bundled Monitor。下列 repo 範例使用完整 repo-relative path；正式 skill 內與 `references/*.md` 則從 skill root 使用 `scripts/monitor-session.sh`。完整參數與 client 啟動範例見 `lat-dispatch/references/clients.md`。

```bash
lat-dispatch/scripts/monitor-session.sh codex \
  --agent-id "$AGENT_ID" --stall 300 --drift 1800
```

Claude exec／TUI 的 Project transcript 路徑由啟動時的 `--session-id "$UUID"` 直接算出，透過 `--jsonl-path "$JSONL_PATH"` 傳入。完整啟動方式見 `lat-dispatch/references/clients.md`。

恢復既有 Session 時，啟動前記錄 JSONL 行數並傳入 `--after-line <N>`；Monitor 只接受該行之後的新 turn，避免回傳上一輪 Final Answer。新 Session 預設 `--after-line 0`。

### Session 定位

Codex exec/tui 不傳 `--jsonl-path`；Monitor 以 `agent_id` 搜尋本地與 UTC 的今天／前一天原生 JSONL，以涵蓋跨午夜時 Codex 依本地日期建立目錄的情況。只接受 user prompt 文字以 `[<agent_id>]` 開頭的檔案，並以原生 `stat` mtime 選擇最新匹配項（GNU/Linux 為奈秒字串，macOS 為 epoch 秒）。若最高 mtime 完全相同，視為候選不明並繼續等待，不依 glob 順序猜測。搜尋時間納入 STALL；自動定位後檔案消失時只考慮該次定位後新出現的匹配路徑，避免退回舊 Session。

若自動定位回報 `STALL: session file not found`，Dispatch 擴大搜尋範圍並人工確認正確 JSONL，然後以明確路徑重啟：

```bash
lat-dispatch/scripts/monitor-session.sh codex \
  --agent-id "$AGENT_ID" --jsonl-path "$JSONL_PATH" \
  --stall 300 --drift 1800
```

## 輸出

成功時輸出固定 envelope，Final Answer 保持原文：

```text
COMPLETED
client=codex
agent_id=<agent_id>
turn_id=<turn_id>
final_answer:
<原始 Final Answer>
```

Codex turn 已有完成事件但沒有 Final Answer 時，輸出固定 envelope 並以 exit code 3 結束：

```text
INCOMPLETE
client=codex
agent_id=<agent_id>
turn_id=<turn_id>
reason=turn_complete_without_final_answer
```

`INCOMPLETE` 不等同配額耗盡。Dispatch 先執行 `codex-multi-auth check` 與 `codex-multi-auth status`；若不是配額問題且為 TUI，須在改變 Session 前以 `zmx history <session> | tail -7` 檢查最後畫面，必要時擴大為 `tail -30`。exec 的 transient error 不保證保存在 rollout JSONL，且目前不另存 client FD 1／FD 2。

腳本不終止 exec 或 zmx session。TUI 發生 STALL 後，Dispatch 再以 `zmx list` 診斷 session 是否仍存在。

## Runtime signals

| 事件 | 來源 | 處理 |
|------|------|------|
| `COMPLETED` | exec / tui | 對應 client 的完成契約成立，提取 Final Answer 交給 Dispatch，再依角色契約決定下一階段 |
| `INCOMPLETE` | Codex exec / tui | turn 已結束但沒有 Final Answer；先驗證配額，再讀取 client 對應診斷來源 |
| `STALL` | 所有 | JSONL 修改時間停滯，交由 dispatch agent 處理 |
| `DRIFT_CHECK` | 所有 | 累計時間過長，供判斷方向 |

`DRIFT_CHECK` 是非終止通知；`COMPLETED`、`INCOMPLETE` 與 `STALL` 會結束本次 Monitor。

## Exit outcomes

| Exit code | 意義 |
|-----------|------|
| `0` | 最新 turn 已完成，Final Answer 已輸出 |
| `2` | Session 未出現或 JSONL 停滯 |
| `3` | Codex 最新 turn 已完成，但沒有 Final Answer |
| `64` | client、參數或數值格式錯誤 |
| `65` | `--after-line` 超出目前 JSONL 範圍 |
| `69` | 缺少必要的本機指令 |

## STALL 間隔

間隔由 `.lat/config.yaml` 的 `monitor.<階段>.stall` 決定：

| 階段 | STALL（秒） | DRIFT（秒） | 適用 |
|------|-----------|------------|------|
| review（spec/plan） | 300 | 1800 | exec |
| code | 900 | 3600 | tui |
| test | 600 | 3600 | tui |
