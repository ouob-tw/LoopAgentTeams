import importlib.util
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/suite-gate.py'


def load():
    spec = importlib.util.spec_from_file_location('suite_gate', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load()


def replace(path, text):
    """Write atomically, so a gate fingerprinting meanwhile never sees a half-written file."""
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(text)
    os.replace(tmp, path)


# The host's global and system Git config (e.g. a shared core.hooksPath) stay out of tests.
GIT_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
               GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t', GIT_COMMITTER_NAME='t',
               GIT_COMMITTER_EMAIL='t@t')


def git(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True,
                   env=GIT_ENV)


class GateCase(unittest.TestCase):
    """A temporary state dir, config and Git repo; fake suites count runs outside the repo."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='suite-gate-test-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])
        self.state = self.tmp / 'state'
        self.config = self.tmp / 'config.json'
        self.set_config(max_slots=2)
        self.env = dict(GIT_ENV, SUITE_GATE_STATE_DIR=str(self.state),
                        SUITE_GATE_CONFIG=str(self.config), HCOM_INSTANCE_NAME='tester',
                        HCOM_TAG='t', HOME=str(self.tmp / 'home'),
                        XDG_CONFIG_HOME=str(self.tmp / 'xdg-config'))
        self.env.pop('CLAUDE_CODE_SESSION_ID', None)
        self.repo = self.tmp / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q', '-b', 'main')
        (self.repo / 'app.py').write_text('x = 1\n')
        (self.repo / '.gitignore').write_text('ignored/\n.env.test\n')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'init')
        self.counter = self.tmp / 'count'
        self.procs = []
        self.addCleanup(self.stop_procs)

    def set_config(self, **values):
        self.config.write_text(json.dumps(
            dict({'poll_seconds': 0.05, 'report_seconds': 0.2}, **values)))

    def commit(self, cwd, message):
        subprocess.run(['git', 'commit', '-qm', message], cwd=cwd, check=True,
                       capture_output=True, env=getattr(self, 'env', os.environ))

    def suite(self, code=0, sleep=0):
        """A fake suite: count the run, optionally wait, print, exit with code."""
        return (f'echo run >> {self.counter}; sleep {sleep}; echo suite-out; '
                f'echo suite-err >&2; exit {code}')

    def runs(self):
        return len(self.counter.read_text().splitlines()) if self.counter.exists() else 0

    def gate(self, *args, cwd=None, **kwargs):
        return subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd or self.repo,
                              env=self.env, capture_output=True, text=True, timeout=60, **kwargs)

    def start(self, *args, cwd=None):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), *args], cwd=cwd or self.repo,
                                env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True)
        self.procs.append(proc)
        return proc

    def finish(self, proc, timeout=60):
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out, err

    def stop_procs(self):
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
            proc.communicate()

    def records(self):
        path = self.state / 'ledger.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def status(self):
        result = self.gate('status', '--json', '--limit', '100')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def wait_until(self, condition, timeout=20, message='condition'):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.05)
        self.fail(f'timed out waiting for {message}')

    def blocker(self, name):
        """A suite in a non-Git dir that holds a slot until its release file exists."""
        directory = self.tmp / f'plain-{name}'
        directory.mkdir()
        release = self.tmp / f'release-{name}'
        proc = self.start('run', '--', f'while [ ! -f {release} ]; do sleep 0.05; done',
                          cwd=directory)
        return proc, release


class RunAndReuseTests(GateCase):
    def test_first_run_executes_records_and_passes_output_and_exit_code_through(self):
        result = self.gate('run', '--', self.suite(code=3))
        self.assertEqual(result.returncode, 3)
        self.assertIn('suite-out', result.stdout)
        self.assertIn('suite-err', result.stderr)
        self.assertEqual(self.runs(), 1)
        [record] = self.records()
        info = gate.fingerprint(self.repo, [self.suite(code=3)])
        self.assertEqual(record['fingerprint'], info['fingerprint'])
        self.assertEqual(record['repo'], str(self.repo))
        self.assertEqual(record['exit_code'], 3)
        self.assertEqual(record['agent'], 't-tester')
        self.assertEqual(record['rel_cwd'], '.')
        self.assertIn('suite-out', record['output_tail'])
        self.assertIsNone(record['rerun_reason'])
        self.assertFalse(record['reusable'])
        for field in ('command', 'cwd', 'duration_s', 'time', 'finished'):
            self.assertIn(field, record)

    def test_passed_content_is_not_run_again_and_rerun_needs_a_reason(self):
        self.assertEqual(self.gate('run', '--', self.suite()).returncode, 0)
        again = self.gate('run', '--', self.suite())
        self.assertEqual(again.returncode, 0)
        self.assertEqual(self.runs(), 1)
        self.assertIn('already passed', again.stdout)
        self.assertIn('t-tester', again.stdout)
        self.assertIn('suite-out', again.stdout)
        self.assertIn('--rerun', again.stdout)

        refused = self.gate('run', '--rerun', ' ', '--', self.suite())
        self.assertEqual(refused.returncode, 2)
        forced = self.gate('run', '--rerun', 'db schema changed', '--', self.suite())
        self.assertEqual(forced.returncode, 0)
        self.assertEqual(self.runs(), 2)
        self.assertEqual(self.records()[-1]['rerun_reason'], 'db schema changed')

    def test_shell_quoting_is_part_of_the_command(self):
        (self.repo / 'a.txt').write_text('')
        self.assertEqual(self.gate('run', '--', f'echo run >> {self.counter}; ls *.txt').returncode, 0)
        self.assertEqual(self.gate('run', '--', f"echo run >> {self.counter}; ls '*.txt'").returncode, 2)
        self.assertEqual(self.runs(), 2)

    def test_shell_string_and_split_arguments_are_different_commands(self):
        split = ['echo', '-e', 'a\\nb']
        shell = gate.normalize_command(split)
        self.assertEqual(gate.normalize_command([shell]), shell)
        self.assertNotEqual(gate.fingerprint(self.repo, split)['fingerprint'],
                            gate.fingerprint(self.repo, [shell])['fingerprint'])

    def test_changed_content_untracked_file_and_failure_run_again(self):
        self.gate('run', '--', self.suite())
        (self.repo / 'app.py').write_text('x = 2\n')
        self.gate('run', '--', self.suite())
        self.assertEqual(self.runs(), 2)
        (self.repo / 'new_test.py').write_text('y = 1\n')
        self.gate('run', '--', self.suite())
        self.assertEqual(self.runs(), 3)
        (self.repo / 'ignored').mkdir()
        (self.repo / 'ignored/cache').write_text('z')
        self.gate('run', '--', self.suite())
        self.assertEqual(self.runs(), 3, 'ignored files are outside the fingerprint')

        failing = self.suite(code=1)
        self.assertEqual(self.gate('run', '--', failing).returncode, 1)
        self.assertEqual(self.gate('run', '--', failing).returncode, 1)
        self.assertEqual(self.runs(), 5)

    def test_later_failure_of_the_same_content_stops_reuse(self):
        code_file = self.tmp / 'code'
        code_file.write_text('0')
        command = f'echo run >> {self.counter}; exit $(cat {code_file})'
        self.gate('run', '--', command)
        code_file.write_text('1')
        self.assertEqual(self.gate('run', '--rerun', 'service moved', '--', command).returncode, 1)
        code_file.write_text('0')
        self.gate('run', '--', command)
        self.assertEqual(self.runs(), 3, 'the latest result for this content failed')

    def test_content_changed_during_the_run_is_recorded_but_not_reused(self):
        command = f'echo run >> {self.counter}; echo edit >> app.py'
        result = self.gate('run', '--', command)
        self.assertEqual(result.returncode, 0)
        self.assertIn('content changed during the run', result.stderr)
        self.assertIn('git status --porcelain', result.stderr)
        record = self.records()[-1]
        self.assertTrue(record['content_changed'])
        self.assertFalse(record['reusable'])
        git(self.repo, 'checkout', '--', 'app.py')
        self.gate('run', '--', command)
        self.assertEqual(self.runs(), 2)

    def test_merge_with_the_same_tree_and_another_worktree_reuse(self):
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'app.py').write_text('x = 3\n')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'feature')
        self.assertEqual(self.gate('run', '--', self.suite()).returncode, 0)
        git(self.repo, 'checkout', '-q', 'main')
        subprocess.run(['git', 'merge', '-q', '--no-ff', '-m', 'merge', 'feature'],
                       cwd=self.repo, check=True, capture_output=True, env=self.env)
        merged = self.gate('run', '--', self.suite())
        self.assertIn('already passed', merged.stdout)

        other = self.tmp / 'other-worktree'
        git(self.repo, 'worktree', 'add', '-q', str(other), 'feature')
        elsewhere = self.gate('run', '--', self.suite(), cwd=other)
        self.assertIn('already passed', elsewhere.stdout)
        self.assertEqual(self.runs(), 1)

    def test_outside_git_runs_every_time_and_is_never_reused(self):
        plain = self.tmp / 'plain'
        plain.mkdir()
        for _ in range(2):
            result = self.gate('run', '--', self.suite(), cwd=plain)
            self.assertEqual(result.returncode, 0)
            self.assertIn('not in a Git work tree', result.stderr)
        self.assertEqual(self.runs(), 2)
        self.assertTrue(all(r['fingerprint'] is None and not r['reusable']
                            for r in self.records()))

    def test_registry_include_adds_ignored_files_to_the_fingerprint(self):
        command = [self.suite()]
        before = gate.fingerprint(self.repo, command)['fingerprint']
        (self.repo / '.env.test').write_text('A=1\n')
        self.assertEqual(gate.fingerprint(self.repo, command)['fingerprint'], before)
        (self.repo / '.suite-gate.json').write_text(
            json.dumps({'fingerprint_include': ['.env.test']}))
        with_registry = gate.fingerprint(self.repo, command)['fingerprint']
        (self.repo / '.env.test').write_text('A=2\n')
        self.assertNotEqual(gate.fingerprint(self.repo, command)['fingerprint'], with_registry)

    def test_the_fingerprint_covers_command_and_relative_cwd(self):
        (self.repo / 'sub').mkdir()
        (self.repo / 'sub/a.py').write_text('')
        root = gate.fingerprint(self.repo, ['pytest'])
        self.assertNotEqual(root['fingerprint'], gate.fingerprint(self.repo / 'sub', ['pytest'])['fingerprint'])
        self.assertNotEqual(root['fingerprint'], gate.fingerprint(self.repo, ['pytest', '-x'])['fingerprint'])
        self.assertEqual(root['fingerprint'], gate.fingerprint(self.repo, [' pytest '])['fingerprint'])
        git(self.repo, 'add', '-A')
        (self.repo / 'app.py').write_text('x = 5\n')  # same-size edit
        self.assertNotEqual(root['fingerprint'], gate.fingerprint(self.repo, ['pytest'])['fingerprint'])
        real_index = (self.repo / '.git/index').read_bytes()
        gate.fingerprint(self.repo, ['pytest'])
        self.assertEqual((self.repo / '.git/index').read_bytes(), real_index)


class CoordinationTests(GateCase):
    def test_two_identical_requests_run_once(self):
        first = self.start('run', '--', self.suite(sleep=1))
        self.wait_until(lambda: self.runs() == 1, message='first run to start')
        second = self.start('run', '--', self.suite(sleep=1))
        self.assertEqual(self.finish(first)[0], 0)
        code, out, err = self.finish(second)
        self.assertEqual(code, 0)
        self.assertIn('already passed', out)
        self.assertIn('waiting for t-tester', err)
        self.assertEqual(self.runs(), 1)

    def test_second_identical_request_runs_itself_when_the_first_fails(self):
        first = self.start('run', '--', self.suite(code=1, sleep=1))
        self.wait_until(lambda: self.runs() == 1, message='first run to start')
        second = self.start('run', '--', self.suite(code=1, sleep=1))
        self.wait_until(lambda: any(w.get('kind') == 'content' for w in self.status()['waiting']),
                        message='second request to wait on the same content')
        self.assertEqual(self.finish(first)[0], 1)
        self.assertEqual(self.finish(second)[0], 1)
        self.assertEqual(self.runs(), 2)

    def test_host_slots_cap_running_suites_and_queue_the_rest(self):
        a, release_a = self.blocker('a')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: len(self.status()['running']) == 2, message='two running')
        c, release_c = self.blocker('c')
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='third queued')
        time.sleep(0.3)
        self.assertEqual(len(self.status()['running']), 2)
        release_a.touch()
        self.assertEqual(self.finish(a)[0], 0)
        self.wait_until(lambda: len(self.status()['waiting']) == 0, message='third admitted')
        release_b.touch()
        release_c.touch()
        self.assertEqual(self.finish(b)[0], 0)
        code, _, err = self.finish(c)
        self.assertEqual(code, 0)
        self.assertIn('waiting for a host slot (2/2 in use', err)

    def test_slot_limit_comes_from_the_config(self):
        self.set_config(max_slots=1)
        a, release_a = self.blocker('a')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='one running')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='second queued')
        release_b.touch()
        time.sleep(0.3)
        self.assertIsNone(b.poll(), 'the queued suite must not start while the slot is taken')
        release_a.touch()
        self.assertEqual(self.finish(a)[0], 0)
        self.assertEqual(self.finish(b)[0], 0)

    def test_content_change_while_queued_uses_the_new_fingerprint(self):
        self.set_config(max_slots=1)
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        queued = self.start('run', '--', self.suite())
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='request queued')
        replace(self.repo / 'app.py', 'x = 9\n')
        release.touch()
        code, _, err = self.finish(queued)
        self.assertEqual(code, 0)
        self.assertIn('content changed while queued', err)
        self.finish(hold)
        new = gate.fingerprint(self.repo, [self.suite()])['fingerprint']
        self.assertEqual(self.records()[-1]['fingerprint'], new)
        self.assertTrue(self.records()[-1]['reusable'])

    def test_switching_to_a_fingerprint_held_by_a_slot_waiter_does_not_deadlock(self):
        self.set_config(max_slots=1)
        one, two = self.tmp / 'wt1', self.tmp / 'wt2'
        git(self.repo, 'worktree', 'add', '-q', str(one), 'HEAD')
        git(self.repo, 'worktree', 'add', '-q', str(two), 'HEAD')
        (two / 'app.py').write_text('x = 2\n')
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        a = self.start('run', '--', self.suite(), cwd=one)
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='a queued')
        b = self.start('run', '--', self.suite(), cwd=two)
        self.wait_until(lambda: len(self.status()['waiting']) == 2, message='b queued')
        self.assertEqual(len(self.status()['locks']), 2)
        replace(one / 'app.py', 'x = 2\n')
        release.touch()
        code_a, out_a, err_a = self.finish(a, timeout=30)
        code_b, _, _ = self.finish(b, timeout=30)
        self.finish(hold)
        self.assertEqual((code_a, code_b), (0, 0))
        self.assertIn('content changed while queued', err_a)
        self.assertIn('already passed', out_a)
        self.assertEqual(self.runs(), 1)


class SessionTests(GateCase):
    def suite_with_grandchild(self):
        """The suite starts a grandchild that closes its inherited files and keeps running."""
        pidfile = self.tmp / 'grandchild.pid'
        return pidfile, (f'sleep 60 <&- >&- 2>&- & echo $! > {pidfile}; '
                         f'echo run >> {self.counter}; wait')

    def kill_session_later(self, pidfile):
        def kill():
            if pidfile.exists():
                pid = int(pidfile.read_text())
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except ProcessLookupError:
                    pass
        self.addCleanup(kill)

    def test_interrupt_ends_the_test_session_and_writes_no_record(self):
        pidfile, command = self.suite_with_grandchild()
        self.kill_session_later(pidfile)
        proc = self.start('run', '--', command)
        self.wait_until(pidfile.exists, message='grandchild started')
        grandchild = int(pidfile.read_text())
        proc.send_signal(signal.SIGINT)
        code, _, err = self.finish(proc)
        self.assertEqual(code, 128 + signal.SIGINT)
        self.assertIn('interrupted', err)
        self.wait_until(lambda: gate.proc_stat(grandchild) is None
                        or gate.proc_stat(grandchild)[0] == 'Z', message='grandchild ended')
        self.assertEqual(self.records(), [])
        self.assertEqual(self.status()['running'], [])

    def test_lock_and_slot_stay_held_while_a_finished_suite_leaves_processes(self):
        pidfile = self.tmp / 'left.pid'
        self.kill_session_later(pidfile)
        command = f'sleep 60 <&- >&- 2>&- & echo $! > {pidfile}; exit 1'
        self.assertEqual(self.gate('run', '--', command).returncode, 1)
        status = self.status()
        self.assertEqual((len(status['running']), len(status['locks'])), (1, 1))
        os.killpg(int(status['running'][0]['sid']), signal.SIGKILL)
        self.wait_until(lambda: not self.status()['locks'], message='lock freed')

    def test_a_gate_killed_before_recording_the_session_never_starts_the_suite(self):
        snippet = (
            'import importlib.util, os, signal, sys\n'
            f'spec = importlib.util.spec_from_file_location("g", {str(SCRIPT)!r})\n'
            'g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n'
            'g.Gate.set_session = lambda self, sid: os.kill(os.getpid(), signal.SIGKILL)\n'
            'g.main(sys.argv[1:])\n')
        result = subprocess.run([sys.executable, '-c', snippet, 'run', '--', self.suite()],
                                cwd=self.repo, env=self.env, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, -signal.SIGKILL)
        time.sleep(0.3)
        self.assertEqual(self.runs(), 0)
        self.assertEqual(self.status()['running'], [])

    def test_interrupt_sends_the_suite_a_term_it_can_handle(self):
        ready, cleaned = self.tmp / 'ready', self.tmp / 'cleaned'
        command = (f"trap 'touch {cleaned}; exit 1' TERM; touch {ready}; "
                   f"while true; do sleep 0.05; done")
        proc = self.start('run', '--', command)
        self.wait_until(ready.exists, message='suite started')
        proc.send_signal(signal.SIGTERM)
        self.assertEqual(self.finish(proc)[0], 128 + signal.SIGTERM)
        self.assertTrue(cleaned.exists(), 'the suite never saw SIGTERM')

    def test_killed_gate_keeps_the_slot_while_the_test_session_lives(self):
        self.set_config(max_slots=1)
        pidfile, command = self.suite_with_grandchild()
        self.kill_session_later(pidfile)
        proc = self.start('run', '--', command)
        self.wait_until(pidfile.exists, message='grandchild started')
        proc.kill()
        proc.wait()
        status = self.status()
        self.assertEqual(len(status['running']), 1)
        self.assertEqual(len(status['locks']), 1)

        waiting, release = self.blocker('next')
        release.touch()
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='next queued')
        time.sleep(0.3)
        self.assertIsNone(waiting.poll(), 'the slot must stay taken')
        os.killpg(int(self.status()['running'][0]['sid']), signal.SIGKILL)
        self.assertEqual(self.finish(waiting)[0], 0)
        self.assertEqual(self.records()[-1]['fingerprint'], None)
        self.assertEqual(len(self.records()), 1, 'the killed run writes no record')


class StatusTests(GateCase):
    def test_status_lists_records_and_filters_by_fingerprint(self):
        self.gate('run', '--', self.suite())
        self.gate('run', '--', self.suite(code=2))
        fp = self.records()[0]['fingerprint']
        text = self.gate('status').stdout
        self.assertIn('Running (0/2 host slots)', text)
        self.assertIn('PASS', text)
        self.assertIn('FAIL exit 2', text)
        only = json.loads(self.gate('status', '--json', '--fingerprint', fp[:10]).stdout)
        self.assertEqual([r['fingerprint'] for r in only['records']], [fp])

    def test_status_shows_running_and_waiting_suites(self):
        self.set_config(max_slots=1)
        a, release_a = self.blocker('a')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='running')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='waiting')
        text = self.gate('status').stdout
        self.assertIn('Running (1/1 host slots):\n  t-tester', text)
        self.assertIn('host slot', text)
        release_a.touch()
        release_b.touch()
        self.finish(a)
        self.finish(b)


class AffectedCase(GateCase):
    """A mapped project: src/ and web/ map to their tests, docs need none, deps.lock is shared."""

    def setUp(self):
        super().setUp()
        self.log = self.tmp / 'affected.log'
        files = {'src/app.py': '', 'src/util.py': '', 'tests/test_app.py': '',
                 'tests/test_util.py': '', 'web/src/page.ts': '', 'web/tests/page.test.ts': '',
                 'docs/guide.md': '', 'deps.lock': '', 'README.md': ''}
        for name, text in files.items():
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(text)
        self.registry = {
            'integration_branch': 'main',
            'full_suites': [{'command': self.full('root'), 'cwd': '.'},
                            {'command': self.full('web'), 'cwd': 'web'}],
            'affected': {
                'commands': {'.': f'echo "$PWD {{tests}}" >> {self.log}',
                             'web': f'echo "$PWD {{tests}}" >> {self.log}'},
                'map': [
                    {'paths': ['src/app.py'], 'tests': ['tests/test_app.py']},
                    {'paths': ['src/util.py'], 'tests': ['tests/test_*.py']},
                    {'paths': ['web/src/**'], 'tests': ['web/tests/**/*.test.ts']},
                    {'paths': ['docs/**', '.suite-gate.json', '.gitignore'], 'tests': []},
                ],
                'shared': ['deps.lock'],
            },
        }
        self.write_registry()
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'mapped project')
        git(self.repo, 'checkout', '-qb', 'feature')

    def write_registry(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps(self.registry))

    def full(self, name):
        return f'echo {name} >> {self.counter}'

    def full_runs(self):
        return self.counter.read_text().split() if self.counter.exists() else []

    def ran(self):
        """(directory relative to the repo, [tests]) for each affected command that ran."""
        if not self.log.exists():
            return []
        out = []
        for line in self.log.read_text().splitlines():
            directory, *tests = line.split()
            out.append((os.path.relpath(directory, self.repo), tests))
        return out

    def touch(self, name, text='changed\n'):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


class AffectedTests(AffectedCase):
    def test_mapped_change_runs_selected_tests_per_directory_and_records_them(self):
        self.touch('src/util.py')
        self.touch('web/src/page.ts')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py', 'tests/test_util.py']),
                                      ('web', ['tests/page.test.ts'])])
        self.assertEqual(self.full_runs(), [])
        for text in ('src/util.py', 'web/src/page.ts', 'merge-base of HEAD and main',
                     'tests/test_app.py  (src/util.py matches src/util.py)',
                     'web/tests/page.test.ts  (web/src/page.ts matches web/src/**)'):
            self.assertIn(text, result.stderr)
        root, web = self.records()
        self.assertEqual((root['kind'], web['kind']), ('affected', 'affected'))
        self.assertEqual(root['changed_files'], ['src/util.py', 'web/src/page.ts'])
        self.assertEqual(root['selected_tests'], ['tests/test_app.py', 'tests/test_util.py'])
        self.assertEqual(web['selected_tests'], ['web/tests/page.test.ts'])
        self.assertEqual(web['rel_cwd'], 'web')
        self.assertEqual(root['exit_code'], 0)
        self.assertFalse(root['reusable'])
        head = subprocess.run(['git', 'rev-parse', 'main'], cwd=self.repo, capture_output=True,
                              text=True).stdout.strip()
        self.assertEqual(root['base'], head)
        status = self.gate('status').stdout
        self.assertIn('(affected tests)', status)

    def test_affected_runs_do_not_take_or_wait_for_a_host_slot_and_are_never_reused(self):
        self.set_config(max_slots=1)
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        self.touch('src/app.py')
        for _ in range(2):
            result = self.gate('affected')
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.ran()), 2)
        release.touch()
        self.finish(hold)

    def test_a_changed_test_file_is_selected_and_a_deleted_one_is_not_run(self):
        self.touch('tests/test_util.py')
        (self.repo / 'web/tests/page.test.ts').unlink()
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('tests/test_util.py  (test file changed)', result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_util.py'])])

    def test_the_change_counts_commits_staged_unstaged_and_new_files_since_the_merge_base(self):
        self.touch('src/app.py')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'committed change')
        git(self.repo, 'checkout', '-q', 'main')
        self.touch('web/src/page.ts')  # on main after the branch point: not this change
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'main moves on')
        git(self.repo, 'checkout', '-q', 'feature')
        self.touch('tests/test_util.py')
        git(self.repo, 'add', 'tests/test_util.py')  # staged
        self.touch('docs/guide.md')  # unstaged
        self.touch('src/new_test_helper.txt')  # new and not ignored
        self.touch('ignored/cache.py')  # ignored
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)  # the new file falls back
        self.assertEqual(self.records()[-1]['trigger_files'], ['src/new_test_helper.txt'])
        (self.repo / 'src/new_test_helper.txt').unlink()
        self.log.unlink(missing_ok=True)
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]['changed_files'],
                         ['docs/guide.md', 'src/app.py', 'tests/test_util.py'])
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py', 'tests/test_util.py'])])

    def test_base_can_be_given_and_a_missing_branch_or_bad_base_is_an_error(self):
        self.touch('src/app.py')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'one')
        self.touch('web/src/page.ts')
        result = self.gate('affected', '--base', 'HEAD')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]['changed_files'], ['web/src/page.ts'])
        self.assertEqual(self.gate('affected', '--base', 'nope').returncode, 2)
        del self.registry['integration_branch']
        self.write_registry()
        missing = self.gate('affected')
        self.assertEqual(missing.returncode, 2)
        self.assertIn('integration_branch', missing.stderr)

    def test_paths_mapped_to_no_tests_run_nothing(self):
        self.touch('docs/guide.md')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('nothing to run', result.stderr)
        self.assertEqual((self.ran(), self.full_runs(), self.records()), ([], [], []))

    def test_a_failing_affected_test_command_passes_its_exit_code_through(self):
        self.registry['affected']['commands']['.'] = 'echo {tests}; exit 4'
        self.write_registry()
        self.touch('src/app.py')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 4)
        self.assertIn('tests/test_app.py', result.stdout)
        self.assertEqual(self.records()[-1]['exit_code'], 4)

    def test_no_map_or_a_bad_map_is_refused(self):
        self.registry['affected']['commands'] = {'.': 'echo no placeholder'}
        self.write_registry()
        bad = self.gate('affected')
        self.assertEqual(bad.returncode, 2)
        self.assertIn('{tests}', bad.stderr)
        (self.repo / '.suite-gate.json').unlink()
        none = self.gate('affected')
        self.assertEqual(none.returncode, 2)
        self.assertIn('no affected-test map', none.stderr)


class MapFallbackTests(AffectedCase):
    def test_an_unmapped_file_runs_every_full_suite_through_the_gate_then_reuses_it(self):
        self.touch('README.md')
        self.touch('src/app.py')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('needs the full suite (map fallback)', result.stderr)
        self.assertIn('README.md: not in the affected-test map', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.assertEqual(self.ran(), [])
        root, web = self.records()
        for record in (root, web):
            self.assertEqual(record['purpose'], 'map-fallback')
            self.assertEqual(record['trigger_files'], ['README.md'])
            self.assertTrue(record['reusable'])
            self.assertNotIn('kind', record)
        self.assertEqual(web['rel_cwd'], 'web')
        self.assertEqual(root['fingerprint'],
                         gate.fingerprint(self.repo, [self.full('root')])['fingerprint'])
        again = self.gate('affected')
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(again.stdout.count('already passed'), 2)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        notes = self.records()[2:]
        self.assertEqual([(n['kind'], n['purpose'], n['trigger_files'], n['fingerprint'])
                          for n in notes],
                         [('reuse', 'map-fallback', ['README.md'], r['fingerprint'])
                          for r in (root, web)])
        self.assertIn('REUSED pass of', self.gate('status').stdout)
        self.gate('affected')
        self.assertEqual(self.full_runs(), ['root', 'web'], 'reuse notes never block reuse')

    def test_a_fallback_reusing_a_post_merge_pass_records_the_fallback(self):
        self.touch('README.md')
        for suite in self.registry['full_suites']:
            cwd = self.repo / suite['cwd']
            result = self.gate('run', '--purpose', 'post-merge', '--', suite['command'], cwd=cwd)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gate('affected').returncode, 0)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        notes = self.records()[2:]
        self.assertEqual([(n['kind'], n['purpose'], n['trigger_files'], n['reused_agent'])
                          for n in notes], [('reuse', 'map-fallback', ['README.md'], 't-tester')] * 2)

    def test_a_shared_path_falls_back_and_waits_for_a_host_slot(self):
        self.set_config(max_slots=1)
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        self.touch('deps.lock')
        proc = self.start('affected')
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='fallback queued')
        time.sleep(0.4)
        self.assertEqual(self.full_runs(), [], 'the fallback must wait for the slot')
        release.touch()
        code, _, err = self.finish(proc)
        self.finish(hold)
        self.assertEqual(code, 0, err)
        self.assertIn('deps.lock: shared path deps.lock', err)
        self.assertIn('waiting for a host slot', err)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_mapped_tests_that_match_no_file_or_have_no_command_fall_back(self):
        self.registry['affected']['map'][0]['tests'] = ['tests/gone_*.py']
        self.write_registry()
        self.touch('src/app.py')
        result = self.gate('affected')
        self.assertIn('maps to tests that match no file', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.counter.unlink()
        self.registry['affected']['map'][0]['tests'] = ['tests/test_app.py']
        del self.registry['affected']['commands']['.']
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('no affected.commands directory holds this test', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_a_failing_full_suite_fails_the_fallback(self):
        self.registry['full_suites'][1]['command'] = 'exit 3'
        self.write_registry()
        self.touch('README.md')
        self.assertEqual(self.gate('affected').returncode, 3)
        self.assertEqual(self.full_runs(), ['root'])


class PurposeTests(AffectedCase):
    def test_an_unmarked_full_suite_is_refused_with_the_affected_command(self):
        result = self.gate('run', '--', self.full('root'))
        self.assertEqual(result.returncode, 2)
        self.assertIn(gate.affected_command(), result.stderr)
        self.assertIn('--purpose post-merge', result.stderr)
        self.assertEqual((self.full_runs(), self.records()), ([], []))
        rerun = self.gate('run', '--rerun', 'env changed', '--', self.full('root'))
        self.assertEqual(rerun.returncode, 2)

    def test_purposes_are_recorded_outside_the_fingerprint(self):
        merged = self.gate('run', '--purpose', 'post-merge', '--', self.full('root'))
        self.assertEqual(merged.returncode, 0, merged.stderr)
        record = self.records()[-1]
        self.assertEqual((record['purpose'], record['purpose_reason']), ('post-merge', None))
        release = self.gate('run', '--purpose', 'release', '--', self.full('root'))
        self.assertEqual(release.returncode, 0, release.stderr)
        self.assertIn('already passed', release.stdout)
        self.assertIn('purpose:     post-merge', release.stdout)
        self.assertEqual(self.full_runs(), ['root'])
        note = self.records()[-1]
        self.assertEqual((note['kind'], note['purpose']), ('reuse', 'release'))
        self.touch('src/app.py')
        reason = self.gate('run', '--reason', 'investigating a flaky test', '--',
                           self.full('root'))
        self.assertEqual(reason.returncode, 0, reason.stderr)
        record = self.records()[-1]
        self.assertEqual((record['purpose'], record['purpose_reason']),
                         ('reason', 'investigating a flaky test'))
        self.assertIn('reason: investigating a flaky test', self.gate('status').stdout)

    def test_bad_purpose_arguments_are_refused(self):
        for args in (['--reason', ' '], ['--purpose', 'post-merge', '--reason', 'x'],
                     ['--purpose', 'map-fallback']):
            with self.subTest(args=args):
                self.assertEqual(self.gate('run', *args, '--', self.full('root')).returncode, 2)
        self.assertEqual(self.full_runs(), [])

    def test_a_project_without_a_map_needs_no_purpose(self):
        del self.registry['affected']
        self.write_registry()
        result = self.gate('run', '--', self.full('root'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIsNone(self.records()[-1]['purpose'])
        self.assertIn('already passed', self.gate('run', '--', self.full('root')).stdout)
        self.assertEqual(len(self.records()), 1, 'a reuse without a purpose writes nothing')


class DetectionTests(unittest.TestCase):
    def test_default_rules_treat_runners_without_targets_as_full(self):
        full = [
            'pytest', 'pytest -q -n 4', 'uv run pytest -x', 'python3 -m pytest --tb short',
            'uv run --no-project python -m unittest discover -s tests',
            'python -m unittest', 'cd board && bun test', 'bun run test', 'npm test',
            'npm run test -- --coverage', 'pnpm test', 'yarn test', 'npx vitest run', 'jest',
            'npx playwright test --project chromium', 'go test ./...', 'cargo test',
            'FOO=1 timeout 600 pytest', "bash -lc 'pytest -q'", 'echo hi; pytest',
            'cd board\nbun test', 'pytest -q 2>&1 | tail -20', 'pytest > out.txt',
            'pytest &>/dev/null', 'cd x # go to x\npytest', 'echo "a\nb"; pytest',
            'pytest # comment', 'echo "# note"; pytest', 'echo a#b; pytest',
            "echo 'it''s'; pytest", 'pytest \\\n  -q',
        ]
        targeted = [
            'pytest tests/test_a.py', 'pytest -k login', 'pytest -kfoo', 'pytest tests/a.py::t',
            'python -m unittest tests.test_a', 'python -m unittest discover -s t -p test_x.py',
            'bun test src/a.test.ts', 'bun test -t name', 'npm test -- a.test.ts',
            'npx vitest run src/a', 'jest -t name', 'npx playwright test -g login',
            'playwright test e2e/a.spec.ts', 'go test ./pkg', 'go test -run TestX ./...',
            'cargo test parse', 'cargo test -p core', 'echo pytest', 'git status',
            'bun run build', 'uv run python script.py', 'pytest tests/a.py 2>&1 | tail',
            'echo "# note"\ngit status', 'pytest tests/a.py # full run later',
            'pytest \\\n  tests/a.py', 'pytest "tests/a b.py"',
        ]
        for command in full:
            self.assertTrue(gate.is_full_suite(command, registry={}), command)
        for command in targeted:
            self.assertFalse(gate.is_full_suite(command, registry={}), command)

    def test_registry_takes_priority_over_the_default_rules(self):
        registry = {'suites': ['make check', 'uv run --no-project python -m unittest discover -s skills/*/tests']}
        self.assertTrue(gate.is_full_suite('make check', registry=registry))
        self.assertTrue(gate.is_full_suite(
            'uv run --no-project python -m unittest discover -s skills/lat/tests', registry=registry))
        self.assertFalse(gate.is_full_suite('pytest', registry=registry))

    def test_registry_is_read_from_the_repo_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, 'init', '-q')
            (repo / 'sub').mkdir()
            self.assertTrue(gate.is_full_suite('pytest', repo / 'sub'))
            (repo / '.suite-gate.json').write_text(json.dumps({'suites': ['make  check']}))
            self.assertFalse(gate.is_full_suite('pytest', repo / 'sub'))
            self.assertTrue(gate.is_full_suite('make check', repo / 'sub'))



def run_hook(command, cwd, env=None):
    payload = json.dumps({'hook_event_name': 'PreToolUse', 'tool_name': 'Bash',
                          'tool_input': {'command': command}, 'cwd': str(cwd)})
    return subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=payload, text=True,
                          capture_output=True, env=env, timeout=60)


def rewrite_of(stderr):
    """The ready-to-run command from a block message (it may span lines)."""
    return stderr.split('\n  ', 1)[1].split('\nOnly the suite', 1)[0]


class HookTests(GateCase):
    """Claude sends the command as a string; Codex as a string or ["bash", "-lc", text]."""

    def formats(self, text):
        return {'claude': text, 'codex-list': ['bash', '-lc', text]}

    def test_unwrapped_full_suites_are_blocked_with_a_ready_to_run_rewrite(self):
        """Only the suite command is replaced; everything around it stays as written."""
        g, q = gate.gate_command, gate.shlex.quote
        cases = {
            'pytest': g('pytest'),
            'FOO=1 timeout 600 uv run pytest -q': g('FOO=1 timeout 600 uv run pytest -q'),
            'cd sub && uv run pytest -q': 'cd sub && ' + g('uv run pytest -q'),
            'npm test 2>&1 | tail -5': g('npm test') + ' 2>&1 | tail -5',
            'set -o pipefail\npytest 2>&1 | tail -20':
                'set -o pipefail\n' + g('pytest') + ' 2>&1 | tail -20',
            'pytest | tail -30; echo "exit=${PIPESTATUS[0]}"':
                g('pytest') + ' | tail -30; echo "exit=${PIPESTATUS[0]}"',
            "bash -lc 'go test ./...'": 'bash -lc ' + q(g('go test ./...')),
            "bash -lc 'cd a && pytest' | tail": 'bash -lc ' + q('cd a && ' + g('pytest')) + ' | tail',
            "APP_ENV=test bash -c 'pytest'": 'APP_ENV=test bash -c ' + q(g('pytest')),
            "false && bash -c 'echo prep; pytest'":
                'false && bash -c ' + q('echo prep; ' + g('pytest')),
            "bash -c 'cd backend && pytest'; bun test":
                'bash -c ' + q('cd backend && ' + g('pytest')) + '; ' + g('bun test'),
            'pytest && cargo test': g('pytest') + ' && ' + g('cargo test'),
            'cd a && pytest && cd ../b && bun test':
                'cd a && ' + g('pytest') + ' && cd ../b && ' + g('bun test'),
            'export APP_ENV=test; pytest': 'export APP_ENV=test; ' + g('pytest'),
            'cd "$ROOT" && pytest --junitxml="$OUT/r.xml"':
                'cd "$ROOT" && ' + g('pytest --junitxml="$OUT/r.xml"'),
            'pytest # comment': g('pytest') + ' # comment',
            'echo "# note"; pytest': 'echo "# note"; ' + g('pytest'),
            'pytest "#"; pytest': 'pytest "#"; ' + g('pytest'),
        }
        for text, expected in cases.items():
            for client, command in self.formats(text).items():
                with self.subTest(client=client, text=text):
                    result = run_hook(command, self.repo, self.env)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(rewrite_of(result.stderr), expected)

    def test_a_registry_pattern_over_several_commands_wraps_the_whole_text(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': ['make deps; make check']}))
        result = run_hook('make deps; make check', self.repo, self.env)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(rewrite_of(result.stderr), gate.gate_command('make deps; make check'))

    def test_wrapped_targeted_and_other_commands_pass(self):
        wrapped = gate.gate_command('pytest')
        for text in (wrapped, wrapped.replace(' run -- ', ' run --rerun "db reset" -- '),
                     f'cd sub && {wrapped} 2>&1 | tail -3', 'pytest tests/test_a.py',
                     'pytest -k login', 'go test ./pkg', 'git status', 'ls -la',
                     f'{gate.shlex.quote(str(SCRIPT))} status', ''):
            for client, command in self.formats(text).items():
                with self.subTest(client=client, text=text):
                    result = run_hook(command, self.repo, self.env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stderr, '')

    def test_messages_that_mention_a_suite_pass(self):
        for text in (
            "hcom send @meka --name ripu --intent inform -- 'Suite PASSES. Direct "
            "`python3 -m unittest discover -s tests | tail -20` was blocked; ran pytest via the gate.'",
            'echo "next: pytest && npm test"',
            "git commit -m 'test: run pytest -q in CI'",
            "printf '%s\\n' 'go test ./...' | tee notes.txt",
        ):
            for client, command in self.formats(text).items():
                with self.subTest(client=client, text=text):
                    result = run_hook(command, self.repo, self.env)
                    self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_wrapped_suite_does_not_cover_another_unwrapped_one(self):
        result = run_hook(f"{gate.gate_command('pytest')} && pytest", self.repo, self.env)
        self.assertEqual(result.returncode, 2)

    def test_the_registry_in_the_payload_cwd_decides(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': ['make check']}))
        (self.repo / 'sub').mkdir()
        self.assertEqual(run_hook('make check', self.repo / 'sub', self.env).returncode, 2)
        self.assertEqual(run_hook('pytest', self.repo / 'sub', self.env).returncode, 0)
        self.assertEqual(run_hook('make check', self.tmp, self.env).returncode, 0)

    def test_the_rewrite_runs_passes_the_hook_and_is_reused_next_time(self):
        suite = self.suite()
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': [suite]}))
        blocked = run_hook(suite, self.repo, self.env)
        self.assertEqual(blocked.returncode, 2, blocked.stderr)
        rewrite = rewrite_of(blocked.stderr)
        self.assertEqual(run_hook(rewrite, self.repo, self.env).returncode, 0)
        for expected_runs in (1, 1):
            result = subprocess.run(rewrite, shell=True, cwd=self.repo, env=self.env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.runs(), expected_runs)
        self.assertIn('already passed', result.stdout)
        self.assertIn('not by itself a reason', result.stdout)

    def test_unreadable_input_never_blocks_and_unreadable_commands_block_only_runners(self):
        for payload in ('not json', '[]', '{"tool_input": "x"}'):
            with self.subTest(payload=payload):
                result = subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=payload,
                                        text=True, capture_output=True, env=self.env)
                self.assertEqual(result.returncode, 0, result.stderr)
        original = gate.split_commands
        gate.split_commands = lambda text: 1 / 0  # a hook bug on any text
        try:
            self.assertEqual(gate.gate_rewrite('pytest -q | tail', self.repo),
                             gate.gate_command('pytest -q | tail'))
            self.assertTrue(gate.gate_rewrite('bun run test', self.repo))
            self.assertIsNone(gate.gate_rewrite('git status', self.repo))
            self.assertIsNone(gate.gate_rewrite(gate.gate_command('pytest'), self.repo))
        finally:
            gate.split_commands = original
        # A payload cwd that does not exist falls back to the hook's own directory.
        self.assertEqual(run_hook('pytest', self.tmp / 'gone', self.env).returncode, 2)


def mapped_reply(stderr):
    """(affected command, full suite with a purpose) from a mapped project's block message."""
    affected = stderr.split('Run this instead:\n  ', 1)[1].split('\nIt runs the tests', 1)[0]
    full = stderr.split('with a purpose:\n  ', 1)[1].split('\nReplace --reason', 1)[0]
    return affected, full


