import importlib.util
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
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


# The host's global, system and environment Git config (e.g. a shared core.hooksPath) stay
# out of tests.
GIT_ENV = dict({k: v for k, v in os.environ.items()
                if not k.startswith(('GIT_CONFIG', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX'))},
               GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1',
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
        self.env = dict(GIT_ENV, SUITE_GATE_STATE_DIR=str(self.state), SUITE_GATE_REAP_WAIT='0',
                        SUITE_GATE_CONFIG=str(self.config), HCOM_INSTANCE_NAME='tester',
                        HCOM_TAG='t', HOME=str(self.tmp / 'home'),
                        XDG_CONFIG_HOME=str(self.tmp / 'xdg-config'),
                        XDG_STATE_HOME=str(self.tmp / 'xdg-state'),
                        XDG_DATA_HOME=str(self.tmp / 'xdg-data'),
                        XDG_CACHE_HOME=str(self.tmp / 'xdg-cache'),
                        GH_CONFIG_DIR=str(self.tmp / 'gh-config'))
        self.env.pop('CLAUDE_CODE_SESSION_ID', None)
        self.env.pop('SUITE_GATE_TEST_TODAY', None)
        self.install_fake_gh()
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

    def install_fake_gh(self):
        """A `gh` first on PATH that logs its arguments; the real one is never reached.

        `issue list` prints gh/open.json (default `[]`), `issue view` gh/view.json (default
        an open issue); with gh/fail present every call fails."""
        self.gh_dir = self.tmp / 'gh'
        self.gh_dir.mkdir()
        fake = self.tmp / 'bin/gh'
        fake.parent.mkdir()
        fake.write_text(f"""#!{sys.executable}
import json, sys
from pathlib import Path
d = Path({str(self.gh_dir)!r})
with open(d / 'calls.jsonl', 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if (d / 'fail').exists():
    sys.exit('gh: HTTP 502')
if sys.argv[1:3] == ['issue', 'list']:
    print((d / 'open.json').read_text() if (d / 'open.json').exists() else '[]')
elif sys.argv[1:3] == ['issue', 'view']:
    view = d / 'view.json'
    print(view.read_text() if view.exists() else json.dumps(
        {{'state': 'OPEN', 'url': 'https://github.com/o/r/issues/' + sys.argv[3]}}))
elif sys.argv[1:3] == ['issue', 'create']:
    print('https://github.com/o/r/issues/7')
""")
        fake.chmod(0o755)
        self.env['PATH'] = f"{fake.parent}{os.pathsep}{self.env['PATH']}"

    def gh_calls(self):
        path = self.gh_dir / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

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
        self.env['PATH'] = f'{fake_bin}:{self.env["PATH"]}'

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

    def reaper_log(self):
        log = self.tmp / 'xdg-state/lat/reaper/closed.jsonl'
        log.parent.mkdir(parents=True, exist_ok=True)
        return log

    def append_reaper_record(self, where, pid, result='exited after SIGTERM', signal='SIGTERM'):
        """Shell command that appends a lat-reap record stamped with the time it runs."""
        record = {'pid': pid, 'cwd': where, 'agent': 'nabo-qa-rape', 'why': 'owner agent ended',
                  'command': 'node build-test/index.js', 'signal': signal, 'result': result}
        head, tail = '{"time": "', '", ' + json.dumps(record)[1:]
        now = '"$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"'
        return f"printf '%s\\n' {shlex.quote(head)}{now}{shlex.quote(tail)} >> {self.reaper_log()}"

    def test_processes_the_reaper_ended_under_the_suite_during_the_run_are_reported(self):
        old = {'time': '2020-01-01T00:00:00+00:00', 'pid': 1, 'cwd': str(self.repo),
               'command': 'node old', 'agent': 'x', 'result': 'killed'}
        self.reaper_log().write_text(json.dumps(old) + '\n')
        board = str(self.repo / 'board')
        command = '; '.join([
            f'echo run >> {self.counter}',
            self.append_reaper_record(board, 4242),
            self.append_reaper_record('/elsewhere', 7),
            self.append_reaper_record(board, 8, 'gone before signal', None),
            self.append_reaper_record(board, 9, 'still running after SIGKILL', 'SIGKILL')])
        result = self.gate('run', '--', command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('reaper ended 1 process(es)', result.stderr)
        self.assertIn('pid 4242 node build-test/index.js', result.stderr)
        reaped = self.records()[-1]['reaped']
        self.assertEqual([e['pid'] for e in reaped], [4242])
        self.assertEqual((reaped[0]['signal'], reaped[0]['result']), ('SIGTERM', 'exited after SIGTERM'))

    def test_a_failed_run_waits_for_reaper_records_written_after_the_suite_exits(self):
        self.env['SUITE_GATE_REAP_WAIT'] = '8'
        proc = self.start('run', '--', 'sleep 2; exit 1')
        during = datetime.now(timezone.utc) + timedelta(seconds=1)
        time.sleep(3)  # the suite has failed; lat-reap is still waiting out its grace period
        record = {'time': during.isoformat(timespec='seconds'), 'pid': 4242,
                  'cwd': str(self.repo), 'command': 'node build-test/index.js',
                  'signal': 'SIGTERM', 'result': 'exited after SIGTERM'}
        with self.reaper_log().open('a') as stream:
            stream.write(json.dumps(record) + '\n')
        code, _, _ = self.finish(proc)
        self.assertEqual(code, 1)
        self.assertEqual([e['pid'] for e in self.records()[-1]['reaped']], [4242])
        self.env['SUITE_GATE_REAP_WAIT'] = '0.5'
        self.reaper_log().write_text('')
        late = dict(record, time=(datetime.now(timezone.utc) + timedelta(seconds=30)).isoformat(timespec='seconds'))
        self.reaper_log().write_text(json.dumps(late) + '\n')
        started = time.monotonic()
        self.gate('run', '--rerun', 'again', '--', 'exit 1')
        self.assertEqual(self.records()[-1]['reaped'], [], 'a kill dated after the suite exited is not its')
        self.assertLess(time.monotonic() - started, 5, 'a failure with no kills waits only the window')

    def test_a_run_without_reaper_kills_records_none(self):
        self.gate('run', '--', self.suite())
        self.assertEqual(self.records()[-1]['reaped'], [])

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
                    {'paths': ['docs/**', '.suite-gate.json', '.suite-gate.d/**', '.gitignore'],
                     'tests': []},
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

    def test_rules_in_suite_gate_d_files_are_added_to_the_map(self):
        (self.repo / '.suite-gate.d').mkdir()
        (self.repo / '.suite-gate.d/b-docs.json').write_text(json.dumps(
            {'map': [{'paths': ['docs/guide.md'], 'tests': ['tests/test_util.py']}]}))
        (self.repo / '.suite-gate.d/a-new.json').write_text(json.dumps(
            {'map': [{'paths': ['src/new.py'], 'tests': ['tests/test_app.py']}]}))
        self.touch('src/new.py')
        self.touch('docs/guide.md')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py', 'tests/test_util.py'])])
        self.assertEqual(self.full_runs(), [])

    def test_a_new_suite_gate_d_file_selects_only_its_own_tests(self):
        # As in a real project, which lists the map files as shared paths.
        self.registry['affected']['shared'].append('.suite-gate.d/**')
        self.write_registry()
        git(self.repo, 'commit', '-qam', 'map files shared')
        self.touch('.suite-gate.d/new.json', json.dumps(
            {'map': [{'paths': ['src/new.py'], 'tests': ['tests/test_app.py']}]}))
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py'])])
        self.assertEqual(self.full_runs(), [])
        self.assertIn('tests/test_app.py  (.suite-gate.d/new.json maps src/new.py)',
                      result.stderr)

    def test_a_changed_suite_gate_d_file_selects_only_its_current_tests(self):
        self.touch('.suite-gate.d/web.json', json.dumps(
            {'map': [{'paths': ['web/src/page.ts'], 'tests': ['web/tests/**/*.test.ts']}]}))
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'web map file')
        git(self.repo, 'checkout', '-q', 'feature')
        git(self.repo, 'merge', '-q', 'main')
        self.touch('.suite-gate.d/web.json', json.dumps(
            {'map': [{'paths': ['web/src/page.ts'], 'tests': ['web/tests/**/*.test.ts']},
                     {'paths': ['src/new.py'], 'tests': ['tests/test_util.py']}]}))
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_util.py']),
                                      ('web', ['tests/page.test.ts'])])
        self.assertEqual(self.full_runs(), [])

    def test_a_suite_gate_d_file_mapping_to_no_file_falls_back(self):
        self.touch('.suite-gate.d/new.json', json.dumps(
            {'map': [{'paths': ['src/new.py'], 'tests': ['tests/gone_*.py']}]}))
        result = self.gate('affected')
        self.assertIn('.suite-gate.d/new.json maps to tests that match no file', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_a_shared_suite_gate_json_still_falls_back(self):
        self.registry['affected']['shared'].append('.suite-gate.json')
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('.suite-gate.json: shared path .suite-gate.json', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_a_bad_suite_gate_d_file_stops_affected_and_names_the_file(self):
        (self.repo / '.suite-gate.d').mkdir()
        (self.repo / '.suite-gate.d/bad.json').write_text('{"map": [')
        self.touch('src/app.py')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('.suite-gate.d/bad.json', result.stderr)
        self.assertEqual((self.ran(), self.full_runs()), ([], []))

    def test_a_bad_suite_gate_d_rule_names_its_file(self):
        (self.repo / '.suite-gate.d').mkdir()
        (self.repo / '.suite-gate.d/odd.json').write_text('{"map": [null]}')
        self.touch('src/app.py')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('.suite-gate.d/odd.json: map[0]', result.stderr)

    def test_a_bad_suite_gate_d_file_keeps_the_project_mapped_for_run(self):
        (self.repo / '.suite-gate.d').mkdir()
        (self.repo / '.suite-gate.d/bad.json').write_text('{"map": [')
        result = self.gate('run', '--', self.full('root'))
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('--purpose post-merge', result.stderr)
        self.assertEqual(self.full_runs(), [])

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
        self.assertIn('--base <commit>', result.stderr)
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
        self.assertEqual([(n['kind'], n['purpose'], n['trigger_files'], n['reused_fingerprint'])
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

    def test_affected_tests_are_no_cleanup_unit_but_fallback_suites_are(self):
        self.touch('src/app.py')
        self.assertEqual(self.gate('affected').returncode, 0)
        self.assertEqual(self.status()['cleanup'], [])
        self.touch('README.md')
        self.assertEqual(self.gate('affected').returncode, 0)
        self.assertEqual(sorted((u['rel_cwd'], u['command']) for u in self.status()['cleanup']),
                         [('.', self.full('root')), ('web', self.full('web'))])

    def test_a_failing_full_suite_fails_the_fallback(self):
        self.registry['full_suites'][1]['command'] = 'exit 3'
        self.write_registry()
        self.touch('README.md')
        self.assertEqual(self.gate('affected').returncode, 3)
        self.assertEqual(self.full_runs(), ['root'])


class FallbackScopeTests(AffectedCase):
    """A fallback runs only the full suites whose directory holds the trigger files."""

    def share(self, *paths):
        self.registry['affected']['shared'].extend(paths)
        self.write_registry()
        git(self.repo, 'commit', '-qam', 'more shared paths')

    def test_a_shared_file_inside_a_suite_directory_runs_only_that_suite(self):
        self.share('web/package.json')
        self.touch('web/package.json')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('web/package.json: shared path web/package.json', result.stderr)
        self.assertEqual(self.full_runs(), ['web'])
        self.assertEqual(self.ran(), [])
        (web,) = self.records()
        self.assertEqual((web['rel_cwd'], web['purpose'], web['trigger_files']),
                         ('web', 'map-fallback', ['web/package.json']))

    def test_a_shared_file_in_no_suite_directory_runs_every_suite(self):
        self.share('.gitignore')
        self.touch('.gitignore')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        for record in self.records():
            self.assertEqual((record['purpose'], record['trigger_files']),
                             ('map-fallback', ['.gitignore']))

    def test_a_trigger_in_no_suite_directory_widens_a_scoped_fallback(self):
        self.share('web/package.json')
        self.touch('web/package.json')
        self.touch('README.md')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        for record in self.records():
            self.assertEqual(record['trigger_files'], ['README.md', 'web/package.json'])

    def test_tests_outside_the_fallback_suites_still_run(self):
        self.share('web/package.json')
        self.touch('web/package.json')
        self.touch('web/src/page.ts')
        self.touch('src/app.py')
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['web'])
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py'])])

    def test_a_failing_fallback_suite_fails_even_when_the_other_tests_pass(self):
        self.share('web/package.json')
        self.registry['full_suites'][1]['command'] = 'exit 3'
        self.write_registry()
        git(self.repo, 'commit', '-qam', 'failing web suite')
        self.touch('web/package.json')
        self.touch('src/app.py')
        self.assertEqual(self.gate('affected').returncode, 3)
        self.assertEqual(self.ran(), [('.', ['tests/test_app.py'])])


class RegistryMapChangeTests(AffectedCase):
    """A changed .suite-gate.json selects the tests of its added or changed map rules."""

    def setUp(self):
        super().setUp()
        # As in a real project, which lists the registry as a shared path.
        self.registry['affected']['shared'].append('.suite-gate.json')
        self.write_registry()
        git(self.repo, 'commit', '-qam', 'registry shared')
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '-q', 'feature')
        git(self.repo, 'checkout', '-q', 'feature')

    def test_an_added_rule_selects_only_its_tests(self):
        self.registry['affected']['map'].append(
            {'paths': ['src/new.py'], 'tests': ['tests/test_util.py']})
        self.write_registry()
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_util.py'])])
        self.assertEqual(self.full_runs(), [])
        self.assertIn('tests/test_util.py  (.suite-gate.json maps src/new.py)', result.stderr)

    def test_a_changed_rule_selects_only_its_current_tests(self):
        self.registry['affected']['map'][0]['tests'] = ['tests/test_util.py']
        self.registry['affected']['map'].insert(0, {'paths': ['src/new.py'], 'tests': []})
        self.write_registry()
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.ran(), [('.', ['tests/test_util.py'])])
        self.assertEqual(self.full_runs(), [])

    def test_a_reformatted_registry_selects_nothing(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps(self.registry, indent=2))
        result = self.gate('affected')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.ran(), self.full_runs()), ([], []))

    def test_a_removed_rule_falls_back(self):
        del self.registry['affected']['map'][1]
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('.suite-gate.json: a map rule was removed', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.assertEqual(self.ran(), [])

    def test_a_removed_rule_falls_back_even_with_a_rule_added_elsewhere(self):
        del self.registry['affected']['map'][0]
        self.registry['affected']['map'].append({'paths': ['docs/new/**'], 'tests': []})
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('.suite-gate.json: a map rule was removed', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_a_change_outside_the_map_falls_back(self):
        changes = {
            'commands': lambda r: r['affected']['commands'].update({'.': 'echo {tests}'}),
            'shared': lambda r: r['affected']['shared'].append('README.md'),
            'full_suites': lambda r: r['full_suites'].append({'command': 'true'}),
            'suites': lambda r: r.update({'suites': ['make test']}),
        }
        for field, change in changes.items():
            with self.subTest(field=field):
                git(self.repo, 'checkout', '-q', '--', '.suite-gate.json')
                self.counter.unlink(missing_ok=True)
                registry = json.loads(json.dumps(self.registry))
                change(registry)
                registry['affected']['map'].append(
                    {'paths': ['src/new.py'], 'tests': ['tests/test_util.py']})
                (self.repo / '.suite-gate.json').write_text(json.dumps(registry))
                result = self.gate('affected')
                self.assertIn('.suite-gate.json: shared path .suite-gate.json', result.stderr)
                self.assertGreaterEqual(len(self.full_runs()), 2)
                self.assertEqual(self.ran(), [])

    def test_dropping_the_registry_from_shared_falls_back(self):
        self.registry['affected']['shared'].remove('.suite-gate.json')
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('.suite-gate.json: no longer a shared path', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_an_added_rule_mapping_to_no_file_falls_back(self):
        self.registry['affected']['map'].append(
            {'paths': ['src/new.py'], 'tests': ['tests/gone_*.py']})
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('.suite-gate.json maps to tests that match no file', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_a_new_registry_falls_back(self):
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'rm', '-q', '.suite-gate.json')
        self.commit(self.repo, 'no registry yet')
        git(self.repo, 'checkout', '-q', 'feature')
        git(self.repo, 'merge', '-q', 'main')
        self.write_registry()
        result = self.gate('affected')
        self.assertIn('.suite-gate.json: shared path .suite-gate.json', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])


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
        merged_fp = record['fingerprint']
        release = self.gate('run', '--purpose', 'release', '--', self.full('root'))
        self.assertEqual(release.returncode, 0, release.stderr)
        self.assertIn('already passed', release.stdout)
        self.assertIn('purpose:     post-merge', release.stdout)
        self.assertEqual(self.full_runs(), ['root'])
        note = self.records()[-1]
        self.assertEqual((note['kind'], note['purpose']), ('reuse', 'release'))
        # A reader that ignores `kind` (an older gate) takes the latest record for this
        # content; the note must not hide the pass from it.
        latest = [r for r in self.records() if r.get('fingerprint') == merged_fp][-1]
        self.assertEqual((latest['purpose'], latest['reusable']), ('post-merge', True))
        self.assertNotIn('fingerprint', note)
        self.assertEqual(note['reused_fingerprint'], merged_fp)
        self.assertIn(f'REUSED pass of {latest["time"]}  fp {merged_fp[:12]}',
                      self.gate('status', '--fingerprint', merged_fp[:12]).stdout)
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


class CleanupCase(GateCase):
    """One full suite whose delay and exit code come from files outside the repo, in a
    project whose registry names a GitHub tracker (the fake `gh`)."""

    def setUp(self):
        super().setUp()
        self.registry = {'cleanup': {'github_repo': 'o/r', 'label': 'test-cleanup'}}
        self.write_registry()
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'registry')
        self.delay_file, self.code_file = self.tmp / 'delay', self.tmp / 'code'
        self.before = self.tmp / 'before.sh'  # runs first; may change the repo mid-run
        self.before.write_text('')
        self.command = (f'sh {self.before}; echo run >> {self.counter}; '
                        f'sleep $(cat {self.delay_file}); '
                        f'echo suite-out; exit $(cat {self.code_file})')

    def write_registry(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps(self.registry))

    def run_suite(self, day, delay=0, code=0, rerun=True):
        """Run the suite on day (YYYY-MM-DD); rerun makes it run even for passed content."""
        self.delay_file.write_text(str(delay))
        self.code_file.write_text(str(code))
        self.env['SUITE_GATE_TEST_TODAY'] = day
        flags = ['--rerun', 'speed sample'] if rerun else []
        result = self.gate('run', *flags, '--', self.command)
        self.assertEqual(result.returncode, code, result.stderr)
        if 'already passed' not in result.stdout:
            self.assertEqual(result.stdout, 'suite-out\n', 'the check never touches stdout')
        return result

    def unit(self):
        [unit] = self.status()['cleanup']
        return unit

    def actions(self):
        """The gh calls other than looking up the open issue."""
        return [call[:3] for call in self.gh_calls()
                if call[:2] not in (['issue', 'list'], ['issue', 'view'])]

    def set_speed(self, baseline, samples):
        """Replace the unit's baseline and later passes with exact numbers of seconds."""
        path = self.state / 'state.json'
        state = json.loads(path.read_text())
        [unit] = state['cleanup'].values()
        unit.update(baseline=baseline, baseline_source='given', samples=samples,
                    sample_count=len(samples))
        path.write_text(json.dumps(state))


class CleanupTests(CleanupCase):
    def test_the_first_run_starts_a_window_today_with_its_time_as_the_baseline(self):
        self.run_suite('2026-01-01', delay=0.1)
        unit = self.unit()
        self.assertEqual((unit['last_cleanup'], unit['rel_cwd'], unit['command']),
                         ('2026-01-01', '.', self.command))
        self.assertEqual(unit['project'], str(self.repo))
        self.assertEqual(unit['baseline_source'], 'first pass')
        self.assertGreaterEqual(unit['baseline'], 0.1)
        self.assertEqual((unit['sample_count'], unit['median'], unit['due']), (0, None, []))
        self.assertEqual(self.gh_calls(), [])
        text = self.gate('status').stdout
        self.assertIn('Test cleanup (1 suites):', text)
        self.assertIn('not due: `' + self.command, text)
        self.assertIn('Last cleanup: 2026-01-01', text)

    def test_more_than_30_days_triggers_on_any_run_even_a_failed_one(self):
        self.run_suite('2026-01-01')
        self.run_suite('2026-01-31', code=1)
        self.assertEqual(self.gh_calls(), [], 'exactly 30 days is not due')
        result = self.run_suite('2026-02-01', code=1)
        list_call, create = self.gh_calls()
        self.assertEqual(list_call, ['issue', 'list', '--state', 'open', '--label',
                                     'test-cleanup', '--json', 'number,url', '--limit', '1',
                                     '--repo', 'o/r'])
        self.assertEqual(create[:4], ['issue', 'create', '--title', f'Test cleanup: {self.repo.name}'])
        self.assertEqual(create[4:6], ['--label', 'test-cleanup'])
        self.assertEqual(create[-2:], ['--repo', 'o/r'])
        body = create[create.index('--body') + 1]
        self.assertIn('31 days since the last cleanup (2026-01-01)', body)
        self.assertIn('references/cleanup.md', body)
        self.assertIn('cleanup-done', body)
        self.assertIn('opened https://github.com/o/r/issues/7', result.stderr)
        self.assertTrue(self.unit()['due'])

    def test_a_run_whose_content_changed_is_checked_but_is_no_sample(self):
        self.before.write_text(f'echo x >> {self.repo}/app.py\n')
        self.run_suite('2026-01-01')
        self.assertTrue(self.records()[-1]['content_changed'])
        self.assertIsNone(self.unit()['baseline'], 'a run that is not reusable is no sample')
        self.run_suite('2026-03-01')
        self.assertTrue(self.records()[-1]['content_changed'])
        self.assertEqual(self.actions(), [['issue', 'create', '--title']])

    def test_a_reused_result_is_not_checked(self):
        self.run_suite('2026-01-01', rerun=False)
        result = self.run_suite('2026-03-01', rerun=False)
        self.assertEqual(self.runs(), 1)
        self.assertNotIn('cleanup', result.stderr)
        self.assertEqual(self.gh_calls(), [])
        self.run_suite('2026-03-01')
        self.assertEqual(self.actions(), [['issue', 'create', '--title']])

    def test_30_percent_slower_triggers_once_three_later_passes_exist(self):
        self.run_suite('2026-01-01', delay=0.2)
        self.run_suite('2026-01-02', code=1, delay=0.6)
        self.run_suite('2026-01-02', delay=0.4)
        self.run_suite('2026-01-02', delay=0.4)
        unit = self.unit()
        self.assertEqual((unit['sample_count'], unit['median'], unit['due']), (2, None, []),
                         'a failed run is no sample, and two samples are not judged')
        self.assertEqual(self.gh_calls(), [])
        self.run_suite('2026-01-02', delay=0.4)
        unit = self.unit()
        self.assertEqual(unit['sample_count'], 3)
        self.assertGreaterEqual(unit['median'], unit['baseline'] * 1.3)
        [reason] = unit['due']
        self.assertIn('of the latest 3 passes', reason)
        self.assertEqual(self.actions(), [['issue', 'create', '--title']])

    def test_a_median_of_exactly_130_percent_triggers_and_just_below_does_not(self):
        self.run_suite('2026-01-01')
        self.set_speed(100, [129, 129, 129])
        self.run_suite('2026-01-02', code=1)  # a failed run is checked but adds no sample
        self.assertEqual((self.unit()['median'], self.unit()['due']), (129, []))
        self.assertEqual(self.gh_calls(), [])
        self.set_speed(100, [130, 130, 130])
        self.run_suite('2026-01-02', code=1)
        [reason] = self.unit()['due']
        self.assertIn('median 130s of the latest 3 passes is 130% of the baseline 100s', reason)
        self.assertEqual(self.actions(), [['issue', 'create', '--title']])

    def test_a_single_slow_run_does_not_trigger(self):
        for delay in (0.2, 0.2, 0.8, 0.2, 0.2):
            self.run_suite('2026-01-02', delay=delay)
        unit = self.unit()
        self.assertEqual(unit['sample_count'], 4)
        self.assertLess(unit['median'], unit['baseline'] * 1.3)
        self.assertEqual(unit['due'], [])
        self.assertEqual(self.gh_calls(), [])

    def test_the_median_uses_only_the_latest_five_later_passes(self):
        for delay in (0.2, 0.6, 0.6, 0.6, 0.2, 0.2, 0.2):
            self.run_suite('2026-01-02', delay=delay)
        unit = self.unit()
        self.assertEqual((unit['sample_count'], len(unit['samples'])), (6, 5))
        self.assertEqual(unit['due'], [], 'latest five: 0.6 0.6 0.2 0.2 0.2')

    def test_cleanup_done_starts_a_new_window_without_the_old_samples(self):
        for delay in (0.2, 0.4, 0.4, 0.4):
            self.run_suite('2026-01-02', delay=delay)
        self.assertTrue(self.unit()['due'])
        self.env['SUITE_GATE_TEST_TODAY'] = '2026-01-05'
        done = self.gate('cleanup-done')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('last cleanup 2026-01-05, baseline the next passing run', done.stdout)
        unit = self.unit()
        self.assertEqual((unit['last_cleanup'], unit['baseline'], unit['samples'],
                          unit['sample_count'], unit['due']), ('2026-01-05', None, [], 0, []))
        calls = len(self.gh_calls())
        for delay in (0.4, 0.4, 0.4, 0.4):
            self.run_suite('2026-01-05', delay=delay)
        unit = self.unit()
        self.assertEqual((unit['baseline_source'], unit['sample_count'], unit['due']),
                         ('first pass', 3, []))
        self.assertEqual(len(self.gh_calls()), calls)

    def test_cleanup_done_can_set_the_baseline_and_status_shows_due(self):
        self.assertEqual(self.gate('cleanup-done', '--baseline', '0.1').returncode, 2)
        self.env['SUITE_GATE_TEST_TODAY'] = '2026-01-02'
        done = self.gate('cleanup-done', '--command', self.command, '--baseline', '0.1')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.unit()['baseline'], self.unit()['baseline_source']), (0.1, 'given'))
        for _ in range(3):
            self.run_suite('2026-01-02', delay=0.3)
        self.assertEqual(self.unit()['sample_count'], 3)
        self.assertEqual(self.actions(), [['issue', 'create', '--title']])
        text = self.gate('status').stdout
        self.assertIn('DUE: `' + self.command, text)
        self.assertIn('Baseline: 0.1s (given)', text)
        self.assertIn('of the baseline 0.1s, at least 130%', text)

    def test_cleanup_done_does_not_allow_a_second_action_the_same_day(self):
        for delay in (0.2, 0.4, 0.4, 0.4):
            self.run_suite('2026-01-02', delay=delay)
        self.assertEqual(len(self.actions()), 1)
        self.env['SUITE_GATE_TEST_TODAY'] = '2026-01-02'
        self.gate('cleanup-done', '--command', self.command, '--baseline', '0.1')
        for _ in range(3):
            result = self.run_suite('2026-01-02', delay=0.3)
        self.assertTrue(self.unit()['due'])
        self.assertIn('already updated today', result.stderr)
        self.assertEqual(len(self.actions()), 1)

    def test_a_very_short_suite_keeps_a_positive_baseline(self):
        for _ in range(4):
            result = self.run_suite('2026-01-01')
            self.assertNotIn('check skipped', result.stderr)
        unit = self.unit()
        self.assertGreater(unit['baseline'], 0)
        self.assertIsNotNone(unit['median'])
        result = self.run_suite('2026-03-01')
        self.assertNotIn('check skipped', result.stderr)
        self.assertIn('59 days since the last cleanup', self.gh_calls()[-1][-3])

    def test_an_open_cleanup_ticket_gets_a_comment_once_per_day(self):
        (self.gh_dir / 'open.json').write_text(
            json.dumps([{'number': 5, 'url': 'https://github.com/o/r/issues/5'}]))
        self.run_suite('2026-01-01')
        result = self.run_suite('2026-02-15')
        self.assertIn('commented on https://github.com/o/r/issues/5', result.stderr)
        [comment] = self.actions()
        self.assertEqual(comment, ['issue', 'comment', '5'])
        body = self.gh_calls()[-1][4]
        self.assertTrue(body.startswith('Updated numbers'), body)
        self.assertIn('45 days since the last cleanup', body)
        again = self.run_suite('2026-02-15')
        self.assertIn('already updated today', again.stderr)
        self.assertEqual(len(self.actions()), 1)
        self.run_suite('2026-02-16')
        self.assertEqual(len(self.actions()), 2)

    def test_the_opened_issue_gets_the_next_comment_even_before_the_label_list_shows_it(self):
        self.run_suite('2026-01-01')
        self.run_suite('2026-02-01')
        self.assertEqual(self.actions(), [['issue', 'create', '--title']])
        result = self.run_suite('2026-02-02')  # the label list still returns []
        self.assertIn('commented on https://github.com/o/r/issues/7', result.stderr)
        self.assertEqual(self.gh_calls()[-2][:5], ['issue', 'view', '7', '--json', 'state,url'])
        self.assertEqual(self.actions(), [['issue', 'create', '--title'],
                                          ['issue', 'comment', '7']])

    def test_after_our_issue_is_closed_the_label_list_decides_again(self):
        self.run_suite('2026-01-01')
        self.run_suite('2026-02-01')
        (self.gh_dir / 'view.json').write_text(
            json.dumps({'state': 'CLOSED', 'url': 'https://github.com/o/r/issues/7'}))
        (self.gh_dir / 'open.json').write_text(
            json.dumps([{'number': 5, 'url': 'https://github.com/o/r/issues/5'}]))
        result = self.run_suite('2026-02-02')
        self.assertIn('commented on https://github.com/o/r/issues/5', result.stderr)
        (self.gh_dir / 'open.json').unlink()
        self.run_suite('2026-02-03')
        self.assertEqual(self.actions(), [['issue', 'create', '--title'],
                                          ['issue', 'comment', '5'],
                                          ['issue', 'create', '--title']])

    def test_a_failing_tracker_only_prints_the_ticket_and_is_retried(self):
        (self.gh_dir / 'fail').touch()
        self.run_suite('2026-01-01')
        result = self.run_suite('2026-03-01', code=3)
        self.assertIn('could not be updated (gh issue list failed: gh: HTTP 502)', result.stderr)
        self.assertIn(f'Title: Test cleanup: {self.repo.name}', result.stderr)
        self.assertIn('59 days since the last cleanup', result.stderr)
        self.assertEqual(self.records()[-1]['exit_code'], 3)
        (self.gh_dir / 'fail').unlink()
        self.run_suite('2026-03-01')
        self.assertEqual(self.actions(), [['issue', 'create', '--title']],
                         'a failed attempt does not use up the day')

    def test_without_a_tracker_the_ticket_is_printed(self):
        del self.registry['cleanup']
        self.write_registry()
        self.run_suite('2026-01-01')
        result = self.run_suite('2026-03-01')
        self.assertIn('registry names no tracker', result.stderr)
        self.assertIn('59 days since the last cleanup', result.stderr)
        self.assertEqual(self.gh_calls(), [])

    def test_worktrees_of_one_project_share_a_unit(self):
        self.run_suite('2026-01-01')
        other = self.tmp / 'wt'
        git(self.repo, 'worktree', 'add', '-q', '--detach', str(other))
        self.env['SUITE_GATE_TEST_TODAY'] = '2026-01-02'
        self.code_file.write_text('0')
        self.delay_file.write_text('0')
        result = self.gate('run', '--rerun', 'other tree', '--', self.command, cwd=other)
        self.assertEqual(result.returncode, 0, result.stderr)
        unit = self.unit()
        self.assertEqual((unit['project'], unit['sample_count']), (str(self.repo), 1))


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

    def listed(self, check, processes):
        # Exercise the documented shell filters on a private process table. Host-wide
        # pgrep/ps output races with unrelated agents starting and stopping gates.
        fake_bin = self.tmp / 'process-bin'
        fake_bin.mkdir(exist_ok=True)
        commands = {
            'pgrep': 'printf "%s\\n" "$CUTOVER_PGREP" | grep -E -- "$2"',
            'ps': 'printf "%s\\n" "$CUTOVER_PS"',
            'date': 'printf "1000\\n"',
        }
        for name, body in commands.items():
            path = fake_bin / name
            path.write_text('#!/bin/sh\n' + body + '\n')
            path.chmod(0o755)
        env = dict(self.env, PATH=f'{fake_bin}:{self.env["PATH"]}',
                   CUTOVER_PGREP='\n'.join(f'{pid} {args}' for pid, age, args in processes),
                   CUTOVER_PS='\n'.join(f'{pid} {age} {args}' for pid, age, args in processes))
        result = subprocess.run(['bash', '-c', check], capture_output=True, text=True,
                                timeout=30, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return {int(line.split()[0]) for line in result.stdout.splitlines()}

    def test_the_checks_list_old_runs_still_fingerprinting_and_old_statuses_still_running(self):
        # run need not have registered in gate state yet; status is also a writer in
        # the old version. Installation at t=990 must include that exact second.
        processes = [
            (101, 30, 'python /old/suite-gate.py run -- true'),
            (102, 20, 'python /old/suite-gate.py status'),
            (103, 10, 'python /old/suite-gate.py status'),
            (104, 2, 'python /new/suite-gate.py status'),
            (105, 40, 'python unrelated.py'),
            (106, 40, "pgrep -af 'suite-gate\\.py'"),
            (107, 40, 'python suite-gateXpy status'),
        ]
        self.assertEqual(self.listed(self.documented('pgrep '), processes), {101, 102, 103, 104})
        self.assertEqual(self.listed('installed=990; ' + self.documented('ps -eo '), processes),
                         {101, 102, 103})


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

    def test_suites_in_data_text_do_not_run_but_the_same_text_run_by_a_shell_does(self):
        """Pairs: the text of a message, comment, echo or file heredoc is not run; the same
        text after a command separator, in `sh -c` or in a heredoc fed to a shell is."""
        registry = {'suites': ['*bun run test:all', '*bun run test:all *', '*bun test ./tests']}
        pairs = [
            ("hcom send @x --intent inform -- 'ran bun run test:all via the gate'",
             "sh -c 'bun run test:all'"),
            ("gh issue comment 5 --body 'bun run test:all passed'",
             "bash -lc 'echo hi; bun run test:all'"),
            ('gh pr create --title t --body "run bun test ./tests"',
             'gh pr create --title t --body x && bun test ./tests'),
            ('echo bun run test:all', 'echo start; bun run test:all'),
            ("printf '%s\\n' 'bun run test:all'", "printf 'x' | bun run test:all"),
            ('cat > notes.md <<EOF\nbun run test:all\nEOF',
             'bash <<EOF\nbun run test:all\nEOF'),
            ("cat > notes.md <<'EOF'\nit's bun run test:all\nEOF\ngit status",
             "bash -s <<'EOF'\ncd board && bun test ./tests\nEOF"),
            ('hcom send @x --file - <<EOF\nbun test ./tests\nEOF',
             'timeout 600 sh <<EOF\nbun test ./tests\nEOF'),
            ('cat <<-EOF > f\n\tbun run test:all\n\tEOF\necho done',
             'cat <<-EOF > f\n\tnotes\n\tEOF\nbun run test:all'),
            ('cat <<EOF | tee f\nbun run test:all\nEOF', 'cat <<EOF | bash\nbun run test:all\nEOF'),
            ("echo 'bun run test:all' | tee f", "echo 'bun run test:all' | sh"),
            ("cat > f <<'EOF'\n$(bun run test:all)\nEOF", 'cat > f <<EOF\nout: $(bun run test:all)\nEOF'),
            ('cat > f <<"EOF"\n`bun test ./tests`\nEOF', 'cat > f <<EOF\n`bun test ./tests`\nEOF'),
            ('cat /dev/stdin <<EOF\nbun test ./tests\nEOF', 'bash /dev/stdin <<EOF\nbun test ./tests\nEOF'),
            ("rg 'bun run test:all' README.md", "sh -c 'rg x README.md; bun run test:all'"),
            ("git commit -m 'run bun run test:all in CI'", "git commit -m x && bun run test:all"),
            ("printf '%s\\n' 'bun run test:all' > f", "printf '%s\\n' 'bun run test:all' | sh"),
            ("echo -e 'bun run test:all' >> f", "echo -e 'bun run test:all' | bash"),
            ('wc -c <<EOF | sh\nbun run test:all\nEOF', 'cat <<EOF | cat | sh\nbun run test:all\nEOF'),
            ('bash <<A <<B\nbun run test:all\nA\necho safe\nB',
             'bash <<A <<B\necho safe\nA\nbun run test:all\nB'),
            ('bash 3<<EOF\nbun run test:all\nEOF', 'bash 0<<EOF\nbun run test:all\nEOF'),
            ("printf '%s %s\\n' bun test > f", "printf '%s %s:%s\\n' 'bun run' test all | bash"),
            ("cat > f <<'EOF'\n$(printf ')'; bun run test:all)\nEOF",
             "cat > f <<EOF\n$(printf ')'; bun run test:all)\nEOF"),
            ('bash <<EOF </dev/null\nbun run test:all\nEOF', 'bash </dev/null <<EOF\nbun run test:all\nEOF'),
        ]
        for data, run in pairs:
            self.assertFalse(gate.is_full_suite(data, registry=registry), data)
            self.assertTrue(gate.is_full_suite(run, registry=registry), run)
        # A pattern that names the text command itself still counts it.
        self.assertTrue(gate.is_full_suite('echo smoke', registry={'suites': ['echo smoke']}))
        self.assertFalse(gate.is_full_suite('cat > f <<EOF\npytest\nEOF', registry={}))
        self.assertTrue(gate.is_full_suite('bash <<EOF\npytest\nEOF', registry={}))

    def test_registry_is_read_from_the_repo_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, 'init', '-q')
            (repo / 'sub').mkdir()
            self.assertTrue(gate.is_full_suite('pytest', repo / 'sub'))
            (repo / '.suite-gate.json').write_text(json.dumps({'suites': ['make  check']}))
            self.assertFalse(gate.is_full_suite('pytest', repo / 'sub'))
            self.assertTrue(gate.is_full_suite('make check', repo / 'sub'))



