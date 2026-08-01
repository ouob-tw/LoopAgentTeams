# 原生路徑

原生路徑由宿主 client 的工具直接執行，先 bootstrap before prompt delivery，再交付 prompt。

## 啟動與封存

1. Codex 使用 `spawn_agent`；Claude 使用 `Agent`。
2. 在 launch turn 內，將第一次回傳的 exact runtime handle 與 native owner 原子封存。封存前為 provisional 身分；封存完成後才是 sealed 身分。
3. Codex 使用 `wait_agent`；Claude 使用 foreground/blocking completion，等待選定任務完成。

回傳的 handle 必須對應已驗證的 target、workspace、model、effort 與 permission。

## 後續與續接

follow-up/resume 僅可提交給相同 native owner 的 exact runtime handle。這是 resume-only 規則：不建立替代任務、不以相似名稱重找，也不移轉 client。遇到 invalid/unsealed-handle refusal without replacement。

## 停止

原生停止固定分三階段：

1. `prepare-native-stop`
2. Codex `interrupt_agent(target=exact_handle)` 或 Claude `TaskStop(task_id=exact_handle)`
3. private confirmation JSON，接著 `finalize-native-stop`

Bash never invokes or simulates the host-native stop primitive。Shell 也不得用 signal、背景工作或輪詢模擬上述宿主操作。
