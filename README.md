# LoopAgentTeams

配合 [Superpowers](https://github.com/obra/superpowers) 規格驅動開發的多 Agent 協作技能組。

使用者提出需求後，經過互動式腦力激盪確認方向，後續的規格撰寫與審查、計劃產生、任務派發、背景執行、進度監控、結果驗收由系統自動串接，不需手動介入每個階段的銜接。遇到設計歧義或不可恢復的錯誤時會暫停請求決策。

Dispatch Agent 是協調者，驅動整個生命週期並委派工作。同宿主優先使用內建 subagent，直接等待完成通知；跨宿主才使用外部 CLI Agent 與 Session Monitor。Code executor 完成後寫回結果。每個 TASK_ID 的任務狀態與執行結果都保存在 `.lat/workspace/<TASK_ID>/`，新任務不會覆蓋舊紀錄。

## 特點

- **不綁定 Agent 框架** — 任何支援 skills 的 Agent 都能擔任 Dispatch Agent——Claude Code、Codex、hermes、OpenClaw、Pi Agent 等；同宿主使用內建 subagent，跨宿主以 YAML 工作紀錄與 CLI client 協作
- **不受單次額度限制** — 不依賴 `/goal` 等一次性自動化指令，任務以 session 持久化執行，不受 Codex 5 小時額度等限制，直到完成為止
- **額度耗盡自動換號** — 搭配 [codex-multi-auth](https://github.com/nicobailey/codex-multi-auth)，Codex 帳號配額用完時自動切換到下一個帳號，無需人工介入
- **人類可直接介入任意 Agent** — 透過 zmx session manager，隨時 attach 到任何背景執行中的 Agent（TUI 模式），即時查看進度或直接輸入訊息，不需要透過 Dispatch Agent 轉達
- **跨模型協作** — 可在不同階段召喚不同模型，例如 Opus 4.8 探索程式碼、Opus 4.6 撰寫文件、gpt-5.6-terra 編寫程式碼，依任務特性選用最適合的模型
- **三層測試隔離** — 依外部依賴將測試分為單元、整合與 E2E；裸跑只執行單元測試，整合與 E2E 必須明確指定，另以 `qa_e2e/` 保存規格驗收測試
- **相容未來計費模式** — 若 Anthropic 日後對 `claude -p`（CLI 同步模式）收費，可直接改用 TUI 模式讓 Agent 操控互動介面，不影響流程
- **Code executor 擁有完整權限** — 解決 Codex plugin for Claude Code 無法臨時授予 full-auto 權限的問題，Code executor 在獨立 session 中執行，權限由啟動時的設定決定

## 流程

```
使用者需求
    |
    v
+---------------------------+
|  spec（規格）              |
|  草稿 → 初始化 TASK_ID     |   <-- Superpowers 腦力激盪工作流
|  建立任務紀錄 → Reviewer   |       Reviewer 只報告、不改檔
|  → Dispatch 獨立裁決       |
+---------------------------+
    |
    v
+---------------------------+
|  plan（計劃）              |
|  外部 Writer → Reviewer    |   <-- Writer / Reviewer / Dispatch 三層
|  → Dispatch 獨立裁決       |       規格 + 計劃一起 git commit
+---------------------------+
    |
    v
+---------------------------+
|  dispatch（派發）          |
|  驗證任務紀錄 → 加入任務    |   <-- 一個摘要任務指向計劃檔案
|  啟動 Code executor       |       同宿主內建 subagent／跨宿主 CLI
+---------------------------+
    |
    v
+---------------------------+
|  monitor（監控）           |
|  等待內建完成通知          |   <-- 內建不輪詢；外部 CLI 才做兩層監控
|  或外部 session 完成標記   |       STALL／DRIFT_CHECK 時通知 AI 介入
+---------------------------+
    |
    v
+---------------------------+
|  test（測試與驗收）         |
|  test_executor：           |   <-- 寫整合 + E2E 測試，修到綠
|    整合 + E2E 測試         |
|  qa_executor：             |   <-- 依 QA 清單寫驗收測試至 qa_e2e/
|    驗收測試 → qa_e2e/      |       失敗回饋 test_executor 修正
|  迴圈到全過或達上限         |       結果透過 workspace 傳遞
+---------------------------+
    |
    v
  回報使用者
```

### 審查不是照單全收

Spec／Plan Reviewer 都是 report-only，只提交附證據的 finding，不直接修改文件。Dispatch 逐項查證後標記 `ACCEPT`、`REJECT` 或 `USER_DECISION`；即使 Reviewer 回覆 `PASS`，仍會對需求範圍、QA 可測試性與高風險假設執行 focused gap scan。只有 Reviewer 與 Dispatch 裁決都完成後，該階段才通過。

## 安裝

`lat-dispatch` 的統一 Session Monitor 支援 GNU/Linux 與 macOS。

前置需求：

| 工具 | 用途 | 必要性 |
|------|------|--------|
| [Node.js](https://nodejs.org/) 18+ | 執行 `npx skills` 安裝技能 | 必要 |
| git | 版本控制、提交規格與計劃 | 必要 |
| jq、uuidgen、trash-cli | Session 解析、UUID 與安全清理 | `lat-dispatch` 必要 |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Dispatch Agent 與 Code executor 的執行環境之一 | 至少裝一個 |
| [Codex CLI](https://github.com/openai/codex) | Code executor 的執行環境之一，也用於 spec/plan 審查 | 至少裝一個 |
| [zmx](https://github.com/neurosnap/zmx) | 長時任務的背景 session 管理（見 [zmx 是什麼](#zmx-是什麼)） | TUI client 需要 |
| [codex-multi-auth](https://github.com/nicobailey/codex-multi-auth) | Codex 多帳號切換，配額耗盡時自動切換 | 選用 |

GNU/Linux（Debian／Ubuntu）安裝 Monitor 相依套件：

```bash
sudo apt-get update
sudo apt-get install -y jq uuid-runtime trash-cli
```

macOS 已內建 `uuidgen`；其餘相依套件可用 Homebrew 安裝：

```bash
brew install jq trash-cli
```

```bash
# 安裝 Superpowers skills（腦力激盪、規格撰寫等基礎工作流）
npx skills add obra/superpowers

# 安裝 LoopAgentTeams skills
npx skills add ouob-tw/LoopAgentTeams
```

更新已安裝的 skills 到最新版本：

```bash
npx skills update
```

長時任務需要 zmx（發行檔為 tar.gz，內含單一執行檔）：

```bash
ZMX_VERSION=0.6.0
mkdir -p ~/.local/bin

# Linux x86_64
curl -fsSL "https://github.com/neurosnap/zmx/releases/download/v${ZMX_VERSION}/zmx-${ZMX_VERSION}-linux-x86_64.tar.gz" | tar -xz -C ~/.local/bin

# macOS Apple Silicon
curl -fsSL "https://github.com/neurosnap/zmx/releases/download/v${ZMX_VERSION}/zmx-${ZMX_VERSION}-macos-aarch64.tar.gz" | tar -xz -C ~/.local/bin
```

其他架構（Linux aarch64、macOS Intel）將檔名中的架構改為 `linux-aarch64` 或 `macos-x86_64`。最新版本見 [zmx releases](https://github.com/neurosnap/zmx/releases)。

## 用法

在任何支援 skills 的 Code Agent 中觸發 `lat-dispatch`，會自動從腦力激盪開始跑完整流程：

```
lat-dispatch 幫我做一個使用者登入功能
```

可以指定各階段的 client 設定：

```
spec 用 codex-exec 審查，code 用 claude-tui sonnet 4.6 medium
```

Code executor 通常由 Dispatch 自動啟動，也可以手動觸發 `lat-code`。

### 外部 TUI 執行中查看進度

Code executor 透過外部 TUI 在背景跑時，可以用 zmx 指令查看：

| 指令 | 說明 |
|------|------|
| `zmx list` | 列出所有背景 session |
| `zmx attach <session>` | 即時檢視 Code executor 執行畫面（`Ctrl+\` 脫離） |
| `zmx tail <session>` | 追蹤 session 輸出 |
| `zmx history <session> \| tail -20` | 查看最近輸出 |

## 架構

```
lat-dispatch/           Dispatch Agent 技能（協調者）
  SKILL.md                  流程定義、監控邏輯
  references/
    clients.md               Client 指令格式、內建預設、監控腳本、Session 恢復
    yaml-schema.md           每個 TASK_ID 的任務與結果格式

lat-code/               Code executor 技能（執行者）
  SKILL.md                  任務讀取、實作、結果寫入

three-tier-testing/     測試架構技能（三層分離）
  SKILL.md                  通用原則、歸屬判斷、範圍判斷
  references/
    python.md               pytest 設定與指令
    typescript.md           Vitest + Playwright 設定與指令

.lat/                  執行時工作目錄（gitignore）
  logs/
    <TASK_ID>/
      <agent_id>.stdout.jsonl
      <agent_id>.stderr.log  exec runtime 診斷紀錄
  workspace/
    <TASK_ID>/
      tasks.yaml            不刪除的 phase/instance 生命週期紀錄
      results.yaml          不刪除的執行結果歷史
      qa-results.md         QA 驗收證據
      prompts/              可依 retention 清理的暫存 prompt
```

## 支援的派發方式

同宿主優先使用內建 subagent：Codex → GPT／Codex、Claude Code → Claude。內建 worker 完成時直接通知 Dispatch，不以固定週期查詢狀態。

跨宿主使用下列外部 Client：

| Client      | 執行方式                       | 適用場景        |
| ----------- | ------------------------------ | --------------- |
| claude-tui  | zmx 背景執行 + claude TUI     | 長時任務        |
| claude-exec | claude -p（同步）              | Agent 直接呼叫  |
| codex-tui   | zmx 背景執行 + codex TUI      | 長時任務        |
| codex-exec  | codex exec（同步）             | Agent 直接呼叫  |

> **TUI（Terminal UI）**：在終端機中運作的互動式文字介面，可即時交互與顯示執行狀態。

### Exec runtime 診斷

外部 exec client 會將每次執行的原始 runtime 保存至 `.lat/logs/<TASK_ID>/`：

- `<agent_id>.stdout.jsonl`：保留 client 的原生結構化事件，外層加入 `captured_at`、`stream` 與 `event`。
- `<agent_id>.stderr.log`：保留人類可讀的 stderr，每行加入 RFC 3339 UTC 秒級時間。
- launch 與 resume 都會寫入 boundary；resume 只會附加到原檔案，不會覆寫既有紀錄。

Session JSONL 仍是完成狀態與 Final Answer 的唯一依據；正常完成不讀 runtime log。只有 Session Monitor 無法判斷或回報異常時，Dispatch 才先以 `tail -n 7` 查看當次 FD2 尾端，資訊不足再擴大為 `tail -n 20`，後續範圍由 Agent 依錯誤內容判斷，避免一次讀入整份 sub-agent runtime。

runtime logs 預設保留 60 天；清理前會先確認 ownership lock、PID 與 launcher 狀態，無法安全判定時停止清理。

## 外部 CLI 兩層監控

外部 CLI 以存活檢查與偏離檢查取代硬性 timeout；內建 subagent 直接等待完成通知，不使用本節監控：

| 階段       | 存活檢查（工具是否正常運行）       | 偏離檢查（是否在做對的事）     |
| ---------- | ------------------------------ | ------------------------------ |
| spec/plan  | 10 分鐘 session JSONL 無 mtime 變更 | 30 分鐘讀 session 判斷方向  |
| code       | 15 分鐘 session JSONL 無 mtime 變更 | 1 小時讀 session 判斷方向   |
| test/qa    | 10 分鐘 session JSONL 無 mtime 變更 | 1 小時讀 session 判斷方向   |

## zmx 是什麼

[zmx](https://github.com/neurosnap/zmx) 是輕量級的 terminal session 持久化工具。與 tmux 最大的理念差異在於：zmx 不做視窗管理（pane/window/tab），而是讓每個 session 是獨立的原生滾動終端。本專案用它來背景執行 Code executor，Dispatch Agent 透過 zmx 指令監控進度與讀取輸出。

跟 tmux 的差異：

| | tmux | zmx |
|---|---|---|
| 核心理念 | 終端多工器，管理 pane/window/tab | 原生滾動的 session 持久化 |
| 視窗管理 | 內建分割、切換、佈局 | 不做，每個 session 獨立存在 |
| 滾動 | tmux 自己的 scrollback buffer | 直接用終端模擬器的原生滾動 |
| 輸出擷取 | `capture-pane` 等複雜操作 | `zmx history` 直接取得完整 scrollback |
| 背景執行 | `send-keys` + detach | `zmx run -d` 一行搞定 |
| 追蹤輸出 | 需要 attach 到 pane | `zmx tail` 即時追蹤，不需 attach |

## 授權

[MIT](LICENSE)
