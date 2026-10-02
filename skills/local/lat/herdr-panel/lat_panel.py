#!/usr/bin/env python3
"""Stdlib core and controller CLI for the LAT question panel.

Public API used by the Textual panel and LAT controller:

* ``locked_replace`` performs a conditional atomic UTF-8 replacement. Pass a
  journal path for a panel save, or call ``save_panel_edit`` to use
  ``<questions parent>/panel-journal.jsonl``.
* ``parse_questions``, ``upsert_question``, and ``set_question_status`` model
  and update natural-language question sections without touching other sections.
* ``question_provenance`` checks one snapshot section against the latest panel
  journal entry that changed that question.
* ``bind_controller``, ``unbind_controller``, and ``resolve_binding`` manage
  exact per-Herdr-workspace routing.
* ``mark_notification_pending``, ``notification_is_pending``,
  ``send_pending_notification``, and ``clear_pending_notification`` provide the
  persisted notification lifecycle. ``send_pending_notification`` returns an
  ``(ok, reason)`` pair and clears state only after target delivery.

Controller CLI (run from the project root unless ``--questions`` is supplied)::

  question upsert --id ID --file section.md
  question section-hash --id ID
  question provenance --id ID --journal panel-journal.jsonl
  question set-status --id ID --revision N --status recorded \
      --expected-section-sha256 HASH
  question archive-recorded --older-than 300
  bind --hcom-name NAME --client CLIENT --session-id ID --workspace ROOT \
       [--herdr-workspace ID]
  unbind --session-id ID
  resolve [--herdr-workspace ID]

All commands are prefixed with ``uv run --no-project python lat_panel.py``.
Binding data uses ``HERDR_PLUGIN_CONFIG_DIR``, then
``herdr plugin config-dir lat.panel``, then the XDG config fallback. Pending
state uses ``HERDR_PLUGIN_STATE_DIR`` or the XDG state fallback.
"""

from contextlib import contextmanager
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import uuid


@contextmanager
def _path_lock(path):
    lock_path = path.with_name(f".{path.name}.lock")
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a", encoding="utf-8") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _replace_locked(path, text):
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent, delete=False
        ) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), mode)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def _question_changes(before, after):
    before_by_id = {item["id"]: item for item in _sections(before)}
    after_by_id = {item["id"]: item for item in _sections(after)}
    changes = []
    for question_id in sorted(before_by_id.keys() | after_by_id.keys()):
        old = before_by_id.get(question_id)
        new = after_by_id.get(question_id)
        if old is None or new is None or old["raw"] != new["raw"]:
            change = {
                "id": question_id,
                "before_status": old["status"] if old else None,
                "after_status": new["status"] if new else None,
            }
            if new is not None:
                change["section_sha256"] = _section_sha256(new)
            changes.append(change)
    return changes


def _iso_time(now=None):
    value = datetime.now().astimezone() if now is None else now
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("time must include a UTC offset")
    return value.isoformat(timespec="seconds")


def _append_journal(journal_path, before, after, *, kind=None, details=None, now=None):
    journal_path = Path(journal_path)
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "time": (
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            if now is None else now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        ),
        "before_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
        "after_sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
        "changed_questions": _question_changes(before, after),
    }
    if kind is not None:
        entry["kind"] = kind
    if details:
        entry.update(details)
    with journal_path.open("a", encoding="utf-8") as journal:
        journal.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        journal.flush()
        os.fsync(journal.fileno())


def locked_replace(path, expected_text, new_text, *, journal_path=None):
    """Return true after an atomic replacement, or false on content conflict."""
    path = Path(path)
    with _path_lock(path):
        try:
            current = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            current = ""
        if current != expected_text:
            return False
        _replace_locked(path, new_text)
        if journal_path is not None:
            _append_journal(journal_path, expected_text, new_text)
        return True


def save_panel_edit(questions_path, expected_text, new_text):
    """Save panel text conditionally and append the standard panel journal."""
    questions_path = Path(questions_path)
    return locked_replace(
        questions_path,
        expected_text,
        new_text,
        journal_path=questions_path.parent / "panel-journal.jsonl",
    )


