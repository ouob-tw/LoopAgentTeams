"""CLI contract tests for lat-unattended.py: temp HOME/XDG config, a temp Git repo and a fake
session record; nothing on the host is read or written."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-unattended.py'
SESSION = '11111111-1111-4111-8111-111111111111'
GIT_ENV = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
FULL = ['--goal', '修好登入頁', '--done', '登入成功跳到首頁', '--done', '錯誤密碼顯示提示',
        '--scope', 'ticket-confirmation', 'assume-defaults', '--max-hours', '6']
SETTINGS_SCOPE = ('ticket-confirmation', 'assume-defaults', 'prototype')


def git(cwd, *args):
    subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True, env=GIT_ENV)


class UnattendedCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q', '-b', 'dev')
        self.lat = self.repo / '.lat'
        self.global_file = self.root / 'xdg' / 'lat' / 'preauth.toml'
        self.project_file = self.lat / 'preauth.toml'
        self.board_state = self.root / 'board-state'
        self.grant = self.lat / 'unattended' / f'{SESSION}-r1.json'
        self.session()

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def session(self, status='active', **extra):
        self.write(self.lat / 'sessions' / f'{SESSION}.json',
                   json.dumps(dict(status=status, history=[], hcom_name='orch',
                                   decisions_path=str(self.lat / 'decisions'), **extra)))

    def record(self):
        return json.loads((self.lat / 'sessions' / f'{SESSION}.json').read_text())

    def run_tool(self, *args):
        environment = {key: value for key, value in os.environ.items()
                       if key not in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')}
        environment.update(HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.root / 'xdg'),
                           XDG_STATE_HOME=str(self.root / 'state'), GIT_CONFIG_NOSYSTEM='1',
                           GIT_CONFIG_GLOBAL=os.devnull, CLAUDE_CODE_SESSION_ID=SESSION,
                           LAT_BOARD_STATE_DIR=str(self.board_state))
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                              text=True, cwd=self.repo, env=environment, timeout=60)

    def json_of(self, *args, code=0):
        result = self.run_tool(*args, '--json')
        self.assertEqual(result.returncode, code, result.stderr)
        return json.loads(result.stdout)

    def status(self):
        return self.json_of('status')

    def create(self, *extra, source='board-form', evidence='board-action-1', code=0):
        return self.json_of('create', *FULL, '--source', source, '--evidence', evidence, *extra,
                            code=code)

    def default_create(self, evidence, code=0, scope=SETTINGS_SCOPE, hours='12'):
        """A default start, with the scope and time limit the settings give by default."""
        return self.json_of('create', '--goal', '修好登入頁', '--done', '登入成功',
                            '--scope', *scope, '--max-hours', hours,
                            '--source', 'settings-default', '--evidence', evidence, code=code)

    def board_write(self, source, value='unattended', file=None):
        path = self.board_state / 'preauth-writes.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        entry = dict(at='2026-11-13T00:00:00+00:00', kind='board', layer='global',
                     file=str(file or self.global_file), source=source,
                     changes=[dict(section='unattended', key='mode', value=value)])
        with path.open('a') as stream:
            stream.write(json.dumps(entry) + '\n')


class ResolutionTests(UnattendedCase):
    def layers(self, settings):
        values = settings
        return {key: (values[key]['value'], values[key]['layer'])
                for key in ('mode', 'ticket_confirmation', 'assume_defaults', 'prototype_decide',
                            'max_hours')}

    def test_each_value_comes_from_the_narrowest_layer_that_sets_it(self):
        cases = [
            ('nothing set: initial values', None, None, None,
             dict(mode=('manual', 'default'), ticket_confirmation=(True, 'default'),
                  assume_defaults=(True, 'default'), prototype_decide=(True, 'default'),
                  max_hours=(12, 'default'))),
            ('global only, some keys missing', None, None,
             '[unattended]\nmode = "unattended"\nmax_hours = 8\n',
             dict(mode=('unattended', 'global'), ticket_confirmation=(True, 'default'),
                  assume_defaults=(True, 'default'), prototype_decide=(True, 'default'),
                  max_hours=(8, 'global'))),
            ('project follows global for the mode but sets one delegation', None,
             '[unattended]\nmode = "follow-global"\nassume_defaults = false\n',
             '[unattended]\nmode = "unattended"\nassume_defaults = true\n',
             dict(mode=('unattended', 'global'), ticket_confirmation=(True, 'default'),
                  assume_defaults=(False, 'project'), prototype_decide=(True, 'default'),
                  max_hours=(12, 'default'))),
            ('project overrides global', None, '[unattended]\nmode = "manual"\n',
             '[unattended]\nmode = "unattended"\nmax_hours = 3\n',
             dict(mode=('manual', 'project'), ticket_confirmation=(True, 'default'),
                  assume_defaults=(True, 'default'), prototype_decide=(True, 'default'),
                  max_hours=(3, 'global'))),
            ('controller overrides project and global', dict(mode='unattended',
                                                             prototype_decide=False),
             '[unattended]\nmode = "manual"\nprototype_decide = true\n',
             '[unattended]\nmode = "manual"\n',
             dict(mode=('unattended', 'controller'), ticket_confirmation=(True, 'default'),
                  assume_defaults=(True, 'default'), prototype_decide=(False, 'controller'),
                  max_hours=(12, 'default'))),
            ('project file without an [unattended] section', None, '[advisor]\n',
             '[unattended]\nticket_confirmation = false\n',
             dict(mode=('manual', 'default'), ticket_confirmation=(False, 'global'),
                  assume_defaults=(True, 'default'), prototype_decide=(True, 'default'),
                  max_hours=(12, 'default'))),
        ]
        for name, controller, project, global_text, expected in cases:
            with self.subTest(name):
                for path, text in ((self.project_file, project), (self.global_file, global_text)):
                    path.unlink(missing_ok=True)
                    if text is not None:
                        self.write(path, text)
                self.session(**({'unattended': controller} if controller else {}))
                result = self.status()
                self.assertEqual(self.layers(result['settings']), expected)
                self.assertEqual(result['problems'], [])
                self.assertTrue(result['quota_stop'])

    def test_text_output_names_every_value_and_its_layer(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\nmax_hours = 8\n')
        self.write(self.project_file, '[unattended]\nmode = "follow-global"\n'
                                      'prototype_decide = false\n')
        self.session(unattended=dict(ticket_confirmation=False))
        result = self.run_tool('status')
        self.assertEqual(result.returncode, 0, result.stderr)
        for line in ('模式：無人模式 ← 全域', '短流程票代確認：關 ← 主控',
                     '在固定清單內選預設：開 ← 初始值', '做樣品再決定：關 ← 專案',
                     '停止條件：額度用完一律停；時間上限 8 小時 ← 全域'):
            self.assertIn(line, result.stdout)

    def test_a_bad_setting_falls_back_to_manual_and_says_why(self):
        cases = (('global', '[unattended]\nmode = "sometimes"\n', None, 'mode'),
                 ('global follow', '[unattended]\nmode = "follow-global"\n', None,
                  'only for a project'),
                 ('controller follow', '[unattended]\nmode = "unattended"\n',
                  dict(mode='follow-global'), 'only for a project'),
                 ('malformed', '[unattended\nmode = "unattended"\n', None, 'malformed'))
        for name, text, controller, reason in cases:
            with self.subTest(name):
                self.write(self.global_file, text)
                self.session(**({'unattended': controller} if controller else {}))
                result = self.status()
                self.assertEqual(result['settings']['mode']['value'], 'manual')
                self.assertTrue(any(reason in problem for problem in result['problems']),
                                result['problems'])
                self.assertEqual(result['state'], 'none')

    def test_a_bad_preauth_action_does_not_touch_the_mode(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\n'
                                     '[actions.merge]\nalow = true\n')
        result = self.status()
        self.assertEqual(result['problems'], [])
        self.assertEqual(result['settings']['mode']['value'], 'unattended')


class GrantTests(UnattendedCase):
    def test_create_refuses_any_missing_field_and_writes_nothing(self):
        fields = {'--goal': ['--goal', 'g'], '--done': ['--done', 'd'],
                  '--scope': ['--scope', 'none'], '--max-hours': ['--max-hours', '2'],
                  '--source': ['--source', 'board-form'], '--evidence': ['--evidence', 'e']}
        for missing in fields:
            with self.subTest(missing):
                args = [part for flag, parts in fields.items() if flag != missing for part in parts]
                result = self.json_of('create', *args, code=1)
                self.assertEqual(result['status'], 'refused')
                self.assertIn(missing, result['reason'])
                self.assertFalse(self.grant.exists())
                self.assertNotIn('unattended', self.record())
        blank = self.json_of('create', *FULL, '--source', 'board-form', '--evidence', '  ', code=1)
        self.assertIn('--evidence', blank['reason'])
        self.assertFalse(self.grant.exists())

    def test_board_form_grant_takes_effect_and_turns_the_controller_unattended(self):
        created = self.create()['created']
        self.assertEqual(created['version'], 1)
        self.assertEqual(created['done'], ['登入成功跳到首頁', '錯誤密碼顯示提示'])
        self.assertEqual(created['scope'], dict(ticket_confirmation=True, assume_defaults=True,
                                                prototype_decide=False))
        self.assertEqual(created['stop'], dict(quota=True, max_hours=6))
        result = self.status()
        self.assertEqual(result['state'], 'active')
        self.assertEqual(result['settings']['mode'], dict(value='unattended', layer='controller',
                                                          source=None))
        self.assertEqual(result['version']['version'], 1)
        # A second create while one is in effect is refused.
        self.assertEqual(self.create(code=1)['status'], 'refused')

    def test_update_makes_a_new_version_now_and_keeps_every_old_one(self):
        self.create()
        updated = self.json_of('update', '--goal', '修好登入頁與註冊頁', '--source', 'user-edit',
                               '--evidence', 'board-action-2')['created']
        self.assertEqual(updated['version'], 2)
        self.assertEqual(updated['done'], ['登入成功跳到首頁', '錯誤密碼顯示提示'])
        self.json_of('update', '--done', '只要登入成功', '--max-hours', '3', '--source',
                     'user-edit', '--evidence', 'board-action-3')
        status = self.status()
        self.assertEqual(status['version']['version'], 3)
        self.assertEqual(status['version']['goal'], '修好登入頁與註冊頁')
        self.assertEqual(status['version']['stop']['max_hours'], 3)
        versions = self.json_of('versions')['versions']
        self.assertEqual([v['version'] for v in versions], [1, 2, 3])
        self.assertEqual([v['end_reason'] for v in versions], ['superseded', 'superseded', None])
        self.assertEqual(versions[0]['ended_at'], versions[1]['started_at'])
        self.assertEqual(versions[1]['ended_at'], versions[2]['started_at'])
        self.assertIsNone(versions[2]['ended_at'])
        text = self.run_tool('versions').stdout
        self.assertIn('第 1 版：', text)
        self.assertIn('被新版本取代', text)
        self.assertIn('第 3 版：', text)
        self.assertIn('生效中', text)

    def test_update_needs_source_evidence_and_a_grant_in_effect(self):
        refused = self.json_of('update', '--goal', 'x', '--source', 'user-edit',
                               '--evidence', 'e', code=1)
        self.assertIn('no grant in effect', refused['reason'])
        self.create()
        self.assertIn('--evidence', self.json_of('update', '--goal', 'x', '--source',
                                                 'user-edit', code=1)['reason'])
        self.assertEqual(len(self.json_of('versions')['versions']), 1)

    def test_closing_ends_the_version_with_time_and_reason(self):
        for reason, label in (('off', '使用者關掉'), ('quota', '額度用完')):
            with self.subTest(reason):
                self.grant.unlink(missing_ok=True)
                self.session()
                self.create()
                self.json_of('close', '--reason', reason)
                status = self.status()
                self.assertEqual(status['state'], 'none')
                self.assertEqual(status['state_label'], '無有效授權')
                self.assertEqual(status['last_end']['reason'], reason)
                self.assertIsNotNone(status['last_end']['ended_at'])
                self.assertIn(f'（{label}）', self.run_tool('status').stdout)
                self.assertIn('無人授權：無有效授權', self.run_tool('status').stdout)

    def test_off_sends_the_controller_back_to_manual(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\n')
        self.json_of('close', '--reason', 'off')
        status = self.status()
        self.assertEqual(status['settings']['mode']['value'], 'manual')
        self.assertEqual(status['settings']['mode']['layer'], 'controller')
        self.assertEqual(status['state'], 'none')

    def test_after_quota_runs_out_no_decision_can_cite_that_version(self):
        self.create()
        before = datetime.now(timezone.utc).isoformat()
        self.assertEqual(self.run_tool('check', '--version', '1').returncode, 0)
        self.json_of('close', '--reason', 'quota')
        result = self.json_of('check', '--version', '1', code=1)
        self.assertFalse(result['effective'])
        self.assertIn('額度用完', result['reason'])
        # A decision made before the end still checks against the period it fell in.
        self.assertTrue(self.json_of('check', '--version', '1', '--at', before)['effective'])
        self.assertEqual(self.json_of('update', '--goal', 'x', '--source', 'user-edit',
                                      '--evidence', 'e', code=1)['status'], 'refused')
        self.assertFalse(self.json_of('check', '--version', '2', code=1)['effective'])

    def test_the_time_limit_ends_the_version_at_its_deadline(self):
        self.create()
        data = json.loads(self.grant.read_text())
        start = (datetime.now(timezone.utc) - timedelta(hours=7)).replace(microsecond=0)
        data['versions'][0]['started_at'] = start.isoformat(timespec='seconds')
        self.grant.write_text(json.dumps(data))
        status = self.status()
        self.assertEqual(status['state'], 'none')
        self.assertEqual(status['last_end']['reason'], 'time-limit')
        ended = json.loads(self.grant.read_text())['versions'][0]
        self.assertEqual(datetime.fromisoformat(ended['ended_at']), start + timedelta(hours=6))
        self.assertEqual(ended['end_reason'], 'time-limit')
        self.assertIn('時間上限到期', self.run_tool('status').stdout)

    def test_a_mode_turned_manual_ends_the_open_version_for_good(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\n')
        self.board_write('board:t1')
        self.default_create('board:t1')
        self.write(self.project_file, '[unattended]\nmode = "manual"\n')
        status = self.status()
        self.assertEqual(status['state'], 'none')
        self.assertEqual(status['last_end']['reason'], 'mode-manual')
        self.project_file.unlink()
        self.assertEqual(self.status()['state'], 'none')
        self.assertIsNotNone(json.loads(self.grant.read_text())['versions'][0]['ended_at'])

    def test_update_refuses_a_time_limit_that_has_already_passed(self):
        self.create()
        data = json.loads(self.grant.read_text())
        data['versions'][0]['started_at'] = (datetime.now(timezone.utc)
                                             - timedelta(hours=3)).isoformat()
        self.grant.write_text(json.dumps(data))
        refused = self.json_of('update', '--max-hours', '2', '--source', 'user-edit',
                               '--evidence', 'e', code=1)
        self.assertIn('already passed', refused['reason'])
        self.assertEqual(len(json.loads(self.grant.read_text())['versions']), 1)
        self.assertEqual(self.status()['state'], 'active')

    def test_an_ended_round_has_no_grant_in_effect(self):
        self.create()
        self.session(status='ended', unattended=dict(mode='unattended'))
        status = self.status()
        self.assertEqual(status['state'], 'none')
        self.assertFalse(status['round_active'])
        self.assertFalse(self.json_of('check', '--version', '1', code=1)['effective'])
        self.assertEqual(self.create(code=1)['status'], 'refused')


class DefaultStartTests(UnattendedCase):
    def test_default_start_waits_for_the_goal_before_the_grant_counts(self):
        for layer, path in (('global', self.global_file), ('project', self.project_file)):
            with self.subTest(layer):
                self.global_file.unlink(missing_ok=True)
                self.project_file.unlink(missing_ok=True)
                self.grant.unlink(missing_ok=True)
                self.board_state.joinpath('preauth-writes.jsonl').unlink(missing_ok=True)
                self.write(path, '[unattended]\nmode = "unattended"\nsource = "board:t1"\n')
                status = self.status()
                self.assertEqual(status['state'], 'pending-goal')
                self.assertIsNone(status['version'])
                self.assertIn('無人授權：無人模式，尚待目標', self.run_tool('status').stdout)
                self.assertFalse(self.json_of('check', '--version', '1', code=1)['effective'])
                self.board_write('board:t1', file=path)
                created = self.default_create('board:t1')['created']
                self.assertEqual(created['note'], '目標由主控擬出')
                self.assertEqual(self.status()['state'], 'active')
                self.assertNotIn('unattended', self.record())

    def test_manual_default_never_waits_for_a_goal(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\n')
        self.write(self.project_file, '[unattended]\nmode = "manual"\n')
        self.assertEqual(self.status()['state'], 'none')


class EvidenceTests(UnattendedCase):
    def decision(self, name, status='answered', answer_revision='r1'):
        self.write(self.lat / 'decisions' / f'{name}.md',
                   f'# {name} 這輪不用問我？\n\n- status: {status}\n- version: r1\n\n'
                   f'## 答覆 {answer_revision}\n\n- 來源：面板答題\n- 選 A\n')

    def test_chat_grant_must_cite_an_answered_panel_question_at_that_revision(self):
        self.decision('GEBU-UN-1')
        self.decision('GEBU-UN-2', status='pending')
        self.decision('GEBU-UN-3', answer_revision='r2')
        for evidence in ('GEBU-UN-1', 'GEBU-UN-1 r2', 'GEBU-UN-2 r1', 'GEBU-UN-3 r1',
                         'GEBU-UN-9 r1'):
            with self.subTest(evidence):
                self.assertEqual(self.create(source='chat', evidence=evidence, code=1)['status'],
                                 'refused')
                self.assertFalse(self.grant.exists())
        self.assertEqual(self.create(source='chat', evidence='GEBU-UN-1 r1')['created']['source'],
                         'chat')
        self.assertEqual(self.status()['state'], 'active')

    def test_settings_default_must_cite_the_board_write_that_set_the_mode(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\n')
        refused = self.default_create('board:t1', code=1)
        self.assertIn('board:t1', refused['reason'])
        self.board_write('board:t1')
        self.board_write('board:t2', file=self.project_file)  # another file does not count
        self.assertEqual(self.default_create('board:t9', code=1)['status'], 'refused')
        self.board_write('board:t3', value='manual')
        self.assertIn('manual', self.default_create('board:t3', code=1)['reason'])
        self.board_write('board:t4')
        self.assertEqual(self.default_create('board:t1', code=1)['status'], 'refused')
        self.assertFalse(self.grant.exists())
        self.assertEqual(self.default_create('board:t4')['created']['version'], 1)

    def test_settings_default_refused_when_the_mode_is_not_a_default_or_after_version_1(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\n')
        self.board_write('board:t1')
        self.session(unattended=dict(mode='unattended'))
        self.assertIn('主控', self.default_create('board:t1', code=1)['reason'])
        self.session()
        self.default_create('board:t1')
        self.json_of('close', '--reason', 'quota')
        self.assertIn('version 1', self.default_create('board:t1', code=1)['reason'])

    def test_a_default_start_takes_scope_and_time_limit_from_the_settings(self):
        self.write(self.global_file, '[unattended]\nmode = "unattended"\nmax_hours = 8\n')
        self.write(self.project_file, '[unattended]\nprototype_decide = false\n')
        self.board_write('board:t1')
        for scope, hours in ((SETTINGS_SCOPE, '8'), (SETTINGS_SCOPE[:2], '12'),
                             (SETTINGS_SCOPE[:2], '100')):
            with self.subTest(scope=scope, hours=hours):
                refused = self.default_create('board:t1', scope=scope, hours=hours, code=1)
                self.assertIn('--scope ticket-confirmation assume-defaults --max-hours 8',
                              refused['reason'])
                self.assertFalse(self.grant.exists())
        created = self.default_create('board:t1', scope=SETTINGS_SCOPE[:2], hours='8')['created']
        self.assertEqual(created['stop']['max_hours'], 8)
        self.assertFalse(created['scope']['prototype_decide'])


if __name__ == '__main__':
    unittest.main()
