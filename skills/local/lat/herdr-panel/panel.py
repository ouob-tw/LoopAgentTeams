# /// script
# requires-python = ">=3.11"
# dependencies = ["textual==8.2.8"]
# ///
"""Herdr popup for answering the LAT questions file bound to the current workspace.

``panel.py open`` is the ``lat.panel.open`` action: it resolves the current tab
against controller panes from Herdr's 0.9.3 ``session.snapshot`` API, then opens
the ``popup`` pane. With more than one unmatched controller, the popup receives
``LAT_PANEL_CHOICES`` and lists one controller per row to choose from before
opening the questions.

The popup opens in selector mode: one tab per 待答 question plus a final 送出
review tab. Every selection or input change is written as an unchecked draft
through ``lat_panel.write_question_answer``; only 送出 checks questions and
notifies the controller. Ctrl+E toggles the V1 raw-file editor.
"""
import asyncio
import dataclasses
from datetime import datetime
import json
import os
import re
from pathlib import Path
import socket
import sys
import tempfile
import tomllib

if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
import cjk_wrap
import lat_panel

from rich.cells import cell_len
from rich.text import Text
from textual.actions import SkipAction
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import VerticalScroll
from textual import events
from textual.messages import InBandWindowResize
from textual.widgets import Static, TextArea

cjk_wrap.install()

PLUGIN_ID = "lat.panel"
KEYS = "A–I／Enter 選擇 · ↑↓ 移動 · ←→ 換題 · Tab 備註 · Esc 關閉"
RAW_KEYS = "Ctrl+E 選擇框  Ctrl+Q 關閉  Ctrl+Z 復原  Ctrl+Y 重做"
INPUT_KEYS = "Enter 換行 · Esc 離開輸入框"
PICKER_KEYS = "↑↓ 移動 · Enter 選定 · 1–9 直接選 · Esc 關閉"
PICKER_TITLE = "選擇要回答哪個主控的問題"
PANE_MISSING = "視窗已不存在"
NO_QUESTIONS = "目前沒有待答問題"
OTHER_LABEL = "其他（自己輸入）"
SUBMITTED = "已送出，等待記錄"
RECORDED = "✔ 已記錄"
LOCKED = "已送出或已記錄的題目不能修改；要改答案請在聊天告訴主控"
FORGED = "答覆或備註不能有單獨一行寫成「- [x] 送出」、「答覆：」或題目標題；這次輸入沒有儲存"
TAB_TITLE_CELLS = 16
RECOMMENDED = "（建議）"
# A focus unit is ``(kind, id, start)``: a paragraph ("text", number), an option
# ("option", index) or a row after the options ("post", name), then the offset
# in its text where this part of it starts.
FIRST_UNIT = ("text", 0, 0)
NO_BINDING = "此 workspace 沒有綁定的 LAT 主控"
CONFLICT = "外部內容已變更，暫停儲存。F5：備份目前草稿並載入磁碟版本。"
CONFLICT_CLOSE = "有未存的衝突草稿。先按 F5 備份草稿並載入磁碟版本，再關閉。"
CONFLICT_SWITCH = "有未存的衝突草稿。先按 F5 備份草稿並載入磁碟版本，再切換到選擇框。"


def binding_error_text(error):
    if "no LAT controller is bound" in str(error):
        return NO_BINDING
    return f"無法讀取 LAT 綁定：{error}"


def notify_failure_line(cause):
    return f"通知失敗：{cause}。Ctrl+N 重試；再按 Ctrl+Q 保留待送並關閉"


def submission_error_text(text):
    question_ids = lat_panel.malformed_submission_ids(text)
    if not question_ids:
        return ""
    return (
        f"送出格式錯誤：{'、'.join(question_ids)} 已勾選送出，"
        "但找不到完整的答覆格式"
    )


def notify_failure_text(reason, target):
    reason = (reason.strip().splitlines() or ["未知錯誤"])[0]
    target = target or "主控"
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
    return notify_failure_line(cause)


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


def _live_tabs(request, env):
    """Return ``(pane id -> tab id, tab id -> tab name)`` from Herdr's snapshot."""
    snapshot = request("session.snapshot", {}, env)["result"]["snapshot"]
    panes = snapshot["panes"]
    if not isinstance(panes, list):
        raise ValueError("Herdr snapshot panes are invalid")
    tabs = snapshot.get("tabs")
    return {
        pane["pane_id"]: pane["tab_id"]
        for pane in panes
        if isinstance(pane, dict) and pane.get("pane_id") and pane.get("tab_id")
    }, {
        tab["tab_id"]: tab["label"]
        for tab in (tabs if isinstance(tabs, list) else [])
        if isinstance(tab, dict) and tab.get("tab_id")
        and isinstance(tab.get("label"), str) and tab["label"].strip()
    }


def _picker_choice(binding, pane_tabs, tab_names):
    """Add what the picker shows about a binding's Herdr tab and pane."""
    if pane_tabs is None:
        return binding
    live_tab = pane_tabs.get(binding.get("herdr_pane"))
    tab = live_tab or binding.get("herdr_tab", "")
    return dict(binding, tab_name=tab_names.get(tab, tab), pane_missing=live_tab is None)


def _open_binding_env(binding, workspace):
    return {
        "LAT_PANEL_HERDR_WORKSPACE": workspace,
        "LAT_PANEL_FILE": binding["questions_path"],
        "LAT_PANEL_SESSION_ID": binding["session_id"],
    }


def open_popup(env=None, *, request=rpc):
    """Route by live controller tab, then single binding, then a picker."""
    env = os.environ if env is None else env
    workspace = env.get("HERDR_WORKSPACE_ID", "")
    current_tab = env.get("HERDR_TAB_ID", "")
    pane_env = {"LAT_PANEL_HERDR_WORKSPACE": workspace}
    try:
        bindings = lat_panel.list_bindings(workspace or None)
        if not bindings:
            raise ValueError("no LAT controller is bound to this Herdr workspace")
        try:
            pane_tabs, tab_names = _live_tabs(request, env)
        except (KeyError, OSError, RuntimeError, TypeError, ValueError):
            pane_tabs, tab_names = None, {}
        matches = [
            binding for binding in bindings
            if current_tab and (
                pane_tabs.get(binding.get("herdr_pane")) if pane_tabs is not None
                else binding.get("herdr_tab")
            ) == current_tab
        ]
        if len(matches) == 1:
            pane_env = _open_binding_env(matches[0], workspace)
        elif len(bindings) == 1:
            pane_env = _open_binding_env(bindings[0], workspace)
        else:
            pane_env["LAT_PANEL_CHOICES"] = json.dumps(
                [_picker_choice(binding, pane_tabs, tab_names) for binding in bindings],
                ensure_ascii=False,
            )
    except (OSError, ValueError, KeyError) as error:
        pane_env["LAT_PANEL_ERROR"] = binding_error_text(error)
    return request("plugin.pane.open", {
        "plugin_id": PLUGIN_ID, "entrypoint": "popup", "placement": "popup",
        "env": pane_env, "focus": True,
    }, env)