_SECTION_HEADER = re.compile(
    r"^## (?P<title>[^\r\n]+)\r?\n"
    r"(?P<id>[A-Za-z0-9][A-Za-z0-9._-]*) · r(?P<revision>[1-9][0-9]*) · "
    r"(?P<status_label>待答|已記錄)"
    r"(?: · (?P<recorded_at>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d))?[ \t]*$",
    re.MULTILINE,
)
_ARCHIVE_HEADER = re.compile(
    r"^### 舊版 r[1-9][0-9]*（不套用至 r[1-9][0-9]*）$", re.MULTILINE
)
_ANSWER_MARKER = re.compile(r"^答覆：[ \t]*$", re.MULTILINE)
_SUBMIT_MARKER = re.compile(r"^- \[(?P<checked>[ xX])\] 送出[ \t]*$", re.MULTILINE)


def _archive_match(raw):
    return _ARCHIVE_HEADER.search(raw)


def parse_questions(text):
    """Return parsed question-section dictionaries while preserving raw spans."""
    matches = list(_SECTION_HEADER.finditer(text))
    sections = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        raw = text[match.start():end]
        status_end = match.end() - match.start()
        archive = _archive_match(raw)
        current_raw = raw[:archive.start()] if archive else raw
        answer_marker = _ANSWER_MARKER.search(current_raw, status_end)
        submit_marker = (
            _SUBMIT_MARKER.search(current_raw, answer_marker.end())
            if answer_marker
            else None
        )
        body = None
        answer = None
        answer_block = ""
        checked = False
        if answer_marker and submit_marker and submit_marker.end() <= len(current_raw):
            body = raw[status_end:answer_marker.start()].strip("\n")
            answer = raw[answer_marker.end():submit_marker.start()].strip("\n")
            answer_block = raw[answer_marker.start():submit_marker.end()]
            checked = submit_marker.group("checked").lower() == "x"
        status_label = match.group("status_label")
        status = "recorded" if status_label == "已記錄" else ("ready" if checked else "pending")
        sections.append({
            "id": match.group("id"),
            "title": match.group("title"),
            "revision": int(match.group("revision")),
            "status": status,
            "status_label": status_label,
            "recorded_at": match.group("recorded_at"),
            "start": match.start(),
            "end": end,
            "raw": raw,
            "body": body,
            "answer": answer,
            "answer_block": answer_block,
            "checked": checked,
            "status_start": match.start("status_label") - match.start(),
            "status_end": match.end() - match.start(),
        })
    return sections


_sections = parse_questions


def _section_text(section):
    """Return the current-revision section without inter-section whitespace."""
    marker = _archive_match(section["raw"])
    current = section["raw"][:marker.start()] if marker else section["raw"]
    return current.rstrip("\n") + "\n"


def _section_sha256(section):
    return hashlib.sha256(_section_text(section).encode("utf-8")).hexdigest()


def _question_section(document, question_id):
    matching = [item for item in _sections(document) if item["id"] == question_id]
    if len(matching) > 1:
        raise ValueError(f"duplicate question ID: {question_id}")
    if not matching:
        raise ValueError(f"question not found: {question_id}")
    return matching[0]


