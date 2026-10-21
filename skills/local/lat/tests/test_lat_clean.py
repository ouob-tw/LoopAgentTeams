"""Cleanup command list/execute; gh, trash-put and shred are stubs, files are disposable."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-clean.py'
sys.path.insert(0, str(SCRIPT.parent))
import _lat_cleanup  # noqa: E402

ACTIVE = '11111111-1111-4111-8111-111111111111'
ENDED_SID = '22222222-2222-4222-8222-222222222222'
REPO = 'owner/tracker'
RECORDED = ('## 舊題目\nQ0 · r1 · 已記錄 · 2026-10-02T09:00:00+00:00\n\n'
            'A. Done\n\n答覆：A. Done\n\n- [x] 送出\n')
PENDING = '## 新題目\nQ1 · r1 · 待答\n\n請回答。\n\n答覆：\n\n- [ ] 送出\n'
FAKE_GH = '''#!/bin/sh
printf 'gh %s\\n' "$*" >> "$FAKE_LOG"
if [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi
cat "$FAKE_GH_JSON"
'''
# Both stubs log their call, then remove what they were given so later checks see it gone.
FAKE_REMOVE = '''#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$FAKE_LOG"
for item in "$@"; do
  case "$item" in -u|--) ;; *) rm -rf -- "$item" ;; esac
done
'''


class CleanTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        (self.work / '.git').mkdir(parents=True)
        self.lat = self.work / '.lat'
        for name in ('decisions', 'sessions', 'tasks', 'watch/waits', 'progress', 'evidence',
                     'runs', 'questions'):
            (self.lat / name).mkdir(parents=True)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'calls.log'
        self.issues = self.root / 'issues.json'
        for name, text in (('gh', FAKE_GH), ('trash-put', FAKE_REMOVE), ('shred', FAKE_REMOVE)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        self.set_issues([])
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        FAKE_LOG=str(self.log), FAKE_GH_JSON=str(self.issues))
        self.env.pop('FAKE_GH_FAIL', None)
        self.list_file = self.root / 'out/list.json'

    def set_issues(self, issues):
        self.issues.write_text(json.dumps(issues))

    def write(self, relative, text=''):
        path = self.lat / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def session(self, sid, name, status, **extra):
        progress = self.write(f'progress/{name}.md', 'progress\n')
        record = dict(client='claude', session_id=sid, role='orchestrator', workspace=str(self.work),
                      status=status, progress_path=str(progress),
                      decisions_path=str(self.lat / 'decisions'),
                      tasks_path=str(self.lat / 'tasks'), hcom_name=name, **extra)
        self.write(f'sessions/{sid}.json', json.dumps(record))
        return progress

    def cli(self, *args):
        return subprocess.run(['uv', 'run', '--no-project', 'python', str(SCRIPT), *map(str, args)],
                              text=True, capture_output=True, env=self.env, timeout=120)

    def list_items(self):
        result = self.cli('list', '--workspace', self.work, '--repo', REPO, '--output', self.list_file)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(self.list_file.read_text())
        return result, document, {os.path.relpath(item['path'], self.lat): item
                                  for item in document['items']}

    def list_hash(self):
        return hashlib.sha256(self.list_file.read_bytes()).hexdigest()

    def execute(self, *extra, digest=None):
        return self.cli('execute', '--workspace', self.work, '--list', self.list_file,
                        '--hash', digest or self.list_hash(), *extra)

    def calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def removal_calls(self):
        return [line for line in self.calls() if not line.startswith('gh ')]


class Fixture(CleanTestCase):
    def setUp(self):
        super().setUp()
        self.session(ACTIVE, 'live', 'active')
        self.session(ENDED_SID, 'gone', 'ended', ended_at_utc='2026-09-01T00:00:00+00:00')
        self.write('questions-gone.md', RECORDED)
        self.write('questions-gone-archive.md', RECORDED)
        self.write('.questions-gone.md.lock')
        self.write('questions-empty.md')
        self.write('questions-open.md', PENDING)
        self.write('questions-live.md', PENDING)
        self.write('.questions-old.md.lock')
        self.write('questions.md', PENDING)
        self.write('demo-questions.md', 'demo\n')
        self.write('questions/quiet.md')
        self.write('panel-journal.jsonl', '{}\n')
        self.write('decisions/D-1.md', '- status: approved\n')
        self.write('evidence/issue-5-qa/shot.png', 'x' * 2048)
        self.write('evidence/issue-7-qa/shot.png', 'open ticket')
        self.write('evidence/notes/readme.md', 'no ticket\n')
        self.write('evidence/home-copy/codex-home/auth.json', '{"token": 1}')
        self.write('progress/issue-5-fixture/state/password.json', '{}')
        self.write('runs/misc-2026-10-01-proto/index.html', '<p>')
        self.write('runs/issue-7/notes.md', 'open\n')
        self.write(f'watch/{ENDED_SID}.log', 'old\n')
        self.write(f'watch/{ACTIVE}.log', 'live\n')
        self.write('watch/gone/watch.jsonl', '{}\n')
        self.write('watch/live/watch.jsonl', '{}\n')
        self.write('watch/prompt-gone-abc.txt', 'half typed\n')
        self.write('watch/waits/old-agent.json', '{}')
        self.write('watch/waits/.old-agent.lock')
        self.write('watch/waits/live.json', '{}')
        self.write('evidence/linked-notes/a.png', 'linked from an open ticket')
        self.write('tasks/done/old-card.md', 'done\n')
        self.write('tasks/live-card.md', '- agent：helper\n- orchestrator：live\n- status：dispatched\n')
        (self.work / '.worktrees/wt/.lat/watch').mkdir(parents=True)
        (self.work / '.worktrees/wt/.lat/watch/prompt-user-1.txt').write_text('typed\n')
        (self.work / '.worktrees/wt2/.lat/runs/issue-7').mkdir(parents=True)
        (self.work / '.worktrees/wt2/.lat/runs/issue-7/n.md').write_text('open ticket\n')
        (self.root / 'outside/.lat').mkdir(parents=True)
        (self.root / 'outside/.lat/keep.md').write_text('not ours\n')
        (self.work / '.worktrees/alias').symlink_to(self.root / 'outside')
        self.set_issues([
            dict(number=5, state='CLOSED', body='see .lat/evidence/issue-5-qa/shot.png', comments=[
                dict(body='notes in /abs/.lat/progress/gone.md.')]),
            dict(number=7, state='OPEN', body='', comments=[
                dict(body='screens: /abs/.lat/evidence/linked-notes/a.png')]),
        ])



class ListTests(Fixture):
    def test_list_shows_category_size_method_and_linked_tickets(self):
        result, document, items = self.list_items()

        self.assertEqual(items['evidence/issue-5-qa']['category'], 'closed-ticket')
        self.assertEqual(items['evidence/issue-5-qa']['size'], 2048)
        self.assertEqual(items['evidence/issue-5-qa']['method'], 'trash')
        self.assertEqual(items['evidence/issue-5-qa']['linked'],
                         {'found': [{'number': 5, 'state': 'CLOSED'}]})
        self.assertEqual(items['progress/gone.md']['category'], 'controller-progress')
        self.assertEqual(items['progress/gone.md']['linked'], {'found': [{'number': 5, 'state': 'CLOSED'}]})
        self.assertEqual(items['evidence/notes']['linked'], {'found': []})
        self.assertEqual(items['evidence/notes']['category'], 'no-ticket')
        self.assertEqual(items['runs/misc-2026-10-01-proto']['category'], 'misc-run')
        for relative in ('evidence/home-copy', 'progress/issue-5-fixture', 'watch/prompt-gone-abc.txt'):
            self.assertEqual(items[relative]['method'], 'shred', relative)
        expected = {
            'questions-gone.md': 'legacy-question', 'questions-gone-archive.md': 'legacy-question',
            'questions-empty.md': 'empty-question', 'questions/quiet.md': 'empty-question',
            'questions.md': 'legacy-file', 'demo-questions.md': 'legacy-file',
            '.questions-old.md.lock': 'orphan-lock', '.questions-gone.md.lock': 'orphan-lock',
            f'watch/{ENDED_SID}.log': 'watch-leftover', 'watch/gone': 'watch-leftover',
            'watch/waits/old-agent.json': 'stale-wait', 'watch/waits/.old-agent.lock': 'orphan-lock',
            'watch/prompt-gone-abc.txt': 'prompt-backup', 'tasks/done/old-card.md': 'done-task-card',
        }
        self.assertEqual({key: items[key]['category'] for key in expected}, expected)
        worktree = {os.path.relpath(item['path'], self.work): item for item in document['items']
                    if '.worktrees' in item['path']}
        self.assertEqual(list(worktree), ['.worktrees/wt/.lat'])
        self.assertEqual(worktree['.worktrees/wt/.lat']['method'], 'shred')
        self.assertFalse(any('outside' in item['path'] for item in document['items']))
        for item in document['items']:
            self.assertTrue(item['modified_utc'] and item['fingerprint'])
        self.assertIn('| # | 類別 | 路徑 | 大小 | 最後修改 | 刪除方式 | 連到的票 | 說明 |', result.stdout)
        self.assertIn('| 已關閉票的資料 | .lat/evidence/issue-5-qa | 2.0 KB |', result.stdout)
        self.assertIn('#5（關閉）', result.stdout)
        self.assertIn('未查到', result.stdout)
        self.assertIn('shred（隔離 client 家目錄', result.stdout)
        self.assertIn(f'清單雜湊：{self.list_hash()}', result.stdout)

    def test_list_leaves_out_hard_limits_active_files_open_tickets_and_open_questions(self):
        _, document, items = self.list_items()

        listed = set(items)
        for relative in ('decisions', 'decisions/D-1.md', 'sessions', 'panel-journal.jsonl',
                         'progress/live.md', 'questions-live.md', f'watch/{ACTIVE}.log', 'watch/live',
                         'watch/waits/live.json', 'evidence/issue-7-qa', 'runs/issue-7',
                         'questions-open.md', 'evidence/linked-notes', 'tasks/live-card.md',
                         'tasks'):
            self.assertNotIn(relative, listed)
        reasons = {os.path.relpath(item['path'], self.lat): item['reason']
                   for item in document['excluded']}
        self.assertEqual(reasons['evidence/issue-7-qa'], '開啟中的票 #7')
        self.assertEqual(reasons['evidence/linked-notes'], '開啟中的票連到此路徑 #7')
        self.assertEqual(reasons['../.worktrees/wt2/.lat/runs'], '開啟中的票 #7')
        self.assertTrue(reasons['progress/live.md'].startswith('active session 仍需要'))

    def test_tracker_failure_is_marked_and_does_not_stop_the_list(self):
        self.env['FAKE_GH_FAIL'] = 'HTTP 502'

        result, document, items = self.list_items()

        self.assertIn('查詢失敗：gh issue list failed: HTTP 502', result.stdout)
        self.assertEqual(items['evidence/notes']['linked'], {'error': 'gh issue list failed: HTTP 502'})
        self.assertNotIn('evidence/issue-5-qa', items)
        reasons = {os.path.relpath(item['path'], self.lat): item['reason']
                   for item in document['excluded']}
        self.assertTrue(reasons['evidence/issue-5-qa'].startswith('票狀態無法確認'))


class ExecuteTests(Fixture):
    def test_wrong_hash_or_edited_list_is_refused_without_deleting(self):
        self.list_items()
        digest = self.list_hash()
        wrong = self.execute(digest='0' * 64)
        document = json.loads(self.list_file.read_text())
        document['items'].append(dict(document['items'][0], id=999, path=str(self.lat / 'decisions')))
        self.list_file.write_text(json.dumps(document))
        edited = self.execute(digest=digest)

        for result in (wrong, edited):
            self.assertEqual(result.returncode, 1)
            self.assertIn('清單雜湊不符', result.stderr)
        self.assertEqual(self.removal_calls(), [])
        self.assertTrue((self.lat / 'evidence/notes/readme.md').exists())

    def test_items_changed_gone_or_no_longer_eligible_are_skipped_and_listed(self):
        _, document, items = self.list_items()
        (self.lat / 'evidence/notes/new.md').write_text('added after listing\n')
        shutil.rmtree(self.lat / 'runs/misc-2026-10-01-proto')
        self.session(ENDED_SID, 'gone', 'active')

        result = self.execute()

        self.assertEqual(result.returncode, 0, result.stderr)
        lines = {line.split(' | ')[1]: line for line in result.stdout.splitlines()
                 if line.startswith('| ') and ' | ' in line[2:]}
        self.assertIn('跳過：列出後已被改動', lines['.lat/evidence/notes'])
        self.assertIn('跳過：已不存在', lines['.lat/runs/misc-2026-10-01-proto'])
        self.assertIn('跳過：active session 仍需要', lines['.lat/watch/gone'])
        self.assertIn('跳過：active session 仍需要', lines['.lat/questions-gone.md'])
        self.assertIn('已用 trash 移到垃圾桶', lines['.lat/demo-questions.md'])
        self.assertTrue((self.lat / 'evidence/notes/readme.md').exists())
        self.assertTrue((self.lat / 'watch/gone/watch.jsonl').exists())
        self.assertFalse((self.lat / 'demo-questions.md').exists())

    def test_hard_limits_in_the_list_are_never_deleted(self):
        _, document, _ = self.list_items()
        template = document['items'][0]
        self.write('.questions-open.md.lock')
        protected = [self.lat / 'decisions', self.lat / 'decisions/D-1.md', self.lat / 'sessions',
                     self.lat / 'panel-journal.jsonl', self.lat / '.questions-open.md.lock',
                     self.lat / 'progress/live.md', self.lat / 'evidence/issue-7-qa', self.lat]
        document['items'] = [dict(template, id=index, path=str(path),
                                  fingerprint=_lat_cleanup.fingerprint(path))
                             for index, path in enumerate(protected, 1)]
        self.list_file.write_text(json.dumps(document))

        result = self.execute()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.removal_calls(), [])
        for path in protected:
            self.assertTrue(path.exists(), path)
        self.assertEqual(result.stdout.count('跳過：'), len(protected))
        for reason in ('硬限制 decisions', '硬限制 sessions', '硬限制 panel-journal.jsonl',
                       '現存檔案的鎖', 'active session 仍需要', '開啟中的票 #7', '不在 .lat 內'):
            self.assertIn(reason, result.stdout)

    def test_sensitive_items_are_shredded_and_others_trashed(self):
        _, _, items = self.list_items()
        wanted = ','.join(str(items[key]['id']) for key in (
            'evidence/home-copy', 'progress/issue-5-fixture', 'watch/prompt-gone-abc.txt',
            'evidence/notes', 'questions-gone.md', '.questions-gone.md.lock'))

        result = self.execute('--only', wanted)

        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.removal_calls()
        home = self.lat / 'evidence/home-copy'
        fixture = self.lat / 'progress/issue-5-fixture'
        self.assertIn(f'shred -u -- {home}/codex-home/auth.json', calls)
        self.assertIn(f'trash-put -- {home}', calls)
        self.assertIn(f'shred -u -- {fixture}/state/password.json', calls)
        self.assertIn(f'shred -u -- {self.lat}/watch/prompt-gone-abc.txt', calls)
        self.assertIn(f'trash-put -- {self.lat}/evidence/notes', calls)
        self.assertIn(f'trash-put -- {self.lat}/questions-gone.md', calls)
        # The lock goes last, once its question file is gone.
        self.assertEqual(calls[-1], f'trash-put -- {self.lat}/.questions-gone.md.lock')
        self.assertFalse(any(line.startswith('shred') and 'notes' in line for line in calls))
        self.assertIn('刪除 6 項，跳過 0 項，失敗 0 項。', result.stdout)

    def test_a_lock_whose_file_stays_is_skipped(self):
        _, _, items = self.list_items()

        result = self.execute('--only', items['.questions-gone.md.lock']['id'])

        self.assertIn('跳過：現存檔案的鎖 .questions-gone.md.lock', result.stdout)
        self.assertTrue((self.lat / '.questions-gone.md.lock').exists())
        self.assertEqual(self.removal_calls(), [])

    def test_tracker_failure_at_execute_skips_everything(self):
        _, _, items = self.list_items()
        self.env['FAKE_GH_FAIL'] = 'offline'
        wanted = f'{items["evidence/issue-5-qa"]["id"]},{items["evidence/notes"]["id"]}'

        result = self.execute('--only', wanted)

        self.assertEqual(result.stdout.count('跳過：票狀態無法確認'), 2)
        self.assertTrue((self.lat / 'evidence/issue-5-qa').exists())
        self.assertTrue((self.lat / 'evidence/notes').exists())
        self.assertEqual(self.removal_calls(), [])


class RulesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lat = Path(self.temp.name) / '.lat'
        self.lat.mkdir()

    def test_sensitive_rule(self):
        cases = {
            'x/.lat/watch/prompt-y-2.txt': True,
            'a/password.json': True, 'a/auth.json': True, 'a/logs.sqlite-wal': True,
            'a/.credentials.json': True, 'watch/prompt-x-1.txt': True, 'b/claude/sessions/x.jsonl': True,
            'c/notes.md': False, 'c/prompt-x.txt': False,
        }
        for relative, sensitive in cases.items():
            path = self.lat / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('x')
            top = self.lat / relative.split('/')[0]
            item = path if relative.startswith('watch/') else top
            self.assertEqual(bool(_lat_cleanup.sensitive_reason(item)), sensitive, relative)

    def test_ticket_numbers_skip_dates_and_commit_hashes(self):
        cases = {
            'evidence/2026-10-07-hcom151': [151], 'progress/issue-9-notes.md': [9],
            'evidence/sivi-qa195-e3110c4': [195], 'progress/qa-evidence-0a6a46b': [],
            'evidence/186-187-integrated-mado': [186, 187], 'watch/1234.log': [],
        }
        for relative, numbers in cases.items():
            self.assertEqual(_lat_cleanup.ticket_numbers(self.lat / relative, self.lat), numbers, relative)

    def test_shred_refuses_an_item_with_hard_linked_files(self):
        home = self.lat / 'home'
        (home / 'sessions').mkdir(parents=True)
        (home / 'auth.json').write_text('secret')
        (home / 'sessions/chat.jsonl').write_text('conversation')
        outside = Path(self.temp.name) / 'kept.jsonl'
        os.link(home / 'sessions/chat.jsonl', outside)
        calls = []
        original = _lat_cleanup.run_cli
        _lat_cleanup.run_cli = lambda command, **_: calls.append(command)
        try:
            with self.assertRaisesRegex(ValueError, 'other hard links'):
                _lat_cleanup.delete(home, 'shred')
        finally:
            _lat_cleanup.run_cli = original

        self.assertEqual(calls, [])
        self.assertEqual(outside.read_text(), 'conversation')
        self.assertTrue((home / 'auth.json').exists())


class RootsTests(unittest.TestCase):
    """Which .lat folders count, with `git worktree list` answered by a stub."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(os.path.realpath(self.temp.name))
        self.main = self.root / 'main'
        (self.main / '.lat/sessions').mkdir(parents=True)
        self.worktrees = []
        original = _lat_cleanup.run_cli
        _lat_cleanup.run_cli = lambda command, **_: ''.join(
            f'worktree {path}\n' for path in [self.main, *self.worktrees])
        self.addCleanup(setattr, _lat_cleanup, 'run_cli', original)

    def outside(self, name):
        (self.root / name / '.lat').mkdir(parents=True)
        (self.root / name / '.lat/keep.md').write_text('not ours\n')
        return self.root / name

    def test_links_never_make_a_cleanup_root(self):
        (self.main / '.worktrees').symlink_to(self.outside('elsewhere'))
        alias = self.root / 'alias'
        alias.symlink_to(self.outside('registered'))
        self.worktrees = [alias]

        self.assertEqual(_lat_cleanup.lat_directories(self.main / '.lat'), [self.main / '.lat'])
        protection = _lat_cleanup.Protection(self.main / '.lat', issues=[])
        for path in (self.root / 'elsewhere/.lat', self.root / 'registered/.lat/keep.md'):
            self.assertEqual(protection.reason(path), '不在 .lat 內')

    def test_open_ticket_absolute_link_protects_an_external_worktree(self):
        external = self.outside('external')
        (external / '.lat/evidence/qa').mkdir(parents=True)
        (external / '.lat/evidence/qa/shot.png').write_text('x')
        self.worktrees = [external]
        issues = [(7, 'OPEN', f'see {external}/.lat/evidence/qa/shot.png')]

        protection = _lat_cleanup.Protection(self.main / '.lat', issues=issues, need_tracker=True)

        self.assertEqual(protection.lat_dirs, [self.main / '.lat', external / '.lat'])
        for path in (external / '.lat', external / '.lat/evidence/qa'):
            self.assertEqual(protection.reason(path), '開啟中的票連到此路徑 #7')
        self.assertIsNone(protection.reason(external / '.lat/keep.md'))


