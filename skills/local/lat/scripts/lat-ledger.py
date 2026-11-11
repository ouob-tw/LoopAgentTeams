#!/usr/bin/env python3
"""Work ledger for one LAT orchestrator round (stdlib only).

Only this program writes the ledger. Each write replaces the JSON file atomically under a
lock, rewrites the seal (SHA-256 of the file) and appends the new snapshot to the journal
beside it. A read refuses a ledger whose seal does not match (a hand edit, even a well-formed
one) or whose content is malformed; `repair` recovers either case with a stated reason.
Closing an item needs evidence the program can find: a commit reachable from a branch, a
suite-gate record fingerprint, or a non-empty file. The program only checks that evidence
exists; whether the work passed acceptance stays the orchestrator's call. A gate record that
passed only on the automatic rerun of failed test files counts only with `--rerun-ack`, a
review result that names it.
A row added with `--tiny` (the tiny-change lane, with the orchestrator's two declarations) marks
every row of its ticket; `review-result --tiny-confirm` records the reviewer's confirmation of
the four limits after running the tiny check (review-size.py) on the row's work.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import getpass
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(1, str(Path(__file__).resolve().parents[1] / 'herdr-panel'))
from _lat_common import (full_hcom_name, read_hcom_list, resolve_agent_name, run_cli,
                         same_controller, shared_lat_dir, write_text_atomic)
from _lat_tracker import read_issue, tracker_repo
from transcript import current_settings

LAT_DIR = Path(__file__).resolve().parents[1]
# Overrides for tests: a fixed clock, another suite-gate script and a file for `hcom list --json`.
NOW_ENV = 'LAT_LEDGER_NOW'
GATE_ENV = 'LAT_LEDGER_SUITE_GATE'
HCOM_LIST_ENV = 'LAT_LEDGER_HCOM_LIST'
# ... and a JSON file {name: object} standing in for `hcom list <name> --json`.
HCOM_AGENTS_ENV = 'LAT_LEDGER_HCOM_AGENTS'
READ_ONLY = ('next', 'check', 'show', 'problems')
VERSION = 1
STAGES = {'impl': '實作', 'review': '審查', 'qa-draft': 'QA 草稿', 'qa': '驗收',
          'merge': '整合', 'spec-review': 'Spec 審查', 'research': '研究', 'advisor': '參謀',
          'other': '其他'}
STATUSES = {'unassigned': '未派', 'assigned': '已派', 'in_progress': '進行中',
            'blocked': '受阻', 'done': '已結案', 'cancelled': '已取消'}
KINDS = ('commit', 'gate', 'file')
OPEN = ('assigned', 'in_progress', 'blocked')
DEP_CANCELLED = '依賴已取消'
CARD_FIELD = re.compile(r'-\s+([^：:\n]+)[：:]\s*(.*)')
CARD_CLOSED = ('committed', 'merged', 'completed')
RELATIVE = re.compile(r'\+(\d+)([mhd])')
ROUND_LEDGER = re.compile(r'(.+)-r\d+\.json')
# The tool keeps each row's deadline at its estimate plus this; it only drives stall alarms.
DEADLINE_AFTER_ESTIMATE = timedelta(hours=1)
# The ticket layer `show` builds from the rows. Each progress step but merged and deployed is
# made of the rows of these stages; the deployed step exists only where the project has a
# successful production deploy in its deploy history.
STEPS = {'draft': '草稿', 'impl': '實作', 'review': '審查', 'qa': '驗收', 'merged': '合併',
         'deployed': '上線'}
STEP_STAGES = {'draft': ('qa-draft',), 'impl': ('impl',), 'review': ('review',), 'qa': ('qa',)}
STEP_MARKS = {'done': '✓', 'active': '●', 'pending': '○', 'skipped': '—'}
# A ticket's state, by precedence: any open row decides it, else how far its delivery went.
TICKET_STATES = {'in_progress': '進行中', 'blocked': '受阻', 'assigned': '已派',
                 'unassigned': '未派', 'deployed': '已上線', 'merged': '已合併',
                 'done': '已結案', 'cancelled': '已取消'}
DEPLOY_ACTION = 'deploy-prod'
TITLE_TIMEOUT_SECONDS = 10
TITLE_BUDGET_SECONDS = 20
QUALIFIED_TICKET = re.compile(r'([\w.-]+/[\w.-]+)#(\d+)')
# Reading what an agent really runs on: the effort words a task card's model field may end
# with, and how much of a transcript's end is searched for the latest turn's settings.
EFFORTS = ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
TRANSCRIPT_TAIL_BYTES = 4 << 20
UNVERIFIED = '未查證'
TINY_DECLARED = ['no-feature', 'no-format-change']
# The problem log: one file per project in the shared .lat, the fixed stages a problem can be
# found in (in the order work reaches them), and the levels. Problems found after merging are
# recorded by the orchestrator and may name 不明 instead of the ticket that caused them.
PROBLEMS_FILE = 'problems.jsonl'
PROBLEM_STAGES = {'self': '自查', 'test': '自動測試', 'review': '審查', 'qa': '驗收',
                  'post-merge': '合併後測試', 'suite': '背景整套',
                  'post-deploy-user': '上線後（使用者）', 'post-deploy': '上線後（其他）'}
LATE_STAGES = ('post-merge', 'suite', 'post-deploy-user', 'post-deploy')
LEVELS = ('甲', '乙', '丙')
UNKNOWN_TICKET = '不明'
# A ticket line shows a stage's count even at 0 once this progress step is done.
ZERO_SHOWN = {'review': 'review', 'qa': 'qa', 'post-deploy-user': 'deployed'}


class Failure(Exception):
    """The request cannot be served; the message goes to stderr."""


def now():
    fixed = os.environ.get(NOW_ENV)
    return parse_time(fixed, base=None) if fixed else datetime.now(timezone.utc)


def parse_time(text, base):
    """ISO 8601 (naive means local time) or +N[m|h|d] from base; returns aware UTC."""
    match = RELATIVE.fullmatch(text.strip())
    if match and base is not None:
        unit = {'m': 'minutes', 'h': 'hours', 'd': 'days'}[match.group(2)]
        return base + timedelta(**{unit: int(match.group(1))})
    try:
        value = datetime.fromisoformat(text.strip().replace('Z', '+00:00'))
    except ValueError as error:
        raise Failure(f'invalid time {text!r}: use ISO 8601 or +N[m|h|d]') from error
    if value.tzinfo is None:
        value = value.astimezone()
    return value.astimezone(timezone.utc)


def stamp(value):
    return value.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def loads_time(text):
    return datetime.fromisoformat(text.replace('Z', '+00:00'))


def actor(args):
    return args.by


def resolve_names(args):
    """Turn --by (default $HCOM_INSTANCE_NAME), --orchestrator and --agent into HCOM full names
    before anything is written; without any HCOM name the OS user acts. An unreadable HCOM
    list refuses the command rather than writing a name it could not check."""
    by = args.by or os.environ.get('HCOM_INSTANCE_NAME')
    # (attribute, flag, name): init takes --orchestrator, assign/reassign --agent.
    names = [('by', '--by', by),
             ('orchestrator', '--orchestrator', getattr(args, 'orchestrator', None))]
    if not getattr(args, 'native', False):
        names.append(('agent', '--agent', getattr(args, 'agent', None)))
    names = [entry for entry in names if entry[2]]
    if names:
        agents = {item['name'] for item in read_hcom_list(HCOM_LIST_ENV)
                  if isinstance(item.get('name'), str)}
        for attribute, flag, name in names:
            setattr(args, attribute, full_hcom_name(agents, name, flag))
    if not by:
        args.by = getpass.getuser()


def item_ids(text):
    try:
        return sorted({int(part) for part in text.split(',') if part.strip()})
    except ValueError as error:
        raise Failure(f'invalid item list {text!r}: use comma-separated numbers') from error


def deadline_for(estimate):
    """The deadline the tool keeps for an estimate stamp; None without an estimate."""
    return stamp(loads_time(estimate) + DEADLINE_AFTER_ESTIMATE) if estimate else None


def ignore_deadline(args):
    """--deadline is still accepted from older callers but no longer set by hand."""
    if getattr(args, 'deadline', None):
        print('lat-ledger: --deadline ignored; the deadline is now the estimate + 1h, '
              'set by start/update --eta', file=sys.stderr)


def kinds_of(values):
    kinds = []
    for value in values:
        for part in value.split(','):
            part = part.strip()
            if part not in KINDS:
                raise Failure(f'unknown evidence kind {part!r}; use {", ".join(KINDS)}')
            if part not in kinds:
                kinds.append(part)
    return kinds


# ---- storage --------------------------------------------------------------------------

class Store:
    def __init__(self, path):
        path = Path(path)
        if not path.is_absolute():
            raise Failure(f'--ledger must be an absolute path: {path}')
        self.path = path
        self.seal = path.with_name(path.name + '.seal')
        self.journal = path.with_name(path.name + '.journal.jsonl')
        self.lock = path.with_name(path.name + '.lock')


def serialize(doc):
    return json.dumps(doc, indent=2, ensure_ascii=False) + '\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


@contextmanager
def locked(store, exclusive):
    store.path.parent.mkdir(parents=True, exist_ok=True)
    with open(store.lock, 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield


def validate(doc):
    """Raise ValueError naming the first structural problem."""
    if not isinstance(doc, dict) or doc.get('version') != VERSION:
        raise ValueError(f'expected an object with version {VERSION}')
    for key in ('workspace', 'created_at'):
        if not isinstance(doc.get(key), str):
            raise ValueError(f'{key} must be a string')
    if not isinstance(doc.get('history'), list) or not isinstance(doc.get('next_id'), int):
        raise ValueError('history must be a list and next_id a number')
    titles = doc.get('titles', {})  # ledgers made before ticket titles have none
    if not isinstance(titles, dict) or not all(isinstance(v, str) for v in titles.values()):
        raise ValueError('titles must map tickets to text')
    for key in ('reviews', 'participants'):  # ledgers made before review results have none
        entries = doc.get(key, [])
        if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
            raise ValueError(f'{key} must be a list of objects')
    items = doc.get('items')
    if not isinstance(items, list):
        raise ValueError('items must be a list')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('id'), int):
            raise ValueError('every item needs a numeric id')
        if item['id'] in seen or item['id'] >= doc['next_id']:
            raise ValueError(f'item {item["id"]}: duplicate or out-of-range id')
        seen.add(item['id'])
        if item.get('status') not in STATUSES or item.get('stage') not in STAGES:
            raise ValueError(f'item {item["id"]}: unknown status or stage')
        kinds = item.get('evidence_kinds')
        if not isinstance(kinds, list) or not kinds or any(k not in KINDS for k in kinds):
            raise ValueError(f'item {item["id"]}: invalid evidence kinds')
        if not isinstance(item.get('depends_on'), list) or not isinstance(item.get('history'), list):
            raise ValueError(f'item {item["id"]}: depends_on and history must be lists')
        if not isinstance(item.get('evidence'), dict):
            raise ValueError(f'item {item["id"]}: evidence must be an object')
    for item in items:
        if any(dep not in seen for dep in item['depends_on']):
            raise ValueError(f'item {item["id"]}: depends on a missing item')


def parse_ledger(data):
    doc = json.loads(data.decode('utf-8'))
    validate(doc)
    return doc


def load(store):
    """Return (doc, raw bytes); refuse a missing, malformed or unsealed ledger."""
    try:
        data = store.path.read_bytes()
    except FileNotFoundError:
        if store.journal.exists():
            raise Failure(f'ledger missing: {store.path}; rebuild it with '
                          'repair --from-journal --reason "<why>"') from None
        raise Failure(f'no ledger at {store.path}; create it with init') from None
    try:
        doc = parse_ledger(data)
    except (ValueError, UnicodeError) as error:
        raise Failure(f'ledger is malformed ({error}): {store.path}; rebuild it with '
                      'repair --from-journal --reason "<why>"') from error
    try:
        sealed = store.seal.read_text().strip()
    except FileNotFoundError:
        sealed = None
    if sealed != digest(data):
        raise Failure(f'ledger was modified outside lat-ledger (seal mismatch): {store.path}; '
                      'inspect the change, then accept it with repair --reason "<why>"')
    if journal_tail_seal(store) != sealed:
        raise Failure(f'journal does not end with this ledger state (a write did not finish): '
                      f'{store.journal}; inspect the ledger, then accept it with '
                      'repair --reason "<why>"')
    return doc, data


def journal_tail_seal(store):
    """Seal of the last journal line, or None when it cannot be read."""
    try:
        with open(store.journal, 'rb') as stream:
            stream.seek(0, os.SEEK_END)
            end = position = stream.tell()
            tail = b''
            while position and tail.count(b'\n') < 2:
                position = max(0, position - 65536)
                stream.seek(position)
                tail = stream.read(end - position)
        return json.loads(tail.rstrip(b'\n').rpartition(b'\n')[2])['seal']
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save(store, doc, expected, entry):
    """Atomic replace, seal, then journal; `entry` describes the change for the journal."""
    text = serialize(doc)
    data = write_text_atomic(store.path, text, expected=expected, mode=0o644)
    sealed = digest(data)
    write_text_atomic(store.seal, sealed + '\n', mode=0o644)
    line = json.dumps(dict(entry, seal=sealed, snapshot=doc), ensure_ascii=False) + '\n'
    with open(store.journal, 'a+b') as stream:
        if stream.tell():
            stream.seek(-1, os.SEEK_END)
            if stream.read(1) != b'\n':
                line = '\n' + line  # an interrupted append left a partial line; end it
        stream.write(line.encode('utf-8'))
        stream.flush()
        os.fsync(stream.fileno())


def read_journal(store):
    """The last journal snapshot, checked against its seal; Failure when unusable.

    Earlier unreadable lines (a partial append that a later write ended) are skipped with a
    warning, since every line holds a full snapshot; the last line must be valid.
    """
    try:
        lines = store.journal.read_bytes().splitlines()  # decode per line: a cut-off
        # append may end inside a multibyte character
    except FileNotFoundError:
        raise Failure(f'journal missing: {store.journal}; the ledger cannot be rebuilt and '
                      'no empty ledger is created') from None
    except OSError as error:
        raise Failure(f'journal unreadable: {error}') from error
    if not lines:
        raise Failure(f'journal is empty: {store.journal}; the ledger cannot be rebuilt')
    try:
        entry = json.loads(lines[-1])
        snapshot = entry['snapshot']
        validate(snapshot)
        if digest(serialize(snapshot).encode('utf-8')) != entry['seal']:
            raise ValueError('snapshot does not match its seal')
    except (ValueError, KeyError, TypeError) as error:
        raise Failure(f'journal line {len(lines)} is corrupt ({error}): {store.journal}; '
                      'the ledger cannot be rebuilt and no empty ledger is created') from error
    for number, line in enumerate(lines[:-1], 1):
        try:
            json.loads(line)['seal']
        except (ValueError, KeyError, TypeError):
            print(f'lat-ledger: warning: skipped unreadable journal line {number}',
                  file=sys.stderr)
    return snapshot


@contextmanager
def transaction(args, action, item_id=None, reason=None):
    """Load under an exclusive lock, yield the document, save when the body succeeds."""
    store = Store(args.ledger)
    with locked(store, exclusive=True):
        doc, data = load(store)
        yield doc
        doc['updated_at'] = stamp(now())
        save(store, doc, data, {'at': doc['updated_at'], 'by': actor(args), 'action': action,
                                'item': item_id, 'reason': reason})


def read_only(args):
    store = Store(args.ledger)
    with locked(store, exclusive=False):
        return load(store)[0]


def find(doc, item_id):
    for item in doc['items']:
        if item['id'] == item_id:
            return item
    raise Failure(f'no item {item_id} in the ledger')


def record(args, item, action, changes, reason=None):
    """Apply {field: new} to the item and add one history entry with old -> new."""
    diff = {}
    for field, value in changes.items():
        if item.get(field) != value:
            diff[field] = [item.get(field), value]
            item[field] = value
    item['history'].append({'at': stamp(now()), 'by': actor(args), 'action': action,
                            'changes': diff, 'reason': reason})


def block_for_cancelled_dependency(args, item, why):
    """Block an open item; an item already blocked keeps its own reason after the prefix."""
    if item['status'] == 'blocked':
        if item['blocked_reason'].startswith(DEP_CANCELLED):
            return
        changes = {'blocked_reason': f'{DEP_CANCELLED}；{item["blocked_reason"]}'}
    elif item['status'] in ('unassigned', 'assigned', 'in_progress'):
        changes = {'status': 'blocked', 'blocked_from': item['status'],
                   'blocked_reason': DEP_CANCELLED}
    else:
        return
    record(args, item, 'block', changes, why)


def sync_cancelled_dependencies(args, doc, item, why):
    """Block while any dependency is cancelled; release that block once none is."""
    if any(find(doc, dep)['status'] == 'cancelled' for dep in item['depends_on']):
        block_for_cancelled_dependency(args, item, why)
    elif item['status'] == 'blocked' and item['blocked_reason'].startswith(DEP_CANCELLED):
        rest = item['blocked_reason'][len(DEP_CANCELLED) + 1:]
        if rest:
            record(args, item, 'block', {'blocked_reason': rest}, why)
        else:
            record(args, item, 'unblock', {'status': item['blocked_from'], 'blocked_from': None,
                                           'blocked_reason': None}, why)


def require_status(item, allowed, action):
    if item['status'] not in allowed:
        raise Failure(f'item {item["id"]} is {item["status"]}; {action} needs '
                      + ' or '.join(allowed))


def required_text(label, value):
    if value is None or not value.strip():
        raise Failure(f'{label} is required and must not be empty')
    return value.strip()


# ---- evidence -------------------------------------------------------------------------

def gate_script():
    return Path(os.environ.get(GATE_ENV) or
                LAT_DIR.parent / 'three-tier-testing' / 'scripts' / 'suite-gate.py')


def check_repo(path):
    """Return (absolute repo path, problem); the path must be inside a git repository."""
    if not Path(path).is_absolute():
        return None, f'--repo {path}: must be an absolute path'
    try:
        run_cli(['git', '-C', path, 'rev-parse', '--git-dir'], timeout=30)
    except ValueError:
        return None, f'--repo {path}: not a git repository'
    return str(Path(path)), None


def branch_exists(repo, branch):
    try:
        run_cli(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', f'{branch}^{{commit}}'],
                timeout=30)
        return True
    except ValueError:
        return False


def default_branches(repo):
    """The repo's default branch as the refs that exist: what origin/HEAD names, else (no
    origin/HEAD, or it names a gone ref) main or master, each local or remote-tracking."""
    try:
        head = run_cli(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short',
                        'refs/remotes/origin/HEAD'], timeout=30).strip()
        named = [head.removeprefix('origin/'), head]
    except ValueError:
        named = []
    for candidates in (named, ['main', 'master', 'origin/main', 'origin/master']):
        found = [branch for branch in candidates if branch_exists(repo, branch)]
        if found:
            return found
    return []


def reachable(repo, sha, branches):
    for branch in branches:
        try:
            run_cli(['git', '-C', repo, 'merge-base', '--is-ancestor', sha, branch], timeout=30)
            return True
        except ValueError:
            continue
    return False


def owning_checkout(path):
    """The main checkout of the repo `path` is in (a bare repo stands for itself), or None."""
    try:
        common = Path(run_cli(['git', '-C', str(path), 'rev-parse', '--path-format=absolute',
                               '--git-common-dir'], timeout=30).strip())
    except ValueError:
        return None
    return str(common.parent if common.name == '.git' else common)


def main_checkouts(doc, item):
    """Where a row's commit can still be when its repo is gone: the checkout noted at closing,
    the one holding the gone path (a task worktree under <checkout>/.worktrees, and rows closed
    before the note existed or after the removal), then the ledger's workspace."""
    places = [doc['workspace']]
    if item.get('repo'):
        existing = next((p for p in Path(item['repo']).parents if p.is_dir()), None)
        places[:0] = [item.get('main_checkout'), owning_checkout(item['repo']),
                      owning_checkout(existing)]
    return list(dict.fromkeys(place for place in places if place))


