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
- temp paths：逐項列路徑；含機密者標記 `secret → shred -u`，不記錄機密內容
- done so far：
- next step：
- deliverable commit：待 Orchestrator 從 Git 查證後填入
```

agent 欄以 HCOM 名稱開頭，要加說明時接空白或半形／全形括號（如 `<名稱> (HCOM tag ...)`、`<名稱>（QA）`）；orchestrator 填派工主控的 HCOM 名稱。[停住監控](stall-watch.md) 靠這兩欄找出每位主控要盯的 Agent；缺少 agent、orchestrator、status 任一欄，或 agent 欄留空、名稱後接其他符號的卡片無法辨識，監控會跳過並記錄，該 Agent 因此不受監控。不適用的欄位填「無」，不可省略資源歸屬或虛構 commit。status 使用 `dispatched / in progress / committed / merged`；受阻原因及恢復條件寫在 next step。

## 更新與歸檔

- Orchestrator 派工時建立卡片並填好任務位置與資源分配。
- Agent 在開工、每個檢查點及結束時更新目前狀態、已完成工作與下一步，不累加敘事日誌。內建 Agent 無檔案存取能力時，由 Orchestrator 代寫。
- Orchestrator 從 Git 查證成果後填入 deliverable commit，確認整合後標記 merged。

## 任務收尾

每項任務合併至整合分支且整合後驗證通過後，由 Orchestrator 在關閉 Agent 的同一步驟完成以下清理，不等整批結束：

- 清理任務卡列明且屬於本任務的資源；普通暫存檔用 trash-cli，含機密者先用 `shred -u`，再移除所在 worktree。
- 以 `git worktree remove` 移除該任務的獨立 worktree，以 `git branch -d` 刪除任務分支；`-D` 僅限使用者明確確認放棄該分支。
- 將任務卡移至 `.lat/tasks/done/`；移走後停住監控不再盯該 Agent。

只有任務卡明列待完成後續工作時可暫留，例如 QA 保留 worktree 供複驗；後續工作完成後立即收尾。

[Spec 文件審查](spec-review.md#收尾) 沒有 commit，不適用上述合併門檻：使用者確認或放棄該 Spec 後，主控關閉審查者，deliverable commit 填「無（證據為 issue 留言）」，任務卡移至 `.lat/tasks/done/`。
