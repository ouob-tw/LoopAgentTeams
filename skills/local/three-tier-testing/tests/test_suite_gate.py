import importlib.util
import fcntl
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/suite-gate.py'


def load():
    spec = importlib.util.spec_from_file_location('suite_gate', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gate = load()
BASE_COMMIT = 'f61eb8d'  # the last suite-gate.py before suites ran in scopes
GIB = 2 ** 30


def scope_unavailable():
    """Why this host cannot run suites in systemd user scopes, or None when it can."""
    if not Path('/sys/fs/cgroup/cgroup.controllers').is_file():
        return 'cgroup v2 is not mounted at /sys/fs/cgroup'
    try:
        probe = subprocess.run(['systemd-run', '--user', '--scope', '--quiet', '--collect',
                                f'--unit=suite-gate-test-probe-{os.getpid()}', 'true'],
                               capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return 'systemd-run is not installed'
    if probe.returncode != 0:
        return f'no systemd user scope: {probe.stderr.strip()}'
    return None


SCOPE_SKIP = scope_unavailable()


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
        # Scopes this test starts share its unique prefix; whatever is left of them is killed.
        self.env['SUITE_GATE_UNIT_PREFIX'] = self.tmp.name
        if not SCOPE_SKIP:
            self.addCleanup(subprocess.run, ['systemctl', '--user', 'kill', '--signal=KILL',
                                             f'{self.tmp.name}-*.scope'], capture_output=True)
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
            dict({'poll_seconds': 0.05, 'report_seconds': 0.2, 'sample_seconds': 0.1},
                 **values)))

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

    def without_scopes(self):
        """Make the gate see no cgroup v2, so suites run in a plain new session."""
        empty = self.tmp / 'no-cgroup'
        empty.mkdir()
        self.env['SUITE_GATE_CGROUP_ROOT'] = str(empty)

    def scopes_that_fall_back(self, probe_starts=True):
        """Make the gate see cgroup v2 and systemd-run, but have every suite's scope fail to
        start, so the started suite falls back to a session. With probe_starts the empty probe
        scope (`... true`) starts, so the queued suite still expects a scope."""
        root, fake_bin = self.tmp / 'cgroup', self.tmp / 'scope-bin'
        root.mkdir()
        (root / 'cgroup.controllers').write_text('cpu memory pids\n')
        fake_bin.mkdir()
        probe = 'for last; do :; done; [ "$last" = true ] && exit 0\n' if probe_starts else ''
        (fake_bin / 'systemd-run').write_text(f'#!/bin/sh\n{probe}echo no user bus >&2\nexit 1\n')
        (fake_bin / 'systemd-run').chmod(0o755)
        self.env['SUITE_GATE_CGROUP_ROOT'] = str(root)
        self.env['PATH'] = f'{fake_bin}:{os.environ["PATH"]}'

    def alive(self, pid):
        stat = gate.proc_stat(pid)
        return stat is not None and stat[0] != 'Z'

    def fake_host(self, cores=32, idle=0.5, mem_gb=64, io=0.0, cpu=0.0, skip=()):
        """Point the gate's host readings at fake files: /proc/stat with `cores` CPUs `idle`
        idle since boot (the file never moves, so that is the idle share the gate sees),
        MemAvailable in GiB and pressure `some avg10` percentages. Paths in skip are left
        out; calling again rewrites the files."""
        root = self.tmp / 'proc'
        (root / 'pressure').mkdir(parents=True, exist_ok=True)
        total = 1_000_000 * cores
        files = {
            'stat': f'cpu  {total - int(total * idle)} 0 0 {int(total * idle)} 0 0 0 0 0 0\n'
                    + ''.join(f'cpu{n} 0 0 0 0 0 0 0 0 0 0\n' for n in range(cores)),
            'meminfo': f'MemTotal: {128 * 2**20} kB\nMemAvailable: {int(mem_gb * 2**20)} kB\n',
            'pressure/io': f'some avg10={io:.2f} avg60=0.00 avg300=0.00 total=0\n'
                           'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
            'pressure/cpu': f'some avg10={cpu:.2f} avg60=0.00 avg300=0.00 total=0\n'
                            'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
        }
        for name, text in files.items():
            path = root / name
            if name in skip:
                path.unlink(missing_ok=True)
            else:
                replace(path, text)
        self.env['SUITE_GATE_PROC_ROOT'] = str(root)
        return root

    def old_gate(self):
        """The previous suite-gate.py, from the base commit, as a runnable file."""
        shown = subprocess.run(['git', 'show', f'{BASE_COMMIT}:skills/local/three-tier-testing/'
                                'scripts/suite-gate.py'], cwd=SCRIPT.parent,
                               capture_output=True, text=True)
        if shown.returncode != 0:
            self.skipTest(f'the previous version is not in Git here: {shown.stderr.strip()}')
        path = self.tmp / 'old/suite-gate.py'
        path.parent.mkdir()
        path.write_text(shown.stdout)
        return path

    def waiting_reason(self):
        return [w.get('reason') for w in self.status()['waiting'] if w.get('kind') == 'slot']


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
        self.assertEqual(record['profile_key'], info['profile_key'])
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

    def test_without_scopes_a_finished_suite_holds_while_its_session_leaves_processes(self):
        self.without_scopes()
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
            'g.Gate.set_session = lambda self, *a: os.kill(os.getpid(), signal.SIGKILL)\n'
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


