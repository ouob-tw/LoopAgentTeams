"""Every gate entry point offloads: `affected` (its tests, checks and full suites), `light`
and background full suites go to another host when this one is busy, and the project's
`local_only` marks keep a run here. `clean-remote` removes this host's old caches there.
Other hosts are directories under remotes/ reached through the fake `ssh` (see
GateCase.install_fake_ssh); no test reaches a real host or the real config."""
import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import AffectedCase, GateCase, git  # noqa: E402
from test_suite_gate_background import BackgroundCase  # noqa: E402
from test_suite_gate_remote import RemoteMixin  # noqa: E402
from test_suite_gate_rerun import RerunCase  # noqa: E402


class AffectedRemoteCase(RemoteMixin, AffectedCase):
    """The mapped project with host s3; mark() commits registry changes on the feature branch
    so the change measured from its HEAD holds only the files a test touches."""

    def setUp(self):
        super().setUp()
        self.add_host('s3')

    def mark(self, **changes):
        self.registry.update(changes)
        self.write_registry()
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'marks')

    def affected(self):
        return self.gate('affected', '--base', 'HEAD')

    def where(self):
        """{directory the affected command ran in: [tests]} from the log."""
        out = {}
        for line in self.log.read_text().splitlines() if self.log.exists() else []:
            directory, *tests = line.split()
            out[directory] = tests
        return out

    def there(self, rel='.'):
        return str(self.tree('s3') / rel) if rel != '.' else str(self.tree('s3'))

    def affected_records(self):
        return {r['rel_cwd']: r for r in self.records() if r.get('kind') == 'affected'}


class AffectedOffloadTests(AffectedRemoteCase):
    def test_affected_tests_and_checks_go_to_another_host_when_this_one_is_busy(self):
        self.mark(affected=dict(self.registry['affected'], checks=[
            {'paths': ['web/src/**'], 'cwd': 'web',
             'command': f'echo "$PWD check" >> {self.log}'}]))
        self.touch('src/app.py')
        self.touch('web/src/page.ts')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.where(), {self.there('web'): ['tests/page.test.ts'],
                                        self.there(): ['tests/test_app.py']}, result.stderr)
        self.assertIn(f"{self.there('web')} check", self.log.read_text().splitlines())
        self.assertEqual(self.full_runs(), [])
        records = [r for r in self.records() if r.get('kind') == 'affected']
        self.assertEqual(len(records), 3, records)
        self.assertEqual({r['host'] for r in records}, {'s3'})
        self.assertEqual(self.status()['remote'], [])

    def test_affected_tests_run_here_at_once_when_this_host_is_not_busy(self):
        self.touch('src/app.py')
        self.set_config(min_slots=0, max_slots=2, hosts=['s3'])
        self.fake_host(io=0.0)
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.where(), {str(self.repo): ['tests/test_app.py']})
        self.assertEqual(self.ssh_calls(), [])
        self.assertIsNone(self.affected_records()['.']['host'])

    def test_a_busy_host_with_no_usable_other_host_runs_affected_tests_here_at_once(self):
        (self.remotes / 's3/down').touch()
        self.touch('src/app.py')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.where(), {str(self.repo): ['tests/test_app.py']})
        self.assertIn('no other host is usable, so it runs here at once: not on s3: cannot '
                      'reach it over ssh', result.stderr)

    def test_a_full_suite_affected_falls_back_to_queues_and_goes_to_another_host(self):
        self.touch('deps.lock')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('runs on s3 instead', result.stderr)
        self.assertEqual(sorted(self.full_runs()), ['root', 'web'])
        fallback = [r for r in self.records() if r.get('purpose') == 'map-fallback']
        self.assertEqual([r['host'] for r in fallback], ['s3', 's3'])
        self.assertTrue(all(r['reusable'] for r in fallback))


