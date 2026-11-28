---
name: task-proposal
description: 使用者在對話中要你新增定期執行的自動化任務時使用：把任務送到 LAT 看板成為任務提案，等使用者在看板以 passkey 核准後才建立；也用來查詢、等待或撤回自己送出的提案。
---

# 任務提案

用 `uv run --no-project python scripts/task-proposal.py` 送出、查詢、等待或撤回提案，用法見 `scripts/task-proposal.py --help`。

- 送出：`submit <檔案>`，檔案是一個 JSON 物件，欄位和看板「新增任務」相同。
- 查詢：`status <提案編號>`；等待：`wait <提案編號> --timeout <秒>`；撤回：`withdraw <提案編號>`。
- 看板沒在執行時，送出與撤回會印「看板沒在執行」並以 3 結束。
- 不要直接改看板狀態資料夾裡的任何檔案。
