"""Pre-authorization recheck where questions are asked: panel `question upsert` and the
DECIDE/HELP Stop check. Temp HOME/XDG, a temp Git workspace and a fake herdr only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
SESSION_SCRIPT = SKILL / 'scripts/lat-session.py'
PANEL = SKILL / 'herdr-panel/lat_panel.py'
SESSION = '11111111-1111-4111-8111-111111111111'
ALLOW_MERGE = '[actions.merge]\nallow = true\nbranches = ["dev"]\nsource = "P-1"\n'
RECORD = '- status: pending\n- advisor: needs-human\n- action: merge dev\n'
QUESTION = '## 合併到 dev？\n要合併嗎？\n\n- A. 合併\n- B. 先不要\n'


class PreauthQuestionTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.work = self.root / 'work'
        self.work.mkdir()
        self.git('init', '-q', '-b', 'dev')
        self.git('-c', 'user.email=t@example.com', '-c', 'user.name=T',
                 'commit', '-q', '--allow-empty', '-m', 'first')
        self.decisions = self.work / '.lat/decisions'
        self.decisions.mkdir(parents=True)
        self.project = self.work / '.lat/preauth.toml'
        self.reports = self.root / 'reports'
        self.reports.mkdir()
        # A duty on record, so DECIDE Stops are not held for the duty check.
        (self.reports / f'{SESSION}.duty.json').write_text('{"text": "t", "expected": "e"}')
        self.decision = self.decisions / 'LAT-P.md'
        self.decision.write_text(RECORD)
        self.source = self.root / 'question.md'
        self.source.write_text(QUESTION)
        herdr = self.root / 'bin/herdr'
        herdr.parent.mkdir()
        herdr.write_text(
            '#!/bin/sh\n'
            'if [ "$*" = "plugin list --plugin lat.panel --json" ]; then\n'
            '  printf \'%s\\n\' \'{"result":{"plugins":[{"plugin_id":"lat.panel","enabled":true}]}}\'\n'
            'fi\n')
        herdr.chmod(0o755)

    def git(self, *args):
        subprocess.run(['git', '-C', str(self.work), *args], check=True, capture_output=True,
                       env=dict(os.environ, GIT_CONFIG_NOSYSTEM='1',
                                GIT_CONFIG_GLOBAL=os.devnull))

    def env(self):
        env = {key: value for key, value in os.environ.items()
               if key not in ('CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'XDG_STATE_HOME')}
        env.update(HOME=str(self.root / 'home'), XDG_CONFIG_HOME=str(self.root / 'xdg'),
                   LAT_REPORTS_DIR=str(self.reports), GIT_CONFIG_NOSYSTEM='1',
                   GIT_CONFIG_GLOBAL=os.devnull, HCOM_LAUNCHED_BY='tester',
                   HERDR_PLUGIN_CONFIG_DIR=str(self.root / 'plugin-config'),
                   HERDR_WORKSPACE_ID='herdr-workspace', HERDR_TAB_ID='herdr-tab',
                   HERDR_PANE_ID='herdr-pane', PATH=f'{self.root / "bin"}:{os.environ["PATH"]}')
        return env

    def run_script(self, *args, payload=None):
        return subprocess.run([sys.executable, *map(str, args)], text=True, capture_output=True,
                              input=json.dumps(payload) if payload is not None else '',
                              env=self.env(), cwd=self.work, timeout=60)

    def controller(self, client='codex'):
        record = dict(client=client, session_id=SESSION, role='orchestrator',
                      workspace=str(self.work), status='active', skill_dir=str(SKILL),
                      hcom_name='orch', decisions_path=str(self.decisions))
        path = self.work / '.lat/sessions' / f'{SESSION}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))

    def bind(self, client='codex'):
        result = self.run_script(PANEL, 'bind', '--client', client, '--session-id', SESSION,
                                 '--workspace', self.work, '--hcom-name', 'orch')
        self.assertEqual(result.returncode, 0, result.stderr)
        questions = Path(json.loads(result.stdout)['binding']['questions_path'])
        questions.parent.mkdir(parents=True, exist_ok=True)
        return questions

    def unbind(self):
        result = self.run_script(PANEL, 'unbind', '--session-id', SESSION)
        self.assertEqual(result.returncode, 0, result.stderr)

    def upsert(self, questions, identifier='LAT-P'):
        return self.run_script(PANEL, 'question', 'upsert', '--questions', questions,
                               '--decisions', self.decisions, '--id', identifier,
                               '--file', self.source)

    def stop(self, message, client='codex', active=False):
        payload = dict(hook_event_name='Stop', cwd=str(self.work), session_id=SESSION,
                       stop_hook_active=active, last_assistant_message=message)
        result = self.run_script(SESSION_SCRIPT, 'hook', '--client', client, payload=payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def preauth_lines(self):
        return [line for line in self.decision.read_text().splitlines()
                if line.startswith('- preauth:')]


class UpsertTests(PreauthQuestionTests):
    def setUp(self):
        super().setUp()
        self.controller()
        self.questions = self.bind()

    def test_unsent_question_allowed_now_is_refused_and_nothing_is_written(self):
        self.project.write_text(ALLOW_MERGE)
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 1)
        self.assertIn('refused, nothing written: LAT-P is pre-authorized', result.stderr)
        self.assertIn('allow merge dev', result.stderr)
        self.assertIn('lat-preauth.py record', result.stderr)
        self.assertFalse(self.questions.exists())
        self.assertEqual(self.decision.read_text(), RECORD)

    def test_unsent_question_that_must_be_asked_is_written_with_the_preauth_line(self):
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], 'LAT-P r1')
        self.assertNotIn('提醒', result.stdout)
        self.assertIn('LAT-P · r1 · 待答', self.questions.read_text())
        lines = self.decision.read_text().splitlines()
        self.assertEqual(lines[2], '- action: merge dev')
        self.assertTrue(lines[3].startswith(
            '- preauth: ask merge dev — reasons: no layer sets actions.merge.allow'), lines[3])

    def test_recheck_ignores_the_recorded_preauth_line_both_ways(self):
        # ask -> allow: the old line says ask, the current settings allow.
        self.decision.write_text(RECORD + '- preauth: ask merge dev — reasons: old\n')
        self.project.write_text(ALLOW_MERGE)
        self.assertEqual(self.upsert(self.questions).returncode, 1)
        self.assertFalse(self.questions.exists())
        # allow -> ask: the old line says allow, the current settings ask.
        self.decision.write_text(RECORD + '- preauth: allow merge dev — basis: old\n')
        self.project.write_text('[actions.merge]\nallow = false\nbranches = ["dev"]\n')
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('LAT-P · r1 · 待答', self.questions.read_text())
        [line] = self.preauth_lines()
        self.assertIn('ask merge dev — reasons: actions.merge.allow=false', line)

    def test_question_already_on_the_panel_is_rewritten_with_a_reminder(self):
        self.assertEqual(self.upsert(self.questions).returncode, 0)
        self.project.write_text(ALLOW_MERGE)
        self.source.write_text(QUESTION + '\n補充說明。\n')
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], 'LAT-P r2')
        self.assertIn('提醒：LAT-P 此題目前已預先授權，可由使用者決定撤回（allow merge dev', result.stdout)
        self.assertIn('LAT-P · r2 · 待答', self.questions.read_text())
        [line] = self.preauth_lines()
        self.assertIn('allow merge dev — basis:', line)

    def test_question_only_in_the_archive_counts_as_sent(self):
        archive = self.questions.with_name(f'{self.questions.stem}-archive.md')
        archive.write_text('## 合併到 dev？\nLAT-P · r1 · 待答\n\n要合併嗎？\n')
        self.project.write_text(ALLOW_MERGE)
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('提醒：LAT-P', result.stdout)

    def test_question_asked_in_chat_before_allow_is_written_with_a_reminder(self):
        self.unbind()
        self.assertEqual(self.stop('問題全文\nDECIDE: LAT-P r1'), {})
        self.questions = self.bind()
        self.project.write_text(ALLOW_MERGE)
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('提醒：LAT-P', result.stdout)
        self.assertIn('LAT-P · r1 · 待答', self.questions.read_text())

    def test_record_without_action_is_unchanged(self):
        plain = '- status: pending\n- advisor: needs-human\n'
        self.decision.write_text(plain)
        self.project.write_text(ALLOW_MERGE)
        result = self.upsert(self.questions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['LAT-P r1'])
        self.assertEqual(self.decision.read_text(), plain)


class StopTests(PreauthQuestionTests):
    HELD = 'LAT 預先授權檢查未通過：LAT-P（allow merge dev'
    REMINDER = 'LAT 預先授權提醒：LAT-P 此題目前已預先授權，可由使用者決定撤回'

    def test_unbound_unsent_allowed_question_is_held_once_for_both_clients(self):
        self.project.write_text(ALLOW_MERGE)
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.controller(client)
                output = self.stop('問題全文\nDECIDE: LAT-P r1', client)
                self.assertEqual(output['decision'], 'block')
                self.assertIn(self.HELD, output['reason'])
                self.assertIn('lat-preauth.py record', output['reason'])
                warning = self.stop('問題全文\nDECIDE: LAT-P r1', client, active=True)
                self.assertEqual(set(warning), {'systemMessage'})
                self.assertIn(self.HELD, warning['systemMessage'])
                self.assertIn('不再攔下', warning['systemMessage'])
                (self.reports / f'{SESSION}.jsonl').unlink()

    def test_unsent_allowed_help_question_is_held(self):
        self.project.write_text(ALLOW_MERGE)
        self.decision.write_text(RECORD + '- kind: help\n')
        self.controller()
        output = self.stop('問題全文\nHELP: LAT-P r1')
        self.assertEqual(output['decision'], 'block')
        self.assertIn(self.HELD, output['reason'])

    def test_question_on_the_panel_stays_sent_after_unbinding(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.controller(client)
                questions = self.bind(client)
                questions.unlink(missing_ok=True)
                self.project.unlink(missing_ok=True)
                self.assertEqual(self.upsert(questions).returncode, 0)
                self.unbind()
                self.project.write_text(ALLOW_MERGE)
                output = self.stop('問題全文\nDECIDE: LAT-P r1', client)
                self.assertEqual(set(output), {'systemMessage'})
                self.assertIn(self.REMINDER, output['systemMessage'])
                (self.reports / f'{SESSION}.jsonl').unlink()

    def test_question_asked_in_chat_then_allowed_passes_with_a_reminder(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.controller(client)
                self.project.unlink(missing_ok=True)
                self.assertEqual(self.stop('問題全文\nDECIDE: LAT-P r1', client), {})
                self.project.write_text(ALLOW_MERGE)
                output = self.stop('改版題目\nDECIDE: LAT-P r2', client)
                self.assertEqual(set(output), {'systemMessage'})
                self.assertIn(self.REMINDER, output['systemMessage'])
                (self.reports / f'{SESSION}.jsonl').unlink()

    def test_question_on_the_panel_then_allowed_passes_with_a_reminder(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.controller(client)
                questions = self.bind(client)
                questions.unlink(missing_ok=True)
                self.project.unlink(missing_ok=True)
                self.assertEqual(self.upsert(questions).returncode, 0)
                self.project.write_text(ALLOW_MERGE)
                output = self.stop('DECIDE: LAT-P r1', client)
                self.assertEqual(set(output), {'systemMessage'})
                self.assertIn('❓ LAT-P r1 - 合併到 dev？', output['systemMessage'])
                self.assertIn(self.REMINDER, output['systemMessage'])
                (self.reports / f'{SESSION}.jsonl').unlink()

    def test_ask_and_records_without_action_pass_unchanged(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.controller(client)
                self.decision.write_text(RECORD)
                self.project.unlink(missing_ok=True)
                self.assertEqual(self.stop('問題全文\nDECIDE: LAT-P r1', client), {})
                self.decision.write_text('- status: pending\n- advisor: needs-human\n')
                self.project.write_text(ALLOW_MERGE)
                self.assertEqual(self.stop('問題全文\nDECIDE: LAT-P r2', client), {})
                (self.reports / f'{SESSION}.jsonl').unlink()


if __name__ == '__main__':
    unittest.main()