class LocalOnlyTests(AffectedRemoteCase):
    def test_a_test_picked_from_a_marked_suite_stays_here(self):
        suites = [dict(s) for s in self.registry['full_suites']]
        suites[1]['local_only'] = True  # web
        self.mark(full_suites=suites)
        self.touch('src/app.py')
        self.touch('web/src/page.ts')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.where(), {str(self.repo / 'web'): ['tests/page.test.ts'],
                                        self.there(): ['tests/test_app.py']})
        self.assertIn('not on s3: it stays on this host: it runs web/tests/page.test.ts, in the '
                      'directory of a full suite marked local_only in .suite-gate.json',
                      result.stderr)
        self.assertEqual({k: r['host'] for k, r in self.affected_records().items()},
                         {'.': 's3', 'web': None})

    def test_a_marked_suite_and_a_suite_holding_a_marked_path_stay_here(self):
        for marks in ({'full_suites': [dict(self.registry['full_suites'][0]),
                                       dict(self.registry['full_suites'][1], local_only=True)]},
                      {'local_only': {'paths': ['web/tests/**']}}):
            with self.subTest(marks=marks):
                self.mark(**marks)
                self.brake_here()
                proc = self.start('run', '--reason', 'marks', '--',
                                  self.registry['full_suites'][1]['command'],
                                  cwd=self.repo / 'web')
                self.wait_until(lambda: any('it stays on this host' in (r.get('s3') or '')
                                            for r in self.waiter_reasons()),
                                message='kept here')
                self.unbrake_here()
                code, _, err = self.finish(proc)
                self.assertEqual(code, 0, err)
                self.assertIsNone(self.records()[-1]['host'])
                self.registry.pop('local_only', None)
                self.registry['full_suites'][1].pop('local_only', None)

    def test_an_unmarked_suite_beside_a_marked_one_still_goes(self):
        self.mark(local_only={'paths': ['web/tests/**']})
        self.brake_here()
        # The root suite holds the files outside web/, which has its own suite.
        result = self.gate('run', '--reason', 'marks', '--', self.registry['full_suites'][0]
                           ['command'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]['host'], 's3')

    def test_a_marked_path_keeps_the_affected_tests_naming_it_here(self):
        self.mark(local_only={'paths': ['tests/test_app.py']})
        self.touch('src/app.py')
        self.touch('web/src/page.ts')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.where(), {str(self.repo): ['tests/test_app.py'],
                                        self.there('web'): ['tests/page.test.ts']})
        self.assertIn('it runs tests/test_app.py, marked by local_only.paths tests/test_app.py',
                      result.stderr)

    def test_checks_are_judged_by_their_paths_command_and_suite(self):
        checks = [
            {'paths': ['src/**'], 'cwd': '.',
             'command': f'cat tests/test_util.py; echo "$PWD named" >> {self.log}'},
            {'paths': ['src/**'], 'cwd': '.',
             'command': f'test -n needs-live; echo "$PWD needs-live" >> {self.log}'},
            {'paths': ['src/**'], 'cwd': 'web', 'command': f'echo "$PWD web" >> {self.log}'},
            {'paths': ['src/**'], 'cwd': '.', 'command': f'echo "$PWD plain" >> {self.log}'},
        ]
        suites = [dict(self.registry['full_suites'][0]),
                  dict(self.registry['full_suites'][1], local_only=True)]
        self.mark(affected=dict(self.registry['affected'], checks=checks), full_suites=suites,
                  local_only={'paths': ['tests/test_util.py'],
                              'commands': ['test -n needs-live']})
        self.touch('src/app.py')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = self.log.read_text().splitlines()
        self.assertIn(f'{self.repo} named', lines)
        self.assertIn(f'{self.repo} needs-live', lines)
        self.assertIn(f'{self.repo}/web web', lines)
        self.assertIn(f'{self.there()} plain', lines)
        self.assertIn('its command matches local_only.commands', result.stderr)

    def test_a_full_suite_run_through_a_runner_script_covers_its_directory(self):
        self.touch('tools/run_tests.sh', f'echo root >> {self.counter}\n')
        suites = [{'command': 'sh tools/run_tests.sh', 'cwd': '.'},
                  dict(self.registry['full_suites'][1])]
        self.mark(full_suites=suites, local_only={'paths': ['tests/test_util.py']})
        self.brake_here()
        proc = self.start('run', '--reason', 'wrapper', '--', 'sh tools/run_tests.sh')
        self.wait_until(lambda: any('it runs tests/test_util.py, marked by' in (r.get('s3') or '')
                                    for r in self.waiter_reasons()), message='kept here')
        self.unbrake_here()
        self.assertEqual(self.finish(proc)[0], 0)
        self.assertIsNone(self.records()[-1]['host'])

    def test_a_marked_file_run_as_the_program_or_by_absolute_path_stays_here(self):
        self.touch('tests/live.sh', 'true\n')
        self.mark(local_only={'paths': ['tests/live.sh', 'tests/test_util.py']})
        self.brake_here(light_min_slots=0)
        for command in ('./tests/live.sh tests/test_app.py',
                        f'cat {self.repo}/tests/test_util.py tests/test_app.py'):
            with self.subTest(command=command):
                proc = self.start('light', '--', command)
                self.wait_until(lambda: any(
                    'it stays on this host' in ((w.get('remote') or {}).get('s3') or '')
                    for w in self.status()['waiting'] if w.get('kind') == 'light'),
                    message='kept here')
                self.unbrake_here()
                self.finish(proc)
                self.brake_here(light_min_slots=0)
        self.assertEqual(self.trees('s3'), [])

    def test_an_unreadable_mark_keeps_every_run_here(self):
        self.mark(local_only={'paths': 'tests/**'})
        self.touch('src/app.py')
        self.brake_here()
        result = self.affected()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.where(), {str(self.repo): ['tests/test_app.py']})
        self.assertIn('the local_only marks in .suite-gate.json cannot be read', result.stderr)


