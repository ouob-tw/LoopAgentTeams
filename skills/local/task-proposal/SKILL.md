---
name: task-proposal
description: 使用者在對話中要你新增定期執行的自動化任務（每天、每週、每月、每 N 天自動做某件事），或 LAT 主控要登記事件任務（等程序結束、檔案、Log 文字或某個時間再接手）時使用：把任務送到 LAT 看板成為任務提案，使用者在看板以 passkey 核准後才建立；也用來查詢、等待、撤回自己的提案，以及主控為事件任務暫停並關閉自己。
---

# 任務提案

送出提案只是請求；任務要等使用者本人在看板以 passkey 核准才建立。使用者在對話裡說「好」不算核准。提案只能新增任務；要修改、暫停或刪除既有任務，請使用者到看板的「週期任務」或「事件任務」分頁操作。

指令在本技能資料夾內，以下寫作 `tp`：

```bash
uv run --no-project python <本技能資料夾>/scripts/task-proposal.py
```

## 流程

1. 依下方欄位寫好任務 JSON；Agent 任務另寫說明檔。
2. **送出前**在對話裡列出完整內容：名稱、排程與時間、時間上限、種類；指令任務的指令、資料夾與固定檢查；Agent 任務的 client、模型、強度、資料夾、說明檔全文與回報方式；檢查官設定；無人模式授權。使用者要改就改好再給一次。
3. `tp submit task.json`，記下提案編號，告訴使用者到看板核准（24 小時內沒處理會過期）。
4. 提案有結果時看板會用 HCOM 通知你。通知只送一次、可能沒到（撤回不通知），結果以 `tp status <編號>` 為準。不必開著等；需要接著做事時用 `tp wait <編號> --timeout 100`（秒數要比你執行指令工具的時限短）。

事件任務照同一流程；第 2 步改列事件與細節、期限、一次性或可重複、接手方式（`new-agent` 另列 Agent 欄位與說明檔全文）。

撤回：使用者改主意時 `tp withdraw <編號>`。只能撤回你自己這個 Agent 程序送出、還在等的提案。

## 欄位

和看板「新增任務」表單相同。時間一律是台灣時間（Asia/Taipei）。工作資料夾 `folder` 用完整路徑或 `~` 開頭；固定檢查的 `path` 寫完整路徑或相對於 `folder`，不能用 `~`。

```json
{
  "name": "每週依賴檢查",
  "schedule": { "type": "weekly", "fromWeekday": 1, "toWeekday": 3 },
  "time": "09:00",
  "limitMinutes": 30,
  "kind": "agent",
  "agent": { "client": "claude", "model": "claude-sonnet-5-5", "effort": "medium", "folder": "~/project", "brief": "automation/deps.md" },
  "review": { "enabled": true, "checklist": ["報告列出每個過期套件與版本"], "client": "codex", "model": "gpt-6.1-sol", "effort": "medium" }
}
```

- `name`：最多 80 字。`limitMinutes`：1–1440。
- `schedule` 三選一；每期成功一次後不再跑：
  - `{"type":"daily"}`；每 N 天加 `"everyDays": N`（1–365），N ≥ 2 時要 `"startDate": "YYYY-MM-DD"`。
  - `{"type":"weekly","fromWeekday":1,"toWeekday":7}`（1 是星期一，不能跨過星期日）。
  - `{"type":"monthly","fromDay":1,"toDay":5}`。
- `kind: "command"`：`"command": {"command": "…", "folder": "…", "checks": [{"type":"file","path":"…"}, {"type":"output","text":"…"}]}`。指令以 `bash -c` 執行，結束碼 0 且檢查全過才算成功。
- `kind: "agent"`：`client` 是 `claude` 或 `codex`；`effort` 是 `low`、`medium`、`high`；`brief` 是說明檔（相對於 `folder`、完整路徑或 `~` 開頭）；`report` 可填 `oral`（預設）或 `demo`（發布成網頁）。
- `agent.unattended`：只有使用者明確要求無人模式時才加。`{"goal":"…","done":["…"],"scope":{"ticket_confirmation":false,"assume_defaults":false,"prototype_decide":false}}`；每一項開啟都是放寬授權，照使用者的話填。
- `review`：不給就是不檢查（看板表單對 Agent 任務預設開，建議明確填寫）。`enabled: true` 時 `checklist` 至少一條；`client` 建議和任務不同家。

## 事件任務

