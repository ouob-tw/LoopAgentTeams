---
status: accepted
---

# 以繼承的 Agent 編號回收 HCOM Agent 遺留的程序

Agent 為測試開的服務在 Agent 結束後仍活著，2026-10-22 曾有 12 個看板測試伺服器跑了約 7.5 天、吃掉約 23 GB 記憶體。需求見 ouob-tw/LoopAgentTeams-work#258（使用者決定 HUZU-SVC-1 至 HUZU-SVC-3、HUZU-SPEC-1），工具是 `skills/local/lat/scripts/lat-reap.py`。

## 決定

1. **以程序環境中繼承的 `HCOM_PROCESS_ID` 認定擁有者，不看程序名稱，也不要求 Agent 自行登記。**
   - 為什麼：HCOM 啟動每個 Agent 時設定專屬編號，Claude 與 Codex 的工具 shell 及其背景程序都會繼承（2026-10-22 以真實 Codex 背景指令實測，`setsid` 脫離後仍帶編號）；7100 正式看板這類系統服務沒有編號，天然不在範圍內。
   - 代價：使用者自己開的 Claude／Codex 視窗、更新前已遺留的舊程序沒有編號，永遠不會被收；程序若主動清掉環境變數也會漏收。

2. **Agent 已結束須三項證據同時成立：HCOM 存活名單沒有這個編號、主機上沒有它的 client 程序，而且 HCOM 有紀錄顯示這個程序所屬的 Agent 已停止；任一項顯示存活就不收，HCOM 沒有停止紀錄的稱為「不明擁有者」，一律不收。**
   - 存活名單取自 `hcom list --json`（各 Agent 的 `launch_context.process_id` 與 `pid_identity`），不直接讀 HCOM 資料庫：這是 HCOM 對外的指令介面，lat-watch 已在用；資料庫結構是內部細節，且 Agent 結束後其 `process_bindings` 紀錄會被刪掉，讀資料庫也拿不到更多。
   - client 程序：名單有紀錄時，以 `pid_identity` 的啟動時間加上相同編號認定（`hcom list` 不給 PID，同一時刻啟動的子程序不算，只取最上層那個）；名單已沒有紀錄時，帶該編號的 `hcom` 包裝程序，或執行檔／腳本名稱等於其 `HCOM_TOOL` 的程序（例如 `claude`、`node …/codex`）都算 client。名稱只用來判定「還活著」，從不用來決定關閉。
   - 停止紀錄：HCOM 的 `life` 事件不帶 `HCOM_PROCESS_ID`（2026-10-23 查證 `hcom events --type life` 的 `created`、`started`、`ready`、`stopped`、`batch_launched` 都沒有，`hcom list --stopped --json` 也不輸出 JSON），所以改用程序繼承的 `HCOM_INSTANCE_NAME` 與 `HCOM_LAUNCH_BATCH_ID` 對應：`batch_launched` 事件的 `batch_id` 等於該批次且 `instances` 含這個名稱，之後（事件編號較大）又有該名稱的 `stopped` 事件，才算已停止。早於這次啟動的 `stopped` 屬於先前同名的 Agent，不算。查詢以 `hcom events --type life --sql …` 只取需要判斷的名稱與批次；名稱或批次含英數、`_`、`.`、`-` 以外的字元時不查詢，視為不明擁有者。
   - 不明擁有者：沒有名稱或批次（例如測試設的假編號）、HCOM 沒有這個批次的啟動紀錄，或尚無停止紀錄的程序。`scan` 列在「Unknown owner」，`reap` 只印出數量，不寫關閉紀錄。
   - 名單讀不到、格式不對，停止紀錄需要查詢卻讀不到、格式不對，或保留紀錄讀不到、損壞（含欄位型別不對）時，這次一個都不收，並在關閉紀錄寫一筆 `aborted` 與原因。
   - 為什麼：寧可晚收也不誤殺；HCOM 名單可能因為 HCOM 自己的清理而先消失，client 程序是第二道保險。只看「名單沒有」時，HCOM 從未見過的編號（看板測試 harness 的全 0 編號、lat-reap 自己測試的假編號）也被當成已結束，主機上任何主控的定期回收都會關掉別人的測試程序（ouob-tw/LoopAgentTeams-work#265），所以要有 HCOM 主動記下的停止紀錄才收。
   - 代價：client 本體卡住不結束時，它的遺留程序也不會被收；工具 shell 裡剛好執行名為 `claude`／`codex` 的指令時，該 Agent 會被暫時視為存活。程序清掉或改掉名稱、批次環境變數，或 HCOM 重設（`hcom reset`）後舊批次紀錄不在目前的事件中時，它的遺留程序永遠不收。對應靠名稱與批次而不是編號：自設同樣名稱與批次的程序會被當成該 Agent 的程序。

