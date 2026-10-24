#!/usr/bin/env python3
"""Answer a Claude Code AskUserQuestion menu on the LAT board instead of in the terminal.

The hook (`hook`, Claude's PreToolUse for AskUserQuestion) writes a board ask to the shared
folder, waits in place for the board's answer and hands it back as `allow` with `updatedInput`.
Anything that goes wrong gives no decision, so the client shows its own menu as before.
`install` and `uninstall` add or remove the hook in Claude's settings.

The shared folder, one board ask per file (all 0600):

- `<id>.json`: the ask, written whole by the hook (temporary file renamed into place). The hook
  writes it again with `outcome` (`filled` or `timed_out`) before it ends.
- `<id>.result.json`: who took the ask, written once: a temporary file hard-linked into place,
  which fails when the file already exists. The board writes `{"kind": "answer", ...}`, the hook
  at its deadline `{"kind": "timeout", ...}`; whoever links first wins.
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
STATUS_MESSAGE = '正在等看板作答，按 Esc 可中斷改在終端機回答'


def asks_dir(env):
    given = env.get('LAT_BOARD_ASKS_DIR')
    if given and os.path.isabs(given):
        return Path(given)
    state = env.get('XDG_STATE_HOME')
    base = Path(state) if state and os.path.isabs(state) else Path.home() / '.local/state'
    return base / 'lat/board-asks'


def wait_seconds(env):
    try:
        value = float(env.get('LAT_BOARD_ASK_WAIT_SECONDS', ''))
    except ValueError:
        return WAIT_SECONDS
    return value if value > 0 else WAIT_SECONDS


def iso(at):
    return datetime.fromtimestamp(at, timezone.utc).isoformat().replace('+00:00', 'Z')


def board_running(folder, now):
    try:
        return now - (folder / HEARTBEAT).stat().st_mtime <= HEARTBEAT_STALE_SECONDS
    except OSError:
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


def run_hook(text, env, clock=time.time, sleep=time.sleep):
    """The hook's decision for this input, or None to leave the client's own menu."""
    payload = json.loads(text)
    if not isinstance(payload, dict) or payload.get('hook_event_name') != 'PreToolUse' \
            or payload.get('tool_name') != 'AskUserQuestion':
        return None
    # A Task sub-agent's call, and an agent outside Herdr, which the board has no page for.
    if 'agent_id' in payload or not env.get('HERDR_PANE_ID'):
        return None
    tool_input = payload.get('tool_input')
    session_id = payload.get('session_id')
    if not isinstance(tool_input, dict) or not valid_questions(tool_input.get('questions')) \
            or not isinstance(session_id, str) or not session_id:
        return None
    folder = asks_dir(env)
    now = clock()
    if not board_running(folder, now):
        return None

    ask_id = uuid.uuid4().hex
    deadline = now + wait_seconds(env)
    ask_path = folder / f'{ask_id}.json'
    result_path = folder / f'{ask_id}.result.json'
    ask = {
        'id': ask_id,
        'client': 'claude',
        'session_id': session_id,
        'hcom_name': env.get('HCOM_INSTANCE_NAME') or None,
        'herdr_pane': env['HERDR_PANE_ID'],
        'cwd': payload.get('cwd') if isinstance(payload.get('cwd'), str) else os.getcwd(),
        'kind': 'question',
        'tool_use_id': payload.get('tool_use_id'),
        'tool_input': tool_input,
        'created_at': iso(now),
        'deadline_at': iso(deadline),
        'hook_pid': os.getpid(),
        'outcome': None,
        'outcome_at': None,
    }
    write_whole(ask_path, ask)

    result = None
    while result is None and clock() < deadline:
        sleep(POLL_SECONDS)
        result = read_json(result_path)
    if result is None and claim(result_path, {'kind': 'timeout', 'at': iso(clock())}):
        write_whole(ask_path, {**ask, 'outcome': 'timed_out', 'outcome_at': iso(clock())})
        return None
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


def cmd_hook():
    try:
        decision = run_hook(sys.stdin.read(), os.environ)
    except Exception:  # noqa: BLE001 - any failure leaves the client's own menu
        return 0
    if decision is not None:
        print(json.dumps(decision, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------- install

HOOK_COMMAND = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'hook'])
BACKUP_PREFIX = '.board-ask-backup-'
MATCHER = 'AskUserQuestion'


def is_hook_handler(handler):
    """A handler running some copy of this script's hook, wherever it is installed."""
    if not isinstance(handler, dict) or not isinstance(handler.get('command'), str):
        return False
    try:
        words = shlex.split(handler['command'])
    except ValueError:
        return False
    return any(os.path.basename(word) == SCRIPT.name for word in words) \
        and words[-1:] == ['hook']


