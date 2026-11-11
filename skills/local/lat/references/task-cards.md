# 任務卡

派工前，Orchestrator 確認 `.gitignore` 包含 `.lat/`。任務卡是本機恢復狀態，不提交 Git；所有 worktree／Agents 共用同一個 `.lat/tasks/` 絕對路徑，派工時提供。

每張派工一張 `.lat/tasks/YYYY-MM-DD-<tag>.md`（派發日期；同日同 tag 重派加 `-2`、`-3`，第一行註明接續的卡）。外部 Agent 的 tag 用 /hcom-spawn 的 HCOM `--tag`；內建 Agent 由 Orchestrator 指派唯一任務 tag。

HCOM Agent 的卡用 `scripts/lat-dispatch.py card` 建（新 Agent 啟動前加 `--before-launch`，見 [Agent 設定](agents.md#派工)），禁止手寫。

## 欄位模板

```markdown
接續：無（重派時填上一張任務卡路徑）

- agent：
- orchestrator：
- native agent：是（僅內建 Agent 加這行）
- model：
- branch：
- worktree：
- base commit：
- status：dispatched
- ledger row：（選填；`card --ledger` 自動寫入，格式 `<列編號> (<總表絕對路徑>)`）
- owned resources：ports、containers、images、sandbox prefix
- live actions：無（有現場動作時寫額度）
- preflight：無（有現場動作時填核對事項）
- 視覺驗收：無（填法見 [視覺驗收](visual-acceptance.md)）
- 預計檢查數：無（派 QA 時寫預計的檢查數量級）
- 整套測試：無（派實作與 QA 時必填：由誰、何時經閘門跑一次；實作寫「最終版本跑一次 `affected --purpose pre-merge`」（沒有對照表時它跑整套），整批合併後寫明由誰跑 `post-merge`，QA 寫「不跑；合併前查實作者回報的 pre-merge 總結，合併後查 `post-merge` 總結紀錄」）
- runs：主工作區 `.lat/runs/` 下該票資料夾的絕對路徑（見「票資料位置」）；沒有自己票號的卡（Spec 審查、參謀）寫上層票的資料夾，都沒有寫「無」
- temp paths：逐項列路徑；含機密者標記 `secret → shred -u`，不記錄機密內容；隔離 client 家目錄必列（見「隔離 client 家目錄」）
- done so far：
- next step：
- deliverable commit：待 Orchestrator 從 Git 查證後填入
```

小改動票（`card --ledger … --tiny`）的 QA 與證據規則見 [預先授權](preauth.md#小改動通道)。

agent 欄以 HCOM 名稱開頭，要加說明時接空白或半形／全形括號；orchestrator 填派工主控的 HCOM 名稱。[停住監控](stall-watch.md) 靠這兩欄找每位主控要盯的 Agent；缺 agent、orchestrator、status 任一欄，或 agent 欄空白、名稱後接其他符號的卡片無法辨識，監控會跳過並記錄。不適用的欄位填「無」，不可省略資源歸屬或虛構 commit。status 使用 `dispatched / in progress / committed / merged`，沒有 commit 者以 `completed` 結束；受阻原因與恢復條件寫在 next step。

## 票資料位置

每張票的 QA 情境草稿、實作路徑清單、測試清單、證據、截圖與重測結果，放在主工作區的 `.lat/runs/issue-<N>/`，N 是 tracker 的票號。別的 tracker 的票放 `issue-<N>-<短名>/` 以免撞號：沿用 `runs/` 同 tracker 的短名，否則用 repo 名小寫。沒有票號的工作（研究、原型）放 `.lat/runs/misc-<YYYY-MM-DD>-<tag>/`。主控進度索引維持單一檔案 `.lat/progress/<hcom-name>.md`，`progress/` 下不建子資料夾或票的筆記。既有資料留原處。

任務卡的 `runs` 欄寫該票資料夾的絕對路徑。路徑一律指向主工作區的 `.lat`，不在 worktree 內另建。證據只存結論、指令輸出、必要截圖與單一檔案節錄；通過的項目只存截圖或輸出，失敗才留 Playwright trace（設定見 three-tier-testing）。

## 隔離 client 家目錄

測試或 QA 以隔離的 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 等啟動 Agent 時，家目錄放在 `.lat` 以外的暫存位置，以任務 tag 命名。建立時立刻把路徑寫進 `temp paths` 並標 `secret → shred -u`；做法見 three-tier-testing 的「測試資源清理：隔離 client 家目錄」。

## 現場動作額度

**現場動作**指碰到真實外部系統或運作中環境的動作：對外部服務送請求、操作真實帳號或瀏覽器、重新部署或重建正在使用的服務、對外傳送訊息；只在 sandbox、測試替身或本機單元測試內的不算。

`live actions` 與 `preflight` 兩欄必填，各寫一行，由主控派工時填好，並寫進第一則任務訊息：

- `live actions`：沒有現場動作填「無」。有現場動作時寫明額度，不適用的項目寫「不適用」：
  - 重新部署／重建次數、請求或頁面數、訊息或操作次數、時間的上限，以及明確的停止條件
  - 重現模型輸出問題：真實模型預設最多 10 次（獨立、固定出現率 ≥26% 時，全未出現機率 <5%）；未重現記 `UNPROVEN`，附各次輸出，停手回報。
- `preflight`：`live actions` 為「無」時填「無」。否則寫明已核對的事項；尚未核對的項目寫明由誰在動手前核對：
  - 登入身分與帳號、請求量與頻率、被限流或風控的風險、時間相依、復原方式

範例：

```markdown
- live actions：重建 staging 最多 2 次；請求最多 60 個；最長 45 分鐘；出現登入頁、429 或連續 3 次相同錯誤即停
- preflight：測試帳號 qa-01 已登入（主控已核對）；間隔 10 秒以上；限流每分鐘 30 個；重建失敗切回上一個映像（動手前由執行 Agent 核對映像仍在）
```

額度不擴大授權：只能在使用者已確認的 Spec 或驗收條件內訂。花錢、動帳號或額度、刪資料、對外發布等要問使用者的事，寫進額度也仍要先問。

執行 Agent 依這兩欄行動：

- 動手前逐項核對 `preflight`；任一項不成立就先回報主控。
- 額度內的現場動作自己做，不逐步請核准。
- 有現場動作的 QA 等實作者宣布定版後才開始用額度。
- 只在下列情況回報主控：(1) 即將超過或已超過任一額度；(2) 觸發停止條件；(3) 出現登入、真人驗證或風控等風險訊號；(4) 遇到規格外的決定；(5) 得到最終結果。
- 每用掉一次額度就在任務卡 `done so far` 加一行（第幾次、結果），逐次保留，不受「不累加日誌」限制。
- 額度用完但目標未達成時，不再多試一次，立刻停手回報，等主控依「追加額度」決定。

任一欄缺少或留空時，[停住監控](stall-watch.md#任務卡必填欄位檢查) 會通知主控補上，不判斷額度內容或用量。

### 追加額度

追加任何額度前，主控在待決紀錄寫明追加的執行出現什麼結果會改變哪個結論，交 [參謀](advisors.md#諮詢流程) 定案（需要真人時問使用者），核准才追加；寫不出就照現有證據結案。

### 重複的真機／VM 程序

同一種真機、VM 或外部裝置的測試會重複做時，主控把準備步驟、已知等待時間和成功判準寫成專案文件（如 `docs/agents/`），`preflight` 指向它。沒有這份文件時，由執行 Agent 第一次做完補寫。

停止條件不能比已知的準備時間短（開機要幾分鐘，就不能「一連不上就算失敗」）；沒有已知時間時，第一次先量並記錄。

## 更新與歸檔

- Orchestrator 派工時建立卡片並填好任務位置、資源分配與必填欄位。
- Agent 在開工、檢查點及結束時更新狀態、已完成工作與下一步，不累加日誌。內建 Agent 無檔案存取時由 Orchestrator 代寫。
- Orchestrator 從 Git 查證後填入 deliverable commit，整合後標記 merged。

## 任務收尾

每項任務合併至整合分支且整合後驗證通過後，由 Orchestrator 在關閉 Agent 的同一步驟完成以下清理，不等整批結束：

- 清理任務卡列明且屬於本任務的資源；普通暫存檔用 trash-cli，含機密者（含隔離 client 家目錄）先用 `shred -u`，再移除所在 worktree。核對 `temp paths` 的位置都已不存在、`.lat` 無家目錄副本。
- 以 `git worktree remove` 移除該任務的獨立 worktree，在整合分支的工作區執行 `git branch -d` 刪除任務分支（`-d` 檢查是否已合入該工作區的 `HEAD`，有上游分支則檢查上游）；`-D` 僅限使用者確認放棄。
- **先**結案任務卡（該列須先 `done`，否則失敗），**再**關閉 Agent：`uv run --no-project python <lat_dir>/scripts/lat-dispatch.py card close --card <卡片> --status committed|merged|completed --deliverable <commit 或證據>`（`merged` 加 `--merged-into <整合分支>`）。改欄位、移到 done/、更新總表，失敗全還原。移走後停止監控；卡片仍在而 Agent 消失視為意外並通知主控。
- `hcom kill` 關閉 Agent 並核對已停止後，立即執行 `uv run --no-project python <lat_dir>/scripts/lat-reap.py reap --agent <Agent 名稱>` 收掉它留下的服務。

任務卡明列待完成後續工作時可暫留，完成後立即收尾。

交付前以 `uv run --no-project python <lat_dir>/scripts/lat-reap.py scan --limit 0` 列出本輪關閉的程序與仍保留的服務，寫入交付回報。

沒有 commit 的 [Spec 文件審查](spec-review.md#收尾)與參謀不適用合併門檻：使用者確認或放棄 Spec（參謀為階段交界、交付或取消）時，主控先以 `card close --status completed --deliverable '無（證據為 issue 留言）'`（參謀寫 `'無（參謀無提交）'`）結案任務卡，再關閉該 Agent。
