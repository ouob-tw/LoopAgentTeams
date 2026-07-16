# LAT Writer／Reviewer Context7 MCP 能力設計

## 目標

讓 LAT 的 writer／reviewer 角色在需要查核 library、framework、SDK、API、CLI 或 cloud service 最新文件時，可直接使用使用者已配置的 Context7 MCP。

本功能只增加 Context7 MCP 能力，不限制或改變 client 原有的 sandbox、內建工具、其他 MCP 與權限。

## 適用角色

下列角色需要時必須能看見並呼叫 `context7` MCP：

- `spec_reviewer`
- `plan_writer`
- `plan_reviewer`

`plan_reviewer` 預設為 self，直接使用 Dispatch 的 Context7 能力；若覆蓋為外部 client，沿用該 client 的有效 MCP 設定。`spec_writer`、`code_executor`、`test_executor` 與 `qa_executor` 不在本次範圍。

## 已確認前提

截至 2026-07-16，本機狀態為：

- Claude Code 的 `context7` MCP 已連線。
- Codex 的 `context7` MCP 已啟用。
- Context7 CLI 已移除。
- Context7 CLI-backed skills 已移除。

此 Spec 不保存 MCP credential、完整啟動參數或任何 secret。實作與驗收輸出也不得顯示這些資料。

## 設計決策

### 1. 只新增 MCP 能力

外部 writer／reviewer 沿用 client 的有效 MCP 設定，self reviewer 則使用 Dispatch 的有效 MCP 設定。若使用者已在全域或專案設定配置並啟用 `context7`，LAT 不需額外注入啟動參數，也不重複建立同名 server；LAT 只需在角色能力契約與 prompt 中指示有需要時使用 Context7 MCP。

不採用以下限制：

- 不啟用 Claude `--strict-mcp-config`。
- 不停用 Codex 的其他 MCP server。
- 不建立 MCP allowlist。
- 不移除或隱藏其他 tool namespace。
- 不改變現有內建工具。

### 2. 保持既有權限

加入 Context7 MCP 不得改變角色原本的 client permission：

| 角色 | Codex 預設 permission | 權限契約 |
|---|---|---|
| `spec_reviewer` | `read-only` | report-only，不修改規格 |
| `plan_writer` | `workspace-write` | 只寫入指定計劃文件 |
| `plan_reviewer`（外部 override） | `read-only` | report-only，不修改計劃 |

若使用者將 phase 改為 Claude Code client，仍沿用該 phase 已解析的 Claude permission mode；不得為了 Context7 改用 `bypassPermissions`。

Context7 MCP 不需要開放額外 shell network，也不需要啟用 live WebSearch／WebFetch。

### 3. Client 啟動行為

Claude Code 與 Codex 都使用既有有效 MCP 設定，不注入 strict 或 disable-other-MCP 參數。若 server 已存在，不重新 add、login 或覆寫設定。

當工作實際需要最新技術文件時，writer／reviewer 先嘗試呼叫 Context7 MCP；若工具不可見，再清楚回報缺少能力。不得因為沒有執行額外 preflight 就阻止純本地、與外部文件無關的 phase，也不得未經使用者授權修改全域 MCP 設定。

### 4. 失敗處理

實際需要文件查核但 Context7 tool 不可見或呼叫失敗時，writer／reviewer 必須如實說明該項未驗證；不得自動安裝 CLI、修改 MCP 或提高 permission。Context7 的 tool schema 與查詢步驟由既有 MCP server 提供，不在 LAT 重複定義。

## 範圍

### 本次包含

- Claude Code／Codex writer 與 reviewer 使用既有 Context7 MCP。
- 角色 prompt 中的 Context7 MCP 使用契約。
- 保持既有 permission、其他 MCP 與內建工具不變。
- 對應的 skill contract 與本機 MCP 設定檢查。

### 本次不包含

- 安裝或恢復 Context7 CLI。
- 安裝或恢復 Context7 CLI-backed skills。
- 限制、停用或重排其他 MCP／工具。
- 啟用 strict MCP、MCP allowlist 或 exclusive MCP mode。
- 改變任何 phase 的 sandbox／permission。
- 開放 shell network、live WebSearch 或 WebFetch。
- 修改 LAT Monitor、STALL、PID／PGID 或 Session 完成契約。
- 將 credential 寫入 repo、prompt、process list、runtime YAML、log 或 transcript。

## 驗收清單（QA）

### Q1：三個角色取得 Context7 能力

**使用者行為：** 以 `spec_reviewer`、`plan_writer` 或 `plan_reviewer` 處理需要最新技術文件的工作。

**預期：** `spec_reviewer`、`plan_writer` 與外部 `plan_reviewer` canonical prompt 都要求在需要時使用既有 Context7 MCP；self `plan_reviewer` 使用 Dispatch 的既有能力，不要求安裝 CLI。

**測試／證據：** skill contract test 分別檢查三個 prompt，並確認本機 Claude Code 與 Codex 的 MCP 清單存在 `context7`。

### Q2：其他既有能力不被限制

**使用者行為：** 使用任一上述角色執行純本地或需要 Context7 的工作。

**預期：** phase 的 sandbox／permission、其他 MCP 與內建工具維持原設定；LAT 不注入 strict、allowlist 或 disable-other-MCP 參數。

**測試／證據：** contract test 檢查角色既有 permission 與 client 啟動文件，確認只新增 prompt 指示，沒有新增 MCP 啟動旗標或 permission 變更。

### Q3：Context7 CLI 與 CLI-backed skills 維持移除

**使用者行為：** 驗收目前安裝狀態。

**預期：** `ctx7` 不在 PATH，兩個 client 的 `context7` MCP 仍存在，Context7 CLI-backed skill 目錄不存在。

**測試／證據：** 執行 `command -v ctx7`、Claude Code／Codex MCP list 與四個既有 skill 路徑存在性檢查；輸出不得包含 credential。

## 成功條件

- Claude Code 與 Codex 的外部 writer／reviewer，以及 Dispatch self `plan_reviewer`，都能使用各自既有的 Context7 MCP。
- Context7 CLI 與 CLI-backed skills 維持未安裝狀態。
- 其他 MCP、內建工具、sandbox 與 permission 不因本功能被限制或改變。
- Context7 失敗時不隱瞞、不自動擴權。
