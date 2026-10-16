#!/usr/bin/env python3
"""Stdlib core and controller CLI for the LAT question panel.

Public API used by the Textual panel and LAT controller:

* ``locked_replace`` performs a conditional atomic UTF-8 replacement. Pass a
  journal path for a panel save, or call ``save_panel_edit`` to use
  ``<questions parent>/panel-journal.jsonl``.
* ``parse_questions``, ``upsert_question``, and ``set_question_status`` model
  and update natural-language question sections without touching other sections.
* V2 selector UI flow: ``parse_question_options``, ``question_context``,
  ``question_recommendation``, and
  ``parse_question_answer`` read one ``parse_questions`` result;
  ``question_section_sha256`` captures its guarded-write identity;
  ``write_question_answer`` saves (or, with ``None``, clears) a draft while
  the question is unchecked;
  ``submit_question_answers`` checks several answered drafts in one write; and
  ``mark_submit_notification_pending`` applies the submit-only notification
  policy. ``render_answer_area`` emits the canonical hand-editable Markdown
  and raises ``AnswerFormatError`` for text that would forge file structure.
  Write results are ``saved``, ``read_only``, or ``question_changed``; batch
  results are ``submitted`` or ``question_changed``. V2-T2 should replace its
  loaded identity with the hash returned by each successful draft save.
  ``QuestionAnswer`` kinds are ``single`` (one keyed selection), ``multi``
  (ordered label selections plus optional ``other``), ``other`` (the explicit
  choice on a single-select question), and ``text`` (an input-only question).
  Batch submit receives ``{question_id: (revision, section_sha256)}``; pass its
  successful result to ``mark_submit_notification_pending``.
* ``question_provenance`` checks one snapshot section against the latest panel
  journal entry that changed that question.
* ``bind_controller``, ``unbind_controller``, and the binding lookup helpers
  manage per-controller routing inside a Herdr workspace.
* ``mark_notification_pending``, ``notification_is_pending``,
  ``send_pending_notification``, and ``clear_pending_notification`` provide the
  persisted notification lifecycle. ``send_pending_notification`` returns an
  ``(ok, reason)`` pair and clears state only after target delivery; it also
  notes which submitted answers that delivery covered.
* ``board_controllers``, ``board_questions``, ``answer_and_notify``, and
  ``notify_controller`` back the ``board`` commands: the LAT board reads and
  answers question files only through them. ``answer_question`` is the write
  half of ``answer_and_notify``. ``board_transcript`` reads one page of a
  controller's conversation from the Claude or Codex session record that
  ``transcript_path`` finds, with the model and effort of the latest turn
  (``current_settings``). ``board_launch_args`` reads the arguments hcom
  stored for an agent's launch, read-only from hcom's own database.
  ``prune_reports`` deletes the controller report files whose newest record
  is past the board's retention, under the same lock the turn-end hook
  appends with.

Controller CLI (run from the project root unless ``--questions`` is supplied)::

  question upsert --questions PATH --decisions DIR --id ID --file section.md
  question section-hash --questions PATH --id ID
  question provenance --questions SNAPSHOT --source-questions PATH --id ID \
      --journal panel-journal.jsonl
  question set-status --questions PATH --id ID --revision N --status recorded \
      --expected-section-sha256 HASH
  question cleanup --questions PATH --decisions DIR
  question archive-recorded --questions PATH --older-than 300
  question check-pending --questions PATH --decisions DIR
  bind --hcom-name NAME --client CLIENT --session-id ID --workspace ROOT \
       [--herdr-workspace ID] [--herdr-tab ID] [--herdr-pane ID]
  unbind --session-id ID
  resolve (--session-id ID | [--herdr-workspace ID])
  board list
  board questions --questions PATH
  board answer --questions PATH --id ID --revision N \
      --expected-section-sha256 HASH [--select N]... [--text TEXT] [--note TEXT]
  board notify --questions PATH
  board transcript --client (claude|codex) --session-id ID [--before SEQ]
  board launch-args --session-id ID
  board prune-reports --reports-dir DIR --now TIME

All commands are prefixed with ``uv run --no-project python lat_panel.py``.
Binding data uses ``HERDR_PLUGIN_CONFIG_DIR``, then
``herdr plugin config-dir lat.panel``, then the XDG config fallback. Pending
state uses ``HERDR_PLUGIN_STATE_DIR`` or the XDG state fallback. ``board``
commands print one JSON object, including on failure; only a usage error
prints argparse's message on stderr and exits 2.
"""

from contextlib import contextmanager
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import sys
import tempfile
from typing import NamedTuple
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lat_decision_status import read_decision_status


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


def _append_journal(
    journal_path, before, after, *, kind=None, details=None, now=None, panel_write=True,
):
    journal_path = Path(journal_path)
    journal_path.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "time": (
            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            if now is None else now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        ),
        "before_sha256": hashlib.sha256(before.encode("utf-8")).hexdigest(),
        "after_sha256": hashlib.sha256(after.encode("utf-8")).hexdigest(),
        # Provenance reads these hashes as proof of a panel write; an upsert must not supply one.
        "changed_questions": _question_changes(before, after) if panel_write else [],
    }
    if kind is not None:
        entry["kind"] = kind
    if details:
        entry.update(details)
    with journal_path.open("a", encoding="utf-8") as journal:
        journal.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
        journal.flush()
        os.fsync(journal.fileno())


def locked_replace(
    path, expected_text, new_text, *, journal_path=None, journal_details=None,
):
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
            _append_journal(
                journal_path, expected_text, new_text, details=journal_details
            )
        return True


def save_panel_edit(questions_path, expected_text, new_text):
    """Save panel text conditionally and append the standard panel journal."""
    questions_path = Path(questions_path)
    return locked_replace(
        questions_path,
        expected_text,
        new_text,
        journal_path=questions_path.parent / "panel-journal.jsonl",
        journal_details={"questions_path": _question_key(questions_path)},
    )


_SECTION_HEADER = re.compile(
    r"^## (?P<title>[^\r\n]+)\r?\n"
    r"(?P<id>[A-Za-z0-9][A-Za-z0-9._-]*) · r(?P<revision>[1-9][0-9]*) · "
    r"(?P<status_label>待答|已記錄)"
    r"(?: · (?P<recorded_at>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d))?"
    r"[ \t]*\r?$",
    re.MULTILINE,
)
_ARCHIVE_HEADER = re.compile(
    r"^### 舊版 r[1-9][0-9]*（不套用至 r[1-9][0-9]*）\r?$", re.MULTILINE
)
_ANSWER_MARKER = re.compile(r"^答覆：(?P<inline>[^\r\n]*)\r?$", re.MULTILINE)
_SUBMIT_MARKER = re.compile(
    r"^- \[(?P<checked>[ xX])\] 送出[ \t]*\r?$", re.MULTILINE
)


