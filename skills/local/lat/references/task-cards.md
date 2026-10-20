# 任務卡

每次派工前，由 Orchestrator 確認專案 `.gitignore` 包含 `.lat/`。任務卡是本機恢復狀態，不提交 Git；所有 worktree／Agents 使用同一個 `.lat/tasks/` 絕對路徑，派工時提供。

每張派工建立 `.lat/tasks/YYYY-MM-DD-<tag>.md`，日期為派發日期。外部 Agent 的 tag 使用 /hcom-spawn 規則下的 HCOM `--tag`；內建 Agent 由 Orchestrator 指派唯一任務 tag。同日同 tag 重派依序加 `-2`、`-3`，第一行註明接續的任務卡。

## 欄位模板

```markdown
接續：無（重派時填上一張任務卡路徑）

- agent：
- orchestrator：
- model：
- branch：
- worktree：
- base commit：
- status：dispatched
- owned resources：ports、containers、images、sandbox prefix
- live actions：無（有現場動作時寫額度，見「現場動作額度」）
- preflight：無（有現場動作時寫動手前的核對事項）
- 預計檢查數：無（派 QA 時寫預計的檢查數量級，如約 10 項）
- 整套測試：無（派實作與 QA 時必填：由誰、在什麼時點經閘門跑一次，如「實作者在該票審查都通過後的最終版本」「不跑，查實作者的閘門紀錄」）
- temp paths：逐項列路徑；含機密者標記 `secret → shred -u`，不記錄機密內容
- done so far：
- next step：
- deliverable commit：待 Orchestrator 從 Git 查證後填入
```

agent 欄以 HCOM 名稱開頭，要加說明時接空白或半形／全形括號（如 `<名稱> (HCOM tag ...)`、`<名稱>（QA）`）；orchestrator 填派工主控的 HCOM 名稱。[停住監控](stall-watch.md) 靠這兩欄找出每位主控要盯的 Agent；缺少 agent、orchestrator、status 任一欄，或 agent 欄留空、名稱後接其他符號的卡片無法辨識，監控會跳過並記錄，該 Agent 因此不受監控。不適用的欄位填「無」，不可省略資源歸屬或虛構 commit。status 使用 `dispatched / in progress / committed / merged`，沒有 commit 的 Spec 文件審查與參謀以 `completed` 結束；受阻原因及恢復條件寫在 next step。

## 現場動作額度

**現場動作**指會碰到真實外部系統或正在運作的環境的動作：對外部服務送請求、操作真實帳號或瀏覽器、重新部署或重建正在使用的服務、對外傳送訊息。只在自己的 sandbox、測試替身或本機單元測試內的動作不算。

`live actions` 與 `preflight` 兩欄必填，各寫在同一行，由主控派工時填好，並把同樣內容寫進第一則任務訊息：

- `live actions`：沒有現場動作填「無」。有現場動作時寫明額度，不適用的項目寫「不適用」：
  - 可重新部署／重建的次數上限
  - 可送出的請求或頁面數上限
  - 可傳送的訊息或操作次數上限
  - 時間上限
  - 明確的停止條件
- `preflight`：`live actions` 為「無」時填「無」。否則寫明動手前已核對的事項；尚未核對完成的項目寫明由誰在動手前核對：
  - 登入身分與帳號
  - 請求量與頻率
  - 被限流或風控的風險
  - 時間相依
  - 復原方式

範例：

```markdown
- live actions：重建 staging 最多 2 次；對外請求最多 60 個；傳送訊息不適用；最長 45 分鐘；出現登入頁、429 或連續 3 次相同錯誤即停
- preflight：測試帳號 qa-01 已登入（主控已核對）；每次輪詢 1 個請求、間隔 10 秒以上；限流門檻每分鐘 30 個；結果與整點排程無關；重建失敗時切回上一個映像（執行 Agent 動手前核對映像仍在）
```

額度不擴大授權：主控只能在使用者已確認的 Spec 或 issue 驗收條件之內訂額度。花錢、動帳號或額度、刪資料、對外發布等原本就要問使用者的事，寫進額度也仍要先問。

執行 Agent 依這兩欄行動：

- 動手前逐項核對 `preflight`；有任何一項不成立就先回報主控，不動手。
- 額度內的現場動作自己做，不逐步請主控核准。
- 只在下列情況回報主控：
  1. 即將超過或已超過任一額度。
  2. 觸發停止條件。
  3. 出現登入、真人驗證或風控等風險訊號。
  4. 遇到規格外的決定。
  5. 得到最終結果。
- 額度用完但目標未達成時停手回報，不自行加碼；由主控決定是否在既有授權內再給一份額度。

任一欄缺少或留空時，[停住監控](stall-watch.md#任務卡必填欄位檢查) 會通知主控補上；該 Agent 仍照常受監控。監控只檢查有沒有填，不判斷額度內容，也不計算用量。

## 更新與歸檔

- Orchestrator 派工時建立卡片並填好任務位置、資源分配、`live actions` 與 `preflight`。
- Agent 在開工、每個檢查點及結束時更新目前狀態、已完成工作與下一步，不累加敘事日誌。內建 Agent 無檔案存取能力時，由 Orchestrator 代寫。
- Orchestrator 從 Git 查證成果後填入 deliverable commit，確認整合後標記 merged。

## 任務收尾

每項任務合併至整合分支且整合後驗證通過後，由 Orchestrator 在關閉 Agent 的同一步驟完成以下清理，不等整批結束：

- 清理任務卡列明且屬於本任務的資源；普通暫存檔用 trash-cli，含機密者先用 `shred -u`，再移除所在 worktree。
- 以 `git worktree remove` 移除該任務的獨立 worktree，以 `git branch -d` 刪除任務分支；`-D` 僅限使用者明確確認放棄該分支。
- **先**將任務卡移至 `.lat/tasks/done/`，**再**關閉 Agent；移走後停住監控不再盯該 Agent。卡片仍在而 Agent 消失會被視為意外消失並通知主控。

只有任務卡明列待完成後續工作時可暫留，例如 QA 保留 worktree 供複驗；後續工作完成後立即收尾。

[Spec 文件審查](spec-review.md#收尾) 沒有 commit，不適用上述合併門檻：使用者確認或放棄該 Spec 後，主控先將 status 改為 `completed`、deliverable commit 填「無（證據為 issue 留言）」並把任務卡移至 `.lat/tasks/done/`，再關閉審查者。

參謀沒有 commit：階段交界、任務交付或取消時，主控將 status 改為 `completed`、deliverable commit 填「無（參謀無提交）」，先移卡至 `.lat/tasks/done/`，再關閉 Agent。