@unittest.skipIf(SCOPE_SKIP, f'needs systemd user scopes: {SCOPE_SKIP}')
class ScopeTests(GateCase):
    """Suites in real systemd user scopes (cgroup v2)."""

    def sleeper(self, name, ignore_term=False):
        """Shell text that starts one process in a new session and writes its pid to a file
        (an ignored TERM stays ignored across exec)."""
        pidfile = self.tmp / f'{name}.pid'
        trap = 'trap "" TERM; ' if ignore_term else ''
        return pidfile, (f"setsid sh -c '{trap}echo $$ > {pidfile}; exec sleep 60' "
                         f"</dev/null >/dev/null 2>&1 &")

    def test_each_suite_runs_in_its_own_scope_and_records_its_profile(self):
        groups = []
        for n in range(2):
            seen = self.tmp / f'cgroup-{n}'
            result = self.gate('run', '--rerun', 'again', '--',
                               f'cut -d: -f3 /proc/self/cgroup > {seen}; sleep 0.3')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('new session', result.stderr)
            groups.append(seen.read_text().strip())
        self.assertNotEqual(groups[0], groups[1])
        for group in groups:
            self.assertTrue(group.endswith('.scope') and self.tmp.name in group, group)
        profile = self.records()[-1]['profile']
        self.assertEqual(set(profile), {'cpu_peak_cores', 'cpu_avg_cores', 'cpu_seconds',
                                        'mem_peak_bytes', 'sample_seconds', 'fallback',
                                        'leftover_processes'})
        self.assertEqual((profile['fallback'], profile['leftover_processes'],
                          profile['sample_seconds']), (False, 0, 0.1))
        for field in ('cpu_peak_cores', 'cpu_avg_cores', 'cpu_seconds'):
            self.assertIsInstance(profile[field], float, field)
        self.assertGreater(profile['mem_peak_bytes'], 0)

    def test_the_holder_records_the_group_and_the_main_session(self):
        seen = self.tmp / 'seen'
        release = self.tmp / 'release'
        proc = self.start('run', '--', f'cut -d: -f3 /proc/self/cgroup > {seen}; echo $$ >> {seen}; '
                                       f'while [ ! -f {release} ]; do sleep 0.05; done')
        self.wait_until(lambda: len(seen.read_text().split()) == 2 if seen.exists() else False,
                        message='suite started')
        group, pid = seen.read_text().split()
        [holder] = self.status()['running']
        self.assertEqual((holder['cgroup'], holder['sid']), (group, int(pid)))
        [lock] = self.status()['locks'].values()
        self.assertEqual((lock['cgroup'], lock['sid']), (group, int(pid)))
        release.touch()
        self.assertEqual(self.finish(proc)[0], 0)

    def test_a_suite_shorter_than_the_interval_and_a_late_memory_peak_are_measured(self):
        self.set_config(sample_seconds=30)
        # About 0.3 s of CPU on one core, then 200 MiB touched right before the suite exits.
        script = ('import os, time\n'
                  'os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})\n'
                  'end = time.process_time() + 0.3\n'
                  'while time.process_time() < end: pass\n'
                  'block = bytearray(200 * 2**20)\n')
        (self.tmp / 'load.py').write_text(script)
        result = self.gate('run', '--', f'{sys.executable} {self.tmp / "load.py"}')
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = self.records()[-1]['profile']
        self.assertGreaterEqual(profile['mem_peak_bytes'], 200 * 2**20)
        self.assertGreaterEqual(profile['cpu_seconds'], 0.3)
        self.assertGreater(profile['cpu_peak_cores'], 0.2)
        self.assertEqual(profile['sample_seconds'], 30)

    def test_cpu_used_right_after_the_start_counts_toward_the_peak(self):
        self.set_config(sample_seconds=30)
        script = ('import os, time\n'
                  'os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})\n'
                  'end = time.process_time() + 0.3\n'
                  'while time.process_time() < end: pass\n')
        (self.tmp / 'load.py').write_text(script)
        # A gate that stalls just before taking its CPU baseline must still count the suite's
        # first second.
        snippet = (
            'import importlib.util, sys, time\n'
            f'spec = importlib.util.spec_from_file_location("g", {str(SCRIPT)!r})\n'
            'g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)\n'
            'init = g.Sampler.__init__\n'
            'def slow(self, *a):\n'
            '    time.sleep(1)\n'
            '    init(self, *a)\n'
            'g.Sampler.__init__ = slow\n'
            'sys.exit(g.main(sys.argv[1:]))\n')
        result = subprocess.run([sys.executable, '-c', snippet, 'run', '--',
                                 f'{sys.executable} {self.tmp / "load.py"}'], cwd=self.repo,
                                env=self.env, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        profile = self.records()[-1]['profile']
        self.assertGreaterEqual(profile['cpu_seconds'], 0.3)
        self.assertGreater(profile['cpu_peak_cores'], 0.2)

    def test_status_shows_current_usage_of_running_suites(self):
        release = self.tmp / 'release'
        proc = self.start('run', '--', f'while [ ! -f {release} ]; do sleep 0.05; done')
        self.wait_until(lambda: any((h.get('sample') or {}).get('cpu_cores') is not None
                                    for h in self.status()['running']), message='a sample')
        [holder] = self.status()['running']
        self.assertIsInstance(holder['usage']['cpu_cores'], float)
        self.assertGreater(holder['usage']['mem_bytes'], 0)
        text = self.gate('status').stdout
        self.assertRegex(text, r'cpu \d+\.\d cores, mem \d+\.\d (KiB|MiB)')
        release.touch()
        self.assertEqual(self.finish(proc)[0], 0)

    def test_a_new_session_keeps_the_slot_after_the_gate_is_killed(self):
        self.set_config(max_slots=1)
        pidfile, start = self.sleeper('detached')
        proc = self.start('run', '--', f'{start} while :; do sleep 0.1; done')
        self.wait_until(pidfile.exists, message='detached process started')
        detached = int(pidfile.read_text())
        proc.kill()
        proc.wait()
        [holder] = self.status()['running']
        self.assertIsNone(holder['usage']['cpu_cores'], 'no gate samples it any more')
        self.assertGreater(holder['usage']['mem_bytes'], 0)
        os.killpg(holder['sid'], signal.SIGKILL)  # only the other session is left
        self.wait_until(lambda: gate.session_pids(holder['sid']) == [], message='session gone')
        self.assertTrue(self.alive(detached))
        self.assertIn('its group still has processes', self.gate('status').stdout)

        waiting, release = self.blocker('next')
        release.touch()
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='next queued')
        time.sleep(0.3)
        self.assertIsNone(waiting.poll(), 'the slot must stay taken')
        self.assertEqual(len(self.status()['locks']), 1)
        os.kill(detached, signal.SIGKILL)
        self.assertEqual(self.finish(waiting)[0], 0)
        self.assertEqual(self.status()['locks'], {})
        self.assertEqual(len(self.records()), 1, 'the killed run writes no record')

    def test_interrupt_ends_the_whole_group_with_new_sessions_and_writes_no_record(self):
        stubborn, start_stubborn = self.sleeper('stubborn', ignore_term=True)
        polite, start_polite = self.sleeper('polite')
        proc = self.start('run', '--', f'{start_stubborn} {start_polite} '
                                       f'while :; do sleep 0.1; done')
        self.wait_until(lambda: stubborn.exists() and polite.exists(), message='both started')
        pids = [int(stubborn.read_text()), int(polite.read_text())]
        sent = time.monotonic()
        proc.send_signal(signal.SIGINT)
        code, _, err = self.finish(proc)
        self.assertGreaterEqual(time.monotonic() - sent, gate.KILL_GRACE_SECONDS,
                                'the stubborn process outlives SIGTERM until the group is killed')
        self.assertEqual(code, 128 + signal.SIGINT)
        self.assertIn('interrupted', err)
        for pid in pids:
            self.assertFalse(self.alive(pid), pid)
        self.assertEqual(self.records(), [])
        status = self.status()
        self.assertEqual((status['running'], status['locks']), ([], {}))

    def test_processes_left_after_a_normal_end_are_listed_recorded_kept_and_free_the_slot(self):
        pidfile, start = self.sleeper('left')
        result = self.gate('run', '--', f'{start} while [ ! -s {pidfile} ]; do sleep 0.05; done')
        self.assertEqual(result.returncode, 0, result.stderr)
        left = int(pidfile.read_text())
        self.assertIn('left 1 process(es) running in its group', result.stderr)
        self.assertIn(f'  {left} sleep 60', result.stderr)
        self.assertEqual(self.records()[-1]['profile']['leftover_processes'], 1)
        self.assertTrue(self.alive(left), 'the gate must not stop it')
        status = self.status()
        self.assertEqual((status['running'], status['locks']), ([], {}))

    def test_without_a_user_service_the_suite_falls_back_to_a_session(self):
        for var in ('XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'):
            self.env.pop(var, None)
        result = self.gate('run', '--', self.suite())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('could not start a systemd user scope', result.stderr)
        self.assertIn('running the suite in a new session instead', result.stderr)
        self.assertTrue(self.records()[-1]['profile']['fallback'])
        self.assertEqual(self.runs(), 1)


