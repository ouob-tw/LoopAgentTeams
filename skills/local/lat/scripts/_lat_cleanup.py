"""Shared .lat cleanup rules: sensitive files, hard limits and deletion (stdlib only).

The cleanup command (lat-clean.py) and automatic cleanup both decide with these rules, so a
path one of them refuses is refused by the other too.
"""
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys

from _lat_common import process_starttime, run_cli

SCRIPTS = Path(__file__).resolve().parent
# Any file with one of these names, anywhere inside an item, is shredded.
SENSITIVE_NAMES = ('password.json', 'auth.json', '*.sqlite*', '.credentials*')
# A directory holding one of these is an isolated client home (CODEX_HOME, CLAUDE_CONFIG_DIR).
CLIENT_HOME_FILES = ('auth.json', '.credentials.json')
CLIENT_HOME_DIRS = ('sessions',)
# Never cleaned, moved or truncated, in the shared .lat and in any worktree's own .lat.
NEVER = ('decisions', 'sessions', 'panel-journal.jsonl')
# Top-level .lat folders holding ticket evidence and progress; an open ticket's data stays.
TICKET_DATA = ('runs', 'progress', 'evidence', 'prototypes', 'handoffs')
ENDED = ('ended', 'completed', 'cancelled')
_DATE = re.compile(r'\d{4}-\d{2}-\d{2}')
_HASH = re.compile(r'(?<![0-9a-z])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}(?![0-9a-z])')
_NUMBER = re.compile(r'(?<![0-9])(?:[0-9]{2,4}|(?<=issue-)[0-9]+)(?![0-9])')
_SHRED_BATCH = 200


def _inside(path, other):
    """True when `path` is `other` or below it (lexical, both absolute)."""
    return path == other or other in path.parents


def entries(path):
    """The item itself, then everything below it; symbolic links are not followed."""
    path = Path(path)
    yield path
    if path.is_dir() and not path.is_symlink():
        for root, directories, files in os.walk(path):
            for name in sorted(directories) + sorted(files):
                yield Path(root) / name


def sensitive_reason(path, lat):
    """Why `path` (a file or a whole directory) must be shredded, or None for trash."""
    watch = Path(lat) / 'watch'
    for entry in entries(path):
        name = entry.name
        if entry.parent == watch and fnmatch.fnmatch(name, 'prompt-*.txt'):
            return f'輸入備份 {name}'
        if any(fnmatch.fnmatch(name, pattern) for pattern in SENSITIVE_NAMES):
            return f'敏感檔 {entry}'
        if entry.is_dir() and not entry.is_symlink() and (
                any((entry / item).exists() for item in CLIENT_HOME_FILES)
                or any((entry / item).is_dir() for item in CLIENT_HOME_DIRS)):
            return f'隔離 client 家目錄 {entry}'
    return None


def deletion_method(path, lat):
    return 'shred' if sensitive_reason(path, lat) else 'trash'


def ticket_numbers(path, lat):
    """Ticket numbers in the name of a ticket-data item (dates and commit hashes skipped)."""
    try:
        parts = Path(path).relative_to(lat).parts
    except ValueError:
        return []
    if len(parts) < 2 or parts[0] not in TICKET_DATA:
        return []
    name = _HASH.sub(' ', _DATE.sub(' ', parts[1].lower()))
    return sorted({int(number) for number in _NUMBER.findall(name)})


def lock_targets(path):
    """Files a `.<name>.lock` guards: `<name>`, or `<name>.json` for wait declarations."""
    path = Path(path)
    if not (path.name.startswith('.') and path.name.endswith('.lock')):
        return []
    name = path.name[1:-len('.lock')]
    if not name:
        return []
    return [path.with_name(name), path.with_name(f'{name}.json')]


