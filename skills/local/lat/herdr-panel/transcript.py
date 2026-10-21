"""Standalone Claude and Codex transcript readers."""

import json
import os
from pathlib import Path
import re
import sqlite3
import time


TRANSCRIPT_PAGE_TEXTS = 50


_SUMMARY_LIMIT = 80


_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


_INJECTED_INPUT = re.compile(
    r"\s*(<hcom[\s>]|\[lat-watch\]|(read (any|your) unread hcom|you have unread hcom))",
    re.IGNORECASE,
)


_HCOM_DELIVERY = re.compile(r"\s*(<hcom>|\[(?:\d+ )?(?:new message|request|inform|ack)\b[^\]]*\])")


_CLIENT_WRAPPER = re.compile(
    r"\s*(<(local-command-[a-z]+|bash-(input|stdout|stderr)|task-notification|system-reminder)>"
    r"|\[Request interrupted|Caveat: )"
)


_COMMAND_WRAPPER = re.compile(
    r"<command-name>/?([^<]*)</command-name>(?:.*?<command-args>(.*?)</command-args>)?", re.DOTALL
)


def _transcript_root(env, name, default):
    value = env.get(name)
    return Path(value) if value else Path.home() / default


def transcript_path(client, session_id, *, env=None):
    """Find the client's own record of one session, or raise ``FileNotFoundError``.

    Claude keeps ``projects/<project>/<session>.jsonl`` under ``CLAUDE_CONFIG_DIR``
    (default ``~/.claude``); Codex keeps ``sessions/YYYY/MM/DD/rollout-*-<session>.jsonl``
    under ``CODEX_HOME`` (default ``~/.codex``), and moves old ones to
    ``archived_sessions``.
    """
    env = os.environ if env is None else env
    if not _SESSION_ID.fullmatch(session_id or ""):
        raise ValueError(f"not a session ID: {session_id!r}")
    if client == "claude":
        root = _transcript_root(env, "CLAUDE_CONFIG_DIR", ".claude")
        found = sorted(root.glob(f"projects/*/{session_id}.jsonl"))
        label = "Claude 的 session 紀錄檔"
    elif client == "codex":
        root = _transcript_root(env, "CODEX_HOME", ".codex")
        found = sorted(root.glob(f"sessions/*/*/*/rollout-*-{session_id}.jsonl")) or sorted(
            root.glob(f"archived_sessions/rollout-*-{session_id}.jsonl")
        )
        label = "Codex 的 rollout 紀錄檔"
    else:
        raise ValueError(f"對話紀錄只支援 Claude 與 Codex，這個主控的 client 是 {client}")
    if not found:
        raise FileNotFoundError(f"在 {root} 找不到 session {session_id} 的{label}")
    # A session the client wrote more than once keeps growing in its newest file.
    return max(found, key=lambda path: path.stat().st_mtime)


def _read_records(path):
    """Parse every complete JSON line; return the records and how many lines were unusable.

    A last line without its newline may still be being written, so it is neither
    used nor counted until it is complete.
    """
    records, skipped = [], 0
    lines = path.read_bytes().split(b"\n")
    for line in lines[:-1]:
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except ValueError:
            skipped += 1
            continue
        if isinstance(record, dict):
            records.append(record)
        else:
            skipped += 1
    return records, skipped


class _RecordError(Exception):
    """A record the client would not have written: one of its fields has the wrong type."""


def _text_field(value):
    """A field that must be text when present."""
    if value is None or isinstance(value, str):
        return value
    raise _RecordError(f"expected text, got {type(value).__name__}")


def _one_line(text, limit=_SUMMARY_LIMIT):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


_SAFE_COMMAND = re.compile(r"[A-Za-z0-9 \-_./:=,@+%]+")


_SAFE_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9\-_./:=,@+%]*")


_PROGRAM = re.compile(r"[A-Za-z0-9_./+-]+")


_SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}


def _command_summary(command):
    """What a shell command shows, failing closed so that nothing it writes can show: a one-line
    command of only safe characters in full (at most 80); otherwise its program's name; otherwise
    nothing."""
    text = str(command).strip()
    if "\n" not in text and "\r" not in text and _SAFE_COMMAND.fullmatch(text):
        return _one_line(text)
    words = text.split()
    while words and _SAFE_ASSIGNMENT.fullmatch(words[0]):
        words.pop(0)
    program = os.path.basename(words[0]) if words and _PROGRAM.fullmatch(words[0]) else ""
    return _one_line(f"{program} …") if program else ""