class LightOffloadTests(RemoteMixin, GateCase):
    def setUp(self):
        super().setUp()
        self.add_host('s3')
        (self.repo / 'tests').mkdir()
        (self.repo / 'tests/test_a.py').write_text('a = 1\n')
        (self.repo / 'tests/test_live.py').write_text('b = 1\n')
        (self.repo / '.suite-gate.json').write_text(json.dumps(
            {'local_only': {'paths': ['tests/test_live.py']}}))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'tests')

    def light_waiters(self):
        return [w for w in self.status()['waiting'] if w.get('kind') == 'light']

    def test_a_waiting_light_run_goes_to_another_host_and_writes_no_record(self):
        self.brake_here(light_min_slots=0)
        result = self.gate('light', '--', f'cat tests/test_a.py; pwd > {self.tmp}/where; exit 4')
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn('a = 1', result.stdout)
        self.assertEqual((self.tmp / 'where').read_text().strip(), str(self.tree('s3')))
        self.assertIn('light run exited 4 on s3', result.stderr)
        self.assertEqual(self.records(), [])
        self.assertEqual(self.status()['remote'], [])

    def test_a_light_run_of_a_marked_test_file_stays_here(self):
        self.brake_here(light_min_slots=0)
        proc = self.start('light', '--', f'cat tests/test_live.py; pwd > {self.tmp}/where')
        self.wait_until(lambda: [w.get('remote') for w in self.light_waiters()] == [{
            's3': 'it stays on this host: it runs tests/test_live.py, marked by '
                  'local_only.paths tests/test_live.py in .suite-gate.json'}],
            message='kept here')
        self.assertIn('not on s3: it stays on this host', self.gate('status').stdout)
        self.unbrake_here()
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0, err)
        self.assertEqual((self.tmp / 'where').read_text().strip(), str(self.repo))
        self.assertEqual(self.records(), [])


