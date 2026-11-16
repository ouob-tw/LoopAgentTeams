---
name: vm
description: Use before using, starting, stopping or creating a full-OS virtual machine on this host (the Windows or macOS Docker containers, or a new one), when a vm command refused you, or when you receive a vm reminder or reclaim notice. Covers borrowing, extending, returning, adding a new machine, connecting over ssh, web screen or remote desktop, and the watcher service.
---

# 主機虛擬機借用（vm）

主機上的完整作業系統虛擬機（Docker 包的 Windows、macOS，以及日後登記的機器）一律借用後才用：誰在用、用到幾點都記在一處，別人不能開關或延長你借走的機器。以下 `<skill>` 指本技能安裝後的目錄，`vm` 指：

```bash
uv run --no-project python <skill>/scripts/vm.py
```

借用者取自 HCOM 實例名稱（`HCOM_INSTANCE_NAME`），所以 Agent 要在 HCOM 下執行；沒有這個名稱時一律拒絕，也沒有參數能指定借用者。時間一律顯示台北時間。

## 什麼時候借用

開機、ssh 進去、用網頁畫面或遠端桌面之前先借；用完立刻歸還。機器沒在執行也要借，借用就是開機的唯一方式。只是看狀態不用借。

## 各動作

| 指令 | 作用 |
|---|---|
| `vm list`、`vm status [機器]` | 每台的狀態（關機、開機中、執行中、關機失敗）、借用者、用途、到期時間與剩餘時間；指定機器時另列連線方式 |
| `vm borrow <機器> "<用途>" [--hours N]` | 借用並開機；預設 3 小時，最多 8 小時 |
| `vm extend <機器> [--hours N]` | 從目前到期時間往後延 N 小時（預設 3）；新到期最多現在起 8 小時 |
| `vm return <機器>` | 正常關機（給 2 分鐘）並清除借用 |
| `vm start <機器>` | 替自己借到但沒在執行的機器開機（登記後第一次開機、安裝中重開機、低記憶體關機後再開） |
| `vm add <機器> ...` | 登記新機器，登記者成為借用者，不開機（見「新增機器」） |

看守程式（`vm watch`，以 systemd 使用者服務常駐）每 30 秒處理一次：

- 到期前 10 分鐘以 HCOM 提醒你一次；還要用就 `vm extend`。
- 到期時正常關機（2 分鐘）並清除借用。
- 你在 HCOM 上連續消失超過 30 分鐘，機器提早關機收回。
- 可用記憶體低於 8G 時所有清單機器關機，借用保留並通知你；記憶體恢復後 `vm start` 再開。
- 沒有借用卻在執行的清單機器會被關機，所以不要繞過 `vm` 直接開機。
- 關機失敗時借用保留、狀態標「關機失敗」，看守每輪重試並通知你。

## 被拒時怎麼辦

被拒時結束碼非零，訊息寫明原因與下一步，照著做：

- **別人借用中**：訊息列出借用者、用途與到期時間。等它歸還或到期，或改借其他機器；需要時用 HCOM 問借用者。不要排隊空等，也不要自己開關容器。
- **記憶體不夠**：開機要「可用記憶體扣掉還在開機中的機器需求」≥「這台需求＋8G」。等別的機器歸還後再試。
- **看守暫停開機**：可用記憶體低於 8G，等它恢復。
- **找不到 HCOM 名稱**：在 HCOM 下啟動的 Agent 裡執行。
- **等不到鎖**：另一個動作（常是 2 分鐘的關機）正在進行，稍後再試。

## 使用者專用

- `vm borrow --human ...` 等動作加 `--human`，借用者記為「使用者」；使用者借用不發提醒、不做 HCOM 消失收回。
- `vm reclaim <機器> --to-human|--stop`：強制收回，先以 HCOM 通知原借用者，再轉給使用者或關機。

這兩個只給使用者在自己的終端機用；Agent 使用由 host-guard 擋下。

## 新增機器

1. `vm add <機器> --container <容器名> --memory-gb <G> --port web=<埠> --port ssh=<埠> [--port rdp=<埠>] --ssh-host <ssh 名稱> --purpose "<用途>"`。你成為借用者，`~/vm/<機器>/` 會建好。
2. 照官方說明（Windows：https://github.com/dockur/windows ，macOS：https://github.com/sickcodes/Docker-OSX ）以 **`docker create`** 建立容器，不開機：
   - 容器名稱用登記的名稱；
   - 掛載只用 `~/vm/<機器>/` 底下的路徑；
   - 連線埠只綁本機並用登記的埠，例如 `-p 127.0.0.1:8100:8006`。
3. `vm start <機器>` 開機（記憶體檢查同借用），開始安裝。
4. 安裝期間照一般借用規則：要更久就 `vm extend`，到期會關機，需要時再 `vm start`。完成後 `vm return` 或繼續用。

不要用 `docker run` 建立掛 `/dev/kvm` 的容器：它會直接開機、跳過記憶體檢查，host-guard 會擋下。

## 連線

`vm status <機器>` 會列出 ssh 名稱與連線埠。所有連線埠都只綁本機 `127.0.0.1`。

- **ssh**：`ssh -F ~/vm/ssh/config <ssh 名稱>`；設定與金鑰都在 `~/vm/ssh/`。
- **網頁畫面**：Windows 機器的 `web` 埠是 dockur/windows 內建的網頁畫面，瀏覽器開 `http://127.0.0.1:<web 埠>/`；macOS 機器用 `vnc` 埠。
- **遠端桌面**：Windows 機器的 `rdp` 埠，用遠端桌面用戶端連 `127.0.0.1:<rdp 埠>`。
- 用瀏覽器操作虛擬機網頁畫面時，瀏覽器資料放在 `~/vm/browser/`。

## 資料夾

`~/vm`（測試或其他位置用環境變數 `VM_HOME` 或 `--root` 指定）只放資料：每台機器的 `~/vm/<機器>/`（磁碟、掛載資料、客體安裝檔如 Windows 的 `oem/`）、借用紀錄、看守狀態、紀錄檔 `vm.log`、`ssh/` 與 `browser/`。管理程式都在本技能的 `scripts/`。檔案格式見 [FORMATS.md](FORMATS.md)；改格式時 host-guard 的規則要一起改。

## 看守服務

`scripts/vm-watch.service` 是 systemd 使用者服務範本，執行安裝後的 `~/.agents/skills/vm/scripts/vm.py watch`。複製到 `~/.config/systemd/user/` 後 `systemctl --user enable --now vm-watch.service`；更新技能後 `systemctl --user restart vm-watch.service` 才會生效。主機上只該有這一個看守。

## 已知限制

- host-guard 擋的是 Agent 不小心繞過借用的常見做法（直接 `docker start/stop`、改借用紀錄、自建關機排程、私自建立 KVM 容器、使用使用者專用動作），**不是資安防線**。所有 Agent 與使用者是同一個系統帳號，刻意偽造 `HCOM_INSTANCE_NAME` 或自己寫程式改紀錄仍擋不住。
- Claude 的檔案編輯工具寫入狀態檔會被擋，但 Codex 的檔案編輯工具不經過 host-guard，只擋得住它下的 shell 指令。
- 沒有排隊候補；一般測試容器不歸本技能管。