def run_hook(command, cwd, env=None, hook_cwd=None):
    payload = json.dumps({'hook_event_name': 'PreToolUse', 'tool_name': 'Bash',
                          'tool_input': {'command': command}, 'cwd': str(cwd)})
    return subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=payload, text=True,
                          capture_output=True, env=env, timeout=60, cwd=hook_cwd)


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

    def test_registry_suites_in_data_text_pass_and_the_same_text_run_by_a_shell_is_blocked(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': ['*bun run test:all']}))
        g = gate.gate_command
        for text in ("hcom send @x --intent inform -- 'next: bun run test:all'",
                     "gh pr comment 3 --comment 'bun run test:all passed'",
                     'cat > notes.md <<EOF\nbun run test:all\nEOF'):
            with self.subTest(text=text):
                result = run_hook(text, self.repo, self.env)
                self.assertEqual((result.returncode, result.stderr), (0, ''))
        cases = {
            "sh -c 'bun run test:all'": 'sh -c ' + gate.shlex.quote(g('bun run test:all')),
            'bash <<EOF\nbun run test:all\nEOF': 'bash <<EOF\n' + g('bun run test:all') + '\nEOF',
            'cat > f <<EOF\nbun run test:all\nEOF\nbun run test:all':
                'cat > f <<EOF\nbun run test:all\nEOF\n' + g('bun run test:all'),
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                result = run_hook(text, self.repo, self.env)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertEqual(rewrite_of(result.stderr), expected)

    def test_gate_calls_by_path_or_a_variable_assigned_in_the_same_command_pass(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': ['*bun run test:all']}))
        rel = os.path.relpath(SCRIPT, self.repo)
        for text in (f'uv run --no-project python {rel} run -- bun run test:all',
                     f'G={SCRIPT}; uv run --no-project python "$G" run -- bun run test:all',
                     f'G={SCRIPT}\n${{G}} run --rerun flaky -- bun run test:all',
                     f'cd sub && G={rel} && python3 $G run -- bun run test:all | tail'):
            with self.subTest(text=text):
                result = run_hook(text, self.repo, self.env)
                self.assertEqual((result.returncode, result.stderr), (0, ''))

    def test_gate_calls_through_other_variables_are_blocked_and_told_to_use_the_full_path(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': ['*bun run test:all']}))
        for text in ('uv run --no-project python "$GATE" run -- bun run test:all',
                     'G=/tmp/other.py; python "$G" run -- bun run test:all',
                     f'(G={SCRIPT}); python "$G" run -- bun run test:all',
                     f'G={SCRIPT} | true; python "$G" run -- bun run test:all',
                     f'true | G={SCRIPT}; python "$G" run -- bun run test:all',
                     f'python "$G" run -- bun run test:all; G={SCRIPT}'):
            with self.subTest(text=text):
                result = run_hook(text, self.repo, self.env)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('full path', result.stderr)
        result = run_hook(f'G={SCRIPT}; python "$G" run -- bun run test:all && bun run test:all',
                          self.repo, self.env)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(rewrite_of(result.stderr),
                         f'G={SCRIPT}; python "$G" run -- bun run test:all && '
                         + gate.gate_command('bun run test:all'))
        self.assertNotIn('full path', result.stderr)

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
        # A payload cwd that does not exist falls back to the hook's own directory (here one with
        # no registry, so the default rules apply whatever repo the tests run from).
        self.assertEqual(run_hook('pytest', self.tmp / 'gone', self.env, hook_cwd=self.tmp).returncode, 2)


def cli(*args):
    """A gate command line as the gate prints it, built here rather than by the gate."""
    return shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), *args])


AFFECTED = cli('affected')
WHY = ('--reason', '<why the full suite is needed>')
BEGIN, END = '# >>> suite-gate pre-push >>>\n', '# <<< suite-gate pre-push <<<\n'


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
        a, q = AFFECTED, shlex.quote
        cases = {
            'pytest': (a, cli('run', *WHY, '--', 'pytest')),
            'cd web && bun test 2>&1 | tail -30':
                (f'cd web && {a} 2>&1 | tail -30',
                 f"cd web && {cli('run', *WHY, '--', 'bun test')} 2>&1 | tail -30"),
            "bash -lc 'pytest -q' | tail":
                (f'bash -lc {q(a)} | tail',
                 f"bash -lc {q(cli('run', *WHY, '--', 'pytest -q'))} | tail"),
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
                result = run_hook(cli('run', *flags, '--', self.full('root')), self.repo,
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
                         f"cd web && {cli('run', '--', 'bun test')} 2>&1 | tail -30")
        self.assertNotIn(AFFECTED, result.stderr)


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

    def test_a_symlinked_suite_directory_matches_the_gate(self):
        (self.repo / 'web-alias').symlink_to('web')
        self.registry['full_suites'] = [{'command': self.full('web'), 'cwd': 'web-alias'}]
        self.write_registry()
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-qm', 'alias')
        self.fill(self.push('HEAD:refs/tags/a1'))
        self.assertEqual(self.push('HEAD:refs/tags/a1').returncode, 0)

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
        return sorted(self.hook.parent.glob('pre-push.suite-gate-backup-*'))

    def test_preview_install_and_uninstall_of_a_new_hook(self):
        preview = self.install('--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn('+' + BEGIN, preview.stdout)
        self.assertFalse(self.hook.exists())
        self.assertEqual(self.install().returncode, 0)
        text = self.hook.read_text()
        self.assertTrue(text.startswith('#!/bin/sh\n' + BEGIN) and text.endswith(END), text)
        self.assertIn(cli('pre-push'), text)
        self.assertTrue(os.access(self.hook, os.X_OK))
        self.assertEqual(self.push('feature').returncode, 0)
        self.assertIn('push refused', self.push('main').stderr)
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
        self.assertTrue(text.startswith('#!/bin/sh\n' + BEGIN), text)
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
        for out in (result.stdout, self.install('--preview').stdout, self.install().stdout):
            self.assertIn(f'Installed but NOT active: core.hooksPath={shared}', out)
            self.assertIn('exec "$local_hook" "$@"', out)
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
        for marks in ((BEGIN, BEGIN, END), (BEGIN, END, END), (END, BEGIN), (BEGIN,)):
            broken = '#!/bin/sh\n' + 'echo keep\n'.join(marks) + 'exit 0\n'
            self.hook.write_text(broken)
            self.hook.chmod(0o755)
            for action in ('install-pre-push', 'uninstall-pre-push'):
                with self.subTest(marks=marks, action=action):
                    self.assertEqual(self.gate(action, '--repo', str(self.repo)).returncode, 1)
                    self.assertEqual(self.hook.read_text(), broken)

    def test_an_existing_shebang_only_hook_survives_uninstall(self):
        self.hook.write_text('#!/bin/sh\n')
        self.hook.chmod(0o755)
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.gate('uninstall-pre-push', '--repo', str(self.repo)).returncode, 0)
        self.assertEqual(self.hook.read_text(), '#!/bin/sh\n')


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