def question_provenance(questions_path, journal_path, question_id):
    """Return panel provenance for one question in a questions snapshot."""
    document = Path(questions_path).read_text(encoding="utf-8")
    section = _question_section(document, question_id)
    if section["status"] != "ready":
        raise ValueError(f"question is not submitted: {question_id}")
    section_sha256 = _section_sha256(section)
    latest = None
    try:
        journal_lines = Path(journal_path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        raise ValueError(f"panel journal not found: {journal_path}") from None
    for line_number, line in enumerate(journal_lines, 1):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid panel journal line {line_number}: {error.msg}") from None
        for change in entry.get("changed_questions", []):
            if change.get("id") == question_id:
                latest = (line_number, entry, change)
    if latest is None:
        raise ValueError(f"no panel journal entry touched question: {question_id}")
    line_number, entry, change = latest
    recorded_sha256 = change.get("section_sha256")
    if recorded_sha256 is None:
        raise ValueError(
            f"panel journal line {line_number} has no per-question section hash"
        )
    if recorded_sha256 != section_sha256:
        raise ValueError(
            f"section hash mismatch: snapshot {section_sha256}, "
            f"panel journal line {line_number} {recorded_sha256}"
        )
    return {
        "status": "ok",
        "id": question_id,
        "journal_path": str(Path(journal_path)),
        "journal_line": line_number,
        "time": entry.get("time"),
        "section_sha256": section_sha256,
    }


def _question_input(text):
    match = re.match(r"\A## (?P<title>[^\r\n]+)(?:\r?\n(?P<body>[\s\S]*))?\Z", text)
    if match is None:
        raise ValueError("question file must start with one '## <question title>' heading")
    return {
        "title": match.group("title"),
        "body": (match.group("body") or "").strip("\n"),
    }


def _archive_text(raw):
    marker = _archive_match(raw)
    return raw[marker.start():] if marker else ""


def _render_section(question_id, revision, title, body, answer_block=None, archives=""):
    lines = [f"## {title}", f"{question_id} · r{revision} · 待答"]
    if body:
        lines.extend(("", body))
    lines.extend(("", answer_block or "答覆：\n\n- [ ] 送出"))
    if archives:
        lines.extend(("", archives))
    return "\n".join(lines) + "\n"


def upsert_question(questions_path, question_id, section_text):
    """Add or update one question under the shared lock; return its revision."""
    questions_path = Path(questions_path)
    incoming = _question_input(section_text)
    with _path_lock(questions_path):
        try:
            document = questions_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            document = ""
        matching = [item for item in _sections(document) if item["id"] == question_id]
        if len(matching) > 1:
            raise ValueError(f"duplicate question ID: {question_id}")
        existing = matching[0] if matching else None
        if existing is None:
            revision = 1
            replacement = _render_section(
                question_id, revision, incoming["title"], incoming["body"]
            )
            separator = "" if not document or document.endswith("\n\n") else "\n"
            updated = document + separator + replacement
        else:
            if existing["body"] is None:
                raise ValueError("existing section is missing answer or submit marker")
            content_changed = (
                existing["title"] != incoming["title"]
                or existing["body"] != incoming["body"]
            )
            if content_changed:
                revision = existing["revision"] + 1
                prior = (
                    f"### 舊版 r{existing['revision']}（不套用至 r{revision}）\n"
                    f"{existing['answer_block'].rstrip()}"
                )
                older = _archive_text(existing["raw"])
                archives = prior + (f"\n\n{older}" if older else "")
            else:
                revision = existing["revision"]
            if content_changed:
                replacement = _render_section(
                    question_id,
                    revision,
                    incoming["title"],
                    incoming["body"],
                    archives=archives,
                )
                updated = (
                    document[:existing["start"]]
                    + replacement
                    + document[existing["end"]:]
                )
            else:
                return revision
        _replace_locked(questions_path, updated)
        return revision


def set_question_status(
    questions_path, question_id, revision, status, expected_section_sha256, *, now=None
):
    """Set status only when the revision and current section hash both match."""
    if status != "recorded":
        raise ValueError("the controller may only set status to recorded")
    questions_path = Path(questions_path)
    with _path_lock(questions_path):
        document = questions_path.read_text(encoding="utf-8")
        existing = _question_section(document, question_id)
        if existing["revision"] != revision:
            raise ValueError(
                f"revision mismatch: expected r{revision}, found r{existing['revision']}"
            )
        actual_section_sha256 = _section_sha256(existing)
        if actual_section_sha256 != expected_section_sha256:
            raise ValueError(
                f"section hash mismatch: expected {expected_section_sha256}, "
                f"found {actual_section_sha256}"
            )
        recorded_at = _iso_time(now)
        status_start = existing["start"] + existing["status_start"]
        status_end = existing["start"] + existing["status_end"]
        updated = (
            document[:status_start]
            + f"已記錄 · {recorded_at}"
            + document[status_end:]
        )
        _replace_locked(questions_path, updated)
        recorded_section = _question_section(updated, question_id)
        _append_journal(
            questions_path.parent / "panel-journal.jsonl",
            document,
            updated,
            kind="set-status",
            details={
                "recorded_question": question_id,
                "recorded_revision": revision,
                "recorded_at": recorded_at,
                "recorded_section_sha256": _section_sha256(recorded_section),
            },
            now=now,
        )


def _recorded_hashes(journal_path):
    hashes = {}
    try:
        lines = Path(journal_path).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return hashes
    for line_number, line in enumerate(lines, 1):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid panel journal line {line_number}: {error.msg}") from None
        if entry.get("kind") == "set-status" and entry.get("recorded_question"):
            hashes[entry["recorded_question"]] = entry.get("recorded_section_sha256")
    return hashes


def _archive_path(questions_path):
    questions_path = Path(questions_path)
    return questions_path.with_name(f"{questions_path.stem}-archive{questions_path.suffix}")


def _append_archive(path, sections):
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = path.read_text(encoding="utf-8") if path.exists() else ""
    additions = [section for section in sections if section not in existing]
    if not additions:
        return
    separator = "" if not existing or existing.endswith("\n\n") else "\n"
    with path.open("a", encoding="utf-8") as archive:
        archive.write(separator + "".join(additions))
        archive.flush()
        os.fsync(archive.fileno())


def archive_recorded_questions(
    questions_path, older_than, *, expected_text=None, now=None
):
    """Move unchanged recorded sections older than ``older_than`` seconds.

    Returns archived question IDs. If ``expected_text`` no longer matches the
    file, returns ``None`` without changing either file.
    """
    questions_path = Path(questions_path)
    current_time = datetime.now().astimezone() if now is None else now
    if current_time.tzinfo is None or current_time.utcoffset() is None:
        raise ValueError("time must include a UTC offset")
    journal_path = questions_path.parent / "panel-journal.jsonl"
    archive_path = _archive_path(questions_path)
    with _path_lock(questions_path):
        document = questions_path.read_text(encoding="utf-8")
        if expected_text is not None and document != expected_text:
            return None
        recorded_hashes = _recorded_hashes(journal_path)
        eligible = []
        for section in _sections(document):
            if section["status"] != "recorded" or not section["recorded_at"]:
                continue
            recorded_at = datetime.fromisoformat(section["recorded_at"])
            if (current_time - recorded_at).total_seconds() <= older_than:
                continue
            if recorded_hashes.get(section["id"]) != _section_sha256(section):
                continue
            eligible.append(section)
        if not eligible:
            return []
        archived_ids = [section["id"] for section in eligible]
        archived_raw = [section["raw"] for section in eligible]
        kept = []
        cursor = 0
        for section in eligible:
            kept.append(document[cursor:section["start"]])
            cursor = section["end"]
        kept.append(document[cursor:])
        updated = "".join(kept)
        _append_archive(archive_path, archived_raw)
        _replace_locked(questions_path, updated)
        _append_journal(
            journal_path,
            document,
            updated,
            kind="archive-recorded",
            details={
                "archived_questions": archived_ids,
                "archive_path": str(archive_path),
            },
            now=now,
        )
        return archived_ids


def plugin_directory(kind, env=None):
    """Resolve the plugin config or state directory without contacting Herdr's server."""
    env = os.environ if env is None else env
    variable = f"HERDR_PLUGIN_{kind.upper()}_DIR"
    if env.get(variable):
        return Path(env[variable]).expanduser()
    if kind == "config":
        try:
            result = subprocess.run(
                ["herdr", "plugin", "config-dir", "lat.panel"],
                text=True, capture_output=True, timeout=10, check=True, env=env,
            )
            if result.stdout.strip():
                return Path(result.stdout.strip()).expanduser()
        except (FileNotFoundError, subprocess.SubprocessError):
            pass
        base = Path(env.get("XDG_CONFIG_HOME", Path.home() / ".config"))
        return base / "herdr/plugins/config/lat.panel"
    base = Path(env.get("XDG_STATE_HOME", Path.home() / ".local/state"))
    return base / "herdr/plugins/lat.panel"


def _bindings_path(config_dir=None):
    directory = Path(config_dir) if config_dir else plugin_directory("config")
    return directory / "bindings.json"


def _read_bindings(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(payload, dict) or not isinstance(payload.get("bindings", {}), dict):
        raise ValueError("invalid bindings file")
    return payload.get("bindings", {})


def _write_bindings(path, bindings):
    path.parent.mkdir(parents=True, exist_ok=True)
    _replace_locked(path, json.dumps({"bindings": bindings}, ensure_ascii=False, indent=2) + "\n")


def bind_controller(hcom_name, client, session_id, workspace, herdr_workspace, *, config_dir=None):
    """Bind one Herdr workspace and return ``(binding, replaced_binding)``."""
    if not herdr_workspace:
        raise ValueError("Herdr workspace ID is required")
    workspace = Path(workspace).expanduser().resolve()
    binding = {
        "hcom_name": hcom_name,
        "client": client,
        "session_id": session_id,
        "workspace": str(workspace),
        "questions_path": str(workspace / ".lat/questions.md"),
        "herdr_workspace": herdr_workspace,
    }
    path = _bindings_path(config_dir)
    with _path_lock(path):
        bindings = _read_bindings(path)
        replaced = bindings.get(herdr_workspace)
        bindings[herdr_workspace] = binding
        _write_bindings(path, bindings)
    return binding, replaced


def unbind_controller(session_id, *, config_dir=None):
    """Remove only bindings owned by ``session_id`` and return their count."""
    path = _bindings_path(config_dir)
    with _path_lock(path):
        bindings = _read_bindings(path)
        kept = {
            workspace_id: binding for workspace_id, binding in bindings.items()
            if binding.get("session_id") != session_id
        }
        if kept != bindings:
            _write_bindings(path, kept)
        return len(bindings) - len(kept)


def resolve_binding(herdr_workspace=None, *, config_dir=None):
    """Resolve only the exact Herdr workspace binding."""
    path = _bindings_path(config_dir)
    with _path_lock(path):
        bindings = _read_bindings(path)
    if herdr_workspace and herdr_workspace in bindings:
        return bindings[herdr_workspace]
    raise ValueError("no LAT controller is bound to this Herdr workspace")


def _notification_path(state_dir=None):
    directory = Path(state_dir) if state_dir else plugin_directory("state")
    return directory / "pending-notifications.json"


def _question_key(questions_path):
    return str(Path(questions_path).expanduser().resolve())


def _read_pending(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(payload, dict) or not isinstance(payload.get("pending", {}), dict):
        raise ValueError("invalid pending notification file")
    return payload.get("pending", {})


def _write_pending(path, pending):
    path.parent.mkdir(parents=True, exist_ok=True)
    _replace_locked(path, json.dumps({"pending": pending}, ensure_ascii=False, indent=2) + "\n")


def mark_notification_pending(questions_path, *, state_dir=None):
    """Persist a pending notification keyed by the absolute questions path."""
    path = _notification_path(state_dir)
    key = _question_key(questions_path)
    with _path_lock(path):
        pending = _read_pending(path)
        generation = uuid.uuid4().hex
        pending[key] = {
            "questions_path": key,
            "marked_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "generation": generation,
        }
        _write_pending(path, pending)
    return generation


def notification_is_pending(questions_path, *, state_dir=None):
    """Return whether the questions path has a persisted pending notification."""
    path = _notification_path(state_dir)
    with _path_lock(path):
        return _question_key(questions_path) in _read_pending(path)


_UNCONDITIONAL_CLEAR = object()


def clear_pending_notification(
    questions_path, *, state_dir=None, expected_generation=_UNCONDITIONAL_CLEAR
):
    """Clear one pending notification, leaving other projects untouched."""
    path = _notification_path(state_dir)
    key = _question_key(questions_path)
    with _path_lock(path):
        pending = _read_pending(path)
        current = pending.get(key)
        generation_matches = (
            expected_generation is _UNCONDITIONAL_CLEAR
            or current and current.get("generation") == expected_generation
        )
        if current and generation_matches:
            del pending[key]
            _write_pending(path, pending)
            return True
        return False


def _delivered_targets(payload):
    targets = []
    if isinstance(payload, dict):
        delivered = payload.get("delivered_to")
        if isinstance(delivered, str):
            targets.append(delivered)
        elif isinstance(delivered, list):
            targets.extend(item for item in delivered if isinstance(item, str))
        for value in payload.values():
            targets.extend(_delivered_targets(value))
    elif isinstance(payload, list):
        for value in payload:
            targets.extend(_delivered_targets(value))
    return targets


def _hcom_receipt_names(target):
    """Return the full HCOM name and its receipt-level unique base name."""
    target = target.removeprefix("@")
    return {target, target.rsplit("-", 1)[-1]}


def send_pending_notification(questions_path, binding, *, state_dir=None, env=None, timeout=10):
    """Send one persisted notification; return ``(ok, reason)`` and clear on success."""
    questions_key = _question_key(questions_path)
    state_path = _notification_path(state_dir)
    with _path_lock(state_path):
        pending = _read_pending(state_path).get(questions_key)
    if not pending:
        return True, "no pending notification"
    generation = pending.get("generation")
    if _question_key(binding.get("questions_path", "")) != questions_key:
        return False, "binding does not match the questions path"
    target = binding.get("hcom_name", "")
    if not target:
        return False, "binding has no HCOM name"
    message = (
        f"Questions file changed: {questions_key}. Re-read the file and apply the LAT "
        "question-processing contract. This notification is not approval. Only an "
        "unambiguous checked submit answer for the matching question ID and revision may be recorded."
    )
    command = [
        "hcom", "send", f"@{target}", "--from", "lat-panel",
        "--intent", "inform", "--json", "--", message,
    ]
    try:
        result = subprocess.run(
            command, text=True, capture_output=True, timeout=timeout,
            env=os.environ if env is None else env,
        )
    except subprocess.TimeoutExpired:
        return False, "notification timed out"
    except OSError as error:
        return False, str(error)
    if result.returncode != 0:
        return False, result.stderr.strip() or f"hcom exited {result.returncode}"
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False, "invalid hcom JSON response"
    delivered = {item.removeprefix("@") for item in _delivered_targets(payload)}
    if _hcom_receipt_names(target).isdisjoint(delivered):
        return False, f"notification not delivered to {target}"
    clear_pending_notification(
        questions_path, state_dir=state_dir, expected_generation=generation
    )
    return True, "delivered"


def _build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    question = commands.add_parser("question")
    question_commands = question.add_subparsers(dest="question_command", required=True)
    upsert = question_commands.add_parser("upsert")
    upsert.add_argument("--questions", type=Path, default=Path(".lat/questions.md"))
    upsert.add_argument("--id", required=True)
    upsert.add_argument("--file", required=True, type=Path)
    provenance = question_commands.add_parser("provenance")
    provenance.add_argument("--questions", required=True, type=Path)
    provenance.add_argument("--journal", required=True, type=Path)
    provenance.add_argument("--id", required=True)
    section_hash = question_commands.add_parser("section-hash")
    section_hash.add_argument("--questions", required=True, type=Path)
    section_hash.add_argument("--id", required=True)
    set_status = question_commands.add_parser("set-status")
    set_status.add_argument("--questions", type=Path, default=Path(".lat/questions.md"))
    set_status.add_argument("--id", required=True)
    set_status.add_argument("--revision", required=True, type=int)
    set_status.add_argument(
        "--status", required=True, choices=("recorded",)
    )
    set_status.add_argument("--expected-section-sha256", required=True)
    archive_recorded = question_commands.add_parser("archive-recorded")
    archive_recorded.add_argument(
        "--questions", type=Path, default=Path(".lat/questions.md")
    )
    archive_recorded.add_argument("--older-than", type=float, default=300)
    bind = commands.add_parser("bind")
    bind.add_argument("--hcom-name", required=True)
    bind.add_argument("--client", required=True)
    bind.add_argument("--session-id", required=True)
    bind.add_argument("--workspace", required=True, type=Path)
    bind.add_argument("--herdr-workspace", default=os.environ.get("HERDR_WORKSPACE_ID"))
    unbind = commands.add_parser("unbind")
    unbind.add_argument("--session-id", required=True)
    resolve = commands.add_parser("resolve")
    resolve.add_argument("--herdr-workspace", default=os.environ.get("HERDR_WORKSPACE_ID"))
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "question" and args.question_command == "upsert":
            revision = upsert_question(
                args.questions, args.id, args.file.read_text(encoding="utf-8")
            )
            print(f"{args.id} r{revision}")
            return 0
        if args.command == "question" and args.question_command == "provenance":
            print(json.dumps(
                question_provenance(args.questions, args.journal, args.id),
                ensure_ascii=False,
            ))
            return 0
        if args.command == "question" and args.question_command == "section-hash":
            document = args.questions.read_text(encoding="utf-8")
            print(json.dumps({
                "id": args.id,
                "section_sha256": _section_sha256(
                    _question_section(document, args.id)
                ),
            }))
            return 0
        if args.command == "question" and args.question_command == "set-status":
            set_question_status(
                args.questions, args.id, args.revision, args.status,
                args.expected_section_sha256,
            )
            return 0
        if args.command == "question" and args.question_command == "archive-recorded":
            if args.older_than < 0:
                raise ValueError("--older-than must be zero or greater")
            expected = args.questions.read_text(encoding="utf-8")
            archived = archive_recorded_questions(
                args.questions, args.older_than, expected_text=expected
            )
            if archived is None:
                raise ValueError("questions changed while archiving; retry")
            print(json.dumps({"archived": archived}, ensure_ascii=False))
            return 0
        if args.command == "bind":
            binding, replaced = bind_controller(
                args.hcom_name, args.client, args.session_id, args.workspace,
                args.herdr_workspace,
            )
            print(json.dumps({"binding": binding, "replaced": replaced}, ensure_ascii=False))
            return 0
        if args.command == "unbind":
            removed = unbind_controller(args.session_id)
            print(json.dumps({"removed": removed}))
            return 0
        if args.command == "resolve":
            print(json.dumps(resolve_binding(args.herdr_workspace), ensure_ascii=False))
            return 0
    except (OSError, ValueError) as error:
        print(f"lat-panel: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
