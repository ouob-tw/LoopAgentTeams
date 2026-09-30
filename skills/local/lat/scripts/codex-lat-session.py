#!/usr/bin/env python3
"""Codex LAT controller records and SessionStart recovery (stdlib only)."""
import argparse
import copy
import difflib
import json
import os
from pathlib import Path
import re
import shlex
import sys
import tempfile

SKILL_DIR = Path(__file__).resolve().parents[1]
GROUP_NAME = 'lat-codex-recovery'


def session_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError('A valid CODEX_THREAD_ID is required; do not infer a session ID')
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


def dependencies(record):
    skill = Path(record['skill_dir'])
    files = [skill / 'SKILL.md', skill / 'references/agents.md',
             skill / 'references/task-cards.md', Path(record['progress_path'])]
    decisions = Path(record['decisions_path'])
    for path in [*files, decisions]:
        if not path.is_absolute():
            raise ValueError('Recovery paths must be absolute')
    for path in files:
        if not path.is_file():
            raise ValueError(f'Missing recovery file: {path}')
    if not decisions.is_dir():
        raise ValueError(f'Missing decisions directory: {decisions}')


def activate(args):
    workspace = args.workspace.resolve(strict=True)
    if workspace_root(workspace) != workspace:
        raise ValueError('--workspace must be the Git worktree root')
    sid = session_id(os.environ.get('CODEX_THREAD_ID'))
    record = dict(client='codex', session_id=sid, role='orchestrator',
                  workspace=str(workspace), status='active', skill_dir=str(SKILL_DIR),
                  progress_path=str(args.progress.resolve(strict=True)),
                  decisions_path=str(args.decisions.resolve(strict=True)))
    dependencies(record)
    path = workspace / '.lat/sessions' / f'{sid}.json'
    original = current_bytes(path)
    if path.exists() and read_json(path) != record:
        raise ValueError('Existing session record differs; do not reset or rebind it')
    write_json(path, record, original)
    print(path)


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
    sid = session_id(args.session_id or os.environ.get('CODEX_THREAD_ID'))
    path = workspace / '.lat/sessions' / f'{sid}.json'
    original = current_bytes(path)
    record = read_json(path)
    expected = dict(client='codex', session_id=sid, role='orchestrator',
                    workspace=str(workspace))
    if any(record.get(key) != value for key, value in expected.items()):
        raise ValueError('Controller identity does not match; record unchanged')
    record['status'] = args.status
    write_json(path, record, original)
    print(path)


def context(text):
    print(json.dumps({'hookSpecificOutput': {'hookEventName': 'SessionStart',
                                            'additionalContext': text}}))


def configure(args):
    path = args.codex_home.expanduser().resolve() / 'hooks.json'
    original = current_bytes(path)
    config = json.loads(original) if original is not None else {}
    if not isinstance(config, dict) or not isinstance(config.get('hooks', {}), dict):
        raise ValueError('Expected hooks.json object with a hooks object')
    updated = copy.deepcopy(config)
    events = updated.setdefault('hooks', {})
    groups = events.setdefault('SessionStart', [])
    if not isinstance(groups, list) or any(not isinstance(g, dict) for g in groups):
        raise ValueError('Expected SessionStart matcher groups')
    owned = [g for g in groups if g.get('name') == GROUP_NAME]
    if args.action == 'install':
        command = shlex.join(['uv', 'run', '--no-project', 'python',
                              str(SKILL_DIR / 'scripts/codex-lat-session.py'), 'hook'])
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
            if len(lat_handlers) > 1:
                raise ValueError('LAT group ownership is ambiguous; inspect hooks.json')
            if lat_handlers:
                lat_handlers[0].update(handler)
            else:
                handlers.append(handler)
            group['matcher'] = '^(compact|resume)$'
        else:
            groups.append(dict(name=GROUP_NAME, matcher='^(compact|resume)$', hooks=[handler]))
    else:
        for group in owned:
            handlers = group.get('hooks')
            if not isinstance(handlers, list):
                raise ValueError('Invalid LAT command group')
            group['hooks'] = [h for h in handlers if not is_lat_command(h)]
            if not group['hooks'] and set(group) <= {'name', 'matcher', 'hooks'}:
                groups.remove(group)
        if not owned:
            updated = config
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
        with tempfile.NamedTemporaryFile(prefix='hooks.json.lat-backup-', dir=path.parent,
                                         delete=False) as backup:
            backup.write(original)
            print(f'Backup: {backup.name}')
    write_json(path, updated, original)
    print(f'Updated {path}; review changed hooks through Codex /hooks before use')


def is_lat_command(handler):
    if not isinstance(handler, dict) or handler.get('type') != 'command':
        return False
    try:
        command = shlex.split(handler.get('command', ''))
        return (len(command) == 6 and command[:4] == ['uv', 'run', '--no-project', 'python']
                and Path(command[4]).name == 'codex-lat-session.py' and command[5] == 'hook')
    except (ValueError, TypeError):
        return False


def hook():
    # Hook payload IDs are authoritative: the hook process has no CODEX_THREAD_ID.
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or payload.get('hook_event_name') != 'SessionStart':
            return
        if payload.get('source') not in ('compact', 'resume'):
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
        expected = dict(client='codex', session_id=sid, role='orchestrator',
                        workspace=str(root), status='active')
        # Reject known mismatches before checking broken dependencies.
        if any(key in record and record[key] != value for key, value in expected.items()):
            return
        if any(key not in record for key in expected):
            raise ValueError('Incomplete controller identity')
        dependencies(record)
        context(pointer(path))
    except (OSError, ValueError, TypeError, KeyError):
        context(f'LAT recovery error: {path}. Record or recovery files are missing/corrupt. '
                'Stop dependent work and report; do not infer authorization or recreate progress.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    start = sub.add_parser('activate', help='Activate only the current Codex LAT controller')
    start.add_argument('--workspace', type=Path, required=True)
    start.add_argument('--progress', type=Path, required=True)
    start.add_argument('--decisions', type=Path, required=True)
    stop = sub.add_parser('deactivate', help='Complete/cancel a controller, retaining its record')
    stop.add_argument('--workspace', type=Path, required=True)
    stop.add_argument('--status', choices=('completed', 'cancelled'), required=True)
    stop.add_argument('--session-id', help='Explicit ID for manual stale-record deactivation')
    sub.add_parser('hook', help='Read SessionStart payload on stdin')
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action.title()} the independent LAT hook group')
        config.add_argument('--codex-home', type=Path,
                            default=Path(os.environ.get('CODEX_HOME', '~/.codex')))
        config.add_argument('--preview', action='store_true', help='Show diff without writing')
    args = parser.parse_args()
    try:
        if args.action == 'activate':
            activate(args)
        elif args.action == 'deactivate':
            deactivate(args)
        elif args.action == 'hook':
            hook()
        else:
            configure(args)
    except (OSError, ValueError, TypeError, KeyError) as exc:
        print(f'LAT error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
