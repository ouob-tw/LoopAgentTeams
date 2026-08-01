# 生命週期狀態

所有狀態只可位於 `$HOME/.agent-invoke`。registry 目錄為 `0700`，JSON 與同目錄暫存
檔為 `0600`。symlink、非本人 owner、無效 JSON、重複 operation ID 或既有 lock 一律
拒絕；不可推測 stale lock 或自動移除它。

## Bootstrap 與 seal

`bootstrap-launch <operation> <client> <workspace> <provisional-id> <mode>`
會原子寫入一筆 unsealed record。Claude 可在 unsealed record 保存預配置 UUID；Codex
一律以 null identity 開始。launch turn 回傳 authoritative identity 後，必須以同一個
turn/seal token 呼叫 `seal-session`。identity 未 seal 前不可 resume；既有 seal、rebind、
token 不符、partial write 或不確定性都維持原 record 並拒絕。

`begin-turn` 只接受 sealed identity、沒有 active turn、沒有 stop intent 的 record；
`complete-turn` 必須收到 exact active turn token。exec、ZMX 與 native owner 都同時核對
當前 turn 與其 exact owner token/handle。

## 停止與清理

外部 carrier 必須先核對 exact active turn 與 owner token。exec 另需 PID、start time、
executable 全部仍相符；TUI 必須是仍 live 的 exact tokenized ZMX handle。helper 只停止
該 verified carrier，確認其已不存在後，以一次 state replacement 清除 owner 與
active-turn 並記錄 `interrupted`。任何 carrier 檢查或停止不確定時均不改 state。

native stop 固定分三段：

1. `prepare-native-stop <operation> <turn-token> <native-handle> <owner-token>` 寫入
   private `prepared` intent，並回傳一個新的 exact stop token。
2. host 以 exact handle 直接呼叫 native stop tool；Bash helper 絕不呼叫或模擬此工具。
3. private `0600` confirmation JSON 只能記錄同一 turn、handle、owner、stop token 的
   confirmed `stopped`；`finalize-native-stop` 重新上鎖並同時核對所有欄位。

finalize 成功時以一次 state replacement 清除 matching intent、owner、active turn，
記錄 `interrupted`，所以 sealed record 可立即 clean。失敗、不確定或 token 不符時，
intent、owner、active-turn 必須 byte-for-byte 保持不變；不得以 shell signal 模擬 native
tool。

`clean-one <operation> --dry-run` 只列出 `recoverable-clean` sealed record。`--confirm`
會在同一個 lock 下重新核對該唯一 record，再以 `trash-put --` 移入垃圾桶。unsealed、
active、stop-intent、live/ambiguous owner、malformed 或 unsafe metadata 都只能手動處理；
沒有 age-based cleanup，也沒有不受限的 `clean --all`。
