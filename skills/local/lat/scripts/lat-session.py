#!/usr/bin/env python3
"""Codex/Claude LAT controller records, recovery and DECIDE/HELP checks (stdlib only)."""
import argparse
import copy
import difflib
from datetime import datetime, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import shlex
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lat_decision_status import (read_advisor_error, read_decision_kind, read_decision_status,
                                 read_spec_consensus_error)

SKILL_DIR = Path(__file__).resolve().parents[1]
GROUP_NAME = 'lat-codex-recovery'
# The controller reads its own session ID from the client environment.
SESSION_ENV = dict(codex='CODEX_THREAD_ID', claude='CLAUDE_CODE_SESSION_ID')
MATCHER = '^(compact|resume)$'
# Pre-rename installs used codex-lat-session.py; recognize them so install/uninstall migrate.
COMMAND_NAMES = ('lat-session.py', 'codex-lat-session.py')
WATCH_SCRIPT = SKILL_DIR / 'scripts/lat-watch.py'
HCOM_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}')
# Older records stored 'completed' or 'cancelled'; all three mean the round ended.
ENDED = ('ended', 'completed', 'cancelled')
# A last line with one of these tags asks the user a recorded question.
QUESTION_TAGS = ('DECIDE:', 'HELP:')


def panel_module():
    path = SKILL_DIR / 'herdr-panel/lat_panel.py'
    spec = importlib.util.spec_from_file_location('lat_panel', path)
    if spec is None or spec.loader is None:
        raise ValueError(f'Cannot load LAT panel helper: {path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def activate_command(client, workspace, progress, decisions, tasks, hcom_name):
    command = [
        'uv', 'run', '--no-project', 'python', str(Path(__file__).resolve()),
        'activate', '--client', client, '--workspace', str(workspace),
        '--progress', str(progress), '--decisions', str(decisions), '--tasks', str(tasks),
    ]
    if hcom_name:
        command += ['--hcom-name', hcom_name]
    else:
        command += ['--hcom-name', '<主控-HCOM-名稱>']
    return shlex.join(command)


def bind_command(args, workspace, sid):
    return shlex.join([
        'uv', 'run', '--no-project', 'python',
        str(SKILL_DIR / 'herdr-panel/lat_panel.py'), 'bind',
        '--hcom-name', args.hcom_name, '--client', args.client,
        '--session-id', sid, '--workspace', str(workspace),
    ])


def session_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError('A valid client session ID is required; do not infer a session ID')
    return value


def workspace_root(cwd):
    for path in (cwd, *cwd.parents):
        if (path / '.git').exists():
            return path
    raise ValueError('A Git worktree is required')


def read_json(path):
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value


def current_bytes(path):
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def write_json(path, value, expected):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
            if current_bytes(path) != expected:
                raise ValueError(f'Concurrent change detected: {path}; retry after inspection')
            if path.exists():
                os.chmod(temp, path.stat().st_mode & 0o777)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def legacy_record(record):
    return 'tasks_path' not in record and 'hcom_name' not in record


def dependencies(record, *, require_watcher=True):
    skill = Path(record['skill_dir'])
    files = [skill / 'SKILL.md', skill / 'references/agents.md',
             skill / 'references/task-cards.md', Path(record['progress_path'])]
    if require_watcher:
        files.append(skill / 'scripts/lat-watch.py')
    decisions = Path(record['decisions_path'])
    for path in [*files, decisions]:
        if not path.is_absolute():
            raise ValueError('Recovery paths must be absolute')
    for path in files:
        if not path.is_file():
            raise ValueError(f'Missing recovery file: {path}')
    if not decisions.is_dir():
        raise ValueError(f'Missing decisions directory: {decisions}')
    if require_watcher:
        tasks = Path(record['tasks_path'])
        if not tasks.is_absolute() or not tasks.is_dir():
            raise ValueError(f'Missing task-card directory: {tasks}')
        if not HCOM_NAME.fullmatch(record['hcom_name']):
            raise ValueError('A valid explicit --hcom-name is required')


def legacy_upgrade_command(record):
    return activate_command(
        record['client'], record['workspace'], record['progress_path'],
        record['decisions_path'], '<task-card-directory>', '<controller-HCOM-name>',
    )


def watcher_paths(record):
    root = Path(record['workspace']) / '.lat/watch'
    sid = record['session_id']
    return root / f'{sid}.pid', root / f'{sid}.lock', root / f'{sid}.log'


def watcher_command(record):
    script = Path(record['skill_dir']) / 'scripts/lat-watch.py'
    return [
        'uv', 'run', '--no-project', 'python', str(script), 'run',
        '--workspace', record['workspace'], '--orchestrator', record['hcom_name'],
        '--tasks', record['tasks_path'], '--decisions', record['decisions_path'],
    ]


def read_pid(path):
    try:
        value = int(path.read_text())
    except (FileNotFoundError, ValueError):
        return None
    return value if value > 1 else None


def process_command(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        if stat[stat.rfind(')') + 2:].split(maxsplit=1)[0] == 'Z':
            return None
        return tuple(part.decode() for part in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                     if part)
    except (FileNotFoundError, PermissionError, UnicodeDecodeError):
        return None


def watcher_running(record, pid=None):
    pid_path, _, _ = watcher_paths(record)
    pid = pid or read_pid(pid_path)
    command = process_command(pid) if pid is not None else None
    if command is None:
        return False
    expected = tuple(watcher_command(record)[5:])
    return any(Path(command[index]).name == 'lat-watch.py'
               and command[index + 1:index + 1 + len(expected)] == expected
               for index in range(len(command) - len(expected)))


def write_pid(path, pid):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            stream.write(f'{pid}\n')
            stream.flush()
            os.fsync(stream.fileno())
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def _ensure_watcher_locked(record):
    pid_path, lock_path, log_path = watcher_paths(record)
    if watcher_running(record):
        return read_pid(pid_path)
    pid_path.unlink(missing_ok=True)
    with log_path.open('ab') as output:
        process = subprocess.Popen(
            watcher_command(record), cwd=record['workspace'], stdin=subprocess.DEVNULL,
            stdout=output, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True,
        )
    write_pid(pid_path, process.pid)
    return process.pid


def move_status_display(panel, binding, replaced):
    """Restore the pane this session was bound to before, then show counts on the new one."""
    if replaced and replaced.get('herdr_pane') and replaced['herdr_pane'] != binding['herdr_pane']:
        panel.clear_status_display(replaced)
    return panel.refresh_status_display(binding['questions_path'])


def refresh_binding(record):
    """Point the panel binding at the Herdr pane this process runs in; never raise.

    A resumed session runs in a new Herdr tab and pane, so the IDs bound at
    activate go stale. Without all three IDs the binding is left as it is.
    """
    herdr = [os.environ.get(f'HERDR_{name}_ID') for name in ('WORKSPACE', 'TAB', 'PANE')]
    if not all(herdr):
        return
    try:
        panel = panel_module()
        if panel.panel_enabled():
            binding, replaced, _ = panel.bind_controller(
                record['hcom_name'], record['client'], record['session_id'],
                record['workspace'], *herdr)
            move_status_display(panel, binding, replaced)
    except (OSError, ValueError):
        pass


def ensure_tab_label(hcom_name):
    """Label this Herdr tab `lat-<name after the last hyphen>`; never raise."""
    tab = os.environ.get('HERDR_TAB_ID')
    if not tab:
        return
    label = f'lat-{hcom_name.rsplit("-", 1)[-1]}'
    try:
        result = subprocess.run(['herdr', 'tab', 'get', tab], capture_output=True, text=True,
                                timeout=5, check=True)
        if json.loads(result.stdout)['result']['tab']['label'] == label:
            return
        subprocess.run(['herdr', 'tab', 'rename', tab, label], capture_output=True,
                       timeout=5, check=True)
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        pass


def ensure_watcher(record, record_path, *, rebind=False):
    _, lock_path, _ = watcher_paths(record)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        latest = read_json(record_path)
        expected = dict(client=record['client'], session_id=record['session_id'],
                        role='orchestrator', workspace=record['workspace'], status='active')
        if any(key in latest and latest[key] != value for key, value in expected.items()):
            return None
        if any(key not in latest for key in expected):
            raise ValueError('Incomplete controller identity')
        dependencies(latest)
        pid = _ensure_watcher_locked(latest)
        # Under the lock deactivate also holds, so a stopped session is not bound or labeled.
        if rebind:
            refresh_binding(latest)
        ensure_tab_label(latest['hcom_name'])
        return pid


def process_group_exists(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False


def _stop_watcher_locked(record):
    pid_path, _, _ = watcher_paths(record)
    pid = read_pid(pid_path)
    if pid is None or not watcher_running(record, pid):
        pid_path.unlink(missing_ok=True)
        return
    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        pid_path.unlink(missing_ok=True)
        return
    if pgid != pid:
        raise ValueError(f'Watcher process group does not match pid {pid}; not stopping it')
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pid_path.unlink(missing_ok=True)
        return
    deadline = time.monotonic() + 2
    while process_group_exists(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    if process_group_exists(pid):
        os.killpg(pid, signal.SIGKILL)
    pid_path.unlink(missing_ok=True)


def activate(args):
    workspace = args.workspace.resolve(strict=True)
    if workspace_root(workspace) != workspace:
        raise ValueError('--workspace must be the Git worktree root')
    sid = session_id(os.environ.get(SESSION_ENV[args.client]))
    command = activate_command(
        args.client, workspace, args.progress.resolve(), args.decisions.resolve(),
        args.tasks.resolve(), args.hcom_name,
    )
    if not args.hcom_name or not HCOM_NAME.fullmatch(args.hcom_name):
        raise ValueError(f'A valid explicit --hcom-name is required; rerun: {command}')
    record = dict(client=args.client, session_id=sid, role='orchestrator',
                  workspace=str(workspace), status='active', skill_dir=str(SKILL_DIR),
                  progress_path=str(args.progress.resolve(strict=True)),
                  decisions_path=str(args.decisions.resolve(strict=True)),
                  tasks_path=str(args.tasks.resolve(strict=True)), hcom_name=args.hcom_name)
    dependencies(record)
    spec = importlib.util.spec_from_file_location('lat_watch', WATCH_SCRIPT)
    watcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(watcher)
    fingerprint = watcher.rule_fingerprint(SKILL_DIR)
    path = workspace / '.lat/sessions' / f'{sid}.json'
    original = current_bytes(path)
    if path.exists():
        existing = read_json(path)
        if existing.get('status') in ENDED:
            identity = ('client', 'session_id', 'role', 'workspace')
            required = set(record) - {'tasks_path', 'hcom_name'} if legacy_record(existing) else set(record)
            if (any(existing.get(key) != record[key] for key in identity)
                    or not required.issubset(existing)):
                raise ValueError('Existing session record differs; do not reset or rebind it')
            paths = ('skill_dir', 'progress_path', 'decisions_path')
            if not legacy_record(existing):
                paths += ('tasks_path',)
                name = existing['hcom_name']
                if not isinstance(name, str) or not HCOM_NAME.fullmatch(name):
                    raise ValueError('Invalid finished controller name; do not reset or rebind it')
            if any(not isinstance(existing[key], str) or not Path(existing[key]).is_absolute()
                   for key in paths):
                raise ValueError('Invalid finished recovery paths; do not reset or rebind it')
            history = existing.get('history', [])
            if not isinstance(history, list) or any(not isinstance(item, dict) for item in history):
                raise ValueError('Invalid session history; do not reset or rebind it')
            record['history'] = [*history, {key: value for key, value in existing.items()
                                          if key != 'history'}]
        elif legacy_record(existing):
            expected = {key: value for key, value in record.items()
                        if key not in ('tasks_path', 'hcom_name')}
            if any(existing.get(key) != value for key, value in expected.items()):
                raise ValueError('Existing session record differs; do not reset or rebind it')
            record = dict(existing, tasks_path=record['tasks_path'], hcom_name=record['hcom_name'])
        else:
            if any(existing.get(key) != value for key, value in record.items()):
                raise ValueError('Existing session record differs; do not reset or rebind it')
            record = existing
    record.setdefault('rule_fingerprint', fingerprint)
    panel = panel_module()
    try:
        enabled = panel.panel_enabled()
    except ValueError as error:
        raise ValueError(
            f'{error}；請修復 Herdr 後重新執行：{command}'
        ) from error
    write_json(path, record, original)
    print(path)
    print(f'已開始第 {len(record.get("history", [])) + 1} 輪')
    if enabled:
        try:
            binding, replaced, legacy_ignored = panel.bind_controller(
                args.hcom_name, args.client, sid, workspace,
                os.environ.get('HERDR_WORKSPACE_ID'), os.environ.get('HERDR_TAB_ID'),
                os.environ.get('HERDR_PANE_ID'),
            )
        except (OSError, ValueError) as error:
            raise ValueError(
                f'自動綁定失敗：{error}；session 紀錄保持 active。'
                '請先補齊 HERDR_WORKSPACE_ID、HERDR_TAB_ID、HERDR_PANE_ID，'
                f'再手動執行：{bind_command(args, workspace, sid)}'
            ) from error
        print(json.dumps({
            'binding': binding,
            'replaced': replaced,
            'legacy_ignored': legacy_ignored,
        }, ensure_ascii=False))
        print(f'問題檔：{binding["questions_path"]}')
        display = move_status_display(panel, binding, replaced)
        if display['status'] == 'failed':
            print(f'側欄未更新：{display["reason"]}')
    else:
        print('面板未啟用，略過綁定')
    if ensure_watcher(record, path) is None:
        raise ValueError('Session was deactivated while starting its watcher')


def pointer(path):
    return (f'LAT recovery record: {path}\n'
            'Before any dependent action, read this record, then fully re-read '
            'skill_dir/SKILL.md, skill_dir/references/agents.md, '
            'skill_dir/references/task-cards.md, progress_path, and all decision records '
            'in decisions_path. Resolve these paths from the record. Reconcile the progress '
            'index with the tracker; preserve the existing checklist. Verify prior human '
            'authorization and pending decisions before continuing. Missing or corrupt data: '
            'stop dependent work and report; never infer authorization or reset progress.')


def deactivate(args):
    if args.successor and not HCOM_NAME.fullmatch(args.successor):
        raise ValueError('Invalid successor HCOM name; record unchanged')
    workspace = args.workspace.resolve(strict=True)
    sid = session_id(args.session_id or os.environ.get(SESSION_ENV[args.client]))
    path = workspace / '.lat/sessions' / f'{sid}.json'
    lock_record = dict(workspace=str(workspace), session_id=sid)
    _, lock_path, _ = watcher_paths(lock_record)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        original = current_bytes(path)
        record = read_json(path)
        expected = dict(client=args.client, session_id=sid, role='orchestrator',
                        workspace=str(workspace))
        if any(record.get(key) != value for key, value in expected.items()):
            raise ValueError('Controller identity does not match; record unchanged')
        _stop_watcher_locked(record)
        panel = panel_module()
        try:
            panel.clear_status_display(panel.resolve_session_binding(sid))
        except (OSError, ValueError, KeyError):
            pass
        removed = panel.unbind_controller(sid)
        if record['status'] == 'active' and not legacy_record(record):
            record['final_report_pending'] = True
        record['status'] = 'ended'
        if args.successor:
            record['successor'] = args.successor
        write_json(path, record, original)
    print(path)
    print(json.dumps({'removed': removed}))


def context(text):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart',
                                            'additionalContext': text}}))


