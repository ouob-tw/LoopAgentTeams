"""Controller bindings, status display and notification delivery."""

import sys
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lat_decision_status import read_decision_kind
from _lat_common import (
    plugin_directory, run_cli, shared_lat_dir, write_text_atomic as _replace_locked,
)
from questions import (
    QUESTIONS_DIR,
    _answer_text_and_note,
    _decision_state,
    _full_section_sha256,
    _journal_entry_matches_questions,
    _path_lock,
    _question_key,
    _read_text_exact,
    _record_submitted_answers,
    _section_sha256,
    _sections,
    panel_journal_path,
    parse_questions,
    question_provenance,
)


def record_submitted_answers(questions_path, question_ids, *, config_dir=None, now=None):
    """Resolve the bound decisions directory, record answers and refresh status."""
    try:
        decisions_path, unknown = _bound_decisions_path(questions_path, config_dir), None
    except (OSError, ValueError) as error:
        decisions_path, unknown = None, str(error)
    outcomes = _record_submitted_answers(
        questions_path, question_ids, decisions_path, unknown, now=now
    )
    if any(item["recorded"] for item in outcomes):
        refresh_status_display(questions_path, config_dir=config_dir)
    return outcomes


def panel_enabled(env=None):
    """Return whether this shell is in Herdr with the LAT panel enabled."""
    env = os.environ if env is None else env
    if not env.get("HERDR_WORKSPACE_ID"):
        return False
    try:
        output = run_cli(
            ["herdr", "plugin", "list", "--plugin", "lat.panel", "--json"],
            timeout=10, failure="cannot check lat.panel", env=env,
        )
        payload = json.loads(output)
    except ValueError as error:
        if isinstance(error.__cause__, FileNotFoundError):
            return False
        if isinstance(error, json.JSONDecodeError):
            raise ValueError("cannot check lat.panel: invalid JSON from herdr plugin list") from error
        raise
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


def legacy_questions_path(workspace, hcom_name):
    """The root ``.lat`` file bindings made before ``.lat/questions/``; never moved or rewritten."""
    workspace = Path(workspace).expanduser().resolve()
    return workspace / ".lat" / f"questions-{_safe_controller_name(hcom_name)}.md"


def new_questions_path(workspace, hcom_name):
    """The ``.lat/questions/`` file of this name, in the ``.lat`` every worktree shares."""
    workspace = Path(workspace).expanduser().resolve()
    return shared_lat_dir(workspace) / QUESTIONS_DIR / f"{_safe_controller_name(hcom_name)}.md"


