"""CLI contract tests for lat-preauth.py: temp HOME/XDG config, temp Git repos, fake session,
and a temp suite-gate record store standing in for the host's gate."""
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
import unittest.mock
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-preauth.py'
SUITE_GATE = Path(__file__).resolve().parents[2] / 'three-tier-testing/scripts/suite-gate.py'
INSTALLER = Path(__file__).resolve().parents[4] / 'scripts/install-skills.py'
PANEL = Path(__file__).resolve().parents[1] / 'herdr-panel/lat_panel.py'
SESSION = '11111111-1111-4111-8111-111111111111'
SUITES = [{'command': 'uv run pytest', 'cwd': '.'}, {'command': 'bun test', 'cwd': 'web'}]


def load_suite_gate():
    spec = importlib.util.spec_from_file_location('suite_gate_for_tests', SUITE_GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# Fixture Git ignores the host's Git config and hooks, so pushes to the temp remote run no
# installed hook.
GIT_ENV = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)


def git(cwd, *args):
    return subprocess.run(['git', '-c', f'core.hooksPath={os.devnull}', '-C', str(cwd), *args],
                          check=True, capture_output=True, text=True, env=GIT_ENV).stdout.strip()


class PreauthCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q', '-b', 'dev')
        git(self.repo, 'config', 'user.email', 't@example.com')
        git(self.repo, 'config', 'user.name', 'T')
        (self.repo / 'a.txt').write_text('a\n')
        (self.repo / '.suite-gate.json').write_text(json.dumps({'full_suites': SUITES}))
        git(self.repo, 'add', 'a.txt', '.suite-gate.json')
        git(self.repo, 'commit', '-q', '-m', 'first')
        self.gate_state = self.root / 'gate-state'
        self.config = self.root / 'xdg'
        self.global_file = self.config / 'lat' / 'preauth.toml'
        self.project_file = self.repo / '.lat' / 'preauth.toml'
        self.sessions = self.repo / '.lat' / 'sessions'
        self.script = SCRIPT

    def run_tool(self, *args, cwd=None, path=None, wait=True):
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')}
        environment.update(HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.config),
                           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                           XDG_STATE_HOME=str(self.root / 'state'),
                           SUITE_GATE_STATE_DIR=str(self.gate_state))
        environment.pop('SUITE_GATE_CONFIG', None)
        if path:
            environment['PATH'] = path
        environment['CLAUDE_CODE_SESSION_ID'] = SESSION
        command = [sys.executable, str(self.script), *args]
        if not wait:
            return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, cwd=cwd or self.repo, env=environment)
        return subprocess.run(command, capture_output=True, text=True, cwd=cwd or self.repo,
                              env=environment, timeout=60)

    def check(self, action, *extra, **kwargs):
        result = self.run_tool('check', '--action', action, *extra, '--json', **kwargs)
        self.assertEqual(result.stderr, '')
        verdict = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if verdict['verdict'] == 'allow' else 1)
        return verdict

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def session(self, *, status='active', history=0, integration='dev', tickets=('313',),
                hcom_name='orch', **extra):
        ledger = self.repo / '.lat' / 'ledgers' / 'round.json'
        self.write(ledger, json.dumps({'integration_branch': integration,
                                       'items': [{'ticket': t} for t in tickets]}))
        record = dict(status=status, history=[{}] * history, ledger_path=str(ledger),
                      hcom_name=hcom_name, decisions_path=str(self.repo / '.lat' / 'decisions'),
                      **extra)
        self.write(self.sessions / f'{SESSION}.json', json.dumps(record))


    def commit(self, message, name='b.txt'):
        (self.repo / name).write_text(message + '\n')
        git(self.repo, 'add', name)
        git(self.repo, 'commit', '-q', '-m', message)
        return git(self.repo, 'rev-parse', 'HEAD')

    def gate_record(self, ref='HEAD', suites=SUITES, passed=True):
        """A record in the temp gate store, fingerprinted the way the gate computes it."""
        gate = load_suite_gate()
        registry = gate.load_registry(self.repo) or {}
        self.gate_state.mkdir(exist_ok=True)
        with open(self.gate_state / 'ledger.jsonl', 'a') as ledger:
            for suite in suites:
                fingerprint = gate.suite_fingerprint(self.repo, registry, suite,
                                                     git(self.repo, 'rev-parse', ref))
                ledger.write(json.dumps({'fingerprint': fingerprint, 'reusable': passed,
                                         'exit_code': 0 if passed else 1}) + '\n')


