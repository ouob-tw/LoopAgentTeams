# Agent Invoke V1 收斂設計規格

日期：2026-08-03
狀態：草案，待實作
取代關係：本文取代 `docs/superpowers/specs/2026-08-01-agent-invoke-design.md`（下稱「舊 Spec」）
的**驗收與發布範圍**，即舊 Spec 的第 9（測試策略）、10（驗收條件）、11（實作與發布階段）節。
舊 Spec 的行為契約，即其第 6（架構邊界）、7（路由契約）、8（Skill 結構與 context 預算）節，
仍然有效，本文以引用方式沿用，不重述。舊文件保留為歷史，不得刪除或改寫。

本文中未加「舊 Spec」字樣的節次編號，一律指本文自己的節次。

## 1. 為何需要本文

`agent-invoke` 的實作已經 review-clean：`SKILL.md` 55 行、7 個 reference 共 204 行、
4 個 script 共 514 行，六個 integration suite、ShellCheck、Agent Skills validation 全部 PASS，
最後一輪 reviewer verdict 為 PASS。

但整個任務停在 `partial`，六個 code executor 全部終止。卡住的不是產品，是外圍的驗證與
發布機器：56-turn behavior proxy、14-group installed E2E、nonce／manifest／provenance、
operation snapshot、多表面 refusal evidence。舊 Plan 的 Task 6 把 persistent-state migration、
session import、transcript completion、PID／ZMX／native lifecycle、installed provenance 與
remote publishing 綁成單一 review unit，導致五輪 reviewer 才逐層收斂。

本文的目的只有一個：**在不改動產品實作的前提下，重新定義一組能實際跑完的驗收條件**，
讓已完成的工作能落地到 `dev`。

## 2. 目標

1. `agent-invoke` 以現有實作安裝到 Claude 與 Codex 兩側，並能真實觸發。
2. 六項核心行為有真實證據支撐。
3. 驗證規模控制在單一 executor 可在一輪內跑完。
4. 產出可推 `dev` 的候選版本。

## 3. 非目標

- **不改動 `agent-invoke/` 下任何檔案，無例外。** 驗證若揭露產品回歸，V1 判定為 FAIL，
  另開 product-fix TASK_ID 處理；本 Spec 的任何流程都不授權修改產品套件。
- 不刪除或改寫 `tests/agent-invoke/` 下任何既有斷言。測試樹**只增不減**：可新增斷言與
  evidence 欄位，不得移除、放寬或改寫既有邏輯（見 6.4）。
- 不碰 `lat-dispatch/`。
- 不推進 `main`，不做正式發布。
- 不重跑或改寫舊 ledger `2026-08-01-agent-invoke-design`。
- 依使用者 2026-08-04 明確決定，本 TASK_ID **跳過 LAT 的 `test_executor` 與 `qa_executor`
  phase**。V1 的驗證由 code_executor 依本 Spec 第 6 節執行，Dispatch 逐項核對實際輸出。

## 4. 產品邊界

產品即現有套件，一行不改：

```text
agent-invoke/
├── SKILL.md                          55
├── references/{native,exec,tui,resume,lifecycle,monitoring,external-common}.md   204
└── scripts/{manage-run-state,monitor-session,resolve-session-reference,run-exec-client}.sh   514
```

行為契約依舊 Spec 第 6、7、8 節。持久狀態依舊 Spec 7.8（`~/.agent-invoke/` operation tree、
`0700`／`0600` 權限、operation lock、owner／active-turn 分離）。停止與清理依舊 Spec 7.9。

## 5. V1 範圍切分

### 5.1 必須驗證（阻擋 push `dev`）

| 代號 | 行為 |
|---|---|
| V1-A | native-first routing：同宿主同家族走內建 Agent，無 CLI／ZMX 副作用 |
| V1-B | cross-family exec：Claude → Codex 走 external exec，取得完整 turn 結果 |
| V1-C | explicit external override：明確要求時揭露並遵從；native 不可用時不靜默降級 |
| V1-D | exact external session resume：只以封存 handle 延續原 session |
| V1-E | 單一 operation 的 stop / clean：ownership 可證才動作，否則 fail closed |
| V1-F | `~/.agent-invoke` 最小 identity registry：路徑、權限、metadata 欄位正確 |

### 5.2 標為 experimental（程式碼保留，Spec 明示未驗證，不阻擋 `dev`）

