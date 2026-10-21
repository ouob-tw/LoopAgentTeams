"""Automatic 40-day cleanup; gh, trash-put and shred are stubs, files are disposable."""
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
from unittest import mock

from test_lat_clean import ACTIVE, ENDED_SID, REPO, CleanTestCase

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-autoclean.py'
RECENT_SID = '33333333-3333-4333-8333-333333333333'
LEGACY_SID = '44444444-4444-4444-8444-444444444444'
NOW = datetime.now(timezone.utc)


def ago(days):
    return (NOW - timedelta(days=days)).isoformat()


def age(path, days):
    """Set `path` and everything below it to `days` old."""
    moment = (NOW - timedelta(days=days)).timestamp()
    for root, directories, files in os.walk(path) if path.is_dir() else [(path.parent, [], [path.name])]:
        for name in directories + files:
            os.utime(Path(root) / name, (moment, moment))
    os.utime(path, (moment, moment))


class AutocleanTestCase(CleanTestCase):
    def setUp(self):
        super().setUp()
        self.session(ACTIVE, 'live', 'active')
        self.session(ENDED_SID, 'gone', 'ended', ended_at_utc=ago(50))
        self.session(RECENT_SID, 'recent', 'ended', ended_at_utc=ago(10))
        self.session(LEGACY_SID, 'legacy', 'completed')
        self.set_issues([
            dict(number=1, state='CLOSED', closedAt=ago(50), body='', comments=[]),
            dict(number=2, state='CLOSED', closedAt=ago(10), body='', comments=[]),
            dict(number=3, state='OPEN', closedAt=None, body='', comments=[]),
            dict(number=4, state='OPEN', closedAt=ago(60), body='reopened', comments=[]),
        ])
        for number in (1, 2, 3, 4, 9):
            self.write(f'runs/issue-{number}/notes.md', 'evidence\n')
        self.write('runs/issue-1/home/codex/auth.json', '{"token": 1}')
        self.write('runs/misc-2026-08-01-proto/index.html', '<p>')
        self.write('progress/issue-1-notes.md', 'old progress\n')
        self.write('decisions/D-1.md', '- status: approved\n')
        self.write('panel-journal.jsonl', '{}\n')
        for sid in (ACTIVE, ENDED_SID, RECENT_SID, LEGACY_SID):
            self.write(f'watch/{sid}.log', 'log\n')
            self.write(f'watch/{sid}.lock')
        for name in ('live', 'gone', 'recent', 'legacy', 'unknown'):
            self.write(f'watch/{name}/watch.jsonl', '{}\n')
        self.write('tasks/done/old-card.md', 'done\n')
        self.write('tasks/done/new-card.md', 'done\n')
        self.write('tasks/live-card.md', '- agent：helper\n- orchestrator：live\n- status：dispatched\n')
        for agent in ('old-agent', 'live', 'helper'):
            self.write(f'watch/waits/{agent}.json', '{}')
            self.write(f'watch/waits/.{agent}.lock')
        self.write('watch/waits/young-lock.json', '{}')
        self.write('watch/waits/.young-lock.lock')
        age(self.lat, 100)
        for path in ('tasks/done/new-card.md', 'watch/waits/.young-lock.lock'):
            age(self.lat / path, 5)
        # A file deep in a ticket folder changed today; only the close time counts.
        (self.lat / 'runs/issue-1/notes.md').write_text('touched today\n')
        self.untouchable = {path: path.read_bytes() for path in (
            *self.lat.glob('decisions/*'), *self.lat.glob('sessions/*'),
            self.lat / 'panel-journal.jsonl', self.lat / f'watch/{ACTIVE}.log',
            self.lat / 'watch/live/watch.jsonl', self.lat / 'tasks/live-card.md',
            self.lat / 'watch/waits/live.json', self.lat / 'watch/waits/helper.json')}

    def autoclean(self, *args):
        return subprocess.run(['uv', 'run', '--no-project', 'python', str(SCRIPT), *map(str, args)],
                              text=True, capture_output=True, env=self.env, timeout=120)

    def enable(self):
        result = self.autoclean('enable', '--workspace', self.work, '--repo', REPO)
        self.assertEqual(result.returncode, 0, result.stderr)

    def run_once(self):
        result = self.autoclean('run', '--workspace', self.work)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def log_lines(self):
        path = self.lat / 'cleanup.log'
        return [line.split('\t') for line in path.read_text().splitlines()] if path.exists() else []

    def outcome(self, relative):
        """The logged outcome of `relative`, or None when it was not logged."""
        found = [line[4] for line in self.log_lines() if line[2] == relative]
        return found[-1] if found else None

    def exists(self, relative):
        return (self.lat / relative).exists()

    def assert_untouched(self):
        for path, content in self.untouchable.items():
            self.assertEqual(path.read_bytes(), content, path)
        removed = ' '.join(self.removal_calls())
        for keep in ('decisions', 'sessions', 'panel-journal'):
            self.assertNotIn(keep, removed)


