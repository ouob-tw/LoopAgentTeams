---
name: task-proposal
description: 使用者在對話中要你新增定期執行的自動化任務（每天、每週、每月、每 N 天自動做某件事）時使用：把任務送到 LAT 看板成為任務提案，使用者在看板以 passkey 核准後才建立；也用來查詢、等待或撤回自己送出的提案。
---

# 任務提案

送出提案只是請求；任務要等使用者本人在看板以 passkey 核准才建立。使用者在對話裡說「好」不算核准。提案只能新增任務；要修改、暫停或刪除既有任務，請使用者到看板的自動化分頁操作。

指令在本技能資料夾內，以下寫作 `tp`：

```bash
uv run --no-project python <本技能資料夾>/scripts/task-proposal.py
```

## 流程

1. 依下方欄位寫好任務 JSON；Agent 任務另寫說明檔。
2. **送出前**在對話裡列出完整內容：名稱、排程與時間、時間上限、種類；指令任務的指令、資料夾與固定檢查；Agent 任務的 client、模型、強度、資料夾、說明檔全文與回報方式；檢查官設定；無人模式授權。使用者要改就改好再給一次。
3. `tp submit task.json`，記下提案編號，告訴使用者到看板核准（24 小時內沒處理會過期）。
4. 提案有結果時看板會用 HCOM 通知你。通知只送一次、可能沒到（撤回不通知），結果以 `tp status <編號>` 為準。不必開著等；需要接著做事時用 `tp wait <編號> --timeout 100`（秒數要比你執行指令工具的時限短）。

撤回：使用者改主意時 `tp withdraw <編號>`。只能撤回你自己這個 Agent 程序送出、還在等的提案。

## 欄位

和看板「新增任務」表單相同。時間一律是台灣時間（Asia/Taipei）。路徑用完整路徑或 `~` 開頭。

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
- `kind: "agent"`：`client` 是 `claude` 或 `codex`；`effort` 是 `low`、`medium`、`high`；`brief` 是說明檔（相對於 `folder` 或完整路徑）；`report` 可填 `oral`（預設）或 `demo`（發布成網頁）。
- `agent.unattended`：只有使用者明確要求無人模式時才加。`{"goal":"…","done":["…"],"scope":{"ticket_confirmation":false,"assume_defaults":false,"prototype_decide":false}}`；每一項開啟都是放寬授權，照使用者的話填。
- `review`：不給就是不檢查（看板表單對 Agent 任務預設開，建議明確填寫）。`enabled: true` 時 `checklist` 至少一條；`client` 建議和任務不同家。

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
| 已核准 | 把任務編號告訴使用者，在看板自動化分頁看。 |
| 核准失敗 | 沒有建立任務。照原因修正，給使用者看過後重送。 |
| 已拒絕 | 把原因告訴使用者；使用者要改才改完重送。 |
| 已過期 | 問使用者還要不要，要才重送。 |
| 無效 | 照列出的欄位修正後重送，使用者看不到這一筆。內容有實質改動時先給使用者看。 |
| 已撤回 | 結束。 |
| 找不到這個提案 | 核對編號；結束滿 7 天的提案會清掉，到看板自動化分頁確認任務在不在。 |
| 看板沒在執行 | 沒有送出也沒有撤回。告訴使用者，看板啟動後再執行一次。 |
| 看板沒有回應 | 可能已收下。請使用者看看板上有沒有這筆，再決定要不要重送。 |
| 拒收 | 看板查不到或不認可送出的 Agent。把原因告訴使用者。 |

## 禁止

不要建立、修改或刪除看板狀態資料夾裡的任何檔案（任務提案資料夾、`automation/` 任務檔），也不要改環境變數冒充別的 Agent 或繞過看板。提案送不出去時回報使用者。