def configure(args):
    if args.client == 'codex':
        path = args.codex_home.expanduser().resolve() / 'hooks.json'
    else:
        path = args.claude_settings.expanduser().resolve()
    original = current_bytes(path)
    config = json.loads(original) if original is not None else {}
    if not isinstance(config, dict) or not isinstance(config.get('hooks', {}), dict):
        raise ValueError('Expected hooks.json object with a hooks object')
    if args.action == 'uninstall' and 'hooks' not in config:
        print('No changes')
        return
    updated = copy.deepcopy(config)
    events = updated.setdefault('hooks', {})
    for event in ('SessionStart', 'Stop'):
        if args.action == 'uninstall' and event not in events:
            continue
        groups = events.setdefault(event, [])
        if not isinstance(groups, list) or any(not isinstance(g, dict) for g in groups):
            raise ValueError(f'Expected {event} matcher groups')
        if args.client == 'codex':
            owned = [g for g in groups if g.get('name') == GROUP_NAME]
        else:
            # Claude settings groups have no name field; own the group holding our command.
            owned = [g for g in groups if isinstance(g.get('hooks'), list)
                     and any(is_lat_command(h) for h in g['hooks'])]
        if args.action == 'install':
            command = ['uv', 'run', '--no-project', 'python',
                       str(SKILL_DIR / 'scripts/lat-session.py'), 'hook']
            if args.client == 'claude':
                command += ['--client', 'claude']
            command = shlex.join(command)
            handler = dict(type='command', command=command)
            if owned:
                # Own only our command, preserving unknown fields and added third-party handlers.
                if len(owned) != 1:
                    raise ValueError('Duplicate LAT groups; inspect hooks.json')
                group = owned[0]
                handlers = group.get('hooks')
                if not isinstance(handlers, list):
                    raise ValueError('Invalid LAT command group')
                lat_handlers = [h for h in handlers if is_lat_command(h)]
                # An unnamed Claude group may be shared; resetting its matcher would
                # change when the other handlers run.
                if args.client == 'claude' and len(lat_handlers) != len(handlers):
                    raise ValueError(f'LAT hook shares a {event} group with other handlers; '
                                     'move them to their own group and retry')
                if len(lat_handlers) > 1:
                    raise ValueError('LAT group ownership is ambiguous; inspect hooks.json')
                if lat_handlers:
                    lat_handlers[0].update(handler)
                else:
                    handlers.append(handler)
                if event == 'SessionStart':
                    group['matcher'] = MATCHER
                else:
                    group.pop('matcher', None)
            else:
                group = dict(hooks=[handler])
                if args.client == 'codex':
                    group['name'] = GROUP_NAME
                if event == 'SessionStart':
                    group['matcher'] = MATCHER
                groups.append(group)
        else:
            for group in owned:
                handlers = group.get('hooks')
                if not isinstance(handlers, list):
                    raise ValueError('Invalid LAT command group')
                group['hooks'] = [h for h in handlers if not is_lat_command(h)]
                if not group['hooks'] and set(group) <= {'name', 'matcher', 'hooks'}:
                    groups.remove(group)
    if updated == config:
        print('No changes')
        return
    before = original.decode() if original is not None else ''
    after = json.dumps(updated, indent=2, ensure_ascii=False) + '\n'
    if args.preview:
        print(''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                         fromfile=str(path), tofile=str(path))), end='')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    if current_bytes(path) != original:
        raise ValueError('Concurrent hooks.json change; retry after inspection')
    if original is not None:
        with tempfile.NamedTemporaryFile(prefix=f'{path.name}.lat-backup-', dir=path.parent,
                                         delete=False) as backup:
            backup.write(original)
            print(f'Backup: {backup.name}')
    write_json(path, updated, original)
    if args.client == 'codex':
        print(f'Updated {path}; review changed hooks through Codex /hooks before use')
    else:
        print(f'Updated {path}; restart Claude Code sessions and confirm the hook in /hooks')


