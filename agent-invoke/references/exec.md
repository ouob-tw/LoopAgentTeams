# 外部 exec 交接

`run-exec-client.sh` 一次只接受一個 launch 或 resume operation。launch 會
bootstrap 一筆 `exec` record；Claude 的呼叫端預配置 UUID 必須等到唯一相符的
authoritative init event 確認才可 seal，fresh Codex 則必須先找到唯一、owned 的
native transcript，再 seal 唯一的 authoritative `thread.started` ID。seal 記錄
session-ref 保存 exact transcript identity；owner 只保存 PID、start time、executable、
private token，而 baseline/current native turn ID 僅保存 active-turn。

launcher 以 Bash array 建立 client argv，並 redirect 私有 prompt 檔。它會 capture
每個 turn 的 stream、等待該 exact child，並拒絕缺少、重複或不相符的 start identity。
成功 launch 會保留 active turn 給 completion monitor。resume 必須先驗證 sealed
client、workspace、exact session 與 immutable settings，才可建立呼叫端指定的 exact
turn token。