- TUI resume（`references/tui.md`、ZMX carrier 路徑）
- `prune`
- native handle 跨 session 持久恢復
- 任意匯入的歷史 external session

這四項的實作與既有測試全部保留。`SKILL.md` 不改，但本 Spec 與 V1 evidence 必須明確
記載它們未經真實驗證，不得在 release note 或 ledger 中宣稱已驗收。

## 6. 驗證策略

三層，全部必須 PASS。

### 6.1 Deterministic（既有，不新增）

`tests/agent-invoke/integration/` 六個 suite 全數執行，加上 Bash syntax、ShellCheck、
Agent Skills validation、`SKILL.md` 行數 ≤ 150、package boundary、`lat-dispatch/` 零 diff。
這些已經 PASS，V1 只是重跑確認未回歸。

### 6.2 Decision proxy（縮編）

以 fresh agent turn 驗證路由決策，不讀 client 原始 JSONL，只取 decision envelope。

- 8 個決策案例：

  | case id | 對應 |
  |---|---|
  | `generic-native` | V1-A |
  | `cross-client` | V1-B |
  | `explicit-exec` | V1-C |
  | `reference-resume` | V1-D |
  | `stop` | V1-E |
  | `full-LAT` | QA-6 負向：不得接手完整 LAT 流程 |
  | `non-delegation-request` | QA-6 負向：純資訊要求不得委派 |
  | `direct-work` | QA-6 負向：要求本代理自己動手時不得委派 |

- × 2 clients（claude、codex）
- × 1 repetition
- = **16 turns**（原設計為 14 cases × 2 clients × 2 reps = 56）

三個負向案例缺一不可：QA-6 同時要求三種情境都不觸發，而 installed case 的
`lat_unchanged` 只能證明 `.lat` 未變，證明不了「沒有發生錯誤委派」。

`clean` 不列入 proxy：它與 `stop` 是幾乎相同的決策（同為 `route: none`、
`decision_scope: agent-invoke`），實際覆蓋由 installed `lifecycle` case 與
`state-manager-test.sh` 承擔。`unsupported-client`、`exact-claude-model`、`explicit-tui`、
`operation-resume`、`prune` 不直接對應 V1 必驗行為，列為 optional、non-blocking，V1 不執行。

重複執行只在懷疑不穩定時追加，不列為預設規模。
沿用既有 `tests/agent-invoke/e2e/run-trigger-eval.sh` 的 runner 與 envelope 契約，
只縮小 case 清單。

**Codex 額度處理**：若 Codex 因額度失敗（`thread.started` → `turn.started` → `error` →
`turn.failed` 且無 agent message），處置方式是**更換 Codex 帳號後重跑**。不得記為
blocked、不得以 Claude 側證據替代、不得降級為 deterministic-only。

### 6.3 Installed smoke（縮編）

既有 `tests/agent-invoke/e2e/run-installed-e2e.sh` 已是 `--case CASE_ID` 單案 runner，
支援 14 個 case ID。V1 不新寫 script，執行其中 8 個 case：

| 案 | runner case ID | 對應 |
|---|---|---|
| S1 | `claude-native` | V1-A |
| S2 | `codex-native` | V1-A |
| S3 | `claude-to-codex-exec` | V1-B |
| S4 | `codex-to-claude-exec` | V1-B |
| S5 | `same-host-exec` | V1-C 明確 override |
| S6 | `native-unavailable` | V1-C 不靜默降級 |
| S7 | `managed-exec-resume` | V1-D |
| S8 | `lifecycle` | V1-E |

S5 與 S6 是 V1-C 的兩個必要子行為，兩者缺一則 V1-C 只剩 decision envelope，沒有
真實執行證據。S6 走既有的 `validate_preexecution_refusal`，該函式已斷言「零 carrier
事件」與「protected state 前後不變」，正是 QA-3 需要的證據。

**`lifecycle` 是硬性 gate，沒有 fallback。** S8 任一子步驟失敗即 V1 不通過，記錄實際
失敗點後另案處理，不得改寫 runner 讓它通過，也不得以 deterministic 證據替代。這不使
TUI resume 脫離 5.2 的 experimental 標記：S8 驗證的是 lifecycle 的 stop／clean，不是
experimental 的 TUI resume 能力。

