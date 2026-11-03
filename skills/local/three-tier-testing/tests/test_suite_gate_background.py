"""`background --repo <dir>` fills in missing full-suite passes on the local integration
branch, and `install-background` / `uninstall-background` manage its hourly timer, through
the CLI. `gh` and `systemctl` are fakes; no real timer or label is created."""
import json
import os
import shlex
import subprocess
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

# Run by file path (the affected template) as well as by discover.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GateCase, PrePushCase, git

PY = shlex.quote(sys.executable)


def rev(cwd, name):
    return subprocess.run(['git', 'rev-parse', name], cwd=cwd, capture_output=True,
                          text=True).stdout.strip()


class FakeToolsMixin:
    """A fake `gh` that knows labels (gh/label present: the suite-failure label exists) and
    a fake `systemctl` that logs its arguments."""

    def install_fake_gh(self):
        super().install_fake_gh()
        fake = self.tmp / 'bin/gh'
        fake.write_text(f"""#!{sys.executable}
import json, sys
from pathlib import Path
d = Path({str(self.gh_dir)!r})
args = sys.argv[1:]
with open(d / 'calls.jsonl', 'a') as log:
    log.write(json.dumps(args) + '\\n')
if (d / 'fail').exists():
    sys.exit('gh: HTTP 502')
if args[:2] == ['label', 'create']:
    if (d / 'label').exists():
        sys.exit('label with name "suite-failure" already exists; use `--force` to update')
    (d / 'label').touch()
elif args[:2] == ['issue', 'list']:
    print((d / 'open.json').read_text() if (d / 'open.json').exists() else '[]')
elif args[:2] == ['issue', 'view']:
    view = d / 'view.json'
    print(view.read_text() if view.exists() else json.dumps(
        {{'state': 'OPEN', 'url': 'https://github.com/o/r/issues/' + args[2]}}))
elif args[:2] == ['issue', 'create']:
    if '--label' in args and not (d / 'label').exists():
        sys.exit("could not add label: 'suite-failure' not found")
    print('https://github.com/o/r/issues/7')
""")
        systemctl = fake.parent / 'systemctl'
        self.systemctl_log = self.tmp / 'systemctl.jsonl'
        systemctl.write_text(f"""#!{sys.executable}
import json, sys
with open({str(self.systemctl_log)!r}, 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
""")
        systemctl.chmod(0o755)

    def systemctl_calls(self):
        path = self.systemctl_log
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def issue_calls(self):
        return [c for c in self.gh_calls() if c[:1] == ['issue']]

    def background(self, **kwargs):
        return self.gate('background', '--repo', str(self.repo), **kwargs)

    def age_records(self, hours=25):
        """Move every record's times back by hours."""
        path = self.state / 'ledger.jsonl'
        lines = []
        for record in self.records():
            for field in ('time', 'finished'):
                if record.get(field):
                    record[field] = (datetime.fromisoformat(record[field])
                                     - timedelta(hours=hours)).isoformat(timespec='seconds')
            lines.append(json.dumps(record))
        path.write_text(''.join(line + '\n' for line in lines))


class BackgroundCase(FakeToolsMixin, PrePushCase):
    """The mapped project on its integration branch main, with a tracker; the web suite
    declares depends_on, so a change outside web/ leaves its fingerprint alone."""

    def setUp(self):
        super().setUp()
        git(self.repo, 'checkout', '-q', 'main')
        self.registry['full_suites'][1]['depends_on'] = []
        self.registry['cleanup'] = {'github_repo': 'o/r'}
        (self.gh_dir / 'label').touch()
        self.commit_registry()

    def commit_registry(self):
        self.write_registry()
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'registry')

    def change_main(self, name='src/app.py'):
        self.touch(name, f'changed {len(self.records())}\n')
        git(self.repo, 'add', '-A')
        self.commit(self.repo, f'change {name}')

    def fail_root(self, code=3):
        self.registry['full_suites'][0]['command'] = f'{self.full("root")}; exit {code}'
        self.commit_registry()

    def background_records(self):
        return [r for r in self.records() if r.get('purpose') == 'background']


