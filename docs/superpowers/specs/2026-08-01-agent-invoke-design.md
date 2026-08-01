# 獨立 Agent Invoke Skill 設計規格

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

本次以新名稱 `agent-invoke` 重新定義這項能力：

> `agent-invoke` 是一個不依賴完整 LAT 生命週期的輕量 Agent 呼叫 Skill。
> 它先判斷是否可用目前宿主的內建 subagent；只有跨客戶端家族、使用者明確指定，
> 或確實需要外部持久 session 時，才進入外部 CLI／TUI 路徑。

名稱採用 `agent-invoke`，因為主要使用者意圖是「呼叫任意已支援的 Agent client 並取得
結果」；route 只是內部實作。名稱不使用 `lat-` 前綴，以表明它可脫離完整 LAT
workflow 獨立安裝與使用。

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

**改善：** 第一階段的 `agent-invoke` 與 `lat-dispatch` 完全獨立。不得修改 Dispatch、
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

1. 新增可獨立安裝與觸發的 `agent-invoke` Skill。
2. 不載入完整 `lat-dispatch` 即可委派一個 Agent 並取得結果。
3. 同宿主、同 Agent 家族預設使用內建 subagent。
4. 跨宿主家族或使用者明確要求時，才使用外部 exec CLI／ZMX TUI。
5. 保留 Claude Code 與 Codex 兩個宿主的必要外部呼叫能力。
6. 可以精確恢復 `agent-invoke` 已記錄的 session，也可導入使用者提供的精確
   Claude Code／Codex session reference。
7. 以小而清楚的 Skill 主體和按需 reference 控制 context 成本。
8. 在 `dev` 完成真實安裝驗證，經使用者確認後才另行討論正式發布。

## 4. 非目標

- 不修改 `lat-dispatch/` 任何檔案或既有行為。
- 不將 `agent-invoke` 接入完整 LAT phase、ledger、review、test 或 QA 流程。
- 不建立 `.lat/workspace`、`tasks.yaml` 或 `results.yaml`。
- 不遷移、刪除或鏡像 `lat-dispatch` 的 client references 與 scripts。
- 不建立 `lat-native-client`、`lat-cli-client`、`lat-tui-client` 等多個使用者入口。
- 不同時重寫 README、發布流程或 main/dev 分支政策。
- 不解決所有 client 版本、OS 或舊版 Skill 的交叉相容矩陣。
- 第一階段只支援 Claude Code 與 Codex，不建立可配置的第三方 client adapter。
- 不以「最新 session」、名稱片段、glob、`--last` 或 `--continue` 猜測要恢復的 session。
- 不建立通用 workflow engine、evaluation framework 或 evidence database。

## 5. 名詞

- **宿主（host）：** 目前正在執行 Skill 的 Agent 產品，例如 Codex 或 Claude Code。
- **目標家族（target family）：** 使用者希望委派的 Agent 家族，例如
  GPT／Codex 或 Claude。
- **native route：** 由宿主提供的內建 subagent 能力建立或延續委派。
- **external exec route：** 啟動新的外部非互動式 CLI，或恢復精確指定的 CLI session。
- **external TUI route：** 透過 ZMX 建立新的互動 session，或延續精確指定的外部
  client session。
- **同客戶端：** 宿主與目標家族具有可直接使用的內建 subagent 對應。
- **resume：** 對同一個已驗證 session 開始新 turn，不建立新的 client 對話。

## 6. 架構邊界

```text
使用者要求呼叫 Agent
        |
        v
agent-invoke/SKILL.md
  解析 new／resume -> 解析明確覆寫 -> 選定或恢復唯一 route
        |
        +-- native ------> 宿主內建 subagent，直接等待結果
        |
        +-- external exec -> CLI launcher + completion handling
        |
        `-- external TUI --> ZMX session + completion handling
