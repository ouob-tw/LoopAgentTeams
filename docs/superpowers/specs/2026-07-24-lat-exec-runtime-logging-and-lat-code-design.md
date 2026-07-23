# LAT exec runtime log 與 lat-code 命名設計

日期：2026-07-24

## 背景

LAT 的外部 exec client 目前以 CLI 原始 Session JSONL 判定 turn 是否完成並提取 Final Answer。這個來源適合統一 Codex／Claude 的 exec 與 TUI 完成契約，但不保證保存 CLI 執行期間出現在標準輸出或標準錯誤中的 transient error。

`codex-exec` 現行啟動方式會將 client 的 FD1 與 FD2 導向 `/dev/null`。當 Session JSONL 已出現完成事件卻沒有 Final Answer，Dispatch 只能得到 `INCOMPLETE`，無法取得已遺失的錯誤訊息。TUI 可從 session 畫面診斷；exec 缺少等價的 runtime 診斷來源。

此外，現有 `lat-runner` skill 實際只承接 dispatch 後的 code phase 實作任務，但名稱容易與 `run-exec-client.sh` 這類程序 wrapper 混淆。本設計同時將該 skill 改名為 `lat-code`，使角色名稱與 `code_executor` phase 一致。

## 目標

- 為 Codex 與 Claude 的外部 exec client 保存可跨 Dispatch Session 使用的 runtime stdout 與 stderr。
- FD1 與 FD2 分檔保存，保留原始通道身分。
- 由 LAT capture 層為每一行加入 UTC capture time，不依賴 client 是否提供 timestamp。
- Session JSONL 繼續作為完成判定與 Final Answer 的唯一來源。
- runtime log 只作為異常診斷來源，不取代 task ledger 或 Session Monitor。
- 限制 Dispatch 讀取範圍，避免把完整 sub-agent runtime 載入主 Agent context。
- 將 `lat-runner` skill 改名為 `lat-code`，但維持既有 `code_executor_<instance>_<task_id>` identity。

## 非目標

- 不改變 TUI client 的 zmx 畫面與 Session JSONL 監控方式。
- 不將 runtime stdout 或 stderr 直接混入 Dispatch shell。
- 不以 runtime stdout 中的 Final Answer 判定 turn 完成。
- 不統一 Codex 與 Claude 的原生 stdout event schema。
- 不保證 FD1 與 FD2 之間的絕對事件先後；capture time 只表示 LAT 收到該行的時間。
- 不改變 executor 的 ledger 欄位、狀態轉換與 results-first reconciliation。
- 不回頭修改已標示為歷史文件的舊 Spec 或 Plan。

## 名詞

| 名稱 | 定義 |
| --- | --- |
| `lat-code` | 執行 code phase 已核准 task 的 Agent skill，取代 `lat-runner` |
| exec launcher | `run-exec-client.sh` Bash wrapper，負責啟動外部 exec client、保存 PID、等待退出及擷取 runtime |
| exec client | `codex exec` 或 `claude --print` 程序 |
| Session Monitor | `monitor-session.sh`，讀取 CLI 原始 Session JSONL 判定 turn 完成 |

有效文件不得再單獨以「runner」稱呼 exec launcher，避免與 Agent skill 混淆。

## Runtime 檔案配置

PID 與 runtime logs 使用不同生命週期：

```text
.lat/workspace/<TASK_ID>/runtime/
└── <agent_id>.pid

.lat/logs/<TASK_ID>/
├── <agent_id>.stdout.jsonl
└── <agent_id>.stderr.log
```

- PID file 沿用現有行為：只包含實際 client PID，client 結束後由 exec launcher 使用 `trash-put` 清除。
- runtime logs 在 client 結束後保留，預設由 `logs.retention_days` 控制保存天數。
- `clean` 只能清除超過保存期限且對應 exec 已不在執行的 runtime logs。
- `purge <TASK_ID>` 應一併以 `trash-put` 移除該 task 的 workspace 與 runtime log directory。
- 新 Agent Session 使用新的 `agent_id`，不得覆寫既有 runtime logs。
- Resume 同一 Agent Session 時 append 到原檔，並在兩個通道加入帶時間的 resume boundary。