def settings_path(claude_settings):
    if claude_settings:
        return Path(claude_settings).expanduser().resolve()
    home = os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'
    return Path(home).expanduser().resolve() / 'settings.json'


def updated_config(config, action):
    """A copy of config with this hook installed or removed under PreToolUse."""
    if not isinstance(config, dict) or not isinstance(config.get('hooks', {}), dict):
        raise ValueError('expected a JSON object whose "hooks" is an object')
    updated = copy.deepcopy(config)
    if action == 'uninstall' and 'PreToolUse' not in updated.get('hooks', {}):
        return updated
    events = updated.setdefault('hooks', {})
    groups = events.setdefault('PreToolUse', [])
    if not isinstance(groups, list) or any(not isinstance(g, dict) for g in groups):
        raise ValueError('expected PreToolUse to be a list of matcher groups')
    for group in groups:
        if 'hooks' in group and not isinstance(group['hooks'], list):
            raise ValueError('expected every PreToolUse group to hold a "hooks" list')
    mine = [(group, handler) for group in groups for handler in group.get('hooks', [])
            if is_hook_handler(handler)]
    if action == 'install':
        handler = {'type': 'command', 'command': HOOK_COMMAND, 'timeout': HOOK_TIMEOUT_SECONDS,
                   'statusMessage': STATUS_MESSAGE}
        if len(mine) > 1:
            raise ValueError('the board-ask hook is listed more than once; inspect the file')
        if mine:
            group, existing = mine[0]
            existing.update(handler)  # a moved board gets the new path; other fields stay
            if all(is_hook_handler(h) for h in group['hooks']):
                group['matcher'] = MATCHER
        else:
            groups.append({'matcher': MATCHER, 'hooks': [handler]})
        return updated
    for group, handler in mine:
        group['hooks'].remove(handler)
    emptied = [group for group, _ in mine
               if not group['hooks'] and set(group) <= {'matcher', 'hooks'}]
    groups[:] = [g for g in groups if not any(g is e for e in emptied)]
    if not groups:
        del events['PreToolUse']
    return updated


def cmd_configure(action, claude_settings, preview):
    path = settings_path(claude_settings)
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    config = json.loads(original) if original is not None else {}
    updated = updated_config(config, action)
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
    print(f'Updated {path}; agents already running pick it up at their next AskUserQuestion '
          'or after a restart')
    return 0


# ---------------------------------------------------------------- entry

def main(argv=None):
    parser = argparse.ArgumentParser(prog='board-ask.py', description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('hook', help='PreToolUse hook for AskUserQuestion; reads the payload on stdin')
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action} the hook in a client\'s settings')
        # Codex comes with its permission requests (a later ticket).
        config.add_argument('--client', choices=('claude',), required=True)
        config.add_argument('--claude-settings', metavar='PATH',
                            help='default: $CLAUDE_CONFIG_DIR/settings.json or '
                                 '~/.claude/settings.json')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    args = parser.parse_args(argv)
    if args.action == 'hook':
        return cmd_hook()
    try:
        return cmd_configure(args.action, args.claude_settings, args.preview)
    except (OSError, ValueError) as exc:
        print(f'board-ask: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