def wrap_rows(rows, width):
    """Wrap ``(first_prefix, text, style)`` rows CJK-aware with hanging indents.

    Returns the Rich text, the first display line of every row, and for every
    display line the offset in its row's text where it starts.
    """
    output = Text()
    starts = []
    chars = []
    for prefix, text, style in rows:
        starts.append(len(chars))
        indent = " " * cell_len(prefix)
        available = max(width - len(indent), 1)
        lead = prefix
        position = 0
        for paragraph in text.split("\n"):
            offsets = cjk_wrap.compute_wrap_offsets(paragraph, available, 4)
            bounds = [0, *offsets, len(paragraph)]
            for begin, finish in zip(bounds, bounds[1:]):
                if chars:
                    output.append("\n")
                output.append(lead + paragraph[begin:finish].rstrip(), style)
                chars.append(position + begin)
                lead = indent
            position += len(paragraph) + 1
    return output, starts, chars


def answer_label(label):
    """Option text as written to the answer area; 建議 is display-only."""
    return label.removesuffix(RECOMMENDED).rstrip()


def short_title(title, cells=TAB_TITLE_CELLS):
    if cell_len(title) <= cells:
        return title
    shortened = ""
    for character in title:
        if cell_len(shortened + character) > cells - 1:
            break
        shortened += character
    return shortened + "…"


def pending_titles(questions_path):
    """Return the titles of the questions waiting for an answer in a file."""
    try:
        text = Path(questions_path).read_text(encoding="utf-8")
    except (OSError, ValueError):
        text = ""
    return [
        section["title"] for section in lat_panel.parse_questions(text)
        if section["status"] == "pending"
    ]


class Draft:
    """In-memory selector state for one question tab, mirrored to its answer area."""

    def __init__(self, section):
        self.id = section["id"]
        self.revision = section["revision"]
        self.hash = lat_panel.question_section_sha256(section)
        self.title = section["title"]
        parsed = lat_panel.parse_question_options(section)
        self.kind = parsed.kind
        self.options = parsed.options
        self.reason = parsed.reason
        self.context = lat_panel.question_context(section)
        self.recommendation = lat_panel.question_recommendation(section)
        self.malformed_submission = section["malformed_submission"]
        if section["status_label"] == "已記錄":
            self.status = "recorded"
        elif section["checked"]:
            self.status = "submitted"
        elif section["answer"] is None:
            self.status = "broken"
        else:
            self.status = "draft"
        self.focus = FIRST_UNIT
        self.selected = []
        self.other = ""
        self.note = ""
        self.unmatched = ""
        self.unsaved = False
        answer = lat_panel.parse_question_answer(section) if section["answer"] else None
        if answer is not None:
            self.restore(answer)

    @property
    def cursor(self):
        """Index of the focused option, or ``None`` while reading other text."""
        return self.focus[1] if self.focus[0] == "option" else None

    @cursor.setter
    def cursor(self, index):
        self.focus = ("option", index, 0)

    @property
    def other_index(self):
        return len(self.options)

    def letters(self):
        """Row letters: the file's keys for single, A, B, … for multi; 其他 takes the next."""
        if self.kind == "single":
            keys = [option.key for option in self.options]
        else:
            keys = [chr(ord("A") + index) if index < 26 else "" for index in range(len(self.options))]
        following = chr(max((ord(key) for key in keys if key), default=ord("A") - 1) + 1)
        return keys + [following if following <= "Z" else ""]

    @property
    def editable(self):
        return self.status == "draft"

    @property
    def submittable(self):
        """Editable with a saved answer the review tab shows in full."""
        return (
            self.editable and self.answer() is not None
            and not self.unmatched and not self.unsaved
        )

    def restore(self, answer):
        self.note = answer.note
        if answer.kind in ("other", "text"):
            self.other = answer.other
            if answer.kind == "other":
                self.selected = [self.other_index]
            return
        unmatched = []
        for selection in answer.selections:
            index = self.match(selection)
            if index is None:
                unmatched.append(selection)
            elif index not in self.selected:
                self.selected.append(index)
        if answer.kind == "multi" and answer.other:
            self.other = answer.other
            self.selected.append(self.other_index)
        self.unmatched = "；".join(unmatched)

    def match(self, selection):
        for index, option in enumerate(self.options):
            if self.kind == "single" and (
                selection == f"{option.key}. {option.label}"
                or selection == option.key
                or selection.startswith(f"{option.key}.")
            ):
                return index
            if selection in (option.label, answer_label(option.label)):
                return index
        return None

    def answer(self):
        """Return the ``QuestionAnswer`` to write, or ``None`` for no answer."""
        if self.kind is None:
            if not self.other.strip():
                return None
            return lat_panel.QuestionAnswer("text", (), self.other, self.note)
        if self.kind == "single":
            if self.selected == [self.other_index]:
                if not self.other.strip():
                    return None
                return lat_panel.QuestionAnswer("other", (), self.other, self.note)
            if not self.selected:
                return None
            option = self.options[self.selected[0]]
            return lat_panel.QuestionAnswer(
                "single", (f"{option.key}. {answer_label(option.label)}",), "", self.note
            )
        labels = tuple(
            answer_label(self.options[index].label) for index in self.selected
            if index != self.other_index
        )
        other = self.other if self.other_index in self.selected and self.other.strip() else ""
        if not labels and not other:
            return None
        return lat_panel.QuestionAnswer("multi", labels, other, self.note)

    def summary(self):
        """Answer text shown on the review tab."""
        answer = self.answer()
        if self.unsaved:
            return "（未儲存：答覆或備註含不允許的行）"
        if answer is None:
            return self.unmatched or "（未作答）"
        area = lat_panel.render_answer_area(answer)
        text = area.rsplit("\n\n- [", 1)[0].removeprefix("答覆：")
        return f"{text}（無法對應選項：{self.unmatched}）" if self.unmatched else text

    def marker(self):
        if self.status == "recorded":
            return "✔"
        if self.unsaved:
            return "☐"
        return "☒" if self.answer() is not None or self.unmatched else "☐"


class Relayout:
    """Lay the selector out again once this widget has its new size."""

    def on_resize(self, event):
        self.app.on_resize(event)


class Body(Relayout, VerticalScroll):
    """The scrolling question area; tells the panel when the user scrolls it."""

    def on_mouse_scroll_up(self, _event):
        self.app.keep_scroll()

    def on_mouse_scroll_down(self, _event):
        self.app.keep_scroll()

    def on_scroll_up(self, _message):
        self.app.keep_scroll()

    def on_scroll_down(self, _message):
        self.app.keep_scroll()

    def on_scroll_to(self, _message):
        self.app.keep_scroll()


class View(Relayout, Static):
    """The question text; a click focuses or chooses the unit under it."""

    def on_click(self, event):
        offset = event.get_content_offset(self)
        if offset is not None:
            self.app.click_view(offset.y)


class Tabs(Static):
    """The tab bar; a click switches to the tab under it."""

    def on_click(self, event):
        offset = event.get_content_offset(self)
        if offset is not None:
            self.app.click_tab(offset.x)