def _codex_command(command):
    """The script of a shell-wrapped Codex command, or its arguments joined with spaces."""
    if isinstance(command, str):
        return command
    argv = [_text_field(part) or "" for part in command]
    if len(argv) >= 3 and os.path.basename(argv[0]) in _SHELLS:
        for position, flag in enumerate(argv[1:-1], start=1):
            if re.fullmatch(r"-[a-z]*c[a-z]*", flag):
                return argv[position + 1]
    return " ".join(argv)


def _shown_path(path, cwd):
    path = str(path).removeprefix("file://")
    if cwd and path.startswith(cwd.rstrip("/") + "/"):
        path = path[len(cwd.rstrip("/")) + 1:]
    return _one_line(path)


def _tool(time, name, label, detail="", error=False):
    return {"kind": "tool", "time": time, "name": name, "label": label,
            "detail": detail, "error": error}


def _injected(time, text):
    """How input a tool typed shows: a bare `<hcom>` only wakes the client and shows nothing
    (the delivery arrives separately); anything else is one notice."""
    return None if text.strip() == "<hcom>" else _notice(time, text)


def _notice(time, text):
    """An HCOM delivery, a LAT watch reminder or a hook's prompt, by what it says; never its content."""
    if text.lstrip().startswith("[lat-watch]"):
        return _tool(time, "lat-watch", "收到 lat-watch 提醒")
    if _HCOM_DELIVERY.match(text) or _INJECTED_INPUT.match(text):
        return _tool(time, "hcom", "收到 hcom 通知")
    return _tool(time, "hook", "hook 提示")


_CLAUDE_TOOLS = {
    "Bash": ("執行指令", "command", False),
    "Read": ("讀檔", "file_path", True),
    "Write": ("寫檔", "file_path", True),
    "Edit": ("改檔", "file_path", True),
    "MultiEdit": ("改檔", "file_path", True),
    "NotebookEdit": ("改檔", "notebook_path", True),
    "Grep": ("搜尋", "pattern", False),
    "Glob": ("找檔", "pattern", False),
    "WebSearch": ("搜尋網頁", "query", False),
    "WebFetch": ("讀網頁", "url", False),
    "Skill": ("使用技能", "skill", False),
    "Agent": ("召喚子 Agent", "description", False),
    "Task": ("召喚子 Agent", "description", False),
}


def _claude_tool(block, time, cwd):
    name = _text_field(block.get("name")) or "工具"
    known = _CLAUDE_TOOLS.get(name)
    arguments = block.get("input") if isinstance(block.get("input"), dict) else {}
    if not known or not isinstance(arguments.get(known[1]), str):
        return _tool(time, name, name)
    label, key, is_path = known
    value = arguments[key]
    if name == "Bash":
        detail = _command_summary(value)
    elif name == "WebFetch":
        # The query string may carry a token.
        detail = _one_line(value.split("?", 1)[0].split("#", 1)[0])
    elif is_path:
        detail = _shown_path(value, cwd)
    else:
        detail = _one_line(value)
    return _tool(time, name, label, detail)


def _claude_user_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"] for block in content
            if isinstance(block, dict) and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        )
    return ""


def _claude_human_text(record, text):
    """What a person typed, or None for input the client or a tool put there."""
    if record.get("isMeta") or record.get("isCompactSummary") or record.get("isVisibleInTranscriptOnly"):
        return None
    origin = record.get("origin")
    if origin is not None and not isinstance(origin, dict):
        raise _RecordError("origin is not an object")
    if origin is not None:
        human = origin.get("kind") == "human"
    else:
        # Decided per record, since a resumed session can mix client versions: without an origin
        # only the client's own wrappers are not typed text. A built-in command such as `/copy`
        # then shows, which is still something the person typed.
        human = not _CLIENT_WRAPPER.match(text)
    if not human or _INJECTED_INPUT.match(text):
        return None
    wrapped = _COMMAND_WRAPPER.search(text)
    if wrapped:
        # A slash command the person typed, such as `/lat 繼續`.
        command = "/" + wrapped.group(1).strip().lstrip("/")
        arguments = (wrapped.group(2) or "").strip()
        return f"{command} {arguments}" if arguments else command
    return text