只收 LAT 主控的提案。何時用、選哪種接手方式與關掉自己前後要做什麼，見 LAT 技能的停住監控說明。接回原主控的完整提案：

```json
{
  "name": "Log 收完後分析",
  "trigger": "event",
  "event": { "type": "log", "path": "/home/me/project/collect.log", "text": "collection finished", "caseSensitive": true },
  "deadlineMinutes": 2880,
  "repeat": false,
  "handoff": "resume"
}
```

- `event` 四選一：
  - `{"type":"process","pid":1234}`：程序結束；送出時程序要還在。看板拿不到結束碼。
  - `{"type":"file","path":"/完整路徑"}`：檔案出現或更新。
  - 上例的 `log`：出現含 `text`（一行，最多 500 字）的完整新行；`caseSensitive` 預設 `true`。
  - `{"type":"time","at":"2026-11-29T09:00"}`：台灣時間，要在核准之後、期限之內。
- `file` 與 `log` 只算**核准之後**的更新與新行，核准前就寫好的不會觸發：可能很快完成的工作，等核准後再啟動，或改等它的程序。
- `deadlineMinutes`：從核准起算，1–10080，預設 1440；到期沒事件也會接手。
- `repeat`：預設 `false`；只有 `file`、`log` 能設 `true`。
- `handoff` 必填。`resume`（接回原主控）只填上例這些欄位。`new-agent`（開新 Agent）另填 `"kind": "agent"`、`agent`、`limitMinutes` 與說明檔，不填 `schedule`、`time`，不能開 `unattended` 與 `review`。

`resume` 任務核准後，註冊它的主控執行 `tp away <任務編號或提案編號>`：看板標成事件等待，幾秒後關閉你，所以它是最後一個動作。被拒時照印出的原因處理，保持開著。`away` 沒收到回應時（印出的文字講的是送出提案）也保持開著，再執行一次 `away`，重做是安全的。

## 說明檔

排程時由一個沒有這段對話的新 Agent 讀它照做，所以要自足：

- 寫明目標、步驟、怎樣算做完、可以與不可以動的範圍、結果放哪裡。
- 提到的檔案寫完整路徑：核准後任務讀看板另存的副本，位置和原檔不同。
- 結尾回覆格式（DONE／FAILED／ASK）看板會自己交代，不用寫。
- UTF-8，最多 256 KB。送出當下的全文就是使用者核准的版本；之後改原檔不影響，要改內容就撤回再重送。

## 結果與下一步

看輸出開頭的字（`--json` 放在子指令前可取得結構化輸出）。

| 輸出 | 意思與做法 |
| --- | --- |
| 已送出／等待中／仍在等待 | 還沒決定。不要重送同一份。 |
| 核准中 | 使用者已核准，任務建立中；稍後再查。 |
| 已核准 | 把任務編號告訴使用者，在看板「週期任務」或「事件任務」分頁看。 |
| 核准失敗 | 沒有建立任務。照原因修正，給使用者看過後重送。 |
| 已拒絕 | 把原因告訴使用者；使用者要改才改完重送。 |
| 已過期 | 問使用者還要不要，要才重送。 |
| 無效 | 照列出的欄位修正後重送，使用者看不到這一筆。內容有實質改動時先給使用者看。 |
| 已撤回 | 結束。 |
| 找不到這個提案 | 核對編號；結束滿 7 天的提案會清掉，到看板對應的任務分頁確認任務在不在。 |
| 看板沒在執行 | 沒有送出也沒有撤回。告訴使用者，看板啟動後再執行一次。 |
| 看板沒有回應 | 送出：可能已收下，請使用者看看板上有沒有這筆，再決定要不要重送。撤回：用 `tp status <編號>` 確認。 |
| 提案格式不對／提案不是 JSON／讀不到提案／提案太大 | 沒有送出。照訊息修正再送。 |
| 撤回被拒（不是你提的、已經有結果） | 用 `tp status <編號>` 看現況，告訴使用者。 |
| 事件任務只收 LAT 主控的提案 | 沒有送出。告訴使用者；不要改身分重送。 |
| 看板沒能寫下這個提案 | 回報使用者，不要反覆重送。 |
| 拒收 | 看板查不到或不認可送出的 Agent。把原因告訴使用者。 |

## 禁止

不要建立、修改或刪除看板狀態資料夾裡的任何檔案（任務提案資料夾、`automation/` 任務檔），也不要改環境變數冒充別的 Agent 或繞過看板。提案送不出去時回報使用者。