def is_lat_command(handler):
    if not isinstance(handler, dict) or handler.get('type') != 'command':
        return False
    try:
        command = shlex.split(handler.get('command', ''))
        return (len(command) in (6, 8) and command[:4] == ['uv', 'run', '--no-project', 'python']
                and Path(command[4]).name in COMMAND_NAMES and command[5] == 'hook'
                and command[6:] in ([], ['--client', 'claude']))
    except (ValueError, TypeError):
        return False


def question_tag(message):
    """The DECIDE/HELP tag that starts the last nonblank line, or None."""
    lines = [line for line in message.splitlines() if line.strip()]
    return next((tag[:-1] for tag in QUESTION_TAGS if lines and lines[-1].startswith(tag)), None)


def tag_line_identifiers(message):
    """`<ID> r<N>` written after the last line's DECIDE/HELP tag."""
    last = [line for line in message.splitlines() if line.strip()][-1]
    return set(re.findall(
        r'(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]+r([0-9]+)(?![A-Za-z0-9_])',
        last.split(':', 1)[1]))


def question_identifiers(message):
    """`❓ **<ID> r<N>**` headings plus `<ID> r<N>` on the last line's tag."""
    return set(re.findall(
        r'^❓ \*\*([A-Za-z0-9_.-]+) r([0-9]+)\*\*', message, re.MULTILINE)
    ) | tag_line_identifiers(message)