def _each_record(records, handle):
    """Turn records into items with ``handle(record, items)``; return the items and how many records
    were dropped. A record whose fields have unexpected types is dropped whole, keeping the rest."""
    items, dropped = [], 0
    for record in records:
        kept = len(items)
        try:
            handle(record, items)
        except (_RecordError, TypeError, AttributeError, KeyError, ValueError):
            del items[kept:]
            dropped += 1
    return items, dropped


def _claude_items(records):
    tools, seen = {}, set()

    def handle(record, items):
        record_id = _text_field(record.get("uuid"))
        if record_id in seen or record.get("isSidechain"):
            return
        if record_id:
            seen.add(record_id)
        time, kind = _text_field(record.get("timestamp")), record.get("type")
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        content = message.get("content")
        if kind == "assistant" and message.get("model") != "<synthetic>" and isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and (_text_field(block.get("text")) or "").strip():
                    items.append({"kind": "assistant", "time": time, "text": block["text"]})
                elif block.get("type") == "tool_use":
                    item = _claude_tool(block, time, _text_field(record.get("cwd")))
                    tools[_text_field(block.get("id"))] = item
                    items.append(item)
        elif kind == "user":
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result" and block.get("is_error"):
                        if _text_field(block.get("tool_use_id")) in tools:
                            tools[block["tool_use_id"]]["error"] = True
            text = _claude_user_text(content)
            if not text.strip():
                return
            if text.startswith("Stop hook feedback"):
                items.append(_tool(time, "hook", "hook 提示"))
                return
            human = _claude_human_text(record, text)
            if human is not None:
                items.append({"kind": "user", "time": time, "text": human})
            elif _INJECTED_INPUT.match(text) and (notice := _injected(time, text)):
                items.append(notice)
        elif kind == "attachment" and isinstance(record.get("attachment"), dict):
            attachment = record["attachment"]
            attached = attachment.get("type")
            if attached == "queued_command":
                # Typed while the client was busy; recorded only here.
                text = _claude_user_text(attachment.get("prompt"))
                origin = attachment.get("origin")
                human = isinstance(origin, dict) and origin.get("kind") == "human"
                if attachment.get("commandMode") != "prompt" or not human or not text.strip():
                    return
                if not _INJECTED_INPUT.match(text):
                    items.append({"kind": "user", "time": time, "text": text})
                elif notice := _injected(time, text):
                    items.append(notice)
            elif attached in ("hook_additional_context", "hook_system_message"):
                value = attachment.get("content")
                text = "\n".join(map(str, value)) if isinstance(value, list) else str(value or "")
                items.append(_notice(time, text))

    return _each_record(records, handle)


def _codex_text(content):
    if not isinstance(content, list):
        return ""
    return "".join(
        _text_field(part.get("text")) or "" for part in content if isinstance(part, dict)
    )


def _codex_item(item, time, cwd):
    kind = item.get("type")
    if kind == "UserMessage":
        text = _codex_text(item.get("content"))
        if not text.strip():
            return None
        if _INJECTED_INPUT.match(text):
            return _injected(time, text)
        return {"kind": "user", "time": time, "text": text}
    if kind == "AgentMessage":
        text = _codex_text(item.get("content"))
        return {"kind": "assistant", "time": time, "text": text} if text.strip() else None
    failed = item.get("status") in ("failed", "declined")
    if kind == "CommandExecution":
        command = item.get("command")
        command = _codex_command(command) if isinstance(command, (str, list)) else _text_field(command)
        error = failed or item.get("exit_code") not in (0, None)
        return _tool(time, "exec", "執行指令", _command_summary(command or ""), error)
    if kind == "FileChange":
        changes = item.get("changes") if isinstance(item.get("changes"), dict) else {}
        paths = [_shown_path(path, cwd) for path in changes]
        detail = paths[0] if len(paths) == 1 else (f"{paths[0]} 等 {len(paths)} 個檔案" if paths else "")
        return _tool(time, "apply_patch", "改檔", detail, failed)
    if kind == "ImageView" and isinstance(item.get("path"), str):
        return _tool(time, "view_image", "看圖", _shown_path(item["path"], cwd))
    if kind == "McpToolCall":
        name = f"{_text_field(item.get('server'))}.{_text_field(item.get('tool'))}"
        return _tool(time, "mcp", "MCP 工具", _one_line(name), failed)
    if kind == "HookPrompt":
        return _tool(time, "hook", "hook 提示")
    if kind in ("Reasoning", "SubAgentActivity", None):
        return None
    kind = _text_field(kind)
    return _tool(time, kind, kind, "", failed)


