#!/usr/bin/env python3
"""Answer a Claude Code or Codex menu question or permission request on the LAT board.

The hook (`hook`) handles Claude's PreToolUse for AskUserQuestion and PermissionRequest, and with
`--client codex` Codex's PermissionRequest, Stop and PostToolUse. For a question or a permission
request it writes a board ask to the shared folder, waits in place for the board's answer and hands
it back (`allow` with `updatedInput`, or the permission's `allow` / `deny`). At its deadline Claude's
turn ends (`continue: false`, or for a permission `deny` with `interrupt`); Codex's permission request
is handed back to the terminal with no decision. Anything that goes wrong gives no decision, so the
client shows its own menu or dialog as before.
`install` and `uninstall` add or remove the hook in Claude's settings or Codex's hooks.json.

The shared folder, one board ask per file (all 0600):

- `<id>.json`: the ask, written whole by the hook (temporary file renamed into place). The hook
  writes it again with `outcome` before it ends: `filled`, `timed_out`, `handed_back` (Codex's
  deadline), `terminal` (answered in Claude's terminal first), `sent` (a board answer to Claude's
  permission request, handed back while its dialog was open too) or `allowed` (Codex allowed after
  its turn had ended).
- `<id>.result.json`: who took the ask, written once: a temporary file hard-linked into place,
  which fails when the file already exists. The board writes `{"kind": "answer", ...}` (a question's
  `answers`, a permission's `decision` and `reason`), the hook at its deadline `{"kind": "timeout"}`
  (Claude) or `{"kind": "handed_back"}` (Codex), and `{"kind": "terminal", "decision": ...}` once
  Claude's transcript shows the request answered in the terminal; whoever links first wins. The
  board also writes `{"kind": "interrupted", ...}` once the hook's process is gone with nothing
  taken (Esc).
- `<id>.late.json`: an answer to a timed-out ask, which the board sends as a message: written once
  by the board the same way, then again whole with `outcome` (`relayed` or `gone`).
- `<id>.resend.json`: the user's resend of a late answer the board may not have sent (it stopped
  while sending): written once by the board the same way, then again whole with `outcome`.
- `<id>.observed.json`: what Claude did with a `sent` permission answer, as its transcript shows:
  written once by the hook's watcher, `{"decision": ...}` or `{"kind": "unknown"}`.
- `<id>.stopped.json`: Codex's turn ended while the permission request waited (its Stop event).
- `<id>.executed.json`: Codex ran the tool allowed after its turn ended (its PostToolUse event),
  `{"kind": "executed", "summary": ...}`, or `{"kind": "ambiguous"}` when two such asks match it.
- `<id>.notified.json`, `<id>.noted.json`: the board's own, written once each: the message telling
  Codex the tool ran, and the operation-record entry of how the ask ended.
- `heartbeat`: the board touches it every 30 seconds; older than 90 seconds means no board runs.

Only the standard library; run with `uv run --no-project python`.
"""
import argparse
import copy
import difflib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).resolve()
HEARTBEAT = 'heartbeat'
HEARTBEAT_STALE_SECONDS = 90
# The #284 experiment: both clients honoured a 620 s answer under a 660 s hook timeout.
WAIT_SECONDS = 600
HOOK_TIMEOUT_SECONDS = 660
POLL_SECONDS = 0.2
HELPER_SECONDS = 10
CONTROLLER_REASON = (
    'You are the LAT controller, so do not ask with AskUserQuestion. Write the question with '
    "the question panel's `question upsert` and end your message with DECIDE.")
STATUS_MESSAGE = '正在等看板作答，按 Esc 可中斷改在終端機回答'
# Shown in the terminal and given to the model when the wait runs out and the turn ends.
STOP_REASON = '看板作答等太久，先結束這一回合；使用者會在看板上回答，答案會以訊息傳給你，收到前不要自己猜答案。'
# What the model reads when the user denies a permission request on the board; the transcript
# watcher also tells such a denial by it.
DENY_MESSAGE = '使用者在看板拒絕了這個操作。'
# Claude's tool result when the user rejects a tool use in its own dialog, or a hook interrupts.
REJECTED_PREFIX = "The user doesn't want to proceed with this tool use"
# How long a board answer to Claude's permission request is watched for in its transcript.
OBSERVE_SECONDS = 60
TRANSCRIPT_SECONDS = 1