class LayerTests(PreauthCase):
    def test_no_settings_anywhere_asks_every_action(self):
        for action, extra in (('merge', ['--branch', 'dev']), ('push', ['--branch', 'dev']),
                              ('deploy-test', []), ('deploy-prod', []), ('install-host', [])):
            with self.subTest(action=action):
                verdict = self.check(action, *extra)
                self.assertEqual(verdict['verdict'], 'ask')
                self.assertIn(f'no layer sets actions.{action}.allow', verdict['reasons'])

    def test_project_false_tightens_global_allow(self):
        self.write(self.global_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        self.write(self.project_file, '[actions.merge]\nallow = false\nsource = "P-1"\n')
        verdict = self.check('merge', '--branch', 'dev')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('actions.merge.allow=false from project (source P-1)', verdict['reasons'])

    def test_project_allow_loosens_when_global_is_silent(self):
        self.write(self.project_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        verdict = self.check('merge', '--branch', 'dev')
        self.assertEqual(verdict['verdict'], 'allow')
        self.assertEqual(verdict['reasons'], [])

    def test_keys_resolve_one_by_one_and_name_their_layer(self):
        self.write(self.global_file,
                   '[actions.merge]\nallow = false\nbranches = ["dev"]\nsource = "G-1"\n')
        self.write(self.project_file, '[actions.merge]\nallow = true\nsource = "P-2"\n')
        result = self.run_tool('check', '--action', 'merge', '--branch', 'dev')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('allow merge dev — basis: ', result.stdout)
        self.assertIn('allow=true from project (source P-2)', result.stdout)
        self.assertIn('branches=["dev"] from global (source G-1)', result.stdout)

    def test_a_preauth_field_left_in_the_session_record_is_ignored(self):
        self.write(self.project_file, '[actions.merge]\nallow = false\nbranches = ["dev"]\n')
        for label, preauth in (
                ('this round', {'round': 1, 'settings': {'actions': {'merge': {'allow': True}}}}),
                ('malformed', {'oops': True}),
                ('unknown key', {'round': 1, 'settings': {'actions': {'merge': {'oops': 1}}}})):
            with self.subTest(label):
                self.session(preauth=preauth)
                verdict = self.check('merge', '--branch', 'dev')
                self.assertEqual(verdict['reason_kinds'], ['allow-false'])
                self.assertNotIn('controller', self.run_tool('show').stdout)

    def test_show_lists_the_two_layers_with_effective_settings_and_origins(self):
        self.write(self.global_file, 'version = 1\n'
                   '[actions.push]\nallow = true\nbranches = ["dev"]\nsource = "G-2"\n'
                   '[advisor]\nextended = true\nmay_settle = ["small fixes"]\n')
        self.write(self.project_file, '[actions.push]\nallow = false\n')
        result = self.run_tool('show')
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        layers = out.split('Effective settings:')[0].splitlines()[1:]
        self.assertEqual([line.split(':')[0].strip() for line in layers], ['project', 'global'])
        self.assertIn('    allow = false  ← project', out)
        self.assertIn('    branches = ["dev"]  ← global (source G-2)', out)
        self.assertIn('  [actions.merge] (not set; asks)', out)
        self.assertIn('    may_settle = ["small fixes"]  ← global', out)
        self.assertNotIn('專案層的 [advisor] 不生效', out)

    def test_project_advisor_section_is_not_in_effect(self):
        self.write(self.global_file, '[advisor]\nmay_settle = ["from global"]\n')
        self.write(self.project_file, '[advisor]\nmay_settle = ["from project"]\n'
                   'must_ask = ["project only"]\n')
        out = self.run_tool('show').stdout
        self.assertIn('    may_settle = ["from global"]  ← global', out)
        self.assertIn('專案層的 [advisor] 不生效', out)
        self.assertNotIn('from project', out)
        self.assertNotIn('project only', out)
        self.assertNotIn('must_ask', out)
        with self.subTest('nothing in the global layer'):
            self.global_file.unlink()
            out = self.run_tool('show').stdout
            self.assertIn('  [advisor] (not set)', out)
            self.assertIn('專案層的 [advisor] 不生效', out)
            self.assertNotIn('from project', out)
        with self.subTest('it is still checked like the rest of the file'):
            self.write(self.project_file, '[advisor]\noops = 1\n')
            verdict = self.check('merge', '--branch', 'dev')
            self.assertEqual(verdict['verdict'], 'ask')
            self.assertIn('unknown key `oops`', ' '.join(verdict['reasons']))


class ErrorTests(PreauthCase):
    def setUp(self):
        super().setUp()
        self.write(self.project_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')

    def assert_asks(self, global_text, reason):
        self.write(self.global_file, global_text)
        verdict = self.check('merge', '--branch', 'dev')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertTrue(any(reason in item for item in verdict['reasons']), verdict['reasons'])
        self.assertIn(reason, self.run_tool('show').stdout)

    def test_malformed_file_asks_rather_than_loosening(self):
        self.assert_asks('[actions.merge\nallow = true\n', 'malformed TOML')

    def test_unknown_key_asks(self):
        self.assert_asks('[actions.push]\nalow = true\n', 'unknown key `alow`')

    def test_the_removed_experiment_key_is_an_unknown_key(self):
        for value in ('true', '"yes"'):
            with self.subTest(value=value):
                self.assert_asks(f'experiment = {value}\n', 'unknown key `experiment`')

    def test_wrong_value_type_asks(self):
        self.assert_asks('[actions.push]\nallow = "yes"\n', '`allow` must be true or false')

    def test_unknown_action_in_settings_asks(self):
        self.assert_asks('[actions.rebase]\nallow = true\n', 'unknown action [actions.rebase]')

    def test_always_ask_category_in_settings_asks(self):
        self.assert_asks('[actions.spend]\nallow = true\n', 'never pre-authorized')

    def test_unknown_and_always_ask_actions_are_refused(self):
        for action, reason in (('rebase', 'unknown action `rebase`'),
                               ('change-acceptance', 'always ask'),
                               ('spend', 'always ask'), ('delete-user-data', 'always ask'),
                               ('new-ticket', 'always ask')):
            with self.subTest(action=action):
                verdict = self.check(action)
                self.assertEqual(verdict['verdict'], 'ask')
                self.assertIn(reason, verdict['reasons'][0])

    def test_version_must_be_the_integer_one(self):
        for text in ('version = true\n', 'version = 1.0\n', 'version = 2\n'):
            with self.subTest(text=text):
                self.assert_asks(text, 'version must be 1')

    def test_undecodable_file_asks(self):
        self.global_file.parent.mkdir(parents=True)
        self.global_file.write_bytes(b'\xff\n')
        result = self.run_tool('check', '--action', 'merge', '--branch', 'dev')
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('unreadable', result.stdout)


class ConditionTests(PreauthCase):
    def test_merge_branch_must_be_listed(self):
        self.write(self.global_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        verdict = self.check('merge', '--branch', 'main')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('branch `main` is not in actions.merge.branches', verdict['reasons'][0])
        self.write(self.global_file, '[actions.merge]\nallow = true\n')
        self.assertIn('no layer sets actions.merge.branches',
                      self.check('merge', '--branch', 'dev')['reasons'])

    def test_each_reason_carries_its_kind(self):
        self.write(self.project_file, '[actions.merge]\nallow = false\nbranches = ["dev"]\n')
        verdict = self.check('merge', '--branch', 'main')
        self.assertEqual(verdict['reason_kinds'], ['allow-false', 'condition'])
        self.write(self.project_file, '[actions.merge]\nallow = true\n')
        self.assertEqual(self.check('merge', '--branch', 'dev')['reason_kinds'], ['unset'])
        self.assertEqual(self.check('spend')['reason_kinds'], ['always-ask'])
        self.write(self.project_file, '[actions.merge]\noops = 1\n')
        self.assertEqual(set(self.check('merge', '--branch', 'dev')['reason_kinds']), {'error'})
        self.write(self.project_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        self.assertEqual(self.check('merge', '--branch', 'dev')['reason_kinds'], [])

    def test_gate_and_checkout_reasons_are_conditions(self):
        self.allow_all()
        self.gate_record(suites=SUITES[:1])
        verdict = self.check('install-host')
        self.assertEqual(verdict['reason_kinds'], ['condition'] * len(verdict['reasons']))
        git(self.repo, 'checkout', '-q', '-b', 'side')
        self.commit('side work', 'side.txt')
        verdict = self.check('deploy-prod')
        self.assertIn('HEAD is not the tip of integration branch `dev`', verdict['reasons'])
        self.assertEqual(set(verdict['reason_kinds']), {'condition'})
        git(self.repo, 'checkout', '-q', 'dev')
        self.write(self.project_file, '')
        self.session()
        verdict = self.check('deploy-test')
        self.assertIn('the project layer does not set actions.deploy-test.target',
                      verdict['reasons'])
        self.assertEqual(set(verdict['reason_kinds']), {'condition'})

    def allow_all(self):
        self.write(self.global_file, ''.join(f'[actions.{name}]\nallow = true\n' for name in
                                             ('deploy-test', 'deploy-prod', 'install-host')))
        self.write(self.project_file, '[actions.deploy-test]\ntarget = "staging on :9000"\n')
        self.session()

    def test_main_checkout_at_integration_tip_with_passing_gate_allows(self):
        self.allow_all()
        self.gate_record()
        head = git(self.repo, 'rev-parse', 'HEAD')
        for action in ('deploy-test', 'deploy-prod', 'install-host'):
            with self.subTest(action=action):
                verdict = self.check(action)
                self.assertEqual(verdict['verdict'], 'allow', verdict['reasons'])
                self.assertIn('integration branch `dev` from the round ledger', verdict['basis'])
                self.assertIn(f'every registered full suite passed for {head[:12]}',
                              verdict['basis'])

    def test_allowed_deploy_and_install_point_to_the_notice_command(self):
        self.allow_all()
        self.gate_record()
        for action in ('deploy-test', 'deploy-prod', 'install-host'):
            with self.subTest(action=action):
                verdict = self.check(action)
                self.assertIn('next_steps', verdict)
                steps = verdict['next_steps']
                for word in ('lat-preauth.py notice --text', 'event id', '--started', 'action',
                             'after-notice', 'record --kind auto', '--notice-before',
                             '--notice-after', 'lat-preauth.py now', '--controller-workspace'):
                    self.assertIn(word, steps)
                self.assertNotIn('--last 1', steps)
                result = self.run_tool('check', '--action', action)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines()[1], 'Next steps: ' + steps)

    def test_merge_and_ask_output_has_no_next_steps(self):
        self.allow_all()
        for action, extra in (('merge', ('--branch', 'dev')), ('install-host', ())):
            with self.subTest(action=action):
                verdict = self.check(action, *extra)
                self.assertNotIn('next_steps', verdict)
                result = self.run_tool('check', '--action', action, *extra)
                self.assertEqual(len(result.stdout.splitlines()), 1)
                self.assertNotIn('Next steps:', result.stdout)

    def test_deploy_and_install_check_the_gate(self):
        self.allow_all()
        self.gate_record(suites=SUITES[:1])
        head = git(self.repo, 'rev-parse', 'HEAD')
        for action in ('deploy-test', 'deploy-prod', 'install-host'):
            with self.subTest(action=action):
                self.assertEqual(self.check(action)['reasons'], [
                    f'no passing full-suite record for {head[:12]}: bun test (in web)'])

    def test_a_suite_with_depends_on_keeps_its_pass_until_its_paths_change(self):
        suites = [{'command': 'bun test', 'cwd': 'web', 'depends_on': ['lib/**']},
                  {'command': 'uv run pytest', 'cwd': 'api', 'depends_on': []}]
        for folder in ('web', 'api', 'lib', 'docs'):
            (self.repo / folder).mkdir()
        (self.repo / '.suite-gate.json').write_text(json.dumps({'full_suites': suites}))
        git(self.repo, 'add', '.suite-gate.json')
        self.commit('scoped suites', 'api/a.txt')
        self.allow_all()
        self.gate_record(suites=suites)
        docs = self.commit('docs only', 'docs/guide.md')
        lib = self.commit('library', 'lib/util.txt')
        for action in ('deploy-prod', 'install-host'):
            with self.subTest(action=action, change='docs'):
                git(self.repo, 'reset', '-q', '--hard', docs)
                verdict = self.check(action)
                self.assertEqual(verdict['verdict'], 'allow', verdict['reasons'])
            with self.subTest(action=action, change='lib'):
                git(self.repo, 'reset', '-q', '--hard', lib)
                self.assertEqual(self.check(action)['reasons'], [
                    f'no passing full-suite record for {lib[:12]}: bun test (in web)'])

    def test_deploy_commit_must_be_head(self):
        self.allow_all()
        self.gate_record()
        first = git(self.repo, 'rev-parse', 'HEAD')
        self.commit('later')
        self.gate_record()
        self.assertEqual(self.check('deploy-prod', '--commit', first)['reasons'],
                         [f'commit `{first}` is not HEAD'])

    def test_linked_worktree_asks(self):
        self.allow_all()
        linked = self.root / 'linked'
        git(self.repo, 'worktree', 'add', '-q', '-b', 'side', str(linked))
        reasons = self.check('install-host', cwd=linked)['reasons']
        self.assertIn(f'{linked} is not the main checkout', reasons)

    def test_head_off_the_integration_tip_asks(self):
        self.allow_all()
        git(self.repo, 'switch', '-q', '-c', 'side')
        (self.repo / 'b.txt').write_text('b\n')
        git(self.repo, 'add', 'b.txt')
        git(self.repo, 'commit', '-q', '-m', 'side')
        self.assertIn('HEAD is not the tip of integration branch `dev`',
                      self.check('deploy-prod')['reasons'])

    def test_unknown_integration_branch_asks(self):
        self.allow_all()
        self.session(integration=None)
        self.assertIn('integration branch unknown (the round ledger names none and no layer '
                      'sets integration_branch)', self.check('install-host')['reasons'])

    def test_integration_branch_setting_fills_a_null_ledger_value(self):
        self.allow_all()
        self.gate_record()
        self.session(integration=None)
        self.write(self.global_file, 'integration_branch = "main"\n' +
                   self.global_file.read_text())
        self.write(self.project_file, 'integration_branch = "dev"\n' +
                   self.project_file.read_text())
        verdict = self.check('install-host')
        self.assertEqual(verdict['verdict'], 'allow', verdict['reasons'])
        self.assertIn('integration branch `dev` from project integration_branch',
                      verdict['basis'])
        self.assertIn('  integration_branch = "dev"  ← project', self.run_tool('show').stdout)

    def test_ledger_integration_branch_wins_over_the_setting(self):
        self.allow_all()
        self.gate_record()
        self.write(self.project_file, 'integration_branch = "main"\n' +
                   self.project_file.read_text())
        verdict = self.check('install-host')
        self.assertEqual(verdict['verdict'], 'allow', verdict['reasons'])
        self.assertIn('integration branch `dev` from the round ledger', verdict['basis'])

    def test_integration_branch_setting_must_be_a_name(self):
        self.allow_all()
        self.write(self.project_file, 'integration_branch = ""\n')
        self.assertIn('integration_branch must be a branch name',
                      ' '.join(self.check('install-host')['reasons']))

    def test_deploy_test_needs_the_project_target(self):
        self.allow_all()
        self.write(self.project_file, '')
        self.write(self.global_file, '[actions.deploy-test]\nallow = true\ntarget = "x"\n')
        self.assertIn('the project layer does not set actions.deploy-test.target',
                      self.check('deploy-test')['reasons'])
        self.assertNotIn('target = "x"', self.run_tool('show').stdout)

    def test_show_and_check_name_the_project_target_over_the_global_one(self):
        self.allow_all()
        self.write(self.global_file, self.global_file.read_text().replace(
            '[actions.deploy-test]\n', '[actions.deploy-test]\ntarget = "production"\n'))
        self.assertIn('target="staging on :9000" from project [actions.deploy-test]',
                      self.check('deploy-test')['basis'])
        out = self.run_tool('show').stdout
        self.assertIn('    target = "staging on :9000"  ← project', out)
        self.assertNotIn('production', out)


class TimeWindowTests(PreauthCase):
    """`check` runs through a shim that freezes the tool's clock; the real clock is never read."""
    WINDOW = 'hours = "01:00-08:00"\ntimezone = "Asia/Taipei"\n'
    ALLOW = '[actions.merge]\nallow = true\nbranches = ["dev"]\n'

    def setUp(self):
        super().setUp()
        self.script = self.root / 'frozen-preauth.py'
        self.script.write_text(
            'from datetime import datetime\n'
            'import importlib.util, os\n'
            f'spec = importlib.util.spec_from_file_location("lat_preauth", {str(SCRIPT)!r})\n'
            'module = importlib.util.module_from_spec(spec)\n'
            'spec.loader.exec_module(module)\n'
            'module.current_time = lambda: datetime.fromisoformat(os.environ["FROZEN_NOW"])\n'
            'raise SystemExit(module.main())\n')

    def merge_at(self, moment, *extra):
        with patch.dict(os.environ, FROZEN_NOW=moment):
            return self.check('merge', '--branch', 'dev', *extra)

    def verdicts(self, cases):
        for moment, verdict in cases:
            with self.subTest(moment):
                self.assertEqual(self.merge_at(moment)['verdict'], verdict)

    def test_only_inside_the_window_allows_with_the_end_excluded(self):
        self.write(self.project_file, self.ALLOW + self.WINDOW)
        self.verdicts((('2026-10-30T00:59:59+08:00', 'ask'), ('2026-10-30T01:00:00+08:00', 'allow'),
                       ('2026-10-30T07:59:59+08:00', 'allow'), ('2026-10-30T08:00:00+08:00', 'ask')))

    def test_a_window_across_midnight_is_one_span_over_two_days(self):
        self.write(self.project_file, self.ALLOW
                   + 'hours = "22:00-06:00"\ntimezone = "Asia/Taipei"\n')
        self.verdicts((('2026-10-30T21:59:00+08:00', 'ask'), ('2026-10-30T22:00:00+08:00', 'allow'),
                       ('2026-10-30T23:59:00+08:00', 'allow'), ('2026-10-31T00:00:00+08:00', 'allow'),
                       ('2026-10-31T05:59:00+08:00', 'allow'), ('2026-10-31T06:00:00+08:00', 'ask')))

    def test_the_window_reads_the_configured_zone_not_the_clock_zone(self):
        self.write(self.project_file, self.ALLOW + self.WINDOW)
        self.verdicts((('2026-10-29T19:00:00+00:00', 'allow'), ('2026-10-30T03:00:00+00:00', 'ask')))

    def test_outside_is_a_condition_that_names_the_window_inside_goes_in_the_basis(self):
        self.write(self.project_file, self.ALLOW + self.WINDOW + 'source = "P-1"\n')
        window = ('actions.merge.hours 01:00-08:00 from project (source P-1), '
                  'timezone Asia/Taipei from project (source P-1)')
        verdict = self.merge_at('2026-10-30T09:30:00+08:00')
        self.assertEqual(verdict['reason_kinds'], ['condition'])
        self.assertEqual(verdict['reasons'], [f'now 09:30 is outside {window}'])
        verdict = self.merge_at('2026-10-30T03:00:00+08:00')
        self.assertIn(f'now 03:00 is inside {window}', verdict['basis'])

    def test_show_names_the_window(self):
        self.write(self.project_file, self.ALLOW + self.WINDOW)
        output = self.run_tool('show').stdout
        self.assertIn('hours = "01:00-08:00"  ← project', output)
        self.assertIn('timezone = "Asia/Taipei"  ← project', output)

    def test_a_bad_window_is_a_setting_error_even_at_a_time_it_would_cover(self):
        for settings, reason in (
                ('hours = "01:00-08:00"\n', 'no layer sets `timezone`'),
                ('timezone = "Asia/Taipei"\n', 'no layer sets `hours`'),
                ('hours = "01:00-08:00"\ntimezone = "Mars/Base"\n', '`timezone` must be'),
                ('hours = "01:00-08:00"\ntimezone = ""\n', '`timezone` must be'),
                ('hours = "01:00-08:00"\ntimezone = "localtime"\n', '`timezone` must be'),
                ('hours = "1:00-8:00"\ntimezone = "Asia/Taipei"\n', '`hours` must be'),
                ('hours = "01:00-24:00"\ntimezone = "Asia/Taipei"\n', '`hours` must be'),
                ('hours = "03:00-03:00"\ntimezone = "Asia/Taipei"\n', '`hours` must be'),
                ('hours = 1\ntimezone = "Asia/Taipei"\n', '`hours` must be a string')):
            with self.subTest(settings):
                self.write(self.project_file, self.ALLOW + settings)
                verdict = self.merge_at('2026-10-30T03:00:00+08:00')
                self.assertEqual(verdict['verdict'], 'ask')
                self.assertEqual(set(verdict['reason_kinds']), {'error'})
                self.assertTrue(any(reason in item for item in verdict['reasons']),
                                verdict['reasons'])

    def test_the_narrowest_window_wins_and_an_inherited_one_still_binds(self):
        self.write(self.global_file, self.ALLOW + self.WINDOW)
        self.write(self.project_file, '[actions.merge]\nallow = true\n')
        self.verdicts((('2026-10-30T03:00:00+08:00', 'allow'), ('2026-10-30T09:00:00+08:00', 'ask')))
        self.write(self.project_file, '[actions.merge]\nhours = "09:00-10:00"\n'
                                      'timezone = "Asia/Taipei"\n')
        self.verdicts((('2026-10-30T03:00:00+08:00', 'ask'), ('2026-10-30T09:00:00+08:00', 'allow')))

    def test_hours_and_timezone_resolve_key_by_key_and_each_names_its_layer(self):
        self.write(self.global_file, self.ALLOW + self.WINDOW)
        self.write(self.project_file, '[actions.merge]\nhours = "02:00-04:00"\n')
        self.verdicts((('2026-10-30T03:00:00+08:00', 'allow'), ('2026-10-30T01:30:00+08:00', 'ask')))
        self.assertIn('now 03:00 is inside actions.merge.hours 02:00-04:00 from project, '
                      'timezone Asia/Taipei from global',
                      self.merge_at('2026-10-30T03:00:00+08:00')['basis'])
        self.write(self.project_file, '[actions.merge]\ntimezone = "UTC"\n')
        self.verdicts((('2026-10-30T03:00:00+00:00', 'allow'), ('2026-10-30T03:00:00+08:00', 'ask')))

    def test_a_bad_value_in_a_wider_layer_is_still_a_setting_error(self):
        self.write(self.global_file, '[actions.merge]\ntimezone = "Mars/Base"\n')
        self.write(self.project_file, self.ALLOW + self.WINDOW)
        verdict = self.merge_at('2026-10-30T03:00:00+08:00')
        self.assertEqual(set(verdict['reason_kinds']), {'error'})

    def test_allow_false_stays_even_inside_the_window(self):
        self.write(self.project_file, '[actions.merge]\nallow = false\nbranches = ["dev"]\n'
                   + self.WINDOW)
        verdict = self.merge_at('2026-10-30T03:00:00+08:00')
        self.assertEqual(verdict['reason_kinds'], ['allow-false'])

    def test_inside_the_window_deploy_prod_keeps_its_fixed_conditions(self):
        git(self.repo, 'switch', '-q', '-c', 'side')
        self.commit('side work')
        self.session()
        self.write(self.project_file, '[actions.deploy-prod]\nallow = true\n' + self.WINDOW)
        with patch.dict(os.environ, FROZEN_NOW='2026-10-30T03:00:00+08:00'):
            verdict = self.check('deploy-prod')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('HEAD is not the tip of integration branch `dev`', verdict['reasons'])
        self.assertTrue(any('no passing full-suite record' in item for item in verdict['reasons']))


class NoticeCase(PreauthCase):
    """`notice` against a stub hcom that keeps its agents, sends and events in files."""
    TEXT = 'about to install the host skills'

    def setUp(self):
        super().setUp()
        self.session()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.agents = self.root / 'agents.json'
        self.mode = self.root / 'mode'
        self.events = self.root / 'events.jsonl'
        self.sends = self.root / 'sends.log'
        self.set_agents([{'name': 'orch'}, {'name': 'kela'}])
        self.mode.write_text('ok')
        self.events.write_text('')
        hcom = self.bin / 'hcom'
        hcom.write_text(f'#!{sys.executable}\n' + (
            'import datetime, json, sys\n'
            f'agents, mode = open({str(self.agents)!r}).read(), open({str(self.mode)!r}).read()\n'
            'if sys.argv[1] == "list":\n'
            '    if agents == "FAIL": sys.exit(1)\n'
            '    print(agents); sys.exit()\n'
            'if sys.argv[1] == "send":\n'
            f'    open({str(self.sends)!r}, "a").write(json.dumps(sys.argv[2:]) + "\\n")\n'
            '    if mode == "fail": print("No active agent for @kela", file=sys.stderr); sys.exit(1)\n'
            '    args = sys.argv[2:]\n'
            '    text = args[args.index("--") + 1]\n'
            '    to = [a[1:] for a in args if a.startswith("@")]\n'
            '    count = {"dup": 2, "silent": 0}.get(mode, 1)\n'
            f'    with open({str(self.events)!r}, "a") as out:\n'
            '        for _ in range(count):\n'
            '            out.write(json.dumps(dict(id=500 + len(open(' + repr(str(self.events)) + ').read().splitlines()),'
            ' type="message", ts=datetime.datetime.now(datetime.timezone.utc).isoformat(),'
            ' data={"from": "orch", "mentions": to, "delivered_to": to, "scope": "mentions", "text": text})) + "\\n")\n'
            '    sys.exit()\n'
            'if sys.argv[1] == "events": sys.stdout.write(open(' + repr(str(self.events)) + ').read())\n'))
        hcom.chmod(0o755)

    def set_agents(self, agents):
        self.agents.write_text(agents if isinstance(agents, str) else json.dumps(agents))

    def other_sessions(self, *rows):
        for name, status in rows:
            self.write(self.sessions / f'{name}-session.json',
                       json.dumps(dict(status=status, hcom_name=name)))

    def notice(self, *extra, text=None):
        return self.run_tool('notice', '--text', text or self.TEXT, *extra,
                             path=f'{self.bin}:{os.environ["PATH"]}')

    def sent(self):
        return [json.loads(line) for line in self.sends.read_text().splitlines()] \
            if self.sends.exists() else []


class NoticeTests(NoticeCase):
    def test_sends_to_live_controllers_and_prints_the_event_id_of_this_message(self):
        self.other_sessions(('kela', 'active'), ('old', 'ended'))
        self.events.write_text(json.dumps(dict(
            id=7, type='message', ts='2020-01-01T00:00:00+00:00',
            data={'from': 'orch', 'mentions': ['kela'], 'delivered_to': ['kela'], 'scope': 'mentions',
                  'text': self.TEXT})) + '\n')  # an older, identical message
        result = self.notice()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '501\n')
        self.assertEqual(self.sent(), [['@kela', '--intent', 'inform', '--name', 'orch', '--',
                                        self.TEXT]])

    def test_tagged_controller_sends_as_its_name_and_matches_its_base_name(self):
        self.session(hcom_name='tag-orch')
        self.other_sessions(('tag-kela', 'active'))
        self.set_agents([{'name': 'tag-orch', 'base_name': 'orch'},
                         {'name': 'tag-kela', 'base_name': 'kela'}])
        result = self.notice()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sent()[0][:5], ['@tag-kela', '--intent', 'inform', '--name',
                                              'tag-orch'])

    def test_to_names_the_recipients(self):
        result = self.notice('--to', 'kela')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sent(), [['@kela', '--intent', 'inform', '--name', 'orch', '--',
                                        self.TEXT]])

    def test_a_named_recipient_not_live_fails_without_a_partial_send(self):
        result = self.notice('--to', 'kela', 'gone')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('not live on HCOM: gone', result.stderr)
        self.assertEqual(self.sent(), [])

    def test_recorded_controllers_hcom_no_longer_has_are_skipped(self):
        self.other_sessions(('kela', 'active'), ('vuho', 'active'))
        result = self.notice()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('not sent to vuho', result.stderr)
        self.assertEqual(self.sent()[0][0], '@kela')

    def test_no_other_live_controller_sends_nothing_and_prints_a_none_id(self):
        self.other_sessions(('vuho', 'active'))  # recorded, but HCOM no longer has it
        result = self.notice()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'none-1\n')
        self.assertIn('no other live controller to notify', result.stderr)
        self.assertIn('vuho', result.stderr)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.notice().stdout, 'none-2\n')
        [first, _] = [json.loads(line) for line in next(
            (self.repo / '.lat' / 'preauth-records').glob('*-no-recipient.jsonl')
        ).read_text().splitlines()]
        self.assertEqual((first['sender'], first['recorded'], first['not_live']),
                         ('orch', ['vuho'], ['vuho']))

    def test_a_malformed_agent_list_is_not_taken_as_no_one_live(self):
        self.other_sessions(('kela', 'active'))
        for agents in ([None, {}], [{}], [{'name': None}], [{'name': ''}]):
            with self.subTest(agents=agents):
                self.set_agents(json.dumps(agents))
                result = self.notice()
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
                self.assertIn('malformed agent list', result.stderr)

    def test_a_named_recipient_that_is_not_live_still_fails(self):
        self.other_sessions(('vuho', 'active'))
        result = self.notice('--to', 'vuho')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertEqual(self.sent(), [])

    def test_naming_only_a_gone_agent_or_yourself_fails(self):
        for names in (['gone'], ['orch']):
            with self.subTest(names=names):
                result = self.notice('--to', *names)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, '')
        self.assertEqual(self.sent(), [])

    def test_hcom_send_failure_fails_without_an_id(self):
        self.other_sessions(('kela', 'active'))
        self.mode.write_text('fail')
        result = self.notice()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        self.assertIn('No active agent for @kela', result.stderr)

    def test_a_send_that_left_no_event_fails_even_with_an_older_identical_message(self):
        self.other_sessions(('kela', 'active'))
        self.mode.write_text('silent')
        self.events.write_text(json.dumps(dict(
            id=7, type='message', ts='2020-01-01T00:00:00+00:00',
            data={'from': 'orch', 'mentions': ['kela'], 'delivered_to': ['kela'], 'scope': 'mentions',
                  'text': self.TEXT})) + '\n')
        result = self.notice()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('not found in hcom events', result.stderr)

    def test_two_identical_new_messages_are_ambiguous(self):
        self.other_sessions(('kela', 'active'))
        self.mode.write_text('dup')
        result = self.notice()
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, '')
        self.assertIn('cannot tell which', result.stderr)

    def test_unreadable_hcom_or_unknown_sender_fails(self):
        self.other_sessions(('kela', 'active'))
        for agents in ('FAIL', json.dumps({'error': 'x'})):
            with self.subTest(agents=agents):
                self.set_agents(agents)
                result = self.notice()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
        self.set_agents([{'name': 'orch'}, {'name': 'kela'}])
        self.session(hcom_name='')
        result = self.notice()
        self.assertEqual(result.returncode, 1)
        self.assertIn('sender is unknown', result.stderr)
        self.assertEqual(self.sent(), [])

    def test_empty_text_fails(self):
        self.other_sessions(('kela', 'active'))
        result = self.notice(text='  ')
        self.assertEqual(result.returncode, 1)
        self.assertEqual(self.sent(), [])


