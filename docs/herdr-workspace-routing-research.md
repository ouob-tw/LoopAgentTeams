# HCOM 建立 HERDR Agent 的 workspace 路由

更新日期：2026-09-21。現行設定與安裝方式見 [設定教學](hcom-herdr-setup.md)。

## 現行方式

HCOM 的 Herdr preset 直接將呼叫端的 `HERDR_WORKSPACE_ID` 傳給 `herdr tab create --workspace`，新 Agent 因此建立於呼叫來源的 workspace。使用者切換 UI 焦點不會改變這個目標。

- `--no-focus` 保留使用者目前的 UI 焦點。
- `--cwd` 決定程序工作目錄，與 workspace 選擇分開。
- `--label` 設定分頁名稱。
- 使用者指定其他 workspace 時，先取得目標 ID，再以 `HERDR_WORKSPACE_ID` 傳入；詳見設定教學。

舊 wrapper 與其名稱／編號查詢方案已停用，專案中的腳本已移除。原先「未指定就使用 server active workspace」的方案也已被上述方式取代。

## 驗證範圍

本次已核對本機 `~/.hcom/config.toml` 與設定教學一致，並確認專案沒有程式引用已移除的腳本。本次未建立 Agent 或分頁，以下執行行為尚未重新實測：

| 情境 | 預期結果 |
| --- | --- |
| 從 workspace A 啟動，UI 焦點在 B | Agent 建立於 A，焦點留在 B |
| 明確傳入 workspace B 的 ID | Agent 建立於 B |
| workspace A 搭配不同工作目錄 | 分頁位於 A，程序使用指定工作目錄 |