def missing_question_parts(panel, question, message):
    """Parts of the question's text absent from the message, compared without whitespace.

    Parts are searched in order from the question's `❓ **<ID> r<N>**` heading,
    or from the start of the message without one; the tag line is not searched.
    """
    def compact(text):
        return re.sub(r'\s+', '', text)
    body = message.rstrip()
    body = body[:body.rfind('\n') + 1]
    heading = re.search(
        rf'^❓ \*\*{re.escape(question["id"])} r{question["revision"]}\*\*', body, re.MULTILINE)
    text = compact(body[heading.start():] if heading else body)
    cursor = 0
    missing = []
    for name, part in panel.question_chat_parts(question):
        found = text.find(compact(part), cursor)
        if found < 0:
            missing.append(name)
        else:
            cursor = found + len(compact(part))
    return missing


def announced_questions(record):
    """Question IDs and revisions this session already asked in a reported DECIDE/HELP.

    An unreadable report log counts as nothing asked; the report write warns about it.
    """
    announced = set()
    try:
        lines = reports_path(record).read_bytes().splitlines()
    except OSError:
        return announced
    for line in lines:
        try:
            item = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if (isinstance(item, dict) and item.get('tag') in ('DECIDE', 'HELP')
                and isinstance(item.get('message'), str) and question_tag(item['message'])):
            announced |= question_identifiers(item['message'])
    return announced