def _normalize_newlines(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _read_text_exact(path):
    with Path(path).open("r", encoding="utf-8", newline="") as source:
        return source.read()


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
        checked_submit = next(
            (
                marker for marker in _SUBMIT_MARKER.finditer(current_raw, status_end)
                if marker.group("checked").lower() == "x"
            ),
            None,
        )
        submit_marker = (
            _SUBMIT_MARKER.search(current_raw, answer_marker.end())
            if answer_marker
            else None
        )
        body = None
        answer = None
        answer_block = ""
        answer_start = None
        answer_end = None
        checked = False
        if answer_marker and submit_marker and submit_marker.end() <= len(current_raw):
            body = _normalize_newlines(
                raw[status_end:answer_marker.start()]
            ).strip("\n")
            following_block = raw[answer_marker.end():submit_marker.start()]
            inline_answer = answer_marker.group("inline")
            if inline_answer.strip():
                following_answer = _normalize_newlines(
                    following_block
                ).removeprefix("\n").rstrip("\n")
                answer = inline_answer + (
                    f"\n{following_answer}" if following_answer else ""
                )
            else:
                answer = _normalize_newlines(following_block).strip("\n")
            answer_block = raw[answer_marker.start():submit_marker.end()]
            answer_start = answer_marker.start()
            answer_end = submit_marker.end()
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
            "answer_start": answer_start,
            "answer_end": answer_end,
            "checked": checked,
            "malformed_submission": bool(checked_submit and not checked),
            "status_start": match.start("status_label") - match.start(),
            "status_end": match.end() - match.start(),
        })
    return sections


def malformed_submission_ids(text):
    """Return pending question IDs with a checked but unparseable submission."""
    return [
        section["id"]
        for section in parse_questions(text)
        if section["status_label"] == "待答" and section["malformed_submission"]
    ]


_sections = parse_questions


class QuestionOption(NamedTuple):
    """One selector option parsed from a current question body."""

    key: str | None
    label: str
    impact: str


class QuestionOptions(NamedTuple):
    """Selector mode, parsed options, and a fallback reason when unavailable."""

    kind: str | None
    options: tuple
    reason: str | None


_SINGLE_OPTION = re.compile(r"^(?P<key>[A-Z])\.\s+(?P<label>\S.*)$")
_MULTI_OPTION = re.compile(r"^- \[[ xX]\]\s+(?P<label>\S.*)$")
_RECOMMENDATION = re.compile(r"(?:\A|\n[ \t]*\n)(?P<recommendation>➡\ufe0f?)")


def _question_display_parts(question):
    """Split an unindented arrow paragraph from selectable content."""
    body = question.get("body") or ""
    marker = _RECOMMENDATION.search(body)
    if marker is None:
        return body, ""
    return (
        body[:marker.start()].rstrip("\n"),
        body[marker.start("recommendation"):].strip("\n"),
    )


def question_recommendation(question):
    """Read the original trailing recommendation, without changing stored text."""
    return _question_display_parts(question)[1]


def _option_items(lines, pattern, *, keyed):
    items = []
    for index, line in enumerate(lines):
        match = pattern.match(line)
        if match is None:
            continue
        impact = []
        for following in lines[index + 1:]:
            if not following or not following[:1].isspace():
                break
            impact.append(following.strip())
        items.append(QuestionOption(
            match.group("key") if keyed else None,
            match.group("label").strip(),
            "\n".join(impact),
        ))
    return tuple(items)


def parse_question_options(question):
    """Parse selector options from one ``parse_questions`` result.

    ``A.`` lines produce single-select options and checklist lines produce
    multi-select options. Mixed or absent styles deliberately fall back to
    free-form input and include a user-facing reason.
    """
    lines = _question_display_parts(question)[0].splitlines()
    single = _option_items(lines, _SINGLE_OPTION, keyed=True)
    multi = _option_items(lines, _MULTI_OPTION, keyed=False)
    if single and multi:
        return QuestionOptions(None, (), "題目混用了單選與複選格式")
    if single:
        return QuestionOptions("single", single, None)
    if multi:
        return QuestionOptions("multi", multi, None)
    return QuestionOptions(None, (), "題目沒有可解析的選項")


def question_context(question):
    """Return the body without the option lines and impacts the selector lists."""
    lines = _question_display_parts(question)[0].splitlines()
    kind = parse_question_options(question).kind
    if kind is None:
        return "\n".join(lines).strip("\n")
    pattern = _SINGLE_OPTION if kind == "single" else _MULTI_OPTION
    kept = []
    in_option = False
    for line in lines:
        if pattern.match(line):
            in_option = True
            continue
        if in_option and line[:1].isspace():
            continue
        in_option = False
        if line or (kept and kept[-1]):
            kept.append(line)
    return "\n".join(kept).strip("\n")


class QuestionAnswer(NamedTuple):
    """One selector answer, including optional free-form text and note."""

    kind: str
    selections: tuple
    other: str
    note: str


_NOTE_LINE = re.compile(r"(?:\A|\n)備註：(?P<first>[^\n]*)(?P<rest>(?:\n[\s\S]*)?)\Z")


def _answer_text_and_note(text):
    match = _NOTE_LINE.search(text)
    if match is None:
        return text.strip("\n"), ""
    answer_text = text[:match.start()].strip("\n")
    note = match.group("first") + match.group("rest")
    return answer_text, note.strip("\n")


def parse_question_answer(question):
    """Parse a current answer area into a ``QuestionAnswer`` or ``None``.

    Both V1's next-line answer and V2's same-line answer are accepted because
    ``parse_questions`` normalizes them into the question's ``answer`` value.
    """
    raw_answer = question.get("answer")
    if raw_answer is None:
        return None
    answer_text, note = _answer_text_and_note(raw_answer)
    if not answer_text:
        return None
    option_kind = parse_question_options(question).kind
    if option_kind is None:
        return QuestionAnswer("text", (), answer_text, note)
    if option_kind == "multi":
        if answer_text.startswith("其他："):
            selections = ()
            other = answer_text.removeprefix("其他：")
        elif "；其他：" in answer_text:
            selection_text, other = answer_text.split("；其他：", 1)
            selections = tuple(
                part.strip() for part in selection_text.split("；") if part.strip()
            )
        else:
            selections = tuple(
                part.strip() for part in answer_text.split("；") if part.strip()
            )
            other = ""
        return QuestionAnswer("multi", selections, other, note)
    if answer_text.startswith("其他："):
        return QuestionAnswer("other", (), answer_text.removeprefix("其他："), note)
    if option_kind == "single":
        return QuestionAnswer("single", (answer_text,), "", note)
    raise ValueError(f"unknown option kind: {option_kind}")


class AnswerFormatError(ValueError):
    """Free-form answer or note text would read as question-file structure."""


def render_answer_area(answer, *, submitted=False):
    """Render one answer and submit checkbox in the canonical V2 format.

    Raises ``AnswerFormatError`` when free-form text contains a line that would
    be parsed as a submit box, another answer marker, a section header, or an
    old-revision header.
    """
    if answer.kind == "single":
        if len(answer.selections) != 1 or answer.other:
            raise ValueError("single answer requires exactly one selection")
        value = answer.selections[0]
    elif answer.kind == "multi":
        parts = list(answer.selections)
        if answer.other:
            parts.append(f"其他：{answer.other}")
        if not parts:
            raise ValueError("multi answer requires a selection or other text")
        value = "；".join(parts)
    elif answer.kind == "other":
        if answer.selections or not answer.other:
            raise ValueError("other answer requires only free-form text")
        value = f"其他：{answer.other}"
    elif answer.kind == "text":
        if answer.selections or not answer.other:
            raise ValueError("text answer requires only free-form text")
        value = answer.other
    else:
        raise ValueError(f"unknown answer kind: {answer.kind}")
    lines = [f"答覆：{value}"]
    if answer.note:
        note_lines = answer.note.splitlines()
        lines.append(f"備註：{note_lines[0]}")
        lines.extend(note_lines[1:])
    area = "\n".join(lines)
    if (
        _SUBMIT_MARKER.search(area)
        or len(_ANSWER_MARKER.findall(area)) > 1
        or _SECTION_HEADER.search(area)
        or _ARCHIVE_HEADER.search(area)
    ):
        raise AnswerFormatError("answer text contains a question-file structure line")
    return f"{area}\n\n- [{'x' if submitted else ' '}] 送出"


