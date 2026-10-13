# LAT 看板：安裝與使用

LAT 看板是跑在主機上的網頁服務。電腦與手機用同一個網址，就能看到所有專案的 LAT 主控目前做到哪、收它們的交付與求助回報、回答待決題，並直接傳話給主控。

它不顯示終端畫面，也不管 LAT 主控以外的 Agent，不做手機推播。Herdr 的待答面板照舊可用，兩邊可以同時使用。開發者與設定細節見 [board/README.md](../board/README.md)。

## 需要什麼

- Node 22 以上：伺服器一律用 Node 執行，建置也要它。
- Bun：用來安裝套件和執行 `board` 指令，沒有 Bun 也行。沒有 Bun 時，需要 Node 22.18 以上，並把 `bun install` 換成 `npm install`、`bun run build` 換成 `npm run build`、`bun run board` 換成 `node src/cli.ts`。
- 已安裝的 LAT 技能，以及它一直在用的 `uv` 與 Python：看板不自己讀寫問題檔，一律呼叫技能裡的面板輔助工具。
- 傳話要用到 `hcom`。

## 安裝與建置

```bash
git clone https://github.com/ouob-tw/LoopAgentTeams.git   # 已有本地工作區就略過
cd LoopAgentTeams/board
bun install
bun run build
```

## 啟動

```bash
bun run board start
```

預設監聽 `0.0.0.0:7100`。用 `--host`、`--port` 改位址與連接埠，例如 `bun run board start --host 127.0.0.1 --port 7200`；也可以用環境變數 `HOST`、`PORT`。之後用 `http://<主機位址>:7100` 開啟。其他設定（狀態目錄、技能位置等）都是環境變數，見 [board/README.md](../board/README.md) 的設定表。

## 配對裝置

沒配對過的瀏覽器只看到配對畫面，什麼資料都拿不到。在主機上執行：

```bash
bun run board pair       # 印出配對碼，只能用一次，5 分鐘內有效
bun run board devices    # 列出已配對的裝置（ID、配對時間、瀏覽器）
bun run board revoke <裝置 ID>   # 撤銷一台裝置，它會回到配對畫面
```

在要配對的裝置開啟看板，輸入 `pair` 印出的配對碼。成功後那個瀏覽器就長期有效，不必再配。更換瀏覽器或清掉網站資料後要重新配對。

## 在背景常駐

範例檔 [board/lat-board.service](../board/lat-board.service) 是 systemd 使用者服務，登出與重開機後都會自動恢復。

1. 先確認 `bun run build` 已完成，並用 `command -v node uv hcom` 查出這三個指令所在的目錄。
2. 複製範例檔並把 `<...>` 換成實際值：`WorkingDirectory` 填專案裡的 `board` 目錄；`PATH` 要含上面查到的目錄，因為服務的 PATH 很短，找不到 `uv` 或 `hcom` 時，待決題與傳話會失敗。

   ```bash
   mkdir -p ~/.config/systemd/user
   cp board/lat-board.service ~/.config/systemd/user/
   ```

3. 啟用，並讓它在沒登入時也跑：

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now lat-board
   loginctl enable-linger "$USER"
   ```

4. 查狀態與紀錄：`systemctl --user status lat-board`、`journalctl --user -u lat-board`。

要改位址或連接埠，改範例檔裡的 `HOST`、`PORT`；其他設定用同樣方式加一行 `Environment=`，改完 `systemctl --user daemon-reload && systemctl --user restart lat-board`。

用背景服務時，主機上的 `pair`、`devices`、`revoke` 仍照上一節手動執行。若你改了狀態目錄（`LAT_BOARD_STATE_DIR`）或其他設定，這些指令要用相同的環境變數，否則改到另一份資料。

## 自訂樣式

把自己的樣式寫在 `~/.config/lat/board/user.css`（設定目錄可用 `LAT_BOARD_CONFIG_DIR` 改）。它在內建樣式之後載入，所有已配對裝置重新載入頁面就會套用；刪掉檔案就恢復預設，不需要重啟看板。

顏色、圓角與字型都是 CSS 變數，例如：

```css
:root {
	--accent: #ff8a3d;
	--radius: 2px;
}
```

可用的變數見 [board/README.md](../board/README.md)。

## 更新

1. 在專案目錄 `git pull`。
2. 重新安裝技能（指令見 [README](../README.md#本地開發) 的「修改後同步安裝」），看板才會用到新版的面板輔助工具。
3. 在 `board` 目錄執行 `bun install` 與 `bun run build`。
4. 若有跑背景服務：`systemctl --user restart lat-board`。

技能更新後，正在跑的主控要從它的下一個回合才開始留下回報紀錄，更新前的訊息不會補上。

## 安全

看板沒有內建加密連線（沒有 HTTPS），配對只擋得住沒有配對碼的人。回報全文可能含內網位址與本機路徑，看板又能對主控下指示，所以只應放在家裡或公司內網、私人網路。需要加密時，自己在前面加反向代理。