@unittest.skipUnless(INSTALLER.is_file(), 'needs the repo copy of scripts/install-skills.py')
class CrossRepoTests(NoticeCase):
    """The controller's session lives in repo A (self.repo); the action happens in repo B."""
    STARTED = '2026-10-25T10:05:00+00:00'

    def setUp(self):
        super().setUp()
        self.other = self.root / 'other'
        self.other.mkdir()
        git(self.other, 'init', '-q', '-b', 'dev')
        git(self.other, 'config', 'user.email', 't@example.com')
        git(self.other, 'config', 'user.name', 'T')
        git(self.other, 'commit', '-q', '--allow-empty', '-m', 'first')
        self.other_records = self.other / '.lat' / 'preauth-records'
        self.cross = ('--workspace', str(self.other), '--controller-workspace', str(self.repo))
        self.records_file = self.repo / '.lat' / 'preauth-records' / f'{SESSION}-r1.jsonl'

    def tool(self, *args, **kwargs):
        return self.run_tool(*args, path=f'{self.bin}:{os.environ["PATH"]}', **kwargs)

    def in_other(self, name, status='active', stem=None):
        self.write(self.other / '.lat' / 'sessions' / f'{stem or name + "-session"}.json',
                   json.dumps(dict(status=status, hcom_name=name)))

    def record_merge(self, *extra):
        return self.tool('record', '--action', 'merge', '--branch', 'dev', '--commit', 'abc123',
                         '--basis', 'allow merge dev', '--result', 'succeeded', *extra)

    def install_flow(self, *flags, **kwargs):
        """Before-notice, `now`, after-notice, record: the steps of a sub-second action."""
        before = self.tool('notice', '--text', 'before', *flags, **kwargs)
        self.assertEqual(before.returncode, 0, before.stderr)
        started = self.tool('now')
        self.assertEqual(started.returncode, 0, started.stderr)
        after = self.tool('notice', '--text', 'after', *flags, **kwargs)
        self.assertEqual(after.returncode, 0, after.stderr)
        return self.record_install(started.stdout.strip(), before.stdout.strip(),
                                   after.stdout.strip(), *flags, **kwargs)

    def record_install(self, started, before, after, *flags, **kwargs):
        return self.tool('record', '--action', 'install-host', '--commit', 'abc123', '--basis',
                         'allow install-host', '--result', 'succeeded', '--started', started,
                         '--notice-before', before, '--notice-after', after, *flags, **kwargs)

    def entries(self):
        return [json.loads(line) for line in self.records_file.read_text().splitlines()]

    def test_without_the_controller_workspace_a_foreign_repo_is_refused_with_the_way_out(self):
        for label, result in (
                ('notice', self.tool('notice', '--text', 'x', '--workspace', str(self.other))),
                ('record', self.record_merge('--workspace', str(self.other))),
                ('report', self.tool('report', '--workspace', str(self.other)))):
            with self.subTest(label):
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn('--controller-workspace', result.stderr)
        self.assertEqual(self.sent(), [])
        self.assertFalse(self.other_records.exists())

    def test_check_notice_record_and_report_all_work_across_repos(self):
        self.write(self.other / '.lat' / 'preauth.toml',
                   '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        self.assertEqual(self.check('merge', '--branch', 'dev', '--workspace',
                                    str(self.other))['verdict'], 'allow')
        notice = self.tool('notice', '--text', self.TEXT, *self.cross)
        self.assertEqual(notice.returncode, 0, notice.stderr)
        result = self.record_merge(*self.cross)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([entry.get('action_repo') for entry in self.entries()], [str(self.other)])
        self.assertFalse(self.other_records.exists())
        for flags in ((), self.cross):
            with self.subTest(flags=flags):
                report = self.tool('report', *flags)
                self.assertEqual(report.returncode, 0, report.stderr)
                self.assertIn(f'merge dev abc123（動作在 {self.other}）：succeeded', report.stdout)

    def test_a_push_in_another_repo_still_asks_because_the_round_ledger_is_not_there(self):
        self.write(self.other / '.lat' / 'preauth.toml',
                   '[actions.push]\nallow = true\nbranches = ["dev"]\n')
        verdict = self.check('push', '--branch', 'dev', '--workspace', str(self.other))
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('no active round ledger', ' '.join(verdict['reasons']))

    def test_identity_comes_from_the_controller_and_recipients_cover_both_repos(self):
        self.other_sessions(('kela', 'active'))
        self.in_other('zono')
        self.in_other('gone', status='ended')
        self.in_other('orch')  # the same controller's older record in B
        self.in_other('fake', stem=SESSION)  # B must not decide who this session is
        self.set_agents([{'name': 'orch'}, {'name': 'kela'}, {'name': 'zono'}, {'name': 'fake'}])
        result = self.tool('notice', '--text', self.TEXT, *self.cross)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sent(), [['@kela', '@zono', '--intent', 'inform', '--name', 'orch',
                                        '--', self.TEXT]])

    def test_no_one_to_notify_is_logged_with_the_controller_and_accepted_by_record(self):
        result = self.install_flow(*self.cross)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sent(), [])
        self.assertTrue((self.repo / '.lat' / 'preauth-records' /
                         f'{SESSION}-r1-no-recipient.jsonl').is_file())
        self.assertFalse(self.other_records.exists())
        self.assertEqual(self.entries()[0]['action_repo'], str(self.other))

    def test_the_action_repo_defaults_to_the_current_directory(self):
        result = self.tool('record', '--action', 'merge', '--branch', 'dev', '--commit', 'abc123',
                           '--basis', 'x', '--result', 'succeeded', '--controller-workspace',
                           str(self.repo), cwd=self.other)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entries()[0]['action_repo'], str(self.other))

    def test_a_workspace_outside_git_is_refused_before_anything_is_sent(self):
        self.other_sessions(('kela', 'active'))
        outside = self.root / 'plain'
        outside.mkdir()
        flags = ('--workspace', str(outside), '--controller-workspace', str(self.repo))
        for label, result in (('notice', self.tool('notice', '--text', 'x', *flags)),
                              ('record', self.record_merge(*flags))):
            with self.subTest(label):
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn('not in a Git repository', result.stderr)
        self.assertEqual(self.sent(), [])
        self.assertFalse(self.records_file.exists())

    def test_the_same_repo_keeps_the_single_repo_record(self):
        linked = self.root / 'linked'
        git(self.repo, 'worktree', 'add', '-q', '-b', 'side', str(linked))
        cases = (('no flag', ()),
                 ('flag names the same repo', ('--controller-workspace', str(self.repo))),
                 ('a worktree of the controller repo',
                  ('--workspace', str(linked), '--controller-workspace', str(self.repo))))
        for label, flags in cases:
            with self.subTest(label):
                self.records_file.unlink(missing_ok=True)
                result = self.record_merge(*flags)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(set(self.entries()[0]),
                                 {'at', 'kind', 'action', 'target', 'commit', 'basis', 'result'})
                self.assertNotIn('動作在', self.tool('report').stdout)

    def test_an_action_in_a_worktree_of_the_other_repo_records_its_main_checkout(self):
        linked = self.root / 'other-linked'
        git(self.other, 'worktree', 'add', '-q', '-b', 'side', str(linked))
        result = self.record_merge('--workspace', str(linked), '--controller-workspace',
                                   str(self.repo))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.entries()[0]['action_repo'], str(self.other))

    def test_older_records_still_read(self):
        self.write(self.records_file, json.dumps(dict(
            at='2026-10-25T10:00:00+00:00', kind='auto', action='merge', target='dev',
            commit='abc123', basis='allow merge dev', result='succeeded')) + '\n')
        report = self.tool('report')
        self.assertEqual(report.returncode, 0, report.stderr)
        self.assertIn('- merge dev abc123：succeeded；依據：allow merge dev', report.stdout)

    def test_now_prints_microseconds_and_a_time_zone(self):
        printed = self.tool('now').stdout.strip()
        self.assertRegex(printed, r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}[+-]\d\d:\d\d$')

    def test_a_sub_second_action_records_with_now(self):
        self.other_sessions(('kela', 'active'))
        with self.subTest('same repo'):
            result = self.install_flow()
            self.assertEqual(result.returncode, 0, result.stderr)
        with self.subTest('across repos'):
            result = self.install_flow(*self.cross)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.entries()), 2)

    def test_notice_order_is_still_checked_against_now(self):
        self.other_sessions(('kela', 'active'))
        first = self.tool('notice', '--text', 'first').stdout.strip()
        between = self.tool('now').stdout.strip()
        second = self.tool('notice', '--text', 'second').stdout.strip()
        late = self.tool('now').stdout.strip()
        for label, started, before, after, reason in (
                ('before-notice after the start', between, second, second,
                 'later than --started'),
                ('after-notice before the start', late, first, second, 'is not later than --started'),
                ('after-notice not after before-notice', between, first, first,
                 'is not later than before notice')):
            with self.subTest(label):
                result = self.record_install(started, before, after)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(reason, result.stderr)
        self.assertFalse(self.records_file.exists())