def asks_dir(env):
    given = env.get('LAT_BOARD_ASKS_DIR')
    if given and os.path.isabs(given):
        return Path(given)
    state = env.get('XDG_STATE_HOME')
    base = Path(state) if state and os.path.isabs(state) else Path.home() / '.local/state'
    return base / 'lat/board-asks'


def seconds(env, name, default):
    try:
        value = float(env.get(name, ''))
    except ValueError:
        return default
    return value if value > 0 else default


def wait_seconds(env):
    return seconds(env, 'LAT_BOARD_ASK_WAIT_SECONDS', WAIT_SECONDS)


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace('+00:00', 'Z')


def board_running(folder, now):
    try:
        return now - (folder / HEARTBEAT).stat().st_mtime <= HEARTBEAT_STALE_SECONDS
    except OSError:
        return False


def helper_command(env):
    """The panel helper's command, the way the board finds it; None when it cannot be told."""
    given = env.get('LAT_BOARD_HELPER_COMMAND')
    if given:
        command = json.loads(given)
        if not isinstance(command, list) or not command \
                or any(not isinstance(part, str) for part in command):
            return None
        return command
    lat_dir = env.get('LAT_BOARD_LAT_DIR') or str(Path.home() / '.agents/skills/lat')
    return ['uv', 'run', '--no-project', 'python', str(Path(lat_dir) / 'herdr-panel/lat_panel.py')]


def is_controller(session_id, env):
    """Whether the panel helper has a controller binding for this session; any failure is no."""
    try:
        command = helper_command(env)
        if command is None:
            return False
        done = subprocess.run([*command, 'resolve', '--session-id', session_id], env=env,
                              capture_output=True, text=True, timeout=HELPER_SECONDS)
        return done.returncode == 0 and isinstance(json.loads(done.stdout), dict)
    except Exception:  # noqa: BLE001 - a failed lookup treats the agent as an ordinary one
        return False


def valid_questions(questions):
    if not isinstance(questions, list) or not questions:
        return False
    for question in questions:
        if not isinstance(question, dict) or not isinstance(question.get('question'), str):
            return False
        options = question.get('options', [])
        if not isinstance(options, list) or any(
                not isinstance(option, dict) or not isinstance(option.get('label'), str)
                for option in options):
            return False
    return len({question['question'] for question in questions}) == len(questions)


def write_whole(path, record):
    """The record as the file's whole content: a temporary file renamed into place."""
    temporary = path.with_name(f'.{path.name}.{os.getpid()}.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as file:
        json.dump(record, file, ensure_ascii=False)
        file.write('\n')
    os.replace(temporary, path)


def claim(path, record):
    """Write the record to path only if nobody has: True when this call did."""
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'w') as file:
            json.dump(record, file, ensure_ascii=False)
            file.write('\n')
        os.link(temporary, path)
        return True
    except FileExistsError:
        return False
    finally:
        os.unlink(temporary)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def answers_for(questions, result):
    """The answers by question text when the result holds one for every question; else None."""
    answers = result.get('answers') if isinstance(result, dict) else None
    texts = {question['question'] for question in questions}
    if not isinstance(answers, dict) or set(answers) != texts:
        return None
    if any(not isinstance(value, str) or not value.strip() for value in answers.values()):
        return None
    return answers


def run_hook(text, env, client='claude', clock=time.time, sleep=time.sleep):
    """The hook's decision for this input, or None to leave the client's own menu or dialog."""
    payload = json.loads(text)
    if not isinstance(payload, dict):
        return None
    event = payload.get('hook_event_name')
    if client == 'codex':
        if event == 'Stop':
            return mark_stopped(payload, env, clock)
        if event == 'PostToolUse':
            return mark_executed(payload, env, clock)
    # A Task sub-agent's call, and an agent outside Herdr, which the board has no page for.
    if 'agent_id' in payload or not env.get('HERDR_PANE_ID'):
        return None
    if event == 'PermissionRequest' and payload.get('tool_name') != 'AskUserQuestion':
        return ask_permission(payload, env, client, clock, sleep)
    if client == 'claude' and event == 'PreToolUse' and payload.get('tool_name') == 'AskUserQuestion':
        return ask_question(payload, env, clock, sleep)
    return None