def _section_text(section):
    """Return the current-revision section without inter-section whitespace."""
    marker = _archive_match(section["raw"])
    current = section["raw"][:marker.start()] if marker else section["raw"]
    current = _normalize_newlines(current)
    return current.rstrip("\n") + "\n"


def _section_sha256(section):
    return hashlib.sha256(_section_text(section).encode("utf-8")).hexdigest()


def question_section_sha256(question):
    """Return the current-revision hash used by guarded panel writes."""
    return _section_sha256(question)


def _full_section_sha256(section):
    text = section["raw"].rstrip("\r\n") + "\n"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _question_section(document, question_id):
    matching = [item for item in _sections(document) if item["id"] == question_id]
    if len(matching) > 1:
        raise ValueError(f"duplicate question ID: {question_id}")
    if not matching:
        raise ValueError(f"question not found: {question_id}")
    return matching[0]


_EMPTY_ANSWER_AREA = "答覆：\n\n- [ ] 送出"


def _question_still_matches(section, revision, expected_section_sha256):
    return (
        section["revision"] == revision
        and _section_sha256(section) == expected_section_sha256
    )


def write_question_answer(
    questions_path,
    question_id,
    revision,
    expected_section_sha256,
    answer,
):
    """Guard and write one answer area, preserving every other section byte-for-byte.

    Submitted or recorded questions are read-only. A stale revision or
    current-section hash returns a ``question_changed`` result without writing.
    ``answer=None`` clears the draft back to an empty answer area.
    """
    questions_path = Path(questions_path)
    with _path_lock(questions_path):
        return _write_question_answer_locked(
            questions_path, question_id, revision, expected_section_sha256, answer
        )


def _write_question_answer_locked(
    questions_path, question_id, revision, expected_section_sha256, answer
):
    document = _read_text_exact(questions_path)
    matches = [item for item in _sections(document) if item["id"] == question_id]
    if len(matches) > 1:
        raise ValueError(f"duplicate question ID: {question_id}")
    if not matches or not _question_still_matches(
        matches[0], revision, expected_section_sha256
    ):
        return {"status": "question_changed", "id": question_id}
    section = matches[0]
    if section["answer_start"] is None:
        raise ValueError(f"question has no writable answer area: {question_id}")
    if section["status_label"] == "已記錄" or section["checked"]:
        return {"status": "read_only", "id": question_id}
    replacement = (
        render_answer_area(answer, submitted=False) if answer is not None
        else _EMPTY_ANSWER_AREA
    )
    start = section["start"] + section["answer_start"]
    end = section["start"] + section["answer_end"]
    updated = document[:start] + replacement + document[end:]
    changed = updated != document
    if changed:
        _replace_locked(questions_path, updated)
        _append_journal(
            questions_path.parent / "panel-journal.jsonl",
            document,
            updated,
            kind="answer-write",
            details={
                "questions_path": _question_key(questions_path),
                "answer_question": question_id,
            },
        )
    updated_section = _question_section(updated, question_id)
    return {
        "status": "saved",
        "id": question_id,
        "revision": revision,
        "section_sha256": _section_sha256(updated_section),
        "submitted": updated_section["checked"],
        "changed": changed,
    }


def submit_question_answers(questions_path, expected_questions):
    """Check several answered questions in one guarded write and journal entry.

    ``expected_questions`` maps each question ID to ``(revision, section_hash)``.
    If any question changed, nothing is written and all stale IDs are returned.
    """
    questions_path = Path(questions_path)
    with _path_lock(questions_path):
        return _submit_question_answers_locked(questions_path, expected_questions)


def _submit_question_answers_locked(questions_path, expected_questions):
    document = _read_text_exact(questions_path)
    sections = _sections(document)
    by_id = {}
    for section in sections:
        if section["id"] in by_id:
            raise ValueError(f"duplicate question ID: {section['id']}")
        by_id[section["id"]] = section
    stale = []
    selected = []
    for question_id, identity in expected_questions.items():
        revision, section_hash = identity
        section = by_id.get(question_id)
        if (
            section is None
            or section["status_label"] != "待答"
            or not _question_still_matches(section, revision, section_hash)
        ):
            stale.append(question_id)
            continue
        if section["answer_start"] is None or parse_question_answer(section) is None:
            raise ValueError(f"question has no answer to submit: {question_id}")
        selected.append(section)
    if stale:
        return {"status": "question_changed", "ids": stale}

    updated = document
    submitted_ids = []
    for section in sorted(selected, key=lambda item: item["start"], reverse=True):
        if section["checked"]:
            continue
        replacement = _SUBMIT_MARKER.sub(
            lambda match: match.group(0).replace("[ ]", "[x]", 1),
            section["answer_block"],
        )
        start = section["start"] + section["answer_start"]
        end = section["start"] + section["answer_end"]
        updated = updated[:start] + replacement + updated[end:]
        submitted_ids.append(section["id"])
    submitted_ids.sort()
    if submitted_ids:
        _replace_locked(questions_path, updated)
        _append_journal(
            questions_path.parent / "panel-journal.jsonl",
            document,
            updated,
            kind="batch-submit",
            details={
                "questions_path": _question_key(questions_path),
                "submitted_questions": submitted_ids,
            },
        )
    updated_by_id = {item["id"]: item for item in _sections(updated)}
    return {
        "status": "submitted",
        "question_ids": submitted_ids,
        "section_sha256": {
            question_id: _section_sha256(updated_by_id[question_id])
            for question_id in submitted_ids
        },
    }


def _journal_entry_matches_questions(entry, questions_path):
    recorded_path = entry.get("questions_path")
    if recorded_path is not None:
        return recorded_path == _question_key(questions_path)
    return Path(questions_path).name == "questions.md"


def question_provenance(
    questions_path, journal_path, question_id, *, source_questions_path=None,
):
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
    source_questions_path = source_questions_path or questions_path
    for line_number, line in enumerate(journal_lines, 1):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid panel journal line {line_number}: {error.msg}") from None
        if not _journal_entry_matches_questions(entry, source_questions_path):
            continue
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
        "questions_path": _question_key(source_questions_path),
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
    lines.extend(("", answer_block or _EMPTY_ANSWER_AREA))
    if archives:
        lines.extend(("", archives))
    return "\n".join(lines) + "\n"


def upsert_question(questions_path, question_id, section_text, *, decisions_path):
    """Add or update one question under the shared lock; return its revision."""
    questions_path = Path(questions_path)
    incoming = _question_input(section_text)
    if not Path(decisions_path).is_dir():
        raise ValueError(f"decisions directory does not exist: {decisions_path}")
    with _path_lock(questions_path):
        try:
            document = _read_text_exact(questions_path)
        except FileNotFoundError:
            document = ""
        matching = [item for item in _sections(document) if item["id"] == question_id]
        if len(matching) > 1:
            raise ValueError(f"duplicate question ID: {question_id}")
        existing = matching[0] if matching else None
        if existing is not None and existing["body"] is None:
            raise ValueError("existing section is missing answer or submit marker")
        document, _ = _cleanup_locked(
            questions_path, decisions_path, document, exclude_id=question_id
        )
        existing = next((item for item in _sections(document)
                         if item["id"] == question_id), None)
        if existing is None:
            revision = 1
            replacement = _render_section(
                question_id, revision, incoming["title"], incoming["body"]
            )
            separator = "" if not document or document.endswith("\n\n") else "\n"
            updated = document + separator + replacement
        else:
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
        try:
            _append_journal(
                questions_path.parent / "panel-journal.jsonl",
                document,
                updated,
                kind="upsert",
                details={
                    "questions_path": _question_key(questions_path),
                    "upsert_question": question_id,
                    "revision": revision,
                },
                panel_write=False,
            )
        except OSError:
            # The question is written; only the board's asked time is lost.
            pass
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
                "questions_path": _question_key(questions_path),
                "recorded_question": question_id,
                "recorded_revision": revision,
                "recorded_at": recorded_at,
                "recorded_section_sha256": _full_section_sha256(recorded_section),
            },
            now=now,
        )