def point_at_merge_target(doc, item, branch):
    """The row's changes once its work is on `branch`, named by the orchestrator: from here on
    the row is checked there, whatever happens to its worktree and task branch. Refused unless
    every commit on the row has reached it, in a main checkout that has it."""
    commits, looked = item['evidence'].get('commit', []), []
    for place in main_checkouts(doc, item):
        if not branch_exists(place, f'refs/heads/{branch}'):
            looked.append(f'{place}: no branch {branch}')
            continue
        missing = [sha for sha in commits if not reachable(place, sha, [branch])]
        if not missing:
            return {'branch': branch, **({'repo': place} if item.get('repo') else {})}
        looked.append(f'{place}: {", ".join(missing)} is not reachable from {branch}')
    raise Failure(f'item {item["id"]} not on {branch}; checked ' + '; '.join(looked))


def verify_commit_after_removal(doc, item, value):
    """The row's repo is gone: only the integration branch of a main checkout can vouch for the
    commit, or that checkout's default branch where the name is unrecorded or not there. A
    surviving task branch does not count, since the work has not landed."""
    sha, looked = None, []
    for place in main_checkouts(doc, item):
        try:
            sha = run_cli(['git', '-C', place, 'rev-parse', '--verify', '--quiet',
                           f'{value}^{{commit}}'], timeout=30).strip()
        except ValueError:
            looked.append(f'{place}: commit {value} not found')
            continue
        integration = doc.get('integration_branch')
        branches = ([integration] if integration and branch_exists(place, integration)
                    else default_branches(place))
        if not branches:
            looked.append(f'{place}: no integration or default branch')
        elif reachable(place, sha, branches):
            return sha, None
        else:
            looked.append(f'{place}: commit {value} is not reachable from {" or ".join(branches)}')
    return sha, (f'repo {item["repo"]} no longer exists; checked ' + '; '.join(looked) +
                 f'; if the commit reached another branch, name it with `update {item["id"]} '
                 '--repo <main checkout> --branch <branch>`')


def verify_commit(doc, item, value):
    """Return (full sha, problem); the commit must reach the item or integration branch.

    A row with its own repo is checked there (once gone, see verify_commit_after_removal). The
    branches are only enforced where they exist in that repo, since the integration branch name
    belongs to the workspace. A deleted task branch with no integration branch to check leaves
    the repo's default branch."""
    workspace = item.get('repo') or doc['workspace']
    if item.get('repo') and check_repo(workspace)[1]:
        return verify_commit_after_removal(doc, item, value)
    try:
        sha = run_cli(['git', '-C', workspace, 'rev-parse', '--verify', '--quiet',
                       f'{value}^{{commit}}'], timeout=30).strip()
    except ValueError:
        return None, f'commit {value}: not found in {workspace}'
    branches = [b for b in (item.get('branch'), doc.get('integration_branch')) if b]
    if item.get('repo'):
        branches = [b for b in branches if branch_exists(workspace, b)]
        if not branches and not item.get('branch'):
            return sha, None
    elif not branches:
        return sha, f'commit {value}: no branch to check reachability (set --branch on the item)'
    hint = ''
    if not branches or (not doc.get('integration_branch')
                        and not branch_exists(workspace, item['branch'])):
        hint = (f'; task branch {item["branch"]} no longer exists, name the branch the commit '
                f'reached with `update {item["id"]} --branch <branch>`')
        branches = default_branches(workspace)
        if not branches:
            return sha, f'commit {value}: no default branch found in {workspace}{hint}'
    if reachable(workspace, sha, branches):
        return sha, None
    return sha, f'commit {value} is not reachable from {" or ".join(branches)} in {workspace}{hint}'


def verify_gate(doc, value, acks=()):
    """Return (full fingerprint, problem). A record whose newest run passed only on the
    automatic rerun of failed test files is not clean evidence until a recorded review
    acknowledges it (acks: the fingerprints review results named, see rerun_acks())."""
    script = gate_script()
    try:
        output = run_cli([sys.executable, str(script), 'status', '--json', '--fingerprint',
                          value, '--limit', '100000'], timeout=60,
                         failure='suite-gate status failed')
        records = json.loads(output)['records']
    except (ValueError, KeyError, TypeError) as error:
        return None, f'gate record {value}: lookup failed ({error})'
    found = {r.get('fingerprint') or r.get('reused_fingerprint') for r in records
             if isinstance(r, dict)} - {None}
    if value not in found and len(found) > 1:
        return None, f'gate record {value}: prefix matches several fingerprints; give it in full'
    if not found:
        return None, f'gate record {value}: no suite-gate record with this fingerprint'
    full = value if value in found else found.pop()
    ran = [r for r in records if isinstance(r, dict) and r.get('fingerprint') == full
           and r.get('kind') != 'reuse']
    return full, ran and rerun_only_problem(full, ran[-1], acks)


def rerun_only_problem(fingerprint, record, acks):
    """Why a record that passed only on the rerun is refused, or None when it did not, or an
    acknowledged fingerprint in acks is a prefix of it."""
    if record.get('exit_code') != 0 or not (record.get('rerun_only') or record.get('flaky')):
        return None
    if any(fingerprint.startswith(ack) for ack in acks):
        return None
    files = ', '.join(str(f.get('file')) for f in record.get('flaky') or []) or 'not recorded'
    return (f'gate record {fingerprint[:12]} PASSED ONLY ON RERUN (failed first: {files}), so '
            'it is not clean evidence: a reviewer must look at those failures, then record it '
            'on this row with `review-result --row <row> '
            f'--reviewer <name> --clean --rerun-ack {fingerprint[:12]} --note "<what the '
            'failures were>"`. Or fix the failing test so the gate passes at the first try')


def rerun_acks(doc, row=None):
    """The gate fingerprints (12+ characters) the recorded reviews acknowledge as looked-at
    rerun-only passes; only the reviews of that row when row is given."""
    return [ack for review in doc.get('reviews') or [] if isinstance(review, dict)
            and (row is None or review.get('row') == row)
            for ack in review.get('rerun_acks') or [] if isinstance(ack, str) and len(ack) >= 12]


def verify_file(value):
    path = Path(value)
    if not path.is_absolute():
        return None, f'file {value}: must be an absolute path'
    try:
        if not path.is_file():
            return None, f'file {value}: does not exist or is not a file'
        if path.stat().st_size == 0:
            return None, f'file {value}: is empty'
    except OSError as error:
        return None, f'file {value}: {error}'
    return str(path), None