def new_ask(payload, env, client, kind, tool_input, now, deadline):
    """The ask file's fields every kind has."""
    return {
        'id': uuid.uuid4().hex,
        'client': client,
        'session_id': payload['session_id'],
        'hcom_name': env.get('HCOM_INSTANCE_NAME') or None,
        'herdr_pane': env['HERDR_PANE_ID'],
        'cwd': payload.get('cwd') if isinstance(payload.get('cwd'), str) else os.getcwd(),
        'kind': kind,
        'tool_input': tool_input,
        'created_at': iso(now),
        'deadline_at': iso(deadline),
        'hook_pid': os.getpid(),
        'outcome': None,
        'outcome_at': None,
    }


def ask_question(payload, env, clock, sleep):
    """Claude's AskUserQuestion: the board's answers as `updatedInput`, or the turn ended."""
    tool_input = payload.get('tool_input')
    session_id = payload.get('session_id')
    if not isinstance(tool_input, dict) or not valid_questions(tool_input.get('questions')) \
            or not isinstance(session_id, str) or not session_id:
        return None
    folder = asks_dir(env)
    now = clock()
    if not board_running(folder, now):
        return None

    # The controller asks through the question panel, not the board: no ask file, no waiting.
    if is_controller(session_id, env):
        return {'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': CONTROLLER_REASON,
        }}

    deadline = now + wait_seconds(env)
    ask = {**new_ask(payload, env, 'claude', 'question', tool_input, now, deadline),
           'tool_use_id': payload.get('tool_use_id')}
    ask_path = folder / f'{ask["id"]}.json'
    result_path = folder / f'{ask["id"]}.result.json'
    write_whole(ask_path, ask)

    result = None
    while result is None and clock() < deadline:
        sleep(POLL_SECONDS)
        result = read_json(result_path)
    if result is None and claim(result_path, {'kind': 'timeout', 'at': iso(clock())}):
        write_whole(ask_path, {**ask, 'outcome': 'timed_out', 'outcome_at': iso(clock())})
        # The turn ends; a later answer on the board comes as a message.
        return {'continue': False, 'stopReason': STOP_REASON, 'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': STOP_REASON,
        }}
    # Taken by the board: its answer counts even when it landed at the deadline.
    while result is None:
        sleep(POLL_SECONDS)
        result = read_json(result_path)
    answers = answers_for(tool_input['questions'], result) if result.get('kind') == 'answer' else None
    if answers is None:
        return None
    write_whole(ask_path, {**ask, 'outcome': 'filled', 'outcome_at': iso(clock())})
    return {'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': 'allow',
        'updatedInput': {**tool_input, 'answers': answers},
    }}


# ---------------------------------------------------------------- permission requests

def permission_output(decision, reason=None, interrupt=False):
    """A PermissionRequest decision, as both clients read it."""
    if decision == 'allow':
        return {'hookSpecificOutput': {'hookEventName': 'PermissionRequest',
                                       'decision': {'behavior': 'allow'}}}
    message = DENY_MESSAGE + (f'理由：{reason}' if reason else '')
    body = {'behavior': 'deny', 'message': message}
    if interrupt:
        body['interrupt'] = True
    return {'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': body}}


def tool_result_decision(item):
    """Whether Claude ran the tool the transcript's tool result is for: `allow`, or `deny` when the
    use was rejected in the terminal, denied by the board, or interrupted. A refusal is an error
    result; a tool's own output that only quotes such text is not one."""
    content = item.get('content')
    if isinstance(content, list):
        content = '\n'.join(part.get('text', '') for part in content
                            if isinstance(part, dict) and isinstance(part.get('text'), str))
    text = content if isinstance(content, str) else ''
    if item.get('is_error') is True and (text.startswith(REJECTED_PREFIX) or DENY_MESSAGE in text):
        return 'deny'
    return 'allow'