@unittest.skipUnless(shutil.which('trash-put') and shutil.which('shred'), 'needs trash-cli and shred')
class RealToolsTests(unittest.TestCase):
    """Runs the real trash-put and shred inside a temporary directory and trash."""

    def test_real_trash_and_shred(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lat = root / '.lat'
            plain = lat / 'evidence/plain'
            secret = lat / 'evidence/secret'
            for path in (plain / 'notes.md', secret / 'auth.json'):
                path.parent.mkdir(parents=True)
                path.write_text('content')
            data = root / 'data'
            env = dict(os.environ, XDG_DATA_HOME=str(data))
            saved = os.environ.copy()
            os.environ.update(env)
            try:
                _lat_cleanup.delete(plain, 'trash')
                _lat_cleanup.delete(secret, 'shred')
            finally:
                os.environ.clear()
                os.environ.update(saved)

            self.assertFalse(plain.exists())
            self.assertFalse(secret.exists())
            trashed = {path.name for path in (data / 'Trash/files').iterdir()}
            self.assertEqual(trashed, {'plain', 'secret'})
            self.assertTrue((data / 'Trash/files/plain/notes.md').exists())
            self.assertEqual(list((data / 'Trash/files/secret').iterdir()), [])


if __name__ == '__main__':
    unittest.main()
