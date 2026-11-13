"""Unattended mode at the turn-end check: delegated decision records, parked items, DECIDE/HELP
while the grant is in effect, and replies to review items. Temp HOME/XDG dirs, a temp Git repo
and a fake controller record; no model, HCOM or Herdr call reaches the host."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
SESSION_SCRIPT = SKILL / 'scripts/lat-session.py'
UNATTENDED = SKILL / 'scripts/lat-unattended.py'
PREAUTH = SKILL / 'scripts/lat-preauth.py'
WATCH = SKILL / 'scripts/lat-watch.py'
PANEL = SKILL / 'herdr-panel/lat_panel.py'
SESSION = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
GRANT = ['--goal', '修好登入頁', '--done', '登入成功跳到首頁', '--max-hours', '6',
         '--source', 'board-form']
OPINIONS = ('## 參謀意見\n\n'
            '- puma（claude opus）：agree；只改命名，不動驗收\n'
            '- kiwi（codex gpt-6-astra）：agree；屬固定清單第 1 類\n')
QUESTION = '## 要開工嗎？\n\n驗收條件如票。\n\n- A. 開工\n- B. 先不要\n'


def git(cwd, *args):
    subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True,
                   env=dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull))


class UnattendedStopCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.work = self.root / 'work'
        self.work.mkdir()
        git(self.work, 'init', '-q', '-b', 'dev')
        self.lat = self.work / '.lat'
        self.decisions = self.lat / 'decisions'
        self.decisions.mkdir(parents=True)
        self.reports = self.root / 'reports'
        self.reports.mkdir()
        # The duty check needs a duty on record before a tagged Stop.
        (self.reports / f'{SESSION}.duty.json').write_text('{}')
        self.binary = self.root / 'bin'
        self.binary.mkdir()
        for name in ('hcom', 'herdr'):
            stub = self.binary / name
            stub.write_text('#!/bin/sh\nexit 2\n')
            stub.chmod(0o755)
        self.write_record()

    def env(self, session=SESSION):
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(('HERDR_', 'HCOM_'))
                       and key not in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID')}
        environment.update(
            HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.root / 'xdg'),
            XDG_STATE_HOME=str(self.root / 'state'), LAT_REPORTS_DIR=str(self.reports),
            LAT_BOARD_STATE_DIR=str(self.root / 'board'), LAT_REAP_COMMAND='true',
            HERDR_PLUGIN_CONFIG_DIR=str(self.root / 'plugin-config'),
            HERDR_PLUGIN_STATE_DIR=str(self.root / 'plugin-state'),
            GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
            CODEX_THREAD_ID=session, PATH=f'{self.binary}:{os.environ["PATH"]}')
        return environment

    def run_script(self, script, *args, stdin='', session=SESSION):
        return subprocess.run([sys.executable, str(script), *map(str, args)], input=stdin,
                              text=True, capture_output=True, cwd=self.work,
                              env=self.env(session), timeout=60)

    def write_record(self, **extra):
        record = dict(client='codex', session_id=SESSION, role='orchestrator',
                      workspace=str(self.work), status='active', skill_dir=str(SKILL),
                      progress_path=str(self.work / 'progress.md'),
                      decisions_path=str(self.decisions), hcom_name='orch', history=[],
                      tasks_path=str(self.lat / 'tasks'))
        (self.lat / 'tasks').mkdir(parents=True, exist_ok=True)
        record.update(extra)
        path = self.lat / 'sessions' / f'{SESSION}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))

    # The unattended tool -------------------------------------------------------------------

    def unattended(self, *args, code=0):
        result = self.run_script(UNATTENDED, *args, '--json')
        self.assertEqual(result.returncode, code, result.stderr)
        return json.loads(result.stdout)

    def board_request(self, scope, op='create', goal='修好登入頁'):
        """The line the board writes to its action log when a device sends the grant form; a
        board-form grant must cite one that matches it."""
        log = self.root / 'board' / 'sent-log.jsonl'
        log.parent.mkdir(parents=True, exist_ok=True)
        number = len(log.read_text().splitlines()) + 1 if log.exists() else 1
        entry = dict(kind='unattended-request', id=f'fixture-{number}', op=op,
                     controllerId=SESSION, time=datetime.now(timezone.utc).isoformat(),
                     goal=goal, done=['登入成功跳到首頁'], maxHours=6,
                     scope=dict(ticket_confirmation='ticket-confirmation' in scope,
                                assume_defaults='assume-defaults' in scope,
                                prototype_decide='prototype' in scope))
        with log.open('a') as stream:
            stream.write(json.dumps(entry, ensure_ascii=False) + '\n')
        return f'board-action:{entry["id"]}'

    def grant(self, *scope):
        scope = scope or ('ticket-confirmation', 'assume-defaults', 'prototype')
        return self.unattended('create', *GRANT, '--evidence', self.board_request(scope),
                               '--scope', *scope)['created']

    # Records ----------------------------------------------------------------------------------

    def delegated(self, name, status='assumed', *, version=1, at=None, session=SESSION,
                  opinions=OPINIONS, extra='', drop=()):
        """A delegated record that passes unless changed; `drop` removes lines by prefix."""
        moment = at or datetime.now(timezone.utc)
        advisor = {'proxy-confirmed': 'ticket-confirmation', 'assumed': 'assume-defaults',
                   'prototype-decided': 'prototype'}[status]
        lines = [f'# {name} 代決', '', f'- status: {status}', f'- advisor: proxy {advisor}',
                 f'- session: {session}', f'- grant: r1 v{version}',
                 f'- decided-at: {moment.isoformat()}', '- version: r1',
                 '- question: 元件要叫什麼名字']
        if status == 'assumed':
            lines += ['- assume-class: naming', '- revert: 改成 LoginPanel']
        elif status == 'prototype-decided':
            lines += ['- sample: .lat/runs/issue-1/proto/index.html']
        lines = [line for line in lines if not line.startswith(drop)]
        body = '\n'.join(lines) + '\n' + extra + '\n' + opinions
        if status == 'proxy-confirmed':
            body += '\n## 驗收對照\n\n- 登入成功跳到首頁 ← 「登入後要回首頁」 session s-1 第 2 則\n'
        path = self.decisions / f'{name}.md'
        path.write_text(body)
        return path

    def started(self, version):
        return datetime.fromisoformat(version['started_at'])

    # Turn ends --------------------------------------------------------------------------------

    def stop(self, message='還在進行', active=False):
        payload = dict(hook_event_name='Stop', cwd=str(self.work), session_id=SESSION,
                       stop_hook_active=active, last_assistant_message=message)
        result = self.run_script(SESSION_SCRIPT, 'hook', '--client', 'codex',
                                 stdin=json.dumps(payload), session=OTHER)
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        return json.loads(result.stdout) if result.stdout else {}

    def assert_held(self, output, *parts):
        self.assertEqual(output.get('decision'), 'block', output)
        for part in parts:
            self.assertIn(part, output['reason'])
        return output['reason']


class QuestionTagTests(UnattendedStopCase):
    def test_decide_is_held_once_while_the_grant_is_in_effect_and_passes_without_one(self):
        (self.decisions / 'LAT-A.md').write_text(
            f'- status: pending\n- advisor: needs-human\n- session: {SESSION}\n')
        for tag in ('DECIDE', 'HELP'):
            with self.subTest('manual round', tag=tag):
                output = self.stop(f'題目\n{tag}: LAT-A r1')
                self.assertNotIn('無人模式', json.dumps(output, ensure_ascii=False))
        self.grant()
        for tag in ('DECIDE', 'HELP'):
            with self.subTest('unattended round', tag=tag):
                self.assert_held(self.stop(f'題目\n{tag}: LAT-A r1'), 'LAT 無人模式檢查未通過',
                                 'parked', 'NO REPLY:')
                released = self.stop(f'題目\n{tag}: LAT-A r1', active=True)
                self.assertNotIn('decision', released)
                self.assertIn('本回合已繼續過，不再攔下', released['systemMessage'])
        self.unattended('close', '--reason', 'off')
        self.assertNotIn('無人模式', json.dumps(self.stop('題目\nDECIDE: LAT-A r1'),
                                               ensure_ascii=False))


class DelegatedRecordTests(UnattendedStopCase):
    def test_valid_records_pass_and_keep_passing_after_the_grant_ends(self):
        self.grant()
        for status in ('proxy-confirmed', 'assumed', 'prototype-decided'):
            self.delegated(f'LAT-{status}', status)
        # may_settle: an advisor-resolved record never needs the grant.
        (self.decisions / 'LAT-R.md').write_text(
            '- status: advisor-resolved\n- advisor: resolved\n- authority: 預先授權 全域：may_settle\n')
        self.assertEqual(self.stop(), {})
        self.unattended('close', '--reason', 'off')
        self.assertEqual(self.stop(), {})
        self.assertEqual(self.stop('收尾\nNO REPLY: 尚無新增結果', active=True).get('decision'), None)

    def test_every_defect_is_held_and_listed_per_record(self):
        first = self.grant('ticket-confirmation', 'assume-defaults')
        cases = {
            'NOVER': (dict(version=9), '不存在'),
            'EARLY': (dict(at=self.started(first) - timedelta(minutes=5)), '不在授權 r1 v1 的生效期間'),
            'FUTURE': (dict(at=datetime.now(timezone.utc) + timedelta(hours=1)), '晚於現在'),
            'ONEADV': (dict(opinions='## 參謀意見\n\n- puma（claude opus）：agree；可以\n'),
                       '缺參謀結論'),
            'DISAGREE': (dict(opinions=OPINIONS.replace('agree；屬', 'disagree；不屬')),
                         '應記為擱置'),
            'HUMAN': (dict(extra='\n## 答覆（r1，聊天）\n\n- 答覆：A\n- 來源：聊天\n'), '真人答覆段落'),
            'ACTION': (dict(extra='- action: push main abc123\n'), '一定擱置'),
            'HELPKIND': (dict(extra='- kind: help\n'), '求助題'),
            'CONSENSUS': (dict(extra='- consensus: v2 ' + '0' * 64 + '\n'), 'Spec 共識'),
            'NOCLASS': (dict(drop=('- assume-class',)), '假設類別未標'),
            'BADCLASS': (dict(drop=('- assume-class',), extra='- assume-class: scope\n'),
                         '假設類別未標或不在固定清單'),
            'NOREVERT': (dict(drop=('- revert',)), '缺 `- revert:`'),
            'NOGRANT': (dict(drop=('- grant',)), '缺授權版本'),
            'NOSESSION': (dict(drop=('- session',)), '缺 `- session:`'),
        }
        for name, (changes, _) in cases.items():
            self.delegated(name, **changes)
        self.delegated('EXEMPT', 'proxy-confirmed').write_text(
            self.delegated('EXEMPT', 'proxy-confirmed').read_text().replace(
                'proxy ticket-confirmation', 'exempt spec-confirmation'))
        self.delegated('NOSAMPLE', 'prototype-decided', drop=('- sample',))
        self.delegated('NOROWS', 'proxy-confirmed').write_text(
            self.delegated('NOROWS', 'proxy-confirmed').read_text().split('## 驗收對照')[0])
        reason = self.assert_held(self.stop(), 'LAT 代決紀錄檢查未通過')
        lines = {line.split('（')[0][2:]: line for line in reason.splitlines()
                 if line.startswith('- ')}
        for name, (_, text) in cases.items():
            with self.subTest(name):
                self.assertIn(text, lines[name])
        self.assertIn('屬一定擱置類別', lines['EXEMPT'])
        self.assertIn('缺 `- sample:`', lines['NOSAMPLE'])
        # The grant did not check prototype, so a sample decision is out of scope too.
        self.assertIn('沒有勾選「做樣品再決定」', lines['NOSAMPLE'])
        self.assertIn('驗收對照', lines['NOROWS'])
        # Version 1 ended when version 2 replaced it: citing v1 afterwards is held.
        self.unattended('update', '--goal', '改目標', '--source', 'user-edit', '--evidence',
                        self.board_request(('ticket-confirmation', 'assume-defaults'),
                                           op='update', goal='改目標'))
        for path in self.decisions.glob('*.md'):
            path.unlink()
        self.delegated('OLDV', at=datetime.now(timezone.utc))
        second = self.unattended('versions')['versions'][1]
        self.delegated('INV1', at=self.started(first) + (self.started(second) - self.started(first)) / 2)
        reason = self.assert_held(self.stop(), 'OLDV')
        self.assertIn('ended at', reason)
        self.assertNotIn('INV1', reason)

    def test_a_question_already_asked_cannot_become_a_delegated_record(self):
        self.grant()
        self.delegated('LAT-ASKED')
        report = dict(session_id=SESSION, tag='DECIDE', message='題目\nDECIDE: LAT-ASKED r1',
                      round=1)
        (self.reports / f'{SESSION}.jsonl').write_text(json.dumps(report) + '\n')
        self.assert_held(self.stop(), 'LAT-ASKED', '已問過使用者')

    def test_records_of_another_session_are_left_to_their_controller(self):
        self.delegated('LAT-PREDECESSOR', session=OTHER, version=7)
        self.assertEqual(self.stop(), {})

    def test_delegated_records_without_any_grant_are_held(self):
        self.delegated('LAT-NOGRANT')
        self.assert_held(self.stop(), 'LAT-NOGRANT', '不存在')


class ParkedTests(UnattendedStopCase):
    def test_parked_items_need_no_question_and_a_no_reply_turn_passes_after_waiting(self):
        self.grant()
        (self.decisions / 'LAT-P.md').write_text(
            f'- status: parked\n- advisor: exempt spec-confirmation\n- session: {SESSION}\n'
            '- version: r1\n- question: Spec 要不要改\n')
        held = self.assert_held(self.stop('等待中\nNO REPLY: 擱置一項，其他照做'), 'LAT 等待檢查未通過')
        self.assertNotIn('LAT-P', held)
        waited = self.run_script(WATCH, 'wait', '--workspace', self.work, '--agent', 'orch',
                                 '--for-pending', '--reason', '只剩擱置項')
        self.assertEqual(waited.returncode, 0, waited.stderr)
        self.assertIn('LAT-P', waited.stdout)
        # Nothing about the parked item reaches the user: no hold, no shown question.
        self.assertEqual(self.stop('等待中\nNO REPLY: 擱置一項，其他照做'), {})


class PreauthTests(UnattendedStopCase):
    def test_the_grant_never_changes_what_push_and_deploy_preauthorization_answer(self):
        config = self.root / 'xdg/lat/preauth.toml'
        config.parent.mkdir(parents=True)
        config.write_text('[actions.merge]\nallow = true\nbranches = ["dev"]\n'
                          '[actions.push]\nallow = true\nbranches = ["main"]\n'
                          '[actions.deploy]\nallow = false\n')

        def answers():
            found = {}
            for action, branch in (('merge', 'dev'), ('push', 'main'), ('deploy', None)):
                args = ['check', '--action', action, '--json']
                if branch:
                    args += ['--branch', branch]
                result = self.run_script(PREAUTH, *args)
                found[action] = json.loads(result.stdout)
                found[action].pop('checked_at', None)
            return found

        before = answers()
        self.grant()
        self.assertEqual(self.unattended('status')['state'], 'active')
        self.assertEqual(answers(), before)


class ChatTests(UnattendedStopCase):
    def panel(self, *args):
        result = self.run_script(PANEL, 'question', *args, '--decisions', self.decisions)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_a_submitted_confirmation_question_becomes_the_grant_evidence(self):
        questions = self.lat / 'questions/orch.md'
        section = self.root / 'confirm.md'
        section.write_text('## 這輪改成無人模式嗎？\n\n目標：修好登入頁；做完條件：登入成功跳到首頁；'
                           '參謀可代決：三項；何時停：額度用完或 6 小時。\n\n- A. 確認開啟\n- B. 先不要\n')
        self.panel('ask', '--questions', questions, '--id', 'LAT-ON', '--file', section,
                   '--advisor', 'exempt requirement-discussion', '--session-id', SESSION)
        self.unattended('create', *GRANT[:6], '--scope', 'ticket-confirmation',
                        '--source', 'chat', '--evidence', 'LAT-ON r1', code=1)
        self.panel('record-chat', '--questions', questions, '--id', 'LAT-ON', '--text', 'A',
                   '--source', 'session s-1 第 4 則')
        created = self.unattended('create', *GRANT[:6], '--scope', 'ticket-confirmation',
                                  '--source', 'chat', '--evidence', 'LAT-ON r1')['created']
        self.assertEqual(created['source'], 'chat')
        status = self.unattended('status')
        self.assertEqual((status['state'], status['settings']['mode']['layer']),
                         ('active', 'controller'))

    def test_a_reply_or_override_to_a_review_item_is_recorded_as_the_human_answer(self):
        self.grant()
        (self.decisions / 'LAT-P.md').write_text(
            f'- status: parked\n- advisor: needs-human\n- session: {SESSION}\n- version: r2\n')
        self.delegated('LAT-AS')
        self.unattended('close', '--reason', 'off')
        for name, text in (('LAT-P', '照 B 做'), ('LAT-AS', '推翻：改叫 SignIn')):
            with self.subTest(name):
                result = self.panel('record-chat', '--id', name, '--text', text,
                                    '--source', 'session s-1 回顧頁')
                self.assertEqual(json.loads(result.stdout)['status'], 'answered')
                record = (self.decisions / f'{name}.md').read_text()
                self.assertIn('- status: answered', record)
                self.assertIn(f'- 答覆：{text}', record)
                self.assertIn('- 來源：聊天，session s-1 回顧頁（回顧項目）', record)
        self.assertIn('## 答覆（r2，聊天', (self.decisions / 'LAT-P.md').read_text())
        self.assertEqual(self.stop(), {})
        approved = self.panel('approve', '--id', 'LAT-AS', '--scope', '元件改叫 SignIn')
        self.assertIn('approved', approved.stdout)


if __name__ == '__main__':
    unittest.main()
