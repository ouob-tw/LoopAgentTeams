#!/usr/bin/env python3
"""Watch explicitly registered LAT work for stalled agents (stdlib only)."""
import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import functools
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lat_decision_status import DecisionStatus, read_decision_status
from _lat_common import (process_starttime, resolve_agent_name, run_cli, same_controller,
                         shared_lat_dir, watcher_process_matches, write_json_atomic,
                         read_hcom_pauses)


IDLE_SECONDS = 10 * 60
ACTIVE_SECONDS = 20 * 60
WAIT_DEFAULT_MINUTES = 50
WAIT_EXTENSION_SECONDS = 30 * 60
PROMPT_SECONDS = 5 * 60
PROMPT_SETTLE_SECONDS = 1
PROMPT_POLL_SECONDS = 0.05
CHECK_SECONDS = 60
QUOTA_CLEAR_ROUNDS = 2
QUOTA_REPEAT_SECONDS = 20 * 60
CAPACITY_CONTINUE_SECONDS = 5 * 60
FAILURE_REPEAT_SECONDS = 60 * 60
ORCHESTRATOR_GONE_SECONDS = 60 * 60
LOG_ROTATE_BYTES = 1024 * 1024
TRANSCRIPT_TAIL_BYTES = 256 * 1024
KEEPALIVE_SECONDS = 10 * 60
IDLE_GAP_SECONDS = 5 * 60
KEEPALIVE_DECISION_SECONDS = 3 * 60 * 60
KEEPALIVE_QUIET_HOURS = (1, 9)
PROMPT_UNREADABLE_SECONDS = 15 * 60
LEDGER_START_SECONDS = 10 * 60
LEDGER_USER_SECONDS = 10 * 60
SCREEN_TAIL_LINES = 15
SCREEN_TAIL_CHARS = 200
# Successful deliveries awaiting a session-record save; retained across retry cycles.
RULE_DELIVERIES = {}
ALARM_DELIVERIES = {}
# Latest ledger delivery state per watcher state file; survives a failed state save.
LEDGER_DELIVERIES = {}
_UNSET = object()
NUDGE = ('[lat-watch] Read any unread HCOM messages and finish all work not blocked by pending '
         'decisions. If nothing remains, declare exactly what you are waiting for '
         'with lat-watch wait.')
KEEPALIVE = ('[lat-watch] Prompt cache keep-alive. Read any unread HCOM messages. If nothing '
             'is new, run no tools, keep your current wait without declaring it again and '
             'end your turn with the shortest possible reply.')
QUOTA_CONTINUE = '[lat-watch] Please continue.'
CAPACITY_CONTINUE = 'Continue'
# One Continue per Codex capacity episode; kept until new output or another error.
CAPACITY_KEYS = ('capacity_continue_at', 'capacity_continue_notified', 'capacity_offset')
NAME_PATTERN = r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
NAME = re.compile(NAME_PATTERN)
CARD_AGENT = re.compile(rf'({NAME_PATTERN})(?=$|[\s(（])')
ENVELOPE_FIELDS = ('live actions', 'preflight')
CLIENT_PROFILES = {
    'codex': {
        'error': re.compile(
            r'^■\s+(?:(?P<capacity>Selected model is at capacity\b)|'
            r"(?P<usage>You've hit your usage limit\b|Quota exceeded\b))", re.IGNORECASE),
        'model': re.compile(
            r'^\s*((?:GPT|o)[A-Za-z0-9. -]*?)\s+'
            r'(?:minimal|low|medium|high|xhigh|max|ultra)\s+·', re.IGNORECASE),
    },
    'claude': {
        'primary': re.compile(
            r'^●\s+Usage limit reached\s+·\s+continuing automatically at\b',
            re.IGNORECASE),
        'notice': re.compile(
            r'^Usage limit reached\s+·\s+continuing automatically at\b.*'
            r'·\s+esc to cancel$', re.IGNORECASE),
        'footer': re.compile(r'^\s{2}⚠\s+Usage limit reached\b', re.IGNORECASE),
        'model': re.compile(
            r'^\s*((?:Opus|Sonnet|Haiku)[A-Za-z0-9. -]*?)\s+'
            r'(?:low|medium|high|max)\s+·', re.IGNORECASE),
    },
}
# Raw crash output starts at column 0; client replies and tool output are prefixed or indented.
CRASH = re.compile(r'^(?:[A-Za-z].*\bpanicked\b|(?:stack )?backtrace\b)', re.IGNORECASE)
CRASH_ACTION = ('inspect the agent screen, then resume the same agent or replace it and '
                'resend its task')
RECOVERY_ACTIONS = {
    ('codex', 'model-capacity'): 'switch to another model',
    ('codex', 'usage-limit'): (
        'switch to another subscribed account with quota; Do not switch to API billing; '
        'if no subscribed account is available, the user decides how to continue'),
    ('codex', 'rate-limit'): (
        'switch to another subscribed account with quota; Do not switch to API billing; '
        'if no subscribed account is available, the user decides how to continue'),
}


class Observation(NamedTuple):
    agent: str
    status: str
    prompt_empty: bool
    command_running: bool
    transcript_size: int
    transcript_mtime_ns: int
    event_id: int
    wait_active: bool = False
    wait_released: bool = False
    is_orchestrator: bool = False
    task_card_revision: str = ''
    task_card_updated_at: float = 0
    orchestrator_wait_started_at: float = 0
    input_text: str = ''
    unread_count: int = 0
    client: str = 'unknown'
    model: str = 'unknown'
    quota_issue: object = None
    codex_turn_finished: object = None
    nudge_only: bool = False
    keepalive_only: bool = False
    terminal_ready: object = None
    screen_working: bool = False
    # False when hcom term reports no boolean prompt_empty (menus such as /model).
    prompt_readable: bool = True
    screen_tail: tuple = ()
    quota_screen: tuple = ()
    screen_digest: str = ''
    # The transcript has more than the watcher's Continue since it was typed.
    capacity_output: bool = False
    # hcom-spawn's spawn-watch types Continue and sends the 5-minute notice for this agent.
    capacity_covered: bool = False


class QuotaIssue(NamedTuple):
    kind: str
    line: str
    reset_time: object = None


class Action(NamedTuple):
    kind: str
    agent: str
    message: str = ''
    text: str = ''
    category: str = ''
    label: str = ''


class Process(NamedTuple):
    pid: int
    ppid: int
    starttime: int
    state: str
    session: int
    command: tuple
    environment: tuple


