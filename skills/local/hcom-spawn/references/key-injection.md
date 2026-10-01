# 替 Agent 按鍵

需要在 Agent 的終端畫面觸發斜線指令（如 `/compact`）、在選單移動或取消時，用 `hcom term inject`。它把字元原樣送進對方終端，沒有方向鍵參數，特殊鍵用 bash 的 `$'…'` 送跳脫序列：

```bash
hcom term inject <名稱> '/compact' --name <自身名稱>   # 打字，不送出
hcom term inject <名稱> --enter --name <自身名稱>      # Enter
hcom term inject <名稱> $'\e[B' --name <自身名稱>      # ↓；↑ \e[A、→ \e[C、← \e[D
hcom term inject <名稱> $'\e' --name <自身名稱>        # Esc
```

- 每按一步就用 `hcom term <名稱>` 看畫面，確認游標或選項真的移到目標再按 Enter。選單會改設定（例如 `/model`）而畫面確認不了時，按 Esc 離開，不要盲按 Enter。
- 按鍵之間用 `hcom listen 2` 等畫面更新，不用 `sleep`。
- 只按任務需要的鍵；替 Agent 選選項等於替它做決定，任務訊息沒授權的選擇先問使用者。

HCOM 0.7.26 實測：Claude Code 2.1.284 文字帶 `--enter` 一次送出可用；Codex CLI 0.158.0 文字與 Enter 分兩次送可用，一次送出未測。Codex `/model` 選單送 `\e[B` 游標下移一項，送 `\e` 離開且模型未變。