class MappedHookTests(AffectedCase):
    """With an affected-test map the hook answers a full suite with the affected command."""

    def formats(self, text):
        return {'claude': text, 'codex-list': ['bash', '-lc', text]}

    def test_an_unwrapped_full_suite_gets_the_affected_command_and_the_purpose_syntax(self):
        a, g, q, why = (gate.affected_command(), gate.gate_command, gate.shlex.quote,
                        gate.REASON_FLAGS)
        cases = {
            'pytest': (a, g('pytest', why)),
            'cd web && bun test 2>&1 | tail -30':
                (f'cd web && {a} 2>&1 | tail -30', f"cd web && {g('bun test', why)} 2>&1 | tail -30"),
            "bash -lc 'pytest -q' | tail":
                (f'bash -lc {q(a)} | tail', f"bash -lc {q(g('pytest -q', why))} | tail"),
        }
        for text, expected in cases.items():
            for client, command in self.formats(text).items():
                with self.subTest(client=client, text=text):
                    result = run_hook(command, self.repo, self.env)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(mapped_reply(result.stderr), expected)
                    self.assertIn('--purpose post-merge', result.stderr)
                    self.assertIn('--purpose release', result.stderr)

    def test_the_affected_reply_passes_the_hook_and_runs_the_selected_tests(self):
        self.touch('src/app.py')
        blocked = run_hook('cd web && bun test 2>&1 | tail -30', self.repo, self.env)
        affected, _ = mapped_reply(blocked.stderr)
        self.assertEqual(run_hook(affected, self.repo, self.env).returncode, 0)
        result = subprocess.run(affected, shell=True, cwd=self.repo, env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py'])])
        self.assertEqual(self.full_runs(), [])

    def test_wrapped_runs_with_a_purpose_pass_and_the_purpose_reply_runs(self):
        self.registry['suites'] = [self.full('root')]
        self.write_registry()
        for flags in (('--purpose', 'post-merge'), ('--purpose', 'release'),
                      ('--reason', 'flaky test')):
            with self.subTest(flags=flags):
                result = run_hook(gate.gate_command(self.full('root'), flags), self.repo,
                                  self.env)
                self.assertEqual((result.returncode, result.stderr), (0, ''))
        blocked = run_hook(self.full('root'), self.repo, self.env)
        self.assertEqual(blocked.returncode, 2, blocked.stderr)
        _, full = mapped_reply(blocked.stderr)
        self.assertEqual(run_hook(full, self.repo, self.env).returncode, 0)
        result = subprocess.run(full, shell=True, cwd=self.repo, env=self.env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root'])
        self.assertEqual(self.records()[-1]['purpose'], 'reason')

    def test_an_unmapped_project_keeps_the_gate_rewrite(self):
        del self.registry['affected']
        self.write_registry()
        result = run_hook('cd web && bun test 2>&1 | tail -30', self.repo, self.env)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(rewrite_of(result.stderr),
                         f"cd web && {gate.gate_command('bun test')} 2>&1 | tail -30")
        self.assertNotIn(gate.affected_command(), result.stderr)


def head(cwd, rev='HEAD'):
    return subprocess.run(['git', 'rev-parse', rev], cwd=cwd, check=True, capture_output=True,
                          text=True, env=GIT_ENV).stdout.strip()


class PrePushCase(AffectedCase):
    """A mapped project with a bare remote; the pre-push check is installed in the temp repo."""

    def setUp(self):
        super().setUp()
        self.remote = self.tmp / 'remote.git'
        git(self.tmp, 'init', '-q', '--bare', str(self.remote))
        git(self.repo, 'remote', 'add', 'origin', str(self.remote))
        self.hook = self.repo / '.git/hooks/pre-push'

    def install(self, *extra, repo=None):
        return self.gate('install-pre-push', '--repo', str(repo or self.repo), *extra)

    def push(self, *args):
        return subprocess.run(['git', 'push', '-q', 'origin', *args], cwd=self.repo,
                              env=self.env, capture_output=True, text=True, timeout=120)

    def fill(self, refused):
        """Run every release command a refused push printed."""
        prefix = 'suite-gate:   cd '
        commands = [line[len(prefix) - 3:] for line in refused.stderr.splitlines()
                    if line.startswith(prefix)]
        self.assertTrue(commands, refused.stderr)
        for command in commands:
            self.assertIn('run --purpose release --', command)
            result = subprocess.run(command, shell=True, cwd=self.tmp, env=self.env,
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
        return commands


class PrePushTests(PrePushCase):
    def setUp(self):
        super().setUp()
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_main_and_tags_need_a_pass_of_every_registered_suite(self):
        self.assertEqual(self.push('feature').returncode, 0)
        refused = self.push('main')
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('push refused', refused.stderr)
        self.assertIn(f"    .: {self.full('root')}", refused.stderr)
        self.assertIn(f"    web: {self.full('web')}", refused.stderr)
        self.assertNotIn('work tree differs', refused.stderr)
        self.assertEqual(self.full_runs(), [], 'the check itself runs nothing')
        self.assertEqual(len(self.fill(refused)), 2)
        self.assertEqual(sorted(self.full_runs()), ['root', 'web'])
        self.assertEqual({r['purpose'] for r in self.records()}, {'release'})
        self.assertEqual(self.push('main').returncode, 0)
        git(self.repo, 'tag', 'v1')
        self.assertEqual(self.push('v1').returncode, 0)
        self.touch('src/app.py')
        git(self.repo, 'commit', '-qam', 'change')
        self.assertEqual(self.push('feature').returncode, 0, 'other branches are not checked')
        git(self.repo, 'tag', '-a', 'v2', '-m', 'v2')
        refused = self.push('v2')
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('refs/tags/v2', refused.stderr)
        self.assertIn('--no-verify', refused.stderr)
        self.assertEqual(self.push('--no-verify', 'v2').returncode, 0)
        self.assertEqual(self.push(':refs/tags/v2').returncode, 0, 'deletions are not checked')
        for cwd in (self.repo, self.repo / 'web'):
            suite = self.full('root' if cwd == self.repo else 'web')
            result = self.gate('run', '--purpose', 'post-merge', '--', suite, cwd=cwd)
            self.assertEqual(result.returncode, 0, result.stderr)
        runs = len(self.full_runs())
        self.assertEqual(self.push('v2').returncode, 0, 'a post-merge pass counts')
        self.assertEqual(len(self.full_runs()), runs)

    def test_fingerprint_include_files_come_from_the_work_tree(self):
        self.registry['fingerprint_include'] = ['.env.test']
        self.write_registry()
        (self.repo / '.env.test').write_text('A=1\n')
        git(self.repo, 'commit', '-qam', 'include')
        self.fill(self.push('HEAD:refs/tags/t1'))
        self.assertEqual(self.push('HEAD:refs/tags/t1').returncode, 0)
        (self.repo / '.env.test').write_text('A=2\n')
        refused = self.push('HEAD:refs/tags/t2')
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn('refs/tags/t2', refused.stderr)
        self.fill(refused)
        self.assertEqual(self.push('HEAD:refs/tags/t2').returncode, 0)

    def test_the_stdin_protocol(self):
        sha, zero = head(self.repo), '0' * 40
        cases = {
            f'refs/heads/feature {sha} refs/heads/feature {zero}': 0,
            f'refs/heads/feature {sha} refs/heads/mainline {zero}': 0,
            f'(delete) {zero} refs/heads/main {sha}': 0,
            f'(delete) {zero} refs/tags/v1 {sha}': 0,
            f'refs/heads/feature {sha} refs/heads/main {zero}': 1,
            f'refs/tags/v1 {sha} refs/tags/v1 {zero}': 1,
        }
        for line, code in cases.items():
            with self.subTest(line=line):
                result = self.gate('pre-push', 'origin', str(self.remote), input=line + '\n')
                self.assertEqual(result.returncode, code, result.stderr)
        both = self.gate('pre-push', 'origin', str(self.remote),
                         input=f'refs/heads/main {sha} refs/heads/main {zero}\n'
                               f'refs/tags/v1 {sha} refs/tags/v1 {zero}\n')
        self.assertEqual(both.returncode, 1)
        self.assertIn('refs/heads/main, refs/tags/v1', both.stderr)
        self.assertEqual(both.stderr.count('run --purpose release'), 2)
        self.touch('src/app.py')
        dirty = self.gate('pre-push', 'origin', str(self.remote),
                          input=f'refs/heads/main {sha} refs/heads/main {zero}\n')
        self.assertIn('work tree differs', dirty.stderr)
        self.assertEqual(self.full_runs(), [])


class PrePushInstallTests(PrePushCase):
    OLD = '#!/bin/sh\necho "$@" > {out}.args\ncat > {out}\nexit 0\n'

    def backups(self):
        return sorted(self.hook.parent.glob('pre-push' + gate.BACKUP_PREFIX + '*'))

    def test_preview_install_and_uninstall_of_a_new_hook(self):
        preview = self.install('--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn('+' + gate.PRE_PUSH_BEGIN, preview.stdout)
        self.assertFalse(self.hook.exists())
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.hook.read_text(), '#!/bin/sh\n' + gate.pre_push_block())
        self.assertTrue(os.access(self.hook, os.X_OK))
        self.assertIn('No changes', self.install().stdout)
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.gate('uninstall-pre-push', '--repo', str(self.repo),
                                   '--preview').returncode, 0)
        self.assertTrue(self.hook.exists())
        self.assertEqual(self.gate('uninstall-pre-push', '--repo', str(self.repo)).returncode, 0)
        self.assertFalse(self.hook.exists())

    def test_an_existing_hook_is_kept_and_still_gets_the_pushed_refs(self):
        out = self.tmp / 'old-hook'
        original = self.OLD.format(out=out)
        self.hook.write_text(original)
        self.hook.chmod(0o755)
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.hook.read_text()
        self.assertTrue(text.startswith('#!/bin/sh\n' + gate.PRE_PUSH_BEGIN), text)
        self.assertTrue(text.endswith(original.split('\n', 1)[1]))
        [backup] = self.backups()
        self.assertEqual(backup.read_text(), original)
        self.hook.write_text(text.replace(str(SCRIPT), '/old/suite-gate.py'))
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.hook.read_text(), text, 'a moved skill is updated in place')
        self.assertIn('No changes', self.install().stdout)
        self.assertEqual(self.push('feature').returncode, 0)
        self.assertIn(f"refs/heads/feature {head(self.repo)} refs/heads/feature", out.read_text())
        self.assertEqual(Path(f'{out}.args').read_text().split(), ['origin', str(self.remote)])
        self.assertEqual(self.gate('uninstall-pre-push', '--repo', str(self.repo)).returncode, 0)
        self.assertEqual(self.hook.read_text(), original)
        self.assertIn('No changes',
                      self.gate('uninstall-pre-push', '--repo', str(self.repo)).stdout)

    def test_a_shared_hooks_path_is_never_written(self):
        shared = self.tmp / 'shared-hooks'
        shared.mkdir()
        git(self.repo, 'config', 'core.hooksPath', str(shared))
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'core.hooksPath is {shared}', result.stdout)
        self.assertIn('exec "$local_hook" "$@"', result.stdout)
        self.assertTrue(self.hook.exists())
        self.assertEqual(list(shared.iterdir()), [])

    def test_refused_without_a_registry_or_with_a_hook_it_cannot_extend(self):
        plain = self.tmp / 'plain'
        plain.mkdir()
        git(plain, 'init', '-q')
        result = self.install(repo=plain)
        self.assertEqual(result.returncode, 1)
        self.assertIn('only for repos with a registry', result.stderr)
        self.assertFalse((plain / '.git/hooks/pre-push').exists())
        for text, mode in (('#!/usr/bin/env python3\nprint(1)\n', 0o755),
                           (self.OLD.format(out=self.tmp / 'x'), 0o644)):
            with self.subTest(text=text, mode=mode):
                self.hook.write_text(text)
                self.hook.chmod(mode)
                self.assertEqual(self.install().returncode, 1)
                self.assertEqual(self.hook.read_text(), text)


