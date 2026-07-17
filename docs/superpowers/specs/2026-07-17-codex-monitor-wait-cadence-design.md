# Codex Monitor 等待節奏修正規格

## 適用範圍

本規格只描述目前 Codex `functions.exec`、`functions.wait`、`exec_command` 與 `write_stdin` 的工具機制及參數。其他 agent、client 或 runtime 的對應機制尚未驗證，不得從本規格類推；各 client 仍依自己的工具契約處理。

## 背景

Codex Dispatch 透過 `exec_command` 啟動 LAT Monitor shell process，再以 `write_stdin` 等待同一個 exec session 的輸出。實際執行時，即使內層等待已設為 30 或 60 秒，外層 `functions.exec` 若未設定自己的 yield，仍會沿用約 10 秒的預設值，提早回傳 `Script running with cell ID ...` 並喚醒 Codex。

這個現象不會重啟 Monitor，也不會重設 `STALL`，但會造成不必要的工具往返與頻繁喚醒。2026-07-17 的實際重現中，內層 `exec_command.yield_time_ms` 設為 30000，外層未設 pragma；約 10 秒後外層回傳 `cell ID 166`，以 `functions.wait(cell_id=166)` 接續原 cell 後，同一批測試約 2 秒後完成。

## 名詞與層級

### Monitor shell process

- 由 `exec_command` 啟動。
- 以 exec `session_id` 識別。
- 依 `POLL`（預設 5 秒）自行檢查 CLI 原始 Session JSONL。
- `STALL`、`DRIFT_CHECK`、`COMPLETED` 與 `INCOMPLETE` 均由 Monitor 判定。

### 內層 `write_stdin`

- 使用 exec `session_id` 等待既有 Monitor shell process 的輸出。
- `chars: ""` 代表空輪詢，schema 單次等待上限為 300000 毫秒（5 分鐘）。
- 傳入非空字元時，單次等待上限為 30000 毫秒。
- 等待結束但 Monitor 尚未完成時，下一次仍使用同一個 exec `session_id`。

### 外層 `functions.exec`

- 包住實際的 `tools.write_stdin(...)` 呼叫。
- 未指定 pragma 時約 10 秒先 yield，產生 `Script running with cell ID ...`。
- `cell_id` 只識別外層 JavaScript cell，不是 Monitor 的 exec `session_id`。
- 已實測 `// @exec: {"yield_time_ms": 300000}` 可被接受，但目前 schema 與 Codex Manual 未公布 `functions.exec` 的明確最大值，因此不得把「接受 300000」描述為已證明其硬上限或所有環境都一定完整等待 5 分鐘。
- 外層提早 yield 時，`functions.wait(cell_id)` 只接續同一個 JavaScript cell，不會重啟 Monitor。

## 60 秒指引與本次決策

目前 Codex developer 行為指引要求「避免執行超過 60 秒的阻塞 sleep／wait，因為期間可能無法與使用者溝通」。這是互動性指引，不是 `functions.exec` 或 `write_stdin` 的工具硬限制，也不是 LAT Monitor 的 timeout。

首次執行工具時通常還沒有新的使用者請求需要處理，因此使用者決定首次外層 `functions.exec` 等待 120000 毫秒。進入後續等待後，為避免使用者中途插入訊息等待過久，`functions.wait` 與後續外層 `functions.exec` 改採 60000 毫秒。內層空輪詢的 `write_stdin.yield_time_ms` 固定使用工具上限 300000 毫秒；它可能因取得輸出、程序完成或等待期結束而回傳，不假設 Monitor 必定在 300 秒內產生輸出。

## 設計

### 內層 `write_stdin`

空輪詢固定使用：

```text
WRITE_STDIN_WAIT_MS = 300000
```

這是目前 `write_stdin` 空輪詢的 schema 上限。Monitor 的 `stall` 可能是 600 或 900 秒，因此單次 300 秒等待不保證取得 Monitor 輸出；等待期結束但 Monitor session 仍在執行時，下一次仍沿用同一個 `session_id`。