class InstallHostGateTests(PreauthCase):
    """install-host counts only the full suites inside the skill folders the installer would
    install, judged by the installer's own code, so both give the same answer."""
    SKILL = 'skills/local/alpha'
    SKILL_SUITES = [{'command': 'uv run pytest', 'cwd': 'skills/local/alpha'},
                    {'command': 'bun test', 'cwd': 'board'}]

    def setUp(self):
        super().setUp()
        self.write(self.repo / self.SKILL / 'SKILL.md', '---\nname: alpha\ndescription: x\n---\n')
        self.write(self.repo / 'skills/matt/beta/SKILL.md', '---\nname: beta\ndescription: x\n---\n')
        self.write(self.repo / 'board/app.js', 'app\n')
        self.write(self.repo / 'scripts/install-skills.py', INSTALLER.read_text())
        self.write(self.repo / 'skills/local/three-tier-testing/scripts/suite-gate.py',
                   SUITE_GATE.read_text())
        self.write(self.repo / '.gitignore', '.lat/\n__pycache__/\n')
        (self.repo / '.suite-gate.json').write_text(json.dumps({'full_suites': self.SKILL_SUITES}))
        git(self.repo, 'add', '-A')
        git(self.repo, 'commit', '-q', '-m', 'skills')
        self.write(self.global_file, '[actions.install-host]\nallow = true\n')
        self.session()
        bunx = self.root / 'bin' / 'bunx'
        self.write(bunx, '#!/bin/sh\nexit 0\n')
        bunx.chmod(0o755)

    def folder_record(self, suite, passed=True):
        """A gate record of suite run on the repo's HEAD content, as the gate writes it."""
        gate = load_suite_gate()
        tree = gate.content_tree(self.repo, commit=git(self.repo, 'rev-parse', 'HEAD'))
        self.gate_state.mkdir(exist_ok=True)
        with open(self.gate_state / 'ledger.jsonl', 'a') as ledger:
            ledger.write(json.dumps({'fingerprint': 'f' + tree, 'tree': tree,
                                     'command': suite['command'], 'rel_cwd': suite['cwd'],
                                     'reusable': passed, 'content_changed': False}) + '\n')

    def install(self):
        environment = dict(GIT_ENV, SUITE_GATE_STATE_DIR=str(self.gate_state),
                           PATH=f"{self.root / 'bin'}{os.pathsep}{os.environ['PATH']}")
        return subprocess.run([sys.executable, str(self.repo / 'scripts/install-skills.py')],
                              cwd=self.repo, env=environment, capture_output=True, text=True,
                              timeout=60)

    def test_a_board_suite_without_a_pass_does_not_ask(self):
        self.folder_record(self.SKILL_SUITES[0])
        verdict = self.check('install-host')
        self.assertEqual(verdict['verdict'], 'allow', verdict['reasons'])
        head = git(self.repo, 'rev-parse', 'HEAD')
        self.assertIn(f'every full suite in the 2 skill folders passed for {head[:12]}',
                      verdict['basis'])
        self.assertEqual(self.install().returncode, 0)
        with self.subTest('push still needs every registered suite'):
            self.write(self.global_file, self.global_file.read_text() +
                       '[actions.push]\nallow = true\nbranches = ["dev"]\n')
            self.assertIn(f'no passing full-suite record for {head[:12]}: bun test (in board)',
                          self.check('push', '--branch', 'dev')['reasons'])

    def test_a_skill_suite_without_a_pass_asks_and_names_it(self):
        head = git(self.repo, 'rev-parse', 'HEAD')
        for passed, why in ((None, 'no run of this content'),
                            (False, 'the latest run of this content failed')):
            with self.subTest(why=why):
                if passed is not None:
                    self.folder_record(self.SKILL_SUITES[0], passed=passed)
                self.folder_record(self.SKILL_SUITES[1])
                self.assertEqual(self.check('install-host')['reasons'], [
                    f'no passing full-suite record for {head[:12]}: uv run pytest '
                    f'(in {self.SKILL}; skill folder {self.SKILL}: {why})'])
                result = self.install()
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn(f'  alpha: {self.SKILL}: uv run pytest ({why})', result.stderr)

    def test_changes_outside_the_skill_folders_keep_the_pass(self):
        self.folder_record(self.SKILL_SUITES[0])
        self.commit('board change', 'board/app.js')
        self.assertEqual(self.check('install-host')['verdict'], 'allow')
        self.assertEqual(self.install().returncode, 0)
        changed = self.commit('skill change', f'{self.SKILL}/notes.md')
        self.assertIn(f'no passing full-suite record for {changed[:12]}: uv run pytest',
                      self.check('install-host')['reasons'][0])
        self.assertEqual(self.install().returncode, 1)