class BackgroundRunTests(BackgroundCase):
    def test_suites_that_never_passed_run_in_a_clean_checkout_of_the_local_branch(self):
        main = rev(self.repo, 'main')
        git(self.repo, 'checkout', '-q', 'feature')
        self.touch('src/app.py', 'uncommitted on another branch\n')
        result = self.background()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        records = self.background_records()
        self.assertEqual([r['rel_cwd'] for r in records], ['.', 'web'])
        checkouts = self.state / 'checkouts'
        for record in records:
            self.assertTrue(record['reusable'])
            self.assertTrue(record['cwd'].startswith(str(checkouts)), record['cwd'])
        self.assertEqual(list(checkouts.iterdir()), [], 'the checkout is removed')
        self.assertIn(f'main at {main[:12]}', result.stderr)
        state = json.loads((self.state / 'state.json').read_text())
        self.assertEqual({(a['commit'], a['result']) for a in state['background'].values()},
                         {(main, 'passed')})

    def test_suites_that_already_passed_this_content_do_not_run(self):
        self.assertEqual(self.background().returncode, 0)
        result = self.background()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'], 'nothing ran the second time')
        self.assertEqual(result.stderr.count('not run, this content already passed'), 2)

    def test_a_pass_of_any_purpose_counts(self):
        for suite in self.registry['full_suites']:
            result = self.gate('run', '--purpose', 'release', '--', suite['command'],
                               cwd=self.repo / suite['cwd'])
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.background().returncode, 0)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.assertEqual(self.background_records(), [])

    def test_only_the_suite_lacking_a_pass_runs_once_its_last_pass_is_over_a_day_old(self):
        self.assertEqual(self.background().returncode, 0)
        self.change_main('src/app.py')
        result = self.background()
        self.assertIn('within 24 hours', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'], 'the root pass is under a day old')
        self.age_records()
        result = self.background()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web', 'root'],
                         'web still has a pass of its content')

    def test_a_recent_non_background_pass_holds_new_content_for_a_day(self):
        for suite in self.registry['full_suites']:
            self.gate('run', '--purpose', 'release', '--', suite['command'],
                      cwd=self.repo / suite['cwd'])
        self.change_main('web/src/page.ts')
        self.assertEqual(self.background().returncode, 0)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.age_records(23)
        self.assertEqual(self.background().returncode, 0)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.age_records(2)
        self.assertEqual(self.background().returncode, 0)
        # The root suite covers the whole repo, so the web change is new content for it too.
        self.assertEqual(self.full_runs(), ['root', 'web', 'root', 'web'])

    def test_a_failed_content_is_not_run_again_until_it_changes(self):
        self.fail_root()
        result = self.background()
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.age_records()
        result = self.background()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('the background run on this content failed', result.stderr)
        self.assertEqual(self.full_runs(), ['root', 'web'])
        self.change_main('src/app.py')
        self.assertEqual(self.background().returncode, 3)
        self.assertEqual(self.full_runs(), ['root', 'web', 'root'])

    def test_a_second_background_run_ends_at_once(self):
        release = self.tmp / 'release'
        self.registry['full_suites'][0]['command'] = (
            f'{self.full("root")}; while [ ! -f {release} ]; do sleep 0.05; done')
        self.commit_registry()
        first = self.start('background', '--repo', str(self.repo))
        self.wait_until(lambda: self.full_runs() == ['root'], message='the first run')
        second = self.background()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('another background run', second.stdout)
        release.touch()
        code, _out, err = self.finish(first)
        self.assertEqual(code, 0, err)
        self.assertEqual(self.full_runs(), ['root', 'web'])

    def test_push_reuses_the_background_pass_of_the_same_content(self):
        self.assertEqual(self.install().returncode, 0)
        self.assertEqual(self.background().returncode, 0)
        result = self.push('main')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('every registered full suite passed', result.stderr)

    def test_no_integration_branch_is_an_error(self):
        del self.registry['integration_branch']
        self.commit_registry()
        result = self.background()
        self.assertEqual(result.returncode, 2)
        self.assertIn('names no integration_branch', result.stderr)


