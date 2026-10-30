"""Question files, guarded answers, journals and report retention."""

import sys
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import textwrap
import time
from typing import NamedTuple
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lat_decision_status import read_decision_kind, read_decision_session, read_decision_status
from _lat_common import run_cli, write_text_atomic as _replace_locked


QUESTIONS_DIR = "questions"


def panel_journal_path(questions_path):
    """The one panel journal at the ``.lat`` root, for a root or ``questions/`` file alike."""
    directory = Path(questions_path).parent
    if directory.name == QUESTIONS_DIR:
        directory = directory.parent
    return directory / "panel-journal.jsonl"


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
        journal_path=panel_journal_path(questions_path),
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


class _OptionBlock(NamedTuple):
    """One option line's match, its body, and the lines it spans."""

    match: re.Match
    body: str
    first: int
    end: int


class QuestionOptions(NamedTuple):
    """Selector mode, parsed options, and a fallback reason when unavailable."""

    kind: str | None
    options: tuple
    reason: str | None


# Options are list items: "- A. label" (single) or "- [ ] label" (multi); the older
# unlisted "A. label" still parses.
_SINGLE_OPTION = re.compile(r"^(?P<listed>- )?(?P<key>[A-Z])\.\s+(?P<label>\S.*)$")


_MULTI_OPTION = re.compile(r"^(?P<listed>- )\[[ xX]\]\s+(?P<label>\S.*)$")


_RECOMMENDATION = re.compile(r"(?:\A|\n[ \t]*\n)(?P<recommendation>➡\ufe0f?)")


_DETAILS_START = "【詳細資訊】"


_DETAILS_END = "【詳細資訊結束】"


_DETAILS_MARKER = re.compile(
    rf"^(?P<marker>{_DETAILS_START}|{_DETAILS_END})[ \t]*$", re.MULTILINE
)


def _split_details(body):
    """Return ``(body without the details block, details or None)``.

    An unbalanced or out-of-order marker pair is left in the body as text;
    ``question upsert`` refuses such input before it is written.
    """
    markers = list(_DETAILS_MARKER.finditer(body))
    if (
        len(markers) != 2
        or markers[0].group("marker") != _DETAILS_START
        or markers[1].group("marker") != _DETAILS_END
    ):
        return body, None
    start, end = markers
    details = body[start.end():end.start()].strip("\n")
    before = body[:start.start()].rstrip("\n")
    after = body[end.end():].lstrip("\n")
    return (before + "\n\n" + after if before and after else before or after), details


def _check_details_markers(body):
    markers = [marker.group("marker") for marker in _DETAILS_MARKER.finditer(body)]
    if markers and markers != [_DETAILS_START, _DETAILS_END]:
        raise ValueError(
            f"details block needs one {_DETAILS_START} line followed by one {_DETAILS_END} line"
        )
    if markers and not _split_details(body)[1].strip():
        raise ValueError(f"details block between {_DETAILS_START} and {_DETAILS_END} is empty")


def question_details(question):
    """Read the text inside the details markers, or ``None`` without a block."""
    return _split_details(question.get("body") or "")[1]


_VISUAL_MARKER = "【示意】"


# The links are the body's last lines, so the same words elsewhere stay text.
_VISUAL_LINES = re.compile(rf"(?:^{_VISUAL_MARKER}.*\n*)+\Z", re.MULTILINE)


def visual_link_error(url):
    """Why ``url`` cannot be a question's demo link, or ``None``."""
    try:
        parts = urlsplit(url)
        host = parts.hostname
    except ValueError:
        return f"not a valid http or https link: {url!r}"
    if parts.scheme not in ("http", "https") or not host:
        return f"only http and https links are accepted: {url!r}"
    if " " in url or not url.isprintable():
        return f"http or https link has spaces or control characters: {url!r}"
    return None


def _written_visuals(body):
    match = _VISUAL_LINES.search(_normalize_newlines(_split_details(body)[0]))
    lines = match.group().split("\n") if match else []
    return [line.removeprefix(_VISUAL_MARKER).strip() for line in lines if line]


def _check_visual_links(urls):
    for url in urls:
        error = visual_link_error(url)
        if error:
            raise ValueError(f"demo link refused: {error}")


def add_visual_links(text, urls):
    """Append ``urls`` to one question's section text as its last lines."""
    if not urls:
        return text
    _check_visual_links(urls)
    lines = "\n".join(_VISUAL_MARKER + url for url in urls)
    return f"{text.rstrip()}\n\n{lines}\n"


