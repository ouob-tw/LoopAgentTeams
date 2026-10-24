# LAT 看板

LAT 看板的開發者說明：設定變數、各功能的實作細節、錯誤紀錄與測試。怎麼安裝與使用，見[使用說明](../docs/lat-board.md)，那是唯一的使用說明。

連線沒有加密，登入密碼也以明文傳送，只應在內網或私人網路使用。

## 安裝與使用

安裝、啟動、登入、背景常駐、各功能的操作、自訂樣式與更新，都只寫在[使用說明](../docs/lat-board.md)；本檔每個功能章節的第一行指向使用說明裡對應的章節，下面只放實作細節。

需要 Bun（實測 1.3.14）或 Node 22.17 以上（實測 22.17.0）擇一，以及已安裝的 LAT 技能與它使用的 `uv`、Python。只有 Bun 時，建置、`start`、`password` 都由 Bun 執行；只有 Node 時用 npm 建置，`board` 指令用 `node --experimental-strip-types src/cli.ts`（22.18 以上可省略旗標）。細節見[使用說明](../docs/lat-board.md#需要什麼)。

## 設定

都是環境變數，啟動伺服器與執行主機指令時要一致。

| 變數 | 用途 | 預設 |
| --- | --- | --- |
| `HOST`、`PORT` | 監聽位址與連接埠（也可用 `start` 的 `--host`、`--port`） | `0.0.0.0`、`7100` |
| `LAT_BOARD_BUILD_DIR` | 建置輸出到哪個目錄、`start` 啟動哪一份建置（相對看板目錄）；`bun run build:test` 設為 `build-test`，讓測試不改寫常駐看板正在用的 `build/` | `build` |
| `LAT_BOARD_LAT_DIR` | LAT 技能目錄 | `~/.agents/skills/lat` |
| `LAT_BOARD_HELPER_COMMAND` | 直接指定輔助工具指令（JSON 字串陣列），看板會在後面加上 `board list` 等參數 | 由技能目錄組出 |
| `LAT_BOARD_STATE_DIR` | 看板自己的狀態目錄（已登入裝置、密碼雜湊、回報的已讀與封存、用量列樣式 `usage-style.json`、送出紀錄） | `$XDG_STATE_HOME/lat/board` |
| `LAT_REPORTS_DIR` | 主控回報紀錄目錄，須與 LAT hook 寫入的位置相同 | `$XDG_STATE_HOME/lat/reports` |
| `LAT_USAGE_DIR` | Claude 主控用量檔的目錄，須與狀態列記錄程式寫入的位置相同（見「用量與快取」） | `$XDG_STATE_HOME/lat/usage` |
| `LAT_BOARD_FALLBACK_SECONDS` | 漏掉檔案變動時，最慢幾秒內補上（從變動到畫面更新）；5 到 60 | `60` |
| `LAT_BOARD_HELPER_TIMEOUT_SECONDS` | 輔助工具多久沒回應就放棄；最多是（上一項 − 1）秒的四分之一（每次讀取會連續用兩次輔助工具） | `15`（保底時限 60 秒時實際最多 14.75） |
| `LAT_BOARD_LOGIN_LOCK_SECONDS` | 同一來源連續輸錯 5 次密碼後拒絕登入的秒數 | `60` |
| `ADDRESS_HEADER`、`XFF_DEPTH` | 放在反向代理後面時，從哪個標頭讀真正的來源位址（輸錯次數依來源計算） | 不設定：用連線的位址 |
| `LAT_BOARD_CONFIG_DIR` | 看板的設定目錄，放使用者樣式檔 `user.css` | `$XDG_CONFIG_HOME/lat/board` |
| `LAT_BOARD_INJECT_COMMAND` | 傳話用的輸入指令（JSON 字串陣列），看板會在後面加上 `<HCOM 名稱> <文字> --enter`；文字剛好是 `--help`、`-h`、`--name`、`--go`、`--enter` 這五個之一時，輸入指令會當成自己的選項，所以改分兩次呼叫（第一個字元，再接其餘字元與 `--enter`），輸入框收到的字元不變（這種訊息送出最多慢約 2 秒） | `["hcom","term","inject"]` |
| `LAT_BOARD_INJECT_TIMEOUT_SECONDS` | 輸入指令多久沒結束就放棄 | `15` |
| `LAT_BOARD_HCOM_COMMAND` | hcom 指令（JSON 字串陣列）。新建時看板在後面加上 `<client> --dir <資料夾> --terminal herdr --go --hcom-prompt <第一則訊息>`，喚醒接回時加上 `r <session ID> --terminal herdr --go --hcom-prompt <第一則訊息>`（切換 Codex 模型的接回沒有第一則訊息），兩者之後再接選定的模型與思考強度參數；判斷 client 是否還在（每次讀取資料與喚醒前）時加上 `list --json`，切換模型與在「Herdr」分頁關閉有接 HCOM 的 Agent 時加上 `kill <HCOM 名稱>` | `["hcom"]` |
| `LAT_BOARD_HCOM_TIMEOUT_SECONDS` | hcom 啟動或接回指令多久沒結束就不再等（含 hcom 自己等 client 就緒的時間）；逾時算「仍在啟動」，不算失敗 | `60` |
| `LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS` | `hcom list --json` 多久沒結束就當成讀不到（此時喚醒不送出，名冊沿用上次的清單）；`hcom kill` 也用這個時間，逾時算「停止結果不明」（關閉 Agent 時算結果不明） | `15` |
| `LAT_BOARD_MODEL_OPTIONS` | 表單提供的模型與思考強度（JSON），例如 `{"codex":{"models":["gpt-6.1-sol"]}}`；只取代有寫到的 client 與清單，其餘用內建清單 | 內建清單 |
| `LAT_BOARD_STATUS_POLL_SECONDS`、`LAT_BOARD_STATUS_WORKING_POLL_SECONDS`、`LAT_BOARD_STATUS_POLL_TIMEOUT_SECONDS`、`LAT_BOARD_STATUS_AFTER_ACTION_SECONDS` | Agent 狀態輕量輪詢（只讀 hcom 與 Herdr 的 Agent 清單）：有頁面連著時的間隔、每次讀取的上限、傳話或中斷後補讀的等待 | `5`、`2`、`4`、`2` |
| `LAT_BOARD_HERDR_COMMAND` | Herdr 指令（JSON 字串陣列），看板會在後面加上 `pane list`、`workspace list`、`workspace create --cwd <專案或所選資料夾> --label <名稱> --no-focus`，以及每次讀取資料時的 `agent list`、`workspace list`、`tab list`，傳話與中斷時的 `agent prompt <窗格> <文字>`、`agent send-keys <窗格> esc`，關閉沒接 HCOM 的 Agent 時的 `pane close <窗格>`，調整分頁順序與改分頁名稱時的 `tab list --workspace <工作區>`、`tab rename <分頁> <名稱>`（「Herdr」分頁） | `["herdr"]` |
| `LAT_BOARD_HERDR_TIMEOUT_SECONDS` | 每個 Herdr 指令多久沒結束就放棄 | `10` |
| `HERDR_SOCKET_PATH` | Herdr 的連線介面，用於 CLI 沒有的移動分頁（接回與開新後移到最前面、在「Herdr」分頁調整順序）；逾時同上一項 | `$XDG_CONFIG_HOME/herdr/herdr.sock` |
| `LAT_BOARD_LAUNCH_WAIT_SECONDS` | 新建後多久還沒出現綁定，就在新建紀錄提示「已開分頁，但主控尚未啟用」；喚醒接回後多久還沒在 hcom 清單出現，就在送出紀錄提示「接回後仍未出現」 | `180` |
| `LAT_HCOM_PAUSED_DIR` | 暫停通訊紀錄的目錄（絕對路徑；不是絕對路徑時當成沒設），LAT 停住監控與程序回收讀同一個目錄 | `$XDG_STATE_HOME/lat/hcom-paused` |
| `LAT_BOARD_ASKS_DIR` | 看板提問的共用目錄（絕對路徑；不是絕對路徑時當成沒設），hook 與看板讀寫同一個目錄，兩邊要一致 | `$XDG_STATE_HOME/lat/board-asks` |
| `LAT_BOARD_ASK_WAIT_SECONDS` | hook 讀的：問完原地等多久（秒），測試用來縮短 | `600` |
| `LAT_BOARD_UNPAUSE_WAIT_SECONDS` | 恢復通訊打入接回指令後，最多等多久它以原名稱與原 session 回到 hcom 清單 | `60` |
| `LAT_BOARD_ASR_URL` | 語音輸入用的語音辨識服務（gohakka-infra）網址，例如 `http://localhost:8025`；看板呼叫它的 `/v1/asr/sync`（`whisper-large-v3-turbo`、`zh`）。沒設定或缺下一項時，按麥克風只會提示未設定 | 不設定 |
| `LAT_BOARD_ASR_TOKEN` | 該服務的 JWT。只留在看板伺服器，不會出現在任何給瀏覽器的回應 | 不設定 |
| `LAT_BOARD_ASR_TIMEOUT_SECONDS` | 語音辨識多久沒回應就放棄 | `60` |
| `LAT_BOARD_UPLOAD_DIR` | 附件存放的資料夾（見「附件」）；資料夾是連結或不屬於看板的帳號時拒絕使用 | `/tmp/lat-board-uploads` |
| `LAT_BOARD_UPLOAD_MAX_MB` | 單一附件的大小上限（MB） | `250` |
| `BODY_SIZE_LIMIT` | 伺服器收的請求大小上限（adapter-node 的設定）。約 3 分鐘的錄音會超過預設的 512K，用語音輸入時設成 `2M` | `512K` |
| `LAT_BOARD_TIDY_COMMAND` | 整理長語音用的 Codex app server 指令（JSON 字串陣列），每次整理啟動一個、以標準輸入輸出溝通，用完即結束；模型固定為 `gpt-6-luna`、思考強度 `low`。預設指令關掉 apps、hooks、memories、plugins、skills 說明與各種工具（`config.ts` 的 `TEXT_ONLY_CODEX`），自訂時照用所設的值、不會自動補上 | `["codex","app-server","-c","features.apps=false",…]` |
| `LAT_BOARD_TIDY_TIMEOUT_SECONDS` | Codex 整理多久沒完成就改放原始辨識文字並提示 | `30` |
| `LAT_BOARD_TRANSLATE_COMMAND` | 翻譯對話紀錄英文回覆用的 Codex app server 指令（JSON 字串陣列），每段翻譯啟動一個、用完即結束；模型固定為 `gpt-6-luna`、思考強度 `low`（見「對話翻譯」）；預設指令與自訂時的做法同上 | 同上 |
| `LAT_BOARD_SKILLS_COMMAND` | 列出 Codex 在某資料夾能用的 skill 時啟動的 Codex app server 指令（JSON 字串陣列），以 `skills/list` 詢問，用完即結束（見「傳話給主控」的 skill 名稱提示） | `["codex","app-server"]` |
| `LAT_BOARD_SKILLS_TIMEOUT_SECONDS` | 等 Codex 回 skill 清單多久，逾時就不提示 | `15` |
| `LAT_BOARD_TRANSLATE_TIMEOUT_SECONDS` | 一段翻譯多久沒完成就算失敗，該段留著原文並小字註明 | `60` |
| `LAT_BOARD_TRANSLATE_CONCURRENCY` | 同時最多幾個 Codex 在翻譯，其餘排隊；所有頁面共用 | `3` |
| `LAT_BOARD_TRANSLATE_KEEP_DAYS` | 存下的譯文多久沒用到就清掉 | `30` |
| `LAT_BOARD_CSWAP_COMMAND` | claude-swap 指令（JSON 字串陣列），「額度」分頁讀 Claude 帳號時在後面加上 `list --json --cached-only`（只讀 claude-swap 自己的檔案，不連網、不刷新登入）；看板不會執行其他 cswap 指令 | `["cswap"]` |
| `LAT_BOARD_CSWAP_TIMEOUT_SECONDS` | 上一項多久沒結束就放棄 | `10` |
| `CODEX_MULTI_AUTH_DIR` | codex-multi-auth 的資料夾，「額度」分頁直接讀其中的 `openai-codex-accounts.json` 與 `quota-cache.json`，只取 email、使用中、方案、用量、重置時間與更新時間，不執行 codex-multi-auth；沒設定時用 `$CODEX_HOME/multi-auth` | `~/.codex/multi-auth` |
| `LAT_BOARD_QUOTA_SECONDS` | 「額度」分頁的資料多久讀一次，所有瀏覽器共用 | `30` |

`XDG_STATE_HOME` 未設定時是 `~/.local/state`，`XDG_CONFIG_HOME` 未設定時是 `~/.config`。

## 登入

設定、變更、忘記密碼與輸錯的限制，見[使用說明](../docs/lat-board.md#登入)。實作上：

- `bun run board password` 在終端機輸入時不回顯；標準輸入不是終端機時，改讀前兩行（測試用這個方式）。
- 密碼以 scrypt（N=2^15、r=8、p=1，16 位元組隨機鹽）雜湊後存在狀態目錄的 `password.json`，權限 600，不存明文。伺服器每次登入都重讀這個檔，所以變更立即生效。
- 登入成功就在 `devices.json` 登記一台裝置，瀏覽器拿到 400 天的 HttpOnly cookie；配對碼版本留下的裝置格式相同，升級後照常有效。
- 連續輸錯的計數依 `getClientAddress()` 的來源位址，只存在記憶體，重啟看板就清除。
- 登入畫面與 `/api/login` 之外的路徑都要登入；`/api/*` 與事件串流未登入時回 401，其他頁面轉到 `/login`。

## 待辦

使用方式見[使用說明](../docs/lat-board.md#待辦與已處理)。實作上：

- 待辦只列啟用中主控還沒被記錄的待決題，以及所有主控未讀的交付（`DONE`）與求助（`HELP`）回報；其他回報只更新名冊上的目前階段。已讀與已封存的回報、答過的題目在「已處理」。

- 在待辦點開一筆回報（電腦與手機相同）就標為已讀，已經是已讀時不再送出；已讀狀態所有已登入裝置共用。正在看的那一則留在待辦列表上，離開它（打開別項、回到列表或主控畫面）後才移到「已處理」。回報下方的「標為未讀」把它變回未讀、回到待辦；頁面還停在這筆回報時不會又自動變成已讀，要重新點開才算。
- 回報不論已讀未讀，一律自發出（`time`）起滿 7 天封存，已讀不會讓它更早或更晚封存。封存後仍在「已處理」開啟全文，但點開不改變已讀狀態、沒有「標為未讀」，也不能移回待辦，沒有手動封存。
- 「已處理」是一份新到舊的清單：已讀的回報、封存的回報與答過的題目，依處理的時間排：回報是標為已讀的時間（未讀就封存的用發出時間）、題目是答覆被記錄的時間；只列發出或提問（沒有提問時間時用記錄時間）未滿 30 天的，旁邊的數字也只算這些。`GET /api/archive`（要登入）一次回傳 50 筆（`items`），附下一頁的游標 `before`；帶 `?before=<游標>` 取更早的一頁，頁與頁之間不重複也不漏，最後一頁的 `before` 為 null，格式不對的游標回 400。清單捲到底自動載入下一頁，底部也有「載入更早」按鈕；載入失敗後只用按鈕重試。看板資料更新時重讀最新一頁，接在已載入的較早頁面上；新增的超過一頁時，往下多讀幾頁直到接上。最新一頁讀不出來時顯示「再試一次」按鈕，不會自動重試。
- 答過的題目來自問題檔與它的封存檔（`questions-<名稱>-archive.md`），每次讀取資料時由輔助工具的 `board answered` 讀出：同一題號取最新的一段，已記錄且有答覆的才算。讀的是綁定中主控的問題檔，以及每個不在綁定裡、有回報檔的 session 依它最後回報的工作區與名稱，由輔助工具找出的問題檔（已停用 LAT 的主控也找得到，看板不自己拼檔名）。題目歸給提問訊息所屬的 session；找不到提問的回報時歸給綁定該檔的主控，再不然歸給最後回報的 session。檔案讀不出來時以浮動通知顯示原因。`GET /api/answered?controller=<ID>`（要登入）回傳一個主控答過的題目，供對話紀錄顯示卡片。
- 發出滿 30 天的回報在看板上等於不存在：待辦、已處理與它的數字都不列，也不會再被標為已讀或封存。看板每次讀取資料、推送畫面之後（不拖慢這次讀取，同時只跑一個），找出最新一筆有效紀錄已發出滿 30 天的回報檔，先從已讀與封存狀態清掉這些 session 的項目並存檔，再呼叫輔助工具的 `board prune-reports`（傳入回報目錄、看板自己的時間與這些 session ID）刪檔，同名的職責檔（`<session-id>.duty.json`）一起刪；狀態檔讀不出來或存不進去時這次不刪，存不進去時另以浮動通知顯示原因。所以同一 session 之後再寫回報時從頭編號，不會沿用舊的已讀或封存狀態。輔助工具只看傳入的 session，在 hook 追加回報用的同一把鎖內再確認一次才刪，鎖被佔用就留到下次，鎖檔一律不刪；沒有任何有效紀錄的回報檔不刪。刪除直接移除檔案，救不回來。個別檔案讀不出來或刪不掉時不影響其他檔案；這些失敗與輔助工具本身的失敗都以浮動通知顯示原因，下次讀取再試。
- `POST /api/inbox/read` 與 `POST /api/inbox/unread`（`key`）標為已讀或未讀，都要登入，寫入同一份已讀狀態檔。找不到的回報回 404，已封存的回 409。看板資料（`inbox`）仍帶著未封存的已讀回報，由頁面決定待辦列哪些，「待決／未讀」的數字照舊。
- 名冊依狀態分組（等你、進行中、已交付、閒置、已關閉），組內依最新回報時間新到舊，沒有回報的在組尾，再依專案、名稱、ID；排序在伺服器（`src/lib/server/model.ts`）。閒置或已關閉、最後回報超過 1 天（或沒有回報）的由頁面收進名冊最後的「閒置／已關閉 N ›」彈出框，依 3 天內、1 週內、更早分段（`src/lib/board/roster.ts`）。彈出框寬畫面時盡量與按鈕對齊（按鈕在畫面上半部對齊頂端、下半部對齊底部），位置一律夾在畫面上下各 1rem 之內，內容比可用高度高時在框內捲動；視窗大小改變時，開著的彈出框依同樣規則重新定位。
- 看板每次讀取資料（檔案變動、保底重讀、手動重新整理、載入頁面）都讀一次 `hcom list --json`，不在工作的主控依 session ID 在不在清單上分兩種（`types.ts` 的 `isInactive`）：
  - 閒置：不在面板綁定裡（LAT 已停用）、session ID 在清單上。
  - 已關閉：session ID 不在清單上，不論還有沒有面板綁定。
- 閒置與已關閉的處理方式相同：只要還有未封存的回報（已讀的也算）就留在名冊上，全部封存後才消失；待決題不列入待辦也不能作答（伺服器同樣拒絕），傳話改走喚醒（伺服器拒絕直接打進輸入框）。回報檔刪除後就不會再出現，也無法從看板喚醒。有綁定的主控之後又出現在清單上就恢復為啟用中；面板綁定不會被修改。
- hcom 清單讀不到（逾時、結束碼非 0、格式不符）時，以讀取錯誤的浮動通知顯示原因，並沿用上一次讀到的清單判斷；看板啟動後還沒讀到過時，所有綁定都顯示為啟用中，沒有綁定的都顯示為閒置。每次讀取的輔助工具、hcom 清單與 Herdr 的清單（見「Herdr 分頁」）同時進行，輔助工具讀完清單後再用一次讀答過的題目並確認送出的答覆；保底重讀的間隔扣掉「兩次輔助工具逾時、hcom 清單逾時、Herdr 逾時」中最長的那個。這個最長的時間超過保底重讀時限的一半時（輔助工具逾時已限制在範圍內），時限就保證不了，例如保底重讀時限 60 秒、`LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS` 或 `LAT_BOARD_HERDR_TIMEOUT_SECONDS` 設得比 30 秒更長時。有未結案的接回時，同一次讀到的清單也用來結案，不會再讀第二次。

## 回答待決題

使用方式見[使用說明](../docs/lat-board.md#回答待決題)。實作上：送出後由面板輔助工具寫入問題檔並通知主控，效果與在 Herdr 待答面板作答相同，同一題先送出的答案算數。

- 待決題的提問訊息：同一主控自己的訊息、最後一行以 `DECIDE:` 或 `HELP:` 開頭並含完整的 `<ID> r<版本>`（前後有邊界，`X-1 r1` 不會對到 `X-1 r10` 或 `X-10 r1`）、時間不早於題目的 `asked_at`（沒有值時不看時間），多則符合取最新的一則。看板直接拿對話紀錄裡的訊息比對，不等回合結束才寫入的回報紀錄；回報紀錄只用來判斷提出題目的回合是否已結束（題目寫入後主控有沒有新的回報）。對應規則在 `src/lib/board/question-message.ts`，案例在 `tests/fixtures/question-message-match.json`，Herdr 側欄可共用同一份案例。
- 點開待決題時，進入該主控的對話紀錄，在提問訊息的位置顯示題目卡片，不顯示聊天原文，畫面停在卡片；題號、版本、選項與送出一律取自面板題目。提出它的回合還沒結束（題目寫入後主控還沒有新的回報）而訊息還沒出現時，卡片先放在對話最新的位置（訊息將出現處），訊息出現後卡片原地不動。題目沒有 `asked_at` 時視為回合已結束；主控沒有再回報（例如回合中途當掉）時卡片一直留在最新的位置，仍可作答。回合結束後，往前讀對話紀錄直到題目的 `asked_at`（沒有時到提問的回報時間，都沒有時到對話開頭）找那則訊息（提問訊息不一定是回合最後一則，所以不看回報有沒有問到）；在開著的畫面上剛結束的回合，先在原處等下一份對話紀錄或最多 5 秒（回報可能比對話紀錄早一步寫入）。仍找不到（或紀錄讀不到）才改為只顯示卡片並註明「找不到提出這題的原訊息」，不猜最像的訊息；這時看板仍繼續接收該主控的對話紀錄，之後出現那則訊息就不需重新整理，自動改回在對話紀錄中停在那則訊息。
- 同一則訊息一次問了多題時，打開其中一題，那則訊息的位置依訊息中的題目順序，一張接一張顯示這則訊息問到、且仍在待辦的所有題目卡片，畫面停在被打開的那一張；其他卡片同樣可以作答，答過的以唯讀卡片顯示。
- 主控畫面與打開某一則時的對話紀錄裡，主控自己的訊息只要照上述規則問到仍在待辦或答過（30 天內）的題目，就直接在訊息的位置顯示這些題目卡片（同一則問多題時依訊息列出的順序連續排列），所以訊息一出現就是卡片；被打開的那一題與同訊息的其他題在那一處一起顯示，畫面停在被打開的那張。看板沒有題目資料（超過 30 天、聊天作答等）時照舊顯示文字；題目比訊息晚到時，題目出現後改為卡片。
- 題目卡片（不論在哪裡顯示）依序顯示說明、選項、推薦，最後接面板題目的詳細資訊 `details`，直接顯示、不折疊；輔助工具沒有提供或為空時，卡片照原樣。送出後的狀態文字、唯讀卡片的版面與改版的處理見使用說明。
- 在對話紀錄裡送出答案後，那張卡片在答案送出期間與之後 2.5 秒內停在畫面原處，直到使用者捲動或點按對話紀錄以外的地方（改點另一張卡片時，改為讓那一張停在原處，不被上面變短的卡片帶走）：卡片變短而後面內容不夠時，在對話紀錄最後補空白，不讓畫面往回捲；畫面在最上面時上方的待決題列消失，就在對話紀錄最前面補上同樣高的空白，捲過它之後空白拿掉、畫面不跳；之後載入更早的紀錄時，空白只留卡片停在目前位置需要的高度。主控記錄答案後，題目從待辦消失到重讀答過的題目之間，頁面先把它當成已記錄、留在答過的題目裡（`question-message.ts` 的 `justRecorded`），卡片不會消失再出現。
- 答案寫入了但通知主控失敗時，顯示「已送出，但通知主控失敗」與「重新通知」按鈕，所有裝置都看得到。按下才會重送，看板不會自己重送；重送不會改寫答案。重送回報「沒有待送的通知」只表示沒有東西要重送。通知失敗時待送通知沒能存下來也一樣能重送：只要答案已寫入、主控還沒記錄，而且沒有送達過通知，就算有通知要送。重送也送不到時，請在聊天告訴主控。
- 經看板送出的答案記在 `sent-log.jsonl`，和傳話紀錄一起顯示在該主控的資訊頁，狀態會從「已送出，等主控記錄」變成「已記錄」；送出後題目被主控改版則顯示「題目已改版」。在 Herdr 面板作答的不在這份紀錄裡。
- 主控停用 LAT 時還在等記錄的答覆，看板會再讀一次它留下的問題檔：已記錄就顯示「已記錄」，題目已改版照樣顯示「題目已改版」，沒有記錄則顯示「主控已停用 LAT，沒有記錄這份答覆」；問題檔或那一題讀不到時顯示「主控已停用 LAT，無法確認這份答覆有沒有被記錄」。之後不再重讀，除非同一個主控再次啟用。

## 部署

使用說明：[更新](../docs/lat-board.md#更新)。

`scripts/deploy.sh` 把已提交的 `HEAD` 部署到常駐看板：`git worktree add --detach` 開臨時資料夾、連結 `node_modules`、以 `LAT_BOARD_BUILD_DIR=<看板目錄>/build-new`（絕對路徑）建置，成功且有 `build-new/index.js` 才換：`build` → `build-prev`、`build-new` → `build`，再重啟並輪詢登入頁。換之前的任何失敗都只清掉臨時資料夾與 `build-new`；兩次改名之間失敗或被中斷會把 `build-prev` 放回 `build`；換之後重啟失敗或登入頁不回 200，則放回 `build-prev`、重啟並再確認一次登入頁，通過才說「previous build restored and running」，否則提示檢查服務，兩種情況結束碼都是 1。腳本會把 `~/.bun/bin` 與服務單元的 PATH 補進自己的 PATH，Agent 的 shell 找不到 bun 也能跑。用 `trash` 刪除（沒有 `trash` 指令的主機要先裝）。設定（環境變數）：

| 變數 | 用途 | 預設 |
| --- | --- | --- |
| `LAT_DEPLOY_BOARD_DIR` | 要部署的看板目錄 | 腳本所在的看板目錄 |
| `LAT_DEPLOY_UNIT` | 重啟的 systemd 使用者服務名稱 | `lat-board` |
| `LAT_DEPLOY_RESTART` | 重啟指令（交給 `sh -c`） | `systemctl --user restart <服務名稱>` |
| `LAT_DEPLOY_BUILD` | 在臨時資料夾的看板目錄執行的建置指令 | `bun run build` |
| `PORT` | 確認登入頁用的連接埠（位址固定 127.0.0.1） | `7100` |
| `LAT_DEPLOY_WAIT` | 等登入頁回 200 的秒數 | `60` |

測試在 `tests/unit/deploy-script.test.ts`：用暫存的 git 倉庫與看板目錄、複製檔案當建置、寫紀錄當重啟、測試內的假伺服器當登入頁，不碰正在跑的服務與 7100。

## 資料怎麼更新

使用方式見[使用說明](../docs/lat-board.md#資料怎麼更新)。實作上：伺服器監看面板綁定登記、各主控的問題檔與回報紀錄目錄，有變動才重讀；保底重讀的間隔見設定表的 `LAT_BOARD_FALLBACK_SECONDS`，為什麼有固定間隔見 ADR 0003 決定 1 的補記。

浮動通知分成一次性的（操作結果）與持續中的（連線中斷、讀取錯誤、送出紀錄讀寫失敗、作答途中題目被改版），後者在狀況解除後自動移除。回報內容、題目說明、選項內容與推薦、對話紀錄的 Markdown 顯示在 `src/lib/board/markdown.ts`：文字裡的 HTML 一律當成文字，不安全的連結與圖片不顯示。

## 對話紀錄

使用方式見[使用說明](../docs/lat-board.md#對話紀錄)。實作上：主控資訊頁（啟用中、閒置與已關閉的主控都有）的「對話紀錄」由新到舊列出你打的每則訊息與主控的每段文字回覆，包括回合中途沒有帶標籤的回答。資料由面板輔助工具的 `board transcript --client <claude|codex> --session-id <ID> [--before <游標>]` 讀 client 自己的紀錄檔產生，看板只呼叫它（ADR 0003 第 1 點）。

- 紀錄檔：Claude 是 `$CLAUDE_CONFIG_DIR/projects/*/<session>.jsonl`，Codex 是 `$CODEX_HOME/sessions/*/*/*/rollout-*-<session>.jsonl`，找不到再看 `archived_sessions/`；沒設定時分別是 `~/.claude`、`~/.codex`。看板以背景服務執行而你改過這兩個目錄時，服務也要設定相同的變數。
- 算「你說的話」的只有真人輸入，包括看板傳話、在 client 忙碌時打的字與 `/lat` 這類斜線指令。hook 附加的內容、系統提示、hcom 投遞、lat-watch 提醒、子 Agent 的內容都不算；其中 hcom 投遞、lat-watch 提醒與 hook 提示算成操作。
- 兩段文字之間的操作合成一行「⋯ 做了 N 個操作」，點一下展開成每個操作一行：寫檔與改檔只顯示路徑，讀檔與搜尋顯示路徑或搜尋字串，讀網頁只顯示網址、不含 `?` 之後的參數，指令只有在整段只有一行、而且只用英文字母、數字、空白與 `-_./:=,@+%` 這些字元時才完整顯示（最多 80 字）；其他指令（含引號、`$`、`>`、`|`、`;`、換行等）只顯示程式名稱，例如「printf …」（`git log | head` 也只顯示「git …」），連程式名稱都看不出來時只顯示「執行指令」；不確定參數安不安全的工具只顯示名稱；失敗的操作前面有「✗」。不顯示任何輸出或檔案內容。
- 一頁是最後 50 段文字（你的訊息加主控文字）和其間的操作；捲到清單底部時自動取再早的 50 段，底部的「載入更早」按鈕也可以手動載入，載入失敗後只能用按鈕重試。每個項目帶著它在整段對話裡的位置（`seq`），頁與頁之間不重複也不漏。
- 頁面開著時，伺服器監看那個紀錄檔，有變動 5 秒內推送最新一頁（`/api/transcript/events`）；一次多出超過 50 段時只留新的一頁，更早的可再載入。紀錄檔還不存在時（輔助工具回 `not_found`，例如剛開的 session）推送空的對話、不跳通知；讀不出來時以浮動通知顯示原因，資訊頁其他區塊不受影響。兩者之後都每幾秒再試。關掉頁面時，還在讀的輔助工具連同它開的 Python 一起結束。
- 讀不出來的行會略過，這一區上方註明「有 N 行紀錄讀不出來，已略過」：不是 JSON 物件的行，以及欄位型別不對的紀錄（只略過那一筆，前後照常）；client 還在寫的最後一行不算。

## 對話翻譯

使用方式見[使用說明](../docs/lat-board.md#對話翻譯)。實作上：翻譯圖示是 `TranslateToggle.svelte`（`aria-pressed` 的按鈕，名稱「翻譯成中文」），主控資訊頁、Herdr 分頁的 Agent 頁與已關閉 Agent 頁共用同一個對話紀錄元件（`Transcript.svelte`，以對話的 id 判斷是不是同一個對話）。

- **對話翻譯偏好**（設定的「對話翻譯」：自動翻譯／手動切換，`translatePref.mode`）：所有已登入裝置共用，存在看板狀態目錄的 `translate-mode.json`（`{"mode":"auto"|"manual"}`，權限 600，原子寫入），還沒存過、檔案壞掉或內容不是這兩個值時是 `manual`（手動切換，下次存檔會蓋掉壞檔）。做法與用量列樣式相同：`GET /api/translate-mode` 讀、`PUT /api/translate-mode`（本文 `{"mode":…}`）寫，都要登入，回應與 `translate-mode` 事件都是 `{mode, revision}`，頁面只採用比已套用的更新的 `revision`；別的值回 400，存檔失敗回 500 且維持原值、不推送。存檔後所有開著的頁面立刻套用，新連上的頁面一連上也會收到目前的值。頁面只在看板回報存好了才換；存檔失敗時顯示「對話翻譯偏好沒有存成功」浮動通知，按鈕維持原樣。瀏覽器不再讀寫舊的 `lat-board-translate`，頁面載入時會把它清掉（`prefs.ts` 的 `LEGACY_TRANSLATE_KEY`）。
- **翻哪些**：只翻主控或 Agent 的文字回覆，而且要判斷為英文：拿掉程式碼區塊（以看板的 Markdown 解析判斷，含縮排、清單與引言裡的程式碼框）、行內程式碼、網址與含 `/` 的字（路徑等）之後，至少有 3 個英文單字（兩個字母以上），而且中日文字數不超過英文單字數的一半（`src/lib/board/translate.ts` 的 `isEnglish`）。你的訊息、操作行、以題目卡或回報卡顯示的訊息都不翻；列在對話紀錄裡、帶回報標記（完成／求助）的回覆照常翻，標記保留。只翻已載入到畫面上的段落：最新一頁、往下捲載入的更早頁、即時推送的新回覆，不預先翻整段歷史。
- **請求**：頁面把還沒問過的英文段落（新的在前）一起送到 `POST /api/translate`（`{ "texts": [...] }`，一次最多 50 段，段數超過就分成幾個請求；單段超過 20000 字不翻，該段回失敗「太長，不翻譯」，同一請求的其他段照常）。伺服器以 NDJSON 回答，每段好了就送一行 `{"index":0,"text":"…"}` 或失敗的 `{"index":0,"error":"原因"}`，已存的譯文立刻送出，不用等其他段。端點跟其他 API 一樣要登入。
- **伺服器翻譯**：每段開一個 Codex app server（`LAT_BOARD_TRANSLATE_COMMAND`）跑一個回合，同時最多 `LAT_BOARD_TRANSLATE_CONCURRENCY` 個，其餘排隊；頁面離開（關閉、換頁、關閉翻譯）時，排隊中、還沒開始而且沒有其他頁面要的段落直接取消，不會再啟動 Codex，已經開始的照樣翻完並存下；呼叫與逾時做法和語音整理相同（`src/lib/server/codex-turn.ts`）：開 thread 前先以 `config/read` 讀出 Codex 設定的 MCP 伺服器，在 `thread/start` 的 `config` 逐一關掉（自訂指令也一樣），所以不必等它們啟動；翻譯另以 `baseInstructions`（`translate.ts` 的 `BASE_INSTRUCTIONS`）取代 Codex 內建的寫程式指示。`~/.codex/AGENTS.md` 目前沒有設定能關掉（codex-cli 0.163.0 的 `project_doc_max_bytes` 只管專案內的檔案），仍會載入。Codex 邊寫邊回報譯文（`item/agentMessage/delta`），一段的 `</reply>` 出現就檢查記號、記進譯文快取並送出那一段（`translations.json` 在這批結束時寫一次），不等同批其他段；回合結束時補上其餘，回合失敗時只有還沒送出的段落算失敗；同一段被 Codex 寫了兩次時，串流中已送出的第一次為準（回合結束才一起看到的重複仍算失敗）。送出前把程式碼區塊（同上的判斷，整行換掉）、行內程式碼、網址與含 `/` 的字換成 `⟦0⟧` 這類記號，Codex 只翻其餘文字並保留 Markdown 結構，回來後用 opencc-js 轉成台灣正體、再把記號換回原文，所以這些內容與原文完全相同；記號少了或重複就算失敗。指令、檔名等沒加反引號的技術詞由提示要求維持原樣。
- **存放**：譯文以原文的 SHA-256 為鍵存在狀態目錄的 `translations.json`（權限 600，不存原文），所有裝置共用，重開頁面或換裝置直接用、不再呼叫 Codex。同一段文字正在翻時又被要求，等同一次翻譯。每段記最後使用時間（最多一小時更新一次），每次請求與每次存檔時清掉超過 `LAT_BOARD_TRANSLATE_KEEP_DAYS` 天沒用到的。失敗不存；同一段失敗後 5 分鐘內再被要求，直接回同一個失敗原因、不再呼叫 Codex（只記在記憶體，重啟看板就清掉），過了才會再翻。
- **紀錄**：失敗寫一行 `[translate] Codex translation failed: …` 到錯誤紀錄，附 Codex 標準錯誤輸出的最後 300 字；對話文字（原文與換成記號後的文字）在讀取時就換成「…」，再截短，所以再長的原文被 Codex 原樣印出也不會留下片段。
- 測試以 `tests/fake-codex.mjs` 代替 Codex：`tests/unit/translate.test.ts`（英文判斷、記號、快取命中與過期、同時數、失敗與 5 分鐘內沿用、出錯不中斷、頁面離開取消排隊、頁面請求）、`tests/server/translate-server.test.ts`（登入、串流、重啟後沿用、30 天過期、失敗與逾時、頁面離開取消排隊）、`tests/browser/translate-page.test.ts`（真瀏覽器：預設關閉不送請求、翻譯中與替換、看原文、重新整理回到原文、失敗小字、載入更早只翻新的一頁、手機寬度）、`tests/server/translate-mode.test.ts`（共用偏好的讀寫：未登入、不合法的值、跨裝置推送與重啟後沿用、存檔失敗、壞檔）、`tests/browser/translate-mode-page.test.ts`（真瀏覽器，使用起點加 77 與加 78：兩種偏好的頁面行為、圖示只改目前對話、他處改變即時跟隨、存檔失敗的通知、舊的裝置開關被清掉）；自動翻譯下三種頁面的行為見 `tests/browser/page-navigation.test.ts`。

## Herdr 分頁

使用方式見[使用說明](../docs/lat-board.md#herdr-分頁)。實作上：中間欄頂端的「待辦／Herdr」分頁（對輔助技術是一組按下狀態的按鈕，與待辦的檢視切換相同）切換兩份清單。「Herdr」分頁列出 Herdr 所有工作區裡的每一個 Agent，名冊、待辦與主控資訊頁不受影響。

- 名單：每次讀取資料（與輔助工具、hcom 清單同時）執行 `herdr agent list`，並用 `workspace list`、`tab list`（不帶 `--workspace`，一次列出所有分頁）取得工作區與分頁名稱。每個 Agent 以 Herdr 回報的 client session ID（`agent_session.value`）為鍵；Herdr 還不知道 session ID 的 Agent 照樣列出，但沒有鍵，不能點開，清單上註明原因，等 Herdr 回報後才能開啟。不在 Herdr 清單上的 Agent 不列，包括只在 hcom 清單上的（tmux 裡的、子 Agent）；從 Herdr 清單消失就從分頁消失。
- 是否接 HCOM：`hcom list --json` 裡有同一個 session ID 的 Agent，沒有時看 `launch_context.pane_id` 是不是同一個窗格（還沒有 session ID 的 Agent 只看窗格）。配對到的顯示 HCOM 名稱與 HCOM 狀態（`active` 工作中、`listening` 閒置、`blocked` 等待輸入，其他是不明）；沒配對到的顯示 Herdr 分頁名稱（沒有時用終端機標題）與 Herdr 的 `agent_status`（`blocked` 等待輸入、`done` 已完成、`working` 工作中、`idle` 閒置，其他是不明），見 ADR 0003 第 2 點的補記。
- 面板綁定登記裡有它的 session ID 的標為 LAT 主控（綁定登記讀不到時沿用上次讀到的）。
- 工作區：`workspace list` 的每個工作區依編號列出（`snapshot.workspaces`，讀不到時沿用上次的），沒有 Agent 的也列標題與「沒有 Agent」；只有 Agent 記著、清單上沒有的工作區排最後，沒有「＋」。
- 排序在伺服器（`src/lib/server/agents.ts`）：照 Herdr 自己的順序，依 Herdr 工作區編號分組（不在工作區清單上的排最後），組內依分頁位置，同一分頁內依 `herdr agent list` 列出的窗格順序；只因模型切換未完成而列出、已不在 Herdr 的排在該組最後。狀態改變不會移動位置。
- Herdr 的三份清單任一讀不到（結束碼非 0、逾時、不是預期的 JSON 或格式）時，以讀取錯誤的浮動通知顯示原因，分頁沿用上次讀到的清單；看板啟動後還沒讀到過時清單是空的。
- hcom 清單讀不到時沿用上次讀到的配對：配對結果依 session ID 記住（沒有 session ID 的依窗格），當時配對到的照舊顯示 HCOM 名稱與當時的狀態，換了窗格也一樣；當時已確認沒接的照舊是沒接；同一個窗格換成新的 session 不會接手舊的配對，算是讀不到期間才出現的。看板啟動後還沒讀到過，或在讀不到期間才出現的 Agent，HCOM 連線標為「無法確認」，名稱與狀態暫用 Herdr 的。之後讀到清單就恢復。
- 清單跟著看板的資料推送更新（`snapshot.agents`）：Agent 開啟、關閉或狀態改變不會動到看板監看的檔案，所以狀態另由輕量輪詢帶到畫面上：有頁面連著時每 `LAT_BOARD_STATUS_POLL_SECONDS`（預設 5）秒（有 hcom 回報工作中的 Agent 時改為每 `LAT_BOARD_STATUS_WORKING_POLL_SECONDS`，預設 2 秒，讓按 Esc 後的結束也來得及在 5 秒內看到並確認）只讀 `hcom list --json` 與 Herdr 的三份清單，經同一套名冊更新 `agents` 與 `workspaces`，狀態有變才推送；從看板傳話或中斷後 `LAT_BOARD_STATUS_AFTER_ACTION_SECONDS`（預設 2）秒內再讀一次；沒有頁面連著時不讀，兩份清單各以 `LAT_BOARD_STATUS_POLL_TIMEOUT_SECONDS`（預設 4）秒為限，上一次還沒結束不會重疊，整批重讀進行中也照讀（整批重讀等輔助工具時不擋狀態），整批重讀以自己開始之後才讀到的輪詢結果取代它較舊的兩份清單，不會把新狀態蓋回舊的，兩份都讀不到時不更新；傳話或中斷後的補讀排定後不會被後一次動作往後推；暫停紀錄只用 hcom 清單判斷是否結束，不查 Herdr 窗格（那一步留給整批重讀，它不受這個時間上限約束）。hcom 回報 `active`、Herdr 卻回報同一窗格閒置或已完成時（按 Esc 中斷後 hcom 的停止 hook 不會跑，常見），名冊（`agents.ts` 的 `hcomBehind`）要兩次讀取相隔至少 1 秒都如此才把狀態改為閒置，第一次看到時輪詢約 1.1 秒後再讀一次（`confirming`／`LAG_CONFIRM_MS`），所以停止鈕（`controllerInterruptible` 看這個狀態）在 5 秒內消失（輪詢最慢 2 秒一次再加確認那一次）；只有 `active` 才這樣處理，`blocked`、`listening` 與讀不到的清單照舊。其餘變化（含開啟與關閉）仍等整批重讀，最慢同保底重讀的時限；其他來源的檔案變動、重新整理按鈕與載入頁面也會一起重讀。
- 點進 Agent（網址 `?agent=<session ID>`）的版面與主控資訊頁相同：上方一行之後是共用的用量小字（`UsageLine.svelte`），工作位置（與主控共用 `placeText`；分頁位置由每次讀取的 `tab list` 算出，存在 `herdr.tabPlace`）、狀態來源與 Session ID 在「詳細資料」裡；目前的模型與思考強度、用量都來自頁面已開著的對話紀錄即時推送，不另外讀取。傳話、中斷與切換模型都在指令列：開著 Agent 頁面時，沒有 `@名稱` 的內容傳給它（每個 Agent 的草稿只存在頁面記憶體），模型與思考強度的部分換成 `AgentModelPicker.svelte`。對話紀錄與主控資訊頁共用同一套顯示、往下捲載入更早與自動接上新內容（見「對話紀錄」）；紀錄檔還不存在（輔助工具回 `not_found`，例如剛開的 session）時推送空的對話、不跳通知，照常每 4 秒重試；其他讀不到的情況以浮動通知顯示原因。Agent 從 Herdr 清單消失後，開著的頁面改說它已不在清單上。
- 端點（都要登入，未登入回 401）：`GET /api/agents` 回傳目前的清單；`GET /api/agents/transcript?session=<ID>[&before=<游標>]` 與 `GET /api/agents/transcript/events?session=<ID>` 對應主控的 `/api/transcript` 與 `/api/transcript/events`，以 Agent 在 Herdr 回報的 client 呼叫輔助工具的 `board transcript`；「已關閉」清單上的 session 也接受，client 用已關閉紀錄的（看板最後看到它時 Herdr 回報的）。兩份清單都沒有的 session ID 回 404，不呼叫輔助工具。下面的傳話、中斷、關閉與操作紀錄端點同樣要登入。
- 傳話（`POST /api/agents/send`，`session`、`text`）：有接 HCOM 的用傳話給主控的輸入指令（`hcom term inject`，見「傳話給主控」，CR 一樣換成 LF）；沒接的用 `herdr agent prompt <窗格> <文字>`。Herdr 0.9.5 一律把窗格後面那個參數當成文字（`--wait`、`--help` 也一樣），所以文字原樣傳入，不需要分次。HCOM 連線無法確認時拒絕（409），指令列也停用。
- 中斷（`POST /api/agents/interrupt`，`session`）：`herdr agent send-keys <窗格> esc`，有沒有接 HCOM、連線能不能確認都一樣。開著 Agent 頁面時，Agent 不是閒置或已完成，送出鈕左邊就多一顆紅色停止鈕（有沒有打字都一樣，按了不清輸入框），按一次就直接送出，沒有確認框；送出還沒有結果前停止鈕停用。主控也用這個端點，見「傳話給主控」。
- 關閉（`POST /api/agents/close`，`session`）：有接 HCOM 的用 `hcom kill <HCOM 名稱>`（hcom 會連它的窗格一起關掉；名稱是 `all` 或以 `tag:` 開頭時拒絕，因為 hcom 會當成多個 Agent），沒接的用 `herdr pane close <窗格>`。這次讀到的窗格就是看板自己所在的窗格（`HERDR_PANE_ID`）時拒絕（409）；有接 HCOM 的另在 kill 前重讀 `hcom list --json`，hcom 記的窗格（`launch_context.pane_id`，依 session 配對時可能與 Herdr 的不同）是看板自己的、清單讀不到或已沒有這個名稱時也拒絕；HCOM 連線無法確認時也拒絕（409），頁面上的關閉按鈕停用。指令成功後以 `herdr pane list` 核對窗格已經不在（最多 5 次、每次隔 0.4 秒），確認後才算關閉成功，並立刻重讀資料，Agent 從清單消失；指令失敗、逾時或核對不到都回 502，原因說明是失敗還是結果不明。頁面先問一次，確認畫面依 Agent 說明關閉後能不能接回：LAT 主控可以從主控資訊頁喚醒；有接 HCOM 的一般 Agent 有對話紀錄的話，7 天內可以從「已關閉」接回；沒接 HCOM 的看板沒辦法接回。
- 三者都只試一次、不重送，與傳話給主控、喚醒、切換模型排在同一個 session 的隊伍裡（`queued`），依序執行。每次請求先重讀一次資料（與重新整理按鈕相同），以這次讀到的 Herdr 清單與 hcom 配對決定窗格、HCOM 名稱與走哪條路，不看頁面送來的其他欄位：Agent 已不在 Herdr 清單上，或這次 Herdr 的清單讀不到（只有上次的清單可用），都拒絕（409）且不執行任何指令。Herdr 拒絕時（結束碼非 0，標準錯誤是 `{"error":{"code","message"}}`）以 `message` 為原因回 502；`agent_blocked`（停在確認畫面）另外說明。輸入指令或 Herdr 指令逾時算失敗，原因裡提醒文字可能已經送進去。
- 操作紀錄：每次傳話、中斷與關閉（成功、失敗或拒絕）都寫一行 `sent-log.jsonl`（`kind: agent-action`；`action` 是 `send`、`interrupt`、`close`，或下面的 `move`、`rename`、`resume`，另有 `agentId`（session ID）、當時的名稱與窗格、`route`（`hcom`、`herdr`，拒絕時 null）、文字、結果與原因）。`GET /api/agents/log?session=<ID>` 回傳這個 Agent 的紀錄（新的在前），不在目前清單上的回 404，所以關閉成功後就不再提供；頁面的「操作紀錄」分頁顯示它。傳話與中斷不一定改變看板資料，所以每次寫入後伺服器另外推送 `agent-action` 事件（`{agentId}`），開著這個 Agent 紀錄的頁面（任何裝置）收到就重讀；資料推送時也會重讀。這些行只有中斷算進同一個 session 的主控送出紀錄（`readSent`；送出紀錄顯示「中斷（Herdr）」與「已送出 Esc」或原因），開著該主控送出紀錄的頁面收到 `agent-action` 事件也重讀。
- 切換模型（`POST /api/agents/model`，`session`、`model`、`effort`，null 表示保持目前；兩個都是 null 時繼續未結案的切換）：沿用主控的切換流程（`src/lib/server/switch.ts`，見「模型與思考強度」），由 `src/lib/server/agent-switch.ts` 以 session ID 為鍵呼叫，切換紀錄同樣是 `kind: switch`（`controllerId` 就是 session ID），另帶 `agent`（當時 Herdr 清單上的名稱、資料夾、工作區 ID、名稱與編號；從主控資訊頁切換時，主控在 Herdr 清單上也會記下）。新的切換要這次讀到的 Herdr 清單上有它、有接 HCOM、窗格不是看板自己的、client 是 Claude 或 Codex、值在選項裡，才走主控的流程（hcom 清單上 `listening` 才停止、停止前再查一次、以參數接回同一段對話）；不符合時寫一筆 `refused` 並回 409，不執行任何指令。拒絕原因以 Agent 為主詞（例如工作中時說明要等它這一回合做完）。以 `--model`、`-m`、`--oss` 啟動的 Codex 拒絕換模型（`board launch-args` 判斷，同主控），思考強度照常；以 `-c model=…` 啟動的不受限。接回到切換紀錄記下的 Herdr 工作區，那個工作區已不在時才依它的資料夾選（`chooseWorkspace` 的 `prefer`）。`GET /api/agents/model?session=<ID>` 回傳選項與 Codex 的啟動參數判斷；不在清單上的回 404。
- 還沒有對話紀錄的 Agent（輔助工具的 `board transcript` 回 `not_found`，例如開好後還沒送過訊息）沒有可接回的內容，`hcom r` 會讓 client 一啟動就結束。新的切換會在停止前先讀 hcom 記的啟動參數（`board launch-args`；停止後 hcom 就不記了）與原分頁的名稱、位置，記在切換紀錄的 `relaunch`，讀不到參數就拒絕（409）且不停止。停止後不接回，改以 `hcom <client> --dir <資料夾>` 在同一個工作區重新啟動，參數是原本的啟動參數加上新設定（後面的優先，與接回相同），不帶第一則訊息；`switch-step` 記下新的 HCOM 名稱（`relaunchedName`），等它在 Herdr 執行（`src/lib/server/appear.ts`）後，新分頁改回原分頁的名稱（即使那是舊 HCOM 名稱）、移到原位置，切換記為 `done`（改名或移動失敗另寫在 `error`）；沒出現就記 `resume-failed` 並寫明原因，切換仍未結案。重新啟動中（hcom 跑之前就記下，等待時間內）再按繼續切換會被拒絕，不會開第二個；失敗後繼續切換，先看上一次重新啟動的 client 是不是後來出現了，出現了就直接結案。等它出現的工作只在當下的看板程序裡；看板中途重啟的話，改由每次讀取資料時判斷（出現就結案，等待時間過了就記失敗）。等待結束時切換已被放棄或已結案的，不再改寫。HCOM 名稱與 session ID 會換新，舊的 Agent 頁面改說它已不在清單上。
- 切換的接回要確認真的在跑：hcom 回報接回成功、清單上也有那個 session，不代表 client 還活著（例如沒有對話紀錄可接回時一啟動就結束）。所以切換的接回要 hcom 清單有它，而且 Herdr 有同一個 session 或在 hcom 記的窗格裡有 Agent，才記為成功（`resume-closed` 的 `succeeded`）。每次讀取資料（與繼續切換前的查證）時判斷：hcom 跑完接回 15 秒後 Herdr 仍沒有在執行它，或等到等待時間結束還沒在跑，就記為 `failed` 並寫原因（`switchResumeVerdict`）。失敗在那之後的下一次讀取顯示，最慢同保底重讀的間隔。失敗的切換狀態是 `resume-failed`，Agent 留在清單上標「切換未完成」。主控喚醒（不是切換）的接回不受影響，仍以 hcom 清單為準。
- 切換未完成：每次讀取資料時從送出紀錄找出所有未結案的切換（`openSwitches`，沿用主控的判斷：停止中、停止失敗、停止結果不明、已停止待接回、接回中、接回失敗），在 Herdr 清單上的 Agent 帶上 `switch`；不在 Herdr 清單上、而切換帶有 `agent` 的，以切換紀錄的 session ID、client、HCOM 名稱與工作區列出（`inHerdr: false`，狀態取 hcom 清單上的，沒有時不明），所以看板重啟後仍在。有未結案切換的 Agent（不論在不在 Herdr 清單上）的傳話、中斷、關閉一律拒絕（409）；頁面只說明切換未完成，「繼續切換」與「放棄切換」在指令列模型旁的 ⚠ 裡。繼續切換不要求它在 Herdr 清單上，沿用主控的再次查證，不會重複接回。從主控資訊頁開始的切換也帶 `agent`，所以同樣列出；只有切換當時主控不在 Herdr 清單上、沒記到 `agent` 的不列。主控資訊頁的文字與接回選工作區的方式不變，從這個分頁繼續或放棄時才以 Agent 為主詞、接回到記下的工作區。
- 放棄切換（`POST /api/agents/model/abandon`，`session`）：結束整筆切換，不只是目前這次接回。先把這筆切換未結案的接回寫成 `resume-closed`（`abandoned`），再追加 `switch-step`（`state: abandoned`），不執行任何 hcom 或 Herdr 指令；之後這筆切換算結案，Agent 回到一般規則（在 Herdr 清單上照常列出，不在就消失）。沒有未結案的切換回 409。與切換排在同一個 session 的隊伍裡，所以正在執行的停止或接回會先做完。切換與放棄後伺服器重讀資料並推送 `agent-action` 事件。主控資訊頁的切換與「放棄前一次接回」不變；主控的送出紀錄裡被放棄的切換顯示「已放棄這次切換」。
- 操作紀錄的端點另外回傳 `switches`（這個 session 的所有切換，新的在前，含主控資訊頁開始的），頁面依時間與傳話、中斷、關閉排在一起。
- 調整分頁順序（`POST /api/agents/tab/move`，`session`（沒有 session ID 的卡片是 null，只用於紀錄）、`workspace`、`tab`、`onto`）：卡片最右邊的把手（pointer 事件，`touch-action: none`，滑鼠與觸控都能拖）拖到同工作區另一張卡片上，`onto` 是那張卡片所在的 Herdr 的分頁。插入位置以 `herdr tab list --workspace <工作區>` 的完整分頁清單計算（含看板不顯示的一般終端機分頁；同一分頁多個 Agent 時有多張卡片）：Herdr 0.9.5 把分頁插在「目前清單（被移動的分頁還在裡面）第 `insert_index` 個分頁」之前（2026-10-19 在真實工作區實測），所以往前拖時 `insert_index` 是 `onto` 分頁目前的位置（插在它之前），往後拖時是它的位置加一（插在它之後）（`src/lib/server/tab-control.ts`）。再經 Herdr 的連線介面送 `tab.move {tab_id, insert_index}`（連線介面見「接回」一段，`HERDR_SOCKET_PATH`）。拖曳中在目標分頁的第一張（往前）或最後一張（往後）卡片外側畫線標示放下位置（`tabDrop`）；拖到同分頁的另一張卡片不動作也不送出，伺服器收到 `onto` 等於 `tab` 回 400；拖出所屬工作區時卡片標示不可放下、放開後回原位，不送出。
- 改分頁名稱（`POST /api/agents/tab/rename`，`session`、`workspace`、`tab`、`label`）：卡片按右鍵（觸控長按 450ms，移動超過 8px 取消）開自訂選單，唯一項目「改分頁名稱」，卡片標題變成預填目前分頁名稱的輸入框；Enter 儲存（輸入法選字的 Enter 不算），Esc 或失焦取消，空白不送出（伺服器去掉前後空白後是空的也回 400），名稱沒變不送出。執行 `herdr tab rename <分頁> <名稱>`。
- 兩者都先以 `herdr tab list --workspace` 確認分頁仍在那個工作區（`onto` 也要在），不在或清單讀不到就拒絕（409）、不呼叫 Herdr；Herdr 拒絕或逾時回 502 並附上原因。看板自己所在的分頁也能排序與改名。同一工作區的請求依序執行（`queued`）。不論結果都先重讀資料才回應，所以清單顯示的是 Herdr 實際的順序與名稱；頁面不先自己挪動卡片。每次都寫一行操作紀錄（`action` 是 `move` 或 `rename`，文字欄寫移動或改名的內容），記在拖曳或改名的那張卡片的 Agent 下（卡片還沒有 session ID 時 `agentId` 是空字串）。只在 Herdr 清單上的 Agent 有把手與選單；只因切換未完成而列出的沒有。看板不提供分割、搬到新分頁、跨工作區搬移或關閉整個分頁。
- 開新 Agent：見「新建主控」的實作說明最後一段。
- 暫停通訊（`POST /api/agents/pause`，`session`）：只給這次讀到有接 HCOM 的 Agent，按鈕在「關閉 Agent」旁（`AgentClose.svelte`，主控資訊頁與 Herdr 分頁的主控頁也有），按下就送出、不再確認；旁邊的說明圖示（`aria-expanded` 的按鈕）點開在按鈕下方列出 `AGENT_PAUSE_POINTS` 的重點，再點一次、點別處或按 Esc 收起。看板自己的窗格（Herdr 的或 hcom 記的）拒絕；先重讀 `hcom list --json`，這個名稱仍是同一個 session 才做。先以暫存檔改名寫暫停紀錄（`<session_id>.json`，欄位 `session_id`、`hcom_name`、`client`、`pane`、`paused_at`），寫不進去就不停止，再執行 `hcom stop <HCOM 名稱>`（逾時同 `LAT_BOARD_HCOM_LIST_TIMEOUT_SECONDS`）。之後重讀 hcom 清單（最多 5 次、每次隔 0.4 秒）：不在連線上就成功；仍在連線上就刪掉紀錄並回 502；都讀不到時保留紀錄、回 502 說明無法確認，畫面顯示「HCOM 連線無法確認」，等讀得到清單再判斷。暫停中的 Agent 標示「暫停通訊」，傳話走 Herdr 直接輸入，不能切換模型，關閉走 `herdr pane close`；暫停中的主控仍算進行中（不是已關閉），待答題目照列，從主控資訊頁傳話也改走 Herdr。
- 恢復通訊（`POST /api/agents/unpause`，`session`）：只給暫停中的 Agent。Herdr 顯示它在工作或停在確認畫面時拒絕；hcom 清單讀不到、或同名已被另一個 session 用著時也拒絕。以 `herdr agent prompt <窗格> <文字>` 打入接回指令：Claude 用 `!hcom start --as <名稱>`；Codex 的 `!` 指令不會跑回合，hcom 綁不回去（約 40 秒後標成 launch_failed），所以 Codex 與其他 client 改打一句請它執行 `hcom start --as <名稱>` 的話。之後每秒讀 hcom 清單，等到同一個 session 以原名稱、狀態為 `listening`／`active`／`blocked` 出現才算成功並刪紀錄；同名不同 session 不算。等滿 `LAT_BOARD_UNPAUSE_WAIT_SECONDS` 仍沒有就回 502 並保留紀錄。
- 暫停紀錄的清除：每次讀取資料時，該 session 回到 hcom 清單的連線上（不論怎麼接回的）、或它的窗格已不在 Herdr（`agent list` 沒有它時再以 `pane list` 確認）就刪掉；清單讀不到時不刪，讀取開始前之後才寫的紀錄與正在暫停中的也不刪。關閉成功時也刪。讀不出來或欄位不全的檔案當成沒有。
- 已關閉（`src/lib/server/closed-agents.ts`、`ClosedAgents.svelte`）：每次讀到 Herdr 清單時，把清單上有 session ID 的 Agent 記在看板狀態目錄的 `seen-agents.json`（session ID、HCOM 名稱、client、資料夾、分頁名稱、工作區 ID 與名稱、最後看到的時間；時間最多每小時更新一次，其他欄位有變才寫）。同一次讀取另執行 `hcom events --type life --action stopped --full --after <看板時鐘往回 7×24 小時> --last 100000`；只有 `--full` 的事件帶 `snapshot.session_id`，`ts` 沒帶時區時當成 UTC（hcom 0.7.30 實測）。列入條件：看板記過它；目前不在 Herdr 清單、不在 hcom 清單（依 session ID）、沒有未結案的模型切換；這個 session 最後一筆停止事件（依事件 ID）的 `by` 是 `cli`（看板關閉或 `hcom kill`）、`pty`（Herdr 窗格關掉）、`session`（client 自己結束）或 `system`（程序結束），其他 Agent 名稱與 `subagent` 不列（2026-10-20 核對 hcom 0.7.30 的實際紀錄：只見過這六類）；停止未滿 7×24 小時；有已保存的對話：以 `board transcript` 往回讀（最多 20 頁）找得到 `kind: user`，`not_found` 或沒有使用者訊息都不列，讀不出來也不列（同一筆停止 1 分鐘內不再問；確定的結果依 session 與停止事件記在記憶體）。Herdr 或 hcom 清單看板啟動後還沒讀到過時都不列；停止紀錄讀不到時沿用上次的並在區塊裡說明。停止滿 7×24 小時（沒有停止紀錄的看最後看到的時間）、又不在 Herdr 清單上的紀錄從檔案刪掉；停止紀錄讀不到時不刪。資料推送帶 `snapshot.closed`（`agents` 新到舊、`error`、看板主機的時區 `timeZone`）；在主控名冊上的標 `controller`。
- 已關閉的介面：所有工作區之後一列摺疊的「已關閉 N」，展開後依停止時間分「今天」「昨天」「近 7 天」，以看板主機時區的日曆日判斷（頁面每分鐘更新一次今天是哪天），組內新到舊。每列顯示分頁名稱（沒有時用 HCOM 名稱）、HCOM 名稱、client、資料夾、原工作區與停止時間（今天的只顯示時刻），主控標「主控」，接回中或失敗時另顯示一行。整列是按鈕，點了以 `?agent=<session ID>` 打開它的頁面（`ClosedAgentInfo.svelte`，與 Agent 頁同一個網址與返回行為；`viewOf` 認得「已關閉」清單上的 session）：資訊卡（已關閉、分頁名稱與 HCOM 名稱、client、資料夾、原工作區、停止時間、session ID），下方是「接回」（`ClosedResume.svelte`），再下方是對話紀錄（與 Agent 頁相同的 `Transcript.svelte`，可往前翻頁）；操作紀錄端點只認 Herdr 清單上的 Agent，所以這頁沒有操作紀錄分頁。指令列在這頁停用，提示「已關閉，先接回才能傳訊息」；之前留下的草稿（含以 `@名稱` 指定它本身的）也不送，草稿擋住提示時，提示改顯示在指令列上方。接回後同一個 session 出現在 Herdr 清單上，頁面就換成 Agent 頁或主控頁。
- 接回（`POST /api/agents/closed/resume`，`session`；主控另帶喚醒選項 `text`、`newRound`、`model`、`effort`）：只接受這次重讀後仍在「已關閉」清單上的；不在清單上或正在接回時拒絕（409），也寫一行操作紀錄。這次的 hcom 清單、Herdr 清單或停止紀錄讀不到（只有上次的可用），或這個 session 最後一筆停止事件已不是列入時那筆，也拒絕，不執行任何指令。用 `hcom r <session ID> --terminal herdr --no-run-here --go`（不帶第一則訊息與其他參數）接回同一段對話，工作區以原工作區為優先、不在時依資料夾挑（`chooseWorkspace` 的 `prefer`，與 Agent 切換模型的接回相同）。與新建主控、開新 Agent 共用同一個排隊（`inLaunchQueue`），一次只跑一個，等前一個出現或逾時才開始下一個。hcom 跑完就回應；之後等它在 Herdr 執行（`waitToAppear`，以 session ID 認），出現後把分頁移到該工作區最前面。成功或任何一步失敗都寫一行操作紀錄（`action: resume`，成功時文字寫開在哪個工作區，移動失敗也寫在文字裡）；進行中與失敗原因只記在看板程序的記憶體，顯示在它的頁面與該列（失敗時該列保留，可以再按）；hcom 在 Herdr 執行它之前就會列出接回的 client（一直沒起來的也是），所以接回中或失敗的列在 Herdr 執行它之前不因 hcom 清單有它而離開，這段期間再按接回會被拒絕。接回後 hcom 清單有這個 session 就離開「已關閉」，回到清單主體。主控的「接回」先在它的頁面展開喚醒選項（模型與思考強度用 `ModelPicker.svelte`，只有確定 client 不在執行時才帶上；開新一輪 LAT；可留空的第一則訊息；前一次接回卡住時的「放棄前一次接回」），按「喚醒接回」後伺服器以 `wakeController` 喚醒（同主控資訊頁：排在該主控的隊伍、檢查未結案的接回、記在主控的送出紀錄），喚醒允許沒有訊息，但主控其實還在執行時拒絕而不打空白進去；之後同樣等它在 Herdr 執行（分頁由喚醒移到最前面），出現才寫成功的 `resume` 操作紀錄，沒出現或失敗都寫原因並留在該列。
- 測試以 `tests/fake-herdr.mjs`（`agent list`、`tab list`、`agent prompt`、`agent send-keys`、`pane close`、`tab rename`；每次讀取資料的清單呼叫另記在 `herdr-list-calls.jsonl`）與 `tests/fake-hcom.mjs`（含 `kill`，kill 時記一筆 `by: cli` 的停止事件；`events` 印出 `hcom-events.jsonl` 的停止事件；接回時可用 `resumedHerdr` 把 Agent 加回假的 Herdr）代替真的指令；harness 預設就用假的 Herdr，所以測試不會讀到真的 Herdr。

## 看板提問

使用方式見[使用說明](../docs/lat-board.md#在看板回答-agent-的提問)。實作上，hook 與看板只靠共用目錄（`LAT_BOARD_ASKS_DIR`）裡的檔案溝通，見 ADR 0009；檔案格式寫在 `hooks/board-ask.py` 開頭。

- hook：`hooks/board-ask.py hook` 是 Claude 的 PreToolUse hook（matcher `AskUserQuestion`，`timeout` 660 秒，等待 600 秒，依 #284 的實測）。只用標準函式庫。心跳超過 90 秒、共用目錄寫不進去、輸入看不懂、沒有 `HERDR_PANE_ID`、輸入帶 `agent_id`（Task 子 Agent）、不是 PreToolUse（Claude 在 PreToolUse 沒給決定時也會為 AskUserQuestion 發 PermissionRequest），或任何例外，都不輸出、以 0 結束、不留提問檔。例外是 LAT 主控：看板在執行（心跳未過期）時，hook 以 session ID 呼叫面板輔助工具 `resolve --session-id`（指令格式與預設路徑和看板相同，但這兩個環境變數讀的是 Agent 自己的環境，不是看板服務的：`LAT_BOARD_HELPER_COMMAND`、`LAT_BOARD_LAT_DIR`；10 秒逾時），退出碼 0 且輸出是 JSON 物件就是主控，立即輸出 `permissionDecision: deny` 與固定英文提醒（改用待答面板的 `question upsert`、以 DECIDE 結尾），不寫提問檔、不等待；查詢失敗、逾時或輸出看不懂都當一般 Agent。
- 提問檔 `<id>.json` 以暫存檔改名寫入；結果檔 `<id>.result.json` 先寫暫存檔再 hard link 到位，已存在就失敗，看板的答案與 hook 的逾時標記搶同一個位置，只有一方成功。hook 讀到答案後以 `allow` 加 `updatedInput`（原題目加 `answers`，以題目文字對應答案）填回，並在提問檔記 `outcome: filled`；時間到先搶到逾時標記就記 `timed_out`，輸出 `deny` 加 `continue: false` 與 `stopReason`，結束這一回合。檔案權限 0600、目錄 0700。
- 看板：啟動時與每 30 秒寫一次心跳檔 `heartbeat`；監看共用目錄（不含心跳檔與 `.` 開頭的暫存檔），和其他資料一起重讀，放進 `snapshot.asks`，有等待中提問的 Agent 標 `asking`，清單與 Agent 頁面的狀態改顯示「等你回答」。
- 作答：`POST /api/asks/answer`（`id` 與每題一份 `select`、`other`、`text`）。每題都要答；單選取選項標籤，複選以 `, ` 連接，「其他」的文字接在最後。搶到回 200 `accepted`，已被搶走回 409 `taken`（「已有人作答」）；兩者都以 `board-ask` 動作寫進送出紀錄（操作紀錄的「看板提問」）。
- 逾時之後：作答以同樣的互斥方式寫逾時後答案檔 `<id>.late.json`，再交給共用的傳話步驟 `relayToAgent`（`server/agent-control.ts`，與 Agent 頁的傳話同一個隊伍；之後的權限確認逾時傳話與 Codex「已允許並執行」通知也用它）：當下重讀 Herdr 的清單，清單上有就送（有接 hcom 走 hcom 的輸入指令，沒接走 `herdr agent prompt`），讀成功但清單沒有就是 `gone`（不論 hcom 有沒有它），讀不到或指令失敗是 `failed`。送出後逾時後答案檔記 `outcome: relayed`，`gone` 記 `outcome: gone`（回 409 `agent_gone`），`failed` 刪掉逾時後答案檔讓使用者重試。看板在傳話途中停掉時，留下的逾時後答案檔沒有 `outcome`，不確定停掉前有沒有打進去，重啟後這一題標「結果不明，請看對話紀錄」（`relay_unknown`），算結束，看板不自己重送（決策 RATI-ASK286-1：C）。卡片的「再送一次」呼叫 `POST /api/asks/resend`（`id`）：以同樣的互斥方式寫 `<id>.resend.json`，把逾時後答案檔裡的答案再交給 `relayToAgent`，結果同樣記在 resend 檔（`failed` 刪掉 resend 檔讓使用者重試；看板又在重送途中停掉時，沒有 `outcome` 的 resend 檔讀回 `relay_unknown`，可以再按）。訊息格式見 `board/board-asks.ts` 的 `lateAnswerMessage`。
- 中斷與清理：每次重讀前 `settleAsks` 檢查等待中的提問，hook 程序（提問檔的 `hook_pid`）已不在、結果檔也沒有內容時，看板以同樣的互斥方式寫 `{"kind": "interrupted"}`（「已在終端機中斷」），並在它的操作紀錄記一筆沒有作答的「看板提問」；`ENDED_ASK_STATES` 裡的提問（已填回、已傳話、結果不明、已中斷、已失效）結束滿 7 天（`ASK_RETENTION_MS`）刪掉它的三個檔案。之後新增的結束狀態加進 `ENDED_ASK_STATES` 並給 `endedAt` 就會一起清理。
- 待辦：`snapshot.asks` 在頁面轉成 `AskRow`（`src/lib/board/ask-inbox.ts`），沒結束的（不在 `ENDED_ASK_STATES`）是待辦的一筆，與項目一起排序（`sortEntries`、`groupEntriesByProject`，專案取 Agent 的工作資料夾，Agent 已不在清單時取提問檔的 `cwd`）；結束的併進已處理清單（`mergeProcessed`，依結束時間，還有更早的項目沒載入時，比已載入最舊一筆更早的提問等它那一頁）。點開走 `openAsk`：一般 Agent 到 Agent 頁面，主控的權限確認到主控資訊頁，然後捲到 `[data-ask]` 的題目卡。
- 測試：待辦在 `tests/unit/ask-inbox.test.ts` 與 `tests/browser/ask-inbox.test.ts`；hook 在 `tests/unit/board-ask-hook.test.ts`（暫存共用目錄與假心跳，主控判斷用真的輔助工具讀暫存綁定登記，含兩個程序同時搶結果檔、答案與截止同時發生），安裝在 `tests/unit/board-ask-install.test.ts`（只用暫存設定檔），伺服器端在 `tests/server/board-asks.test.ts`（含重啟）與 `tests/server/board-ask-late.test.ts`（逾時後傳話、失效、讀不到 Herdr 清單、中斷、7 天清理），瀏覽器端在 `tests/browser/board-ask.test.ts`（真的 hook 程序對測試看板提問，含兩個瀏覽器同時送出、逾時後兩個瀏覽器同時作答）。

## 用量與快取

使用方式與狀態列記錄程式的安裝、移除見[使用說明](../docs/lat-board.md#用量與快取)。實作上：目前階段下方的用量小字，Claude 主控跟它終端機的狀態列同一組數字（四捨五入也一樣，剛好 .5 時取偶數）。閒置與已關閉的主控不顯示；某項讀不到只省略那一項。

- 「上下文已用」是上下文已用的比例；額度是「剩」多少（100 − 已用），依期間寫成 `5 小時額度剩`、`7 天額度剩`、`30 分鐘額度剩` 這類名稱；「快取命中」是最近一次請求從快取讀的比例，快取冷時只顯示 `快取尚未建立`。失效倒數（`20 分鐘後失效`，接在快取後面、換行時不拆開）只有 Claude 主控有，算法同狀態列（剩餘秒數 ÷ 60 取整數），每過一分鐘自動更新，失效後顯示紅色 `已失效`（沒有快取命中可接時整句是 `快取已失效`）。
- 安全範圍的項目隱藏（`usageParts`）：上下文已用 ≤ 10%、5 小時額度剩 > 45%、7 天額度剩 > 30%（其他期間一律顯示）、快取命中 > 80%、倒數 > 30 分鐘、權限為免確認；冷快取與已失效一定顯示。只剩倒數時整句帶快取名稱，例如 `快取 20 分鐘後失效`。全部隱藏或讀不到時整行與資訊圖示都不顯示。行尾資訊圖示（滑鼠停留或點一下）用 `usageDetails` 列出全部數值；「詳細資料」的「執行狀況」列是 `usageParts(…, all)`，什麼都不隱藏。
- 權限模式放最後：寫成 `權限：自動模式`、`手動確認`、`自動接受修改`、`規劃模式`、`免確認` 這類中文；Claude 取自對話紀錄最後一則使用者訊息的模式（Shift+Tab 切換後要等下一則訊息才反映），Codex 取自 rollout 的核准與沙箱設定（例如 `權限：需要時才詢問，檔案權限：可寫入工作區`）。
- 變黃：上下文已用 ≥ 80%、任一額度剩不到 20%、快取剩 5 分鐘以內；已失效用紅色。淺色主題另加粗。
- 精簡樣式（設定的「用量列」，`appearance.usageStyle`）：這是所有已登入裝置共用的設定，存在看板狀態目錄的 `usage-style.json`（`{"style":"detailed"|"compact"}`，權限 600，原子寫入），還沒存過、檔案壞掉或內容不是這兩個值時是 `detailed`（下次存檔會蓋掉壞檔）。`GET /api/usage-style` 讀、`PUT /api/usage-style`（本文 `{"style":…}`）寫，都要登入，回應與事件都是 `{style, revision}`，`revision` 每次存檔遞增（從啟動時間起算，重啟後仍比之前大），頁面只採用比已套用的更新的 revision，所以事件與存檔回應不論誰先到都不會把畫面退回舊值；別的值回 400，存檔失敗回 500 且維持原值、不推送。存檔後看板在事件串流推 `usage-style` 事件，所有開著的頁面立刻套用，新連上的頁面一連上也會收到目前的值，所以其他裝置不必重新整理。頁面只在看板回報存好了才換樣式；存檔失敗時顯示「用量列樣式沒有存成功」浮動通知，按鈕與畫面維持原樣。瀏覽器不再讀寫舊的 `lat-board-usage-style`，頁面載入時會把它清掉。樣式內容：`usageParts(…, { style: 'compact' })` 隱藏與變色同上，文字用狀態列的縮寫：`Ctx 62%`、`5h 40%`、`Cache 70%`、`⏳ 20 min`（一定接在 `Cache` 後面，只剩倒數時是 `Cache ⏳ 20 min`）、`⏳ expired`、`Cache cold`，權限不加前綴，Claude 用英文名稱（`Auto mode`、`Bypass permissions` 等），Codex 寫 `approval on-request`。只影響行內小字；資訊圖示（`usageDetails`）與「執行狀況」列一律是中文全稱。
- Codex 主控：輔助工具的 `board transcript` 從 rollout 最後的 `token_count` 事件算出 `usage`，是看板自己的算法，不一定等於 Codex 畫面上的「context left」：上下文已用 = 最後一次請求的 `input_tokens` ÷ `model_context_window`，快取命中 = `cached_input_tokens` ÷ `input_tokens`，額度取最後一筆方案額度（`limit_id` 為 `codex` 或沒有）的 `rate_limits` 的 `primary`／`secondary`（有幾個就顯示幾個，依 `window_minutes` 命名）；`premium` 這類其他額度的事件不算。
- Claude 主控：這些數字只有狀態列指令拿得到，所以要在狀態列指令前面串上 `scripts/usage-recorder.sh`。它每次狀態列更新時讀標準輸入，把 `context_window.used_percentage`、`rate_limits` 的 `five_hour`／`seven_day`（`used_percentage`、`resets_at`）、`prompt_cache`（`caching_observed`、`warm`、`hit_ratio`、`expires_at`）與寫入時間存成 `$LAT_USAGE_DIR/<session ID>.json`（先寫暫存檔再改名），不存訊息、路徑或憑證；接著把同一份輸入原封不動交給後面的指令，印出它的輸出。記錄失敗（例如沒有 `jq`、目錄寫不進去、輸入不是 JSON）一律略過，不影響狀態列。需要 `bash` 與 `jq`。
- 頁面開著時，用量跟著對話紀錄的推送（`/api/transcript/events` 的 `page.usage`）更新：Codex 隨紀錄檔變動；Claude 另外監看用量檔，只有它變了時只重讀這個檔、不重跑輔助工具。用量檔讀不出來時當成沒有，不影響其他區塊。

## 傳話給主控

使用方式見[使用說明](../docs/lat-board.md#傳話給主控)。實作上：

- 送出前會重讀資料，確認主控仍啟用；對象是閒置或已關閉的主控時改為喚醒（見下節）。不自動重試，也不改走別的管道。
- 每次傳話不論成敗都記在狀態目錄的 `sent-log.jsonl`，在該主控的資訊頁可以看到，所有已登入裝置看到的相同。
- 多行文字以一則訊息送出：行與行之間送的是換行字元（LF），最後才送出 Enter（CR）。文字裡的 CR 會先換成 LF，否則會提早送出。頁面上 Enter 與 Shift+Enter 的規則（寬度 760px 以下或沒有滑鼠時 Enter 換行）在指令列元件裡，輸入法選字時的 Enter 不送出。
- skill 名稱提示：`MessageBox.svelte` 帶 `skillsFor`（收件 client 與工作資料夾；指令列取開著的 Agent 的 `client`／`folder` 或對象主控的 `client`／`workspace`，新建表單取所選 client 與資料夾）時才提示，觸發、篩選與插入規則在 `src/lib/board/skills.ts`。清單由 `GET /api/skills?client=&folder=`（要登入，`folder` 須是完整路徑）提供，頁面依 client 與資料夾各讀一次、5 分鐘後再讀，失敗 30 秒內不重問（`skill-hints.svelte.ts`）。Claude 的照 Claude Code 2.1 啟動時列出的位置讀檔（`src/lib/server/skills.ts`）：`~/.claude/skills/<資料夾>/SKILL.md`、該資料夾往上到 Git 專案根目錄（不在 Git 專案裡就到 `/`）每層的 `.claude/skills`，以及使用者與專案設定 `enabledPlugins` 開著的外掛（`installed_plugins.json` 的 `installPath`）的 `skills/`，外掛的寫成 `外掛名:資料夾`；使用者設定的 `extraKnownMarketplaces` 寫的來源與 `known_marketplaces.json` 不同的 marketplace，Claude 不載入（`claude plugin list` 寫 added but ignored），它的外掛也不列；名稱用資料夾名（與 Claude 相同）。已知限制：Claude Code 內建（`/simplify` 等）與 claude.ai 帳號帶來的 skill（`anthropic-skills:*`）沒有檔案，只有開一個 Claude session（會跑它的啟動 hook）才列得出來，所以不列，與 client 內建指令同樣看待。Codex 的外掛與停用設定取決於它自己的狀態，所以直接問 Codex app server 的 `skills/list`（`LAT_BOARD_SKILLS_COMMAND`，`cwds` 是該資料夾），只列 `enabled` 的（含 Codex 自己裝在 `~/.codex/skills/.system` 的 `system` skill），同一資料夾的答案留 60 秒；問不到回 502，頁面就不提示。描述只取第一句（`firstSentence`）。
- 中斷主控這一回合：對象是 `herdr` 不為空、而且 client 這一回合正在跑的主控（`controllerInterruptible`），回合狀態取自資料裡同一個 session 的 Agent（`agents`），不看主控的 LAT 狀態：狀態來自 hcom 時要是 `working`（hcom `active`）或 `blocked`，來自 Herdr 時（hcom 沒有它）照一般 Agent 的規則，不是閒置或已完成；不在 Herdr 清單上或有未完成的模型切換就沒有停止鈕。送出鈕左邊多一顆 Agent 頁面那顆紅色停止鈕（有沒有打字、有沒有用 `@名稱` 指定別人都一樣，對象永遠是頁面上的主控），按一次就直接呼叫與 Agent 相同的 `POST /api/agents/interrupt`（`session` 是主控的 session ID）。伺服器照 Agent 的規則重讀清單，以 Herdr 這次列出的窗格送 `herdr agent send-keys <窗格> esc`，不在 Herdr 清單上或有未完成的模型切換就拒絕，只試一次；結果照樣寫一行 `agent-action`（`interrupt`）。通知寫「已對 @名稱 送出 Esc。」或失敗原因。主控資訊頁與 Herdr 分頁的主控頁都一樣。

## 喚醒閒置或已關閉的主控

使用方式見[使用說明](../docs/lat-board.md#喚醒閒置或已關閉的主控)。實作上：

- 由指令列喚醒（電腦與手機相同）：對象是閒置或已關閉的主控時，送出按鈕從箭頭圖示改成「喚醒」，旁邊出現選項按鈕，點開的浮動框裡有「開新一輪 LAT」、額度提醒，以及「放棄前一次接回」；模型與思考強度在指令列的模型標籤上選（`ModelPicker.svelte`）。

- `POST /api/wake`（`controllerId`、`text`、`newRound`）喚醒一次；`POST /api/wake/abandon`（`controllerId`、`wakeId`）放棄一筆未結案的接回。兩者都要登入，並與傳話排在同一個主控的隊伍裡依序處理，所以同時按兩次也只會接回一次。
- client 是否還在只看 `hcom list --json` 裡有沒有這個主控的 session ID，不看 Herdr 的 Agent 狀態。在就用傳話的輸入指令打進它的輸入框；不在就用 `hcom r <session ID>` 接回，工作區照新建的規則選（專案範圍是主控回報裡的工作區路徑）。清單讀不到就什麼都不做。
- 每次喚醒都寫一行 `sent-log.jsonl`（`kind: wake`），欄位有走的路（輸入框或接回）、送出的文字、是否開新一輪、目標工作區、接回輸出的 HCOM 名稱、接回的窗格、結果與原因；`extraArgs` 是接在 `hcom r` 旗標後面、給 client 的額外參數，也就是保持權限模式的參數與喚醒時選的模型與思考強度（`choice`）；`switchId` 不為空的是 Codex 切換模型時的接回。
- 權限模式（`permission.ts`）：Claude 接回時不會從對話紀錄恢復權限模式，而是用啟動參數給的，沒給就用使用者預設；`hcom r` 重複它存下的上次啟動參數（最新一筆 `stopped` 事件 snapshot 的 `launch_args`，以 `hcom events --sql` 讀），再接上看板的參數。所以喚醒、切換模型與「已關閉」的接回，看板都讀對話紀錄最後一則使用者訊息的權限模式，在模型參數之前補上 `--permission-mode <模式>`；存下的參數已給同一個模式（最後一個 `--permission-mode`）時不加，讀不到存下的參數就當作沒有。`--dangerously-skip-permissions` 不論前後都蓋過 `--permission-mode`，`hcom r` 也不能拿掉存下的參數：存下的參數有它而紀錄是免確認模式時什麼都不加；是別的模式時另加 `--settings '{"permissions":{"disableBypassPermissionsMode":"disable"}}'` 讓 `--permission-mode` 生效，代價是這段對話之後也切不進免確認模式（使用者於 TOSE-262-AC4 選定；Claude Code 2.1.308 實測）。存下的參數已有同一個設定時只補模式。Codex 不加。補上的參數記在 `wake` 的 `extraArgs`。
- 接回前先寫一行 `wake`（`pending`，未結案），寫不進去就不執行 hcom；hcom 結束後再追加一行 `resume-result` 記結果。看板在 hcom 執行中停掉，或結果那行寫不進去，這筆接回就維持未結案，由下一次喚醒查證。
- 接回結果：結束碼 0 記 `started`、結束碼 2 或逾時記 `pending`，兩者都是「未結案」；其他結束碼記 `failed`，直接結案。接回後看板再讀一次 hcom 清單，記下同 session 或同名 Agent 的 `launch_context.pane_id`。
- 接回開出的新分頁會移到該工作區的最前面（喚醒與切換模型都一樣）：窗格一查到（接回當下，或之後補記 `resume-pane` 時；切換模型的接回只補記，窗格取 Herdr 執行這個 session 的窗格，因為停止後 hcom 清單可能還列著已關閉的舊窗格），看板從 `herdr pane list` 找出它的分頁，再經 Herdr 的連線介面送 `tab.move`（`insert_index: 0`；Herdr 0.9.3 的 CLI 沒有移動分頁的指令）。連線介面預設是 `~/.config/herdr/herdr.sock`，可用 `HERDR_SOCKET_PATH` 指定。移動在結果寫進紀錄之後才做、不等它完成，失敗也不影響接回。
- 未結案的接回由後來追加的行結案：`resume-closed` 記結果（`succeeded`、`ended`、`abandoned`），`resume-pane` 補記後來才查到的窗格。每次讀取資料讀到的 hcom 清單上出現該 session，就結案為成功。
- 再次喚醒前的查證依序是：session 在 hcom 清單上 → 結案為成功，改走輸入框；清單上有主控原本的名稱或接回輸出的名稱（含還沒綁定的 Agent）或記下的窗格還在 `herdr pane list` 裡 → 拒絕；記下的窗格已不在 → 結案為已結束，照常接回；沒記到窗格 → 拒絕並回傳可放棄的那一筆（`abandon`）。窗格清單讀不到也拒絕。等待時間只用來顯示提示，不會放行。
- 閒置主控的資訊頁有「關閉」（`ControllerInfo.svelte`），與 Herdr 分頁的「關閉 Agent」共用 `AgentClose.svelte` 與 `POST /api/agents/close`：拒絕條件、確認與結果通知都相同，確認文字一律說明可以從主控資訊頁喚醒接回，與從 Herdr 分頁打開它時相同。按鈕只在這次讀到的 Herdr 清單上有同一個 session ID 的 Agent 時出現，找不到時說明無法從這裡關閉；它有未完成的模型切換時，與 Agent 頁面一樣不顯示按鈕、只說明要先處理切換；進行中的主控同樣在 Herdr 清單上找得到時有「關閉 Agent」（與 Herdr 分頁的主控頁相同），有接 HCOM 或暫停通訊時旁邊另有「暫停通訊」／「恢復通訊」；有未完成的模型切換時照 Agent 頁只說明要先處理切換。關閉後 session 從 hcom 清單消失，下一次讀取資料就顯示為已關閉。
- 測試以 `tests/fake-hcom.mjs`（`list --json` 與 `r`）、`tests/fake-herdr.mjs`、`tests/fake-inject.mjs` 代替真的指令。

## 模型與思考強度

使用方式見[使用說明](../docs/lat-board.md#模型與思考強度)。實作上：

- 參數：Claude 用 `--model <模型>`、`--effort <強度>`；Codex 只用 `-c model="<模型>"`、`-c model_reasoning_effort="<強度>"`，從不用 `--model`／`-m`，因為 Codex 0.162.1 明確的 `--model` 優先於任何 `-c model`，而同一鍵的多個 `-c` 以最後一個為準。新建、喚醒接回與切換的接回都把它們接在 hcom 旗標之後；只帶有選的那一項，但換模型而思考強度保持目前時（切換與喚醒），另外帶上 `current.effort`（Claude `--effort`、Codex `-c model_reasoning_effort`），讀不到就不帶；帶上的值記在接回那行 `wake` 的 `carriedEffort`，不算進 `to`／`choice`。切換時這個值在選定設定時讀一次、記在切換紀錄（`switch` 或之後改選的 `switch-step` 的 `carriedEffort`），繼續切換時改選設定或主控仍在而再次停止，都以當下的紀錄重讀並記下；只是重新接回時沿用記下的值。模型標籤 ⚠ 裡的「繼續切換」旁依這個值顯示會帶上的思考強度，讀不到時顯示提示。Claude 的切換也是停止再接回，看板從不在對話裡打 `/model`、`/effort`（Claude Code 2.1.299 互動對話裡這兩個指令一定會存成新對話的預設，還可能跳確認框）；Claude 沒有指定過模型的限制，重複的 `--model`、`--effort` 以最後一個為準（QA 實測）。
- 目前設定：`board transcript` 的輸出多一個 `current`（`model`、`effort`、`time`），從整份紀錄讀，不管是哪一頁。Claude 取最後一則不是 `<synthetic>`、不是子 Agent 的主控訊息的 `message.model` 與紀錄上的 `effort`，`time` 是那個回合開頭（它之前最後一則不是工具結果的使用者紀錄）；Codex 取最後一個 `turn_context` 的 `model`、`effort` 與時間。頁面以「最新送出的切換」實際送出的時間（`appliedAt`：最近一次帶著它接回的時間，舊版 Claude 打入的切換是打入的時間；喚醒接回帶了選擇時是那次喚醒的時間）比對，所以繼續切換之前跑的舊回合不算：`current.time` 比它晚才算下一回合，有選的項目都相符就清掉提示，否則顯示「切換沒有生效」。
- 等下一回合時顯示的設定（`shownSettings`）：主控資訊頁的標籤讀主控的送出紀錄，Herdr 分頁 Agent 頁面（含在 Herdr 的主控）的標籤讀它的操作紀錄裡的切換（`/api/agents/log` 的 `switches`），兩者都以 `lastApplied` 找最新送出的切換。
- 指令列的模型標籤：對話頁沒開著時，換對象或對象開始、結束時讀一次 `GET /api/transcript` 的 `current`；讀到 `null`（還沒有回合，例如剛新建的主控）時，之後每次看板資料更新都再讀一次，直到讀到為止，所以第一回合開始後不必重新整理頁面（`readsCurrentAgain`）。切換等下一回合確認時也同樣每次重讀。
- 啟動參數：`board launch-args --session-id <ID>` 以唯讀方式開 hcom 的資料庫（`$HCOM_DIR/hcom.db`，預設 `~/.hcom`），讀 `instances` 表該 session 的 `launch_args`（JSON 字串陣列，空字串算沒有參數）。這是 hcom 0.7.29 的內部資料，讀取只在這個輔助工具指令裡，hcom 改版時改這裡即可。看板在第一個 `--` 之前找 `--model`、`--model=…`、`-m`（含 `-m<值>`）、`--oss`；有就停用模型欄，伺服器也拒絕換模型；讀不到則照常允許，畫面提示無法確認。
- `GET /api/model?controller=<ID>` 回傳選項、client 是否在 hcom 清單上與它的狀態、Codex 的啟動參數判斷；`POST /api/model`（`controllerId`、`model`、`effort`，null 表示保持目前）切換一次，兩個都是 null 時繼續未結案的切換。有未結案的切換時一律先處理它，不論 client 在不在。都要登入，並與傳話、喚醒排在同一個主控的隊伍裡。值不在該 client 的清單裡就拒絕。
- 每次切換寫一行 `sent-log.jsonl`（`kind: switch`），欄位有切換前的設定（`from`，讀不到時為 null）、新設定（`to`）、走的路（`restart`；`inject` 只出現在舊版打入的 Claude 切換）、狀態與原因。先寫這行（`stopping`）才執行 `hcom kill`，寫不進去就不停止；之後的進展追加 `switch-step` 行（`stop-failed`、`stop-unknown`、`stopped`、再次停止時的窗格，或繼續時改選的 `to`）。停止前再查一次 hcom 清單，session 仍在、HCOM 名稱與剛才相同、狀態仍是 `listening` 才停止。每次停止（含繼續切換時的再次停止）都先寫下 `stopping` 與這次的窗格，寫不進去就不停止。有未確認停止的切換（`stopping`、`stop-failed`、`stop-unknown`）時，喚醒要接回會被拒絕；喚醒帶的模型同樣依 `board launch-args` 判斷，指定過模型的 Codex 主控拒絕換模型。繼續切換時，session 已經又出現在 hcom 清單上（不論怎麼回來的）就追加 `done` 結案；此時若有改選設定，另開一筆新的切換。接回已經在進行中時不接受改選。停止後的接回是一行 `wake`（`switchId` 指向這筆切換、沒有文字），所以沿用接回的未結案紀錄與再次喚醒前的查證；切換的狀態由這筆接回推得：未結案是 `resuming`，結案為成功是 `done`，其他是 `resume-failed`。
- 停止後的核對：`hcom list --json` 查無該 session，而且停止前記下的窗格不在 `herdr pane list` 裡，最多查 5 次、每次隔 0.4 秒。`hcom kill` 失敗記 `stop-failed`，逾時或核對不到記 `stop-unknown`，兩者都不接回。
- 測試以 `tests/fake-hcom.mjs`（多了 `kill` 與 `listSeries`）、`tests/fake-helper.mjs`（`current` 與 `launch-args`）代替真的指令；輔助工具的部分在 `skills/local/lat/tests/test_lat_panel_model.py`。

## 新建主控

使用方式見[使用說明](../docs/lat-board.md#新建主控)。實作上：

- `GET /api/launches` 回傳可選的資料夾（回報紀錄裡的 `workspace`，去重複、依最新一筆回報的時間排序，附「是否存在」「是否在 Git 專案裡」）與最近 20 筆新建紀錄；`POST /api/launches` 新建一次。兩者都要登入。同一時間只跑一次新建，所以兩次新建不會為同一個專案各建一個工作區。
- `GET /api/browse?q=<輸入的路徑>` 供資料夾輸入框即時搜尋，要登入；`q` 必須是完整路徑（`/` 開頭，或以 `~` 代表看板服務使用者的家目錄），否則回 400。回傳 `path`（正規化後的資料夾）、`target`（`state`：`folder`／`missing`／`not-folder`；`git`：是否在 Git 專案裡，不存在時看最近一層存在的上層；`cannotCreate`：不存在時看板不肯建立的原因，null 表示送出時會建立），以及 `entries`：`q` 最後一個 `/` 之前那一層底下、名稱含有最後一段的子資料夾（不分大小寫，開頭符合的在前、最多 50 個；最後一段以 `.` 開頭才列隱藏資料夾；符號連結指向資料夾的以連結本身的路徑列出，指向檔案或不存在的不列），每個附是否在 Git 專案裡（沿用 `gitRoot()`，連結以實際位置判斷）。那一層讀不到時 `error` 帶錯誤代碼（如 `ENOENT`）、清單為空。已知專案的比對在頁面上做（`src/lib/board/folder-search.ts`，與伺服器共用規則）。
- 是否在 Git 專案裡，與 LAT 啟用時找專案根目錄的方式相同：從資料夾往上找第一個有 `.git` 的目錄。
- 選工作區時只用 `herdr pane list` 的 `cwd` 與 `workspace_id`、`herdr workspace list` 的 `number`，不看 Herdr 的 Agent 狀態。兩份清單只要有一筆不是預期的格式，或專案裡的窗格所在的工作區不在清單上，就當成讀不到而停下，不會新建工作區。看板服務本身不在任何 Herdr 工作區裡，所以呼叫 hcom 時以環境變數 `HERDR_WORKSPACE_ID` 指定目標工作區（hcom 的 herdr 終端在該工作區開分頁）。
- 新建、喚醒與 Codex 切換模型後接回時，hcom 都帶 `--terminal herdr --no-run-here`。hcom 決定要不要把單一 Agent 直接跑在呼叫它的程式裡時不看 `--terminal`：從不是 Agent 的終端機呼叫（背景服務，或拿掉呼叫端身分後的看板）時，它會把主控跑在看板自己的子程式裡，不開 Herdr 分頁、沒有窗格，看板一直等到逾時。`--no-run-here` 讓它一律開新分頁；實測 hcom 0.7.29 接受這個選項，雖然 `hcom <client> --help` 沒有列出。
- 同樣這些呼叫的環境會拿掉呼叫端的 Agent 身分：`HCOM_DIR` 以外所有 `HCOM_` 開頭的變數，`CODEX_HOME` 以外所有 `CODEX_` 開頭的變數，`HERDR_SOCKET_PATH`、`HERDR_CONFIG_PATH` 以外所有 `HERDR_` 開頭的變數（`HERDR_WORKSPACE_ID` 再由看板指定），以及 `CLAUDECODE`、`CLAUDE_CODE_*`、`CLAUDE_PID`、`CLAUDE_EFFORT`、`AI_AGENT`。看板在某個 Herdr 窗格裡啟動時，那個窗格的分頁編號、`HERDR_ENV` 等變數否則會一路傳到新主控的分頁，蓋掉新分頁自己的值；拿掉 `HERDR_` 變數就是不讓呼叫端的身分與所在位置混進新主控。測試時曾看到接回的主控被記成跑在呼叫端的窗格裡，確切原因沒有重現出來（hcom 開新分頁時本身會拿掉 `HERDR_PANE_ID`），看板另外會拒絕停止記在自己窗格裡的主控。看板在某個 Agent 的終端機裡啟動時（例如測試），hcom 否則會把那個 Agent 當成啟動者：新主控成為它的子 Agent，第一則訊息後面還會多一行要新主控把結果回傳給它。拿掉後效果與背景服務相同；`HCOM_TAG` 也因此不會傳下去，啟動輸出的 `Names:` 就是完整的 HCOM 名稱。`hcom list` 等不啟動 Agent 的呼叫不受影響。
- Codex 切換模型要停止主控時，若 hcom 記的主控窗格就是看板自己所在的窗格（看板在 Herdr 裡啟動時的 `HERDR_PANE_ID`），看板拒絕停止並說明原因，不會關掉自己的窗格。
- 執行任何指令前先讀一次面板綁定登記；讀不到就不啟動，因為之後無法分辨新主控與先前同名的 Agent。
- 資料夾不存在時（`stat` 失敗，含指向不存在位置的連結），送出前先判斷能不能建：最近一層存在的上層以 `realpath` 解開連結後必須在家目錄（同樣解開）底下，否則回 409、不建立也不記錄。可以建時，新建主控在讀完綁定登記後、開新 Agent 在確認工作區後才逐層 `mkdir`；中途失敗會把這次建出的層由深到淺移除（只刪空的），記為失敗。新建主控的新資料夾一律 `git init`（在既有 Git 專案裡也是，自成一個專案），不看 `gitInit`；git init 失敗時資料夾留著，記為失敗。紀錄多 `folderCreated: true`。
- hcom 結束碼 0 記為已啟動，結束碼 2 或逾時記為仍在啟動（都不算失敗、不重試），其他結束碼記為失敗。啟動輸出沒有剛好一個名稱時，記為結果不確定，不去猜哪個綁定是它。
- 新建紀錄寫在 `sent-log.jsonl`（`kind: launch`），欄位有 client、所選資料夾、專案範圍、選定的模型與思考強度（null 是 client 預設）、`defaults`（新建當下從 client 設定讀到的預設模型，與依所用模型算出的預設思考強度；讀不到的是 null）、HCOM 名稱、目標工作區、是否先 git init、結果與原因。`GET /api/launches` 另外回傳 `modelOptions`。之後每次讀取資料時，出現 HCOM 名稱相同的綁定，或該名稱在新建之後寫的回報紀錄，就追加一行 `launch-bound` 記下它成為哪個主控；不比對資料夾，所以同一資料夾連開兩次也各自對應。新建前就已經用這個名稱綁定的 session（前一個同名 Agent 留下的）不算；同一個名稱之後被 hcom 再用時，只算給最新那一筆。
- 預設值：`GET /api/launches/defaults?folder=<絕對路徑>`（要登入；沒給 `folder` 時只讀使用者層）回傳兩個 client 不帶參數啟動時會用的模型與思考強度（`src/lib/server/client-settings.ts`）。Claude 依序讀 `~/.claude/settings.json`、所選資料夾的 `.claude/settings.json`、`.claude/settings.local.json`，後面的蓋過前面的；`model` 是別名（`opus`、`sonnet`、`haiku`、`fable`，可帶 `[1m]`）時換成完整 ID，思考強度取 `effortLevel`，`modelSettings[<模型>].effortLevel` 有寫時以該模型的為準（`modelEfforts`）。Codex 讀 `~/.codex/config.toml` 的 `model`、`model_reasoning_effort`，有頂層 `profile` 時先取 `[profiles.<名稱>]` 的值。其中一個檔案存在但讀不到或格式不對、Codex 指定的 profile 不存在時，整個 client 都當成讀不到；不讀環境變數、Codex 專案層設定與企業管理設定。表單下拉選單的第一項寫「預設：<模型>」「預設：<思考強度>」，只選模型時思考強度的預設依所選模型；換 client、換資料夾時跟著更新，表單開著時每 15 秒重讀。讀不到或沒寫的項目寫「讀不到 client 設定，交給 client 內建預設」。送出時仍不帶這些值，啟動參數與留預設時相同。「最近新建」與主控的送出紀錄依 `defaults` 寫出具體值（沒有 `defaults` 的舊紀錄照舊）。
- 「尚未啟用」的等待時間用看板的時鐘計算（測試可用 `LAT_BOARD_CLOCK_FILE` 調整）；新建主控頁開著時每 15 秒重讀一次紀錄，所以時間到了不必重新整理。
- 測試以 `tests/fake-hcom.mjs`、`tests/fake-herdr.mjs` 代替真的 hcom 與 Herdr；不在 Git 專案裡的測試資料夾放在上層沒有 `.git` 的暫存目錄。
- 開新 Agent（Herdr 分頁工作區標題的「＋」，網址 `?new-agent=<工作區 ID>`）共用 `NewController.svelte`（帶 `target`）與 `POST /api/launches`：請求多一個 `agent: { tabName }`。伺服器不送 LAT 啟動指令、不檢查 Git 也不 git init（`gitInit: true` 回 400），第一則訊息可以是空的（空的就不帶 `--hcom-prompt`），分頁名稱去頭尾空白後最多 60 字、不能換行；Claude 一樣帶 `--dangerously-skip-permissions`，模型與思考強度參數同新建主控。資料夾不存在時同上建立（不 git init）。紀錄是 `kind: launch` 加 `role: agent` 與 `tabName`，不會配對成主控（`settleLaunches` 跳過）。
- 工作區：兩個表單都送 `workspace`，是 `{ kind: 'auto' }`（依專案挑選，沒有就以專案資料夾名稱新建，即原本新建主控的做法）、`{ kind: 'existing', id }` 或 `{ kind: 'new', label }`（名稱去頭尾空白後 1 到 60 字、不能換行，送出時以所選資料夾為 `--cwd` 建立）。新建主控不帶時當成 `auto`；開新 Agent 不帶回 400。`existing` 在建立資料夾或 git init 之前先查 Herdr 清單，已不在就記為失敗；`new` 建立失敗也記為失敗，兩者都不改開到別的工作區（`src/lib/server/launch.ts` 的 `lookFirst`、`placeIn`）。表單的選單見 `src/lib/board/launch.ts` 的 `WorkspaceOption`：從「＋」打開預設當前工作區，上方「新建」預設自動，每次打開表單都回到預設；這次送出新建了工作區時，選單改指向那個工作區，重送不會再建一個。
- 新建主控與開新 Agent 在 hcom 回報名稱後都會追蹤：伺服器每秒讀一次 `hcom list --json` 與 Herdr 的清單，hcom 清單上這個名稱的 session ID 或 `launch_context.pane_id`，對到 `herdr agent list` 的同一個 session 或窗格，就算出現在 Herdr。接著開新 Agent 有分頁名稱時 `herdr tab rename <分頁> <名稱>`，再以 socket 的 `tab.move`（`insert_index: 0`）移到最前面（主控只移動），追加一行 `launch-followed`（出現時間、沒出現的原因、改名與移動各自的失敗原因），然後重讀資料。連續三次讀得到的 hcom 清單都沒有這個名稱（它也列還在啟動的）就不再等；等到新建紀錄的等待時間（`LAT_BOARD_LAUNCH_WAIT_SECONDS`，預設 180 秒）還沒出現就記逾時，兩種都不改名也不移動。主控的狀態仍以綁定為準，追蹤結果只另外顯示移動失敗或沒出現的原因。「最近新建」的主控紀錄依 `launchLink`（`src/lib/board/launch.ts`）決定按鈕：已啟用且在名冊上的是「看主控資訊 →」；否則 Herdr 清單上有它的 Agent 時是「看這個 Agent →」，開它的 Agent 頁面：已配對到主控的紀錄只認那個 session；還沒配對的以 HCOM 名稱找，同一個名稱只歸時間最新的那筆紀錄（Herdr 分頁開的新 Agent 也算），新建當下已綁在這個名稱上的 session 也不算。失敗的紀錄沒有按鈕。只在使用者按下時換頁，不切換 Herdr 焦點。新建與開新共用同一個隊伍：要等追蹤結束才換下一個，`POST` 則在 hcom 跑完就回應。`GET /api/launches` 的 `launches` 兩種各取最近 20 筆，各自的表單只列自己那種。

## 語音輸入

使用方式見[使用說明](../docs/lat-board.md#語音輸入)。實作上：功能開關記在瀏覽器的 localStorage，連按「待辦」分頁 5 次切換。

- 錄音送到看板伺服器的 `/api/voice`，由伺服器帶著憑證轉給語音辨識服務（見「設定」的 `LAT_BOARD_ASR_*`）；結果用 opencc-js 轉成台灣正體字（`traditional.ts` 的 `toTraditionalChars`，`cn` → `tw`，只轉字、不換用詞；翻譯用的 `toTraditional` 仍是 `twp`、含用詞），Codex 整理的提示也要它保留原本的用詞。放入時只取代選取的文字；錄音最長約 3 分鐘（略短於語音辨識服務的 180 秒上限）。
- 20 個字以內直接放到游標處；更長的先交給 Codex app server 修錯字、去掉口誤與贅字再放入。Codex 失敗、看不懂或逾時就放轉換後的原文，並以通知說明原因。
- 測試以 Bun 啟動的假語音辨識服務與 `tests/fake-codex.mjs`（假的 Codex app server）代替真的服務，不會呼叫外部服務。

## 附件

使用方式見[使用說明](../docs/lat-board.md#附件)。實作上：

- 瀏覽器把檔案切成每塊 256KB 依序上傳：`POST /api/uploads`（`name`、`size`）先建立空檔並回傳 `id` 與完整路徑，再以 `PUT /api/uploads/<id>?offset=<位置>` 逐塊附加；每塊都在 `BODY_SIZE_LIMIT` 預設的 512K 以內，所以傳附件不用調整這個上限。位置不接續、超過宣告大小或單塊超過 256KB 都回 409；超過 `LAT_BOARD_UPLOAD_MAX_MB` 在建立時就回 413。傳完最後一塊之前檔案以開頭加一個點的隱藏名稱存放（完成的檔名開頭不會是點），不會被讀回；未完成的上傳只記在記憶體，看板重啟後要重新選檔，留下的隱藏檔不會被當成附件。
- 檔案存在 `LAT_BOARD_UPLOAD_DIR/<日期>/<16 碼隨機字>-<檔名>`，資料夾權限 700、檔案 600；檔名去掉路徑、控制字元與開頭的點，空白換成 `_`，最長 237 位元組（中文一字 3 位元組，保留副檔名，不會切開一個字）。看板不會自己刪附件，放在 `/tmp` 時交給系統清理。
- 送出時在訊息最後空一行接上「附件：」與每個檔案的完整路徑（一行一個），Agent 自己開檔案；送出紀錄（主控與 Agent）與對話紀錄裡使用者自己的訊息找到這段就改顯示成附件（`AttachmentList.svelte`；Agent 的回覆不受影響）；讀不回來的檔案改寫「檔案已不在」（圖片與影片以外的檔案在顯示時以 `HEAD` 確認一次；點開圖片或 PDF、下載任何檔案時再確認一次，文字檔的預覽則由讀檔本身得知）。附件依輸入框的草稿分組：主控共用一組，每個 Agent 各一組。
- `GET /api/uploads/file?path=<完整路徑>` 讀回附件，只給附件資料夾內（解開連結後）已傳完的檔案，其他一律 404。圖片、影片與 PDF 照類型回應（PDF 為 `application/pdf`、不帶下載標頭，瀏覽器在新分頁用內建檢視器開），並支援分段讀取（影片拖曳進度與文字預覽要用），其他檔案一律以下載方式回應，下載標頭的檔名是上傳時的原名（`uploadedName` 去掉 16 碼前綴，存檔名稱不變）；所有回應都帶 `Content-Security-Policy: sandbox` 與 `nosniff`，上傳的網頁、SVG 或 PDF 不會以看板的身分執行（Chrome 的 PDF 檢視器在 sandbox 下照常顯示，已以 Chrome 144 實測）。
- 檔案種類依副檔名判斷（`attachments.ts` 的 `attachmentKind`）：圖片、影片、PDF、Markdown（.md、.markdown）、文字（常見文字與程式碼副檔名）與其他。點圖片或文字檔開 `AttachmentPreview.svelte` 的視窗（`<dialog>`）。文字預覽以 `Range: bytes=0-204799` 只讀開頭 200KB（204,800 位元組），由 `Content-Range` 的總長判斷是否截斷，切在一個字中間時捨去那半個字；Markdown 用對話紀錄同一個 `renderMarkdown`（不允許原始 HTML、不載入圖片、擋掉不安全的連結），其他文字放進 `<pre>` 當純文字。讀檔時發現檔案已不在就關掉視窗，改寫「檔案已不在」。視窗標題與「下載」用原名；標題只佔一行，`nameParts` 把檔名分成前 3 字、中段、副檔名前最多 6 字（不含前 3 字）與副檔名，太窄時先把中段縮成「…」，再從前面縮那 6 字（也標「…」），前 3 字與副檔名不縮。圖片以 `max-width`／`max-height: 100%` 整張放進視窗，觸控的雙指縮放與單指拖曳由 pointer 事件自己算（`touch-action: none`，只處理 `pointerType` 為 touch），滑鼠不縮放。視窗開著時 `:root:has(dialog.preview[open])` 設 `overflow: hidden`，背後頁面不捲動，關閉後位置不變。

## 版面與外觀

使用方式見[使用說明](../docs/lat-board.md#版面與外觀)，自訂樣式的變數表也在使用說明。實作上：

- 展開的名冊點空白處（不含卡片、按鈕、彈出框、欄寬拖曳條，剛選完文字也不算）收起，在 `+page.svelte` 的 `foldOnBlank`。
- 設定裡的字級都寫成 `max(<大小>, var(--min-font, 0px))`，新加的字級也要照這個寫法。
- 主控資訊頁的 Herdr 位置（在「詳細資料」裡）以工作區與分頁的名稱和第幾個顯示，由 `GET /api/herdr-place?controller=<ID>`（要登入）讀 `herdr workspace list` 與 `herdr tab list`；分頁的第幾個依清單順序計算，每次看板資料更新時重讀；看板移動接回分頁不會改變看板資料，所以移動成功後另外推送 `tab-moved` 事件，開著的頁面收到就重讀。
- 開著的畫面寫在網址裡（`?item=<key>`、`?controller=<ID>`、`?launch`、`?agent=<session ID>`），每開一個畫面記一筆瀏覽器歷史紀錄（`src/lib/board/navigation.ts`）。退到待辦列表時的捲動位置記在列表那一筆歷史紀錄裡，重新整理後也找得回來；不在待辦的項目會在「已處理」往前讀更早的頁找到為止；從別處直接開帶畫面的網址時，在它前面補一筆待辦列表。只為重新整理與返回使用，不保證網址拿到其他裝置的行為。
- 從別的網頁以整頁載入來到看板、再按「上一頁」回來時頁面會重新載入，不瞬間還原：瀏覽器暫存的離開頁面會一直占著即時連線，純 HTTP/1.1 下同一主機最多 6 條，幾頁暫存頁就會讓目前這頁的請求（翻譯、傳話、載入更早）一直卡住，所以離開時暫存頁面就結束連線（`src/hooks.client.ts`）。看板內點擊切換不受影響。
- 用量列樣式與對話翻譯偏好由看板統一保存、所有裝置共用；其餘版面設定只記在各自裝置的瀏覽器裡（清單見使用說明）。

## 錯誤紀錄

看板出錯時寫一行 JSON 到標準錯誤，背景常駐時由 systemd 收進 journal：

```bash
journalctl --user -u lat-board -o cat | grep '"layer":"lat-board"'
journalctl --user -u lat-board -o cat | grep '"message":"client_error"' | jq .
```

每行都有 `ts`（UTC）、`level`、`logger`、`layer`（固定 `lat-board`）、`message`（事件名），請求中寫的行另有同一請求共用的 `request_id`（沿用請求的 `x-request-id`，沒有就自產）。只記四種事件，不記一般請求，也不記 4xx 的拒絕（密碼錯誤、題目已改版等）：

| `message` | 何時寫 | 其他欄位 |
| --- | --- | --- |
| `http_error` | 任何 API 或頁面回應狀態 ≥ 500（例如輔助工具失敗的 502、寫不進送出紀錄的 500），也包括看板自己在處理請求前就出錯的 500 | `method`、`path`、`status`，以及回應裡的 `reason`、`error`、`logError`、`detail`（SvelteKit 錯誤頁的訊息），各最多 2000 字 |
| `unhandled_error` | 伺服器端沒被處理的例外（同一請求另有一行 500 的 `http_error`，連 SvelteKit 在請求處理前就失敗也是） | `method`、`path`、`exc_type`、`exc_message`、`traceback` |
| `client_error` | 瀏覽器端的錯誤：頁面變成 Internal Error、或沒被處理的 `error`／`unhandledrejection`，由頁面送到 `POST /api/client-error` | `kind`、`exc_type`、`exc_message`、`traceback`、`url`、`user_agent`、`device_id`；內容見下 |
| `transcript_push_failed` | 對話紀錄有更新時，送給某個開著的頁面出錯（同一段對話的其他頁面照常收到） | `client`、`session_id`、`exc_type`、`exc_message`、`traceback` |

不寫密碼、裝置 token、答覆與訊息內文：

- 伺服器端的 `http_error` 與 `unhandled_error`：每一行從回應或例外取來的文字，都先把該請求內容裡的 `text`、`note`、`password`（不論請求宣稱的內容類型；含去頭尾空白、換行統一、JSON 跳脫後的樣子與其中每一行）和該請求 cookie 的裝置 token 換成 `[omitted]`；Node 引述無法傳給指令的參數（`Received …`）、`JSON.parse` 引述讀不懂的內容（`"…" is not valid JSON`，含截短的）也一樣，網址去掉查詢字串與 `#` 之後。只引用答覆其中幾個字的原因認不出來。
- 瀏覽器的 `client_error`：頁面送來的錯誤訊息是任意文字，伺服器分辨不出其中有沒有答覆，所以一律不照原樣記，只記伺服器自己檢查後寫的內容。`exc_message` 只有認得整句的已知錯誤才記一個固定說法（Svelte 錯誤碼如 `svelte:each_key_duplicate`，常見的引擎訊息如 `cannot read a property of undefined`、`not a function`、`invalid JSON`、`network request failed`，其中提到的名稱不記），其餘記 `[omitted]`；`exc_type` 只收內建的錯誤類型（`Error`、`TypeError` 等），`kind` 只收三種來源，不符合的記 `[omitted]`；`traceback` 只留這次建置真有的腳本檔（伺服器列出 `build/client/_app/immutable` 下的檔案）裡的位置（`at /_app/...js:行:欄`，最多 30 個，多的以 `…[truncated]` 標示），函式名稱、訊息行、其他網站與不存在的檔案都不記，開發模式沒有建置所以不記位置；`url` 只記看板的頁面（`/`、`/login`），其他路徑記 `[omitted]`。`user_agent` 取自請求標頭，最多 500 字。以上每個欄位也再濾一次該請求的裝置 token。

`/api/client-error` 只收已登入裝置（未登入回 401、不寫）；整個請求超過 64K 字回 413；同一裝置每分鐘最多記 10 筆，其餘回 429 不寫。只寫標準錯誤，不另存日誌檔。

## 開發與測試

```bash
bun run dev -- --host 0.0.0.0 --port 7110
bun run check
bun run test           # 單元測試（tests/unit/）：不啟動伺服器、不開瀏覽器；裸跑 bun test 也只跑這層
bun run test:server    # 先建置到 build-test/，再跑 tests/server/：以暫存目錄與假的輔助工具啟動伺服器
bun run test:browser   # 先建置到 build-test/，再跑 tests/browser/：伺服器加無頭 Chrome
bun run test:all       # 先建置到 build-test/，再跑以上三層
```

測試分三層放在 `tests/unit/`、`tests/server/`、`tests/browser/`；共用的 `harness.ts`、`browser.ts`、`fake-*.mjs` 與 `fixtures/` 在 `tests/` 底下。後三個腳本的建置輸出到 `build-test/`（不進版控），測試伺服器只從那裡啟動，不會改寫常駐看板正在用的 `build/`；正式的 `bun run build` 仍輸出到 `build/`。`test:server`、`test:browser`、`test:all` 是整套測試，Agent 要經整套測試閘門執行（登記在 repo 根目錄的 `.suite-gate.json`）。

測試檔不得寫死 `/tmp/` 之類的固定暫存路徑，要用 `mkdtemp(join(tmpdir(), …))` 開暫存資料夾並在結束時刪掉；`tests/unit/no-hardcoded-tmp.test.ts` 掃描 `tests/` 底下的 `.ts`、`.mjs`、`.js`，發現就失敗並列出檔案與行號。

測試不讀寫真實的 `.lat/`、綁定登記或回報紀錄，也不會對真實的主控輸入文字或送出答案。測試用 Node 啟動伺服器，PATH 上沒有 Node 時改用執行測試的 Bun，所以只有 Bun 的主機也能跑完整套（`bun run test:all`）。瀏覽器測試找不到 Chrome 或 Chromium（`CHROME` 有指定時只找它）就失敗並寫明原因，不會略過。測試伺服器和瀏覽器測試用的 Chrome 都綁連接埠 0，由系統挑一個沒人用的，所以不受主機上其他服務占用的連接埠影響，測試也不需要設定連接埠。

瀏覽器擴充功能（例如 Dark Reader）會在頁面啟動前，在樣式表旁邊插入或搬動節點；樣式表放在頁面元件的範本裡就會讓首頁變成錯誤頁，所以一律放在 `<head>`。

```bash
bun run build:test && bun run repro:hydration   # 無頭 Chrome 模擬這些改動；有一種讓看板壞掉就以 1 結束
bun run repro:hydration --serve none       # 只啟動已登入的假資料看板，給裝了真實擴充功能的瀏覽器開
```

需要本機有 Chrome 或 Chromium（可用 `CHROME` 指定），使用測試連接埠起點加 12 與加 13 的兩個連接埠。

`tests/browser/back-navigation.test.ts` 也用無頭 Chrome（同樣可用 `CHROME` 指定，使用起點加 29 與加 30）在真的瀏覽器裡走返回與重新整理。

`tests/browser/page-navigation.test.ts` 也用無頭 Chrome（使用起點加 72 與加 73）在同一分頁以整頁載入輪流開主控頁、Herdr Agent 頁與已關閉 Agent 頁（桌機與手機寬度各三輪），確認暫存的頁面不占住連線、翻譯照常完成；並確認從別的頁面按上一頁回到看板時重新載入、即時更新照常、指令列草稿仍在。

`tests/server/status-poll.test.ts`（狀態輪詢：變更在間隔內推到頁面、沒變不推、沒頁面不讀、讀不到沿用、慢讀不重疊、傳話或中斷後補讀）。`tests/browser/agents-page.test.ts` 以同樣方式（使用起點加 32 與加 33）在電腦與手機寬度操作「Herdr」分頁（含傳話、中斷、關閉與操作紀錄），並檢查畫面不會左右捲動。傳話與中斷的伺服器端行為在 `tests/server/agent-control.test.ts`（起點加 34），關閉在 `tests/server/agent-close.test.ts`（起點加 35），切換模型、繼續切換與放棄切換在 `tests/server/agent-switch.test.ts`（起點加 37）。暫停與恢復通訊在 `tests/server/agent-pause.test.ts`，暫停紀錄的讀寫在 `tests/unit/pause-records.test.ts`。

`tests/browser/skill-hints-page.test.ts` 以同樣方式在指令列（電腦與手機寬度）與新建主控、開新 Agent 表單檢查 skill 名稱提示；Claude 的 skill 寫在測試暫存的家目錄與專案資料夾，Codex 的由假的 Codex app server（`tests/fake-codex.mjs`）回答。

`tests/browser/model-defaults-page.test.ts` 以同樣方式（使用起點加 44 與加 45）檢查新建主控與開新 Agent 表單的預設項目，以及新主控第一回合開始後不重新整理頁面，指令列模型標籤就顯示實際模型；client 設定寫在測試暫存的家目錄，不讀真的 `~/.claude`、`~/.codex`。

寬版底部指令列的版面規則：單行時目標標籤、輸入框文字與送出按鈕的垂直中心相差不超過 2px；輸入框隨多行內容長高時，標籤與按鈕都貼齊輸入框最下面一行，位置不跳動；送出按鈕在輸入框框線內的右側，輸入的文字不會跑到按鈕底下。量測（深色與淺色、整體大小 80／100／150 %）：

```bash
bun run build:test && bun run measure:commandline   # 無頭 Chrome；違反規則就以 1 結束；使用測試連接埠起點加 16 與加 17
bun scripts/measure-commandline.ts --serve     # 啟動已登入的假資料看板，再用 scripts/measure-commandline.py 以 WebKit 量同樣的案例
```

手機寬度（760px 以下）的指令列分兩行：迴紋針與麥克風由 `CommandLine.svelte` 自己放（`MessageBox` 的 `tools={false}`，麥克風呼叫它的 `insert`），寬版時仍在輸入框左邊、外觀與放在框內時相同；手機時外層改成 `display: contents`，以 `order` 排成第一行只有輸入框，第二行迴紋針、模型與思考強度、麥克風、喚醒選項、收起鈕（最右）。模型標籤的選單在手機改從指令列左側往上展開。`tests/browser/command-line-layout.test.ts` 檢查寬版一行與 360、390px 兩行的順序、每個按鈕點得到、沒有橫向捲動，以及收起後能再展開。

錯誤紀錄的伺服器端在 `tests/server/server-log.test.ts`（起點加 63），格式與限頻本身在 `tests/unit/log.test.ts`；`tests/browser/client-error-page.test.ts` 用無頭 Chrome（起點加 64 與加 65）讓頁面變成 Internal Error，檢查 journal 那一行。

封存與 30 天保留的期限都用看板的時鐘計算。測試以 `LAT_BOARD_CLOCK_FILE` 指定一個檔案，內容是一個 ISO 時間，看板就把它當成現在；沒有設定或檔案讀不出時間時用系統時間。