def hold_once(payload, reason):
    """Block the first Stop of a turn; later ones only leave a visible warning."""
    if payload.get('stop_hook_active'):
        print(json.dumps({'systemMessage': reason + ' 本回合已繼續過，不再攔下。'}, ensure_ascii=False))
        return False
    print(json.dumps({'decision': 'block', 'reason': reason}, ensure_ascii=False))
    return True


def stop_check(record, payload):
    message = payload['last_assistant_message']
    tag = question_tag(message)
    identifiers = question_identifiers(message)
    problems = []
    if not identifiers:
        problems.append('沒有寫出題號與版本')
    decisions = Path(record['decisions_path'])
    if not decisions.is_dir():
        raise ValueError(f'待決目錄不存在：{decisions}')
    statuses = {}
    for path in sorted(decisions.glob('*.md')):
        status = read_decision_status(path)
        statuses[path.stem] = status
        if status.error:
            problems.append(f'{path.name}：讀不出狀態（{status.error}）')
    for identifier, revision in sorted(identifiers):
        status = statuses.get(identifier)
        if status is None:
            problems.append(f'{identifier} r{revision}：沒有待決紀錄')
        elif status.error is None and status.status != 'pending':
            problems.append(f'{identifier} r{revision}：紀錄不是 pending')
        if status is not None and tag == 'HELP' and read_decision_kind(
                decisions / f'{identifier}.md') != 'help':
            problems.append(f'{identifier} r{revision}：HELP 題的紀錄沒有 `- kind: help`')
        if status is not None:
            advisor_error = read_advisor_error(decisions / f'{identifier}.md')
            if advisor_error:
                problems.append(f'{identifier} r{revision}：{advisor_error}')
            else:
                consensus_error = read_spec_consensus_error(decisions / f'{identifier}.md', message)
                if consensus_error:
                    problems.append(f'{identifier} r{revision}：{consensus_error}')
    panel = panel_module()
    binding = next((item for item in panel.list_bindings()
                    if item.get('session_id') == record['session_id']), None)
    if binding is not None:
        if binding.get('client') != record['client'] or binding.get('workspace') != record['workspace']:
            raise ValueError('面板綁定與主控紀錄不符')
        questions_path = Path(binding['questions_path'])
        questions = panel.parse_questions(questions_path.read_text(encoding='utf-8')) if questions_path.exists() else []
        listed = tag_line_identifiers(message) or identifiers
        for identifier, revision in sorted(identifiers):
            question = next((question for question in questions
                             if question['id'] == identifier and question['status_label'] == '待答'
                             and question['revision'] == int(revision)), None)
            if question is None:
                problems.append(f'{identifier} r{revision}：自己的面板缺少同版本待答題目')
            elif (identifier, revision) in listed:
                missing = missing_question_parts(panel, question, message)
                if missing:
                    problems.append(f'{identifier} r{revision}：訊息沒有照抄題目原文，缺少'
                                    + '、'.join(missing))
        _, missing, inconsistent, unreadable, reverse = panel.pending_question_gaps(questions_path, decisions)
        problems.extend(f'{identifier}：遺漏檢查缺少面板題目' for identifier in missing)
        problems.extend(f'{identifier}：遺漏檢查不一致（{reason}）'
                        for identifier, reason, _ in inconsistent)
        problems.extend(f'{identifier}：{reason}' for identifier, reason, _ in reverse)
        problems.extend(f'{path.name}：遺漏檢查讀不出狀態（{reason}）'
                        for path, reason in unreadable
                        if path.stem not in statuses or not statuses[path.stem].error)
    if not problems:
        # The tag line decides; headings count only when the tag line names no question.
        listed = tag_line_identifiers(message) or identifiers
        if listed <= announced_questions(record):
            names = '、'.join(f'{identifier} r{revision}'
                              for identifier, revision in sorted(listed))
            return hold_once(payload, (
                f'LAT {tag} 檢查未通過：最後一行只列出 {names}，已在先前訊息以 DECIDE／HELP 問過，版本沒變。'
                '這則有新題或改版時，把它的題號寫進最後一行；沒有時改以 `NO REPLY: ` 開頭，'
                '題目仍待答，側欄會持續顯示。'))
        return
    return hold_once(payload, f'LAT {tag} 檢查未通過：' + '；'.join(problems) + (
        '。Spec 確認題先更新 Spec 共識 → 跑檢查工具 → 確認題寫明共識版本。補做順序：寫待決紀錄 → 諮詢參謀或註明例外 → 寫入面板（已綁定時） → 遺漏檢查 → 依聊天提問格式重列題目。'))