其餘 6 個 case ID（`same-host-tui`、`unsupported-client`、`managed-tui-resume`、
`imported-resume`、`native-resume`、`prune`）留給 V1.1，V1 不執行。

### 6.4 只增不減的既有 evidence 補強

既有 runner 與 validator 對某些 V1 必驗行為只驗到「狀態正確」，驗不到「行為真的發生」。
依使用者 2026-08-04 決定，允許對 `tests/agent-invoke/e2e/` **只增不減**地補強：新增斷言與
evidence 欄位，不得移除、放寬或改寫既有邏輯。`agent-invoke/` 依舊一行不改。

必要的補強共四項：

| 編號 | 現況缺口 | 補強 |
|---|---|---|
| E-1 | native case 的 pass predicate 只檢查 route／mode／model／completion，未排除外部 carrier | 對已寫入 evidence JSON 的 `tool_events` 加「零 exec／ZMX carrier」斷言。此項不需改 runner，可由外部 jq 斷言完成 |
| E-2 | `result_excerpt` 只用於比對拒絕字串，未寫入 evidence，也不在 pass predicate | 委派內容改用固定且不含敏感資訊的 marker，evidence 增加單一布林 `result_returned`，並納入 pass predicate |
| E-3 | `managed-exec-resume` 與單次 exec case 共用 predicate，只要求一個 operation、一次 completion | 增加兩 turn 的 session identity、設定與 baseline 比對 |
| E-4 | lifecycle validator 只驗成功／失敗兩個 operation 的 identity 與 stop-intent 清除 | 增加三個有界斷言：非目標 operation snapshot 不變、stop 後可用相同 session identity 開新 turn、clean 前後原生 session sentinel 不變 |

補強只針對上述四項缺口，不擴張為新的 provenance 層。

### 6.5 V1 不再建造

不新增任何 evidence 機器：不做 `evidence-summary.json` 彙總、不擴充 provenance chain、
不做 operation snapshot 比對層、不跑 14-group installed matrix、不做 remote `dev` E2E。
依使用者 2026-08-04 明確決定，不設 `test_executor`／`qa_executor` phase。

既有且已 review 的機制（`run-installed-e2e.sh` 內的 nonce manifest 與
`validate-installed-evidence.sh`）照常使用，不視為新建造；6.4 的四項補強是對這些既有
機制的斷言增補，同樣不視為新建造。

## 7. 安裝

沿用本機既有慣例：本體在 `~/.agents/skills/`，Claude 以 symlink 掛載。

```text
~/.agents/skills/agent-invoke         實體目錄（本體）
~/.claude/skills/agent-invoke   ->    ../../.agents/skills/agent-invoke
~/.codex/skills/agent-invoke          實體目錄（Codex 不吃 symlink 慣例，獨立複製）
```

安裝內容只含 skill 目錄本身（`SKILL.md` + `references/` + `scripts/`）。不安裝
`tests/`、fixtures 或任何 repo-root 文件；skill 內不得連結到 repo 的 `docs/`。

兩側安裝後都必須驗證 skill 能被該 host 觸發。**觸發驗證必須在 repository 以外的乾淨
工作目錄執行**，且證據必須是 host 自身的 skill activation 事件——不能只看代理是否「說得
出」路由名稱。在 repo 目錄下提問時，代理可以直接讀 `agent-invoke/SKILL.md` 而完全沒有
載入已安裝的 skill，那種回答是 false positive。

## 8. 驗收條件

| 代號 | 條件 |
|---|---|
| A-1 | 6.1 deterministic 全部 PASS，且 `agent-invoke/` 對 commit `6031333` 的內容零 diff（`git diff 6031333 -- agent-invoke/` 無輸出）。產品套件出現任何 diff 即 A-1 FAIL，沒有例外條款 |
| A-2 | 6.2 的 16 turns 全部 PASS，claude 與 codex 各 8 turns 都有真實 envelope，含三個負向案例 |
| A-3 | 6.3 的 S1–S8 全部通過（`lifecycle` 無 fallback），且每案 `.lat` 未變、`~/.agent-invoke/` 內容符合預期 |
| A-4 | 三處安裝狀態正確；兩側觸發驗證在 repo 外的乾淨工作目錄執行，並取得 host 自身的 skill activation 證據 |
| A-5 | `lat-dispatch/` 對 `main` 零 diff；移除 `lat-dispatch` 後 `agent-invoke` 仍可運作 |
| A-6 | experimental 四項在 evidence 中明確標記為未驗證 |
| A-7 | 6.4 的 E-1 至 E-4 補強已完成，且 `tests/agent-invoke/` 的既有斷言零移除、零放寬 |
| A-8 | 新 ledger `.lat/workspace/2026-08-03-agent-invoke-v1-design/` 的 code task 為終端狀態；舊 ledger `2026-08-01-agent-invoke-design/` 的 `tasks.yaml` 與 `results.yaml` 內容與本輪開始時逐位元組相同 |
| A-9 | reviewer 對本輪 diff verdict 為 PASS，且 Dispatch 對每個 finding 完成裁決 |