class PushTests(PreauthCase):
    """Push: listed branch, every full suite passed, unpushed commits only of this round."""

    def setUp(self):
        super().setUp()
        remote = self.root / 'remote.git'
        git(self.root, 'init', '-q', '--bare', str(remote))
        git(self.repo, 'remote', 'add', 'origin', str(remote))
        git(self.repo, 'push', '-q', 'origin', 'dev')
        self.write(self.global_file, '[actions.push]\nallow = true\nbranches = ["dev"]\n')
        self.session(tickets=('313', 'ouob-tw/LoopAgentTeams-work#314'))

    def test_listed_branch_passing_gate_and_round_commits_allow(self):
        self.commit('feat(lat): gate check (#313)')
        sha = self.commit('fix(lat): edge (ouob-tw/LoopAgentTeams-work#314)', 'c.txt')
        self.gate_record()
        result = self.run_tool('check', '--action', 'push', '--branch', 'dev')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('allow push dev — basis: ', result.stdout)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertNotIn('next_steps', self.check('push', '--branch', 'dev'))
        self.assertIn(f'every unpushed commit of {sha[:12]} references only tickets of the '
                      'round ledger', result.stdout)
        self.assertIn(f'every registered full suite passed for {sha[:12]}', result.stdout)

    def test_missing_failed_or_stale_gate_records_ask_and_name_the_suite(self):
        first = self.commit('feat(lat): one (#313)')
        missing = f'no passing full-suite record for {first[:12]}: '
        with self.subTest('no record'):
            self.assertEqual(self.check('push', '--branch', 'dev')['reasons'], [
                missing + 'uv run pytest (in .)', missing + 'bun test (in web)'])
        with self.subTest('one suite missing'):
            self.gate_record(suites=SUITES[:1])
            self.assertEqual(self.check('push', '--branch', 'dev')['reasons'],
                             [missing + 'bun test (in web)'])
        with self.subTest('only a failed record'):
            self.gate_record(suites=SUITES[1:], passed=False)
            self.assertEqual(self.check('push', '--branch', 'dev')['reasons'],
                             [missing + 'bun test (in web)'])
        with self.subTest('content changed after the records'):
            self.gate_record(suites=SUITES[1:])
            self.assertEqual(self.check('push', '--branch', 'dev')['verdict'], 'allow')
            second = self.commit('feat(lat): two (#313)', 'c.txt')
            self.assertEqual(len(self.check('push', '--branch', 'dev')['reasons']), 2)
            self.assertIn(f'no passing full-suite record for {second[:12]}: uv run pytest',
                          self.check('push', '--branch', 'dev')['reasons'][0])

    def test_a_scoped_suite_pass_counts_for_a_push_until_its_paths_change(self):
        suites = [{'command': 'bun test', 'cwd': 'web', 'depends_on': []}]
        (self.repo / 'web').mkdir()
        (self.repo / '.suite-gate.json').write_text(json.dumps({'full_suites': suites}))
        git(self.repo, 'add', '.suite-gate.json')
        self.commit('feat(web): scoped (#313)', 'web/a.txt')
        self.gate_record(suites=suites)
        self.commit('docs: elsewhere (#313)', 'c.txt')
        self.assertEqual(self.check('push', '--branch', 'dev')['verdict'], 'allow')
        web = self.commit('fix(web): change (#313)', 'web/a.txt')
        self.assertEqual(self.check('push', '--branch', 'dev')['reasons'],
                         [f'no passing full-suite record for {web[:12]}: bun test (in web)'])

    def test_commits_outside_the_round_ask_and_are_listed(self):
        own = self.commit('feat(lat): mine (#313)')
        bare = self.commit('chore: tidy', 'c.txt')
        other = self.commit('feat: theirs (#999)', 'd.txt')
        mixed = self.commit('fix: both #313 and other/repo#42', 'e.txt')
        self.gate_record()
        reasons = self.check('push', '--branch', 'dev')['reasons']
        self.assertEqual(len(reasons), 1, reasons)
        self.assertTrue(reasons[0].startswith(
            "unpushed commits outside this round's tickets (#313, ouob-tw/loopagentteams-work#314): "),
            reasons[0])
        self.assertIn(f'{bare[:12]} "chore: tidy" (no ticket)', reasons[0])
        self.assertIn(f'{other[:12]} "feat: theirs (#999)" (#999)', reasons[0])
        self.assertIn(f'{mixed[:12]} "fix: both #313 and other/repo#42" (other/repo#42)',
                      reasons[0])
        self.assertNotIn(own[:12], reasons[0])

    def test_same_number_in_another_repo_is_not_a_round_ticket(self):
        self.session(tickets=('ouob-tw/LoopAgentTeams-work#313', '314'))
        own = self.commit('feat: mine (ouob-tw/LoopAgentTeams-work#313)')
        bare = self.commit('feat: bare (#313)', 'c.txt')
        other = self.commit('feat: theirs (someone/else#313)', 'd.txt')
        loose = self.commit('feat: theirs too (someone/else#314)', 'e.txt')
        self.gate_record()
        reasons = self.check('push', '--branch', 'dev')['reasons']
        self.assertEqual(len(reasons), 1, reasons)
        self.assertIn(f'{other[:12]} "feat: theirs (someone/else#313)" (someone/else#313)',
                      reasons[0])
        self.assertIn(f'{loose[:12]} "feat: theirs too (someone/else#314)" '
                      '(someone/else#314)', reasons[0])
        self.assertNotIn(own[:12], reasons[0])
        self.assertNotIn(bare[:12], reasons[0])

    def test_a_bare_ledger_number_takes_the_own_tracker_beside_another_repos_row(self):
        self.session(tickets=('370', 'ouob-tw/bw-broker-work#7'))
        own = self.commit('fix: mine (ouob-tw/LoopAgentTeams-work#370)')
        other = self.commit('fix: theirs (ouob-tw/other-repo#370)', 'c.txt')
        self.gate_record()
        tracker = self.repo / 'docs/agents/issue-tracker.md'
        prs = ('- **Read a PR**: `gh pr view <number> -R ouob-tw/LoopAgentTeams --comments`\n'
               '- **Close**: `gh pr close`, each with `-R ouob-tw/LoopAgentTeams`.\n')
        cases = {'tracker doc names the repo':
                 'Use `gh` and **always pass `-R ouob-tw/other-repo`**.\n'
                 '- **Read**: `gh issue view <number> -R ouob-tw/LoopAgentTeams-work --json x`\n'
                 '- **Close**: `gh issue close <n> -R ouob-tw/loopagentteams-work`\n' + prs,
                 'no tracker doc': None,
                 'tracker doc has no gh issue -R':
                 '**always pass `-R ouob-tw/LoopAgentTeams-work`**\n' + prs,
                 'tracker doc names two repos': '`gh issue view 1 -R ouob-tw/LoopAgentTeams-work`\n'
                 '`gh issue list -R a/b`\n'}
        for case, text in cases.items():
            with self.subTest(case):
                if text is None:
                    tracker.unlink(missing_ok=True)
                else:
                    self.write(tracker, text)
                reasons = self.check('push', '--branch', 'dev')['reasons']
                self.assertEqual(len(reasons), 1, reasons)
                self.assertIn(f'{other[:12]} "fix: theirs (ouob-tw/other-repo#370)"', reasons[0])
                if case == 'tracker doc names the repo':
                    self.assertNotIn(own[:12], reasons[0])
                else:  # the own tracker is unknown, so nothing loosens
                    self.assertIn(f'{own[:12]} "fix: mine (ouob-tw/LoopAgentTeams-work#370)"',
                                  reasons[0])

    def test_commits_the_remote_has_are_not_listed(self):
        self.commit('chore: no ticket but pushed')
        git(self.repo, 'push', '-q', 'origin', 'dev')
        self.commit('feat(lat): mine (#313)', 'c.txt')
        self.gate_record()
        self.assertEqual(self.check('push', '--branch', 'dev')['verdict'], 'allow')

    def test_without_a_round_ledger_push_asks(self):
        self.commit('feat(lat): mine (#313)')
        self.gate_record()
        self.session(status='ended')
        self.assertIn('no active round ledger to tell whose tickets the unpushed commits '
                      'belong to', self.check('push', '--branch', 'dev')['reasons'])

    def test_unresolvable_version_and_missing_registry_ask(self):
        self.assertIn('cannot resolve the version to push (`nope`)',
                      self.check('push', '--branch', 'dev', '--commit', 'nope')['reasons'])
        with self.subTest('non-object gate record lines are skipped'):
            self.commit('feat(lat): mine (#313)')
            self.gate_state.mkdir(exist_ok=True)
            (self.gate_state / 'ledger.jsonl').write_text('null\n[1]\n')
            self.assertEqual(len(self.check('push', '--branch', 'dev')['reasons']), 2)
            self.gate_record()
            self.assertEqual(self.check('push', '--branch', 'dev')['verdict'], 'allow')
        (self.repo / '.suite-gate.json').unlink()
        self.assertIn('full-suite gate check failed: full_suites must list',
                      ' '.join(self.check('push', '--branch', 'dev')['reasons']))


ANSWER = ('## 答覆（r1，面板，{time}）\n\n- 題目：{id} r1\n- 答覆：A. 可以\n'
          '- 來源：面板，/x/panel-journal.jsonl 第 3 行，time {time}\n')


class WriteCase(PreauthCase):
    def setUp(self):
        super().setUp()
        self.session()
        self.decisions = self.repo / '.lat' / 'decisions'

    def decision(self, identifier, grants=(), *, status='answered', answer=True):
        text = f'# Q\n- version: r1\n- status: {status}\n- session: {SESSION}\n'
        text += '\n## 問題與選項\n'
        text += '- grant: global push allow=true branches=dev\n'  # outside the approved scope
        if answer:
            text += '\n' + ANSWER.format(time='2026-10-25T00:30:34+08:00', id=identifier)
        text += '\n## 核准範圍（主控判斷）\n使用者同意。\n' + ''.join(f'{g}\n' for g in grants)
        self.write(self.decisions / f'{identifier}.md', text)

    def grant(self, *args):
        return self.run_tool('grant', *args)

    def records(self):
        path = self.repo / '.lat' / 'preauth-records' / f'{SESSION}-r1.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


