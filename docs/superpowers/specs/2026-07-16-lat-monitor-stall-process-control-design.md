# LAT Monitor STALL、Exec 程序控制與 Claude Monitor 生命週期設計

## 目標

修正 LAT Dispatch 在長時間 exec 任務中的監控假警報，讓 Dispatch 能在需要介入時安全識別並終止正確的 exec client，同時維持 Session JSONL 作為 turn 完成的唯一主要來源。

本設計處理四個問題：

1. exec client 啟動後如何保存可供後續診斷及終止的程序身分。
2. Monitor 回報 `STALL` 時，是否以及何時可以終止 exec 或 TUI client。
3. review 階段的 STALL 門檻是否應由 5 分鐘調高。
4. Claude Code Monitor 應使用一小時租期或持續到監控命令自行結束。

## 原始問題的直接答案

### Client 啟動與 Monitor 是否合併在同一個 shell

不將「是否同 shell」當作程序終止權限的依據：

- Claude exec 依 Claude Code 工具介面，以背景 client 與 Monitor 分開啟動。
- Claude／Codex TUI 以 detached zmx Session 啟動，必然與 Monitor 分離。
- Codex dispatch 可保留在同一個 `exec_command` 中啟動背景 exec 與 Monitor，但必須先捕捉 exec 的 PID；Monitor 結束不得連帶終止 client。

四種模式都遵守同一條規則：Monitor 是唯讀觀察者，不擁有自動終止 client 的權限。

### 目前 TUI STALL 是否由 AI 決定要不要 kill

是。現行契約中，`STALL` 只結束 `monitor-session.sh`，不會執行 `zmx kill`。Dispatch 收到 STALL 後檢查 `zmx list`、最後畫面與錯誤證據，再決定重新監控、傳送訊息、kill 後 resume，或回報使用者。

本設計保留這項行為，並將相同原則明確套用到 exec client：單獨一個 STALL 不足以授權 kill。

### Review STALL 是否調高至 10 分鐘

同意。`spec_reviewer`、`plan_writer` 與 `plan_reviewer` 共用：

```yaml
monitor:
  review:
    stall: 600
    drift: 1800
```

不另外為 `plan_writer` 建立角色專用設定。使用者 prompt 仍可依既有優先序覆蓋此值。

### Claude Monitor 使用一小時或持續監控

使用 `persistent: true`，讓生命週期由 `monitor-session.sh` 的 `COMPLETED`、`INCOMPLETE`、`STALL` 終端事件控制。Claude Code Monitor 呼叫仍傳入 schema 所需的 `timeout_ms: 3600000`，但 persistent 模式不以一小時作為實際終止期限。

這裡的「持續」不是系統常駐 daemon；監控命令結束或 Claude session 結束時，Monitor 即停止。

## 事故明細

### 事故識別

- 日期：2026-07-16（Asia/Taipei）
- Agent ID：`plan_writer_1_2026-07-16-quick-switch-merge-and-pause-removal-design`
- Client：`codex-exec`
- Model：`gpt-5.6-sol`
- Effort：`high`
- 工作目錄：`/home/swy/agent_manager`
- Codex Session ID：`019f68f4-0c40-75f0-9962-42769810cdb5`
- Turn ID：`019f68f4-0ce9-7bc1-9ace-9acdfcfc1a3d`
- Codex JSONL：`/home/swy/.codex/sessions/2026/07/16/rollout-2026-07-16T11-24-12-019f68f4-0c40-75f0-9962-42769810cdb5.jsonl`
- Claude Dispatch transcript：`/home/swy/.claude/projects/-home-swy-agent-manager/b05e0056-3a38-4a2f-aa3a-0c92d14f490f.jsonl`

以 Monitor 相同的嚴格候選條件重新搜尋 2026-07-15 與 2026-07-16 的 Codex Session：只接受 user `input_text` 以完整 `[<agent_id>]` 開頭。結果只有上述一個 JSONL，排除後續分析對話僅引用 Agent ID 的假候選。

### 精確時間線

