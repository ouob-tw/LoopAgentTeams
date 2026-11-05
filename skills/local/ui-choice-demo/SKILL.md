---
name: ui-choice-demo
description: Use when the user will look at something: before asking them to choose a UI, layout, or interaction, when showing results or a demo, and when a choice is easier to make from a picture. Applies in any conversation and to non-UI questions too. Prefer an openable HTML server over text or screenshots.
---

# 給使用者看的東西，優先給能打開的網址

使用者要看得到才看得懂、選得出來。三種情況都先開 HTML 伺服器，給一個能打開的網址：

- 問介面、版面、互動方式的選擇（不限介面題，看圖比較好選的題目也算）。
- 回報成果。
- 展示 DEMO。

文字和截圖只當補充。網址打不開就先修好再回報。不要用 Claude 的 artifact 工具。

不必開伺服器：只有文字的結果，或使用者要的是檔案或 markdown。只問措辭時用 `ui-copy`。

## 1. 備畫面

依現況挑一種：

- **已有可跑的實作**：在測試伺服器上給實際畫面。各選項的差異做成開關或網址參數，同一個網址就能切換。
- **還沒實作**：用 `/prototype` 的介面分支（它的 `UI.md`）做可切換版本的示意頁，貼著真實頁面做，不做空頁。
- **問的是流程或區塊關係，版本切換幫不上**：畫一張圖，放在能用網址打開的頁面上。

## 2. 決定網址

開伺服器前先看專案的 `CLAUDE.md` 或 `AGENTS.md` 有沒有指向主機私人設定檔。有的話，埠號與網域照那份寫的用，並照它分開測試伺服器與示意頁。沒有就用專案預設。

連結要用使用者那一端打得開的位址：使用者不在這台主機時，`localhost` 打不開。

## 3. 確認打得開

逐一打開要放進題目或回報的連結，確認回應成功，而且顯示的是連結指定的版本。有任何一個失敗就先修好，不發問、不回報。

## 4. 發問或回報

- 成果與 DEMO 直接在回報裡放網址。
- 題目裡放可以直接打開的連結，每個選項一條，帶上版本參數指到那個組合，例如 `?variant=b`。多個維度就都帶上，例如 `?layout=rail&density=compact`。
- 用 LAT 面板問時，連結交給 `question ask` 或 `question upsert` 的 `--visual`，用法在 `lat` 技能的 `references/question-panel.md`。

伺服器留著，直到使用者答覆或看完。答覆後示意頁依 `/prototype` 的規則收尾。
