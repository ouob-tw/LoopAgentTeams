# Codex 壓縮後的 HCOM 說明

## 結論與適用版本

2026-09-29 實測 Codex CLI 0.158.0、HCOM 0.7.26：原設定下，手動 `/compact` 後的下一輪仍會收到完整 HCOM 說明。單純將 SessionStart matcher 加上 `compact`，不能讓 `hcom codex-sessionstart` 額外提供說明；本次不保留這項全域修改。

HCOM 在啟動時透過 `developer_instructions` 提供說明。`codex-sessionstart` 負責綁定 session、更新狀態，回傳不含 additional context。因此「matcher 沒有 compact」本身不足以判定說明遺失。以上結論限於這組版本與實測流程，不代表所有舊版本或自動壓縮都已驗證。

來源（查閱日期：2026-09-29）：[HCOM v0.7.26 的 SessionStart handler](https://github.com/aannoo/hcom/blob/v0.7.26/src/hooks/codex.rs#L329)、[Codex hook 官方說明](https://learn.chatgpt.com/docs/hooks)。官方說明支援 `SessionStart` 的 `compact` 來源，並規定 hook 的文字輸出可成為 developer context；實際是否提供內容仍取決於 handler。

## 設定與復原

HCOM 0.7.26 安裝的設定片段如下；它是既有設定的一部分，請勿用片段覆蓋整份檔案：

```json
{
  "matcher": "startup|resume|clear|fork",
  "hooks": [
    { "command": "hcom codex-sessionstart", "type": "command" }
  ]
}
```

測試過的候選值為 `startup|resume|clear|fork|compact`。HCOM 啟動／接回時會整理自身 hooks，本次 `hcom r` 已將候選值恢復為原值，不必等到更新才發生。[設定合併實作](https://github.com/aannoo/hcom/blob/v0.7.26/src/hooks/codex.rs#L714) 會移除既有 HCOM hook 再加入預期設定。

換機器或更新 HCOM／Codex 後：

1. 記錄兩者版本，檢查 Codex 使用者設定目錄的 `hooks.json` 中，執行 `hcom codex-sessionstart` 的 SessionStart 群組；也從 Codex `/hooks` 確認是否載入、啟用與信任。
2. 用專用 Agent 做一般啟動、手動 `/compact`、下一輪 HCOM 回報及接回測試。比對完整 developer instructions、名稱、session ID 與登記數量；Agent 說「記得怎麼用」或只看摘要，不足以證明重新注入。
3. 若上述行為正常，保持 HCOM 管理的設定，不追加 `compact`。若新版本真的遺失說明，先保存 transcript 與版本，再檢查該版 handler 是否提供 context；不要直接沿用本次無效的修法。
4. 必須測試全域修改時，先通知其他 Codex 使用者、備份原檔，只改對應 matcher。新 hook 定義可能需要重新信任；舊 session 是否重新載入亦須實測，不能只看磁碟內容。
5. 測完逐項比對備份。沒有其他人的同期修改時才整檔還原；有同期修改時，只撤回自己的 matcher 變更，保留其他設定。再次驗證一般啟動與接回，關閉自己建立的測試 Agent。

若說明確實不在 context，暫時由召喚者在下一則任務訊息重送回報對象、`hcom send` 用法與 `hcom <command> --help` 提醒，保存工作後再以 HCOM 接回。這是人工恢復方式，不代表已修好自動壓縮。

## 驗證界線

原始指令、session／訊息證據、全域備份位置與未解事項保存於私人票 [ouob-tw/LoopAgentTeams-work#3](https://github.com/ouob-tw/LoopAgentTeams-work/issues/3)，需求來源為 [ouob-tw/LoopAgentTeams-work#1](https://github.com/ouob-tw/LoopAgentTeams-work/issues/1)。本文件不包含本機 session 資料。

自動壓縮、其他 Codex／HCOM 版本及更新後重測：NOT_EXECUTED。HCOM 官方回報僅準備草稿，須由使用者決定是否送出。

本次實測與實作路徑：

| 路徑 | 可見結果 | 判定 |
| --- | --- | --- |
| HCOM 一般啟動 → 原始 matcher | 完整 HCOM developer instructions、可送回報 | PASS |
| 原始 matcher → 手動壓縮 → 下一輪 | transcript 再出現完整 HCOM 說明 | PASS；問題未重現 |
| 修改全域 matcher → HCOM 接回 | HCOM 將 matcher 恢復原值；其他 hooks 與備份一致 | PASS；候選修法不持久 |
| 專用 session 的 compact probe → 真實手動壓縮 → 下一輪 | 收到 `source=compact`；handler exit 0、stdout 0 bytes | PASS；沒有由 hook 補回說明 |
| 接回 → HCOM 回報 | 同名、同 session ID，完整說明仍在 | PASS |
| 未再附參數的接回 → 核對有效設定 | argv 保留原參數，實際 effort 卻從 low 變成 medium | FAIL：effort 未維持；票內追蹤 |
| 重複附 `--model` 接回 → 啟動失敗 | 第二次接回因重複參數退出 | FAIL：接回異常；票內追蹤 |

Probe 只記錄真實 hook payload、轉交原 handler 並原樣輸出結果，沒有替 handler 產生說明。全域候選 matcher 被啟動流程撤回後，另用 session 專屬 hook 完成 handler 測試；不能把這項結果當成全域候選設定已成功部署。

接回時也要重新核對有效參數。本次 `hcom r` 沿用儲存的 `--model`、effort 設定與 `--yolo` argv，但未附參數的接回畫面及 transcript 顯示 effort 從 low 變成 medium；argv 存在不等於生效。重複附上 `--model` 的第二次接回曾因重複參數而退出。詳細重現證據與後續處理留在私人票，不在此保證某種接回參數組合適用所有版本。