| 時間 | 事件與證據 |
|---|---|
| 11:24:11 | Claude Dispatch 以背景 Bash task `b4l5p9oq7` 啟動 codex-exec。 |
| 11:24:12 | Codex JSONL 建立。 |
| 11:24:14.683 | JSONL 寫入以完整 Agent ID 開頭的 user prompt，turn ID 為 `019f68f4-0ce9-7bc1-9ace-9acdfcfc1a3d`。 |
| 11:24:17 | Claude Monitor task `b5shbonh0` 啟動，參數為 `--stall 300 --drift 1800`、`timeout_ms: 600000`、`persistent: false`。 |
| 11:30:23.359–11:34:14.550 | 本 Session 最大相鄰 JSONL 事件間隔，約 231 秒。 |
| 11:34:17 | Monitor #1 達到外層 10 分鐘 timeout，被 Claude Monitor 工具終止；codex-exec 繼續執行。 |
| 11:34:46.657 | Monitor #2 啟動前最後一筆 JSONL 事件。 |
| 11:34:48 | Claude Monitor task `bsufar6us` 啟動，Dispatch 臨時改用 `--stall 60`、`timeout_ms: 120000`、`persistent: false`。 |
| 11:35:48 | Monitor #2 回報 `STALL: JSONL unchanged for 60s` 並以 exit 2 結束。 |
| 11:35:54.645 | JSONL 寫入下一筆事件；距離上一筆約 68 秒，只比錯誤門檻晚約 7 秒。 |
| 11:35:54–11:40:47 | JSONL 持續寫入 reasoning、tool call、patch、token count 與 commentary 等事件。 |
| 11:40:47.643 | 同一 turn 寫入 `response_item`、`phase: final_answer`。 |
| 11:40:47.659 | 同一 turn 寫入 `event_msg`、`type: task_complete`。 |
| 11:40:47 | codex-exec 正常結束，計劃檔完整寫入。 |

### 事故影響

- 兩個 Monitor 都提前結束，Dispatch 暫時失去自動完成通知。
- codex-exec 與 Monitor 是獨立程序，故計劃產出未中斷、未損壞。
- Dispatch 另外讀取輸出與檔案判斷狀態，增加了人工診斷與誤判風險。
- 若未保存 exec PID，Dispatch 在真正需要終止 client 時只能重新搜尋程序，可能選錯程序。

### 已證實根因

1. Skill 未規定 Claude Monitor 的 `timeout_ms`／persistent 契約，Dispatch 自行使用 10 分鐘 timeout；client 實際執行約 16.5 分鐘。
2. Monitor 重新掛載時未強制沿用已解析的 phase 設定，Dispatch 將 `stall` 從 300 秒縮成 60 秒。
3. `STALL` 只表示 Session JSONL 修改時間未變，不能區分正常純推理、client 異常或程序死亡。
4. exec 啟動流程沒有在啟動當下保存 PID，後續只能重新搜尋程序。

### 事故不支持的推論

本 Session 的最大相鄰 JSONL 事件間隔是約 231 秒，不是 6 分鐘；L214 後也仍持續寫入多種事件。因此這次事故能證明 60 秒門檻錯誤，不能單獨證明 GPTSOL 在本次執行中有超過 5 分鐘的靜默期。

review STALL 改為 600 秒屬於安全餘裕與未來長推理風險的設計決策，不偽裝成本次事故的直接觀測結果。

## 設計

### 1. Exec 程序身分紀錄

每個 exec client 啟動後、Monitor 啟動前，Dispatch 只捕捉 client PID。Agent ID、client 類型與 TASK_ID 已存在於 Dispatch 上下文及檔名，不重複寫入檔案。

PID 必須在啟動當下由 Bash `$!` 取得，不得事後用 `pgrep` 猜測：

```bash
cleanup_pid_file() {
  [ ! -e "$PID_FILE" ] || trash-put -- "$PID_FILE"
}
trap cleanup_pid_file EXIT

<exec-client-command> &
CLIENT_PID=$!
printf '%s\n' "$CLIENT_PID" > "$PID_FILE"
wait "$CLIENT_PID"
```

將唯一的十進位 PID 寫入該 TASK_ID 的暫存檔：

```text
.lat/workspace/<TASK_ID>/runtime/<agent_id>.pid
```

review 角色雖不寫 tasks/results ledger，仍使用 TASK_ID workspace 的 runtime 子目錄保存 PID。此檔不是完成證據，也不得改變 reviewer report-only 契約。