def lat_directories(lat):
    """The shared .lat, then the .lat of every linked worktree and `.worktrees/*` folder."""
    lat = Path(lat)
    others = sorted(lat.parent.glob('.worktrees/*/.lat'))
    try:
        output = run_cli(['git', '-C', str(lat.parent), 'worktree', 'list', '--porcelain'],
                         timeout=10)
    except ValueError:
        output = ''
    others += [Path(line.removeprefix('worktree ')) / '.lat' for line in output.splitlines()
               if line.startswith('worktree ')]
    return [lat, *dict.fromkeys(other for other in others if other != lat and other.is_dir())]


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _panel_bindings():
    directory = SCRIPTS.parent / 'herdr-panel'
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
    import bindings
    return bindings


def session_records(lat_dirs):
    """Every readable session record, as (path, record); unreadable ones are reported."""
    records, errors = [], []
    for lat in lat_dirs:
        for path in sorted((Path(lat) / 'sessions').glob('*.json')):
            try:
                record = json.loads(path.read_text(encoding='utf-8'))
                if not isinstance(record, dict):
                    raise ValueError('not a JSON object')
            except (OSError, ValueError) as error:
                errors.append(f'{path}: {error}')
                continue
            records.append((path, record))
    return records, errors


def _monitored_agents(record, watcher):
    """HCOM names an active controller monitors: itself and the agents on its task cards."""
    name = record.get('hcom_name')
    agents = {name} if name else set()
    tasks = Path(record.get('tasks_path') or '/nonexistent')
    for card in sorted(tasks.glob('*.md')) if tasks.is_dir() else []:
        try:
            fields = watcher.parse_task(card)
            if name and fields.get('orchestrator', name) == name and 'agent' in fields:
                agents.add(watcher.task_agent(fields['agent']))
        except (OSError, ValueError, UnicodeDecodeError):
            continue
    return agents


def active_dependencies(lat, lat_dirs):
    """Paths an active controller still needs: recovery files, its questions, its watch files."""
    records, errors = session_records(lat_dirs)
    active = [(path, record) for path, record in records if record.get('status') not in ENDED]
    paths = set()
    agents = set()
    watcher = _load('lat_watch_rules', SCRIPTS / 'lat-watch.py') if active else None
    bindings = _panel_bindings() if active else None
    for record_path, record in active:
        for key in ('progress_path', 'decisions_path', 'tasks_path'):
            if record.get(key):
                paths.add(Path(record[key]))
        record_lat = record_path.parent.parent
        sid = record.get('session_id') or record_path.stem
        paths.update(record_lat / 'watch' / f'{sid}{suffix}' for suffix in ('.pid', '.lock', '.log'))
        name = record.get('hcom_name')
        if name:
            paths.add(record_lat / 'watch' / name)
            for questions in _questions_paths(bindings, record, lat):
                archive = questions.with_name(f'{questions.stem}-archive{questions.suffix}')
                for item in (questions, archive):
                    paths.update((item, item.with_name(f'.{item.name}.lock')))
        agents |= _monitored_agents(record, watcher)
    for agent in agents:
        for directory in lat_dirs:
            waits = Path(directory) / 'watch/waits'
            paths.update((waits / f'{agent}.json', waits / f'.{agent}.lock'))
    return {Path(os.path.realpath(path)) for path in paths}, errors


def _questions_paths(bindings, record, lat):
    paths = []
    try:
        name = bindings._safe_controller_name(record['hcom_name'])
    except ValueError:
        return paths
    if record.get('workspace'):
        paths.append(Path(record['workspace']) / '.lat' / f'questions-{name}.md')
    paths.extend([Path(lat) / f'questions-{name}.md', Path(lat) / 'questions' / f'{name}.md'])
    return paths


