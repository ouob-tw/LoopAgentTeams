# 獨立 LAT Client 路由 Skill 設計規格

**狀態：** 草案，待使用者確認

**目標分支：** `dev`

**正式分支：** 本階段不得修改 `main`

**歷史基準：** `main@5a8e76c`

**問題版本：** 舊 Spec `bbae911`、舊實作 `93d1d73`、過度擴張的後續設計
`842f37a`／`9caf7aa`

## 1. 背景

使用者原本希望從 `lat-dispatch` 抽出「呼叫其他 Agent」的能力，使 Agent 不必載入
完整 LAT Spec、Plan、ledger、review、test 與 QA 流程，也能完成一次獨立委派。

舊版把這個需求理解成「獨立操作外部 Claude Code／Codex exec CLI 或 ZMX TUI」。
使用者實際安裝測試後發現：即使目前宿主已具備可用的內建 subagent，`lat-client`
仍會啟動外部 CLI／TUI。這不只是實作錯誤，而是舊 Spec 的產品邊界與驗收條件錯誤。

本次重新定義 `lat-client`：

> `lat-client` 是一個不依賴完整 LAT 生命週期的輕量 Agent 呼叫路由 Skill。
> 它先判斷是否可用目前宿主的內建 subagent；只有跨客戶端家族、使用者明確指定，
> 或確實需要外部持久 session 時，才進入外部 CLI／TUI 路徑。

## 2. 本次教訓與根因

### 2.1 產品定位錯誤

舊 Spec 的目標是「處理外部 Claude Code／Codex client」，而不是「用最小成本呼叫
另一個 Agent」。因此 Skill 的名稱看似通用，實際能力卻只涵蓋外部工具。

**改善：** 新版先定義使用者意圖與路由結果，再把 CLI／TUI 視為其中兩種後備執行
方式，不能把實作工具當成產品本身。

### 2.2 舊 Spec 主動排除了正確路徑

舊 Spec 將「不改變同宿主內建 subagent 的路由」列為非目標；舊
`lat-client/SKILL.md` 也直接要求在 exec 與 TUI 中選一種，沒有任何「先判斷目前
宿主與目標 Agent 家族」的步驟。安裝後呼叫外部工具，是這份規格的必然結果。

**改善：** 同宿主／同家族的 native-first 判斷必須位於 `SKILL.md` 第一層，且成為
不得回歸的驗收條件。

### 2.3 驗證矩陣只證明外部工具可用

舊 QA 詳細驗證 Claude exec、Claude TUI、Codex exec、Codex TUI，卻沒有驗證：

- Codex 宿主要求 GPT／Codex worker 時，是否使用內建 subagent。
- Claude Code 宿主要求 Claude worker 時，是否使用內建 subagent。
- native 路徑是否完全沒有 CLI、ZMX、PID、Session monitor 與 `.lat-client` 狀態。
- native 能力不可用時，是否避免未告知就退回外部工具。

**改善：** installed-skill 真實行為是發布門檻；mock、文件契約與 review PASS 都不能
取代它。

### 2.4 `lat-client` 與 `lat-dispatch` 過度耦合

舊設計同時要求：

- 將 `lat-client` 設為外部 client 契約的權威來源。
- 修改 `lat-dispatch` 使用新契約。
- 在 `lat-dispatch` 保留完整 compatibility mirror。
- 測試兩份內容永遠一致。

結果是同一份 client 規則被複製，任何修改都要處理相容鏡像與版本漂移，也讓「先
證明獨立 Skill 可用」被擴張成 Dispatch 遷移工程。

**改善：** 第一階段的 `lat-client` 與 `lat-dispatch` 完全獨立。不得修改 Dispatch、
不得建立 runtime dependency、不得建立 mirror。未來是否整合另立 Spec 決定。

### 2.5 漸進揭露名義存在，內容仍然重複

舊實作一次增加 33 個檔案與 3,316 行；`lat-client/references/clients.md` 單檔
649 行，而且 `SKILL.md` 又規定 standalone 路徑不得讀它。後續優化設計再擴張到
1,027 行 Spec 與 1,729 行 Plan，加入大量 route、archive、version-skew 與 evidence
schema，沒有先修正核心路由。

**改善：**

- `SKILL.md` 只保留唯一的路由決策、共同安全規則與完成條件。
- reference 每份只服務一種已選定路徑，不再擁有第二套路由邏輯。
- 不建立禁止 runtime 使用的重複 reference。
- 測試、fixture、trace 與報告不放入安裝後的 Skill package。
- 第一階段不自製 evaluation framework、archive schema 或報告產生器。

