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

## Docker 構建與清理

適用於以容器交付的專案；Host 模式維持原有測試方式。

- 開發測試重用專案開發 image，掛載目前工作區的程式碼；與 production 共用 runtime 版本、依賴鎖定與 Dockerfile 階段，依賴變更時重建。
- 正式 E2E／QA 使用 production Dockerfile 的正式 target 構建，不掛載原始碼；修改後重建受影響 image 並重新驗證。改到 Dockerfile、啟動、打包或檔案權限時，提前驗證正式 image。
- 正常構建重用 build cache，不預設使用 `--no-cache`。
- 每個任務使用獨立 Compose project 名稱（見下節），記錄自己建立的資源。自訂 label 不會隔離 Compose 操作。
- 執行者先保存測試結果與必要 logs，再清理已無後續用途的任務專用 container、network、測試 volume 與 image；後續仍需使用的資源交接給接手者。
- 保留共用 image、共用資料與 build cache，不執行全域 prune。Build cache 的容量與期限由主機 GC 政策管理。

## Compose 與 .env 檔案

只允許下列檔名，需要時才建立。不建立其他 `compose.*.yml` 或 `.env.*`（如 `.env.test`、`.env.integration`、`docker-compose.test.yml`、`compose.qa.yml`）。

| 用途 | Compose 檔 | 環境變數檔 |
| ---- | ---------- | ---------- |
| 單元測試 | 無 | 無，不讀任何 env 檔 |
| 整合測試 | `compose.integration.yml` | 無；測試值直接寫入，必要密鑰由執行時的 `TEST_*` 環境變數提供 |
| E2E、驗收測試、人工檢查站 | `compose.e2e.yml` | `.env.e2e`（不進 git） |
| 正式環境 | `compose.yml` | `.env`（不進 git） |
| 範本 | — | `.env.example`（進 git） |

- `.env.example` 列出所有環境用到的 key。只有 E2E 用的 key 集中成一段，以註解 `# --- E2E only ---` 標明；不另建 `.env.e2e.example`。
- E2E 打已部署環境或由 CI 注入變數時，不必建立 `compose.e2e.yml` 或 `.env.e2e`。
- 測試 compose 檔獨立完整，不用 `-f compose.yml -f compose.e2e.yml` 疊加正式設定，以免繼承正式的服務、掛載、port 與 `env_file`。
- 測試 compose 檔頂層寫 `name: <project>_integration` 或 `name: <project>_e2e`。名稱只用小寫字母、數字、`-`、`_`，開頭為字母或數字。
- 測試 compose 檔不得出現：`container_name:`、`env_file: .env`、指定 `name:` 的 volume／network、`external: true` 的 volume／network、正式資料的掛載路徑。
- `compose.integration.yml` 不使用變數替換（`${VAR}`、`$VAR`），也不使用 `env_file`，不用 `environment` 只列 key 或留空值的寫法從外部帶值；測試值直接寫入。
- Port：只在容器之間連線的服務不對外 publish。需要 publish 時用非預設 host port（E2E 可由 `.env.e2e` 的變數指定）；同時跑多個任務時，每個任務用不同 port。

測試的每條 Compose 指令都明確帶 `-f` 與 `-p`。使用 `.env.e2e` 時加 `--env-file .env.e2e`；E2E 變數完全由 CI 注入時，設定 `COMPOSE_DISABLE_ENV_FILE=1` 並清空 `COMPOSE_ENV_FILES`，停用預設 `.env` 載入。`up`、`logs`、`exec`、`down` 用同一組參數：

```bash
docker compose -f compose.integration.yml -p <project>_integration up -d
docker compose -f compose.e2e.yml -p <project>_e2e --env-file .env.e2e up -d
```

同時跑多個任務（如多個 worktree）時，整合測試改用 `-p <project>_integration_<task>`，E2E 改用 `-p <project>_e2e_<task>`；`<task>` 轉成小寫，不合法的字元換成 `-`，且不用 `review`（保留給人工檢查站）。

### 人工檢查站（review）

給人用瀏覽器做最後檢查、要連續開著好幾天的網站。它需要保留資料並對外 publish port，與自動化 E2E（跑完即 `down -v --remove-orphans`）相反，所以寫在同一個 compose 檔，但用獨立的 project 隔開。專案沒有這種網站時略過本節。

- 服務寫在 `compose.e2e.yml`，命名為 `review-*`（如 `review-app`），並加上 `profiles: [review]`，讓自動化 E2E 的 `up` 不會啟動它；不另建 compose 檔。
- 每條指令固定帶 `-p <project>_e2e_review` 與 `--profile review`：

```bash
docker compose -f compose.e2e.yml -p <project>_e2e_review --env-file .env.e2e --profile review up -d review-app
```

- 設定值放在 `.env.e2e` 的 `# --- review site ---` 段，host port 由變數指定（如 `E2E_REVIEW_PORT`）。檢查站專用的變數不用 `${VAR:?…}`：profile 未啟用時 Compose 仍會解析，缺值會讓自動化 E2E 失敗。
- 檢查站只由 `--profile review` 啟用。`.env.e2e` 不設 `COMPOSE_PROFILES`，自動化 E2E 執行前也清除 shell／CI 的這個變數，否則一般的 `up` 會連檢查站一起啟動。
- image 的構建規則同正式 E2E（正式 target、不掛載原始碼）。
- 不掛載正式資料路徑，不連正式 DB。可以連共用的非正式測試 DB，但檢查站的 DB／schema 與資料路徑不給自動化 E2E 重設或清理，連線設定分開；變更 schema 前先備份，並用專案的 migration 工具執行。
- 要保留的資料寫入檢查站 project 的 volume 或上述測試 DB，不放在容器可寫層（重建容器就會消失）。
- 對檢查站的 project 不執行 `down -v`（會刪掉它的資料），任務結束的清理也不包含它。更新用 `up -d --build review-app`，停用用 `stop`。