## Runtime 輸出格式

### FD1：結構化 stdout

Codex exec 使用原生 JSONL 輸出：

```bash
codex exec --json ...
```

Claude exec 使用原生 stream JSON 輸出：

```bash
claude --print --output-format stream-json --verbose ...
```

LAT 不建立跨 client 的共同 event schema，只在原生 event 外增加 capture metadata：

```json
{"captured_at":"2026-07-24T09:42:18Z","stream":"stdout","event":{"type":"item.completed"}}
```

`captured_at` 使用 Dispatch host 產生的 RFC 3339 UTC 秒級時間。Codex 與 Claude 的原生事件內容保存在 `event`，避免新增欄位與 client 原生欄位碰撞。

### FD2：人類可讀 stderr

stderr 保持人類可讀文字，每一行只增加 UTC capture time 前綴：

```text
2026-07-24T09:42:19Z ERROR: request failed
```

LAT 不將 stderr 轉為 JSON，也不將 FD1 與 FD2 以 `2>&1` 合併。

### Boundary

每次初次 launch 或 resume 都在兩個檔案 append 一筆 LAT boundary，至少包含：

- `captured_at`
- `agent_id`
- `action`：`launch` 或 `resume`

stdout JSONL 使用固定 envelope：

```json
{"captured_at":"2026-07-24T09:42:18Z","stream":"meta","event":{"type":"lat.runtime_boundary","agent_id":"code_executor_1_example","action":"launch"}}
```

stderr 使用固定人類可讀 sentinel：

```text
2026-07-24T09:42:18Z LAT_RUNTIME_BOUNDARY agent_id=code_executor_1_example action=launch
```

Boundary 讓 Dispatch 只篩選本次 launch／resume 之後的 stdout events，也能辨識同一 transcript 的多次 exec 嘗試。

## 資料流與責任

```text
exec client FD1 ──▶ timestamp capture ──▶ stdout.jsonl
exec client FD2 ──▶ timestamp capture ──▶ stderr.log

CLI 原始 Session JSONL ──▶ monitor-session.sh ──▶ Dispatch lifecycle output
task/result ledger ─────────────────────────────▶ workflow status
```

exec launcher 負責：

- 建立 runtime log directory。
- 拒絕非 resume 情境下的同名 log 覆寫。
- 啟動 client 並保存精確 PID。
- 將 client FD1／FD2 分流至 timestamp capture。
- 等待 client 與 capture 完整結束。
- 傳遞 client exit status。
- 以 `trash-put` 清理 PID file。

exec launcher 的介面至少須接收：

- PID file path。
- stdout log path。
- stderr log path。
- `agent_id`。
- `action`：`launch` 或 `resume`。
- stdout format：Codex JSONL 或 Claude stream JSON。
- `--` 之後的原始 client command 與 arguments。

確切旗標拼法由實作計劃決定，但上述資料不得由檔名猜測，且 launch／resume 必須由呼叫端明確指定。

Session Monitor 繼續負責：

- 定位與讀取 CLI 原始 Session JSONL。
- 輸出 `COMPLETED`、`INCOMPLETE`、`STALL`、`DRIFT_CHECK`。
- 提取 Final Answer 交給 Dispatch。

Monitor 的 FD1／FD2 保留給 Dispatch；exec client 的 FD1／FD2 不再出現在 Dispatch shell。正常完成時，Dispatch 不讀取任何 runtime log。

## 異常診斷

啟動失敗、`INCOMPLETE` 或 `STALL` 時，Dispatch 依下列順序診斷：

1. 記錄事件種類、`agent_id`、PID 狀態與 runtime log 路徑。
2. 先讀 stderr 最後 7 行：

   ```bash
   tail -n 7 "$STDERR_LOG"
   ```

3. 若 7 行不足，再擴大為最後 20 行：

   ```bash
   tail -n 20 "$STDERR_LOG"
   ```

