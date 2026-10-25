"""Retro feedback backlog: a local git repo of feedback entries, one markdown file per issue.

Every command that changes data either writes everything and commits, or rolls back to the
commit it started from. Entry status and recurrence are computed from the timestamped
occurrence and processing records, never edited by hand.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys

ENV_DIR = 'RETRO_BACKLOG_DIR'
ENTRIES = 'entries'
CLIENTS = ('claude', 'codex')
STATUS_LABELS = {'observing': '觀察中', 'ready': '可處理', 'done': '已完成', 'wontfix': '不做'}
H_DESC, H_SUGGEST, H_OCC, H_PROC = '## 問題描述', '## 建議做法', '## 出現紀錄', '## 處理紀錄'
HEADINGS = (H_DESC, H_SUGGEST, H_OCC, H_PROC)
FRONT_KEYS = ('id', 'title', 'status', 'severe', 'severe_reason', 'recurring', 'merged_into', 'suspected')
GIT_IDENTITY = ('-c', 'user.name=retro-log', '-c', 'user.email=retro-log@localhost')


class Refused(Exception):
    """An invalid operation; nothing was changed."""


class Failed(Exception):
    """A write or commit failed; the message says whether the backlog was restored."""


@dataclass
class Occurrence:
    time: str
    project: str
    client: str
    session: str
    evidence: str


@dataclass
class Processing:
    time: str
    kind: str  # severe | unsevere | done | wontfix | ready
    detail: str


@dataclass
class Entry:
    id: int
    title: str
    description: str
    suggestion: str
    occurrences: list = field(default_factory=list)
    processing: list = field(default_factory=list)
    merged_into: int | None = None
    suspected: list = field(default_factory=list)

    def state(self):
        """Replay the records in time order; processing records sort after occurrences at the same time.

        Each done or wontfix record starts a new count over the sessions not seen before it: one such
        session reopens a done entry as recurring, two reopen a wontfix entry (not recurring). A manual
        ready record holds until the next done or wontfix and reopens a closed entry, not recurring.
        """
        events = [(when(o.time), 0, o) for o in self.occurrences]
        events += [(when(p.time), 1, p) for p in self.processing]
        sessions, severe, reason = set(), False, ''
        closed, manual, recurring, before, new = None, False, False, set(), set()
        for _, _, record in sorted(events, key=lambda e: (e[0], e[1])):
            if isinstance(record, Occurrence):
                if closed and record.session not in before:
                    new.add(record.session)
                    if closed == 'done' or len(new) >= 2:
                        closed, recurring = None, closed == 'done'
                sessions.add(record.session)
            elif record.kind == 'severe':
                severe, reason = True, record.detail
            elif record.kind == 'unsevere':
                severe, reason = False, ''
            elif record.kind in ('done', 'wontfix'):
                closed, manual, recurring, before, new = record.kind, False, False, set(sessions), set()
            elif record.kind == 'ready':
                closed, manual = None, True
        status = closed or ('ready' if severe or manual or recurring or len(sessions) >= 2 else 'observing')
        return {'status': status, 'severe': severe, 'severe_reason': reason, 'recurring': recurring,
                'sessions': len(sessions)}

    def latest(self):
        return max(when(o.time) for o in self.occurrences)


def when(text):
    return datetime.fromisoformat(text)


def normalize_time(text):
    if text is None:
        return datetime.now().astimezone().isoformat()
    try:
        value = datetime.fromisoformat(text)
    except ValueError:
        raise Refused(f'時間格式無效：{text}（請用 ISO 8601，例如 2026-10-25T14:30:00+08:00）')
    return value.astimezone().isoformat() if value.tzinfo is None else value.isoformat()


def one_line(name, value, allow_pipe=False):
    if not value or not value.strip():
        raise Refused(f'{name} 不能是空的')
    if len(value.splitlines()) != 1:
        raise Refused(f'{name} 不能換行或含有分行字元')
    if not allow_pipe and '|' in value:
        raise Refused(f'{name} 不能含有「|」')
    return value.strip()


def free_text(name, value):
    if not value or not value.strip():
        raise Refused(f'{name} 不能是空的')
    for line in value.splitlines():
        if line.strip() in HEADINGS:
            raise Refused(f'{name} 不能含有保留標題「{line.strip()}」')
    return value.strip()


# ---- entry files ----

def render(entry):
    state = entry.state()
    front = {'id': entry.id, 'title': entry.title, 'status': state['status'], 'severe': state['severe'],
             'severe_reason': state['severe_reason'], 'recurring': state['recurring'],
             'merged_into': entry.merged_into, 'suspected': entry.suspected}
    lines = ['---', *(f'{k}: {json.dumps(front[k], ensure_ascii=False)}' for k in FRONT_KEYS), '---', '',
             H_DESC, '', entry.description, '', H_SUGGEST, '', entry.suggestion, '', H_OCC, '']
    # records are written in time order, so the file does not depend on the order they were added in
    lines += [f'- {o.time} | {o.project} | {o.client} | {o.session} | {o.evidence}'
              for o in sorted(entry.occurrences, key=lambda o: when(o.time))]
    lines += ['', H_PROC, '']
    lines += [f'- {p.time} | {p.kind} | {p.detail}' for p in sorted(entry.processing, key=lambda p: when(p.time))]
    return '\n'.join(lines) + '\n'


def parse(path):
    text = path.read_text(encoding='utf-8')
    try:
        _, front_text, body = text.split('---\n', 2)
        front = {}
        for line in front_text.splitlines():
            key, value = line.split(': ', 1)
            front[key] = json.loads(value)
        sections = section_texts(body)
        occurrences = [Occurrence(*item[2:].split(' | ', 4)) for item in sections[H_OCC].splitlines() if item]
        processing = [Processing(*item[2:].split(' | ', 2)) for item in sections[H_PROC].splitlines() if item]
        return Entry(front['id'], front['title'], sections[H_DESC], sections[H_SUGGEST], occurrences,
                     processing, front['merged_into'], front['suspected'])
    except (ValueError, KeyError, TypeError) as error:
        raise Refused(f'條目檔格式無法解讀：{path.name}（{error}）')


def section_texts(body):
    lines = body.splitlines()
    starts = [lines.index(h) for h in HEADINGS]
    ends = starts[1:] + [len(lines)]
    return {h: '\n'.join(lines[s + 1:e]).strip() for h, s, e in zip(HEADINGS, starts, ends)}


# ---- backlog repo ----

class Backlog:
    def __init__(self, root):
        self.root = root
        self.entries_dir = root / ENTRIES

    def git(self, *args, check=True):
        result = subprocess.run(['git', '-C', str(self.root), *GIT_IDENTITY, *args],
                                capture_output=True, text=True)
        if check and result.returncode != 0:
            raise RuntimeError(f'git {args[0]} 失敗：{(result.stderr or result.stdout).strip()}')
        return result

    def exists(self):
        return (self.root / '.git').exists()

    def create(self):
        self.root.mkdir(parents=True, exist_ok=True)
        self.git('init', '-q')

    def head(self):
        result = self.git('rev-parse', '--verify', '-q', 'HEAD', check=False)
        return result.stdout.strip() or None

    def dirty(self):
        out = self.git('status', '--porcelain', '--untracked-files=all').stdout
        return [line[3:] for line in out.splitlines()]

    def discard(self, head):
        if head:
            self.git('reset', '-q', '--hard', head)
        else:
            self.git('rm', '-r', '-q', '--cached', '--ignore-unmatch', '.')
        self.git('clean', '-q', '-fd')

    def path(self, entry_id):
        return self.entries_dir / f'{entry_id:04d}.md'

    def all(self):
        if not self.entries_dir.is_dir():
            return []
        return [parse(p) for p in sorted(self.entries_dir.glob('*.md'))]

    def existing_path(self, entry_id):
        path = self.path(entry_id)
        if not path.exists():
            raise Refused(f'找不到條目 #{entry_id}')
        return path

    def get(self, entry_id):
        return parse(self.existing_path(entry_id))

    def next_id(self):
        return max((e.id for e in self.all()), default=0) + 1

    @contextmanager
    def locked(self):
        """Hold an exclusive lock on the backlog folder itself, so no lock file enters the repo."""
        self.root.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.root, os.O_RDONLY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            os.close(fd)

    def transaction(self, change):
        """Run change() -> (entries to write, commit message, output) under the lock; commit, or restore."""
        with self.locked():
            return self.commit_change(change)

    def commit_change(self, change):
        start = None
        if self.exists():
            leftover = self.dirty()
            if leftover:
                raise Refused('反饋庫有未提交的改動，拒絕執行：\n' + '\n'.join(f'  {f}' for f in leftover)
                              + '\n請先執行 restore 還原到最後一次 commit，再重跑原指令。')
            if (self.root / '.git/index.lock').exists():
                raise Refused('反饋庫的 .git/index.lock 存在：可能有另一個 git 程序正在使用反饋庫。'
                              '確認沒有其他程序在用後再重跑原指令；若是殘留的鎖檔，請自行確認後移除。')
            start = self.head()
        entries, message, output = change()
        if not entries:
            return output
        try:
            if not self.exists():
                self.create()
            self.entries_dir.mkdir(exist_ok=True)
            for entry in entries:  # replace whole files so an unlocked reader never sees half of one
                path = self.path(entry.id)
                temp = path.with_name(f'.{path.name}.tmp')
                temp.write_text(render(entry), encoding='utf-8')
                os.replace(temp, path)
            self.git('add', '-A')
            self.git('commit', '-q', '-m', message)
        except (OSError, RuntimeError, ValueError) as error:
            try:
                if self.exists():
                    self.discard(start)
            except (OSError, RuntimeError) as restore_error:
                raise Failed(f'寫入失敗：{error}\n還原也失敗：{restore_error}\n反饋庫可能留有未提交的改動；'
                             '排除原因後執行 restore，再重跑原指令。')
            raise Failed(f'寫入失敗：{error}\n已還原到指令開始前的狀態（{(start or "空的反饋庫")[:12]}），可以直接重跑原指令。')
        return output


def backlog_root():
    configured = os.environ.get(ENV_DIR)
    return Path(configured).expanduser() if configured else Path.home() / 'retro-backlog'


# ---- commands ----

def summary(entry):
    state = entry.state()
    flags = ''.join(['［嚴重］' if state['severe'] else '', '［復發］' if state['recurring'] else ''])
    return f'#{entry.id} [{STATUS_LABELS[state["status"]]}]{flags} {entry.title}（{state["sessions"]} 個 session）'


def occurrence_from(args):
    if args.client not in CLIENTS:
        raise Refused(f'client 只能是 {"／".join(CLIENTS)}：{args.client}')
    return Occurrence(normalize_time(args.time), one_line('專案', args.project), args.client,
                      one_line('session', args.session), one_line('證據', args.evidence, allow_pipe=True))


def add_processing(entry, record):
    """Append record; False when an identical one is already there (a rerun). Another record at its time is refused."""
    same_time = [p for p in entry.processing if when(p.time) == when(record.time)]
    if any(p.kind == record.kind and p.detail == record.detail for p in same_time):
        return False
    if same_time:
        raise Refused(f'#{entry.id} 已有時間 {record.time} 的處理紀錄，請用 --time 指定不同的時間')
    entry.processing.append(record)
    return True


def unchanged(entry, record):
    return [], '', f'已存在：#{entry.id} 已有相同的處理紀錄（{record.time} {record.kind}），未新增'


def cmd_init(backlog, args):
    if backlog.exists():
        return f'反饋庫已存在：{backlog.root}'
    backlog.create()
    return f'已建立反饋庫：{backlog.root}'


def cmd_add(backlog, args):
    def change():
        occurrence = occurrence_from(args)
        entry = Entry(backlog.next_id(), one_line('標題', args.title, allow_pipe=True),
                      free_text('問題描述', args.description), free_text('建議做法', args.suggestion),
                      [occurrence])
        if args.severe is not None:
            add_processing(entry, Processing(occurrence.time, 'severe', one_line('嚴重理由', args.severe, allow_pipe=True)))
        return [entry], f'feat: add #{entry.id} {entry.title}', f'已新增 {summary(entry)}'
    return backlog.transaction(change)


def cmd_occur(backlog, args):
    def change():
        entry = live(backlog, args.id)
        occurrence = occurrence_from(args)
        existing = next((o for o in entry.occurrences if o.session == occurrence.session), None)
        if existing and when(existing.time) <= when(occurrence.time):
            return [], '', f'已存在：#{entry.id} 已有 session {occurrence.session} 的出現紀錄，未增加次數'
        if existing:  # keep the earlier time, as a merge does, so the result does not depend on write order
            entry.occurrences.remove(existing)
            entry.occurrences.append(occurrence)
            return ([entry], f'chore: move occurrence of #{entry.id} to an earlier time',
                    f'已存在：#{entry.id} 已有 session {occurrence.session} 的出現紀錄，改用較早的時間 '
                    f'{occurrence.time}，未增加次數 {summary(entry)}')
        entry.occurrences.append(occurrence)
        return [entry], f'chore: record occurrence of #{entry.id}', f'已記錄出現 {summary(entry)}'
    return backlog.transaction(change)


def cmd_severe(backlog, args):
    def change():
        entry = live(backlog, args.id)
        if args.unset:
            record = Processing(normalize_time(args.time), 'unsevere', '取消嚴重')
            message, verb = f'chore: unmark #{entry.id} severe', '已記錄取消嚴重'
        else:
            if args.reason is None:
                raise Refused('設嚴重需要 --reason 理由')
            record = Processing(normalize_time(args.time), 'severe', one_line('嚴重理由', args.reason, allow_pipe=True))
            message, verb = f'chore: mark #{entry.id} severe', '已設嚴重'
        if not add_processing(entry, record):
            return unchanged(entry, record)
        if args.unset and entry.state()['severe']:
            verb += '（之後還有設嚴重紀錄，目前仍是嚴重）'
        return [entry], message, f'{verb} {summary(entry)}'
    return backlog.transaction(change)


def cmd_done(backlog, args):
    def change():
        entry = live(backlog, args.id)
        if args.commit is None and args.file is None:
            raise Refused('標已完成需要 --commit 或 --file（改了哪個 commit 或檔案）')
        parts = [f'commit {one_line("commit", args.commit)}'] if args.commit is not None else []
        if args.file is not None:
            parts.append(f'file {one_line("檔案", args.file, allow_pipe=True)}')
        if args.commit is not None and any(p.kind == 'done' and p.detail.split('; ')[0] == parts[0]
                                           for p in entry.processing):
            return [], '', f'已存在：#{entry.id} 已有 {parts[0]} 的完成紀錄，未新增'
        record = Processing(normalize_time(args.time), 'done', '; '.join(parts))
        if not add_processing(entry, record):
            return unchanged(entry, record)
        return [entry], f'chore: mark #{entry.id} done', recorded(entry, '已標已完成', 'done')
    return backlog.transaction(change)


def cmd_wontfix(backlog, args):
    def change():
        entry = live(backlog, args.id)
        if args.reason is None:
            raise Refused('標不做需要 --reason 理由')
        record = Processing(normalize_time(args.time), 'wontfix', one_line('不做理由', args.reason, allow_pipe=True))
        if not add_processing(entry, record):
            return unchanged(entry, record)
        return [entry], f'chore: mark #{entry.id} wontfix', recorded(entry, '已標不做', 'wontfix')
    return backlog.transaction(change)


def cmd_ready(backlog, args):
    def change():
        entry = live(backlog, args.id)
        record = Processing(normalize_time(args.time), 'ready', '手動設可處理')
        if not add_processing(entry, record):
            return unchanged(entry, record)
        return [entry], f'chore: mark #{entry.id} ready', recorded(entry, '已手動設可處理', 'ready')
    return backlog.transaction(change)


def recorded(entry, verb, status):
    if entry.state()['status'] != status:
        verb += f'（之後還有其他紀錄，目前不是{STATUS_LABELS[status]}）'
    return f'{verb} {summary(entry)}'


def live(backlog, entry_id):
    entry = backlog.get(entry_id)
    if entry.merged_into is not None:
        raise Refused(f'#{entry.id} 已併入 #{entry.merged_into}，請改用 #{entry.merged_into}')
    return entry


def rank_key(entry):
    state = entry.state()
    return (not state['severe'], not state['recurring'], -state['sessions'], -entry.latest().timestamp(), entry.id)


def cmd_list(backlog, args):
    entries = [e for e in backlog.all() if e.merged_into is None]
    if args.status:
        entries = [e for e in entries if e.state()['status'] == args.status]
    entries.sort(key=rank_key)
    if args.limit is not None:
        entries = entries[:args.limit]
    return '\n'.join(summary(e) for e in entries) or '沒有符合的條目'


def cmd_search(backlog, args):
    words = [w.casefold() for w in args.keywords]
    hits = []
    for entry in backlog.all():
        text = '\n'.join([entry.title, entry.description, entry.suggestion]).casefold()
        score = sum(w in text for w in words)
        if score:
            hits.append((-score, entry.id, entry))
    hits.sort(key=lambda h: h[:2])
    lines = [summary(e) + (f' → 已併入 #{e.merged_into}' if e.merged_into else '') for _, _, e in hits[:args.limit]]
    return '\n'.join(lines) or '沒有符合的條目'


def cmd_show(backlog, args):
    return backlog.existing_path(args.id).read_text(encoding='utf-8').rstrip('\n')


def cmd_restore(backlog, args):
    if not backlog.exists():
        return '反饋庫不存在，沒有需要還原的改動'
    with backlog.locked():
        leftover = backlog.dirty()
        if not leftover:
            return '沒有未提交的改動'
        backlog.discard(backlog.head())
    return '已還原到最後一次 commit，捨棄：\n' + '\n'.join(f'  {f}' for f in leftover)


def positive(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError('必須是正整數')
    return value


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('init', help='建立反饋庫（不存在時）')

    def occurrence_args(p):
        p.add_argument('--project', required=True)
        p.add_argument('--client', required=True, help='claude 或 codex')
        p.add_argument('--session', required=True)
        p.add_argument('--evidence', required=True, help='一句證據')
        p.add_argument('--time', help='這條反饋在該 session 出現的時間（ISO 8601），預設現在')

    p = sub.add_parser('add', help='新增條目並記第一次出現')
    p.add_argument('--title', required=True)
    p.add_argument('--description', required=True)
    p.add_argument('--suggestion', required=True)
    p.add_argument('--severe', metavar='REASON', help='新增時就標嚴重，附一句理由')
    occurrence_args(p)
    p = sub.add_parser('occur', help='對既有條目記一次出現')
    p.add_argument('id', type=positive)
    occurrence_args(p)
    p = sub.add_parser('severe', help='設或取消嚴重')
    p.add_argument('id', type=positive)
    p.add_argument('--reason')
    p.add_argument('--unset', action='store_true')
    p.add_argument('--time', help='處理時間（ISO 8601），預設現在')
    p = sub.add_parser('done', help='標已完成，附 commit 或檔案')
    p.add_argument('id', type=positive)
    p.add_argument('--commit')
    p.add_argument('--file')
    p.add_argument('--time', help='完成時間（ISO 8601），預設現在')
    p = sub.add_parser('wontfix', help='標不做，附理由')
    p.add_argument('id', type=positive)
    p.add_argument('--reason')
    p.add_argument('--time', help='處理時間（ISO 8601），預設現在')
    p = sub.add_parser('ready', help='手動設可處理')
    p.add_argument('id', type=positive)
    p.add_argument('--time', help='處理時間（ISO 8601），預設現在')
    p = sub.add_parser('list', help='依狀態列清單')
    p.add_argument('--status', choices=list(STATUS_LABELS))
    p.add_argument('--limit', type=positive)
    p = sub.add_parser('search', help='關鍵字搜尋標題與內文')
    p.add_argument('keywords', nargs='+')
    p.add_argument('--limit', type=positive, default=10)
    p = sub.add_parser('show', help='顯示單一條目')
    p.add_argument('id', type=positive)
    sub.add_parser('restore', help='還原未提交改動，回到最後一次 commit')
    return parser


COMMANDS = {'init': cmd_init, 'add': cmd_add, 'occur': cmd_occur, 'severe': cmd_severe, 'done': cmd_done,
            'wontfix': cmd_wontfix, 'ready': cmd_ready, 'list': cmd_list, 'search': cmd_search, 'show': cmd_show,
            'restore': cmd_restore}


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        print(COMMANDS[args.command](Backlog(backlog_root()), args))
    except Refused as error:
        print(f'錯誤：{error}', file=sys.stderr)
        return 1
    except Failed as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
