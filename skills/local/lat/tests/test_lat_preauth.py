"""CLI contract tests for lat-preauth.py: temp HOME/XDG config, temp Git repos, fake session,
and a temp suite-gate record store standing in for the host's gate."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-preauth.py'
SUITE_GATE = Path(__file__).resolve().parents[2] / 'three-tier-testing/scripts/suite-gate.py'
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

    def run_tool(self, *args, cwd=None, session=SESSION):
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')}
        environment.update(HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.config),
                           GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                           XDG_STATE_HOME=str(self.root / 'state'),
                           SUITE_GATE_STATE_DIR=str(self.gate_state))
        environment.pop('SUITE_GATE_CONFIG', None)
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
                integration='dev', tickets=('313',)):
        ledger = self.repo / '.lat' / 'ledgers' / 'round.json'
        self.write(ledger, json.dumps({'integration_branch': integration,
                                       'items': [{'ticket': t} for t in tickets]}))
        record = dict(status=status, history=[{}] * history, ledger_path=str(ledger))
        if settings is not None:
            record['preauth'] = {'round': round_number, 'settings': settings}
        self.write(self.sessions / f'{SESSION}.json', json.dumps(record))


    def commit(self, message, name='b.txt'):
        (self.repo / name).write_text(message + '\n')
        git(self.repo, 'add', name)
        git(self.repo, 'commit', '-q', '-m', message)
        return git(self.repo, 'rev-parse', 'HEAD')

    def gate_record(self, ref='HEAD', suites=SUITES, passed=True):
        """A record in the temp gate store, fingerprinted the way the gate computes it."""
        gate = load_suite_gate()
        tree = gate.content_tree(self.repo, (), git(self.repo, 'rev-parse', ref))
        self.gate_state.mkdir(exist_ok=True)
        with open(self.gate_state / 'ledger.jsonl', 'a') as ledger:
            for suite in suites:
                fingerprint = gate.digest(tree, [suite['command']],
                                          gate.rel_cwd(self.repo, self.repo / suite['cwd']))
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

    def test_bad_controller_field_asks(self):
        self.session({'actions': {'merge': {'allow': True, 'oops': 1}}})
        verdict = self.check('merge', '--branch', 'dev')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('unknown key `oops`', ' '.join(verdict['reasons']))

    def test_malformed_controller_envelope_asks(self):
        self.write(self.project_file, '[actions.merge]\nallow = false\nbranches = ["dev"]\n')
        settings = {'actions': {'merge': {'allow': True}}}
        for label, preauth, history in (
                ('missing round', {'settings': settings}, []),
                ('boolean round', {'round': True, 'settings': settings}, []),
                ('extra key', {'round': 1, 'oops': True, 'settings': settings}, []),
                ('broken history', {'round': 1, 'settings': settings}, 'broken')):
            with self.subTest(label):
                self.write(self.sessions / f'{SESSION}.json', json.dumps(
                    dict(status='active', history=history, preauth=preauth)))
                verdict = self.check('merge', '--branch', 'dev')
                self.assertEqual(verdict['verdict'], 'ask')
                self.assertIn('controller layer', ' '.join(verdict['reasons']))


class ConditionTests(PreauthCase):
    def test_merge_branch_must_be_listed(self):
        self.write(self.global_file, '[actions.merge]\nallow = true\nbranches = ["dev"]\n')
        verdict = self.check('merge', '--branch', 'main')
        self.assertEqual(verdict['verdict'], 'ask')
        self.assertIn('branch `main` is not in actions.merge.branches', verdict['reasons'][0])
        self.write(self.global_file, '[actions.merge]\nallow = true\n')
        self.assertIn('no layer sets actions.merge.branches',
                      self.check('merge', '--branch', 'dev')['reasons'])

    def allow_all(self):
        self.write(self.global_file, ''.join(f'[actions.{name}]\nallow = true\n' for name in
                                             ('deploy-test', 'deploy-prod', 'install-host')))
        self.write(self.project_file, '[actions.deploy-test]\ntarget = "staging on :9000"\n')
        self.session(None)

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

    def test_deploy_and_install_check_the_gate(self):
        self.allow_all()
        self.gate_record(suites=SUITES[:1])
        head = git(self.repo, 'rev-parse', 'HEAD')
        for action in ('deploy-test', 'deploy-prod', 'install-host'):
            with self.subTest(action=action):
                self.assertEqual(self.check(action)['reasons'], [
                    f'no passing full-suite record for {head[:12]}: bun test (in web)'])

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
        self.session(None, integration=None)
        self.assertIn('integration branch unknown (the round ledger names none and no layer '
                      'sets integration_branch)', self.check('install-host')['reasons'])

    def test_integration_branch_setting_fills_a_null_ledger_value(self):
        self.allow_all()
        self.gate_record()
        self.session(None, integration=None)
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

    def test_controller_layer_integration_branch_wins_over_project(self):
        self.allow_all()
        self.gate_record()
        self.session({'integration_branch': 'dev'}, integration=None)
        self.write(self.project_file, 'integration_branch = "main"\n' +
                   self.project_file.read_text())
        self.assertIn('integration branch `dev` from controller integration_branch',
                      self.check('install-host')['basis'])

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

    def test_show_and_check_name_the_project_target_over_narrower_layers(self):
        self.allow_all()
        self.session({'actions': {'deploy-test': {'target': 'production'}}})
        self.assertIn('target="staging on :9000" from project [actions.deploy-test]',
                      self.check('deploy-test')['basis'])
        out = self.run_tool('show').stdout
        self.assertIn('    target = "staging on :9000"  ← project', out)
        self.assertNotIn('production', out)


class PushTests(PreauthCase):
    """Push: listed branch, every full suite passed, unpushed commits only of this round."""

    def setUp(self):
        super().setUp()
        remote = self.root / 'remote.git'
        git(self.root, 'init', '-q', '--bare', str(remote))
        git(self.repo, 'remote', 'add', 'origin', str(remote))
        git(self.repo, 'push', '-q', 'origin', 'dev')
        self.write(self.global_file, '[actions.push]\nallow = true\nbranches = ["dev"]\n')
        self.session(None, tickets=('313', 'ouob-tw/LoopAgentTeams-work#314'))

    def test_listed_branch_passing_gate_and_round_commits_allow(self):
        self.commit('feat(lat): gate check (#313)')
        sha = self.commit('fix(lat): edge (ouob-tw/LoopAgentTeams-work#314)', 'c.txt')
        self.gate_record()
        result = self.run_tool('check', '--action', 'push', '--branch', 'dev')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('allow push dev — basis: ', result.stdout)
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
        self.session(None, tickets=('ouob-tw/LoopAgentTeams-work#313', '314'))
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

    def test_commits_the_remote_has_are_not_listed(self):
        self.commit('chore: no ticket but pushed')
        git(self.repo, 'push', '-q', 'origin', 'dev')
        self.commit('feat(lat): mine (#313)', 'c.txt')
        self.gate_record()
        self.assertEqual(self.check('push', '--branch', 'dev')['verdict'], 'allow')

    def test_without_a_round_ledger_push_asks(self):
        self.commit('feat(lat): mine (#313)')
        self.gate_record()
        self.session(None, status='ended')
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


if __name__ == '__main__':
    unittest.main()