class _SubAgentThread(Exception):
    """The rollout is a sub-agent's own thread, not a conversation with the person."""


def _codex_items(records):
    cwd = None

    def handle(record, items):
        nonlocal cwd
        payload = record.get("payload") if isinstance(record.get("payload"), dict) else {}
        time = _text_field(record.get("timestamp"))
        if record.get("type") == "session_meta":
            if isinstance(payload.get("source"), dict) and "subagent" in payload["source"]:
                raise _SubAgentThread
            cwd = _text_field(payload.get("cwd"))
        elif record.get("type") == "event_msg" and payload.get("type") == "item_completed":
            item = payload.get("item")
            entry = _codex_item(item, time, cwd) if isinstance(item, dict) else None
            if entry:
                items.append(entry)
        elif (
            record.get("type") == "response_item" and payload.get("type") == "message"
            and payload.get("role") == "developer"
        ):
            if _codex_text(payload.get("content")).lstrip().startswith("<hcom>"):
                items.append(_tool(time, "hcom", "收到 hcom 通知"))

    try:
        return _each_record(records, handle)
    except _SubAgentThread:
        return [], 0


def _claude_current(records):
    """The last reply's model and effort; its turn starts at the prompt before it."""
    current, prompt_time = None, None
    for record in records:
        if record.get("isSidechain"):
            continue
        time = record.get("timestamp") if isinstance(record.get("timestamp"), str) else None
        message = record.get("message") if isinstance(record.get("message"), dict) else {}
        if record.get("type") == "user":
            content = message.get("content")
            is_result = isinstance(content, list) and any(
                isinstance(block, dict) and block.get("type") == "tool_result" for block in content
            )
            if not is_result:
                prompt_time = time
        elif record.get("type") == "assistant":
            model = message.get("model")
            if not isinstance(model, str) or not model or model == "<synthetic>":
                continue
            effort = record.get("effort")
            current = {"model": model, "effort": effort if isinstance(effort, str) else None,
                       "time": prompt_time or time}
    return current


def _codex_current(records):
    """The last turn context's model and effort; the turn starts when it was written."""
    current = None
    for record in records:
        payload = record.get("payload")
        if record.get("type") != "turn_context" or not isinstance(payload, dict):
            continue
        model, effort = payload.get("model"), payload.get("effort")
        if not isinstance(model, str) or not model:
            continue
        time = record.get("timestamp")
        current = {"model": model, "effort": effort if isinstance(effort, str) else None,
                   "time": time if isinstance(time, str) else None}
    return current