class BackgroundTicketTests(BackgroundCase):
    def test_a_failure_opens_a_suite_failure_ticket_naming_project_and_command(self):
        self.fail_root()
        self.assertEqual(self.background().returncode, 3)
        create = [c for c in self.issue_calls() if c[:2] == ['issue', 'create']]
        self.assertEqual(len(create), 1, self.gh_calls())
        title = create[0][create[0].index('--title') + 1]
        self.assertIn('Background full suite failed: repo', title)
        self.assertIn(self.registry['full_suites'][0]['command'], title)
        self.assertEqual(create[0][-4:], ['--label', 'suite-failure', '--repo', 'o/r'])
        body = create[0][create[0].index('--body') + 1]
        self.assertIn(rev(self.repo, 'main'), body)
        self.assertIn('Exit code: 3', body)
        status = self.status()
        self.assertEqual(status['background_failures'], [], 'a ticketed failure is handled')

    def test_an_open_ticket_of_the_same_suite_gets_a_comment(self):
        self.fail_root()
        self.assertEqual(self.background().returncode, 3)
        title = next(c for c in self.issue_calls() if c[:2] == ['issue', 'create'])
        title = title[title.index('--title') + 1]
        # The ticket the gate opened is closed; another open one has the same title.
        (self.gh_dir / 'view.json').write_text(json.dumps({'state': 'CLOSED', 'url': 'x'}))
        (self.gh_dir / 'open.json').write_text(json.dumps([
            {'number': 3, 'title': 'Background full suite failed: other', 'url': 'u3'},
            {'number': 12, 'title': title, 'url': 'https://github.com/o/r/issues/12'}]))
        self.change_main('src/app.py')
        self.assertEqual(self.background().returncode, 3)
        calls = self.issue_calls()
        self.assertEqual([c[:3] for c in calls[2:]], [['issue', 'view', '7'],
                                                     ['issue', 'list', '--state'],
                                                     ['issue', 'comment', '12']])
        # The gate now remembers 12 and comments on it while it is open.
        (self.gh_dir / 'view.json').unlink()
        self.change_main('src/app.py')
        self.background()
        self.assertEqual([c[:3] for c in self.issue_calls()[5:]],
                         [['issue', 'view', '12'], ['issue', 'comment', '12']])

    def test_without_the_label_the_ticket_opens_unlabelled(self):
        (self.gh_dir / 'label').unlink()
        self.fail_root()
        result = self.background()
        self.assertEqual(result.returncode, 3)
        create = [c for c in self.issue_calls() if c[:2] == ['issue', 'create']]
        self.assertEqual(len(create), 2)
        self.assertIn('--label', create[0])
        self.assertNotIn('--label', create[1])
        self.assertIn('opening it without a label', result.stderr)

    def test_without_a_tracker_status_lists_the_failure_until_the_suite_passes(self):
        del self.registry['cleanup']
        self.registry['full_suites'][0]['command'] = f'{self.full("root")}; test ! -f broken'
        self.touch('broken')
        self.commit_registry()
        self.assertEqual(self.background().returncode, 1)
        self.assertEqual(self.issue_calls(), [])
        [failure] = self.status()['background_failures']
        self.assertEqual((failure['rel_cwd'], failure['exit_code'], failure['commit']),
                         ('.', 1, rev(self.repo, 'main')))
        text = self.gate('status').stdout
        self.assertIn('Background full-suite failures without a ticket (1)', text)
        git(self.repo, 'rm', '-q', 'broken')
        self.commit(self.repo, 'fixed')
        result = self.gate('run', '--purpose', 'release', '--',
                           self.registry['full_suites'][0]['command'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.status()['background_failures'], [])

    def test_a_tracker_that_fails_leaves_the_failure_listed(self):
        (self.gh_dir / 'fail').touch()
        self.fail_root()
        result = self.background()
        self.assertEqual(result.returncode, 3)
        self.assertIn('could not be updated', result.stderr)
        self.assertEqual(len(self.status()['background_failures']), 1)


class BackgroundRerunTests(FakeToolsMixin, GateCase):
    def test_a_failing_test_file_is_rerun_and_a_flaky_pass_counts(self):
        mark = self.tmp / 'mark'
        (self.repo / 'pkg').mkdir()
        (self.repo / 'pkg/__init__.py').write_text('')
        (self.repo / 'pkg/test_one.py').write_text(f"""import unittest
from pathlib import Path
MARK = Path({str(mark)!r})
class OneTests(unittest.TestCase):
    def test_once(self):
        first = not MARK.exists()
        MARK.touch()
        self.assertFalse(first, 'failed on purpose')
""")
        (self.repo / '.suite-gate.json').write_text(json.dumps({
            'integration_branch': 'main',
            'full_suites': [{'command': f'{PY} -m unittest discover -s .', 'cwd': '.'}],
            'affected': {'commands': {'.': f'{PY} -m unittest {{tests}}'},
                         'map': [{'paths': ['pkg/**'], 'tests': ['pkg/test_*.py']}]}}))
        git(self.repo, 'add', '-A')
        self.commit(self.repo, 'project')
        self.env['PYTHONDONTWRITEBYTECODE'] = '1'
        result = self.background()
        self.assertEqual(result.returncode, 0, result.stderr)
        [record] = self.records()
        self.assertEqual((record['purpose'], record['exit_code'], record['reusable']),
                         ('background', 0, True))
        self.assertEqual(record['flaky'], [{'file': 'pkg/test_one.py', 'tests': ['test_once']}])


class BackgroundInstallTests(FakeToolsMixin, PrePushCase):
    def setUp(self):
        super().setUp()
        self.registry['cleanup'] = {'github_repo': 'o/r'}
        self.write_registry()
        self.units = self.tmp / 'xdg-config/systemd/user'

    def configure(self, action, *extra):
        return self.gate(f'{action}-background', '--repo', str(self.repo), *extra)

    def test_preview_install_and_uninstall(self):
        preview = self.configure('install', '--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn('+OnCalendar=hourly', preview.stdout)
        self.assertFalse(self.units.exists())
        self.assertEqual(self.systemctl_calls(), [])
        self.assertEqual(self.gh_calls(), [])

        result = self.configure('install')
        self.assertEqual(result.returncode, 0, result.stderr)
        service, = self.units.glob('suite-gate-background-repo-*.service')
        timer, = self.units.glob('suite-gate-background-repo-*.timer')
        self.assertIn('OnCalendar=hourly', timer.read_text())
        text = service.read_text()
        self.assertIn(f'"background" "--repo" "{self.repo.resolve()}"', text)
        self.assertIn('Environment="PATH=', text)
        self.assertEqual(self.systemctl_calls(), [['--user', 'daemon-reload'],
                                                  ['--user', 'enable', '--now', timer.name]])
        self.assertEqual(self.gh_calls()[0][:3], ['label', 'create', 'suite-failure'])
        self.assertIn('Created the suite-failure label in o/r', result.stdout)

        again = self.configure('install')
        self.assertIn('No changes', again.stdout)
        self.assertIn('label already exists', again.stdout)

        removed = self.configure('uninstall')
        self.assertEqual(removed.returncode, 0, removed.stderr)
        self.assertEqual(list(self.units.iterdir()), [])
        self.assertEqual(self.systemctl_calls()[-2:], [['--user', 'disable', '--now', timer.name],
                                                       ['--user', 'daemon-reload']])
        self.assertIn('No changes', self.configure('uninstall').stdout)

    def test_without_a_tracker_no_label_is_created(self):
        del self.registry['cleanup']
        self.write_registry()
        result = self.configure('install')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gh_calls(), [])
        self.assertIn('no label created', result.stdout)

    def test_a_unit_file_suite_gate_did_not_create_is_left_alone(self):
        self.assertEqual(self.configure('install').returncode, 0)
        service, = self.units.glob('*.service')
        service.write_text('[Service]\nExecStart=/bin/true\n')
        result = self.configure('uninstall')
        self.assertEqual(result.returncode, 1)
        self.assertIn('did not create it', result.stderr)
        self.assertTrue(service.exists())

    def test_a_repo_without_an_integration_branch_is_refused(self):
        del self.registry['integration_branch']
        self.write_registry()
        result = self.configure('install')
        self.assertEqual(result.returncode, 1)
        self.assertIn('names no integration_branch', result.stderr)
        self.assertFalse(self.units.exists())


if __name__ == '__main__':
    unittest.main()
