---
name: retro-log
description: "在 /retro 之後手動執行：把 retro 的每條反饋記進全域反饋庫，合併相同問題、判斷嚴重，列出可處理的前三名和一個推薦；並可查詢與改條目狀態。"
disable-model-invocation: true
---

# 把 retro 反饋記進反饋庫

反饋庫是所有專案共用的本機 git repo，由小程式管理。計數、狀態、復發、排序、去重與 git commit 都由小程式負責，你負責判斷「是不是同一個問題」「是否嚴重」，並撰寫條目內容。條目檔只透過小程式改動。

小程式：`uv run --no-project python <本次實際載入的本技能目錄絕對路徑>/scripts/retro-log.py <指令>`，下文簡寫為 `retro-log <指令>`。各指令參數見 `retro-log <指令> --help`。指令被拒時照訊息修正後重跑，下方 Gotchas 另有規定的除外。

## 記錄一次 retro

1. **找反饋來源**：預設讀本對話中最近一次 /retro 列出的每條改善建議。使用者指定其他 session（補匯入）時，讀那個 session 的紀錄（Claude：`~/.claude/projects/*/<session>.jsonl`；Codex：`~/.codex/sessions/**/rollout-*-<session>.jsonl`）中的 /retro 結果。找不到 /retro 結果就停下告訴使用者，不自行做 retro。
2. **定出出現紀錄的共用欄位**：
   - `--client`：`claude` 或 `codex`，看反饋來源的 session 是哪個 client。
   - `--session`：本對話用 `$CLAUDE_CODE_SESSION_ID`（Claude）或 `$CODEX_THREAD_ID`（Codex）；其他 session 用它的 session ID。
   - `--project`：該 session 工作的 git repo 名稱（主 worktree 的資料夾名，不是 `.worktrees/` 下的分支資料夾）。
   - `--time`：該 session 中觸發 /retro 那則使用者訊息的時間戳記；查不到時用該 session 最後一則紀錄的時間。本對話也照查，不用現在時間。
3. **逐條搜尋**：每條反饋用兩三組關鍵字（含同義詞、中英文說法）跑 `retro-log search <關鍵字…>`，再對看起來相關的候選跑 `retro-log show <編號>` 讀全文。搜尋只比對字面，措辭不同的同一問題要靠換關鍵字找。結果顯示「已併入 #N」時改看 #N。
4. **判斷相同、新開或拿不準**：
   - **相同**：根本原因相同，同一個修法能同時解決。用 `retro-log occur <編號> …`。
   - **新開**：沒有候選，或候選明顯是別的問題。用 `retro-log add …`。
   - **拿不準**：有候選但無法確定是同一問題。用 `retro-log add … --suspected <候選編號…>`。
   - 新開時用繁體中文寫：`--title` 一句話說問題；`--description` 發生了什麼、在哪裡；`--suggestion` retro 建議的做法。`--evidence` 一律寫一句這次 session 的具體證據。
5. **判斷嚴重**：符合以下任一項就是嚴重：錯誤成品被交付、資料或檔案損毀、耗費大量時間或額度。嚴重時寫一句理由，說明符合哪一項、依據這次的什麼事實。新開用 `add --severe <理由>`；記到既有條目且該條目目前不嚴重時，再跑 `retro-log severe <編號> --reason <理由> --time <同一個時間>`。不符合就不標。
6. **印出摘要**：全部寫完後跑 `retro-log list --status ready --limit 3`，依下方格式回覆使用者。新開、併入、拿不準三份清單依第 3–5 步各指令的輸出整理；小程式回「已存在」的條目列在併入，註明未加次數。

```markdown
**本次寫入**
- 新開：#12 標題；#13 標題
- 併入舊條目：#4 標題（現 2 個 session，轉可處理）
- 拿不準：#13 疑似 #7；確認相同可說「把 #13 併入 #7」

**可處理前三名**
1. #4 標題［嚴重］：一句話說明問題與影響
2. …
3. …

**推薦先做**：#4，一句理由。
```

某一類清單是空的就寫「無」。可處理不到三筆就列現有的。修問題不是本技能的工作；使用者挑中後照平常方式處理。

## 其他用法

使用者要求時才做，做完印出小程式的結果那一行。

| 使用者要的 | 指令 |
| --- | --- |
| 關鍵字查詢 | `search <關鍵字…>` |
| 依狀態列清單 | `list --status <狀態>`；有疑似標記的 `list --suspected`；已併入的 `list --merged` |
| 看單一條目 | `show <編號>` |
| 手動合併（確認拿不準的是同一問題） | `merge <被併的> <保留的>` |
| 確認拿不準的是不同問題 | `unsuspect <編號>` |
| 標已完成 | `done <編號> --commit <sha>` 或 `--file <路徑>`；補記過去的修好用 `--time <commit 提交時間>` |
| 標不做 | `wontfix <編號> --reason <理由>` |
| 手動設可處理 | `ready <編號>` |
| 改嚴重或取消嚴重 | `severe <編號> --reason <理由>`；取消用 `severe <編號> --unset` |
| 改既有處理紀錄的時間 | `retime <編號> --from <原時間> --to <新時間>` |

## Gotchas

- 照訊息跑 `retro-log restore` 時，把它列出的捨棄檔案告訴使用者。
- 合併因兩筆處理紀錄時間相同而被拒時，先後由使用者決定：把列出的衝突原樣交給使用者，問哪一筆在前、要改成什麼時間，照回答用 `retime` 改那一筆，再重跑同一個 `merge`；衝突的是「合併新增」那筆時，改成在 `merge` 加 `--time <新時間>` 重跑。不自行決定先後，也不另記一筆新紀錄代替改時間。
- 測試或試跑時設 `RETRO_BACKLOG_DIR` 指向暫存資料夾，避免寫進真正的反饋庫。
