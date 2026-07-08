---
name: three-tier-testing
description: Use when setting up test infrastructure, adding tests, reorganizing test directories, or reviewing test structure. Triggers include creating test files, discussing test strategy, separating unit from integration tests, or when tests need external services like databases or Docker.
---

# 三層測試架構

依照外部依賴程度，將測試分為三層。每層獨立運行，一條指令執行。

| 層級 | 目錄 | 外部依賴 | 目的 |
| ---- | ---- | -------- | ---- |
| 單元測試 | `tests/unit/` | 無 | 邏輯正確性 — 純程式碼，所有依賴皆 mock |
| 整合測試 | `tests/integration/` | 假的（測試用 DB 等） | 服務串接 — 真實 DB、mock 外部服務 |
| E2E 測試 | `tests/e2e/` | 真的 | 完整使用者流程 — 無 mock，真實外部服務 |

前後端分離時，後端測試放 `<backend>/tests/` 下，前端測試放 `<frontend>/tests/`（單元測試可能在 `<frontend>/src/**/*.test.*`）。單體專案直接用根目錄 `tests/`。

## 裸跑原則

裸跑測試指令（不帶目錄或標籤參數）只跑單元測試。整合與 E2E 需明確指定。具體實現方式（testpaths、build tag、設定檔分離等）依語言而定，見語言設定章節。

## 整合測試環境：Host（預設） vs Docker

```
本機已跑單一 DB？          → Host（預設）
開發流程已有 Docker Compose？ → Docker
多資料庫 / 訊息佇列？       → Docker
```

## 測試範圍判斷

優先測試：
- 業務關鍵路徑（付款、認證、資料寫入）
- 錯誤處理與邊界條件
- 安全邊界（權限檢查、輸入驗證）
- 資料完整性（migration、約束、串接）

不需測試：
- trivial getter/setter、純資料結構
- 框架自動生成的程式碼（ORM migration 檔、route 註冊）
- 一次性腳本、設定檔

判斷不了時：問「這段壞了會不會有人被 page」。會 → 測。不會 → 跳過。

## 測試歸屬判斷

### 單元測試（`tests/unit/`）

- 函式邏輯搭配 mock 依賴
- 資料轉換、驗證、解析
- 類別行為搭配假協作物件
- 無 DB fixture、無外部服務

### 整合測試（`tests/integration/`）

- 資料庫操作（migration、CRUD、約束）
- API endpoint 經由 test client 加真實 DB
- 前端流程搭配 mock backend

### E2E 測試（`tests/e2e/`）

- 瀏覽器驅動的使用者流程 — 無 mock，打真實 server
- 完整 API 呼叫鏈搭配真實外部服務與真實 API 金鑰
- 判斷標準：有 mock 就不是 E2E，歸 integration

## 驗收測試（`tests/qa_e2e/`，選用）

三層之外的獨立目錄，存放對應規格驗收清單（QA）的測試。LoopAgentTeams 的 qa_executor 依規格逐條撰寫於此。

- 技術規則同 E2E：無 mock、驅動真實應用
- 與 `tests/e2e/` 分開的原因：每條測試對應規格的一條驗收項，由驗收方撰寫；修正實作的一方（如 test_executor）只能執行、不得修改
- 裸跑不含此目錄，執行需明確指定（設定方式見語言 reference）
- 前後端分離時放 `<frontend>/tests/qa_e2e/`

## 從扁平 tests/ 遷移

- [ ] 建立 `tests/unit/` 和 `tests/integration/`
- [ ] 逐一檢查測試檔：用到真實外部服務 → `integration/`，純 mock → `unit/`
- [ ] 拆分共用 fixture：DB fixture → `integration/`，其餘 → `unit/`
- [ ] 設定裸跑只執行單元測試（依語言設定）
- [ ] 每層加上自動標記或標籤
- [ ] 執行驗證：裸跑只收集單元測試、指定目錄只收集對應層級

## 語言設定

依專案檔偵測語言，讀取對應 reference：

| 偵測檔案 | 語言 | Reference |
| -------- | ---- | --------- |
| `pyproject.toml` 或 `setup.py` | Python | `references/python.md` |
| `package.json` | TypeScript/JavaScript | `references/typescript.md` |

多語言專案：各語言子專案分別偵測，各讀各的 reference。

未列出的語言：依本文的通用原則（三層目錄、歸屬判斷、裸跑原則），具體設定由 agent 依該語言慣例自行決定。

## 注意事項

- 裸跑只跑單元測試是核心設定。若設定錯誤導致裸跑執行整合測試，會破壞層級隔離。
- 若測試 import 了真實外部服務，即使放在 `tests/unit/` 也是整合測試。正確做法是搬移檔案，不是 mock import。
- Docker 模式使用非預設 port，避免與開發環境衝突。
- Host 模式需確保外部服務在測試前已啟動。