class QueueOffloadTests(RemoteMixin, GateCase):
    def test_a_full_host_without_a_brake_sends_the_queued_suite(self):
        self.add_host('s3')
        self.fake_host(io=0.0)
        self.set_config(min_slots=0, max_slots=1, remote_connect_seconds=1, hosts=['s3'])
        # A suite outside Git never goes to another host; it holds the only slot here.
        blocker, release = self.blocker('here')
        self.wait_until(lambda: len(self.status()['running']) == 1, message='slot held')
        result = self.gate('run', '--', self.suite())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records()[-1]['host'], 's3')
        release.touch()
        self.assertEqual(self.finish(blocker)[0], 0)

    def test_a_host_added_to_the_config_is_used_on_the_next_poll(self):
        self.add_host('s3')
        self.brake_here(hosts=[])
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: self.waiting_reason() == ['brake on: disk wait 90%, above 40%'],
                        message='queued')
        self.assertEqual(self.ssh_calls(), [])
        self.brake_here(hosts=['s3'])
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.records()[-1]['host'], 's3')

    def test_a_suite_runs_on_one_host_only(self):
        self.add_host('s3')
        self.add_host('lab')
        self.brake_here(hosts=[{'host': 's3', 'max_runs': 2}, {'host': 'lab', 'max_runs': 2}])
        result = self.gate('run', '--', self.suite())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.runs(), 1)
        self.assertEqual(self.records()[-1]['host'], 's3')
        self.assertEqual(self.ssh_calls('lab'), [])
        self.assertEqual(self.trees('lab'), [])

    def test_a_record_without_a_host_field_is_read_and_reused(self):
        result = self.gate('run', '--', self.suite())
        self.assertEqual(result.returncode, 0, result.stderr)
        ledger = self.state / 'ledger.jsonl'
        old = [{k: v for k, v in r.items() if k != 'host'} for r in self.records()]
        ledger.write_text(''.join(json.dumps(r) + '\n' for r in old))
        self.add_host('s3')
        self.brake_here()
        again = self.gate('run', '--', self.suite())
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn('already passed', again.stdout)
        self.assertNotIn('ran on:', again.stdout)
        self.assertEqual(self.runs(), 1)
        shown = self.gate('status')
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertEqual(self.ssh_calls(), [])


class BackgroundOffloadTests(RemoteMixin, BackgroundCase):
    def test_background_suites_go_to_another_host_and_count_as_passes(self):
        self.add_host('s3')
        self.brake_here()
        result = self.background()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        records = self.background_records()
        self.assertEqual([r['host'] for r in records], ['s3', 's3'])
        self.assertTrue(all(r['reusable'] for r in records))
        self.unbrake_here()
        again = self.background()
        self.assertEqual(again.stderr.count('not run, this content already passed'), 2,
                         again.stderr)


class RemoteAffectedRerunTests(RemoteMixin, RerunCase):
    def test_failed_affected_files_rerun_where_they_first_ran(self):
        self.add_host('s3')
        self.project({'web': 'bun test {tests}'}, RerunCase.BUN_FILES)
        reg = json.loads((self.repo / '.suite-gate.json').read_text())
        reg['affected']['map'] = [{'paths': ['web/src/**'], 'tests': ['web/tests/**']}]
        (self.repo / '.suite-gate.json').write_text(json.dumps(reg))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'map web')
        git(self.repo, 'checkout', '-qb', 'feature')
        (self.repo / 'web/src').mkdir()
        (self.repo / 'web/src/page.ts').write_text('changed\n')
        self.plan('bun', ('bun-fail.txt', 1), ('bun-pass.txt', 0))
        self.brake_here()
        result = self.gate('affected', '--base', 'main')
        self.assertEqual(result.returncode, 0, result.stderr)
        record = self.only_record()
        self.assertEqual((record['kind'], record['host']), ('affected', 's3'))
        self.assertTrue(record['flaky'])
        web = str(self.tree('s3') / 'web')
        self.assertEqual([c[1] for c in self.calls()], [web, web])


