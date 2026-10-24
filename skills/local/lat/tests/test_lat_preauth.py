"""CLI contract tests for lat-preauth.py: temp HOME/XDG config, temp Git repos, fake session."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-preauth.py'
SESSION = '11111111-1111-4111-8111-111111111111'
GATE = 'full-suite gate check is not wired yet'


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True,
                          text=True).stdout.strip()


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
        git(self.repo, 'add', 'a.txt')
        git(self.repo, 'commit', '-q', '-m', 'first')
        self.config = self.root / 'xdg'
        self.global_file = self.config / 'lat' / 'preauth.toml'
        self.project_file = self.repo / '.lat' / 'preauth.toml'
        self.sessions = self.repo / '.lat' / 'sessions'

    def run_tool(self, *args, cwd=None, session=SESSION):
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')}
        environment.update(HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.config))
        if session:
            environment['CLAUDE_CODE_SESSION_ID'] = session
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                              text=True, cwd=cwd or self.repo, env=environment, timeout=60)

    def check(self, action, *extra, **kwargs):
        result = self.run_tool('check', '--action', action, *extra, '--json', **kwargs)
        self.assertEqual(result.stderr, '')
        verdict = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if verdict['verdict'] == 'allow' else 1)
        return verdict

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def session(self, settings, *, status='active', round_number=1, history=0,
                integration='dev'):
        ledger = self.repo / '.lat' / 'ledgers' / 'round.json'
        self.write(ledger, json.dumps({'integration_branch': integration}))
        record = dict(status=status, history=[{}] * history, ledger_path=str(ledger))
        if settings is not None:
            record['preauth'] = {'round': round_number, 'settings': settings}
        self.write(self.sessions / f'{SESSION}.json', json.dumps(record))


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

    def test_controller_layer_overrides_project(self):
        self.write(self.project_file, '[actions.merge]\nallow = false\nbranches = ["dev"]\n')
        self.session({'actions': {'merge': {'allow': True, 'source': 'C-1'}}})
        verdict = self.check('merge', '--branch', 'dev')
        self.assertEqual(verdict['verdict'], 'allow')
        self.assertIn('allow=true from controller (source C-1) [actions.merge]', verdict['basis'])

    def test_controller_layer_lapses_when_round_ended_or_moved_on(self):
        self.write(self.project_file, '[actions.merge]\nbranches = ["dev"]\n')
        settings = {'actions': {'merge': {'allow': True}}}
        for label, kwargs in (('ended', dict(status='ended')),
                              ('earlier round', dict(round_number=1, history=1))):
            with self.subTest(label):
                self.session(settings, **kwargs)
                self.assertEqual(self.check('merge', '--branch', 'dev')['verdict'], 'ask')
        with self.subTest('another session'):
            self.session(settings)
            self.assertEqual(self.check('merge', '--branch', 'dev',
                                        session='22222222')['verdict'], 'ask')

    def test_show_prints_effective_settings_and_origins(self):
        self.write(self.global_file, 'version = 1\nexperiment = true\n'
                   '[actions.push]\nallow = true\nbranches = ["dev"]\nsource = "G-2"\n'
                   '[advisor]\nextended = true\nmay_settle = ["small fixes"]\n')
        self.write(self.project_file, '[actions.push]\nallow = false\n')
        self.session(None, status='ended')
        result = self.run_tool('show')
        self.assertEqual(result.returncode, 0, result.stderr)
        out = result.stdout
        self.assertIn('controller: ', out)
        self.assertIn('not in effect: session is ended', out)
        self.assertIn('    allow = false  ← project', out)
        self.assertIn('    branches = ["dev"]  ← global (source G-2)', out)
        self.assertIn('  [actions.merge] (not set; asks)', out)
        self.assertIn('    may_settle = ["small fixes"]  ← global', out)


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

    def test_bad_controller_field_asks(self):
        self.session({'actions': {'merge': {'allow': True, 'oops': 1}}})
        verdict = self.check('merge', '--branch', 'dev')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('unknown key `oops`', ' '.join(verdict['reasons']))


class ConditionTests(PreauthCase):
    def test_merge_branch_must_be_listed(self):
        self.write(self.global_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        verdict = self.check('merge', '--branch', 'main')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('branch `main` is not in actions.merge.branches', verdict['reasons'][0])
        self.write(self.global_file, '[actions.merge]\nallow = true\n')
        self.assertIn('no layer sets actions.merge.branches',
                      self.check('merge', '--branch', 'dev')['reasons'])

    def test_push_waits_for_the_gate_check(self):
        self.write(self.global_file, '[actions.push]\nallow = true\nbranches = ["dev"]\n')
        self.assertEqual(self.check('push', '--branch', 'dev')['reasons'], [GATE])

    def allow_all(self):
        self.write(self.global_file, ''.join(f'[actions.{name}]\nallow = true\n' for name in
                                             ('deploy-test', 'deploy-prod', 'install-host')))
        self.write(self.project_file, '[actions.deploy-test]\ntarget = "staging on :9000"\n')
        self.session(None)

    def test_main_checkout_at_integration_tip_only_waits_for_the_gate(self):
        self.allow_all()
        for action in ('deploy-test', 'deploy-prod', 'install-host'):
            with self.subTest(action=action):
                self.assertEqual(self.check(action)['reasons'], [GATE])

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
        self.session(None, integration='')
        self.assertIn('integration branch unknown (no active round ledger names one)',
                      self.check('install-host')['reasons'])

    def test_deploy_test_needs_the_project_target(self):
        self.allow_all()
        self.write(self.project_file, '')
        self.write(self.global_file, '[actions.deploy-test]\nallow = true\ntarget = "x"\n')
        self.assertIn('the project layer does not set actions.deploy-test.target',
                      self.check('deploy-test')['reasons'])


if __name__ == '__main__':
    unittest.main()
