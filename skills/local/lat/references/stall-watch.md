# 停住監控

主控 activate 時，`lat-session.py` 自動在背景啟動 `scripts/lat-watch.py run`；deactivate 停止它，compact／resume 發現它不在時重新啟動（見 [主控恢復程序](recovery.md)）。每個主控一支，每分鐘檢查一次。以下 `$lat_dir`、`$workspace`、`$tasks` 是主控 activate 時用的 LAT 技能目錄、工作區根目錄與任務卡目錄絕對路徑。

## 技能文字更新通知

activate 在自己的 session 紀錄保存 `skill_dir` 與 `rule_fingerprint`（`SKILL.md`、`references/` 各檔案的內容指紋，含子目錄）。監控每輪只比對該主控 active 紀錄中的技能目錄；程式、面板、快取與檔案時間變動不會觸發通知。舊紀錄沒有指紋時，以監控首次檢查時的內容建立基準，不追溯通知。

文字改變、references 檔案新增或移除時，監控以 HCOM 傳一則 `LAT skill rules updated` 給該主控，列出變動檔案，請它重讀 `SKILL.md` 與變動的 references（移除的檔案不再讀取），不必請使用者重新輸入 `/lat`。傳送成功後才更新紀錄中的基準，監控程序持續執行時，同一次變動不重複通知；之後再有變動會再通知。重跑 activate 保留已有基準，避免漏掉尚未通知的變動。若監控在傳送成功後、保存新基準前當機，重啟後可能再收到一次相同通知。

讀取或傳送失敗時保持原基準，記錄 `skill-rules-check-failed`，下一輪重試。傳送成功但寫回紀錄失敗時，執行中的監控暫存已送達的指紋，下一輪重試寫回，不重送同一則通知；後續變動以已送達的版本比對。成功寫回記錄 `skill-rules-updated` 與變動清單，位置同下方的 `watch.jsonl`。

## 監控誰、何時出手

監控對象是主控自己，加上 `$tasks` 下（不含 `done/`）`orchestrator` 欄等於該主控、status 還不是 `merged` 的任務卡所列 Agent。hcom-spawn 單獨召喚、沒有任務卡的 Agent 不在監控內。

紀錄檔或 HCOM 事件有變動就算有進展，計時歸零。HCOM 事件以 `hcom list --json` 提供的 session ID 歸屬，不會把其他同短名 Agent 的事件算進來。沒有進展時：

| 狀態 | 門檻 | 監控的動作 |
|---|---|---|
| `listening`，輸入框空，沒有有效等待聲明 | 10 分鐘 | 在它的視窗輸入一則催促（每段停住只催一次） |
| `active`，畫面其實停在空輸入框（狀態卡在 `active`） | 20 分鐘 | 同上 |
| 催促後仍沒進展 | 10 分鐘 | 執行 Agent：通知主控；主控：通知使用者 |
| 主控收到通知後該 Agent 仍沒被處理 | 10 分鐘 | 通知使用者 |
| `active`，畫面仍在執行指令 | 20 分鐘 | 通知上一層一次，不催 |
| `blocked`（等核准） | 10 分鐘 | 通知上一層一次，不催 |
| 輸入框有字、有訊息排隊，字 5 分鐘沒變 | 5 分鐘 | 存檔、清空輸入框、通知使用者 |
| 當前畫面顯示額度用完或模型滿載，或 HCOM 為 `inactive (failure:rate_limit)` | 立即 | 通知上一層一次，不催 |

「上一層」對執行 Agent 是它的主控，對主控是使用者。背景指令還在跑時不算停住。
等核准與其他非輸入框畫面可能在 `hcom term --json` 回傳 `input_text=null`；監控會把它當成「沒有輸入文字」，不會因此略過 `blocked` 通知。

額度與滿載辨識只看 `hcom term --json` 當前可見畫面的 client UI 結構，不以固定行數猜測本輪邊界。Codex 的 `■` 錯誤後若已出現更新的 `Working`、Agent 回覆或非空白新提示，就當作舊輪。Claude 的 `● Usage limit reached` 除了畫面上完整的自動繼續時間與 `esc to cancel`，還必須對得上 Claude 紀錄檔末端未被新 user/assistant 回合取代的 system notice；畫面後面有新的回覆、非空白使用者提示或 `Working` 也會判為舊輪。最後一條輸入區分隔線下的 `⚠ Usage limit reached` 則本身就是當前狀態，不依賴模型列。當前狀態列與舊的主錯誤同時出現時，以狀態列的重置時間為準。這些條件不會把舊畫面或 Agent 回覆引用的同段文字當成錯誤。錯誤與重置時間換行時會先合併再辨識。通知附 Agent、client、畫面可辨識的模型、符合行與重置時間（畫面有寫時）。同一段狀況只通知一次；該畫面消失或 Agent 有新進展後才重新計算。不會對「已用 90%」之類的提前警告發通知。

## 結束回合前

主控與執行 Agent 結束回合前，先做完所有不受待決事項影響的工作並回報。真的只剩等待時，寫明在等什麼再結束：