class CleanRemoteTests(RemoteMixin, GateCase):
    def cache_dirs(self, name):
        base = self.remotes / name / 'home/.cache/suite-gate/remote'
        return sorted(p for p in base.glob('*/*') if p.is_dir())

    def age(self, cache, days):
        stamp = time.time() - days * 86400
        os.utime(cache / 'used', (stamp, stamp))

    def test_only_this_hosts_old_unused_caches_are_removed_and_listed(self):
        self.add_host('s3')
        self.brake_here()
        result = self.gate('run', '--', self.suite())
        self.assertEqual(result.returncode, 0, result.stderr)
        [mine] = self.cache_dirs('s3')
        # Another host's cache, a fresh one of this host and one with a live job there.
        root = mine.parent.parent
        foreign = root / 'repo-x/other-y'
        fresh = root / 'repo-x/fresh-z'
        busy = root / 'repo-x/busy-w'
        for cache in (foreign, fresh, busy):
            (cache / 'job').mkdir(parents=True)
            (cache / 'used').write_text('2020-01-01T00:00:00Z\n')
        (foreign / 'owner').write_text('some-other-host\n')
        (fresh / 'owner').write_text((mine / 'owner').read_text())
        (busy / 'owner').write_text((mine / 'owner').read_text())
        (busy / 'job/job-1.pid').write_text(f'{os.getpgid(0)}\n')
        for cache in (mine, foreign, busy):
            self.age(cache, 20)
        self.age(fresh, 3)
        cleaned = self.gate('clean-remote', '--days', '7')
        self.assertEqual(cleaned.returncode, 0, cleaned.stderr)
        self.assertEqual(self.cache_dirs('s3'), sorted([foreign, fresh, busy]))
        relative = mine.relative_to(self.remotes / 's3/home')
        self.assertIn(f's3: removed 1 cache(s) unused for over 7 day(s), kept 2', cleaned.stdout)
        self.assertIn(f'  removed ~/{relative} (last used ', cleaned.stdout)
        self.assertIn('a job there is still running', cleaned.stdout)
        self.assertIn('used within the limit', cleaned.stdout)
        self.assertNotIn('other-y', cleaned.stdout)
        # The default limit comes from the config.
        self.age(fresh, 20)
        self.set_config(hosts=['s3'], remote_cache_days=30)
        self.assertEqual(self.cache_dirs('s3'), sorted([foreign, fresh, busy]))
        self.assertIn('removed 0 cache(s)', self.gate('clean-remote').stdout)

    def test_no_run_claims_a_cache_on_a_host_while_it_is_cleaned(self):
        self.add_host('s3')
        started = self.tmp / 'cleaning'
        self.host_tool('s3', 'stat', f'touch {started}; sleep 2; exec /usr/bin/stat "$@"')
        self.brake_here()
        first = self.gate('run', '--', 'true')
        self.assertEqual(first.returncode, 0, first.stderr)
        [mine] = self.cache_dirs('s3')
        self.age(mine, 20)
        started.unlink(missing_ok=True)
        cleaner = self.start('clean-remote', '--days', '7')
        self.wait_until(started.exists, message='cleaning')
        proc = self.start('run', '--', self.suite())
        self.wait_until(lambda: self.waiter_reasons() == [
            {'s3': 'clean-remote is removing old caches there'}], message='refused meanwhile')
        code, out, err = self.finish(cleaner)
        self.assertEqual(code, 0, err)
        self.assertIn('removed 1 cache(s)', out)
        code, _, err = self.finish(proc)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.records()[-1]['host'], 's3')
        self.assertEqual(len(self.cache_dirs('s3')), 1)

    def test_a_cache_a_run_here_holds_is_kept_and_a_host_that_is_down_fails(self):
        self.add_host('s3')
        self.add_host('lab')
        (self.remotes / 'lab/down').touch()
        self.brake_here(hosts=['s3', 'lab'])
        release = self.tmp / 'release'
        proc = self.start('run', '--', f'while [ ! -f {release} ]; do sleep 0.05; done')
        self.wait_until(lambda: [h.get('phase') for h in self.status()['remote']] == ['running'],
                        message='running on s3')
        [mine] = self.cache_dirs('s3')
        self.age(mine, 20)
        cleaned = self.gate('clean-remote', '--days', '7')
        self.assertEqual(cleaned.returncode, 1, cleaned.stderr)
        self.assertIn('a run from this host uses it', cleaned.stdout)
        self.assertIn('clean-remote: lab:', cleaned.stderr)
        self.assertEqual(self.cache_dirs('s3'), [mine])
        release.touch()
        self.assertEqual(self.finish(proc)[0], 0)


if __name__ == '__main__':
    unittest.main()
