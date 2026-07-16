## plan_writer_1 Monitor 假警報事件分析

### 背景

plan_writer_1 以 `codex-exec` 啟動（model: `gpt-5.6-sol`, effort: high），任務是讀取 approved spec 和專案原始碼後撰寫完整實作計劃。

### 時間線

| 時間          | 事件                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| 11:24:12      | codex-exec 啟動，JSONL 建立                                                                           |
| 11:24 ~ 11:34 | 模型讀取原始碼、撰寫及檢查計劃檔，JSONL 持續更新                                                     |
| 11:34:17      | **Monitor #1 被終止** — `timeout_ms=600000`（10 分鐘）到期；codex-exec 不受影響並繼續執行             |
| 11:34:46      | Monitor #2 啟動前的最後一筆 JSONL 事件                                                               |
| 11:34:48      | **Monitor #2 啟動**，錯誤設定為 `--stall 60`                                                         |
| 11:35:48      | **Monitor #2 報 STALL** — JSONL 超過 60 秒沒有修改，腳本判定停滯並退出                                |
| 11:35:54      | JSONL 寫入下一筆事件；距離上一筆約 68 秒，之後持續更新                                               |
| 11:40:47      | 同一 turn 寫入 `final_answer` 與 `task_complete`                                                      |
| 11:40:47      | codex-exec 正常結束，計劃檔案完整寫入                                                                 |

### 根因（兩個獨立問題）

**問題 1：Monitor 工具 `timeout_ms` 不夠長**

Monitor #1 設定 `timeout_ms=600000`（10 分鐘），但 plan_writer_1 實際執行了約 990 秒（16.5 分鐘）。Monitor 工具在 10 分鐘時強制 kill 監控進程，此時 codex-exec 還在正常工作。

**問題 2：Monitor #2 的 `--stall` 違反當時已解析的 skill 設定**

skill 的 `config.yaml` 明確定義 review 階段 `stall: 300`：

```yaml
monitor:
  review:
    stall: 300
    drift: 1800
```

Dispatch 重新 arm 時自行選了 `--stall 60`。Monitor #2 啟動前後的相鄰 JSONL 事件實際相隔約 68 秒，因此 60 秒門檻在下一筆事件出現前約 6 秒觸發，造成假 STALL。若沿用當時已解析的 `stall: 300`，本次事件不會被判定為 STALL。事故後的正式設計另將 review 預設提高為 600 秒；這是安全餘裕決策，不是本次事故直接觀察到超過 5 分鐘靜默。

### 實際 JSONL 事件間隔

codex CLI 的 JSONL 只會在產生 reasoning、tool call、message、token count 等事件時寫入；事件之間沒有新資料時，檔案修改時間不會改變。

這個 plan_writer session 的 229 行 JSONL 中，最大相鄰事件間隔為約 231 秒（11:30:23 至 11:34:14），不是 6 分鐘。Monitor #2 所涵蓋的關鍵間隔則約為 68 秒（11:34:46 至 11:35:54）。因此，本事件能證明 `--stall 60` 過短並違反既有設定，但不能證明 GPTSOL 在這次執行中出現超過 5 分鐘的 JSONL 靜默期。

### 為什麼沒有影響產出

Monitor 和 codex-exec 是**獨立進程**，沒有父子關係。Monitor 只是一個唯讀觀察者（輪詢 `stat` + `jq` 讀取 JSONL），被 kill 不影響 codex-exec。codex-exec 繼續跑到自然結束，計劃檔案完整正確。

### 正確做法

```
Monitor(
  command: "monitor-session.sh codex --agent-id ... --stall 600 --drift 1800",
  timeout_ms: 3600000,
  persistent: true
)
```

同一 client turn 重新 arm 時必須原樣重用已解析的 `stall`、`drift` 與 `poll`，不得臨時縮短。`COMPLETED`、`INCOMPLETE`、`STALL` 由 bundled script 結束 Monitor；`DRIFT_CHECK` 不另開重複 Monitor。單一 STALL 只觸發診斷，不自動 kill client。

完整事故證據、PID 捕捉方式與 QA 見 `docs/superpowers/specs/2026-07-16-lat-monitor-stall-process-control-design.md`。


## human review
skills漏寫 claude self monitor timeout 值
GPT SOL 可能出現超過 5 分鐘的推理靜默期，應調高 review 階段的 `stall` to 10min；本次事件本身沒有觀察到超過 5 分鐘的相鄰 JSONL 事件間隔
