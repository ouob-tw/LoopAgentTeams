"""The gate reruns the failed test files once, through the CLI. Outputs come from this host:
bun and pytest are fakes that print output captured from real runs (fixtures/rerun), and
unittest runs for real."""
import json
import shlex
import sys
import unittest
from pathlib import Path

# Run by file path (the affected template) as well as by discover.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GateCase, git

FIXTURES = Path(__file__).resolve().parent / 'fixtures/rerun'
PY = shlex.quote(sys.executable)


class RerunCase(GateCase):
    """A mapped project with fake bun and pytest on PATH. Each fake call takes the next step
    of plan/<tool>.json: print the fixture `out` (bun to stderr, pytest to stdout; its
    capture directory read as the current one), touch
    `touch` if given, exit `code`. `bun run <script> [-- args]` runs the package.json script
    with the arguments appended, as bun does."""

    def setUp(self):
        super().setUp()
        self.plans = self.tmp / 'plan'
        self.plans.mkdir()
        fake_bin = self.tmp / 'tools'
        fake_bin.mkdir()
        for tool in ('bun', 'pytest'):
            path = fake_bin / tool
            path.write_text(f"""#!{sys.executable}
import json, os, shlex, subprocess, sys
from pathlib import Path
if {tool!r} == 'bun' and sys.argv[1:2] == ['run']:
    script = json.loads(Path('package.json').read_text())['scripts'][sys.argv[2]]
    extra = sys.argv[3:][1:] if sys.argv[3:4] == ['--'] else sys.argv[3:]
    sys.exit(subprocess.run(['/bin/sh', '-c', ' '.join([script, *map(shlex.quote, extra)])]
                            ).returncode)
plans = Path({str(self.plans)!r})
with open(plans / 'calls.jsonl', 'a') as log:
    log.write(json.dumps([{tool!r}, os.getcwd(), sys.argv[1:]]) + '\\n')
plan = json.loads((plans / {tool!r}).with_suffix('.json').read_text())
step = plan.pop(0)
(plans / {tool!r}).with_suffix('.json').write_text(json.dumps(plan))
out = sys.stderr if {tool!r} == 'bun' else sys.stdout
# The fixtures name the directory they were captured in as /home/user/project.
out.write((Path({str(FIXTURES)!r}) / step['out']).read_text().replace(
    '/home/user/project', os.getcwd()))
if step.get('touch'):
    Path(step['touch']).write_text('changed by the test\\n')
sys.exit(step['code'])
""")
            path.chmod(0o755)
        self.env['PATH'] = f"{fake_bin}:{self.env['PATH']}"
        self.env['PYTHONDONTWRITEBYTECODE'] = '1'
        self.commands = {}

    def project(self, commands, files=(), mapped=True):
        """Commit files ({path: text} or paths) and a registry whose affected.commands are
        commands; without mapped there is no affected-test map."""
        files = files if isinstance(files, dict) else dict.fromkeys(files, '')
        for name, text in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        registry = {'full_suites': [{'command': 'true', 'cwd': '.'}]}
        if mapped:
            registry['affected'] = {'commands': commands,
                                    'map': [{'paths': ['src/**'], 'tests': ['**/test_*.py']}]}
        (self.repo / '.suite-gate.json').write_text(json.dumps(registry))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'project')

    def plan(self, tool, *steps):
        """steps: (fixture, exit code) or (fixture, exit code, {'touch': path})."""
        (self.plans / f'{tool}.json').write_text(json.dumps(
            [dict(out=s[0], code=s[1], **(s[2] if len(s) > 2 else {})) for s in steps]))

    def calls(self):
        path = self.plans / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def run_suite(self, command, cwd=None):
        return self.gate('run', '--reason', 'rerun test', '--', command,
                         cwd=self.repo / cwd if cwd else None)

    def only_record(self):
        records = self.records()
        self.assertEqual(len(records), 1, records)
        return records[0]

    def assert_not_rerun(self, result, why, calls=1):
        self.assertNotEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual(record['exit_code'], result.returncode)
        self.assertIn(why, record['rerun']['skipped'])
        self.assertIn('failed tests not rerun: ', result.stderr)
        self.assertEqual(record['flaky'], [])
        self.assertEqual(len(self.calls()), calls)
        return record

    def flaky_module(self, path, cls, marker, always=False):
        """A unittest module whose one test fails the first time (or always)."""
        check = 'True' if always else 'first'
        return {path: f"""import unittest
from pathlib import Path
MARK = Path({str(self.tmp / marker)!r})
class {cls}(unittest.TestCase):
    def test_once(self):
        first = not MARK.exists()
        MARK.touch()
        self.assertFalse({check}, 'failed on purpose')
"""}

    BUN_FILES = ('web/tests/a.test.ts', 'web/tests/sub/b.test.ts', 'web/tests/c.test.ts')
    # The files of fixtures/rerun/bun-parallel-fail.txt.
    PARALLEL_FILES = ('web/tests/browser/agents-page.test.ts', 'web/tests/server/model.test.ts',
                      'web/tests/server/closed-agents.test.ts',
                      'web/tests/browser/pd-notify-throws.test.ts')


