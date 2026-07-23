# Test Service、E2E 與 QA 生命週期待辦

## 狀態

討論中，尚未核准設計，也尚未修改 `three-tier-testing` 或 `lat-dispatch`。

## 起因

原始觀察是：QA Reviewer 完成任務、控制權回到 Dispatch 的最後檢查階段時，Test Service 看起來理應進入 rebuild 狀態。

進一步討論後，需要先確認三層測試框架如何規範測試環境，避免把 rebuild 放在錯誤階段，或讓同一批 E2E 測試分別在主機與容器重複執行。

## 現行框架

目前 `three-tier-testing` 的規範如下：

- 單元測試在 `tests/unit/`，不使用外部服務。
- 整合測試在 `tests/integration/`，Host 是預設模式；專案已有 Docker Compose，或需要多個資料庫、訊息佇列等依賴時才採 Docker。
- E2E 測試在 `tests/e2e/`，必須驅動真實應用且不得使用 mock。
- QA 驗收測試在 `tests/qa_e2e/`，技術規則同 E2E，但由獨立的 `qa_executor` 依 Spec 驗收清單撰寫與執行。
- TypeScript reference 允許 Playwright `webServer` 啟動完整 stack，或連接已運行的 staging 環境。
- 現行規範沒有要求 E2E／QA 一定使用 Test Service 容器，也沒有定義 image ID、container instance、rebuild 或 readiness 的交接契約。

目前 `lat-dispatch` 的流程是：

```text
test_executor 寫並執行 integration + E2E
  -> qa_executor 執行 qa_e2e
  -> Dispatch 讀取 ledger 與 qa-results.md
  -> report
```

QA FAIL 時，Dispatch 會啟動新的 `test_executor` 修正實作，再啟動新的 `qa_executor` 重新驗收。

## 已確認的問題

### 不應在 report 前直接 rebuild

如果 Dispatch 在 QA 全部 PASS 後才 rebuild Test Service，最後產生的是一個沒有經過 E2E／QA 驗證的新環境。除非 rebuild 後再執行驗收，否則不能把它當成已驗證產物。

### 不應重複執行同一批 E2E

若先在 host 對真實服務跑一遍 E2E，再對 Test Service 容器跑完全相同的一批 E2E，屬於不必要的重複。Host 與 Docker 應代表不同測試層級或不同依賴拓撲，而不是無條件重跑相同測試。

### QA 的獨立性不必靠重建相同 image

QA 的獨立性可由以下條件提供：

- 使用獨立的 `qa_executor`。
- 執行不同的 `qa_e2e` 驗收測試。
- 從相同的已驗證 image 建立乾淨 container instance。
- 不允許 QA 修改實作或既有測試。

如果程式碼沒有變更，再次 build 相同 Test Service image 通常沒有額外價值。

## 目前推薦方向

建議把容器化專案的生命週期定義為：

```text
test_executor
  -> 從目前 working tree build Test Service image
  -> 啟動 container
  -> readiness check
  -> 對該服務執行 E2E
  -> 記錄 image ID/digest

qa_executor
  -> 使用同一 image ID/digest 建立乾淨 container instance
  -> readiness check
  -> 執行獨立的 qa_e2e
  -> 記錄 image ID/digest 與驗收證據

Dispatch
  -> 確認 E2E 與 QA 使用相同 image ID/digest
  -> 驗證 ledger 與 qa-results.md
  -> report
```

各層預期分工：

- 單元測試：在 host 執行，不啟動 Test Service。
- 整合測試：測 API、DB、cache 等元件串接；測試 runner 可在 host，外部測試依賴可在容器。
- E2E：只對 Test Service 容器執行，不再額外跑一遍等價的 host E2E。
- QA：對相同 image 的乾淨 container instance 執行 `qa_e2e`。

QA 發現問題並由 `test_executor` 修改實作後，必須 build 新 image，重新執行 E2E，再交給新的 QA 驗收：

```text
修改實作
  -> build 新 image
  -> E2E
  -> QA
```

## 尚待決定

1. Test Service 容器契約是否只套用於已有 Docker／Compose 的專案，非容器化專案則保留 fresh process／Playwright `webServer`。
2. image ID/digest 要記錄在 `results.yaml`、`qa-results.md`，或兩者都記錄。
3. readiness 指令由 Spec／Plan 明確提供，或允許 executor 從既有 Compose、healthcheck 與專案指令中解析。
4. QA 是否必須建立新的 container instance，或在能證明狀態已清理時允許重用既有 instance。
5. Test Service 的停止與清理責任屬於 `qa_executor`，還是 Dispatch 在 report 前只負責確認清理完成。
6. 非 Docker 專案如何提供與 image digest 等價的可追溯版本證據，例如 Git commit、working-tree hash 或 build artifact digest。

## 預計影響範圍

設計核准後，預計至少檢查並可能修改：

- `three-tier-testing/SKILL.md`
- `three-tier-testing/references/python.md`
- `three-tier-testing/references/typescript.md`
- `lat-dispatch/SKILL.md`
- `lat-dispatch` 與 `three-tier-testing` 的 contract tests
- 必要的 README 流程說明

修改 skills 時必須遵循 Agent Skills 的 skill creation best practices，維持規則精簡、提供明確預設，並把語言或工具特定細節留在 reference 文件中。
