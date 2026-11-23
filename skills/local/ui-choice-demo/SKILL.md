---
name: ui-choice-demo
description: "Use when the user will look at something: before asking them to choose a UI, layout, or interaction, when showing results or a demo, and when a choice is easier to make from a picture. Applies in any conversation and to non-UI questions too. Publishes static HTML with one command instead of hand-starting servers."
---

# 給使用者看的東西，用指令發布成網址

使用者要看得到才看得懂、選得出來。這三種情況都發布成能打開的網址：

- 問介面、版面、互動方式的選擇（看圖比較好選的題目也算，不限介面題）。
- 回報成果。
- 展示 DEMO。

文字和截圖只當補充。網址打不開就先修好再回報。不要用 Claude 的 artifact 工具。

不必發布：只有文字的結果，或使用者要的是檔案或 markdown。只問措辭時用 `ui-copy`。要看真實看板的即時畫面，照舊用專案的測試伺服器，不走這裡。

## 發布

1. 把畫面寫成一個資料夾，裡面有 `index.html`（單一檔案也行）。只要內容片段就好，開頭不是 `<!DOCTYPE` 或 `<html` 時，會自動套共用外框：深淺色、手機寬度、`.card`、`.option`（放在 `.options` 裡會並排）。要比較多個版本，每版包成 `<section data-variant="a" data-title="直排">`，外框會加切換列。完整 HTML 則原樣顯示。
   展示內容的文字至少 18px（外框預設就是 18px，示意畫面內的字也一樣）。不要用縮小來把畫面塞進視窗，放不下就讓它左右滑動。每個版本的說明只寫一句話，詳細比較放在題目裡。
   一頁放很多格嵌入頁面（iframe）比較狀態時，每格各自載入整頁和樣式會很慢（44 格約 220 個請求、3MB）：先用 `fetch` 抓一次頁面與樣式，把樣式內嵌後用 `srcdoc` 給各格，並用 `IntersectionObserver` 只畫畫面附近的區塊；抓不到時退回 `src`。
   展示頁跟隨系統的深淺主題（示意畫面用 `prefers-color-scheme` 切換，配色取自被示意的真實畫面）；只有這頁就是要比較或測試某個特定主題時才固定。
   發布時工具會替每一頁（包外框的片段與完整 HTML 都一樣）自動加上圖片檢視器：點 `<img>` 開全螢幕，一開始整張放得進視窗；滾輪、觸控板捏合、手機雙指縮放，拖曳或雙指滑動移動，Esc、點空白處或右上角 ✕ 關閉。包在 `<a href>`、按鈕裡的圖不會被攔截，仍照連結走；不想讓某張圖可放大就在它或外層加 `data-no-zoom`。iframe 裡的畫面不受影響。只對發布之後的新版本有效，已發布的頁面要重新發布才會有；檢視器是發布時寫進 `index.html` 的，不必自己寫。
2. 發布：

   ```bash
   uv run --no-project python <本技能目錄>/scripts/demo.py publish ./my-demo --name hcom-mailbox
   ```

   名稱用小寫英數與 `.` `_` `-`。同名再發布就覆蓋，原網址重新整理即是新版。指令會自己打開網址確認，成功印出內網網址（含密鑰）；有設定看板網址時，第二行是看板網址（`<看板>/demo/<名稱>/`，已登入看板的瀏覽器在外網也打得開）。給使用者時兩行都整行貼上；失敗會印原因，先修好再繼續。
3. 滿 14 天沒更新的展示會自動清掉，不必手動關。
4. 問選擇時，網址放進題目；用 LAT 面板就交給 `question ask` 或 `question upsert` 的 `--visual`（見 `lat` 技能的 `references/question-panel.md`）。有看板網址時 `--visual` 放看板網址，使用者在外面也看得到。作答仍走面板，展示頁不收點選。

只提供靜態檔案。要先做示意頁時用 `/prototype` 的介面分支（它的 `UI.md`），貼著真實頁面做，不做空頁。

## 沒有網址時（一次性安裝）

指令回報連不上，代表常駐服務還沒裝。埠號與網域不寫進 repo：先看專案 `CLAUDE.md` 指向的主機私人設定檔，把展示用的埠號與網域寫進 `~/.agents/demo.json`：

```json
{"port": <展示用埠號>, "host": "<網域>", "board": "<LAT 看板網址，選填>"}
```

`board` 寫上主機的 LAT 看板網址後，發布時多印看板網址；看板從同一個資料夾提供示意頁，要使用者登入看板才看得到。

再建立 `~/.config/systemd/user/demo-publish.service`，把 `<…>` 換成實際值後啟用（服務的 PATH 很短，所以 uv 要寫完整路徑）：

```ini
[Unit]
Description=Demo static server
[Service]
ExecStart=<uv 的完整路徑，用 command -v uv 查> run --no-project python <本技能目錄>/scripts/demo.py serve
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now demo-publish
```
