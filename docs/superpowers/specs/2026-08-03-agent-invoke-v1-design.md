# Agent Invoke V1 收斂設計規格

日期：2026-08-03
狀態：草案，待實作
取代關係：本文取代 `docs/superpowers/specs/2026-08-01-agent-invoke-design.md` 的
**驗收與發布範圍**（第 9、10、11 節）。該文件的行為契約（第 6、7、8 節）仍然有效，
本文以引用方式沿用，不重述。舊文件保留為歷史，不得刪除或改寫。

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

- 不改動 `agent-invoke/` 下任何檔案（除非驗證揭露真實回歸）。
- 不刪除 `tests/agent-invoke/` 下任何既有檔案。
- 不碰 `lat-dispatch/`。
- 不推進 `main`，不做正式發布。
- 不重跑或改寫舊 ledger `2026-08-01-agent-invoke-design`。

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

- 6 個核心決策案例（對應 V1-A 至 V1-F 的路由面）
- × 2 clients（claude、codex）
- × 1 repetition
- = **12 turns**（原設計為 14 cases × 2 clients × 2 reps = 56）

重複執行只在懷疑不穩定時追加，不列為預設規模。
沿用既有 `tests/agent-invoke/e2e/run-trigger-eval.sh` 的 runner 與 envelope 契約，
只縮小 case 清單。

**Codex 額度處理**：若 Codex 因額度失敗（`thread.started` → `turn.started` → `error` →
`turn.failed` 且無 agent message），處置方式是**更換 Codex 帳號後重跑**。不得記為
blocked、不得以 Claude 側證據替代、不得降級為 deterministic-only。

### 6.3 Installed smoke（縮編）

安裝到真實位置後執行 6 案：

| 案 | 內容 | 對應 |
|---|---|---|
| S1 | Claude host → native Claude subagent | V1-A |
| S2 | Codex host → native Codex subagent | V1-A |
| S3 | Claude host → Codex external exec | V1-B |
| S4 | Codex host → Claude external exec | V1-B |
| S5 | S3 的 operation 以封存 handle resume | V1-D |
| S6 | S3 的 operation 執行 stop 後 clean | V1-E |

每案必須驗證：`.lat/workspace` 未被建立（QA-5 精神）、`~/.agent-invoke/` 只出現預期的
最小 metadata、無非預期的 ZMX session 殘留。

V1 smoke 另寫一支獨立 script，**不修改** 既有 `tests/agent-invoke/e2e/run-installed-e2e.sh`
（795 行、14 group）與 `validate-installed-evidence.sh`。那兩支保留在 repo 作為 V1.1 素材。

### 6.4 V1 不做

nonce／manifest／provenance chain、`evidence-summary.json`、operation snapshot 比對、
14-group installed matrix、remote `dev` E2E、`test_executor`／`qa_executor` 獨立 phase。

## 7. 安裝

沿用本機既有慣例：本體在 `~/.agents/skills/`，Claude 以 symlink 掛載。

```text
~/.agents/skills/agent-invoke         實體目錄（本體）
~/.claude/skills/agent-invoke   ->    ../../.agents/skills/agent-invoke
~/.codex/skills/agent-invoke          實體目錄（Codex 不吃 symlink 慣例，獨立複製）
```

安裝內容只含 skill 目錄本身（`SKILL.md` + `references/` + `scripts/`）。不安裝
`tests/`、fixtures 或任何 repo-root 文件；skill 內不得連結到 repo 的 `docs/`。

兩側安裝後都必須驗證 skill 能被該 host 觸發。

## 8. 驗收條件

| 代號 | 條件 |
|---|---|
| A-1 | 6.1 deterministic 全部 PASS。`agent-invoke/` 預期對 `HEAD` 零 diff；若驗證揭露真實回歸而必須修改，該修改須有對應 failing test 佐證，並在 evidence 中列出 |
| A-2 | 6.2 的 12 turns 全部 PASS，claude 與 codex 各 6 turns 都有真實 envelope |
| A-3 | 6.3 的 S1–S6 全部通過，且每案 `.lat` 未變、`~/.agent-invoke/` 內容符合預期 |
| A-4 | `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills` 三處安裝狀態正確，兩側可觸發 |
| A-5 | `lat-dispatch/` 對 `main` 零 diff；移除 `lat-dispatch` 後 `agent-invoke` 仍可運作 |
| A-6 | experimental 四項在 evidence 中明確標記為未驗證 |
| A-7 | reviewer 對本輪 diff verdict 為 PASS |

全數滿足 → push `dev`。`main` 另案，需要完整證據，本 Spec 不涵蓋。

## 9. 完成定義

V1 的成功不是「所有 route 都被證明」，而是：

1. 使用者在 Claude 或 Codex 任一側，不載入完整 LAT，就能委派另一個 Agent。
2. 同家族優先用內建 subagent，跨家族用 external exec，兩者都有真實證據。
3. 精確 resume 與安全 stop／clean 有真實證據。
4. 未驗證的部分被誠實標記，不假裝完成。
5. `dev` 上有一個可被實際使用的候選版本，而不是一份停在 `partial` 的 ledger。
