---
name: lat
description: "使用者指定 LAT 或 LoopAgentTeams 的 Matt skills 流程時使用，協調討論、規劃、委派實作與 QA 驗收。"
---

# LoopAgentTeams

LAT 管理角色、階段轉換與交接；各階段的做法交給對應 Matt skill。

## 角色

- **Orchestrator**：主控 Agent，管理流程、派發、裁決與整合交付；詳細執行交給其他 Agent。
- **Designer**：與使用者討論，接續整理 Spec 與 Tickets；可由主控兼任或外部 Agent 擔任。
- **Implementer**：實作、測試、呼叫獨立 Review、修正與提交。
- **QA**：操作真實應用，依需求與驗收條件測試；與實作者分開。

## 執行清單

Orchestrator 啟動時，將下列清單建立為本次任務的進度紀錄。收到委派結果後，核對完成條件再勾選，並推進下一個可執行步驟。進度記錄在任務中，SKILL.md 保持為模板。

- [ ] 討論：Designer 使用 /grill-with-docs 與使用者釐清需求，確認方向。
- [ ] Spec：同一位 Designer 使用 /to-spec，整理需求、範圍與驗收條件。
- [ ] 使用者確認：讓使用者確認 Spec；已有明確授權涵蓋時直接沿用。這是唯一的正式確認點。
- [ ] Tickets：同一位 Designer 使用 /to-tickets，拆分工作並列出驗收條件與依賴。
- [ ] 派發：Orchestrator 核對規劃，將可開始的 Tickets 交給 Implementer，每張實作任務使用新 context。
- [ ] 實作：Implementer 使用 /implement；所有 Tickets 完成實作、測試、獨立 Review 與必要修正。
- [ ] 整合：Orchestrator 協調整合，由執行 Agent 驗證整合後版本；同版本已有的有效證據可沿用。
- [ ] 驗收：QA 按需求與驗收條件測試；問題交回 Implementer 修正，再複驗。
- [ ] 交付：Orchestrator 核對驗收證據，回報成果與未完成事項；必要驗證未執行時，不宣告完成。

需要 Prototype／Wayfinder 時，加入對應子任務。後續修改若使先前驗證失效，重新開啟受影響項目。

## 按需委派

每次委派前讀取 [Agent 設定](references/agents.md)，明確設定模型、thinking effort 與權限模式；原生 Subagent、HCOM 與各階段內部再委派都適用。

- **Prototype**：需要具體素材驗證設計問題時，委派 /prototype，將成果與結論交回 Designer。
- **Wayfinder**：工作太大、關鍵決策尚未釐清時，委派 /wayfinder 建立與推進決策地圖，結果交回 Designer；需要使用者參與的決策仍由使用者回答。
- **Agent 機制**：Orchestrator 建立或指派外部 Agent／原生 Subagent。外部 Agent 由 HCOM 協調，適合跨 client 或使用者直接互動；原生 Subagent 使用當前 client 的委派能力。

## 交接

- 派發時提供：目標、範圍、授權、Spec／Ticket 位置、驗收條件、工作位置與審查基準。
- 一併提供下方「確認與自動推進」規則，讓接手 Agent 知道何時自行處理、何時回報主控。
- 完成時回報：成果位置與版本、決策證據、測試／審查結果、未完成事項與下一步。
- 接手者先讀交接及引用文件；長對話換 session 時可按需使用 /handoff 整理脈絡。

## 確認與自動推進

Grilling 時與使用者共同討論。Spec 確認後，在已確認的需求、範圍與驗收條件內，自動完成拆票、實作、測試、審查、修正與交付。

Matt skills 中其他流程性的使用者確認，由 Orchestrator 根據既有決策處理：/to-spec 的測試切入點併入 Spec 確認；/to-tickets 的粒度、依賴與拆合由 Orchestrator 核對，不再逐項詢問使用者。

執行 Agent 卡住時先調查與嘗試解決，再將阻礙交給 Orchestrator 協調。只有無法在既定範圍與權限內繼續，需要使用者提供資訊、操作，或改變已確認的需求時，才回來詢問，並說明卡在哪裡、已嘗試什麼及需要的協助。

## 技能銜接

- 啟動前確認所需 Matt skills 與委派能力可用；依 client 支援的方式呼叫，LAT 不改變技能的呼叫限制。
- /implement 已包含 /code-review；Review 另用 Subagents 檢查規範與 Spec，不另設主流程階段。
- 審查範圍須包含本次完整變更。若 /code-review 只比較到 HEAD，先提交待審查變更，避免漏掉未提交修改；修正後再複查。