class TranscriptWatch:
    """Claude's transcript, read as it grows, for the one tool call a permission request is about.

    The request carries no tool-use ID, so the call is the tool use with the same tool name and
    input whose result was not already written before the request (before `start`, a byte offset).
    Two such calls cannot be told apart: `ambiguous`, and nothing is said of either."""

    def __init__(self, path, tool_name, tool_input, start=None):
        self.path = Path(path)
        self.tool_name = tool_name
        self.tool_input = tool_input
        self.uses = set()
        self.results = {}
        self.position = 0
        self.ambiguous = False
        if start is None:
            try:
                start = self.path.stat().st_size
            except OSError:
                start = 0
        self.start = start

    def read(self):
        try:
            with self.path.open('rb') as file:
                file.seek(self.position)
                chunk = file.read()
        except OSError:
            return
        end = chunk.rfind(b'\n') + 1
        at = self.position
        for line in chunk[:end].split(b'\n'):
            line_at = at
            at += len(line) + 1
            if b'"tool_use"' not in line and b'"tool_result"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            content = (entry.get('message') or {}).get('content') if isinstance(entry, dict) else None
            for item in content if isinstance(content, list) else []:
                if not isinstance(item, dict):
                    continue
                if item.get('type') == 'tool_use' and item.get('name') == self.tool_name \
                        and item.get('input') == self.tool_input:
                    self.uses.add(item.get('id'))
                elif item.get('type') == 'tool_result' and isinstance(item.get('tool_use_id'), str):
                    self.results.setdefault(item['tool_use_id'], (item, line_at))
        self.position += end

    def decision(self):
        """`allow` or `deny` once the call's result is written; None before, or when ambiguous."""
        self.read()
        calls = [use for use in self.uses
                 if use not in self.results or self.results[use][1] >= self.start]
        if len(calls) > 1:
            self.ambiguous = True
        if len(calls) != 1 or calls[0] not in self.results:
            return None
        return tool_result_decision(self.results[calls[0]][0])


def ask_permission(payload, env, client, clock, sleep):
    """A permission request: the board's allow or deny. At the deadline Claude's turn ends (deny
    with interrupt); Codex's request goes back to its terminal dialog (no decision). Claude shows
    its own dialog meanwhile: an answer there, seen in its transcript, ends the wait with none."""
    tool_name = payload.get('tool_name')
    tool_input = payload.get('tool_input')
    session_id = payload.get('session_id')
    if not isinstance(tool_name, str) or not tool_name or not isinstance(tool_input, dict) \
            or not isinstance(session_id, str) or not session_id:
        return None
    folder = asks_dir(env)
    now = clock()
    if not board_running(folder, now):
        return None
    transcript = payload.get('transcript_path')
    watch = TranscriptWatch(transcript, tool_name, tool_input) \
        if client == 'claude' and isinstance(transcript, str) and transcript else None
    deadline = now + wait_seconds(env)
    ask = {**new_ask(payload, env, client, 'permission', tool_input, now, deadline),
           'tool_name': tool_name}
    if client == 'codex':
        ask['turn_id'] = payload.get('turn_id') if isinstance(payload.get('turn_id'), str) else None
    if watch is not None:
        ask.update(transcript_path=transcript, transcript_start=watch.start)
    ask_path = folder / f'{ask["id"]}.json'
    result_path = folder / f'{ask["id"]}.result.json'
    write_whole(ask_path, ask)

    def answered_in_terminal():
        """True once the transcript shows the call answered and that took the ask."""
        seen = watch.decision() if watch is not None else None
        if seen is None or not claim(result_path, {'kind': 'terminal', 'decision': seen,
                                                   'at': iso(clock())}):
            return False
        write_whole(ask_path, {**ask, 'outcome': 'terminal', 'outcome_at': iso(clock())})
        return True

    result = None
    looked = now
    while result is None and clock() < deadline:
        sleep(POLL_SECONDS)
        result = read_json(result_path)
        if result is None and clock() - looked >= TRANSCRIPT_SECONDS:
            looked = clock()
            if answered_in_terminal():
                return None
            result = read_json(result_path)
    if result is None:
        # Answered in the terminal just before the deadline: no interrupt for the next turn.
        if answered_in_terminal():
            return None
        kind = 'timeout' if client == 'claude' else 'handed_back'
        if claim(result_path, {'kind': kind, 'at': iso(clock())}):
            write_whole(ask_path, {**ask, 'outcome': 'timed_out' if client == 'claude' else kind,
                                   'outcome_at': iso(clock())})
            # Claude's turn ends and a later answer comes as a message; Codex shows its dialog.
            return permission_output('deny', interrupt=True) if client == 'claude' else None
    while result is None:
        sleep(POLL_SECONDS)
        result = read_json(result_path)
    decision = result.get('decision') if result.get('kind') == 'answer' else None
    if decision not in ('allow', 'deny'):
        return None
    reason = result.get('reason') if isinstance(result.get('reason'), str) else ''
    if client == 'codex':
        stopped = (folder / f'{ask["id"]}.stopped.json').exists()
        outcome = 'allowed' if stopped and decision == 'allow' else 'filled'
        # Written before the decision goes out. A Stop that saw the ask still waiting may write its
        # mark only after this: the board then reads the ask as allowed after the turn all the same.
        write_whole(ask_path, {**ask, 'outcome': outcome, 'outcome_at': iso(clock())})
    else:
        # Claude's dialog may have been answered first: what it did is watched for after this.
        until = clock() + seconds(env, 'LAT_BOARD_ASK_OBSERVE_SECONDS', OBSERVE_SECONDS)
        sent = {**ask, 'outcome': 'sent', 'outcome_at': iso(clock()), 'observe_until': iso(until)}
        write_whole(ask_path, sent)
        start_watcher(ask_path, env)
    return permission_output(decision, reason.strip())


