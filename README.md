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

需要 Git、Bun，以及支援 skills 的 Agent client；外部 Agent 協作另需 HCOM 與對應 client。

在本專案根目錄安裝目前 checkout 的技能，以下以 Claude Code 全局安裝為例：

```bash
bunx skills add . --skill lat --skill three-tier-testing --global --agent claude-code
```

dev 開發時，將本地工作區的 LAT 同步安裝到 Claude Code 與 Codex：

```bash
bunx skills add /home/swy/LoopAgentTeams --skill lat --global \
  --agent claude-code codex --yes
```

另行安裝 [Matt skills](https://github.com/mattpocock/skills) 中需要的階段技能：

```bash
bunx skills add mattpocock/skills --global --agent claude-code
```

依安裝提示選擇技能；使用其他 client 時替換 `--agent`。CLI 選項見 [skills 安裝說明](https://github.com/vercel-labs/skills#readme)。更新本地 checkout 後，重新執行本地安裝指令同步技能。

## 用法

```text
LAT 幫我完成這個功能，先討論需求。
```

可直接指定模型、分工與範圍；未指定時依 [Agent 設定](lat/references/agents.md) 執行。

## 使用者決策

提問前先查事實與既有授權；實作、修復、QA 與排程不重複請示。

真正需要使用者回答的問題，保存在專案 `.lat/decisions/<ID>.md`。使用者照常聊天回答，主控保存答覆原文、來源與問題版本。所有 worktree 與 Agents 共用決策目錄，主控與執行 Agent 都核對授權。

HCOM 回報或使用者未回覆不能解除等待；相依工作保持阻塞，其他已授權工作繼續。這是 skill 的流程約束，尚無工具層強制阻擋。詳見 [決策設計](docs/lat-user-decisions-design.md)。

## 文件

- [LAT 流程與規則](lat/SKILL.md)
- [模型、權限與 HCOM 設定](lat/references/agents.md)
- [三層測試](three-tier-testing/SKILL.md)
- [HCOM／HERDR workspace 設定](docs/hcom-herdr-setup.md)

## 授權

[MIT](LICENSE)