### 2.6 文件審查不能代替真實安裝回饋

舊設計可以在規格完整性、契約測試與外部 client smoke 上得到看似充分的證據，仍然
沒有滿足使用者最常見的實際操作。

**改善：** 使用者透過 `#dev` 安裝後的 observed behavior 是最高優先級驗收證據。
若實際路由與本 Spec 不同，即使所有靜態測試通過也不得發布。

## 3. 目標

1. 新增可獨立安裝與觸發的 `lat-client` Skill。
2. 不載入完整 `lat-dispatch` 即可委派一個 Agent 並取得結果。
3. 同宿主、同 Agent 家族預設使用內建 subagent。
4. 跨宿主家族或使用者明確要求時，才使用外部 exec CLI／ZMX TUI。
5. 保留 Claude Code 與 Codex 兩個宿主的必要外部呼叫能力。
6. 以小而清楚的 Skill 主體和按需 reference 控制 context 成本。
7. 在 `dev` 完成真實安裝驗證，經使用者確認後才另行討論正式發布。

## 4. 非目標

- 不修改 `lat-dispatch/` 任何檔案或既有行為。
- 不將 `lat-client` 接入完整 LAT phase、ledger、review、test 或 QA 流程。
- 不建立 `.lat/workspace`、`tasks.yaml` 或 `results.yaml`。
- 不遷移、刪除或鏡像 `lat-dispatch` 的 client references 與 scripts。
- 不建立 `lat-native-client`、`lat-cli-client`、`lat-tui-client` 等多個使用者入口。
- 不同時重寫 README、發布流程或 main/dev 分支政策。
- 不解決所有 client 版本、OS 或舊版 Skill 的交叉相容矩陣。
- 不建立通用 workflow engine、evaluation framework 或 evidence database。

## 5. 名詞

- **宿主（host）：** 目前正在執行 Skill 的 Agent 產品，例如 Codex 或 Claude Code。
- **目標家族（target family）：** 使用者希望委派的 Agent 家族，例如
  GPT／Codex 或 Claude。
- **native route：** 由宿主提供的內建 subagent 能力完成委派。
- **external exec route：** 啟動另一產品的非互動式 CLI。
- **external TUI route：** 透過 ZMX 建立或恢復可互動、可持續的外部 TUI session。
- **同客戶端：** 宿主與目標家族具有可直接使用的內建 subagent 對應。

## 6. 架構邊界

```text
使用者要求呼叫 Agent
        |
        v
lat-client/SKILL.md
  解析明確覆寫 -> 判斷宿主與目標家族 -> 選定唯一 route
        |
        +-- native ------> 宿主內建 subagent，直接等待結果
        |
        +-- external exec -> CLI launcher + completion handling
        |
        `-- external TUI --> ZMX session + completion handling