def reports_path(record):
    override = os.environ.get('LAT_REPORTS_DIR')
    state = os.environ.get('XDG_STATE_HOME')
    directory = (Path(override) if override else
                 (Path(state) if state and Path(state).is_absolute() else
                  Path.home() / '.local/state') / 'lat/reports')
    if not directory.is_absolute():
        raise ValueError('LAT_REPORTS_DIR must be absolute')
    return directory / f'{record["session_id"]}.jsonl'


def append_report(record, message):
    """Append one allowed Stop; the report log also guards the final record."""
    if legacy_record(record):
        return
    path = reports_path(record)
    directory = path.parent
    final = record['status'] in ENDED
    if final and not record.get('final_report_pending'):
        return
    round_number = len(record.get('history', [])) + 1
    lines = [line for line in message.splitlines() if line.strip()]
    match = re.fullmatch(r'(DECIDE|HELP|DONE|NO REPLY):[ \t]*(.*)', lines[-1]) if lines else None
    report = dict(time=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
                  session_id=record['session_id'], hcom_name=record['hcom_name'],
                  client=record['client'], workspace=record['workspace'], round=round_number,
                  tag=match[1] if match else '', summary=match[2] if match else '',
                  message=message, final=final)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / f'{record["session_id"]}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with path.open('a+b') as stream:
            if final:
                stream.seek(0)
                for line in stream:
                    try:
                        item = json.loads(line)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if (isinstance(item, dict) and item.get('round') == round_number
                            and item.get('final')):
                        os.fsync(stream.fileno())
                        return
            stream.seek(0, os.SEEK_END)
            if stream.tell():
                stream.seek(-1, os.SEEK_END)
                if stream.read(1) != b'\n':
                    stream.write(b'\n')
            stream.write((json.dumps(report, ensure_ascii=False) + '\n').encode('utf-8'))
            stream.flush()
            os.fsync(stream.fileno())