4. 20 行仍不足時，不規定固定下一個範圍；Dispatch 根據已看到的錯誤自行決定擴大 stderr、篩選 stdout 結構化事件，或驗證帳號、配額及程序狀態。
5. stdout 查詢只查看目前 launch／resume boundary 之後的事件，優先篩選 client 對應的 error／failed events；不得直接載入完整 stdout JSONL。
6. 若 runtime 指向帳號或配額問題，仍須以即時帳號狀態驗證，不得只憑歷史 log 判定目前狀態。
7. 仍無明確原因時，回報已查看的路徑、範圍、時間與現有證據；不猜測、不 kill、不變更 ledger。

Dispatch 不得無理由讀取完整 runtime log。這是目的導向限制，不禁止 Agent 在已有具體診斷理由時自行擴大範圍。

## lat-code 改名

現行有效結構：

```text
lat-runner/
├── SKILL.md
└── references/yaml-schema.md
```

目標結構：

```text
lat-code/
└── SKILL.md

lat-dispatch/references/
└── yaml-schema.md
```

修改範圍：

- skill directory 與 frontmatter name 由 `lat-runner` 改為 `lat-code`。
- 標題、description、觸發文字、Dispatch prompt 與 README 改用 `lat-code`／Code executor。
- shared YAML schema 移至 `lat-dispatch/references/yaml-schema.md`，因其同時定義 code、test、QA executor ledger。
- 所有目前有效的 schema 引用改指向新位置。
- `lat-dispatch/references/clients.md` 的 exec launcher 名詞、啟動與 resume 範例同步更新。
- `agent_id`、phase 名稱與 ledger 歷史不變。
- repo skill 與支援的 installed skill copies 必須同步。

`lat-code` 應保持單一明確責任：執行一筆已核准的 code phase task、寫入 result、再更新 task status 並退出。詳細共享 ledger schema 以 progressive disclosure 留在 `lat-dispatch/references/`，避免把所有 workflow 細節塞入 `SKILL.md`。

`lat-code` 不支援獨立安裝，必須與 `lat-dispatch` 一起安裝；其 compatibility 與 `SKILL.md` 應明確指出共享 schema 的 companion dependency。installed-copy 驗證必須同時檢查兩個 skills，避免留下無法解析的跨 skill reference。

## 錯誤與邊界處理

- runtime log directory 建立失敗：exec launcher 非零退出，不啟動 client。
- 新 launch 發現同名 log：拒絕覆寫並非零退出。
- stdout 出現無法解析的非 JSON 行：不得遺失該行；以明確的 unparsed event envelope 保存。
- timestamp capture 在 client 啟動前失敗：不得啟動 client，exec launcher 非零回報。
- 任一 capture 通道在 client 執行中意外失敗：這是已確認的致命診斷故障；exec launcher 對已保存的精確 client PID 送出一次 `SIGTERM`、等待 client 與另一 capture 通道結束，再以非零狀態回報。不得升級 `SIGKILL` 或以 `pgrep` 尋找替代程序。
- client 結束後須等待兩個 capture 通道完成寫入，避免尾端錯誤遺失。
- cleanup 不得清除仍有有效 PID 的 runtime logs；PID 遺失或格式錯誤時不得以 `pgrep` 猜測。
- Resume 必須沿用原始 model、effort、permission 與既有 Session JSONL `--after-line` 契約。

## 驗收清單（QA）

### Q1：exec 錯誤可跨 Session 診斷

**使用者行為：** 外部 exec client 在沒有 Final Answer 的情況下輸出 transient stderr 後結束，之後由另一個 Dispatch Session 接手診斷。

**預期：** 新 Dispatch Session 能從對應 `<agent_id>.stderr.log` 看到帶 UTC capture time 的原始錯誤，不依賴 CLI Session JSONL 是否保存該錯誤。

**測試／證據：** 整合測試以 disposable client 對 FD2 輸出辨識字串並退出；重新啟動獨立診斷程序，以 `tail -n 7` 讀到該字串與 timestamp。

### Q2：FD1 與 FD2 分離且不污染 Monitor

**使用者行為：** exec client 同時輸出 stdout runtime event 與 stderr error。

