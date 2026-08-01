# 外部完成證據

`monitor-session.sh` 接受 operation、exact active-turn token、exact exec owner
token 與 owned regular transcript。它 join sealed session-ref、carrier-only owner、
turn-specific active-turn 與 immutable metadata；caller transcript 必須等於 sealed path。

Claude 完成需要 sealed session ID、選定 model，以及最新相符的 user-to-assistant
`end_turn` 結果。Codex 完成需要 sealed `session_meta` ID 與 workspace、sealed 的
owned transcript、baseline 後同一 turn 的 matching model、`phase=final_answer` 的
`response_item`，以及同一 turn 的 `task_complete` 或 `turn_complete`。monitor 會先
印出唯一的 Final Answer，才以 exact token 呼叫 `complete-turn`。缺少或衝突的證據
返回 exit 70 並保留 active turn。

## 已安裝 E2E 的證據綁定

已安裝 runner 不會把 host 的文字回覆、單一 tool 名稱、requested model 或不相關的
successful event 當作完成證據。外部路由必須有一筆同時匹配 immutable metadata、sealed
session-ref、owner token 與 active-turn token 的 completion，並以 metadata 的非空 model
做一致性檢查；completion 未提供 model 時不補造欄位。native 路由另需同一 tool-use/result
ID 的 exact start handle、authoritative child actual-model，及同一 handle/turn completion。

refusal、lifecycle、prune 分別只接受結構化 refusal 與無 carrier/state delta、成功/失敗
finalize 的 tree invariants、以及一筆 `recoverable-clean` dry-run 後只刪除該 operation 的
manifest。任一 validator 缺少資料或失敗時，runner 只會輸出 unverified，絕不發布 PASS。
每次 runner invocation 另以隨機 provenance nonce 建立新的 private validator artifact
directory，manifest 記錄 case、nonce、檔名與 SHA-256；既存 directory 或 manifest/內容被改寫
均拒絕。runner 只在一般 `--source/--case/--evidence` 流程完成參數、隔離、auth、安裝與
package preflight 後建立 nonce，並在 host 執行前後複製 exact `runs/<operation>/` tree；不提供
跳過上述流程的 provenance harness。directory digest 遞迴綁定每個相對 path、type、mode、
owner 與 regular-file content SHA-256，任何層級的 symlink 或其他特殊檔案都拒絕。

host 啟動前 runner 先確認 private checkpoint observer 已就緒。observer 只在 exact sealed
operation 同時具有 owner 與 active-turn 時複製 pre-completion tree；completion/model validator
以此 tree 綁定 operation、session、owner 與 turn，host 結束後的另一份 tree 則必須證明
active-turn 已移除，exec owner 亦已移除，而 native/TUI persistent owner 不得被改寫。fixture
不得以完成後仍殘留 exec owner/active-turn 的假狀態代替這個前後邊界。

lifecycle 只接受 structured fact 指定的 success/failure operation，並分別綁定 finalize 前、
finalize 後、clean 後與 failed-finalize tree；prune 只接受 structured dry-run 中唯一的
`recoverable-clean` ID，且該 ID 必須存在於 confirm 前 checkpoint、在 final tree 消失，其他
operation 完全相同。refusal 的 before/after envelope 固定包含 agent state、Codex sessions、
Claude projects、ZMX、case-scoped process 與 workspace `.lat` 六份 digest manifest；process
manifest 不保存 argv、environment 或輸出，只保存 case-root process identity 的非秘密 digest。

validator 只讀取該次 nonce manifest 明列且 digest 相符的 copied artifacts；額外、重複或
未列入 manifest 的 artifact 都拒絕。這個 envelope 不保留 raw client output，只封存已選取的
結構化事實；任一路由缺少所需 facts 時維持 unverified。
