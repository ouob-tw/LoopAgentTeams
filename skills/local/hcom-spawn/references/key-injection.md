# 替 Agent 按鍵

需要在 Agent 的終端畫面觸發斜線指令（如 `/compact`）、在選單移動或取消時，用 `hcom term inject`。它把字元原樣送進對方終端，沒有方向鍵參數，特殊鍵用 bash 的 `$'…'` 送跳脫序列：

```bash
hcom term inject <名稱> '/compact' --name <自身名稱>   # 打字，不送出
hcom term inject <名稱> --enter --name <自身名稱>      # Enter
hcom term inject <名稱> $'\e[B' --name <自身名稱>      # ↓；↑ \e[A、→ \e[C、← \e[D
hcom term inject <名稱> $'\e' --name <自身名稱>        # Esc
```

- 每按一步就用 `hcom term <名稱>` 看畫面，確認游標或選項真的移到目標再按 Enter。選單會改設定（例如 `/model`）而畫面確認不了時，按 Esc 離開，不要盲按 Enter。
- 按鍵之間用 `timeout 2 tail -f /dev/null || true` 等畫面更新，不用 `hcom listen`：listen 一收到訊息就返回並把訊息標為已讀，畫面可能還沒更新，輸出沒讀就等於漏收訊息。
- 只按任務需要的鍵；替 Agent 選選項等於替它做決定，任務訊息沒授權的選擇先問使用者。

HCOM 0.7.31 實測固定等待：`timeout 8 tail -f /dev/null || true` 在 Codex CLI 0.164.0（GPT-6.1-Sol medium）與 Claude Code 2.1.319（Sonnet 5.5 medium）各跑 3 次都照跑、約 8 秒，等待期間送來的 HCOM 訊息都在指令結束時收到。`sleep` 不穩：Codex 有時以 HCOM 注入的「不用 sleep」拒跑，Claude Code 擋下 `sleep 40; echo`。`hcom listen N --sql "1=0"` 這類過濾條件擋不住送給自己的訊息，照樣返回並標為已讀，不能當等待。

HCOM 0.7.26 實測：Claude Code 2.1.284 文字帶 `--enter` 一次送出可用；Codex CLI 0.158.0 文字與 Enter 分兩次送可用，一次送出未測。Codex `/model` 選單送 `\e[B` 游標下移一項，送 `\e` 離開且模型未變。