**預期：** stdout event 只存在 `.stdout.jsonl`，stderr error 只存在 `.stderr.log`；Dispatch shell 只收到 Monitor lifecycle envelope。

**測試／證據：** 整合測試分別對兩個 FD 寫入不同 sentinel，驗證檔案內容與 shell capture，並確認沒有交叉污染。

### Q3：每行具備 capture time

**使用者行為：** exec client 連續輸出多筆 stdout 與 stderr。

**預期：** 每筆 stdout envelope 與每行 stderr 都包含 RFC 3339 UTC 秒級 `captured_at`；不宣稱這是 client 原生事件時間。

**測試／證據：** 解析 stdout JSONL 並以格式檢查驗證 `captured_at`；以正規表示式驗證 stderr 每行時間前綴。

### Q4：正常完成不載入 runtime

**使用者行為：** exec client 正常產生 Final Answer 並完成。

**預期：** Monitor 從 Session JSONL 回傳 Final Answer，Dispatch 不讀取 stdout 或 stderr runtime logs。

**測試／證據：** contract test 與執行 trace 證明正常路徑只有 Session Monitor、Final Answer 與 ledger 驗證，不含 runtime log read。

### Q5：診斷採漸進式 stderr 範圍

**使用者行為：** exec client 發生 `INCOMPLETE`、`STALL` 或啟動失敗。

**預期：** Dispatch 先執行 `tail -n 7`；不足時才執行 `tail -n 20`。20 行仍不足時由 Agent 依證據決定下一步，不無理由讀取完整檔案。

**測試／證據：** contract test 檢查正式診斷流程；QA trace 分別覆蓋 7 行足夠與必須擴大到 20 行的情境。

### Q6：launch、resume 與 log 保存安全

**使用者行為：** 初次 launch、resume 同一 Agent Session，以及嘗試以新 launch 覆寫既有 agent logs。

**預期：** 初次 launch 建立新 log；resume append 並加入 boundary；非 resume 覆寫被拒絕。超過 retention 且不在執行的 log 可由 `clean` 使用 `trash-put` 清理。

**測試／證據：** 整合測試驗證 append、boundary、拒絕覆寫、PID 存活防護與 retention cleanup。

### Q7：exec launcher 生命週期無回歸

**使用者行為：** exec client 正常退出、非零退出或收到 TERM。

**預期：** exec launcher 保存精確 client PID、傳遞 client exit status、等待 capture 完成，且只清理自己的 PID file，不影響其他程序。

**測試／證據：** 擴充既有 `exec-client-test.sh`，覆蓋正常、非零、TERM、stdin forwarding、FD capture 與尾端輸出完整性。

### Q8：真實 Codex 與 Claude exec 保留 runtime

**使用者行為：** 分別以真實 Codex exec 與 Claude exec 執行一個最小任務。

**預期：** 兩者的 stdout 結構化 runtime、stderr、Session JSONL Final Answer 與 exit status 均可取得，且不互相取代。

**測試／證據：** 真實 smoke/E2E transcript 記錄啟動命令、兩個 log 的有限範圍、Monitor `COMPLETED` envelope 與 Final Answer。

### Q9：lat-code 名稱與責任一致

**使用者行為：** Dispatch 啟動 code phase executor。

**預期：** Agent 載入 `lat-code` skill，處理精確 `code_executor_<instance>_<task_id>` task，先寫 `results.yaml`、再更新 `tasks.yaml` 並退出；有效文件不再稱其為 `lat-runner`。

**測試／證據：** skill contract test、全 repo 有效引用掃描，以及一個真實 code task trace 驗證 ledger 順序與最終狀態。

### Q10：共享 schema 與 installed copies 一致

**使用者行為：** Dispatch、code、test 或 QA executor 讀取 ledger 契約，或使用者從任一支援宿主載入已安裝 skill。

**預期：** 所有角色引用 `lat-dispatch/references/yaml-schema.md`；repo 與支援的 installed copies 無差異，且不存在有效的舊 `lat-runner` skill copy。

**測試／證據：** schema reference contract test、skill validation、installed-copy `diff -qr` 與舊路徑檢查全部通過。