目前 Codex Node launcher 會把 SIGTERM 轉送給 native Codex 子程序；Claude CLI 的 PID 則直接指向主程序。因此第一版只保存並操作這一個 PID。

TUI 不建立 PID runtime 記錄；其控制 handle 維持 zmx session 名稱。

### 2. PID 終止

Dispatch 只有在使用者明確要求，或診斷已確認 client 無法繼續且需要 resume／清理時，才可終止 exec client。

終止前讀取 PID file，確認內容是正整數並以 `kill -0 "$CLIENT_PID"` 確認程序仍存在；任一步驟失敗就停止，不重新搜尋替代 PID。

確認需要介入後，只執行 `kill -TERM "$CLIENT_PID"`，再確認程序是否退出。第一版不自動升級為 SIGKILL；SIGTERM 無效時保留證據並回報使用者。

正常完成或 SIGTERM 結束後，由等待 client 的 launcher wrapper 以 `trash-put` 清除 PID file。若 Dispatch／Claude session 已中斷，既有 PID file 不得直接用於 kill，避免信任可能過期或重用的 PID。

### 3. STALL 決策契約

`monitor-session.sh` 保持唯讀，不加入 kill 行為。

收到 STALL 後：

1. 確認 client control handle：exec 使用已保存的 PID；TUI 使用 zmx session。
2. 檢查程序或 zmx session 是否仍存在。
3. 檢查 Session JSONL 最新事件、mtime 與 client 對應的診斷來源。
4. 若 client 存活且沒有確認錯誤，使用原始解析值重新掛載 Monitor，不 kill、不 resume。
5. 若確認可恢復錯誤，依 client 流程終止舊程序／zmx session，再以精確 Session ID resume。
6. 若證據不充分或終止驗證失敗，保留 client 與 ledger 原狀並回報使用者。

禁止因單一 STALL、自行縮短門檻、只看到輸出檔存在，或只看到 ledger 結果就終止 client。

### 4. Monitor 參數解析與重新掛載

每次 phase 開始時，依「使用者 prompt > `.lat/config.yaml` > 內建預設」解析一次 monitor 設定。至少保存：

- `stall`；
- `drift`；
- `poll`（若有覆蓋）；
- Claude Monitor 的 `persistent` 與 `timeout_ms` 固定呼叫值。

同一 client turn 的所有 re-arm 必須重用這組解析結果。除非使用者在新的 prompt 明確修改設定，Dispatch 不得自行縮短或延長任何值。

內建 review 預設為 `stall: 600`、`drift: 1800`。Code 與 test 階段維持現有值，本次不調整。

### 5. Claude Monitor 生命週期

Claude Code dispatch 統一使用：

```text
timeout_ms: 3600000
persistent: true
```

實際監控期限由 bundled script 控制：

- `COMPLETED`：turn 已有 Final Answer 與完成事件；Monitor 結束。
- `INCOMPLETE`：Codex turn 已結束但缺 Final Answer；Monitor 結束並進入診斷。
- `STALL`：超過 phase 門檻未更新；Monitor 結束並交由 Dispatch 裁決。
- `DRIFT_CHECK`：非終止通知；不得另開重複 Monitor。

因此 persistent 模式不會取消 STALL 防護，也不會讓監控成為跨 Claude session 的永久程序。

### 6. 完成來源與程序狀態邊界

Session JSONL 仍是四種 client 共用的 turn 完成來源：

- Claude：最新人類 prompt 後有 assistant text 且 `stop_reason: end_turn`。
- Codex：同一 turn 同時有 `phase: final_answer` 與 `task_complete`／`turn_complete`。

PID、zmx 存活與 exit code 只用於程序控制、診斷及清理，不得取代 Final Answer 完成契約。Monitor 回報 COMPLETED 後不主動 kill exec；Dispatch 讓程序自然退出，再由 launcher 清理 PID file。

## 錯誤處理

### PID 不存在

視為 client 已退出的診斷訊號，但仍須從 Session JSONL 判斷 turn 是否完成。不得以 Agent ID 子字串搜尋另一個 PID 後直接替代。

### TERM 後 client 仍存在

不自動改用 SIGKILL，也不擴大搜尋子程序；保存證據並回報使用者決定後續處理。

### Monitor STALL 但 client 仍在工作