def _recorded_hashes(journal_path, questions_path):
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
        if (
            _journal_entry_matches_questions(entry, questions_path)
            and entry.get("kind") == "set-status"
            and entry.get("recorded_question")
        ):
            hashes[entry["recorded_question"]] = entry.get("recorded_section_sha256")
    return hashes


def _archive_path(questions_path):
    questions_path = Path(questions_path)
    return questions_path.with_name(f"{questions_path.stem}-archive{questions_path.suffix}")


def cleanup_questions(questions_path, decisions_path, *, expected_text=None):
    """Archive eligible sections in one file; refuse a changed snapshot."""
    questions_path = Path(questions_path)
    if not Path(decisions_path).is_dir():
        raise ValueError(f"decisions directory does not exist: {decisions_path}")
    if expected_text is None:
        expected_text = _read_text_exact(questions_path)
    with _path_lock(questions_path):
        document = _read_text_exact(questions_path)
        if document != expected_text:
            raise ValueError("questions changed while cleaning; retry")
        _, result = _cleanup_locked(questions_path, decisions_path, document)
        return result


def _decision_state(decision_path):
    try:
        status = read_decision_status(decision_path)
    except FileNotFoundError:
        return "missing-decision"
    except (OSError, UnicodeError):
        return "unreadable-decision"
    if status.error:
        return "unreadable-decision"
    return "pending" if status.status == "pending" else "decision-not-pending"


def _cleanup_locked(questions_path, decisions_path, document, *, exclude_id=None):
    """Clean a snapshot while the caller holds the questions-file lock."""
    journal_path = questions_path.parent / "panel-journal.jsonl"
    recorded_hashes = _recorded_hashes(journal_path, questions_path)
    eligible = []
    result = {"archived": [], "kept": []}
    for section in _sections(document):
        identifier = section["id"]
        if identifier == exclude_id:
            reason = "same-id"
        elif section["status"] == "recorded":
            reason = ("recorded" if section["recorded_at"] and
                      recorded_hashes.get(identifier) == _full_section_sha256(section)
                      else "unverified-recorded")
        elif section["checked"] or section["malformed_submission"]:
            reason = "submitted-not-recorded"
        else:
            reason = _decision_state(Path(decisions_path) / f"{identifier}.md")
        if reason in ("recorded", "decision-not-pending"):
            eligible.append(section)
            result["archived"].append({"id": identifier, "reason": reason})
        else:
            result["kept"].append({"id": identifier, "reason": reason})
    kept = []
    cursor = 0
    for section in eligible:
        kept.append(document[cursor:section["start"]])
        cursor = section["end"]
    kept.append(document[cursor:])
    updated = "".join(kept)
    current = _read_text_exact(questions_path) if questions_path.exists() else ""
    if current != document:
        raise ValueError("questions changed while cleaning; retry")
    archive_path = _archive_path(questions_path)
    if eligible:
        _append_archive(archive_path, [section["raw"] for section in eligible], exact_match=True)
        _replace_locked(questions_path, updated)
    _append_journal(
        journal_path, document, updated, kind="cleanup",
        details={"questions_path": _question_key(questions_path),
                 "archive_path": str(archive_path), **result},
    )
    return updated, result


def pending_question_gaps(questions_path, decisions_path):
    """Check pending decisions across controllers and stale questions in this file."""
    questions_path = Path(questions_path)
    decisions_path = Path(decisions_path)
    if not decisions_path.is_dir():
        raise ValueError(f"decisions directory does not exist: {decisions_path}")
    pending_ids = []
    unreadable = []
    for decision in sorted(decisions_path.glob("*.md")):
        try:
            status = read_decision_status(decision)
        except (OSError, UnicodeError) as error:
            unreadable.append((decision, str(error)))
            continue
        if status.error:
            unreadable.append((decision, status.error))
        elif status.status == "pending":
            pending_ids.append(decision.stem)

    question_files = sorted(
        path for path in questions_path.parent.glob("questions-*.md")
        if not path.stem.endswith("-archive")
    )
    current = {}
    for path in question_files:
        for question in parse_questions(path.read_text(encoding="utf-8")):
            current.setdefault(question["id"], []).append((path, question))
    archived = {}
    for path in sorted(questions_path.parent.glob("questions-*-archive.md")):
        for question in parse_questions(path.read_text(encoding="utf-8")):
            archived.setdefault(question["id"], []).append((path, question))
    present = []
    missing = []
    inconsistent = []
    for identifier in pending_ids:
        matches = current.get(identifier, [])
        waiting = next(
            ((path, question) for path, question in matches
             if question["status_label"] == "待答"),
            None,
        )
        if waiting:
            present.append((identifier, waiting[0]))
            continue
        recorded = next(
            ((path, question) for path, question in matches
             if question["status_label"] == "已記錄"),
            None,
        )
        if recorded:
            inconsistent.append((identifier, "問題檔已記錄", recorded[0]))
        elif identifier in archived:
            inconsistent.append((identifier, "問題已歸檔", archived[identifier][0][0]))
        else:
            missing.append(identifier)
    reverse = []
    if questions_path.exists():
        for question in parse_questions(_read_text_exact(questions_path)):
            if question["status_label"] != "待答":
                continue
            state = _decision_state(decisions_path / f"{question['id']}.md")
            if state == "missing-decision":
                reason = "題目待答但找不到決策紀錄；補決策紀錄"
            elif state == "decision-not-pending":
                reason = "題目待答但決策已非 pending"
            else:
                continue
            if question["checked"] or question["malformed_submission"]:
                reason += "；處理使用者已送出的答覆，再標為已記錄"
            elif state == "decision-not-pending":
                reason += "；執行 question cleanup --questions <此問題檔> --decisions <決策目錄>"
            reverse.append((question["id"], reason, questions_path))
    return present, missing, inconsistent, unreadable, reverse