def verify(doc, item, evidence):
    """Check every value; return (resolved evidence, problems)."""
    acks = rerun_acks(doc, item['id'])
    resolved, problems = {}, []
    for kind in KINDS:
        for value in evidence.get(kind, []):
            if kind == 'commit':
                full, problem = verify_commit(doc, item, value)
            elif kind == 'gate':
                full, problem = verify_gate(doc, value, acks)
            else:
                full, problem = verify_file(value)
            if problem:
                problems.append(problem)
            else:
                resolved.setdefault(kind, []).append(full)
    return resolved, problems


# ---- task card ------------------------------------------------------------------------

def card_status(path):
    if not path:
        return None, 'no task card'
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None, f'task card unreadable: {path}'
    for line in text.splitlines():
        match = CARD_FIELD.fullmatch(line.strip())
        if match and match.group(1).strip().lower() == 'status':
            return match.group(2).strip(), None
    return None, f'task card has no status: {path}'


def card_mismatch(item):
    if item['status'] in ('unassigned', 'cancelled'):
        return None
    status, problem = card_status(item.get('card'))
    if problem:
        return problem
    closed = status in CARD_CLOSED
    if item['status'] == 'done' and not closed:
        return f'card says {status}, ledger says done'
    if item['status'] != 'done' and closed:
        return f'card says {status}, ledger says {item["status"]}'
    return None


def update_card(item, resolved):
    """Mirror a close into the task card."""
    commits = resolved.get('commit')
    values = {}
    if card_status(item.get('card'))[0] not in CARD_CLOSED:  # a closed card (e.g. merged) keeps its status
        values['status'] = 'committed' if commits else 'completed'
    if commits:
        values['deliverable commit'] = ', '.join(commits)
    write_card_fields(item, values)


def write_card_fields(item, values):
    """Set the card's fields; a failure only warns (the ledger is authoritative)."""
    path = item.get('card')
    if not path:
        return
    try:
        text = Path(path).read_text(encoding='utf-8')
        lines = text.splitlines(keepends=True)
        for index, line in enumerate(lines):
            match = CARD_FIELD.fullmatch(line.strip())
            if match and match.group(1).strip().lower() in values:
                key = match.group(1).strip()
                ending = '\n' if line.endswith('\n') else ''
                lines[index] = f'- {key}：{values.pop(key.lower())}{ending}'
        write_text_atomic(path, ''.join(lines), expected=text.encode('utf-8'))
    except (OSError, UnicodeError, ValueError) as error:
        print(f'lat-ledger: warning: task card not updated: {error}', file=sys.stderr)


# ---- actual model and effort ------------------------------------------------------------
#
# What an agent really runs on is read when its row is assigned (`card bind` assigns it),
# again at `done`, and for each reviewer when a review result is recorded:
#   1. `hcom list <name> --json` (supported command): the client (`tool`), the session's
#      `transcript_path` and the model of the latest reply (`usage.model`). HCOM keeps no effort.
#   2. That transcript's latest turn: the model and effort it ran with (HCOM's model only when
#      the transcript has no turn yet). Only the end of the file is read (TRANSCRIPT_TAIL_BYTES).
#   3. Whatever is still missing comes from the task card's model field (what the orchestrator
#      meant to use), and the reading is marked unverified. A native sub-agent has no HCOM name
#      to look up, so its reading is always unverified.

def card_setting(path):
    """(model, effort) from a task card's `model` field, e.g. "gpt-6-astra medium"; the effort
    is its last word when that is an effort level. (None, None) without a card or field."""
    if not path:
        return None, None
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None, None
    for line in text.splitlines():
        match = CARD_FIELD.fullmatch(line.strip())
        if match and match.group(1).strip().lower() == 'model':
            words = match.group(2).split()
            if words and words[-1].lower() in EFFORTS:
                return ' '.join(words[:-1]) or None, words[-1].lower()
            return ' '.join(words) or None, None
    return None, None


def hcom_agent(name):
    """`hcom list <name> --json` as a dict; ValueError when HCOM cannot answer for `name`. In
    tests the HCOM_AGENTS_ENV file stands in, and a test that stands in only for the agent list
    gets no live HCOM answer either."""
    fake = os.environ.get(HCOM_AGENTS_ENV)
    if fake:
        try:
            details = json.loads(Path(fake).read_text()).get(name)
        except (OSError, ValueError, AttributeError) as error:
            raise ValueError(f'hcom agent details unreadable: {error}') from error
    elif os.environ.get(HCOM_LIST_ENV):
        raise ValueError('hcom agent details have no stand-in in this test')
    else:
        details = json.loads(run_cli(['hcom', 'list', name, '--json'], timeout=30,
                                     failure='hcom list failed'))
    if not isinstance(details, dict):
        raise ValueError(f'hcom has no agent {name}')
    return details


def transcript_settings(client, path):
    """{model, effort} of the latest turn in the end of a Claude or Codex transcript; None when
    it has none or cannot be read."""
    if client not in ('claude', 'codex') or not isinstance(path, str) or not path:
        return None
    try:
        with open(path, 'rb') as stream:
            size = stream.seek(0, os.SEEK_END)
            stream.seek(max(0, size - TRANSCRIPT_TAIL_BYTES))
            lines = stream.read().split(b'\n')
    except OSError:
        return None
    if size > TRANSCRIPT_TAIL_BYTES:
        lines = lines[1:]  # starts inside a line
    records = []
    for line in lines[:-1]:  # the last line may still be being written
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return current_settings(client, records)


def read_settings(name, card=None, native=False):
    """One reading of what agent `name` runs on: client, model, effort, where each came from,
    whether it is verified (model and effort both read live) and why not."""
    live, problem = {}, None
    if native:
        problem = 'native sub-agent without an HCOM name'
    else:
        try:
            details = hcom_agent(name)
            client = details.get('tool') if isinstance(details.get('tool'), str) else None
            usage = details.get('usage') if isinstance(details.get('usage'), dict) else {}
            latest = transcript_settings(client, details.get('transcript_path')) or {}
            live = {'client': client,
                    # The latest turn's model goes with its effort; HCOM's may still name
                    # the reply before a model switch, so it only fills a gap.
                    'model': (('transcript', latest['model']) if latest.get('model') else
                              ('hcom', usage.get('model') if isinstance(usage.get('model'), str)
                               else None)),
                    'effort': ('transcript', latest.get('effort'))}
        except ValueError as error:
            problem = ' '.join(str(error).split())
    intended = dict(zip(('model', 'effort'), card_setting(card)))
    reading = {'client': live.get('client'), 'native': native, 'at': stamp(now())}
    sources = {}
    for field in ('model', 'effort'):
        source, value = live.get(field, (None, None))
        if not value:
            source, value = ('card', intended[field]) if intended[field] else (None, None)
        reading[field], sources[field] = value, source
    reading['sources'] = sources
    reading['verified'] = all(sources[field] in ('hcom', 'transcript')
                              for field in ('model', 'effort'))
    if not reading['verified']:
        reading['problem'] = problem or 'HCOM and the transcript lack ' + ' and '.join(
            field for field in ('model', 'effort') if sources[field] not in ('hcom', 'transcript'))
    return reading


def settings_text(first, last=None):
    """"model・effort", "model・low→high" when two verified readings differ, with 未查證 when
    the latest reading is not verified."""
    first, last = first or last, last or first
    if not last:
        return ''
    parts = []
    for field in ('model', 'effort'):
        value = last.get(field) or '?'
        if (first is not last and first.get('verified') and last.get('verified')
                and first.get(field) != last.get(field)):
            value = f'{first.get(field) or "?"}→{value}'
        parts.append(value)
    text = '・'.join(parts) if any(last.get(field) for field in ('model', 'effort')) else ''
    if not last.get('verified'):
        text = f'{text}（{UNVERIFIED}）' if text else UNVERIFIED
    return text


def row_settings_text(item):
    actual = item.get('actual') or {}
    return settings_text(actual.get('bind'), actual.get('done')) if actual else ''


def settings_changes(first, last):
    """{field: [at bind, at done]} for the fields that differ between two readings."""
    return {field: [first.get(field), last.get(field)]
            for field in ('client', 'model', 'effort', 'verified')
            if first.get(field) != last.get(field)}


# ---- commands -------------------------------------------------------------------------

def cmd_init(args):
    store = Store(args.ledger)
    workspace = Path(args.workspace)
    if not workspace.is_absolute() or not workspace.is_dir():
        raise Failure(f'--workspace must be an existing absolute directory: {workspace}')
    with locked(store, exclusive=True):
        existing = [p for p in (store.path, store.seal, store.journal) if p.exists()]
        if existing:
            raise Failure(f'ledger already exists ({existing[0]}); init never overwrites it')
        at = stamp(now())
        doc = {'version': VERSION, 'workspace': str(workspace),
               'integration_branch': args.integration_branch, 'orchestrator': args.orchestrator,
               'created_at': at, 'updated_at': at, 'next_id': 1, 'items': [],
               'qa_coverage': True,  # ledgers made before this rule lack it and skip the rule
               'problem_gates': True,  # likewise: done needs findings or a review (#549)
               'history': [{'at': at, 'by': actor(args), 'action': 'init', 'reason': None}]}
        save(store, doc, None, {'at': at, 'by': actor(args), 'action': 'init', 'item': None,
                                'reason': None})
    print(store.path)


def check_round(path):
    """Refuse a `<session>-r<N>.json` ledger that is not the round ledger its session record
    (`.lat/sessions/<session>.json` beside `.lat/ledgers/`) names."""
    path = Path(path)
    name = ROUND_LEDGER.fullmatch(path.name)
    if not name:
        return
    try:
        record = json.loads((path.parent.parent / 'sessions' / f'{name[1]}.json').read_text())
        current = record['ledger_path']
        if not isinstance(current, str) or not current:
            return
    except (OSError, ValueError, KeyError, TypeError):
        return
    if Path(current).resolve() != path.resolve():
        raise Failure(f'{path} is not this round\'s ledger; the session record names {current}. '
                      'Add the row there, or pass --old-round to add it to this older round '
                      'on purpose')


def cmd_add(args):
    if not args.old_round:
        check_round(args.ledger)
    kinds = kinds_of(args.evidence)
    ticket = required_text('--ticket', args.ticket)
    if args.tiny or args.no_feature or args.no_format_change:
        if not (args.tiny and args.no_feature and args.no_format_change):
            raise Failure('the tiny lane needs --tiny with both declarations, --no-feature and '
                          '--no-format-change; nothing written')
        refs = ticket_refs(ticket)
        if len(refs) != 1 or not next(iter(refs))[1].startswith('#'):
            raise Failure(f'the tiny lane covers exactly one numbered ticket; --ticket {ticket!r} '
                          'names another set, so dispatch it in the normal flow; nothing written')
    title = args.title.strip() if args.title and args.title.strip() else None
    ignore_deadline(args)
    repo = None
    if args.repo:
        repo, problem = check_repo(args.repo)
        if problem:
            raise Failure(problem)
    # The tracker is read outside the lock, and only for tickets never asked before.
    before = read_only(args)
    keys = ticket_keys(ticket, tracker_repo(before['workspace']))
    fetched = {} if title else fetch_titles(
        [key for key in keys if key not in before.get('titles', {})])
    with transaction(args, 'add') as doc:
        titles = doc.setdefault('titles', {})
        for key in keys:
            if title:
                titles[key] = title
            elif key in fetched and key not in titles:
                titles[key] = fetched[key]
        known = {item['id'] for item in doc['items']}
        deps = item_ids(args.depends) if args.depends else []
        missing = [d for d in deps + ([args.follows] if args.follows else []) if d not in known]
        if missing:
            raise Failure(f'unknown item(s): {", ".join(map(str, missing))}')
        at = now()
        item = {'id': doc['next_id'], 'ticket': ticket, 'stage': args.stage, 'agent': None,
                'card': None, 'branch': args.branch, 'repo': repo, 'status': 'unassigned',
                'depends_on': deps, 'follows': args.follows, 'assigned_at': None,
                'started_at': None, 'estimate': None, 'deadline': None,
                'evidence_kinds': kinds, 'evidence': {}, 'progress': None,
                'blocked_reason': None, 'blocked_from': None, 'cancel_reason': None,
                'history': []}
        default_repo = tracker_repo(doc['workspace'])
        same = [row for row in doc['items']
                if ticket_keys(row['ticket'], default_repo) == keys]
        mark = ({'declared': TINY_DECLARED, 'by': actor(args), 'at': stamp(at)} if args.tiny
                else next((row['tiny'] for row in same if row.get('tiny')), None))
        if mark:
            item['tiny'] = mark
        doc['next_id'] += 1
        doc['items'].append(item)
        item['history'].append({'at': stamp(at), 'by': actor(args), 'action': 'add',
                                'changes': {'status': [None, 'unassigned']}, 'reason': None})
        for row in same if args.tiny else []:
            record(args, row, 'tiny', {'tiny': mark}, 'its ticket was marked tiny')
        sync_cancelled_dependencies(args, doc, item, 'depends on a cancelled item')
    print(item['id'])


def cmd_assign(args):
    agent = required_text('--agent', args.agent)
    card = required_text('--card', args.card)
    ignore_deadline(args)
    reading = read_settings(agent, card, args.native)  # HCOM is asked outside the lock
    with transaction(args, 'assign', args.id) as doc:
        item = find(doc, args.id)
        require_status(item, ('unassigned',), 'assign')
        record(args, item, 'assign', {'status': 'assigned', 'agent': agent, 'card': card,
                                      'assigned_at': stamp(now())})
        item['actual'] = {'bind': reading}