```

`lat-client` 不呼叫或讀取 `lat-dispatch`。`lat-dispatch` 也不需要知道 `lat-client`
存在。兩者可以單獨安裝、單獨更新與單獨驗證。

## 7. 路由契約

### 7.1 目標解析

先從使用者明確指定的產品、Agent 或模型解析目標家族。若使用者只說「委派一個
Agent／subagent」而未指定家族，目標家族預設為目前宿主可提供的 native 家族；不得
因為本機剛好安裝了另一個 CLI 就選擇外部家族。若名稱無法唯一對應，先請使用者確認，
不得猜測後啟動外部程序。

### 7.2 優先順序

每次操作只選一條 route，依下列順序判定：

1. **明確使用者覆寫：** 使用者明確要求 CLI、exec、TUI、ZMX、外部 client、
   persistent session 或指定現有外部 session 時，遵從指定模式。
2. **同客戶端 native：** 未覆寫且宿主對目標家族提供內建 subagent 時，必須使用
   native route。
3. **跨客戶端 external：** 宿主與目標家族不同時，預設使用 external exec。
4. **互動／持久需求：** 只有使用者明確要求互動、可傳訊或持久 session 時，選擇
   external TUI。
5. **native 不可用：** 原本應走 native，但目前環境沒有對應能力時，必須清楚回報
   缺少的能力並取得使用者明確同意；不得靜默降級為外部 CLI／TUI。

### 7.3 必要對應

| 目前宿主 | 目標家族 | 預設 route | 執行方式 |
|---|---|---|---|
| Codex | GPT／Codex | native | `spawn_agent`，以 `wait_agent` 等完成 |
| Claude Code | Claude | native | 內建 `Agent`，以前景或 blocking completion 等完成 |
| Codex | Claude | external exec | Claude Code exec CLI |
| Claude Code | GPT／Codex | external exec | Codex exec CLI |

使用者明確指定 external exec 或 external TUI 時，可覆寫前表；Skill 必須在執行前用
一句話揭露將使用外部程序。

### 7.4 Native route 的禁止行為

native route：

- 不得啟動 Claude Code 或 Codex CLI。
- 不得啟動 ZMX。
- 不得建立 PID、Session JSONL monitor 或外部 session handle。
- 不得建立 `.lat-client/`。
- 不得讀取 external exec／TUI／monitoring reference。
- 不得固定輪詢；使用宿主的完成通知或 blocking wait。
- 完成條件是內建 subagent 已返回本次委派結果。

### 7.5 External route 的共同行為

external route：

- 執行前確認目標 CLI；TUI 另確認 ZMX。
- 原始 prompt 先安全寫入檔案，不插入 shell command。
- 只保存恢復與判定本次操作所需的最小狀態。
- external exec 是跨家族呼叫的預設；TUI 不是預設後備。
- 必須以目標 client 的權威完成訊號取得本次 Final Answer，不以 PID 消失或畫面文字
  單獨推斷完成。
- 缺少 CLI、登入、配額或權限時回報具體阻塞，不改走另一外部模式。

外部狀態限於：

```text
.lat-client/runs/{operation_id}/
├── metadata.json
├── prompt.txt
├── session-handle
├── stdout.jsonl
└── stderr.log
```

實作可以依 client／mode 省略不適用的檔案，但不得把 LAT ledger 或 phase 狀態加入
這個目錄。

## 8. Skill 結構與 context 預算

候選結構：

```text
lat-client/
├── SKILL.md
├── references/
│   ├── native.md
│   ├── external-common.md
│   ├── exec.md
│   ├── tui.md
│   └── monitoring.md
└── scripts/
    ├── run-exec-client.sh
    └── monitor-session.sh

tests/
└── lat-client/
```

規則：

- `SKILL.md` 是唯一 route owner，目標不超過 150 行。
- frontmatter description 以使用者意圖描述觸發時機，不把 Skill 描述成單純
  CLI／TUI wrapper。
- `SKILL.md` 必須在任何 external reference 前完成 native／external 判斷。
- 每份 reference 只處理單一已選路徑；不得重述完整路由表。
- 不建立 `references/clients.md` 相容鏡像。
- 不複製 `lat-dispatch` 的完整生命週期文字。
- scripts 只用於容易因 shell quoting、PID 或 transcript 判定而出錯的外部操作；
  native route 不使用 scripts。
- 測試、fixtures、raw traces 與 generated evidence 位於 Skill package 外。
- raw transcripts 不提交 Git；只保留精簡、可重現的命令、exit code 與關鍵事件摘要。

此結構遵循 Agent Skills 的
[漸進揭露與精簡原則](https://agentskills.io/skill-creation/best-practices)：
Skill 主體在啟用時會完整載入，因此只保留每次都需要的決策資訊；description 則依
[觸發最佳實務](https://agentskills.io/skill-creation/optimizing-descriptions)
聚焦使用者意圖，而不是列出所有內部命令。

## 9. 測試策略

### 9.1 契約測試

先寫會在舊版失敗的測試：

- `SKILL.md` 具有 explicit override → native-first → cross-family 的固定優先順序。
- native route 明確禁止 CLI、ZMX、monitor 與 `.lat-client` 狀態。
- external reference 只能在 external route 選定後載入。
- Skill 不依賴或鏡像 `lat-dispatch`。
- 安裝 package 不包含 tests、fixtures、traces 或 generated reports。

### 9.2 整合測試

以可觀察的 fake client／fake ZMX 驗證：

- 跨家族預設只呼叫一次正確 exec client。
- 明確 TUI 要求只建立正確 ZMX session。
- prompt 不經 shell interpolation。
- 缺少 native 能力時不會自行啟動 external process。
- external 完成與錯誤狀態可正確分類。

這層可以證明 route 與 shell 契約，但不得稱為真實 client E2E。

### 9.3 真實安裝 E2E

發布候選前，以 fresh agent 安裝 `#dev` 後完成：

