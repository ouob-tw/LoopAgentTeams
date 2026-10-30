---
name: ui-choice-demo
description: Use before asking the user to choose a UI, layout, or interaction, in any conversation, so the choice comes with something they can open and look at. Also when writing a decision card or question about how a screen should look or behave.
---

# 介面題先給看

使用者要看得到才選得出來。問介面、版面、互動方式的選擇前，先備好能打開的畫面，再發問。只問措辭時用 `ui-copy`，不用這裡。

## 1. 備畫面

依現況挑一種：

- **已有可跑的實作**：在測試伺服器上給實際畫面。各選項的差異做成開關或網址參數，同一個網址就能切換。
- **還沒實作**：用 `/prototype` 的介面分支（它的 `UI.md`）做可切換版本的示意頁，貼著真實頁面做，不做空頁。
- **問的是流程或區塊關係，版本切換幫不上**：畫一張圖，放在能用網址打開的頁面上。

## 2. 決定網址

開伺服器前先看專案的 `CLAUDE.md` 或 `AGENTS.md` 有沒有指向主機私人設定檔。有的話，埠號與網域照那份寫的用，並照它分開測試伺服器與示意頁。沒有就用專案預設。

連結要用使用者那一端打得開的位址：使用者不在這台主機時，`localhost` 打不開。

## 3. 確認打得開

逐一打開要放進題目的連結，確認回應成功，而且顯示的是連結指定的版本。有任何一個失敗就先修好，不發問。

## 4. 發問

- 題目裡放可以直接打開的連結，每個選項一條，帶上版本參數指到那個組合，例如 `?variant=b`。多個維度就都帶上，例如 `?layout=rail&density=compact`。
- 用 LAT 面板問時，連結交給 `question ask` 或 `question upsert` 的 `--visual`，用法在 `lat` 技能的 `references/question-panel.md`。

伺服器留著，直到使用者答覆。答覆後示意頁依 `/prototype` 的規則收尾。