### Gotchas

- 正式與測試共用同一個 project name 時，彼此的容器會被當成 orphan，`--remove-orphans` 或 `COMPOSE_REMOVE_ORPHANS` 會把它們刪掉；service 同名時則可能直接操作或重建對方的容器。檔名不同不算隔離。
- 只用 `-f` 指定測試檔，不會停用預設 `.env` 載入；Compose 仍可能讀入正式的 `.env`，用來替換變數，也用來讀 `COMPOSE_PROJECT_NAME`、`COMPOSE_PROFILES`、`COMPOSE_REMOVE_ORPHANS` 等自身設定，與 service 的 `env_file:` 無關。所以 `-p` 必帶：名稱優先順序是 `-p` > `COMPOSE_PROJECT_NAME` > 頂層 `name:`。
- `--env-file` 改用指定檔案供 Compose 載入，shell 中的同名變數仍優先；它不影響 service 的 `env_file:`，也不影響程式自己載入的 dotenv。

### 舊專案搬遷

- [ ] 列出現有的 compose 與 env 檔，對照上表找出不合規的檔案
- [ ] 舊測試 compose 檔改為 `compose.integration.yml` 或 `compose.e2e.yml`：加頂層 `name:`，移除禁止項，拆掉對 `compose.yml` 的疊加
- [ ] 舊 env 檔：整合測試的一般值寫入 `compose.integration.yml` 或測試程式，必要密鑰改由執行時的 `TEST_*` 環境變數提供；E2E 的值併入 `.env.e2e`，key 補進 `.env.example`；確認搬遷後，含密鑰的舊檔用 shred 刪除，一般檔案用 trash
- [ ] `.gitignore` 忽略 `.env`、`.env.e2e`，保留 `.env.example`
- [ ] 更新腳本、CI、文件裡的檔名與指令（補上 `-f`、`-p`、`--env-file`）
- [ ] 清理舊測試容器：先以容器 ID、labels、掛載與用途確認哪些是舊測試容器，只移除已確認的容器；與正式共用 project 時，不執行 `down` 或 `--remove-orphans`，也不以 service 名稱辨識
- [ ] 驗證：對每個存在的測試 compose 檔，用搬遷後的同一組 `-f`／`-p`／env 參數執行 `config`，檢查展開後的名稱、port、環境變數不含正式值（輸出可能含密鑰，不貼進紀錄）；`docker compose ls` 顯示正式與測試分屬不同 project

## 測試範圍判斷

優先測試：
- 需求指定的功能，以及使用者操作後應出現的結果
- 業務關鍵路徑（付款、認證、資料寫入）
- 錯誤處理與邊界條件
- 安全邊界（權限檢查、輸入驗證）
- 資料完整性（migration、約束、串接）

通常不需單獨測試無自訂行為的 getter/setter、純資料結構與框架產生的樣板；若影響需求、資料或執行行為，仍需驗證其結果。一次性腳本、設定檔與 migration 依影響選擇驗證方式，不以檔案種類直接排除。

依需求、使用者影響、資料正確性與失敗風險選擇測試；是否會觸發值班告警不是跳過的判準。選擇能證明該行為的層級，不要求每項都用 E2E。

## 測試可信度

- 測試受影響的使用流程時，若以 mock／override 替換權限、認證、配額、模型決策等正式行為，在測試或 fixture 說明替換內容與驗證限制，並連結適當層級下實際執行相關控制／路徑的補充證據。缺少證據的那項保證標為 `UNPROVEN`，不以其他測試通過代替；不要求每個單元測試連接真實外部服務。
- 例如，強制權限放行的工具測試不能證明正式權限流程可用；預先寫好的模型工具呼叫不能證明真實模型會選用哪個工具。補充驗證須涵蓋被替換且與本次需求相關的行為。
- 修復缺陷的回歸測試須在修復前版本因目標缺陷失敗，並在修復後通過；保留版本、指令與結果。Import、fixture 或環境錯誤不算重現。無法取得基準或重現時，將「測試能攔下原缺陷」標為 `UNPROVEN` 並記原因，修復後結果另列，不抹除其他有效證據。
- 結果區分 `PASS`、`FAIL`、`UNPROVEN`（證據不足）與 `NOT_EXECUTED`（未執行），記錄原因；未測與無法證明不能彙總成通過。

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

三層之外的獨立目錄，存放對應規格驗收清單（QA）的測試。LoopAgentTeams 的 QA 依規格逐條撰寫於此。

- 技術規則同 E2E：無 mock、驅動真實應用
- 與 `tests/e2e/` 分開的原因：每條測試對應規格的一條驗收項，由驗收方撰寫；修正實作的一方（如 Implementer）只能執行、不得修改
- 裸跑不含此目錄，執行需明確指定（設定方式見語言 reference）
- 前後端分離時放 `<frontend>/tests/qa_e2e/`

## 從扁平 tests/ 遷移

- [ ] 建立 `tests/unit/` 和 `tests/integration/`
- [ ] 逐一檢查測試檔，依上方「測試歸屬判斷」分類至對應目錄
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

- 若測試 import 了真實外部服務，即使放在 `tests/unit/` 也是整合測試。正確做法是搬移檔案，不是 mock import。
- Docker port 規則見「Compose 與 .env 檔案」。
- Host 模式需確保外部服務在測試前已啟動。
