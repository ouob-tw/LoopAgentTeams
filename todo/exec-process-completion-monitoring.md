# Exec 程序完成監控（待辦）

## 現況

目前 `lat-dispatch` 對 Codex／Claude 的 exec 與 TUI 採用同一種完成監控：直接讀取 CLI 原始 Session JSONL，確認最新 turn 已輸出 Final Answer 並結束。

Monitor 的 `COMPLETED` 只表示 turn 完成，不保證 exec OS 程序已 EOF／退出，也不驗證 exit code。

目前刻意不做：

- 不使用 `--output-format stream-json` 作為主要完成來源。
- 不重新導向 exec stdout 到獨立 JSONL 或 log。
- 不建立 `.exit`、`.done` 或 PID marker。
- 不讓 exec 與 TUI 使用不同的主要完成契約。

## 未來評估項目

若之後需要證明 exec 程序已成功停止，再設計原始 Session JSONL 之外的第二層程序監控：

1. 等待 exec 子程序 EOF。
2. 取得並驗證 exit code。
3. 評估 Claude `stream-json` result 是否只作為 exec 的附加證據。
4. 評估 Codex exec 的程序完成事件與 exit code 取得方式。
5. 保持原始 Session JSONL 為 exec／TUI 共用的 turn 完成來源。
6. 不得因加入程序監控而讓 Final Answer 提取來源在 exec／TUI 間分叉。

## 驗收條件

- 原始 Session JSONL 與程序狀態的責任清楚分離。
- exec 非零退出不會被誤報為成功停止。
- TUI 不要求程序退出，仍能依 turn 完成繼續 LAT 流程。
- 不遺留自訂 log、status marker 或暫存檔。
