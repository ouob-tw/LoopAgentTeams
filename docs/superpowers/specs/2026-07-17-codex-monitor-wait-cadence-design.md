# Codex Monitor 等待節奏修正規格

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

使用者已明確接受超過 60 秒才取得一次狀態的互動取捨，並決定 Codex Dispatch 的偏好單次等待值改為 120000 毫秒。LAT skill 因此採用 120 秒；60 秒指引仍保留在本規格作為決策背景，但不作為本功能的有效等待上限。

## 設計

### 等待值

Codex Dispatch 每次等待使用：

```text
WAIT_MS = min(stall_ms, 120000, tool_max_yield_ms)
```

- `stall_ms`：目前 phase 的 Monitor 停滯門檻。
- `120000`：本次確認的 Codex Dispatch 偏好等待值。
- `tool_max_yield_ms`：目前呼叫模式的工具 schema 上限。

一般 review 與 code phase 的 `stall` 分別為 600 秒與 900 秒，而 `write_stdin` 使用空輪詢，所以上述兩種情況的 `WAIT_MS` 都是 120000 毫秒。

### 外層與內層同步

每次 Codex Monitor 等待，外層 `functions.exec` pragma 與內層 `write_stdin.yield_time_ms` 必須使用相同的 `WAIT_MS`：

```javascript
// @exec: {"yield_time_ms": 120000, "max_output_tokens": 20000}
const result = await tools.write_stdin({
  session_id: MONITOR_SESSION_ID,
  chars: "",
  yield_time_ms: 120000,
  max_output_tokens: 20000,
});
text(result.output);
```

若 120 秒後 Monitor 仍在執行，下一次呼叫沿用同一個 exec `session_id`。若外層仍因平台限制提早回傳 `Script running with cell ID ...`，才以 `functions.wait` 接續該 cell。

## 不變項目

- 不修改 Monitor shell script 的 `POLL`、`STALL`、`DRIFT_CHECK` 或完成判定。
- 不因單次等待結束而重啟 Monitor。
- 不重設已解析的 phase 設定。
- 不混用外層 `cell_id` 與 Monitor exec `session_id`。
- 不把 600／900 秒的 phase stall 直接當成工具 `yield_time_ms`。
- Claude Code Dispatch 的 persistent Monitor 契約不在本次變更範圍。

## 驗收清單（QA）

### Q1：不再每 10 秒喚醒 Codex

**A：** Codex Monitor 範例的外層 `functions.exec` 與內層 `write_stdin` 都明確使用 120000 毫秒；contract test 同時檢查兩者。

### Q2：等待結束不重啟 Monitor

**A：** 文件明確要求沿用同一個 exec `session_id`，並由 contract test 保護「不得重啟 Monitor」契約。

### Q3：正確區分工具限制

**A：** 文件記錄 `write_stdin` 空輪詢上限 300000 毫秒、非空寫入上限 30000 毫秒，以及 `functions.exec` 接受 300000 但最大值未文件化，避免誤稱兩者具有相同的已知硬上限。

### Q4：保留 60 秒指引的真實定位

**A：** 規格明確記錄 60 秒是互動性行為指引、不是工具硬限制；同時記錄使用者已接受取捨並選擇 120 秒。

### Q5：Monitor 語意無回歸

**A：** 執行 `exec-client-test.sh`、`monitor-session-test.sh`、`skill-contract-test.sh`、Bash syntax 與 ShellCheck；既有 Monitor 完成、停滯與程序生命週期測試全部通過。

### Q6：source 與 installed copies 一致

**A：** 使用 skill installer 同步後，以 `diff -qr` 比較 repo source 與 `~/.agents/skills/lat-dispatch`、`~/.claude/skills/lat-dispatch`，兩者皆須無差異。