class Protection:
    """Answers whether a path is inside a hard limit, from one fresh read of sessions."""

    def __init__(self, lat, *, ticket_states=None, ticket_error=None):
        self.lat = Path(os.path.realpath(lat))
        self.lat_dirs = [Path(os.path.realpath(path)) for path in lat_directories(self.lat)]
        self.never = [directory / name for directory in self.lat_dirs for name in NEVER]
        self.active, self.session_errors = active_dependencies(self.lat, self.lat_dirs)
        self.ticket_states = ticket_states
        self.ticket_error = ticket_error

    def reason(self, path, *, going=frozenset()):
        """Why `path` must never be deleted, or None.

        `going` holds paths removed before this one in the same run; their locks are not
        locks of an existing file.
        """
        path = Path(os.path.abspath(path))
        try:
            real = Path(os.path.realpath(path.parent)) / path.name
        except OSError as error:
            return f'無法解析路徑：{error}'
        shared, others = self.lat_dirs[0], self.lat_dirs[1:]
        if not ((real != shared and _inside(real, shared))
                or any(_inside(real, directory) for directory in others)):
            return '不在 .lat 內'
        for limit in self.never:
            if _inside(real, limit) or (_inside(limit, real) and os.path.lexists(limit)):
                return f'硬限制 {limit.name}'
        if self.session_errors:
            return f'讀不到 session 紀錄：{self.session_errors[0]}'
        for dependency in self.active:
            if _inside(real, dependency) or (_inside(dependency, real)
                                             and os.path.lexists(dependency)):
                return f'active session 仍需要 {dependency}'
        for entry in entries(real):
            if any(target.exists() and not _inside(target, real) and target not in going
                   for target in lock_targets(entry)):
                return f'現存檔案的鎖 {entry.name}'
        numbers = ticket_numbers(real, self.lat)
        if numbers and self.ticket_states is None:
            return f'票狀態無法確認：{self.ticket_error or "未查詢"}'
        open_tickets = [number for number in numbers
                        if (self.ticket_states or {}).get(number) == 'OPEN']
        if open_tickets:
            return '開啟中的票 ' + '、'.join(f'#{number}' for number in open_tickets)
        return None


def ticket_states(repo):
    """{number: 'OPEN' | 'CLOSED'} for every ticket; raises ValueError when gh fails."""
    return {issue['number']: issue['state'] for issue in tracker_issues(repo, ('number', 'state'))}


def tracker_issues(repo, fields):
    output = run_cli(['gh', 'issue', 'list', '-R', repo, '--state', 'all', '--limit', '10000',
                      '--json', ','.join(fields)], timeout=180, failure='gh issue list failed')
    try:
        issues = json.loads(output)
        if not isinstance(issues, list):
            raise ValueError('not a list')
        return issues
    except ValueError as error:
        raise ValueError(f'gh issue list returned unreadable output: {error}') from error


def fingerprint(path):
    """Hash of every entry's relative path, type, size and modification time."""
    path = Path(path)
    digest = hashlib.sha256()
    for entry in entries(path):
        info = entry.lstat()
        relative = '.' if entry == path else str(entry.relative_to(path))
        digest.update(json.dumps([relative, stat.S_IFMT(info.st_mode), info.st_size,
                                  info.st_mtime_ns]).encode() + b'\n')
    return digest.hexdigest()


def usage(path):
    """(bytes of regular files, latest modification time) for a file or a directory."""
    size, latest = 0, 0.0
    for entry in entries(path):
        info = entry.lstat()
        if stat.S_ISREG(info.st_mode):
            size += info.st_size
        latest = max(latest, info.st_mtime)
    return size, latest


def delete(path, method, lat):
    """Remove one item with trash-put; for 'shred', `shred -u` its regular files first.

    A file with other hard links is not shredded (that would destroy the other copy);
    when such a file is itself sensitive the item is refused before anything changes.
    """
    path = Path(path)
    if method not in ('trash', 'shred'):
        raise ValueError(f'unknown deletion method: {method}')
    if method == 'shred':
        files = []
        for entry in entries(path):
            info = entry.lstat()
            if not stat.S_ISREG(info.st_mode):
                continue
            if info.st_nlink > 1:
                if sensitive_reason(entry, lat):
                    raise ValueError(f'sensitive file has other hard links: {entry}')
                continue
            files.append(str(entry))
        for start in range(0, len(files), _SHRED_BATCH):
            run_cli(['shred', '-u', '--', *files[start:start + _SHRED_BATCH]], timeout=600)
    if os.path.lexists(path):
        run_cli(['trash-put', '--', str(path)], timeout=600)


def watcher_alive(pid_path):
    try:
        pid = int(Path(pid_path).read_text())
    except (OSError, ValueError):
        return False
    return pid > 1 and process_starttime(pid) is not None

