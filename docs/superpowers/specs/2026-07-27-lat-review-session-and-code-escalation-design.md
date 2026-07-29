# LAT 審查 Session 復用與 Code 模型漸進升級設計

## 背景

目前 LAT 在 accepted finding 修正後，傾向啟動新的 Reviewer Session。這會重複載入
前輪 findings、修正基準與增量 diff，也容易讓不同 Reviewer 對同一問題產生新的解讀。
此外，Reviewer 回覆 `PASS` 後仍可能花時間分類或修正不影響主 task 的措辭、風格與
微小改善。Code phase 遇到具名高風險時則可直接從 Terra/medium 跳到 Sol/high，
缺少以真實專案失敗證據驅動的中間階梯。

## 目標

1. 同一審查鏈的 re-review 優先恢復原 Reviewer Session，保留 finding 與裁決脈絡。
2. Reviewer `PASS` 後，只讓可證明影響主 task 的 bug、需求缺口或直接 regression
   阻擋 phase；非 bug 與無關微小細節不進入修正迴圈。
3. 一般 code 工作維持 Terra/medium；具名高風險或具體 correctness failure 採
   `Terra/high → Sol/medium → Sol/high` 漸進升級。
4. TUI 的 zmx session 在 task 結束、進入 report 前由 task-scoped clean 安全清理，
   避免背景 session 長期堆積。

## 審查 Session 規則

- 首次審查建立 Reviewer Session 與 reviewer instance。
- accepted findings 修正後開始新的 review round，但優先 resume 原 Session，維持原
  reviewer instance、model、effort 與 permission。
- 只有下列情況建立新的 Reviewer Session 與 instance：
  - 原 Session 無法恢復；
  - 需要改變 model 或 effort；
  - 修正造成架構重寫或使 revision base 失效；
  - Dispatch 已用具體證據判定原 Reviewer 的判斷不可靠；
  - 使用者要求獨立 final review。
- re-review 仍只取得前輪 findings、revision base 與 incremental diff；除非增量證據
  觸發既有完整重讀條件。

## PASS 後的範圍

`PASS` 後的 focused gap scan 只是一個窄化的 correctness gate，不是改善清單。只有
下列證據可以重新開啟 review：

- 具體違反已確認需求或 QA；
- 可重現的失敗或攻擊路徑；
- 對主 task 造成直接 regression。

措辭、格式、命名偏好、註解、文件潤飾、可選 refactor，以及與主 task 無直接關聯的
改善，不建立 finding、不交回修正、不延長 phase。使用者另行要求時才處理。

## Code 模型與 effort

- 一般 code_executor：`gpt-5.6-terra`／medium。
- 具名高風險只將第一輪提高為 `gpt-5.6-terra`／high，不直接跳 Sol。
- 同類 covering test、QA 或 review correctness failure 持續存在時，下一個負責修復的
  executor 依序使用：

  ```text
  gpt-5.6-terra/high
  → gpt-5.6-sol/medium
  → gpt-5.6-sol/high
  ```

- 每次升級需記錄前一階、具體失敗證據、同階不足原因與下一階預期改善。
- 工具、環境、配額或無效測試不提高 code model／effort。
- 使用者明確指定的 model／effort 仍有最高優先序。

## ZMX 清理

- 每次 TUI launch／resume 前，Dispatch 將精確 zmx session 名稱保存至
  `.lat/workspace/<TASK_ID>/runtime/<agent_id>.zmx-session`。
- `report` 前固定呼叫 `clean <TASK_ID>`。
- clean 只讀取該 TASK_ID 保存的 handle，並以 `zmx list --short` 精確確認；禁止用
  TASK_ID、agent_id 或名稱片段推測 session。
- 只有該 Agent 已有內建完成通知或外部 Monitor `COMPLETED`，且 executor ledger
  狀態（如適用）已終結時，才執行 `zmx kill "$SESSION_NAME"`。
- completion 證據不足、handle 格式錯誤或無法精確匹配時，保留 session 並在 report
  說明；不得使用 `--force`。
- zmx session 是否存在不作為 phase 完成證據。

## 驗收清單（QA）

### Q1：re-review 復用原 Session

**使用者行為：** Reviewer 提出 accepted finding，作者完成局部修正後再次送審。

**預期：** LAT 開始新的 review round，但 resume 原 Reviewer Session 並維持原
reviewer instance；只有具名例外才建立新 Session。

**測試／證據：** `skill-contract-test.sh` 驗證 Spec、Plan 與 client instance 契約。

### Q2：PASS 後忽略非 bug

**使用者行為：** Reviewer 回覆 `PASS`，focused gap scan 只發現措辭、格式或與主
task 無關的微小改善。

**預期：** 不建立 finding、不交回修正、不延長 phase。

**測試／證據：** contract test 驗證 PASS gate 只接受需求違反、可重現失敗或直接
regression。

### Q3：Code 漸進升級

**使用者行為：** 一般 code task、具名高風險 task，以及同類 correctness failure
連續未解決。

**預期：** 一般工作維持 Terra/medium；高風險從 Terra/high 開始，只有具體專案
失敗證據才依序升至 Sol/medium、Sol/high。

**測試／證據：** contract test 驗證預設、階梯、升級證據及工具／環境失敗不升級。

### Q4：Report 前清理 task-scoped zmx sessions

**使用者行為：** Code、Test、QA 或外部 Reviewer 的 TUI turn 已完成，LAT 準備輸出
最終報告。

**預期：** LAT 先執行 `clean <TASK_ID>`，只終止該 task 已保存且有完成證據的精確
zmx sessions；不影響其他 task 或無法確認完成的 session。

**測試／證據：** contract test 驗證 handle 保存、精確匹配、完成 gate、禁止模糊
推測及 report-before-clean 順序。
