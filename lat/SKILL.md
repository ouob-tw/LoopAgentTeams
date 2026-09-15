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
- [ ] 規劃：同一位 Designer 接續 /to-spec → /to-tickets，交付驗收條件與任務依賴。
- [ ] 派發：Orchestrator 核對規劃，將可開始的 Tickets 交給 Implementer，每張實作任務使用新 context。
- [ ] 實作：Implementer 使用 /implement；所有 Tickets 完成實作、測試、獨立 Review 與必要修正。
- [ ] 整合：Orchestrator 協調整合，由執行 Agent 驗證整合後版本；同版本已有的有效證據可沿用。
- [ ] 驗收：QA 按需求與驗收條件測試；問題交回 Implementer 修正，再複驗。
- [ ] 交付：Orchestrator 核對驗收證據，回報成果與未完成事項；必要驗證未執行時，不宣告完成。

需要 Prototype／Wayfinder 時，加入對應子任務。後續修改若使先前驗證失效，重新開啟受影響項目。

## 按需委派

- **Prototype**：需要具體素材驗證設計問題時，委派 /prototype，將成果與結論交回 Designer。
- **Wayfinder**：工作太大、關鍵決策尚未釐清時，委派 /wayfinder 建立與推進決策地圖，結果交回 Designer；需要使用者參與的決策仍由使用者回答。
- **Agent 機制**：Orchestrator 建立或指派外部 Agent／原生 Subagent。外部 Agent 由 HCOM 協調，適合跨 client 或使用者直接互動；原生 Subagent 使用當前 client 的委派能力。

## 交接

- 派發時提供：目標、範圍、授權、Spec／Ticket 位置、驗收條件、工作位置與審查基準。
- 完成時回報：成果位置與版本、決策證據、測試／審查結果、未完成事項與下一步。
- 接手者先讀交接及引用文件；長對話換 session 時可按需使用 /handoff 整理脈絡。

## 決策權限

使用者確認方向後，Agent 在既定需求、範圍與驗收條件內，自行完成實作取捨、測試、審查與修正。只有需要改變上述共識，或缺少使用者才能提供的資訊／操作時，才回到使用者；其餘問題由 Orchestrator 協調處理。

## 技能銜接

- 啟動前確認所需 Matt skills 與委派能力可用；依 client 支援的方式呼叫，LAT 不改變技能的呼叫限制。
- /implement 已包含 /code-review；Review 另用 Subagents 檢查規範與 Spec，不另設主流程階段。
- 審查範圍須包含本次完整變更。若 /code-review 只比較到 HEAD，先提交待審查變更，避免漏掉未提交修改；修正後再複查。