class Status(Relayout, Static):
    pass


class Input(TextArea):
    """The answer/note box; keeps its cursor in view when it is resized."""

    def on_resize(self, _event):
        self.scroll_cursor_visible()


class Panel(App):
    NOTIFY_DELAY = 2.0
    POLL_INTERVAL = 0.5
    NOTIFY_TIMEOUT = 10
    ARCHIVE_AFTER = 300
    PICKER_PAGE_SIZE = 9
    ENABLE_COMMAND_PALETTE = False
    AUTO_FOCUS = None
    CSS = """
    #picker { height: auto; padding: 0 1; text-wrap: nowrap; }
    #tabs { height: 1; padding: 0 1; }
    #body { height: 1fr; scrollbar-gutter: stable; }
    #view { padding: 1 1 0 0; }
    #input-label { height: 1; padding: 0 1; color: $text-muted; }
    #input { height: auto; min-height: 3; max-height: 10; }
    #editor { height: 1fr; border: none; }
    #status { height: auto; padding: 0 1; color: $error; display: none; }
    #keys { height: 1; color: $text-muted; padding: 0 1; }
    """
    BINDINGS = [
        Binding("ctrl+q", "close_panel", "關閉", priority=True),
        Binding("escape", "escape", "關閉", priority=True, show=False),
        Binding("ctrl+e", "toggle_raw", "原始檔", priority=True, show=False),
        Binding("ctrl+n", "retry_notification", "重試通知", priority=True, show=False),
        Binding("ctrl+z", "undo_edit", "復原", priority=True),
        Binding("ctrl+y", "redo_edit", "重做", priority=True),
        Binding("f5", "reload_file", "備份草稿並載入", priority=True),
        Binding("up", "move(-1)", priority=True, show=False),
        Binding("down", "move(1)", priority=True, show=False),
        Binding("pageup", "page(-1)", priority=True, show=False),
        Binding("pagedown", "page(1)", priority=True, show=False),
        Binding("left", "switch_tab(-1)", priority=True, show=False),
        Binding("right", "switch_tab(1)", priority=True, show=False),
        Binding("enter", "choose", priority=True, show=False),
        Binding("space", "toggle", priority=True, show=False),
        Binding("tab", "note", priority=True, show=False),
        *(
            Binding(str(digit), f"digit({digit})", priority=True, show=False)
            for digit in range(1, 10)
        ),
        *(
            Binding(key, f"letter('{key}')", priority=True, show=False)
            for key in "abcdefghiABCDEFGHI"
        ),
    ]

    def __init__(
        self, path, herdr_workspace="", error="", env=None, *, session_id="", choices=None,
    ):
        super().__init__()
        theme, theme_notice = herdr_theme(os.environ if env is None else env, self.available_themes)
        if theme:
            if not self.available_themes[theme].dark:
                # Light themes get a pure white background instead of the theme's tint.
                self.register_theme(dataclasses.replace(
                    self.available_themes[theme], background="#ffffff",
                ))
            self.theme = theme
        self.notices = {"theme": theme_notice}
        self.path = Path(path) if path else None
        self.herdr_workspace = herdr_workspace or None
        self.session_id = session_id or None
        self.choices = choices or []
        self.picker_active = bool(self.choices)
        self.picker_cursor = 0
        # Rows per page as last drawn; digits and paging follow what is on screen.
        self.picker_size = self.PICKER_PAGE_SIZE
        self.picker_pending = [
            pending_titles(item.get("questions_path", "")) for item in self.choices
        ]
        self.raw_mode = False
        self.drafts = {}
        self.tab = 0
        self.input_target = None
        self.kept_scroll = None
        self.review_focus = FIRST_UNIT
        self.units = []
        self.tab_spans = []
        self.revised = {}
        self.saved = ""
        self.conflict = False
        self.close_armed = False
        self.closing = False
        self.notify_timer = None
        self.unrecorded_notification = False
        self.notify_lock = asyncio.Lock()
        if not error and not self.picker_active:
            error = self.read_file()
        self.read_only = bool(error) or self.picker_active
        self.notices["file"] = error

    @classmethod
    def from_env(cls, env):
        try:
            choices = json.loads(env.get("LAT_PANEL_CHOICES", "[]"))
            if not isinstance(choices, list):
                raise ValueError("choices must be a list")
        except (json.JSONDecodeError, ValueError) as error:
            choices = []
            env = dict(env, LAT_PANEL_ERROR=f"無法讀取 LAT 選單：{error}")
        return cls(
            env.get("LAT_PANEL_FILE", ""), env.get("LAT_PANEL_HERDR_WORKSPACE", ""),
            env.get("LAT_PANEL_ERROR", "")
            or ("" if env.get("LAT_PANEL_FILE") or choices else NO_BINDING),
            env, session_id=env.get("LAT_PANEL_SESSION_ID", ""), choices=choices,
        )

    def read_file(self):
        """Read ``self.path`` into ``self.saved``; return an error text or ``""``."""
        try:
            self.saved = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            self.saved = ""
            return f"問題檔不存在：{self.path}"
        except (OSError, ValueError) as read_error:
            self.saved = ""
            return f"無法讀取問題檔 {self.path}：{read_error}"
        return ""

    def get_driver_class(self):
        """Keep mouse reports in cells: Herdr offers in-band resize, not pixel mouse.

        Textual turns on SGR-pixel mouse once a terminal reports in-band resize
        support and then divides every mouse position by the cell size. Herdr
        keeps reporting cells, so the wheel landed in the top-left corner and
        never reached the body. Without in-band resize Textual stays in cells
        and follows window size changes through SIGWINCH as usual.
        """
        driver = super().get_driver_class()

        class CellMouseDriver(driver):
            def process_message(self, message):
                if not isinstance(message, InBandWindowResize):
                    super().process_message(message)

        return CellMouseDriver

    def compose(self) -> ComposeResult:
        yield Static("", id="picker", markup=False)
        yield Tabs("", id="tabs", markup=False)
        with Body(id="body"):
            yield View("", id="view", markup=False)
        yield Static("", id="input-label", markup=False)
        yield Input("", soft_wrap=True, show_line_numbers=False, id="input")
        yield TextArea(
            self.saved, soft_wrap=True, show_line_numbers=False,
            read_only=self.read_only, id="editor",
        )
        yield Status("", id="status", markup=False)
        yield Static(KEYS, id="keys", markup=False)

    def on_mount(self):
        self.query_one("#body").can_focus = False
        self.query_one("#picker", Static).display = self.picker_active
        self.input.display = False
        self.query_one("#input-label", Static).display = False
        self.editor.display = False
        if self.picker_active:
            self.query_one("#tabs", Static).display = False
            self.query_one("#body").display = False
            self.query_one("#keys", Static).update(PICKER_KEYS)
            self.query_one("#picker", Static).update(self.picker_text())
            self.render_status()
            return
        self.open_file()

    def open_file(self):
        """Show the selector for the loaded file and start polling/notifications."""
        self.query_one("#picker", Static).display = False
        self.query_one("#tabs", Static).display = True
        self.query_one("#body").display = True
        self.query_one("#keys", Static).update(KEYS)
        self.load_selector(self.saved)
        self.call_after_refresh(self.refresh_view)
        if self.read_only:
            return
        self.archive_recorded()
        self.set_interval(self.POLL_INTERVAL, self.check_external)
        if self.notification_pending():
            self.start_notification()

    def fitting_page_size(self):
        """Up to nine rows, fewer when the pane cannot show the title, rows and keys."""
        if not self.size.height:
            return self.PICKER_PAGE_SIZE
        status = self.query_one("#status", Static)
        notices = status.size.height if status.display else 0
        height = self.size.height
        return max(1, min(self.PICKER_PAGE_SIZE, height - 2 - notices))

    @property
    def picker_page(self):
        return self.picker_cursor // self.picker_size

    def picker_row(self, index, number, width):
        """One display line naming a controller.

        When the line is too wide the first pending title gives way first, down to
        eight cells, then the longest of name, folder and tab, down to eight cells each.
        """
        item = self.choices[index]
        names = [
            item.get("hcom_name", ""), Path(item.get("workspace", "")).name,
            item.get("tab_name") or item.get("herdr_tab", ""),
        ]
        titles = self.picker_pending[index]
        marker = "▶" if index == self.picker_cursor else " "

        def row(cells):
            name, folder, tab = (short_title(text, size) for text, size in zip(names, cells))
            parts = [name, folder, f"分頁 {tab}"]
            if item.get("pane_missing"):
                parts.append(PANE_MISSING)
            parts.append(f"待答 {len(titles)} 題：" if titles else "沒有待答")
            return f"{marker} {number} {'｜'.join(parts)}"

        cells = [cell_len(text) for text in names]
        room = width - (8 if titles else 0)
        while cell_len(row(cells)) > room and max(cells) > 8:
            cells[cells.index(max(cells))] -= 1
        line = row(cells)
        if titles and cell_len(line) < width:
            line += short_title(titles[0], width - cell_len(line))
        text = Text(line, "reverse" if marker == "▶" else "")
        text.truncate(width, overflow="ellipsis")
        return text

    def picker_text(self):
        """One controller per line, cut to the pane width; the cursor row is marked."""
        size = self.picker_size = self.fitting_page_size()
        start = self.picker_page * size
        width = max(self.query_one("#picker", Static).size.width or self.size.width - 2, 20)
        title = PICKER_TITLE
        page_count = (len(self.choices) + size - 1) // size
        if page_count > 1:
            title += f"  [{self.picker_page + 1}/{page_count}] ←/→ 換頁"
        text = Text(title)
        text.truncate(width, overflow="ellipsis")
        for index in range(start, min(start + size, len(self.choices))):
            text.append("\n")
            text.append_text(self.picker_row(index, index - start + 1, width))
        return text

    def on_key(self, event: events.Key):
        if not self.picker_active:
            draft = self.current
            if (
                self.focused is None and not self.raw_mode and not self.closing
                and self.typing_target(draft)
                and event.is_printable and event.character
            ):
                event.stop()
                self.type_text(draft, event.character)
            return
        if not event.character or not event.character.isdigit():
            return
        choice_index = int(event.character) - 1
        size = self.picker_size
        absolute_index = self.picker_page * size + choice_index
        if 0 <= choice_index < size and absolute_index < len(self.choices):
            event.stop()
            self.select_choice(self.choices[absolute_index])

    def move_picker(self, cursor):
        """Put the picker cursor on row ``cursor``, clamped to the list."""
        cursor = min(max(cursor, 0), len(self.choices) - 1)
        if cursor != self.picker_cursor:
            self.picker_cursor = cursor
            self.query_one("#picker", Static).update(self.picker_text())

    def turn_picker_page(self, direction):
        size = self.picker_size
        page_count = (len(self.choices) + size - 1) // size
        new_page = min(max(self.picker_page + direction, 0), page_count - 1)
        if new_page != self.picker_page:
            self.move_picker(new_page * size)

    def select_choice(self, binding):
        self.path = Path(binding["questions_path"])
        self.session_id = binding["session_id"]
        error = self.read_file()
        self.picker_active = False
        self.read_only = bool(error)
        self.notices["file"] = error
        self.editor.read_only = self.read_only
        self.open_file()

    @property
    def editor(self):
        return self.query_one("#editor", TextArea)

    @property
    def input(self):
        return self.query_one("#input", TextArea)

    def set_notice(self, kind, message):
        self.notices[kind] = message
        self.render_status()

    def render_status(self):
        message = "\n".join(text for text in self.notices.values() if text)
        status = self.query_one("#status", Static)
        status.update(message)
        status.display = bool(message)

    # Selector state -----------------------------------------------------

    @property
    def tab_ids(self):
        return list(self.drafts)

    @property
    def current(self):
        """The draft on the current tab, or ``None`` on the 送出 tab."""
        ids = self.tab_ids
        return self.drafts[ids[self.tab]] if self.tab < len(ids) else None

    def load_selector(self, text, reset=()):
        """Rebuild tabs from disk text, keeping unchanged questions' local state.

        A question already on a tab stays (✔ once recorded); new 待答 questions
        are appended. A revised question resets with a 題目已更新 notice.
        """
        previous = self.current
        current_id = previous.id if previous else None
        on_review = bool(self.drafts) and previous is None
        self.saved = text
        drafts = {}
        duplicates = []
        for section in lat_panel.parse_questions(text):
            question_id = section["id"]
            if question_id in drafts:
                duplicates.append(question_id)
                continue
            old = self.drafts.get(question_id)
            if old is None and section["status_label"] != "待答":
                continue
            if (
                old is not None
                and question_id not in reset
                and old.revision == section["revision"]
                and old.hash == lat_panel.question_section_sha256(section)
            ):
                drafts[question_id] = old
                continue
            draft = Draft(section)
            if old is not None and old.revision == draft.revision:
                draft.focus = old.focus
                if old.cursor is not None:
                    draft.cursor = min(old.cursor, draft.other_index)
            elif old is not None and (
                question_id == current_id or old.answer() is not None
            ):
                self.revised[question_id] = draft.revision
            drafts[question_id] = draft
        self.drafts = drafts
        self.revised = {
            question_id: revision for question_id, revision in self.revised.items()
            if question_id in drafts and drafts[question_id].editable
        }
        self.render_revised()
        if self.input_target and drafts.get(current_id) is not previous:
            self.close_input()
        ids = self.tab_ids
        if on_review or current_id not in ids:
            self.tab = len(ids) if on_review else min(self.tab, len(ids))
        else:
            self.tab = ids.index(current_id)
        broken = [
            draft.id for draft in drafts.values()
            if draft.status == "broken" and not draft.malformed_submission
        ]
        self.notices["broken"] = (
            f"題目格式錯誤：{'、'.join(broken)} 找不到答覆或送出標記，請按 Ctrl+E 修正"
            if broken else ""
        )
        self.notices["duplicates"] = (
            f"題號重複：{'、'.join(duplicates)}，請按 Ctrl+E 修正" if duplicates else ""
        )
        self.notices["submission"] = submission_error_text(text)
        self.refresh_view()

    def render_revised(self):
        """Keep 題目已更新 visible until the user answers that question again."""
        self.notices["revised"] = "；".join(
            f"題目已更新：{question_id} r{revision}，這題的選擇已重設"
            for question_id, revision in self.revised.items()
        )

    # Rendering ------------------------------------------------------------

    def tab_bar(self):
        labels = [
            f"{draft.marker()} {short_title(draft.title)}" for draft in self.drafts.values()
        ] + ["✔ 送出"]
        width = max(self.query_one("#tabs").size.width or self.size.width - 2, 20)
        first = 0
        while first < self.tab and cell_len("   ".join(labels[first:self.tab + 1])) + 4 > width:
            first += 1
        bar = Text("← ")
        # Cell ranges a click maps to a tab; the arrows step one tab.
        self.tab_spans = [(0, 1, self.tab - 1)]
        for index in range(first, len(labels)):
            if index > first:
                bar.append("   ")
            start = bar.cell_len
            bar.append(labels[index], "reverse" if index == self.tab else "")
            self.tab_spans.append((start, bar.cell_len, index))
        bar.append(" →")
        self.tab_spans.append((bar.cell_len - 1, bar.cell_len, self.tab + 1))
        return bar

    def view_rows(self):
        """Return ``(rows, keys)``; rows are ``(prefix, text, style)``.

        ``keys`` names the focus unit each row belongs to, ``None`` for the
        blank rows between units.
        """
        if self.read_only:
            return [], []
        if not self.drafts:
            return [("", NO_QUESTIONS, "")], [None]
        draft = self.current
        if draft is None:
            return self.review_rows()
        accent = f"bold {self.current_theme.primary}" if self.current_theme else "bold"
        rows = [("", draft.title, "bold")]
        keys = [("text", 0)]
        if draft.status == "submitted":
            rows.append(("", SUBMITTED, accent))
        elif draft.status == "recorded":
            rows.append(("", RECORDED, accent))
        elif draft.status == "broken":
            rows.append(("", "題目格式錯誤：找不到答覆或送出標記。請按 Ctrl+E 修正", "bold"))
        keys += [("text", 0)] * (len(rows) - 1)
        paragraphs = [text for text in re.split(r"\n(?:[ \t]*\n)+", draft.context) if text]
        for number, paragraph in enumerate(paragraphs, 1):
            rows.extend((("", "", ""), ("", paragraph, "")))
            keys.extend((None, ("text", number)))
        rows.append(("", "", ""))
        keys.append(None)
        if draft.kind is not None:
            letters = draft.letters()
            for index, label in enumerate([option.label for option in draft.options] + [OTHER_LABEL]):
                focused = draft.editable and index == draft.cursor
                first = len(rows)
                pointer = "❯ " if focused else "  "
                checked = index in draft.selected
                prefix = f"{pointer}{letters[index]}. " if letters[index] else pointer
                if draft.kind == "multi":
                    prefix += f"[{'x' if checked else ' '}] "
                else:
                    if checked:
                        label += "  ✔"
                rows.append((prefix, label, accent if focused else ""))
                indent = " " * cell_len(prefix)
                if index < len(draft.options) and draft.options[index].impact:
                    rows.append((indent, draft.options[index].impact, "dim"))
                if index == draft.other_index and draft.other and checked:
                    rows.append((indent, draft.other, ""))
                keys += [("option", index)] * (len(rows) - first)
        if draft.recommendation:
            rows.extend((("", "", ""), ("", draft.recommendation, "")))
            keys.extend((None, ("post", "recommendation")))
        if draft.kind is None and not draft.editable and draft.other:
            rows.append(("答覆：", draft.other, ""))
            keys.append(("post", "answer"))
        if draft.unmatched:
            rows.append(("", f"目前答覆無法對應選項：{draft.unmatched}", "dim"))
            keys.append(("post", "unmatched"))
        if draft.note and draft.answer() is not None:
            rows.append(("備註：", draft.note, ""))
            keys.append(("post", "note"))
        return rows, keys

    def review_rows(self):
        rows = [("", "送出前檢查", "bold"), ("", "", "")]
        keys = [("text", 0), None]
        ready = 0
        for number, draft in enumerate(self.drafts.values(), 1):
            rows.append((f"{draft.marker()} ", draft.title, ""))
            if draft.status == "recorded":
                rows.append(("  ", "已記錄", "dim"))
                keys += [("text", number)] * 2
                continue
            text = draft.summary()
            if draft.status == "submitted":
                text += f"（{SUBMITTED}）"
            elif draft.submittable:
                ready += 1
            rows.append(("  ", text, "" if draft.answer() is not None else "dim"))
            keys += [("text", number)] * 2
        rows.append(("", "", ""))
        rows.append((
            "❯ " if ready else "",
            f"Enter 送出 {ready} 題" if ready else "沒有可送出的答覆",
            "bold" if ready else "dim",
        ))
        keys += [None, ("post", "submit")]
        return rows, keys

    @property
    def focus(self):
        """Focus unit key of the current tab."""
        draft = self.current
        return draft.focus if draft else self.review_focus

    @focus.setter
    def focus(self, key):
        draft = self.current
        if draft:
            draft.focus = key
        else:
            self.review_focus = key

    def build_units(self, rows, keys, lines, chars, height):
        """Return focus units ``(key, first_line, last_line)`` in reading order.

        Rows that share a key form one unit. Text taller than half the body,
        and an option taller than the body, is split into parts, so stepping
        through never jumps over unread text.
        """
        units = []
        for row, key in enumerate(keys):
            if key is None:
                continue
            if units and units[-1][0] == key:
                units[-1][2].append(row)
            else:
                units.append((key, lines[row], [row]))
        half = max(height - height // 2, 1)
        parts = []
        for key, first, unit_rows in units:
            # Where each line starts in the unit's text, its rows end to end.
            starts = []
            before = 0
            for row in unit_rows:
                starts += [before + char for char in chars[lines[row]:lines[row + 1]]]
                before += len(rows[row][1]) + 1
            size = height if key[0] == "option" else half
            parts += [
                ((*key, starts[offset]), first + offset, first + min(offset + size, len(starts)))
                for offset in range(0, len(starts), size)
            ]
        return parts

    def focus_index(self):
        """Index in ``self.units`` of the focused unit.

        After rewrapping or a change of height the parts differ: pick the part
        that holds the text the focus started at, so nothing unread is passed.
        """
        kind, name, start = self.focus
        best = 0
        for index, (key, _first, _last) in enumerate(self.units):
            if key[:2] == (kind, name) and key[2] <= start:
                best = index
        return best

    def refresh_view(self):
        if not self.is_mounted:
            return
        self.query_one("#tabs", Static).update(
            self.tab_bar() if self.drafts and not self.read_only else ""
        )
        body = self.query_one("#body")
        rows, keys = self.view_rows()
        view = self.query_one("#view", Static)
        # One column is the focus bar.
        width = max((view.size.width or self.size.width - 3) - 1, 1)
        text, starts, chars = wrap_rows(rows, width)
        height = body.size.height or max(self.size.height - 2, 1)
        self.units = self.build_units(rows, keys, [*starts, len(chars)], chars, height)
        first, last = self.units[self.focus_index()][1:] if self.units else (0, 0)
        accent = self.current_theme.primary if self.current_theme else "bold"
        shown = Text()
        for number, line in enumerate(text.split("\n", allow_blank=True) if rows else []):
            if number:
                shown.append("\n")
            shown.append("▌" if first <= number < last else " ", accent)
            shown.append_text(line)
        view.update(shown)
        draft = self.current
        self.notices["options"] = (
            f"{draft.id}：{draft.reason}，只能輸入文字"
            if draft and draft.editable and draft.kind is None and draft.reason else ""
        )
        self.render_status()
        if self.input_target is None:
            self.show_text_input(draft)
        # A scroll the user made stays until they act or this question changes.
        if self.units and self.kept_scroll != (self.question_key(),):
            self.kept_scroll = None
            self.call_after_refresh(self.scroll_to_focus, first, last)

    def question_key(self):
        """What the current tab shows, apart from its position and wrapping."""
        draft = self.current
        return (draft.id, draft.revision, draft.hash) if draft else None

    def keep_scroll(self):
        """Remember that the user scrolled what the current tab shows."""
        self.kept_scroll = (self.question_key(),)

    def scroll_to_focus(self, first, last):
        """Scroll so the focused lines sit at the middle of the body.

        Near the start or end of the text the body cannot scroll that far, so
        the focus moves on to the real edge. A unit taller than the space
        below the middle is pulled up until it fits, its top staying in view.
        """
        body = self.query_one("#body")
        # Lines count from the view's text; the body scrolls its padding too.
        padding = self.query_one("#view").gutter.top
        height = body.size.height
        top = padding + first
        target = max(top - height // 2, padding + last - height)
        body.scroll_to(y=max(min(target, top), 0), animate=False, immediate=True)

    def show_text_input(self, draft):
        """Show an input-only question's answer box, unfocused, on its tab."""
        shown = bool(
            draft and draft.editable and draft.kind is None
            and not self.raw_mode and not self.read_only
        )
        label = self.query_one("#input-label", Static)
        # Focus only through open_input, so every focused input has a target.
        self.input.can_focus = not shown
        if shown:
            label.update(f"{draft.id} 答覆（Enter 或直接輸入）")
            if self.input.text != draft.other:
                self.input.load_text(draft.other)
        self.input.display = label.display = shown

    def typing_target(self, draft):
        """The input a printable key types into: input-only answer or the 其他 row."""
        if not draft or not draft.editable:
            return None
        if draft.kind is None:
            return "text"
        return "other" if draft.cursor == draft.other_index else None

    def type_text(self, draft, character):
        """Start typing an answer or 其他 text with the key that was pressed."""
        target = self.typing_target(draft)
        self.open_input(target)
        self.input.insert(character)
        self.write_text_change(draft, self.input.text)

    def on_resize(self, _event):
        # Leave room for the tabs, input label, footer, notices and three body lines.
        status = self.query_one("#status", Static)
        notices = status.size.height if status.display else 0
        self.input.styles.max_height = max(3, min(10, self.size.height - 6 - notices))
        if self.picker_active:
            # Redraw once the new layout is in place, not with the old sizes.
            self.call_after_refresh(
                lambda: self.query_one("#picker", Static).update(self.picker_text())
            )
        elif not self.raw_mode:
            self.refresh_view()

    # Selector keys ----------------------------------------------------------

    def selector_draft(self):
        """Return the editable draft for a main-view selector key, else skip it."""
        if self.picker_active or self.raw_mode or self.read_only or self.closing:
            raise SkipAction()
        if self.focused is not None:
            raise SkipAction()
        self.notices["action"] = ""
        self.kept_scroll = None
        return self.current

    def action_move(self, step):
        if self.picker_active and self.focused is None:
            self.move_picker(self.picker_cursor + step)
            return
        self.selector_draft()
        if self.units:
            index = min(max(self.focus_index() + step, 0), len(self.units) - 1)
            self.focus = self.units[index][0]
        self.refresh_view()

    def action_page(self, step):
        """Scroll the question or review text a page; the cursor stays put."""
        if self.picker_active or self.raw_mode or self.focused is not None:
            raise SkipAction()
        body = self.query_one("#body")
        if step < 0:
            body.scroll_page_up(animate=False)
        else:
            body.scroll_page_down(animate=False)
        self.keep_scroll()

    def action_switch_tab(self, step):
        if self.picker_active and self.focused is None:
            self.turn_picker_page(step)
            return
        self.selector_draft()
        self.tab = min(max(self.tab + step, 0), len(self.drafts)) if self.drafts else 0
        self.refresh_view()

    def action_digit(self, digit):
        """Hidden alias kept from before letters: digit N picks row N."""
        self.pick_row(str(digit), lambda draft: digit - 1)

    def action_letter(self, key):
        self.pick_row(key, lambda draft: next(
            (index for index, letter in enumerate(draft.letters()) if letter == key.upper()),
            None,
        ))

    def pick_row(self, character, row_index):
        """Choose the option row ``row_index(draft)`` names, or type ``character``."""
        if self.picker_active:
            raise SkipAction()
        draft = self.selector_draft()
        if self.typing_target(draft):
            self.type_text(draft, character)
            return
        if not draft or not draft.editable:
            self.refresh_view()
            return
        index = row_index(draft)
        if index is not None and index <= draft.other_index:
            draft.cursor = index
            if draft.kind == "multi":
                self.toggle_option(draft, index)
            else:
                self.select_option(draft, index)
        self.refresh_view()

    def action_choose(self):
        if self.picker_active and self.focused is None:
            self.select_choice(self.choices[self.picker_cursor])
            return
        draft = self.selector_draft()
        if draft is None:
            if self.drafts:
                self.submit()
            self.refresh_view()
            return
        if not draft.editable:
            self.refresh_view()
            return
        if draft.kind is None:
            self.open_input("text")
        elif draft.cursor is None:
            pass
        elif draft.kind == "multi":
            self.choose_multi(draft)
        else:
            self.select_option(draft, draft.cursor)
            # Move on once the choice is saved; 其他 stays to take its text.
            if (
                self.current is draft and self.input_target is None
                and draft.selected == [draft.cursor] and not draft.unsaved
            ):
                self.tab += 1
        self.refresh_view()

    def choose_multi(self, draft):
        """Enter or a click on a multi-select option."""
        # 其他 only opens its input; checking it when it has text opens it too.
        if draft.cursor != draft.other_index or (
            draft.other.strip() and draft.cursor not in draft.selected
        ):
            self.toggle_option(draft, draft.cursor)
        else:
            self.open_input("other")

    def action_toggle(self):
        draft = self.selector_draft()
        if self.typing_target(draft):
            self.type_text(draft, " ")
            return
        if draft and draft.kind is not None and draft.cursor is None:
            pass
        elif draft and draft.editable and draft.kind == "multi":
            self.toggle_option(draft, draft.cursor)
        elif draft and draft.editable and draft.kind == "single":
            self.select_option(draft, draft.cursor)
        self.refresh_view()

    def action_note(self):
        draft = self.selector_draft()
        if draft and draft.editable and (draft.kind is None or draft.cursor is not None):
            # Tab on an option chooses it first; 其他 must already be the answer.
            if draft.kind is not None and draft.cursor != draft.other_index:
                if draft.kind == "single":
                    self.select_option(draft, draft.cursor)
                elif draft.cursor not in draft.selected:
                    self.toggle_option(draft, draft.cursor)
                ready = self.current is draft and draft.cursor in draft.selected
            else:
                ready = draft.answer() is not None and (
                    draft.kind is None or draft.other_index in draft.selected
                )
            if ready:
                self.open_input("note")
            elif draft.kind is None:
                self.notices["action"] = "先選擇或輸入答覆，再按 Tab 加備註"
            elif draft.cursor == draft.other_index:
                self.notices["action"] = "先在「其他」輸入內容，再按 Tab 加備註"
        self.refresh_view()

    def click_tab(self, x):
        """Switch to the tab drawn at cell ``x`` of the tab bar."""
        if self.picker_active or self.raw_mode or self.read_only or self.closing:
            return
        for start, end, tab in self.tab_spans:
            if start <= x < end and 0 <= tab <= len(self.drafts):
                if self.focused is not None:
                    self.leave_input()
                self.notices["action"] = ""
                self.kept_scroll = None
                self.tab = tab
                self.refresh_view()
                return

    def click_view(self, line):
        """Focus the unit drawn at view ``line``; an option is chosen as well."""
        if self.picker_active or self.raw_mode or self.read_only or self.closing:
            return
        key = next((key for key, first, last in self.units if first <= line < last), None)
        if key is None:
            return
        if self.focused is not None:
            self.leave_input()
        self.notices["action"] = ""
        self.kept_scroll = None
        self.focus = key
        draft = self.current
        if draft and draft.editable and key[0] == "option":
            if draft.kind == "multi":
                self.choose_multi(draft)
            else:
                self.select_option(draft, draft.cursor)
        self.refresh_view()

    def select_option(self, draft, index):
        """Select one option; 其他 replaces the answer only once text is typed."""
        if index == draft.other_index and not draft.other.strip():
            self.open_input("other")
            return
        draft.selected = [index]
        draft.unmatched = ""
        self.write_draft(draft)
        if index == draft.other_index and self.current is draft:
            self.open_input("other")

    def toggle_option(self, draft, index):
        draft.unmatched = ""
        if index in draft.selected:
            draft.selected.remove(index)
        else:
            draft.selected.append(index)
        self.write_draft(draft)
        if index == draft.other_index and index in draft.selected and self.current is draft:
            self.open_input("other")

    # Inputs ---------------------------------------------------------------

    def open_input(self, target):
        draft = self.current
        self.input_target = target
        self.kept_scroll = None
        label = {"other": OTHER_LABEL, "note": "備註", "text": "答覆"}[target]
        self.query_one("#input-label", Static).update(f"{draft.id} {label}")
        self.query_one("#input-label", Static).display = True
        self.input.load_text(draft.note if target == "note" else draft.other)
        self.input.display = True
        self.input.read_only = False
        self.input.can_focus = True
        self.input.focus()
        self.input.move_cursor(self.input.document.end)
        self.query_one("#keys", Static).update(INPUT_KEYS)

    def close_input(self):
        """Hide the input box without writing."""
        self.input_target = None
        self.kept_scroll = None
        self.input.display = False
        self.query_one("#input-label", Static).display = False
        self.set_focus(None)
        self.query_one("#keys", Static).update(KEYS)

    def leave_input(self):
        draft = self.current
        target = self.input_target
        self.close_input()
        if (
            target == "other" and draft and not draft.other.strip()
            and (draft.other or draft.other_index in draft.selected)
        ):
            # Blank 其他 text is no answer: drop it so later typing starts clean.
            draft.other = ""
            if draft.other_index in draft.selected:
                draft.selected.remove(draft.other_index)
            self.write_draft(draft)
        self.refresh_view()

    def on_text_area_changed(self, event):
        if event.text_area.id == "editor":
            self.save()
            return
        draft = self.current
        if self.input_target is None or draft is None or self.closing:
            return
        self.write_text_change(draft, event.text_area.text)

    def write_text_change(self, draft, value):
        attribute = "note" if self.input_target == "note" else "other"
        if getattr(draft, attribute) == value:
            return
        setattr(draft, attribute, value)
        if self.input_target == "other" and draft.kind == "single":
            if value.strip():
                draft.selected = [draft.other_index]
                draft.unmatched = ""
            elif draft.selected == [draft.other_index]:
                draft.selected = []
        elif self.input_target == "other" and draft.kind == "multi":
            if value.strip() and draft.other_index not in draft.selected:
                draft.selected.append(draft.other_index)
                draft.unmatched = ""
        self.write_draft(draft)
        self.refresh_view()

    # Writes and submit ----------------------------------------------------

    def reload_disk(self, reset=()):
        try:
            text = self.path.read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            self.set_notice("read", f"無法讀取問題檔：{error}")
            return
        self.load_selector(text, reset)

    def write_draft(self, draft):
        """Write one draft; on refusal or failure show disk state, not the edit."""
        try:
            result = lat_panel.write_question_answer(
                self.path, draft.id, draft.revision, draft.hash, draft.answer()
            )
        except lat_panel.AnswerFormatError:
            # Keep the typed text so the user can fix the offending line.
            draft.unsaved = True
            self.notices["save"] = FORGED
            return False
        except (OSError, ValueError) as error:
            self.notices["save"] = f"儲存失敗：{error}"
            self.reload_disk(reset={draft.id})
            return False
        self.notices["save"] = ""
        if result["status"] == "saved":
            draft.hash = result["section_sha256"]
            draft.unsaved = False
            if self.revised.pop(draft.id, None):
                self.render_revised()
            return True
        revision = draft.revision
        self.reload_disk(reset={draft.id})
        updated = self.drafts.get(draft.id)
        if result["status"] == "question_changed" and (
            updated is None or updated.revision == revision
        ):
            self.notices["action"] = f"{draft.id} 已在外部變更，這次的選擇沒有儲存"
        elif result["status"] == "read_only":
            self.notices["action"] = f"{draft.id} 已送出或已記錄，這次的修改沒有儲存"
        return False

    def submit(self):
        expected = {
            draft.id: (draft.revision, draft.hash)
            for draft in self.drafts.values()
            if draft.submittable
        }
        if not expected:
            self.notices["action"] = "沒有可送出的答覆"
            return
        try:
            result = lat_panel.submit_question_answers(self.path, expected)
        except (OSError, ValueError) as error:
            self.notices["save"] = f"送出失敗：{error}"
            self.reload_disk()
            return
        self.notices["save"] = ""
        if result["status"] != "submitted":
            self.reload_disk(reset=set(result["ids"]))
            self.notices["action"] = (
                f"送出前題目已變更：{'、'.join(result['ids'])}。請重新檢查後再送出"
            )
            return
        self.reload_disk()
        try:
            lat_panel.mark_submit_notification_pending(self.path, result)
        except (OSError, ValueError) as error:
            self.unrecorded_notification = True
            self.notices["notify"] = notify_failure_line(f"無法記錄待送通知：{error}")
            return
        self.unrecorded_notification = False
        # Close through the normal path: notify first, stay open if that fails.
        self.close_armed = False
        self.action_close_panel()

    # Raw editor (V1) ------------------------------------------------------

    def action_toggle_raw(self):
        if self.picker_active or self.read_only or self.closing:
            return
        if self.raw_mode:
            if self.conflict:
                self.set_notice("conflict", CONFLICT_SWITCH)
                return
            if not self.save():
                return
            self.raw_mode = False
            self.editor.display = False
            self.query_one("#tabs", Static).display = True
            self.query_one("#body").display = True
            self.query_one("#keys", Static).update(KEYS)
            self.set_focus(None)
            self.reload_disk()
            return
        if self.input_target:
            self.leave_input()
        self.raw_mode = True
        try:
            self.saved = self.path.read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            self.set_notice("read", f"無法讀取問題檔：{error}")
        self.editor.load_text(self.saved)
        self.query_one("#tabs", Static).display = False
        self.query_one("#body").display = False
        self.editor.display = True
        self.editor.focus()
        self.query_one("#keys", Static).update(RAW_KEYS)
        self.notices["options"] = self.notices["action"] = ""
        self.render_status()

    def save(self):
        """Save the raw editor (V1 autosave); return whether nothing is unsaved."""
        if not self.raw_mode:
            return True
        text = self.editor.text
        if self.read_only or self.conflict or text == self.saved:
            return not self.conflict
        if locked_ids(self.saved) - locked_ids(text):
            self.notices["save"] = LOCKED
            self.load(self.saved)
            return True
        try:
            saved = lat_panel.save_panel_edit(self.path, self.saved, text)
        except OSError as error:
            self.set_notice("save", f"儲存失敗：{error}")
            return False
        if not saved:
            self.enter_conflict()
            return False
        newly_submitted = ready_ids(text) - ready_ids(self.saved)
        self.saved = text
        self.close_armed = False
        self.notices["save"] = ""
        self.notices["submission"] = submission_error_text(text)
        self.render_status()
        if newly_submitted:
            self.mark_pending()
        return True

    def enter_conflict(self):
        self.conflict = True
        self.set_notice("conflict", CONFLICT)

    def check_external(self):
        if not self.is_mounted or not self.is_running or self.conflict:
            return
        if self.raw_mode and self.editor.text == self.saved:
            self.archive_recorded()
        try:
            disk = self.path.read_text(encoding="utf-8")
        except (OSError, ValueError) as error:
            self.set_notice("read", f"無法讀取問題檔：{error}")
            return
        if self.notices.get("read"):
            self.set_notice("read", "")
        if disk == self.saved:
            if self.raw_mode and self.editor.text != self.saved:
                self.save()
            elif not self.raw_mode:
                self.archive_recorded()
            return
        if self.raw_mode and self.editor.text != self.saved:
            self.enter_conflict()
            return
        self.load(disk)

    def archive_now(self):
        return datetime.now().astimezone()

    def archive_recorded(self):
        """Archive overdue, unchanged sections without creating a notification."""
        if self.read_only or self.conflict or (
            self.raw_mode and self.editor.text != self.saved
        ):
            return
        try:
            archived = lat_panel.archive_recorded_questions(
                self.path,
                self.ARCHIVE_AFTER,
                expected_text=self.saved,
                now=self.archive_now(),
            )
            if archived:
                self.load(self.path.read_text(encoding="utf-8"))
            self.set_notice("archive", "")
        except (OSError, ValueError) as error:
            self.set_notice("archive", f"歸檔失敗：{error}")

    def load(self, text):
        """Show disk text without saving or notifying; resets raw undo history."""
        if not self.raw_mode:
            self.load_selector(text)
            return
        location = self.editor.cursor_location
        self.saved = text
        self.editor.load_text(text)
        self.editor.move_cursor(location)
        self.notices["submission"] = submission_error_text(text)
        self.render_status()

    def backup_draft(self, text):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=self.path.parent,
            prefix=f"{self.path.stem}-draft-{stamp}-", suffix=".md", delete=False,
        ) as backup:
            backup.write(text)
            backup.flush()
            os.fsync(backup.fileno())

    def action_reload_file(self):
        if self.read_only or not self.raw_mode:
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
        if isinstance(self.focused, TextArea) and not self.focused.read_only:
            self.focused.undo()

    def action_redo_edit(self):
        if isinstance(self.focused, TextArea) and not self.focused.read_only:
            self.focused.redo()

    # Notification (V1) ----------------------------------------------------

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
            self.set_notice("notify", notify_failure_line(f"無法記錄待送通知：{error}"))
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
                    self.set_notice("notify", notify_failure_line(f"無法記錄待送通知：{error}"))
                    return False
                self.unrecorded_notification = False
            try:
                if not await asyncio.to_thread(lat_panel.notification_is_pending, self.path):
                    self.set_notice("notify", "")
                    return True
                binding = await asyncio.to_thread(
                    lat_panel.resolve_session_binding, self.session_id
                )
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

    def action_escape(self):
        if self.focused is self.input:
            self.leave_input()
            return
        self.action_close_panel()

    def action_close_panel(self):
        if self.closing:
            return
        if self.picker_active or self.read_only:
            self.exit()
            return
        if self.conflict:
            self.set_notice("conflict", CONFLICT_CLOSE)
            return
        if not self.save():
            return
        if self.close_armed:
            if self.unrecorded_notification:
                self.mark_pending()
                if self.unrecorded_notification:
                    return
            self.exit()
            return
        if self.notify_timer:
            self.notify_timer.stop()
        self.closing = True
        self.editor.read_only = self.input.read_only = True
        self.run_worker(self.flush_and_close(), group="close")

    async def flush_and_close(self):
        try:
            delivered = await self.send_notification()
            if delivered and self.notification_pending():
                delivered = await self.send_notification()
        finally:
            self.closing = False
        if delivered:
            self.exit()
        else:
            self.editor.read_only = self.input.read_only = False
            self.close_armed = True


def locked_ids(text):
    """``(id, section hash)`` of questions that are submitted or recorded."""
    return {
        (section["id"], lat_panel.question_section_sha256(section))
        for section in lat_panel.parse_questions(text)
        if section["status"] in ("ready", "recorded")
    }


def ready_ids(text):
    """IDs of 待答 questions whose 送出 box is checked."""
    return {
        section["id"] for section in lat_panel.parse_questions(text)
        if section["status"] == "ready"
    }


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