def question_visuals(question):
    """The question's http and https demo links, in the order written."""
    return [url for url in _written_visuals(question.get("body") or "")
            if visual_link_error(url) is None]


def _question_display_parts(question):
    """Split an unindented arrow paragraph from selectable content."""
    body = _split_details(question.get("body") or "")[0]
    visuals = _VISUAL_LINES.search(body)
    if visuals:
        body = body[:visuals.start()].rstrip("\n")
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


def _option_blocks(lines, pattern):
    """Yield an ``_OptionBlock`` for each option line.

    A list-item option owns every following blank or indented line up to the
    next unindented one, as Markdown nests them, dedented and without trailing
    blank lines. An unlisted ``A.`` option owns only the indented lines right
    under it, each stripped.
    """
    index = 0
    while index < len(lines):
        match = pattern.match(lines[index])
        if match is None:
            index += 1
            continue
        listed = bool(match.group("listed"))
        end = index + 1
        while end < len(lines) and (lines[end][:1].isspace() or (listed and not lines[end])):
            end += 1
        while end > index + 1 and not lines[end - 1].strip():
            end -= 1
        owned = lines[index + 1:end]
        body = (
            textwrap.dedent("\n".join(owned)) if listed
            else "\n".join(line.strip() for line in owned)
        )
        yield _OptionBlock(match, body, index, end)
        index = end


def _option_items(lines, pattern, *, keyed):
    return tuple(
        QuestionOption(
            block.match.group("key") if keyed else None,
            block.match.group("label").strip(),
            block.body,
        )
        for block in _option_blocks(lines, pattern)
    )


def parse_question_options(question):
    """Parse selector options from one ``parse_questions`` result.

    ``- A.`` (or older ``A.``) lines produce single-select options and
    checklist lines produce multi-select options; each option's ``impact`` is
    the Markdown under it. Mixed or absent styles deliberately fall back to
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
    """Return the body without the option lines and bodies the selector lists."""
    lines = _question_display_parts(question)[0].splitlines()
    kind = parse_question_options(question).kind
    if kind is None:
        return "\n".join(lines).strip("\n")
    pattern = _SINGLE_OPTION if kind == "single" else _MULTI_OPTION
    owned = set()
    for block in _option_blocks(lines, pattern):
        owned.update(range(block.first, block.end))
    kept = []
    for number, line in enumerate(lines):
        if number in owned:
            continue
        if line or (kept and kept[-1]):
            kept.append(line)
    return "\n".join(kept).strip("\n")


# A fence opens with three or more ` or ~ (a ` fence's info string has no `) and closes
# on a line of the same character, at least as long, with nothing after it.
_FENCE_OPEN = re.compile(r"^[ \t]*(?P<fence>`{3,}(?=[^`]*$)|~{3,})")


_HEADING_MARK = re.compile(r"^([ \t]*)#{1,6}[ \t]+")


_INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)(.+?)(?<!`)\1(?!`)")


_LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")


# Emphasis marks around text; `*` may sit inside CJK words but not between ASCII letters or digits,
# `_` only outside words, so 2*3*4 and snake_case stay as written.
_EMPHASIS = (
    re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*"),
    re.compile(r"(?<!\w)__(?=\S)(.+?)(?<=\S)__(?!\w)"),
    re.compile(r"~~(?=\S)(.+?)(?<=\S)~~"),
    re.compile(r"(?<![0-9A-Za-z*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![0-9A-Za-z*])"),
    re.compile(r"(?<!\w)_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)"),
)


def _plain_inline(text):
    text = _LINK.sub(r"\1 (\2)", text)
    for pattern in _EMPHASIS:
        text = pattern.sub(r"\1", text)
    return text.replace("**", "")


def _code_span(text):
    """A code span's text: one space is trimmed from each end when both ends have one."""
    return text[1:-1] if len(text) > 2 and text[0] == text[-1] == " " and text.strip() else text