def cmd_start(args):
    with transaction(args, 'start', args.id) as doc:
        item = find(doc, args.id)
        require_status(item, ('assigned',), 'start')
        at = now()
        estimate = stamp(parse_time(args.eta, at))
        record(args, item, 'start', {'status': 'in_progress', 'started_at': stamp(at),
                                     'estimate': estimate, 'deadline': deadline_for(estimate)})


def cmd_update(args):
    reason = args.reason.strip() if args.reason else None
    ignore_deadline(args)
    if (args.eta or args.depends is not None) and not reason:
        raise Failure('--reason is required when changing --eta or --depends')
    if not any((args.eta, args.progress, args.card, args.branch, args.repo,
                args.merged_into, args.depends is not None)):
        raise Failure('nothing to update; give --eta, --progress, --card, --branch, '
                      '--repo, --merged-into or --depends')
    with transaction(args, 'update', args.id, reason) as doc:
        item = find(doc, args.id)
        if args.eta or args.progress:
            if item['status'] == 'done':
                raise Failure(f'item {item["id"]} is done; to note a later change or replace '
                              'its evidence, use amend')
            require_status(item, OPEN, 'update')
        elif args.depends is not None:
            require_status(item, ('unassigned',) + OPEN, 'update --depends')
        at = now()
        changes = {}
        if args.eta:
            if item['status'] != 'in_progress':
                raise Failure(f'item {item["id"]} is {item["status"]}; --eta needs in_progress')
            changes['estimate'] = stamp(parse_time(args.eta, at))
            changes['deadline'] = deadline_for(changes['estimate'])
        if args.progress:
            changes['progress'] = args.progress.strip()
        if args.card:
            changes['card'] = args.card
        if args.branch:
            changes['branch'] = args.branch
        if args.repo:
            changes['repo'], problem = check_repo(args.repo)
            if problem:
                raise Failure(problem)
        if args.merged_into:
            changes.update(point_at_merge_target(doc, item, args.merged_into))
        if args.depends is not None:
            deps = item_ids(args.depends)
            known = {other['id'] for other in doc['items']}
            if any(d not in known or d == item['id'] for d in deps):
                raise Failure(f'--depends names an unknown item or the item itself: {args.depends}')
            changes['depends_on'] = deps
        record(args, item, 'update', changes, reason)
        if args.depends is not None:
            sync_cancelled_dependencies(args, doc, item, 'dependencies changed')


def cmd_block(args):
    reason = required_text('--reason', args.reason)
    with transaction(args, 'block', args.id, reason) as doc:
        item = find(doc, args.id)
        require_status(item, ('unassigned', 'assigned', 'in_progress'), 'block')
        record(args, item, 'block', {'status': 'blocked', 'blocked_from': item['status'],
                                     'blocked_reason': reason}, reason)


def cmd_unblock(args):
    with transaction(args, 'unblock', args.id, args.reason) as doc:
        item = find(doc, args.id)
        require_status(item, ('blocked',), 'unblock')
        cancelled = [d for d in item['depends_on'] if find(doc, d)['status'] == 'cancelled']
        if cancelled:
            raise Failure(f'item {item["id"]} still depends on cancelled item(s) '
                          f'{", ".join(map(str, cancelled))}; change them with update --depends')
        # The deadline follows the current estimate again (older ledgers stored a hand-set one).
        record(args, item, 'unblock', {'status': item['blocked_from'], 'blocked_from': None,
                                       'blocked_reason': None,
                                       'deadline': deadline_for(item['estimate'])}, args.reason)


def cmd_done(args):
    given = {'commit': args.commit or [], 'gate': args.gate or [], 'file': args.file or []}
    before = find(read_only(args), args.id)
    reading = done_reading(before)  # HCOM is asked outside the lock
    with transaction(args, 'done', args.id) as doc:
        item = find(doc, args.id)
        require_status(item, ('assigned', 'in_progress'), 'done')
        if (item['agent'], item.get('card')) != (before['agent'], before.get('card')):
            raise Failure(f'item {item["id"]} was reassigned meanwhile; rerun done')
        changes = {'status': 'done'}
        if args.repo:
            repo, problem = check_repo(args.repo)
            if problem:
                raise Failure(f'item {item["id"]} not closed:\n  - {problem}')
            changes['repo'] = repo
        problems = [f'{kind} evidence is required for this item' for kind in
                    item['evidence_kinds'] if not given[kind]]
        problems += [f'{kind} evidence was not declared for this item' for kind in KINDS
                     if given[kind] and kind not in item['evidence_kinds']]
        resolved, failed = verify(doc, {**item, **changes}, {kind: given[kind]
                                                              for kind in item['evidence_kinds']})
        problems += failed
        if doc.get('problem_gates') or args.no_findings:
            gate = done_gate_problem(doc, item, args.no_findings, read_problems(doc),
                                     str(Path(args.ledger)))
            if gate:
                problems.append(gate)
        if args.no_findings:
            changes['no_findings'] = True
        if problems:
            raise Failure(f'item {item["id"]} not closed:\n' +
                          '\n'.join(f'  - {problem}' for problem in problems))
        changes['evidence'] = resolved
        repo = changes.get('repo') or item.get('repo')
        if repo:
            changes['main_checkout'] = owning_checkout(repo)
        record(args, item, 'done', changes)
        record_done_settings(args, item, reading)
    update_card(item, resolved)
    print(f'item {item["id"]} closed')


def done_reading(item):
    """The row's agent read again for done (a native agent stays native); None when the row
    has no agent, which done refuses anyway."""
    if not item.get('agent'):
        return None
    bind = (item.get('actual') or {}).get('bind')
    return read_settings(item['agent'], item.get('card'), bool(bind and bind.get('native')))


def record_done_settings(args, item, reading):
    """Store the done reading; a difference from the bind reading goes into the row's
    history. Rows assigned before readings existed get only the done reading."""
    actual = item.get('actual') or {}
    bind = actual.get('bind')
    actual['done'] = reading
    item['actual'] = actual
    changes = settings_changes(bind, actual['done']) if bind else {}
    if changes:
        item['history'].append({'at': actual['done']['at'], 'by': actor(args),
                                'action': 'settings', 'changes': changes,
                                'reason': 'actual settings at done differ from those at bind'})


def cmd_amend(args):
    reason = required_text('--reason', args.reason)
    given = {'commit': args.commit or [], 'gate': args.gate or [], 'file': args.file or []}
    with transaction(args, 'amend', args.id, reason) as doc:
        item = find(doc, args.id)
        require_status(item, ('done',), 'amend')
        problems = [f'{kind} evidence was not declared for this item' for kind in KINDS
                    if given[kind] and kind not in item['evidence_kinds']]
        resolved, failed = verify(doc, item, given)
        problems += failed
        if problems:
            raise Failure(f'item {item["id"]} not amended:\n' +
                          '\n'.join(f'  - {problem}' for problem in problems))
        record(args, item, 'amend', {'progress': f'補記：{reason}',
                                     'evidence': {**item['evidence'], **resolved}}, reason)
    if resolved.get('commit'):
        # Only the version changed: a card already marked merged stays merged.
        write_card_fields(item, {'deliverable commit': ', '.join(resolved['commit'])})
    print(f'item {item["id"]} amended')


def cmd_review_result(args):
    """Record one review of a row and a participant entry per reviewer with what that reviewer
    runs on, read now. A name HCOM does not list (a native sub-agent) is kept as given and its
    setting is unverified. A review either is --clean or names its findings, each of which
    becomes a review-stage problem in the project's problem log, found by the reviewers."""
    findings = [parse_finding(text) for text in args.finding or []]
    if args.clean == bool(findings):
        raise Failure('give either --clean or at least one --finding "<甲|乙|丙>:<one line>"; '
                      'nothing written')
    note = args.note.strip() if args.note and args.note.strip() else None
    acks = [required_text('--rerun-ack', ack).lower() for ack in args.rerun_ack or []]
    bad = [ack for ack in acks if not re.fullmatch(r'[0-9a-f]{12,64}', ack)]
    if bad:
        raise Failure(f'--rerun-ack {bad[0]}: give 12 to 64 hex characters of the gate record '
                      'fingerprint; nothing written')
    if acks and not note:
        raise Failure('--rerun-ack needs --note saying what the first failures were; nothing '
                      'written')
    tiny = (tiny_confirmation(args, read_only(args)) if args.tiny_confirm or args.tiny_hints
            else None)
    try:
        agents = {item['name'] for item in read_hcom_list(HCOM_LIST_ENV)
                  if isinstance(item.get('name'), str)}
    except ValueError as error:
        print(f'lat-ledger: warning: {error}; reviewers are kept as given, {UNVERIFIED}',
              file=sys.stderr)
        agents = set()
    reviewers = []
    for given in args.reviewer:
        given = required_text('--reviewer', given)
        try:
            name = resolve_agent_name(agents, given, required=False)
        except ValueError as error:
            raise Failure(f'--reviewer: {error}; nothing written') from None
        if name not in agents and agents:
            print(f'lat-ledger: warning: HCOM lists no agent {given}; kept as given, '
                  f'{UNVERIFIED}', file=sys.stderr)
        if name not in reviewers:
            reviewers.append(name)
    readings = {name: read_settings(name, native=name not in agents)  # outside the lock
                for name in reviewers}
    with transaction(args, 'review-result', args.row) as doc:
        item = find(doc, args.row)
        if item['status'] == 'cancelled':
            raise Failure(f'item {item["id"]} is cancelled; no review to record')
        ticket = finding_ticket(doc, item, args.ticket) if findings else None
        reviews = doc.setdefault('reviews', [])
        review = {'id': len(reviews) + 1, 'row': item['id'], 'at': stamp(now()),
                  'by': actor(args), 'result': 'findings' if findings else 'clean',
                  'reviewers': reviewers, 'note': note}
        if acks:
            review['rerun_acks'] = list(dict.fromkeys(acks))
        if tiny:
            review['tiny'] = tiny
        if findings:
            # Written before the ledger is saved: a failed save leaves problems without their
            # review, never a review naming problems that are not there.
            review['problems'] = append_problems(doc, args, [
                {'ticket': ticket, 'stage': 'review', 'finder': ','.join(reviewers),
                 'level': level, 'text': text, 'caught': False, 'gate': None,
                 'row': item['id'], 'review': review['id']} for level, text in findings])
        reviews.append(review)
        for name in reviewers:
            reading = readings[name]
            doc.setdefault('participants', []).append({
                'stage': 'review', 'name': name, 'row': item['id'], 'review': review['id'],
                **{key: reading[key] for key in ('client', 'model', 'effort', 'verified',
                                                 'sources', 'at')},
                **({'problem': reading['problem']} if 'problem' in reading else {})})
    print(f'review {review["id"]} of item {item["id"]} recorded: '
          + '; '.join(f'{p["name"]} {settings_text(p)}' for p in doc['participants']
                      if p['review'] == review['id'])
          + (f'; problems {", ".join(review["problems"])}' if findings else ''))


# ---- problem log ----------------------------------------------------------------------
# One append-only file per project (beside the ledgers in the shared .lat), written only here.
# A `record` line gives a problem its id; later `update` lines add a resolution or correct
# fields by that id. Reads collapse the lines by id, keeping each line as history, so every
# count is by problem id.

def problems_path(doc):
    return shared_lat_dir(doc['workspace']) / PROBLEMS_FILE


def parse_finding(text):
    level, sep, line = (text or '').partition(':')
    if not sep:
        level, sep, line = text.partition('：')
    if level.strip() not in LEVELS or not line.strip():
        raise Failure(f'--finding {text!r}: write it as "<甲|乙|丙>:<one line>"; nothing written')
    return level.strip(), one_line('--finding', line)


def one_line(label, text):
    text = required_text(label, text)
    if '\n' in text:
        raise Failure(f'{label} must be one line')
    return text


def read_problem_lines(path):
    try:
        raw = path.read_bytes().splitlines()
    except FileNotFoundError:
        return []
    lines = []
    for number, line in enumerate(raw, 1):
        try:
            entry = json.loads(line)
            if not isinstance(entry, dict) or not isinstance(entry.get('id'), str):
                raise ValueError('not a problem line')
            lines.append(entry)
        except (ValueError, UnicodeError):
            print(f'lat-ledger: warning: skipped unreadable line {number} of {path}',
                  file=sys.stderr)
    return lines


def collapse_problems(lines):
    """{id: problem} in recording order: the record line's fields with each update applied,
    the resolution of the latest update that gave one, and every line as history."""
    problems = {}
    for line in lines:
        if line.get('op') == 'record':
            if line['id'] in problems:
                continue  # an id is given once; a repeat would be a hand edit
            problem = {key: value for key, value in line.items() if key != 'op'}
            problem.update(resolution=None, history=[line])
            problems[line['id']] = problem
        elif line.get('op') == 'update' and line['id'] in problems:
            problem = problems[line['id']]
            problem.update(line.get('changes') or {})
            if line.get('resolution'):
                problem['resolution'] = line['resolution']
            problem['history'].append(line)
    return problems


@contextmanager
def problem_log(doc, exclusive):
    path = problems_path(doc)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_name(path.name + '.lock'), 'a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
        yield path


