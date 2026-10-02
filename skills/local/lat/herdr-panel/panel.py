# /// script
# requires-python = ">=3.11"
# dependencies = ["textual==8.2.8"]
# ///
"""Herdr popup editor for the LAT questions file bound to the current workspace.

``panel.py open`` is the ``lat.panel.open`` action: it resolves the binding for
``HERDR_WORKSPACE_ID`` through ``lat_panel`` and opens the ``popup`` pane. The
pane runs ``panel.py edit`` with the internal handoff variables
``LAT_PANEL_FILE`` (resolved questions file), ``LAT_PANEL_HERDR_WORKSPACE`` and,
when nothing can be opened, ``LAT_PANEL_ERROR`` (reason shown in the popup).
"""
import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import tomllib

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import lat_panel

from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.widgets import Static, TextArea

PLUGIN_ID = "lat.panel"
KEYS = "Ctrl+Q 關閉  Ctrl+Z 復原  Ctrl+Y 重做"
NO_BINDING = "此 workspace 沒有綁定的 LAT 中控"
CONFLICT = "外部內容已變更，暫停儲存。F5：備份目前草稿並載入磁碟版本。"
CONFLICT_CLOSE = "有未存的衝突草稿。先按 F5 備份草稿並載入磁碟版本，再關閉。"


def binding_error_text(error):
    if "no LAT controller is bound" in str(error):
        return NO_BINDING
    return f"無法讀取 LAT 綁定：{error}"


def failure_line(cause):
    return f"通知失敗：{cause}。Ctrl+N 重試；再按 Ctrl+Q 保留待送並關閉"


def notify_failure_text(reason, target):
    reason = (reason.strip().splitlines() or ["未知錯誤"])[0]
    target = target or "中控"
    if "timed out" in reason:
        cause = "通知逾時"
    elif reason.startswith("notification not delivered"):
        cause = f"{target} 未收到通知（不在線或未送達）"
    elif "No active agent" in reason:
        cause = f"{target} 不在線"
    elif binding_error_text(reason) == NO_BINDING:
        cause = NO_BINDING
    elif "binding does not match" in reason:
        cause = "目前綁定的問題檔已不是這個檔案"
    else:
        cause = f"HCOM 錯誤：{reason}"
    return failure_line(cause)


def herdr_theme(env, available):
    """Return ``(theme_name_or_None, notice)`` from Herdr's ``[theme].name``."""
    config_path = Path(
        env.get("HERDR_CONFIG_PATH") or Path.home() / ".config/herdr/config.toml"
    ).expanduser()
    try:
        config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return None, f"無法讀取 Herdr 設定，使用預設配色：{error}"
    theme = config.get("theme")
    name = theme.get("name") if isinstance(theme, dict) else None
    if isinstance(name, str) and name in available:
        return name, ""
    return None, f"Herdr 主題 {name or '未指定'} 無法套用，使用預設配色"


def rpc(method, params, env):
    endpoint = env.get("HERDR_SOCKET_PATH")
    if env.get("HERDR_ENV") != "1" or not endpoint:
        raise RuntimeError("run inside Herdr (needs HERDR_ENV=1 and HERDR_SOCKET_PATH)")
    request_id = "lat-panel-open"
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(endpoint)
        request = {"id": request_id, "method": method, "params": params}
        client.sendall((json.dumps(request) + "\n").encode())
        stream = client.makefile("rb")
        while line := stream.readline():
            response = json.loads(line)
            if response.get("id") == request_id:
                if "error" in response:
                    raise RuntimeError(str(response["error"]))
                return response
    raise RuntimeError("Herdr closed the connection without a response")


def open_popup(env=None, *, request=rpc):
    """Resolve the workspace binding and open the popup pane; never guesses."""
    env = os.environ if env is None else env
    workspace = env.get("HERDR_WORKSPACE_ID", "")
    pane_env = {"LAT_PANEL_HERDR_WORKSPACE": workspace}
    try:
        pane_env["LAT_PANEL_FILE"] = lat_panel.resolve_binding(workspace or None)["questions_path"]
    except (OSError, ValueError, KeyError) as error:
        pane_env["LAT_PANEL_ERROR"] = binding_error_text(error)
    return request("plugin.pane.open", {
        "plugin_id": PLUGIN_ID, "entrypoint": "popup", "placement": "popup",
        "env": pane_env, "focus": True,
    }, env)


