"""The floor of one full suite, the light path (`light -- <cmd>`) for test files and builds
an agent picks, and the hook that sends the registry's `heavy` commands to it."""
import json
import sys
import time
import unittest
from pathlib import Path

# Run by file path (the affected template) as well as by discover.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GIB, SCOPE_SKIP, GateCase, gate, run_hook


class LightAdmissionRuleTests(unittest.TestCase):
    """light_admission() and the light reservations in admission(), with exact numbers."""

    def config(self, **values):
        return dict(gate.DEFAULTS, **values)

    def host(self, free=16.0, mem_gb=32, brake=False, io=0.0):
        return {'cpu_free_cores': free, 'mem_available_bytes': mem_gb * GIB,
                'pressure': {'io': io, 'cpu': 0.0}, 'brake': {'on': brake},
                'unreadable': {'load': [], 'pressure': []}}

    def test_the_cap_then_the_floor_then_the_slice_limit_then_the_host(self):
        config, small = self.config(light_max_slots=3), (2, 2 * GIB)
        two = [(2, 2 * GIB), (2, 2 * GIB)]
        self.assertEqual(gate.light_admission(config, two + [(0, 0)], 6, small, self.host(), (),
                                              20), (False, 'light-path cap reached: 3/3 running'))
        awful = self.host(free=0, mem_gb=0, brake=True, io=90)
        self.assertEqual(gate.light_admission(config, [], 0, (30, GIB), awful, (), 20),
                         (True, None), 'the first light run starts whatever the host')
        self.assertEqual(gate.light_admission(config, two, 18, small, self.host(), (), 20),
                         (True, None), '18 + 2 reserved is exactly the limit')
        self.assertEqual(gate.light_admission(config, two, 18.5, small, self.host(), (), 20),
                         (False, 'light-path reservations would pass the test slice CPU '
                                 'limit: 18.5 reserved + 2 > 20 cores'))
        self.assertEqual(gate.light_admission(config, two, 4, small, self.host(brake=True,
                                                                                  io=45), (), 20),
                         (False, 'brake on: disk wait 45%, above 40%'))
        # 16 idle - 2 x 2 unused light - 11 unused of a full suite = 1 core left.
        self.assertEqual(gate.light_admission(config, two, 4, small, self.host(), [(11, 0)], 20),
                         (False, 'not enough CPU: needs 2 cores, 1 available'))

    def test_a_full_suite_past_the_floor_counts_unused_light_reservations(self):
        config, host = self.config(), self.host(free=8)
        self.assertEqual(gate.admission(config, [(0, 0)], (4, GIB), host), (True, None))
        self.assertEqual(gate.admission(config, [(0, 0)], (4, GIB), host, [(2, 0), (3, 0)]),
                         (False, 'not enough CPU: needs 4 cores, 3 available'))
        self.assertEqual(gate.admission(config, [], (4, GIB), self.host(free=0), [(9, 0)]),
                         (True, None), 'below the floor light runs do not matter')


class FloorTests(GateCase):
    """By default only the first full suite starts regardless of the host."""

    def setUp(self):
        super().setUp()
        self.without_scopes()

    def test_with_one_running_and_the_brake_on_the_second_waits_and_says_why(self):
        self.set_config(max_slots=4)
        config = json.loads(self.config.read_text())
        del config['min_slots']  # the default floor
        self.config.write_text(json.dumps(config))
        self.fake_host(io=45)
        a, release_a = self.blocker('a')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='a below the floor')
        b, release_b = self.blocker('b')
        self.wait_until(lambda: self.waiting_reason() == ['brake on: disk wait 45%, above 40%'],
                        message='b held by the brake')
        self.assertIn('1 start regardless of load, at most 4 run', self.gate('status').stdout)
        time.sleep(0.3)  # one waiting report
        self.fake_host(io=0)
        self.wait_until(lambda: len(self.status()['running']) == 2, message='b after the brake')
        release_a.touch()
        release_b.touch()
        code, _, err = self.finish(b)
        self.assertEqual((self.finish(a)[0], code), (0, 0))
        self.assertIn('ahead): brake on: disk wait 45%, above 40%', err)