### 首次外層等待

首次外層 `functions.exec` 等待 120000 毫秒，內層 `write_stdin` 則等待 300000 毫秒：

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 20000}
const result = await tools.write_stdin({
  session_id: MONITOR_SESSION_ID,
  chars: "",
  yield_time_ms: 300000,
  max_output_tokens: 20000,
});
text(result.output);
```

### 外層 cell 的後續等待

若外層 `functions.exec` 回傳 `Script running with cell ID ...`，後續以 `functions.wait` 接續同一個 JavaScript cell，每次最多等待 60000 毫秒：

```javascript
functions.wait({
  cell_id: CELL_ID,
  yield_time_ms: 60000,
});
```

cell 仍在執行時重複相同等待，讓 Dispatch 最多每 60 秒重新取得控制權。`functions.wait` 只能接續外層 `cell_id`，不能用 Monitor 的 exec `session_id` 呼叫，也不能取代一般 Monitor 輪詢。

### Monitor exec session 的後續輪詢

若 JavaScript cell 已完成，但 `write_stdin` 回傳 Monitor exec session 仍在執行，新一輪外層 `functions.exec` 等待 60000 毫秒，內層 `write_stdin` 仍等待 300000 毫秒：

```javascript
// @exec: {"yield_time_ms": 60000, "max_output_tokens": 20000}
const result = await tools.write_stdin({
  session_id: MONITOR_SESSION_ID,
  chars: "",
  yield_time_ms: 300000,
  max_output_tokens: 20000,
});
text(result.output);
```

後續輪詢沿用同一個 exec `session_id`，不得重啟 Monitor 或重設 phase 設定。

## 不變項目

- 不修改 Monitor shell script 的 `POLL`、`STALL`、`DRIFT_CHECK` 或完成判定。
- 不因單次等待結束而重啟 Monitor。
- 不重設已解析的 phase 設定。
- 不混用外層 `cell_id` 與 Monitor exec `session_id`。
- 不把 600／900 秒的 phase stall 直接當成工具 `yield_time_ms`。
- Claude Code Dispatch 的 persistent Monitor 契約不在本次變更範圍。

## 驗收清單（QA）

### Q1：首次等待不再每 10 秒喚醒 Codex

**A：** Codex Monitor 首次等待範例的外層 `functions.exec` 明確使用 120000 毫秒，內層空輪詢的 `write_stdin` 使用 300000 毫秒；contract test 同時檢查兩者。

### Q2：等待結束不重啟 Monitor

**A：** 文件明確要求沿用同一個 exec `session_id`，並由 contract test 保護「不得重啟 Monitor」契約。

### Q3：正確區分工具限制

**A：** 文件記錄 `write_stdin` 空輪詢上限 300000 毫秒、非空寫入上限 30000 毫秒，以及 `functions.exec` 接受 300000 但最大值未文件化，避免誤稱兩者具有相同的已知硬上限。

### Q4：後續等待維持 60 秒互動節奏

**A：** 外層 cell 的後續 `functions.wait` 與重新輪詢 Monitor 時的外層 `functions.exec` 都使用 60000 毫秒；內層 `write_stdin` 維持 300000 毫秒。規格同時說明 60 秒是互動性目標，不是工具硬限制。

### Q5：Monitor 語意無回歸

**A：** 執行 `exec-client-test.sh`、`monitor-session-test.sh`、`skill-contract-test.sh`、Bash syntax 與 ShellCheck；既有 Monitor 完成、停滯與程序生命週期測試全部通過。

### Q6：source 與 installed copies 一致

**A：** 使用 skill installer 同步後，以 `diff -qr` 比較 repo source 與 `~/.agents/skills/lat-dispatch`、`~/.claude/skills/lat-dispatch`，兩者皆須無差異。