class BunRerunTests(RerunCase):
    def test_a_failure_that_passes_on_the_rerun_is_one_passing_reusable_record_with_flaky(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        result = self.run_suite('bun test ./tests', cwd='web')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual(record['exit_code'], 0)
        self.assertTrue(record['reusable'])
        self.assertEqual(record['flaky'], [
            {'file': 'web/tests/a.test.ts', 'tests': ['breaks']},
            {'file': 'web/tests/sub/b.test.ts', 'tests': ['group > inner fails']}])
        rerun = record['rerun']
        self.assertEqual((rerun['first_exit_code'], rerun['exit_code']), (1, 0))
        self.assertEqual([(r['dir'], r['command'], r['exit_code']) for r in rerun['runs']],
                         [('web', 'bun test tests/a.test.ts tests/sub/b.test.ts', 0)])
        self.assertIsInstance(rerun['duration_s'], float)
        self.assertEqual([c[1:] for c in self.calls()][1],
                         [str(self.repo / 'web'), ['test', 'tests/a.test.ts', 'tests/sub/b.test.ts']])
        status = self.gate('status').stdout
        self.assertIn('failed tests rerun once (first run exit 1): exit 0', status)
        self.assertIn('web/tests/a.test.ts: breaks', status)
        self.assertIn('Flaky tests in these records (failed first, passed on the rerun): 2', status)
        self.assertEqual(self.run_suite('bun test ./tests', cwd='web').returncode, 0)
        self.assertEqual(len(self.calls()), 2, 'the rerun pass is reused')

    def test_a_failure_that_fails_again_is_recorded_as_a_failure(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        self.plan('bun', ('bun-fail.txt', 1), ('bun-fail.txt', 1))
        result = self.run_suite('bun test ./tests', cwd='web')
        self.assertEqual(result.returncode, 1)
        record = self.only_record()
        self.assertEqual((record['exit_code'], record['reusable'], record['flaky']), (1, False, []))
        self.assertEqual(record['rerun']['exit_code'], 1)
        self.assertIn('the rerun failed too', result.stderr)

    def test_a_parallel_run_reruns_its_failed_file_once_despite_the_closing_failed_list(self):
        # Trimmed from a real `bun test --parallel=6` run: the closing `1 tests failed:`
        # list repeats the failure after another file's header.
        self.project({'web': 'bun test {tests}'}, self.PARALLEL_FILES)
        self.plan('bun', ('bun-parallel-fail.txt', 1), ('bun-pass.txt', 0))
        result = self.run_suite('bun test ./tests', cwd='web')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual(record['flaky'], [{
            'file': 'web/tests/browser/pd-notify-throws.test.ts',
            'tests': ['a throwing Notification constructor does not break the page; '
                      'the new request still opens the panel']}])
        self.assertEqual(self.calls()[1][2], ['test', 'tests/browser/pd-notify-throws.test.ts'])

    def test_affected_tests_rerun_their_failed_files_too(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        reg = json.loads((self.repo / '.suite-gate.json').read_text())
        reg['affected']['map'] = [{'paths': ['web/src/**'], 'tests': ['web/tests/**']}]
        (self.repo / '.suite-gate.json').write_text(json.dumps(reg))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'map web')
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'web/src').mkdir()
        (self.repo / 'web/src/page.ts').write_text('changed\n')
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        result = self.gate('affected', '--base', 'main')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual((record['kind'], record['exit_code']), ('affected', 0))
        self.assertEqual(len(record['flaky']), 2)

    BOARD_TEMPLATE = ("if printf '%s\\n' {tests} | grep -qv '^tests/unit/'; then bun run build:test "
                      "|| exit; fi; bun test --timeout 30000 $(printf './%s\\n' {tests})")

    def board_affected(self, build):
        """Run affected in a project shaped like the board: the template builds first (a
        package.json script that runs build), then runs the selected files."""
        self.project({'web': self.BOARD_TEMPLATE}, dict.fromkeys(self.BUN_FILES, '') | {
            'web/package.json': json.dumps({'scripts': {'build:test': build}})})
        reg = json.loads((self.repo / '.suite-gate.json').read_text())
        reg['affected']['map'] = [{'paths': ['web/src/**'], 'tests': ['web/tests/**']}]
        (self.repo / '.suite-gate.json').write_text(json.dumps(reg))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'map web')
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'web/src').mkdir()
        (self.repo / 'web/src/page.ts').write_text('changed\n')
        return self.gate('affected', '--base', 'main')

    def test_a_board_style_affected_template_reruns_its_flaky_files(self):
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        result = self.board_affected('LAT_BOARD_BUILD_DIR=${LAT_BOARD_BUILD_DIR:-build-test} true')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual((record['kind'], record['exit_code']), ('affected', 0))
        self.assertEqual([f['file'] for f in record['flaky']],
                         ['web/tests/a.test.ts', 'web/tests/sub/b.test.ts'])
        self.assertEqual(self.calls()[1][2][-2:], ['./tests/a.test.ts', './tests/sub/b.test.ts'])

    def test_a_board_style_affected_template_whose_build_fails_is_not_rerun(self):
        self.assert_not_rerun(self.board_affected('false'), 'no complete bun test summary line',
                              calls=0)

    def test_a_test_script_chained_before_the_tests_needs_its_own_summary(self):
        self.project({'web': 'bun test {tests}'}, dict.fromkeys(self.BUN_FILES, '') | {
            'web/package.json': json.dumps({'scripts': {
                'test:all': 'bun run smoke && bun test ./tests', 'smoke': 'bun test ./smoke'}})})
        self.plan('bun', ('bun-fail.txt', 1))
        self.assert_not_rerun(self.run_suite('bun run test:all', cwd='web'),
                              'no complete bun test summary line')

    def test_a_script_chained_before_the_tests_that_hides_its_runner_is_not_rerun(self):
        scripts = {'test:all': 'bun run smoke && bun test ./tests', 'inner': 'bun test ./smoke'}
        for smoke in ('sh smoke.sh', 'uv run --no-project bun run inner', 'RUNNER=bun $RUNNER',
                      'echo "$(bun test ./smoke)"; false'):
            with self.subTest(smoke=smoke):
                self.forget_runs()
                self.project({'web': 'bun test {tests}'}, dict.fromkeys(self.BUN_FILES, '') | {
                    'web/smoke.sh': 'bun test ./smoke\n', 'web/package.json': json.dumps(
                        {'scripts': scripts | {'smoke': smoke}})})
                self.plan('bun', ('bun-fail.txt', 1))
                self.assert_not_rerun(self.run_suite('bun run test:all', cwd='web'),
                                      'may run tests the gate cannot list')

    def forget_runs(self):
        """Forget earlier records and fake calls, for one more case in the same test."""
        for path in (self.state / 'ledger.jsonl', self.plans / 'calls.jsonl'):
            path.unlink(missing_ok=True)

    def test_output_without_a_summary_line_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'}, ['web/tests/f1.test.ts'])
        self.plan('bun', ('bun-killed.txt', 124))
        self.assert_not_rerun(self.run_suite('bun test ./tests', cwd='web'),
                              'no complete bun test summary line')

    def test_a_bail_option_in_a_package_json_script_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'}, dict.fromkeys(self.BUN_FILES, '') | {
            'web/package.json': json.dumps({'scripts': {'test:all': 'bun test --bail ./tests'}})})
        self.plan('bun', ('bun-fail.txt', 1))
        self.assert_not_rerun(self.run_suite('bun run test:all', cwd='web'),
                              'bun test is set to stop at the first failure')

    def test_a_file_that_fails_to_load_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'}, ['web/tests/a.test.ts', 'web/tests/d.test.ts'])
        self.plan('bun', ('bun-load-error.txt', 1))
        self.assert_not_rerun(self.run_suite('bun test ./tests', cwd='web'),
                              'bun test reported an error outside a test')

    def test_a_failed_build_step_of_the_suite_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'}, dict.fromkeys(self.BUN_FILES, '') | {
            'web/package.json': json.dumps({'scripts': {
                'test:all': 'bun run build:test && bun test ./tests',
                'build:test': 'false'}})})
        self.assert_not_rerun(self.run_suite('bun run test:all', cwd='web'),
                              'no complete bun test summary line', calls=0)

    def test_a_build_chained_before_the_tests_still_lets_them_rerun(self):
        self.project({'web': 'bun test {tests}'}, dict.fromkeys(self.BUN_FILES, '') | {
            'web/package.json': json.dumps({'scripts': {
                'test:all': 'bun run build:test && bun test ./tests', 'build:test': 'true'}})})
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        result = self.run_suite('bun run test:all', cwd='web')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.only_record()['flaky']), 2)

    def test_a_step_after_the_tests_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        self.plan('bun', ('bun-fail.txt', 1))
        self.assert_not_rerun(self.run_suite('bun test ./tests; exit 7', cwd='web'),
                              'the rerun trusts only a single test command')

    def test_a_step_before_the_tests_whose_failure_does_not_stop_them_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        self.plan('bun', ('bun-fail.txt', 1))
        self.assert_not_rerun(self.run_suite('false; bun test ./tests', cwd='web'),
                              'the rerun trusts only a single test command')

    def test_a_command_that_changes_directory_is_not_rerun(self):
        self.project({'web': 'bun test {tests}'},
                     self.BUN_FILES + ('tests/a.test.ts', 'tests/sub/b.test.ts'))
        self.plan('bun', ('bun-fail.txt', 1))
        for command in ('cd web && bun test ./tests', 'env -C web bun test ./tests',
                        'env --chdir=web bun test ./tests', 'command cd web && bun test ./tests',
                        'MARK=1 cd web && bun test ./tests', 'bun test --cwd=web ./tests'):
            with self.subTest(command=command):
                self.assert_not_rerun(self.run_suite(command), 'the rerun trusts')
                self.plan('bun', ('bun-fail.txt', 1))
                (self.state / 'ledger.jsonl').unlink()
                (self.plans / 'calls.jsonl').unlink(missing_ok=True)

    def test_more_than_ten_failed_files_are_not_rerun(self):
        self.project({'web': 'bun test {tests}'},
                     [f'web/tests/f{i}.test.ts' for i in range(1, 12)])
        self.plan('bun', ('bun-11-files.txt', 1))
        self.assert_not_rerun(self.run_suite('bun test ./tests', cwd='web'),
                              '11 test files failed, more than 10')

    def test_a_project_without_an_affected_map_is_not_rerun(self):
        self.project({}, self.BUN_FILES, mapped=False)
        self.plan('bun', ('bun-fail.txt', 1))
        self.assert_not_rerun(self.gate('run', '--', 'bun test ./tests', cwd=self.repo / 'web'),
                              'no affected-test map')

    def test_content_changed_during_the_rerun_is_not_reusable(self):
        self.project({'web': 'bun test {tests}'}, self.BUN_FILES)
        self.plan('bun', ('bun-fail.txt', 1),
                  ('bun-pass.txt', 0, {'touch': str(self.repo / 'web/tests/c.test.ts')}))
        result = self.run_suite('bun test ./tests', cwd='web')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual((record['exit_code'], record['content_changed'], record['reusable']),
                         (0, True, False))
        self.assertIn('content changed during the run', result.stderr)