def read_problems(doc):
    """The project's problems, collapsed; empty when its log does not exist yet."""
    if not problems_path(doc).exists():
        return {}
    with problem_log(doc, exclusive=False) as path:
        return collapse_problems(read_problem_lines(path))


def write_problem_lines(path, lines):
    data = ''.join(json.dumps(line, ensure_ascii=False) + '\n' for line in lines)
    with open(path, 'a+b') as stream:
        if stream.tell():
            stream.seek(-1, os.SEEK_END)
            if stream.read(1) != b'\n':
                data = '\n' + data  # an interrupted append left a partial line; end it
        stream.write(data.encode('utf-8'))
        stream.flush()
        os.fsync(stream.fileno())


def candidate_number(doc, ticket):
    """Which candidate of the ticket a problem is found on: one per delivery of its impl rows
    (a done, or an amend that replaced the commit), plus the one an open impl row is making.
    None when the ticket has no impl row in this ledger."""
    default_repo = tracker_repo(doc['workspace'])
    rows = [item for item in doc['items'] if item['stage'] == 'impl'
            and ticket in ticket_keys(item['ticket'], default_repo)]
    if not rows:
        return None
    deliveries = sum(1 for row in rows for entry in row['history']
                     if entry.get('action') == 'done' or (
                         entry.get('action') == 'amend'
                         and 'commit' in ((entry.get('changes') or {}).get('evidence') or
                                          [{}, {}])[1]
                         and (entry['changes']['evidence'][0] or {}).get('commit')
                         != entry['changes']['evidence'][1].get('commit')))
    return max(1, deliveries + any(row['status'] in OPEN for row in rows))


def append_problems(doc, args, entries):
    """Give each entry the next id and append it as a record line; returns the ids."""
    at = stamp(now())
    with problem_log(doc, exclusive=True) as path:
        known = {line['id'] for line in read_problem_lines(path) if line.get('op') == 'record'}
        number = max((int(key[1:]) for key in known if re.fullmatch(r'P\d+', key)), default=0)
        lines = []
        for entry in entries:
            number += 1
            lines.append({'op': 'record', 'id': f'P{number}', 'at': at, 'by': actor(args),
                          'ledger': str(Path(args.ledger)), **entry,
                          'candidate': candidate_number(doc, entry['ticket'])})
        write_problem_lines(path, lines)
    return [line['id'] for line in lines]


def finding_ticket(doc, item, given):
    """The one canonical ticket a problem found on this row belongs to."""
    keys = ticket_keys(item['ticket'], tracker_repo(doc['workspace']))
    if given:
        wanted = ticket_keys(given, tracker_repo(doc['workspace']))
        if len(wanted) != 1 or wanted[0] not in keys:
            raise Failure(f'--ticket {given}: item {item["id"]} covers {", ".join(keys)}; '
                          'name one of them')
        return wanted[0]
    if len(keys) > 1:
        raise Failure(f'item {item["id"]} covers {", ".join(keys)}; say which ticket the '
                      'problem belongs to with --ticket')
    return keys[0]


def ledger_tickets(doc):
    default_repo = tracker_repo(doc['workspace'])
    return {key for item in doc['items'] for key in ticket_keys(item['ticket'], default_repo)}


def problem_ticket(doc, given, stage, row):
    """The canonical ticket for `problem`: the row's (one of them with --ticket); else a ticket
    of this ledger, or for a problem found after merging any ticket of the project or 不明."""
    if row is not None:
        return finding_ticket(doc, row, given)
    given = required_text('--ticket', given)
    if given == UNKNOWN_TICKET:
        if stage not in LATE_STAGES:
            raise Failure(f'--ticket {UNKNOWN_TICKET} is only for problems found after merging '
                          f'({", ".join(LATE_STAGES)})')
        return given
    keys = ticket_keys(given, tracker_repo(doc['workspace']))
    if len(keys) != 1:
        raise Failure(f'--ticket {given}: name exactly one ticket')
    if stage not in LATE_STAGES and keys[0] not in ledger_tickets(doc):
        raise Failure(f'--ticket {given}: no row of this ledger covers {keys[0]}')
    return keys[0]


def caught_gate(doc, value):
    """(True, full fingerprint) for --caught, (False, None) without it."""
    if value is None:
        return False, None
    full, problem = verify_gate(doc, required_text('--caught', value), acks=[value])
    if problem:
        raise Failure(f'--caught: {problem}; nothing written')
    return True, full


def cmd_problem(args):
    """Record one problem: which ticket, the stage it was found in, who found it, its level and
    one line; with --caught, the gate record of the test run that caught it."""
    doc = read_only(args)
    if args.stage == 'review':
        raise Failure('review findings are recorded with review-result --row <impl row> '
                      '--reviewer <name> --finding "<level>:<one line>"; nothing written')
    if args.stage in LATE_STAGES and doc.get('orchestrator') and not same_controller(
            doc['orchestrator'], actor(args)):
        raise Failure(f'problems found after merging are recorded by the orchestrator '
                      f'{doc["orchestrator"]}; nothing written')
    row = find(doc, args.row) if args.row is not None else None
    ticket = problem_ticket(doc, args.ticket, args.stage, row)
    caught, gate = caught_gate(doc, args.caught)
    entry = {'ticket': ticket, 'stage': args.stage,
             'finder': one_line('--finder', args.finder) if args.finder else actor(args),
             'level': args.level, 'text': one_line('--text', args.text), 'caught': caught,
             'gate': gate, 'row': row['id'] if row else None, 'review': None}
    [problem_id] = append_problems(doc, args, [entry])
    print(problem_id)


def resolution_of(args, doc):
    if args.fixed:
        repo = args.repo or doc['workspace']
        try:
            sha = run_cli(['git', '-C', repo, 'rev-parse', '--verify', '--quiet',
                           f'{args.fixed}^{{commit}}'], timeout=30).strip()
        except ValueError:
            raise Failure(f'--fixed {args.fixed}: no such commit in {repo}; give the repo it '
                          'is in with --repo') from None
        return {'kind': 'fixed', 'commit': sha}
    if args.known_limit:
        return {'kind': 'known-limit'}
    if args.wontfix:
        return {'kind': 'wontfix', 'reason': one_line('--wontfix', args.wontfix)}
    if args.new_ticket:
        keys = ticket_keys(args.new_ticket, tracker_repo(doc['workspace']))
        if len(keys) != 1 or not keys[0].rpartition('#')[2].isdigit():
            raise Failure(f'--new-ticket {args.new_ticket}: name one numbered ticket')
        return {'kind': 'new-ticket', 'ticket': keys[0]}
    return None


def cmd_problem_update(args):
    """Add a resolution to a problem, or correct its fields (with --reason), by its id."""
    doc = read_only(args)
    problem_id = args.problem if args.problem.startswith('P') else f'P{args.problem}'
    resolution = resolution_of(args, doc)
    changes = {}
    if args.level:
        changes['level'] = args.level
    if args.text:
        changes['text'] = one_line('--text', args.text)
    if args.finder:
        changes['finder'] = one_line('--finder', args.finder)
    if args.stage:
        changes['stage'] = args.stage
    if args.caught:
        changes['caught'], changes['gate'] = caught_gate(doc, args.caught)
    if not resolution and not changes and not args.ticket:
        raise Failure('nothing to record; give a resolution (--fixed, --known-limit, '
                      '--wontfix, --new-ticket) or a correction (--level, --text, --finder, '
                      '--stage, --ticket, --caught)')
    reason = args.reason.strip() if args.reason and args.reason.strip() else None
    with problem_log(doc, exclusive=True) as path:
        problems = collapse_problems(read_problem_lines(path))
        if problem_id not in problems:
            raise Failure(f'no problem {problem_id} in {path}')
        problem = problems[problem_id]
        if args.ticket:
            changes['ticket'] = problem_ticket(doc, args.ticket, changes.get('stage',
                                                                             problem['stage']),
                                               None)
        if changes and not reason:
            raise Failure('a correction needs --reason saying what was wrong; nothing written')
        stage = changes.get('stage', problem['stage'])
        if (stage == 'review') != (problem['stage'] == 'review'):
            raise Failure('review findings stay review findings: they belong to a review '
                          'result; nothing written')
        if stage in LATE_STAGES and changes.get('stage') and doc.get('orchestrator') and \
                not same_controller(doc['orchestrator'], actor(args)):
            raise Failure(f'problems found after merging are recorded by the orchestrator '
                          f'{doc["orchestrator"]}; nothing written')
        if changes.get('ticket', problem['ticket']) == UNKNOWN_TICKET and stage not in LATE_STAGES:
            raise Failure(f'{UNKNOWN_TICKET} is only for problems found after merging')
        line = {'op': 'update', 'id': problem_id, 'at': stamp(now()), 'by': actor(args),
                'resolution': resolution, 'changes': changes, 'reason': reason}
        write_problem_lines(path, [line])
    print(f'problem {problem_id} updated')


def problem_view(problem):
    """A problem as `problems` and `show --json` give it, with labels for display."""
    resolution = problem.get('resolution') or {}
    return {**problem, 'stage_label': PROBLEM_STAGES.get(problem['stage'], problem['stage']),
            'resolution_text': resolution_text(resolution)}


def resolution_text(resolution):
    kind = resolution.get('kind')
    if kind == 'fixed':
        return f'已修 {resolution["commit"][:12]}'
    if kind == 'known-limit':
        return '列為已知限制'
    if kind == 'wontfix':
        return f'不處理：{resolution.get("reason", "")}'
    if kind == 'new-ticket':
        return f'另開票 {resolution.get("ticket", "")}'
    return ''


def cmd_problems(args):
    """The project's problems, or one ticket's, collapsed to their current state."""
    doc = read_only(args)
    problems = [problem_view(p) for p in read_problems(doc).values()]
    if args.ticket:
        wanted = (args.ticket if args.ticket == UNKNOWN_TICKET
                  else ticket_keys(args.ticket, tracker_repo(doc['workspace'])))
        problems = [p for p in problems if p['ticket'] in wanted]
    if args.json:
        print(json.dumps(problems, ensure_ascii=False, indent=1))
        return 0
    if not problems:
        print('沒有記下的問題')
        return 0
    print('| 編號 | 票 | 發現階段 | 發現者 | 級別 | 內容 | 測試抓到 | 處理 | 候選 |')
    print('|---|---|---|---|---|---|---|---|---|')
    for p in problems:
        print('| ' + ' | '.join(cell(value) for value in (
            p['id'], p['ticket'], p['stage_label'], p['finder'], p['level'], p['text'],
            ('是 ' + p['gate'][:12]) if p['caught'] else '否', p['resolution_text'],
            p.get('candidate'))) + ' |')
    return 0


def done_gate_problem(doc, item, no_findings, problems, ledger):
    """Why a row of this ledger may not close yet for want of findings, or None. Only what was
    recorded in the row's current round counts: since its latest start (a reassign or a
    follow-on row starts a new one)."""
    since = item.get('started_at') or item.get('assigned_at')
    if item['stage'] == 'qa':
        keys = ticket_keys(item['ticket'], tracker_repo(doc['workspace']))
        # Recorded through this ledger on one of the row's tickets (as it reads now, after any
        # correction), and with --row on this row.
        own = [p['id'] for p in problems.values() if p['stage'] == 'qa'
               and p.get('ledger') == ledger and p['ticket'] in keys
               and p.get('row') in (None, item['id'])
               and same_controller(item['agent'] or '', p['by'])
               and (not since or p['at'] >= since)]
        if own and no_findings:
            return (f'--no-findings, but you recorded {", ".join(own)} for this round; drop '
                    '--no-findings')
        if own or no_findings:
            return None
        return ('record what this acceptance found, or say it found nothing: '
                f'`problem --row {item["id"]} --stage qa --level <甲|乙|丙> --text '
                '"<one line>"` for each problem (add --caught <gate fingerprint> when a test '
                'caught it), or close with --no-findings. Only problems this row\'s own agent '
                'recorded since its latest start count')
    if no_findings:
        return ('--no-findings is for acceptance (qa) rows; an implementation row needs a '
                'review result')
    if item['stage'] == 'impl' and not any(
            review.get('row') == item['id'] and (not since or review.get('at', '') >= since)
            for review in doc.get('reviews', [])):
        return ('record the review of this round first: `review-result --row '
                f'{item["id"]} --reviewer <name> --clean`, or with one --finding '
                '"<甲|乙|丙>:<one line>" per finding instead of --clean. A review recorded '
                'before the row\'s latest start does not count')
    return None


