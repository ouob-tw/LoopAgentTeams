# HERDR 面板與 HCOM 包裹客戶端的狀態不一致

調查日期：2026-10-12，Asia/Taipei。僅調查，未修改程式、設定或重新啟動服務。

## 結論

**已確認狀態不一致，Claude Code 與 Codex 都觀察到「畫面判讀為工作中，面板狀態仍為閒置」。**

這是 HCOM 與 HERDR 的狀態回報來源、會話登記與終端包裹方式相互衝突。原始碼可以解釋目前症狀；尚未用隔離的新客戶端重播完整啟動順序或驗證修正。

## 主機實際證據

- HERDR 客戶端與執行中服務：0.9.3。
- HCOM：0.7.28。此調查會話外層 HCOM 程序的執行檔與目前安裝檔 SHA256 相同。
- HERDR 整合：Claude v10、Codex v8，均顯示 current。
- Codex `wV:pD2`：連續三次讀取 `agent list → agent explain → agent list`，結果都是 `idle → working → idle`；畫面規則為 `screen_working_fallback`。後續再次讀取仍相同。
- Claude Code `wX:p1`：觀察到面板為 `idle`，畫面規則 `live_turn_working` 判定 `working`；稍後客戶端回到等待輸入，畫面規則改為 `live_prompt_box`，屬正常工作狀態變化。
- 兩個會話都已登記 HERDR 官方會話來源：`herdr:codex`、`herdr:claude`。
- 本會話的外層 HCOM 位於 `pts/5`、程序群組 `3249925`；內層 Codex 位於 `pts/88`、程序群組 `3250055`。外層未設定 `HERDR_AGENT`。

這裡確認的是 HERDR 提供給面板的實際狀態與其即時畫面判讀不一致，沒有擷取使用者正在觀看的左側面板圖片，也沒有把 HCOM 的 active 單獨當成真實工作狀態證據。

## 原始碼中的成因

以下來源固定於安裝版本，不以最新主線代替。

1. HCOM 會透過 `pane.report_agent` 回報 `source=hcom`，將 listening 對應 idle、active 對應 working；回報不包含會話識別，且只在狀態變更時傳送。[HCOM delivery.rs:287–298、405–415、477–493](https://github.com/aannoo/hcom/blob/v0.7.28/src/delivery.rs#L287)
2. HERDR 的 Claude/Codex 整合只在 SessionStart 登記會話，沒有持續回報工作／閒置狀態；此版本預期工作狀態由畫面判讀取得。[官方整合說明](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.3/docs/next/website/src/content/docs/integrations.mdx)，以及主機 `/home/swy/.claude/hooks/herdr-agent-state.sh`、`/home/swy/.codex/herdr-agent-state.sh`。
3. 原始碼存在這條確定的衝突流程：先收到沒有會話識別的 HCOM idle 回報，再登記官方會話來源時，舊的 HCOM 狀態來源可以留下；之後 HCOM 的回報因與官方會話來源不同而被忽略。HCOM 未提供會話識別，因此也不能符合接管條件。[HERDR state.rs:736–745、1310–1335、1639–1679、1718–1726](https://github.com/herdrdev/herdr/blob/v0.9.3/src/terminal/state.rs#L736)
   被忽略的回報仍可能收到成功回覆，HCOM 便認為已送達，在同一狀態下不再重送，因此不會自然修復。[HERDR panes.rs:1661–1673](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/api/panes.rs#L1661)、[HCOM delivery.rs:583–603](https://github.com/aannoo/hcom/blob/v0.7.28/src/delivery.rs#L583)
4. HERDR 優先採用保留的回報狀態，畫面判讀出的 working 不會覆蓋有效回報來源的 idle。[HERDR state.rs:2404–2419](https://github.com/herdrdev/herdr/blob/v0.9.3/src/terminal/state.rs#L2404)
5. `agent explain` 會使用目前已知的客戶端種類直接判讀畫面，與背景程序偵測路徑不同，所以它能輸出 working，同時面板仍保留 idle。[HERDR agents.rs:303–325](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/api/agents.rs#L303)
6. HCOM 另開終端造成內外程序群組不同；HERDR 在 Linux 只接受外層前景程序群組成員，內層客戶端不在其中。背景偵測也不直接沿用 `agent explain` 所用的回報種類，因此畫面偵測無法可靠接手。[HERDR linux.rs:468–480、625–627](https://github.com/herdrdev/herdr/blob/v0.9.3/src/platform/linux.rs#L468)、[pane.rs:810–812、875–876、913–921](https://github.com/herdrdev/herdr/blob/v0.9.3/src/pane.rs#L810)

HCOM 自身的狀態更新迴圈仍會讀取資料庫，不能歸因為「它完全沒讀到 active」。[HCOM delivery.rs:92–122](https://github.com/aannoo/hcom/blob/v0.7.28/src/delivery.rs#L92)

上述完整啟動先後次序是依原始碼推導，並非本次擷取到的啟動事件紀錄；已直接觀察到的是兩個客戶端的狀態不一致、官方會話來源以及內外終端差異。

## 修正方向與界線

修正需要讓 HCOM 的狀態回報與 HERDR 官方會話登記能同時運作，或讓 HERDR 在保留會話登記時，可靠辨識包裹內的客戶端並接管狀態。應以「啟動 → 工作 → 等待輸入 → 需要批准 → 結束」驗證兩種客戶端。

HERDR 官方提供 `HERDR_AGENT` 作為包裹程序的種類提示，但這只改善種類辨識，未必能解除舊 HCOM idle 回報的優先權，不能直接宣稱加上該變數就修好。[官方包裹程序說明](https://raw.githubusercontent.com/herdrdev/herdr/v0.9.3/docs/next/website/src/content/docs/agents.mdx)

- 狀態不一致：**FAIL（實際觀察）**。
- 原始碼可解釋原因：**已確認衝突路徑；完整啟動順序尚未重播**。
- 任何修正與修正後驗收：**NOT_EXECUTED**。

## 可重查的唯讀指令

```sh
herdr agent list | jq '.result.agents[] | select(.pane_id=="wV:pD2") | {agent,agent_status,agent_session}'
herdr agent explain wV:pD2 --json | jq '{agent,state,matched_rule,screen_detection_skipped}'
```

目標窗格應仍在工作中；會話結束或窗格關閉後，不應沿用這個歷史 ID 宣稱新狀態。