class PytestRerunTests(RerunCase):
    PY_FILES = ('tests/test_alpha.py', 'tests/sub/test_gamma.py', 'tests/test_classerr.py',
                'tests/test_beta.py')

    def test_failed_pytest_files_rerun_from_the_short_summary(self):
        self.project({'.': 'pytest {tests}'}, self.PY_FILES)
        self.plan('pytest', ('pytest-fail.txt', 1), ('pytest-pass.txt', 0))
        result = self.run_suite('pytest tests')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual(record['rerun']['runs'][0]['command'],
                         'pytest tests/sub/test_gamma.py tests/test_alpha.py '
                         'tests/test_classerr.py')
        self.assertEqual(record['flaky'][1], {'file': 'tests/test_alpha.py', 'tests': [
            'AlphaTests::test_bad', 'AlphaTests::test_err', 'AlphaTests::test_sub']})

    def test_a_collection_error_is_not_rerun(self):
        self.project({'.': 'pytest {tests}'}, self.PY_FILES + ('tests/test_broken.py',))
        self.plan('pytest', ('pytest-collect.txt', 2))
        self.assert_not_rerun(self.run_suite('pytest tests'), 'pytest could not collect')

    def test_exitfirst_is_not_rerun(self):
        self.project({'.': 'pytest {tests}'}, self.PY_FILES)
        self.plan('pytest', ('pytest-x.txt', 1))
        self.assert_not_rerun(self.run_suite('pytest -x tests'),
                              'pytest is set to stop at the first failure')


