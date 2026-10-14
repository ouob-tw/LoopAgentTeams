---
status: accepted
---

# LAT 看板：啟動與接回 Agent 時不帶呼叫者身分、切換模型一律停止再接回、對話紀錄直接讀 client 紀錄檔

使用者要從看板喚醒已結束的主控、新建主控、看完整對話紀錄，並隨時切換主控的模型與思考強度（需求見 ouob-tw/LoopAgentTeams-work#122）。驗收時發現 hcom、Herdr 與 Claude Code 的幾個實際行為，以下三個決定由此而來。

## 決定

1. **看板呼叫 hcom 新建或接回 Agent 時，先拿掉呼叫者的 Agent 與 Herdr 分頁身分，並一律加 `--no-run-here`。**
   拿掉 `HCOM_DIR` 以外的 `HCOM_*`、`CODEX_HOME` 以外的 `CODEX_*`、`CLAUDECODE`、`CLAUDE_CODE_*` 等 Agent 標記，以及 `HERDR_SOCKET_PATH`、`HERDR_CONFIG_PATH` 以外的 `HERDR_*`；目標工作區另以 `HERDR_WORKSPACE_ID` 明確指定。
   - 為什麼：看板若從某個 Agent 的終端機啟動，會繼承它的身分；hcom 因此在新主控的第一則訊息加上「做完回傳給 @某 Agent」，呼叫者的分頁資訊也會蓋過新分頁自己的值。拿掉身分之後，hcom 會把看板當成一般終端機，單一 Agent 時直接在看板自己的程序裡執行，不開 Herdr 分頁（`--terminal herdr` 不影響這個判斷），新主控就沒有分頁編號、LAT 面板綁不上。systemd 服務本來就沒有這些標記，所以同樣需要 `--no-run-here`。
   - 代價：`--no-run-here` 沒有列在 `hcom <client> --help`，是依 hcom 原始碼採用，新建已在 0.7.29 實測、接回依同一段判斷推定並在驗收時以真實接回確認；hcom 改版時須重新核對。看板另外拒絕停止「紀錄的分頁就是看板自己所在分頁」的 Agent，避免誤關呼叫者。

2. **切換主控的模型與思考強度，Claude 與 Codex 都用「只在等待時停止，再以參數接回同一段對話」，看板不在對話裡打 `/model`、`/effort`。**
   Claude 接回附 `--model`、`--effort`；Codex 只用 `-c model=…`、`-c model_reasoning_effort=…`，新建 Codex 主控也不用 `--model`。
   - 為什麼：Claude Code 2.1.299 在互動對話中執行 `/model`、`/effort`，依其程式碼會把選擇存成使用者新對話的預設，且可能跳出確認框；驗收時實際改到了使用者的全域設定。Codex 0.162.1 的 `/model` 只開互動選單。接回時的命令列參數只影響那段對話；hcom 接回會重放原始參數，重複的 `--model`、`--effort` 以最後一個為準（驗收時以真實 Claude 主控接回確認），但 Codex 明確的 `--model` 會蓋過任何 `-c model`，所以看板新建的 Codex 只用 `-c`，原本帶明確模型的 Codex 主控則停用改模型。使用者在需求討論時選了這個做法。
   - 代價：主控正在工作時看板拒絕切換，要等它這一回合做完；原分頁會關掉、在新分頁重開；停止與接回之間的失敗需要「切換嘗試」紀錄與「繼續切換」來恢復。只換模型時須明確帶上目前的思考強度，否則會變成新模型的預設。

3. **對話紀錄由 Python 輔助工具直接讀 Claude 的 session 紀錄檔與 Codex 的 rollout 紀錄檔，不用 `hcom transcript`。**
   沿用 ADR 0003 第 1 點：解析只放在輔助工具，看板呼叫它。
   - 為什麼：`hcom transcript` 把文字與工具分開列（0.7.29 的 `transcript --detailed --json` 每段交換只給合併後的文字與另一份工具清單），看不出工具操作夾在哪兩段文字之間，無法做「兩段文字之間的操作合成一行」。
   - 代價：要跟著兩個 client 的紀錄格式調整；格式不符的單筆紀錄會被略過並計數。工具摘要採白名單，只有單行且全為安全字元的指令才完整顯示，避免露出寫進檔案的內容，代價是含管線等符號的指令只顯示程式名稱。
