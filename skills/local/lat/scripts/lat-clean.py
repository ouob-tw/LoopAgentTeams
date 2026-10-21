#!/usr/bin/env python3
"""List what the shared .lat can lose, then delete only a confirmed list (stdlib only)."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_cleanup import (ENDED, TICKET_DATA, Protection, delete, fingerprint, lock_targets,
                          sensitive_reason, session_records, ticket_numbers, ticket_states,
                          tracker_issues, usage, watcher_alive)
from _lat_common import shared_lat_dir, write_text_atomic

LIST_VERSION = 1
CATEGORIES = {
    'legacy-question': '根目錄舊問題檔',
    'empty-question': '空問題檔',
    'legacy-file': '舊版檔案',
    'orphan-lock': '孤立鎖檔',
    'controller-progress': '主控進度檔',
    'closed-ticket': '已關閉票的資料',
    'no-ticket': '無票號的舊資料',
    'misc-run': '研究或原型資料夾',
    'worktree-lat': 'worktree 內多出的 .lat',
    'watch-leftover': '監控殘留',
    'stale-wait': '等待紀錄',
    'prompt-backup': '輸入備份',
}
LEGACY_FILES = ('questions.md', 'demo-questions.md')
SESSION_FILE = re.compile(r'(?P<sid>[A-Za-z0-9_-]{1,128})\.(?:log|lock|pid)')


def _questions():
    directory = Path(__file__).resolve().parents[1] / 'herdr-panel'
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
    import questions
    return questions


def _sections(path):
    """Question sections of a file; an unreadable file counts as holding one."""
    try:
        return _questions().parse_questions(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return []
    except (OSError, UnicodeDecodeError):
        return [dict(status_label='?')]


def _has_open_question(path):
    return any(section['status_label'] != '已記錄' for section in _sections(path))


def _real(path):
    return Path(os.path.realpath(path))


def scan(protection):
    """Every candidate as (path, category, note), before the hard limits are applied."""
    lat = protection.lat
    records = [record for _, record in session_records(protection.lat_dirs)[0]]
    active = [record for record in records if record.get('status') not in ENDED]
    found = []

    def add(path, category, note=''):
        found.append((_real(path), category, note))

    for path in sorted(lat.glob('questions-*.md')):
        archive = path.name.endswith('-archive.md')
        main = path.with_name(path.name.removesuffix('-archive.md') + '.md') if archive else path
        if _has_open_question(main):
            continue
        if archive:
            add(path, 'legacy-question', '歸檔檔')
        else:
            add(path, 'legacy-question' if _sections(path) else 'empty-question')
    for name in LEGACY_FILES:
        if (lat / name).is_file():
            add(lat / name, 'legacy-file')
    for path in sorted((lat / 'questions').glob('*.md')):
        if not path.name.endswith('-archive.md') and not _sections(path):
            add(path, 'empty-question')

    progress = {}
    for record in records:
        if record.get('progress_path'):
            progress.setdefault(_real(record['progress_path']), record.get('hcom_name') or '?')
    for top in TICKET_DATA:
        directory = lat / top
        for path in sorted(directory.iterdir()) if directory.is_dir() else []:
            real = _real(path)
            numbers = [number for number in ticket_numbers(real, lat)
                       if protection.ticket_states is None or number in protection.ticket_states]
            if real in progress:
                add(path, 'controller-progress', f'主控 {progress[real]} 的進度檔')
            elif top == 'runs' and path.name.startswith('misc-'):
                add(path, 'misc-run')
            elif numbers:
                add(path, 'closed-ticket', '、'.join(f'#{number}' for number in numbers))
            else:
                add(path, 'no-ticket')

    for other in protection.lat_dirs[1:]:
        if protection.reason(other) is None:
            add(other, 'worktree-lat')
        else:
            for path in sorted(other.iterdir()):
                add(path, 'worktree-lat', f'{other} 的一部分')

    watch = lat / 'watch'
    sessions = {record.get('session_id'): record for record in records}
    active_sessions = {record.get('session_id') for record in active}
    active_names = {record.get('hcom_name') for record in active}
    for path in sorted(watch.iterdir()) if watch.is_dir() else []:
        match = SESSION_FILE.fullmatch(path.name)
        if path.is_dir() and not path.is_symlink():
            if path.name != 'waits' and path.name not in active_names:
                add(path, 'watch-leftover', f'主控 {path.name} 沒有 active session')
        elif path.name.startswith('prompt-') and path.name.endswith('.txt'):
            add(path, 'prompt-backup')
        elif match and match.group('sid') not in active_sessions:
            if path.suffix == '.pid' and watcher_alive(path):
                continue
            record = sessions.get(match.group('sid'))
            note = ('沒有 session 紀錄' if record is None else
                    f'結束於 {record["ended_at_utc"][:10]}' if record.get('ended_at_utc') else
                    '無結束時間')
            add(path, 'watch-leftover', note)
    for path in sorted((watch / 'waits').glob('*.json')):
        add(path, 'stale-wait', f'Agent {path.stem}')

    listed = {path for path, _, _ in found}
    locks = [*lat.glob('.*.lock'), *(lat / 'questions').glob('.*.lock'),
             *(watch / 'waits').glob('.*.lock')]
    for path in sorted(locks):
        targets = [_real(target) for target in lock_targets(path)]
        existing = [target for target in targets if target.exists()]
        if not existing:
            add(path, 'orphan-lock')
        elif all(target in listed for target in existing):
            add(path, 'orphan-lock', '目標檔也在清單中，目標刪除後才刪')
    return found


def _is_lock(path):
    return Path(path).name.endswith('.lock')


def candidates(protection):
    """(included, excluded): candidates passing the hard limits, and those refused with why."""
    included, excluded = [], []
    found = scan(protection)
    going = set()
    for path, category, note in sorted(found, key=lambda item: _is_lock(item[0])):
        reason = protection.reason(path, going=frozenset(going))
        if reason:
            excluded.append(dict(path=str(path), category=category, reason=reason))
        else:
            included.append((path, category, note))
            going.add(path)
    return included, excluded


def _linked(path, repo_root, issues):
    needle = os.path.relpath(path, repo_root)
    pattern = re.compile(r'(?<![A-Za-z0-9_-])' + re.escape(needle)
                         + r'(?![A-Za-z0-9_-]|\.[A-Za-z0-9])')
    return [dict(number=number, state=state) for number, state, text in issues
            if needle in text and pattern.search(text)]


def list_command(args):
    lat = _real(shared_lat_dir(args.workspace.resolve(strict=True)))
    try:
        issues = [(issue['number'], issue['state'],
                   '\n'.join([issue.get('body') or '',
                              *((comment.get('body') or '') for comment in issue.get('comments') or [])]))
                  for issue in tracker_issues(args.repo, ('number', 'state', 'body', 'comments'))]
        states, error = {number: state for number, state, _ in issues}, None
    except (ValueError, KeyError, TypeError, AttributeError) as failure:
        issues, states, error = None, None, str(failure)
    protection = Protection(lat, ticket_states=states, ticket_error=error)
    included, excluded = candidates(protection)
    items = []
    for index, (path, category, note) in enumerate(included, 1):
        size, modified = usage(path)
        reason = sensitive_reason(path, lat)
        items.append(dict(
            id=index, category=category, path=str(path), note=note, size=size,
            modified_utc=datetime.fromtimestamp(modified, timezone.utc).isoformat(timespec='seconds'),
            method='shred' if reason else 'trash', sensitive=reason,
            tickets=ticket_numbers(path, lat),
            linked=(dict(error=error) if issues is None
                    else dict(found=_linked(path, lat.parent, issues))),
            fingerprint=fingerprint(path),
        ))
    document = dict(version=LIST_VERSION, repo=args.repo, lat=str(lat),
                    created_at_utc=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                    items=items, excluded=excluded)
    written = write_text_atomic(args.output, json.dumps(document, indent=2, ensure_ascii=False) + '\n')
    print(f'清單檔：{args.output.resolve()}')
    print(f'清單雜湊：{hashlib.sha256(written).hexdigest()}')
    print(render_list(document, lat.parent))


def _size(value):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if value < 1024 or unit == 'GB':
            return f'{value} B' if unit == 'B' else f'{value:.1f} {unit}'
        value /= 1024


def _linked_text(linked):
    if 'error' in linked:
        return f'查詢失敗：{linked["error"]}'
    if not linked['found']:
        return '未查到'
    return '、'.join(f'#{item["number"]}（{"開啟" if item["state"] == "OPEN" else "關閉"}）'
                    for item in linked['found'])


def _cell(text):
    return str(text).replace('|', '\\|').replace('\n', ' ')


def render_list(document, repo_root):
    items = document['items']
    lines = [f'共 {len(items)} 項，合計 {_size(sum(item["size"] for item in items))}；'
             f'因硬限制或仍在使用而未列入 {len(document["excluded"])} 項（見清單檔 excluded）。',
             '',
             '| # | 類別 | 路徑 | 大小 | 最後修改 | 刪除方式 | 連到的票 | 說明 |',
             '|---|---|---|---|---|---|---|---|']
    for item in items:
        modified = datetime.fromisoformat(item['modified_utc']).astimezone()
        method = f'shred（{item["sensitive"]}）' if item['method'] == 'shred' else 'trash'
        lines.append('| ' + ' | '.join(_cell(value) for value in (
            item['id'], CATEGORIES[item['category']], os.path.relpath(item['path'], repo_root),
            _size(item['size']), modified.strftime('%Y-%m-%d %H:%M'), method,
            _linked_text(item['linked']), item['note'] or '')) + ' |')
    return '\n'.join(lines)


def _selection(text, items):
    if not text:
        return items
    wanted = set()
    for part in text.split(','):
        first, _, last = part.strip().partition('-')
        wanted.update(range(int(first), int(last or first) + 1))
    unknown = wanted - {item['id'] for item in items}
    if unknown:
        raise ValueError(f'--only names items not in the list: {sorted(unknown)}')
    return [item for item in items if item['id'] in wanted]


def execute_command(args):
    content = args.list.read_bytes()
    digest = args.hash.strip().lower().removeprefix('sha256:')
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError('清單雜湊不符，拒絕執行；請重新列出並交使用者確認')
    document = json.loads(content)
    lat = _real(shared_lat_dir(args.workspace.resolve(strict=True)))
    if document.get('version') != LIST_VERSION or document.get('lat') != str(lat):
        raise ValueError(f'清單不是這個工作區（{lat}）的清理清單，拒絕執行')
    items = _selection(args.only, document['items'])
    try:
        states, error = ticket_states(document['repo']), None
    except ValueError as failure:
        states, error = None, str(failure)
    results = {}
    for locks in (False, True):
        protection = Protection(lat, ticket_states=states, ticket_error=error)
        current = {str(path): category for path, category, _ in scan(protection)}
        for item in items:
            if _is_lock(item['path']) == locks:
                results[item['id']] = _execute_item(item, protection, current, lat)
    failed = 0
    print('| # | 路徑 | 結果 |')
    print('|---|---|---|')
    for item in items:
        result = results[item['id']]
        failed += result.startswith('失敗')
        print(f'| {item["id"]} | {_cell(os.path.relpath(item["path"], lat.parent))} | {_cell(result)} |')
    done = sum(result.startswith('已') for result in results.values())
    print(f'\n刪除 {done} 項，跳過 {len(items) - done - failed} 項，失敗 {failed} 項。')
    return 1 if failed else 0


def _execute_item(item, protection, current, lat):
    path = Path(item['path'])
    reason = protection.reason(path)
    if reason:
        return f'跳過：{reason}'
    if not os.path.lexists(path):
        return '跳過：已不存在'
    if fingerprint(path) != item['fingerprint']:
        return '跳過：列出後已被改動'
    if current.get(str(_real(path))) != item['category']:
        return '跳過：已不符合清單條件'
    method = 'shred' if item['method'] == 'shred' or sensitive_reason(path, lat) else 'trash'
    try:
        delete(path, method, lat)
    except (OSError, ValueError) as error:
        return f'失敗：{error}'
    return '已用 shred 銷毀' if method == 'shred' else '已用 trash 移到垃圾桶'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    listing = sub.add_parser('list', help='Write the list of removable items and print its hash')
    listing.add_argument('--workspace', type=Path, required=True)
    listing.add_argument('--repo', required=True, help='Tracker repository, OWNER/NAME')
    listing.add_argument('--output', type=Path, required=True, help='List file to write')
    run = sub.add_parser('execute', help='Delete the items of a confirmed list')
    run.add_argument('--workspace', type=Path, required=True)
    run.add_argument('--list', type=Path, required=True)
    run.add_argument('--hash', required=True, help='Hash printed by list')
    run.add_argument('--only', help='Item numbers the user agreed to, e.g. 1,3,5-7')
    args = parser.parse_args()
    try:
        if args.action == 'list':
            list_command(args)
            return 0
        return execute_command(args)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'LAT error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