class UnittestRerunTests(RerunCase):
    def two_packages(self, always=False):
        files = {'pkg_a/__init__.py': '', 'pkg_b/__init__.py': ''}
        files |= self.flaky_module('pkg_a/test_one.py', 'OneTests', 'mark-a', always)
        files |= self.flaky_module('pkg_b/test_two.py', 'TwoTests', 'mark-b', always)
        return files

    def test_failed_files_in_two_template_directories_rerun_each_with_its_own(self):
        self.project({'pkg_a': f'{PY} -m unittest {{tests}}',
                      'pkg_b': f'{PY} -m unittest -v {{tests}}'}, self.two_packages())
        result = self.run_suite(f'{PY} -m unittest discover -s .')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual([(r['dir'], r['command'], r['exit_code'])
                          for r in record['rerun']['runs']],
                         [('pkg_a', f'{PY} -m unittest test_one.py', 0),
                          ('pkg_b', f'{PY} -m unittest -v test_two.py', 0)])
        self.assertEqual(record['flaky'], [{'file': 'pkg_a/test_one.py', 'tests': ['test_once']},
                                           {'file': 'pkg_b/test_two.py', 'tests': ['test_once']}])

    def test_unittest_through_uv_run_reruns(self):
        self.project({'.': f'{PY} -m unittest {{tests}}'}, self.two_packages())
        result = self.run_suite(f'uv run --no-project {PY} -m unittest discover -s .')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.only_record()['flaky']), 2)

    def test_unittest_failures_that_fail_again_are_a_failure(self):
        self.project({'.': f'{PY} -m unittest {{tests}}'}, self.two_packages(always=True))
        result = self.run_suite(f'{PY} -m unittest discover -s .')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.only_record()['rerun']['runs'][0]['command'],
                         f'{PY} -m unittest pkg_a/test_one.py pkg_b/test_two.py')

    def test_a_failed_file_no_template_directory_holds_is_not_rerun(self):
        self.project({'pkg_a': f'{PY} -m unittest {{tests}}'}, self.two_packages())
        self.assert_not_rerun(self.run_suite(f'{PY} -m unittest discover -s .'),
                              'no affected.commands directory holds pkg_b/test_two.py', calls=0)

    def test_failfast_with_a_normal_summary_line_is_not_rerun(self):
        self.project({'.': f'{PY} -m unittest {{tests}}'}, self.two_packages())
        result = self.run_suite(f'{PY} -m unittest discover -f -s .')
        self.assertIn('Ran 1 test in', result.stderr)
        self.assert_not_rerun(result, 'unittest is set to stop at the first failure', calls=0)

    def test_failfast_forwarded_to_a_package_json_script_is_not_rerun(self):
        files = self.two_packages() | {'package.json': json.dumps(
            {'scripts': {'test:all': f'{PY} -m unittest discover -s .'}})}
        self.project({'.': f'{PY} -m unittest {{tests}}'}, files)
        result = self.run_suite('bun run test:all -- -f')
        self.assertIn('Ran 1 test in', result.stderr)
        self.assert_not_rerun(result, 'unittest is set to stop at the first failure', calls=0)

    def test_a_module_that_fails_to_load_is_not_rerun(self):
        files = self.two_packages() | {'pkg_a/test_broken.py': 'import missing_module_xyz\n'}
        self.project({'.': f'{PY} -m unittest {{tests}}'}, files)
        self.assert_not_rerun(self.run_suite(f'{PY} -m unittest discover -s .'),
                              'unittest could not load', calls=0)


if __name__ == '__main__':
    unittest.main()