1. Codex 宿主呼叫 GPT／Codex worker：觀察到內建 subagent，且無外部程序與
   `.lat-client` 狀態。
2. Claude Code 宿主呼叫 Claude worker：觀察到內建 Agent，且無外部程序與
   `.lat-client` 狀態。
3. Codex 宿主呼叫 Claude：觀察到 Claude external exec 與正確結果。
4. Claude Code 宿主呼叫 GPT／Codex：觀察到 Codex external exec 與正確結果。
5. 任一同宿主案例明確要求 TUI：觀察到 external TUI，證明使用者覆寫有效。
6. 模擬 native 不可用：觀察到停下並說明，而非靜默啟動外部工具。

每案只保存 route、實際工具事件、關鍵完成事件、exit status 與精簡結果；完整原始
transcript 留在臨時目錄或 CI artifact，不提交 repo。

### 9.4 Trigger 評估

使用小型、可讀的 prompt set 驗證 description：

- 至少 6 個應觸發案例：一般委派、同宿主、跨宿主、明確 exec、明確 TUI、resume。
- 至少 6 個不應觸發或應轉交案例：完整 LAT 流程、只問文件、一般 shell 指令、
  無 Agent 委派需求、純 Git 操作、只要求修改目前 Agent 自己的內容。

先以一次 fresh-agent run 找明顯問題；只有結果不穩定的案例才重跑，最多三次。
不得為此建立新的通用 evaluator、archive 或 schema。

## 10. 驗收條件

### QA-1：同宿主預設使用 native

Codex→GPT／Codex 與 Claude Code→Claude 的真實安裝案例都使用宿主內建 subagent；
沒有 CLI、ZMX、monitor 或 `.lat-client` 副作用。

### QA-2：跨宿主預設使用 external exec

Codex→Claude 與 Claude Code→GPT／Codex 都啟動正確的 external exec client，取得
本次 turn 的完整結果，且不進入 LAT lifecycle。

### QA-3：外部模式只能由條件選中

同宿主不會自行使用外部工具；明確要求 exec／TUI 時會揭露並遵從覆寫；native
不可用時不會靜默降級。

### QA-4：與 Dispatch 完全獨立

本次 diff 中 `lat-dispatch/` 為零變更；移除或未安裝 `lat-dispatch` 時，
`lat-client` 仍可安裝、觸發並完成三種 route。

### QA-5：不載入完整 LAT

任何 `lat-client` route 都不建立 `.lat/workspace`、task ledger，不進入
Spec／Plan／review／test／QA phase。

### QA-6：Skill 維持精簡

`SKILL.md` 不超過 150 行；沒有 compatibility mirror；package 不含測試、fixture、
raw trace 或 generated evidence；fresh-agent trace 顯示每次只讀取選定 route 所需
reference。

### QA-7：真實安裝結果優先

第 9.3 節六個案例全部有本機真實證據才可標記候選完成。mock、靜態 contract、
review 結論或 Agent 自述成功不能替代缺少的 E2E。

## 11. 實作與發布階段

### 第一階段：獨立實作

- 只新增 `lat-client`、其必要 scripts 與 repo-level tests。
- `lat-dispatch` 維持 `main@5a8e76c` 的行為。
- 在本機與 `dev` 候選完成測試，不推進 `main`。

### 第二階段：使用者安裝驗證

- 使用者以 `#dev` 安裝候選。
- 依第 9.3 節執行真實案例。
- 將使用者觀察到的 route 與副作用視為最終驗收依據。

### 第三階段：另案決定整合

只有獨立 Skill 通過後，才討論：

- `lat-dispatch` 是否要引用 `lat-client`。
- 如何避免相容鏡像與雙份規則。
- main/dev 文件與正式發布步驟。

本 Spec 不預先決定第三階段，也不得以未來整合需求擴大第一階段。

## 12. 完成定義

本設計的成功不是「四種外部 client 都能啟動」，而是：

1. 使用者不載入完整 LAT，也能委派另一個 Agent。
2. 同客戶端優先使用內建 subagent，沒有不必要的外部程序。
3. 跨客戶端與明確覆寫仍能安全使用 external exec／TUI。
4. `lat-client` 可獨立安裝，`lat-dispatch` 零修改。
5. Skill 內容足以可靠執行，但不重複完整 Dispatch 或建立大型評估框架。
6. 真實 `#dev` 安裝行為與上述規則一致，並由使用者確認後才進入實作整合或正式
   發布討論。
