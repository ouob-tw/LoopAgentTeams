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


def git(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True)


class GateCase(unittest.TestCase):
    """A temporary state dir, config and Git repo; fake suites count runs outside the repo."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='suite-gate-test-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])
        self.state = self.tmp / 'state'
        self.config = self.tmp / 'config.json'
        self.set_config(max_slots=2)
        self.env = dict(os.environ, SUITE_GATE_STATE_DIR=str(self.state),
                        SUITE_GATE_CONFIG=str(self.config), HCOM_INSTANCE_NAME='tester',
                        HCOM_TAG='t', GIT_AUTHOR_NAME='t', GIT_AUTHOR_EMAIL='t@t',
                        GIT_COMMITTER_NAME='t', GIT_COMMITTER_EMAIL='t@t')
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
        g = gate.gate_command
        cases = {
            'pytest': g('pytest'),
            'FOO=1 timeout 600 uv run pytest -q': g('FOO=1 timeout 600 uv run pytest -q'),
            'cd sub && uv run pytest -q': 'cd sub && ' + g('uv run pytest -q'),
            'npm test 2>&1 | tail -5': g('npm test') + ' 2>&1 | tail -5',
            'set -o pipefail\npytest 2>&1 | tail -20':
                'set -o pipefail\n' + g('pytest') + ' 2>&1 | tail -20',
            'pytest | tail -30; echo "exit=${PIPESTATUS[0]}"':
                g('pytest') + ' | tail -30; echo "exit=${PIPESTATUS[0]}"',
            "bash -lc 'go test ./...'": g('go test ./...'),
            "bash -lc 'cd a && pytest' | tail": 'cd a && ' + g('pytest') + ' | tail',
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