```

`agent-invoke` 不呼叫或讀取 `lat-dispatch`。`lat-dispatch` 也不需要知道 `agent-invoke`
存在。兩者可以單獨安裝、單獨更新與單獨驗證。

## 7. 路由契約

### 7.1 目標解析

先從使用者明確指定的產品、Agent 或模型解析目標家族。若使用者只說「委派一個
Agent／subagent」而未指定家族，目標家族預設為目前宿主可提供的 native 家族；不得
因為本機剛好安裝了另一個 CLI 就選擇外部家族。若名稱無法唯一對應，先請使用者確認，
不得猜測後啟動外部程序。

第一階段支援的產品封閉為 Claude Code 與 Codex。使用者指定其他 client 時，
Skill 必須回報「尚未支援」並停止；不得猜測命令、映射到其他產品或啟動任何
外部程序。

### 7.2 目標保真

使用者明確指定 client、Agent 或 model 時，選定的 route 必須將該目標傳入執行層，
並從宿主回傳、child runtime metadata 或外部 client 的權威 session 證據驗證實際
目標。不得以同家族的預設模型取代使用者指定模型。

native route 無法傳遞或驗證指定目標時，視為 native 能力不可用，套用下節的
fail-closed 流程；不得改用預設模型，也不得靜默降級到 external route。

### 7.3 Resume 身分與路由

resume 只接受兩種精確輸入：

1. `agent-invoke` 已記錄的精確 `operation_id`。
2. 使用者提供的精確 Claude Code／Codex session ID 或 transcript 路徑，並明確
   client；Skill 驗證成功後才建立 imported registry entry。

imported session 固定為 external route，mode 預設為 exec；只在使用者明確指定 TUI 時
記錄為 TUI。兩種 client 分別使用下列 validator：

- **Claude Code：** 接受精確 session UUID，或位於
  `~/.claude/projects/<project-slug>/<UUID>.jsonl` 的精確 transcript。必須將 workspace
  canonicalize 後導出 project slug，並驗證 UUID、transcript 與 workspace 是同一個
  session。
- **Codex：** 接受精確 session UUID，或位於 `~/.codex/sessions/` 下的精確
  rollout JSONL。以 `session_meta.payload.id` 精確比對 UUID，並驗證 session metadata 的
  workspace／cwd；不使用 prompt 子字串或 mtime 選檔。

transcript 路徑 canonicalize 後必須仍在對應 client 的原生 session root，是目前使用者
擁有的 regular file，且路徑與各個組件都不是 symlink。client／reference 不匹配、
重複 UUID 對應、路徑逸出原生 root、檔案失效或 session identity 無法唯一驗證時
fail closed。

workspace 優先取自權威 session metadata；無法取得時必須由使用者明確提供且
canonical path 已存在。model、effort 與 permission 優先取自可驗證的 session metadata；任一
維度缺失時要求使用者明確提供，並將來源記為 `user-supplied`。resume 必須在
新 turn 重送這些封存值，並驗證實際 session identity 與 model；client 無法重送或驗證
必要值時拒絕 import。

resume 必須讀取並驗證原本的 route、client、mode、model、effort、permission、workspace
與 session reference；新 turn 沿用這些值，不重新套用目前預設。使用者若要改變
client 或 model，必須建立新 invoke，不得假裝為 resume。

恢復已記錄的 external session 是明確路由覆寫：即使目前宿主與目標家族相同，
也必須恢復該 external session，不可改建 native subagent。TUI wrapper 仍存活時使用
精確 ZMX handle；wrapper 已結束但 client session 仍有效時，可建立新 wrapper，但
必須 resume 同一個 client session。

native session 只在目前宿主提供可恢復的精確 runtime handle 時恢復。Codex 使用原
subagent handle 的 follow-up 能力；Claude Code 使用原 `Agent` handle 的 resume 能力。若
handle 已失效、無法跨 host lifecycle 恢復或宿主沒有對應能力，明確回報不可恢復；
不得建立新 subagent 冒充原 session，也不得改走 external CLI。

禁止使用 `--last`、`--continue`、最新修改時間、名稱前綴、glob 或子字串搜尋選擇
session。無法得到唯一精確對應時 fail closed。

### 7.4 優先順序

每次操作只選一條 route，依下列順序判定：

1. **精確 resume：** 先依上節恢復原 route 與 session，不重新選路。
2. **明確使用者覆寫：** 使用者明確要求 CLI、exec、TUI、ZMX、外部 client 或
   persistent session 時，遵從指定模式。
3. **同客戶端 native：** 未覆寫且宿主對目標家族提供內建 subagent 時，必須使用
   native route。
4. **跨客戶端 external：** 宿主與目標家族不同時，預設使用 external exec。
5. **互動／持久需求：** 只有使用者明確要求互動、可傳訊或持久 session 時，選擇
   external TUI。
6. **native 不可用：** 原本應走 native，但目前環境沒有對應能力時，必須清楚回報
   缺少的能力並取得使用者明確同意；不得靜默降級為外部 CLI／TUI。

### 7.5 必要對應

| 目前宿主 | 目標家族 | 預設 route | 執行方式 |
|---|---|---|---|
| Codex | GPT／Codex | native | `spawn_agent`，以 `wait_agent` 等完成 |
| Claude Code | Claude | native | 內建 `Agent`，以前景或 blocking completion 等完成 |
| Codex | Claude | external exec | Claude Code exec CLI |
| Claude Code | GPT／Codex | external exec | Codex exec CLI |

使用者明確指定 external exec 或 external TUI 時，可覆寫前表；Skill 必須在執行前用
一句話揭露將使用外部程序。

### 7.6 Native route 的禁止行為

native route：

- 不得啟動 Claude Code 或 Codex CLI。
- 不得啟動 ZMX。
- 不得建立 PID、Session JSONL monitor 或外部 session handle。
- 可在 `~/.agent-invoke/` 寫入恢復所需的最小 native handle metadata，但不得建立
  external PID、ZMX 或 monitor 狀態。
- 不得讀取 external exec／TUI／monitoring reference。
- 不得固定輪詢；使用宿主的完成通知或 blocking wait。
- 使用者指定 model 時，必須傳遞並驗證實際 child model。
- 完成條件是內建 subagent 已返回本次委派結果。

### 7.7 External route 的共同行為

external route：

- 執行前確認目標 CLI；TUI 另確認 ZMX。
- 原始 prompt 先寫入 `/tmp` 下的私有 `mktemp` 目錄，不插入 shell command；交付後
  以 `shred` 清理，不長期保存。
- 只保存判定與恢復本次操作所需的最小狀態。
- external exec 是跨家族呼叫的預設；TUI 不是預設後備。
- 使用者指定 model 時，必須將 model 傳入目標 client 並驗證實際 session model。
- 必須以目標 client 的權威完成訊號取得本次 Final Answer，不以 PID 消失或畫面文字
  單獨推斷完成。
- 缺少 CLI、登入、配額或權限時回報具體阻塞，不改走另一外部模式。

### 7.8 持久狀態

狀態固定放在使用者家目錄，不寫入目前專案：

```text
~/.agent-invoke/
├── locks/
│   └── {operation_id}.lock/
└── runs/
    └── {operation_id}/
        ├── metadata.json
        ├── session-ref
        └── runtime/
            ├── owner.json
            └── active-turn.json
