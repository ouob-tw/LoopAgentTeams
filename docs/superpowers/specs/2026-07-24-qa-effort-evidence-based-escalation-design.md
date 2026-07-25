# QA effort 證據式升級規格

## 背景

LAT 的 code、test 與 QA executor 預設使用 `gpt-5.6-terra`／medium。使用者可依任務
覆蓋模型；若只指定 QA 使用 `gpt-5.6-sol` 而未指定 effort，現行規則從 low 開始，
並在 `qa-results.md` 出現任一 `FAIL` 後逐階升至 medium、high。

「任一 FAIL」無法區分產品缺陷、QA 驗收方法失效及工具／環境錯誤。QA 清楚證明
產品不符合規格時，代表驗收判定已成功，不應只因結果為 FAIL 就提高 QA 推理成本。

## 目標

讓 Dispatch 先依實際證據分類 QA 結果，只在 QA 自身無法可靠完成驗收判定時提高
未指定 effort 的 Sol QA；產品失敗與工具／環境失敗均不提高 QA effort。

## 非目標

- 不變更 code、test 或 QA 的 Terra/medium 內建預設。
- 不變更 Spec reviewer、Plan writer 或其他角色的預設模型。
- 不新增 model、effort 或 config 欄位。
- 不修改 retry 次數、Monitor 等待節奏或完整回歸 gate。
- 不讓 Dispatch 接手 executor 的實作、測試或驗收工作。
- 不建立 PLAN 文件。

## 規則

### 解析優先序

使用者 prompt 仍高於 `.lat/config.yaml`，後者高於內建預設。使用者明確指定 QA
effort 時，不套用自動階梯。

只有使用者明確指定 `qa_executor` 使用 `gpt-5.6-sol`、且未指定 effort 時，首次
驗收使用 low，後續才可能依本規格升級，最高為 high。

### 派發前的風險升級

既有具名高風險規則維持不變：並行正確性、秘密或權限邊界、不可逆資料遷移、
付款／扣款，以及外部副作用的冪等性或結果不明。

Dispatch 若依具名高風險預先升級負責修復的 executor，必須記錄具體風險與受影響
行為。任務長度、檔案數量或未附證據的「複雜」不得作為升級理由。QA executor
不因產品修復本身屬高風險而自動切換模型。

### QA 結果分類

Dispatch 在每輪 QA 完成後，依 ledger、`qa-results.md`、驗收輸出及必要的 runtime
診斷將每個未通過項目分類：

| 分類 | 可觀察證據 | 後續流程 | 未指定 effort 的 Sol QA |
| --- | --- | --- | --- |
| `PRODUCT_FAILURE` | 驗收步驟有效，實際行為清楚違反已核准 Spec／QA 項目 | 建立下一個 `test_executor` 修實作，修復後重新驗收 | 維持原階 |
| `QA_INVALID` | 驗收測試本身無效、PASS／FAIL 與證據矛盾，或在 app 與測試環境正常時仍無法可靠判定 QA 項目 | 下一個 QA 修正驗收方法並重新執行 | 提高一階 |
| `TOOL_OR_ENVIRONMENT_FAILURE` | client、權限、服務啟動、連線、測試環境或工具呼叫失敗，尚無有效產品結論 | 依既有異常診斷修復或同階重試 | 維持原階 |
| `PASS` | 所有 QA 項目都有一致且足夠的 PASS 證據 | 停止 QA 迴圈，進入完整回歸 gate | 維持原階 |

若證據不足以支持 `QA_INVALID`，Dispatch 必須維持目前 effort，不得猜測升級。
同一輪同時包含 `QA_INVALID` 與 `PRODUCT_FAILURE` 時，先修正 QA 驗收方法並重驗，
建立可信結果後才將仍成立的產品失敗交給 `test_executor`。工具或環境錯誤不否定
同輪其他已有充分證據的項目。

### effort 階梯

```text
首次 Sol QA：low
QA_INVALID：low -> medium -> high
PRODUCT_FAILURE：維持目前 effort
TOOL_OR_ENVIRONMENT_FAILURE：維持目前 effort
PASS：停止
high 後：維持 high
```

每次自動升級必須記錄：

1. 分類結果。
2. 觸發條件。
3. 本輪具體證據或錯誤。
4. 前一輪 model／effort。
5. 同階 effort 為何不足，以及提高一階預期改善的驗收判定。

## 文件配置

model、effort 與 client 的詳細判定規則保留在
`lat-dispatch/references/clients.md`，符合 progressive disclosure。主
`lat-dispatch/SKILL.md` 只補足 QA FAIL 後 Dispatch 必須先分類再分流的核心程序，
避免重複完整矩陣。

## 驗收清單（QA）

### Q1：產品失敗不提高 QA effort

**Q：** 當 Sol/low QA 以有效驗收證據確認產品違反規格，修復後的 QA 應使用哪個
effort？

**A：** 維持 low。contract test 必須驗證 `PRODUCT_FAILURE` 會交給
`test_executor` 修復，且不得觸發 QA effort 升級。

### Q2：只有 QA 驗收失效才逐階升級

**Q：** 當驗收測試無效、證據互相矛盾，或環境正常但 QA 無法可靠判定時，未指定
effort 的 Sol QA 如何處理？

**A：** 分類為 `QA_INVALID`，依 `low → medium → high` 提高一階，high 封頂。
contract test 必須驗證觸發條件、階梯與上限。

### Q3：工具或環境失敗不提高 effort

**Q：** 當 QA 因 client、權限、服務、連線或測試環境問題而沒有得到有效產品結論
時，是否提高 effort？

**A：** 不提高。依既有異常診斷處理並以相同 effort 重試。contract test 必須驗證
此分類不計入升級。

### Q4：明確指定 effort 保持最高優先

**Q：** 使用者同時指定 QA model 與 effort 時，自動階梯是否覆蓋該 effort？

**A：** 不覆蓋。contract test 必須保留使用者明確 effort 優先的斷言。

### Q5：Dispatch 升級必須附具體證據

**Q：** Dispatch 能否只以「任務複雜」或任一 FAIL 為理由提高 effort？

**A：** 不能。contract test 必須驗證規則要求分類、具體證據、前一階 model／effort
及升級理由；證據不足時維持原階。

### Q6：既有預設與其他流程不回歸

**Q：** 此變更是否影響預設模型、explicit override、retry、Monitor 或完整回歸？

**A：** 不影響。完整 skill contract、exec client、Monitor、native subagent、
shell syntax、ShellCheck 與 Agent Skills validator 必須通過；repo 與已安裝 skill
copies 必須一致。

## 完成條件

- 先修改 contract test 並確認舊規則以預期原因失敗。
- 以最小文件變更使新 contract 通過。
- Terra 獨立執行測試並回報實際命令與結果。
- Fable 5／medium 以 report-only 方式審查本規格與實際 diff。
- Dispatch 驗證每個 finding；有效問題修正後，以新的 Fable reviewer 重審。
- Reviewer verdict 與 Dispatch adjudication 均通過，且所有驗證命令為綠。
