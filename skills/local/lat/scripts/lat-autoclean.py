#!/usr/bin/env python3
"""Automatic 40-day .lat cleanup: off until the one-off cleanup enables it (stdlib only).

Controllers trigger it on activate and deactivate; it runs in the background at most once
per 24 hours per workspace and logs every deletion and skip to `.lat/cleanup.log`.
"""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_cleanup import (ENDED, Protection, deletion_method, delete, issue_texts,
                          lat_directories, session_records, tracker_issues, usage)
from _lat_common import shared_lat_dir, write_json_atomic

MARKER = 'autoclean-enabled.json'
LOG = 'cleanup.log'
# Guards a run; named after the log so the cleanup command never sees it as an orphan lock.
LOCK = '.cleanup.log.lock'
LAST_RUN = 'cleanup.last-run'
AGE = timedelta(days=40)
INTERVAL = timedelta(hours=24)
TICKET = re.compile(r'issue-(?P<number>[0-9]+)')
SESSION_FILE = re.compile(r'(?P<sid>[A-Za-z0-9_-]{1,128})\.(?:log|lock)')
TICKET_FOLDER, WATCH_LEFTOVER, DONE_CARD, WAIT = '票資料夾', '監控殘留', '已完成任務卡', '等待紀錄'


def _time(value):
    try:
        moment = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    except ValueError:
        return None
    return moment if moment.tzinfo else None


def _modified(path):
    return datetime.fromtimestamp(Path(path).lstat().st_mtime, timezone.utc)


class Log:
    """Appends tab-separated lines: time, category, path, size, method or why it was skipped."""

    def __init__(self, lat, dry_run=False):
        self.lat, self.dry_run = lat, dry_run

    def write(self, category, outcome, path=None, size=None):
        where = '-' if path is None else os.path.relpath(path, self.lat)
        line = '\t'.join([datetime.now(timezone.utc).isoformat(timespec='seconds'), category,
                          where, '-' if size is None else str(size), outcome])
        if self.dry_run:
            print(line)
            return
        # Non-blocking, so a log that is a FIFO without a reader fails instead of hanging.
        descriptor = os.open(self.lat / LOG, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NONBLOCK,
                             0o600)
        with os.fdopen(descriptor, 'a', encoding='utf-8') as stream:
            stream.write(line + '\n')


def enabled(lat):
    return (Path(lat) / MARKER).is_file()


def _marker_repo(lat):
    try:
        return json.loads((Path(lat) / MARKER).read_text(encoding='utf-8')).get('repo')
    except (OSError, ValueError, AttributeError):
        return None


def ticket_folders(lat, issues, now):
    """`runs/issue-<N>/` whose ticket is closed and was last closed 40 days ago, as
    (path, None), and the rest as (path, why kept). Only the tracker decides, never file times."""
    closed = {issue['number']: issue for issue in issues}
    for path in sorted((lat / 'runs').glob('issue-*')):
        match = TICKET.fullmatch(path.name)
        if not match or not path.is_dir() or path.is_symlink():
            continue
        issue = closed.get(int(match.group('number')))
        if issue is None:
            yield path, 'tracker 查不到這張票'
        elif issue.get('state') != 'CLOSED':
            yield path, '票仍開啟或已重開'
        elif (_time(issue.get('closedAt')) or now) > now - AGE:
            yield path, f'關閉未滿 40 天（{issue.get("closedAt") or "無關閉時間"}）'
        else:
            yield path, None


def watch_leftovers(lat, records, now):
    """Watch files of ended sessions whose recorded end is 40 days old, as (path, why kept)."""
    by_session, by_name = {}, {}
    for _, record in records:
        by_session.setdefault(record.get('session_id'), []).append(record)
        by_name.setdefault(record.get('hcom_name'), []).append(record)

    def ended_before(group):
        """None when every record ended with a recorded time 40 days ago, else why kept."""
        if not group:
            return '沒有 session 紀錄'
        if any(record.get('status') not in ENDED for record in group):
            return '仍有 active session'
        ends = [_time(record.get('ended_at_utc')) for record in group]
        if None in ends:
            return '無結束時間'
        latest = max(ends)
        return None if latest <= now - AGE else f'結束未滿 40 天（{latest.isoformat()}）'

    watch = lat / 'watch'
    for path in sorted(watch.iterdir()) if watch.is_dir() else []:
        if path.is_symlink():
            continue
        if path.is_dir():
            if path.name != 'waits':
                yield path, ended_before(by_name.get(path.name, []))
            continue
        match = SESSION_FILE.fullmatch(path.name)
        if match:
            yield path, ended_before(by_session.get(match.group('sid'), []))


def _untouched(paths, now):
    """Files among `paths` as (path, None) when last modified 40 days ago, else (path, why kept)."""
    for path in paths:
        if path.is_file() and not path.is_symlink():
            modified = _modified(path)
            yield path, None if modified <= now - AGE else (
                f'未滿 40 天（{modified.isoformat(timespec="seconds")}）')


def done_cards(lat, now):
    return _untouched(sorted((lat / 'tasks/done').glob('*.md')), now)