def report_stop(record, payload):
    if record['status'] == 'active':
        tag = question_tag(payload['last_assistant_message'])
        if tag:
            try:
                if stop_check(record, payload):
                    return
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
                print(json.dumps({'systemMessage': f'LAT {tag} 檢查發生錯誤，未攔下：{exc}'},
                                 ensure_ascii=False))
    try:
        append_report(record, payload['last_assistant_message'])
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f'LAT report warning: {exc}', file=sys.stderr)


CLAUDE_LAT_COMMAND = '<command-name>/lat</command-name>'
CODEX_LAT_NAME = '<name>lat</name>'
CODEX_LAT_SKILL = re.compile(r'\s*<skill>\s*' + re.escape(CODEX_LAT_NAME))
# Raw-line prefilter: every line invoked_lat can accept contains one of these.
LAT_MARKERS = dict(claude=(CLAUDE_LAT_COMMAND, '"Skill"'), codex=(CODEX_LAT_NAME,))


def transcript_record(client, record):
    """Whether a parsed line has the shape of this client's transcript records."""
    if client == 'claude':
        return isinstance(record.get('type'), str) and 'sessionId' in record
    return isinstance(record.get('type'), str) and isinstance(record.get('payload'), dict)


def invoked_lat(client, record):
    """Whether one transcript record is the client calling up the LAT skill.

    Claude: the user's /lat command, or a Skill tool call for ``lat``/``<ns>:lat``.
    Codex: the ``<skill>`` block Codex injects when the user types ``$lat``.
    Reading SKILL.md with a tool leaves neither, so it never counts.
    """
    if client == 'claude':
        message = record.get('message')
        if not isinstance(message, dict):
            return False
        content = message.get('content')
        if record.get('type') == 'user':
            if isinstance(content, str):
                return CLAUDE_LAT_COMMAND in content
            return isinstance(content, list) and any(
                isinstance(block, dict) and block.get('type') == 'text'
                and CLAUDE_LAT_COMMAND in str(block.get('text', '')) for block in content)
        if record.get('type') == 'assistant' and isinstance(content, list):
            for block in content:
                if (isinstance(block, dict) and block.get('type') == 'tool_use'
                        and block.get('name') == 'Skill' and isinstance(block.get('input'), dict)):
                    skill = block['input'].get('skill')
                    if isinstance(skill, str) and skill.rsplit(':', 1)[-1] == 'lat':
                        return True
        return False
    payload = record.get('payload')
    if (record.get('type') != 'response_item' or not isinstance(payload, dict)
            or payload.get('type') != 'message' or payload.get('role') != 'user'
            or not isinstance(payload.get('content'), list)):
        return False
    return any(isinstance(block, dict) and block.get('type') == 'input_text'
               and CODEX_LAT_SKILL.match(str(block.get('text', '')))
               for block in payload['content'])


def lat_transcript(client, payload, sid):
    """Read the conversation's transcript; True when it shows the LAT skill was called up."""
    path = payload.get('transcript_path')
    if path is None:
        path = panel_module().transcript_path(client, sid)
    elif not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError(f'transcript_path is not an absolute path: {path!r}')
    # Transcripts can be large: parse lines until one confirms the format, then only marker lines.
    markers = LAT_MARKERS[client]
    records = False
    with open(path, encoding='utf-8') as stream:
        for line in stream:
            if records and not any(marker in line for marker in markers):
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if isinstance(record, dict) and transcript_record(client, record):
                records = True
                if invoked_lat(client, record):
                    return True
    if not records:
        raise ValueError(f'no transcript records in {path}')
    return False