```

`~/.agent-invoke/`、`locks/`、`runs/`、operation 與 `runtime/` 目錄權限為 `0700`；metadata、session
reference 與 runtime 檔案為 `0600`。`operation_id` 只允許 `[A-Za-z0-9._-]+` 且不得
為 `.`／`..`；建立時
確保唯一，不覆寫既有目錄。

`metadata.json` 至少保存 route、client、mode、model、effort、permission、workspace 絕對路徑、
managed／imported 來源、建立時間與最後恢復時間。`session-ref` 只保存精確原生
session ID、transcript 路徑或 native runtime handle；不複製完整 transcript。修改狀態時
在同目錄原子寫入，不跟隨 symlink，也不寫入 LAT ledger。

launch、resume、stop、clean 與有效的 prune mutation 必須先以原子 `mkdir` 取得精確
`locks/{operation_id}.lock/`；同一 operation 已有 lock 時 fail closed。lock 只在單次狀態
transaction 期間持有，成功或失敗都由取得者移除；異常中斷後遺留的 lock 不自動
判定 stale，不自動刪除。

active carrier 由 route owner 寫入 `runtime/owner.json`，並在確認結束後移除。exec owner
至少包含 PID、process start identity、實際 executable 與隨機 ownership token；TUI owner 使用
含隨機 token 的精確 ZMX handle；native owner 使用宿主回傳的精確 runtime handle。任何
身分比對不完整、PID 已被重用、handle 不一致或 owner 狀態損壞時 fail closed；不用
`pgrep`、名稱片段或新 handle 猜測載體。

carrier 存活與 turn 執行是不同狀態。new invoke 或 resume 在短期 operation lock 內確認
沒有 `runtime/active-turn.json`，寫入含隨機 turn token、action、session identity、baseline
與建立時間的 active-turn state，再釋放 lock 並送出 prompt。第二個 invoke／resume 即使可以
取得 lock，只要 active-turn token 存在就 fail closed。

只有監控到該 token 對應 turn 的權威完成事件，或在啟動失敗且證明 prompt 未交付時，
才可重新取得 lock、比對 token 並清除 active-turn state。persistent TUI wrapper 可繼續存活；
它在 idle 時保留 owner 但沒有 active-turn token。`stop` 使用短期 lock 驗證 owner 後仍可
停止 carrier；若同時有 active turn，確認 carrier 已停止後將該 turn 記為 interrupted，再以
精確 token 清除 active-turn state。無法驗證 token 或 turn 狀態時 fail closed。

### 7.9 停止與清理

- `stop <operation_id>` 取得 operation lock 後，只在 `owner.json` 的完整身分仍與實際
  PID／start identity／executable，精確 ZMX handle，或宿主 native handle 一致時停止
  目前載體；無法證明 ownership 時拒絕發 signal。停止後確認載體結束才移除
  owner state；保留 metadata 與 session reference，不刪除 Claude／Codex 原生 session。
- `clean <operation_id>` 取得 operation lock，只接受安全的精確 ID，解析 metadata 後
  檢查 active-turn 與對應載體。任何 active-turn token 尚未由權威完成事件清除，或
  PID、ZMX 或 native Agent 仍在執行時拒絕清理，提示先 `stop`。非執行狀態使用
  `trash-put` 移除精確 run 目錄；這只刪除 registry，不刪除原生 session。
- `prune` 只列出 session reference 已不存在、metadata 損壞或 workspace 已不存在的
  registry entry，預設 dry-run。只有使用者明確確認後才逐筆 `trash-put`；
  每筆 mutation 仍需取得對應 operation lock。metadata 無法解析而無法排除 active runtime
  的 entry 只回報人工處理，不自動移除。
- 不依 7 天、30 天或其他年齡自動刪除，也不提供未受限制的 `clean --all`。
- registry 被 clean 後，使用者仍可提供精確 client 與 session reference 重新導入。

## 8. Skill 結構與 context 預算

候選結構：

```text
agent-invoke/
├── SKILL.md
├── references/
│   ├── native.md
│   ├── external-common.md
│   ├── exec.md
│   ├── tui.md
│   ├── monitoring.md
│   ├── resume.md
│   └── lifecycle.md
└── scripts/
    ├── run-exec-client.sh
    ├── monitor-session.sh
    └── manage-run-state.sh

