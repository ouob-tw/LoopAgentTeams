# LAT exec client stdin 轉交修復規格

日期：2026-07-17

## 背景

`lat-dispatch` 透過 `scripts/run-exec-client.sh` 啟動 exec client、記錄實際 child PID 並等待程序結束。Codex exec 的標準呼叫方式則以 `- < "$PROMPT_PATH"` 從 stdin 傳入 prompt。

現有 runner 以 `"$@" &` 將 child 放到背景執行，但沒有替背景 child 明確保留 runner 的 stdin。非互動 Bash 因而讓 `codex exec -` 收到空輸入，立即回報 `No prompt provided via stdin.` 並以 exit code 1 結束。runner 的 EXIT trap 隨後清除 PID file，Codex 尚未建立原始 Session JSONL，Monitor 最後只能回報 `STALL: session file not found`。

同一組 `gpt-5.6-sol`、`read-only`、`xhigh` 參數直接執行 `codex exec` 可成功，證明問題位於 runner 與 child 的 stdin 邊界，而不是 model、帳號、permission 或 Codex CLI。

## 目標

1. runner 啟動背景 child 時，將自身 stdin 原樣轉交給 child。
2. prompt 內的 `$()`、反引號與引號只作為文字傳遞，不被 runner 執行或改寫。
3. 保留既有實際 child PID 記錄、exit status 傳遞、PID file 清理與拒絕覆寫行為。
4. 讓既有 `codex exec ... - < "$PROMPT_PATH"` 文件與呼叫方式可直接正常運作，不要求把 prompt 放進程序 argv。

## 設計

在 `run-exec-client.sh` 啟動 child 的命令加入明確 stdin redirection：

```bash
"$@" <&0 &
```

`<&0` 明確將 runner 的 file descriptor 0 交給背景 child，避免 Bash 在沒有顯式 stdin redirection 時將背景程序 stdin 指向空輸入。其餘 PID 與生命週期邏輯不變。

## 測試

在 `lat-dispatch/tests/exec-client-test.sh` 新增 regression test：

1. 以 pipe 將包含 `$()` 與反引號的可辨識 prompt 傳給 runner。
2. 測試 child 從 stdin 讀取內容並寫入暫存檔。
3. 逐字比對 child 收到的內容與原 prompt。
4. 確認 child 正常結束後 PID file 仍被清理。

修改前測試必須因 child 收不到 stdin 而失敗；修改後必須通過。完整驗證另包含既有 exec-client、monitor-session、skill-contract、Bash syntax 與 ShellCheck gates，以及使用真實 `codex exec -` 的 smoke test。

## 範圍

- 修改 `lat-dispatch/scripts/run-exec-client.sh`。
- 修改 `lat-dispatch/tests/exec-client-test.sh`。
- 同步已驗證的 `lat-dispatch` 到 supported installed skill copies。

## 不做

- 不改變 exec client 的 model、effort、permission 或 monitor 設定。
- 不把 prompt 改成 `"$(cat -- "$PROMPT_PATH")"` argv 參數。
- 不改變 PID file 格式、程序終止規則或 Session 完成契約。
- 不處理與 stdin 無關的 reviewer、Plan、ledger 或測試流程。

## 驗收清單（QA）

### Q1：stdin 完整轉交

**Q：** 使用 `run-exec-client.sh` 執行需從 stdin 讀取內容的 child 時，child 收到與 runner 輸入逐字一致的內容。

**A：** regression test 傳入含 `$()` 與反引號的文字並逐字比對 child capture；RED 為 `FAIL: runner did not forward stdin to the child unchanged`，GREEN 為 `PASS: exec-client`。

### Q2：Codex prompt 可正常啟動

**Q：** 使用既有 `codex exec ... -` 格式經 runner 啟動時，Codex 能收到 prompt、建立 session 並正常完成，而不是回報沒有 stdin prompt。

**A：** 真實 smoke test 要求 Codex 回覆 `OK`，驗證 exit code 0 且 runner 結束後 PID file 已清理。

### Q3：既有生命週期無回歸

**Q：** runner 仍記錄精確 child PID、傳遞正常與 TERM exit status、拒絕覆寫既有 PID file，且不影響 Monitor 與 skill contract。

**A：** 執行完整 `exec-client-test.sh`、`monitor-session-test.sh`、`skill-contract-test.sh`、`bash -n` 與 ShellCheck，全部須為 exit 0。

### Q4：source 與 installed copies 一致

**Q：** 使用者實際載入的 `lat-dispatch` 與 source repo 版本一致。

**A：** 透過 skill installer 同步後，以 `diff -qr` 比較 repo 與 `~/.agents/skills/lat-dispatch`、`~/.claude/skills/lat-dispatch`，兩者皆須無差異。
