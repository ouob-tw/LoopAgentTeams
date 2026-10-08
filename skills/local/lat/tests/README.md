# 主控恢復驗證

供維護者驗證恢復機制；主控執行 LAT 時不需載入。先將 `lat_dir` 設為待測 LAT 技能目錄的絕對路徑；hook 安裝步驟見 [Hook 設定程序](../references/hook-setup.md)。

單元／CLI 合約測試（僅暫存檔，沒有模型或真實 Codex）：

```bash
uv run --no-project python -m unittest discover -s "$lat_dir/tests"
```

在 `skills/local/lat` 執行包含 Textual 面板的完整測試：

```bash
uv run --no-project --with textual==8.2.8 python -m unittest discover -s tests
```

實機測試使用專用 Git 工作區、隔離 `CODEX_HOME`、技能副本與假進度／待決檔，保留原始 transcript 與 hook 設定。若複製 auth，限制權限為 0600，禁止輸出內容；測試完成以 `shred -u` 清除。測試程序結束後清理自己的非機密暫存資源。

1. install preview → install → 正常 `/hooks` 信任；核對其他 command 保留。啟動 Codex 主控載入 `$lat`，讀設定後 activate，完整讀 references 與假進度。
2. `/compact` 後要求繼續。從工具紀錄核對：首個相依動作之前完整重讀紀錄、SKILL、兩份 references、進度與待決紀錄，並核對 tracker；截斷讀取與模型自稱記得均不算通過。
3. 同 session 再 compact 一次，確認同樣恢復並有進度，沒有全文累積或無進度迴圈。完成後 deactivate，再 compact／resume 應零注入。
4. 另一次真實 auto compact：僅對測試程序設定 `-c model_auto_compact_token_limit=<基礎context加餘量>`，用有限假工具輸出跨過門檻；確認真實 auto boundary 的提示在當次 continuation 前，以及首個相依動作前重讀。無法觸發記 NOT_EXECUTED，不用模擬 hook 取代。
5. 行為核對：已授權工作繼續；沒有真人答覆的 pending 仍阻擋；缺獨立 review 不宣告完成。負向核對同 repo 的 no-LAT session、執行 Agent、completed session 零注入。記錄 PASS／FAIL／UNPROVEN／NOT_EXECUTED。

提示 token 數以 `o200k_base` 為代理，目標 ≤300；計入實際紀錄路徑。tokenizer 僅供驗證，不是 helper 依賴。hook 契約與信任機制見 [Codex 官方 hooks 文件](https://learn.chatgpt.com/docs/hooks)；已實測基準為 Codex 0.158.0。

共識工具與回合結束檢查（命令入口、暫存紀錄與 hook payload；不呼叫模型）：

```bash
uv run --no-project python -m unittest discover -s "$lat_dir/tests" -p test_lat_consensus.py
uv run --no-project python -m unittest discover -s "$lat_dir/tests" -p test_lat_session.py
```

真實 Spec 另依 tracker 設定取得最新內文，執行 `lat-consensus.py --spec <內文檔案>`（只檢查）；再以故意改壞的副本確認非零結束與行號。這項證據不由暫存範例取代；待決紀錄的寫入用有授權的紀錄或隔離測試目錄驗證。
