"""Board question and answer JSON assembly."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import re
import sys
import time

from questions import (
    QUESTIONS_DIR,
    QuestionAnswer,
    _RECOMMENDED,
    _answer_label,
    _answer_text_and_note,
    _archive_path,
    _journal_entry_matches_questions,
    _option_letters,
    _path_lock,
    _question_key,
    _question_section,
    _read_text_exact,
    _section_sha256,
    _sections,
    _submit_question_answers_locked,
    _write_question_answer_locked,
    panel_journal_path,
    parse_question_answer,
    parse_question_options,
    question_context,
    question_details,
    question_recommendation,
    render_answer_area,
)
from bindings import (
    _notification_path,
    _read_pending,
    _send_notification,
    _submitted_answers,
    _undelivered_answers,
    controller_questions_path,
    legacy_questions_path,
    list_bindings,
    mark_notification_pending,
    notification_is_pending,
    record_submitted_answers,
    send_pending_notification,
    session_record,
)
from _lat_common import run_cli

LEDGER_TOOL = Path(__file__).resolve().parents[1] / "scripts/lat-ledger.py"
# A read waits for a ledger's writer, which may hold its lock while checking evidence. Each read
# and the whole batch stay well inside the board's helper timeout (15 seconds by default), so one
# held ledger fails alone instead of taking the others with it.
LEDGER_READ_SECONDS = 3
LEDGERS_SECONDS = 8
_SESSION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


def _asked_times(questions_path):
    """Map ``(question ID, revision)`` to the time its upsert was journaled."""
    times = {}
    try:
        lines = panel_journal_path(questions_path).read_text(encoding="utf-8").splitlines()
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
    letters = _option_letters(parsed)
    answer, note = _answer_text_and_note(section["answer"] or "")
    return {
        "id": section["id"],
        "revision": section["revision"],
        "status": "submitted" if section["status"] == "ready" else section["status"],
        "title": section["title"],
        "context": question_context(section),
        "details": question_details(section),
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


def _name_files(questions_path):
    """The root file and the ``questions/`` file of one name in one ``.lat``, older first."""
    path = Path(questions_path)
    if path.parent.name == QUESTIONS_DIR:
        return [path.parent.parent / f"questions-{path.stem}.md", path]
    if path.name.startswith("questions-"):
        return [path, path.parent / QUESTIONS_DIR / path.name.removeprefix("questions-")]
    return [path]


def _answered_questions(questions_path, older=()):
    """The answered questions of this file, of the other location's file of its name and of
    ``older`` files: a controller's earlier rounds may have used another one."""
    latest = {}
    asked_times = {}
    # The archive holds older sections than the file; a later section of an ID replaces any
    # earlier one, and one that is not an answered, recorded question leaves nothing for it.
    for questions in dict.fromkeys([*map(Path, older), *_name_files(questions_path)]):
        for path in (_archive_path(questions), questions):
            try:
                document = path.read_text(encoding="utf-8")
            except FileNotFoundError:
                continue
            for section in _sections(document):
                latest.pop(section["id"], None)
                answer, _ = _answer_text_and_note(section["answer"] or "")
                if section["status"] == "recorded" and answer:
                    latest[section["id"]] = section
        asked_times.update(_asked_times(questions))
    return [_board_question(section, asked_times) for section in latest.values()]


def board_answered(questions_paths, controllers=()):
    """Return the answered questions each questions file and its archive hold.

    The files are ``questions_paths``, then the file of each ``(workspace,
    hcom_name)`` in ``controllers`` as ``controller_questions_path`` names it;
    those entries also carry their ``workspace`` and ``hcom_name``, so the board
    finds an unbound controller's file without naming it itself. Each file gets
    the latest section of every question ID in it or its ``-archive`` file, or in
    the other location's file of the same name (root ``.lat`` or
    ``.lat/questions/``) and its archive, when that section is recorded with an
    answer. A file that cannot be read, or a
    name that makes no file name, sets only its own ``error``; a file that does
    not exist has no questions.
    """
    files = []
    for path in questions_paths:
        files.append(_answered_entry(path, {"questions_path": str(path)}))
    for workspace, hcom_name in controllers:
        entry = {"questions_path": None, "workspace": workspace, "hcom_name": hcom_name}
        try:
            path = controller_questions_path(workspace, hcom_name)
            older = [legacy_questions_path(workspace, hcom_name)]
        except (OSError, ValueError) as error:
            files.append({**entry, "questions": [], "error": str(error)})
            continue
        files.append(_answered_entry(path, {**entry, "questions_path": str(path)}, older))
    return files


