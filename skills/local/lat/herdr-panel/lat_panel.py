#!/usr/bin/env python3
"""Stdlib core and controller CLI for the LAT question panel.

Public API used by the Textual panel and LAT controller:

* ``locked_replace`` performs a conditional atomic UTF-8 replacement. Pass a
  journal path for a panel save, or call ``save_panel_edit`` to use
  the ``panel-journal.jsonl`` at the ``.lat`` root (``panel_journal_path``).
* ``parse_questions``, ``upsert_question``, and ``set_question_status`` model
  and update natural-language question sections without touching other sections.
* V2 selector UI flow: ``parse_question_options``, ``question_context``,
  ``question_details``, ``question_recommendation``, ``question_plain_text``
  (what the turn-end hook shows after a DECIDE/HELP), and
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
  successful result to ``mark_submit_notification_pending``, which first runs
  ``record_submitted_answers``: each answer that passes the provenance check is
  appended to its decision record (status ``answered``) and marked recorded.
* ``question_provenance`` checks one snapshot section against the latest panel
  journal entry that changed that question.
* ``bind_controller``, ``unbind_controller``, and the binding lookup helpers
  manage per-controller routing inside a Herdr workspace.
* ``mark_notification_pending``, ``notification_is_pending``,
  ``send_pending_notification``, and ``clear_pending_notification`` provide the
  persisted notification lifecycle. ``send_pending_notification`` returns an
  ``(ok, reason)`` pair and clears state only after target delivery; it also
  notes which submitted answers that delivery covered.
* ``board_controllers``, ``board_questions``, ``board_answered``,
  ``answer_and_notify``, and ``notify_controller`` back the ``board``
  commands: the LAT board reads and answers question files only through them.
  ``answer_question`` is the write half of ``answer_and_notify``.
  ``board_transcript`` reads one page of a controller's conversation from the
  Claude or Codex session record that ``transcript_path`` finds, with the
  model and effort of the latest turn (``current_settings``).
  ``board_launch_args`` reads the arguments hcom stored for an agent's launch,
  read-only from hcom's own database. ``board_ledger`` reads a controller's
  work ledger through ``lat-ledger show --json``, from the path in its session
  record. ``prune_reports`` deletes the named
  controller report files whose newest record is past the board's retention,
  under the same lock the turn-end hook appends with.

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
  question resolve-help --questions PATH --decisions DIR --id ID \
      --evidence TEXT --location TEXT
  question withdraw --questions PATH --decisions DIR --id ID \
      --reason TEXT --source TEXT
  bind --hcom-name NAME --client CLIENT --session-id ID --workspace ROOT \
       [--herdr-workspace ID] [--herdr-tab ID] [--herdr-pane ID]
  unbind --session-id ID
  resolve (--session-id ID | [--herdr-workspace ID])
  board list
  board questions --questions PATH
  board answered [--questions PATH]... [--workspace ROOT --hcom-name NAME]...
  board answer --questions PATH --id ID --revision N \
      --expected-section-sha256 HASH [--select N]... [--text TEXT] [--note TEXT]
  board notify --questions PATH
  board transcript --client (claude|codex) --session-id ID [--before SEQ]
  board launch-args --session-id ID
  board ledger [--workspace ROOT --session-id ID]... [--seconds N]
  board prune-reports --reports-dir DIR --now TIME --session-id ID...

All commands are prefixed with ``uv run --no-project python lat_panel.py``.
Binding data uses ``HERDR_PLUGIN_CONFIG_DIR``, then
``herdr plugin config-dir lat.panel``, then the XDG config fallback. Pending
state uses ``HERDR_PLUGIN_STATE_DIR`` or the XDG state fallback. ``board``
commands print one JSON object, including on failure; only a usage error
prints argparse's message on stderr and exits 2.
"""