class LightCase(GateCase):
    def light_status(self):
        status = self.status()
        return status['light']['running'], [w for w in status['waiting']
                                            if w.get('kind') == 'light']

    def light(self, name, cwd=None):
        """A light run that holds its slot until its release file exists."""
        release = self.tmp / f'release-{name}'
        proc = self.start('light', '--', f'while [ ! -f {release} ]; do sleep 0.05; done',
                          cwd=cwd)
        return proc, release


class LightTests(LightCase):
    def setUp(self):
        super().setUp()
        self.without_scopes()
        self.fake_host()

    def test_a_light_run_starts_while_full_suites_are_at_their_cap_and_records_nothing(self):
        self.set_config(min_slots=0, max_slots=1, light_max_slots=1)
        suite, release_suite = self.blocker('suite')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='suite running')
        first, release_first = self.light('first')
        self.wait_until(lambda: len(self.light_status()[0]) == 1, message='light running')
        second, release_second = self.light('second')
        self.wait_until(lambda: [w['reason'] for w in self.light_status()[1]] == [
            'light-path cap reached: 1/1 running'], message='second light at the light cap')
        status = self.status()
        self.assertEqual(status['light']['running'][0]['reservation'],
                         {'cpu_cores': 2.0, 'mem_bytes': 2 * GIB, 'source': 'light'})
        self.assertEqual(status['light']['cpu_budget_cores'], 20.0)
        text = self.gate('status').stdout
        self.assertIn('Light path: picked test files and builds, not recorded (1/1 light slots, '
                      'reserving 2 of 20 cores):', text)
        self.assertIn('  running  t-tester', text)
        self.assertIn('light-path cap reached: 1/1 running', text)
        release_first.touch()
        code, _, err = self.finish(first)
        self.assertEqual(code, 0, err)
        self.assertIn('light run exited 0', err)
        self.wait_until(lambda: len(self.light_status()[0]) == 1, message='second runs next')
        release_second.touch()
        release_suite.touch()
        self.assertEqual((self.finish(second)[0], self.finish(suite)[0]), (0, 0))
        self.assertEqual([r for r in self.records() if 'while' in r['command']
                          and r['cwd'] == str(self.repo)], [], 'light runs write no record')

    def test_the_exit_code_and_output_pass_through(self):
        result = self.gate('light', '--', 'echo out; echo err >&2; exit 3')
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, 'out\n')
        self.assertIn('err\n', result.stderr)

    def test_a_full_suite_is_refused(self):
        (self.repo / '.suite-gate.json').write_text(json.dumps({'suites': ['make check']}))
        result = self.gate('light', '--', 'make check')
        self.assertEqual(result.returncode, 2)
        self.assertIn('this runs a full test suite; the light path is only for', result.stderr)

    def test_a_nested_light_run_inside_a_gated_session_runs_at_once(self):
        self.set_config(light_max_slots=1)
        inner = f'{sys.executable} {gate.SCRIPT} light -- "echo inner"'
        result = self.gate('light', '--', f'{inner} && echo outer')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'inner\nouter\n')
        self.assertEqual(result.stderr.count('light run exited'), 1)
        nested = self.gate('run', '--', f'{inner}', cwd=self.tmp)
        self.assertEqual(nested.returncode, 0, nested.stderr)
        self.assertNotIn('light run exited', nested.stderr, 'inside a full suite too')

    def test_an_interrupted_light_run_frees_its_slot(self):
        proc, _ = self.light('stopped')
        self.wait_until(lambda: len(self.light_status()[0]) == 1, message='light running')
        proc.terminate()
        self.finish(proc)
        self.wait_until(lambda: self.light_status() == ([], []), message='slot freed')