def _append_archive(path, sections, *, exact_match=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = ""
    if path.exists():
        existing = _read_text_exact(path) if exact_match else path.read_text(encoding="utf-8")
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
        recorded_hashes = _recorded_hashes(journal_path, questions_path)
        eligible = []
        for section in _sections(document):
            if section["status"] != "recorded" or not section["recorded_at"]:
                continue
            recorded_at = datetime.fromisoformat(section["recorded_at"])
            if (current_time - recorded_at).total_seconds() <= older_than:
                continue
            if recorded_hashes.get(section["id"]) != _full_section_sha256(section):
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
                "questions_path": _question_key(questions_path),
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


def panel_enabled(env=None):
    """Return whether this shell is in Herdr with the LAT panel enabled."""
    env = os.environ if env is None else env
    if not env.get("HERDR_WORKSPACE_ID"):
        return False
    try:
        result = subprocess.run(
            ["herdr", "plugin", "list", "--plugin", "lat.panel", "--json"],
            text=True, capture_output=True, timeout=10, check=True, env=env,
        )
        payload = json.loads(result.stdout)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise ValueError(f"cannot check lat.panel: {error}") from error
    except subprocess.CalledProcessError as error:
        reason = error.stderr.strip() or f"herdr plugin list exited {error.returncode}"
        raise ValueError(f"cannot check lat.panel: {reason}") from error
    except subprocess.TimeoutExpired as error:
        raise ValueError("cannot check lat.panel: herdr plugin list timed out") from error
    except json.JSONDecodeError as error:
        raise ValueError("cannot check lat.panel: invalid JSON from herdr plugin list") from error
    if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
        payload = payload["result"]
    if isinstance(payload, dict):
        if "plugins" not in payload:
            raise ValueError("cannot check lat.panel: missing plugins list")
        plugins = payload["plugins"]
    else:
        plugins = payload
    if not isinstance(plugins, list):
        raise ValueError("cannot check lat.panel: invalid plugins list")
    return any(
        isinstance(plugin, dict)
        and plugin.get("plugin_id") == "lat.panel"
        and plugin.get("enabled") is True
        for plugin in plugins
    )


def _bindings_path(config_dir=None):
    directory = Path(config_dir) if config_dir else plugin_directory("config")
    return directory / "bindings.json"


class LegacyBindingsError(ValueError):
    def __init__(self, count):
        self.count = count
        super().__init__(
            f"legacy bindings ignored ({count}); each LAT controller must rebind"
        )


def _read_bindings(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if not isinstance(payload, dict) or not isinstance(payload.get("bindings", {}), dict):
        raise ValueError("invalid bindings file")
    bindings = payload.get("bindings", {})
    if payload.get("version") != 2 and bindings:
        raise LegacyBindingsError(len(bindings))
    return bindings


def _write_bindings(path, bindings):
    path.parent.mkdir(parents=True, exist_ok=True)
    _replace_locked(
        path,
        json.dumps({"version": 2, "bindings": bindings}, ensure_ascii=False, indent=2)
        + "\n",
    )


def _safe_controller_name(hcom_name):
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", hcom_name).strip("-_").lower()
    if not safe:
        raise ValueError("HCOM name has no safe filename characters")
    return safe


def bind_controller(
    hcom_name, client, session_id, workspace, herdr_workspace, herdr_tab, herdr_pane,
    *, config_dir=None,
):
    """Bind one controller session and return its binding and prior state."""
    missing = [
        label for label, value in (
            ("HCOM name", hcom_name), ("client", client), ("session ID", session_id),
            ("Herdr workspace ID", herdr_workspace), ("Herdr tab ID", herdr_tab),
            ("Herdr pane ID", herdr_pane),
        ) if not value
    ]
    if missing:
        raise ValueError(f"{', '.join(missing)} required")
    workspace = Path(workspace).expanduser().resolve()
    questions_name = f"questions-{_safe_controller_name(hcom_name)}.md"
    binding = {
        "hcom_name": hcom_name,
        "client": client,
        "session_id": session_id,
        "workspace": str(workspace),
        "questions_path": str(workspace / ".lat" / questions_name),
        "herdr_workspace": herdr_workspace,
        "herdr_tab": herdr_tab,
        "herdr_pane": herdr_pane,
    }
    path = _bindings_path(config_dir)
    with _path_lock(path):
        legacy_ignored = 0
        try:
            bindings = _read_bindings(path)
        except LegacyBindingsError as error:
            legacy_ignored = error.count
            bindings = {}
        replaced = bindings.get(session_id)
        bindings[session_id] = binding
        _write_bindings(path, bindings)
    return binding, replaced, legacy_ignored


def unbind_controller(session_id, *, config_dir=None):
    """Remove only bindings owned by ``session_id`` and return their count."""
    path = _bindings_path(config_dir)
    with _path_lock(path):
        bindings = _read_bindings(path)
        kept = {
            owner_session: binding for owner_session, binding in bindings.items()
            if owner_session != session_id
        }
        if kept != bindings:
            _write_bindings(path, kept)
        return len(bindings) - len(kept)


def list_bindings(herdr_workspace=None, *, config_dir=None):
    """Return version-2 bindings, optionally restricted to one workspace."""
    path = _bindings_path(config_dir)
    with _path_lock(path):
        bindings = _read_bindings(path)
    values = list(bindings.values())
    if herdr_workspace is not None:
        values = [
            binding for binding in values
            if binding.get("herdr_workspace") == herdr_workspace
        ]
    return sorted(values, key=lambda item: (item.get("hcom_name", ""), item.get("session_id", "")))


def resolve_session_binding(session_id, *, config_dir=None):
    """Resolve a controller's own binding without any workspace fallback."""
    path = _bindings_path(config_dir)
    with _path_lock(path):
        binding = _read_bindings(path).get(session_id)
    if binding:
        return binding
    raise ValueError(f"no LAT controller binding for session: {session_id}")


def resolve_binding(herdr_workspace=None, *, config_dir=None):
    """Resolve a workspace only when it has exactly one controller."""
    bindings = list_bindings(herdr_workspace, config_dir=config_dir)
    if len(bindings) == 1:
        return bindings[0]
    if len(bindings) > 1:
        raise ValueError("multiple LAT controllers are bound to this Herdr workspace")
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
    # The delivery record dates its start by this file's last change, so it has to exist before
    # the file changes again: otherwise this write would pass for the earlier state.
    delivered_path = _delivered_path(path.parent)
    with _path_lock(delivered_path):
        _read_delivered(delivered_path)
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


def mark_submit_notification_pending(questions_path, submit_result, *, state_dir=None):
    """Mark notification state only for a successful, non-empty batch submit."""
    if (
        submit_result.get("status") != "submitted"
        or not submit_result.get("question_ids")
    ):
        return None
    return mark_notification_pending(questions_path, state_dir=state_dir)


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


def _delivered_path(state_dir=None):
    return _notification_path(state_dir).with_name("delivered-notifications.json")


def _write_delivered(path, delivered, since):
    _replace_locked(
        path,
        json.dumps({"delivered": delivered, "since": since}, ensure_ascii=False, indent=2) + "\n",
    )


def _read_delivered(path):
    """Return ``(delivered, since)`` from the delivery record, starting it if there is none.

    ``delivered`` maps each questions path to the answer hashes its last
    delivery covered. Notifications sent before the record existed left no
    trace in it, so the record starts with ``since``, the last time the pending
    notifications changed: an answer submitted before that was handled by the
    stored notifications alone and is owed nothing more. ``since`` is ``None``
    when there was no earlier state.

    Content that cannot be used counts as an empty record: the cost is one
    repeated notification, where refusing would block every later one.
    """
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        try:
            changed = path.with_name("pending-notifications.json").stat().st_mtime
            since = datetime.fromtimestamp(changed, timezone.utc).isoformat()
        except FileNotFoundError:
            since = None
        _write_delivered(path, {}, since)
        return {}, since
    except ValueError:
        return {}, None
    delivered = payload.get("delivered") if isinstance(payload, dict) else None
    if not isinstance(delivered, dict):
        return {}, None
    since = payload.get("since")
    try:
        datetime.fromisoformat(since)
    except (TypeError, ValueError):
        since = None
    return {key: value for key, value in delivered.items() if isinstance(value, list)}, since


def _submitted_after(submitted, since):
    """Whether an answer journaled at ``submitted`` came after the record's start."""
    if since is None:
        return True
    try:
        submitted = datetime.fromisoformat(submitted.replace("Z", "+00:00"))
        return submitted > datetime.fromisoformat(since)
    except (AttributeError, TypeError, ValueError):
        return False


def _submitted_answers(questions_path):
    """Map the section hash of each panel-submitted, unrecorded answer to its journal time.

    These are the answers a notification is owed for, whether or not a pending
    notification was ever stored. A submit the panel journal does not prove is
    left out: the controller could not record it either.
    """
    questions_path = Path(questions_path)
    journal_path = questions_path.parent / "panel-journal.jsonl"
    try:
        sections = _sections(questions_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    answers = {}
    for section in sections:
        if section["status"] != "ready":
            continue
        try:
            proof = question_provenance(questions_path, journal_path, section["id"])
        except (OSError, ValueError, AttributeError, TypeError):
            # The last two: a journal line that is JSON but not an entry.
            continue
        answers[proof["section_sha256"]] = proof["time"]
    return answers


def _record_delivered(questions_path, answers, *, state_dir=None):
    """Note the submitted answers that a delivered notification covered."""
    path = _delivered_path(state_dir)
    key = _question_key(questions_path)
    with _path_lock(path):
        delivered, since = _read_delivered(path)
        if not answers and key not in delivered:
            return
        if answers:
            delivered[key] = sorted(answers)
        else:
            del delivered[key]
        _write_delivered(path, delivered, since)


def _undelivered_answers(questions_path, *, state_dir=None):
    """Return the hashes of submitted answers that no delivered notification has covered."""
    answers = _submitted_answers(questions_path)
    if not answers:
        return set()
    path = _delivered_path(state_dir)
    with _path_lock(path):
        delivered, since = _read_delivered(path)
    covered = delivered.get(_question_key(questions_path), [])
    return {
        answer for answer, submitted in answers.items()
        if answer not in covered and _submitted_after(submitted, since)
    }


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
    state_path = _notification_path(state_dir)
    with _path_lock(state_path):
        pending = _read_pending(state_path).get(_question_key(questions_path))
    if not pending:
        return True, "no pending notification"
    ok, reason = _send_notification(
        questions_path, binding, state_dir=state_dir, env=env, timeout=timeout
    )
    if ok:
        clear_pending_notification(
            questions_path, state_dir=state_dir, expected_generation=pending.get("generation")
        )
    return ok, reason


def _send_notification(questions_path, binding, *, state_dir=None, env=None, timeout=10):
    """Tell the bound controller to re-read its questions file; return ``(ok, reason)``.

    A delivery is noted with the submitted answers it covered.
    """
    questions_key = _question_key(questions_path)
    if _question_key(binding.get("questions_path", "")) != questions_key:
        return False, "binding does not match the questions path"
    target = binding.get("hcom_name", "")
    if not target:
        return False, "binding has no HCOM name"
    # Read before sending: an answer submitted while the message is under way is not covered.
    covered = _submitted_answers(questions_path)
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
    _record_delivered(questions_path, covered, state_dir=state_dir)
    return True, "delivered"


_RECOMMENDED = "（建議）"


def _answer_label(label):
    """Option text as the panel writes it to the answer area, without 建議."""
    return label.removesuffix(_RECOMMENDED).rstrip()


def _asked_times(questions_path):
    """Map ``(question ID, revision)`` to the time its upsert was journaled."""
    times = {}
    try:
        lines = (
            Path(questions_path).parent / "panel-journal.jsonl"
        ).read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        return times
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(entry, dict)
            and entry.get("kind") == "upsert"
            and isinstance(entry.get("upsert_question"), str)
            and isinstance(entry.get("revision"), int)
            and _journal_entry_matches_questions(entry, questions_path)
        ):
            times[entry["upsert_question"], entry["revision"]] = entry.get("time")
    return times


def _board_question(section, asked_times):
    parsed = parse_question_options(section)
    if parsed.kind == "single":
        letters = [option.key for option in parsed.options]
    else:
        letters = [
            chr(ord("A") + index) if index < 26 else ""
            for index in range(len(parsed.options))
        ]
    answer, note = _answer_text_and_note(section["answer"] or "")
    return {
        "id": section["id"],
        "revision": section["revision"],
        "status": "submitted" if section["status"] == "ready" else section["status"],
        "title": section["title"],
        "context": question_context(section),
        "kind": parsed.kind or "text",
        "options": [
            {
                "letter": letter,
                "label": _answer_label(option.label),
                "impact": option.impact,
                "recommended": option.label.endswith(_RECOMMENDED),
            }
            for letter, option in zip(letters, parsed.options)
        ],
        "recommendation": question_recommendation(section),
        "answer": answer,
        "note": note,
        "asked_at": asked_times.get((section["id"], section["revision"])),
        "recorded_at": section["recorded_at"],
        "section_sha256": _section_sha256(section),
    }


def _unique_sections(document):
    sections = _sections(document)
    seen = set()
    for section in sections:
        if section["id"] in seen:
            raise ValueError(f"duplicate question ID: {section['id']}")
        seen.add(section["id"])
    return sections


def board_questions(questions_path):
    """Return the current revision of each question in one questions file.

    The file need not belong to a bound controller: the board reads what an
    ended controller left behind this way. A file that does not exist has no
    questions.
    """
    try:
        document = Path(questions_path).read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    asked_times = _asked_times(questions_path)
    return [
        _board_question(section, asked_times) for section in _unique_sections(document)
    ]


def _notification_owed(questions_path, state_dir):
    try:
        return bool(_undelivered_answers(questions_path, state_dir=state_dir))
    except OSError:
        # Nothing can show that a notification was delivered.
        return bool(_submitted_answers(questions_path))


def board_controllers(*, config_dir=None, state_dir=None):
    """Return every bound controller with the current revision of each question.

    A questions file that cannot be read sets only its own controller's
    ``error``; a controller that has not asked anything yet has no questions.
    ``notification_pending`` is true for a stored pending notification and for
    a submitted answer that no delivered notification covers, so an answer
    whose pending notification could not be stored still shows as not notified.
    """
    state_path = _notification_path(state_dir)
    try:
        with _path_lock(state_path):
            pending = _read_pending(state_path)
    except OSError:
        # The state cannot be used at all; the question files still tell what is owed.
        pending = {}
    controllers = []
    for binding in list_bindings(config_dir=config_dir):
        controller = {
            **binding,
            "notification_pending": (
                _question_key(binding["questions_path"]) in pending
                or _notification_owed(binding["questions_path"], state_dir)
            ),
            "error": None,
            "questions": [],
        }
        try:
            controller["questions"] = board_questions(binding["questions_path"])
        except (OSError, ValueError) as error:
            controller["error"] = str(error)
        controllers.append(controller)
    return controllers


def _board_answer(section, selections, text, note):
    """Build the panel's ``QuestionAnswer`` for a board reply, or raise ``ValueError``."""
    parsed = parse_question_options(section)
    has_text = bool(text.strip())
    if parsed.kind is None:
        if selections or not has_text:
            raise ValueError("a text question takes text and no selection")
        return QuestionAnswer("text", (), text, note)
    if len(set(selections)) != len(selections) or not all(
        1 <= number <= len(parsed.options) for number in selections
    ):
        raise ValueError(
            f"selections must be distinct option numbers from 1 to {len(parsed.options)}"
        )
    options = [parsed.options[number - 1] for number in selections]
    if parsed.kind == "multi":
        if not options and not has_text:
            raise ValueError("a multi-select question takes a selection or other text")
        return QuestionAnswer(
            "multi",
            tuple(_answer_label(option.label) for option in options),
            text if has_text else "",
            note,
        )
    if has_text and not options:
        return QuestionAnswer("other", (), text, note)
    if has_text or len(options) != 1:
        raise ValueError("a single-select question takes one selection or other text")
    return QuestionAnswer(
        "single", (f"{options[0].key}. {_answer_label(options[0].label)}",), "", note
    )


def answer_question(
    questions_path, question_id, revision, expected_section_sha256,
    *, selections=(), text="", note="",
):
    """Write and submit one answer exactly as the Herdr panel would.

    ``selections`` are 1-based option numbers in the order chosen; ``text`` is
    the whole answer of a text question and the 其他 text of the others. Returns
    ``submitted``, or refuses without writing as ``question_changed`` (stale
    revision or section hash), ``not_pending`` (already submitted or recorded)
    or ``invalid_answer`` (does not fit the question kind).
    """
    questions_path = Path(questions_path)

    def refused(status, reason):
        return {"status": status, "id": question_id, "reason": reason}

    with _path_lock(questions_path):
        document = _read_text_exact(questions_path)
        # The submit step rejects any duplicate ID; find it before the draft is written.
        matches = [
            item for item in _unique_sections(document) if item["id"] == question_id
        ]
        if not matches:
            return refused("question_changed", "question is no longer in the file")
        section = matches[0]
        if section["revision"] != revision:
            return refused(
                "question_changed", f"question is now at revision {section['revision']}"
            )
        if section["status_label"] != "待答" or section["checked"]:
            return refused("not_pending", "question is already submitted or recorded")
        if _section_sha256(section) != expected_section_sha256:
            return refused("question_changed", "question changed since it was loaded")
        if section["answer_start"] is None:
            raise ValueError(f"question has no writable answer area: {question_id}")
        try:
            answer = _board_answer(section, tuple(selections), text, note)
            start = section["start"] + section["answer_start"]
            end = section["start"] + section["answer_end"]
            draft = document[:start] + render_answer_area(answer) + document[end:]
            if parse_question_answer(_question_section(draft, question_id)) is None:
                raise ValueError("answer would be read back as empty")
        except ValueError as error:
            return refused("invalid_answer", str(error))
        saved = _write_question_answer_locked(
            questions_path, question_id, revision, expected_section_sha256, answer
        )
        submitted = _submit_question_answers_locked(
            questions_path, {question_id: (revision, saved["section_sha256"])}
        )
        return {
            "status": "submitted",
            "id": question_id,
            "revision": revision,
            "section_sha256": submitted["section_sha256"][question_id],
        }


def notify_controller(questions_path, *, config_dir=None, state_dir=None):
    """Send the pending notification of one questions file to its bound controller.

    Returns ``delivered``, ``no_pending``, or ``failed`` with a ``reason``; a
    failed notification stays pending. A submitted answer that no delivered
    notification covers is notified even when no pending notification was
    stored for it; that one is owed only until the answer is recorded or the
    question is asked again, so nothing is stored for it here either.
    """
    pending = notification_is_pending(questions_path, state_dir=state_dir)
    if not pending and not _undelivered_answers(questions_path, state_dir=state_dir):
        return {"status": "no_pending"}
    questions_key = _question_key(questions_path)
    binding = next(
        (
            binding for binding in list_bindings(config_dir=config_dir)
            if _question_key(binding["questions_path"]) == questions_key
        ),
        None,
    )
    if binding is None:
        return {"status": "failed", "reason": "no LAT controller is bound to this questions file"}
    send = send_pending_notification if pending else _send_notification
    ok, reason = send(questions_path, binding, state_dir=state_dir)
    if not ok:
        return {"status": "failed", "reason": reason}
    return {"status": "delivered" if reason == "delivered" else "no_pending"}


def answer_and_notify(
    questions_path, question_id, revision, expected_section_sha256,
    *, selections=(), text="", note="", config_dir=None, state_dir=None,
):
    """Answer one question and notify its controller, as a panel submit does.

    A written answer stays submitted when the notification fails; the result
    then has ``notified`` false with a ``reason`` and the notification stays
    pending for ``notify_controller``.
    """
    result = answer_question(
        questions_path, question_id, revision, expected_section_sha256,
        selections=selections, text=text, note=note,
    )
    if result["status"] != "submitted":
        return result
    try:
        mark_notification_pending(questions_path, state_dir=state_dir)
        notice = notify_controller(questions_path, config_dir=config_dir, state_dir=state_dir)
    except (OSError, ValueError) as error:
        notice = {"status": "failed", "reason": str(error)}
    result["notified"] = notice["status"] != "failed"
    if not result["notified"]:
        result["reason"] = notice["reason"]
    return result


# --- Conversation history for the board ------------------------------------

TRANSCRIPT_PAGE_TEXTS = 50
_SUMMARY_LIMIT = 80
_SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
# Text that arrives as user input but was put there by a tool, not typed by a person.
_INJECTED_INPUT = re.compile(
    r"\s*(<hcom[\s>]|\[lat-watch\]|(read (any|your) unread hcom|you have unread hcom))",
    re.IGNORECASE,
)
# What HCOM delivers inside a hook: `<hcom>…` or `[request #12] sender → receiver: …`.
_HCOM_DELIVERY = re.compile(r"\s*(<hcom>|\[(?:\d+ )?(?:new message|request|inform|ack)\b[^\]]*\])")
# What the client itself wraps around output it puts into the conversation (older records
# have no `origin` to tell typed text apart).
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


# A command made only of these characters cannot carry quoted text, expansions or redirections,
# so it is safe to show as it is.
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


# Claude tools whose main argument is safe to show: (label, input key, is a path).
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


REPORT_RETENTION = timedelta(days=30)
_REPORT_TAGS = {"DECIDE", "HELP", "DONE", "NO REPLY", ""}
_REPORT_TEXT_FIELDS = ("session_id", "hcom_name", "workspace", "client", "summary", "message")


def _report_time(line):
    """When a complete report record was issued, as the board reads it; None otherwise."""
    try:
        item = json.loads(line)
    except (ValueError, UnicodeDecodeError):
        return None
    if not (
        isinstance(item, dict)
        and isinstance(item.get("time"), str)
        and all(isinstance(item.get(field), str) for field in _REPORT_TEXT_FIELDS)
        and type(item.get("round")) in (int, float)
        and isinstance(item.get("final"), bool)
        and item.get("tag") in _REPORT_TAGS
    ):
        return None
    try:
        time = datetime.fromisoformat(item["time"])
    except ValueError:
        return None
    return time if time.tzinfo else time.replace(tzinfo=timezone.utc)


def _report_expired(path, now):
    """Whether the newest complete record in a report file is past retention. A file
    without one, or one that cannot be read, is not."""
    try:
        with path.open("rb") as stream:
            times = [time for time in map(_report_time, stream) if time is not None]
    except OSError:
        return False
    return bool(times) and now - max(times) >= REPORT_RETENTION


def prune_reports(directory, now):
    """Delete each ``<session-id>.jsonl`` report file in ``directory`` whose newest
    complete record was issued ``REPORT_RETENTION`` or more before ``now``.

    Each file is checked again while holding ``<session-id>.lock`` without
    waiting, the lock the turn-end hook appends under; a busy lock leaves the file
    for a later run. The lock file is never deleted: a hook already waiting on it
    and one arriving after the deletion must keep sharing the one lock. A file
    that cannot be read or locked is left alone too. Returns the session IDs whose
    file was deleted.
    """
    directory = Path(directory)
    if not directory.is_dir():
        return []
    deleted = []
    for path in sorted(directory.glob("*.jsonl")):
        if not _report_expired(path, now):
            continue
        try:
            with path.with_suffix(".lock").open("a") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                if _report_expired(path, now):
                    path.unlink()
                    deleted.append(path.stem)
        except OSError:
            # A busy lock included: the file is left for a later run.
            continue
    return deleted


def _run_board(args):
    try:
        if args.board_command == "list":
            result, code = {"controllers": board_controllers()}, 0
        elif args.board_command == "questions":
            result, code = {"questions": board_questions(args.questions)}, 0
        elif args.board_command == "answer":
            result = answer_and_notify(
                args.questions, args.id, args.revision, args.expected_section_sha256,
                selections=args.select, text=args.text, note=args.note,
            )
            code = 0 if result["status"] == "submitted" else 1
        elif args.board_command == "transcript":
            try:
                result = board_transcript(args.client, args.session_id, before=args.before)
                code = 0
            except FileNotFoundError as error:
                result, code = {"status": "not_found", "reason": str(error)}, 1
        elif args.board_command == "launch-args":
            result = board_launch_args(args.session_id)
            code = 0 if result["status"] == "ok" else 1
        elif args.board_command == "prune-reports":
            now = datetime.fromisoformat(args.now)
            if now.tzinfo is None:
                raise ValueError("--now must include a time zone")
            result, code = {"status": "ok", "deleted": prune_reports(args.reports_dir, now)}, 0
        else:
            result = notify_controller(args.questions)
            code = 1 if result["status"] == "failed" else 0
    except (OSError, ValueError) as error:
        result, code = {"status": "error", "reason": str(error)}, 1
    print(json.dumps(result, ensure_ascii=False))
    return code


def _build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    question = commands.add_parser("question")
    question_commands = question.add_subparsers(dest="question_command", required=True)
    upsert = question_commands.add_parser("upsert")
    upsert.add_argument("--questions", type=Path, default=Path(".lat/questions.md"))
    upsert.add_argument("--decisions", required=True, type=Path)
    upsert.add_argument("--id", required=True)
    upsert.add_argument("--file", required=True, type=Path)
    provenance = question_commands.add_parser("provenance")
    provenance.add_argument("--questions", required=True, type=Path)
    provenance.add_argument("--source-questions", type=Path)
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
    cleanup = question_commands.add_parser("cleanup")
    cleanup.add_argument("--questions", required=True, type=Path)
    cleanup.add_argument("--decisions", required=True, type=Path)
    check_pending = question_commands.add_parser("check-pending")
    check_pending.add_argument("--questions", required=True, type=Path)
    check_pending.add_argument("--decisions", required=True, type=Path)
    bind = commands.add_parser("bind")
    bind.add_argument("--hcom-name", required=True)
    bind.add_argument("--client", required=True)
    bind.add_argument("--session-id", required=True)
    bind.add_argument("--workspace", required=True, type=Path)
    bind.add_argument("--herdr-workspace", default=os.environ.get("HERDR_WORKSPACE_ID"))
    bind.add_argument("--herdr-tab", default=os.environ.get("HERDR_TAB_ID"))
    bind.add_argument("--herdr-pane", default=os.environ.get("HERDR_PANE_ID"))
    unbind = commands.add_parser("unbind")
    unbind.add_argument("--session-id", required=True)
    resolve = commands.add_parser("resolve")
    resolve.add_argument("--herdr-workspace", default=os.environ.get("HERDR_WORKSPACE_ID"))
    resolve.add_argument("--session-id")
    board = commands.add_parser("board")
    board_commands = board.add_subparsers(dest="board_command", required=True)
    board_commands.add_parser("list")
    board_questions_parser = board_commands.add_parser("questions")
    board_questions_parser.add_argument("--questions", required=True, type=Path)
    answer = board_commands.add_parser("answer")
    answer.add_argument("--questions", required=True, type=Path)
    answer.add_argument("--id", required=True)
    answer.add_argument("--revision", required=True, type=int)
    answer.add_argument("--expected-section-sha256", required=True)
    answer.add_argument("--select", type=int, action="append", default=[])
    answer.add_argument("--text", default="")
    answer.add_argument("--note", default="")
    notify = board_commands.add_parser("notify")
    notify.add_argument("--questions", required=True, type=Path)
    transcript = board_commands.add_parser("transcript")
    transcript.add_argument("--client", required=True)
    transcript.add_argument("--session-id", required=True)
    transcript.add_argument("--before", type=int)
    launch_args = board_commands.add_parser("launch-args")
    launch_args.add_argument("--session-id", required=True)
    prune = board_commands.add_parser("prune-reports")
    prune.add_argument("--reports-dir", required=True, type=Path)
    prune.add_argument("--now", required=True)
    return parser


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "board":
        return _run_board(args)
    try:
        if args.command == "question" and args.question_command == "upsert":
            revision = upsert_question(
                args.questions, args.id, args.file.read_text(encoding="utf-8"),
                decisions_path=args.decisions
            )
            print(f"{args.id} r{revision}")
            return 0
        if args.command == "question" and args.question_command == "provenance":
            print(json.dumps(
                question_provenance(
                    args.questions, args.journal, args.id,
                    source_questions_path=args.source_questions,
                ),
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
        if args.command == "question" and args.question_command == "cleanup":
            print(json.dumps(cleanup_questions(args.questions, args.decisions), ensure_ascii=False))
            return 0
        if args.command == "question" and args.question_command == "check-pending":
            if not panel_enabled():
                print("面板未啟用，略過檢查")
                return 0
            present, missing, inconsistent, unreadable, reverse = pending_question_gaps(
                args.questions, args.decisions
            )
            if present:
                print("已找到待答題目：")
                for identifier, path in present:
                    print(f"- {identifier}：{path}")
            if missing:
                print("遺漏待答題目：")
                for identifier in missing:
                    print(f"- {identifier}")
            if inconsistent:
                print("狀態不一致（決策仍為 pending）：")
                for identifier, reason, path in inconsistent:
                    print(f"- {identifier}：{reason}：{path}")
            if unreadable:
                print("讀不出狀態：")
                for path, reason in unreadable:
                    print(f"- {path}：{reason}")
            if reverse:
                print("待答題目需處理：")
                for identifier, reason, path in reverse:
                    print(f"- {identifier}：{reason}：{path}")
            if missing or inconsistent or unreadable or reverse:
                return 1
            print("沒有遺漏")
            return 0
        if args.command == "bind":
            binding, replaced, legacy_ignored = bind_controller(
                args.hcom_name, args.client, args.session_id, args.workspace,
                args.herdr_workspace, args.herdr_tab, args.herdr_pane,
            )
            print(json.dumps({
                "binding": binding,
                "replaced": replaced,
                "legacy_ignored": legacy_ignored,
            }, ensure_ascii=False))
            return 0
        if args.command == "unbind":
            removed = unbind_controller(args.session_id)
            print(json.dumps({"removed": removed}))
            return 0
        if args.command == "resolve":
            binding = (
                resolve_session_binding(args.session_id)
                if args.session_id else resolve_binding(args.herdr_workspace)
            )
            print(json.dumps(binding, ensure_ascii=False))
            return 0
    except (OSError, ValueError) as error:
        print(f"lat-panel: {error}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
