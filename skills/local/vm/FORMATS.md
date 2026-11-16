# vm 資料檔格式

給 host-guard 規則與維護者看。資料根目錄是 `$VM_HOME`，沒設時是 `~/vm`；`vm.py --root` 優先。JSON 檔一律先寫暫存檔再改名取代。時間字串一律 UTC，格式 `2026-11-17T03:00:00Z`。

## 狀態檔（只能由 vm.py 寫入）

| 檔案 | 內容 |
|---|---|
| `machines.json` | 機器清單 |
| `leases.json` | 借用紀錄 |
| `watch-state.json` | 看守狀態 |
| `vm.log` | 動作紀錄，一行一筆 JSON，只會附加 |
| `.lock` | 鎖檔；所有狀態轉換都在 `flock` 排他鎖內完成 |

### machines.json

```json
{"machines": {
  "win": {"container": "busi-vm-win", "memory_gb": 16,
          "ports": {"web": 8006, "rdp": 3389, "ssh": 2222},
          "ssh_host": "vm-win", "folder": "win"}
}}
```

- 鍵是機器名（小寫英數字與連字號）。
- `container`：Docker 容器名稱，清單內唯一。host-guard 用它判斷 `docker` 指令是否針對清單內機器。
- `memory_gb`：開機所需記憶體（G）。
- `ports`：連線埠名稱 → 本機埠號。
- `folder`：資料夾，相對於資料根目錄，等於機器名。

### leases.json

```json
{"leases": {
  "win": {"borrower": "zizi", "human": false, "purpose": "測試安裝程式",
          "borrowed_at": "2026-11-17T00:00:00Z", "expires_at": "2026-11-17T03:00:00Z",
          "powered_on_at": "2026-11-17T00:00:00Z", "warned": false,
          "absent_since": null,
          "stop_failed": {"reason": "到期", "release": true, "error": "...",
                          "notified_at": "2026-11-17T03:00:00Z"}}
}}
```

- 沒有鍵的機器就是沒人借用。
- `borrower`：HCOM 實例名稱，使用者借用時是 `使用者`（`human` 為 true）。host-guard 判斷「呼叫者是不是這台的借用者」就比對這個欄位與呼叫者的 `HCOM_INSTANCE_NAME`。
- `powered_on_at`：最近一次由 vm 開機的時間；開機後 10 分鐘內算「開機中」，記憶體檢查會扣除它的需求。
- `warned`：到期提醒已發；延長時歸零。
- `absent_since`：看守第一次發現借用者不在 HCOM 上的時間。
- `stop_failed`：只在關機失敗時出現；`release` 為 true 表示關機成功後要清除借用。

### watch-state.json

```json
{"low_memory": true, "since": "2026-11-17T03:00:00Z"}
```

`low_memory` 為 true 時拒絕所有開機，直到看守量到可用記憶體回到 8G 以上。

### vm.log

```json
{"time": "2026-11-17T02:50:00Z", "action": "remind", "machine": "win", "borrower": "zizi", "reason": "10 分鐘後到期", "by": "watch"}
```

`by` 是 `watch`（看守）、借用者名稱或 `使用者`。看守的 `action`：`remind`、`stop`、`release`、`absent`、`stop-failed`、`retry-stop`、`low-memory`、`low-memory-end`。

## 其他資料（不是狀態檔）

- `<機器>/`：該機磁碟、掛載資料與客體安裝檔。
- `ssh/`：`config` 與金鑰。
- `browser/`：操作虛擬機網頁畫面用的瀏覽器資料。
