#!/usr/bin/env python3
"""Codex/Claude LAT controller records, recovery and DECIDE/HELP checks (stdlib only)."""
import argparse
import copy
import difflib
from datetime import datetime, timezone
import fcntl
import importlib
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
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lat_decision_status import (read_advisor_error, read_decision_kind, read_decision_status,
                                 read_spec_consensus_error)
from _lat_common import (reports_directory, run_cli, shared_lat_dir, watcher_process_matches,
                         write_json_atomic)

SKILL_DIR = Path(__file__).resolve().parents[1]
GROUP_NAME = 'lat-codex-recovery'
# The controller reads its own session ID from the client environment.
SESSION_ENV = dict(codex='CODEX_THREAD_ID', claude='CLAUDE_CODE_SESSION_ID')
MATCHER = '^(compact|resume)$'
# Pre-rename installs used codex-lat-session.py; recognize them so install/uninstall migrate.
COMMAND_NAMES = ('lat-session.py', 'codex-lat-session.py')
WATCH_SCRIPT = SKILL_DIR / 'scripts/lat-watch.py'
AUTOCLEAN_SCRIPT = SKILL_DIR / 'scripts/lat-autoclean.py'
LEDGER_SCRIPT = SKILL_DIR / 'scripts/lat-ledger.py'
LEDGER_TIMEOUT_SECONDS = 120
# Whole recovery prompt: Claude Code moves context over 10,000 characters to a file;
# Codex caps hook context near 2,500 tokens.
CONTEXT_LIMITS = dict(claude=9_800, codex=3_000)
LEDGER_HEADING = '\n\nWork ledger (authority for item state, times and evidence): '
HCOM_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}')
# Older records stored 'completed' or 'cancelled'; all three mean the round ended.
ENDED = ('ended', 'completed', 'cancelled')
# A last line with one of these tags asks the user a recorded question.
QUESTION_TAGS = ('DECIDE:', 'HELP:')
# A last line with one of these tags needs the controller's duty on record first.
DUTY_TAGS = QUESTION_TAGS + ('DONE:',)
DUTY_LIMIT = 40
REAP_TIMEOUT_SECONDS = 60
HOOK_EVENTS = ('SessionStart', 'Stop', 'UserPromptSubmit')
INLINE_REFERENCES = ('references/agents.md', 'references/task-cards.md')
QUESTION_HEADING = re.compile(r'^❓ \*\*([A-Za-z0-9_.-]+) r([0-9]+)\*\*', re.MULTILINE)
# Between questions the Stop hook shows; Claude Code drops blank lines, so a visible line.
QUESTION_SEPARATOR = '\n\n' + '─' * 20 + '\n\n'
# HCOM wakes an agent with a prompt holding only this marker; the message itself arrives in hook context.
HCOM_PROMPT = re.compile(r'(?:\s*<hcom>)+\s*')


def panel_module(name='bindings'):
    """Load only the panel capability needed by this hook path."""
    directory = SKILL_DIR / 'herdr-panel'
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
    return importlib.import_module(name)


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


def session_path(workspace, sid):
    """Records live in the main checkout's shared .lat; an older one in a worktree's own .lat
    is still found there, never moved."""
    path = shared_lat_dir(workspace) / 'sessions' / f'{sid}.json'
    legacy = Path(workspace) / '.lat/sessions' / f'{sid}.json'
    return legacy if not path.exists() and legacy.exists() else path


def watcher_paths(record):
    root = session_path(record['workspace'], record['session_id']).parent.parent / 'watch'
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


def watcher_running(record, pid=None):
    pid_path, _, _ = watcher_paths(record)
    pid = pid or read_pid(pid_path)
    return watcher_process_matches(pid, watcher_command(record)[5:])


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
    write_json_atomic(pid_path, process.pid)
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
        output = run_cli(['herdr', 'tab', 'get', tab], timeout=5)
        if json.loads(output)['result']['tab']['label'] == label:
            return
        run_cli(['herdr', 'tab', 'rename', tab, label], timeout=5)
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
    path = session_path(workspace, sid)
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
    round_number = len(record.get('history', [])) + 1
    if not record.get('ledger_path'):
        record['ledger_path'] = str(round_ledger(workspace, sid, round_number, args.hcom_name))
    write_json_atomic(path, record, expected=original)
    print(path)
    print(f'已開始第 {round_number} 輪')
    print(f'工作總表：{record["ledger_path"]}')
    print(f'看板職責：任務明確後執行（任務改變時再執行一次）：{duty_command(record)}')
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
    start_autoclean(workspace)