3. **永不處理清單優先於一切規則，保留到期或解除也不能覆蓋，並逐一套用在每個要送訊號的程序與每個 `keep` 目標：**
   - 沒有 `HCOM_PROCESS_ID` 的程序；其他使用者的程序（根本不讀取）；呼叫者自己與其所有祖先；監聽受保護埠（預設 7100）的程序。
   - 基礎程序：存活 Agent 的 client、其祖先，以及從 client 往下每條分支直到第一個 shell（以執行檔名稱 `bash`、`sh`、`zsh`、`dash`、`fish` 等辨認）為止、含該 shell 的程序。分支上沒有 shell 的程序（例如 Codex 的 `codex-code-mode`、MCP 伺服器）在 Agent 存活期間都是基礎程序。實測結構：Codex 為 `hcom pty` → `node …/codex` → `codex` → 常駐輔助程序／工具 `bash` → 服務；Claude 為 `hcom pty` → `claude` → 工具 `bash` → 服務。
   - LAT 自己的程序（執行檔，或直譯器（python、bash 等）執行的腳本位在 LAT 技能資料夾內；只是開著 LAT 檔案的程序不算；LAT 技能資料夾指本工具所在的技能，或任何 `SKILL.md` 名稱為 `lat` 的資料夾，涵蓋安裝副本與 QA 副本）與 HCOM 自己的程序（執行檔名稱為 `hcom`）。
   - 為什麼：不能因為保留到期或主控停用就關掉主控正在用的 client、MCP 或監控；以第一個 shell 為界，shell 底下 Agent 開出的一般服務仍能回收（使用者於 HUZU-SPEC-1 選定）。
   - 代價：Agent 不經 shell 直接啟動的服務在 Agent 存活期間無法以保留到期收掉；依執行檔名稱辨認 shell，改名的 shell 會被當成一般程序。

4. **保留優先於一般回收：未到期且標記主控仍在 HCOM 名單上、未被解除的保留不收；保留到期、被 `release --by <主控>` 解除，或標記主控已不在名單時，關閉保留程序與其帶相同編號的子孫，不論擁有者是否存活；其餘程序只在擁有者結束後才收。**
   - 另一個仍有效的保留若位在被解除保留的子孫中，仍照有效保留不收。
   - 為什麼：照 HUZU-SVC-3，保留要有期限，到期或主控停用 LAT 時收掉；主控異常消失時沒有人會呼叫停用，所以「主控不在名單」也視為解除。
   - 代價：標記者只以 HCOM 名稱比對，同名的新 Agent 會讓舊保留延續到期限為止；保留以 PID 加啟動時間記錄，程序重啟後要重新標記。

5. **保留紀錄、關閉紀錄與鎖放在使用者層級的 `$XDG_STATE_HOME/lat/reaper/`（未設定時 `~/.local/state/lat/reaper/`），所有專案共用一份；`reap` 一律先拿這把鎖，定期觸發搶不到就略過，手動與停用觸發等至多 30 秒。**
   - 為什麼：回收範圍是整台主機，不同專案的主控必須看見彼此的保留，也不能同時對同一批程序送訊號。
   - 代價：紀錄不在各專案的 `.lat` 裡，既有的 `.lat` 清理指令不會清；`closed.jsonl` 會持續增長，清理另行處理。

6. **關閉時整批先送 SIGTERM，10 秒後仍在的送 SIGKILL；每次送訊號前重新核對 PID 的啟動時間，與掃描時不同就不送。每筆結果寫一行 JSON（時間、觸發來源、PID、啟動時間、截斷到 120 字的指令列、工作目錄、Agent 名稱與編號、訊號、結果、原因），不存環境變數。**
   - 為什麼：給程序正常收尾的機會，也收得掉不理會 SIGTERM 的程序；啟動時間核對避免 PID 被重用時誤殺；指令列可能含機密參數，所以只留前段。
   - 代價：等待期間持有鎖，其他手動回收最多多等 10 秒餘。

## 已知限制

- Codex 會在工具指令結束時結束同一程序群組的背景程序（實測 `nohup … &` 未脫離就被關掉），只有 `setsid` 之類脫離後的程序會留下來，這類程序仍帶編號，會被回收。
- 測試以 `LAT_REAP_HCOM_LIST`（假的 HCOM 名單檔）、`LAT_REAP_HCOM_EVENTS`（假的 HCOM `life` 事件檔，每行一筆）、`LAT_REAP_TEST_SCOPE`（只看此前綴的編號，其他程序一律當成沒有編號）、`LAT_REAP_GRACE_SECONDS`、`LAT_REAP_LOCK_SECONDS` 與 `LAT_REAP_PROTECTED_PORTS` 替換外部依賴；正式使用不設定這些變數。
- 主機上沒有任何 LAT 主控時沒有定期掃描，遺留程序要等下一個主控啟動後才被收。
- 同一使用者但讀不到 `/proc` 資料的程序（例如關閉 dumpable 的 sshd、gpg-agent）無法判斷，永不處理；位在其下的帶編號程序也不處理，因為上層可能是讀不到存活證據的 client。從 ssh 終端機直接開的 Agent 因此不會被回收。讀不到的程序列在 `scan --all` 與 `reap` 輸出，清單改變時在關閉紀錄寫一筆 `not judged`。