def controller_questions_path(workspace, hcom_name):
    """The questions file a new binding of this name in this workspace gets.

    That is the ``.lat/questions/`` file, unless the older root file still has a
    question waiting for an answer or for recording: that one stays in use until
    they are done.
    """
    legacy = legacy_questions_path(workspace, hcom_name)
    try:
        open_questions = any(
            question["status_label"] == "待答"
            for question in parse_questions(legacy.read_text(encoding="utf-8"))
        )
    except FileNotFoundError:
        open_questions = False
    return legacy if open_questions else new_questions_path(workspace, hcom_name)


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
    binding = {
        "hcom_name": hcom_name,
        "client": client,
        "session_id": session_id,
        "workspace": str(workspace),
        "questions_path": None,
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
        # A session already bound is in the same round, which keeps its file.
        same_round = replaced and all(
            replaced.get(key) == binding[key] for key in ("hcom_name", "workspace")
        )
        binding["questions_path"] = (
            replaced["questions_path"] if same_round
            else str(controller_questions_path(workspace, hcom_name))
        )
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


STATUS_SOURCE = "lat.panel.status"


def status_counts(questions_path, decisions_path):
    """Count waiting questions in one file whose decision is still open: ``(decide, help)``."""
    try:
        document = _read_text_exact(Path(questions_path))
    except FileNotFoundError:
        return 0, 0
    counts = {"decide": 0, "help": 0}
    for question in parse_questions(document):
        if question["status_label"] != "待答":
            continue
        decision = Path(decisions_path) / f"{question['id']}.md"
        if _decision_state(decision) == "decision-not-pending":
            continue
        try:
            kind = read_decision_kind(decision)
        except (OSError, UnicodeError):
            kind = "decide"
        counts[kind] += 1
    return counts["decide"], counts["help"]


def status_text(hcom_name, decide, help_count):
    """Sidebar text such as ``tene ⚠待答1``; empty when nothing is waiting.

    The name is the part after the last hyphen, as in the ``lat-<name>`` tab
    label, and a count of 0 is left out so the text fits the sidebar.
    """
    parts = "".join(f"{label}{count}" for label, count in (("待答", decide), ("求助", help_count))
                    if count)
    return f"{hcom_name.rsplit('-', 1)[-1]} ⚠{parts}" if parts else ""


def _run_herdr(arguments, env=None, timeout=5):
    """Run one herdr CLI call; return ``(ok, stdout or failure reason)``."""
    try:
        return True, run_cli(["herdr", *arguments], timeout=timeout,
                             env=os.environ if env is None else env)
    except ValueError as error:
        return False, str(error)


def _report_display(pane, text, seq, env=None):
    display = ["--display-agent", text] if text else ["--clear-display-agent"]
    return _run_herdr([
        "pane", "report-metadata", pane, "--source", STATUS_SOURCE, "--seq", str(seq), *display,
    ], env)


def _show_notification(text, env=None):
    """Send one notification and return Herdr's reason; never retry."""
    ok, output = _run_herdr(["notification", "show", text, "--sound", "none"], env)
    if not ok:
        return output
    try:
        payload = json.loads(output)
        payload = payload.get("result", payload)
        return str(payload["reason"])
    except (ValueError, AttributeError, KeyError, TypeError):
        return "unknown"


def session_record(workspace, session_id):
    """A controller's session record.

    Records live in the shared .lat; an older one in a worktree's own .lat is still read there.
    """
    workspace = Path(workspace)
    name = f"{session_id}.json"
    record_path = shared_lat_dir(workspace) / "sessions" / name
    if not record_path.exists():
        record_path = workspace / ".lat/sessions" / name
    return json.loads(record_path.read_text(encoding="utf-8"))


def _binding_decisions_path(binding):
    """The decisions directory in the bound controller's session record."""
    return Path(session_record(binding["workspace"], binding["session_id"])["decisions_path"])


def _bound_decisions_path(questions_path, config_dir=None):
    key = _question_key(questions_path)
    binding = next((
        item for item in list_bindings(config_dir=config_dir)
        if _question_key(item.get("questions_path", "")) == key
    ), None)
    if binding is None:
        raise ValueError("no LAT controller is bound to this questions file")
    try:
        return _binding_decisions_path(binding)
    except (KeyError, TypeError, ValueError) as error:
        raise ValueError(f"controller session record has no decisions directory: {error}") from None
    except OSError as error:
        raise ValueError(f"controller session record cannot be read: {error}") from None


def refresh_status_display(questions_path, *, notify=False, config_dir=None, env=None):
    """Show the bound controller's waiting counts on its Herdr sidebar row; never raise.

    Returns ``status`` ``unbound`` (no binding owns this file), ``disabled`` (no
    Herdr workspace or ``lat.panel`` not enabled), ``shown``, ``cleared`` or
    ``failed`` with a ``reason``. With ``notify`` and a
    nonzero count, one notification is sent and Herdr's reason kept as
    ``notification``; a rate-limited or busy notification is not retried.
    """
    try:
        key = _question_key(questions_path)
        binding = next((
            item for item in list_bindings(config_dir=config_dir)
            if _question_key(item.get("questions_path", "")) == key
        ), None)
        if binding is None:
            return {"status": "unbound"}
        if not panel_enabled(env):
            return {"status": "disabled"}
        decisions_path = _binding_decisions_path(binding)
        # Count under the file lock; the sequence number lets Herdr drop an older count.
        with _path_lock(Path(questions_path)):
            decide, help_count = status_counts(questions_path, decisions_path)
            seq = time.time_ns()
        pane = binding["herdr_pane"]
        name = binding["hcom_name"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {"status": "failed", "reason": str(error)}
    text = status_text(name, decide, help_count)
    ok, output = _report_display(pane, text, seq, env)
    result = {"status": ("shown" if text else "cleared") if ok else "failed", "text": text}
    if not ok:
        result["reason"] = output
    if notify and text:
        result["notification"] = _show_notification(text, env)
    return result


def clear_status_display(binding, *, env=None):
    """Restore the sidebar name of one binding's pane; return ``(ok, reason)``."""
    return _report_display(binding["herdr_pane"], "", time.time_ns(), env)


def _notification_path(state_dir=None):
    directory = Path(state_dir) if state_dir else plugin_directory("state")
    return directory / "pending-notifications.json"


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


def mark_submit_notification_pending(
    questions_path, submit_result, *, state_dir=None, config_dir=None
):
    """Record the answers of a successful, non-empty batch submit, then mark its notification.

    Recording is ``record_submitted_answers``; an answer it cannot record stays
    submitted and the notification says why.
    """
    if (
        submit_result.get("status") != "submitted"
        or not submit_result.get("question_ids")
    ):
        return None
    record_submitted_answers(
        questions_path, submit_result["question_ids"], config_dir=config_dir
    )
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


def _owed_answers(questions_path):
    """Return each answer a notification is owed for, whether or not one was ever stored.

    These are panel-submitted answers still waiting to be recorded, with the
    reason the submit did not record them, and answers the submit recorded
    itself. Each has ``id``, ``revision``, ``answer``, ``note``, ``recorded``,
    ``reason``, ``hash`` (the current-revision section hash) and ``time`` (when
    it was journaled). A submit the panel journal does not prove is left out:
    the controller could not record it either; so is an answer the controller
    recorded by hand.
    """
    questions_path = Path(questions_path)
    journal_path = panel_journal_path(questions_path)
    try:
        sections = _sections(questions_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    auto_recorded = {}
    not_recorded = {}
    try:
        lines = journal_path.read_text(encoding="utf-8").splitlines()
    except (OSError, ValueError):
        lines = []
    for line in lines:
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict) or not _journal_entry_matches_questions(entry, questions_path):
            continue
        if entry.get("kind") == "set-status" and entry.get("recorded_question"):
            auto_recorded[entry["recorded_question"]] = (
                entry.get("recorded_section_sha256") if entry.get("auto_recorded") else None,
                entry.get("time"),
            )
        elif entry.get("kind") == "auto-record" and isinstance(entry.get("not_recorded"), dict):
            for question_id, failure in entry["not_recorded"].items():
                if isinstance(failure, dict):
                    not_recorded[question_id] = failure
    answers = []
    for section in sections:
        answer, note = _answer_text_and_note(section["answer"] or "")
        item = {"id": section["id"], "revision": section["revision"], "answer": answer, "note": note}
        if section["status"] == "recorded":
            recorded_hash, recorded_time = auto_recorded.get(section["id"], (None, None))
            if recorded_hash != _full_section_sha256(section):
                continue
            answers.append({**item, "recorded": True, "reason": None,
                            "hash": _section_sha256(section), "time": recorded_time})
            continue
        if section["status"] != "ready":
            continue
        try:
            proof = question_provenance(questions_path, journal_path, section["id"])
        except (OSError, ValueError, AttributeError, TypeError):
            # The last two: a journal line that is JSON but not an entry.
            continue
        failure = not_recorded.get(section["id"], {})
        reason = (
            failure.get("reason") if failure.get("section_sha256") == proof["section_sha256"]
            else None
        )
        answers.append({**item, "recorded": False,
                        "reason": reason or "not recorded when it was submitted",
                        "hash": proof["section_sha256"], "time": proof["time"]})
    return answers


def _submitted_answers(questions_path):
    """Map the section hash of each answer a notification is owed for to its journal time."""
    return {item["hash"]: item["time"] for item in _owed_answers(questions_path)}


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


def _delivered_hashes(questions_path, state_dir):
    """Answer hashes the last delivery covered; none when the record cannot be read."""
    path = _delivered_path(state_dir)
    try:
        with _path_lock(path):
            delivered, _ = _read_delivered(path)
    except OSError:
        return set()
    return set(delivered.get(_question_key(questions_path), []))


def _notification_message(questions_key, owed, delivered):
    """The controller's notice: each new answer, recorded or not, quoted as JSON strings."""
    def quoted(item):
        text = f"{item['id']} r{item['revision']}: answer {json.dumps(item['answer'], ensure_ascii=False)}"
        if item["note"]:
            text += f", note {json.dumps(item['note'], ensure_ascii=False)}"
        return text

    fresh = [item for item in owed if item["hash"] not in delivered]
    recorded = [quoted(item) for item in fresh if item["recorded"]]
    unrecorded = [
        f"{quoted(item)}; not recorded: {item['reason']}"
        for item in fresh if not item["recorded"]
    ]
    parts = [f"Questions file changed: {questions_key}."]
    if recorded:
        parts.append(
            "Recorded at submit, decision record status answered: " + "; ".join(recorded)
            + ". Read the answer in .lat/decisions/<ID>.md, judge what it means and write the "
            "approved scope; re-ask with a new revision if it is unclear."
        )
    if unrecorded:
        parts.append(
            "Submitted but not recorded, still submitted: " + "; ".join(unrecorded)
            + ". Check and record these by hand under the LAT question-processing contract."
        )
    if not recorded and not unrecorded:
        parts.append("Re-read the file and apply the LAT question-processing contract.")
    parts.append("This notification is not approval.")
    return " ".join(parts)


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
    owed = _owed_answers(questions_path)
    covered = {item["hash"]: item["time"] for item in owed}
    message = _notification_message(questions_key, owed, _delivered_hashes(questions_path, state_dir))
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
