# LoopAgentTeams

以 Matt skills 協調多個 AI Agent 協作的流程技能：完整流程由 LAT 管理，輕量協作由 hcom-spawn 召喚外部 Agent。

## Language

**主控**：
LAT 流程中管理階段、派工、裁決與整合交付的 Agent。
_Avoid_: 召喚者（僅限 hcom-spawn）、中控

**召喚者**：
使用 hcom-spawn 透過 HCOM 召喚其他 Agent、交代任務並負責收尾的 Agent。
_Avoid_: 主控、Orchestrator（那是 LAT 的角色）

**停住**：
Agent 還有未完成且無人替它等待的工作，卻已沒有進展、也沒有在等使用者決定或其他 Agent 的狀態。
_Avoid_: 卡住（另指同一問題反覆失敗）、閒置（正常收工也會閒置）

**參謀**：
LAT 主控要向使用者提問前，先替主控在既有授權內裁決，並判斷事情是否真的需要使用者的 Agent；每個主控配兩個，不能放寬授權。
_Avoid_: 顧問、審查者（審查者另指 Review 與 Spec 文件審查）