class DisabledTests(AutocleanTestCase):
    def test_every_trigger_while_off_only_logs_that_it_is_off(self):
        self.run_once()
        module = load()
        module.trigger(self.work)
        self.assertEqual([line[1:] for line in self.log_lines()],
                         [['自動清理', '-', '-', '未開啟']] * 2)
        self.assertEqual(self.calls(), [])
        self.assertTrue(self.exists('runs/issue-1') and self.exists('tasks/done/old-card.md'))
        self.assertFalse(self.exists('cleanup.last-run'))

    def test_dry_run_reports_without_deleting_or_logging_even_while_off(self):
        result = self.autoclean('run', '--workspace', self.work, '--repo', REPO, '--dry-run')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('runs/issue-1\t', result.stdout)
        self.assertIn('將以 shred 刪除', result.stdout)
        self.assertEqual(self.removal_calls(), [])
        self.assertFalse(self.exists('cleanup.log'))

    def test_enable_writes_the_marker_with_the_tracker_repo(self):
        self.enable()
        marker = json.loads((self.lat / 'autoclean-enabled.json').read_text())
        self.assertEqual(marker['repo'], REPO)
        self.assertEqual(datetime.fromisoformat(marker['enabled_at_utc']).tzinfo, timezone.utc)


class EnabledTests(AutocleanTestCase):
    def test_cleans_only_the_four_categories_that_qualify(self):
        self.enable()
        self.run_once()

        for removed in ('runs/issue-1', f'watch/{ENDED_SID}.log', f'watch/{ENDED_SID}.lock',
                        'watch/gone', 'tasks/done/old-card.md', 'watch/waits/old-agent.json',
                        'watch/waits/.old-agent.lock', 'watch/waits/young-lock.json'):
            self.assertFalse(self.exists(removed), removed)
        self.assertEqual(self.outcome('runs/issue-1'), 'shred')
        self.assertEqual(self.outcome('tasks/done/old-card.md'), 'trash')
        self.assertEqual(self.outcome(f'watch/{ENDED_SID}.log'), 'trash')
        self.assertTrue(any(call.startswith('shred -u -- ') and 'auth.json' in call
                            for call in self.removal_calls()))
        size = [line[3] for line in self.log_lines() if line[2] == 'tasks/done/old-card.md'][0]
        self.assertEqual(size, '5')

        kept = {
            'runs/issue-2': '關閉未滿 40 天', 'runs/issue-3': '票仍開啟或已重開',
            'runs/issue-4': '票仍開啟或已重開', 'runs/issue-9': 'tracker 查不到這張票',
            f'watch/{RECENT_SID}.log': '結束未滿 40 天', f'watch/{LEGACY_SID}.log': '無結束時間',
            f'watch/{ACTIVE}.log': '仍有 active session', 'watch/recent': '結束未滿 40 天',
            'watch/legacy': '無結束時間', 'watch/unknown': '沒有 session 紀錄',
            'watch/live': '仍有 active session', 'watch/waits/live.json': 'active session 仍需要',
            'watch/waits/helper.json': 'active session 仍需要',
            'watch/waits/.young-lock.lock': '鎖檔未滿 40 天',
        }
        for path, reason in kept.items():
            self.assertTrue(self.exists(path), path)
            self.assertIn(reason, self.outcome(path) or '', path)
        for path in ('runs/misc-2026-08-01-proto', 'progress/issue-1-notes.md',
                     'tasks/done/new-card.md', 'watch/waits/.live.lock'):
            self.assertTrue(self.exists(path), path)
        self.assertNotIn('misc-', ' '.join(self.removal_calls()))
        self.assertNotIn('progress', ' '.join(self.removal_calls()))
        self.assert_untouched()

    def test_github_failure_skips_only_ticket_folders(self):
        self.enable()
        self.env['FAKE_GH_FAIL'] = 'network down'
        self.run_once()
        self.assertTrue(self.exists('runs/issue-1'))
        self.assertTrue(any(line[1] == '票資料夾' and line[4].startswith('跳過整類')
                            and 'network down' in line[4]
                            for line in self.log_lines()))
        for removed in (f'watch/{ENDED_SID}.log', 'watch/gone', 'tasks/done/old-card.md',
                        'watch/waits/old-agent.json'):
            self.assertFalse(self.exists(removed), removed)
        self.assert_untouched()

    def test_a_second_trigger_within_24_hours_does_nothing(self):
        self.enable()
        self.run_once()
        self.write('tasks/done/later.md', 'done\n')
        age(self.lat / 'tasks/done/later.md', 100)
        before = len(self.calls())
        self.run_once()
        self.assertEqual(len(self.calls()), before)
        self.assertTrue(self.exists('tasks/done/later.md'))
        self.assertIn('24 小時內已執行', self.log_lines()[-1][4])

        stamp = self.lat / 'cleanup.last-run'
        stamp.write_text(ago(1.1) + '\n')
        self.run_once()
        self.assertFalse(self.exists('tasks/done/later.md'))

    def test_reactivated_session_and_reopened_ticket_are_no_longer_cleaned(self):
        self.enable()
        record = self.lat / f'sessions/{ENDED_SID}.json'
        data = json.loads(record.read_text())
        data.update(status='active')
        data.pop('ended_at_utc')
        record.write_text(json.dumps(data))
        self.set_issues([dict(number=1, state='OPEN', closedAt=ago(50), body='', comments=[])])
        self.run_once()
        for path in ('runs/issue-1', f'watch/{ENDED_SID}.log', 'watch/gone'):
            self.assertTrue(self.exists(path), path)

    def test_an_open_ticket_linking_a_closed_tickets_folder_keeps_it(self):
        self.enable()
        self.set_issues([dict(number=1, state='CLOSED', closedAt=ago(50), body='', comments=[]),
                         dict(number=5, state='OPEN', closedAt=None,
                              body='see .lat/runs/issue-1/notes.md', comments=[])])
        self.run_once()
        self.assertTrue(self.exists('runs/issue-1'))
        self.assertIn('開啟中的票連到此路徑 #5', self.outcome('runs/issue-1'))

    def test_unreadable_session_record_keeps_everything(self):
        self.enable()
        self.write('sessions/broken.json', '{')
        self.run_once()
        self.assertEqual(self.removal_calls(), [])
        self.assertIn('讀不到 session 紀錄', self.outcome('tasks/done/old-card.md'))

    def test_trigger_starts_the_pass_in_the_background(self):
        self.enable()
        module = load()
        with mock.patch.dict(os.environ, self.env, clear=True):
            started = time.monotonic()
            module.trigger(self.work)
            self.assertLess(time.monotonic() - started, 2)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and not any(line[4] == '結束' for line in self.log_lines()):
            time.sleep(0.1)
        self.assertFalse(self.exists('runs/issue-1'))

    def test_trigger_never_raises(self):
        module = load()
        (self.lat / 'cleanup.log').mkdir()
        with mock.patch('sys.stdout', new_callable=io.StringIO) as output:
            module.trigger(self.root / 'missing')
            module.trigger(self.work)
        self.assertEqual(output.getvalue().count('自動清理未啟動'), 2)


def load():
    spec = importlib.util.spec_from_file_location('lat_autoclean_under_test', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


if __name__ == '__main__':
    unittest.main()
