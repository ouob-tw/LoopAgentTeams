"""`run` goes to another host from the config's `hosts` when this host makes it wait. The other
hosts are directories under remotes/ reached through the fake `ssh` GateCase puts first on
PATH (see install_fake_ssh); no test reaches a real host or the real config."""
import json
import os
import signal
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GateCase, git  # noqa: E402
from test_suite_gate_rerun import RerunCase  # noqa: E402


class RemoteMixin:
    """This host braked (disk wait 90%, no floor), other hosts as remotes/<name>."""

    def brake_here(self, hosts=('s3',), **config):
        self.fake_host(io=90.0)
        self.set_config(min_slots=0, max_slots=2, remote_poll_seconds=0.05,
                        remote_connect_seconds=1, hosts=list(hosts), **config)

    def unbrake_here(self):
        self.fake_host(io=0.0)

    def add_host(self, name, io=0.0, cpu=0.0):
        """A reachable host: its home, pressure files and bin/ (a systemd-run that fails, so
        no test starts a real user scope through it)."""
        base = self.remotes / name
        (base / 'home').mkdir(parents=True, exist_ok=True)
        (base / 'bin').mkdir(exist_ok=True)
        self.host_tool(name, 'systemd-run', 'exit 1')
        self.host_pressure(name, io, cpu)
        return base

    def host_pressure(self, name, io=0.0, cpu=0.0):
        proc = self.remotes / name / 'proc/pressure'
        proc.mkdir(parents=True, exist_ok=True)
        for key, value in (('io', io), ('cpu', cpu)):
            (proc / key).write_text(f'some avg10={value:.2f} avg60=0.00 avg300=0.00 total=0\n')

    def host_tool(self, name, tool, body):
        path = self.remotes / name / 'bin' / tool
        path.write_text(f'#!/bin/sh\n{body}\n')
        path.chmod(0o755)

    def trees(self, name):
        return list((self.remotes / name / 'home/.cache/suite-gate/remote').glob('*/*/tree'))

    def tree(self, name):
        [tree] = self.trees(name)
        return tree

    def waiter_reasons(self):
        return [w.get('remote') or {} for w in self.status()['waiting']
                if w.get('kind') == 'slot']

    def pid_alive(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        return self.alive(pid)


class OffloadTests(RemoteMixin, GateCase):
    def setUp(self):
        super().setUp()
        (self.repo / 'ignored').mkdir()
        (self.repo / 'ignored/secret.txt').write_text('do not send\n')
        (self.repo / '.env.test').write_text('TOKEN=1\n')
        (self.repo / 'new.py').write_text('y = 2\n')  # unignored, not committed

    def test_without_a_host_list_a_braked_host_queues_as_before(self):
        for hosts in (None, [], [5, {'host': '-oProxyCommand=x'}, {'host': 's3', 'max_runs': 0}]):
            with self.subTest(hosts=hosts):
                self.fake_host(io=90.0)
                values = dict(min_slots=0, max_slots=2)
                if hosts is not None:
                    values['hosts'] = hosts
                self.set_config(**values)
                self.add_host('s3')
                proc = self.start('run', '--', f'{self.suite()} # {hosts}')
                self.wait_until(lambda: self.waiting_reason()
                                == ['brake on: disk wait 90%, above 40%'], message='queued')
                time.sleep(0.3)
                self.assertIsNone(proc.poll())
                self.unbrake_here()
                code, _, err = self.finish(proc)
                self.assertEqual(code, 0, err)
                self.assertEqual(self.ssh_calls(), [])
                self.assertIsNone(self.records()[-1]['host'])
                if hosts:
                    self.assertEqual(err.count('config hosts[0]=5 is not usable'), 1)
                    self.assertEqual(err.count('config hosts[1]='), 1)
                    self.assertEqual(err.count('config hosts[2]='), 1)

    def test_a_braked_host_runs_the_suite_on_the_first_usable_host(self):
        self.add_host('s3')
        self.brake_here()
        suite = f'pwd > {self.tmp}/where; ls -a > {self.tmp}/files; {self.suite(code=3)}'
        result = self.gate('run', '--', suite)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertIn('suite-out', result.stdout)
        self.assertIn('suite-err', result.stderr)
        self.assertIn('runs on s3 instead', result.stderr)
        self.assertEqual(self.runs(), 1)
        tree = self.tree('s3')
        self.assertEqual((self.tmp / 'where').read_text().strip(), str(tree))
        sent = (self.tmp / 'files').read_text().split()
        self.assertIn('new.py', sent)
        self.assertIn('app.py', sent)
        for name in ('ignored', '.env.test', '.git'):
            self.assertNotIn(name, sent)
        self.assertFalse((tree / 'ignored').exists())
        [record] = self.records()
        self.assertEqual(record['host'], 's3')
        self.assertEqual(record['exit_code'], 3)
        self.assertIn('suite-out', record['output_tail'])
        self.assertEqual(record['fingerprint'],
                         self.gate_module().fingerprint(self.repo, [suite])['fingerprint'])
        self.assertEqual(self.status()['remote'], [])
        for call in self.ssh_calls('s3'):
            self.assertIn('BatchMode=yes', call['options'])
            self.assertTrue(any(o.startswith('ConnectTimeout=') for o in call['options']))

    def gate_module(self):
        from test_suite_gate import gate
        return gate

    def test_a_pass_there_is_reused_here_and_status_shows_the_run_there(self):
        self.add_host('s3')
        self.brake_here()
        release = self.tmp / 'release'
        suite = f'echo run >> {self.counter}; while [ ! -f {release} ]; do sleep 0.05; done'
        proc = self.start('run', '--', suite)
        self.wait_until(lambda: [h.get('phase') for h in self.status()['remote']] == ['running'],
                        message='running on s3')
        [held] = self.status()['remote']
        self.assertEqual((held['host'], held['agent'], held['command']), ('s3', 't-tester', suite))
        shown = self.gate('status').stdout
        self.assertIn('On other hosts (1 running; hosts: s3):', shown)
        self.assertIn(f'  s3  running  t-tester  ', shown)
        release.touch()
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0, err)
        self.assertTrue(self.records()[-1]['reusable'])
        self.unbrake_here()
        again = self.gate('run', '--', suite)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already passed', again.stdout)
        self.assertIn('ran on:      s3 (another host)', again.stdout)
        self.assertEqual(self.runs(), 1)

    def test_each_host_says_why_it_was_not_used_and_a_later_poll_sends_the_suite(self):
        self.add_host('lab', io=90.0)
        self.add_host('full')
        self.add_host('nochrome')
        (self.repo / '.suite-gate.json').write_text(json.dumps(
            {'remote_checks': {'.': ['test -x "$CHROME"']}}))
        self.brake_here(hosts=['gone', 'lab', {'host': 'full', 'max_runs': 1},
                               {'host': 'nochrome', 'env': {'CHROME': '/nowhere/chrome'}}])
        # `full` is busy with a run from another work tree of this host.
        other = self.tmp / 'other'
        other.mkdir()
        git(other, 'init', '-q', '-b', 'main')
        (other / 'a.py').write_text('a = 1\n')
        git(other, 'add', '-A')
        self.commit(other, 'init')
        release = self.tmp / 'release'
        self.set_config(min_slots=0, max_slots=2, remote_poll_seconds=0.05,
                        remote_connect_seconds=1, hosts=[{'host': 'full', 'max_runs': 1}])
        blocker = self.start('run', '--', f'while [ ! -f {release} ]; do sleep 0.05; done',
                             cwd=other)
        self.wait_until(lambda: [h.get('phase') for h in self.status()['remote']] == ['running'],
                        message='the other work tree runs on full')
        self.brake_here(hosts=['gone', 'lab', {'host': 'full', 'max_runs': 1},
                               {'host': 'nochrome', 'env': {'CHROME': '/nowhere/chrome'}}])
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: len(self.waiter_reasons()) == 1
                        and len(self.waiter_reasons()[0]) == 4, message='reasons')
        [reasons] = self.waiter_reasons()
        self.assertIn('cannot reach it over ssh', reasons['gone'])
        self.assertEqual(reasons['lab'], 'brake on: disk wait 90%, above 40%')
        self.assertEqual(reasons['full'],
                         'its limit is reached (1/1 suite(s) from this host running there)')
        self.assertEqual(reasons['nochrome'], 'the project check failed: test -x "$CHROME"')
        shown = self.gate('status').stdout
        self.assertIn('    not on lab: brake on: disk wait 90%, above 40%', shown)
        self.assertIsNone(proc.poll())
        self.assertEqual(self.runs(), 0)
        # The browser shows up on nochrome: the next poll sends the suite there.
        chrome = self.remotes / 'nochrome/chrome'
        chrome.write_text('#!/bin/sh\n')
        chrome.chmod(0o755)
        self.brake_here(hosts=['gone', 'lab', {'host': 'full', 'max_runs': 1},
                               {'host': 'nochrome', 'env': {'CHROME': str(chrome)}}])
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0, err)
        self.assertIn('not on lab: brake on', err)
        self.assertEqual(self.records()[-1]['host'], 'nochrome')
        release.touch()
        self.assertEqual(self.finish(blocker)[0], 0)

    def test_one_work_tree_never_uses_its_cache_there_twice_at_once(self):
        self.add_host('s3')
        self.brake_here(hosts=[{'host': 's3', 'max_runs': 2}])
        release = self.tmp / 'release'
        first = self.start('run', '--', f'while [ ! -f {release} ]; do sleep 0.05; done')
        self.wait_until(lambda: len(self.status()['remote']) == 1, message='first on s3')
        second = self.start('run', '--', self.suite())
        self.wait_until(lambda: self.waiter_reasons() == [
            {'s3': 'another run of this work tree is using its cache there'}],
            message='second waits for the cache')
        release.touch()
        self.assertEqual(self.finish(first)[0], 0)
        code, _, err = self.finish(second)
        self.assertEqual(code, 0, err)
        self.assertEqual([r['host'] for r in self.records()], ['s3', 's3'])

    def test_a_fingerprint_with_ignored_files_stays_here_and_says_why(self):
        self.add_host('s3')
        (self.repo / '.suite-gate.json').write_text(json.dumps(
            {'fingerprint_include': ['.env.test']}))
        self.brake_here()
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: self.waiter_reasons() == [{'s3': (
            'its fingerprint takes in git-ignored files (fingerprint_include: .env.test), '
            'which are never sent to another host')}], message='not sent')
        self.assertEqual(self.ssh_calls(), [])
        self.unbrake_here()
        self.assertEqual(self.finish(proc)[0], 0)
        self.assertIsNone(self.records()[-1]['host'])

    def test_content_that_differs_after_sending_does_not_run_there(self):
        self.add_host('s3')
        # rsync on s3 changes a file after it lands, as a broken transfer would.
        self.host_tool('s3', 'rsync', '/usr/bin/rsync "$@"; code=$?\n'
                       'for f in "$HOME"/.cache/suite-gate/remote/*/*/tree/app.py; do '
                       '[ -f "$f" ] && echo tampered >> "$f"; done\nexit $code')
        self.brake_here()
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: 'differs from this work tree after sending it' in
                        (self.waiter_reasons() or [{}])[0].get('s3', ''), message='refused')
        self.assertEqual(self.runs(), 0)
        self.unbrake_here()
        self.assertEqual(self.finish(proc)[0], 0)
        self.assertIsNone(self.records()[-1]['host'])

    def test_the_suite_leaves_no_process_there_and_files_it_leaves_are_removed_next_time(self):
        self.add_host('s3')
        self.brake_here()
        pids = self.tmp / 'pids'
        result = self.gate('run', '--', f'sleep 60 & echo $! > {pids}; echo leftover > junk.txt')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.pid_alive(int(pids.read_text())))
        record = self.records()[-1]
        self.assertTrue(record['content_changed'], 'junk.txt is new content there')
        self.assertFalse(record['reusable'])
        self.assertTrue((self.tree('s3') / 'junk.txt').exists())
        result = self.gate('run', '--', f'ls > {self.tmp}/files')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('junk.txt', (self.tmp / 'files').read_text().split())
        self.assertTrue(self.records()[-1]['reusable'])

    def test_a_change_here_during_a_run_there_is_content_changed(self):
        self.add_host('s3')
        self.brake_here()
        result = self.gate('run', '--', f'echo z = 3 >> {self.repo}/app.py')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.records()[-1]
        self.assertEqual(record['host'], 's3')
        self.assertTrue(record['content_changed'])
        self.assertFalse(record['reusable'])

    def test_preparation_runs_there_and_a_failed_or_changing_one_is_no_test_result(self):
        self.add_host('s3')
        (self.repo / 'bun.lock').write_text('{}\n')
        log = self.tmp / 'bun-calls'
        self.host_tool('s3', 'bun', f'echo "$PWD $*" >> {log}; exit 1')
        self.brake_here()
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: 'there failed (exit 1); this is not a test result' in
                        (self.waiter_reasons() or [{}])[0].get('s3', ''), message='prep failed')
        self.assertEqual(self.records(), [])
        self.assertEqual(self.runs(), 0)
        self.assertIn('install --frozen-lockfile', log.read_text())
        # A preparation that changes a sent file does not run there either.
        self.host_tool('s3', 'bun', 'echo changed >> app.py')
        self.wait_until(lambda: 'changed during the preparation' in
                        (self.waiter_reasons() or [{}])[0].get('s3', ''), message='prep changed')
        self.assertEqual(self.runs(), 0)
        # A preparation that only adds ignored files is fine; they stay for the next run.
        (self.repo / '.gitignore').write_text('ignored/\n.env.test\nnode_modules/\n')
        self.host_tool('s3', 'bun', 'mkdir -p node_modules && echo dep > node_modules/dep')
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.records()[-1]['host'], 's3')
        self.assertTrue(self.records()[-1]['reusable'])
        self.assertTrue((self.tree('s3') / 'node_modules/dep').exists())

    def test_a_missing_tool_the_preparation_needs_keeps_the_suite_off_that_host(self):
        self.add_host('s3')
        (self.repo / 'bun.lock').write_text('{}\n')
        self.host_tool('s3', 'bun', 'exit 0')
        self.brake_here()
        env_path = self.env['PATH']
        # Only s3's own bin and the basics: no bun anywhere but where the test puts it.
        self.env['PATH'] = f"{self.tmp / 'bin'}:/usr/bin:/bin"
        (self.remotes / 's3/bin/bun').unlink()
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: self.waiter_reasons() == [{'s3': 'missing bun'}],
                        message='missing bun')
        self.env['PATH'] = env_path
        self.unbrake_here()
        self.assertEqual(self.finish(proc)[0], 0)

    def test_interrupting_the_gate_ends_the_process_group_there(self):
        self.add_host('s3')
        self.brake_here()
        pids = self.tmp / 'pids'
        proc = self.start('run', '--', f'sleep 60 & echo $! > {pids}; sleep 60')
        self.wait_until(lambda: pids.exists() and pids.read_text().strip(), message='started')
        leftover = int(pids.read_text())
        self.assertTrue(self.pid_alive(leftover))
        proc.send_signal(signal.SIGINT)
        code, _, err = self.finish(proc)
        self.assertEqual(code, 128 + signal.SIGINT, err)
        self.wait_until(lambda: not self.pid_alive(leftover), timeout=10,
                        message='the group there ended')
        self.assertEqual(self.records(), [])
        self.assertEqual(self.status()['remote'], [])

    def test_a_timeout_ends_the_process_group_there(self):
        self.add_host('s3')
        self.brake_here()
        self.env['SUITE_GATE_SILENCE_SECONDS'] = '1'
        pids = self.tmp / 'pids'
        result = self.gate('run', '--', f'sleep 60 & echo $! > {pids}; sleep 60')
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertFalse(self.pid_alive(int(pids.read_text())))
        self.assertEqual(self.records()[-1]['host'], 's3')
        self.assertIn('timed_out', self.records()[-1])

    def test_the_light_path_and_affected_runs_stay_here(self):
        self.add_host('s3')
        self.brake_here()
        self.set_config(min_slots=0, max_slots=2, light_min_slots=1, hosts=['s3'],
                        remote_poll_seconds=0.05)
        result = self.gate('light', '--', 'true')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ssh_calls(), [])


class RemoteRerunTests(RemoteMixin, RerunCase):
    def test_failed_files_rerun_on_the_same_host_in_the_same_cache(self):
        self.add_host('s3')
        self.project({'web': 'bun test {tests}'}, RerunCase.BUN_FILES)
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        self.brake_here()
        result = self.run_suite('bun test ./tests', cwd='web')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual(record['host'], 's3')
        self.assertTrue(record['rerun_only'])
        web = str(self.tree('s3') / 'web')
        self.assertEqual([c[1] for c in self.calls()], [web, web])
        self.assertEqual(self.calls()[1][2], ['test', 'tests/a.test.ts', 'tests/sub/b.test.ts'])


if __name__ == '__main__':
    unittest.main()
