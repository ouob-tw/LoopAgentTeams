---
name: hcom-spawn
description: "召喚其他 client 的 Agent 透過 HCOM 協作時使用：叫一個 Codex 或 Claude 查資料、實作或互相審查，涵蓋模型與 effort 預設、啟動參數與核對、任務交代格式、存活與額度處理、以 tag 收尾。"
---

# 透過 HCOM 召喚 Agent

你是**召喚者**：選模型、啟動、交代任務、追蹤存活、向使用者回報、收尾。被召喚的 Agent 彼此直接溝通，你不逐句轉達。

需要獨立 worktree、多人同時改同一批檔案，或要完整的討論→Spec→Tickets→QA 流程時，改呼叫 /lat。

## 選模型與 effort

使用者指定的模型與 effort 優先。使用者只說「Codex」或「Claude」時，用該 client 的預設模型。未指定時：前端任務用 Claude，簡單的用 `claude-sonnet-5-5`、複雜的用 `claude-opus-5-5`；後端任務用 Codex（`gpt-6.1-sol`，簡單複雜都從 `medium` 起）；其他或混合任務依任務內容選。

| 模型 | 起始 effort |
| --- | --- |
| `gpt-6.1-sol`（後端預設） | `medium` |
| `gpt-6-astra` | 簡單任務 `low`、複雜任務 `medium` |
| `gpt-5.6-sol`、`claude-opus-5-5`、`claude-sonnet-5-5`、其他 | `medium` |

**簡單任務**：查資料、讀文件或程式碼回答問題、跑指令收集結果、單一檔案小修改、照明確指示改文字。
**複雜任務**：跨檔案實作、除錯、設計、審查、需自行權衡方案。

上表是常用預設，不是白名單。使用者指定表外模型時，先用工具查該 client 的可用模型，必要時查官方文件，確認正確 ID、可用性與支援的 effort。能唯一對應就用；有歧義或無法使用才詢問，不擅自換模型。表外模型從 `medium` 起；不支援時用已查證的可用級別並說明。

啟動時明確傳入模型 ID 與 effort，不依賴隱含預設。前後端分工只看任務，不因為目前 client 的內建 Agent 做不到就改分工。

### 用自己 client 的內建 Agent 時

模型與 effort 照上面同一套規則，用 client 支援的欄位傳入。權限受宿主限制，把 CLI 參數寫進 prompt 不等於生效。內建機制套不上必要設定時，改用支援的 HCOM 外部 Agent；仍不可用就回報使用者。

## 啟動

tag 用 `<自身名稱>-<主題>`，主題一兩個英文小寫單字（`review`、`docs`、`api-probe`）。HCOM 會把 Agent 名稱變成 `<tag>-xxxx`，所以同一位召喚者開的每組都認得出來，也能用 `@<tag>-` 一次傳給整組。

```bash
hcom 1 codex --tag <自身名稱>-<主題> --go --name <自身名稱> \
  --model gpt-6.1-sol -c 'model_reasoning_effort="medium"' --yolo
```

```bash
hcom 1 claude --tag <自身名稱>-<主題> --go --name <自身名稱> \
  --model claude-opus-5-5 --effort medium --dangerously-skip-permissions
```

Codex 預設加 `--yolo`，Claude 預設加 `--dangerously-skip-permissions`，讓被召喚的 Agent 不會停在確認畫面卡住協作。`--yolo` 同時關掉確認與 sandbox。這些啟動參數不擴大任務授權範圍，任務邊界寫在第一則訊息裡。

使用者指定 HERDR workspace 時，先 `herdr workspace list` 查目標 ID，再 `HERDR_WORKSPACE_ID=<目標ID> hcom 1 <client> --terminal herdr ...`。未指定就照常執行，Agent 會開在呼叫端所在的 workspace。

### 啟動後核對

啟動輸出的 `Names:` 只印 base name，完整名稱是 `<tag>-<base>`，用 `hcom list --name <自身名稱>` 取。Claude 有時超過 10 秒的就緒等待而回報 `Still launching`，那不是失敗，重查 `hcom list` 即可。

`hcom term <名稱> --name <自身名稱>` 看畫面核對三項：

| Client | 模型與 effort | 權限 |
| --- | --- | --- |
| Codex | 底部狀態列 `<模型名> <effort>`（如 `GPT-6.1-Sol medium`） | 開場 `permissions: YOLO mode` |
| Claude Code | 開場 `Opus 5.5 with <effort> effort`、底部 `Opus 5.5 <effort>` | 底部 `⏵⏵ bypass permissions on` |

Claude 列的模型名與 effort 是傳 `claude-opus-5-5` 加 `medium` 時的樣子。畫面要對得上你實際傳的那一組，不是表上寫的值。

`hcom list --json` 的 `tag`、`directory`、`tool` 欄位核對 tag 與工作目錄。從回傳或畫面確認不到的設定，回報時標為未確認，不宣稱已生效。

## 第一則任務訊息

訊息含 backtick、換行或程式碼時用 `--file`，純文字用 `--`：

```bash
hcom send @<agent> --intent request --name <自身名稱> --file <訊息檔路徑>
```

固定欄位，缺一項被召喚的 Agent 就得猜：

