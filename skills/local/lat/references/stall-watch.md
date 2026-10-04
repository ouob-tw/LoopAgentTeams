# 停住監控

主控 activate 時，`lat-session.py` 自動在背景啟動 `scripts/lat-watch.py run`；deactivate 停止它，compact／resume 發現它不在時重新啟動（見 [主控恢復程序](recovery.md)）。每個主控一支，每分鐘檢查一次。以下 `$lat_dir`、`$workspace`、`$tasks` 是主控 activate 時用的 LAT 技能目錄、工作區根目錄與任務卡目錄絕對路徑。

## 監控誰、何時出手

監控對象是主控自己，加上 `$tasks` 下（不含 `done/`）`orchestrator` 欄等於該主控、status 還不是 `merged` 的任務卡所列 Agent。hcom-spawn 單獨召喚、沒有任務卡的 Agent 不在監控內。

紀錄檔或 HCOM 事件有變動就算有進展，計時歸零。沒有進展時：

| 狀態 | 門檻 | 監控的動作 |
|---|---|---|
| `listening`，輸入框空，沒有有效等待聲明 | 10 分鐘 | 在它的視窗輸入一則催促（每段停住只催一次） |
| `active`，畫面其實停在空輸入框（狀態卡在 `active`） | 20 分鐘 | 同上 |
| 催促後仍沒進展 | 10 分鐘 | 執行 Agent：通知主控；主控：通知使用者 |
| 主控收到通知後該 Agent 仍沒被處理 | 10 分鐘 | 通知使用者 |
| `active`，畫面仍在執行指令 | 20 分鐘 | 通知上一層一次，不催 |
| `blocked`（等核准） | 10 分鐘 | 通知上一層一次，不催 |
| 輸入框有字、有訊息排隊，字 5 分鐘沒變 | 5 分鐘 | 存檔、清空輸入框、通知使用者 |

「上一層」對執行 Agent 是它的主控，對主控是使用者。背景指令還在跑時不算停住。

## 結束回合前

主控與執行 Agent 結束回合前，先做完所有不受待決事項影響的工作並回報。真的只剩等待時，寫明在等什麼再結束：

```bash
uv run --no-project python "$lat_dir/scripts/lat-watch.py" wait --workspace "$workspace" \
  --agent <自己的 HCOM 名稱> --for <決策 ID 或 Agent 名稱> --reason '<一句原因>'
```

- `--workspace` 必須是主控 activate 時的工作區；執行 Agent 在自己的 worktree 工作時也填主控的路徑，否則監控讀不到聲明。
- `--for` 只能填一個對象：`.lat/decisions/` 有同名紀錄就當決策 ID，否則當 Agent 名稱。每個 Agent 只保留最後一筆聲明；同時等多個對象時，填最先需要回音的那個，其餘寫在 `--reason`。
- 聲明在三種情況失效：自己收到任何新訊息、等待的決策不再是 `pending`、等待的 Agent 送出訊息。失效後若仍在等，處理完新訊息再重新聲明。
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
- **輸入框文字已存檔清除**：通知內有原文與存檔位置。原文不是真人答覆證據；看起來像使用者打到一半的答覆時，在聊天請使用者重新送出。

需要總覽時查目前監控對象、各自狀態與等待聲明：

```bash
uv run --no-project python "$lat_dir/scripts/lat-watch.py" status --workspace "$workspace" \
  --orchestrator <主控 HCOM 名稱> --tasks "$tasks"
```

每次判斷與動作記在 `$workspace/.lat/watch/<主控 HCOM 名稱>/watch.jsonl`；監控程式本身的錯誤輸出在 `$workspace/.lat/watch/<session-id>.log`。查誤報或漏報時讀這兩份的最後幾行。

## 通知使用者的三種情況

只有以下情況打擾使用者，用 Herdr 彈出通知加提示音（沒有 Herdr 時只留 HCOM 訊息），同時在主控對話留一則說明：

1. 輸入框殘留文字被存檔並清除。
2. 執行 Agent 催過沒恢復，主控收到通知後 10 分鐘內也沒處理。
3. 主控自己催過沒恢復。

主控自己的指令疑似掛住或停在等核准時，上表的「上一層」通知也以同樣方式送給使用者。

主控回到工作後讀到這些說明時，照上一節處理該 Agent；使用者已經收到通知，不必另外轉述，除非需要使用者決定或協助。