class FallbackTests(GateCase):
    def test_without_cgroup_v2_the_suite_runs_in_a_session_and_is_not_measured(self):
        self.without_scopes()
        release = self.tmp / 'release'
        proc = self.start('run', '--', f'echo run >> {self.counter}; '
                                       f'while [ ! -f {release} ]; do sleep 0.05; done')
        self.wait_until(lambda: self.runs() == 1, message='suite started')
        [holder] = self.status()['running']
        self.assertIsNone(holder['cgroup'])
        self.assertIsInstance(holder['sid'], int)
        self.assertEqual(holder['usage'], {'cpu_cores': None, 'mem_bytes': None})
        release.touch()
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0)
        self.assertIn('cgroup v2 is not mounted', err)
        self.assertIn('running the suite in a new session instead', err)
        self.assertEqual(self.records()[-1]['profile'], {
            'cpu_peak_cores': None, 'cpu_avg_cores': None, 'cpu_seconds': None,
            'mem_peak_bytes': None, 'sample_seconds': None, 'fallback': True,
            'leftover_processes': None})


class CompatibilityTests(GateCase):
    """Holders written by the previous suite-gate.py, and that version reading ours."""

    def old_holder(self, sid):
        """A holder in the previous format whose gate is gone (its start time differs)."""
        return {'id': f'old-{sid}', 'pid': os.getpid(), 'start': 0, 'sid': sid, 'agent': 'old',
                'command': 'old suite', 'cwd': str(self.tmp), 'fingerprint': None,
                'since': time.time()}

    def test_a_holder_without_a_group_is_alive_while_its_session_has_processes(self):
        self.set_config(max_slots=1)
        session = subprocess.Popen(['sleep', '60'], start_new_session=True)
        self.addCleanup(session.kill)
        self.state.mkdir()
        (self.state / 'state.json').write_text(json.dumps({
            'seq': 0, 'waiters': [], 'locks': {},
            'slots': [self.old_holder(session.pid), self.old_holder(None)]}))
        self.fake_host()
        status = self.status()
        self.assertEqual([h['sid'] for h in status['running']], [session.pid])
        self.assertEqual(status['running'][0]['reservation'],
                         {'cpu_cores': 4.0, 'mem_bytes': 4 * GIB, 'source': 'default'})
        self.assertEqual(status['host']['unused_reservation'],
                         {'cpu_cores': 4.0, 'mem_bytes': 4 * GIB})
        waiting, release = self.blocker('next')
        release.touch()
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='queued')
        time.sleep(0.3)
        self.assertIsNone(waiting.poll(), 'the old holder must keep the slot')
        session.kill()
        session.wait()
        self.assertEqual(self.finish(waiting)[0], 0)

    def old(self, *args):
        result = subprocess.run([sys.executable, str(self.old_path), *args], cwd=self.repo,
                                env=self.env, capture_output=True, text=True, timeout=60)
        return result

    def old_status(self):
        result = self.old('status', '--json', '--limit', '100')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_the_previous_version_keeps_our_holders_while_the_gate_or_session_lives(self):
        self.old_path = self.old_gate()
        self.set_config(max_slots=1)
        release = self.tmp / 'release'
        ours = self.start('run', '--', f'echo run >> {self.counter}; '
                                       f'while [ ! -f {release} ]; do sleep 0.05; done')
        self.wait_until(lambda: self.runs() == 1, message='our suite started')
        for _ in range(2):  # the gate lives, then only the suite's session does
            status = self.old_status()
            self.assertEqual((len(status['running']), len(status['locks'])), (1, 1))
            saved = json.loads((self.state / 'state.json').read_text())
            self.assertEqual(saved['slots'][0]['cgroup'], status['running'][0]['cgroup'])
            if ours.poll() is None:
                ours.kill()
                ours.wait()

        plain = self.tmp / 'plain-old'
        plain.mkdir()
        theirs = subprocess.Popen([sys.executable, str(self.old_path), 'run', '--',
                                   f'echo run >> {self.counter}'], cwd=plain, env=self.env,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.procs.append(theirs)
        self.wait_until(lambda: len(self.old_status()['waiting']) == 1, message='old run queued')
        time.sleep(0.3)
        self.assertEqual(self.runs(), 1, 'the old version must not take the held slot')
        self.assertEqual(len(self.status()['locks']), 1)
        release.touch()
        self.assertEqual(self.finish(theirs)[0], 0)
        self.assertEqual(self.runs(), 2)
        status = self.status()
        self.assertEqual((status['running'], status['locks']), ([], {}))


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


class AdmissionRuleTests(unittest.TestCase):
    """admission() and unused_reservation() with exact numbers."""
    # 12.5 cores and 21 GiB are left of a host with 16 idle cores and 32 GiB available.
    RUNNING = [(2.0, 2 * GIB), (1.5, 1 * GIB)]

    def config(self, **values):
        return dict(gate.DEFAULTS, **values)

    def host(self, free=16.0, mem_gb=32, brake=False, io=0.0, cpu=0.0, unreadable=()):
        return {'cpu_free_cores': free, 'mem_available_bytes': mem_gb * GIB,
                'pressure': {'io': io, 'cpu': cpu}, 'brake': {'on': brake},
                'unreadable': {'load': list(unreadable), 'pressure': []}}

    def test_a_reservation_that_just_fits_starts_and_one_just_over_waits(self):
        config, host, running = self.config(), self.host(), self.RUNNING
        self.assertEqual(gate.admission(config, running, (12.5, 21 * GIB), host), (True, None))
        self.assertEqual(gate.admission(config, running, (12.75, 21 * GIB), host),
                         (False, 'not enough CPU: needs 12.75 cores, 12.5 available'))
        self.assertEqual(gate.admission(config, running, (12.5, 21.25 * GIB), host),
                         (False, 'not enough memory: needs 21.25 GiB, 21 GiB available'))
        self.assertFalse(gate.admission(config, running, (12.5, 21 * GIB + 1), host)[0])
        self.assertEqual(gate.admission(config, running, (13, 22 * GIB), host)[1],
                         'not enough CPU: needs 13 cores, 12.5 available; '
                         'not enough memory: needs 22 GiB, 21 GiB available')
        self.assertEqual(gate.admission(self.config(mem_reserve_gb=0), running,
                                        (12.5, 29 * GIB), host), (True, None))

    def test_the_cap_comes_first_and_below_the_floor_nothing_else_counts(self):
        running = self.RUNNING
        self.assertEqual(gate.admission(self.config(max_slots=2), running, (0, 0), self.host()),
                         (False, 'host cap reached: 2/2 suites running'))
        awful = self.host(free=0, mem_gb=0, brake=True, io=90, unreadable=['/proc/meminfo'])
        self.assertEqual(gate.admission(self.config(min_slots=3), running, (64, 64 * GIB),
                                        awful), (True, None))
        above_cap = self.config(min_slots=5, max_slots=3)
        self.assertEqual(gate.admission(above_cap, running, (64, 64 * GIB), awful), (True, None))
        self.assertEqual(gate.admission(above_cap, running + [(0, 0)], (0, 0), self.host()),
                         (False, 'host cap reached: 3/3 suites running'))

    def test_at_the_floor_unreadable_data_then_the_brake_then_the_fit_decide(self):
        config, running, small = self.config(), self.RUNNING, (1, GIB)
        self.assertEqual(gate.admission(config, running, small,
                                        self.host(brake=True, unreadable=['/x/meminfo'])),
                         (False, 'host data unreadable: /x/meminfo'))
        self.assertEqual(gate.admission(config, running, small, self.host(brake=True, io=45)),
                         (False, 'brake on: disk wait 45%, above 40%'))
        self.assertEqual(gate.admission(config, running, small,
                                        self.host(brake=True, io=10, cpu=55.5)),
                         (False, 'brake on: CPU wait 55.5%, above 50%'))
        self.assertEqual(gate.admission(config, running, small,
                                        self.host(brake=True, io=30, cpu=5)),
                         (False, 'brake on until disk wait < 20% and CPU wait < 25% '
                                 '(now disk wait 30%, CPU wait 5%)'))

    def test_a_running_suite_holds_what_it_does_not_use_yet_of_its_reservation(self):
        root = Path(tempfile.mkdtemp(prefix='suite-gate-cgroup-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(root)])
        (root / 'x.scope').mkdir()
        memory = root / 'x.scope/memory.current'
        holder = {'pid': os.getpid(), 'start': gate.proc_stat(os.getpid())[2],
                  'cgroup': '/x.scope', 'sample': {'cpu_cores': 2.5},
                  'reservation': {'cpu_cores': 6, 'mem_bytes': 6 * GIB}}
        config = self.config()
        with mock.patch.dict(os.environ, SUITE_GATE_CGROUP_ROOT=str(root)):
            memory.write_text(f'{GIB}\n')
            self.assertEqual(gate.unused_reservation(holder, config), (3.5, 5 * GIB))
            memory.write_text(f'{7 * GIB}\n')
            self.assertEqual(gate.unused_reservation(dict(holder, sample={'cpu_cores': 8.0}),
                                                     config), (0.0, 0))
            memory.write_text(f'{GIB}\n')  # the gate is gone: its CPU use is unknown
            self.assertEqual(gate.unused_reservation(dict(holder, gate_done=True), config),
                             (6, 5 * GIB))
            memory.unlink()
            self.assertEqual(gate.unused_reservation(holder, config), (3.5, 6 * GIB))
        old = {'pid': os.getpid(), 'start': 0, 'sid': 1}  # no group and no reservation
        self.assertEqual(gate.unused_reservation(old, config), (4.0, 4 * GIB))


class HostViewTests(unittest.TestCase):
    """host_view() on fake /proc files whose CPU counters move."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='suite-gate-proc-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.root)])
        (self.root / 'pressure').mkdir()
        for name in ('io', 'cpu'):
            (self.root / 'pressure' / name).write_text('some avg10=0.00 avg60=0.00 total=0\n')
        (self.root / 'meminfo').write_text(f'MemAvailable: {8 * 2**20} kB\n')
        patcher = mock.patch.dict(os.environ, SUITE_GATE_PROC_ROOT=str(self.root))
        patcher.start()
        self.addCleanup(patcher.stop)

    def stat(self, busy, idle, iowait=0):
        (self.root / 'stat').write_text(f'cpu  {busy} 0 0 {idle} {iowait} 0 0 0 0 0\n'
                                        'cpu0 0\ncpu1 0\ncpu2 0\ncpu3 0\n')

    def test_idle_cpu_is_measured_since_the_base_reading_and_a_stale_base_is_dropped(self):
        config, state = dict(gate.DEFAULTS), {}
        self.stat(busy=1000, idle=3000)  # since boot: 3/4 idle
        host = gate.host_view(state, config)
        self.assertEqual((host['cores'], host['cpu_idle'], host['cpu_free_cores']), (4, 0.75, 3.0))
        self.assertEqual(len(state['host_cpu']), 1)
        self.stat(busy=1300, idle=3050, iowait=50)  # 300 busy, 100 idle (iowait counts) since
        host = gate.host_view(state, config)
        self.assertEqual((host['cpu_idle'], host['cpu_free_cores']), (0.25, 1.0))
        self.assertEqual(host['mem_available_bytes'], 8 * GIB)
        state['host_cpu'][0][0] -= 3 * gate.CPU_WINDOW_SECONDS  # the base is too old now
        self.stat(busy=2000, idle=2900, iowait=100)
        host = gate.host_view(state, config)
        self.assertEqual(host['cpu_idle'], 0.6, 'counters since boot, the base was dropped')

    def test_a_reading_older_than_the_window_becomes_the_next_base(self):
        config, state = dict(gate.DEFAULTS), {}
        self.stat(busy=1000, idle=3000)
        gate.host_view(state, config)
        state['host_cpu'][0][0] -= gate.CPU_WINDOW_SECONDS
        self.stat(busy=1100, idle=3100)
        gate.host_view(state, config)
        self.assertEqual([w[1:] for w in state['host_cpu']], [[4000, 3000], [4200, 3100]])
        self.stat(busy=1100, idle=3400)
        host = gate.host_view(state, config)
        self.assertEqual(host['cpu_idle'], 0.8, '100 busy, 400 idle since the base of 4000')


class AdmissionTests(GateCase):
    """Who starts and why the rest wait, on fake host readings. Suites run in plain sessions,
    so their current use is unknown and each running suite holds all of its reservation."""

    def setUp(self):
        super().setUp()
        self.without_scopes()

    def running(self):
        return len(self.status()['running'])

    def test_the_floor_starts_suites_under_pressure_then_the_brake_and_memory_hold_the_rest(self):
        self.set_config(min_slots=2, max_slots=4)
        self.fake_host(cores=32, idle=0.5, mem_gb=1, io=45)
        a, release_a = self.blocker('a')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: self.running() == 2, message='two below the floor')
        c, release_c = self.blocker('c')
        self.wait_until(lambda: self.waiting_reason() == ['brake on: disk wait 45%, above 40%'],
                        message='brake reason')
        time.sleep(0.3)  # one waiting report
        self.fake_host(cores=32, idle=0.5, mem_gb=1, io=30)
        self.wait_until(lambda: self.waiting_reason() == [
            'brake on until disk wait < 20% and CPU wait < 25% (now disk wait 30%, CPU wait 0%)'],
            message='brake still on between the marks')
        self.fake_host(cores=32, idle=0.5, mem_gb=1, io=10)
        # 16 idle cores - 2 x 4 reserved = 8 left; 1 GiB - 2 x 4 GiB - 8 GiB reserve = -15 GiB.
        self.wait_until(lambda: self.waiting_reason() == [
            'not enough memory: needs 4 GiB, -15 GiB available'], message='memory reason')
        status = self.status()
        self.assertEqual((status['host']['cpu_left_cores'], status['host']['mem_left_bytes']),
                         (8.0, -15 * GIB))
        self.assertFalse(status['host']['brake']['on'])
        self.assertEqual([h['reservation'] for h in status['running']],
                         [{'cpu_cores': 4.0, 'mem_bytes': 4 * GIB, 'source': 'default'}] * 2)
        text = self.gate('status').stdout
        self.assertIn('host slot: not enough memory: needs 4 GiB, -15 GiB available', text)
        self.assertIn('Host: CPU 16 of 32 cores idle, 8 left after unused reservations; '
                      'memory 1 GiB available, -15 GiB left after unused reservations and the '
                      '8 GiB reserve; brake off (disk wait 10%, CPU wait 0%); '
                      '2 start regardless of load, at most 4 run', text)
        self.assertIn('reserves 4 cores, 4 GiB (default)', text)
        self.fake_host(cores=32, idle=0.5, mem_gb=20, io=10)  # exactly 4 GiB left
        self.wait_until(lambda: self.running() == 3, message='third admitted')
        for release in (release_a, release_b, release_c):
            release.touch()
        self.assertEqual(self.finish(a)[0], 0)
        self.assertEqual(self.finish(b)[0], 0)
        code, _, err = self.finish(c)
        self.assertEqual(code, 0)
        self.assertIn('waiting for a host slot (2/4 in use: t-tester', err)
        self.assertIn('ahead): brake on: disk wait 45%, above 40%', err)

    def test_not_enough_cpu_waits_and_a_config_change_applies_on_the_next_check(self):
        self.set_config(min_slots=1, max_slots=4)
        self.fake_host(cores=8, idle=0.5)
        a, release_a = self.blocker('a')
        self.wait_until(lambda: self.running() == 1, message='one below the floor')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: self.waiting_reason() == [
            'not enough CPU: needs 4 cores, 0 available'], message='CPU reason')
        self.set_config(min_slots=1, max_slots=4, default_cores=2)
        self.wait_until(lambda: self.running() == 2, message='admitted with smaller reservations')
        release_a.touch()
        release_b.touch()
        self.assertEqual((self.finish(a)[0], self.finish(b)[0]), (0, 0))

    def test_the_cap_follows_the_config_and_lowering_it_stops_nothing(self):
        self.set_config(min_slots=1, max_slots=1)
        self.fake_host()
        a, release_a = self.blocker('a')
        self.wait_until(lambda: self.running() == 1, message='a running')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: len(self.status()['waiting']) == 1, message='b queued')
        c, release_c = self.blocker('c')
        self.wait_until(lambda: self.waiting_reason() == ['host cap reached: 1/1 suites running',
                                                          '1 suite(s) queued ahead'],
                        message='b at the cap, c behind it')
        self.set_config(min_slots=1, max_slots=2)
        self.wait_until(lambda: self.running() == 2, message='b admitted after raising the cap')
        self.set_config(min_slots=1, max_slots=1)
        self.wait_until(lambda: self.waiting_reason() == ['host cap reached: 2/1 suites running'],
                        message='c at the lowered cap')
        time.sleep(0.3)
        self.assertEqual(self.running(), 2)
        self.assertIsNone(a.poll())
        self.assertIsNone(b.poll())
        release_c.touch()
        release_a.touch()
        release_b.touch()
        self.assertEqual([self.finish(p)[0] for p in (a, b, c)], [0, 0, 0])

    def test_unreadable_host_data_admits_only_to_the_floor_and_unreadable_pressure_is_ignored(self):
        self.set_config(min_slots=1, max_slots=4)
        root = self.fake_host(skip=('meminfo', 'pressure/io'))
        a, release_a = self.blocker('a')
        self.wait_until(lambda: self.running() == 1, message='one below the floor')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: self.waiting_reason() == [
            f'host data unreadable: {root}/meminfo'], message='unreadable reason')
        status = self.status()
        self.assertEqual(status['host']['unreadable'], {'load': [f'{root}/meminfo'],
                                                        'pressure': [f'{root}/pressure/io']})
        self.assertFalse(status['host']['brake']['on'])
        shown = self.gate('status')
        self.assertIn(f'cannot read {root}/pressure/io: the brake ignores it', shown.stdout)
        self.assertIn(f'cannot read {root}/meminfo: only 1 start until it can be read',
                      shown.stdout)
        self.assertIn(f'cannot read {root}/pressure/io: the brake ignores disk wait', shown.stderr)
        self.fake_host(skip=('pressure/io',))
        self.wait_until(lambda: self.running() == 2, message='admitted once meminfo reads')
        release_a.touch()
        release_b.touch()
        self.assertEqual((self.finish(a)[0], self.finish(b)[0]), (0, 0))


class BrakeTests(GateCase):
    def test_the_brake_has_two_marks_and_is_shared_through_the_state(self):
        steps = [(40, 50, False), (45, 0, True), (20, 0, True), (19.99, 30, True),
                 (19.99, 24.99, False), (39, 49, False), (10, 55, True)]
        for io, cpu, on in steps:
            with self.subTest(io=io, cpu=cpu):
                self.fake_host(io=io, cpu=cpu)
                self.assertEqual(self.status()['host']['brake']['on'], on)
                saved = json.loads((self.state / 'state.json').read_text())['brake']
                self.assertEqual((saved['on'], saved['io'], saved['cpu']), (on, io, cpu))


class ConfigTests(GateCase):
    def setUp(self):
        super().setUp()
        self.without_scopes()
        self.fake_host()

    def status_of(self):
        result = self.gate('status', '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout), result.stderr

    def test_defaults_and_a_config_with_only_max_slots(self):
        self.config.unlink()
        status, _ = self.status_of()
        self.assertEqual((status['min_slots'], status['max_slots']), (2, 8))
        self.assertEqual(status['config'], gate.DEFAULTS)
        self.config.write_text('{"max_slots": 1}')
        status, _ = self.status_of()
        self.assertEqual((status['min_slots'], status['max_slots']), (1, 1))

    def test_unusable_values_keep_their_defaults_with_a_warning(self):
        self.config.write_text(json.dumps({
            'max_slots': 'x', 'min_slots': -1, 'profile_history': 2.5, 'brake_io_low': 50,
            'brake_cpu_high': 20, 'mem_reserve_gb': 3, 'default_cores': 1.5}))
        status, err = self.status_of()
        self.assertEqual(status['config'], dict(gate.DEFAULTS, mem_reserve_gb=3.0,
                                                default_cores=1.5))
        for text in ('config max_slots="x" is not usable; using 8',
                     'config min_slots=-1 is not usable; using 2',
                     'config profile_history=2.5 is not usable; using 5',
                     'config brake_io_low (50.0) is above brake_io_high (40.0); '
                     'using 20.0 and 40.0',
                     'config brake_cpu_low (25.0) is above brake_cpu_high (20.0); '
                     'using 25.0 and 50.0'):
            self.assertIn(text, err)

    def test_a_queued_suite_keeps_going_through_bad_and_broken_config(self):
        self.set_config(min_slots=1, max_slots=1, brake_io_high='x')
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        queued = self.start('run', '--', self.suite())
        self.wait_until(lambda: self.waiting_reason() == ['host cap reached: 1/1 suites running'],
                        message='queued at the cap')
        time.sleep(0.3)  # several checks, each rereading the config
        self.config.write_text('{not json')
        code, _, err = self.finish(queued)  # the defaults have a floor of 2
        self.assertEqual(code, 0, err)
        self.assertEqual(err.count('config brake_io_high="x" is not usable'), 1)
        self.assertEqual(err.count('ignoring unreadable config'), 1)
        release.touch()
        self.finish(hold)


class ReservationTests(GateCase):
    def setUp(self):
        super().setUp()
        self.fake_host()

    def test_worktrees_of_a_repo_share_a_profile_key_and_other_repos_do_not(self):
        (self.repo / 'sub').mkdir()
        (self.repo / 'sub/a.py').write_text('')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'sub')
        worktree = self.tmp / 'wt'
        git(self.repo, 'worktree', 'add', '-q', str(worktree), 'HEAD')
        other = self.tmp / 'other'
        (other / 'sub').mkdir(parents=True)
        git(other, 'init', '-q')
        keys = [gate.fingerprint(root / 'sub', [f'cd {root}/sub && make; ls {root}-old'])
                ['profile_key'] for root in (self.repo, worktree, other)]
        self.assertEqual(keys[0], {'repo': str((self.repo / '.git').resolve()), 'rel_cwd': 'sub',
                                   'command': f'cd <worktree>/sub && make; ls {self.repo}-old'})
        self.assertEqual(keys[1], dict(keys[0], command=f'cd <worktree>/sub && make; '
                                                        f'ls {worktree}-old'))
        self.assertEqual(keys[2]['repo'], str((other / '.git').resolve()))
        same_text = [gate.fingerprint(root / 'sub', ['cd <worktree>/sub && make'])['profile_key']
                     for root in (self.repo, worktree, other)]
        self.assertEqual(same_text[0], same_text[1])
        self.assertNotEqual(same_text[0], same_text[2])

    def measured_history(self, key):
        """Ledger lines for key, oldest first; the latest five measured runs peak at 5.5 cores
        and 3 GiB."""
        def run(cpu, mem, key=key, **extra):
            return {'profile_key': key, 'profile': dict(
                {'cpu_peak_cores': cpu, 'mem_peak_bytes': mem, 'fallback': False}, **extra)}
        return [run(20, 20 * GIB),  # sixth newest measured run: outside profile_history
                run(3, GIB), run(5.5, 2 * GIB),
                run(30, 30 * GIB, fallback=True), run(None, 9 * GIB),  # not measured
                run(25, 25 * GIB, key=dict(key, repo='/elsewhere/.git')),  # another repo
                run(2, 3 * GIB), run(1, int(1.5 * GIB)), run(2.5, GIB)]

    def write_ledger(self, records, mode='w'):
        self.state.mkdir(exist_ok=True)
        with open(self.state / 'ledger.jsonl', mode) as ledger:
            ledger.write(''.join(json.dumps(r) + '\n' for r in records))

    def reservations(self):
        status = self.status()
        return ([h['reservation'] for h in status['running']],
                [w['reservation'] for w in status['waiting'] if w.get('kind') == 'slot'])

    def test_the_reservation_is_the_highest_of_the_latest_measured_runs_and_follows_the_ledger(self):
        self.scopes_that_fall_back()
        release_queued = self.tmp / 'release-queued'
        command = f'while [ ! -f {release_queued} ]; do sleep 0.05; done'
        key = gate.fingerprint(self.repo, [command])['profile_key']
        self.write_ledger(self.measured_history(key))
        self.set_config(min_slots=1, max_slots=1)
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        queued = self.start('run', '--', command)
        default = {'cpu_cores': 4.0, 'mem_bytes': 4 * GIB, 'source': 'default'}
        self.wait_until(lambda: self.reservations() == (
            [default], [{'cpu_cores': 5.5, 'mem_bytes': 3 * GIB, 'source': 'measured'}]),
            message='measured reservation')
        self.set_config(min_slots=1, max_slots=1, profile_history=1)
        self.wait_until(lambda: self.reservations()[1] == [
            {'cpu_cores': 2.5, 'mem_bytes': GIB, 'source': 'measured'}],
            message='profile_history reread')
        self.set_config(min_slots=1, max_slots=1)
        self.wait_until(lambda: self.reservations()[1] == [
            {'cpu_cores': 5.5, 'mem_bytes': 3 * GIB, 'source': 'measured'}],
            message='profile_history back to 5')
        # Another run of the same command finishes while this one waits; no config change.
        self.write_ledger([{'profile_key': key, 'profile': {
            'cpu_peak_cores': 12.0, 'mem_peak_bytes': 6 * GIB, 'fallback': False}}], mode='a')
        self.wait_until(lambda: self.reservations()[1] == [
            {'cpu_cores': 12.0, 'mem_bytes': 6 * GIB, 'source': 'measured'}],
            message='the new record counted')
        release.touch()
        self.finish(hold)
        # Its scope fails to start, so the running suite falls back and reserves the default.
        self.wait_until(lambda: self.reservations() == ([default], []), message='fell back')
        release_queued.touch()
        code, _, err = self.finish(queued)
        self.assertEqual(code, 0, err)
        self.assertIn('could not start a systemd user scope', err)
        self.assertEqual(self.records()[-1]['profile_key'], key)

    def test_without_scopes_a_queued_suite_reserves_the_default_despite_measured_runs(self):
        self.without_scopes()
        command = self.suite()
        key = gate.fingerprint(self.repo, [command])['profile_key']
        self.write_ledger(self.measured_history(key))
        self.set_config(min_slots=1, max_slots=1)
        hold, release = self.blocker('hold')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='blocker running')
        queued = self.start('run', '--', command)
        default = {'cpu_cores': 4.0, 'mem_bytes': 4 * GIB, 'source': 'default'}
        self.wait_until(lambda: self.reservations() == ([default], [default]),
                        message='default reservation while queued')
        release.touch()
        self.assertEqual(self.finish(queued)[0], 0)
        self.finish(hold)

    def test_without_a_user_service_the_default_is_reserved_before_admission(self):
        self.scopes_that_fall_back(probe_starts=False)
        self.fake_host(cores=16, idle=0.5)  # 8 idle cores: 12 measured do not fit, 4 do
        command = self.suite()
        key = gate.fingerprint(self.repo, [command])['profile_key']
        self.write_ledger([{'profile_key': key, 'profile': {
            'cpu_peak_cores': 12.0, 'mem_peak_bytes': GIB, 'fallback': False}}])
        self.set_config(min_slots=0, max_slots=8)
        result = self.gate('run', '--', command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('running the suite in a new session instead', result.stderr)
        self.assertEqual(self.runs(), 1)


class CutoverTests(GateCase):
    """The process checks of the documented cutover, against the previous version."""

    def documented(self, prefix):
        doc = SCRIPT.parents[1] / 'references/suite-gate.md'
        return next(line for line in doc.read_text().splitlines() if line.startswith(prefix))

    def listed(self, check):
        result = subprocess.run(['bash', '-c', check], capture_output=True, text=True,
                                timeout=30)
        return {int(line.split()[0]) for line in result.stdout.splitlines()}

    def background(self, args, **kwargs):
        proc = subprocess.Popen(args, env=self.env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True, **kwargs)

        def kill():
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
        self.addCleanup(kill)
        return proc

    def test_the_checks_list_old_runs_still_fingerprinting_and_old_statuses_still_running(self):
        old = self.old_gate()
        fake_bin, fingerprinting = self.tmp / 'bin', self.tmp / 'fingerprinting'
        fake_bin.mkdir()
        (fake_bin / 'git').write_text(f'#!/bin/sh\ntouch {fingerprinting}\nexec sleep 60\n')
        (fake_bin / 'git').chmod(0o755)
        self.env['PATH'] = f'{fake_bin}:{os.environ["PATH"]}'
        run = self.background([sys.executable, str(old), 'run', '--', 'true'], cwd=self.repo)
        self.wait_until(fingerprinting.exists, message='the old run to compute its fingerprint')
        self.state.mkdir()
        with open(self.state / 'state.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)  # the old status waits for the state lock
            status = self.background([sys.executable, str(old), 'status'])
            time.sleep(1.2)
            self.assertIsNone(status.poll(), 'the old status must still be running')
            self.assertLessEqual({run.pid, status.pid}, self.listed(self.documented('pgrep ')))
            installed = int(time.time())
            time.sleep(2.2)
            later = self.background([sys.executable, '-c', 'import time; time.sleep(60)',
                                     str(old), 'status'])
            found = self.listed(f'installed={installed}; ' + self.documented('ps -eo '))
            self.assertLessEqual({run.pid, status.pid}, found)
            self.assertNotIn(later.pid, found, 'started after the install')


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
