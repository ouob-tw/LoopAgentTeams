# TypeScript 測試設定（Vitest + Playwright）

## 目錄結構

| 層級 | 工具 | 目錄 |
| ---- | ---- | ---- |
| 單元測試 | Vitest | `src/**/*.test.ts` |
| 整合測試 | Playwright | `tests/integration/*.spec.ts` |
| E2E | Playwright | `tests/e2e/*.spec.ts` |
| 驗收測試（選用） | Playwright | `tests/qa_e2e/*.spec.ts` |

前後端分離時，以上路徑皆相對於 `<frontend>/`。整合與 E2E 皆可用 Playwright，差別在後端：mock backend → integration，真實 server → E2E。

## 裸跑原則

Vitest 預設只收集 `src/**/*.test.ts`（由 vitest config 的 `include` 控制）。Playwright 需明確指定目錄：

```bash
# 只跑單元測試（預設）
npx vitest

# 只跑整合測試
npx playwright test tests/integration

# 只跑 E2E
npx playwright test tests/e2e

# 只跑驗收測試
npx playwright test tests/qa_e2e
```

## 環境設定

**整合測試：** Playwright config 中設定 `webServer` 啟動開發 server，搭配 mock backend（MSW 或自訂 mock server）。

**E2E：** Playwright config 中設定 `webServer` 啟動完整 stack（前端 + 真實後端），或連接已運行的 staging 環境。

## 驗證

```bash
# 確認 vitest 只收集單元測試
npx vitest --reporter=verbose --run 2>&1 | head -30

# 確認 playwright 只收集指定目錄
npx playwright test tests/integration --list
npx playwright test tests/e2e --list
npx playwright test tests/qa_e2e --list
```