class GrantTests(WriteCase):
    def test_refusals_leave_every_file_unchanged(self):
        self.write(self.project_file, '# mine\n[actions.push]\nallow = false\n')
        before = self.project_file.read_bytes()
        args = ('--layer', 'project', '--action', 'push', '--allow', 'true',
                '--branches', 'dev', '--source', 'D-1')
        line = '- grant: project push allow=true branches=dev'
        for label, kwargs, reason in (
                ('no human answer', dict(grants=[line], status='pending', answer=False),
                 'status is pending'),
                ('answered without a source line', dict(grants=[line], answer=False),
                 'no answer section'),
                ('no grant line', dict(), 'has no `- grant:` line'),
                ('grant line differs', dict(grants=['- grant: project push allow=true '
                                                    'branches=main']),
                 'no `- grant:` line matches'),
                ('grant names another layer', dict(grants=['- grant: global push allow=true '
                                                           'branches=dev']),
                 'no `- grant:` line matches')):
            with self.subTest(label):
                self.decision('D-1', **kwargs)
                result = self.grant(*args)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn('refused, nothing changed', result.stderr)
                self.assertIn(reason, result.stderr)
                self.assertEqual(self.project_file.read_bytes(), before)
                self.assertEqual(self.records(), [])
        with self.subTest('missing record'):
            self.assertIn('not found', self.grant('--layer', 'project', '--action', 'push',
                                                  '--allow', 'true', '--source', 'D-9').stderr)

    def test_project_grant_writes_the_rule_with_its_source(self):
        self.decision('D-2', ['- grant: project push allow=true branches=dev'])
        result = self.grant('--layer', 'project', '--action', 'push', '--allow', 'true',
                            '--branches', 'dev', '--source', 'D-2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.project_file.read_text(),
                         '[actions.push]\nallow = true\nbranches = ["dev"]\nsource = "D-2"\n')
        self.assertIn('    allow = true  ← project (source D-2)', self.run_tool('show').stdout)
        self.assertEqual([(r['kind'], r['grant'], r['source']) for r in self.records()],
                         [('grant', 'project push allow=true branches=dev', 'D-2')])

    def test_global_grant_keeps_hand_written_comments_and_sections(self):
        original = ('# my settings, keep me\nversion = 1\n\n'
                    '[actions.merge]  # merges\nallow = true # yes\n'
                    'branches = [\n  "dev",  # only dev\n]\nsource = "OLD"\n\n'
                    '# about pushes\n[actions.push]\nallow = false\n\n'
                    '[advisor]\nextended = true\nmust_ask = ["money"]  # never\n')
        self.write(self.global_file, original)
        self.decision('D-3', ['- grant: global merge branches=dev,release'])
        result = self.grant('--layer', 'global', '--action', 'merge', '--branches', 'dev',
                            'release', '--source', 'D-3')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.global_file.read_text(), original.replace(
            'branches = [\n  "dev",  # only dev\n]\nsource = "OLD"\n',
            '# only dev\nbranches = ["dev", "release"]\nsource = "D-3"\n'))
        self.decision('D-4', ['- grant: global deploy-prod allow=false'])
        self.assertEqual(self.grant('--layer', 'global', '--action', 'deploy-prod', '--allow',
                                    'false', '--source', 'D-4').returncode, 0)
        text = self.global_file.read_text()
        self.assertTrue(text.startswith(original.replace(
            'branches = [\n  "dev",  # only dev\n]\nsource = "OLD"\n',
            '# only dev\nbranches = ["dev", "release"]\nsource = "D-3"\n')))
        self.assertTrue(text.endswith('\n[actions.deploy-prod]\nallow = false\nsource = "D-4"\n'))

    def test_quoted_keys_and_a_missing_final_newline_are_edited_in_place(self):
        self.write(self.project_file, '[ actions."push" ]\n"allow" = false\nbranches = ["dev"]')
        self.decision('D-8', ['- grant: project push allow=true'])
        result = self.grant('--layer', 'project', '--action', 'push', '--allow', 'true',
                            '--source', 'D-8')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.project_file.read_text(), '[ actions."push" ]\nallow = true\n'
                         'branches = ["dev"]\nsource = "D-8"\n')

    def test_grant_that_cannot_be_logged_is_undone(self):
        self.write(self.project_file, '# mine\n[actions.push]\nallow = false\n')
        before = self.project_file.read_bytes()
        self.write(self.repo / '.lat' / 'preauth-records', 'not a directory')
        self.decision('D-9', ['- grant: project push allow=true'])
        result = self.grant('--layer', 'project', '--action', 'push', '--allow', 'true',
                            '--source', 'D-9')
        self.assertEqual(result.returncode, 2)
        self.assertIn('was restored', result.stderr)
        self.assertEqual(self.project_file.read_bytes(), before)
        self.decision('D-9', ['- grant: global push allow=true'])
        result = self.grant('--layer', 'global', '--action', 'push', '--allow', 'true',
                            '--source', 'D-9')
        self.assertIn('was restored', result.stderr)
        self.assertFalse(self.global_file.exists())

    def test_grant_waits_for_deactivate_and_then_refuses(self):
        self.decision('D-10', ['- grant: project merge allow=true'])
        lock = self.repo / '.lat' / 'watch' / f'{SESSION}.lock'
        lock.parent.mkdir(parents=True)
        with lock.open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            process = self.run_tool('grant', '--layer', 'project', '--action', 'merge',
                                    '--allow', 'true', '--source', 'D-10', wait=False)
            self.addCleanup(process.kill)
            with self.assertRaises(subprocess.TimeoutExpired):
                process.wait(timeout=1)
            record = json.loads((self.sessions / f'{SESSION}.json').read_text())
            self.write(self.sessions / f'{SESSION}.json', json.dumps(dict(record, status='ended')))
        _, stderr = process.communicate(timeout=60)
        self.assertEqual(process.returncode, 1)
        self.assertIn('only an active round can write', stderr)
        self.assertEqual(json.loads((self.sessions / f'{SESSION}.json').read_text())['status'],
                         'ended')
        self.assertFalse(self.project_file.exists())

    def test_broken_file_is_refused_not_rewritten(self):
        self.write(self.global_file, '[actions.merge\n')
        self.decision('D-5', ['- grant: global merge allow=true'])
        result = self.grant('--layer', 'global', '--action', 'merge', '--allow', 'true',
                            '--source', 'D-5')
        self.assertEqual(result.returncode, 1)
        self.assertIn('not readable TOML', result.stderr)
        self.assertEqual(self.global_file.read_text(), '[actions.merge\n')

    def test_grant_needs_an_active_round_and_a_real_action(self):
        self.decision('D-7', ['- grant: project spend allow=true'])
        self.assertIn('not a pre-authorizable action',
                      self.grant('--layer', 'project', '--action', 'spend', '--allow', 'true',
                                 '--source', 'D-7').stderr)
        self.session(status='ended')
        self.decision('D-7', ['- grant: project merge allow=true'])
        result = self.grant('--layer', 'project', '--action', 'merge', '--allow', 'true',
                            '--source', 'D-7')
        self.assertEqual(result.returncode, 1)
        self.assertIn('only an active round can write', result.stderr)
        self.assertFalse(self.project_file.exists())