tests/
└── agent-invoke/
```

規則：

- `SKILL.md` 是唯一 route owner，目標不超過 150 行。
- frontmatter description 以使用者意圖描述觸發時機，不把 Skill 描述成單純
  CLI／TUI wrapper。
- `SKILL.md` 必須在任何 external reference 前完成 native／external 判斷。
- 每份 reference 只處理單一已選路徑；不得重述完整路由表。
- 不建立 `references/clients.md` 相容鏡像。
- 不複製 `lat-dispatch` 的完整生命週期文字。
- scripts 只用於可重複的 state 操作，以及容易因 shell quoting、PID 或 transcript 判定
  而出錯的外部操作。native route 可使用 state helper，但不使用 external launcher 或
  monitor。
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

- `SKILL.md` 具有 exact resume → explicit override → native-first → cross-family 的固定
  優先順序。
- 使用者指定的 client／Agent／model 在 native 與 external route 都必須傳遞並驗證。
- resume 只能使用已記錄 `operation_id` 或使用者提供的精確 session reference；禁止
  `--last`、`--continue`、glob 與模糊搜尋。
- native route 明確禁止 CLI、ZMX、monitor 與 external runtime 狀態；只允許最小恢復
  metadata。
- registry 路徑、權限、原子寫入、symlink 防護與 `stop`／`clean`／`prune` 規則固定。
- carrier owner 與 active turn 是分離狀態；transaction lock 釋放後，只要 active-turn
  token 尚未由同一 turn 的權威完成事件清除，第二次 invoke／resume 與 `clean` 仍須拒絕。
- external reference 只能在 external route 選定後載入。
- Skill 不依賴或鏡像 `lat-dispatch`。
- 安裝 package 不包含 tests、fixtures、traces 或 generated reports。

### 9.2 整合測試

以可觀察的 fake client／fake ZMX 驗證：

- 跨家族預設只呼叫一次正確 exec client。
- 同家族明確 exec 覆寫只呼叫一次正確 exec client，不誤走 native 或 TUI。
- 明確 TUI 要求只建立正確 ZMX session。
- 不支援的 client 停止並回報，不啟動外部程序。
- managed exec／TUI operation 只恢復保存的原 session，不新建對話。
- Claude 與 Codex 各自的 imported validator 驗證正確 UUID／path、client mismatch、路徑逸出、
  symlink、非 regular file、重複對應與必要 metadata 缺失。合法 reference 才導入並恢復。
- native handle 可恢復時延續原 subagent；handle 失效時 fail closed，不建新 Agent 冒充。
- operation ID 路徑穿越、symlink、重複 ID、損壞 metadata 與無法唯一驗證的 session
  reference 全部 fail closed。
- 同一 operation 的 simultaneous resume、resume-vs-clean 與其他同時 mutation 由原子 lock
  確實排他；第一個 resume 釋放 transaction lock 後到 Final Answer 前，active-turn token
  仍拒絕第二個 resume 與 `clean`；遺留 lock 不自動清除。
- stale／reused PID、錯誤 ZMX handle、錯誤 native handle 與損壞 owner state 全部拒絕 stop，
  不發 signal、不清 registry。
- `clean` 對執行中載體拒絕，`prune` 預設只列出，兩者都不刪除原生 session。
- prompt 不經 shell interpolation。
- 缺少 native 能力時不會自行啟動 external process。
- external 完成與錯誤狀態可正確分類。

這層可以證明 route 與 shell 契約，但不得稱為真實 client E2E。

### 9.3 真實安裝 E2E

發布候選前，在隔離 skills home 只安裝 `agent-invoke#dev`，並明確驗證沒有
`lat-dispatch` package。每案在 disposable workspace 執行，開始前記錄 `.lat` 不存在或完整
filesystem snapshot，結束後必須仍不存在或 bytes 完全不變。native、external exec 與
external TUI 各至少一案在這個共同 gate 下成功。然後完成：