```markdown
目標：<要達成什麼，含判斷完成的依據>
範圍與不能碰的地方：<可以改哪些檔案／目錄；哪些不准動>
工作目錄：<絕對路徑>
其他 Agent 與分工：<名稱> 負責 <什麼>；需要對方的東西直接找對方，不經我轉達
完成時回報：成果位置、測試結果、未完成事項
回報對象：<自身名稱>
溝通語言：Agent 之間的所有溝通（hcom 訊息、交接、回報）一律使用英文

回報方式：`hcom send @<自身名稱> --name <你的名稱>`。忘記語法就跑 `hcom <指令> --help`，不要猜。
沒有人看你的對話視窗，不需要在視窗輸出說明，所有回報都用 `hcom send`。
```

## 回報與收尾

工作期間不向使用者公告 Agent 的開啟或關閉，由召喚者自己記錄名稱、session ID、client／model／effort 與工作目錄，使用者要找回時據此接回。任務收尾（含取消或移交）的最後一次回報，只列仍開著的 Agent 與保留原因；全部關閉就不提。使用者詢問時依當下狀態回答。只有兩種情況立即告知：使用者直接要求開啟 Agent，回覆是否開啟成功；使用者需要與特定 Agent 互動，提供名稱及必要操作。回報前核對狀態：

```bash
hcom list --names --name <自身名稱>
```

Agent 確定用不到時，召喚者主動關閉，不必等使用者說「收掉」。以下全部成立才算用不到：

- 成果與必要驗證已保存、回報，且召喚者核對過符合任務；只有 Agent 自稱完成不算。
- 沒有待回的問題、排定的審查／修正／複測、交接中的相依工作或未完成的再委派。
- 沒有進行中的回合或指令；它擁有的程序與資源已清理或交給具名負責者。
- 成果位置清楚，未提交的修改已交代位置與歸屬。
- 使用者沒要求留著它，且是自己召喚的 Agent。

閒置（listening）或單一則完成訊息不等於用不到；不設定時清理。卡住升級 effort 與額度換帳號的關閉／接回，依 troubleshooting 的恢復流程。只關 `<自身名稱>-` 開頭的 Agent，使用者自己開的或其他流程的一律保留。

關閉前記下名稱、session ID、client／model／effort、工作目錄與成果位置，關閉後核對已停止。關閉不代表可刪除它的 transcript、worktree 或成果。關閉結果不另外回報。

```bash
hcom kill <名稱> --name <自身名稱>                   # 關一個
hcom kill tag:<自身名稱>-<主題> --name <自身名稱>   # 整組都符合條件才用
```

接回會還原對話與工作目錄，但不會還原當時執行中的指令、HERDR 視窗排版或已刪除的 worktree；工作目錄已不存在時，接回前先指定有效目錄並核對。

### 接回已關閉的 Agent

`hcom r` 會自己重放原本的啟動參數，所以**不要重複傳 `--model` 或 `--yolo`**，重複會讓 Codex 啟動失敗。

需要 HCOM >= 0.7.27。明確指定已記錄的名稱或 session ID，不用 `--last`。一般接回沿用原模型、effort 與權限：

```bash
hcom r <名稱或session-ID> --go --name <自身名稱>
```

只有要改 effort（例如卡住升級）時，才在指令最後附上已選定的新 effort，模型與權限維持原值：

```bash
hcom r <名稱或session-ID> --go --name <自身名稱> -c 'model_reasoning_effort="<目標 effort>"'   # Codex
hcom r <名稱或session-ID> --go --name <自身名稱> --effort <目標 effort>                       # Claude
```

HCOM 0.7.27 / Codex CLI 0.159.3 實測：未附 effort 接回保留原 low，附上 high 後生效。Claude 的沿用原 effort 與附上 high 覆寫行為僅在 HCOM 0.7.26 / Claude Code 2.1.284 測過，未在 0.7.27 重測。這些結果限於已測版本，更新後重新核對。

接回後照「啟動後核對」看畫面，再核對 session ID、工作目錄與 transcript：Codex 看新一輪的 `turn_context`（model、effort、approval_policy、sandbox_policy），Claude 看新一輪的 `message.model`、`effort`／`perTurnEffort` 及使用者訊息的 `permissionMode`。確認目標 effort、原模型與權限，並讓 Agent 接續關閉前的對話；啟動參數或「啟動成功」本身不算驗證。無法確認的項目標為未確認。

## 替 Agent 按鍵

替 Agent 輸入文字、斜線指令或按鍵前，先讀 [按鍵程序](references/key-injection.md)。替 Agent 選選項等於替它做決定，任務訊息沒授權的選擇先問使用者。

## Gotchas

- 新啟動（`hcom N <client>`）和帶 client 參數的 `r`／`f` 預設只印 `LAUNCH PREVIEW`，不加 `--go` 什麼都不會發生。不帶參數的 `hcom r <名稱>` 和 `hcom kill` 直接執行，不需要 `--go`。
- 所有 hcom 指令都要帶 `--name <自身名稱>`，否則身分對不上。
- `--dir` 只設程序的工作目錄，不會選 HERDR workspace。
- Claude CLI 啟動時不驗證模型 ID，打錯的 ID 照樣啟動並顯示在畫面上。啟動成功不代表 ID 正確，表外模型一定要先查證。
- 不是每個模型都在畫面或 transcript 顯示 effort，實測 Haiku 4.5 就沒有顯示。
- 忘記語法先跑 `hcom <指令> --help`，不要猜參數。

## Agent 沉默、卡住或額度耗盡

Agent 久無回應、同一問題反覆失敗、疑似額度用完，或你自己的 HCOM 身分掉線時，讀 [references/troubleshooting.md](references/troubleshooting.md)。