def plain_markdown(text):
    """Drop Markdown marks: emphasis, backticks, code fence lines, heading marks, link syntax.

    Code keeps its text as written; list markers, indentation and emoji stay.
    """
    kept = []
    fence = None
    for line in text.splitlines():
        if fence:
            if re.fullmatch(rf"[ \t]*{re.escape(fence[0])}{{{len(fence)},}}[ \t]*", line):
                fence = None
            else:
                kept.append(line)
            continue
        opening = _FENCE_OPEN.match(line)
        if opening:
            fence = opening.group("fence")
            continue
        # Code spans become placeholders, so emphasis around them is still found
        # and their own text is put back untouched.
        codes = []
        def hold(code):
            codes.append(_code_span(code.group(2)))
            return f"\ue000{len(codes) - 1}\ue001"
        line = _plain_inline(_INLINE_CODE.sub(hold, _HEADING_MARK.sub(r"\1", line)))
        kept.append(re.sub("\ue000([0-9]+)\ue001", lambda held: codes[int(held.group(1))], line))
    return "\n".join(kept)


def question_plain_text(question):
    """The question as plain text in 聊天提問格式 order, for the turn-end hook to show.

    Title line, background, options with their letters and indented content,
    the ``➡️`` paragraph, then the details block, separated by blank lines.
    """
    blocks = [f"❓ {question['id']} r{question['revision']} - {plain_markdown(question['title'])}"]
    context = question_context(question)
    if context:
        blocks.append(plain_markdown(context))
    visuals = question_visuals(question)
    if visuals:
        blocks.append("\n".join(f"看示意：{url}" for url in visuals))
    parsed = parse_question_options(question)
    if parsed.options:
        lines = ["（複選題，可選多項）"] if parsed.kind == "multi" else []
        for letter, option in zip(_option_letters(parsed), parsed.options):
            lines.append(f"{letter}. {option.label}" if letter else option.label)
            lines += [f"  {line}" if line.strip() else ""
                      for line in option.impact.splitlines()]
        blocks.append(plain_markdown("\n".join(lines)))
    recommendation = question_recommendation(question)
    if recommendation:
        blocks.append(plain_markdown(recommendation))
    details = question_details(question)
    if details is not None:
        blocks.append(f"{_DETAILS_START}\n{plain_markdown(details)}\n{_DETAILS_END}")
    return "\n\n".join(blocks)


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
            panel_journal_path(questions_path),
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
            panel_journal_path(questions_path),
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
    body = (match.group("body") or "").strip("\n")
    _check_details_markers(body)
    _check_visual_links(_written_visuals(body))
    return {"title": match.group("title"), "body": body}


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


_DONE_OPTION = "已完成"


def _check_help_question(decisions_path, question_id, incoming):
    """A help question must let the user answer with a single-choice 已完成 option."""
    try:
        kind = read_decision_kind(Path(decisions_path) / f"{question_id}.md")
    except FileNotFoundError:
        return
    if kind == "help":
        check_done_option(question_id, incoming)


def check_done_option(question_id, incoming):
    """Refuse a help question body without a single-choice 已完成 option."""
    options = parse_question_options({"body": incoming["body"]})
    if options.kind != "single" or not any(
        _answer_label(option.label) == _DONE_OPTION for option in options.options
    ):
        raise ValueError(
            f"help question {question_id} needs a single-choice option: - <letter>. {_DONE_OPTION}"
        )


def upsert_question(questions_path, question_id, section_text, *, decisions_path):
    """Add or update one question under the shared lock; return its revision."""
    return upsert_question_written(
        questions_path, question_id, section_text, decisions_path=decisions_path
    )[0]


