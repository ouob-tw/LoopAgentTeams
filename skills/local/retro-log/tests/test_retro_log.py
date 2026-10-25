"""retro-log backlog store contracts through the command entry point."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/retro-log.py'
T1, T2, T3 = '2026-10-01T10:00:00+08:00', '2026-10-02T10:00:00+08:00', '2026-10-03T10:00:00+08:00'
T4, T5, T6 = '2026-10-04T10:00:00+08:00', '2026-10-05T10:00:00+08:00', '2026-10-06T10:00:00+08:00'


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

    def test_concurrent_adds_get_distinct_ids(self):
        self.add()
        writers = [subprocess.Popen([sys.executable, str(SCRIPT), 'add', '--title', f'Writer {n}', '--description', 'd',
                                     '--suggestion', 's', '--project', 'p', '--client', 'codex', '--session', f'w{n}',
                                     '--evidence', 'e'], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, cwd=self.temp.name) for n in range(4)]
        for writer in writers:
            _, err = writer.communicate()
            self.assertEqual(writer.returncode, 0, err)
        titles = sorted(self.front(n)['title'] for n in range(2, 6))
        self.assertEqual(titles, [f'"Writer {n}"' for n in range(4)])
        self.assertEqual(len(self.commits()), 5)

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

    def state(self, entry_id):
        front = self.front(entry_id)
        return front['status'].strip('"'), front['recurring']

    def records(self, entry_id):
        return self.ok('show', str(entry_id)).split('## 出現紀錄')[1]

    def test_done_needs_commit_or_file_and_wontfix_needs_reason(self):
        self.add()
        self.assertIn('--commit', self.refused('done', '1', '--time', T2))
        self.assertIn('--reason', self.refused('wontfix', '1', '--time', T2))
        self.assertEqual(len(self.commits()), 1)
        self.assertIn('#1 [已完成]', self.ok('done', '1', '--file', 'skills/x/SKILL.md', '--time', T2))
        self.assertIn('| done | file skills/x/SKILL.md', self.ok('show', '1'))

    def test_done_reopens_as_recurring_only_for_a_session_new_after_done(self):
        self.add('fixed', 's1', T1)
        self.ok('done', '1', '--commit', 'abc123', '--time', T3)
        self.occur(1, 's2', T2)  # backfilled, before the fix
        self.assertEqual(self.state(1), ('done', 'false'))
        self.occur(1, 's1', T4)  # a session already seen before the fix
        self.assertEqual(self.state(1), ('done', 'false'))
        self.assertIn('#1 [可處理]［復發］', self.occur(1, 's3', T4))
        self.assertEqual(self.state(1), ('ready', 'true'))

    def test_wontfix_reopens_after_two_new_sessions_without_recurring(self):
        self.add('skip', 's1', T1)
        self.ok('wontfix', '1', '--reason', 'not worth it', '--time', T2)
        self.occur(1, 's1', T3)
        out = self.occur(1, 's2', T3)
        self.assertIn('#1 [不做]', out)
        self.assertIn('2 個 session', out)
        self.assertIn('#1 [可處理] skip（3 個 session）', self.occur(1, 's3', T4))
        self.assertEqual(self.state(1), ('ready', 'false'))
        # closing again counts from the latest record: s4 alone does not reopen, s5 does
        self.ok('wontfix', '1', '--reason', 'still not worth it', '--time', T5)
        self.occur(1, 's4', T6)
        self.assertEqual(self.state(1), ('wontfix', 'false'))
        self.occur(1, 's5', T6)
        self.assertEqual(self.state(1), ('ready', 'false'))

    def test_done_again_after_recurring_counts_from_the_latest_done(self):
        self.add('fixed twice', 's1', T1)
        self.ok('done', '1', '--commit', 'c1', '--time', T2)
        self.occur(1, 's2', T3)
        self.ok('done', '1', '--commit', 'c2', '--time', T4)
        self.assertEqual(self.state(1), ('done', 'false'))
        self.occur(1, 's2', T5)
        self.assertEqual(self.state(1), ('done', 'false'))
        self.occur(1, 's3', T5)
        self.assertEqual(self.state(1), ('ready', 'true'))

    def test_manual_ready_holds_until_closed_and_reopens_closed_entries(self):
        self.add('manual', 's1', T1)
        self.ok('severe', '1', '--reason', 'r', '--time', T2)
        self.assertIn('#1 [可處理]', self.ok('ready', '1', '--time', T3))
        self.ok('severe', '1', '--unset', '--time', T4)
        self.assertEqual(self.state(1), ('ready', 'false'))
        self.ok('done', '1', '--commit', 'c1', '--time', T5)
        self.assertEqual(self.state(1), ('done', 'false'))
        self.assertIn('#1 [已完成]［嚴重］', self.ok('severe', '1', '--reason', 'r2', '--time', T6))
        self.add('dropped', 's1', T1)
        self.ok('wontfix', '2', '--reason', 'meh', '--time', T2)
        self.assertIn('#2 [可處理]', self.ok('ready', '2', '--time', T3))
        self.ok('ready', '1', '--time', '2026-10-07T10:00:00+08:00')
        for entry_id in (1, 2):
            self.assertEqual(self.state(entry_id), ('ready', 'false'))

    def test_processing_sorts_after_occurrence_at_same_time_and_second_record_at_same_time_is_refused(self):
        self.add('same instant', 's1', T1)
        self.ok('done', '1', '--commit', 'c1', '--time', T2)
        self.occur(1, 's2', T2)  # same instant as the fix: counts as before it
        self.assertEqual(self.state(1), ('done', 'false'))
        self.assertIn('已有時間', self.refused('wontfix', '1', '--reason', 'r', '--time', T2))
        self.assertIn('已有時間', self.refused('done', '1', '--commit', 'c2', '--time', T2))
        self.assertEqual(self.commits()[0], 'chore: record occurrence of #1')

    def test_result_does_not_depend_on_write_order(self):
        self.add('in order', 's1', T1)
        self.occur(1, 's2', T2)
        self.ok('done', '1', '--commit', 'c1', '--time', T3)
        self.occur(1, 's3', T4)
        self.add('done first', 's1', T1)
        self.ok('done', '2', '--commit', 'c1', '--time', T3)
        self.occur(2, 's3', T4)
        self.occur(2, 's2', T2)  # backfilled after the fix was written
        self.assertEqual(self.records(2), self.records(1))
        self.assertEqual(self.state(2), ('ready', 'true'))
        # a session first written after the fix and backfilled earlier keeps the earlier time
        self.add('session moved', 's1', T1)
        self.ok('done', '3', '--commit', 'c1', '--time', T3)
        self.occur(3, 's2', T4)
        self.assertEqual(self.state(3), ('ready', 'true'))
        self.assertIn('改用較早的時間', self.occur(3, 's2', T2))
        self.assertEqual(self.state(3), ('done', 'false'))

    def test_rerunning_the_same_commands_leaves_the_entry_unchanged(self):
        self.add('rerun', 's1', T1)
        script = [('occur', '1', '--project', 'proj2', '--client', 'codex', '--session', 's2', '--evidence', 'again',
                   '--time', T2),
                  ('done', '1', '--commit', 'c1', '--time', T3),
                  ('done', '1', '--commit', 'c1', '--file', 'a.md', '--time', T4),
                  ('wontfix', '1', '--reason', 'meh', '--time', T5),
                  ('severe', '1', '--reason', 'r', '--time', T6)]
        for command in script:
            self.ok(*command)
        before, commits = self.ok('show', '1'), self.commits()
        for command in script:
            self.assertIn('已存在', self.ok(*command))
        self.assertEqual(self.ok('show', '1'), before)
        self.assertEqual(self.commits(), commits)
        self.assertEqual(before.count('| done |'), 1)


if __name__ == '__main__':
    unittest.main()
