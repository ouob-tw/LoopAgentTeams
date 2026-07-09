# 監控腳本說明

Dispatch Agent 在 spec/plan 審查等 exec client 階段使用的監控腳本講解。啟動外部 exec client 後，以輪詢方式偵測停滯與偏離。腳本本體以 `lat-dispatch/references/clients.md` 的「exec 監控腳本」為準，本文逐段解說其設計。

## 完整腳本

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

## 逐段解析

### 啟動 exec client 並記錄日誌

```bash
LOG="<log_path>"
<codex_command> 2>>"$LOG" | tee -a "$LOG" &
EXEC_PID=$!
```

- codex-exec：stderr 追加到日誌檔，stdout 透過 `tee` 同時輸出到終端和日誌檔
- claude-exec：stdout（stream-json）直接寫入 JSONL 日誌檔，stderr 留在終端（不可 `2>&1`，會破壞 JSONL 格式）
- `&` 放到背景執行，`$!` 取得背景程序的 PID

### 初始化計時器

```bash
START=$SECONDS
LAST_MOD=$(stat -c %Y "$LOG" 2>/dev/null || echo 0)
```

- `$SECONDS` 是 bash 內建的秒數計數器，記錄監控起始時間
- `stat -c %Y` 取得日誌檔的最後修改時間（unix timestamp）
- 檔案不存在時 fallback 為 `0`，避免 stat 報錯

### 主監控迴圈

```bash
while sleep ${STALL:-300}; do
```

每 `STALL` 秒檢查一次（預設 300 秒，即 5 分鐘）。間隔由 `.lat/config.yaml` 的 `monitor.<階段>.stall` 決定：review 300、code 900、test 600。`sleep` 的回傳值作為迴圈條件，只要 sleep 正常完成就繼續執行。

### 程序存活檢查

```bash
kill -0 "$EXEC_PID" 2>/dev/null || { echo "COMPLETED"; break; }
```

`kill -0` 不發送信號，只檢查程序是否存在。程序已結束則輸出 `COMPLETED` 並跳出迴圈——這是「監控事件處理」表中進入下一階段的信號。

### 日誌檔存在檢查

```bash
[ -f "$LOG" ] || continue
```

防禦性檢查。exec client 剛啟動的前幾秒可能還沒產生輸出，日誌檔尚未建立。跳過本次迭代，避免後續 `stat` 對不存在的檔案報錯。

### STALL 偵測（停滯檢查）

```bash
CURRENT_MOD=$(stat -c %Y "$LOG")
if [ "$CURRENT_MOD" -eq "$LAST_MOD" ]; then
    echo "STALL: log unchanged for ${STALL:-300}s"
    tail -20 "$LOG"; break
fi
LAST_MOD=$CURRENT_MOD
```

比較日誌檔的修改時間，如果一個 STALL 週期內沒有任何變化，判定 exec client 可能卡住。印出最後 20 行日誌供除錯後跳出迴圈，交由 Dispatch Agent 檢查狀態、嘗試恢復或報告使用者。

### DRIFT_CHECK 偵測（偏離檢查）

```bash
if [ $(( SECONDS - START )) -ge ${DRIFT:-1800} ]; then
    echo "DRIFT_CHECK: $(( SECONDS - START ))s elapsed"
    tail -20 "$LOG"
    START=$SECONDS
fi
```

每累計 `DRIFT` 秒（預設 1800 秒，即 30 分鐘），印出經過時間和最後 20 行日誌。供外部監控者（人或上層 agent）判斷 exec client 是否還在做正確的事。印完後重設 `START`，下個 DRIFT 週期才會再觸發。

Claude Code dispatch 以 Monitor 工具執行迴圈時，DRIFT_CHECK 後重設 `START` 繼續；Codex dispatch 以 `exec_command` 執行時，DRIFT_CHECK 後 `break`，由 agent 決定是否 resume（詳見 clients.md 的「監控方式」）。

## 監控機制總覽

| 機制 | 觸發條件 | 行為 |
|------|---------|------|
| COMPLETED | PID 不存在 | 程序正常結束，停止監控，進入下一階段 |
| STALL | 日誌一個 STALL 週期沒更新 | 印出最後 20 行日誌，跳出迴圈，交由 agent 處理 |
| DRIFT_CHECK | 每 DRIFT 秒 | 印出進度供判斷方向，繼續執行 |

## 與專案的關係

此腳本用於 `lat-dispatch` 的 exec client 監控（見 README 的「兩層監控」章節）。tui client（code/test/qa 階段的 zmx session）使用 clients.md 的「tui 監控腳本」，改以 `zmx history` 行數偵測停滯、`results.yaml` 中的 `agent_id` 判定完成，間隔更長（code 存活 15 分鐘、test 10 分鐘，偏離皆 1 小時）。
