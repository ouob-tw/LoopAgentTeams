# 任務卡

每次派工前，由 Orchestrator 確認專案 `.gitignore` 包含 `.lat/`。任務卡是本機恢復狀態，不提交 Git；所有 worktree／Agents 使用同一個 `.lat/tasks/` 絕對路徑，派工時提供。

每張派工建立 `.lat/tasks/YYYY-MM-DD-<tag>.md`，日期為派發日期。外部 Agent 的 tag 使用 HCOM `--tag`；內建 Agent 由 Orchestrator 指派唯一任務 tag。同日同 tag 重派依序加 `-2`、`-3`，第一行註明接續的任務卡。

## 欄位模板

```markdown
接續：無（重派時填上一張任務卡路徑）

- agent：
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

不適用的欄位填「無」，不可省略資源歸屬或虛構 commit。status 使用 `dispatched / in progress / committed / merged`；受阻原因及恢復條件寫在 next step。

## 更新與歸檔

- Orchestrator 派工時建立卡片並填好任務位置與資源分配。
- Agent 在開工、每個檢查點及結束時更新目前狀態、已完成工作與下一步，不累加敘事日誌。內建 Agent 無檔案存取能力時，由 Orchestrator 代寫。
- Orchestrator 從 Git 查證成果後填入 deliverable commit，確認整合後標記 merged。
- 合併及資源清理完成後，由 Orchestrator 移至 `.lat/tasks/done/`；仍有待交接資源時保留在原處並寫明歸屬。
- 清理僅限卡片列明且屬於本任務的資源；普通暫存檔使用 trash-cli，含機密的暫存檔使用 `shred -u`。
