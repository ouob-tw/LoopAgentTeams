"""Every test command the gate runs has a total time limit: a hung one is stopped with
everything it started, recorded as a failure that is neither rerun nor reused, with the
test files bun's output shows had not finished. Limits here are seconds."""
import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GateCase, gate as sg, git

LIMIT_MINUTES = 0.05  # 3 seconds


class TimeoutCase(GateCase):
    """A project whose registry sets a 3 s limit, and a fake `bun` on PATH that runs the
    next step of plan.json: print `out` to stderr, then exit `code`, or with `hang` start a
    background sleep (its pid in pids) and wait forever."""

    def setUp(self):
        super().setUp()
        self.plan_file = self.tmp / 'plan.json'
        self.pids = self.tmp / 'pids'
        tools = self.tmp / 'tools'
        tools.mkdir()
        bun = tools / 'bun'
        bun.write_text(f"""#!{sys.executable}
import json, os, subprocess, sys, time
from pathlib import Path
plan = Path({str(self.plan_file)!r})
steps = json.loads(plan.read_text())
step = steps.pop(0)
plan.write_text(json.dumps(steps))
sys.stderr.write(step['out'])
sys.stderr.flush()
if step.get('hang'):
    child = subprocess.Popen(['sleep', '300'])
    with open({str(self.pids)!r}, 'a') as f:
        f.write(f'{{os.getpid()}} {{child.pid}}\\n')
    while True:
        time.sleep(1)
sys.exit(step.get('code', 0))
""")
        bun.chmod(0o755)
        self.env['PATH'] = f"{tools}:{self.env['PATH']}"

    def project(self, limit=LIMIT_MINUTES, files=('web/tests/a.test.ts', 'web/tests/b.test.ts')):
        for name in files:
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('')
        registry = {'full_suites': [{'command': 'bun test ./tests', 'cwd': 'web'}],
                    'affected': {'commands': {'web': 'bun test {tests}'},
                                 'map': [{'paths': ['web/src/**'], 'tests': ['web/tests/**']}]}}
        if limit is not None:
            registry['time_limit_minutes'] = limit
        (self.repo / '.suite-gate.json').write_text(json.dumps(registry))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'project')

    def plan(self, *steps):
        self.plan_file.write_text(json.dumps(list(steps)))

    def run_suite(self):
        return self.gate('run', '--reason', 'timeout test', '--', 'bun test ./tests',
                         cwd=self.repo / 'web')

    def affected(self):
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'web/src').mkdir()
        (self.repo / 'web/src/page.ts').write_text('changed\n')
        return self.gate('affected', '--base', 'main')

    def assert_stopped(self):
        """Every process a hung step started is gone."""
        for line in self.pids.read_text().splitlines():
            for pid in map(int, line.split()):
                self.wait_until(lambda: not _alive(pid), timeout=10,
                                message=f'pid {pid} stopped')

    def assert_timed_out(self, result, started):
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertLess(time.monotonic() - started, 30)
        self.assertIn('TIMED OUT: still running after its 3s limit (time_limit_minutes in '
                      '.suite-gate.json)', result.stderr)
        self.assert_stopped()
        record = self.records()[-1]
        self.assertEqual(record['exit_code'], 124)
        self.assertFalse(record['reusable'])
        self.assertEqual(record['timed_out']['limit_s'], 3.0)
        self.assertEqual(record['rerun'], {'skipped': 'the run timed out'})
        self.assertEqual(record['flaky'], [])
        self.assertFalse(record['rerun_only'])
        return record


def _alive(pid):
    try:
        state = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[0]
    except OSError:
        return False
    return state != 'Z'


SERIAL = 'bun test v1.3.14 (0d9b296a)\n\n'
PARALLEL = 'bun test v1.3.14 (0d9b296a) 6x PARALLEL\n\n'


