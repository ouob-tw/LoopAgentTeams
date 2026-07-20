# LAT Resume 模型與推理強度保存規格

## 背景

LAT 啟動 client 時會先依「使用者 prompt → `.lat/config.yaml` → 內建預設」解析 client、model、effort 與 permission。中斷後恢復同一 transcript，必須延續這組已解析值，不能重新套用恢復當下的全域預設。

實際案例顯示，`codex exec resume` 未指定 model 與 effort 時，原本的 `gpt-5.4/high`、`gpt-5.5/high` 都被目前 `~/.codex/config.toml` 的 `gpt-5.6-sol/medium` 取代；sandbox 也從 `read-only` 變成全域解析出的 `workspace-write`。Codex Session JSONL 的具體 model 與 effort 位於每個 `turn_context`，不是 `session_meta`。

Claude Code 目前通常會自行恢復原 model，但 LAT 不依賴 client 的隱含恢復行為；Claude resume 同樣明確重帶原始 model 與 effort，以維持兩種 client 的一致契約。Claude Opus 4.6 的實測也確認，`--resume` 可安全搭配 `--model` 與 `--effort`：同 model／同 effort、同 model／不同 effort、不同 model／不同 effort皆能正常恢復且不丟失歷史對話。

## 決策

1. Codex exec 與 TUI resume 必須明確帶入原始已解析的 `model`、`effort`、`permission`。
2. Claude exec 與 TUI resume 必須明確帶入原始已解析的 `model`、`effort`、`permission`。
3. Resume 不重新執行 client 設定優先序，也不採用恢復當下的 `~/.codex/config.toml`、Claude 預設或後續變更過的 `.lat/config.yaml`。
4. Resume 同一 transcript 時維持原 agent instance；本次只修正 client 啟動參數，不變更 session 定位、PID、Monitor 或 ledger 契約。
5. Repo skill 驗證通過後，同步至 Claude 與 Codex 的已安裝 `lat-dispatch` copies。

## 指令契約

Codex exec 使用全域 exec options 後接 resume subcommand：

```bash
codex exec --sandbox <permission> --model <model> \
  --config model_reasoning_effort="<effort>" \
  resume "$SESSION_UUID" - < "$PROMPT_PATH"
```

Claude exec：

```bash
claude --resume <agent_id> --model=<model> --effort <effort> \
  --permission-mode <permission> --print "$(cat -- "$PROMPT_PATH")"
```

TUI resume 使用相同參數集合，僅保留各 client 原有的 zmx wrapper 與互動模式差異。

## 範圍

- 更新 `lat-dispatch/references/clients.md` 的 Codex／Claude exec 與 TUI 恢復指令及錯誤恢復說明。
- 更新 `docs/claude-session-resume.md` 的 Claude 恢復範例。
- 更新契約測試，要求四種 resume 指令明確包含原始 model 與 effort。
- 同步已安裝 skill copies。

不修改 Codex 或 Claude CLI、本機全域 model 預設、Monitor 實作、task ledger schema 或其他 client 啟動預設。

## 驗收清單（QA）

- Q1：Codex exec resume 範例是否同時包含原始 permission、model、effort 與精確 Session UUID？
  - A：契約測試比對完整指令，並確認仍使用 PID runner、prompt file 與原 JSONL Monitor。
- Q2：Codex TUI resume 範例是否同時包含原始 permission、model 與 effort？
  - A：契約測試比對 zmx 指令中的三個參數。
- Q3：Claude exec 與 TUI resume 範例是否都明確包含原始 model 與 effort？
  - A：契約測試分別比對兩種 Claude 指令，且保留 permission 與 exec/TUI 模式差異。
- Q4：文件是否禁止 resume 時重新解析目前預設？
  - A：契約測試要求存在「沿用原始已解析值」規則。
- Q5：Repo 與已安裝 skill 是否一致？
  - A：完整測試通過後，以 byte-for-byte `cmp` 驗證同步結果。