def waits(lat, now):
    """Wait declarations, then their locks; a lock goes only after its declaration."""
    folder = lat / 'watch/waits'
    return _untouched([*sorted(folder.glob('*.json')), *sorted(folder.glob('.*.lock'))], now)


def _remove(log, protection, category, candidates, *, dry_run):
    """`protection` returns a fresh Protection: a controller may activate during an earlier
    deletion, so the hard limits are read again before each one."""
    going = set()
    for path, kept in candidates:
        if kept:
            log.write(category, f'跳過：{kept}', path)
            continue
        reason = protection().reason(path, going=frozenset(going))
        if reason:
            log.write(category, f'跳過：{reason}', path)
            continue
        size, _ = usage(path)
        method = deletion_method(path)
        if dry_run:
            log.write(category, f'將以 {method} 刪除', path, size)
            going.add(Path(os.path.realpath(path)))
            continue
        try:
            delete(path, method)
        except (OSError, ValueError) as error:
            log.write(category, f'失敗：{error}', path, size)
            continue
        going.add(Path(os.path.realpath(path)))
        log.write(category, method, path, size)


def clean(lat, repo, log, *, dry_run=False):
    """One pass over the four categories, from fresh session records and tracker state."""
    now = datetime.now(timezone.utc)
    issues, texts, error = None, None, None
    if not repo:
        error = '未設定 tracker repo'
    else:
        try:
            issues = tracker_issues(repo, ('number', 'state', 'closedAt', 'body', 'comments'))
            texts = issue_texts(issues)
        except ValueError as failure:
            issues, error = None, str(failure)

    def protection():
        return Protection(lat, issues=texts, tracker_error=error)

    if issues is None:
        log.write(TICKET_FOLDER, f'跳過整類：{error}')
    else:
        _remove(log, protection, TICKET_FOLDER, ticket_folders(lat, issues, now), dry_run=dry_run)
    records, _ = session_records(lat_directories(lat))
    _remove(log, protection, WATCH_LEFTOVER, watch_leftovers(lat, records, now), dry_run=dry_run)
    _remove(log, protection, DONE_CARD, done_cards(lat, now), dry_run=dry_run)
    _remove(log, protection, WAIT, waits(lat, now), dry_run=dry_run)


def run(lat, repo=None):
    """The background pass: refuses when off, already running or run within 24 hours."""
    log = Log(lat)
    if not enabled(lat):
        log.write('自動清理', '未開啟')
        return
    with (lat / LOCK).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            log.write('自動清理', '跳過：另一次清理執行中')
            return
        stamp = lat / LAST_RUN
        last = _time(stamp.read_text(encoding='utf-8').strip()) if stamp.is_file() else None
        now = datetime.now(timezone.utc)
        if last and now - last < INTERVAL:
            log.write('自動清理', f'跳過：24 小時內已執行（{last.isoformat(timespec="seconds")}）')
            return
        stamp.write_text(now.isoformat(timespec='seconds') + '\n', encoding='utf-8')
        log.write('自動清理', '開始')
        try:
            clean(lat, repo or _marker_repo(lat), log)
        except Exception as error:  # noqa: BLE001 - the log is all anyone sees of a background run
            log.write('自動清理', f'失敗：{error!r}')
            raise
        log.write('自動清理', '結束')


def trigger(workspace):
    """Called by activate and deactivate; never raises and never waits for the cleanup.

    While off it only logs that; otherwise it starts `run` in its own session and returns
    that process.
    """
    try:
        lat = Path(os.path.realpath(shared_lat_dir(workspace)))
        if not enabled(lat):
            Log(lat).write('自動清理', '未開啟')
            return
        return subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run',
                                 '--workspace', str(workspace)],
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
    except (OSError, ValueError) as error:
        print(f'自動清理未啟動：{error}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    once = sub.add_parser('run', help='Run one pass now (activate/deactivate start this)')
    once.add_argument('--workspace', type=Path, required=True)
    once.add_argument('--repo', help='Tracker repository, OWNER/NAME; defaults to the marker')
    once.add_argument('--dry-run', action='store_true',
                      help='Print what one pass would delete; works while off, changes nothing')
    turn_on = sub.add_parser('enable', help='Write the marker that turns automatic cleanup on')
    turn_on.add_argument('--workspace', type=Path, required=True)
    turn_on.add_argument('--repo', required=True, help='Tracker repository, OWNER/NAME')
    args = parser.parse_args()
    try:
        lat = Path(os.path.realpath(shared_lat_dir(args.workspace.resolve(strict=True))))
        if args.action == 'enable':
            write_json_atomic(lat / MARKER, dict(
                enabled_at_utc=datetime.now(timezone.utc).isoformat(timespec='seconds'),
                repo=args.repo))
            print(f'自動清理已開啟：{lat / MARKER}')
        elif args.dry_run:
            clean(lat, args.repo or _marker_repo(lat), Log(lat, dry_run=True), dry_run=True)
        else:
            run(lat, args.repo)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f'LAT error: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