from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
import argparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lat_decision_status import read_decision_kind, read_decision_status
from _lat_common import plugin_directory, run_cli, write_text_atomic as _replace_locked
sys.path.insert(0, str(Path(__file__).resolve().parent))
import questions
from questions import (
    ANSWERED_STATUS,
    AnswerFormatError,
    QuestionAnswer,
    QuestionOption,
    QuestionOptions,
    REPORT_RETENTION,
    _ANSWER_MARKER,
    _ARCHIVE_HEADER,
    _DETAILS_END,
    _DETAILS_MARKER,
    _DETAILS_START,
    _DONE_OPTION,
    _EMPHASIS,
    _EMPTY_ANSWER_AREA,
    _FENCE_OPEN,
    _HEADING_MARK,
    _INLINE_CODE,
    _LINK,
    _MULTI_OPTION,
    _NOTE_LINE,
    _OptionBlock,
    _RECOMMENDATION,
    _RECOMMENDED,
    _REPORT_TAGS,
    _REPORT_TEXT_FIELDS,
    _SECTION_HEADER,
    _SINGLE_OPTION,
    _SUBMIT_MARKER,
    _answer_label,
    _answer_text_and_note,
    _append_archive,
    _append_journal,
    _archive_match,
    _archive_path,
    _archive_text,
    _check_details_markers,
    _check_help_question,
    _cleanup_locked,
    _code_span,
    _decision_state,
    _decision_withdrawn,
    _full_section_sha256,
    _indented,
    _iso_time,
    _journal_entry_matches_questions,
    _normalize_newlines,
    _option_blocks,
    _option_items,
    _option_letters,
    _path_lock,
    _plain_inline,
    _question_changes,
    _question_display_parts,
    _question_input,
    _question_key,
    _question_section,
    _question_still_matches,
    _read_text_exact,
    _record_answer_locked,
    _recorded_hashes,
    _render_section,
    _report_expired,
    _report_time,
    _restore_decision,
    _section_sha256,
    _section_text,
    _sections,
    _set_recorded_locked,
    _split_details,
    _submit_question_answers_locked,
    _write_decision_answer,
    _write_question_answer_locked,
    archive_recorded_questions,
    cleanup_questions,
    locked_replace,
    malformed_submission_ids,
    parse_question_answer,
    parse_question_options,
    panel_journal_path,
    parse_questions,
    pending_question_gaps,
    plain_markdown,
    prune_reports,
    question_context,
    question_details,
    question_plain_text,
    question_provenance,
    question_recommendation,
    question_section_sha256,
    remove_empty_questions,
    render_answer_area,
    resolve_help,
    save_panel_edit,
    set_question_status,
    submit_question_answers,
    upsert_question,
    upsert_question_written,
    withdraw_question,
    write_question_answer,
)
import bindings
from bindings import (
    LegacyBindingsError,
    STATUS_SOURCE,
    _UNCONDITIONAL_CLEAR,
    _binding_decisions_path,
    _bindings_path,
    _bound_decisions_path,
    _delivered_hashes,
    _delivered_path,
    _delivered_targets,
    _hcom_receipt_names,
    _notification_message,
    _notification_path,
    _owed_answers,
    _read_bindings,
    _read_delivered,
    _read_pending,
    _record_delivered,
    _report_display,
    _run_herdr,
    _safe_controller_name,
    _send_notification,
    _show_notification,
    _submitted_after,
    _submitted_answers,
    _undelivered_answers,
    _write_bindings,
    _write_delivered,
    _write_pending,
    bind_controller,
    clear_pending_notification,
    clear_status_display,
    controller_questions_path,
    legacy_questions_path,
    list_bindings,
    mark_notification_pending,
    mark_submit_notification_pending,
    new_questions_path,
    notification_is_pending,
    panel_enabled,
    record_submitted_answers,
    refresh_status_display,
    resolve_binding,
    resolve_session_binding,
    send_pending_notification,
    status_counts,
    status_text,
    unbind_controller,
)
import transcript
from transcript import (
    TRANSCRIPT_PAGE_TEXTS,
    _CLAUDE_TOOLS,
    _CLIENT_WRAPPER,
    _COMMAND_WRAPPER,
    _HCOM_DELIVERY,
    _INJECTED_INPUT,
    _PROGRAM,
    _RecordError,
    _SAFE_ASSIGNMENT,
    _SAFE_COMMAND,
    _SESSION_ID,
    _SHELLS,
    _SUMMARY_LIMIT,
    _SubAgentThread,
    _amount,
    _claude_current,
    _claude_human_text,
    _claude_items,
    _claude_permission,
    _claude_tool,
    _claude_user_text,
    _codex_command,
    _codex_current,
    _codex_item,
    _codex_items,
    _codex_permission,
    _codex_text,
    _codex_usage,
    _command_summary,
    _each_record,
    _injected,
    _notice,
    _one_line,
    _read_records,
    _shown_path,
    _text_field,
    _tool,
    _transcript_root,
    _unknown_args,
    board_launch_args,
    board_transcript,
    current_settings,
    transcript_path,
)
import board
from board import (
    LEDGERS_SECONDS,
    _answered_entry,
    _answered_questions,
    _asked_times,
    _board_answer,
    _board_question,
    _notification_owed,
    _unique_sections,
    answer_and_notify,
    answer_question,
    board_answered,
    board_controllers,
    board_ledger,
    board_ledgers,
    board_questions,
    notify_controller,
)
import subprocess


