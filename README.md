# LoopAgentTeams

以 Matt skills 執行各階段工作，由 LAT 協調多 Agent 的規劃、派工、整合與驗收。

使用者確認 Spec 後，主控在既有授權內持續推進；只有需求、範圍、風險取捨或明確保留的核准事項需要使用者回答。

## 流程

```text
討論 → Spec → 使用者確認 → Tickets → 派工與實作 → 整合驗證 → QA → 交付
```

- **主控**：管理進度、分工、授權與交接；實作與 QA 分開委派。
- **階段技能**：`grill-with-docs`、`to-spec`、`to-tickets`、`implement`、`code-review`；需要時加入 `prototype`、`wayfinder`。
- **Agent 協作**：原生 Subagent 使用當前 client 的能力；外部 Agent 透過 HCOM 協調，可跨 client 或讓使用者直接互動。
- **整合驗證**：平行派工前協調共用檔案，整合後核對驗收條件、保留檔案與測試證據；合併無衝突不等於驗證通過。
- **三層測試**：單元、整合與 E2E 分開執行；QA 操作真實應用，必要驗證未執行時不宣告完成。

## 安裝

技能依來源放在 `skills/local/`（LAT、three-tier-testing）與 `skills/matt/`（Matt skills 副本）。

| 工具 | 用途 |
| --- | --- |
| Git | 版本控制與獨立 worktree |
| Bun | 執行下方 `bunx` 安裝指令 |
| [HCOM](https://github.com/aannoo/hcom) | 跨 Agent client 通訊與協作 |
| [skills CLI](https://github.com/vercel-labs/skills) | 安裝與更新技能，以 `bunx skills` 執行 |
| Agent client（Claude Code／Codex 等） | 載入技能並執行任務 |

先用原生 skills 指令全域安裝 LAT 與本 repo 收錄的技能至 Claude Code + Codex：

```bash
bunx skills add ouob-tw/LoopAgentTeams \
  --skill lat three-tier-testing to-spec to-tickets implement grill-with-docs wayfinder handoff \
  --skill setup-matt-pocock-skills triage to-questionnaire \
  --global --agent claude-code codex
```

本 repo 收錄上述九個 [Matt skills](https://github.com/mattpocock/skills) 的副本，移除 `disable-model-invocation` 並啟用 Codex 的 `allow_implicit_invocation`，讓 LAT 可呼叫各階段技能。

接著安裝其餘必要的 Matt skills：

```bash
bunx skills add mattpocock/skills \
  --skill code-review prototype grilling domain-modeling tdd \
  --global --agent claude-code codex
```

若要安裝完整的 `Mattpocock Skills` 群組，改用下列腳本取代上一條指令。腳本依上游 plugin 清單選取技能，預設排除 `Other` 群組及 LAT repo 已收錄的同名技能：

```bash
uv run scripts/install-matt-skills.py
```

腳本在本 repo 執行，需有 `uv`、`gh`、`bunx` 與 `trash-put`；加上 `--dry-run` 可預覽。預設全域安裝至 Claude Code 與 Codex，使用其他 client 時加上 `--agent`。CLI 選項見 [skills 安裝說明](https://github.com/vercel-labs/skills#readme)

### 可選工具

- **[HERDR](docs/hcom-herdr-setup.md)**：集中查看多個 Agent 與 HCOM 建立的外部 Agent，透過 workspace 整理工作視窗；串接方式見連結說明。

- **[codex-multi-auth](https://github.com/ndycode/codex-multi-auth)**：Codex 帳號與額度管理，以 `codex-multi-auth switch <n>` 指令切換；LAT 的檢查與重啟續接方式見 [Agent 設定](skills/local/lat/references/agents.md#codex-額度與換帳號)。
  ```bash
  bun add --global codex-multi-auth
  codex-multi-auth login  # 各帳號分別登入
  ```
- **[cswap（claude-swap）](https://github.com/realiti4/claude-swap#automatic-switching)**：Claude Code 支援熱切換；加入帳號並啟動自動切換後，接近額度上限時會自動換到有額度的帳號，無須逐次手動操作。Linux／Windows 通常不需重啟 Claude Code；macOS 須等待 Keychain 快取更新。

  以下安裝方式需先安裝 [uv](https://docs.astral.sh/uv/getting-started/installation/)。

  ```bash
  uv tool install claude-swap
  cswap add  # 每次登入不同 Claude Code 帳號後執行
  cswap auto  # 保持執行，自動監看與切換
  ```

## 用法

```text
LAT 幫我完成這個功能，先討論需求。
```

可直接指定模型、分工與範圍；未指定時依 [Agent 設定](skills/local/lat/references/agents.md) 執行。

## 使用者決策

提問前先查事實與既有授權；實作、修復、QA 與排程不重複請示。

真正需要使用者回答的問題，保存在專案 `.lat/decisions/<ID>.md`。使用者照常聊天回答，主控保存答覆原文、來源與問題版本。所有 worktree 與 Agents 共用決策目錄，主控與執行 Agent 都核對授權。

HCOM 回報或使用者未回覆不能解除等待；相依工作保持阻塞，其他已授權工作繼續。這是 skill 的流程約束，尚無工具層強制阻擋。詳見 [決策設計](docs/lat-user-decisions-design.md)。

## 文件

- [LAT 流程與規則](skills/local/lat/SKILL.md)
- [模型、權限與 HCOM 設定](skills/local/lat/references/agents.md)
- [三層測試](skills/local/three-tier-testing/SKILL.md)
- [HCOM／HERDR workspace 設定](docs/hcom-herdr-setup.md)

## 授權

[MIT](LICENSE)

## 本地開發

首次下載（已有本地工作區可略過）：

```bash
git clone https://github.com/ouob-tw/LoopAgentTeams.git ~/LoopAgentTeams
```

修改後同步安裝到 Claude Code + Codex（可重複執行）：

```bash
bunx skills add ~/LoopAgentTeams \
  --skill lat three-tier-testing to-spec to-tickets implement grill-with-docs wayfinder handoff \
  --skill setup-matt-pocock-skills triage to-questionnaire --global \
  --agent claude-code codex --yes
```