不 kill。沿用相同 monitor 設定重新掛載，並記錄新的 JSONL 活動是否出現。

### Claude session 結束

persistent Monitor 隨 Claude session 結束；client 可能仍存在。後續恢復時從 Session JSONL 重新診斷，不直接使用前一個 Dispatch session 遺留的 PID file。

## 範圍

### 本次包含

- exec PID 捕捉、暫存、SIGTERM 終止與清理契約。
- TUI 與 exec 的 STALL 裁決規則。
- review STALL 預設改為 600 秒。
- Claude Monitor 改為 persistent 模式。
- re-arm 參數不可漂移的契約與測試。
- 事故文件與使用者操作文件同步。

### 本次不包含

- Monitor 自動 kill client。
- 將 PID 或 exit code 改為 turn 完成來源。
- 變更 Codex／Claude Session JSONL 完成解析器。
- 調整 code／test STALL 或 DRIFT 預設值。
- 修改 tasks/results ledger schema。
- 終止或接管本事故以外的既有程序。

## 驗收清單（QA）

驗證分成兩層：bundled shell 的可執行行為以 integration test 驗證；Dispatch 的裁決、工具 payload 與 re-arm 規則屬 AI skill 契約，以 prompt／reference contract test 驗證。本次不虛構一個不存在的常駐 Dispatch runtime 或 signal audit service。

### Q1：Exec 啟動後可精確找到其程序

**使用者行為：** 啟動任一 review exec agent，稍後要求 Dispatch 顯示或診斷該 agent 的程序。

**預期：** Dispatch 能從 `<agent_id>.pid` 取得啟動當下由 `$!` 捕捉的 PID；PID file 在 Monitor 啟動前已存在，且不依賴 `pgrep`。

**測試／證據：** `exec-client-test.sh` 啟動 disposable child，確認 PID file 只有正整數、等於 child 自報的 `$$`、`kill -0` 成功，並由 skill contract 確認 Monitor 前必須等待 PID file。

### Q2：健康 exec 遇到 STALL 不會被終止

**使用者行為：** exec agent 在超過測試用短門檻的時間內沒有寫入 JSONL，但程序仍存活且稍後繼續產生事件。

**預期：** Monitor 回報 STALL；Dispatch 診斷後保留 PID，不發 TERM/KILL，並以原設定重新監控。

**測試／證據：** `monitor-session-test.sh` 的「STALL 後 re-arm」案例保留 live sentinel，確認首次回報 STALL 後 sentinel 仍存活，再寫入完成事件並以相同參數 re-arm 取得 Final Answer。

### Q3：確認失敗後終止已記錄的 exec PID

**使用者行為：** 讓指定 exec agent 進入已確認、必須 resume 的失敗狀態。

**預期：** Dispatch 只對該 agent PID file 中的 PID 發送 SIGTERM；另一個同時執行的 sentinel agent 不受影響。

**測試／證據：** `exec-client-test.sh` 對 PID file 中的 child 發送 SIGTERM，確認 runner 回傳 143、PID file 清除且同時執行的 sentinel 仍存活；skill contract 禁止 SIGKILL／process-group 擴張。

### Q4：缺少或無效 PID 時不重新猜測

**使用者行為：** PID file 缺少、內容不是正整數，或 `kill -0` 顯示程序已不存在。

**預期：** Dispatch 拒絕發送 signal，且不使用 `pgrep` 尋找替代程序。

**測試／證據：** skill contract 檢查正整數、`kill -0`、缺檔／格式錯誤即停止及禁止 `pgrep` 的完整文字；本次沒有獨立 stop helper，因此不宣稱存在可注入的 termination API integration test。

### Q5：TUI STALL 維持由 Dispatch 裁決

**使用者行為：** Codex 或 Claude TUI 的 JSONL 超過測試門檻未更新，但 zmx session 仍存在。

**預期：** Monitor 只回報 STALL；Dispatch 先檢查 zmx 與最後畫面，不會自動 `zmx kill`。

**測試／證據：** Monitor integration test 證明 STALL 只回傳 exit 2；skill contract 檢查 TUI 仍以 zmx handle 診斷且單一 STALL 不授權 kill。`monitor-session.sh` 不呼叫 zmx。

### Q6：Review 初次監控與 re-arm 都使用 600 秒

