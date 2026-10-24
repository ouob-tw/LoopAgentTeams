---
status: accepted
---

# 看板提問：hook 與看板以共用目錄溝通、失敗一律放行

Agent 用 client 的選單提問或要求權限確認時，使用者要能直接在看板作答（Spec ouob-tw/LoopAgentTeams-work#282，共識 v3；第一條路徑 #285；client 的實測在 #284）。做法是 client 的 hook 在選單出現前攔下、原地等看板的答案再填回。

## 決定

1. **hook 與看板之間只有一個共用目錄裡的檔案，沒有連線或 API。**
   - 目錄是使用者層級的 `$XDG_STATE_HOME/lat/board-asks/`（與暫停通訊紀錄同一層），可用 `LAT_BOARD_ASKS_DIR` 覆寫。一筆看板提問一個提問檔，hook 建立；另有一個結果檔，看板的答案與 hook 的逾時標記搶同一個位置：先寫暫存檔再 hard link 到位，已存在就失敗，只有先成功的算數，不用先檢查再改名。看板每 30 秒更新心跳檔。檔案 0600、目錄 0700。
   - 為什麼：任一邊重啟都不會遺失狀態（提問與答案都在檔案裡，看板重啟後題目卡照樣在）；hook 不必知道看板的位址與登入；兩邊都能直接用暫存目錄測試。搶同一個結果檔讓「答案被填回」與「hook 已逾時」只會發生一種，多裝置同時作答也只有一個成功。
   - 代價：看板要監看目錄（加保底重讀）才看得到新提問；hook 以輪詢讀結果檔，答案最慢晚一個輪詢間隔（0.2 秒）才填回。格式是兩邊的約定，改動要同時改 `board/hooks/board-ask.py` 與 `board/src/lib/server/board-asks.ts`。

2. **失敗一律放行：hook 有任何疑問就不輸出決定、以 0 結束，client 照舊顯示原本的選單。**
   - 包括看板心跳超過 90 秒（看板沒在執行）、共用目錄寫不進去、輸入看不懂、任何例外；不在 Herdr 裡執行（沒有 `HERDR_PANE_ID`，看板沒有它的頁面）與 Claude 的 Task 子 Agent（輸入帶 `agent_id`）也不攔。Claude 在 PreToolUse 沒給決定時也會為 AskUserQuestion 發 PermissionRequest，hook 不把它當成權限確認。
   - 為什麼：這個功能壞掉時只該退回現狀，不能讓 Agent 卡十分鐘或拿到亂答的答案。
   - 代價：看板剛停的 90 秒內提問的 Agent 會白等到時限，之後結束這一回合（#286）。

3. **LAT 主控的選單提問改走待答面板，不做成看板提問。**
   - 主控本來就應該用待答面板問使用者，答案進待辦；看板提問的 hook 對主控的 AskUserQuestion 擋下並提醒它改用待答面板（後續的票實作）。主控的權限確認則與一般 Agent 相同，在主控頁作答。
   - 為什麼：主控的問題集中在待辦，使用者用熟悉的方式回答，主控也照 LAT 的規則記錄答案。

4. **逾時之後的答案當成訊息傳話；中斷由看板依 hook 的程序判斷（#286）。**
   - Claude 的 AskUserQuestion 逾時時 hook 輸出 `deny` 加 `continue: false` 結束回合；之後的作答以同樣的互斥建立寫進逾時後答案檔，再走看板既有的傳話（ADR 0003：打進輸入框），送不送得到只看傳話當下重讀的 Herdr 清單。等待中 hook 程序已不在、結果檔也沒有內容時，看板替它搶結果檔寫「已中斷」。
   - 為什麼：被搶一次的檔案讓每個答案只會被填回或被傳話其中一種；Esc 會直接結束 hook，hook 自己來不及記，只有看板能事後看出來。
   - 代價：hook 的程序 ID 剛好被別的程序重用時，看板看不出中斷，卡片停在等待中。

等待時限取 10 分鐘與 client 允許的 hook 執行上限扣 30 秒兩者的較小值；#284 實測兩個 client 在 `timeout` 660 秒下都等滿 620 秒，所以 hook 的 `timeout` 設 660 秒、等待 600 秒。

5. **權限確認也走同一個共用目錄；Codex 逾時交回終端機，Claude 的終端機回答以對話紀錄為準（#288）。**
   - Claude 與 Codex 的 PermissionRequest 寫成 `kind: permission` 的提問，看板答 allow 或 deny。Claude 逾時回 `deny` 加 `interrupt: true` 結束回合（它不理 PermissionRequest 的 `continue: false`，RATI-EXP-3）。Codex 逾時不輸出決定，把終端機原本的確認畫面交還（RATI-EXP-2）：Codex 0.164.0 不支援 `continue`、`decision.interrupt`，plain deny 後模型可能繼續做，送 Esc 又是代按按鍵，沒有可靠的結束回合方法。
   - Claude 的確認畫面與 hook 同時出現，終端機的回答不會寫進結果檔，只看得到對話紀錄裡那個工具呼叫的結果；權限請求又沒有工具呼叫 ID，所以 hook 以工具名稱與工具輸入找 hook 開始後才有結果的那一筆，對不出差別時不判定（RATI-EXP-5）。hook 輸出後必須結束，Claude 才收得到決定，所以輸出後的觀察交給 hook 啟動的脫離程序，看板只讀它寫的結果，自己不解析對話紀錄。
   - Codex 回合先結束後才允許的指令仍會執行（RATI-EXP-4 r3），所以 hook 另裝 Codex 的 Stop 與 PostToolUse：Stop 記回合已結束，PostToolUse 記真的執行了，看板看到執行才傳話通知。
   - 代價：脫離的觀察程序若被 client 一併結束，卡片在時限後標結果不明；Codex 的 PostToolUse 對每個工具呼叫都會啟動一次 hook。
