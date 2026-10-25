"""Retro feedback backlog: a local git repo of feedback entries, one markdown file per issue.

Every command that changes data either writes everything and commits, or rolls back to the
commit it started from. Entry status and recurrence are computed from the timestamped
occurrence and processing records, never edited by hand.
"""
import argparse
from dataclasses import dataclass, field
from datetime import datetime
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
    kind: str  # severe | unsevere
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
        """Replay the records in time order; processing records sort after occurrences at the same time."""
        events = [(when(o.time), 0, o) for o in self.occurrences]
        events += [(when(p.time), 1, p) for p in self.processing]
        sessions, severe, reason = set(), False, ''
        for _, _, record in sorted(events, key=lambda e: (e[0], e[1])):
            if isinstance(record, Occurrence):
                sessions.add(record.session)
            elif record.kind == 'severe':
                severe, reason = True, record.detail
            elif record.kind == 'unsevere':
                severe, reason = False, ''
        status = 'ready' if severe or len(sessions) >= 2 else 'observing'
        return {'status': status, 'severe': severe, 'severe_reason': reason, 'recurring': False,
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
    if '\n' in value or '\r' in value:
        raise Refused(f'{name} 不能換行')
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
    lines += [f'- {o.time} | {o.project} | {o.client} | {o.session} | {o.evidence}' for o in entry.occurrences]
    lines += ['', H_PROC, '']
    lines += [f'- {p.time} | {p.kind} | {p.detail}' for p in entry.processing]
    return '\n'.join(lines) + '\n'


def parse(path):
    text = path.read_text()
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

    def get(self, entry_id):
        path = self.path(entry_id)
        if not path.exists():
            raise Refused(f'找不到條目 #{entry_id}')
        return parse(path)

    def next_id(self):
        return max((e.id for e in self.all()), default=0) + 1

    def transaction(self, change):
        """Run change() -> (entries to write, commit message, output); commit, or restore the start commit."""
        start = None
        if self.exists():
            leftover = self.dirty()
            if leftover:
                raise Refused('反饋庫有未提交的改動，拒絕執行：\n' + '\n'.join(f'  {f}' for f in leftover)
                              + '\n請先執行 restore 還原到最後一次 commit，再重跑原指令。')
            start = self.head()
        entries, message, output = change()
        if not entries:
            return output
        try:
            if not self.exists():
                self.create()
            self.entries_dir.mkdir(exist_ok=True)
            for entry in entries:
                self.path(entry.id).write_text(render(entry))
            self.git('add', '-A')
            self.git('commit', '-q', '-m', message)
        except (OSError, RuntimeError) as error:
            if self.exists():
                self.discard(start)
            raise Failed(f'寫入失敗：{error}\n已還原到指令開始前的狀態（{(start or "空的反饋庫")[:12]}），可以直接重跑原指令。')
        return output


class Failed(Exception):
    """A write or commit failed and the backlog was restored."""


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
    if any(when(p.time) == when(record.time) for p in entry.processing):
        raise Refused(f'#{entry.id} 已有時間 {record.time} 的處理紀錄，請用 --time 指定不同的時間')
    entry.processing.append(record)


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
        if any(o.session == occurrence.session for o in entry.occurrences):
            return [], '', f'已存在：#{entry.id} 已有 session {occurrence.session} 的出現紀錄，未增加次數'
        entry.occurrences.append(occurrence)
        return [entry], f'chore: record occurrence of #{entry.id}', f'已記錄出現 {summary(entry)}'
    return backlog.transaction(change)


def cmd_severe(backlog, args):
    def change():
        entry = live(backlog, args.id)
        if args.unset:
            if not entry.state()['severe']:
                raise Refused(f'#{entry.id} 目前不是嚴重')
            add_processing(entry, Processing(normalize_time(args.time), 'unsevere', '取消嚴重'))
            message, verb = f'chore: unmark #{entry.id} severe', '已取消嚴重'
        else:
            if args.reason is None:
                raise Refused('設嚴重需要 --reason 理由')
            add_processing(entry, Processing(normalize_time(args.time), 'severe', one_line('嚴重理由', args.reason, allow_pipe=True)))
            message, verb = f'chore: mark #{entry.id} severe', '已設嚴重'
        return [entry], message, f'{verb} {summary(entry)}'
    return backlog.transaction(change)


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
    return backlog.path(backlog.get(args.id).id).read_text().rstrip('\n')


def cmd_restore(backlog, args):
    if not backlog.exists():
        return '反饋庫不存在，沒有需要還原的改動'
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


COMMANDS = {'init': cmd_init, 'add': cmd_add, 'occur': cmd_occur, 'severe': cmd_severe, 'list': cmd_list,
            'search': cmd_search, 'show': cmd_show, 'restore': cmd_restore}


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