全數滿足 → push `dev`。`main` 另案，需要完整證據，本 Spec 不涵蓋。

## 9. 驗收清單（QA）

以使用者可觀察的行為描述目標。第 8 節的 A-1 至 A-9 是流程 gate；本節是產品驗收。

### QA-1 同家族委派不多開程式

**Q：** 使用者在 Claude Code 裡要求把一件唯讀的小工作交給另一個 Claude 代理處理。工作被交出去、結果被帶回來，而且過程中沒有另外開起任何外部程式或終端機視窗。在 Codex 裡對 Codex 代理提出同樣要求時，行為一致。

**A：** native route。證據：installed case `claude-native` 與 `codex-native`，通過條件為
`route == native`、`mode == native`、model 非空、有 authoritative completion，**外加 E-1 的
零 external carrier 斷言**——對該案 evidence JSON 的 `tool_events` 斷言不存在 exec carrier
或 `zmx` 命令。少了 E-1，本項無法區分「用了 native」與「用了 native 又多開一個外部程式」。
另有 decision proxy case `generic-native`。

### QA-2 跨家族委派可以取回結果

**Q：** 使用者在 Claude Code 裡要求把一件唯讀的小工作交給 Codex 代理，或在 Codex 裡交給
Claude 代理。工作確實交給了對方家族的代理，而且這一次的結果被完整帶回來給使用者。

**A：** cross-family external exec。證據：installed case `claude-to-codex-exec` 與
`codex-to-claude-exec`，通過條件為 `route == external`、`mode == exec`、model 可辨識、
有 authoritative completion，**外加 E-2 的 `result_returned == true`**——委派內容使用固定且
不含敏感資訊的 marker，host 最終回覆必須含該 marker。少了 E-2，完成事件存在不等於
結果真的回到使用者手上。另有 decision proxy case `cross-client` 與
`tests/agent-invoke/integration/exec-client-test.sh`。

### QA-3 明確指定才走外部，沒指定不會自作主張

**Q：** 使用者明確說「用外部方式跑」時，同家族的工作也照外部方式執行，並且讓使用者知道
選了哪一條路。使用者沒有這樣說時，同家族工作不會自己改用外部方式；內建方式不能用時，
系統直接說明並停下來，而不是默默換一條路。

**A：** explicit override 與 no-silent-downgrade，兩個子行為各有一個 installed case。
證據：installed case `same-host-exec`（明確要求時同家族也走 external exec，且證明恰好一個
外部 carrier 執行、native 與 TUI 都沒有）、installed case `native-unavailable`
（native 不可用時在建立任何 state 或 carrier 之前就拒絕，走既有
`validate_preexecution_refusal`，該函式斷言 `tools` 陣列長度為零且 protected state
前後 `diff -qr` 相同）、decision proxy case `explicit-exec`。

先前版本引用 `route-integration-test.sh` 的 override／refusal 斷言，該引用不成立：
該檔的 `expect_fail` 全部針對 ZMX owner、seal 與 stop 的 lifecycle state，沒有 explicit-exec
或 native-unavailable 的斷言。已改為上述兩個 installed case。

### QA-4 接續的是同一段對話

**Q：** 使用者拿著上一次委派回傳的那個識別碼，要求「接著剛才那個繼續」。接下去的是同一段
對話，沿用當初的設定，而不是重新開一段新的。使用者給的識別碼無效或指不到唯一一段對話時，
系統直接說失敗，不會另外開一段來頂替。