def start_watcher(ask_path, env):
    """Watch Claude's transcript for what it did with a sent answer, after the hook has ended."""
    try:
        subprocess.Popen([sys.executable, str(SCRIPT), 'observe', str(ask_path)], env=env,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        pass  # The board marks it 結果不明 once the watch would have ended.


def run_observe(ask_path, clock=time.time, sleep=time.sleep):
    """The watcher: what Claude did with a sent permission answer, once, in `<id>.observed.json`."""
    path = Path(ask_path)
    ask = read_json(path)
    if not isinstance(ask, dict) or ask.get('outcome') != 'sent':
        return
    observed = path.with_name(f'{ask["id"]}.observed.json')
    until = datetime.fromisoformat(ask['observe_until'].replace('Z', '+00:00')).timestamp()
    watch = TranscriptWatch(ask['transcript_path'], ask['tool_name'], ask['tool_input'],
                            ask['transcript_start'])
    while True:
        seen = watch.decision()
        if seen is not None or watch.ambiguous or clock() >= until:
            break
        sleep(TRANSCRIPT_SECONDS)
    record = {'decision': seen} if seen is not None else {'kind': 'unknown'}
    claim(observed, {**record, 'at': iso(clock())})


# ---------------------------------------------------------------- Codex turn end and tool runs

def codex_asks(folder, session_id):
    """Codex's permission asks of this session."""
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    found = []
    for name in names:
        if name.startswith('.') or name.count('.') != 1 or not name.endswith('.json'):
            continue
        ask = read_json(folder / name)
        if isinstance(ask, dict) and ask.get('client') == 'codex' \
                and ask.get('kind') == 'permission' and ask.get('session_id') == session_id \
                and isinstance(ask.get('id'), str):
            found.append(ask)
    return found


def mark_stopped(payload, env, clock):
    """Codex's Stop: a permission request of the session still waiting outlived its turn."""
    session_id = payload.get('session_id')
    folder = asks_dir(env)
    for ask in codex_asks(folder, session_id) if isinstance(session_id, str) else []:
        if not (folder / f'{ask["id"]}.result.json').exists():
            claim(folder / f'{ask["id"]}.stopped.json', {'at': iso(clock())})
    return None


def same_input(asked, ran):
    """Whether the tool ran with the input asked for; Codex's request adds a `description`."""
    return ran == asked or ran == {key: value for key, value in asked.items()
                                   if key != 'description'}


def mark_executed(payload, env, clock):
    """Codex's PostToolUse: the tool allowed on the board after the turn ended has run. The run
    names no request, so every allowed request of the turn with the same tool and input counts,
    in its turn or after it, seen run before or not: with two or more, which one ran is not
    known, and those that outlived the turn are marked so."""
    session_id = payload.get('session_id')
    if not isinstance(session_id, str):
        return None
    folder = asks_dir(env)
    allowed = []
    for ask in codex_asks(folder, session_id):
        result = read_json(folder / f'{ask["id"]}.result.json')
        if ask.get('turn_id') == payload.get('turn_id') \
                and ask.get('tool_name') == payload.get('tool_name') \
                and isinstance(ask.get('tool_input'), dict) \
                and same_input(ask['tool_input'], payload.get('tool_input')) \
                and isinstance(result, dict) and result.get('kind') == 'answer' \
                and result.get('decision') == 'allow':
            allowed.append(ask)
    response = payload.get('tool_response')
    summary = response if isinstance(response, str) else json.dumps(response, ensure_ascii=False)
    record = {'kind': 'executed', 'summary': summary[:2000]} if len(allowed) == 1 \
        else {'kind': 'ambiguous'}
    for ask in allowed:
        if (folder / f'{ask["id"]}.stopped.json').exists():
            claim(folder / f'{ask["id"]}.executed.json', {**record, 'at': iso(clock())})
    return None


def cmd_hook(client):
    try:
        decision = run_hook(sys.stdin.read(), os.environ, client)
    except Exception:  # noqa: BLE001 - any failure leaves the client's own menu
        return 0
    if decision is not None:
        print(json.dumps(decision, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- install

HOOK_ARGS = ['uv', 'run', '--no-project', 'python', str(SCRIPT), 'hook']
HOOK_COMMAND = {'claude': shlex.join(HOOK_ARGS),
                'codex': shlex.join([*HOOK_ARGS, '--client', 'codex'])}
GROUP_NAME = 'board-ask'
BACKUP_PREFIX = '.board-ask-backup-'
# Per client: each event the hook is installed for, its matcher (None for every tool), and whether
# it waits for the board, which only a question or a permission request does.
EVENTS = {
    'claude': [('PreToolUse', 'AskUserQuestion', True), ('PermissionRequest', None, True)],
    'codex': [('PermissionRequest', None, True), ('Stop', None, False),
              ('PostToolUse', None, False)],
}
QUICK_TIMEOUT_SECONDS = 10


def is_hook_handler(handler):
    """A handler running some copy of this script's hook, wherever it is installed."""
    if not isinstance(handler, dict) or not isinstance(handler.get('command'), str):
        return False
    try:
        words = shlex.split(handler['command'])
    except ValueError:
        return False
    at = next((i for i, word in enumerate(words) if os.path.basename(word) == SCRIPT.name), None)
    return at is not None and words[at + 1:at + 2] == ['hook']


def settings_path(client, claude_settings, codex_home):
    if client == 'codex':
        home = codex_home or os.environ.get('CODEX_HOME') or '~/.codex'
        return Path(home).expanduser().resolve() / 'hooks.json'
    if claude_settings:
        return Path(claude_settings).expanduser().resolve()
    home = os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'
    return Path(home).expanduser().resolve() / 'settings.json'


def updated_event(events, event, client, matcher, waits, action):
    """Install or remove this hook under one event of `events`, in place."""
    if action == 'uninstall' and event not in events:
        return
    groups = events.setdefault(event, [])
    if not isinstance(groups, list) or any(not isinstance(g, dict) for g in groups):
        raise ValueError(f'expected {event} to be a list of matcher groups')
    for group in groups:
        if 'hooks' in group and not isinstance(group['hooks'], list):
            raise ValueError(f'expected every {event} group to hold a "hooks" list')
    mine = [(group, handler) for group in groups for handler in group.get('hooks', [])
            if is_hook_handler(handler)]
    if action == 'install':
        handler = {'type': 'command', 'command': HOOK_COMMAND[client]}
        if waits:
            handler.update(timeout=HOOK_TIMEOUT_SECONDS, statusMessage=STATUS_MESSAGE)
        else:
            handler['timeout'] = QUICK_TIMEOUT_SECONDS
        if len(mine) > 1:
            raise ValueError(f'the board-ask hook is listed more than once under {event}; '
                             'inspect the file')
        if mine:
            group, existing = mine[0]
            existing.update(handler)  # a moved board gets the new path; other fields stay
            if matcher and all(is_hook_handler(h) for h in group['hooks']):
                group['matcher'] = matcher
        else:
            group = {'matcher': matcher, 'hooks': [handler]} if matcher else {'hooks': [handler]}
            if client == 'codex':
                group = {'name': GROUP_NAME, **group}
            groups.append(group)
        return
    for group, handler in mine:
        group['hooks'].remove(handler)
    emptied = [group for group, _ in mine
               if not group['hooks'] and set(group) <= {'name', 'matcher', 'hooks'}]
    groups[:] = [g for g in groups if not any(g is e for e in emptied)]
    if not groups:
        del events[event]


def updated_config(config, client, action):
    """A copy of config with this hook installed or removed under each of the client's events."""
    if not isinstance(config, dict) or not isinstance(config.get('hooks', {}), dict):
        raise ValueError('expected a JSON object whose "hooks" is an object')
    updated = copy.deepcopy(config)
    events = updated.setdefault('hooks', {})
    for event, matcher, waits in EVENTS[client]:
        updated_event(events, event, client, matcher, waits, action)
    if not events and 'hooks' not in config:
        del updated['hooks']
    return updated


def cmd_configure(action, client, claude_settings, codex_home, preview):
    path = settings_path(client, claude_settings, codex_home)
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    config = json.loads(original) if original is not None else {}
    updated = updated_config(config, client, action)
    if updated == config:
        print(f'No changes: {path}')
        return 0
    before = original.decode() if original is not None else ''
    after = json.dumps(updated, indent=2, ensure_ascii=False) + '\n'
    diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                        fromfile=str(path), tofile=str(path)))
    if preview:
        print(diff, end='')
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_bytes() if path.exists() else None
    if current != original:
        raise ValueError(f'{path} changed while it was being read; retry')
    if original is not None:
        with tempfile.NamedTemporaryFile(prefix=path.name + BACKUP_PREFIX, dir=path.parent,
                                         delete=False) as backup:
            backup.write(original)
        print(f'Backup: {backup.name}')
    with tempfile.NamedTemporaryFile('w', prefix=path.name + '.', dir=path.parent,
                                     delete=False) as tmp:
        tmp.write(after)
    if original is not None:
        shutil.copymode(path, tmp.name)
    os.replace(tmp.name, path)
    print(diff, end='')
    if client == 'codex':
        print(f'Updated {path}; trust the hook in /hooks in each Codex, and restart the ones '
              'already running')
    else:
        print(f'Updated {path}; agents already running pick it up at their next AskUserQuestion '
              'or permission request, or after a restart')
    return 0


# ---------------------------------------------------------------- entry

def main(argv=None):
    parser = argparse.ArgumentParser(prog='board-ask.py', description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='action', required=True)
    hook = sub.add_parser('hook', help="the client's hook; reads the payload on stdin")
    hook.add_argument('--client', choices=('claude', 'codex'), default='claude')
    observe = sub.add_parser('observe', help="watch Claude's transcript for what it did with a "
                                             'permission answer (started by the hook)')
    observe.add_argument('ask', help="the ask file's path")
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action} the hook in a client\'s settings')
        config.add_argument('--client', choices=('claude', 'codex'), required=True)
        config.add_argument('--claude-settings', metavar='PATH',
                            help='default: $CLAUDE_CONFIG_DIR/settings.json or '
                                 '~/.claude/settings.json')
        config.add_argument('--codex-home', metavar='DIR', help='default: $CODEX_HOME or ~/.codex')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    args = parser.parse_args(argv)
    if args.action == 'hook':
        return cmd_hook(args.client)
    if args.action == 'observe':
        try:
            run_observe(args.ask)
        except Exception:  # noqa: BLE001 - the board marks it 結果不明 once the watch is over
            pass
        return 0
    try:
        return cmd_configure(args.action, args.client, args.claude_settings, args.codex_home,
                             args.preview)
    except (OSError, ValueError) as exc:
        print(f'board-ask: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