def _amount(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _codex_usage(records):
    """Context use, quota and prompt cache from the last ``token_count`` events: the context is
    the last request's input over the model's window, the cache hit its cached share of that
    input, and each quota window is named by its length. None when there is nothing to show."""
    info, limits = None, None
    for record in records:
        payload = record.get("payload")
        if record.get("type") != "event_msg" or not isinstance(payload, dict):
            continue
        if payload.get("type") != "token_count":
            continue
        if isinstance(payload.get("info"), dict):
            info = payload["info"]
        # Other limits, such as ``premium``, come with their own events and are not the plan's quota.
        given = payload.get("rate_limits")
        if isinstance(given, dict) and given.get("limit_id") in (None, "codex"):
            limits = given
    usage = {"context": None, "limits": [], "cache": None}
    last = info.get("last_token_usage") if info else None
    if isinstance(last, dict):
        given, cached = _amount(last.get("input_tokens")), _amount(last.get("cached_input_tokens"))
        window = _amount(info.get("model_context_window"))
        if given is not None and window:
            usage["context"] = given / window * 100
        if given and cached is not None:
            # Codex does not tell when its cache expires.
            usage["cache"] = {"warm": True, "hit": cached / given, "expires": None}
    for name in ("primary", "secondary"):
        limit = limits.get(name) if limits else None
        if not isinstance(limit, dict):
            continue
        minutes, used = _amount(limit.get("window_minutes")), _amount(limit.get("used_percent"))
        if minutes and used is not None:
            usage["limits"].append({"minutes": minutes, "used": used})
    return usage if usage["context"] is not None or usage["limits"] or usage["cache"] else None


def _claude_permission(records):
    """The permission mode of the last prompt, which Claude writes on each one: a mode changed
    since shows from the next prompt on."""
    permission = None
    for record in records:
        if record.get("isSidechain") or record.get("type") != "user":
            continue
        mode = record.get("permissionMode")
        if isinstance(mode, str) and mode:
            permission = {"mode": mode}
    return permission


def _codex_permission(records):
    """The last turn context's approval policy and sandbox type (None when it has none)."""
    permission = None
    for record in records:
        payload = record.get("payload")
        if record.get("type") != "turn_context" or not isinstance(payload, dict):
            continue
        approval, sandbox = payload.get("approval_policy"), payload.get("sandbox_policy")
        if isinstance(sandbox, dict):
            sandbox = sandbox.get("type")
        if not isinstance(approval, str) or not approval:
            continue
        permission = {"approval": approval,
                      "sandbox": sandbox if isinstance(sandbox, str) and sandbox else None}
    return permission


def current_settings(client, records):
    """The model and effort the latest turn ran with, and when that turn started; None when
    the record has no turn yet. A record with a field of the wrong type is passed over."""
    return _claude_current(records) if client == "claude" else _codex_current(records)


def board_transcript(client, session_id, *, before=None, limit=TRANSCRIPT_PAGE_TEXTS, env=None):
    """One page of a session's conversation, read from the client's own record.

    Items are the person's messages (``user``), the controller's text replies
    (``assistant``) and one line per operation in between (``tool``), oldest
    first; each has ``seq``, its position in the whole conversation. A page holds
    the last ``limit`` text items before ``before`` (the end when None) and every
    operation after the first of them, so pages never overlap or leave a gap.
    ``before`` in the result is the cursor for the page just earlier, or None
    when this one starts the conversation. ``skipped`` counts unusable lines:
    ones that are not JSON objects, and records whose fields have the wrong types.
    ``current`` is ``current_settings`` of the whole record, whatever the page.
    ``usage`` is a Codex record's context use, quota and prompt cache
    (``_codex_usage``); None for Claude, whose record does not hold them.
    ``permission`` is the latest turn's permission mode: ``{"mode"}`` for Claude,
    ``{"approval", "sandbox"}`` for Codex; None when the record has none.
    """
    path = transcript_path(client, session_id, env=env)
    records, skipped = _read_records(path)
    items, dropped = _claude_items(records) if client == "claude" else _codex_items(records)
    skipped += dropped
    for seq, item in enumerate(items):
        item["seq"] = seq
    end = len(items) if before is None else max(0, min(before, len(items)))
    texts = [item["seq"] for item in items[:end] if item["kind"] != "tool"]
    start = texts[-limit] if len(texts) > limit else 0
    return {
        "status": "ok",
        "path": str(path),
        "items": items[start:end],
        "before": start or None,
        "skipped": skipped,
        "current": current_settings(client, records),
        "usage": _codex_usage(records) if client == "codex" else None,
        "permission": _claude_permission(records) if client == "claude" else _codex_permission(records),
    }


def _unknown_args(reason):
    return {"status": "unknown", "reason": reason}


def board_launch_args(session_id, *, env=None):
    """The arguments hcom stored for the launch of the agent with this session ID.

    hcom 0.7.29 keeps them as a JSON list in the ``launch_args`` column of its
    ``instances`` table, in ``hcom.db`` under ``HCOM_DIR`` (default ``~/.hcom``).
    That is hcom's internal data, so it is opened read-only, and anything not in
    that shape is reported as unknown rather than guessed at.
    """
    env = os.environ if env is None else env
    root = Path(env["HCOM_DIR"]) if env.get("HCOM_DIR") else Path.home() / ".hcom"
    path = root / "hcom.db"
    if not path.is_file():
        return _unknown_args(f"找不到 hcom 的資料庫 {path}")
    try:
        connection = sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
        try:
            row = connection.execute(
                "select launch_args from instances where session_id = ?", (session_id,)
            ).fetchone()
        finally:
            connection.close()
    except sqlite3.Error as error:
        return _unknown_args(f"hcom 的資料庫讀不出來：{error}")
    if row is None:
        return _unknown_args(f"hcom 沒有 session {session_id} 的 Agent")
    value = row[0]
    if value in (None, ""):
        return {"status": "ok", "args": []}
    try:
        args = json.loads(value) if isinstance(value, str) else None
    except ValueError:
        args = None
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        return _unknown_args("hcom 記下的啟動參數不是預期的格式")
    return {"status": "ok", "args": args}