def activation_check(client, payload, sid):
    """Block the Stop of a conversation started with the LAT skill that never activated."""
    if os.environ.get('HCOM_LAUNCHED_BY', '') not in ('', 'user') or payload.get('stop_hook_active'):
        return
    try:
        if not lat_transcript(client, payload, sid):
            return
    except (OSError, ValueError, TypeError, UnicodeDecodeError) as exc:
        print(f'LAT activation check warning: {exc}', file=sys.stderr)
        return
    recovery = SKILL_DIR / 'references/recovery.md'
    print(json.dumps({'decision': 'block', 'reason': (
        'LAT 啟用檢查未通過：這段對話以 LAT 技能啟動，但這個工作區還沒有本 session 的 LAT 紀錄。'
        f'請依主控恢復程序（{recovery}）執行 activate。'
        '只是閱讀或審查技能時，在回覆中說明原因即可結束。')},
        ensure_ascii=False))


def hook(client):
    # Hook payload IDs are authoritative: the hook process has no client session env.
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        event = payload.get('hook_event_name')
        if event == 'Stop':
            message = payload.get('last_assistant_message')
            if not isinstance(message, str):
                return
        elif event != 'SessionStart' or payload.get('source') not in ('compact', 'resume'):
            return
        sid = session_id(payload.get('session_id'))
        cwd = Path(payload['cwd'])
        if not cwd.is_absolute():
            return
        root = workspace_root(cwd.resolve(strict=True))
        path = root / '.lat/sessions' / f'{sid}.json'
        if not path.exists():
            if event == 'Stop':
                activation_check(client, payload, sid)
            return
    except (OSError, ValueError, TypeError, KeyError):
        return
    try:
        record = read_json(path)
        expected = dict(client=client, session_id=sid, role='orchestrator',
                        workspace=str(root))
        if event != 'Stop':
            expected['status'] = 'active'
        # Reject known mismatches before checking broken dependencies.
        if any(key in record and record[key] != value for key, value in expected.items()):
            return
        if any(key not in record for key in expected):
            raise ValueError('Incomplete controller identity')
        if event == 'Stop':
            if 'status' not in record:
                raise ValueError('Incomplete controller identity')
            if record.get('status') == 'active' or record.get('status') in ENDED:
                report_stop(record, payload)
            return
        if legacy_record(record):
            dependencies(record, require_watcher=False)
            context(f'{pointer(path)}\nLegacy session upgrade: {legacy_upgrade_command(record)}')
            return
        dependencies(record)
        if ensure_watcher(record, path, rebind=True) is None:
            return
        context(pointer(path))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        if event == 'Stop':
            tag = question_tag(message)
            if tag:
                print(json.dumps({'systemMessage': f'LAT {tag} 檢查發生錯誤，未攔下：{exc}'},
                                 ensure_ascii=False))
            else:
                print(f'LAT report warning: {exc}', file=sys.stderr)
            return
        context(f'LAT recovery error: {path}. Record or recovery files are missing/corrupt. '
                'Stop dependent work and report; do not infer authorization or recreate progress.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    start = sub.add_parser('activate', help='Activate only the current LAT controller')
    start.add_argument('--workspace', type=Path, required=True)
    start.add_argument('--progress', type=Path, required=True)
    start.add_argument('--decisions', type=Path, required=True)
    start.add_argument('--tasks', type=Path, required=True)
    start.add_argument('--hcom-name')
    stop = sub.add_parser('deactivate', help='End a controller, retaining its record')
    stop.add_argument('--workspace', type=Path, required=True)
    stop.add_argument('--successor', help='HCOM name of the controller taking over')
    # Accepted for older callers; every deactivation ends as 'ended'.
    stop.add_argument('--status', choices=('completed', 'cancelled'), help=argparse.SUPPRESS)
    stop.add_argument('--session-id', help='Explicit ID for manual stale-record deactivation')
    sub.add_parser('hook', help='Read SessionStart or Stop payload on stdin')
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action.title()} the independent LAT hook group')
        config.add_argument('--codex-home', type=Path,
                            default=Path(os.environ.get('CODEX_HOME', '~/.codex')))
        config.add_argument('--claude-settings', type=Path,
                            default=Path('~/.claude/settings.json'))
        config.add_argument('--preview', action='store_true', help='Show diff without writing')
    for command in sub.choices.values():
        command.add_argument('--client', choices=tuple(SESSION_ENV), default='codex')
    args = parser.parse_args()
    try:
        if args.action == 'activate':
            activate(args)
        elif args.action == 'deactivate':
            deactivate(args)
        elif args.action == 'hook':
            hook(args.client)
        else:
            configure(args)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f'LAT error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