class HungSuiteTests(TimeoutCase):
    def test_a_hung_serial_full_suite_is_stopped_and_names_the_running_file(self):
        self.project()
        self.plan({'out': SERIAL + 'tests/a.test.ts:\n(pass) a1 [1.00ms]\n\n'
                          'tests/b.test.ts:\n(pass) b1 [1.00ms]\n', 'hang': True})
        started = time.monotonic()
        result = self.run_suite()
        record = self.assert_timed_out(result, started)
        self.assertEqual(record['timed_out']['unfinished_files'], ['tests/b.test.ts'])
        self.assertIn('test files that had not finished (the file bun was running): '
                      'tests/b.test.ts', result.stderr)
        status = self.gate('status').stdout
        self.assertIn('FAIL exit 124 TIMED OUT after 3s', status)
        self.assertIn('not finished: tests/b.test.ts', status)
        # A timed-out run is not reused: the same content runs again.
        self.plan({'out': SERIAL + 'Ran 2 tests across 2 files. [5.00ms]\n', 'code': 0})
        self.assertEqual(self.run_suite().returncode, 0)
        self.assertEqual(json.loads(self.plan_file.read_text()), [])

    def test_bun_printing_only_failures_cannot_name_unfinished_files(self):
        self.project()
        self.plan({'out': SERIAL, 'hang': True})
        started = time.monotonic()
        result = self.run_suite()
        record = self.assert_timed_out(result, started)
        self.assertEqual(record['timed_out']['unfinished_files'], [])
        self.assertIn('bun printed only failed tests', record['timed_out']['unfinished_basis'])

    def test_a_hung_parallel_affected_run_names_the_files_with_no_result(self):
        self.project()
        self.plan({'out': PARALLEL + 'tests/a.test.ts:\n(pass) a1 [1.00ms]\n', 'hang': True})
        started = time.monotonic()
        result = self.affected()
        record = self.assert_timed_out(result, started)
        self.assertEqual(record['kind'], 'affected')
        self.assertEqual(record['timed_out']['unfinished_files'], ['tests/b.test.ts'])

    def test_a_rerun_that_hangs_is_stopped_and_the_run_fails(self):
        self.project()
        fail = (SERIAL + 'tests/a.test.ts:\n(fail) a1 [1.00ms]\n\n 0 pass\n 1 fail\n'
                'Ran 1 test across 2 files. [5.00ms]\n')
        self.plan({'out': fail, 'code': 1}, {'out': SERIAL, 'hang': True})
        started = time.monotonic()
        result = self.run_suite()
        self.assertEqual(result.returncode, 124, result.stderr)
        self.assertLess(time.monotonic() - started, 30)
        self.assert_stopped()
        record = self.records()[-1]
        self.assertEqual((record['exit_code'], record['flaky']), (124, []))
        self.assertFalse(record['reusable'])
        run = record['rerun']['runs'][0]
        self.assertEqual(run['exit_code'], 124)
        self.assertEqual(run['timed_out']['limit_s'], 3.0)
        self.assertEqual(record['timed_out']['limit_s'], 3.0)
        self.assertIn('the rerun failed too (exit 124)', result.stderr)


class TimeLimitTests(TimeoutCase):
    """time_limit() in this process, pointed at the test's repo and state."""

    def limit(self, cwd='web', command='bun test ./tests'):
        saved = os.environ.copy()
        os.environ.update(SUITE_GATE_STATE_DIR=str(self.state))
        try:
            return sg.time_limit(self.repo / cwd, command)
        finally:
            os.environ.clear()
            os.environ.update(saved)

    def baselines(self, *units):
        """units: (rel_cwd, command, baseline seconds) of the repo's project."""
        self.state.mkdir(parents=True, exist_ok=True)
        cleanup = {sg.unit_key(self.repo.resolve(), rel, command):
                   {'project': str(self.repo.resolve()), 'rel_cwd': rel, 'command': command,
                    'baseline': baseline} for rel, command, baseline in units}
        (self.state / 'state.json').write_text(json.dumps({'cleanup': cleanup}))

    def test_a_number_applies_everywhere_and_an_object_by_directory(self):
        self.project(limit=90)
        self.assertEqual(self.limit()[0], 5400)
        self.project(limit={'web/': 10, '*': 20})
        self.assertEqual(self.limit()[0], 600)
        self.assertEqual(self.limit(cwd='.')[0], 1200)

    def test_without_a_setting_the_baseline_times_four_with_a_floor(self):
        self.project(limit=None)
        self.baselines(('web', 'bun test ./tests', 1000), ('web', 'bun test ./other', 300))
        self.assertEqual(self.limit(), (4000, '4x the recorded baseline 16m40s, at least 30m00s'))
        # Another command in the directory (an affected run) adds up every suite there.
        self.assertEqual(self.limit(command='bun test tests/a.test.ts')[0], 5200)
        self.baselines(('web', 'bun test ./tests', 60))
        self.assertEqual(self.limit()[0], 1800)
        # A registered suite with no baseline of its own does not borrow its neighbours'.
        self.baselines(('web', 'bun test ./other', 300))
        self.assertEqual(self.limit()[0], 7200)

    def test_without_a_setting_or_baseline_the_default_is_two_hours(self):
        self.project(limit=None)
        self.assertEqual(self.limit()[0], 7200)

    def test_an_unusable_setting_is_ignored(self):
        self.project(limit={'web': 0})
        self.assertEqual(self.limit()[0], 7200)


if __name__ == '__main__':
    unittest.main()