```bash
uv run --no-project python "$lat_dir/scripts/lat-watch.py" wait --workspace "$workspace" \
  --agent <自己的 HCOM 名稱> --for <決策 ID 或 Agent 名稱> --reason '<一句原因>'
```

- `--workspace` 必須是主控 activate 時的工作區；執行 Agent 在自己的 worktree 工作時也填主控的路徑，否則監控讀不到聲明。
- `--for` 只能填一個對象：主控 activate 時 `--decisions` 目錄裡有檔名以它開頭的紀錄就當決策 ID，否則當 Agent 名稱。每個 Agent 只保留最後一筆聲明；同時等多個對象時，填最先需要回音的那個，其餘寫在 `--reason`。
- 聲明在三種情況失效：自己收到任何新訊息、等待的決策不再是 `pending`、等待的 Agent 成功把訊息傳給自己。監控以雙方在 `hcom list --json` 的確切 session 歸屬核對傳送成功；該 Agent 傳給其他人、可能撞名的短名或僅嘗試傳送都不算回報。失效後若仍在等，處理完新訊息再重新聲明。
- 等核准的工具呼叫或背景指令還在跑時，不需要聲明。

## 收到催促時

催促是一句英文，要求讀未讀 HCOM 訊息、做完不受待決事項影響的工作，否則用 `lat-watch wait` 寫明在等什麼。照做即可：

1. 讀未讀的 HCOM 訊息並處理。
2. 核對任務卡與待決紀錄，繼續還能做的工作，照常回報。
3. 真的沒有可做的事，依上一節聲明等待後結束回合。

催促本身不用回覆，也不必向召喚者報告被催過。

## 主控處理監控通知

監控以寄件者 `lat-watch` 傳 HCOM 訊息到主控對話，開頭是 `LAT stall watcher: agent <名稱>`，寫明停了多久、判斷原因、已做過什麼和需要的處理。

- **執行 Agent 催過仍沒恢復**（`--intent request`）：10 分鐘內依 /hcom-spawn 的排查程序查看它，再做下列其中一項，否則監控通知使用者：讓它恢復進展、更新它的任務卡 status 或 next step、收尾（卡片移到 `done/` 或關閉 Agent），或對它聲明 `lat-watch wait --for <該 Agent>`。
- **可能掛住的指令、等核准**：只通知這一次，不催。查看指令是否該繼續，或處理核准畫面。
- **額度用完、模型滿載**：只通知一次，不催。Codex 模型滿載時改用其他模型；Codex 額度用完時改用另一個還有額度的訂閱帳號，不改用 API 計費帳號。沒有可用訂閱帳號，或 Claude 遇到額度限制時，由使用者決定。監控本身不會換帳號、換模型或重開 Agent。
- **輸入框殘留文字處理結果**：通知寫明結果（已存檔清除，或存檔失敗、文字有變動、排隊訊息已消失、清除無法確認而未清），並附原文與存檔位置；先看結果再判斷輸入框是否已清空，未清就依 /hcom-spawn 的排查程序人工處理。原文不是真人答覆證據；看起來像使用者打到一半的答覆時，在聊天請使用者重新送出。

需要總覽時查目前監控對象、各自狀態與等待聲明：

```bash
uv run --no-project python "$lat_dir/scripts/lat-watch.py" status --workspace "$workspace" \
  --orchestrator <主控 HCOM 名稱> --tasks "$tasks"
```

每次判斷與動作記在 `$workspace/.lat/watch/<主控 HCOM 名稱>/watch.jsonl`，無法辨識而跳過的任務卡也記在這裡（`task-card-skipped`，卡片持續無法辨識期間同一內容只記一次；修好或移走後重新計算）。某一輪檢查出錯時記 `cycle-failed`（錯誤類型與訊息，同一錯誤連續發生時每小時最多記一次），下一分鐘照常再查；狀態檔損壞時改名為 `<原檔名>.corrupt-<時間>` 留存，記 `state-file-reset` 後從頭計時；只有個別 Agent 的狀態損壞時，複製一份同名留存檔，記 `agent-state-reset`，只讓該 Agent 從頭計時；任務卡目錄不存在時只盯主控，記一次 `task-directory-missing`。監控程式本身的錯誤輸出在 `$workspace/.lat/watch/<session-id>.log`。查誤報或漏報時讀這兩份的最後幾行。

## 通知使用者的情況

只有以下情況打擾使用者，用 Herdr 彈出通知加提示音（沒有 Herdr 時只留 HCOM 訊息），同時在主控對話留一則說明：

1. 處理過輸入框殘留文字（不論是否成功清除）。
2. 執行 Agent 催過沒恢復，主控收到通知後 10 分鐘內也沒處理。
3. 主控自己催過沒恢復。
4. 主控自己的指令疑似掛住，或停在等核准畫面（上表的「上一層」通知）。
5. 主控自己遇到額度用完或模型滿載。

主控回到工作後讀到這些說明時，照上一節處理該 Agent；使用者已經收到通知，不必另外轉述，除非需要使用者決定或協助。
