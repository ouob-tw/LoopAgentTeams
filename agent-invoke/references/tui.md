# 外部 TUI

只有使用者明確指定互動式或持久 TUI 時，才可選擇此路由；不可由缺少 native
能力、exec 失敗或猜測的偏好自動降級。操作先以 `tui` mode bootstrap，並在第一個
authoritative session-start 後，以同一個 launch turn/seal token seal；Claude 必須確認
預配置 UUID，Codex 必須 seal 第一個 authoritative session identity。未 seal 前不得
resume。

ZMX wrapper 的唯一 handle 是 `ai-OPERATION_ID-TOKENPREFIX`。TOKENPREFIX 來自該
operation 的 private owner token；不可使用名稱前綴、最近 session 或任何模糊選擇。
先啟動一個 detached wrapper，再透過 `zmx send HANDLE` 的 stdin 傳送 prompt bytes，
最後另送一個 carriage return。prompt/message 檔必須位於 `/tmp` 下 private `mktemp -d`
目錄，成功送達或可證明未送達時立即 `shred`；不得 shell interpolation。

resume 先精確核對 sealed client、workspace、session、model、effort、permission 和
owner token。已存且 live 的 exact handle 直接重用；dead handle 只能以同一 sealed
client session 建立新 tokenized wrapper，然後更新 exact owner。idle wrapper 保留 owner
但沒有 active-turn token。stop 只允許 exact live ZMX handle，且只停止該 handle。
