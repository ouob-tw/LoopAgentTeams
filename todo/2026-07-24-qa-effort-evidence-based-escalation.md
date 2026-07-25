# QA effort 證據式升級待辦

## 狀態

已完成。繁中 Spec 已寫至
`docs/superpowers/specs/2026-07-24-qa-effort-evidence-based-escalation-design.md`；
`lat-dispatch`、contract tests 與已安裝 skill copies 均已同步修改。Terra 最終測試
PASS，Fable 5／medium 的完整審查與修正後增量重審皆 PASS，沒有 blocking finding。

## 使用情境

- 使用者通常以 `claude-opus-4-8` 或 `gpt-5.6-sol` 擔任 Dispatch。
- code／test／QA 內建預設目前皆為 `gpt-5.6-terra`／medium。
- 疑難測試可升為 Terra/high。
- 使用者若明確指定 QA 使用 `gpt-5.6-sol`、但沒有指定 effort，目前規則是從 low 開始，最高到 high。
- 使用者明確指定的 model／effort 永遠優先於內建自動規則。

## 已確認設計

採用「Dispatch 先分類，只有 QA 自身能力不足才升 effort」的混合策略。

Dispatch 可以依已知結構性風險預先選擇較高能力，但一般測試失敗不得自動視為 QA
能力不足。是否升級必須有該輪的實際證據，不以任務長度、檔案數量或籠統的
「很複雜」作為理由。

### 可在派發前升級的具名高風險

- 並行正確性。
- secrets、權限或安全邊界。
- 不可逆資料遷移。
- 付款或扣款。
- 外部副作用的冪等性或結果不明。

Dispatch 必須在派發紀錄中指出具體風險與受影響行為；不得只寫「高風險」。

### QA 結果分類與處理

| 分類 | 判定證據 | 後續處理 | QA effort |
| --- | --- | --- | --- |
| 明確產品失敗 | 驗收步驟有效，實際行為清楚違反 Spec／QA 項目 | 交給下一個 `test_executor` 修實作，再由 QA 重驗 | 維持原 effort |
| QA 測試或證據失效 | 驗收測試本身無效、PASS／FAIL 與證據矛盾，或在環境正常時仍無法可靠判定 QA 項目 | 修正 QA 驗收方法並重驗 | Sol 未指定 effort 時升一階 |
| 工具或環境失敗 | client、權限、服務啟動、連線、測試環境或工具呼叫失敗，尚未得到有效產品結論 | 走既有異常診斷／同 effort 重試 | 不升級 |
| 驗收通過 | 所有 QA 項目均有一致且足夠的 PASS 證據 | 停止 QA 迴圈，進入完整回歸 gate | 不升級 |

### Sol QA effort 階梯

只在使用者明確指定 `qa_executor` 使用 `gpt-5.6-sol`，且沒有指定 effort 時套用：

```text
首次：low
QA 測試或證據失效：low -> medium -> high
明確產品失敗：維持目前 effort
工具或環境失敗：維持目前 effort
上限：high
```

不能再以 `qa-results.md` 出現任一 `FAIL` 作為升級條件。清楚找出產品缺陷代表 QA
成功完成判定，不應因此增加推理成本。

## Dispatch 的判定責任

強力 Dispatch 適合辨識已知的結構性風險與裁決證據，但不能只靠事前猜測可靠預測
runtime 難度、flaky test、隱藏 race 或環境問題。因此每次自動升級都必須記錄：

1. 分類結果。
2. 觸發條件。
3. 本輪具體證據或錯誤。
4. 前一輪採用的 model／effort。
5. 為何同 effort 已不足，以及下一階 effort 能改善什麼。

若無法提出以上內容，維持原 model／effort。

## 現行規則需要修正之處

`lat-dispatch/references/clients.md` 目前把「`qa-results.md` 出現任一 `FAIL`」直接
綁定到 Sol QA 的 `low → medium → high`。這會把產品失敗、QA 測試問題與其他失敗
混為一談，應改為上述分類規則。

`lat-dispatch/tests/skill-contract-test.sh` 目前也明確斷言升級須綁定任一 acceptance
FAIL，實作時應先改測試，使舊規則 RED，再修改 skill 契約使其通過。

## 預計修改範圍

- `lat-dispatch/references/clients.md`
- `lat-dispatch/SKILL.md` 中 QA FAIL 後的 Dispatch 分流文字，如需補足分類契約
- `lat-dispatch/tests/skill-contract-test.sh`
- README 中若存在相同 model／effort 說明則同步修正
- repo skill 驗證通過後，同步所有支援的已安裝 `lat-dispatch` copies

修改 skill 時必須遵循 Agent Skills skill creation best practices，維持主
`SKILL.md` 精簡，將 client／model／effort 的細節保留在 `references/clients.md`。

## 實作與驗證順序

1. 依 `skill-creator`、`superpowers:writing-skills` 與
   `superpowers:test-driven-development` 執行。
2. 先更新 contract test，證明現行「任一 FAIL 就升級」會失敗。
3. 以最小變更更新 QA 分類與 effort 規則。
4. 執行 skill contract、shell syntax、ShellCheck 與 Agent Skills validator。
5. 同步已安裝 skill copies，逐份比較 repo 與 installed copy。
6. 檢查 git diff，避免改動其他 TODO 或不相關規則。
7. 完成後再依使用者指示 commit／push；本次僅建立 TODO，不先提交。

## 300000 ms 等待節奏相關脈絡

這是另一個已討論但本待辦不修改的議題：

- Monitor 仍約每 5 秒讀取一次 Session JSONL。
- `300000 ms` 是外層 Codex 等待 Monitor／shell 輸出的單次 blocking wait 上限，不是
  Monitor 每五分鐘才檢查一次。
- completion 或 shell output 可讓等待提早返回；但不能保證新傳入的 steering 訊息
  一定中斷正在進行的 `write_stdin` wait。
- 保守情況下，Dispatch 可能到單次 300 秒等待結束後才處理新訊息；queue 模式還可能
  更晚。這個節奏是依 repo 的「每 5 分鐘查一次 SHELL」指示，目的在減少喚醒與 token
  消耗。

## 建立本待辦時的 repo 狀態

- branch：`main`
- `origin/main`：與本地同步
- HEAD：`e7eac04b6049fc76ccfc8a004fe3542ffd772691`
- `v1.4.0` peeled commit：`e7eac04b6049fc76ccfc8a004fe3542ffd772691`
- GitHub release target：`e7eac04b6049fc76ccfc8a004fe3542ffd772691`
- 上一輪 Fable 5 medium 增量審查結果：PASS
- 建立本待辦前工作樹乾淨
