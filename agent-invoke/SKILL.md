---
name: agent-invoke
description: 在支援的宿主原生 Agent 與跨家族客戶端間，以可驗證目標、明確同意與精確續接識別執行單一代理呼叫。使用於要求啟動、續接、停止或跨家族代理工作的情況。
---

# Agent Invoke

此 skill 僅選擇並執行一條路徑；不鏡像其他套件的調度流程，也不包裝測試或執行證據。

## 先正規化請求

先從使用者請求取得並完整記錄：

`action,target_family,route,client,mode,model,effort,permission,workspace,resume_reference`

- `action` 僅為 launch、follow-up、resume 或 stop；缺值或歧義即詢問，不猜測。
- `target_family`、`client`、`workspace` 與 `permission` 必須在啟動前傳遞給選定路徑，並在回覆前完成 target transmission 與 target verification。
- `resume_reference` 只可使用先前回傳、已封存的精確執行期 handle；不得由名稱、摘要或相近工作取代。
- 未提供 `route` 時，依序套用下節決策。最後輸出正規化欄位與 exactly one selected route。

## 路由決策

依下列順序判定，命中後立即停止，不得同時執行或回報多條路徑：

1. exact resume：`resume_reference` 有效且已封存時，只准對原生 owner 的 exact handle 做 follow-up/resume。
2. override：使用者明確指定可用路徑時採用，但仍須通過目標傳遞、驗證與權限檢查。
3. native：目前 client 支援目標家族的內建 Agent 時，採原生路徑並讀取 `references/native.md`。
4. cross-family：僅在使用者給予 explicit consent，且原生路徑不可用時，才可使用跨家族客戶端；否則拒絕並說明。

unsupported client 或不支援的目標家族必須拒絕；不得靜默降級、改寫 target，或假裝成功。

## 按選定路徑讀取

只在路徑已選定後才進行 conditional reference reads：原生路徑讀取 `references/native.md`。未選定的路徑不得預讀、執行或產生副作用。

精確續接採 resume-only：只傳遞封存 handle 給同一 native owner，不重啟、不替換 handle，也不改投其他家族。若 handle 無效或未封存，明確拒絕。

## 共同安全界線

- 啟動前驗證工作區、目標家族、模型、effort 與 permission 可被選定 client 接收；驗證失敗即停止。
- 首次回傳的身份在封存前是 provisional；只可在同一 launch turn 原子地封存為 sealed identity，之後才允許 resume。
- 原生 host tool 必須直接呼叫；Bash 不得呼叫、代理、模擬或偽造宿主原生啟動、續接、等待或停止操作。
- stop 必須遵守原生 split-phase 流程；不得以 shell signal 取代宿主工具。

## 完成條件

僅在一條路徑已完成 target transmission、target verification，且回覆含正規化欄位、選定 route 與精確 handle（如有）時完成。拒絕情況需指出缺少的同意、支援或有效封存 handle。