def ledger_module():
    spec = importlib.util.spec_from_file_location('lat_ledger', LEDGER_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ledger_cli(*args):
    return subprocess.run([sys.executable, str(LEDGER_SCRIPT), *map(str, args)], text=True,
                          capture_output=True, timeout=LEDGER_TIMEOUT_SECONDS)


def ledger_command(action, path, *extra):
    return shlex.join(['uv', 'run', '--no-project', 'python', str(LEDGER_SCRIPT), action,
                       '--ledger', str(path), *extra])


def round_ledger(workspace, sid, round_number, hcom_name):
    """The round's ledger in the main checkout's .lat, created unless an earlier activate of
    this round already made it."""
    lat = shared_lat_dir(workspace)
    path = lat / 'ledgers' / f'{sid}-r{round_number}.json'
    store = ledger_module().Store(path)
    if any(item.exists() for item in (store.path, store.seal, store.journal)):
        return path
    result = ledger_cli('init', '--ledger', path, '--workspace', lat.parent,
                        '--orchestrator', hcom_name, '--by', hcom_name)
    if result.returncode:
        raise ValueError(f'工作總表建立失敗：{result.stderr.strip() or result.stdout.strip()}')
    return path


def ledger_check(path):
    """`(state, text)` of `lat-ledger check`: ok, fail, or unreadable (never a pass)."""
    try:
        result = ledger_cli('check', '--ledger', path)
    except (OSError, subprocess.SubprocessError) as exc:
        return 'unreadable', f'lat-ledger check 無法執行：{exc}'
    if result.returncode == 0:
        return 'ok', result.stdout.strip()
    if result.stdout.startswith('ledger check:'):
        return 'fail', result.stdout.strip()
    return 'unreadable', result.stderr.strip() or result.stdout.strip() or f'exit {result.returncode}'


def ledger_repair(path):
    """The repair that would make an unreadable ledger readable again, or None when none can.

    A well-formed ledger whose seal no longer matches keeps its content (`repair --reason`);
    a missing or malformed one is rebuilt from its journal while that is usable.
    """
    module = ledger_module()
    store = module.Store(path)
    try:
        module.parse_ledger(store.path.read_bytes())
        return ledger_command('repair', path, '--reason', '<原因>')
    except (OSError, ValueError, UnicodeError):
        pass
    try:
        module.read_journal(store)
    except module.Failure:
        return None
    return ledger_command('repair', path, '--from-journal', '--reason', '<原因>')


def ledger_gate(record, args):
    """Check the round's ledger before deactivating; returns the forced-close note or None."""
    path = record['ledger_path']
    state, text = ledger_check(path)
    if state == 'ok':
        return None
    force = ('補做（結案並附證據，或由主控取消並寫原因）後重跑；確定要結束時加 '
             '`--force-unfinished --reason "<原因>"` 強制停用。')
    if state == 'fail':
        if not args.force_unfinished:
            raise ValueError(f'工作總表核對未通過，拒絕停用：\n{text}\n{force}')
        module = ledger_module()
        by = record['hcom_name']
        try:
            with module.transaction(argparse.Namespace(ledger=path, by=by),
                                    'force-unfinished', reason=args.reason) as doc:
                doc['history'].append({'at': module.stamp(module.now()), 'by': by,
                                       'action': 'force-unfinished', 'reason': args.reason})
        except module.Failure as exc:
            raise ValueError(f'強制停用原因寫不進工作總表，未停用：{exc}') from exc
        return dict(reason=args.reason, saved_in='ledger', check=text)
    repair = ledger_repair(path)
    if repair:
        raise ValueError(f'工作總表無法讀取，拒絕停用：{text}\n先執行 `{repair}` 修復，'
                         '再重跑 deactivate（修復前強制停用也會拒絕）。')
    if not args.force_unfinished:
        raise ValueError(f'工作總表無法讀取，流水帳也重建不了，拒絕停用：{text}\n'
                         '確定要結束時加 `--force-unfinished --reason "<原因>"` 強制停用。')
    return dict(reason=args.reason, saved_in='session', check=text)


def ledger_context(record, text):
    """Append the round's `show` table to the recovery prompt, cut to the client's limit."""
    path = record.get('ledger_path')
    if not path:
        return text
    command = ledger_command('show', path)
    try:
        result = ledger_cli('show', '--ledger', path)
    except (OSError, subprocess.SubprocessError) as exc:
        result = SimpleNamespace(returncode=1, stdout='', stderr=str(exc))
    limit = CONTEXT_LIMITS[record['client']]
    if result.returncode:
        detail = result.stderr.strip() or f'exit {result.returncode}'
        tail = (f'\nLedger: {path}. Stop dependent work and report; repair it as the error '
                'says, never recreate it by hand.')
        room = max(0, limit - len(text) - len(tail) - len('\n\nLAT work ledger error: '))
        if len(detail) > room:
            # The repair hint ends lat-ledger's messages; keep the end.
            detail = '…' + detail[len(detail) - max(0, room - 1):]
        return f'{text}\n\nLAT work ledger error: {detail}{tail}'
    full = f'{text}{LEDGER_HEADING}its `show` output follows and counts as running `{command}`\n\n'
    table = result.stdout.rstrip('\n')
    if len(full) + len(table) <= limit:
        return full + table
    cut = f'{text}{LEDGER_HEADING}`show` output cut to fit the hook limit; run `{command}` for the rest\n\n'
    lines = table.splitlines()
    kept = []
    for line in lines:
        note = f'\n… {len(lines) - len(kept)} more lines not shown'
        if len(cut) + len('\n'.join(kept + [line])) + len(note) > limit:
            break
        kept.append(line)
    return cut + '\n'.join(kept) + f'\n… {len(lines) - len(kept)} more lines not shown'


def start_autoclean(workspace):
    """Hand off to automatic cleanup, which logs and returns at once; it never fails the caller."""
    try:
        spec = importlib.util.spec_from_file_location('lat_autoclean', AUTOCLEAN_SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.trigger(workspace)
    except Exception as error:  # noqa: BLE001 - cleanup must never block a round starting or ending
        print(f'自動清理未啟動：{error}')


def reap_command(*args):
    """The service reaper beside this script; LAT_REAP_COMMAND replaces it in tests."""
    replacement = shlex.split(os.environ.get('LAT_REAP_COMMAND', ''))
    return [*(replacement or [sys.executable, str(Path(__file__).with_name('lat-reap.py'))]),
            *args]


def reap_on_deactivate(record):
    """End this controller's keeps, then close leftovers; a failure prints one line only."""
    steps = [('reap', '--trigger', 'deactivate')]
    if record.get('hcom_name'):
        steps.insert(0, ('release', '--by', record['hcom_name']))
    for step in steps:
        try:
            # The reaper waits up to 30 seconds for its lock, then 10 for SIGTERM to work.
            result = subprocess.run(reap_command(*step), text=True, capture_output=True,
                                    timeout=REAP_TIMEOUT_SECONDS)
        except (OSError, subprocess.TimeoutExpired) as error:
            print(f'服務回收未完成：{error}')
            return
        if result.returncode:
            lines = (result.stderr.strip() or result.stdout.strip()).splitlines()
            print(f'服務回收未完成：{lines[-1] if lines else f"exit {result.returncode}"}')
            return
        print(result.stdout, end='')


def pointer(path, record):
    # Claude compaction drops references; inline the two that dispatch and closing rely on.
    # Codex caps hook context near 2,500 tokens, so it keeps re-reading them itself.
    inline = record['client'] == 'claude'
    refs = ('skill_dir/references/agents.md, skill_dir/references/task-cards.md, '
            if not inline else '')
    text = (f'LAT recovery record: {path}\n'
            'Before any dependent action, read this record, then fully re-read '
            f'skill_dir/SKILL.md, {refs}progress_path, and all decision records '
            'in decisions_path. Resolve these paths from the record. Reconcile the progress '
            'index with the tracker; preserve the existing checklist. Verify prior human '
            'authorization and pending decisions before continuing. Missing or corrupt data: '
            'stop dependent work and report; never infer authorization or reset progress.')
    if inline:
        text += ('\nThe full current text of references/agents.md and '
                 'references/task-cards.md follows; it counts as re-reading them.')
        for name in INLINE_REFERENCES:
            reference = Path(record['skill_dir']) / name
            body = reference.read_text(encoding='utf-8')
            text += f'\n\n===== {reference} =====\n{body}'
    return text


def release_own_wait(workspace, name):
    """End the controller's own wait so a later activation does not report it as expired."""
    path = shared_lat_dir(workspace) / 'watch/waits' / f'{name}.json'
    if not path.parent.is_dir():
        return
    # Same lock file lat-watch uses for this declaration.
    with (path.parent / f'.{path.stem}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        original = current_bytes(path)
        if original is None:
            return
        declaration = json.loads(original)
        if not isinstance(declaration, dict) or not (
                declaration.get('active', True) or declaration.get('expiry_nudge_pending')
                or declaration.get('expiry_notice')):
            return
        # Also drop an expiry nudge or notice still queued for delivery, as a normal release does.
        declaration.pop('expiry_notice', None)
        declaration.update(active=False, released_reason='deactivated',
                           released_at_utc=datetime.now(timezone.utc).isoformat(),
                           expiry_count=0, expiry_declared_at=[], expiry_notified=False,
                           expiry_nudge_pending=False)
        write_json_atomic(path, declaration, expected=original)


def remove_empty_questions(panel, workspace, record):
    """Delete this controller's `.lat/questions/` file once cleanup leaves no question in it.

    The root `.lat` file of older bindings is never touched. Never raises: ending the round
    matters more than tidying the file.
    """
    try:
        path = panel.new_questions_path(workspace, record['hcom_name'])
        if panel_module('questions').remove_empty_questions(path, record['decisions_path']):
            print(f'已刪除空問題檔：{path}')
    except (OSError, ValueError, KeyError) as error:
        print(f'問題檔未收尾：{error}')


def deactivate(args):
    if args.successor and not HCOM_NAME.fullmatch(args.successor):
        raise ValueError('Invalid successor HCOM name; record unchanged')
    args.reason = (args.reason or '').strip()
    if args.force_unfinished and not args.reason:
        raise ValueError('--force-unfinished needs a non-empty --reason; record unchanged')
    if args.reason and not args.force_unfinished:
        raise ValueError('--reason only goes with --force-unfinished; record unchanged')
    workspace = args.workspace.resolve(strict=True)
    sid = session_id(args.session_id or os.environ.get(SESSION_ENV[args.client]))
    path = session_path(workspace, sid)
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
        forced = None
        if record['status'] == 'active' and record.get('ledger_path'):
            forced = ledger_gate(record, args)
        _stop_watcher_locked(record)
        if record.get('hcom_name'):
            release_own_wait(workspace, record['hcom_name'])
        panel = panel_module()
        try:
            panel.clear_status_display(panel.resolve_session_binding(sid))
        except (OSError, ValueError, KeyError):
            pass
        removed = panel.unbind_controller(sid)
        if record.get('hcom_name'):
            remove_empty_questions(panel, workspace, record)
        if record['status'] == 'active' and not legacy_record(record):
            record['final_report_pending'] = True
        if record['status'] not in ENDED:
            record['ended_at_utc'] = datetime.now(timezone.utc).isoformat()
        record['status'] = 'ended'
        if args.successor:
            record['successor'] = args.successor
        if forced:
            # A readable ledger keeps the reason in its history; the copy here feeds the final report.
            record.update(force_unfinished_reason=forced['reason'],
                          force_unfinished_saved_in=forced['saved_in'],
                          force_unfinished_check=forced['check'])
        write_json_atomic(path, record, expected=original)
    print(path)
    print(json.dumps({'removed': removed}))
    if forced:
        print(f'已強制停用，未結案原因寫入{"工作總表歷史" if forced["saved_in"] == "ledger" else "session 紀錄"}：'
              f'{forced["reason"]}')
    reap_on_deactivate(record)
    start_autoclean(workspace)


def duty_path(sid):
    return reports_directory() / f'{sid}.duty.json'


def duty_command(record):
    return shlex.join([
        'uv', 'run', '--no-project', 'python', str(Path(__file__).resolve()), 'duty',
        '--client', record['client'], '--workspace', record['workspace'],
        '--text', f'<{DUTY_LIMIT} 字以內：這個主控負責做什麼>',
        '--expected', '<做完後使用者會看到什麼>',
    ])


def record_duty(args):
    """Write or replace this controller's duty, which the board shows on its card."""
    text, expected = args.text.strip(), args.expected.strip()
    if not text or not expected:
        raise ValueError('--text and --expected must not be empty; duty unchanged')
    if '\n' in text or len(text) > DUTY_LIMIT:
        raise ValueError(f'--text must be one line of at most {DUTY_LIMIT} characters '
                         f'(got {len(text)}); duty unchanged')
    workspace = args.workspace.resolve(strict=True)
    sid = session_id(os.environ.get(SESSION_ENV[args.client]))
    try:
        record = read_json(workspace / '.lat/sessions' / f'{sid}.json')
    except FileNotFoundError:
        record = {}
    expected_identity = dict(client=args.client, session_id=sid, role='orchestrator',
                             workspace=str(workspace), status='active')
    if any(record.get(key) != value for key, value in expected_identity.items()):
        raise ValueError('No active controller record for this session; duty unchanged')
    path = duty_path(sid)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # The report lock: the board's pruning deletes this file with the report file under it.
    with (path.parent / f'{sid}.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        write_json_atomic(path, dict(
            text=text, expected=expected,
            time=datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')))
    print(path)


def duty_reminder(decisions, question_id):
    """One line on the current duty for a confirmation question, or None unless the caller is
    an active controller. Never raises."""
    try:
        text = (Path(decisions) / f'{question_id}.md').read_text(encoding='utf-8')
        advisor = next((line.split(':', 1)[1].lower().split() for line in text.splitlines()
                        if re.match(r'^- advisor:', line, re.IGNORECASE)), [])
        if advisor[:2] not in (['exempt', 'ticket-confirmation'], ['exempt', 'spec-confirmation']):
            return None
        workspace = Path(decisions).resolve().parent.parent
        for client, variable in SESSION_ENV.items():
            value = os.environ.get(variable)
            if not value:
                continue
            try:
                record = read_json(Path(decisions).parent / 'sessions'
                                   / f'{session_id(value)}.json')
            except (OSError, ValueError):
                continue
            if (Path(str(record.get('workspace'))).resolve() == workspace and all(
                    record.get(key) == expected for key, expected in dict(
                        client=client, session_id=value, role='orchestrator',
                        status='active').items())):
                break
        else:
            return None
        try:
            duty = read_json(duty_path(record['session_id'])).get('text')
        except (OSError, ValueError):
            duty = None
        duty = ' '.join(duty.split()) if isinstance(duty, str) else None
        current = f'目前職責：{duty}' if duty else '目前沒有職責紀錄'
        return (f'{current}。任務改變就覆蓋職責，寫一句涵蓋本輪所有任務：'
                f'{duty_command(record)}')
    except Exception:
        return None


def missing_duty(record, message):
    """Why this DECIDE/HELP/DONE Stop should be held for a duty not on record, or None."""
    lines = [line for line in message.splitlines() if line.strip()]
    if legacy_record(record) or not lines or not lines[-1].startswith(DUTY_TAGS):
        return None
    path = duty_path(record['session_id'])
    # A reports location that is not a directory cannot hold a duty either; the report write warns.
    if path.is_file() or (path.parent.exists() and not path.parent.is_dir()):
        return None
    return ('LAT 職責檢查未通過：看板上還沒有這個主控的職責。先執行 '
            f'`{duty_command(record)}`，再照原樣結束回合。任務改變時用同一指令覆蓋。')


def context(text, event='SessionStart'):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': event,
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
    for event in HOOK_EVENTS:
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
            # Install may have added the event; leave no empty list behind for it.
            if owned and not groups:
                del events[event]
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
    write_json_atomic(path, updated, expected=original)
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


def tag_line_questions(message):
    """`(ID, N)` for each `<ID> r<N>` after the last line's DECIDE/HELP tag, in order, once each."""
    last = [line for line in message.splitlines() if line.strip()][-1]
    return list(dict.fromkeys(re.findall(
        r'(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)[ \t]+r([0-9]+)(?![A-Za-z0-9_])',
        last.split(':', 1)[1])))


def tag_line_identifiers(message):
    """`<ID> r<N>` written after the last line's DECIDE/HELP tag."""
    return set(tag_line_questions(message))


def question_identifiers(message):
    """`❓ **<ID> r<N>**` headings plus `<ID> r<N>` on the last line's tag."""
    return set(QUESTION_HEADING.findall(message)) | tag_line_identifiers(message)


def listed_questions(message):
    """The questions a DECIDE/HELP asks, in order: the tag line's, else the `❓` headings'."""
    return tag_line_questions(message) or list(dict.fromkeys(QUESTION_HEADING.findall(message)))


def own_questions_path(panel, record):
    """This controller's bound question file, or None when its session has no panel binding."""
    binding = next((item for item in panel.list_bindings()
                    if item.get('session_id') == record['session_id']), None)
    if binding is None:
        return None
    if binding.get('client') != record['client'] or binding.get('workspace') != record['workspace']:
        raise ValueError('面板綁定與主控紀錄不符')
    return Path(binding['questions_path'])


def read_questions(path):
    return panel_module('questions').parse_questions(
        path.read_text(encoding='utf-8')) if path.exists() else []


def waiting_question(questions, identifier, revision):
    return next((question for question in questions
                 if question['id'] == identifier and question['status_label'] == '待答'
                 and question['revision'] == int(revision)), None)


def question_delivery(record, message):
    """`(text, warning)`: the listed questions as plain text from the bound question file.

    Unbound sessions get nothing. Delivery never changes the check result, so any
    failure only becomes a one-line warning.
    """
    try:
        panel = panel_module()
        path = own_questions_path(panel, record)
        if path is None:
            return '', ''
        questions = read_questions(path)
        shown, missing = [], []
        for identifier, revision in listed_questions(message):
            question = waiting_question(questions, identifier, revision)
            if question is None:
                missing.append(f'{identifier} r{revision}')
            else:
                shown.append(panel_module('questions').question_plain_text(question))
    except Exception as exc:  # noqa: BLE001 - never let delivery break the Stop hook
        return '', f'LAT 題目代送失敗，請到面板查看題目：{exc}'
    warning = ('LAT 題目代送失敗：自己的問題檔沒有 ' + '、'.join(missing)
               + ' 的待答題目，請到面板查看。') if missing else ''
    return QUESTION_SEPARATOR.join(shown), warning


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


def stop_check(record, payload):
    """Why this DECIDE/HELP Stop should be held, or None when it passes."""
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
    questions_path = own_questions_path(panel, record)
    if questions_path is not None:
        questions = read_questions(questions_path)
        for identifier, revision in sorted(identifiers):
            if waiting_question(questions, identifier, revision) is None:
                problems.append(f'{identifier} r{revision}：自己的面板缺少同版本待答題目')
        _, missing, inconsistent, unreadable, reverse = panel_module('questions').pending_question_gaps(
            questions_path, decisions, session_id=record['session_id'])
        problems.extend(f'{identifier}：遺漏檢查缺少面板題目' for identifier in missing)
        problems.extend(f'{identifier}：遺漏檢查不一致（{reason}）'
                        for identifier, reason, _ in inconsistent)
        problems.extend(f'{identifier}：{reason}' for identifier, reason, _ in reverse)
        problems.extend(f'{path.name}：遺漏檢查讀不出狀態（{reason}）'
                        for path, reason in unreadable
                        if path.stem not in statuses or not statuses[path.stem].error)
    if not problems:
        # The tag line decides; headings count only when the tag line names no question.
        listed = set(listed_questions(message))
        if listed <= announced_questions(record):
            names = '、'.join(f'{identifier} r{revision}'
                              for identifier, revision in sorted(listed))
            return (
                f'LAT {tag} 檢查未通過：最後一行只列出 {names}，已在先前訊息以 DECIDE／HELP 問過，版本沒變。'
                '這則有新題或改版時，把它的題號寫進最後一行；沒有時改以 `NO REPLY: ` 開頭，'
                '題目仍待答，側欄會持續顯示。')
        return None
    return f'LAT {tag} 檢查未通過：' + '；'.join(problems) + (
        '。Spec 確認題先更新 Spec 共識 → 跑檢查工具 → 確認題寫明共識版本。補做順序：寫待決紀錄 → 諮詢參謀或註明例外 → 寫入面板（已綁定時） → 遺漏檢查 → 依聊天提問格式重新提問。')


def ledger_stop_check(record, message):
    """Why a DONE Stop should be held for an unfinished ledger, or None."""
    lines = [line for line in message.splitlines() if line.strip()]
    if not record.get('ledger_path') or not lines or not lines[-1].startswith('DONE:'):
        return None
    state, text = ledger_check(record['ledger_path'])
    if state == 'ok':
        return None
    if state == 'fail':
        return ('LAT 交付檢查未通過：工作總表還有未結案或缺證據的工作項。\n' + text
                + '\n補做（結案並附證據，或由主控取消並寫原因）後再照原樣結束回合。')
    repair = ledger_repair(record['ledger_path'])
    fix = f'先執行 `{repair}` 修復' if repair else '總表與流水帳都無法修復，向使用者回報'
    return f'LAT 交付檢查未通過：工作總表無法讀取（{text}）。{fix}，再照原樣結束回合。'


def reports_path(record):
    return reports_directory() / f'{record["session_id"]}.jsonl'


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
    if final and record.get('force_unfinished_reason'):
        report.update({key: record.get(key) for key in (
            'force_unfinished_reason', 'force_unfinished_saved_in', 'force_unfinished_check')})
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
    message = payload['last_assistant_message']
    if record['status'] == 'active':
        tag = question_tag(message)
        reasons, notes = [], []
        try:
            duty = missing_duty(record, message)
        except (OSError, ValueError) as exc:
            notes.append(f'LAT 職責檢查發生錯誤，未攔下：{exc}')
        else:
            if duty:
                reasons.append(duty)
        ledger = ledger_stop_check(record, message)
        if ledger:
            reasons.append(ledger)
        if tag:
            try:
                reason = stop_check(record, payload)
            except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
                notes.append(f'LAT {tag} 檢查發生錯誤，未攔下：{exc}')
            else:
                if reason:
                    reasons.append(reason)
        # Hold only the first Stop of a turn; later ones pass with a visible warning.
        if reasons and not payload.get('stop_hook_active'):
            print(json.dumps({'decision': 'block', 'reason': '\n\n'.join(reasons)},
                             ensure_ascii=False))
            return
        notes += [reason + ' 本回合已繼續過，不再攔下。' for reason in reasons]
        # A passing or released DECIDE/HELP shows its questions after the message.
        shown, warning = question_delivery(record, message) if tag else ('', '')
        text = '\n\n'.join(part for part in (shown, warning, *notes) if part)
        if text:
            print(json.dumps({'systemMessage': text}, ensure_ascii=False))
    try:
        append_report(record, message)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        print(f'LAT report warning: {exc}', file=sys.stderr)


CLAUDE_LAT_COMMAND = '<command-name>/lat</command-name>'
CODEX_LAT_NAME = '<name>lat</name>'
CODEX_LAT_SKILL = re.compile(r'\s*<skill>\s*' + re.escape(CODEX_LAT_NAME))
# Raw-line prefilter: every line invoked_lat can accept contains one of these.
SCAN_RETENTION = 30 * 86400
SCAN_CLEANUP_INTERVAL = 86400
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


def activation_directory():
    state = os.environ.get('XDG_STATE_HOME')
    base = Path(state) if state and Path(state).is_absolute() else Path.home() / '.local/state'
    return base / 'lat/activation'


def load_scan(path, transcript, status):
    """Where the last Stop stopped reading this transcript (`status`: its open file): `(offset, format confirmed)`."""
    try:
        saved = json.loads(path.read_text(encoding='utf-8'))
        offset = saved['offset']
        if (saved['path'] == str(transcript) and saved['inode'] == status.st_ino
                and type(offset) is int and 0 <= offset <= status.st_size
                and isinstance(saved['records'], bool)):
            return offset, saved['records']
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return 0, False


def save_scan(path, transcript, inode, offset, records):
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # At most once a day, drop positions of sessions that went quiet (the report retention).
    marker = directory / '.cleanup'
    now = time.time()
    if not marker.exists() or now - marker.stat().st_mtime >= SCAN_CLEANUP_INTERVAL:
        for stale in directory.glob('*.json'):
            if now - stale.stat().st_mtime >= SCAN_RETENTION:
                stale.unlink(missing_ok=True)
        marker.touch()
        os.utime(marker, (now, now))
    write_json_atomic(path, dict(path=str(transcript), inode=inode, offset=offset,
                                 records=records), mode=0o600)


def lat_transcript(client, payload, sid):
    """Read the conversation's transcript; True when it shows the LAT skill was called up.

    Reads resume where the previous Stop for this session stopped, unless the file was
    replaced or shortened; a half-written last line is read again once it is complete.
    """
    path = payload.get('transcript_path')
    if path is None:
        path = panel_module('transcript').transcript_path(client, sid)
    elif not isinstance(path, str) or not Path(path).is_absolute():
        raise ValueError(f'transcript_path is not an absolute path: {path!r}')
    scan = activation_directory() / f'{client}-{sid}.json'
    # Transcripts can be large: parse lines until one confirms the format, then only marker lines.
    markers = LAT_MARKERS[client]
    with open(path, 'rb') as stream:
        status = os.fstat(stream.fileno())
        inode = status.st_ino
        offset, records = load_scan(scan, path, status)
        stream.seek(offset)
        for raw in stream:
            line = raw.decode('utf-8')
            if raw.endswith(b'\n'):
                offset += len(raw)
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
    try:
        save_scan(scan, path, inode, offset, records)
    except (OSError, ValueError) as exc:
        print(f'LAT activation check warning: {exc}', file=sys.stderr)
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


def waiting_questions(record):
    """`(ID, revision, title, asked at)` of this controller's waiting questions with a pending record."""
    panel = panel_module()
    path = panel.controller_questions_path(record['workspace'], record['hcom_name'])
    decisions = Path(record['decisions_path'])
    waiting = []
    for question in panel_module('board').board_questions(path):
        # A submitted answer waits for the controller to record it, not for the user.
        if question['status'] != 'pending':
            continue
        decision = decisions / f'{question["id"]}.md'
        if not decision.is_file():
            continue
        status = read_decision_status(decision)
        if status.error is None and status.status == 'pending':
            waiting.append((question['id'], question['revision'], question['title'],
                            question['asked_at']))
    return waiting


def local_time(value):
    try:
        return datetime.fromisoformat(value).astimezone().strftime('%Y-%m-%d %H:%M')
    except (TypeError, ValueError):
        return '不明'


def prompt_reminder(record, payload):
    """List the controller's waiting questions when the user sends a new message."""
    prompt = payload.get('prompt')
    if not isinstance(prompt, str) or HCOM_PROMPT.fullmatch(prompt) or legacy_record(record):
        return
    waiting = waiting_questions(record)
    if not waiting:
        return
    lines = [f'LAT 待答提醒：你還有 {len(waiting)} 題待答。']
    lines += [f'- {identifier} r{revision}「{title}」，提問時間 {local_time(asked)}'
              for identifier, revision, title, asked in waiting]
    lines.append('對照使用者這則訊息，判斷各題是否已過時而要撤回（question withdraw），'
                 '或前提改變而要改版；仍適用就繼續等答覆。撤回用法見 '
                 f'{Path(record["skill_dir"]) / "references/question-panel.md"}「撤回過時題目」。')
    context('\n'.join(lines), 'UserPromptSubmit')


def warn_reminder(exc):
    print(json.dumps({'systemMessage': f'LAT 待答提醒發生錯誤，未提醒：{exc}'},
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
        elif event == 'SessionStart':
            if payload.get('source') not in ('compact', 'resume'):
                return
        elif event != 'UserPromptSubmit':
            return
        sid = session_id(payload.get('session_id'))
        cwd = Path(payload['cwd'])
        if not cwd.is_absolute():
            return
        root = workspace_root(cwd.resolve(strict=True))
        path = session_path(root, sid)
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
        if event == 'UserPromptSubmit':
            if all(record.get(key) == value for key, value in expected.items()):
                try:
                    prompt_reminder(record, payload)
                except Exception as exc:  # noqa: BLE001 - never block the user's message
                    warn_reminder(exc)
            return
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
            context(f'{pointer(path, record)}\n'
                    f'Legacy session upgrade: {legacy_upgrade_command(record)}')
            return
        dependencies(record)
        if ensure_watcher(record, path, rebind=True) is None:
            return
        context(ledger_context(record, pointer(path, record)))
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        if event == 'UserPromptSubmit':
            warn_reminder(exc)
            return
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
    stop.add_argument('--force-unfinished', action='store_true',
                      help='End even though the work ledger check fails; needs --reason')
    stop.add_argument('--reason', help='Why unfinished work is left; kept in the ledger history')
    duty = sub.add_parser('duty', help="Record this controller's duty for the board")
    duty.add_argument('--workspace', type=Path, required=True)
    duty.add_argument('--text', required=True, help=f'What it is responsible for, <= {DUTY_LIMIT} chars')
    duty.add_argument('--expected', required=True, help='What the user will see when it is done')
    sub.add_parser('hook', help='Read SessionStart, Stop or UserPromptSubmit payload on stdin')
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
        elif args.action == 'duty':
            record_duty(args)
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
