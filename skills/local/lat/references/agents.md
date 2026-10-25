# Agent 設定

召喚 Agent、選模型與 effort、啟動、存活、額度與關閉一律呼叫 /hcom-spawn。本文件只放 LAT 改動或多加的規則。

hcom-spawn 的「自身名稱」是發起委派的那一方：主控派工時是主控的 HCOM 名稱；執行 Agent 再委派時是它自己的名稱。

## 在 LAT 內與 hcom-spawn 不同之處

- hcom-spawn 要求「回報使用者」的地方，執行 Agent（含再委派時）改回報召喚它的一方，最終到主控；主控在既有授權內處理，超出才依 SKILL.md 的使用者待決規則問使用者。Codex 自動換帳號依 hcom-spawn；無可用訂閱帳號時，等待或兌換 reset 等做法由使用者決定。主控依 /hcom-spawn「回報與收尾」的規定向使用者回報；執行 Agent 仍即時回報召喚者，由主控記錄。
- hcom-spawn「改呼叫 /lat」的指引不適用（已在 LAT 流程內）。
- 關閉時機依下方「收尾」與任務收尾的門檻；執行 Agent 自報完成不能跳過。

## 派工

- 工具：Agent 啟動後，`scripts/lat-dispatch.py card --tag <tag> --tasks <主工作區 .lat/tasks> --orchestrator <主控名稱> --live-actions … --preflight …` 依 tag 查完整名稱建任務卡；`brief --card <卡片> --input <小檔>` 把 `##` 四段小檔（「目標與完成條件」「範圍與不能碰」「其他 Agent 與分工」「現場動作額度」）接上下列固定項目、原樣帶入卡片 `live actions` 與 `preflight`，並印出 `hcom send … --file` 指令，其中 `--name` 用 HCOM 基本名。兩位共用 tag（如參謀）用 `card --agent <完整名稱>`；唯讀任務用 `brief --read-only`，共用文字用 `brief --include <檔案>`。任務要合併、推送、部署或安裝時加 `brief --preauth <動作>[:<分支>]`，只帶入查得 `allow` 的動作。手寫仍然允許；以下各項是手寫時的要求，也是工具輸出的內容。
- 工作總表：`card` 加 `--ledger <主工作區總表絕對路徑> --ticket --stage --evidence --deadline [--depends]` 會同時開列並指派，任務卡多一行 `ledger row`；不加則行為不變。`brief` 讀到該行，就帶上列編號與 `start`、`update`、`done` 三道指令；沒有該行時印警告，簡報不含總表指令。手寫時自行寫入同樣內容。
- 外部 Agent 的第一則任務訊息照 /hcom-spawn 的固定欄位寫，再補上 SKILL.md「交接」要求的項目，以及「做完才收工」規則和填好主控 `$lat_dir`、`$workspace` 絕對路徑的 `lat-watch wait` 與 `lat-watch alarm` 指令（格式見 [停住監控](stall-watch.md#結束回合前)）。鬧鐘範例：`uv run --no-project python <主控 lat_dir>/scripts/lat-watch.py alarm --workspace <主控 workspace> --agent <執行 Agent 完整名稱> --after 30 --reason 'Continue after the cooldown'`；並寫明不要用背景程式傳訊息給自己（HCOM 會拒收）。
- 第一則任務訊息須帶上任務卡 `runs` 欄的絕對路徑（主工作區 `.lat/runs/issue-<N>/`，見 [任務卡](task-cards.md#票資料位置)），QA 草稿、清單與證據都放那裡；需要隔離 client 家目錄時放 `.lat` 以外的暫存位置，規則見 [任務卡](task-cards.md#隔離-client-家目錄)。
- 第一則任務訊息須帶上任務卡 `live actions` 與 `preflight` 兩欄的完整內容（沒有也寫「無」），以及額度內的做法與回報時機；填法與行為見 [任務卡](task-cards.md#現場動作額度)。
- 派實作時，第一則任務訊息寫明以下覆蓋 /implement 的做法：修正與審查期間只跑受影響的測試檔；票內跑哪些測試依 three-tier-testing（有對照表的專案跑受影響測試，審查者核對對照表變更，整批合併後的整套由主控指定一人以 `post-merge` 用途跑；沒有對照表的專案照 three-tier-testing 的舊規則），整套測試依任務卡 `整套測試` 欄；修正後複查只看修正差異。
- 派 /code-review 審查者前（實作者再委派時亦同）先跑 `uv run --no-project python <lat_dir>/scripts/review-size.py <審查基準>` 取得建議，由主控決定：小改動、只改測試或文件派一位 Standards 審查者，其他派兩面向；門檻見腳本說明。Standards 面向照 /hcom-spawn 預設選模型；派兩位時 Spec 面向一律派 `gpt-6-astra`、effort `medium`。使用者另行指定時照其指定。
- 派 Designer 寫 Spec 與拆票（/to-spec、/to-tickets）時寫明：「現有測試全部通過」只寫在 Spec 層級，全部合併後由一人跑一次，不寫進各票驗收條件。
- [Spec 文件審查](spec-review.md) 派給全新、與 Designer 不同家模型的 Agent：Designer 是 Claude 時派 Codex `gpt-6-astra`、effort `medium`；是 Codex 時派 Claude，模型依 /hcom-spawn 預設。它在確認前審 Spec 本身，與實作後審程式的 Spec 面向不同，不互相取代。
- 不同家模型不可用時，先依 /hcom-spawn 的額度與恢復程序處理（如 Codex 換帳號）；仍不可用，依 SKILL.md「使用者待決事項」問使用者要等待還是改用同家全新 Agent。答覆前不改用同家模型、不略過審查，也不發 Spec 確認題。
- 參謀一位 Codex `gpt-6-astra`、effort `medium`，一位 Claude、模型依 /hcom-spawn 預設。這是上一條的例外：某一家不可用時改用兩位同家參謀、不問使用者，見 [參謀](advisors.md#模型與降級)。
- 每項任務用自己的 tag，不跨任務共用，關閉整組時才不會誤關其他任務的 Agents。
- 執行 Agent 卡住時，由召喚它的一方依 /hcom-spawn 的升級規則提高 effort 或換模型；走完仍卡住，交回主控決定新 context 或拆小任務。

## 存活與恢復

- Agent 沉默時，先讀它的任務卡確認已完成工作、下一步及資源歸屬，再依 /hcom-spawn 查執行狀態。停住監控已定時巡查、催醒卡在 `active` 的 Agent 並往上通知；收到通知依 [停住監控](stall-watch.md#主控處理監控通知) 處理，不必另設計時器。
- 內建 Agent 沒有 HCOM 畫面：查 client 提供的狀態與任務卡，仍不清楚就直接傳訊詢問，不讀完整 subagent transcript（塞滿主控 context）。
- 主控的 HCOM 身分掉線時，依 /hcom-spawn 恢復並補讀漏掉的事件後，再核對任務卡與 `.lat/decisions/` 待決紀錄才續作。

## 收尾

- 主控記錄本次 LAT 建立的 HCOM Agent 名稱與 tag。執行 Agent 再委派後，把新 Agent 的名稱與 tag 回報主控；這些 Agent 以執行 Agent 的名稱開頭，主控靠回報找。
- 執行 Agent 保存成果、清理自己的測試資源並回報後待命，不自關。
- 主控依 [任務收尾](task-cards.md#任務收尾) 的時機，依 /hcom-spawn 以 tag 逐組關閉該任務記錄的 Agents（含再委派的），核對都已停止，同步完成清理與歸檔。
- 只關閉本次 LAT 記錄的 Agents；名稱前綴相同但不在紀錄裡的（如先前的協作）一律保留。