def _answered_entry(path, entry, older=()):
    try:
        return {**entry, "questions": _answered_questions(path, older), "error": None}
    except (OSError, ValueError) as error:
        return {**entry, "questions": [], "error": str(error)}


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


def board_ledgers(controllers):
    """``board_ledger`` of each (workspace, session ID), read side by side within the batch's time."""
    deadline = time.monotonic() + LEDGERS_SECONDS
    with ThreadPoolExecutor(max_workers=8) as pool:
        return list(pool.map(lambda pair: board_ledger(*pair, deadline=deadline), controllers))


def board_ledger(workspace, session_id, *, deadline=None):
    """One controller's work ledger, as ``lat-ledger show --json`` prints it.

    ``status`` is ``ok`` with ``ledger``, ``none`` when the session record names no ledger,
    or ``error`` with the ``reason`` the record or the ledger could not be read.
    ``ledger_path`` is there whenever the record names one, so the board can watch it.
    """
    if not _SESSION_ID.fullmatch(session_id):
        return {"session_id": session_id, "status": "error", "reason": f"不是 session ID：{session_id}"}
    try:
        record = session_record(workspace, session_id)
    except (OSError, ValueError) as error:
        return {"session_id": session_id, "status": "error", "reason": f"讀不到 session 紀錄：{error}"}
    path = record.get("ledger_path") if isinstance(record, dict) else None
    if not path:
        return {"session_id": session_id, "status": "none"}
    result = {"session_id": session_id, "ledger_path": str(path)}
    left = LEDGER_READ_SECONDS if deadline is None else min(LEDGER_READ_SECONDS, deadline - time.monotonic())
    if left <= 0:
        return {**result, "status": "error", "reason": "這次重讀的時間用完了，下次重讀再試"}
    try:
        output = run_cli([sys.executable, str(LEDGER_TOOL), "show", "--json", "--ledger", str(path)],
                         timeout=left, failure="lat-ledger show")
        return {**result, "status": "ok", "ledger": json.loads(output)}
    except ValueError as error:
        # run_cli names the interpreter and the script path; a timeout says what it means instead.
        reason = (f"lat-ledger show 逾時（{left:.0f} 秒內沒讀完，可能正在寫入），下次重讀再試"
                  if "timed out" in str(error) else str(error))
        return {**result, "status": "error", "reason": reason}


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
    """Answer, record and notify one question, as a panel submit does.

    ``recorded`` tells whether ``record_submitted_answers`` recorded the answer;
    when it did not, the answer stays submitted and ``record_reason`` says why.
    A notification that fails leaves ``notified`` false with a ``reason`` and
    stays pending for ``notify_controller``.
    """
    result = answer_question(
        questions_path, question_id, revision, expected_section_sha256,
        selections=selections, text=text, note=note,
    )
    if result["status"] != "submitted":
        return result
    [outcome] = record_submitted_answers(questions_path, [question_id], config_dir=config_dir)
    result["recorded"] = outcome["recorded"]
    if not outcome["recorded"]:
        result["record_reason"] = outcome["reason"]
    try:
        mark_notification_pending(questions_path, state_dir=state_dir)
        notice = notify_controller(questions_path, config_dir=config_dir, state_dir=state_dir)
    except (OSError, ValueError) as error:
        notice = {"status": "failed", "reason": str(error)}
    result["notified"] = notice["status"] != "failed"
    if not result["notified"]:
        result["reason"] = notice["reason"]
    return result
