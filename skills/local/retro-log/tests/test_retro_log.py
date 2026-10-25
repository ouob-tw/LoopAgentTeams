"""retro-log backlog store contracts through the command entry point."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/retro-log.py'
T1, T2, T3 = '2026-10-01T10:00:00+08:00', '2026-10-02T10:00:00+08:00', '2026-10-03T10:00:00+08:00'


class RetroLogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backlog = Path(self.temp.name) / 'backlog'
        self.env = {**os.environ, 'HOME': self.temp.name, 'RETRO_BACKLOG_DIR': str(self.backlog)}

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True,
                              env=self.env, cwd=self.temp.name)

    def ok(self, *args):
        result = self.cli(*args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def refused(self, *args):
        result = self.cli(*args)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stderr

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.backlog), *args], check=True, capture_output=True,
                              text=True).stdout

    def commits(self):
        return self.git('log', '--format=%s').splitlines()

    def add(self, title='Flaky waits', session='s1', time=T1, *extra, description='Agent slept instead of listening'):
        return self.ok('add', '--title', title, '--description', description, '--suggestion', 'Use hcom listen',
                       '--project', 'proj', '--client', 'claude', '--session', session, '--evidence', 'slept 60s',
                       '--time', time, *extra)

    def occur(self, entry_id, session, time=T2):
        return self.ok('occur', str(entry_id), '--project', 'proj2', '--client', 'codex', '--session', session,
                       '--evidence', 'again', '--time', time)

    def front(self, entry_id):
        text = (self.backlog / 'entries' / f'{entry_id:04d}.md').read_text()
        return dict(line.split(': ', 1) for line in text.split('---\n')[1].splitlines())

    def test_first_write_creates_repo_without_remote_and_commits_once(self):
        self.assertFalse(self.backlog.exists())
        out = self.add()
        self.assertIn('已新增 #1 [觀察中]', out)
        self.assertEqual(self.git('remote').strip(), '')
        self.assertEqual(self.commits(), ['feat: add #1 Flaky waits'])
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertEqual(self.front(1)['status'], '"observing"')

    def test_default_location_is_home_retro_backlog(self):
        del self.env['RETRO_BACKLOG_DIR']
        self.ok('init')
        self.assertTrue((Path(self.temp.name) / 'retro-backlog/.git').is_dir())

    def test_second_distinct_session_makes_ready_and_same_session_is_deduplicated(self):
        self.add()
        out = self.ok('occur', '1', '--project', 'proj', '--client', 'claude', '--session', 's1',
                      '--evidence', 'dup', '--time', T2)
        self.assertIn('已存在', out)
        self.assertEqual(len(self.commits()), 1)
        out = self.occur(1, 's2')
        self.assertIn('#1 [可處理]', out)
        self.assertIn('2 個 session', out)
        self.assertEqual(self.commits()[0], 'chore: record occurrence of #1')
        self.assertEqual(self.front(1)['status'], '"ready"')

    def test_severe_is_ready_and_unsetting_recomputes(self):
        self.add('Only severe')
        self.add('Two sessions', 's1')
        self.occur(2, 's2')
        self.assertIn('#1 [可處理]［嚴重］', self.ok('severe', '1', '--reason', 'wrong build shipped', '--time', T2))
        self.ok('severe', '2', '--reason', 'lost a day', '--time', T2)
        self.assertIn('#1 [觀察中]', self.ok('severe', '1', '--unset', '--time', T3))
        self.assertIn('#2 [可處理]', self.ok('severe', '2', '--unset', '--time', T3))
        self.assertEqual(self.front(1)['severe'], 'false')
        self.assertIn('- 2026-10-02T10:00:00+08:00 | severe | wrong build shipped', self.ok('show', '1'))

    def test_severe_requires_reason_and_add_can_set_severe(self):
        self.add()
        self.assertIn('--reason', self.refused('severe', '1'))
        out = self.add('Data loss', 's9', T1, '--severe', 'deleted files')
        self.assertIn('#2 [可處理]［嚴重］', out)

    def test_state_follows_record_time_not_insertion_order(self):
        self.add('set first', 'a')
        self.add('unset first', 'b')
        self.ok('severe', '1', '--reason', 'r', '--time', T3)
        self.assertIn('目前仍是嚴重', self.ok('severe', '1', '--unset', '--time', T2))
        self.ok('severe', '2', '--unset', '--time', T2)
        self.ok('severe', '2', '--reason', 'r', '--time', T3)
        for entry_id in (1, 2):
            self.assertEqual(self.front(entry_id)['status'], '"ready"')
            self.assertEqual(self.front(entry_id)['severe'], 'true')

    def test_same_time_processing_is_refused_and_time_defaults_to_now(self):
        self.add()
        self.ok('severe', '1', '--reason', 'r', '--time', T3)
        self.assertIn('已有時間', self.refused('severe', '1', '--unset', '--time', T3))
        self.ok('occur', '1', '--project', 'p', '--client', 'codex', '--session', 's2', '--evidence', 'e')
        last = self.ok('show', '1').split('## 出現紀錄')[1].split('## 處理紀錄')[0].strip().splitlines()[-1]
        self.assertRegex(last, r'^- 20\d\d-\d\d-\d\dT[\d:.]+[+-]\d\d:\d\d \| p \| codex \| s2 \| e$')

    def test_ready_list_is_ranked_and_limited(self):
        self.add('one session older', 'a', T1)
        self.add('two sessions', 'b', T1)
        self.occur(2, 'c', T1)
        self.add('severe', 'd', T1, '--severe', 'shipped wrong')
        self.add('two sessions newer', 'e', T1)
        self.occur(4, 'f', T3)
        self.add('three sessions', 'g', T1)
        self.occur(5, 'h', T1)
        self.occur(5, 'i', T1)
        out = self.ok('list', '--status', 'ready').splitlines()
        self.assertEqual([line.split(' ')[0] for line in out], ['#3', '#5', '#4', '#2'])
        self.assertEqual(len(self.ok('list', '--status', 'ready', '--limit', '2').splitlines()), 2)
        self.assertEqual(self.ok('list', '--status', 'observing').split(' ')[0], '#1')

    def test_search_matches_title_and_body_and_show_prints_entry(self):
        self.add('Flaky waits')
        self.add('Ports collide', 's2', description='Board tests reused port 7100')
        self.assertTrue(self.ok('search', 'flaky').startswith('#1 '))
        self.assertTrue(self.ok('search', '7100').startswith('#2 '))
        self.assertIn('沒有符合', self.ok('search', 'nothing-here'))
        shown = self.ok('show', '2')
        for part in ('title: "Ports collide"', 'Board tests reused port 7100', 'Use hcom listen',
                     '| proj | claude | s2 | slept 60s'):
            self.assertIn(part, shown)

    def test_commit_failure_restores_and_rerun_adds_only_one_entry(self):
        self.add()
        hook = self.backlog / '.git/hooks/pre-commit'
        hook.write_text('#!/bin/sh\nexit 1\n')
        hook.chmod(0o755)
        result = self.cli('add', '--title', 'Second', '--description', 'd', '--suggestion', 's', '--project', 'p',
                          '--client', 'codex', '--session', 'x', '--evidence', 'e')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('已還原', result.stderr)
        self.assertIn('重跑', result.stderr)
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertEqual(len(self.commits()), 1)
        hook.unlink()
        self.ok('add', '--title', 'Second', '--description', 'd', '--suggestion', 's', '--project', 'p',
                '--client', 'codex', '--session', 'x', '--evidence', 'e')
        self.assertEqual(sorted(p.name for p in (self.backlog / 'entries').iterdir()), ['0001.md', '0002.md'])

    @unittest.skipIf(os.geteuid() == 0, 'root ignores the read-only .git that makes the rollback fail')
    def test_rollback_failure_says_not_restored_and_restore_recovers(self):
        self.add()
        hook = self.backlog / '.git/hooks/pre-commit'
        hook.write_text('#!/bin/sh\nchmod a-w .git\nexit 1\n')  # commit and the rollback reset both fail
        hook.chmod(0o755)
        result = self.cli('add', '--title', 'Second', '--description', 'd', '--suggestion', 's', '--project', 'p',
                          '--client', 'codex', '--session', 'x', '--evidence', 'e')
        (self.backlog / '.git').chmod(0o755)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('還原也失敗', result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        hook.unlink()
        self.assertIn('entries/0002.md', self.ok('restore'))
        self.ok('add', '--title', 'Second', '--description', 'd', '--suggestion', 's', '--project', 'p',
                '--client', 'codex', '--session', 'x', '--evidence', 'e')
        self.assertEqual(sorted(p.name for p in (self.backlog / 'entries').iterdir()), ['0001.md', '0002.md'])

    def test_git_index_lock_refuses_before_writing(self):
        self.add()
        (self.backlog / '.git/index.lock').touch()
        self.assertIn('index.lock', self.refused('occur', '1', '--project', 'p', '--client', 'codex',
                                                 '--session', 's2', '--evidence', 'e'))
        self.assertTrue((self.backlog / '.git/index.lock').exists())
        self.assertNotIn('s2', (self.backlog / 'entries/0001.md').read_text())

    def test_leftover_changes_block_writes_until_restore(self):
        self.add()
        (self.backlog / 'entries/0001.md').write_text('half written')
        (self.backlog / 'stray.txt').write_text('x')
        err = self.refused('occur', '1', '--project', 'p', '--client', 'codex', '--session', 's2', '--evidence', 'e')
        self.assertIn('entries/0001.md', err)
        self.assertIn('stray.txt', err)
        self.assertIn('restore', err)
        self.assertIn('stray.txt', self.ok('restore'))
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertIn('#1 [可處理]', self.ok('occur', '1', '--project', 'p', '--client', 'codex',
                                             '--session', 's2', '--evidence', 'e'))

    def test_invalid_operations_exit_nonzero_with_reason(self):
        self.add()
        self.assertIn('#9', self.refused('occur', '9', '--project', 'p', '--client', 'codex', '--session', 's',
                                         '--evidence', 'e'))
        self.assertIn('client', self.refused('occur', '1', '--project', 'p', '--client', 'gemini', '--session', 's',
                                             '--evidence', 'e'))
        self.assertIn('時間格式', self.refused('severe', '1', '--reason', 'r', '--time', 'yesterday'))
        self.assertIn('換行', self.refused('occur', '1', '--project', 'p', '--client', 'codex', '--session', 's',
                                           '--evidence', 'a\nb'))
        self.assertIn('分行', self.refused('occur', '1', '--project', 'p', '--client', 'codex', '--session', 's',
                                           '--evidence', 'a\x0cb'))
        self.assertIn('#1', self.ok('list'))
        self.assertEqual(len(self.commits()), 1)


if __name__ == '__main__':
    unittest.main()