1. Codex 宿主呼叫明確指定的 GPT／Codex model：觀察到內建 subagent、實際
   child model 符合指定，且無外部程序；只允許 `~/.agent-invoke/` 的最小恢復資訊。
2. Claude Code 宿主呼叫明確指定的 Claude model：觀察到內建 Agent、實際
   child model 符合指定，且無外部程序；只允許 `~/.agent-invoke/` 的最小恢復資訊。
3. Codex 宿主呼叫指定 Claude model：觀察到正確 Claude external exec、實際
   session model 符合指定，並取得完整結果。
4. Claude Code 宿主呼叫指定 GPT／Codex model：觀察到正確 Codex external exec、
   實際 session model 符合指定，並取得完整結果。
5. 任一同宿主案例明確要求 external exec：觀察到執行前揭露、唯一正確
   exec client 呼叫、指定目標保真與完整結果，且未誤走 native 或 TUI。
6. 任一同宿主案例明確要求 TUI：觀察到指定目標保真的 external TUI，
   證明使用者覆寫有效。
7. 模擬 native 不可用：觀察到停下並說明，而非靜默啟動外部工具。
8. 呼叫 Claude Code 與 Codex 以外的 client：觀察到明確「尚未支援」結果，且無
   native、CLI、TUI 或 `.agent-invoke` 副作用。