def upsert_question_written(questions_path, question_id, section_text, *, decisions_path,
                            first_revision=1):
    """Like ``upsert_question``; also return whether a new question or revision was written.

    A question not in the file starts at ``first_revision``.
    """
    questions_path = Path(questions_path)
    incoming = _question_input(section_text)
    if not Path(decisions_path).is_dir():
        raise ValueError(f"decisions directory does not exist: {decisions_path}")
    _check_help_question(decisions_path, question_id, incoming)
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
            revision = first_revision
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
                return revision, False
        _replace_locked(questions_path, updated)
        try:
            _append_journal(
                panel_journal_path(questions_path),
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
        return revision, True


def set_question_status(
    questions_path, question_id, revision, status, expected_section_sha256, *, now=None
):
    """Set status only when the revision and current section hash both match."""
    if status != "recorded":
        raise ValueError("the controller may only set status to recorded")
    questions_path = Path(questions_path)
    with _path_lock(questions_path):
        _set_recorded_locked(
            questions_path, question_id, revision, expected_section_sha256, now=now
        )


def _set_recorded_locked(
    questions_path, question_id, revision, expected_section_sha256, *, now=None,
    auto_recorded=False,
):
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
    details = {
        "questions_path": _question_key(questions_path),
        "recorded_question": question_id,
        "recorded_revision": revision,
        "recorded_at": recorded_at,
        "recorded_section_sha256": _full_section_sha256(recorded_section),
    }
    if auto_recorded:
        details["auto_recorded"] = True
    _append_journal(
        panel_journal_path(questions_path),
        document,
        updated,
        kind="set-status",
        details=details,
        now=now,
    )


ANSWERED_STATUS = "answered"


def _indented(text):
    """Continuation lines of a list item, so none of them reads as a record field."""
    return re.sub(r"\n(?=[^\n])", "\n  ", text)


def _write_decision_answer(decision_path, section, answer, note, *, channel, source,
                           recorded_by, now=None):
    """Append one answer to a pending decision record and mark it answered.

    ``channel`` (面板 or 聊天) heads the section and the source line; panel and chat
    answers share every other line. Returns the record's ``(previous, written)``
    text, for ``_restore_decision``.
    """
    if not decision_path.parent.is_dir():
        raise ValueError(f"decisions directory does not exist: {decision_path.parent}")
    if not decision_path.exists():
        raise ValueError(f"decision record not found: {decision_path}")
    with _path_lock(decision_path):
        text = _read_text_exact(decision_path)
        status = read_decision_status(decision_path)
        if status.error:
            raise ValueError(f"decision record status unreadable: {status.error}")
        if status.status != "pending":
            raise ValueError(f"decision record is not pending (status: {status.status})")
        version = _record_revision(text)
        if version is not None and version != section["revision"]:
            raise ValueError(
                f"decision record is at r{version}, question at r{section['revision']}"
            )
        status_line = re.search(r"^- status:.*$", text, re.MULTILINE | re.IGNORECASE)
        lines = [
            f"## 答覆（r{section['revision']}，{channel}，{_iso_time(now)}）",
            "",
            f"- 題目：{section['id']} r{section['revision']}",
            f"- 答覆：{_indented(answer)}",
        ]
        if note:
            lines.append(f"- 備註：{_indented(note)}")
        lines += [
            f"- 來源：{channel}，{source}",
            f"- 記錄：{recorded_by}；答覆的意思與核准範圍由主控判斷後補寫",
        ]
        updated = (
            text[:status_line.start()] + f"- status: {ANSWERED_STATUS}" + text[status_line.end():]
        ).rstrip("\n") + "\n\n" + "\n".join(lines) + "\n"
        _replace_locked(decision_path, updated)
        return text, updated


def set_decision_preauth(decision_path, verdict_line, *, now=None):
    """Write the recheck result as the record's ``- preauth:`` line, for reading only.

    Replaces the first ``- preauth:`` line, else goes right after the ``- action:`` line.
    """
    decision_path = Path(decision_path)
    line = f"- preauth: {verdict_line}（重查於 {_iso_time(now)}）"
    with _path_lock(decision_path):
        text = _read_text_exact(decision_path)
        old = re.search(r"^- preauth:.*$", text, re.MULTILINE | re.IGNORECASE)
        if old is None:
            old = re.search(r"^- action:.*$", text, re.MULTILINE | re.IGNORECASE)
            if old is None:
                raise ValueError(f"decision record has no - action: line: {decision_path}")
            updated = text[:old.end()] + "\n" + line + text[old.end():]
        else:
            updated = text[:old.start()] + line + text[old.end():]
        _replace_locked(decision_path, updated)


def _restore_decision(decision_path, written, previous):
    """Undo ``_write_decision_answer`` unless the record changed since."""
    with _path_lock(decision_path):
        if _read_text_exact(decision_path) != written:
            return False
        _replace_locked(decision_path, previous)
        return True


def _record_submitted_answers(questions_path, question_ids, decisions_path, unknown, *, now=None):
    """Record each submitted answer in its decision record and mark the question recorded.

    Each answer gets the same check as ``question_provenance``; its verbatim
    answer, note and source are appended to the bound controller's
    ``<decisions>/<ID>.md``, whose status becomes ``answered``. Returns one
    outcome per ID with ``id``, ``revision``, ``answer``, ``note`` and
    ``recorded``; an answer that is not recorded stays submitted and its
    outcome has a ``reason``, also journaled for the notification. Never
    raises: what the answer means is left to the controller.
    """
    questions_path = Path(questions_path)
    journal_path = panel_journal_path(questions_path)
    outcomes = []
    try:
        with _path_lock(questions_path):
            for question_id in question_ids:
                outcomes.append(_record_answer_locked(
                    questions_path, journal_path, question_id, decisions_path, unknown, now
                ))
            failed = {
                item["id"]: {"reason": item["reason"], "section_sha256": item["section_sha256"]}
                for item in outcomes if not item["recorded"] and "section_sha256" in item
            }
            if failed:
                document = _read_text_exact(questions_path)
                _append_journal(
                    journal_path, document, document, kind="auto-record",
                    details={"questions_path": _question_key(questions_path),
                             "not_recorded": failed},
                    now=now, panel_write=False,
                )
    except (OSError, ValueError) as error:
        done = {item["id"] for item in outcomes}
        outcomes += [
            {"id": question_id, "recorded": False, "reason": str(error)}
            for question_id in question_ids if question_id not in done
        ]
    for item in outcomes:
        item.pop("section_sha256", None)
    return outcomes


def _record_answer_locked(questions_path, journal_path, question_id, decisions_path, unknown, now):
    try:
        section = _question_section(_read_text_exact(questions_path), question_id)
    except (OSError, ValueError) as error:
        return {"id": question_id, "recorded": False, "reason": str(error)}
    answer, note = _answer_text_and_note(section["answer"] or "")
    outcome = {
        "id": question_id, "revision": section["revision"], "answer": answer, "note": note,
        "recorded": False, "section_sha256": _section_sha256(section),
    }
    try:
        if decisions_path is None:
            raise ValueError(unknown)
        proof = question_provenance(questions_path, journal_path, question_id)
        decision_path = decisions_path / f"{question_id}.md"
        previous, written = _write_decision_answer(
            decision_path, section, answer, note, channel="面板",
            source=f"{proof['journal_path']} 第 {proof['journal_line']} 行，"
                   f"time {proof['time']}，section_sha256 {proof['section_sha256']}",
            recorded_by="送出時由 lat-panel 自動記錄", now=now)
    except (OSError, ValueError, AttributeError, TypeError) as error:
        # The last two: a journal line that is JSON but not an entry.
        outcome["reason"] = str(error)
        return outcome
    try:
        _set_recorded_locked(
            questions_path, question_id, section["revision"], proof["section_sha256"],
            now=now, auto_recorded=True,
        )
    except (OSError, ValueError) as error:
        # Put the record back to pending, so the manual steps can record this answer.
        try:
            restored = _restore_decision(decision_path, written, previous)
        except OSError:
            restored = False
        outcome["reason"] = f"the question could not be marked recorded: {error}" + (
            "" if restored else f"; {decision_path} already has the answer and status answered"
        )
        return outcome
    outcome["recorded"] = True
    return outcome


def record_chat_answer(questions_path, decisions_path, question_id, text, source, *, now=None):
    """Record a chat answer the way a panel submit is recorded, then mark the question.

    The question's current section is read once under the questions lock; the record
    must be pending at the same revision, and the question is marked recorded only if
    that section is unchanged, else the record is put back. ``text`` is kept verbatim.
    """
    if not text.strip():
        raise ValueError("--text must not be blank")
    if not source.strip():
        raise ValueError("--source must not be blank")
    questions_path = Path(questions_path)
    decision_path = Path(decisions_path) / f"{question_id}.md"
    with _path_lock(questions_path):
        document = _read_text_exact(questions_path)
        section = _question_section(document, question_id)
        if section["status"] == "recorded":
            raise ValueError(f"question {question_id} r{section['revision']} is already recorded")
        section_sha256 = _section_sha256(section)
        previous, written = _write_decision_answer(
            decision_path, section, text, "", channel="聊天",
            source=f"{source}，section_sha256 {section_sha256}",
            recorded_by="由 question record-chat 記錄", now=now)
        try:
            _set_recorded_locked(questions_path, question_id, section["revision"],
                                 section_sha256, now=now)
        except (OSError, ValueError) as error:
            # The mark may be written with its journal entry missing; undo both halves.
            if _read_text_exact(questions_path) != document:
                _replace_locked(questions_path, document)
            if not _restore_decision(decision_path, written, previous):
                raise ValueError(f"the question could not be marked recorded: {error}; "
                                 f"{decision_path} already has the answer") from error
            raise
    return {"id": question_id, "revision": section["revision"], "status": ANSWERED_STATUS,
            "section_sha256": section_sha256}


def _decision_fields(text):
    """The decision record's ``- key: value`` lines as ``{key: (start, end)}``, first one wins."""
    fields = {}
    for match in re.finditer(r"^- ([a-z ]+):.*$", text, re.MULTILINE | re.IGNORECASE):
        fields.setdefault(match.group(1).lower(), (match.start(), match.end()))
    return fields


def new_decision_record(question_id, incoming, *, advisor, session_id, question=None,
                        authority_gap=None, blocked_work=None, help_question=False):
    """The text of a new pending decision record for ``question ask``, at r1.

    Unset fields default from the question: its title and its option letters and labels.
    """
    options = parse_question_options({"body": incoming["body"]})
    listed = " / ".join(
        f"{letter} {option.label}".strip()
        for letter, option in zip(_option_letters(options), options.options)
    ) if options.kind else "自由作答"
    # The advisor line sits right below the status line (references/advisors.md).
    lines = [f"# {question_id} {incoming['title']}", "", "- status: pending",
             f"- advisor: {advisor}"]
    if help_question:
        lines.append("- kind: help")
    if session_id:
        lines.append(f"- session: {session_id}")
    lines += [
        "- version: r1",
        f"- question: {question or incoming['title']}",
        f"- options: {listed}",
        f"- authority gap: {authority_gap or '需使用者決定'}",
        f"- blocked work: {blocked_work or '未指定'}",
    ]
    return "\n".join(lines) + "\n"


def _record_revision(text):
    """A record text's ``- version: r<N>`` number, or None without a readable one."""
    match = re.search(r"^- version:\s*r([0-9]+)\b", text, re.MULTILINE | re.IGNORECASE)
    return int(match.group(1)) if match else None


def decision_revision(decision_path):
    return _record_revision(_read_text_exact(decision_path))


def sync_decision_record(decision_path, revision, *, reopen=False, help_question=False):
    """Set the record's version line to the panel revision; optionally reopen it or mark help.

    ``reopen`` sets the status back to pending; ``help_question`` makes the kind line
    ``- kind: help``, adding it after the advisor line (else the status line).
    """
    decision_path = Path(decision_path)
    with _path_lock(decision_path):
        text = _read_text_exact(decision_path)
        edits = []
        fields = _decision_fields(text)
        status = fields.get("status")
        if status is None:
            raise ValueError(f"decision record has no - status: line: {decision_path}")
        if reopen:
            edits.append((*status, "- status: pending"))
        if help_question and "kind" in fields:
            edits.append((*fields["kind"], "- kind: help"))
        elif help_question:
            after = fields.get("advisor", status)[1]
            edits.append((after, after, "\n- kind: help"))
        version = fields.get("version")
        if version is None:
            edits.append((status[1], status[1], f"\n- version: r{revision}"))
        else:
            edits.append((*version, f"- version: r{revision}"))
        for start, end, replacement in sorted(edits, key=lambda edit: edit[:2], reverse=True):
            text = text[:start] + replacement + text[end:]
        _replace_locked(decision_path, text)


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


def remove_empty_questions(questions_path, decisions_path):
    """Clean one file, then delete it when no question section is left in it.

    Returns whether it was deleted; its archive and lock files stay.
    """
    questions_path = Path(questions_path)
    if not Path(decisions_path).is_dir():
        raise ValueError(f"decisions directory does not exist: {decisions_path}")
    with _path_lock(questions_path):
        try:
            document = _read_text_exact(questions_path)
        except FileNotFoundError:
            return False
        updated, _ = _cleanup_locked(questions_path, decisions_path, document)
        if parse_questions(updated):
            return False
        questions_path.unlink()
        return True


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


def _decision_withdrawn(decision_path):
    try:
        status = read_decision_status(decision_path)
    except (OSError, UnicodeError):
        return False
    return status.error is None and status.status == "withdrawn"


def _cleanup_locked(questions_path, decisions_path, document, *, exclude_id=None):
    """Clean a snapshot while the caller holds the questions-file lock."""
    journal_path = panel_journal_path(questions_path)
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
        elif _decision_withdrawn(Path(decisions_path) / f"{identifier}.md"):
            # Withdrawn questions leave even with a submitted answer; the archive keeps it.
            reason = "withdrawn"
        elif section["checked"] or section["malformed_submission"]:
            reason = "submitted-not-recorded"
        else:
            reason = _decision_state(Path(decisions_path) / f"{identifier}.md")
        if reason in ("recorded", "decision-not-pending", "withdrawn"):
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


def _lat_directories(questions_path):
    """The ``.lat`` of this file and, in a Git repository, of every checkout of it.

    New files are in the main checkout's shared ``.lat``; older bindings of a linked
    worktree kept their root files in that worktree's own ``.lat``.
    """
    lat = panel_journal_path(questions_path).parent
    directories = [lat.resolve()]
    try:
        output = run_cli(["git", "-C", str(lat.parent), "worktree", "list", "--porcelain"],
                         timeout=10)
    except ValueError:
        return directories
    for line in output.splitlines():
        if line.startswith("worktree "):
            directories.append((Path(line.removeprefix("worktree ")) / ".lat").resolve())
    return list(dict.fromkeys(directories))


def _question_files(questions_path):
    """Every question and archive file in the ``.lat`` of this file and its checkouts."""
    # Root files are the older place, ``questions/`` the current one; both are read.
    return sorted(
        path for directory in _lat_directories(questions_path)
        for pattern in ("questions-*.md", f"{QUESTIONS_DIR}/*.md")
        for path in directory.glob(pattern)
    )


def _file_question_ids(path):
    return {question["id"] for question in parse_questions(_read_text_exact(path))}


def foreign_decision_ids(questions_path, decisions_path, session_id):
    """Decisions that demonstrably belong to another controller.

    A decision is this controller's when its ``- session:`` is ``session_id`` or its
    question is in ``questions_path`` or that file's archive. Otherwise it is
    another's when its ``- session:`` names a different session, or its question is
    in another controller's question or archive file. Decisions with no owner
    evidence are not returned. ``questions_path`` None (no panel binding) means no
    own file, and question files are not read.
    """
    own = set()
    others = set()
    if questions_path is not None:
        questions_path = Path(questions_path)
        own_files = [questions_path, _archive_path(questions_path)]
        for path in own_files:
            if path.exists():
                own |= _file_question_ids(path)
        own_resolved = {path.resolve() for path in own_files}
        for path in _question_files(questions_path):
            if path.resolve() not in own_resolved:
                others |= _file_question_ids(path)
    foreign = set()
    for decision in Path(decisions_path).glob("*.md"):
        if decision.stem in own:
            continue
        try:
            session = read_decision_session(decision)
        except (OSError, UnicodeError):
            continue
        if session != session_id and (session is not None or decision.stem in others):
            foreign.add(decision.stem)
    return foreign


def pending_question_gaps(questions_path, decisions_path, *, session_id=None):
    """Check pending decisions and stale questions in this file.

    With ``session_id`` decisions of other controllers (``foreign_decision_ids``)
    are skipped; decisions with no owner evidence are still checked. Without it
    every decision in the shared directory is checked.
    """
    questions_path = Path(questions_path)
    decisions_path = Path(decisions_path)
    if not decisions_path.is_dir():
        raise ValueError(f"decisions directory does not exist: {decisions_path}")
    foreign = (foreign_decision_ids(questions_path, decisions_path, session_id)
               if session_id is not None else set())
    pending_ids = []
    unreadable = []
    for decision in sorted(decisions_path.glob("*.md")):
        if decision.stem in foreign:
            continue
        try:
            status = read_decision_status(decision)
        except (OSError, UnicodeError) as error:
            unreadable.append((decision, str(error)))
            continue
        if status.error:
            unreadable.append((decision, status.error))
        elif status.status == "pending":
            pending_ids.append(decision.stem)

    files = _question_files(questions_path)
    current = {}
    for path in files:
        if path.stem.endswith("-archive"):
            continue
        for question in parse_questions(path.read_text(encoding="utf-8")):
            current.setdefault(question["id"], []).append((path, question))
    archived = {}
    for path in (path for path in files if path.stem.endswith("-archive")):
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
    journal_path = panel_journal_path(questions_path)
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


def resolve_help(decisions_path, question_id, evidence, location, *, now=None):
    """Close a pending help record the controller verified itself."""
    path = Path(decisions_path) / f"{question_id}.md"
    if not evidence.strip() or not location.strip():
        raise ValueError("--evidence and --location must not be empty")
    if read_decision_kind(path) != "help":
        raise ValueError(f"{question_id} is not a help record (- kind: help)")
    status = read_decision_status(path)
    if status.error or status.status != "pending":
        raise ValueError(f"{question_id} is not pending")
    with _path_lock(path):
        text = _read_text_exact(path)
        status_line = re.search(r"^- status:.*$", text, re.MULTILINE | re.IGNORECASE)
        updated = (
            text[:status_line.start()] + "- status: self-verified" + text[status_line.end():]
        ).rstrip("\n") + (
            f"\n\n## 主控查證\n- 查證：{evidence.strip()}\n- 位置：{location.strip()}\n"
            f"- 時間：{_iso_time(now)}\n"
        )
        _replace_locked(path, updated)


def withdraw_question(decisions_path, question_id, reason, source, *, now=None):
    """Withdraw a pending record whose question no longer applies, keeping why and on what."""
    path = Path(decisions_path) / f"{question_id}.md"
    if not reason.strip() or not source.strip():
        raise ValueError("--reason and --source must not be empty")
    if not path.is_file():
        raise ValueError(f"decision record not found: {path}")
    with _path_lock(path):
        status = read_decision_status(path)
        if status.error or status.status != "pending":
            raise ValueError(
                f"{question_id} is not pending (status: {status.status or status.error}); "
                "only a pending record can be withdrawn"
            )
        text = _read_text_exact(path)
        status_line = re.search(r"^- status:.*$", text, re.MULTILINE | re.IGNORECASE)
        updated = (
            text[:status_line.start()] + "- status: withdrawn" + text[status_line.end():]
        ).rstrip("\n") + (
            f"\n\n## 撤回\n- 原因：{_indented(reason.strip())}\n"
            f"- 依據：{_indented(source.strip())}\n- 時間：{_iso_time(now)}\n"
        )
        _replace_locked(path, updated)


def _question_key(questions_path):
    return str(Path(questions_path).expanduser().resolve())


_RECOMMENDED = "（建議）"


def _answer_label(label):
    """Option text as the panel writes it to the answer area, without 建議."""
    return label.removesuffix(_RECOMMENDED).rstrip()


def _option_letters(parsed):
    """Option letters per 題目格式: the file's keys, or A, B, … with none past Z."""
    if parsed.kind == "single":
        return [option.key for option in parsed.options]
    return [
        chr(ord("A") + index) if index < 26 else ""
        for index in range(len(parsed.options))
    ]


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
        and isinstance(item.get("tag"), str)
        and item["tag"] in _REPORT_TAGS
    ):
        return None
    try:
        time = datetime.fromisoformat(item["time"])
    except ValueError:
        return None
    return time if time.tzinfo else time.replace(tzinfo=timezone.utc)


