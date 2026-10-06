#!/usr/bin/env python3
"""Codex/Claude LAT controller records, recovery and DECIDE checks (stdlib only)."""
import argparse
import copy
import difflib
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
from lat_decision_status import read_advisor_error, read_decision_status

SKILL_DIR = Path(__file__).resolve().parents[1]
GROUP_NAME = 'lat-codex-recovery'
# The controller reads its own session ID from the client environment.
SESSION_ENV = dict(codex='CODEX_THREAD_ID', claude='CLAUDE_CODE_SESSION_ID')
MATCHER = '^(compact|resume)$'
# Pre-rename installs used codex-lat-session.py; recognize them so install/uninstall migrate.
COMMAND_NAMES = ('lat-session.py', 'codex-lat-session.py')
WATCH_SCRIPT = SKILL_DIR / 'scripts/lat-watch.py'
HCOM_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}')


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
    return [
        'uv', 'run', '--no-project', 'python', str(WATCH_SCRIPT), 'run',
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
    expected = tuple(watcher_command(record)[4:])
    return any(command[index:index + len(expected)] == expected
               for index in range(len(command) - len(expected) + 1))


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
            panel.bind_controller(record['hcom_name'], record['client'], record['session_id'],
                                  record['workspace'], *herdr)
    except (OSError, ValueError):
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
        # Under the lock deactivate also holds, so a stopped session is not bound again.
        if rebind:
            refresh_binding(latest)
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
        if legacy_record(existing):
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
        removed = panel_module().unbind_controller(sid)
        record['status'] = args.status
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


def stop_check(record, payload):
    message = payload['last_assistant_message']
    last = [line for line in message.splitlines() if line.strip()][-1]
    identifiers = set(re.findall(
        r'^❓ \*\*([A-Za-z0-9_.-]+) r([0-9]+)\*\*', message, re.MULTILINE))
    identifiers.update(re.findall(
        r'(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]+r([0-9]+)(?![A-Za-z0-9_])',
        last[len('DECIDE:'):]))
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
        if status is not None:
            advisor_error = read_advisor_error(decisions / f'{identifier}.md')
            if advisor_error:
                problems.append(f'{identifier} r{revision}：{advisor_error}')
    panel = panel_module()
    binding = next((item for item in panel.list_bindings()
                    if item.get('session_id') == record['session_id']), None)
    if binding is not None:
        if binding.get('client') != record['client'] or binding.get('workspace') != record['workspace']:
            raise ValueError('面板綁定與主控紀錄不符')
        questions_path = Path(binding['questions_path'])
        questions = panel.parse_questions(questions_path.read_text(encoding='utf-8')) if questions_path.exists() else []
        for identifier, revision in sorted(identifiers):
            if not any(question['id'] == identifier and question['status_label'] == '待答'
                       and question['revision'] == int(revision) for question in questions):
                problems.append(f'{identifier} r{revision}：自己的面板缺少同版本待答題目')
        _, missing, inconsistent, unreadable = panel.pending_question_gaps(questions_path, decisions)
        problems.extend(f'{identifier}：遺漏檢查缺少面板題目' for identifier in missing)
        problems.extend(f'{identifier}：遺漏檢查不一致（{reason}）'
                        for identifier, reason, _ in inconsistent)
        problems.extend(f'{path.name}：遺漏檢查讀不出狀態（{reason}）'
                        for path, reason in unreadable
                        if path.stem not in statuses or not statuses[path.stem].error)
    if not problems:
        return
    reason = 'LAT DECIDE 檢查未通過：' + '；'.join(problems) + (
        '。補做順序：寫待決紀錄 → 諮詢參謀或註明例外 → 寫入面板（已綁定時） → 遺漏檢查 → 依聊天提問格式重列題目。')
    if payload.get('stop_hook_active'):
        print(json.dumps({'systemMessage': reason + ' 本回合已繼續過，不再攔下。'}, ensure_ascii=False))
    else:
        print(json.dumps({'decision': 'block', 'reason': reason}, ensure_ascii=False))


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
            lines = [line for line in message.splitlines() if line.strip()]
            if not lines or not lines[-1].startswith('DECIDE:'):
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
            return
    except (OSError, ValueError, TypeError, KeyError):
        return
    try:
        record = read_json(path)
        expected = dict(client=client, session_id=sid, role='orchestrator',
                        workspace=str(root), status='active')
        # Reject known mismatches before checking broken dependencies.
        if any(key in record and record[key] != value for key, value in expected.items()):
            return
        if any(key not in record for key in expected):
            raise ValueError('Incomplete controller identity')
        if event == 'Stop':
            stop_check(record, payload)
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
            print(json.dumps({'systemMessage': f'LAT DECIDE 檢查發生錯誤，未攔下：{exc}'}, ensure_ascii=False))
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
    stop = sub.add_parser('deactivate', help='Complete/cancel a controller, retaining its record')
    stop.add_argument('--workspace', type=Path, required=True)
    stop.add_argument('--status', choices=('completed', 'cancelled'), required=True)
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
