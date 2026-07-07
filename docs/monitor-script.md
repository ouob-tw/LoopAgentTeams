# 監控腳本說明

Dispatch Agent 在 spec/plan 審查階段使用的 CLI 程序監控腳本。啟動外部 CLI Agent 後，以輪詢方式偵測停滯與偏離。

## 完整腳本

```bash
LOG="<log_path>"

# codex-exec 啟動：
<codex_command> 2>>"$LOG" | tee -a "$LOG" &

# claude-cli 啟動（擇一）：
# claude ... --output-format stream-json --verbose > "$LOG" &

CLI_PID=$!
START=$SECONDS
LAST_MOD=$(stat -c %Y "$LOG" 2>/dev/null || echo 0)
while sleep 300; do
  kill -0 "$CLI_PID" 2>/dev/null || { echo "CLI completed"; break; }
  [ -f "$LOG" ] || continue
  CURRENT_MOD=$(stat -c %Y "$LOG")
  if [ "$CURRENT_MOD" -eq "$LAST_MOD" ]; then
    echo "STALL: log unchanged for 5+ min"
    tail -20 "$LOG"; break
  fi
  LAST_MOD=$CURRENT_MOD
  if [ $(( SECONDS - START )) -ge 1800 ]; then
    echo "DRIFT_CHECK: $(( SECONDS - START ))s elapsed"
    tail -20 "$LOG"
    START=$SECONDS
  fi
done
```

## 逐段解析

### 啟動 CLI 並記錄日誌

```bash
LOG="<log_path>"
<codex_command> 2>>"$LOG" | tee -a "$LOG" &
CLI_PID=$!
```

- stderr 追加到日誌檔，stdout 透過 `tee` 同時輸出到終端和日誌檔
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
while sleep 300; do
```

每 300 秒（5 分鐘）檢查一次。`sleep` 的回傳值作為迴圈條件，只要 sleep 正常完成就繼續執行。

### 程序存活檢查

```bash
kill -0 "$CLI_PID" 2>/dev/null || { echo "CLI completed"; break; }
```

`kill -0` 不發送信號，只檢查程序是否存在。程序已結束則印出訊息並跳出迴圈。

### 日誌檔存在檢查

```bash
[ -f "$LOG" ] || continue
```

防禦性檢查。CLI 剛啟動的前幾秒可能還沒產生輸出，日誌檔尚未建立。跳過本次迭代，避免後續 `stat` 對不存在的檔案報錯。

### STALL 偵測（停滯檢查）

```bash
CURRENT_MOD=$(stat -c %Y "$LOG")
if [ "$CURRENT_MOD" -eq "$LAST_MOD" ]; then
    echo "STALL: log unchanged for 5+ min"
    tail -20 "$LOG"; break
fi
LAST_MOD=$CURRENT_MOD
```

比較日誌檔的修改時間，如果 5 分鐘內沒有任何變化，判定 CLI 可能卡住。印出最後 20 行日誌供除錯後跳出迴圈。

### DRIFT_CHECK 偵測（偏離檢查）

```bash
if [ $(( SECONDS - START )) -ge 1800 ]; then
    echo "DRIFT_CHECK: $(( SECONDS - START ))s elapsed"
    tail -20 "$LOG"
    START=$SECONDS
fi
```

每累計 1800 秒（30 分鐘），印出經過時間和最後 20 行日誌。供外部監控者（人或上層 agent）判斷 CLI 是否還在做正確的事。印完後重設 `START`，下次再過 30 分鐘才會再觸發。

## 監控機制總覽

| 機制 | 觸發條件 | 行為 |
|------|---------|------|
| 程序結束 | PID 不存在 | 正常結束，停止監控 |
| STALL | 日誌 5 分鐘沒更新 | 印出最後 20 行日誌，跳出迴圈 |
| DRIFT_CHECK | 每 30 分鐘 | 印出進度供人工判斷，繼續執行 |

## 與專案的關係

此腳本用於 `cowork-dispatch` 的 spec/plan 審查階段（見 README 的「兩層監控」章節）。Runner 階段使用 zmx 的 `history` 指令進行類似監控，間隔更長（存活 15 分鐘、偏離 1 小時）。
