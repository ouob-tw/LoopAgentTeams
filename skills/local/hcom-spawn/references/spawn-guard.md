# 派工把關 hook

`scripts/spawn-guard.py` 是 PreToolUse hook，掛在平常的 `hcom N claude|codex` 指令上：

- **派工前檢查**：Agent 要執行的指令裡有 `hcom [N] claude` 或 `hcom [N] codex` 時，缺下列任一項就擋下，回覆缺什麼與正確寫法。沒有例外開關。
  - Claude：`--dangerously-skip-permissions`、`--model <id>`、`--effort <level>`
  - Codex：`--yolo`（或同義的 `--dangerously-bypass-approvals-and-sandbox`）、`--model <id>`、`-c 'model_reasoning_effort="<level>"'`
- `hcom r`、`hcom f`、`hcom send` 等其他子指令與其他 client 不檢查。判斷時比照廣播攔截寧可多擋：讀不懂的指令只要像派工就擋下，被誤擋時改寫成單純的一行指令即可。
- **放行後背景檢查**：放行的派工指令會在背景起 `scripts/spawn-watch.py`，不阻塞派工方：
  1. 從 hcom 的 `batch_launched` 事件找到這次派出的 Agent，派工方以事件的 `by` 為準。同一行指令派多組時依 client（有 `--tag` 時再加 tag）與派工順序對應；沒帶 `--go` 的派工只是預覽，不核對也不佔順序；只認這次指令到同一派工方下一次派工之間的事件，所以沒真正啟動的派工不會冒認之後的派工。同一派工方同時平行執行多個派工指令時仍可能對錯。
  2. 替派工方訂閱每個 Agent 的等待確認狀態（`hcom events sub --blocked <agent> --for <派工方>`），Agent 每次停在確認畫面，派工方都立即收到通知。訂閱前就已停住的，另發一則通知。
  3. 讀 Agent 的畫面核對模型、effort 與權限：Claude 須 `bypass permissions on`；Codex 的模型與 effort 看底部狀態列；Codex 畫面通常不顯示權限模式，改看 session 紀錄 `turn_context` 的 `approval_policy: never` 與 `sandbox_policy: danger-full-access`。其他畫面上沒出現的項目也從 session 紀錄補。
  4. 不符，或 3 分鐘內無法確認時，以 `hcom-spawn` 名義點名通知派工方，寫明 Agent 名稱、預期值與實際值或無法確認的原因。全部相符不發訊息。不會關閉或重派 Agent。
  5. Agent 結束後移除訂閱、不再通知，背景程序結束；核對途中結束的 Agent 不發核對結果。背景程序意外中斷或移除訂閱失敗時，下一次派工會清掉已結束 Agent 的遺留訂閱。

紀錄放在 `${XDG_STATE_HOME:-~/.local/state}/hcom-spawn/`：`watch.log` 是背景程序的錯誤輸出，`subs/` 是尚未移除的訂閱，`runs/` 記每位派工方最近 50 次派工的事件位置。

## 安裝

先將 `skill_dir` 換成本技能實際安裝目錄的絕對路徑，再把下列 group 併入各 client 的 `PreToolUse` 陣列，保留既有 entries（可與廣播攔截共用同一個 `Bash` group，在其 `hooks` 陣列再加一筆）。

Claude Code（`~/.claude/settings.json` 的 `hooks`）與 Codex（`$CODEX_HOME/hooks.json` 的 `hooks`）寫法相同：

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "uv run --no-project python <skill_dir>/scripts/spawn-guard.py"
    }
  ]
}
```

- Claude Code 重啟後在 `/hooks` 確認。
- Codex 重啟後須在 `/hooks` 檢查並信任此 command；搬動技能或更新 command 後要重新信任。
- 已在執行的 Agent 不會套用，重啟後才生效。

驗證：在 Agent 內執行 `hcom 1 claude --go --name <自身名稱>`，應被擋下並列出三個缺項，且沒有 Agent 被啟動。