9. Claude Code 與 Codex 各建立一個 managed external exec，再以 `operation_id` resume：
   每個子案驗證同一 client session、model、effort、permission 與 workspace，取得新 turn 結果，
   且沒有 replacement session。
10. Claude Code 與 Codex 各建立一個 managed external TUI 後 resume：每個子案都驗證
    exact session identity、封存的 model／effort／permission／workspace 與新 turn 結果；wrapper
    存活時使用原 exact handle，wrapper 已結束時建新 wrapper 但恢復同一 client session，
    不建 replacement session。
11. Claude Code 與 Codex 各導入一個使用者提供的精確 session reference 後 resume：
    每個子案驗證 client-specific validator、exact identity、封存的
    model／effort／permission／workspace、新 turn 結果與無 replacement session；另驗證錯誤
    client、逸出／symlink／無效 path 與缺少必要 metadata 均 fail closed。
12. Codex 與 Claude Code 各建立一個 native subagent 後 resume：宿主支援時延續原
    handle；另以失效 handle 驗證明確失敗，且不新建 Agent 或啟動 CLI。
13. 分別對執行中的 exec PID、ZMX 與 native carrier 執行 `clean`：均拒絕且狀態完整。
    各自以精確 ownership `stop` 後再 `clean`，驗證 run 目錄經 `trash-put` 移除、原生
    session 仍可精確導入；另驗證 reused PID、錯誤 ZMX／native handle、simultaneous resume
    與 resume-vs-clean 都 fail closed。第一個 resume 寫入 active-turn 後釋放 transaction lock，
    在 Final Answer 前嘗試第二個 resume 與 `clean`，兩者仍因相同 turn token 被拒絕，且不影響
    非目標載體。
14. 對 broken registry 執行 `prune`：預設只列出；session reference 已不存在的
    entry 明確確認後才移除；無法排除 active runtime 的損壞 metadata 只回報人工
    處理。不影響其他 operation 或原生 session。

每案只保存 route、實際工具事件、關鍵完成事件、exit status 與精簡結果；完整原始
transcript 留在臨時目錄或 CI artifact，不提交 repo。

### 9.4 Trigger 評估

使用小型、可讀的 prompt set 驗證 description：

- 至少 12 個應觸發案例：一般委派、明確 model、同宿主、跨宿主、明確 exec、明確 TUI、
  呼叫尚未支援的 client、使用 operation ID resume、使用精確 session reference resume、
  `stop`、`clean`、`prune`。
- 至少 6 個不應觸發或應轉交案例：完整 LAT 流程、只問文件、一般 shell 指令、
  無 Agent 委派需求、純 Git 操作、只要求修改目前 Agent 自己的內容。

應觸發案例必須在 fresh-agent trace 中出現 `agent-invoke` 啟用與 `SKILL.md` 讀取；
不應觸發案例不得讀取該 Skill。上述案例必須全數符合預期才通過。

每個 prompt 以 fresh agent 固定執行三次，三次都符合預期才通過。只保存每案的觸發次數
與精簡失敗摘要，raw traces 留在暫存或 CI artifact；不得為此建立新的通用 evaluator、
archive 或 schema。

## 10. 驗收條件

### QA-1：同宿主預設使用 native

Codex→GPT／Codex 與 Claude Code→Claude 的真實安裝案例都使用宿主內建 subagent；
指定 model 與實際 child model 一致，且沒有 CLI、ZMX 或 monitor 副作用。
`~/.agent-invoke/` 只能出現恢復原 native handle 所需的最小 metadata。

### QA-2：跨宿主預設使用 external exec

Codex→Claude 與 Claude Code→GPT／Codex 都啟動正確的 external exec client；
指定 model 與實際 session model 一致，取得本次 turn 的完整結果，且不進入
LAT lifecycle。

### QA-3：外部模式只能由條件選中