**使用者行為：** 以內建設定啟動 spec reviewer、plan writer 或 plan reviewer，並讓 Monitor 重新掛載一次。

**預期：** 兩次呼叫皆使用 `--stall 600 --drift 1800`，不會變成 60 或 300 秒。

**測試／證據：** skill contract test 檢查 review config 為 600／1800、review wait 為 600000，以及同一 client turn 初次與 re-arm 必須原樣重用解析值。

### Q7：使用者覆蓋值在 re-arm 後仍保留

**使用者行為：** 在 prompt 或 `.lat/config.yaml` 指定不同 review STALL，之後觸發 re-arm。

**預期：** 依既有優先序選出單一值，re-arm 原樣重用；Dispatch 不自行修改。

**測試／證據：** skill contract 檢查既有「prompt > config > default」優先序與同一 turn 不得重新解析／改寫；LAT 沒有獨立 config parser binary，因此不宣稱存在 table-driven runtime parser test。

### Q8：Claude Monitor 不再於一小時自動到期

**使用者行為：** 由 Claude Code Dispatch 啟動任一 LAT Monitor。

**預期：** Monitor tool payload 為 `timeout_ms: 3600000`、`persistent: true`；實際結束原因來自 bundled script 或 Claude session 結束，不是固定一小時 timeout。

**測試／證據：** skill contract 檢查 Claude Dispatch 的固定 tool payload 與 bundled script 終端事件契約；Monitor integration suite 分別驗證 COMPLETED、INCOMPLETE、STALL。不以實際等待一小時作為驗收方式。

### Q9：DRIFT_CHECK 不建立重複 Monitor

**使用者行為：** 長時間工作中的 Monitor 回報 DRIFT_CHECK。

**預期：** 原 Monitor 繼續執行，Dispatch 做方向檢查但不 re-arm 第二個 Monitor。

**測試／證據：** `monitor-session-test.sh` 先讓同一個 Monitor 輸出 DRIFT_CHECK，稍後更新 JSONL，確認原 instance 繼續到 COMPLETED。

### Q10：完成後不誤殺 client 且會清理 PID file

**使用者行為：** exec agent 正常輸出 Final Answer、完成 turn 並自然退出。

**預期：** Dispatch 不因 COMPLETED 發送 kill；確認程序自然退出後由 launcher 以 `trash-put` 清除對應 PID file。

**測試／證據：** `exec-client-test.sh` 驗證正常 exit 7 原樣傳遞且 PID file 被 trash；Monitor suite 驗證完成事件；skill contract 明定 COMPLETED 不授權 kill。

### Q11：事故紀錄與原始證據一致

**使用者行為：** 依本 Spec 的 Agent ID、Session ID 與時間線重新查核事故。

**預期：** 嚴格候選搜尋只有一個目標 JSONL；最大事件間隔約 231 秒；Monitor #2 關鍵間隔約 68 秒；Final Answer 與 task_complete 屬於同一 turn。

**測試／證據：** read-only evidence script／命令輸出保存唯一候選數、top event gaps 及完成事件；禁止重新引入「L214 後靜默 6 分鐘」敘述。

### Q12：跨平台與既有契約沒有退化

**使用者行為：** 在 GNU/Linux 執行完整測試，並檢查 macOS/Bash 3.2 相容路徑。

**預期：** Monitor 既有 Codex／Claude 完成測試、Linux／BSD stat/date 模擬、shell syntax、skill loader 與 contract tests 全數通過；若未在真實 macOS 執行，報告必須明確標示為模擬證據。

**測試／證據：** 執行 `bash -n`、Monitor suite、skill contract suite、ShellCheck（若可用）、skill loader、`git diff --check`，並記錄真實與模擬驗證邊界。

## 成功條件

- 長時間健康推理不會因 Monitor 外層一小時租期或 re-arm 參數漂移而產生假警報。
- STALL 永遠是診斷觸發器，不是 kill 指令。
- 真正需要終止 exec 時，Dispatch 能對啟動當下保存的 PID 發送 SIGTERM，不重新猜測程序。
- TUI 維持 zmx 控制，不引入多餘 PID 追蹤。
- Session JSONL 完成契約、ledger 權威與 report-only reviewer 邊界保持不變。
