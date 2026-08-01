# 外部執行安全

只有在呼叫端已選定外部 client，並提供 canonical workspace、不可變的
model／effort／permission 設定及私有普通 prompt 檔後，才可執行。launcher
必須在該 workspace 內執行，prompt 只能經 stdin 傳入，絕不可插入 argv。

第一個 identity 一律為 provisional。依賴、驗證、配額、權限、child identity
或 authoritative start 任一檢查失敗即拒絕；不得改用其他 client 或 mode。
保留 active turn 與 unsealed record 供檢查，但不可使其可 resume。capture 與
settings manifest 是每個 operation 的私有檔案；resume 必須使用 sealed exact
session 與完全相同的 settings manifest。prompt 在已交付或已證明未交付後必須
安全清除。

不得只因 client exit 就回報完成。monitor 必須取得 transcript evidence，且只有
它可以清除相符的 active turn。