OTHER_GROUPS = [
    {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command':
        'uv run --no-project python /skills/hcom-spawn/scripts/block-broadcast.py'}]},
    {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command':
        'uv run --no-project python /skills/hcom-spawn/scripts/spawn-guard.py'}]},
]


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='suite-gate-install-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])
        # Point every default at the temp dir, so a test can never touch real settings.
        self.env = dict(os.environ, HOME=str(self.tmp / 'home'),
                        CLAUDE_CONFIG_DIR=str(self.tmp / 'claude'),
                        CODEX_HOME=str(self.tmp / 'codex'))
        self.files = {'claude': self.tmp / 'claude/settings.json',
                      'codex': self.tmp / 'codex/hooks.json'}

    def configure(self, action, client, *extra):
        return subprocess.run([sys.executable, str(SCRIPT), action, '--client', client, *extra],
                              env=self.env, capture_output=True, text=True, timeout=60)

    def seed(self, client):
        path = self.files[client]
        path.parent.mkdir(parents=True)
        config = {'model': 'x', 'hooks': {'PreToolUse': gate.copy.deepcopy(OTHER_GROUPS),
                                          'Stop': [{'hooks': [{'type': 'command',
                                                               'command': 'stop.sh'}]}]}}
        path.write_text(json.dumps(config, indent=2) + '\n')
        return config

    def ours(self, config):
        return [h for g in config['hooks'].get('PreToolUse', []) for h in g['hooks']
                if gate.is_hook_handler(h)]

    def backups(self, client):
        path = self.files[client]
        return sorted(path.parent.glob(path.name + gate.BACKUP_PREFIX + '*'))

    def test_preview_shows_the_diff_and_writes_nothing(self):
        for client in ('claude', 'codex'):
            with self.subTest(client=client):
                self.seed(client)
                original = self.files[client].read_text()
                result = self.configure('install', client, '--preview')
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f'+            "command": "{gate.HOOK_COMMAND}"', result.stdout)
                self.assertEqual(self.files[client].read_text(), original)
                self.assertEqual(self.backups(client), [])

    def test_install_backs_up_keeps_other_entries_and_is_idempotent(self):
        for client in ('claude', 'codex'):
            with self.subTest(client=client):
                seeded = self.seed(client)
                original = self.files[client].read_text()
                result = self.configure('install', client)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = json.loads(self.files[client].read_text())
                self.assertEqual(config['model'], 'x')
                self.assertEqual(config['hooks']['Stop'], seeded['hooks']['Stop'])
                self.assertEqual(config['hooks']['PreToolUse'][:2], OTHER_GROUPS)
                group = config['hooks']['PreToolUse'][2]
                self.assertEqual(group['matcher'], 'Bash')
                self.assertEqual(group['hooks'], [{'type': 'command',
                                                   'command': gate.HOOK_COMMAND}])
                self.assertEqual(group.get('name'), 'suite-gate' if client == 'codex' else None)
                [backup] = self.backups(client)
                self.assertEqual(backup.read_text(), original)
                again = self.configure('install', client)
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertIn('No changes', again.stdout)
                self.assertEqual(json.loads(self.files[client].read_text()), config)
                self.assertEqual(len(self.backups(client)), 1)

    def test_install_creates_a_missing_file_and_updates_a_moved_skill_in_place(self):
        result = self.configure('install', 'codex')
        self.assertEqual(result.returncode, 0, result.stderr)
        config = json.loads(self.files['codex'].read_text())
        self.assertEqual(len(self.ours(config)), 1)
        self.assertEqual(self.backups('codex'), [])
        group = config['hooks']['PreToolUse'][0]
        group['hooks'][0]['command'] = 'uv run --no-project python /old/suite-gate.py hook'
        group['hooks'][0]['timeout'] = 30
        self.files['codex'].write_text(json.dumps(config))
        self.assertEqual(self.configure('install', 'codex').returncode, 0)
        config = json.loads(self.files['codex'].read_text())
        self.assertEqual(self.ours(config), [{'type': 'command', 'command': gate.HOOK_COMMAND,
                                              'timeout': 30}])

    def test_uninstall_removes_only_the_hook(self):
        for client in ('claude', 'codex'):
            with self.subTest(client=client):
                seeded = self.seed(client)
                self.assertEqual(self.configure('install', client).returncode, 0)
                result = self.configure('uninstall', client)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(self.files[client].read_text()), seeded)
                self.assertEqual(len(self.backups(client)), 2)
                self.assertIn('No changes', self.configure('uninstall', client).stdout)

    def test_uninstall_keeps_a_shared_group_and_drops_an_emptied_event(self):
        path = self.files['claude']
        path.parent.mkdir(parents=True)
        shared = {'matcher': 'Bash', 'hooks': [OTHER_GROUPS[0]['hooks'][0],
                                               {'type': 'command', 'command': gate.HOOK_COMMAND}]}
        path.write_text(json.dumps({'hooks': {'PreToolUse': [shared]}}))
        self.assertEqual(self.configure('uninstall', 'claude').returncode, 0)
        self.assertEqual(json.loads(path.read_text()),
                         {'hooks': {'PreToolUse': [OTHER_GROUPS[0]]}})
        self.assertEqual(self.configure('install', 'claude').returncode, 0)
        self.assertEqual(self.configure('uninstall', 'claude').returncode, 0)
        self.assertEqual(json.loads(path.read_text()), {'hooks': {'PreToolUse': [OTHER_GROUPS[0]]}})
        path.write_text(json.dumps({'hooks': {}}))
        self.assertEqual(self.configure('install', 'claude').returncode, 0)
        self.assertEqual(self.configure('uninstall', 'claude').returncode, 0)
        self.assertEqual(json.loads(path.read_text()), {'hooks': {}})

    def test_explicit_paths_and_bad_files(self):
        other = self.tmp / 'elsewhere/settings.json'
        result = self.configure('install', 'claude', '--claude-settings', str(other))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.ours(json.loads(other.read_text()))), 1)
        self.assertFalse(self.files['claude'].exists())
        result = self.configure('install', 'codex', '--codex-home', str(self.tmp / 'c2'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.tmp / 'c2/hooks.json').exists())
        for bad in ('[]', '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}', 'nope'):
            with self.subTest(bad=bad):
                other.write_text(bad)
                result = self.configure('install', 'claude', '--claude-settings', str(other))
                self.assertEqual(result.returncode, 1)
                self.assertEqual(other.read_text(), bad)
        twice = {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': gate.HOOK_COMMAND}]}
        other.write_text(json.dumps({'hooks': {'PreToolUse': [twice, twice]}}))
        self.assertEqual(self.configure('install', 'claude', '--claude-settings',
                                        str(other)).returncode, 1)


if __name__ == '__main__':
    unittest.main()