class RecordTests(WriteCase):
    def setUp(self):
        super().setUp()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.events = self.root / 'events.json'
        self.agents = self.root / 'agents.json'
        self.agents.write_text('[]')
        hcom = self.bin / 'hcom'
        hcom.write_text(f'#!{sys.executable}\n' + (
            'import json, sys\n'
            f'if sys.argv[1] == "list": print(open({str(self.agents)!r}).read()); sys.exit()\n'
            'wanted = int(sys.argv[sys.argv.index("--sql") + 1].split("=")[1])\n'
            f'for event in json.load(open({str(self.events)!r})):\n'
            '    if event["id"] == wanted: print(json.dumps(event))\n'))
        hcom.chmod(0o755)

    def notice(self, identifier, ts, *, sender='orch', mentions=('zono',), delivered=None):
        return dict(id=identifier, type='message', ts=ts, data=dict(
            sender=sender, **{'from': sender}, mentions=list(mentions),
            delivered_to=list(delivered if delivered is not None else mentions),
            scope='mentions' if mentions else 'broadcast'))

    def record(self, *args):
        return self.run_tool('record', *args, path=f'{self.bin}:{os.environ["PATH"]}')

    def deploy(self, before=1, after=2, started='2026-10-25T10:05:00+00:00', result='succeeded'):
        return self.record('--action', 'install-host', '--commit', 'abc123', '--basis',
                           'allow install-host — basis: allow=true from global', '--result',
                           result, '--started', started, '--notice-before', str(before),
                           '--notice-after', str(after))

    def test_deploy_notices_are_checked(self):
        good = [self.notice(1, '2026-10-25T10:00:00+00:00'),
                self.notice(2, '2026-10-25T10:10:00+00:00')]
        for label, events, kwargs, reason in (
                ('missing notice', good[:1], {}, 'after notice #2 not found'),
                ('broadcast', [good[0], self.notice(2, '2026-10-25T10:10:00+00:00',
                                                    mentions=())], {}, 'is a broadcast'),
                ('delivered to no one', [self.notice(1, '2026-10-25T10:00:00+00:00',
                                                     delivered=[]), good[1]], {},
                 'before notice #1 reached no one (delivered_to is empty)'),
                ('reversed', [self.notice(1, '2026-10-25T10:10:00+00:00'),
                              self.notice(2, '2026-10-25T10:00:00+00:00')], {},
                 'later than --started'),
                ('after before before', good, dict(before=2, after=1),
                 'is not later than before notice'),
                ('both before the start', [good[0], self.notice(2, '2026-10-25T10:01:00+00:00')],
                 {}, 'is not later than --started'),
                ('someone else sent it', [self.notice(1, '2026-10-25T10:00:00+00:00',
                                                      sender='zono'), good[1]], {},
                 'not this controller orch')):
            with self.subTest(label):
                self.events.write_text(json.dumps(events))
                result = self.deploy(**kwargs)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(reason, result.stderr)
                self.assertEqual(self.records(), [])
        with self.subTest('no notices at all'):
            result = self.record('--action', 'deploy-test', '--commit', 'abc', '--basis', 'x',
                                 '--result', 'succeeded')
            self.assertIn('needs --notice-before, --notice-after and --started', result.stderr)

    def none_ids(self, *rows, sender='orch', round_number=1, recorded=()):
        """Write the no-one-to-notify log `notice` keeps; rows are (id, time)."""
        self.write(self.repo / '.lat' / 'preauth-records' /
                   f'{SESSION}-r{round_number}-no-recipient.jsonl',
                   ''.join(json.dumps(dict(id=name, sender=sender, recorded=list(recorded), not_live=list(recorded),
                                   self_names=[], at=at)) + '\n'
                           for name, at in rows))

    def test_no_one_to_notify_ids_stand_in_for_notices_and_show_in_the_report(self):
        self.none_ids(('none-1', '2026-10-25T10:00:00.123456+00:00'),
                      ('none-2', '2026-10-25T10:10:00.123456+00:00'))
        result = self.record('--action', 'install-host', '--commit', 'abc123', '--basis',
                             'allow install-host', '--result', 'succeeded', '--started',
                             '2026-10-25T10:05:00+00:00', '--notice-before', 'none-1',
                             '--notice-after', 'none-2')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([(e['notice_before'], e['notice_after']) for e in self.records()],
                         [('none-1', 'none-2')])
        self.assertIn('通知 無人可通知（none-1，未發訊息） → 無人可通知（none-2，未發訊息）',
                      self.run_tool('report').stdout)

    def test_no_one_to_notify_ids_are_checked(self):
        self.none_ids(('none-1', '2026-10-25T10:00:00+00:00'),
                      ('none-2', '2026-10-25T10:10:00+00:00'))
        self.events.write_text(json.dumps([self.notice(1, '2026-10-25T10:00:00+00:00')]))
        for label, before, after, reason in (
                ('never issued', 'none-1', 'none-9', 'none-9 was not issued by `notice`'),
                ('order still applies', 'none-2', 'none-1', 'is later than --started'),
                ('malformed', 'none-x', 'none-2', 'neither an HCOM event ID'),
                ('mixed with an event, order still applies', '1', 'none-1',
                 'after notice none-1 (2026-10-25T10:00:00+00:00) is not later')):
            with self.subTest(label):
                result = self.deploy(before=before, after=after)
                self.assertEqual(result.returncode, 2 if label == 'malformed' else 1,
                                 result.stdout)
                self.assertIn(reason, result.stderr)
                self.assertEqual(self.records(), [])
        with self.subTest('another controller\'s id'):
            self.none_ids(('none-1', '2026-10-25T10:00:00+00:00'), sender='zono')
            result = self.deploy(before='none-1', after='none-2')
            self.assertEqual(result.returncode, 1)
            self.assertIn('before notice none-1 was not issued', result.stderr)
        with self.subTest('a log whose controllers were not all offline'):
            self.write(self.repo / '.lat' / 'preauth-records' /
                       f'{SESSION}-r1-no-recipient.jsonl',
                       json.dumps(dict(id='none-1', sender='orch', recorded=['kela'],
                                       not_live=[], self_names=[],
                                       at='2026-10-25T10:00:00+00:00')) + '\n')
            result = self.deploy(before='none-1', after='none-2')
            self.assertEqual(result.returncode, 1)
            self.assertIn('was not issued by `notice`', result.stderr)
        with self.subTest('another round\'s log does not count'):
            self.none_ids(('none-1', '2026-10-25T10:00:00+00:00'), round_number=2)
            self.none_ids(round_number=1)
            result = self.deploy(before='none-1', after='none-2')
            self.assertEqual(result.returncode, 1)

    def test_a_real_before_notice_and_a_none_after_notice_can_mix(self):
        self.none_ids(('none-1', '2026-10-25T10:10:00+00:00'))
        self.events.write_text(json.dumps([self.notice(1, '2026-10-25T10:00:00+00:00')]))
        self.assertEqual(self.deploy(before=1, after='none-1').returncode, 0)

    def test_notice_order_uses_started_precision(self):
        cases = (
            # Whole seconds allow a before-notice within that second, but not the next.
            ('00', '00.4', '01.2', True),
            ('00', '01.2', '02', False),
            ('00', '00.4', '00.9', False),
            ('00', '00.4', '00.4', False),
            ('00', '00.4', '00.2', False),
            # Preserve the supplied fractional precision, including explicit zeroes.
            ('00.400', '00.4009', '00.401', True),
            ('00.400', '00.401', '01', False),
            ('00.400', '00.399', '00.4009', False),
            ('00.000', '00.001', '01', False),
            ('00.400000', '00.400001', '01', False),
        )
        for started, before, after, allowed in cases:
            with self.subTest(started=started, before=before, after=after):
                # Different offsets describe the same instant; compare real time.
                self.events.write_text(json.dumps([
                    self.notice(1, f'2026-10-25T04:00:{before}+00:00'),
                    self.notice(2, f'2026-10-25T12:00:{after}+08:00')]))
                count = len(self.records())
                result = self.deploy(started=f'2026-10-25T12:00:{started}+08:00')
                self.assertEqual(result.returncode, 0 if allowed else 1, result.stderr)
                self.assertEqual(len(self.records()), count + int(allowed))

    def test_tagged_controller_notices_carry_its_base_name(self):
        self.session(hcom_name='lat-fix-orch')
        self.agents.write_text(json.dumps([
            {'name': 'lat-fix-orch', 'base_name': 'orch', 'tag': 'lat-fix'},
            {'name': 'qa-zorch', 'base_name': 'zorch', 'tag': 'qa'}]))
        after = self.notice(2, '2026-10-25T10:10:00+00:00')
        for sender in ('zorch', 'rch', 'fix-orch', 'zono'):
            with self.subTest(sender=sender):
                self.events.write_text(json.dumps(
                    [self.notice(1, '2026-10-25T10:00:00+00:00', sender=sender), after]))
                result = self.deploy()
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(f'sent by {sender}, not this controller lat-fix-orch', result.stderr)
                self.assertEqual(self.records(), [])
        self.events.write_text(json.dumps([self.notice(1, '2026-10-25T10:00:00+00:00'), after]))
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([entry['notice_before'] for entry in self.records()], [1])

    def test_failed_deploy_is_recorded_with_its_notices(self):
        self.events.write_text(json.dumps([self.notice(1, '2026-10-25T10:00:00+00:00'),
                                           self.notice(2, '2026-10-25T10:10:00+00:00')]))
        result = self.deploy(result='failed')
        self.assertEqual(result.returncode, 0, result.stderr)
        [entry] = self.records()
        self.assertEqual((entry['kind'], entry['action'], entry['result'], entry['notice_before'],
                          entry['notice_after']), ('auto', 'install-host', 'failed', 1, 2))

    def test_merge_needs_no_notices_and_bug_intake_needs_its_four_conditions(self):
        self.assertEqual(self.record('--action', 'merge', '--branch', 'dev', '--commit', 'abc',
                                     '--basis', 'allow merge dev', '--result',
                                     'succeeded').returncode, 0)
        result = self.record('--kind', 'bug-intake', '--issue', '#9', '--source', 'chat 12:00')
        self.assertIn('--self-reported', result.stderr)
        self.assertEqual([entry['kind'] for entry in self.records()], ['auto'])

    def test_report_lists_only_this_round_in_three_groups(self):
        old = self.repo / '.lat' / 'preauth-records' / f'{SESSION}-r1.jsonl'
        self.write(old, json.dumps(dict(kind='auto', action='push', commit='OLDROUND',
                                        basis='b', result='succeeded')) + '\n')
        self.session(history=1)
        self.assertEqual(self.record('--action', 'push', '--branch', 'dev', '--commit',
                                     'abc123', '--basis', 'allow push dev', '--result',
                                     'succeeded').returncode, 0)
        self.assertEqual(self.record('--kind', 'bug-intake', '--issue', '#9', '--source',
                                     'chat 12:00', '--self-reported', 'user typed it',
                                     '--clear-expected', 'says X should be Y', '--single-ticket',
                                     'one file', '--restores-stated', 'back to Y').returncode, 0)
        result = self.run_tool('report')
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        self.assertIn(f'session {SESSION} 第 2 輪', out)
        self.assertNotIn('OLDROUND', out)
        auto, bug, grants = out.split('### ')[1:]
        self.assertIn('依預先授權自動執行\n- push dev abc123：succeeded；依據：allow push dev', auto)
        self.assertIn('免確認開工\n- #9；原訊息：chat 12:00；本人回報：user typed it', bug)
        self.assertEqual(grants, '設定寫入\n- 無\n')
        self.assertNotIn('舊答覆', out)
        self.session(status='ended', history=1)
        self.assertIn('abc123', self.run_tool('report').stdout)


GLOBAL_FILE = """# my notes
version = 1

[actions.merge]
allow = true  # keep merging
branches = ["dev"]
source = "D-1"

# pushing
[actions.push]
allow = true
branches = [
  "dev",  # the one
  # and the other
  "rel[1]",
]
source = "D-1"

# advisor scope
[advisor]
extended = true
source = "D-1"
may_settle = [
  "details [of] the spec",
]
"""