def review_size():
    """review-size.py as a module: the tiny-lane check lives there."""
    path = Path(__file__).resolve().parent / 'review-size.py'
    spec = importlib.util.spec_from_file_location('review_size', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tiny_confirmation(args, doc):
    """The reviewer's four-limit confirmation for a tiny row, after running the tiny check on
    the row's work (its card's worktree, else its branch): refused when a hard limit fails, the
    orchestrator implemented the ticket, or the check shows hints --tiny-hints does not
    answer."""
    size = review_size()
    if not args.tiny_confirm:
        raise Failure('--tiny-hints goes with --tiny-confirm; nothing written')
    if not args.clean:
        raise Failure('--tiny-confirm needs --clean: a review with findings confirms nothing; '
                      'nothing written')
    item = find(doc, args.row)
    if not item.get('tiny'):
        raise Failure(f'item {item["id"]} is not on the tiny lane; nothing written')
    try:
        card = size.card_fields(item.get('card'))
        base = size.card_base(card, item.get('card'))
    except ValueError as error:
        raise Failure(f'{error}; nothing written') from None
    worktree = card.get('worktree', '')
    if worktree.startswith('/') and Path(worktree).is_dir():
        repo, head = worktree, 'HEAD'
    else:
        repo, head = item.get('repo') or doc['workspace'], item.get('branch') or card.get('branch')
    try:
        check = size.tiny_check(repo, base, head or 'HEAD', doc.get('integration_branch'))
    except ValueError as error:
        raise Failure(f'tiny check failed: {error}; nothing written') from None
    default_repo = tracker_repo(doc['workspace'])
    keys = ticket_keys(item['ticket'], default_repo)
    rows = [row for row in doc['items'] if ticket_keys(row['ticket'], default_repo) == keys]
    problems = check['problems'] + size.orchestrator_problems(rows, doc.get('orchestrator'))
    if problems:
        raise Failure('; '.join(problems) + f'; {size.NORMAL_FLOW}; nothing written')
    note = args.tiny_hints.strip() if args.tiny_hints else None
    if check['hints'] and not note:
        raise Failure('the tiny check shows hints the confirmation must address; say how each '
                      'was checked with --tiny-hints: ' + '; '.join(check['hints'])
                      + '; nothing written')
    return {'limits': ['one-ticket', 'code-lines', *TINY_DECLARED], 'base': check['base'],
            'commit': check['head'], 'content': check['content'],
            'code_added': check['code_added'],
            'hints': check['hints'], 'hints_note': note}


def cmd_cancel(args):
    reason = required_text('--reason', args.reason)
    with transaction(args, 'cancel', args.id, reason) as doc:
        if doc.get('orchestrator') and not same_controller(doc['orchestrator'], actor(args)):
            raise Failure(f'only the orchestrator {doc["orchestrator"]} may cancel items')
        item = find(doc, args.id)
        require_status(item, ('unassigned',) + OPEN, 'cancel')
        record(args, item, 'cancel', {'status': 'cancelled', 'cancel_reason': reason}, reason)
        for other in doc['items']:
            if item['id'] in other['depends_on']:
                block_for_cancelled_dependency(args, other, f'item {item["id"]} was cancelled')


def cmd_tiny_off(args):
    """Take a ticket off the tiny lane (orchestrator only): the mark leaves every row of the
    item's ticket, each with a history entry, so later rows of it are ordinary again."""
    reason = required_text('--reason', args.reason)
    with transaction(args, 'tiny-off', args.id, reason) as doc:
        if doc.get('orchestrator') and not same_controller(doc['orchestrator'], actor(args)):
            raise Failure(f'only the orchestrator {doc["orchestrator"]} may take a ticket off '
                          'the tiny lane')
        item = find(doc, args.id)
        default_repo = tracker_repo(doc['workspace'])
        keys = ticket_keys(item['ticket'], default_repo)
        rows = [row for row in doc['items'] if row.get('tiny')
                and ticket_keys(row['ticket'], default_repo) == keys]
        if not rows:
            raise Failure(f'item {item["id"]}: its ticket is not on the tiny lane')
        for row in rows:
            record(args, row, 'tiny-off', {'tiny': None}, reason)
            del row['tiny']
    print(f'{", ".join(keys)} is off the tiny lane: rows {", ".join(str(r["id"]) for r in rows)}')


def cmd_reassign(args):
    agent = required_text('--agent', args.agent)
    reason = required_text('--reason', args.reason)
    reading = read_settings(agent, args.card or find(read_only(args), args.id)['card'],
                            args.native)  # HCOM is asked outside the lock
    with transaction(args, 'reassign', args.id, reason) as doc:
        item = find(doc, args.id)
        require_status(item, OPEN, 'reassign')
        if not item['agent']:
            raise Failure(f'item {item["id"]} was never assigned; use assign')
        changes = {'agent': agent, 'assigned_at': stamp(now()), 'started_at': None,
                   'estimate': None, 'deadline': None}
        if args.card:
            changes['card'] = args.card
        if item['status'] == 'blocked':
            changes['blocked_from'] = 'assigned'
        else:
            changes['status'] = 'assigned'
        record(args, item, 'reassign', changes, reason)
        item['actual'] = {'bind': reading}


def ready(doc):
    done = {item['id'] for item in doc['items'] if item['status'] == 'done'}
    return [item for item in doc['items'] if item['status'] == 'unassigned'
            and all(dep in done for dep in item['depends_on'])]


def cmd_next(args):
    items = ready(read_only(args))
    if args.json:
        print(json.dumps([{'id': i['id'], 'ticket': i['ticket'], 'stage': i['stage']}
                          for i in items], ensure_ascii=False, indent=1))
    elif not items:
        print('nothing ready to dispatch')
    else:
        for item in items:
            print(f'{item["id"]}\t{item["ticket"]}\t{item["stage"]}')
    return 0


def ticket_refs(text):
    """The ticket references in a ticket field (it may list several, split by commas or
    spaces), as (repo, "#N"); repo is None for a bare #N or bare number, which matches only
    another bare one. Text that is no reference counts as one reference of its own."""
    found = set()
    for token in re.split(r'[\s,;、]+', text.strip()):
        match = re.fullmatch(r'(?:([\w.-]+/[\w.-]+))?#?(\d+)', token)
        if match:
            found.add((match.group(1), '#' + match.group(2)))
    return found or {(None, text.strip())}


# ---- ticket layer ---------------------------------------------------------------------

def ticket_keys(text, default_repo):
    """The canonical tickets a ticket field names, in a stable order: `owner/repo#N`, where a
    bare number belongs to `default_repo` (this project's tracker; it stays `#N` without
    one), and a text item is its own ticket keyed by its text."""
    keys = set()
    for repo, ref in ticket_refs(text):
        if not ref.startswith('#'):
            keys.add(ref)
        else:
            keys.add(f'{repo or default_repo or ""}{ref}')
    return sorted(keys)


def fetch_titles(keys):
    """{key: issue title} for the `owner/repo#N` keys; a key the tracker could not answer
    maps to '' so it is not asked again. All reads share one time budget (kept well under
    lat-dispatch's limit for `add`); keys left when it runs out are skipped and asked by a
    later add. A failure only warns: a missing title never stops a row from being added."""
    titles, deadline = {}, time.monotonic() + TITLE_BUDGET_SECONDS
    for key in keys:
        match = QUALIFIED_TICKET.fullmatch(key)
        if not match:
            continue
        left = deadline - time.monotonic()
        if left < 1:
            print(f'lat-ledger: warning: no time left to read the title of {key}; '
                  'a later add tries again', file=sys.stderr)
            continue
        try:
            title = read_issue(match[1], int(match[2]),
                               timeout=min(TITLE_TIMEOUT_SECONDS, left)).get('title')
            if not isinstance(title, str) or not title.strip():
                raise ValueError('the issue has no title')
        except ValueError as error:
            detail = ' '.join(str(error).split())
            print(f'lat-ledger: warning: no title for {key} ({detail}); it stays empty',
                  file=sys.stderr)
            title = ''
        titles[key] = title.strip()
    return titles


def closed_at(item):
    """When the row was last closed (done or cancelled), from its history; None if open."""
    if item['status'] not in ('done', 'cancelled'):
        return None
    action = 'done' if item['status'] == 'done' else 'cancel'
    return next((entry['at'] for entry in reversed(item['history'])
                 if entry.get('action') == action), None)


def first_assigned(item):
    """When the row was first given to an agent (a reassign rewrites assigned_at)."""
    return next((entry['at'] for entry in item['history'] if entry.get('action') == 'assign'),
                item.get('assigned_at') or item.get('started_at'))


def last_deploy_commit(workspace):
    """(whether the project of this checkout has a successful production deploy, the
    latest one's commit)."""
    try:
        path = shared_lat_dir(workspace) / 'deploy-history.jsonl'
        lines = path.read_text(encoding='utf-8').splitlines()
    except (OSError, UnicodeError, ValueError):
        return False, None
    commit = None
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if (isinstance(entry, dict) and entry.get('action') == DEPLOY_ACTION
                and entry.get('result') == 'succeeded'):
            commit = entry.get('commit') or commit
    return commit is not None, commit


class Lookups:
    """Git and deploy-history answers for one `show`, each worked out once: a row shared by
    several tickets, or many rows on one branch, cost one lookup. Never kept between runs,
    so merges and deploys show up at the next `show`."""

    def __init__(self, doc):
        self.doc = doc
        self.answers = {}

    def once(self, key, compute):
        if key not in self.answers:
            self.answers[key] = compute()
        return self.answers[key]

    def places(self, item):
        """Checkouts that may hold the row's commits, its own project's main checkout first."""
        return self.once(('places', item['id']), lambda: main_checkouts(self.doc, item))

    def branches(self, place):
        integration = self.doc.get('integration_branch')
        return self.once(('branches', place), lambda: (
            [integration] if integration and branch_exists(place, integration)
            else default_branches(place)))

    def reachable(self, place, sha, branches):
        return self.once(('reach', place, sha, tuple(branches)),
                         lambda: reachable(place, sha, branches))

    def merged_at(self, item):
        """The checkout whose integration branch (else default branch) holds every commit of
        the closed row, or None: the reachability check `check` uses."""
        commits = item['evidence'].get('commit') or []
        def find():
            for place in self.places(item):
                branches = self.branches(place)
                if branches and all(self.reachable(place, sha, branches) for sha in commits):
                    return place
            return None
        return self.once(('merged', item['id']), find)

    def deploy(self, place):
        """(whether that project has a successful production deploy, the latest commit)."""
        return self.once(('deploy', place), lambda: last_deploy_commit(place))


def rows_step(rows):
    """A row-made step: active while a row is open, pending while one waits to be assigned,
    done once one is done, skipped when every row was cancelled; None without rows."""
    statuses = {row['status'] for row in rows}
    if not statuses:
        return None
    if statuses & set(OPEN):
        return 'active'
    if 'unassigned' in statuses:
        return 'pending'
    return 'done' if 'done' in statuses else 'skipped'


def ticket_steps(lookups, rows, reviewed):
    """{step: state} for one ticket; `reviewed` holds the rows with a recorded review. Merge
    and deploy are checked in each row's own project (a row with --repo belongs to that repo's
    main checkout, others to the workspace)."""
    steps = {step: rows_step([r for r in rows if r['stage'] in stages])
             for step, stages in STEP_STAGES.items()}
    if steps['review'] is None and steps['impl'] is not None:
        # Reviewers have no rows: a recorded review result counts, else an implementer
        # closes only after review.
        if any(r['id'] in reviewed for r in rows if r['stage'] == 'impl'):
            steps['review'] = 'done'
        else:
            steps['review'] = 'done' if steps['impl'] == 'done' else 'pending'
    impl = [r for r in rows if r['stage'] == 'impl' and r['status'] != 'cancelled']
    delivered = [r for r in impl if r['status'] == 'done' and r['evidence'].get('commit')]
    merged = [lookups.merged_at(r) for r in delivered]
    if not delivered:
        # Nothing to merge yet, or a delivery without commits (nothing to merge at all).
        finished = impl and all(r['status'] == 'done' for r in impl)
        steps['merged'] = ('skipped' if finished else 'pending') if impl else None
    elif len(delivered) < len(impl) or None in merged:
        steps['merged'] = 'pending'
    else:
        steps['merged'] = 'done'
    projects = {lookups.places(r)[0] for r in rows} | {place for place in merged if place}
    if any(lookups.deploy(place)[0] for place in projects):
        steps['deployed'] = {None: None, 'skipped': 'skipped'}.get(steps['merged'],
                                                                   'pending')
        if steps['merged'] == 'done' and all(
                lookups.deploy(place)[0] and all(
                    lookups.reachable(place, sha, [lookups.deploy(place)[1]])
                    for sha in row['evidence']['commit'])
                for row, place in zip(delivered, merged)):
            steps['deployed'] = 'done'
    # A step no row reached is skipped once a later step has moved, or when no step ever
    # moved (a ticket of research or spec rows only); otherwise it is still to come.
    order = list(steps)
    moved = any(state in ('done', 'active') for state in steps.values())
    for index, step in enumerate(order):
        if steps[step] is None:
            later = any(steps[after] in ('done', 'active') for after in order[index + 1:])
            steps[step] = 'skipped' if later or not moved else 'pending'
    return steps


def ticket_state(rows, steps):
    statuses = {row['status'] for row in rows} - {'cancelled'}
    if not statuses:
        return 'cancelled'
    for status in ('in_progress', 'blocked', 'assigned', 'unassigned'):
        if status in statuses:
            return status
    if steps.get('deployed') == 'done':
        return 'deployed'
    return 'merged' if steps['merged'] == 'done' else 'done'


def minutes_text(minutes):
    hours, rest = divmod(int(minutes), 60)
    return f'{hours} 小時 {rest} 分' if hours else f'{rest} 分'


def ticket_now(rows, state, steps, at):
    """What the ticket is doing: each open row's stage, agent, latest progress sentence,
    blocked reason and minutes past its estimate; else what is waiting, or the outcome."""
    parts = []
    for row in rows:
        if row['status'] not in OPEN:
            continue
        late = lateness(row, at).get('estimate')
        parts.append('・'.join(text for text in (
            f'{STAGES[row["stage"]]}{STATUSES[row["status"]]}', row['agent'],
            row['progress'] and f'「{row["progress"]}」',
            row['blocked_reason'] and f'受阻：{row["blocked_reason"]}',
            late and f'超過預計 {late} 分') if text))
    if parts:
        return '／'.join(parts)
    waiting = [STAGES[row['stage']] for row in rows if row['status'] == 'unassigned']
    if waiting:
        return '待派：' + '、'.join(dict.fromkeys(waiting))
    if state == 'cancelled':
        reasons = [row['cancel_reason'] for row in rows if row['cancel_reason']]
        return '已取消' + (f'：{reasons[-1]}' if reasons else '')
    finished = [step for step, value in steps.items() if value == 'done']
    if state == 'done' and finished:
        return f'{STEPS[finished[-1]]}完成'  # e.g. only the QA draft so far
    return TICKET_STATES[state]


def ticket_settings(rows, participants):
    """What each stage of a ticket ran on: the readings of its rows and, for review, its
    reviewers' participant entries (never the implementer's reading)."""
    ids = {row['id'] for row in rows}
    stages = []
    for step, row_stages in STEP_STAGES.items():
        entries = [{'name': row['agent'], 'row': row['id'], 'source': 'row',
                    **{key: (row['actual'].get('done') or row['actual']['bind']).get(key)
                       for key in ('client', 'model', 'effort', 'verified')},
                    'text': row_settings_text(row)}
                   for row in rows if row['stage'] in row_stages and row.get('actual')]
        if step == 'review':
            entries += [{'name': entry['name'], 'row': entry['row'], 'source': 'review',
                         **{key: entry.get(key) for key in ('client', 'model', 'effort',
                                                            'verified')},
                         'text': settings_text(entry)}
                        for entry in participants if entry.get('row') in ids]
        if entries:
            stages.append({'step': step, 'label': STEPS[step], 'entries': entries,
                           'text': '、'.join(dict.fromkeys(e['text'] for e in entries))})
    return stages


def stage_counts(problems, stages):
    """One entry per problem stage in `stages` (in stage order): how many problems, by level,
    and how many a test caught. Counted by problem id."""
    entries = []
    for stage, label in PROBLEM_STAGES.items():
        if stage not in stages:
            continue
        found = [p for p in problems if p['stage'] == stage]
        levels = {level: sum(1 for p in found if p['level'] == level) for level in LEVELS}
        entries.append({'stage': stage, 'label': label, 'count': len(found), 'levels': levels,
                        'caught': sum(1 for p in found if p.get('caught')),
                        'severe': bool(levels['甲'] or levels['乙'])})
    return entries


def ticket_findings(problems, steps):
    """A ticket's problems per stage found: every stage with one, and 0 for review, acceptance
    and after deploy once that step is done (so 0 reads as looked and found nothing)."""
    stages = {p['stage'] for p in problems} | {
        stage for stage, step in ZERO_SHOWN.items() if steps.get(step) == 'done'}
    entries = stage_counts(problems, stages)
    for entry in entries:
        severe = '、'.join(f'{level} {entry["levels"][level]}' for level in ('甲', '乙')
                          if entry['levels'][level])
        entry['text'] = f'{entry["label"]} {entry["count"]}' + (f'（{severe}）' if severe else '')
    return {'stages': entries, 'text': '・'.join(entry['text'] for entry in entries),
            'severe': any(entry['severe'] for entry in entries),
            'problems': [problem['id'] for problem in problems]}


def build_tickets(doc, at, problems=None):
    """The ticket layer: one entry per canonical ticket, in the order tickets first appear. A
    row naming several tickets belongs to each of them. `problems` (collapsed, from the
    project's log) gives each ticket its findings per stage."""
    default_repo = tracker_repo(doc['workspace'])
    titles = doc.get('titles', {})
    groups = {}
    for item in doc['items']:
        for key in ticket_keys(item['ticket'], default_repo):
            groups.setdefault(key, []).append(item)
    lookups = Lookups(doc)
    reviewed = {review.get('row') for review in doc.get('reviews', [])}
    participants = doc.get('participants', [])
    tickets = []
    for key, rows in groups.items():
        steps = ticket_steps(lookups, rows, reviewed)
        state = ticket_state(rows, steps)
        starts = [time for time in map(first_assigned, rows) if time]
        running = state not in ('deployed', 'merged', 'done', 'cancelled')
        ends = [time for time in map(closed_at, rows) if time]
        end = at if running else (max(map(loads_time, ends)) if ends else None)
        minutes = (int((end - min(map(loads_time, starts))).total_seconds() // 60)
                   if starts and end else None)
        match = QUALIFIED_TICKET.fullmatch(key) or re.fullmatch(r'()#(\d+)', key)
        tickets.append({
            'key': key, 'repo': (match[1] or None) if match else None,
            'number': int(match[2]) if match else None,
            'title': titles.get(key, '' if match else key),
            'tiny': any(row.get('tiny') for row in rows),
            'state': state, 'state_label': TICKET_STATES[state],
            'steps': [{'key': step, 'label': STEPS[step], 'state': value}
                      for step, value in steps.items()],
            'now': ticket_now(rows, state, steps, at), 'items': [row['id'] for row in rows],
            'settings': ticket_settings(rows, participants),
            'findings': ticket_findings([p for p in (problems or {}).values()
                                         if p['ticket'] == key], steps),
            'started_at': stamp(min(map(loads_time, starts))) if starts else None,
            'total_minutes': minutes, 'running': running})
    return tickets


def tickets_without_qa(doc):
    """Tickets with an impl row but no qa-draft/qa row (a cancelled one is a recorded exemption).
    A cancelled impl row never delivered anything, so it needs no QA."""
    qa_refs = set()
    for item in doc['items']:
        if item['stage'] in ('qa-draft', 'qa'):
            qa_refs |= ticket_refs(item['ticket'])
    missing = {}
    for item in doc['items']:
        if item['stage'] != 'impl' or item['status'] == 'cancelled':
            continue
        for ref in sorted(ticket_refs(item['ticket']), key=str):
            if ref not in qa_refs:
                missing.setdefault(f'{ref[0] or ""}{ref[1]}', []).append(item['id'])
    return missing


def cmd_check(args):
    doc = read_only(args)
    failures, cancelled = [], []
    for number, ids in tickets_without_qa(doc).items() if doc.get('qa_coverage') else ():
        failures.append({'id': ids[0], 'label': f'ticket {number} (impl item {", ".join(map(str, ids))})',
                         'problems': ['no qa-draft or qa item covers it; add one, or cancel one '
                                      'with --reason to record why not']})
    repos = [{'id': item['id'], 'repo': item['repo']} for item in doc['items']
             if item.get('repo') and item['status'] != 'cancelled']
    for item in doc['items']:
        repo = f', repo {item["repo"]}' if item.get('repo') else ''
        label = f'item {item["id"]} ({item["ticket"]} {item["stage"]}{repo})'
        if item['status'] == 'cancelled':
            cancelled.append({'id': item['id'], 'label': label, 'reason': item['cancel_reason']})
            continue
        if item['status'] != 'done':
            failures.append({'id': item['id'], 'label': label,
                             'problems': [f'not closed: {item["status"]}']})
            continue
        try:
            _, problems = verify(doc, item, item['evidence'])
        except Exception as error:  # A crash in a lookup must never read as a pass.
            problems = [f'evidence check failed: {error}']
        missing = [k for k in item['evidence_kinds'] if not item['evidence'].get(k)]
        problems += [f'{kind} evidence missing from the record' for kind in missing]
        if problems:
            failures.append({'id': item['id'], 'label': label, 'problems': problems})
    if args.json:
        print(json.dumps({'ok': not failures, 'failures': failures, 'cancelled': cancelled,
                          'repos': repos},
                         ensure_ascii=False, indent=1))
    else:
        print('ledger check: ' + ('FAIL' if failures else 'OK') +
              f' ({len(doc["items"])} items)')
        for entry in repos:
            print(f'- item {entry["id"]} repo: {entry["repo"]}')
        for failure in failures:
            print(f'- {failure["label"]}: ' + '; '.join(failure['problems']))
        for entry in cancelled:
            print(f'- cancelled {entry["label"]}: {entry["reason"]}')
    return 1 if failures else 0


def lateness(item, at):
    """Minutes past the estimate and the deadline, counted only while they still apply; a
    blocked row has no deadline."""
    late = {}
    if item['status'] == 'in_progress' and item['estimate']:
        late['estimate'] = (at - loads_time(item['estimate'])).total_seconds() // 60
    if item['status'] in ('assigned', 'in_progress') and item['deadline']:
        late['deadline'] = (at - loads_time(item['deadline'])).total_seconds() // 60
    return {key: int(value) for key, value in late.items() if value > 0}


def cell(value):
    return '' if value is None else str(value).replace('|', '\\|').replace('\n', ' ')


def cmd_show(args):
    doc = read_only(args)
    at = now()
    default_repo = tracker_repo(doc['workspace'])
    rows = []
    for item in doc['items']:
        view = dict(item)
        view['late_minutes'] = lateness(item, at)
        view['card_mismatch'] = card_mismatch(item)
        view['stage_label'] = STAGES[item['stage']]
        view['status_label'] = STATUSES[item['status']]
        view['ticket_keys'] = ticket_keys(item['ticket'], default_repo)
        view['settings_text'] = row_settings_text(item)
        rows.append(view)
    if getattr(args, 'rows', False) and not args.json:
        print(f'工作總表 {args.ledger}（更新於 {doc["updated_at"]}）\n')
        show_rows(rows)
        return 0
    problems = read_problems(doc)
    tickets = build_tickets(doc, at, problems)
    counts = {}
    for ticket in tickets:
        counts[ticket['state']] = counts.get(ticket['state'], 0) + 1
    # This ledger's problems: its tickets', and every one recorded through it (an escaped
    # problem names the ticket that caused it, often of an earlier round, or 不明); each id once.
    keys = {ticket['key'] for ticket in tickets}
    mine = [problem for problem in problems.values() if problem['ticket'] in keys
            or problem.get('ledger') == str(Path(args.ledger))]
    summary = stage_counts(mine, {p['stage'] for p in mine} | {
        entry['stage'] for ticket in tickets for entry in ticket['findings']['stages']})
    if args.json:
        print(json.dumps({'ledger': str(Path(args.ledger)), 'now': stamp(at),
                          'workspace': doc['workspace'], 'created_at': doc['created_at'],
                          'updated_at': doc['updated_at'], 'items': rows,
                          'tickets': tickets, 'ticket_counts': counts,
                          'reviews': doc.get('reviews', []),
                          'participants': doc.get('participants', []),
                          'problems': [problem_view(p) for p in mine],
                          'finding_summary': summary,
                          'problems_path': str(problems_path(doc)),
                          'deploy_step': any(step['key'] == 'deployed' for ticket in tickets
                                             for step in ticket['steps'])},
                         ensure_ascii=False, indent=1))
        return 0
    print(f'工作總表 {args.ledger}（更新於 {doc["updated_at"]}）\n')
    show_tickets(tickets, counts, default_repo)
    show_summary(summary)
    return 0


def show_tickets(tickets, counts, default_repo):
    summary = '、'.join(f'{counts[state]} 張{label}' for state, label in TICKET_STATES.items()
                       if counts.get(state))
    print(f'{len(tickets)} 張票：{summary}' if tickets else '沒有票')
    print('\n| 票 | 標題 | 進度 | 現在 | 模型 | 問題 | 用時 | 列 |')
    print('|---|---|---|---|---|---|---|---|')
    for ticket in tickets:
        ref = ticket['key']
        if default_repo and ref.startswith(f'{default_repo}#'):
            ref = ref[len(default_repo):]
        progress = ' '.join(f'{step["label"]}{STEP_MARKS[step["state"]]}'
                            for step in ticket['steps'])
        took = ''
        if ticket['total_minutes'] is not None:
            took = ('已 ' if ticket['running'] else '') + minutes_text(ticket['total_minutes'])
        models = '；'.join(f'{stage["label"]} {stage["text"]}' for stage in ticket['settings'])
        print('| ' + ' | '.join(cell(value) for value in (
            ref, ticket['title'] + ('（小改動）' if ticket['tiny'] else ''), progress,
            ticket['now'], models, ticket['findings']['text'], took,
            ','.join(map(str, ticket['items'])))) + ' |')


def show_summary(summary):
    print('\n哪個階段找出多少問題')
    if not summary:
        print('還沒有記下的問題')
        return
    print('| 發現階段 | 甲 | 乙 | 丙 | 合計 | 其中測試抓到 |')
    print('|---|---|---|---|---|---|')
    for entry in summary:
        print('| ' + ' | '.join(str(value) for value in (
            entry['label'], *entry['levels'].values(), entry['count'], entry['caught'])) + ' |')


def show_rows(rows):
    print('| # | 票號 | 階段 | 負責 | 模型 | 狀態 | 依賴 | 預計完成 | 備註 |')
    print('|---|---|---|---|---|---|---|---|---|')
    for row in rows:
        status = row['status_label']
        if 'estimate' in row['late_minutes']:
            status += f'（超過預計 {row["late_minutes"]["estimate"]} 分）'
        notes = [text for text in (
            row.get('tiny') and '小改動',
            row['blocked_reason'] and f'受阻：{row["blocked_reason"]}',
            row['cancel_reason'] and f'取消：{row["cancel_reason"]}',
            row['follows'] and f'接續自 {row["follows"]}',
            row['card_mismatch'] and f'任務卡不一致：{row["card_mismatch"]}',
            row['progress'] and f'進度：{row["progress"]}') if text]
        print('| ' + ' | '.join(cell(value) for value in (
            row['id'], row['ticket'], row['stage_label'], row['agent'], row['settings_text'],
            status,
            ','.join(map(str, row['depends_on'])), row['estimate'], '；'.join(notes))) + ' |')


def cmd_repair(args):
    reason = required_text('--reason', args.reason)
    store = Store(args.ledger)
    with locked(store, exclusive=True):
        at = stamp(now())
        entry = {'at': at, 'by': actor(args), 'reason': reason, 'item': None}
        if args.from_journal:
            doc = read_journal(store)
            entry['action'] = 'repair-from-journal'
        else:
            try:
                data = store.path.read_bytes()
                doc = parse_ledger(data)
            except FileNotFoundError:
                raise Failure(f'ledger missing: {store.path}; use repair --from-journal') from None
            except (ValueError, UnicodeError) as error:
                raise Failure(f'ledger is malformed ({error}); use repair --from-journal, '
                              'which rebuilds it from the journal') from error
            sealed = store.seal.read_text().strip() if store.seal.exists() else None
            if sealed == digest(data) and journal_tail_seal(store) == sealed:
                raise Failure('ledger seal and journal match; nothing to repair')
            entry['action'] = 'repair-seal'
        doc['history'].append({key: entry[key] for key in ('at', 'by', 'action', 'reason')})
        doc['updated_at'] = at
        current = store.path.read_bytes() if store.path.exists() else None
        save(store, doc, current, entry)
        load(store)  # report failure rather than success when the repair did not take
    print(f'ledger repaired ({entry["action"]}): {store.path}')
    if args.from_journal:
        cmd_show(argparse.Namespace(ledger=args.ledger, json=False, rows=True))


# ---- CLI ------------------------------------------------------------------------------

def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--ledger', required=True, help='absolute path of the ledger JSON')
    common.add_argument('--by', help='who acts; default $HCOM_INSTANCE_NAME, then the OS user. '
                        'HCOM names are stored as full names')
    parser = argparse.ArgumentParser(description='LAT work ledger')
    commands = parser.add_subparsers(dest='command', required=True)

    def command(name, text, item=True):
        sub = commands.add_parser(name, parents=[common], help=text)
        if item:
            sub.add_argument('id', type=int, help='item number')
        return sub

    sub = command('init', 'Create a new ledger', item=False)
    sub.add_argument('--workspace', required=True, help='main workspace (absolute)')
    sub.add_argument('--integration-branch', help='branch every commit may reach, e.g. dev')
    sub.add_argument('--orchestrator', help='HCOM name allowed to cancel items, stored as the '
                     'full name')
    sub = command('add', 'Add an item', item=False)
    sub.add_argument('--ticket', required=True)
    sub.add_argument('--title', help="what the ticket solves, for each ticket the row names; "
                     "without it a numbered ticket's tracker title is read once (a failure "
                     'leaves it empty)')
    sub.add_argument('--stage', required=True, choices=sorted(STAGES))
    sub.add_argument('--evidence', required=True, action='append',
                     help='commit, gate and/or file; comma-separated or repeated')
    sub.add_argument('--depends', help='comma-separated item numbers')
    sub.add_argument('--follows', type=int, help='item this one continues')
    sub.add_argument('--deadline', help='ignored (kept for older callers): the deadline is '
                     'the estimate + 1h')
    sub.add_argument('--branch', help='branch the commit evidence must reach')
    sub.add_argument('--repo', help='absolute path of the git repo the commit evidence lives in')
    sub.add_argument('--old-round', action='store_true',
                     help="add to an earlier round's ledger <session>-r<N>.json on purpose; "
                     "without it such a ledger is refused when its session record names "
                     'another ledger')
    sub.add_argument('--tiny', action='store_true',
                     help='tiny-change lane for this one ticket; marks every row of the ticket. '
                     'Needs both declarations below')
    sub.add_argument('--no-feature', action='store_true',
                     help='with --tiny: the orchestrator declares the change adds no feature')
    sub.add_argument('--no-format-change', action='store_true',
                     help='with --tiny: the orchestrator declares the change keeps every data '
                     'and storage format')
    sub = command('assign', 'Give an item to an agent')
    sub.add_argument('--agent', required=True, help='HCOM name, stored as the full name')
    sub.add_argument('--native', action='store_true',
                     help='Claude built-in agent without an HCOM name: --agent is kept as given')
    sub.add_argument('--card', required=True, help='task card path')
    sub.add_argument('--deadline', help='ignored (kept for older callers)')
    sub = command('start', 'Agent starts work')
    sub.add_argument('--eta', required=True, help='expected finish: ISO 8601 or +N[m|h|d]')
    sub = command('update', 'Record progress or change times, card or dependencies')
    sub.add_argument('--eta', help='new estimate; the deadline moves to it + 1h')
    sub.add_argument('--deadline', help='ignored (kept for older callers)')
    sub.add_argument('--progress')
    sub.add_argument('--card')
    sub.add_argument('--branch', help='branch the commit evidence must reach')
    sub.add_argument('--repo', help='absolute path of the git repo the commit evidence lives in')
    sub.add_argument('--merged-into', help="local long-lived branch that holds the row's commits; "
                     'refused unless it does. The row is checked there from then on')
    sub.add_argument('--depends', help='replace dependencies; empty string clears them')
    sub.add_argument('--reason')
    sub = command('block', 'Mark an item blocked')
    sub.add_argument('--reason', required=True, help='what it waits for')
    sub = command('unblock', 'Resume a blocked item')
    sub.add_argument('--reason')
    sub = command('done', 'Close an item with evidence')
    sub.add_argument('--commit', action='append')
    sub.add_argument('--repo', help='git repo to verify --commit in (absolute; replaces the '
                     "row's repo). Refused when it is not a git repo or lacks the commit; the "
                     "row's branch and the integration branch must contain the commit where "
                     "they exist in that repo; a named branch that is gone falls back to the "
                     "repo's default branch, and with no branch named only the commit's "
                     'existence is checked')
    sub.add_argument('--gate', action='append', help='suite-gate record fingerprint')
    sub.add_argument('--file', action='append', help='absolute path of a report or checklist')
    sub.add_argument('--no-findings', action='store_true',
                     help='a qa row found no problem. Otherwise a qa row closes only after its '
                     'own agent recorded a qa-stage problem since its latest start, and an impl '
                     'row only after a review result for it since then')
    sub = command('amend', 'Note a later change on a closed item; evidence given replaces '
                  'that kind')
    sub.add_argument('--reason', required=True, help='what changed after the close')
    sub.add_argument('--commit', action='append')
    sub.add_argument('--gate', action='append', help='suite-gate record fingerprint')
    sub.add_argument('--file', action='append', help='absolute path of a report or checklist')
    sub = command('review-result', "Record a review of a row with each reviewer's actual "
                  'model and effort', item=False)
    sub.add_argument('--row', type=int, required=True, help='the ledger row the review covers')
    sub.add_argument('--reviewer', action='append', required=True,
                     help='HCOM name of a reviewer (repeat for each); a name HCOM does not list, '
                     'such as a native sub-agent, is kept as given and marked unverified')
    sub.add_argument('--clean', action='store_true', help='the review found nothing')
    sub.add_argument('--note', help='free text kept with the result')
    sub.add_argument('--finding', action='append', metavar='LEVEL:TEXT',
                     help='one problem the review found, as "<甲|乙|丙>:<one line>" (repeat for '
                     'each; instead of --clean). Each becomes a review-stage problem in the '
                     "project's problem log, found by the reviewers named; record one review "
                     'per reviewer to keep finders apart')
    sub.add_argument('--ticket', help='with --finding on a row covering several tickets: the '
                     'one the findings belong to')
    sub.add_argument('--rerun-ack', action='append', metavar='FINGERPRINT',
                     help='a gate record (12+ characters of its fingerprint) that passed only on '
                     'the automatic rerun and that the reviewers looked at; needs --note saying '
                     'what the first failures were. Until then the ledger and the merge check do '
                     'not take that record as evidence')
    sub.add_argument('--tiny-confirm', action='store_true',
                     help="for a tiny-lane row, with --clean: the reviewers confirm all four "
                     'limits (one ticket, at most 30 added code lines, no new feature, no data '
                     "or storage format change). Runs the tiny check on the row's work first")
    sub.add_argument('--tiny-hints', metavar='TEXT',
                     help='with --tiny-confirm: how each hint the tiny check showed was checked; '
                     'required when it shows any')
    sub = command('tiny-off', "Take the item's ticket off the tiny lane (orchestrator only)")
    sub.add_argument('--reason', required=True)
    stages = ', '.join(f'{key} ({label})' for key, label in PROBLEM_STAGES.items())
    sub = command('problem', "Record a problem in the project's problem log; prints its id",
                  item=False)
    sub.add_argument('--stage', required=True, choices=list(PROBLEM_STAGES),
                     help=f'where it was found: {stages}. Review findings go through '
                     'review-result; post-merge, suite and both post-deploy ones are recorded '
                     'by the '
                     'orchestrator')
    sub.add_argument('--level', required=True, choices=LEVELS)
    sub.add_argument('--text', required=True, help='the problem in one line')
    sub.add_argument('--row', type=int, help='the ledger row it was found on (a qa row records '
                     'its own findings with it); its ticket is the problem\'s')
    sub.add_argument('--ticket', help='the ticket whose change caused it (one); without --row '
                     f'it must be a ticket of this ledger, except after merging, where any '
                     f'ticket of the project or {UNKNOWN_TICKET} is taken')
    sub.add_argument('--finder', help='who found it: an agent, user or suite-gate (default: '
                     'whoever records it)')
    sub.add_argument('--caught', metavar='FINGERPRINT',
                     help='a test caught it: the gate record of that run')
    sub = command('problem-update', 'Add a resolution to a problem, or correct it, by its id',
                  item=False)
    sub.add_argument('problem', help='problem id, e.g. P3')
    group = sub.add_mutually_exclusive_group()
    group.add_argument('--fixed', metavar='COMMIT', help='fixed by this commit')
    group.add_argument('--known-limit', action='store_true', help='kept as a known limitation')
    group.add_argument('--wontfix', metavar='REASON', help='not handled, and why')
    group.add_argument('--new-ticket', metavar='TICKET', help='moved to this ticket')
    sub.add_argument('--repo', help='with --fixed: the git repo holding the commit (default: '
                     "the ledger's workspace)")
    sub.add_argument('--level', choices=LEVELS, help='correct the level')
    sub.add_argument('--text', help='correct the line')
    sub.add_argument('--finder', help='correct who found it')
    sub.add_argument('--stage', choices=[s for s in PROBLEM_STAGES if s != 'review'],
                     help='correct the stage')
    sub.add_argument('--ticket', help='correct the ticket')
    sub.add_argument('--caught', metavar='FINGERPRINT', help='a test caught it after all')
    sub.add_argument('--reason', help='what was wrong; required with a correction')
    sub = command('problems', "List the project's problems, current state with history",
                  item=False)
    sub.add_argument('--ticket', help=f'only this ticket\'s (or {UNKNOWN_TICKET})')
    sub.add_argument('--json', action='store_true')
    sub = command('cancel', 'Cancel an item (orchestrator only)')
    sub.add_argument('--reason', required=True)
    sub = command('reassign', 'Hand an open item to another agent')
    sub.add_argument('--agent', required=True, help='HCOM name, stored as the full name')
    sub.add_argument('--native', action='store_true',
                     help='Claude built-in agent without an HCOM name: --agent is kept as given')
    sub.add_argument('--card')
    sub.add_argument('--reason', required=True)
    for name, text in (('next', 'Items ready to dispatch'), ('check', 'Verify every item')):
        command(name, text, item=False).add_argument('--json', action='store_true')
    sub = command('show', 'Print the ledger grouped by ticket', item=False)
    sub.add_argument('--json', action='store_true',
                     help="every row as today, plus a tickets section (the ticket table's data)")
    sub.add_argument('--rows', action='store_true', help='one line per row instead of per ticket')
    sub = command('repair', 'Accept a hand edit or rebuild from the journal', item=False)
    sub.add_argument('--reason', required=True)
    sub.add_argument('--from-journal', action='store_true')
    return parser


def main():
    args = build_parser().parse_args()
    handlers = {'init': cmd_init, 'add': cmd_add, 'assign': cmd_assign, 'start': cmd_start,
                'update': cmd_update, 'block': cmd_block, 'unblock': cmd_unblock,
                'done': cmd_done, 'amend': cmd_amend, 'cancel': cmd_cancel,
                'tiny-off': cmd_tiny_off, 'reassign': cmd_reassign,
                'review-result': cmd_review_result,
                'problem': cmd_problem, 'problem-update': cmd_problem_update,
                'problems': cmd_problems,
                'next': cmd_next, 'check': cmd_check, 'show': cmd_show,
                'repair': cmd_repair}
    try:
        if args.command not in READ_ONLY:
            resolve_names(args)
        return handlers[args.command](args) or 0
    except (Failure, ValueError, OSError) as error:
        print(f'lat-ledger: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