**A：** exact resume，resume-only 且失效即拒絕。證據：installed case `managed-exec-resume`
**外加 E-3 的兩 turn 比對**——第二個 turn 的 session identity 與 model／effort／permission
必須與第一個 turn 相同，且第二個 turn 必須產出自己的結果。少了 E-3，該 case 與單次 exec
共用同一個 pass predicate（只要求一個 operation、一次 completion），無法區分「精確接續」
與「重新開一段」。另有 decision proxy case `reference-resume` 與
`tests/agent-invoke/integration/session-reference-test.sh` 的 symlink 拒絕與不明確 reference 拒絕。

### QA-5 停止與清除只影響指定的那一次

**Q：** 使用者要求停掉某一次委派時，只有那一次被停掉，其他正在進行的不受影響，而且之後
還能用原識別碼接續。使用者要求清除某一次的紀錄時，若那一次還在跑，系統拒絕並要求先停止。
不論停止或清除，Claude／Codex 本身的對話紀錄都不會被刪掉。

**A：** ownership-verified stop 與 fail-closed clean。證據：installed case `lifecycle`
（stop 後 intent 消失、clean 成功；本案為硬性 gate，無 fallback）**外加 E-4 的三個有界斷言**
——非目標 operation 的 snapshot 前後不變、stop 之後能以相同 session identity 開始新 turn、
clean 前後原生 session sentinel 不變。這三項分別對應 Q 裡的「其他不受影響」「之後還能
接續」「原生紀錄不會被刪掉」；少了 E-4，現有 validator 只驗到成功與失敗兩個 operation 的
identity 與 stop-intent 清除，證明不了那三件事。另有 decision proxy case `stop` 與
`tests/agent-invoke/integration/state-manager-test.sh` 的 PID reuse、handle 不符、
owner 證據不完整三種 fail-closed 斷言。

### QA-6 不該接手的時候不接手

**Q：** 使用者要求的是完整的規格／計畫／審查／測試流程時，這個功能不會把工作搶過去自己
處理。使用者只是問問題，或要求現在這個代理自己動手做，也不會有任何工作被交出去。

**A：** decision scope 界線，Q 裡的三種情境各有一個負向 proxy case：`full-LAT`
（`reason_code == lat-workflow`）、`non-delegation-request`（`reason_code ==
non-delegation-request`）、`direct-work`（`reason_code == direct-work`），三者的
`decision_scope` 皆為 `other`、`route` 皆為 `none`。三案缺一不可。另有
`agent-invoke/SKILL.md`「先正規化請求」最後一條與
`tests/agent-invoke/integration/skill-contract-test.sh` 的 scope 斷言。

每個 installed case 的 `lat_unchanged == true` 列為輔助證據而非主要證據：它只能證明
`.lat` 目錄未變，無法證明沒有發生錯誤的委派。

### QA-7 安裝後兩邊都真的用得到

**Q：** 使用者在 Claude Code 和 Codex 兩邊各開一個與這個專案無關的工作目錄，提出會用到
委派的請求，兩邊都真的載入並使用了已安裝的功能，而不只是檔案放在那裡。

**A：** 兩側安裝與觸發驗證，且必須排除 false positive。證據：（1）三個安裝路徑的 `ls -ld`
與 sha256 清單；（2）觸發驗證在 repository 以外的乾淨工作目錄執行；（3）證據是 host 自身
的 skill activation 事件，不是代理「說得出路由名稱」。在 repo 目錄下提問時代理可以直接
讀 `agent-invoke/SKILL.md` 而完全沒有載入已安裝 skill，那種回答不採計。

### QA-8 未驗證的部分被誠實標示

**Q：** 使用者讀了這一版的說明後，能明確知道哪些能力這一版沒有被驗證過，不會誤以為
全部都經過確認。

**A：** experimental 標記。證據：本 Spec 第 5.2 節、Plan Task 4 Step 5 產出的 evidence
文件中列出 TUI resume、`prune`、native handle 持久恢復、任意 session import 四項為未驗證。

## 10. 完成定義

V1 的成功不是「所有 route 都被證明」，而是：

1. 使用者在 Claude 或 Codex 任一側，不載入完整 LAT，就能委派另一個 Agent。
2. 同家族優先用內建 subagent，跨家族用 external exec，兩者都有真實證據。
3. 精確 resume 與安全 stop／clean 有真實證據。
4. 未驗證的部分被誠實標記，不假裝完成。
5. `dev` 上有一個可被實際使用的候選版本，而不是一份停在 `partial` 的 ledger。