def _run_board(args):
    try:
        if args.board_command == "list":
            result, code = {"controllers": board_controllers()}, 0
        elif args.board_command == "questions":
            result, code = {"questions": board_questions(args.questions)}, 0
        elif args.board_command == "answered":
            if len(args.workspace) != len(args.hcom_name):
                raise ValueError("each --workspace needs one --hcom-name")
            result = {"files": board_answered(
                args.questions, list(zip(args.workspace, args.hcom_name))
            )}
            code = 0
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
        elif args.board_command == "ledger":
            if len(args.workspace) != len(args.session_id):
                raise ValueError("each --workspace needs one --session-id")
            result = {"ledgers": board_ledgers(list(zip(args.workspace, args.session_id)), args.seconds)}
            code = 0
        elif args.board_command == "prune-reports":
            now = datetime.fromisoformat(args.now)
            if now.tzinfo is None:
                raise ValueError("--now must include a time zone")
            deleted, failed = prune_reports(args.reports_dir, now, args.session_id)
            result, code = {"status": "ok", "deleted": deleted, "failed": failed}, 0
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
    upsert.add_argument("--questions", required=True, type=Path)
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
    set_status.add_argument("--questions", required=True, type=Path)
    set_status.add_argument("--id", required=True)
    set_status.add_argument("--revision", required=True, type=int)
    set_status.add_argument(
        "--status", required=True, choices=("recorded",)
    )
    set_status.add_argument("--expected-section-sha256", required=True)
    archive_recorded = question_commands.add_parser("archive-recorded")
    archive_recorded.add_argument(
        "--questions", required=True, type=Path
    )
    archive_recorded.add_argument("--older-than", type=float, default=300)
    cleanup = question_commands.add_parser("cleanup")
    cleanup.add_argument("--questions", required=True, type=Path)
    cleanup.add_argument("--decisions", required=True, type=Path)
    resolve_help_parser = question_commands.add_parser("resolve-help")
    resolve_help_parser.add_argument("--questions", required=True, type=Path)
    resolve_help_parser.add_argument("--decisions", required=True, type=Path)
    resolve_help_parser.add_argument("--id", required=True)
    resolve_help_parser.add_argument("--evidence", required=True)
    resolve_help_parser.add_argument("--location", required=True)
    withdraw = question_commands.add_parser("withdraw")
    withdraw.add_argument("--questions", required=True, type=Path)
    withdraw.add_argument("--decisions", required=True, type=Path)
    withdraw.add_argument("--id", required=True)
    withdraw.add_argument("--reason", required=True)
    withdraw.add_argument("--source", required=True)
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
    answered = board_commands.add_parser("answered")
    answered.add_argument("--questions", type=Path, action="append", default=[])
    answered.add_argument("--workspace", action="append", default=[])
    answered.add_argument("--hcom-name", action="append", default=[])
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
    ledger = board_commands.add_parser("ledger")
    ledger.add_argument("--workspace", type=Path, action="append", default=[])
    ledger.add_argument("--session-id", action="append", default=[])
    ledger.add_argument("--seconds", type=float, default=LEDGERS_SECONDS)
    prune = board_commands.add_parser("prune-reports")
    prune.add_argument("--reports-dir", required=True, type=Path)
    prune.add_argument("--now", required=True)
    prune.add_argument("--session-id", required=True, action="append")
    return parser


def _duty_reminder(decisions, question_id):
    """The controller duty line for confirmation questions; any failure means no line."""
    try:
        path = Path(__file__).resolve().parents[1] / "scripts/lat-session.py"
        spec = importlib.util.spec_from_file_location("lat_session", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.duty_reminder(decisions, question_id)
    except Exception:
        return None


def _warn_display(result):
    if result["status"] == "failed":
        print(f"lat-panel: sidebar not updated: {result['reason']}", file=sys.stderr)


def main(argv=None):
    args = _build_parser().parse_args(argv)
    if args.command == "board":
        return _run_board(args)
    try:
        if args.command == "question" and args.question_command == "upsert":
            revision, written = upsert_question_written(
                args.questions, args.id, args.file.read_text(encoding="utf-8"),
                decisions_path=args.decisions
            )
            print(f"{args.id} r{revision}")
            reminder = _duty_reminder(args.decisions, args.id)
            if reminder:
                print(reminder)
            _warn_display(refresh_status_display(args.questions, notify=written))
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
            _warn_display(refresh_status_display(args.questions))
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
            _warn_display(refresh_status_display(args.questions))
            return 0
        if args.command == "question" and args.question_command == "resolve-help":
            resolve_help(args.decisions, args.id, args.evidence, args.location)
            try:
                cleanup = (cleanup_questions(args.questions, args.decisions)
                           if args.questions.exists() else None)
            except (OSError, ValueError) as error:
                # The record is already closed; a rerun of resolve-help would refuse it.
                _warn_display(refresh_status_display(args.questions))
                print(f"lat-panel: {args.id} is self-verified but cleanup failed: {error}; "
                      "rerun question cleanup", file=sys.stderr)
                return 1
            print(json.dumps({"id": args.id, "status": "self-verified", "cleanup": cleanup},
                             ensure_ascii=False))
            _warn_display(refresh_status_display(args.questions))
            return 0
        if args.command == "question" and args.question_command == "withdraw":
            withdraw_question(args.decisions, args.id, args.reason, args.source)
            try:
                cleanup = (cleanup_questions(args.questions, args.decisions)
                           if args.questions.exists() else None)
            except (OSError, ValueError) as error:
                # The record is already withdrawn; a rerun of withdraw would refuse it.
                _warn_display(refresh_status_display(args.questions))
                print(f"lat-panel: {args.id} is withdrawn but cleanup failed: {error}; "
                      "rerun question cleanup", file=sys.stderr)
                return 1
            print(json.dumps({"id": args.id, "status": "withdrawn", "cleanup": cleanup},
                             ensure_ascii=False))
            _warn_display(refresh_status_display(args.questions))
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
