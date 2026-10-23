# 清理指令

`.lat` 的舊資料只經這個指令、在使用者確認後刪除。分兩步：先「列出」，主控把清單交給使用者，真人答覆後才「執行」。敏感判定與硬限制寫在 `scripts/_lat_cleanup.py`，[自動清理](#自動清理) 也用同一份規則。

## 列出

```bash
uv run --no-project python "$lat_dir/scripts/lat-clean.py" list --workspace "$workspace" \
  --repo <tracker repo，OWNER/NAME> --output "$workspace/.lat/runs/misc-<YYYY-MM-DD>-cleanup/list.json"
```

只讀，不改任何檔案。掃描主工作區共用的 `.lat`，以及各 worktree（含 `.worktrees/*`）內多出的 `.lat`；經由符號連結才到得了的 `.lat` 略過。每項列出編號、類別、路徑、大小、最後修改時間、刪除方式（trash／shred 與原因）、連到的票與說明；最後印出清單檔路徑與清單雜湊。

| 類別 | 範圍 |
|---|---|
| 根目錄舊問題檔 | 根目錄 `questions-<名稱>.md` 與其 `-archive.md`；該檔仍有待答題時不列 |
| 空問題檔 | 沒有任何題目的根目錄問題檔與 `questions/<名稱>.md` |
| 舊版檔案 | `questions.md`、`demo-questions.md` |
| 孤立鎖檔 | 根目錄、`questions/`、`watch/waits/` 中目標檔已不存在，或目標檔也在本清單中的 `.<名稱>.lock` |
| 主控進度檔 | `progress/` 中某筆 session 紀錄的 `progress_path` |
| 已關閉票的資料／無票號的舊資料 | `runs/`、`progress/`、`evidence/`、`prototypes/`、`handoffs/` 的每個子項目，依名稱中的票號分類 |
| 研究或原型資料夾 | `runs/misc-*` |
| worktree 內多出的 `.lat` | 整個資料夾；內含硬限制路徑時改為逐項列出其他子項目 |
| 監控殘留 | 非 active session 的 `watch/<session-id>.log`／`.lock`／`.pid`（監控程序仍在時不列 pid），沒有 active session 的 `watch/<名稱>/`；說明欄寫結束時間或「無結束時間」 |
| 等待紀錄 | `watch/waits/<Agent>.json` |
| 輸入備份 | `watch/prompt-*.txt` |
| 已完成任務卡 | `tasks/done/*.md` |

- **連到的票**：以 `gh issue list` 讀 tracker 所有票的內文與留言，找出提到 `.lat/<路徑>` 的票並標開啟／關閉；查不到寫「未查到」。查詢失敗時每項寫「查詢失敗：原因」，清單照常產生。
- **票號**：取名稱中的 `issue-N` 與兩位數以上的數字；日期與 commit 雜湊不算，tracker 沒有的號碼不算。
- **不列入**：硬限制（含開啟中的票連到的路徑）、仍有待答題的問題檔，以及 tracker 查詢失敗時名稱帶票號的項目（票狀態無法確認）。未列入的項目與原因寫在清單檔的 `excluded`。

## 交給使用者

主控以待決題（依 SKILL.md「使用者待決事項」，參謀行 `needs-human`）把清單交給使用者：附清單檔路徑與雜湊、總大小，項目多時依類別摘要並附完整表格。寫明刪除後 tracker 上指向這些路徑的連結立即失效，shred 的項目救不回。使用者可全部同意、只同意部分編號或都不刪。只有真人答覆才算同意，參謀不能代答；沒有答覆前不執行。

## 執行

```bash
uv run --no-project python "$lat_dir/scripts/lat-clean.py" execute --workspace "$workspace" \
  --list <清單檔> --hash <清單雜湊> --only <使用者同意的編號，如 1,3,5-7>
```

- 只接受「列出」產生、雜湊相符、屬於同一工作區的清單檔；不符時整份拒絕，什麼都不刪。
- `--only` 填使用者同意的編號；使用者同意整份清單時才省略。
- 逐項重新核對，不符的跳過並在結果表寫原因：硬限制、active session 仍需要、開啟中的票（重新讀 tracker；讀不到時整份清單都跳過）、已不存在、列出後被改動（項目內任一檔案的增刪、大小或修改時間不同）、已不符合清單類別。鎖檔最後處理，目標檔仍在時跳過。
- 敏感項目先以 `shred -f -u` 逐檔銷毀（唯讀的檔案與目錄也會銷毀乾淨），剩下的空目錄再用 `trash-put`；其他項目用 `trash-put`。敏感項目內有任何檔案另有硬連結時（shred 會毀掉另一份，丟垃圾桶又留下內容），該項失敗、不動任何檔案。
- 印出每項結果與統計；有失敗時以非零結束。把結果回報使用者。

## 敏感判定

項目內任一處符合即整項 shred：`password.json`、`auth.json`、`*.sqlite*`、`.credentials*`、任何 `.lat` 的 `watch/prompt-*.txt`，以及隔離 client 家目錄（資料夾內有 `auth.json`、`.credentials.json` 或 `sessions/`）。

## 硬限制

下列路徑永不刪除，即使出現在清單中：

- 共用 `.lat` 與任何 worktree `.lat` 的 `decisions/`、`sessions/`、`panel-journal.jsonl`，以及包含它們的資料夾。
- 目標檔仍存在的 `.lock`。
- active session 依賴的檔案：進度檔、待決目錄、任務卡目錄與其頂層任務卡（`done/` 不在內）、該主控的問題檔與歸檔檔及其鎖、`watch/<session-id>.*`、`watch/<名稱>/`，以及該主控與其頂層任務卡 Agent 的等待紀錄。
- 開啟中票的資料：任何 `.lat` 的 `runs/`、`progress/`、`evidence/`、`prototypes/`、`handoffs/` 中名稱帶該票號的項目，以及含有這類項目的資料夾；開啟中的票內文或留言提到的路徑、其中的檔案與所在的票資料夾。
- 有任何 session 紀錄讀不出來時，整次不刪。

## 自動清理

預設關閉。一次性清理執行完、使用者確認的項目都刪除後，寫入開啟標記 `.lat/autoclean-enabled.json`（記下開啟時間與 tracker repo）：

```bash
uv run --no-project python "$lat_dir/scripts/lat-autoclean.py" enable --workspace "$workspace" \
  --repo <tracker repo，OWNER/NAME>
```

- **觸發**：主控 `activate` 成功與 `deactivate` 後自動觸發，在背景執行，不等待、也不讓 activate／deactivate 失敗（無法啟動時只印「自動清理未啟動」）。未開啟時只在 `.lat/cleanup.log` 記一行「未開啟」，不刪任何東西。開啟後同一工作區 24 小時最多執行一次（上次時間記在 `.lat/cleanup.last-run`）；24 小時內或另一次仍在執行時，只記跳過原因。
- **只清四類**（只看共用 `.lat`；每次重新讀 session 紀錄與 tracker）：

| 類別 | 條件 |
|---|---|
| 票資料夾 `runs/issue-<N>/` | tracker 上該票為關閉，且最近一次關閉時間（`closedAt`）滿 40 天；不看檔案時間。票開啟中、已重開、tracker 查不到時不清 |
| 監控殘留 `watch/<session-id>.log`／`.lock` | 該 session 紀錄已結束且 `ended_at_utc` 滿 40 天 |
| 監控殘留 `watch/<名稱>/` | 該名稱沒有 active session，同名每筆紀錄都有結束時間，且最近一筆滿 40 天 |
| 已完成任務卡 `tasks/done/*.md` | 卡片檔本身最後修改滿 40 天 |
| 等待紀錄 `watch/waits/<Agent>.json` 與其鎖檔 `.<Agent>.lock` | 各自的最後修改滿 40 天，且該 Agent 不是 active 主控或其頂層任務卡的 Agent；鎖檔在等待紀錄仍存在時不刪 |

- 沒有結束時間的舊 session（含 `completed`／`cancelled`）、沒有 session 紀錄的監控檔、`runs/misc-*`、`progress/`、根目錄舊問題檔與其他舊資料不自動清，由上方清理指令列給使用者。
- 每項刪除前重新讀取 session 紀錄，經上方 [硬限制](#硬限制) 核對（執行中才 activate 的主控也受保護），刪除方式依 [敏感判定](#敏感判定)。`gh` 查詢失敗或標記沒有 repo 時只跳過票資料夾這一類，其他三類照清。
- **紀錄**：`.lat/cleanup.log` 一行一筆，以 tab 分隔：時間（UTC）、類別、相對 `.lat` 的路徑、大小（bytes）、刪除方式（`trash`／`shred`）或「跳過：原因」。四類中每個未刪的項目都寫原因（例如未滿 40 天、票仍開啟、active session 仍需要）。
- **預覽**：`run --workspace "$workspace" --repo <repo> --dry-run` 印出一次執行會刪什麼，未開啟時也能用；不刪、不寫紀錄。
- **關閉**：以 trash-put 移除開啟標記即可。


## Paused orchestrators and retained services

`lat-reap.py` reads the [shared pause records](stall-watch.md#paused-hcom-communication)
when evaluating service keeps. A paused full HCOM name counts as a present orchestrator,
including when another orchestrator's watcher triggers periodic reaping. Its unexpired
keeps remain valid. Explicit release and expiration still take precedence; removing
the pause record restores the ordinary absent-orchestrator rule on the next reap.