class Panel(App):
    NOTIFY_DELAY = 2.0
    POLL_INTERVAL = 0.5
    NOTIFY_TIMEOUT = 10
    ENABLE_COMMAND_PALETTE = False
    CSS = """
    TextArea { height: 1fr; border: none; }
    #status { height: auto; padding: 0 1; color: $error; display: none; }
    #keys { height: 1; color: $text-muted; padding: 0 1; }
    """
    BINDINGS = [
        Binding("ctrl+q", "close_panel", "關閉", priority=True),
        Binding("ctrl+n", "retry_notification", "重試通知", priority=True, show=False),
        Binding("ctrl+z", "undo_edit", "復原", priority=True),
        Binding("ctrl+y", "redo_edit", "重做", priority=True),
        Binding("f5", "reload_file", "備份草稿並載入", priority=True),
    ]

    def __init__(self, path, herdr_workspace="", error="", env=None):
        super().__init__()
        theme, theme_notice = herdr_theme(os.environ if env is None else env, self.available_themes)
        if theme:
            self.theme = theme
        self.notices = {"theme": theme_notice}
        self.path = Path(path) if path else None
        self.herdr_workspace = herdr_workspace or None
        self.saved = ""
        self.conflict = False
        self.close_armed = False
        self.closing = False
        self.notify_timer = None
        self.unrecorded_notification = False
        self.notify_lock = asyncio.Lock()
        if not error:
            try:
                self.saved = self.path.read_text(encoding="utf-8")
            except FileNotFoundError:
                error = f"問題檔不存在：{self.path}"
            except (OSError, ValueError) as read_error:
                error = f"無法讀取問題檔 {self.path}：{read_error}"
        self.read_only = bool(error)
        self.notices["file"] = error

    @classmethod
    def from_env(cls, env):
        return cls(
            env.get("LAT_PANEL_FILE", ""), env.get("LAT_PANEL_HERDR_WORKSPACE", ""),
            env.get("LAT_PANEL_ERROR", "") or ("" if env.get("LAT_PANEL_FILE") else NO_BINDING),
            env,
        )

    def compose(self) -> ComposeResult:
        yield TextArea(
            self.saved, soft_wrap=True, show_line_numbers=False,
            read_only=self.read_only, id="editor",
        )
        yield Static("", id="status", markup=False)
        yield Static(KEYS, id="keys", markup=False)

    def on_mount(self):
        self.editor.focus()
        self.render_status()
        if self.read_only:
            return
        self.set_interval(self.POLL_INTERVAL, self.check_external)
        if self.notification_pending():
            self.start_notification()

    @property
    def editor(self):
        return self.query_one("#editor", TextArea)

    def set_notice(self, kind, message):
        self.notices[kind] = message
        self.render_status()

    def render_status(self):
        message = "\n".join(text for text in self.notices.values() if text)
        status = self.query_one("#status", Static)
        status.update(message)
        status.display = bool(message)

    def save(self):
        text = self.editor.text
        if self.read_only or self.conflict or text == self.saved:
            return not self.conflict
        try:
            saved = lat_panel.save_panel_edit(self.path, self.saved, text)
        except OSError as error:
            self.set_notice("save", f"儲存失敗：{error}")
            return False
        if not saved:
            self.enter_conflict()
            return False
        self.saved = text
        self.close_armed = False
        self.notices["save"] = ""
        self.render_status()
        self.mark_pending()
        return True

    def on_text_area_changed(self, _event):
        self.save()

    def enter_conflict(self):
        self.conflict = True
        self.set_notice("conflict", CONFLICT)

    def check_external(self):
        if self.conflict:
            return
        try:
            disk = self.path.read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            self.set_notice("read", f"無法讀取問題檔：{error}")
            return
        if self.notices.get("read"):
            self.set_notice("read", "")
        if disk == self.saved:
            if self.editor.text != self.saved:
                self.save()
            return
        if self.editor.text != self.saved:
            self.enter_conflict()
            return
        self.load(disk)

    def load(self, text):
        """Show disk text without saving or notifying; resets undo history."""
        location = self.editor.cursor_location
        self.saved = text
        self.editor.load_text(text)
        self.editor.move_cursor(location)

    def backup_draft(self, text):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.path.parent,
            prefix=f"{self.path.stem}-draft-{stamp}-", suffix=".md", delete=False,
        ) as backup:
            backup.write(text)
            backup.flush()
            os.fsync(backup.fileno())
        return Path(backup.name)

    def action_reload_file(self):
        if self.read_only:
            return
        draft = self.editor.text
        try:
            disk = self.path.read_text(encoding="utf-8")
            if draft != self.saved:
                self.backup_draft(draft)
        except (OSError, ValueError) as error:
            self.set_notice("save", f"備份或載入失敗：{error}")
            return
        self.conflict = False
        self.notices["conflict"] = self.notices["save"] = ""
        self.load(disk)
        self.render_status()

    def action_undo_edit(self):
        self.editor.undo()

    def action_redo_edit(self):
        self.editor.redo()

    def notification_pending(self):
        try:
            return lat_panel.notification_is_pending(self.path)
        except (OSError, ValueError) as error:
            self.set_notice("notify", notify_failure_text(str(error), ""))
            return False

    def mark_pending(self):
        try:
            lat_panel.mark_notification_pending(self.path)
        except (OSError, ValueError) as error:
            # Keep the obligation in memory so retry and close persist it first.
            self.unrecorded_notification = True
            self.set_notice("notify", failure_line(f"無法記錄待送通知：{error}"))
            return
        self.unrecorded_notification = False
        if self.notify_timer:
            self.notify_timer.stop()
        self.notify_timer = self.set_timer(self.NOTIFY_DELAY, self.start_notification)

    def start_notification(self):
        self.run_worker(self.send_notification(), group="notify")

    async def send_notification(self):
        """Send the persisted pending notification; return whether none is left."""
        async with self.notify_lock:
            target = ""
            if self.unrecorded_notification:
                try:
                    await asyncio.to_thread(lat_panel.mark_notification_pending, self.path)
                except (OSError, ValueError) as error:
                    self.set_notice("notify", failure_line(f"無法記錄待送通知：{error}"))
                    return False
                self.unrecorded_notification = False
            try:
                if not await asyncio.to_thread(lat_panel.notification_is_pending, self.path):
                    self.set_notice("notify", "")
                    return True
                binding = await asyncio.to_thread(lat_panel.resolve_binding, self.herdr_workspace)
                target = binding.get("hcom_name", "")
                ok, reason = await asyncio.to_thread(
                    lat_panel.send_pending_notification, self.path, binding,
                    timeout=self.NOTIFY_TIMEOUT,
                )
            except (OSError, ValueError) as error:
                ok, reason = False, str(error)
            if ok:
                self.close_armed = False
                self.set_notice("notify", "")
                return True
            self.set_notice("notify", notify_failure_text(reason, target))
            return False

    def action_retry_notification(self):
        if self.read_only or self.closing:
            return
        if self.notify_timer:
            self.notify_timer.stop()
        self.start_notification()

    def action_close_panel(self):
        if self.closing:
            return
        if self.read_only:
            self.exit()
            return
        if self.conflict:
            self.set_notice("conflict", CONFLICT_CLOSE)
            return
        if not self.save():
            return
        if self.close_armed:
            if self.unrecorded_notification:
                # Best effort: never trap the user in the popup over a disk error.
                self.mark_pending()
            self.exit()
            return
        if self.notify_timer:
            self.notify_timer.stop()
        self.closing = True
        self.editor.read_only = True
        self.run_worker(self.flush_and_close(), group="close")

    async def flush_and_close(self):
        try:
            delivered = await self.send_notification()
        finally:
            self.closing = False
        if delivered:
            self.exit()
        else:
            self.editor.read_only = False
            self.close_armed = True


def main(argv):
    command = argv[1] if len(argv) > 1 else "open"
    if command == "open":
        try:
            print(json.dumps(open_popup(), ensure_ascii=False))
        except (OSError, RuntimeError, ValueError) as error:
            print(f"lat-panel: {error}", file=sys.stderr)
            return 1
        return 0
    if command == "edit":
        Panel.from_env(os.environ).run()
        return 0
    print("usage: uv run --script panel.py [open|edit]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