@unittest.skipIf(SCOPE_SKIP, SCOPE_SKIP)
class LightScopeTests(LightCase):
    def test_a_light_run_and_a_light_call_inside_it_share_one_scope(self):
        self.env['SUITE_GATE_SLICE'] = ''
        self.set_config(light_max_slots=1)
        seen = self.tmp / 'seen'
        inner = f'{sys.executable} {gate.SCRIPT} light -- "cut -d: -f3 /proc/self/cgroup"'
        result = self.gate('light', '--', f'cut -d: -f3 /proc/self/cgroup > {seen}; '
                                          f'{inner} >> {seen}')
        self.assertEqual(result.returncode, 0, result.stderr)
        outer, nested = seen.read_text().splitlines()
        self.assertTrue(outer.endswith('.scope') and self.tmp.name in outer, outer)
        self.assertEqual(nested, outer)


class LightHookTests(LightCase):
    HEAVY = ['*bun test *tests/browser/*', '*bun run build', '*bun run build *']

    def setUp(self):
        super().setUp()
        self.without_scopes()
        self.fake_host()
        (self.repo / '.suite-gate.json').write_text(json.dumps(
            {'suites': ['*bun run test:all'], 'heavy': self.HEAVY}))

    def hook(self, command):
        return run_hook(command, self.repo, self.env)

    def test_heavy_commands_are_blocked_with_a_light_rewrite(self):
        light = gate.light_command
        cases = {
            'bun test ./tests/browser/a.test.ts': light('bun test ./tests/browser/a.test.ts'),
            'cd board && bun run build': 'cd board && ' + light('bun run build'),
            'systemd-run --user --scope -q -p MemoryMax=40G timeout 600 bun test '
            'tests/browser/b.test.ts': light('timeout 600 bun test tests/browser/b.test.ts'),
        }
        for command, rewrite in cases.items():
            with self.subTest(command=command):
                result = self.hook(command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn('Blocked: this runs a heavy command', result.stderr)
                self.assertIn(f'\n  {rewrite}\n', result.stderr)

    def test_only_a_single_command_loses_its_systemd_run(self):
        prefix = gate.light_command('x').rsplit(' ', 1)[0]
        self.assertEqual(gate.light_command('systemd-run --user --scope -p MemoryMax=1G bun '
                                            'run build'), f"{prefix} 'bun run build'")
        compound = 'systemd-run --user --scope bun run build && echo ok'
        self.assertEqual(gate.light_command(compound), f'{prefix} {gate.shlex.quote(compound)}')

    def test_other_commands_gate_calls_and_full_suites_keep_their_paths(self):
        for command in ('bun test ./tests/server/a.test.ts', "echo 'bun run build'",
                        gate.light_command('bun run build'), 'bun run build:test'):
            with self.subTest(command=command):
                self.assertEqual(self.hook(command).returncode, 0, command)
        full = self.hook('bun run test:all')
        self.assertEqual(full.returncode, 2)
        self.assertIn('outside the suite gate', full.stderr)

    def test_the_rewrite_passes_the_hook_and_runs_through_the_light_path(self):
        script = self.tmp / 'build.sh'
        script.write_text('echo built\n')
        self.env['PATH'] = f"{self.tmp / 'fake-bun'}:{self.env['PATH']}"
        (self.tmp / 'fake-bun').mkdir()
        (self.tmp / 'fake-bun/bun').write_text(f'#!/bin/sh\nexec sh {script}\n')
        (self.tmp / 'fake-bun/bun').chmod(0o755)
        blocked = self.hook('bun run build')
        rewrite = blocked.stderr.split('\n  ', 1)[1].split('\n', 1)[0]
        self.assertEqual(self.hook(rewrite).returncode, 0)
        result = self.gate('light', '--', 'bun run build')
        self.assertEqual((result.returncode, result.stdout), (0, 'built\n'), result.stderr)
        self.assertEqual(rewrite, gate.light_command('bun run build'))

    def test_a_heavy_command_inside_a_gated_session_is_not_blocked(self):
        payload = json.dumps({'tool_input': {'command': 'bun run build'},
                              'cwd': str(self.repo)}).replace("'", "'\\''")
        result = self.gate('light', '--',
                           f"echo '{payload}' | {sys.executable} {gate.SCRIPT} hook; "
                           'echo "hook exit $?"')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('hook exit 0', result.stdout)
        self.assertNotIn('Blocked', result.stderr)


if __name__ == '__main__':
    unittest.main()