class BoardTests(PreauthCase):
    """The board's `board preauth-read` and `board preauth-write`, run the way the board does."""

    def setUp(self):
        super().setUp()
        self.state = self.root / 'state' / 'lat' / 'board'

    def panel_env(self):
        environment = {key: value for key, value in os.environ.items()
                       if key != 'LAT_BOARD_STATE_DIR'}
        environment.update(HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.config),
                           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                           XDG_STATE_HOME=str(self.root / 'state'))
        return environment

    def panel(self, *args):
        result = subprocess.run([sys.executable, str(PANEL), 'board', *args], capture_output=True,
                                text=True, cwd=self.repo, env=self.panel_env(), timeout=60)
        return json.loads(result.stdout), result.returncode

    def read(self, workspace=None):
        return self.panel('preauth-read', *([f'--workspace={workspace}'] if workspace else []))[0]

    def write_layer(self, changes, layer='global', sha=None, workspace=None):
        if sha is None:
            sha = self.read(workspace or self.repo)['layers'][layer]['sha256']
        return self.panel('preauth-write', f'--layer={layer}', f'--expected-sha256={sha}',
                          f'--changes={json.dumps(changes)}',
                          *([f'--workspace={workspace or self.repo}'] if layer == 'project' else []))

    def log(self):
        path = self.state / 'preauth-writes.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_changing_one_key_leaves_the_rest_of_the_file_alone(self):
        self.write(self.global_file, GLOBAL_FILE)
        result, code = self.write_layer({'actions': {'push': {'allow': False}}})
        self.assertEqual((result['status'], code), ('ok', 0), result)
        text = self.global_file.read_text()
        source = tomllib.loads(text)['actions']['push']['source']
        self.assertRegex(source, r'^board:\d{4}-.*[+-]\d\d:\d\d$')
        pushing, rest = GLOBAL_FILE.split('[actions.push]\n')
        changed = rest.replace('allow = true', 'allow = false', 1).replace('"D-1"', f'"{source}"', 1)
        self.assertEqual(text, f'{pushing}[actions.push]\n{changed}')
        verdict = self.check('push', '--branch', 'dev')
        self.assertIn('allow-false', verdict['reason_kinds'])
        self.assertEqual(self.log()[0]['changes'],
                         [{'section': 'actions.push', 'key': 'allow', 'value': False}])
        self.assertEqual(result['settings']['layers']['global']['actions']['push']['allow'], False)

    def test_a_kept_key_keeps_its_comment_and_new_list_values_replace_a_multi_line_one(self):
        self.write(self.global_file, GLOBAL_FILE)
        self.assertEqual(self.write_layer({'actions': {
            'merge': {'allow': False},
            'push': {'branches': ['dev', 'next']}}})[0]['status'], 'ok')
        text = self.global_file.read_text()
        self.assertIn('allow = false  # keep merging\n', text)
        self.assertIn('branches = ["dev", "next"]\n', text)
        self.assertIn('# and the other\n', text)
        self.assertNotIn('rel[1]', text)

    def test_a_time_window_stays_and_does_not_block_a_write(self):
        window = '[actions.push]\nallow = true\nhours = "20:00-06:00"\ntimezone = "Asia/Taipei"\n'
        self.write(self.global_file, window)
        self.assertEqual(self.read()['layers']['global']['problems'], [])
        result, _ = self.write_layer({'actions': {'push': {'allow': False}}})
        self.assertEqual(result['status'], 'ok', result)
        pushing = tomllib.loads(self.global_file.read_text())['actions']['push']
        self.assertEqual((pushing['allow'], pushing['hours'], pushing['timezone']),
                         (False, '20:00-06:00', 'Asia/Taipei'))
        self.assertEqual(self.write_layer({'actions': {'push': {'hours': '00:00-01:00'}}})[0]['status'], 'invalid')

    def test_a_window_key_only_the_other_layer_completes_blocks_neither_file(self):
        self.write(self.global_file, '[actions.push]\nhours = "20:00-06:00"\n')
        result, _ = self.write_layer({'actions': {'merge': {'allow': True}}})
        self.assertEqual(result['status'], 'ok', result)
        self.assertEqual(result['settings']['layers']['global']['problems'], [])
        self.assertEqual(result['settings']['effective'], {'actions': {}, 'advisor': {}})

    def test_comments_inside_a_rewritten_list_stay_in_the_file(self):
        self.write(self.global_file, '[advisor]\nmust_ask = [ # open\n  "a # not a comment", # why a\n'
                                     '  # about b\n  "b",\n] # close\n')
        self.assertEqual(self.write_layer({'advisor': {'must_ask': ['a # not a comment']}})[0]['status'], 'ok')
        text = self.global_file.read_text()
        for comment in ('# open', '# why a', '# about b', '# close'):
            self.assertIn(comment, text)
        self.assertEqual(tomllib.loads(text)['advisor']['must_ask'], ['a # not a comment'])

    def test_inherit_and_an_empty_list_delete_the_key(self):
        self.write(self.global_file, GLOBAL_FILE)
        result, _ = self.write_layer({'actions': {'push': {'allow': None, 'branches': []}}})
        self.assertEqual(result['status'], 'ok', result)
        data = tomllib.loads(self.global_file.read_text())
        self.assertEqual(set(data['actions']['push']), {'source'})
        self.assertEqual(self.log()[0]['changes'][1]['value'], None)

    def test_a_new_may_settle_entry_shows_and_keeps_the_others(self):
        self.write(self.global_file, GLOBAL_FILE)
        result, _ = self.write_layer({'advisor': {'may_settle': ['details [of] the spec', '小範圍 "補票"']}})
        self.assertEqual(result['status'], 'ok', result)
        data = tomllib.loads(self.global_file.read_text())
        self.assertEqual(data['advisor']['may_settle'], ['details [of] the spec', '小範圍 "補票"'])
        self.assertIs(data['advisor']['extended'], True)
        self.assertIn('小範圍', self.run_tool('show').stdout)
        self.assertIn('# advisor scope\n[advisor]\n', self.global_file.read_text())

    def test_the_first_write_creates_the_file(self):
        result, _ = self.write_layer({'actions': {'deploy-prod': {'allow': False}},
                                      'advisor': {'must_ask': ['花錢']}})
        self.assertEqual(result['status'], 'ok', result)
        data = tomllib.loads(self.global_file.read_text())
        self.assertIs(data['actions']['deploy-prod']['allow'], False)
        self.assertEqual(data['advisor']['must_ask'], ['花錢'])

    def test_nothing_changed_writes_nothing(self):
        self.write(self.global_file, GLOBAL_FILE)
        result, code = self.write_layer({'actions': {'push': {'allow': True}}})
        self.assertEqual((result['status'], result['changes'], code), ('ok', [], 0))
        self.assertEqual(self.global_file.read_text(), GLOBAL_FILE)
        self.assertEqual(self.log(), [])

    def test_a_second_writer_from_an_older_read_is_refused(self):
        self.write(self.global_file, GLOBAL_FILE)
        stale = self.read()['layers']['global']['sha256']
        self.assertEqual(self.write_layer({'actions': {'push': {'allow': False}}}, sha=stale)[0]['status'], 'ok')
        after = self.global_file.read_text()
        result, code = self.write_layer({'actions': {'merge': {'allow': False}}}, sha=stale)
        self.assertEqual((result['status'], code), ('conflict', 1))
        self.assertEqual(self.global_file.read_text(), after)
        self.assertEqual(len(self.log()), 1)

    def test_a_broken_file_is_shown_and_refused_unchanged(self):
        broken = GLOBAL_FILE + 'surprise = 1\n'
        self.write(self.global_file, broken)
        view = self.read()['layers']['global']
        self.assertIn('unknown key `surprise`', view['problems'][0])
        self.assertEqual((view['actions'], view['advisor']), ({}, {}))
        self.assertEqual(self.read()['effective'], {'actions': {}, 'advisor': {}})
        result, code = self.write_layer({'actions': {'push': {'allow': False}}}, sha=view['sha256'])
        self.assertEqual((result['status'], code), ('invalid', 1))
        self.assertIn('unknown key `surprise`', result['problems'][0])
        self.assertEqual(self.global_file.read_text(), broken)
        self.write(self.global_file, 'not toml [')
        self.assertEqual(self.write_layer({}, sha=view['sha256'])[0]['status'], 'invalid')
        self.assertEqual(self.global_file.read_text(), 'not toml [')

    def test_a_layout_the_editor_cannot_keep_is_refused_unchanged(self):
        inline = 'actions.push.allow = true\n'
        self.write(self.global_file, inline)
        result, _ = self.write_layer({'actions': {'push': {'allow': False}}})
        self.assertEqual(result['status'], 'invalid', result)
        self.assertEqual(self.global_file.read_text(), inline)

    def test_only_what_the_layer_offers_can_be_written(self):
        for changes, layer in (({'actions': {'deploy-test': {'target': 'stage'}}}, 'global'),
                               ({'actions': {'push': {'target': 'stage'}}}, 'project'),
                               ({'actions': {'deploy-prod': {'branches': ['dev']}}}, 'global'),
                               ({'advisor': {'may_settle': ['x']}}, 'project'),
                               ({'advisor': {'extended': False}}, 'global'),
                               ({'actions': {'push': {'source': 'me'}}}, 'global'),
                               ({'actions': {'new-ticket': {'allow': True}}}, 'global'),
                               ({'actions': {'spend': {'allow': True}}}, 'project'),
                               ({'actions': {'push': {'allow': 'yes'}}}, 'global'),
                               ({'actions': {'push': {'branches': ['a b']}}}, 'global'),
                               ({'actions': {'push': {'branches': ['  ']}}}, 'global'),
                               ({'advisor': {'must_ask': 'x'}}, 'global'),
                               ({'version': 1}, 'global')):
            result, code = self.write_layer(changes, layer=layer)
            self.assertEqual((result['status'], code), ('invalid', 1), changes)
        self.assertFalse(self.global_file.exists())
        self.assertFalse(self.project_file.exists())

    def test_log_failure_restores_the_file(self):
        self.write(self.global_file, GLOBAL_FILE)
        self.state.parent.mkdir(parents=True)
        self.state.write_text('not a folder')
        result, code = self.write_layer({'actions': {'push': {'allow': False}}})
        self.assertEqual((result['status'], code), ('log_failed', 1), result)
        self.assertEqual(self.global_file.read_text(), GLOBAL_FILE)

    def test_log_failure_on_a_new_file_removes_it(self):
        self.state.parent.mkdir(parents=True)
        self.state.write_text('not a folder')
        self.assertEqual(self.write_layer({'actions': {'push': {'allow': False}}})[0]['status'], 'log_failed')
        self.assertFalse(self.global_file.exists())

    def test_when_the_restore_fails_too_the_result_says_what_is_in_the_file(self):
        self.write(self.global_file, GLOBAL_FILE)
        spec = importlib.util.spec_from_file_location('lat_preauth_restore', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        def fail_log(entry):
            self.global_file.write_text(self.global_file.read_text() + '# edited meanwhile\n')
            raise OSError('disk full')

        module.append_board_write = fail_log
        with unittest.mock.patch.dict(os.environ, self.panel_env()):
            sha = module.board_settings()['layers']['global']['sha256']
            result = module.board_write('global', None, sha, {'actions': {'push': {'allow': False}}})
        self.assertEqual(result['status'], 'restore_failed')
        self.assertIn('allow = false', result['current'])
        self.assertIn('edited meanwhile', result['current'])
        self.assertEqual(result['to_undo'][0], '[actions.push] allow 改回 true')
        self.assertEqual(result['to_undo'][1], '[actions.push] source 改回 "D-1"')

    def test_report_lists_this_rounds_writes_to_this_project_and_global(self):
        self.write(self.state / 'preauth-writes.jsonl', ''.join(json.dumps(entry) + '\n' for entry in (
            dict(at='2026-01-01T00:00:00+00:00', kind='board', layer='global', source='board:x',
                 file=str(self.global_file), changes=[{'section': 'actions.merge', 'key': 'allow', 'value': True}]),
            dict(at='2026-06-01T00:00:00+00:00', kind='board', layer='project', source='board:x',
                 file=str(self.root / 'other' / '.lat' / 'preauth.toml'),
                 changes=[{'section': 'actions.deploy-prod', 'key': 'allow', 'value': True}]))))
        self.session(started_at_utc='2026-03-01T00:00:00+00:00')
        self.write(self.global_file, GLOBAL_FILE)
        self.assertEqual(self.write_layer({'actions': {'push': {'allow': False}}})[0]['status'], 'ok')
        self.assertEqual(self.write_layer({'actions': {'push': {'allow': True}}}, layer='project')[0]['status'], 'ok')
        result = self.run_tool('report')
        self.assertEqual(result.returncode, 0, result.stderr)
        writes = result.stdout.split('### 設定寫入')[1]
        self.assertIn(f'看板 global：[actions.push] allow = false', writes)
        self.assertIn(f'→ {self.global_file}', writes)
        self.assertIn(f'看板 project：[actions.push] allow = true', writes)
        self.assertNotIn('actions.merge', writes)
        self.assertNotIn('deploy-prod', writes)
        for bad in (b'not json\n', b'\xff\n', b'[]\n',
                    json.dumps(dict(at='later', file=str(self.global_file), changes=[])).encode() + b'\n',
                    json.dumps(dict(at='2026-06-01T00:00:00+00:00', file=str(self.global_file),
                                    changes=[{}])).encode() + b'\n'):
            with open(self.state / 'preauth-writes.jsonl', 'ab') as log:
                log.write(bad)
            result = self.run_tool('report')
            self.assertEqual(result.returncode, 0, (bad, result.stderr))
            self.assertIn('讀不懂', result.stdout.split('### 設定寫入')[1])
            self.assertIn('allow = false', result.stdout)
            (self.state / 'preauth-writes.jsonl').write_bytes(
                (self.state / 'preauth-writes.jsonl').read_bytes().removesuffix(bad))

    def test_the_project_layer_from_a_worktree_is_the_main_checkouts_file(self):
        self.write(self.project_file, '[actions.deploy-test]\nallow = true\ntarget = "stage"\n')
        self.write(self.global_file, '[actions.deploy-test]\nallow = false\n')
        worktree = self.root / 'tree'
        git(self.repo, 'worktree', 'add', '-q', str(worktree), '-b', 'side')
        result, _ = self.write_layer({'actions': {'deploy-test': {'allow': None, 'target': ''}}},
                                     layer='project', workspace=worktree)
        self.assertEqual(result['status'], 'ok', result)
        self.assertEqual(set(tomllib.loads(self.project_file.read_text())['actions']['deploy-test']), {'source'})
        effective = result['settings']['effective']['actions']['deploy-test']
        self.assertEqual((effective['allow']['value'], effective['allow']['layer']), (False, 'global'))
        self.assertNotIn('target', effective)

    def test_read_gives_each_layer_and_the_merged_result(self):
        self.write(self.global_file, GLOBAL_FILE)
        self.write(self.project_file, '[actions.push]\nallow = false\n[advisor]\nmust_ask = ["x"]\n')
        view = self.read(self.repo)
        self.assertEqual(view['effective']['actions']['push']['allow']['layer'], 'project')
        self.assertEqual(view['effective']['actions']['push']['branches']['layer'], 'global')
        self.assertEqual(view['effective']['advisor']['may_settle']['layer'], 'global')
        self.assertNotIn('must_ask', view['effective']['advisor'])
        self.assertIs(view['project_advisor'], True)
        self.assertEqual(self.read()['layers'].keys(), {'global'})


class RemovedOptionTests(WriteCase):
    """The controller layer and earlier-answer citations are gone from the command line."""

    def test_removed_options_are_rejected_as_unknown(self):
        self.decision('D-1', ['- grant: controller merge allow=true'])
        for label, args, reason in (
                ('grant --layer controller',
                 ('grant', '--layer', 'controller', '--action', 'merge', '--allow', 'true',
                  '--source', 'D-1'), "invalid choice: 'controller'"),
                ('check --precedent', ('check', '--action', 'merge', '--branch', 'dev',
                                       '--precedent', 'D-1'), 'unrecognized arguments'),
                ('record --kind precedent',
                 ('record', '--kind', 'precedent', '--source', 'D-1 r1', '--basis', 'same'),
                 "invalid choice: 'precedent'"),
                ('record --decision', ('record', '--kind', 'bug-intake', '--decision', 'D-1'),
                 'unrecognized arguments')):
            with self.subTest(label):
                result = self.run_tool(*args)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn(reason, result.stderr)
        self.assertEqual(self.records(), [])
        self.assertNotIn('preauth', json.loads((self.sessions / f'{SESSION}.json').read_text()))


if __name__ == '__main__':
    unittest.main()