def _report_expired(path, now):
    """Whether the newest complete record in a report file is past retention. A file
    without one, or one that is gone, is not; one that cannot be read raises OSError."""
    try:
        with path.open("rb") as stream:
            times = [time for time in map(_report_time, stream) if time is not None]
    except FileNotFoundError:
        return False
    return bool(times) and now - max(times) >= REPORT_RETENTION


def prune_reports(directory, now, sessions):
    """Delete the ``<session-id>.jsonl`` report file in ``directory``, and the
    ``<session-id>.duty.json`` duty file beside it, of each of
    ``sessions`` whose newest complete record was issued ``REPORT_RETENTION`` or
    more before ``now``. Only the sessions the caller names are looked at: the
    board clears their read and archive state before it asks.

    Each file is checked again while holding ``<session-id>.lock`` without
    waiting, the lock the turn-end hook appends under; a busy lock leaves the file
    for a later run. The lock file is never deleted: a hook already waiting on it
    and one arriving after the deletion must keep sharing the one lock. Returns
    the session IDs whose file was deleted, and ``{"session_id", "reason"}`` for
    each file that could not be read, locked or deleted for another reason; those
    are left for a later run and do not stop the others.
    """
    directory = Path(directory)
    deleted, failed = [], []
    for session_id in sessions:
        path = directory / f"{session_id}.jsonl"
        if path.parent != directory or not session_id or session_id.startswith("."):
            failed.append({"session_id": session_id, "reason": "not a report file name"})
            continue
        try:
            if not _report_expired(path, now):
                continue
            with path.with_suffix(".lock").open("a") as lock:
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                if _report_expired(path, now):
                    path.unlink()
                    directory.joinpath(f"{session_id}.duty.json").unlink(missing_ok=True)
                    deleted.append(session_id)
        except OSError as error:
            failed.append({"session_id": session_id, "reason": str(error)})
    return deleted, failed
