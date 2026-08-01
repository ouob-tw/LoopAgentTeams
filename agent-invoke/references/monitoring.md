# 外部完成證據

`monitor-session.sh` 接受 operation、exact active-turn token、exact exec owner
token 與 owned regular transcript。它會先驗證 sealed state 及 immutable settings
manifest。

Claude 完成需要 sealed session ID、選定 model，以及最新相符的 user-to-assistant
`end_turn` 結果。Codex 完成需要 sealed `session_meta` ID 與 workspace、sealed 的
owned transcript、baseline 後同一 turn 的 matching model、`phase=final_answer` 的
`response_item`，以及同一 turn 的 `task_complete` 或 `turn_complete`。monitor 會先
印出唯一的 Final Answer，才以 exact token 呼叫 `complete-turn`。缺少或衝突的證據
返回 exit 70 並保留 active turn。
