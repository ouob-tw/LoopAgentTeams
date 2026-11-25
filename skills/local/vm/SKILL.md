---
name: vm
description: Use before using, starting, stopping or creating a full-OS virtual machine on this host (the Windows or macOS Docker containers, or a new one), before starting an Android emulator (AVD) on this host, when a vm command or host-guard refused you, or when you receive a vm reminder or reclaim notice. Covers borrowing, extending, returning, adding a new machine, borrowing Android emulators and their adb names, connecting over ssh, web screen or remote desktop, and the watcher service.
---

# 主機虛擬機借用（vm）

主機上的完整作業系統虛擬機（Docker 包的 Windows、macOS，以及日後登記的機器）與 Android 模擬器一律借用後才用：誰在用、用到幾點都記在一處，別人不能開關或延長你借走的機器。以下 `<skill>` 指本技能安裝後的目錄，`vm` 指：

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
- 可用記憶體低於 8G 時所有清單機器與模擬器關機，借用保留並通知你；記憶體恢復後 `vm start` 再開。
- 沒有借用卻在執行的清單機器會被關機，所以不要繞過 `vm` 直接開機；模擬器的規則見「Android 模擬器」。
- 關機失敗時借用保留、狀態標「關機失敗」，看守每輪重試並通知你。

## 被拒時怎麼辦

被拒時結束碼非零，訊息寫明原因與下一步，照著做：

- **別人借用中**：訊息列出借用者、用途與到期時間。等它歸還或到期，或改借其他機器；需要時用 HCOM 問借用者。不要排隊空等，也不要自己開關容器。
- **記憶體不夠**：開機要「可用記憶體扣掉還在開機中的機器需求」≥「這台需求＋8G」。等別的機器歸還後再試。
- **找不到模擬器**：訊息列出可借的名稱與搜尋過的資料夾；名稱打錯就改，還沒建立就先 `avdmanager create avd`。
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

## Android 模擬器

主機上的 Android 模擬器（AVD）不進 Docker，但開機一樣只經 `vm`，每台模擬器是一筆借用，名稱寫成 `android --avd <名稱>`（`vm list` 顯示為 `android:<名稱>`，兩種寫法都收）。

```bash
vm list android                                   # 全部模擬器與狀態
vm borrow android "測試登入" --avd pixel [--hours N] [--emulator-args "-cores 2"]
vm extend android --avd pixel                     # extend、return、start、status 都同樣寫法
vm return android --avd pixel
```

- `vm borrow` 以無視窗方式開機（`-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`，再加上 `--emulator-args`），連線埠由 vm 從 5554 起挑沒人用的偶數埠，印出 adb 連線名稱，例如 `emulator-5554`。開機要一兩分鐘，用 `adb -s emulator-5554 wait-for-device` 等它；之後 adb 安裝與操作照常。開機輸出在 `~/vm/android/<名稱>.log`。
- 同一台模擬器同時只借給一人；不同模擬器可同時借給不同 Agent。
- 記憶體需求是該模擬器 `config.ini` 的 `hw.ramSize` 加 2G，讀不到時算 4G；檢查方式同虛擬機。
- 找模擬器的資料夾依序是 `$ANDROID_AVD_HOME`、`~/.android/avd`、各 SDK 的 `avd/`、`~/Android/` 底下名稱含 `avd` 的資料夾（例如 `~/Android/qa88-avd`）。同名出現在兩個資料夾時拒絕，先改名。SDK 依序找 `$ANDROID_HOME`、`$ANDROID_SDK_ROOT`、`~/Android/Sdk`、`~/Android/sdk`、`~/android-sdk`，用第一個有 `emulator` 且有該模擬器系統映像的。
- 可以自己建模擬器（`avdmanager create avd`），建好就能借。不要直接執行 `emulator -avd …` 或 SDK 的 `qemu-system-*`：host-guard 會擋，看守也會關掉沒借用的模擬器。
- 關機先 `adb emu kill` 正常關（最多 2 分鐘），關不掉送 SIGTERM，最後 SIGKILL；都失敗就照「關機失敗」流程保留借用、每輪重試並通知你。
- 沒有借用卻在執行的模擬器：看守第一次處理模擬器時就已在執行的（vm 管理模擬器之前開的）不會因沒借用被關，`vm list` 會標示。是你開的就用 `vm borrow android "<用途>" --avd <名稱>` 接手：vm 不重開，直接登記給你，之後照借用規則到期關機。只接手自己開的。之後才出現的沒借用模擬器，看守記入 `vm.log`，10 分鐘內沒人借用就關機。

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
- 模擬器的程式是從程式清單（`ps`）認的：只有 SDK 的 `emulator` 或 `qemu-system-*` 帶著 `-avd <名稱>`（或 `@<名稱>`）才算，Docker 虛擬機裡的 qemu 不算。