def escalation_message(observation, state, now, recipient):
    stalled_minutes = int((now - state['last_progress_at']) // 60)
    nudged_minutes = int((now - state['nudged_at']) // 60)
    reason = state.get('stall_reason', 'no progress after a terminal nudge')
    if recipient == 'orchestrator':
        action_needed = ('inspect the agent and either resume or stop it, update its task '
                         'card, or declare a wait naming this agent.')
        history = (f'Already done: one terminal nudge was injected '
                   f'{nudged_minutes} minutes ago.')
    elif observation.is_orchestrator:
        action_needed = ('return to this orchestrator and resume the authorized work, or '
                         'record exactly what it is waiting for.')
        history = (f'Already done: one terminal nudge was injected '
                   f'{nudged_minutes} minutes ago.')
    else:
        action_needed = ('check the orchestrator and decide whether to resume, stop, or '
                         'reassign the stalled agent.')
        orchestrator_minutes = int((now - state['orchestrator_notified_at']) // 60)
        history = (f'Already done: one terminal nudge; the orchestrator was notified '
                   f'{orchestrator_minutes} minutes ago.')
    return (f'LAT stall watcher: agent {observation.agent} has made no progress for '
            f'{stalled_minutes} minutes. Reason: {reason}. {history} '
            f'Action needed: {action_needed}')


def owner_notice(observation, state, now, reason):
    stalled_minutes = int((now - state['last_progress_at']) // 60)
    if reason == 'active-command':
        detail = 'the screen still shows work running; this may be a possible hung command'
        action_needed = 'inspect the running command and decide whether it should continue'
    else:
        detail = 'the agent is blocked at an approval prompt'
        action_needed = 'open the agent and approve or reject the pending request'
    message = (f'LAT stall watcher: agent {observation.agent} has made no progress for '
               f'{stalled_minutes} minutes and {detail}. No terminal nudge was injected. '
               f'Action needed: {action_needed}.')
    kind = 'notify-user' if observation.is_orchestrator else 'notify-orchestrator'
    return Action(kind, observation.agent, message,
                  label='待核准' if reason == 'blocked' else '')


def quota_notice(observation, unchanged_minutes=None, continue_minutes=None,
                 input_has_text=False, covered=False):
    issue = observation.quota_issue
    reset = f' Reset time: {issue.reset_time}.' if issue.reset_time else ''
    if issue.kind == 'crash':
        action_needed = CRASH_ACTION
    else:
        action_needed = RECOVERY_ACTIONS.get(
            (observation.client.lower(), issue.kind),
            'the user decides whether to wait or choose another recovery action',
        )
    line_end = '' if issue.line.endswith(('.', '!', '?')) else '.'
    if continue_minutes is not None:
        recovery = f'Continue was sent {continue_minutes} minutes ago with no reaction. '
        action_needed = 'hand the work to another agent'
    elif covered:
        recovery = ('hcom-spawn spawn-watch handles Continue and the 5-minute notice for '
                    'this agent. ')
    elif observation.quota_screen:
        recovery = ('The watcher checks the active cswap account each cycle and only resumes '
                    'a verified Claude quota menu when both usage windows are below 100%. ')
    elif input_has_text:
        recovery = 'No terminal nudge was injected because the input box has text. '
    else:
        recovery = 'No terminal nudge was injected. '
    subject = ('crash' if issue.kind == 'crash'
               else 'quota or model-capacity issue')
    repeat = (f' Still on screen: the screen has been unchanged for {unchanged_minutes} '
              'minutes.' if unchanged_minutes is not None else '')
    message = (f'LAT stall watcher: {subject} for agent '
               f'{observation.agent}.{repeat} Client: {observation.client}. Model: '
               f'{observation.model}. Matched line: {issue.line}{line_end}{reset} '
               f'{recovery}Action needed: {action_needed}.')
    kind = 'notify-user' if observation.is_orchestrator else 'notify-orchestrator'
    label = {'model-capacity': '模型滿載', 'crash': '程式崩潰'}.get(issue.kind, '額度不足')
    return Action(kind, observation.agent, message, category='quota', label=label)


def quota_dedupe(previous, issue):
    """Keep one notice per quota episode; progress alone never re-arms it."""
    previous = previous or {}
    notified = previous.get('quota_notified', False)
    reset_time = previous.get('quota_reset_time')
    clear_rounds = 0
    if issue is None:
        if notified:
            clear_rounds = previous.get('quota_clear_rounds', 0) + 1
        if clear_rounds >= QUOTA_CLEAR_ROUNDS:
            notified, reset_time, clear_rounds = False, None, 0
    else:
        if issue.reset_time and reset_time and issue.reset_time != reset_time:
            notified = False
        reset_time = issue.reset_time or reset_time
    return {'quota_notified': notified, 'quota_reset_time': reset_time,
            'quota_clear_rounds': clear_rounds}


def quota_reset_time(line):
    end = r'(?:\s+·|\s+Continuing shortly\b|\s+esc to cancel\b|\.(?:\s|$)|$)'
    patterns = (
        rf'\blimit resets\s+(.+?){end}',
        rf'\bresets\s+(.+?){end}',
        rf'\bcontinuing automatically at\s+(.+?){end}',
        rf'\btry again at\s+(.+?){end}',
    )
    for pattern in patterns:
        match = re.search(pattern, line, re.IGNORECASE)
        if match:
            return match.group(1).strip().rstrip('.')
    return None


def screen_separator(line):
    stripped = line.strip()
    return len(stripped) >= 3 and set(stripped) == {'─'}


def screen_message(lines, start):
    """Join wrapped text until the next recognizable client UI boundary."""
    parts = [lines[start].strip()]
    model_patterns = tuple(profile['model'] for profile in CLIENT_PROFILES.values())
    for line in lines[start + 1:start + 5]:
        stripped = line.strip()
        if (not stripped or screen_separator(line)
                or stripped.startswith(('Working (', '• ', '› ', '■ ', '● ', '⚠ ', '✻ ', '⏵'))
                or any(pattern.search(line) for pattern in model_patterns)):
            break
        parts.append(stripped)
    return ' '.join(parts)


def codex_error_is_current(lines, index):
    for line in lines[index + 1:]:
        stripped = line.strip()
        # A newer error, even one the watcher does not classify, replaces this one.
        if stripped.startswith('Working (') or line.startswith(('• ', '■ ')):
            return False
        if line.startswith('› ') and stripped != '› Ask Codex to do anything':
            return False
    return True


def claude_primary_is_current(lines, index):
    for line in lines[index + 1:]:
        stripped = line.strip()
        if line.startswith('● ') or stripped.startswith('Working'):
            return False
        if line.startswith('❯ ') and stripped != '❯':
            return False
    return True


def codex_turn_finished(transcript):
    """Read the last Codex turn boundary; unavailable/corrupt tails are unknown."""
    if not isinstance(transcript, (str, Path)) or not transcript:
        return None
    try:
        with Path(transcript).open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            start = max(0, stream.tell() - TRANSCRIPT_TAIL_BYTES)
            stream.seek(start)
            lines = stream.read().splitlines()
    except OSError:
        return None
    if start:
        lines = lines[1:]
    finished = None
    for raw in lines:
        try:
            record = json.loads(raw)
        except (ValueError, RecursionError):
            return None
        if not isinstance(record, dict):
            return None
        payload = record.get('payload', {})
        if not isinstance(payload, dict):
            return None
        if record.get('type') == 'event_msg':
            if payload.get('type') == 'task_complete':
                finished = True
            elif payload.get('type') == 'task_started':
                finished = False
            elif payload.get('type') == 'user_message' and finished is not None:
                finished = False
        elif (record.get('type') == 'response_item' and payload.get('role') == 'user'
              and finished is not None):
            finished = False
    return finished


def nudge_transcript_only(transcript, offset, size, client, nudge=NUDGE):
    """Recognize an exact watcher prompt plus client bookkeeping/error/echo only.

    Unknown, replaced, oversized or corrupt data keeps the old progress behavior.
    A tool, assistant text longer than 200 characters, or other user input is progress.
    """
    if (client.lower() not in ('claude', 'codex') or not transcript
            or size <= offset or size - offset > TRANSCRIPT_TAIL_BYTES):
        return False
    try:
        with Path(transcript).open('rb') as stream:
            stream.seek(offset)
            data = stream.read(size - offset)
        if len(data) != size - offset or not data.endswith(b'\n'):
            return False
        records = [json.loads(line) for line in data.splitlines()]
    except (OSError, ValueError, RecursionError):
        return False
    saw_nudge = False
    for record in records:
        if not isinstance(record, dict):
            return False
        kind = record.get('type')
        payload = record.get('payload', {})
        if not isinstance(payload, dict):
            return False
        message = record.get('message', {}) if client.lower() == 'claude' else payload
        if not isinstance(message, dict):
            return False
        role = message.get('role', kind if client.lower() == 'claude' else None)
        if kind == 'event_msg' and payload.get('type') == 'item_completed':
            item = payload.get('item', {})
            if not isinstance(item, dict):
                return False
            if item.get('type') == 'Reasoning':
                continue
            if item.get('type') not in ('UserMessage', 'AgentMessage'):
                return False
            role = 'user' if item['type'] == 'UserMessage' else 'assistant'
            content = item.get('content', [])
        elif kind == 'event_msg' and payload.get('type') in ('user_message', 'agent_message'):
            role = 'user' if payload['type'] == 'user_message' else 'assistant'
            content = payload.get('message')
        elif (kind == 'event_msg' and payload.get('type') == 'task_complete'
              and payload.get('last_agent_message')):
            role = 'assistant'
            content = payload['last_agent_message']
        else:
            content = message.get('content', [])
        if role in ('user', 'assistant'):
            if isinstance(content, list):
                if role == 'assistant':
                    # Claude extended thinking is not work; only the visible text is measured.
                    content = [item for item in content if not isinstance(item, dict)
                               or item.get('type') not in ('thinking', 'redacted_thinking')]
                if any(not isinstance(item, dict) or item.get('type') not in
                       ('text', 'Text', 'input_text', 'output_text')
                       or not isinstance(item.get('text'), str) for item in content):
                    return False
                content = ''.join(item.get('text', '') for item in content)
            if not isinstance(content, str):
                return False
            if role == 'user':
                if content != nudge:
                    return False
                saw_nudge = True
            elif not saw_nudge:
                return False
            elif not record.get('isApiErrorMessage') and len(content.strip()) > 200:
                return False
        elif client.lower() == 'claude':
            # Snapshots also precede the injected user record; deltas still reset.
            if kind in ('file-history-snapshot', 'mode', 'atis-latch', 'last-prompt',
                        'ai-title', 'permission-mode', 'cost-state'):
                continue
            if kind == 'system' and record.get('subtype') in (
                    'turn_duration', 'stop_hook_summary', 'away_summary', 'informational'):
                continue
            if kind == 'attachment' and saw_nudge:
                continue
            return False
        elif kind == 'event_msg' and payload.get('type') in (
                'task_started', 'task_complete', 'token_count', 'error',
                'thread_settings_applied', 'turn_aborted'):
            continue
        elif kind in ('turn_context', 'world_state', 'token_usage_record'):
            continue
        elif kind == 'response_item' and payload.get('type') == 'reasoning':
            continue
        else:
            return False
    return saw_nudge


def codex_output_since(transcript, offset, size):
    """True only for a complete Codex reply or tool record after offset; unknown is False."""
    if not isinstance(transcript, (str, Path)) or not transcript or size <= offset:
        return False
    start = max(offset, size - TRANSCRIPT_TAIL_BYTES)
    try:
        with Path(transcript).open('rb') as stream:
            stream.seek(start)
            lines = stream.read(size - start).split(b'\n')
    except OSError:
        return False
    # The last piece is empty or a record still being written; a cut first line is partial.
    lines = lines[1:-1] if start > offset else lines[:-1]
    for raw in lines:
        try:
            record = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        payload = record.get('payload') if isinstance(record, dict) else None
        if not isinstance(payload, dict):
            continue
        if record.get('type') == 'response_item':
            if (payload.get('role') == 'assistant'
                    or payload.get('type') not in ('message', 'reasoning')):
                return True
        elif record.get('type') == 'event_msg':
            item = payload.get('item')
            if (payload.get('type') == 'agent_message'
                    or (payload.get('type') == 'item_completed' and isinstance(item, dict)
                        and item.get('type') == 'AgentMessage')):
                return True
    return False


def injected_only(baseline, observation, info, orchestrator, text):
    """True when everything since baseline is the injected text and its lifecycle events."""
    if (not isinstance(baseline, list) or len(baseline) != 3
            or any(not isinstance(value, int) or value < 0 for value in baseline)):
        return False
    if not nudge_transcript_only(info.get('transcript_path'), baseline[0],
                                 observation.transcript_size, observation.client, text):
        return False
    if observation.event_id != baseline[2]:
        events = session_events(orchestrator, info, '--last', '1000', after_id=baseline[2])
        # Never hide another agent's messages, including ones followed by status.
        lifecycle = {'', 'prompt', 'stop', 'ready_observed', 'turn_complete',
                     'failure:authentication_failed'}
        if (not events or len(events) >= 1000
                or latest_event_id(events) != observation.event_id
                or any(event.get('type') != 'status' or status_context(event) not in lifecycle
                       for event in events)):
            return False
    return True


def nudge_only_observation(previous, observation, info, orchestrator):
    """Exclude only an injected nudge or keep-alive, its short reply and lifecycle events."""
    if not previous:
        return observation
    fingerprint = [observation.transcript_size, observation.transcript_mtime_ns,
                   observation.event_id]
    if previous.get('fingerprint') == fingerprint:
        return observation
    if previous.get('nudged') and injected_only(
            previous.get('nudge_fingerprint', previous.get('fingerprint')), observation, info,
            orchestrator, previous.get('nudge_text', NUDGE)):
        observation = observation._replace(nudge_only=True)
    offset = previous.get('capacity_offset')
    if isinstance(offset, int) and observation.transcript_size > offset:
        observation = observation._replace(capacity_output=codex_output_since(
            info.get('transcript_path'), offset, observation.transcript_size))
    keepalive = previous.get('keepalive')
    if isinstance(keepalive, dict) and injected_only(
            keepalive.get('fingerprint'), observation, info, orchestrator, KEEPALIVE):
        observation = observation._replace(keepalive_only=True)
    return observation


def current_claude_quota_notice(transcript):
    """Return an unsuperseded Claude system quota notice near transcript EOF."""
    if not isinstance(transcript, (str, Path)):
        return None
    path = Path(transcript)
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            start = max(0, size - TRANSCRIPT_TAIL_BYTES)
            stream.seek(start)
            data = stream.read()
    except (FileNotFoundError, OSError):
        return None
    lines = data.splitlines()
    if start:
        lines = lines[1:]
    notice = None
    pattern = CLIENT_PROFILES['claude']['notice']
    for raw in lines:
        try:
            record = json.loads(raw)
        except (ValueError, TypeError, RecursionError):
            continue
        if not isinstance(record, dict):
            continue
        content = record.get('content')
        if (record.get('type') == 'system'
                and record.get('subtype') == 'informational'
                and record.get('level') == 'notice'
                and isinstance(content, str) and pattern.search(content)):
            notice = content
        elif notice is not None and record.get('type') in ('user', 'assistant'):
            notice = None
    return notice


def crash_is_current(lines, index):
    """A crash is current while no client UI or later error was drawn after it."""
    model_patterns = tuple(profile['model'] for profile in CLIENT_PROFILES.values())
    for line in lines[index + 1:]:
        if (line.startswith(('› ', '❯', '• ', '● ', '■ ', '╭'))
                or line.strip().startswith('Working')
                or any(pattern.search(line) for pattern in model_patterns)):
            return False
    return True


def detect_screen_quota(lines, client, claude_notice=None):
    """Match quota, capacity or crash UI that is the last error on the screen."""
    if not isinstance(lines, list) or any(not isinstance(line, str) for line in lines):
        raise ValueError('hcom term returned invalid screen lines')
    # Every crash line still current belongs to the final crash; report its first line.
    crashes = [index for index, line in enumerate(lines)
               if CRASH.search(line) and crash_is_current(lines, index)]
    if crashes:
        return QuotaIssue('crash', screen_message(lines, crashes[0]))
    profile = CLIENT_PROFILES.get(client.lower())
    if profile is None:
        return None
    if 'error' in profile:
        for index in range(len(lines) - 1, -1, -1):
            match = profile['error'].search(lines[index])
            if match and codex_error_is_current(lines, index):
                message = screen_message(lines, index)
                kind = 'model-capacity' if match.group('capacity') else 'usage-limit'
                return QuotaIssue(kind, message, quota_reset_time(message))
        return None

    separators = [index for index, line in enumerate(lines) if screen_separator(line)]
    status_start = separators[-1] if separators else len(lines)
    footers = [index for index in range(status_start + 1, len(lines))
               if profile['footer'].search(lines[index])]
    footer = footers[-1] if footers else None
    if footer is not None:
        message = screen_message(lines, footer)
        return QuotaIssue('usage-limit', message, quota_reset_time(message))

    primaries = [index for index, line in enumerate(lines)
                 if profile['primary'].search(line)
                 and claude_primary_is_current(lines, index)]
    if primaries:
        message = screen_message(lines, primaries[-1])
        reset = quota_reset_time(message)
        visible_notice = re.sub(r'^●\s+', '', message)
        if (isinstance(claude_notice, str)
                and ' '.join(visible_notice.split()) == ' '.join(claude_notice.split())):
            return QuotaIssue('usage-limit', message, reset)
    return None


def spawn_capacity_dir():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state'))
    return base / 'hcom-spawn/capacity'


def spawn_watch_covers(agent):
    """True while a running hcom-spawn spawn-watch.py handles this agent's model capacity.

    spawn-watch writes hcom-spawn/capacity/<agent>.json with its pid and start time.
    """
    try:
        record = json.loads((spawn_capacity_dir() / f'{agent}.json').read_text())
        stat = (Path('/proc') / str(int(record['pid'])) / 'stat').read_text()
        return int(stat.rsplit(')', 1)[1].split()[19]) == record['start']
    except (OSError, ValueError, KeyError, TypeError, IndexError):
        return False


def hcom_quota_issue(info):
    context = info.get('status_context', info.get('context', ''))
    detail = info.get('status_detail', '')
    if (info.get('status') == 'inactive'
            and (context == 'failure:rate_limit' or detail == 'rate_limit')):
        return QuotaIssue('rate-limit', 'inactive (failure:rate_limit)')
    return None


def claude_quota_menu(terminal):
    """Recognize the live bottom dialog, independently of HCOM's listening status."""
    if (terminal.get('ready') is not False or terminal.get('prompt_empty') is not None
            or terminal.get('input_text') is not None):
        return ()
    lines = terminal.get('lines', [])
    if not isinstance(lines, list) or not all(isinstance(line, str) for line in lines):
        return ()
    separators = [i for i, line in enumerate(lines) if screen_separator(line)]
    if not separators:
        return ()
    block = tuple(line.strip() for line in lines[separators[-1] + 1:] if line.strip())
    if len(block) < 3 or block[0] != 'What do you want to do?':
        return ()
    # A changed quota menu still deserves a fallback notice, but generic questions do not.
    if not any('Stop and wait for limit to reset' in line or 'usage credits' in line
               for line in block):
        return ()
    return tuple(lines[-30:])


def quota_menu_selection(screen):
    """Accept only the two captured menus and exactly one visible selection marker."""
    lines = [line.strip() for line in screen if line.strip()]
    try:
        start = len(lines) - 1 - lines[::-1].index('What do you want to do?')
    except ValueError:
        raise ValueError('quota menu heading missing') from None
    options = lines[start + 1:-1]
    labels, selected = [], []
    for index, line in enumerate(options):
        match = re.fullmatch(r'(❯ )?(\d)\. (.+)', line)
        if not match or int(match[2]) != index + 1:
            raise ValueError('quota menu options changed')
        labels.append(match[3])
        if match[1]:
            selected.append(index)
    valid = (labels == ['Stop and wait for limit to reset',
                        'Add funds to continue with usage credits', 'Upgrade your plan']
             or (len(labels) == 4 and labels[0] == 'Stop and wait for limit to reset'
                 and re.fullmatch(r'Wait here, then continue automatically (?:at .+|shortly)',
                                  labels[1])
                 and labels[2:] == ['Switch to usage credits', 'Upgrade your plan']))
    if not valid or len(selected) != 1 or lines[-1] != 'Enter to confirm · Esc to cancel':
        raise ValueError('quota menu labels or cursor cannot be verified')
    return selected[0]


def active_claude_quota():
    """cswap's cached-only route reads the live login identity and usage store; no writes."""
    try:
        data = run_json(['cswap', 'list', '--json', '--cached-only'])
        if (not isinstance(data, dict) or data.get('schemaVersion') != 1
                or data.get('cachedOnly') is not True):
            raise ValueError('unsupported cswap cached payload')
        number = data.get('activeAccountNumber')
        accounts = data.get('accounts')
        if type(number) is not int or not isinstance(accounts, list):
            raise ValueError('active cswap account is unknown')
        active = [a for a in accounts if isinstance(a, dict) and a.get('active') is True]
        if len(active) != 1 or active[0].get('number') != number:
            raise ValueError('active cswap account is ambiguous')
        account = active[0]
        usage = account.get('usage')
        if account.get('usageStatus') != 'ok' or not isinstance(usage, dict):
            raise ValueError('active cswap usage is unavailable')
        values = []
        for window in ('fiveHour', 'sevenDay'):
            entry = usage.get(window)
            value = entry.get('pct') if isinstance(entry, dict) else None
            if type(value) not in (int, float) or not 0 <= value <= 100:
                raise ValueError(f'active cswap {window} usage is invalid')
            values.append(value)
        return {'available': all(value < 100 for value in values), 'account': number,
                'five_hour': values[0], 'seven_day': values[1],
                'fetched_at': account.get('usageFetchedAt'),
                'reason': 'quota available' if all(value < 100 for value in values)
                else 'active account quota exhausted'}
    except (OSError, ValueError) as error:
        return {'available': False, 'reason': f'cswap quota unavailable: {error}'}


def recover_claude_quota(observation, previous, state, orchestrator, workspace, log, now):
    """Handle one menu episode; uncertain key delivery is never retried automatically."""
    if observation.client.lower() != 'claude':
        return
    if observation.quota_issue is not None and observation.quota_issue.kind == 'crash':
        observation = observation._replace(quota_issue=None)
    episode = dict((previous or {}).get('quota_recovery', {}))
    if not episode and observation.quota_issue is None:
        return
    if observation.quota_issue is None:
        episode['clear_rounds'] = episode.get('clear_rounds', 0) + 1
        if episode['clear_rounds'] >= QUOTA_CLEAR_ROUNDS:
            state.pop('quota_recovery', None)
            return
    else:
        episode['clear_rounds'] = 0
    state['quota_recovery'] = episode
    if observation.quota_issue is None and not episode.get('failure'):
        return

    def record(step, **fields):
        append_log(log, {'at': now, 'agent': observation.agent,
                         'decision': 'quota-recovery', 'step': step, **fields})

    def screen():
        terminal = run_json(['hcom', 'term', observation.agent, '--json', '--name', orchestrator])
        if not isinstance(terminal, dict):
            raise ValueError('terminal snapshot unavailable')
        record('screen', screen=[line[:300] for line in terminal.get('lines', [])[-30:]
                                 if isinstance(line, str)])
        return terminal

    def key(label, text=None, enter=False):
        episode['attempted'] = True
        record('key', key=label, text=text)
        command = ['hcom', 'term', 'inject', observation.agent]
        if text is not None:
            command.append(text)
        if enter:
            command.append('--enter')
        run_command([*command, '--name', orchestrator])
        record('key-sent', key=label)

    def settled(predicate):
        deadline = time.monotonic() + PROMPT_SETTLE_SECONDS
        while True:
            terminal = screen()
            if predicate(terminal):
                return terminal
            if time.monotonic() >= deadline:
                raise ValueError('terminal did not reach the expected state')
            time.sleep(PROMPT_POLL_SECONDS)

    def notify_failure():
        if episode.get('notified'):
            return
        action = Action('notify-user' if observation.is_orchestrator else 'notify-orchestrator',
                        observation.agent,
                        f'LAT stall watcher: agent {observation.agent} quota-menu recovery '
                        f'stopped: {episode["failure"]}. Inspect its window before continuing.',
                        category='quota-recovery', label='額度不足')
        try:
            delivery = perform(action, orchestrator, workspace)
            episode['notified'] = True
            record('fallback-notified', **delivery)
        except (OSError, ValueError) as error:
            record('fallback-failed', reason=str(error))

    if episode.get('failure'):
        notify_failure()
    if observation.quota_issue is None:
        return
    record('detected', screen=[line[:300] for line in observation.quota_screen])
    if episode.get('attempted'):
        record('skip', reason='already attempted this quota episode')
        return
    quota = active_claude_quota()
    record('quota', **quota)
    if not quota['available']:
        record('skip', reason=quota['reason'])
        return
    try:
        current = screen()
        selected = quota_menu_selection(claude_quota_menu(current))
        record('verified', selected=selected + 1)
        while selected:
            key('Up', '\x1b[A')
            expected = selected - 1

            def moved(terminal):
                actual = quota_menu_selection(claude_quota_menu(terminal))
                if actual not in (selected, expected):
                    raise ValueError('quota menu cursor moved unexpectedly')
                return actual == expected

            settled(moved)
            selected = expected
            record('verified', selected=selected + 1)
        # Re-read even if the cursor started on option 1; never Enter on an old snapshot.
        if quota_menu_selection(claude_quota_menu(screen())) != 0:
            raise ValueError('Stop and wait selection changed before Enter')
        record('verified', selected=1, target='Stop and wait for limit to reset')
        key('menu-Enter', enter=True)
        settled(lambda terminal: terminal.get('ready') is True
                and terminal.get('prompt_empty') is True and terminal.get('input_text') == '')
        record('verified', prompt='empty after menu exit')
        key('continue-text', QUOTA_CONTINUE)
        settled(lambda terminal: terminal.get('prompt_empty') is False
                and terminal.get('input_text') == QUOTA_CONTINUE)
        record('verified', prompt=QUOTA_CONTINUE)
        key('continue-Enter', enter=True)
        episode['completed'] = True
        record('completed', text=QUOTA_CONTINUE)
    except (OSError, ValueError) as error:
        episode['failure'] = str(error)
        record('skip', reason=str(error))
        notify_failure()


def screen_model(lines, client):
    if not isinstance(lines, list):
        return 'unknown'
    profile = CLIENT_PROFILES.get(client.lower())
    if profile is None:
        return 'unknown'
    for line in reversed(lines):
        match = profile['model'].search(line)
        if match:
            return match.group(1).strip()
    return 'unknown'


def prompt_digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def validated_unread_count(info, agent):
    unread_count = info.get('unread_count', 0)
    if (not isinstance(unread_count, int) or isinstance(unread_count, bool)
            or unread_count < 0):
        raise ValueError(f'hcom list returned invalid unread_count for {agent}')
    return unread_count


def decide(previous, observation, now):
    """Return serializable state and requested actions for one observation."""
    fingerprint = [observation.transcript_size, observation.transcript_mtime_ns,
                   observation.event_id]
    progressed = (previous is None or previous.get('fingerprint') != fingerprint)
    if previous and previous.get('nudged') and observation.nudge_only:
        progressed = False
    if previous and observation.keepalive_only:
        progressed = False
    quota_cleared = bool(previous and previous.get('quota_active')
                         and observation.quota_issue is None)
    reset = progressed or observation.wait_released or quota_cleared
    if reset:
        state = {
            'fingerprint': fingerprint,
            'last_progress_at': now,
            'nudged': False,
            'orchestrator_notified': False,
            'orchestrator_handled': False,
            'user_notified': False,
            'quota_active': observation.quota_issue is not None,
        }
    else:
        state = dict(previous)
        state['fingerprint'] = fingerprint
        state.setdefault('orchestrator_notified', False)
        state.setdefault('orchestrator_handled', False)
        state.setdefault('user_notified', False)
        state['quota_active'] = observation.quota_issue is not None
        if state.get('nudged') and 'nudged_at' not in state:
            state['nudged_at'] = now
    queued_prompt = (not observation.prompt_empty and bool(observation.input_text)
                     and observation.unread_count > 0)
    prompt_hash = prompt_digest(observation.input_text)
    previous_prompt_hash = previous.get('prompt_text_hash') if previous else None
    if previous and previous_prompt_hash is None and 'prompt_text' in previous:
        previous_prompt_hash = prompt_digest(previous['prompt_text'])
    same_prompt = (queued_prompt and previous is not None
                   and previous_prompt_hash == prompt_hash)
    uncertain_recovery = (queued_prompt and previous is not None
                          and previous.get('prompt_recovery_uncertain', False))
    if queued_prompt:
        state.pop('prompt_text', None)
        state['prompt_text_hash'] = prompt_hash
        state['prompt_text_since'] = (
            previous.get('prompt_text_since', now) if same_prompt else now)
        if uncertain_recovery:
            state['prompt_recovery_attempted'] = True
            state.pop('prompt_recovery_uncertain', None)
        else:
            state['prompt_recovery_attempted'] = (
                previous.get('prompt_recovery_attempted', False) if same_prompt else False)
    else:
        state.pop('prompt_text', None)
        state.pop('prompt_text_hash', None)
        state.pop('prompt_text_since', None)
        state.pop('prompt_recovery_attempted', None)
        state.pop('prompt_recovery_uncertain', None)
    actions = ()
    state.update(quota_dedupe(previous, observation.quota_issue))
    # A Continue episode ends on new output or another error, not on a passing clear screen.
    new_output = observation.capacity_output
    other_error = (observation.quota_issue is not None
                   and observation.quota_issue.kind != 'model-capacity')
    if previous and 'capacity_continue_at' in previous and not new_output and not other_error:
        state.update({key: previous[key] for key in CAPACITY_KEYS if key in previous})
        state['quota_notified'] = True
    else:
        for key in CAPACITY_KEYS:
            state.pop(key, None)
        if previous and 'capacity_continue_at' in previous:
            state['quota_notified'] = False
    if observation.quota_issue is None:
        for key in ('quota_notified_at', 'quota_screen_digest', 'quota_screen_since'):
            state.pop(key, None)
    else:
        same_screen = (previous is not None
                       and previous.get('quota_screen_digest') == observation.screen_digest)
        state['quota_screen_digest'] = observation.screen_digest
        state['quota_screen_since'] = (previous.get('quota_screen_since', now)
                                       if same_screen else now)
        if state['quota_notified']:
            state['quota_notified_at'] = previous.get('quota_notified_at', now)
    stalled = now - state['last_progress_at'] >= IDLE_SECONDS
    active_stalled = now - state['last_progress_at'] >= ACTIVE_SECONDS
    finished_active = (observation.client.lower() == 'codex'
                       and observation.codex_turn_finished is True
                       and observation.status == 'active' and observation.prompt_empty)
    orchestrator_notified_at = state.get('orchestrator_notified_at', now + 1)
    orchestrator_deadline = orchestrator_notified_at + IDLE_SECONDS
    card_handled = (observation.task_card_revision
                    != state.get('orchestrator_notice_task_revision', '')
                    and orchestrator_notified_at <= observation.task_card_updated_at
                    <= orchestrator_deadline)
    wait_handled = (observation.orchestrator_wait_started_at > 0
                    and orchestrator_notified_at
                    <= observation.orchestrator_wait_started_at
                    <= orchestrator_deadline)
    orchestrator_handled = (state.get('orchestrator_notified')
                            and not state.get('orchestrator_handled')
                            and not observation.is_orchestrator
                            and (card_handled or wait_handled))
    if orchestrator_handled:
        state['orchestrator_handled'] = True
    prompt_stalled = (queued_prompt
                      and now - state['prompt_text_since'] >= PROMPT_SECONDS)
    # Crash words can appear on a working agent's screen; wait for the stall threshold.
    crash_unconfirmed = (observation.quota_issue is not None
                         and observation.quota_issue.kind == 'crash' and not active_stalled)
    # Codex capacity gets one Continue unless the input box has text to keep.
    capacity = (observation.quota_issue is not None
                and observation.quota_issue.kind == 'model-capacity'
                and observation.client.lower() == 'codex')
    input_has_text = capacity and (observation.prompt_empty is not True
                                   or bool(observation.input_text))
    capacity_continue = capacity and observation.status != 'inactive' and not input_has_text
    covered = capacity and observation.capacity_covered
    continue_at = state.get('capacity_continue_at')
    if observation.quota_issue is not None and not state['quota_notified']:
        if covered:
            # spawn-watch already typed Continue or told the spawner; only repeats remain.
            state['quota_notified'] = True
            state['quota_notified_at'] = now
        elif capacity_continue:
            actions = (Action('capacity-continue', observation.agent, text=CAPACITY_CONTINUE),)
            state['quota_notified'] = True
            state['quota_notified_at'] = now
            state['capacity_continue_at'] = now
            state['capacity_offset'] = observation.transcript_size
        elif not crash_unconfirmed:
            actions = (quota_notice(observation, input_has_text=input_has_text),)
            state['quota_notified'] = True
            state['quota_notified_at'] = now
    elif (capacity and continue_at is not None and not covered
          and not state.get('capacity_continue_notified')):
        if (observation.status != 'inactive'
                and now - continue_at >= CAPACITY_CONTINUE_SECONDS):
            actions = (quota_notice(observation,
                                    continue_minutes=int((now - continue_at) // 60)),)
            state['capacity_continue_notified'] = True
            state['quota_notified_at'] = now
    elif observation.quota_issue is not None:
        # Repeat to the orchestrator while the agent stays on the same error screen.
        unchanged_since = max(state['quota_notified_at'], state['quota_screen_since'])
        if (not observation.is_orchestrator and observation.status != 'inactive'
                and now - unchanged_since >= QUOTA_REPEAT_SECONDS):
            actions = (quota_notice(
                observation, int((now - state['quota_screen_since']) // 60),
                continue_minutes=(None if continue_at is None
                                  else int((now - continue_at) // 60)),
                covered=covered and continue_at is None),)
            state['quota_notified_at'] = now
    elif prompt_stalled and not state['prompt_recovery_attempted']:
        actions = (Action(
            'recover-prompt', observation.agent, text=observation.input_text),)
        state['prompt_recovery_attempted'] = True
    elif (stalled and not observation.wait_active and not state['nudged']
            and observation.status == 'listening'
            and observation.prompt_empty and not observation.command_running):
        actions = (Action('nudge', observation.agent),)
        state['nudged'] = True
        state['nudged_at'] = now
        state['nudge_fingerprint'] = fingerprint
        state['stall_reason'] = 'listening at an empty prompt with no command running'
    elif (active_stalled and not observation.wait_active and not state['nudged']
          and observation.status == 'active'
          and observation.prompt_empty
          and (not observation.command_running or finished_active)):
        actions = (Action('nudge', observation.agent),)
        state['nudged'] = True
        state['nudged_at'] = now
        state['nudge_fingerprint'] = fingerprint
        state['stall_reason'] = ('Codex turn finished but status active' if finished_active
                                 else 'active status but terminal ready at an empty prompt')
    elif (state['nudged'] and not observation.wait_active
          and observation.prompt_empty
          and (idle_prompt(observation) if state.get('stall_reason') == 'alarm rang'
               else not observation.command_running or finished_active)
          and now - state['nudged_at'] >= IDLE_SECONDS):
        if observation.is_orchestrator and not state.get('user_notified'):
            actions = (Action(
                'notify-user', observation.agent,
                escalation_message(observation, state, now, 'user'),
            ),)
            state['user_notified'] = True
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_notified')):
            actions = (Action(
                'notify-orchestrator', observation.agent,
                escalation_message(observation, state, now, 'orchestrator'),
            ),)
            state['orchestrator_notified'] = True
            state['orchestrator_notified_at'] = now
            state['orchestrator_notice_task_revision'] = observation.task_card_revision
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_handled')
              and not state.get('user_notified')
              and now - state['orchestrator_notified_at'] >= IDLE_SECONDS):
            actions = (Action(
                'notify-user', observation.agent,
                escalation_message(observation, state, now, 'user'),
            ),)
            state['user_notified'] = True
    elif (active_stalled and not observation.wait_active
          and observation.status == 'active' and observation.command_running
          and not finished_active):
        if observation.is_orchestrator and not state.get('user_notified'):
            actions = (owner_notice(observation, state, now, 'active-command'),)
            state['user_notified'] = True
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_notified')):
            actions = (owner_notice(observation, state, now, 'active-command'),)
            state['orchestrator_notified'] = True
            state['orchestrator_notified_at'] = now
            state['orchestrator_notice_task_revision'] = observation.task_card_revision
    elif (stalled and not observation.wait_active and observation.status == 'blocked'):
        if observation.is_orchestrator and not state.get('user_notified'):
            actions = (owner_notice(observation, state, now, 'blocked'),)
            state['user_notified'] = True
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_notified')):
            actions = (owner_notice(observation, state, now, 'blocked'),)
            state['orchestrator_notified'] = True
            state['orchestrator_notified_at'] = now
            state['orchestrator_notice_task_revision'] = observation.task_card_revision
    if actions:
        state['decision'] = ('quota-issue' if actions[0].category == 'quota'
                             else actions[0].kind)
    elif covered:
        state['decision'] = 'capacity-covered'
    elif state.get('orchestrator_handled'):
        state['decision'] = 'orchestrator-handled'
    elif observation.wait_active:
        state['decision'] = 'valid-wait'
    elif observation.command_running:
        state['decision'] = 'command-running'
    elif queued_prompt and state.get('prompt_recovery_attempted'):
        state['decision'] = 'prompt-recovery-attempted'
    elif queued_prompt:
        state['decision'] = 'prompt-text-wait'
    elif not observation.prompt_empty:
        state['decision'] = 'prompt-not-empty'
    elif observation.status != 'listening':
        state['decision'] = 'not-listening'
    elif reset:
        state['decision'] = 'progress'
    elif state['nudged']:
        state['decision'] = 'already-nudged'
    else:
        state['decision'] = 'within-idle-threshold'
    return state, actions


COMMAND_TIMEOUT_SECONDS = 30
# A reap may wait out the 10-second SIGTERM grace period; it must still end within one cycle.
REAP_TIMEOUT_SECONDS = 45
_WAIT_LOCKS = threading.local()


def valid_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise ValueError(f'Invalid HCOM name: {value!r}')
    return value


@functools.lru_cache(maxsize=None)
def lat_dir(workspace):
    """All worktrees share the main checkout's .lat; never create one in a linked worktree."""
    return shared_lat_dir(workspace)


def watch_dir(workspace):
    return lat_dir(workspace) / 'watch'


def wait_path(workspace, agent):
    return watch_dir(workspace) / 'waits' / f'{valid_name(agent)}.json'


def state_path(workspace, orchestrator):
    return watch_dir(workspace) / valid_name(orchestrator) / 'state.json'


def read_object(path, default=None):
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return default
    if not isinstance(value, dict):
        raise ValueError(f'Expected a JSON object: {path}')
    return value


@contextlib.contextmanager
def wait_lock(path):
    """Hold one agent's wait-file lock; reentrant within a thread. Never hold it across hcom/herdr."""
    held = _WAIT_LOCKS.__dict__.setdefault('paths', set())
    if path in held:
        yield
        return
    lock_path = path.with_name(f'.{path.stem}.lock')
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        held.add(path)
        try:
            yield
        finally:
            held.discard(path)
            fcntl.flock(lock, fcntl.LOCK_UN)


def read_wait(path):
    """Read a declaration and its comparison bytes from the same revision."""
    if not path.parent.is_dir():
        return None, None
    try:
        with wait_lock(path):
            original = path.read_bytes()
    except FileNotFoundError:
        return None, None
    declaration = json.loads(original)
    if not isinstance(declaration, dict):
        raise ValueError(f'Expected a JSON object: {path}')
    return declaration, original


def rule_fingerprint(skill_dir):
    """Hash rule-file contents by relative name, excluding generated caches."""
    skill_dir = skill_dir.resolve(strict=True)
    files = [skill_dir / 'SKILL.md']
    caches = {'__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
    for path in (skill_dir / 'references').rglob('*'):
        relative = path.relative_to(skill_dir)
        if (path.is_file() and not caches.intersection(relative.parts)
                and path.suffix not in ('.pyc', '.pyo')):
            files.append(path)
    return {path.relative_to(skill_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(files) if path.is_file()}


write_object = write_json_atomic


def write_wait(path, value, *, expected):
    """Compare and replace a wait file under its lock."""
    with wait_lock(path):
        return write_object(path, value, expected=expected)


def run_command(command, failure=None):
    return run_cli(command, timeout=COMMAND_TIMEOUT_SECONDS, failure=failure)


def run_json(command):
    try:
        return json.loads(run_command(command))
    except json.JSONDecodeError as error:
        raise ValueError(f'{command[0]} returned invalid JSON') from error


def run_json_lines(command):
    try:
        return [json.loads(line) for line in run_command(command).splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise ValueError(f'{command[0]} returned invalid JSON Lines') from error


def parse_task(path):
    content = path.read_bytes()
    fields = {'_digest': hashlib.sha256(content).hexdigest()}
    for line in content.decode().splitlines():
        match = re.fullmatch(
            r'-\s+(agent|orchestrator|status|next step|live actions|preflight|native agent)：\s*(.*)',
            line)
        if match:
            fields[match.group(1)] = match.group(2).strip()
    return fields


def task_agent(field):
    match = CARD_AGENT.match(field)
    if not match:
        raise ValueError(f'agent field must start with an HCOM name: {field!r}')
    return match.group(1)


def card_digest(path, error):
    try:
        content = path.read_bytes()
    except OSError:
        content = str(error).encode()
    return hashlib.sha256(content).hexdigest()


def monitored_task_cards(tasks, orchestrator, incomplete=None):
    """Return (cards by agent, skipped {card name: (digest, error)}).

    When given, `incomplete` collects {card name: (digest, agent, missing envelope fields)}
    for monitored cards; those cards stay in the returned cards. Cards marked
    `native agent：是` (a Claude built-in agent, no HCOM name) carry `_native`; only their
    fields are checked, not their HCOM presence.
    """
    cards, skipped = {}, {}
    if not tasks.is_dir():
        raise ValueError(f'Missing task-card directory: {tasks}')
    for path in sorted(tasks.glob('*.md')):
        try:
            card = parse_task(path)
            if not same_controller(card.get('orchestrator', orchestrator), orchestrator):
                continue
            missing = [name for name in ('agent', 'orchestrator', 'status')
                       if name not in card]
            if missing:
                raise ValueError(f'missing task-card fields: {", ".join(missing)}')
            if card['status'] != 'merged':
                card['agent'] = task_agent(card['agent'])
                card['_updated_at'] = path.stat().st_mtime
                card['_path'] = str(path)
                # A prefix match, so a card copied from the template's 是（…） line counts.
                card['_native'] = card.get('native agent', '').startswith('是')
                cards.setdefault(card['agent'], card)
                unfilled = [name for name in ENVELOPE_FIELDS if not card.get(name)]
                if unfilled and incomplete is not None:
                    incomplete[path.name] = (card['_digest'], card['agent'], unfilled)
        except (OSError, ValueError) as error:
            skipped[path.name] = (card_digest(path, error), str(error))
    return cards, skipped


def monitored_agents(tasks, orchestrator):
    cards, _ = monitored_task_cards(tasks, orchestrator)
    return [valid_name(orchestrator), *hcom_card_agents(cards)]


def hcom_card_agents(cards):
    return [agent for agent, card in cards.items() if not card['_native']]


def read_watch_file(path, log, now):
    """Read a watcher-owned JSON object; move a corrupt file aside and start fresh."""
    try:
        return read_object(path, {})
    except ValueError as error:
        kept = path.with_name(f'{path.name}.corrupt-{int(now)}')
        path.replace(kept)
        append_log(log, {
            'at': now, 'decision': 'state-file-reset', 'actions': [],
            'file': path.name, 'kept': kept.name, 'error': str(error),
        })
        return {}


def reset_agent_state(path, log, now, agent, error):
    """Keep one copy of the state file for diagnosis, then log the agent's fresh start."""
    kept = path.with_name(f'{path.name}.corrupt-{int(now)}')
    if path.exists() and not kept.exists():
        shutil.copy2(path, kept)
    append_log(log, {
        'at': now, 'agent': agent, 'decision': 'agent-state-reset', 'actions': [],
        'kept': kept.name, 'error': error,
    })


def log_skipped_cards(path, log, skipped, now):
    """Log each skipped card once per content; forget cards that are fixed or gone."""
    logged = read_watch_file(path, log, now)
    current = {}
    for name, (digest, error) in skipped.items():
        seen = logged.get(name, [])
        if digest not in seen:
            append_log(log, {
                'at': now, 'card': name, 'decision': 'task-card-skipped',
                'actions': [], 'error': error,
            })
            seen = [*seen, digest]
        current[name] = seen
    if current != logged:
        write_object(path, current)


def notify_incomplete_cards(path, log, incomplete, orchestrator, workspace, now):
    """Ask the orchestrator once per card content to fill in missing envelope fields."""
    notified = read_watch_file(path, log, now)
    current = {}
    for name, (digest, agent, fields) in incomplete.items():
        seen = notified.get(name, [])
        if digest not in seen:
            action = Action(
                'notify-orchestrator', agent,
                f'LAT stall watcher: task card {name} has missing or empty required field(s): '
                f'{", ".join(fields)}. Add each as a `- <field>：<value>` line; write 無 '
                'when the task has no live actions, otherwise fill them in as described in '
                'references/task-cards.md. The agent stays monitored; this reminder is '
                'sent once per card content.',
                category='task-card-fields-missing')
            try:
                delivery = perform(action, orchestrator, workspace)
                seen = [*seen, digest]
                result = {'kind': action.kind, 'status': 'done', **delivery}
            except (OSError, ValueError) as error:
                result = {'kind': action.kind, 'status': 'failed', 'error': str(error)}
            append_log(log, {
                'at': now, 'card': name, 'decision': 'task-card-fields-missing',
                'fields': fields, 'actions': [action_record(action)],
                'action_results': [result],
            })
        if seen:
            current[name] = seen
    if current != notified:
        write_object(path, current)


def task_card_revision(card):
    if card is None:
        return ''
    return json.dumps([card['status'], card.get('next step', '')], ensure_ascii=False)


def list_hcom(orchestrator=None):
    caller = ['--name', orchestrator] if orchestrator else []
    value = run_json(['hcom', 'list', '--json', *caller])
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError('hcom list returned an invalid agent list')
    return {item.get('name'): item for item in value if isinstance(item.get('name'), str)}


def event_value(event, name, nested):
    data = event.get('data', {})
    containers = [event, data]
    for container in tuple(containers):
        child = container.get(nested, {}) if isinstance(container, dict) else {}
        if isinstance(child, dict):
            containers.append(child)
    for container in containers:
        if isinstance(container, dict) and name in container:
            return container[name]
    return None


def status_context(event):
    if event.get('type') != 'status':
        return None
    return event_value(event, 'status_context', 'status') or event_value(
        event, 'context', 'status')


def read_processes(proc_root=Path('/proc')):
    processes = []
    for directory in proc_root.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            _comm, separator, fields = (directory / 'stat').read_text().rpartition(') ')
            if not separator:
                continue
            stat = fields.split()
            command = tuple(
                value.decode(errors='replace')
                for value in (directory / 'cmdline').read_bytes().split(b'\0') if value
            )
            environment = tuple(
                value.decode(errors='replace')
                for value in (directory / 'environ').read_bytes().split(b'\0') if value
            )
            processes.append(Process(int(directory.name), int(stat[1]), int(stat[19]),
                                     stat[0], int(stat[3]), command, environment))
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, IndexError):
            continue
    return processes


def process_ancestors(pid, parents):
    ancestors = set()
    while pid in parents and parents[pid] not in ancestors:
        pid = parents[pid]
        ancestors.add(pid)
    return ancestors


def descendants_below(pid, parents, roots):
    """Return (root, lineage below it), or None when unrelated."""
    lineage = []
    seen = set()
    while pid in parents and pid not in seen:
        if pid in roots:
            return pid, lineage
        seen.add(pid)
        lineage.append(pid)
        pid = parents[pid]
    return (pid, lineage) if pid in roots else None


def background_process_running(agent, info, processes, current_pid=None):
    """Detect a surviving command tied to the HCOM-bound client process."""
    identity = info.get('launch_context', {}).get('pid_identity', '')
    try:
        client_starttime = int(identity.rsplit(':', 1)[1])
    except (AttributeError, ValueError, IndexError):
        return False
    process_id = info.get('launch_context', {}).get('process_id')
    process_marker = f'HCOM_PROCESS_ID={process_id}'
    clients = {process.pid for process in processes
               if process.starttime == client_starttime
               and (not process_id or process_marker in process.environment)}
    if not clients:
        return False
    process_by_pid = {process.pid: process for process in processes}
    parents = {process.pid: process.ppid for process in processes}
    current_pid = os.getpid() if current_pid is None else current_pid
    excluded = process_ancestors(current_pid, parents) | {current_pid}
    for client in clients:
        excluded |= process_ancestors(client, parents)
    base_name = info.get('base_name') or agent.rsplit('-', 1)[-1]
    owner_marker = process_marker if process_id else f'HCOM_INSTANCE_NAME={base_name}'
    client_sessions = {process_by_pid[pid].session for pid in clients}
    for process in processes:
        if process.pid in clients or process.pid in excluded or process.state == 'Z':
            continue
        provenance = descendants_below(process.pid, parents, clients)
        same_agent = owner_marker in process.environment
        belongs_to_client = provenance is not None
        if not same_agent and not belongs_to_client:
            continue
        if belongs_to_client:
            client, lineage = provenance
            # Tool commands run in a separate session. Resident MCP/language-server
            # helpers inherit the client session even when the client was shell-launched.
            if any(process_by_pid[pid].session != process_by_pid[client].session
                   for pid in lineage):
                return True
            continue
        # A detached tool may be reparented after its shell exits; its HCOM marker
        # and separate session retain provenance without guessing from executable names.
        if process.session not in client_sessions:
            return True
    return False


def delivery_sender(event):
    context = status_context(event)
    if isinstance(context, str) and context.startswith('deliver:'):
        return context[len('deliver:'):]
    return None


def request_watch_notice(message):
    """HCOM's own "X went idle without responding to your request" notice."""
    text = event_value(message, 'text', 'data')
    return (event_value(message, 'from', 'data') == '[hcom-events]'
            and isinstance(text, str) and '[sub:reqwatch-' in text)


def message_releases_wait(message):
    if request_watch_notice(message):
        return False
    return event_value(message, 'intent', 'data') not in ('inform', 'ack')


def wait_release_reason(declaration, participant_events, target_replied, decision_pending,
                        messages=None):
    """Explain why a wait is no longer valid, or return None.

    messages are the message events delivered to the waiter; a delivery frees the wait only if
    one is not an inform/ack, whoever sent it. None or empty releases on any delivery.
    """
    if target_replied:
        return 'target-replied'
    if any(delivery_sender(event) is not None for event in participant_events):
        if not messages or any(message_releases_wait(m) for m in messages):
            return 'message-delivered'
    if decision_pending is False:
        return 'decision-resolved'
    return None


def delivered_messages(orchestrator, waiting_info, participant_events, after):
    """Message events delivered to the waiting agent since the wait began.

    One deliver status can stand for a batch (its context names the first sender, its position
    the last message), so read the messages themselves. A message sent before the wait but
    delivered after it counts, so the lower bound is the last delivery before the wait, not
    the wait's own time (no earlier delivery: no lower bound).
    """
    positions = [position for event in participant_events if delivery_sender(event) is not None
                 and type(position := event_value(event, 'position', 'status')) is int]
    names = {waiting_info.get('name'), waiting_info.get('base_name')} - {None}
    if not positions or not names:
        return []
    earlier = [position for event in session_events(
        orchestrator, waiting_info, '--context', 'deliver:*', '--before', after, '--last', '1')
        if delivery_sender(event) is not None
        and type(position := event_value(event, 'position', 'status')) is int]
    # With no earlier delivery every message to the waiter is part of this window.
    floor = f'id > {max(earlier)} AND ' if earlier else ''
    messages = hcom_events(orchestrator, '--type', 'message', '--sql',
                           f'{floor}id <= {max(positions)}')
    return [message for message in messages if message.get('type') == 'message'
            and names & set(event_value(message, 'delivered_to', 'data') or ())]


def idle_prompt(observation):
    """An empty ready terminal is usable only after the agent's turn ends."""
    if observation.client.lower() == 'claude':
        # Claude hooks report the turn end; the screen only confirms an empty prompt.
        return (observation.status == 'listening' and observation.prompt_empty is True
                and not observation.input_text and not observation.screen_working)
    ready = (observation.terminal_ready if observation.terminal_ready is not None
             else not observation.command_running)
    if not observation.prompt_empty or not ready or observation.screen_working:
        return False
    if observation.client.lower() == 'codex' and observation.codex_turn_finished is False:
        return False
    return (observation.status == 'listening'
            or (observation.status == 'active' and observation.client.lower() == 'codex'
                and observation.codex_turn_finished is True))


def usage_dir():
    """Where the status line recorder writes <session_id>.json."""
    configured = os.environ.get('LAT_USAGE_DIR')
    if configured:
        return Path(configured)
    state = os.environ.get('XDG_STATE_HOME', '')
    return (Path(state) if state.startswith('/') else Path.home() / '.local/state') / 'lat/usage'


def read_prompt_cache(session_id):
    """Return the status line recorder's prompt_cache object for a session, else None."""
    if not isinstance(session_id, str) or not NAME.fullmatch(session_id):
        return None
    try:
        record = json.loads((usage_dir() / f'{session_id}.json').read_text())
    except (OSError, ValueError):
        return None
    cache = record.get('prompt_cache') if isinstance(record, dict) else None
    return cache if isinstance(cache, dict) else None


def cache_expires_at(session_id, now):
    """Return the warm, unexpired prompt-cache expiry for a session, else None."""
    cache = read_prompt_cache(session_id)
    if cache is None or cache.get('warm') is not True:
        return None
    expires_at = cache.get('expires_at')
    if type(expires_at) not in (int, float) or expires_at <= now:
        return None
    return expires_at


def keepalive_blocker(declaration, observation, now, busy=False):
    """Why a keep-alive cannot be typed now regardless of the cache expiry, else None."""
    if not observation.is_orchestrator:
        return 'not-orchestrator'
    if not declaration or not declaration.get('active', True) or not observation.wait_active:
        return 'no-wait'
    if observation.quota_issue and observation.quota_issue.kind == 'rate-limit':
        return 'rate-limited'
    if busy:
        return 'other-action'
    if observation.status != 'listening':
        return f'status-{observation.status}'
    if not observation.prompt_readable:
        return 'prompt-unreadable'
    if observation.screen_working:
        return 'screen-working'
    if not idle_prompt(observation):
        return 'prompt-not-empty'
    kind = declaration.get('kind')
    if kind in ('decision', 'alarm'):
        if now - declaration['declared_at'] >= KEEPALIVE_DECISION_SECONDS:
            return f'{kind}-over-3h'
        start, end = KEEPALIVE_QUIET_HOURS
        if start <= time.localtime(now).tm_hour < end:
            return f'{kind}-quiet-hours'
    return None


def keepalive_due(declaration, observation, info, state, now, busy=False):
    """Return (cache expiry, skip reason); send the keep-alive when only the expiry is set.

    A skipped keep-alive keeps its expiry (None for usage-missing). Both are None when
    nothing is due: the cache is not within ten minutes of
    expiring, is cold or expired, this expiry was already kept warm, or there is no wait.
    """
    if observation.client.lower() != 'claude':
        return None, None
    reason = keepalive_blocker(declaration, observation, now, busy)
    if reason in ('no-wait', 'not-orchestrator'):
        return None, None
    if read_prompt_cache(info.get('session_id')) is None:
        return None, 'usage-missing'
    expires_at = cache_expires_at(info.get('session_id'), now)
    if expires_at is None or expires_at - now > KEEPALIVE_SECONDS:
        return None, None
    sent = state.get('keepalive')
    if isinstance(sent, dict) and sent.get('expires_at') == expires_at:
        return None, None
    return expires_at, reason


def expire_alarm(saved, now, failure):
    saved.update(active=False, released_reason='undelivered', delivery_failure=failure,
                 released_at_utc=datetime.fromtimestamp(now, timezone.utc).isoformat())


def alarm_notification(saved, observation):
    message = (f"LAT stall watcher: agent {observation.agent} alarm was undelivered: "
               f"{saved['reason']}; {saved['delivery_failure']}. Check the agent and continue.")
    return Action('notify-user' if observation.is_orchestrator else 'notify-orchestrator',
                  observation.agent, message,
                  category='alarm-popup' if saved.get('alarm_conversation_delivered') else 'alarm-notice')


def decide_alarm(declaration, observation, condition_met, now):
    """Decide alarm delivery without marking unconfirmed input as delivered."""
    saved = dict(declaration)
    actions, events = [], []
    if saved.get('active', True):
        if saved.get('due_at') is None:
            if condition_met:
                saved.update(due_at=now, outcome='condition met')
            elif now >= saved['timeout_at']:
                saved.update(due_at=saved['timeout_at'], outcome='timed out')
                events.append('alarm-timeout')
        due = saved.get('due_at')
        if due is not None and now >= due:
            saved.setdefault('outcome', 'condition met')
            if idle_prompt(observation):
                text = (f"[lat-watch] Your alarm {saved['outcome']}: {saved['reason']}. "
                        'Continue your work.')
                actions.append(Action('nudge', observation.agent, text=text, category='alarm-ring'))
            elif now >= due + IDLE_SECONDS:
                failure = ('window unavailable' if observation.status == 'unavailable' else
                           'input prompt not empty' if not observation.prompt_empty else 'command running')
                expire_alarm(saved, now, failure)
                events.append('alarm-undelivered')
    if saved.get('released_reason') == 'undelivered' and not saved.get('alarm_notified'):
        actions.append(alarm_notification(saved, observation))
    return saved, actions, events


def foreground_running(observation):
    """Claude reports a running turn as active; other clients by the terminal not ready."""
    if observation.client.lower() == 'claude':
        return observation.status == 'active'
    return observation.terminal_ready is False


def decide_wait(declaration, observation, target_observation, target_state, now,
                *, waits_for_orchestrator=False):
    """Return a deadline declaration, delivery requests and lifecycle log events."""
    if (not declaration or declaration.get('kind') in ('decision', 'alarm')
            or waits_for_orchestrator):
        return declaration, [], []
    saved = dict(declaration)
    actions, events = [], []
    deadline = saved.setdefault('deadline_at', saved['declared_at'] + 60 * 60)
    if saved.get('active', True) and now >= deadline:
        # Background processes alone do not count, and the extension is capped.
        extending = (now < deadline + WAIT_EXTENSION_SECONDS
                     and target_observation is not None and not target_observation.wait_active
                     and (foreground_running(target_observation)
                          or (target_state is not None
                              and now - target_state['last_progress_at'] < ACTIVE_SECONDS)))
        if extending:
            if not saved.get('deadline_extended'):
                events.append('wait-extended')
                saved['deadline_extended'] = True
        else:
            saved.update(active=False, released_reason='expired',
                         released_at_utc=datetime.fromtimestamp(now, timezone.utc).isoformat(),
                         expiry_nudge_pending=True,
                         expiry_count=saved.get('expiry_count', 0) + 1)
            times = [*saved.get('expiry_declared_at', []), saved['declared_at_utc']][:2]
            saved['expiry_declared_at'] = times
            events.append('wait-expired')
    if saved.get('expiry_nudge_pending') and idle_prompt(observation):
        minutes = int((now - saved['declared_at']) // 60)
        text = (f"[lat-watch] Your wait for {saved['target']} expired after {minutes} minutes. "
                'Check that agent status, continue your work or declare a new wait.')
        actions.append(Action('nudge', observation.agent, text=text, category='wait-expiry'))
    notice = saved.get('expiry_notice')
    if saved.get('expiry_count', 0) >= 2 and not saved.get('expiry_notified') and not notice:
        notice = dict(target=saved['target'], declared_at=saved['expiry_declared_at'],
                      conversation_delivered=False, delivered=False)
        saved['expiry_notice'] = notice
    if notice and not notice['delivered'] and not saved.get('expiry_notified'):
        times = notice['declared_at']
        message = (f"LAT stall watcher: agent {observation.agent} has consecutive expired waits "
                   f"for {notice['target']}; declarations: {times[0]}, {times[1]}. "
                   'Check the awaited agent and decide how to continue.')
        actions.append(Action('notify-user' if observation.is_orchestrator
                              else 'notify-orchestrator', observation.agent, message,
                              category=('wait-expiry-popup' if notice['conversation_delivered']
                                        else 'wait-expiry')))
    return saved, actions, events


def pending_decision(decisions, target, *, log=None, agent=None):
    matches = [path for path in decisions.glob(f'{target}*') if path.is_file()]
    if not matches:
        return None
    pending = False
    for path in matches:
        try:
            status = read_decision_status(path)
        except (OSError, UnicodeError) as error:
            status = DecisionStatus(None, str(error))
        if status.error:
            pending = True
            if log is not None:
                append_log(log, {
                    'at': time.time(), 'agent': agent,
                    'decision': 'decision-status-unreadable', 'actions': [],
                    'file': str(path), 'error': status.error,
                    'target': target, 'treated_as_pending': True,
                })
        elif status.status == 'pending':
            pending = True
    return pending


def latest_event_id(events):
    ids = []
    for event in events:
        value = event.get('id')
        if isinstance(value, int):
            ids.append(value)
        elif isinstance(value, str) and value.isdigit():
            ids.append(int(value))
    return max(ids, default=0)


def hcom_events(orchestrator, *filters):
    return run_json_lines(['hcom', 'events', *filters, '--full', '--name', orchestrator])


def agent_info(agents, name):
    """Resolve a canonical name, or an unambiguous base name, from hcom list."""
    if name in agents:
        return agents[name]
    matches = [item for item in agents.values() if item.get('base_name') == name]
    return matches[0] if len(matches) == 1 else None


def session_events(orchestrator, info, *filters, after_id=None):
    """Read only events carrying the exact session identity from hcom list."""
    session_id = info.get('session_id') if isinstance(info, dict) else None
    if not isinstance(session_id, str) or not session_id:
        return []
    quoted = session_id.replace("'", "''")
    query = f"json_extract(data, '$.session') = '{quoted}'"
    if after_id is not None:
        query += f" AND id > {int(after_id)}"
    events = hcom_events(orchestrator, *filters, '--sql', query)
    return [event for event in events
            if event_value(event, 'session', 'status') == session_id]


def after_timestamp(value, threshold):
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        boundary = datetime.fromisoformat(threshold.replace('Z', '+00:00'))
    except (AttributeError, TypeError, ValueError):
        return False
    try:
        return parsed >= boundary
    except TypeError:
        return False


def hcom_send_command(value):
    return (isinstance(value, str)
            and re.search(r'(?:^|&&|\|\||[;|\r\n])\s*hcom\s+send(?:\s|$)', value)
            is not None)


def inform_or_ack_send(command, recipient=None):
    """True when every hcom send to recipient in a shell command is an inform/ack.

    Commands are tokenized with shell quoting, so operators inside a message body do not split
    a send. Sends to others are ignored; no send to recipient found, or an unparsable command,
    is False (the wait releases).
    """
    if not isinstance(command, str):
        return False
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|\n')
        lexer.whitespace = ' \t\r'
        lexer.whitespace_split = True
        words = list(lexer)
    except ValueError:
        return False

    def addressed(word):
        if recipient is None:
            return True
        name = word[1:]
        return (name == recipient or recipient.endswith('-' + name)
                or (name.endswith('-') and recipient.startswith(name)))

    intents = []
    for start, word in enumerate(words[:-1]):
        if word != 'hcom' or words[start + 1] != 'send':
            continue
        intent, targets = None, []
        for index in range(start + 2, len(words)):
            option = words[index]
            if option == '--' or set(option) <= set(';&|\n'):
                break
            if option == '--intent' and index + 1 < len(words):
                intent = words[index + 1]
            elif option.startswith('--intent='):
                intent = option[len('--intent='):]
            elif option.startswith('@'):
                targets.append(option)
        if any(addressed(target) for target in targets):
            intents.append(intent)
    return bool(intents) and all(intent in ('inform', 'ack') for intent in intents)


def successful_send_output(value, recipient=None):
    if not isinstance(value, str):
        return False
    matches = re.findall(r'^Sent to:\s*(.+)$', value, re.MULTILINE)
    if recipient is None:
        return bool(matches)
    if not isinstance(recipient, str) or not recipient:
        return False
    pattern = rf'(?<![A-Za-z0-9_-]){re.escape(recipient)}(?![A-Za-z0-9_-])'
    return any(re.search(pattern, recipients) for recipients in matches)


def successful_hcom_send_since(transcript, declared_at, recipient=None, skip_inform_ack=False):
    """Find a completed hcom send in one exact agent transcript.

    skip_inform_ack ignores sends whose command carries --intent inform or ack.
    """
    claude_hcom_send_ids = set()
    try:
        lines = Path(transcript).open()
    except (FileNotFoundError, OSError):
        return False
    with lines:
        for line in lines:
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(record, dict):
                continue
            completed_after_wait = after_timestamp(record.get('timestamp'), declared_at)

            message = record.get('message', {})
            content = message.get('content', []) if isinstance(message, dict) else []
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    command = item.get('input', {}).get('command') \
                        if isinstance(item.get('input'), dict) else None
                    if (item.get('type') == 'tool_use' and item.get('name') == 'Bash'
                            and isinstance(item.get('id'), str)
                            and hcom_send_command(command)
                            and not (skip_inform_ack and inform_or_ack_send(command, recipient))):
                        claude_hcom_send_ids.add(item['id'])
                    if (completed_after_wait and item.get('type') == 'tool_result'
                            and item.get('tool_use_id') in claude_hcom_send_ids
                            and item.get('is_error') is False
                            and successful_send_output(
                                item.get('content'), recipient=recipient)):
                        return True

            if not completed_after_wait:
                continue

            payload = record.get('payload', {})
            item = payload.get('item', {}) if isinstance(payload, dict) else {}
            if not isinstance(item, dict):
                item = {}
            command = item.get('command') if isinstance(item, dict) else None
            shell_command = command[-1] if isinstance(command, list) and command else None
            if (record.get('type') == 'event_msg'
                    and payload.get('type') == 'item_completed'
                    and item.get('type') == 'CommandExecution'
                    and hcom_send_command(shell_command)
                    and not (skip_inform_ack and inform_or_ack_send(shell_command, recipient))
                    and item.get('status') == 'completed'
                    and item.get('exit_code') == 0
                    and successful_send_output(
                        item.get('stdout'), recipient=recipient)):
                return True
    return False


def release_wait_if_needed(workspace, decisions, orchestrator, declaration, agents=None,
                           *, expected=_UNSET):
    if not declaration or declaration.get('kind') == 'alarm' or (not declaration.get('active', True)
                           and declaration.get('released_reason') != 'expired'):
        return None
    if expected is _UNSET:
        current, expected = read_wait(wait_path(workspace, declaration['agent']))
        if current != declaration:
            raise ValueError('Concurrent wait declaration change detected')
    after = declaration['declared_at_utc']
    agent = declaration['agent']
    target = declaration['target']
    agents = list_hcom(orchestrator) if agents is None else agents
    waiting_info = agent_info(agents, agent)
    participant = session_events(
        orchestrator, waiting_info, '--after', after)
    decision = pending_decision(
        decisions, target,
        log=state_path(workspace, orchestrator).with_name('watch.jsonl'), agent=agent)
    target_info = agent_info(agents, target)
    transcript = target_info.get('transcript_path') if target_info else None
    waiting_name = waiting_info.get('name') if waiting_info else None
    target_replied = bool(
        decision is None and transcript and waiting_name
        and successful_hcom_send_since(
            transcript, after, waiting_name, skip_inform_ack=True))
    reason = wait_release_reason(
        declaration, participant, target_replied, decision,
        delivered_messages(orchestrator, waiting_info or {}, participant, after))
    if reason:
        updated = dict(declaration, active=False, expiry_count=0, expiry_declared_at=[],
                       expiry_notified=False, expiry_nudge_pending=False, released_reason=reason,
                       released_at_utc=datetime.now(timezone.utc).isoformat())
        if updated.get('expiry_notice', {}).get('delivered'):
            updated.pop('expiry_notice', None)
        elif updated.get('expiry_notice'):
            updated['expiry_notice'] = {**updated['expiry_notice'], 'episode_reset': True}
        write_wait(wait_path(workspace, agent), updated, expected=expected)
    return reason


def observe(workspace, decisions, orchestrator, agent, info, card=None, *, processes):
    status_issue = hcom_quota_issue(info)
    try:
        terminal = run_json(['hcom', 'term', agent, '--json', '--name', orchestrator])
    except (OSError, ValueError):
        if status_issue is None:
            raise
        terminal = {'ready': True, 'prompt_empty': True, 'input_text': '', 'lines': []}
    if not isinstance(terminal, dict):
        raise ValueError(f'hcom term returned invalid data for {agent}')
    if not isinstance(terminal.get('ready'), bool):
        raise ValueError(f'hcom term omitted boolean ready for {agent}')
    input_text = terminal.get('input_text', '')
    if input_text is None:
        input_text = ''
    elif not isinstance(input_text, str):
        raise ValueError(f'hcom term returned invalid input_text for {agent}')
    lines = terminal.get('lines', [])
    client = info.get('tool', 'unknown')
    if not isinstance(client, str):
        client = 'unknown'
    transcript = info.get('transcript_path')
    claude_notice = current_claude_quota_notice(transcript)
    screen_issue = detect_screen_quota(lines, client, claude_notice=claude_notice)
    menu_screen = claude_quota_menu(terminal) if client.lower() == 'claude' else ()
    if menu_screen:
        screen_issue = QuotaIssue('rate-limit', 'Claude rate-limit-options menu')
    prompt_empty = terminal.get('prompt_empty')
    prompt_readable = isinstance(prompt_empty, bool)
    if not prompt_readable:
        # A menu opened at a listening Claude prompt (/model, /rate-limit-options) has no
        # input box; typing there would pick a menu entry.
        listening_claude = client.lower() == 'claude' and info.get('status') == 'listening'
        if info.get('status') == 'blocked' or screen_issue or status_issue or listening_claude:
            prompt_empty = False
        else:
            raise ValueError(f'hcom term omitted boolean prompt_empty for {agent}')
    model = info.get('model')
    if not isinstance(model, str) or not model:
        model = screen_model(lines, client)
    unread_count = validated_unread_count(info, agent)
    transcript_size = 0
    transcript_mtime_ns = 0
    if isinstance(transcript, str) and transcript:
        try:
            stat = Path(transcript).stat()
            transcript_size = stat.st_size
            transcript_mtime_ns = stat.st_mtime_ns
        except OSError:
            pass
    own_events = session_events(orchestrator, info, '--last', '1')
    event_id = latest_event_id(own_events)
    declaration, wait_original = read_wait(wait_path(workspace, agent))
    released = release_wait_if_needed(
        workspace, decisions, orchestrator, declaration, expected=wait_original)
    active_wait = bool(declaration and declaration.get('active', True) and not released)
    orchestrator_wait_started_at = 0
    if agent != orchestrator:
        orchestrator_wait = read_object(wait_path(workspace, orchestrator))
        if orchestrator_wait and orchestrator_wait.get('target') == agent:
            declared_at = orchestrator_wait.get('declared_at', 0)
            if isinstance(declared_at, (int, float)):
                orchestrator_wait_started_at = declared_at
    ready = terminal.get('ready') is True
    background_running = background_process_running(agent, info, processes)
    quota_issue = screen_issue or status_issue
    return Observation(
        agent=agent,
        status=info.get('status', 'missing'),
        prompt_empty=prompt_empty,
        command_running=not ready or background_running,
        terminal_ready=ready,
        screen_working=any(
            isinstance(line, str) and re.search(
                r'^(?:Working\s*\(|[✢✳✶✻✽·*]\s+).*esc to interrupt', line.strip(), re.IGNORECASE)
            for line in lines),
        transcript_size=transcript_size,
        transcript_mtime_ns=transcript_mtime_ns,
        event_id=event_id,
        wait_active=active_wait,
        wait_released=released is not None,
        is_orchestrator=agent == orchestrator,
        task_card_revision=task_card_revision(card),
        task_card_updated_at=card.get('_updated_at', 0) if card else 0,
        orchestrator_wait_started_at=orchestrator_wait_started_at,
        input_text=input_text,
        unread_count=unread_count,
        client=client,
        model=model,
        quota_issue=quota_issue,
        codex_turn_finished=(codex_turn_finished(transcript)
                             if client.lower() == 'codex' else None),
        prompt_readable=prompt_readable,
        screen_tail=tuple(line[:SCREEN_TAIL_CHARS] for line in lines[-SCREEN_TAIL_LINES:]
                          if isinstance(line, str)),
        quota_screen=(tuple(lines[-30:]) if client.lower() == 'claude' and quota_issue
                      and quota_issue.kind != 'crash' else ()),
        screen_digest=hashlib.sha256('\n'.join(lines).encode()).hexdigest(),
        capacity_covered=(client.lower() == 'codex' and quota_issue is not None
                          and quota_issue.kind == 'model-capacity'
                          and spawn_watch_covers(agent)),
    )


def append_log(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Other processes (alarm registration) append too; the directory lock keeps rotation atomic.
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        fcntl.flock(directory, fcntl.LOCK_EX)
        with contextlib.suppress(FileNotFoundError):
            if path.stat().st_size > LOG_ROTATE_BYTES:
                # Keep only the current file and one older one.
                os.replace(path, path.with_name(f'{path.name}.1'))
        with path.open('a') as stream:
            stream.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(directory)


def action_record(action):
    record = {'kind': action.kind, 'agent': action.agent}
    if action.message:
        record['message'] = action.message
    if action.category:
        record['category'] = action.category
    return record


def perform_nudge(action, orchestrator, workspace=None):
    run_command(
        ['hcom', 'term', 'inject', action.agent, action.text or NUDGE,
         '--enter', '--name', orchestrator],
        failure=f'hcom inject failed for {action.agent}',
    )
    return {'delivery': 'terminal'}


def perform_capacity_continue(action, orchestrator, workspace=None):
    """Type Continue unless spawn-watch now covers the agent.

    The check and the typing hold the lock spawn-watch takes to start covering an agent,
    and <agent>.continued.json tells spawn-watch when this Continue was typed and how long
    the transcript was, so a watcher that starts covering meanwhile neither types again,
    restarts the 5 minutes nor misses output written since.
    """
    directory = spawn_capacity_dir()
    directory.mkdir(parents=True, exist_ok=True)
    lock = os.open(directory, os.O_RDONLY)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if spawn_watch_covers(action.agent):
            return {'delivery': 'skipped', 'reason': 'spawn-watch covers the agent'}
        transcript, size = transcript_now(action.agent, orchestrator)
        result = perform_nudge(action, orchestrator, workspace)
        write_json_atomic(directory / f'{action.agent}.continued.json',
                          {'at': time.time(), 'transcript': transcript, 'size': size})
        return result
    finally:
        os.close(lock)


def transcript_now(agent, orchestrator):
    """(transcript path, size) of an agent, or (None, None) when unknown."""
    try:
        path = run_json(['hcom', 'list', agent, '--json', '--name', orchestrator])
        path = path.get('transcript_path') if isinstance(path, dict) else None
        return (path, Path(path).stat().st_size) if path else (None, None)
    except (OSError, ValueError):
        return None, None


def send_notification(action, orchestrator, intent):
    run_command(
        ['hcom', 'send', f'@{orchestrator}', '--intent', intent,
         '--from', 'lat-watch', '--name', orchestrator, '--', action.message],
        failure=f'hcom notification failed for {orchestrator}',
    )


def perform_notify_orchestrator(action, orchestrator, workspace=None):
    send_notification(action, orchestrator, 'request')
    return {'delivery': 'hcom'}


def herdr_label(kind, identifier):
    result = run_json(['herdr', kind, 'get', identifier])['result'][kind]
    return result['label'], result


def popup_title(agent, orchestrator, label):
    """One short line for the Herdr popup: client, reason, then where the agent is."""
    client = ''
    place = []
    try:
        info = list_hcom(orchestrator)[agent]
        client = info.get('tool') or ''
        _label, pane = herdr_label('pane', info['launch_context']['pane_id'])
        tab_label, tab = herdr_label('tab', pane['tab_id'])
        place = [herdr_label('workspace', tab['workspace_id'])[0]]
        # A tab already named after the agent would say its name twice.
        if agent.lower() not in str(tab_label).lower():
            place.append(tab_label)
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return ' '.join([f'{client}{label}:', *map(str, place), agent])


def show_popup(agent, orchestrator, label):
    run_command(
        ['herdr', 'notification', 'show', popup_title(agent, orchestrator, label),
         '--sound', 'request'],
        failure='Herdr notification failed',
    )


def perform_notify_user(action, orchestrator, workspace=None):
    if action.category not in ('wait-expiry-popup', 'alarm-popup', 'ledger-user-popup'):
        send_notification(action, orchestrator, 'inform')
    try:
        show_popup(action.agent, orchestrator, action.label or '停住')
    except (OSError, ValueError) as error:
        return {'delivery': 'hcom-only', 'herdr_error': str(error)}
    return {'delivery': 'hcom+herdr'}


def backup_prompt_text(workspace, agent, text):
    directory = watch_dir(workspace)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        dir=directory, prefix=f'prompt-{valid_name(agent)}-', suffix='.txt')
    path = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            descriptor = -1
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise
    return path


def read_terminal_input(agent, orchestrator):
    terminal = run_json(['hcom', 'term', agent, '--json', '--name', orchestrator])
    text = terminal.get('input_text') if isinstance(terminal, dict) else None
    if not isinstance(text, str):
        raise ValueError(f'hcom term omitted input_text for {agent}')
    return text


def wait_for_terminal_edit(agent, orchestrator, previous):
    """Poll briefly for a keypress to appear in the terminal snapshot."""
    deadline = time.monotonic() + PROMPT_SETTLE_SECONDS
    while True:
        current = read_terminal_input(agent, orchestrator)
        if current != previous or time.monotonic() >= deadline:
            return current
        time.sleep(PROMPT_POLL_SECONDS)


def read_prompt_status(agent, orchestrator):
    info = list_hcom(orchestrator).get(agent)
    if info is None:
        raise ValueError(f'agent missing from hcom list: {agent}')
    unread_count = validated_unread_count(info, agent)
    text = read_terminal_input(agent, orchestrator)
    return text, unread_count


def send_prompt_notification(agent, orchestrator, message):
    result = {}
    try:
        send_notification(Action('notify-user', orchestrator, message), orchestrator, 'inform')
        result['hcom'] = 'done'
    except (OSError, ValueError) as error:
        result['hcom'] = 'failed'
        result['hcom_error'] = str(error)
    try:
        show_popup(agent, orchestrator, '輸入未送出')
        result['herdr'] = 'done'
    except (OSError, ValueError) as error:
        result['herdr'] = 'failed'
        result['herdr_error'] = str(error)
    return result


def perform_prompt_recovery(action, orchestrator, workspace=None):
    if workspace is None:
        raise ValueError('Prompt recovery requires a workspace')
    try:
        saved = backup_prompt_text(workspace, action.agent, action.text)
    except (OSError, ValueError) as error:
        reason = 'prompt text backup failed; input not cleared'
        message = (f'LAT stall watcher: agent {action.agent}. Reason: {reason}: {error}. '
                   f'Original prompt text:\n{action.text}')
        return {'reason': reason, **send_prompt_notification(
            action.agent, orchestrator, message)}

    backspaces = 0
    reason = 'prompt text backed up and cleared'
    rearm = False
    uncertain = False
    try:
        current, unread_count = read_prompt_status(action.agent, orchestrator)
    except (OSError, ValueError) as error:
        current = action.text
        unread_count = 0
        reason = f'prompt clear could not be confirmed; no retry: {error}'
    if reason == 'prompt text backed up and cleared' and current != action.text:
        reason = 'prompt text changed before clearing; not cleared'
        rearm = True
    elif reason == 'prompt text backed up and cleared' and unread_count == 0:
        reason = 'queued messages no longer present; input not cleared'
    while reason == 'prompt text backed up and cleared' and current:
        try:
            run_command(
                ['hcom', 'term', 'inject', action.agent, '\x7f',
                 '--name', orchestrator],
                failure=f'hcom backspace failed for {action.agent}',
            )
            backspaces += 1
            updated = wait_for_terminal_edit(action.agent, orchestrator, current)
        except (OSError, ValueError) as error:
            uncertain = True
            reason = f'prompt clear could not be confirmed; no retry: {error}'
            break
        if len(updated) >= len(current):
            reason = ('input text not editable (possible tool UI text)'
                      if backspaces == 1 else 'prompt text did not clear; no retry')
            break
        if not current.startswith(updated):
            reason = 'prompt text changed while clearing; stopped'
            current = updated
            break
        current = updated

    saved_text = str(saved)
    message = (f'LAT stall watcher: agent {action.agent}. Reason: {reason}. '
               f'Saved file: {saved_text}. Backspaces sent: {backspaces}. '
               f'Original prompt text:\n{action.text}')
    return {
        'reason': reason,
        'saved_path': saved_text,
        'backspaces': backspaces,
        '_remaining_input': current,
        '_prompt_rearm': rearm,
        '_prompt_uncertain': uncertain,
        **send_prompt_notification(action.agent, orchestrator, message),
    }


def apply_prompt_recovery_result(state, result, now):
    remaining = result.pop('_remaining_input', None)
    rearm = result.pop('_prompt_rearm', False)
    uncertain = result.pop('_prompt_uncertain', False)
    if remaining is None:
        return
    if remaining:
        state.pop('prompt_text', None)
        state['prompt_text_hash'] = prompt_digest(remaining)
        state['prompt_recovery_attempted'] = not rearm
        if uncertain:
            state['prompt_recovery_uncertain'] = True
            state['prompt_recovery_attempted'] = True
        if rearm:
            state['prompt_text_since'] = now
    else:
        state.pop('prompt_text', None)
        state.pop('prompt_text_hash', None)
        state.pop('prompt_text_since', None)
        state.pop('prompt_recovery_attempted', None)


def observation_record(observation):
    record = observation._asdict()
    text = record.pop('input_text')
    record.pop('screen_tail')
    record.pop('quota_screen')
    record['input_text_length'] = len(text)
    return record


ACTION_POLICIES = {
    'nudge': (perform_nudge, 'nudged', ('nudged_at',)),
    'notify-orchestrator': (
        perform_notify_orchestrator,
        'orchestrator_notified',
        ('orchestrator_notified_at', 'orchestrator_notice_task_revision'),
    ),
    'notify-user': (perform_notify_user, 'user_notified', ()),
    'recover-prompt': (perform_prompt_recovery, None, ()),
    'capacity-continue': (perform_capacity_continue, None, ()),
}


def action_policy(kind):
    try:
        return ACTION_POLICIES[kind]
    except KeyError as error:
        raise ValueError(f'Unsupported watch action: {kind}') from error


def perform(action, orchestrator, workspace=None):
    handler, _flag, _cleanup_fields = action_policy(action.kind)
    return handler(action, valid_name(orchestrator), workspace)


def roll_back(action, state):
    _handler, flag, cleanup_fields = action_policy(action.kind)
    if action.category == 'quota':
        if 'capacity_continue_at' in state:
            # Keep the episode so Continue is not typed again; the notice retries next cycle.
            state['capacity_continue_notified'] = False
        else:
            state['quota_notified'] = False
        return
    if action.category == 'unreadable-screen':
        # The notice retries next cycle; the log line is already written.
        state.get('prompt_unreadable', {}).pop('notified', None)
        return
    if action.kind == 'capacity-continue':
        state['quota_notified'] = False
        state.pop('capacity_continue_at', None)
        return
    if flag is not None:
        state[flag] = False
    for field in cleanup_fields:
        state.pop(field, None)


LEDGER_SCRIPT = Path(__file__).resolve().with_name('lat-ledger.py')
LEDGER_DECISIONS = {'start': 'ledger-start-missing', 'estimate': 'ledger-estimate-passed',
                    'deadline': 'ledger-deadline-passed', 'user': 'ledger-user-notified'}


@functools.lru_cache(maxsize=None)
def ledger_module():
    spec = importlib.util.spec_from_file_location('lat_ledger', LEDGER_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ledger_location(workspace, orchestrator, fallback=None):
    """This round's ledger: `ledger_path` in the orchestrator's active session record.

    `fallback` (the run --ledger argument) applies when no such record names one; None means
    the round has no ledger and the due checks are skipped.
    """
    for path in sorted((lat_dir(workspace) / 'sessions').glob('*.json')):
        try:
            record = read_object(path, {})
        except (OSError, ValueError):
            continue
        if (record.get('role') == 'orchestrator' and record.get('status') == 'active'
                and record.get('hcom_name') == orchestrator
                and record.get('workspace') == str(workspace) and record.get('ledger_path')):
            return Path(record['ledger_path'])
    return None if fallback is None else Path(fallback)


def read_ledger(location):
    ledger = ledger_module()
    store = ledger.Store(location)
    try:
        with ledger.locked(store, exclusive=False):
            return ledger.load(store)[0]
    except ledger.Failure as error:
        raise ValueError(str(error)) from error


def ledger_time(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00')).timestamp()


def ledger_dues(item):
    """{key: (kind, due epoch, due text)} for every check the item's status keeps open.

    A key is the kind, the item number and that time, so a new dispatch, estimate or
    deadline starts a new check while a delivered one is never repeated.
    """
    dues = {}
    status = item['status']
    if status == 'assigned' and item.get('assigned_at'):
        dues['start'] = (ledger_time(item['assigned_at']) + LEDGER_START_SECONDS,
                         item['assigned_at'])
    if status == 'in_progress' and item.get('estimate'):
        dues['estimate'] = (ledger_time(item['estimate']), item['estimate'])
    if status in ('assigned', 'in_progress', 'blocked') and item.get('deadline'):
        dues['deadline'] = (ledger_time(item['deadline']), item['deadline'])
        dues['user'] = dues['deadline']
    return {f'{kind}:{item["id"]}:{text}': (kind, due, text) for kind, (due, text) in dues.items()}


def ledger_message(kind, item, location, now, notified_at=None):
    late = None if kind == 'start' else int(
        (now - ledger_time(item['estimate' if kind == 'estimate' else 'deadline'])) // 60)
    ledger = f'uv run --no-project python {shlex.quote(str(LEDGER_SCRIPT))}'
    where = f'--ledger {shlex.quote(str(location))}'
    name = f'Ledger item {item["id"]} ({item["ticket"]})'
    if kind == 'start':
        return (f'[lat-watch] {name} was assigned to you at {item["assigned_at"]} and is not '
                f'started. Register it now: {ledger} start {item["id"]} {where} '
                '--eta <ISO 8601 or +N[m|h|d]>')
    if kind == 'estimate':
        return (f'[lat-watch] {name} passed your estimate {item["estimate"]} by {late} '
                f'minutes. Record progress with a reason and a new estimate: {ledger} update '
                f'{item["id"]} {where} --eta <ISO 8601 or +N[m|h|d]> --reason "<why>"; or '
                f'close it with {ledger} done {item["id"]} {where} and its evidence.')
    owner = item['agent'] or 'nobody'
    if kind == 'deadline':
        return (f'LAT stall watcher: ledger item {item["id"]} ({item["ticket"]}, stage '
                f'{item["stage"]}) owned by {owner} is {item["status"]} and passed its deadline '
                f'{item["deadline"]} by {late} minutes. Ledger: {location}. Check the agent, '
                'then reassign, block, cancel or extend the deadline with update --deadline '
                '--reason. If its status, owner and deadline stay unchanged for 10 minutes, '
                'the user is notified.')
    return (f'LAT stall watcher: ledger item {item["id"]} ({item["ticket"]}) owned by {owner} '
            f'passed its deadline {item["deadline"]} by {late} minutes. The orchestrator was '
            f'notified {int((now - notified_at) // 60)} minutes ago and its status, owner and '
            f'deadline are unchanged since. Ledger: {location}.')


def ledger_snapshot(item):
    return [item['status'], item['agent'], item['deadline']]


def ledger_handled(item, notice):
    """True once the row's status, owner or deadline changed after the deadline notice.

    The row history is append-only, so entries past the length seen at delivery are the
    later ones, even within the same second.
    """
    return (notice['snapshot'] != ledger_snapshot(item)
            or any({'status', 'agent', 'deadline'} & set(entry.get('changes') or {})
                   for entry in item['history'][notice['history_seen']:]))


def deliver_ledger(kind, item, entry, location, orchestrator, workspace, observe_agent, now,
                   notified_at=None):
    """Try one due check; return the delivery, None to wait for a later cycle, or raise."""
    message = ledger_message(kind, item, location, now, notified_at)
    if kind in ('start', 'estimate'):
        agent = item['agent']
        observation = observe_agent(agent)
        if observation is None:
            return None
        if observation.input_text:
            raise ValueError('input box has text')
        if not idle_prompt(observation):
            return None
        return perform(Action('nudge', agent, text=message, category=LEDGER_DECISIONS[kind]),
                       orchestrator, workspace)
    if kind == 'deadline':
        return perform(Action('notify-orchestrator', item['agent'] or orchestrator, message,
                              category=LEDGER_DECISIONS[kind]), orchestrator, workspace)
    category = 'ledger-user-popup' if entry.get('conversation_delivered') else 'ledger-user'
    delivery = perform(Action('notify-user', item['agent'] or orchestrator, message,
                              category=category, label='逾期'), orchestrator, workspace)
    entry['conversation_delivered'] = True
    if delivery.get('herdr_error') and shutil.which('herdr') is not None:
        raise ValueError(f'Herdr notification failed: {delivery["herdr_error"]}')
    return delivery


def check_ledger(location, saved, orchestrator, workspace, observe_agent, paused, log, now):
    """Run the ledger due checks once; return the delivery state to save.

    Each check is pending until it is due and deliverable, failed after an attempt that did
    not arrive (retried next cycle) and sent once it arrives; only sent ones are deduplicated.
    """
    if location is None:
        return {}
    state = json.loads(json.dumps(saved or {}))
    if state.get('ledger') != str(location):
        # Item numbers and times restart with each round's ledger.
        state = {'ledger': str(location)}
    deliveries = state.setdefault('deliveries', {})
    try:
        doc = read_ledger(location)
    except (OSError, ValueError) as error:
        message = str(error)
        if state.get('error') != message:
            append_log(log, {'at': now, 'agent': orchestrator, 'decision': 'ledger-unreadable',
                             'ledger': str(location), 'error': message, 'actions': []})
        state['error'] = message
        return state
    state.pop('error', None)
    current = {}
    items = {}
    open_items = set()
    for item in doc['items']:
        if item['status'] in ('assigned', 'in_progress', 'blocked'):
            open_items.add(item['id'])
        for key, due in ledger_dues(item).items():
            current[key] = due
            items[key] = item
    # A delivered check stays delivered while its row is open, even when a status change
    # pauses it; undelivered ones restart from their current due time.
    for key, entry in list(deliveries.items()):
        if key not in current and (entry['status'] != 'sent' or entry['item'] not in open_items):
            deliveries.pop(key)
    nudged = set()
    for key, (kind, due, text) in sorted(current.items(), key=lambda pair: pair[1][1]):
        item = items[key]
        entry = deliveries.get(key)
        if entry and entry['status'] == 'sent':
            continue
        notified_at = None
        if kind == 'user':
            notice = deliveries.get(key.replace('user:', 'deadline:', 1))
            if not notice or notice['status'] != 'sent' or notice.get('handled'):
                continue
            if ledger_handled(item, notice):
                notice['handled'] = True
                continue
            notified_at = notice['sent_at']
            due = notified_at + LEDGER_USER_SECONDS
        if now < due:
            continue
        entry = deliveries.setdefault(key, {'kind': kind, 'item': item['id'], 'due': text,
                                            'status': 'pending', 'attempts': 0})
        target = item['agent'] if kind in ('start', 'estimate') else orchestrator
        if target in paused or target in nudged:
            continue
        record = {'at': now, 'agent': item['agent'], 'decision': LEDGER_DECISIONS[kind],
                  'item': item['id'], 'ticket': item['ticket'], 'due': text,
                  'ledger': str(location), 'actions': []}
        try:
            delivery = deliver_ledger(kind, item, entry, location, orchestrator, workspace,
                                      observe_agent, now, notified_at)
        except (OSError, ValueError, TypeError, KeyError) as error:
            entry['attempts'] += 1
            if entry['status'] != 'failed' or entry.get('error') != str(error):
                append_log(log, {**record, 'result': 'failed', 'attempt': entry['attempts'],
                                 'error': str(error)})
            entry.update(status='failed', error=str(error))
            continue
        if delivery is None:
            continue
        entry['attempts'] += 1
        entry.pop('error', None)
        entry.update(status='sent', sent_at=now)
        if kind == 'deadline':
            entry.update(snapshot=ledger_snapshot(item), history_seen=len(item['history']))
        if kind in ('start', 'estimate'):
            nudged.add(item['agent'])
        append_log(log, {**record, 'result': 'sent', 'attempt': entry['attempts'],
                         'delivery': delivery})
    return state


def check_rule_changes(workspace, orchestrator, log, now):
    """Advance each owning session's rule baseline only after delivery succeeds."""
    for path in sorted((lat_dir(workspace) / 'sessions').glob('*.json')):
        try:
            lock_path = watch_dir(workspace) / f'{path.stem}.lock'
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                original = path.read_bytes()
                record = json.loads(original)
                if not isinstance(record, dict):
                    raise ValueError(f'Expected a JSON object: {path}')
                expected = dict(role='orchestrator', status='active',
                                workspace=str(workspace), hcom_name=orchestrator,
                                session_id=path.stem)
                if any(record.get(key) != value for key, value in expected.items()):
                    continue
                current = rule_fingerprint(Path(record['skill_dir']))
                delivery_key = (str(path), record['skill_dir'])
                delivery = RULE_DELIVERIES.get(delivery_key)
                baseline = delivery['fingerprint'] if delivery else record.get('rule_fingerprint')
                if baseline is None:
                    record['rule_fingerprint'] = current
                    write_object(path, record, expected=original)
                    continue
                if not isinstance(baseline, dict):
                    raise ValueError('Expected a rule fingerprint object')
                changed = sorted(name for name in baseline.keys() | current.keys()
                                 if baseline.get(name) != current.get(name))
                if not changed and delivery_key not in RULE_DELIVERIES:
                    continue
                if changed:
                    message = ('LAT skill rules updated. Changed files: '
                               + ', '.join(changed)
                               + '. Please re-read SKILL.md and the changed references in '
                               + record['skill_dir']
                               + '; removed files are no longer available. Continue without '
                               'asking the user to re-enter /lat.')
                    send_notification(Action('notify-orchestrator', orchestrator, message),
                                      orchestrator, 'request')
                    RULE_DELIVERIES[delivery_key] = {'fingerprint': current, 'changed_files': changed}
                record['rule_fingerprint'] = current
                write_object(path, record, expected=original)
                delivered = RULE_DELIVERIES.pop(delivery_key)
                append_log(log, {'at': now, 'agent': orchestrator,
                                 'decision': 'skill-rules-updated',
                                 'changed_files': delivered['changed_files'],
                                 'session_id': path.stem, 'actions': []})
        except (OSError, ValueError, TypeError, KeyError) as error:
            append_log(log, {'at': now, 'agent': orchestrator,
                             'decision': 'skill-rules-check-failed', 'session_id': path.stem,
                             'actions': [], 'error': str(error)})


def restore_alarm_nudge(previous, declaration):
    """Recover a delivered alarm even if the separate watcher-state save failed."""
    if not declaration or declaration.get('released_reason') != 'rang':
        return previous
    nudge = declaration.get('ring_nudge')
    if not nudge:
        return previous
    previous = previous or {}
    if (previous.get('last_progress_at', 0) <= declaration['rang_at']
            and (not previous.get('nudged') or previous.get('nudged_at', 0) < declaration['rang_at'])):
        return {**previous, **nudge}
    return previous


def read_alarm_wait(path):
    declaration, original = read_wait(path)
    pending = ALARM_DELIVERIES.get(str(path))
    if pending:
        expected, delivered = pending
        if original == expected:
            declaration = dict(delivered)
        else:
            # A replacement declaration always wins over a pending old save.
            ALARM_DELIVERIES.pop(str(path))
    return declaration, original


def save_alarm_delivery(path, declaration, original):
    """Keep a successful input/notice across recoverable persistence failures."""
    ALARM_DELIVERIES[str(path)] = (original, dict(declaration))
    saved = write_wait(path, declaration, expected=original)
    ALARM_DELIVERIES.pop(str(path), None)
    return saved


def deliver_alarm_notice(action, declaration, path, original, orchestrator, workspace):
    delivery = perform(action, orchestrator, workspace)
    declaration['alarm_conversation_delivered'] = True
    declaration['alarm_notified'] = (not delivery.get('herdr_error') or shutil.which('herdr') is None)
    original = save_alarm_delivery(path, declaration, original)
    return delivery, original


def unavailable_alarm(workspace, orchestrator, agent, state, now, log):
    """Keep the fixed deadline even when HCOM cannot observe the window."""
    path = wait_path(workspace, agent)
    try:
        with wait_lock(path):
            declaration, original = read_alarm_wait(path)
            if not declaration or declaration.get('kind') != 'alarm':
                return
            observation = Observation(agent, 'unavailable', False, False, 0, 0, 0,
                                      is_orchestrator=agent == orchestrator, terminal_ready=False)
            met = (alarm_condition_met(declaration) if declaration.get('active', True)
                   and declaration.get('due_at') is None else False)
            saved, actions, events = decide_alarm(declaration, observation, met, now)
            original = write_object(path, saved, expected=original)
        ALARM_DELIVERIES.pop(str(path), None)
        state['wait'] = saved
        for event in events:
            append_log(log, {'at': now, 'agent': agent, 'decision': event, 'wait': saved})
        for action in actions:
            delivery, original = deliver_alarm_notice(action, saved, path, original, orchestrator, workspace)
            append_log(log, {'at': now, 'agent': agent, 'decision': 'alarm-notified',
                             'delivery': delivery})
    except (OSError, ValueError, TypeError, KeyError) as error:
        append_log(log, {'at': now, 'agent': agent, 'decision': 'alarm-check-failed', 'error': str(error)})


def log_keepalive_skipped(log, agent, declaration, state, reason, expires_at, now):
    """Record a keep-alive not typed although the cache expires within ten minutes.

    Each reason is logged once per expiry; a missing usage file has no expiry to key on and
    is logged once until the file is readable again.
    """
    if reason == 'usage-missing':
        if state.get('keepalive_usage_missing'):
            return
        state['keepalive_usage_missing'] = True
        append_log(log, {'at': now, 'agent': agent, 'decision': 'cache-keepalive-skipped',
                         'kind': declaration.get('kind'), 'expires_at': None, 'reason': reason})
        return
    skipped = state.get('keepalive_skipped')
    if not isinstance(skipped, dict) or skipped.get('expires_at') != expires_at:
        skipped = {'expires_at': expires_at, 'reasons': []}
    if reason in skipped['reasons']:
        return
    skipped['reasons'].append(reason)
    state['keepalive_skipped'] = skipped
    append_log(log, {'at': now, 'agent': agent, 'decision': 'cache-keepalive-skipped',
                     'kind': declaration.get('kind'), 'expires_at': expires_at,
                     'reason': reason})


def unreadable_screen_notice(observation):
    screen = '\n'.join(observation.screen_tail)
    message = (f'LAT stall watcher: agent {observation.agent} has shown the same unreadable '
               f'screen for {PROMPT_UNREADABLE_SECONDS // 60} minutes; the prompt box cannot '
               f'be found, so this may be a built-in menu or question waiting for a person. '
               f'Last screen lines:\n{screen}\n'
               f'Action needed: open the agent and answer it, or ask the user to.')
    kind = 'notify-user' if observation.is_orchestrator else 'notify-orchestrator'
    return Action(kind, observation.agent, message, category='unreadable-screen',
                  label='畫面待處理')


def check_prompt_readable(log, agent, observation, previous, state, now):
    """Warn once when one unreadable listening Claude screen stays for 15 minutes.

    Returns the notice to send. A changed screen restarts the timer and allows a new notice.
    """
    if (observation.client.lower() != 'claude' or observation.status != 'listening'
            or observation.prompt_readable):
        state.pop('prompt_unreadable', None)
        return ()
    unreadable = dict((previous or {}).get('prompt_unreadable') or {})
    if unreadable.get('digest') != observation.screen_digest:
        unreadable = {'since': now, 'digest': observation.screen_digest}
    notice = ()
    if not unreadable.get('notified') and now - unreadable['since'] >= PROMPT_UNREADABLE_SECONDS:
        if not unreadable.get('logged'):
            append_log(log, {'at': now, 'agent': agent, 'decision': 'prompt-unreadable',
                             'since': unreadable['since'],
                             'lines': list(observation.screen_tail)})
            unreadable['logged'] = True
        unreadable['notified'] = True
        notice = (unreadable_screen_notice(observation),)
    state['prompt_unreadable'] = unreadable
    return notice


def log_signature(observation, state):
    """What counts as a status change for the log; progress alone is not one."""
    return [observation.status, observation.wait_active, observation.command_running,
            observation.prompt_empty, state['quota_active'], state['nudged']]


def run_cycle(workspace, tasks, decisions, orchestrator, now=None, ledger=None):
    """Observe every owned agent once, execute actions, and persist state/logs.

    Returns a stop reason once the orchestrator has been gone from HCOM long enough.
    """
    now = time.time() if now is None else now
    started = time.monotonic()
    orchestrator = valid_name(orchestrator)
    path = state_path(workspace, orchestrator)
    log = path.with_name('watch.jsonl')
    paused = read_hcom_pauses(lambda path, error: append_log(log, {
        'at': now, 'decision': 'pause-record-invalid', 'path': str(path),
        'error': error, 'actions': [],
    }))
    if orchestrator not in paused:
        check_rule_changes(workspace, orchestrator, log, now)
    missing_tasks = path.with_name('tasks-missing')
    incomplete = {}
    if tasks.is_dir():
        missing_tasks.unlink(missing_ok=True)
        cards, skipped = monitored_task_cards(tasks, orchestrator, incomplete)
    else:
        cards, skipped = {}, {}
        if not missing_tasks.exists():
            append_log(log, {
                'at': now, 'decision': 'task-directory-missing', 'actions': [],
                'error': f'Missing task-card directory: {tasks}',
            })
            missing_tasks.touch()
    agents = [orchestrator, *hcom_card_agents(cards)]
    log_skipped_cards(path.with_name('skipped-cards.json'), log, skipped, now)
    notify_incomplete_cards(path.with_name('incomplete-cards.json'), log, incomplete,
                            orchestrator, workspace, now)
    hcom = list_hcom(orchestrator)
    processes = read_processes()
    states = read_watch_file(path, log, now)
    for agent, state in list(states.items()):
        try:
            if not isinstance(state, dict):
                raise ValueError(f'Expected a JSON object, got {type(state).__name__}')
            count = state.get('missing_cycles', 0)
            if type(count) is not int or count < 0:
                raise ValueError('missing_cycles must be a nonnegative integer')
            if 'last_seen_at' in state:
                datetime.fromtimestamp(state['last_seen_at'], timezone.utc)
        except (TypeError, ValueError, OverflowError, OSError) as error:
            reset_agent_state(path, log, now, agent, f'{type(error).__name__}: {error}')
            states.pop(agent)
    ledger_saved = LEDGER_DELIVERIES.get(str(path),
                                         states.get(orchestrator, {}).get('ledger', {}))
    acted = set()
    missing_since = states.get(orchestrator, {}).get('missing_since')
    if type(missing_since) not in (int, float):
        missing_since = None
    orchestrator_gone = False
    for agent in set(states) - set(agents):
        append_log(log, {
            'at': now, 'agent': agent,
            'decision': 'orchestrator-handled-left-watch-set',
            'actions': [],
        })
        states.pop(agent)
    observations = {}

    def current_observation(agent):
        if agent not in observations:
            declaration, _ = read_alarm_wait(wait_path(workspace, agent))
            restored = restore_alarm_nudge(states.get(agent), declaration)
            if restored is not None:
                states[agent] = restored
            observed = observe(workspace, decisions, orchestrator, agent, hcom[agent], cards.get(agent),
                               processes=processes)
            observations[agent] = nudge_only_observation(
                states.get(agent), observed, hcom[agent], orchestrator)
        return observations[agent]

    for agent in agents:
        info = hcom.get(agent)
        previous = states.get(agent, {})
        if agent in paused:
            record = paused[agent]
            segment = [record['session_id'], record['paused_at']]
            if previous.get('pause_segment') != segment:
                append_log(log, {'at': now, 'agent': agent, 'decision': 'paused',
                                 'actions': []})
            previous['pause_segment'] = segment
            states[agent] = previous
            continue
        previous.pop('pause_segment', None)
        if info is not None:
            previous['last_seen_status'] = info.get('status', 'unknown')
            previous['last_seen_at'] = now
            states[agent] = previous
        disappeared = (info is None or (
            info.get('status') == 'inactive' and hcom_quota_issue(info) is None))
        if disappeared:
            unavailable_alarm(workspace, orchestrator, agent, previous, now, log)
            states[agent] = previous
        orchestrator_gone = orchestrator_gone or (agent == orchestrator and info is None)
        if agent != orchestrator and disappeared:
            state = dict(previous)
            state['missing_cycles'] = state.get('missing_cycles', 0) + 1
            actions, results = [], []
            if state['missing_cycles'] >= 2 and not state.get('disappearance_notified'):
                seen_at = state.get('last_seen_at')
                seen_time = (datetime.fromtimestamp(seen_at, timezone.utc).isoformat()
                             if seen_at is not None else 'unknown')
                message = (
                    f'LAT stall watcher: agent {agent} disappeared for two consecutive '
                    f'checks ({"missing from HCOM list" if info is None else "inactive"}). '
                    f'Task card: {cards[agent]["_path"]}; '
                    f'last seen status: {state.get("last_seen_status", "unknown")}; '
                    f'last seen time: {seen_time}. No nudge was sent. '
                    'Verify liveness, resume the same agent if possible, otherwise '
                    'replace it and resend its task, then declare any remaining wait.')
                action = Action('notify-orchestrator', agent, message,
                                category='agent-disappeared')
                actions.append(action_record(action))
                try:
                    delivery = perform(action, orchestrator, workspace)
                    state['disappearance_notified'] = True
                    results.append({'kind': action.kind, 'status': 'done', **delivery})
                except (OSError, ValueError) as error:
                    results.append({'kind': action.kind, 'status': 'failed',
                                    'error': str(error)})
            states[agent] = state
            if state['missing_cycles'] == 1 or actions:
                append_log(log, {
                    'at': now, 'agent': agent, 'decision': 'agent-disappeared',
                    'state': state, 'actions': actions, 'action_results': results,
                })
            continue
        previous.pop('missing_cycles', None)
        previous.pop('disappearance_notified', None)
        if info is None:
            if missing_since is None:
                append_log(log, {
                    'at': now, 'agent': agent, 'decision': 'not-observable',
                    'actions': [], 'error': 'agent missing from hcom list',
                })
            continue
        try:
            try:
                observation = current_observation(agent)
            except (OSError, ValueError, TypeError, KeyError):
                unavailable_alarm(workspace, orchestrator, agent, previous, now, log)
                raise
            previous = states.get(agent)
            logged = previous.get('log_signature') if previous else None
            wait_file = wait_path(workspace, agent)
            with contextlib.ExitStack() as wait_held:
                wait_held.enter_context(wait_lock(wait_file))
                declaration, wait_original = read_alarm_wait(wait_file)
                if declaration and 'kind' not in declaration:
                    declaration['kind'] = ('decision' if pending_decision(
                        decisions, declaration['target']) is not None else 'agent')
                target_observation, target_state = None, None
                waits_for_orchestrator = False
                if declaration and declaration.get('kind') == 'agent':
                    try:
                        target = resolve_agent_name(hcom, declaration['target'], required=False)
                    except ValueError:
                        # Legacy short targets can become ambiguous; keep their normal expiry.
                        target = declaration['target']
                    waits_for_orchestrator = agent != orchestrator and target == orchestrator
                if (declaration and declaration.get('kind') == 'agent'
                        and not waits_for_orchestrator
                        and declaration.get('active', True)
                        and now >= declaration.get('deadline_at', declaration['declared_at'] + 3600)):
                    target = declaration['target']
                    target_info = agent_info(hcom, target)
                    if target_info:
                        target = target_info['name']
                    if (target in agents and target not in paused and target in hcom
                            and hcom[target].get('status') != 'inactive'):
                        # Observing the target runs hcom, so release the lock and compare on return.
                        wait_held.close()
                        try:
                            target_observation = current_observation(target)
                            target_state, _ = decide(states.get(target), target_observation, now)
                        except (OSError, ValueError, TypeError, KeyError):
                            target_observation, target_state = None, None
                        wait_held.enter_context(wait_lock(wait_file))
                        if read_wait(wait_file)[1] != wait_original:
                            raise ValueError(f'Concurrent change detected: {wait_file}')
                if declaration and declaration.get('kind') == 'alarm':
                    met = (alarm_condition_met(declaration) if declaration.get('active', True)
                           and declaration.get('due_at') is None else False)
                    saved_wait, wait_actions, wait_events = decide_alarm(
                        declaration, observation, met, now)
                else:
                    saved_wait, wait_actions, wait_events = decide_wait(
                        declaration, observation, target_observation, target_state, now,
                        waits_for_orchestrator=waits_for_orchestrator)
                if saved_wait is not None:
                    observation = observation._replace(
                        wait_active=saved_wait.get('active', True),
                        wait_released=observation.wait_released or 'wait-expired' in wait_events)
                    wait_original = write_object(wait_file, saved_wait, expected=wait_original)
                    ALARM_DELIVERIES.pop(str(wait_file), None)
            for event in wait_events:
                append_log(log, {'at': now, 'agent': agent, 'decision': event,
                                 'wait': saved_wait})
            try:
                state, actions = decide(previous, observation, now)
            except (TypeError, ValueError, KeyError, AttributeError) as error:
                if previous is None:
                    raise
                reset_agent_state(path, log, now, agent, f'{type(error).__name__}: {error}')
                state, actions = decide(None, observation, now)
            kept = previous.get('keepalive') if previous else None
            if isinstance(kept, dict) and 'keepalive' not in state:
                # Progress ends the reply window but the same expiry is still sent only once.
                state['keepalive'] = {'expires_at': kept.get('expires_at')}
            for key in ('keepalive_last', 'keepalive_skipped', 'keepalive_usage_missing'):
                if previous and key in previous and key not in state:
                    state[key] = previous[key]
            actions = [*actions,
                       *check_prompt_readable(log, agent, observation, previous, state, now)]
            if saved_wait and (saved_wait.get('expiry_nudge_pending')
                               or (saved_wait.get('kind') == 'alarm'
                                   and (saved_wait.get('active', True) or wait_actions))):
                actions = [action for action in actions if action.kind != 'nudge']
            actions = [*wait_actions, *actions]
            keepalive_expires_at = None
            if observation.client.lower() == 'claude':
                # Observing the agents takes time; judge by when the keep-alive is typed.
                send_at = now + time.monotonic() - started
                state['keepalive_check'] = {
                    'at': now, 'reason': keepalive_blocker(saved_wait, observation, send_at,
                                                           busy=bool(actions))}
                keepalive_expires_at, skipped = keepalive_due(
                    saved_wait, observation, info, state, send_at, busy=bool(actions))
                if read_prompt_cache(info.get('session_id')) is not None:
                    state.pop('keepalive_usage_missing', None)
                if skipped:
                    log_keepalive_skipped(log, agent, saved_wait, state, skipped,
                                          keepalive_expires_at, now)
                elif keepalive_expires_at is not None:
                    actions = [Action('nudge', agent, text=KEEPALIVE, category='cache-keepalive')]
            results = []
            for action in actions:
                try:
                    if action.category == 'cache-keepalive':
                        record = {'at': now, 'agent': agent, 'decision': 'cache-keepalive',
                                  'kind': saved_wait.get('kind'),
                                  'expires_at': keepalive_expires_at}
                        try:
                            delivery = perform(action, orchestrator, workspace)
                        except (OSError, ValueError) as error:
                            state['keepalive_last'] = {'at': now, 'result': 'failed',
                                                       'expires_at': keepalive_expires_at,
                                                       'error': str(error)}
                            append_log(log, {**record, 'result': 'failed', 'error': str(error)})
                            raise
                        state['keepalive'] = {'expires_at': keepalive_expires_at,
                                              'fingerprint': state['fingerprint'], 'sent_at': now}
                        state['keepalive_last'] = {'at': now, 'result': 'sent',
                                                   'expires_at': keepalive_expires_at}
                        append_log(log, {**record, 'result': 'sent'})
                    elif action.category == 'alarm-ring':
                        try:
                            delivery = perform(action, orchestrator, workspace)
                        except (OSError, ValueError):
                            if now >= saved_wait['due_at'] + IDLE_SECONDS:
                                expire_alarm(saved_wait, now, 'input failed')
                                wait_original = write_wait(wait_path(workspace, agent), saved_wait,
                                                             expected=wait_original)
                                append_log(log, {'at': now, 'agent': agent,
                                                 'decision': 'alarm-undelivered', 'wait': saved_wait})
                                actions.append(alarm_notification(saved_wait, observation))
                            raise
                        saved_wait.update(active=False, released_reason='rang', rang_at=now)
                        state.update(nudged=True, nudged_at=now, nudge_text=action.text,
                                     nudge_fingerprint=state['fingerprint'], stall_reason='alarm rang')
                        saved_wait['ring_nudge'] = {key: state[key] for key in (
                            'fingerprint', 'last_progress_at', 'nudged', 'nudged_at',
                            'nudge_text', 'nudge_fingerprint', 'stall_reason',
                            'orchestrator_notified', 'orchestrator_handled', 'user_notified')}
                        ALARM_DELIVERIES[str(wait_path(workspace, agent))] = (wait_original, dict(saved_wait))
                        append_log(log, {'at': now, 'agent': agent, 'decision': 'alarm-ring',
                                         'wait': saved_wait})
                        wait_original = save_alarm_delivery(
                            wait_path(workspace, agent), saved_wait, wait_original)
                    elif action.category in ('alarm-notice', 'alarm-popup'):
                        delivery, wait_original = deliver_alarm_notice(
                            action, saved_wait, wait_path(workspace, agent), wait_original,
                            orchestrator, workspace)
                    else:
                        delivery = perform(action, orchestrator, workspace)
                    if action.category.startswith('wait-expiry'):
                        if action.kind == 'nudge':
                            saved_wait['expiry_nudge_pending'] = False
                            state.update(nudged=True, nudged_at=now, nudge_text=action.text,
                                         nudge_fingerprint=state['fingerprint'])
                        else:
                            notice = saved_wait['expiry_notice']
                            notice['conversation_delivered'] = True
                            notice['delivered'] = (not delivery.get('herdr_error')
                                                   or shutil.which('herdr') is None)
                            saved_wait['expiry_notified'] = (notice['delivered']
                                                            and not notice.get('episode_reset'))
                            if notice['delivered']:
                                if notice.get('episode_reset'):
                                    saved_wait.pop('expiry_notice', None)
                                append_log(log, {'at': now, 'agent': agent,
                                                 'decision': 'wait-expiry-notified',
                                                 'target': notice['target']})
                        wait_original = write_wait(wait_path(workspace, agent), saved_wait,
                                                     expected=wait_original)
                    if action.kind == 'recover-prompt':
                        apply_prompt_recovery_result(state, delivery, now)
                    results.append({'kind': action.kind, 'status': 'done', **delivery})
                except (OSError, ValueError) as error:
                    if not action.category.startswith(('wait-expiry', 'alarm-', 'cache-keepalive')):
                        roll_back(action, state)
                    results.append({'kind': action.kind, 'status': 'failed',
                                    'error': str(error)})
            recover_claude_quota(observation, previous, state, orchestrator, workspace, log, now)
            if saved_wait:
                state['wait'] = saved_wait
            state['last_seen_status'] = info.get('status', 'unknown')
            state['last_seen_at'] = now
            state['log_signature'] = log_signature(observation, state)
            states[agent] = state
            if actions:
                acted.add(agent)
            if (actions or state['log_signature'] != logged
                    or any(result['status'] == 'failed' for result in results)):
                append_log(log, {
                    'at': now, 'agent': agent, 'observation': observation_record(observation),
                    'state': state, 'actions': [action_record(action) for action in actions],
                    'action_results': results,
                })
        except (OSError, ValueError, TypeError, KeyError) as error:
            append_log(log, {
                'at': now, 'agent': agent, 'decision': 'observation-failed',
                'actions': [], 'error': str(error),
            })

    def ledger_observation(agent):
        """The agent's observation this cycle; None while another action just used it."""
        if agent in acted:
            return None
        info = hcom.get(agent)
        if info is None or info.get('status') == 'inactive':
            raise ValueError('agent window unavailable: '
                             + ('missing from HCOM list' if info is None else 'inactive'))
        return current_observation(agent)

    try:
        ledger_state = check_ledger(ledger_location(workspace, orchestrator, ledger),
                                    ledger_saved, orchestrator, workspace, ledger_observation,
                                    paused, log, now)
    except (OSError, ValueError, TypeError, KeyError) as error:
        ledger_state = ledger_saved
        append_log(log, {'at': now, 'agent': orchestrator, 'decision': 'ledger-check-failed',
                         'actions': [], 'error': f'{type(error).__name__}: {error}'})
    LEDGER_DELIVERIES[str(path)] = ledger_state
    own = states.setdefault(orchestrator, {})
    own['feature_versions'] = {'wait_deadline': 2, 'alarm': 1, 'cache_keepalive': 5,
                               'claude_quota_resume': 1, 'ledger_due': 1, 'screen_errors': 1,
                               'capacity_continue': 1}
    if ledger_state:
        own['ledger'] = ledger_state
    else:
        own.pop('ledger', None)
    own.pop('missing_since', None)
    stop_reason = None
    if orchestrator_gone:
        since = now if missing_since is None else missing_since
        if now - since >= ORCHESTRATOR_GONE_SECONDS:
            stop_reason = (f'orchestrator {orchestrator} missing from HCOM for '
                           f'{int((now - since) // 60)} minutes')
        else:
            own['missing_since'] = since
    write_object(path, states)
    return stop_reason


def log_cycle_failure(log, previous, error, now, decision='cycle-failed'):
    """Log a failed cycle; repeat an identical failure at most once per hour."""
    message = f'{type(error).__name__}: {error}'
    repeats = previous['repeats'] + 1 if previous and previous['error'] == message else 0
    if repeats and now - previous['logged_at'] < FAILURE_REPEAT_SECONDS:
        return {**previous, 'repeats': repeats}
    record = {'at': now, 'decision': decision, 'actions': [], 'error': message}
    if repeats:
        record['repeats'] = repeats
    print(f'LAT watch {decision.replace("-", " ")}: {message}', file=sys.stderr, flush=True)
    try:
        append_log(log, record)
    except OSError as log_error:
        print(f'LAT watch log failed: {log_error}', file=sys.stderr, flush=True)
    return {'error': message, 'logged_at': now, 'repeats': repeats}


def stop_self(workspace, orchestrator, reason, now, pgid=None):
    """Remove this watcher's pid file and note why in its active session record and log.

    The session stays active, so the recovery hook starts a new watcher on resume.
    """
    pgid = os.getpgrp() if pgid is None else pgid
    stopped_at = datetime.fromtimestamp(now, timezone.utc).isoformat()
    append_log(state_path(workspace, orchestrator).with_name('watch.jsonl'),
               {'at': now, 'agent': orchestrator, 'decision': 'watcher-stopped',
                'reason': reason, 'actions': []})
    # The session launcher records the process group leader (uv) as the watcher pid, next to
    # its session record: the shared .lat, or an older record's own worktree .lat.
    roots = dict.fromkeys([watch_dir(workspace), Path(workspace) / '.lat/watch'])
    for pid_path in sorted(path for root in roots for path in root.glob('*.pid')):
        with contextlib.suppress(OSError, ValueError):
            if int(pid_path.read_text()) == pgid:
                break
    else:
        return None
    sid = pid_path.stem
    with (pid_path.with_suffix('.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with contextlib.suppress(OSError, ValueError):
            if int(pid_path.read_text()) != pgid:
                return None
        pid_path.unlink(missing_ok=True)
        with pid_path.with_suffix('.log').open('a') as stream:
            stream.write(f'{stopped_at} LAT watch stopped: {reason}\n')
        record_path = pid_path.parent.parent / 'sessions' / f'{sid}.json'
        original = record_path.read_bytes()
        record = json.loads(original)
        if (isinstance(record, dict) and record.get('status') == 'active'
                and record.get('hcom_name') == orchestrator):
            record['watcher_stopped'] = {'at_utc': stopped_at, 'reason': reason}
            write_object(record_path, record, expected=original)
    return sid


def reap_command(*args):
    """The service reaper beside this script; LAT_REAP_COMMAND replaces it in tests."""
    replacement = shlex.split(os.environ.get('LAT_REAP_COMMAND', ''))
    return [*(replacement or [sys.executable, str(Path(__file__).with_name('lat-reap.py'))]),
            *args]


def run_forever(args):
    workspace = args.workspace.resolve(strict=True)
    tasks = args.tasks.resolve()
    decisions = args.decisions.resolve(strict=True)
    log = state_path(workspace, args.orchestrator).with_name('watch.jsonl')
    failure = reap_failure = None
    while True:
        now = time.time()
        try:
            reason = run_cycle(workspace, tasks, decisions, args.orchestrator, now,
                               ledger=args.ledger)
            failure = None
        except Exception as error:
            reason = None
            failure = log_cycle_failure(log, failure, error, now)
        if reason:
            stop_self(workspace, args.orchestrator, reason, now)
            return
        # Close services that ended HCOM agents left behind; a failed reap never stops watching.
        try:
            run_cli(reap_command('reap', '--trigger', 'periodic'), timeout=REAP_TIMEOUT_SECONDS,
                    failure='lat-reap failed')
            reap_failure = None
        except Exception as error:
            reap_failure = log_cycle_failure(log, reap_failure, error, now, 'reap-failed')
        time.sleep(CHECK_SECONDS)


def alarm_condition_met(declaration):
    condition = declaration['condition']
    if condition['kind'] == 'file':
        return Path(condition['path']).exists()
    if condition['kind'] == 'process':
        return (condition['starttime'] is None
                or process_starttime(condition['pid']) != condition['starttime'])
    return False


def alarm_watcher_running(workspace, record):
    """Verify the PID belongs to this session's watcher, not a reused PID."""
    try:
        pid = int((watch_dir(workspace) / f"{record['session_id']}.pid").read_text())
    except (OSError, ValueError, KeyError, IndexError):
        return False
    expected = ('run', '--workspace', str(workspace), '--orchestrator', record['hcom_name'],
                '--tasks', record['tasks_path'], '--decisions', record['decisions_path'])
    return watcher_process_matches(pid, expected)


def declare_alarm(args):
    workspace = args.workspace.resolve(strict=True)
    agent = resolve_agent_name(list_hcom(valid_name(args.agent)), args.agent, required=True)
    reason = args.reason.strip()
    if not reason:
        raise ValueError('--reason must not be empty')
    owners = []
    for path in sorted((lat_dir(workspace) / 'sessions').glob('*.json')):
        try:
            record = read_object(path, {})
            if (record.get('role') != 'orchestrator' or record.get('status') != 'active'
                    or record.get('workspace') != str(workspace)):
                continue
            owner = record['hcom_name']
            if owner != agent and agent not in monitored_agents(Path(record['tasks_path']), owner):
                continue
            owners.append(record)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    if not owners:
        raise ValueError('Cannot register alarm: no active orchestrator monitors this agent')
    for record in owners:
        if not alarm_watcher_running(workspace, record):
            continue
        state = read_object(state_path(workspace, record['hcom_name']), {})
        if state.get(record['hcom_name'], {}).get('feature_versions', {}).get('alarm') == 1:
            break
    else:
        raise ValueError('Cannot register alarm: watcher is stopped or lacks alarm support; '
                         'ask its orchestrator to restart the watcher')
    now = time.time()
    declaration = dict(agent=agent, kind='alarm', reason=reason, active=True,
                       declared_at=now, declared_at_utc=datetime.fromtimestamp(now, timezone.utc).isoformat())
    if args.after is not None:
        if args.timeout is not None:
            raise ValueError('--timeout is only allowed with --file or --pid')
        declaration.update(condition=dict(kind='time', minutes=args.after), due_at=now + args.after * 60)
    elif args.file is not None:
        if not args.file.is_absolute():
            raise ValueError('--file must be an absolute path')
        declaration['condition'] = dict(kind='file', path=str(args.file))
    else:
        if args.pid < 1:
            raise ValueError('--pid must be positive')
        declaration['condition'] = dict(kind='process', pid=args.pid,
                                        starttime=process_starttime(args.pid))
    if args.after is None:
        declaration['timeout_at'] = now + (args.timeout or 60) * 60
    with wait_lock(wait_path(workspace, agent)):
        _, original = read_wait(wait_path(workspace, agent))
        write_object(wait_path(workspace, agent), declaration, expected=original)
    append_log(state_path(workspace, record['hcom_name']).with_name('watch.jsonl'),
               {'at': now, 'agent': agent, 'decision': 'alarm-registered', 'wait': declaration})
    print(json.dumps(declaration, ensure_ascii=False))


def declare_wait(args):
    workspace = args.workspace.resolve(strict=True)
    agent = valid_name(args.agent)
    agents = {}
    try:
        agents = list_hcom(agent)
    except (OSError, ValueError) as error:
        print(f'LAT watch warning: hcom list failed; accepting --agent {agent} '
              f'as given: {error}', file=sys.stderr)
    else:
        agent = resolve_agent_name(agents, agent, required=True)
    # A comma list waits on its first entry; the others are named in the reason.
    target, *also = (part.strip() for part in args.target.split(','))
    also = [valid_name(name) for name in also if name]
    declaration = {
        'agent': agent,
        'target': valid_name(target),
        'reason': args.reason.strip(),
        'declared_at': time.time(),
        'declared_at_utc': datetime.now(timezone.utc).isoformat(),
        'active': True,
    }
    if not declaration['reason']:
        raise ValueError('--reason must not be empty')
    if also:
        declaration['reason'] += f' (also waiting for: {", ".join(also)})'
    decision_target = False
    owners = []
    for path in sorted((lat_dir(workspace) / 'sessions').glob('*.json')):
        try:
            record = read_object(path, {})
        except (OSError, ValueError):
            continue
        if (record.get('role') != 'orchestrator'
                or record.get('status') != 'active'
                or record.get('workspace') != str(workspace)):
            continue
        if any(not isinstance(record.get(key), str) or not record[key]
               for key in ('hcom_name', 'tasks_path', 'decisions_path')):
            continue
        owner = record['hcom_name']
        if owner != agent:
            tasks = Path(record['tasks_path'])
            if not tasks.is_dir():
                continue
            cards, _ = monitored_task_cards(tasks, owner)
            if agent not in cards:
                continue
        decisions = Path(record['decisions_path'])
        owners.append((owner, decisions))
        decision = pending_decision(decisions, target)
        decision_target = decision_target or decision is not None
        if decision is False:
            matches = sorted(path for path in decisions.glob(f'{target}*')
                             if path.is_file())
            statuses = ', '.join(f'{path}: {read_decision_status(path).status}'
                                 for path in matches)
            raise ValueError(
                f'Cannot wait on {target}: no pending decision for {owner}; '
                f'matching records: {statuses}. To wait on the user\'s reply or a '
                'manual step, record it as a pending decision and wait on that ID.')
    declaration['kind'] = 'decision' if decision_target else 'agent'
    if decision_target and args.minutes is not None:
        raise ValueError('--minutes is not allowed for a decision target')
    waits_for_orchestrator = False
    if not decision_target:
        declaration['target'] = resolve_agent_name(agents, declaration['target'], required=False)
        if declaration['target'] == agent:
            raise ValueError('Cannot wait on yourself; use lat-watch alarm instead')
        waits_for_orchestrator = any(declaration['target'] == owner for owner, _ in owners)
        if waits_for_orchestrator and args.minutes is not None:
            raise ValueError('--minutes is not allowed when waiting for your owning orchestrator')
        if not waits_for_orchestrator:
            declaration['deadline_at'] = declaration['declared_at'] + (args.minutes or WAIT_DEFAULT_MINUTES) * 60
    path = wait_path(workspace, agent)
    previous, wait_original = read_wait(path)
    if previous and previous.get('expiry_count', 0):
        # Releasing runs hcom, so it stays outside the lock and keeps its own compare-and-replace.
        for owner, decisions in owners or [(agent, lat_dir(workspace) / 'decisions')]:
            if release_wait_if_needed(workspace, decisions, owner, previous, agents,
                                      expected=wait_original):
                break
    with wait_lock(path):
        previous, wait_original = read_wait(path)
        previous = previous or {}
        same_target = not waits_for_orchestrator and previous.get('target') == declaration['target']
        declaration['expiry_count'] = previous.get('expiry_count', 0) if same_target else 0
        if same_target and declaration['expiry_count']:
            for key in ('expiry_declared_at', 'expiry_notified', 'expiry_notice'):
                if key in previous:
                    declaration[key] = previous[key]
        elif (same_target and previous.get('expiry_notice')
              and not previous['expiry_notice']['delivered']):
            declaration['expiry_notice'] = previous['expiry_notice']
        write_object(path, declaration, expected=wait_original)
    print(json.dumps(declaration, ensure_ascii=False))


def cache_status(info, state, now=None):
    """The prompt cache expiry, whether it can be kept warm now, and the last try.

    The cache file and HCOM status are read now; the prompt and wait come from the last
    watcher cycle (checked_at).
    """
    now = time.time() if now is None else now
    cache = read_prompt_cache(info.get('session_id'))
    check = state.get('keepalive_check') if isinstance(state.get('keepalive_check'), dict) else {}
    status = info.get('status', 'missing')
    if cache is None:
        reason, possible = 'usage-missing', False
    elif cache_expires_at(info.get('session_id'), now) is None:
        reason, possible = 'cache-expired' if cache.get('warm') is True else 'cache-cold', False
    elif hcom_quota_issue(info):
        reason, possible = 'rate-limited', False
    elif status != 'listening':
        reason, possible = f'status-{status}', False
    elif (not check or str(check.get('reason')).startswith('status-')
          or check.get('reason') == 'rate-limited'):
        # The last cycle did not judge the prompt and wait at a listening agent: unknown.
        reason, possible = None, None
    else:
        reason = check.get('reason')
        possible = reason is None
    return {
        'expires_at': cache.get('expires_at') if cache else None,
        'warm': cache.get('warm') if cache else None,
        'can_keep_alive': possible,
        'reason': reason,
        'checked_at': check.get('at'),
        'last_keepalive': state.get('keepalive_last'),
    }


def transcript_time(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError):
        return None


def api_calls(transcript):
    """[asked at, last reply block at, cache read, cache write] per main-thread API request.

    A request is asked when the last user entry before it (prompt or tool result) was
    written, or at its first reply block when there is none.
    """
    calls, requests, asked_at = [], {}, None
    with open(transcript, encoding='utf-8', errors='replace') as stream:
        for line in stream:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if not isinstance(entry, dict) or entry.get('isSidechain'):
                continue
            at = transcript_time(entry.get('timestamp'))
            if at is None:
                continue
            if entry.get('type') == 'user':
                asked_at = at
                continue
            message = entry.get('message')
            usage = message.get('usage') if isinstance(message, dict) else None
            if entry.get('type') != 'assistant' or not isinstance(usage, dict):
                continue
            if message.get('model') == '<synthetic>':
                # A failed request leaves a placeholder; a retry is asked after it.
                asked_at = None
                continue
            # A streamed reply repeats one request's usage on every content block.
            key = entry.get('requestId') or message.get('id')
            if key in requests:
                requests[key][1] = max(requests[key][1], at)
                continue
            requests[key] = [at if asked_at is None else asked_at, at,
                             usage.get('cache_read_input_tokens') or 0,
                             usage.get('cache_creation_input_tokens') or 0]
            calls.append(requests[key])
            asked_at = None
    return calls


def keepalive_records(workspace, agent):
    records = []
    for path in sorted(watch_dir(workspace).glob('*/watch.jsonl*')):
        try:
            lines = path.read_text(errors='replace').splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if (isinstance(record, dict) and record.get('agent') == agent
                    and record.get('decision') in ('cache-keepalive', 'cache-keepalive-skipped')
                    and type(record.get('at')) in (int, float)):
                records.append(record)
    return sorted(records, key=lambda record: record['at'])


def cache_history(transcript, keepalives=()):
    """Idle gaps over five minutes, from the end of one reply to the next request being
    asked, and whether that request read or rewrote the cache."""
    gaps = []
    calls = api_calls(transcript)
    for (_, start, _, _), (end, _, read, write) in zip(calls, calls[1:]):
        if end - start <= IDLE_GAP_SECONDS:
            continue
        verdict = 'rewrite' if write > read else 'hit' if read else 'unknown'
        marks = [{key: record[key] for key in ('at', 'decision', 'result', 'reason', 'expires_at')
                  if key in record}
                 for record in keepalives if start <= record['at'] <= end]
        gaps.append({'start_at': start, 'end_at': end, 'idle_seconds': round(end - start),
                     'cache_read_tokens': read, 'cache_write_tokens': write,
                     'verdict': verdict, 'keepalives': marks})
    return gaps


def find_transcript(session_id):
    base = Path(os.environ.get('CLAUDE_CONFIG_DIR') or Path.home() / '.claude')
    matches = sorted((base / 'projects').glob(f'*/{session_id}.jsonl'))
    if not matches:
        raise ValueError(f'No Claude transcript found for session {session_id}')
    return str(matches[0])


def show_cache_history(args):
    agent, session, transcript = None, args.session, None
    try:
        agents = list_hcom()
    except (OSError, ValueError):
        if args.agent:
            raise
        agents = {}
    if args.agent:
        agent = resolve_agent_name(agents, valid_name(args.agent), required=True)
        session = agents[agent].get('session_id')
        transcript = agents[agent].get('transcript_path')
    else:
        valid_name(session)
        for name, info in agents.items():
            if info.get('session_id') == session:
                agent, transcript = name, info.get('transcript_path')
    if not isinstance(transcript, str) or not transcript:
        transcript = find_transcript(session)
    keepalives = (keepalive_records(args.workspace.resolve(strict=True), agent)
                  if args.workspace and agent else [])
    gaps = cache_history(transcript, keepalives)
    if args.json:
        print(json.dumps({'agent': agent, 'session_id': session, 'transcript': transcript,
                          'gaps': gaps}, indent=2, ensure_ascii=False))
        return
    print(f'{agent or session}: {transcript}')
    if not gaps:
        print('No idle gap over 5 minutes.')
    for gap in gaps:
        start = datetime.fromtimestamp(gap['start_at']).strftime('%Y-%m-%d %H:%M')
        end = datetime.fromtimestamp(gap['end_at']).strftime('%H:%M')
        notes = ''.join(
            f"  [{mark['decision']} {datetime.fromtimestamp(mark['at']).strftime('%H:%M')} "
            f"{mark.get('result') or mark.get('reason')}]" for mark in gap['keepalives'])
        print(f"{start} -> {end}  idle {gap['idle_seconds'] // 60}m  "
              f"read {gap['cache_read_tokens']}  write {gap['cache_write_tokens']}  "
              f"{gap['verdict']}{notes}")


def show_status(args):
    workspace = args.workspace.resolve(strict=True)
    agents = monitored_agents(args.tasks.resolve(strict=True), args.orchestrator)
    hcom = list_hcom(args.orchestrator)
    states = read_object(state_path(workspace, args.orchestrator), {})
    target_rows = []
    for agent in agents:
        info = hcom.get(agent, {})
        row = {'agent': agent, 'hcom_status': info.get('status', 'missing'),
               'state': states.get(agent)}
        declaration = read_object(wait_path(workspace, agent))
        if declaration is not None:
            row['wait'] = declaration
        if info.get('tool') == 'claude':
            row['cache'] = cache_status(info, states.get(agent) or {})
        target_rows.append(row)
    print(json.dumps({'orchestrator': args.orchestrator, 'targets': target_rows},
                     indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    waiting = commands.add_parser('wait', help='Declare an agent wait condition')
    waiting.add_argument('--workspace', type=Path, required=True)
    waiting.add_argument('--agent', required=True)
    waiting.add_argument('--for', dest='target', required=True,
                         help='Decision ID or agent name; a comma list waits on the first')
    waiting.add_argument('--reason', required=True)
    waiting.add_argument('--minutes', type=int, choices=range(1, 721),
                         metavar='1..720', help=f'Agent wait deadline (default: {WAIT_DEFAULT_MINUTES} minutes)')
    alarm = commands.add_parser('alarm', help='Register a watcher-owned wake-up alarm')
    alarm.add_argument('--workspace', type=Path, required=True)
    alarm.add_argument('--agent', required=True)
    alarm.add_argument('--reason', required=True)
    condition = alarm.add_mutually_exclusive_group(required=True)
    condition.add_argument('--after', type=int, choices=range(1, 721), metavar='1..720')
    condition.add_argument('--file', type=Path)
    condition.add_argument('--pid', type=int)
    alarm.add_argument('--timeout', type=int, choices=range(1, 721), metavar='1..720')
    status = commands.add_parser('status' , help='List watched agents and current state')
    status.add_argument('--workspace', type=Path, required=True)
    status.add_argument('--orchestrator', required=True)
    status.add_argument('--tasks', type=Path, required=True)
    history = commands.add_parser(
        'cache-history', help='List idle gaps of a Claude session and prompt cache hits')
    owner = history.add_mutually_exclusive_group(required=True)
    owner.add_argument('--agent')
    owner.add_argument('--session')
    history.add_argument('--workspace', type=Path,
                         help='Mark keep-alives logged by the watchers of this workspace')
    history.add_argument('--json', action='store_true')
    run = commands.add_parser('run', help='Run one watcher loop per orchestrator')
    run.add_argument('--workspace', type=Path, required=True)
    run.add_argument('--orchestrator', required=True)
    run.add_argument('--tasks', type=Path, required=True)
    run.add_argument('--decisions', type=Path, required=True)
    run.add_argument('--ledger', type=Path,
                     help='Ledger to check when the active session record names none')
    args = parser.parse_args()
    try:
        if args.command == 'wait':
            declare_wait(args)
        elif args.command == 'alarm':
            declare_alarm(args)
        elif args.command == 'status':
            show_status(args)
        elif args.command == 'cache-history':
            show_cache_history(args)
        else:
            run_forever(args)
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f'LAT watch error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