同宿主不會自行使用外部工具；明確要求 exec／TUI 時會揭露並遵從覆寫；native
不可用時不會靜默降級；不支援的 client 不會觸發任何執行工具。

### QA-4：與 Dispatch 完全獨立

本次 diff 中 `lat-dispatch/` 為零變更；移除或未安裝 `lat-dispatch` 時，
`agent-invoke` 仍可安裝、觸發並完成三種 route。以隔離 skills home 只安裝
`agent-invoke#dev`，並在執行前後驗證 `lat-dispatch` package 都不存在。

### QA-5：不載入完整 LAT

任何 `agent-invoke` route 都不建立 `.lat/workspace`、task ledger，不進入
Spec／Plan／review／test／QA phase。每個 installed E2E 都以 `.lat` filesystem snapshot 證明執行前後
不存在或 bytes 完全不變；native、exec 與 TUI 各至少一案必須在這個 gate 下成功。

### QA-6：Skill 維持精簡

`SKILL.md` 不超過 150 行；沒有 compatibility mirror；package 不含測試、fixture、
raw trace 或 generated evidence；fresh-agent trace 顯示每次只讀取選定 route 所需
reference。

### QA-7：真實安裝結果優先

第 9.3 節十四個案例全部有本機真實證據才可標記候選完成。mock、靜態 contract、
review 結論或 Agent 自述成功不能替代缺少的 E2E。

### QA-8：精確恢復與導入

Claude Code 與 Codex 兩者的 managed exec、managed TUI 與使用者提供的 exact external
reference，以及宿主支援的 native handle，都延續原 session、沿用封存的
model／effort／permission／workspace，並取得新 turn 結果。
失效 native handle、不安全或無法唯一驗證的 external reference 明確失敗；不新建對話、
不猜測 session、不改走其他 route。

### QA-9：可預測且可復原的清理

`stop` 只停止精確載體並保留 resume registry；`clean` 拒絕執行中 operation，並只以
`trash-put` 移除已停止的精確 registry entry；`prune` 預設 dry-run。三者都不刪除
Claude／Codex 原生 session，也不影響其他 operation；無法排除 active runtime 的損壞
metadata 不自動移除。同時 mutation 由 operation lock 排他；PID reuse、錯誤 ZMX／native
handle 或不完整 owner 證據都 fail closed，不發 signal、不清 registry。transaction lock
釋放後仍以 active-turn token 保護進行中的 turn，直到同一 turn 的權威完成事件或經證明的
未交付失敗才可清除。

## 11. 實作與發布階段

### 第一階段：獨立實作

- 只新增 `agent-invoke`、其必要 scripts 與 repo-level tests。
- `lat-dispatch` 維持 `main@5a8e76c` 的行為。
- 在本機與 `dev` 候選完成測試，不推進 `main`。

### 第二階段：使用者安裝驗證

- 使用者以 `#dev` 安裝候選。
- 依第 9.3 節執行真實案例。
- 將使用者觀察到的 route 與副作用視為最終驗收依據。

### 第三階段：另案決定整合

只有獨立 Skill 通過後，才討論：

- `lat-dispatch` 是否要引用 `agent-invoke`。
- 如何避免相容鏡像與雙份規則。
- main/dev 文件與正式發布步驟。

本 Spec 不預先決定第三階段，也不得以未來整合需求擴大第一階段。

## 12. 完成定義

本設計的成功不是「四種外部 client 都能啟動」，而是：

1. 使用者不載入完整 LAT，也能委派另一個 Agent。
2. 同客戶端優先使用內建 subagent，沒有不必要的外部程序。
3. 跨客戶端與明確覆寫仍能安全使用 external exec／TUI。
4. managed、imported external 與宿主可恢復的 native session 都能精確延續，不猜測或冒充。
5. 狀態集中於 `~/.agent-invoke/`；清理可預測、可復原，不刪除原生 session。
6. `agent-invoke` 可獨立安裝，`lat-dispatch` 零修改。
7. Skill 內容足以可靠執行，但不重複完整 Dispatch 或建立大型評估框架。
8. 真實 `#dev` 安裝行為與上述規則一致，並由使用者確認後才進入實作整合或正式
   發布討論。
