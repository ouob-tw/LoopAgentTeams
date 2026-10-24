"""CLI contract tests; only disposable local files, no Codex/model calls."""
import json
import argparse
from datetime import datetime, timezone
import importlib.util
from unittest.mock import patch
import os
from pathlib import Path
import re
import subprocess
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-session.py'
SKILL = SCRIPT.parent.parent
PANEL = SKILL / 'herdr-panel/lat_panel.py'
SESSION = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'
SEPARATOR = '\n\n' + '─' * 20 + '\n\n'


def setUpModule():
    # No test may run a real reap against the host; tests that check the call replace this.
    patcher = patch.dict(os.environ, LAT_REAP_COMMAND='true')
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        (self.work / '.git').mkdir()
        self.progress = self.work / 'progress.md'
        self.progress.write_text('Existing tracker links and progress\n')
        self.decisions = self.work / 'decisions'
        self.decisions.mkdir()
        self.tasks = self.work / '.lat/tasks'
        self.tasks.mkdir(parents=True)
        self.record = self.work / '.lat/sessions' / f'{SESSION}.json'
        self.binary = self.root / 'bin'
        self.binary.mkdir()
        self.fake_uv_log = self.root / 'fake-uv.log'
        uv = self.binary / 'uv'
        uv.write_text(
            '#!/bin/sh\n'
            'printf \'%s\\n\' "$$ $*" >> "$FAKE_UV_LOG"\n'
            "trap 'exit 0' TERM INT\n"
            'while :; do sleep 0.05; done\n'
        )
        uv.chmod(0o755)
        self.addCleanup(self.stop_fake_watchers)

    def cli(self, *args, payload=None, session=SESSION, claude_session='', extra_env=None,
            watch_args=True, script=SCRIPT):
        args = list(args)
        if args and args[0] == 'activate' and watch_args:
            if '--hcom-name' not in args:
                args += ['--hcom-name', 'orch']
            if '--tasks' not in args:
                args += ['--tasks', self.tasks]
        env = self.cli_environment(session, claude_session, extra_env)
        return subprocess.run([sys.executable, str(script), *map(str, args)],
                              input=json.dumps(payload) if payload is not None else '',
                              text=True, capture_output=True, env=env, cwd=self.work)

    def cli_environment(self, session=SESSION, claude_session='', extra_env=None):
        env = dict(os.environ, CODEX_THREAD_ID=session,
                   CLAUDE_CODE_SESSION_ID=claude_session)
        for variable in ('HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID',
                         'HERDR_PLUGIN_CONFIG_DIR', 'HCOM_INSTANCE_NAME'):
            env.pop(variable, None)
        env['HERDR_PLUGIN_CONFIG_DIR'] = str(self.root / 'plugin-config')
        env['FAKE_UV_LOG'] = str(self.fake_uv_log)
        env['LAT_REPORTS_DIR'] = str(self.root / 'reports')
        env['PATH'] = f'{self.binary}:{env["PATH"]}'
        # The activation check for unregistered sessions has its own tests.
        env['HCOM_LAUNCHED_BY'] = 'tester'
        env.update(extra_env or {})
        return env

    def activate(self, session=SESSION, duty=True):
        result = self.cli('activate', '--workspace', self.work,
                          '--progress', self.progress, '--decisions', self.decisions,
                          session=session)
        self.assertEqual(result.returncode, 0, result.stderr)
        if duty:
            self.record_duty(session=session)

    def record_duty(self, text='整理看板名冊', expected='名冊顯示職責', session=SESSION,
                    client='codex', extra_env=None):
        extra = dict(extra_env or {})
        if client == 'claude':
            extra['CLAUDE_CODE_SESSION_ID'] = session
        return self.cli('duty', '--client', client, '--workspace', self.work, '--text', text,
                        '--expected', expected, session=session, extra_env=extra)

    def duty_file(self, session=SESSION):
        return self.root / 'reports' / f'{session}.duty.json'

    def test_hook_and_deactivate_keep_ownership_after_helper_directory_changes(self):
        installed = self.root / 'installed-lat'
        shutil.copytree(SKILL, installed)
        installed_script = installed / 'scripts/lat-session.py'
        self.activate()
        pid = self.watcher_pid()
        self.addCleanup(self.stop_process_group, pid)
        self.wait_for(self.fake_uv_log.exists)
        for source in ('compact', 'resume'):
            result = self.cli('hook', script=installed_script, payload=dict(
                hook_event_name='SessionStart', source=source, cwd=str(self.work),
                session_id=SESSION))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('recovery error', result.stdout)
            self.assertEqual(self.watcher_pid(), pid)
        self.assertEqual(len(self.fake_uv_log.read_text().splitlines()), 1)
        result = self.cli('deactivate', '--workspace', self.work,
                          script=installed_script)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: not self.process_exists(pid))
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())

    def stop_process_group(self, pid):
        try:
            os.killpg(pid, 15)
        except ProcessLookupError:
            pass

    def test_recovery_restart_uses_record_skill_directory_from_another_helper(self):
        installed = self.root / 'installed-lat'
        shutil.copytree(SKILL, installed)
        self.activate()
        pid = self.watcher_pid()
        self.stop_process_group(pid)
        self.wait_for(lambda: not self.process_exists(pid))
        self.fake_uv_log.write_text('')
        result = self.cli('hook', script=installed / 'scripts/lat-session.py', payload=dict(
            hook_event_name='SessionStart', source='resume', cwd=str(self.work),
            session_id=SESSION))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('recovery error', result.stdout)
        self.assertNotEqual(self.watcher_pid(), pid)
        self.wait_for(lambda: bool(self.fake_uv_log.read_text()))
        self.assertIn(str(SKILL / 'scripts/lat-watch.py'), self.fake_uv_log.read_text())
        self.assertNotIn(str(installed), self.fake_uv_log.read_text())

    def start_watcher_command(self, script, **overrides):
        values = dict(workspace=str(self.work), orchestrator='orch',
                      tasks=str(self.tasks), decisions=str(self.decisions))
        values.update(overrides)
        command = [str(self.binary / 'uv'), 'run', '--no-project', 'python', str(script), 'run']
        for key, value in values.items():
            command += [f'--{key}', value]
        process = subprocess.Popen(command, env=self.cli_environment(),
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   start_new_session=True)
        self.addCleanup(self.terminate_process, process)
        self.work.joinpath('.lat/watch', f'{SESSION}.pid').write_text(str(process.pid))
        return process

    def test_activate_keeps_existing_watcher_from_another_directory(self):
        installed = self.root / 'installed-lat'
        shutil.copytree(SKILL, installed)
        script = installed / 'scripts/lat-session.py'
        args = ('activate', '--workspace', self.work, '--progress', self.progress,
                '--decisions', self.decisions)
        result = self.cli(*args, script=script)
        self.assertEqual(result.returncode, 0, result.stderr)
        pid = self.watcher_pid()
        self.stop_process_group(pid)
        self.wait_for(lambda: not self.process_exists(pid))
        process = self.start_watcher_command(SKILL / 'scripts/lat-watch.py')
        rerun = self.cli(*args, script=script)
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(self.watcher_pid(), process.pid)
        result = self.cli('deactivate', '--workspace', self.work,
                          script=script)
        self.assertEqual(result.returncode, 0, result.stderr)
        process.wait(timeout=3)

    def test_deactivate_does_not_stop_unrelated_watcher_arguments_or_script(self):
        self.activate()
        pid = self.watcher_pid()
        self.stop_process_group(pid)
        self.wait_for(lambda: not self.process_exists(pid))
        for changed in ('workspace', 'orchestrator', 'tasks', 'decisions', 'script'):
            with self.subTest(changed=changed):
                script = SKILL / 'scripts/lat-watch.py'
                overrides = {changed: 'unrelated'} if changed != 'script' else {}
                if changed == 'script':
                    script = SKILL / 'scripts/other-watch.py'
                process = self.start_watcher_command(script, **overrides)
                result = self.cli('deactivate', '--workspace', self.work)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIsNone(process.poll())
                self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())
                self.terminate_process(process)

    def stop_hook(self, message='Question\nDECIDE: LAT-A r1', client='codex', **overrides):
        payload = dict(hook_event_name='Stop', cwd=str(self.work), session_id=SESSION,
                       stop_hook_active=False, last_assistant_message=message)
        payload.update(overrides)
        return self.cli('hook', '--client', client, payload=payload, session=OTHER)

    def reports(self):
        path = self.root / 'reports' / f'{SESSION}.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def test_reports_all_tags_and_plain_messages_for_both_clients(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.activate()
                record = json.loads(self.record.read_text())
                record['client'] = client
                self.record.write_text(json.dumps(record))
                self.decisions.joinpath('LAT-A.md').write_text(
                    '- status: pending\n- advisor: exempt requirement-discussion\n')
                self.decisions.joinpath('LAT-H.md').write_text(
                    '- status: pending\n- advisor: needs-human\n- kind: help\n')
                messages = [('DECIDE', 'LAT-A r1'), ('HELP', 'LAT-H r1 need assistance'),
                            ('DONE', 'delivered'), ('NO REPLY', 'waiting'), ('', '')]
                for tag, summary in messages:
                    message = f'Full message\n{tag}: {summary}\n\n' if tag else 'Plain message\n'
                    before = len(self.reports())
                    result = self.stop_hook(message, client)
                    self.assert_silent(result)
                    report = self.reports()[-1]
                    self.assertEqual(len(self.reports()), before + 1)
                    self.assertEqual(report['session_id'], SESSION)
                    self.assertEqual(report['client'], client)
                    self.assertEqual(report['hcom_name'], 'orch')
                    self.assertEqual(report['workspace'], str(self.work))
                    self.assertEqual(report['round'], 1)
                    self.assertEqual(report['tag'], tag)
                    self.assertEqual(report['summary'], summary)
                    self.assertEqual(report['message'], message)
                    self.assertFalse(report['final'])
                    self.assertTrue(report['time'].endswith('Z'))
                self.record.unlink()
                (self.root / 'reports' / f'{SESSION}.jsonl').unlink()

    def test_reports_blocked_stop_warning_release_and_append_only(self):
        self.activate()
        self.assert_stop_block(self.stop_hook(), 'LAT-A')
        self.assertEqual(self.reports(), [])
        warning = self.stop_hook(stop_hook_active=True)
        self.assertIn('systemMessage', json.loads(warning.stdout))
        self.assertEqual(len(self.reports()), 1)
        path = self.root / 'reports' / f'{SESSION}.jsonl'
        previous = path.read_bytes()
        self.assert_silent(self.stop_hook('DONE: all finished'))
        self.assertTrue(path.read_bytes().startswith(previous))
        self.assertEqual(len(self.reports()), 2)

    def test_final_report_once_after_each_finished_status_and_new_round(self):
        self.activate()
        for round_number, status in enumerate(('completed', 'cancelled'), 1):
            args = ('deactivate', '--workspace', self.work, '--status', status)
            self.assertEqual(self.cli(*args).returncode, 0)
            self.assert_silent(self.stop_hook('DONE: delivery'))
            self.assertEqual(len(self.reports()), round_number * 2 - 1)
            report = self.reports()[-1]
            self.assertTrue(report['final'])
            self.assertEqual(report['round'], round_number)
            self.assertEqual(self.cli(*args).returncode, 0)
            self.assert_silent(self.stop_hook('HELP: later conversation'))
            self.assertEqual(len(self.reports()), round_number * 2 - 1)
            self.activate()
            self.assert_silent(self.stop_hook('NO REPLY: working'))
            self.assertEqual(len(self.reports()), round_number * 2)
            self.assertFalse(self.reports()[-1]['final'])
            self.assertEqual(self.reports()[-1]['round'], round_number + 1)

    def test_duty_is_written_replaced_and_refused_when_invalid(self):
        self.activate(duty=False)
        result = self.record_duty('  整理看板名冊  ', '名冊顯示職責')
        self.assertEqual(result.returncode, 0, result.stderr)
        duty = json.loads(self.duty_file().read_text())
        self.assertEqual((duty['text'], duty['expected']), ('整理看板名冊', '名冊顯示職責'))
        self.assertTrue(duty['time'].endswith('Z'))
        self.assertEqual(self.duty_file().stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.record_duty('改做交付', '已推送').returncode, 0)
        self.assertEqual(json.loads(self.duty_file().read_text())['text'], '改做交付')
        before = self.duty_file().read_bytes()
        for text, expected, detail in (('職' * 41, '結果', 'at most 40'), ('兩行\n職責', '結果', 'one line'),
                                       ('   ', '結果', 'must not be empty'),
                                       ('職責', '', 'must not be empty')):
            with self.subTest(text=text, expected=expected):
                result = self.record_duty(text, expected)
                self.assertEqual(result.returncode, 1)
                self.assertIn(detail, result.stderr)
                self.assertEqual(self.duty_file().read_bytes(), before)
        self.assertEqual(self.record_duty('職' * 40, '結果').returncode, 0)

    def test_activate_prints_the_duty_command(self):
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'lat-session.py duty --client codex --workspace {self.work} --text',
                      result.stdout)

    def test_duty_needs_this_sessions_active_controller(self):
        self.activate(duty=False)
        other = self.record_duty(session=OTHER)
        self.assertEqual(other.returncode, 1)
        self.assertIn('No active controller', other.stderr)
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        ended = self.record_duty()
        self.assertEqual(ended.returncode, 1)
        self.assertIn('No active controller', ended.stderr)
        self.assertFalse(self.duty_file().exists())

    def test_tagged_stop_without_duty_is_held_once_with_the_command(self):
        self.activate(duty=False)
        held = self.stop_hook('Work done\nDONE: delivered')
        output = json.loads(held.stdout)
        self.assertEqual(output['decision'], 'block')
        self.assertIn('LAT 職責檢查未通過', output['reason'])
        self.assertIn(f'lat-session.py duty --client codex --workspace {self.work}', output['reason'])
        self.assertEqual(self.reports(), [])
        released = self.stop_hook('Work done\nDONE: delivered', stop_hook_active=True)
        self.assertIn('本回合已繼續過，不再攔下', json.loads(released.stdout)['systemMessage'])
        self.assertEqual(self.reports()[-1]['tag'], 'DONE')
        for message in ('NO REPLY: waiting', 'Plain message'):
            with self.subTest(message=message):
                self.assert_silent(self.stop_hook(message))
        self.assertEqual(self.record_duty().returncode, 0)
        self.assert_silent(self.stop_hook('DONE: delivered'))

    def test_question_stop_without_duty_lists_both_checks(self):
        self.activate(duty=False)
        held = json.loads(self.stop_hook('Question\nDECIDE: LAT-A r1').stdout)
        self.assertIn('LAT 職責檢查未通過', held['reason'])
        self.assertIn('LAT-A r1：沒有待決紀錄', held['reason'])
        self.decisions.joinpath('LAT-A.md').write_text(
            '- status: pending\n- advisor: exempt requirement-discussion\n')
        held = json.loads(self.stop_hook('Question\nDECIDE: LAT-A r1').stdout)
        self.assertTrue(held['reason'].startswith('LAT 職責檢查未通過'))
        self.assertNotIn('DECIDE 檢查未通過', held['reason'])

    def test_report_write_failure_does_not_change_stop_results(self):
        self.activate()
        destination = self.root / 'not-a-directory'
        destination.write_text('occupied')
        env = {'LAT_REPORTS_DIR': str(destination)}
        def stop(message, **values):
            return self.cli('hook', payload=dict(
                hook_event_name='Stop', session_id=SESSION, cwd=str(self.work),
                last_assistant_message=message, **values), extra_env=env)
        self.assert_stop_block(stop('DECIDE: LAT-A r1'), 'LAT-A')
        self.assertEqual(stop('DONE: complete').stdout, '')
        self.assertIn('LAT report warning:', stop('DONE: complete').stderr)
        warning = stop('DECIDE: LAT-A r1', stop_hook_active=True)
        self.assertIn('systemMessage', json.loads(warning.stdout))
        self.assertIn('LAT report warning:', warning.stderr)
        self.assertEqual(self.reports(), [])

    def test_non_controller_and_foreign_identity_do_not_write_reports(self):
        self.assert_silent(self.stop_hook('DONE: not LAT'))
        self.activate()
        original = json.loads(self.record.read_text())
        for key, value in (('role', 'worker'), ('client', 'claude'),
                           ('workspace', str(self.root)), ('session_id', OTHER)):
            record = dict(original, **{key: value})
            self.record.write_text(json.dumps(record))
            self.assert_silent(self.stop_hook('DONE: foreign'))
        self.assertEqual(self.reports(), [])

    def test_reports_use_xdg_state_and_home_fallback_outside_projects(self):
        self.activate()
        for state, directory in ((str(self.root / 'state'), self.root / 'state/lat/reports'),
                                 ('', self.root / '.local/state/lat/reports'),
                                 ('relative', self.root / '.local/state/lat/reports')):
            env = {'LAT_REPORTS_DIR': '', 'XDG_STATE_HOME': state, 'HOME': str(self.root)}
            self.assertEqual(self.record_duty(extra_env=env).returncode, 0)
            result = self.cli('hook', payload=dict(
                hook_event_name='Stop', session_id=SESSION, cwd=str(self.work),
                last_assistant_message='DONE: result'), extra_env=env)
            self.assert_silent(result)
            self.assertTrue((directory / f'{SESSION}.jsonl').is_file())
        self.assertFalse((self.work / '.lat/reports').exists())

    def test_final_report_failure_can_retry_and_concurrent_hooks_write_once(self):
        self.activate(duty=False)
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        destination = self.root / 'reports'
        destination.write_text('blocked')
        failed = self.stop_hook('DONE: delivery')
        self.assertEqual(failed.stdout, '')
        self.assertIn('LAT report warning:', failed.stderr)
        destination.unlink()
        results = []
        threads = [threading.Thread(target=lambda: results.append(
            self.stop_hook('DONE: delivery'))) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        for result in results:
            self.assert_silent(result)
        self.assertEqual(len(self.reports()), 1)
        self.assertTrue(self.reports()[0]['final'])

    def test_legacy_stop_stays_silent_until_activate_upgrades_identity(self):
        self.write_legacy_record()
        self.assert_silent(self.stop_hook('DONE: legacy'))
        self.decisions.joinpath('LAT-A.md').write_text(
            '- status: pending\n- advisor: exempt requirement-discussion\n')
        self.assert_silent(self.stop_hook())
        self.assertEqual(self.reports(), [])
        self.activate()
        self.assert_silent(self.stop_hook('DONE: upgraded'))
        self.assertEqual(len(self.reports()), 1)
        self.assertEqual(self.reports()[0]['hcom_name'], 'orch')

    def test_reports_check_error_release_and_exact_last_line_tags(self):
        self.activate()
        self.decisions.rmdir()
        released = self.stop_hook()
        self.assertIn('systemMessage', json.loads(released.stdout))
        self.assertEqual(len(self.reports()), 1)
        for message in ('DONE: earlier\nplain last line', 'DONEISH: text', '', '  HELP: indented'):
            self.assert_silent(self.stop_hook(message))
            self.assertEqual(self.reports()[-1]['tag'], '')
            self.assertEqual(self.reports()[-1]['summary'], '')
            self.assertEqual(self.reports()[-1]['message'], message)

    def test_corrupt_record_keeps_non_decide_stop_stdout_silent(self):
        self.activate()
        self.record.write_text('{broken')
        result = self.stop_hook('DONE: finished')
        self.assertEqual((result.returncode, result.stdout), (0, ''))
        self.assertEqual(self.reports(), [])
        self.assertIn('systemMessage', json.loads(self.stop_hook().stdout))

    def test_partial_report_tail_and_non_objects_do_not_block_later_rounds(self):
        self.activate()
        directory = self.root / 'reports'
        path = directory / f'{SESSION}.jsonl'
        original = b'[]\nnull\n{"time":"partial'
        path.write_bytes(original)
        self.assert_silent(self.stop_hook('NO REPLY: recovered active report'))
        self.assertTrue(path.read_bytes().startswith(original + b'\n'))
        active = json.loads(path.read_bytes().splitlines()[-1])
        self.assertFalse(active['final'])
        for status in ('completed', 'cancelled'):
            self.assertEqual(self.cli('deactivate', '--workspace', self.work,
                                      '--status', status).returncode, 0)
            self.assert_silent(self.stop_hook('DONE: final recovery'))
            previous = path.read_bytes()
            self.assertTrue(json.loads(previous.splitlines()[-1])['final'])
            self.assert_silent(self.stop_hook('DONE: later'))
            self.assertEqual(path.read_bytes(), previous)
            self.activate()

    def test_final_report_sync_failure_retries_sync_without_appending_duplicate(self):
        self.activate()
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        shim = self.root / 'sync-fault.py'
        calls = self.root / 'sync-calls'
        shim.write_text(
            'import importlib.util, os\n'
            f'spec = importlib.util.spec_from_file_location("lat_session", {str(SCRIPT)!r})\n'
            'helper = importlib.util.module_from_spec(spec)\n'
            'spec.loader.exec_module(helper)\n'
            f'calls = {str(calls)!r}\n'
            'original_sync = os.fsync\n'
            'def sync(fd):\n'
            '    existed = os.path.exists(calls)\n'
            '    with open(calls, "a") as stream: stream.write("sync\\n")\n'
            '    if not existed: raise OSError("simulated sync failure")\n'
            '    original_sync(fd)\n'
            'os.fsync = sync\n'
            'raise SystemExit(helper.main())\n')
        payload = dict(hook_event_name='Stop', session_id=SESSION, cwd=str(self.work),
                       last_assistant_message='DONE: committed')
        failed = self.cli('hook', payload=payload, script=shim)
        self.assertEqual((failed.returncode, failed.stdout), (0, ''))
        self.assertIn('LAT report warning:', failed.stderr)
        path = self.root / 'reports' / f'{SESSION}.jsonl'
        previous = path.read_bytes()
        self.assert_silent(self.cli('hook', payload=payload, script=shim))
        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(len(self.reports()), 1)
        self.assertEqual(calls.read_text().splitlines(), ['sync', 'sync'])

    def test_stop_spec_confirmation_consensus_contract_and_recovery(self):
        receipt = '- consensus: v3 ' + 'a' * 64 + '\n'
        message = ('❓ **LAT-A r1** 確認 Spec\n'
                   'Spec：https://example.test/issues/83，共識 v3。\n'
                   'Spec 審查：通過；未解決項目：無。\n'
                   'A. 照共識做\nB. 調整\nDECIDE: LAT-A r1 請選 A／B。')
        failures = [
            ('', message, '缺共識行'),
            ('- consensus: v3 wrong\n', message, '共識行格式錯'),
            (receipt + receipt, message, '共識行格式錯'),
            (receipt, message.replace('共識 v3', '共識'), '訊息沒寫共識版本'),
            (receipt, message.replace('共識 v3', '共識 v2'), '版本與檢查過的不同'),
            (receipt, message.replace('共識 v3', '共識 v3、共識 v2'), '出現多個不同共識版本'),
        ]
        for client in ('codex', 'claude'):
            self.write_legacy_record(client=client)
            questions = self.bind_stop_panel(client)
            questions.write_text('## 確認 Spec\nLAT-A · r1 · 待答\n')
            binding_path = self.root / 'plugin-config/bindings.json'
            original = binding_path.read_text()
            for bound in (False, True):
                binding_path.write_text(original if bound else '{"version": 2, "bindings": {}}')
                path = self.decisions / 'LAT-A.md'
                prefix = '- status: pending\n- AdViSoR: ExEmPt SPEC-CONFIRMATION note\n'
                for record, invalid_message, reason in failures:
                    with self.subTest(client=client, bound=bound, reason=reason):
                        path.write_text(prefix + record)
                        self.assert_stop_block(self.stop_hook(invalid_message, client), reason)
                        warning = json.loads(self.stop_hook(invalid_message, client, stop_hook_active=True).stdout)
                        self.assertEqual(set(warning), {'systemMessage'})
                        self.assertIn(reason, warning['systemMessage'])
                        path.write_text(prefix + receipt)
                        self.assert_stop_pass(self.stop_hook(message, client, stop_hook_active=True),
                                              *['LAT-A r1 - 確認 Spec'][:bound])
                path.write_bytes(b'\xff')
                warning = json.loads(self.stop_hook(message, client).stdout)
                self.assertEqual(set(warning), {'systemMessage'})
                self.assertIn('檢查發生錯誤，未攔下', warning['systemMessage'])
                for advisor in ('exempt requirement-discussion', 'needs-human', 'late needs-human'):
                    path.write_text(f'- status: pending\n- advisor: {advisor}\n')
                    self.assert_stop_pass(self.stop_hook(message.replace('共識 v3', '共識'), client),
                                          *['LAT-A r1 - 確認 Spec'][:bound])
            binding_path.write_text(original)

    def test_stop_missing_advisor_blocks_then_consulted_reask_passes(self):
        self.write_legacy_record()
        path = self.decisions / 'LAT-A.md'
        path.write_text('- status: pending\n')
        result = self.stop_hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['decision'], 'block')
        self.assertIn('LAT-A r1', output['reason'])
        self.assertIn('沒有參謀行', output['reason'])
        warning = json.loads(self.stop_hook(stop_hook_active=True).stdout)
        self.assertEqual(set(warning), {'systemMessage'})
        path.write_text('- status: pending\n- advisor: needs-human\n')
        self.assert_silent(self.stop_hook(stop_hook_active=True))

    def test_stop_advisor_lines_for_both_clients_bound_and_unbound(self):
        valid = ('needs-human', 'needs-human same-family-degraded',
                 'exempt requirement-discussion',
                 'exempt account-quota', 'late needs-human', 'late resolved',
                 'late self-check', '  NEEDS-HUMAN  ',
                 '\tExEmPt\tACCOUNT-QUOTA   note', ' LATE  SELF-CHECK ')
        invalid = (('', '沒有參謀行'), ('- advisor:   ', '沒有結論'),
                   ('- advisor: resolved', '未知參謀結論'),
                   ('- advisor: exempt', '缺少第二個字'),
                   ('- advisor: exempt other', '不在清單內'),
                   ('- advisor: late', '缺少第二個字'),
                   ('- advisor: late other', '不在清單內'),
                   ('- advisor: invalid\n- advisor: needs-human', '未知參謀結論'))
        for client in ('codex', 'claude'):
            self.write_legacy_record(client=client)
            questions = self.bind_stop_panel(client)
            binding_path = self.root / 'plugin-config/bindings.json'
            original = binding_path.read_text()
            for bound in (False, True):
                binding_path.write_text(original if bound else '{"version": 2, "bindings": {}}')
                questions.write_text('## Question\nLAT-A · r1 · 待答\n')
                path = self.decisions / 'LAT-A.md'
                for value in valid:
                    with self.subTest(client=client, bound=bound, advisor=value):
                        path.write_text(f'- status: pending\n- AdViSoR:{value}\n- advisor: invalid\n')
                        self.assert_stop_pass(self.stop_hook(client=client),
                                              *['LAT-A r1 - Question'][:bound])
                for line, reason in invalid:
                    with self.subTest(client=client, bound=bound, advisor=line):
                        path.write_text(f'- status: pending\n{line}\n')
                        self.assert_stop_block(self.stop_hook(client=client), 'LAT-A r1', reason)
                        warning = json.loads(self.stop_hook(client=client, stop_hook_active=True).stdout)
                        self.assertEqual(set(warning), {'systemMessage'})
                        self.assertIn(reason, warning['systemMessage'])
                path.write_text('- status: pending\n- advisor: late resolved\n')
                if bound:
                    questions.write_text('## Question\nLAT-A · r2 · 待答\n')
                    self.assert_stop_block(self.stop_hook(client=client), '同版本待答')
                path.write_text('- status: advisor-resolved\n- advisor: late resolved\n')
                self.assert_stop_block(self.stop_hook(client=client), '不是 pending')
            binding_path.write_text(original)

    def test_stop_reports_each_advisor_gap_and_ignores_unreferenced_advisor_states(self):
        for client in ('codex', 'claude'):
            self.write_legacy_record(client=client)
            questions = self.bind_stop_panel(client)
            questions.write_text('## Question\nLAT-A · r1 · 待答\n')
            self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
            for status in ('advising', 'advisor-resolved'):
                self.decisions.joinpath('LAT-B.md').write_text(f'- status: {status}\n')
                self.assert_stop_pass(self.stop_hook(client=client), 'LAT-A r1 - Question')
                self.assert_stop_block(self.stop_hook('DECIDE: LAT-A r1, LAT-B r1', client),
                                       'LAT-B r1：紀錄不是 pending', 'LAT-B r1：沒有參謀行')
            self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n')
            self.decisions.joinpath('LAT-B.md').write_text('- status: pending\n- advisor: exempt other\n')
            self.assert_stop_block(self.stop_hook('DECIDE: LAT-A r1, LAT-B r1', client),
                                   'LAT-A r1：沒有參謀行', 'LAT-B r1：參謀 exempt', '補做順序')

    def test_stop_unrecorded_decision_blocks_then_corrected_reask_passes(self):
        self.write_legacy_record()
        result = self.stop_hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['decision'], 'block')
        self.assertIn('LAT-A', output['reason'])
        self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
        self.assert_silent(self.stop_hook(stop_hook_active=True))

    def bind_stop_panel(self, client='codex', session=SESSION, name='orch'):
        result = subprocess.run(
            [sys.executable, str(PANEL), 'bind', '--client', client,
             '--session-id', session, '--workspace', str(self.work), '--hcom-name', name],
            text=True, capture_output=True,
            env=self.cli_environment(extra_env=self.panel_env()), cwd=self.work)
        self.assertEqual(result.returncode, 0, result.stderr)
        questions = Path(json.loads(result.stdout)['binding']['questions_path'])
        questions.parent.mkdir(parents=True, exist_ok=True)
        return questions

    def assert_stop_pass(self, result, *headings):
        """A passing DECIDE/HELP Stop: silent when unbound, else only the shown question headings."""
        if not headings:
            self.assert_silent(result)
            return
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {'systemMessage'})
        self.assertEqual(output['systemMessage'],
                         SEPARATOR.join(f'❓ {heading}' for heading in headings))

    def assert_stop_block(self, result, *details):
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output['decision'], 'block')
        for detail in details:
            self.assertIn(detail, output['reason'])
        self.assertIn('寫待決紀錄 → 諮詢參謀或註明例外 → 寫入面板', output['reason'])
        self.assertIn('遺漏檢查 → 依聊天提問格式重新提問', output['reason'])
        self.assertNotIn('systemMessage', output)

    def test_stop_message_extraction_and_last_nonempty_line(self):
        self.write_legacy_record()
        self.decisions.joinpath('LAT-A.md').write_text('- Status: PENDING\n- advisor: needs-human\n')
        for message in ('hello', 'DECIDE: LAT-A r1\nfinished', '', '   ',
                        'Other LAT-MISSING r1\nDECIDE: LAT-A r1\n \n',
                        'DECIDE: **LAT-A r1** check-pending'):
            with self.subTest(message=message):
                self.assert_silent(self.stop_hook(message))
        for message in ('DECIDE: check-pending', 'Other LAT-A r1\nDECIDE: check-pending'):
            self.assert_stop_block(self.stop_hook(message), '沒有寫出題號')
        for message in ('❓ **LAT-A r1** title\n❓ **LAT-NEW r2** title\nDECIDE: check-pending',
                        'DECIDE: LAT-A r1, LAT-NEW r2',
                        'DECIDE: LAT-A r1, LAT-NEW r2.'):
            self.assert_stop_block(self.stop_hook(message), 'LAT-NEW r2')
        self.decisions.joinpath('A_B.2-3.md').write_text('- status: pending\n- advisor: needs-human\n')
        self.assert_silent(self.stop_hook('DECIDE: A_B.2-3 r12'))

    def test_stop_shared_status_fixtures_hold_bound_and_unbound_for_both_clients(self):
        malformed = {'NO-LINE': '# decision\n', 'EMPTY': '- status:\n',
                     'WHITESPACE': '- Status: \t \n',
                     'FREE-TEXT': '- Status: still pending overall\n'}
        for client in ('codex', 'claude'):
            self.write_legacy_record(client=client)
            questions = self.bind_stop_panel(client)
            for bound in (False, True):
                binding_path = self.root / 'plugin-config/bindings.json'
                original = binding_path.read_text()
                if not bound:
                    binding_path.write_text('{"version": 2, "bindings": {}}')
                for identifier, text in malformed.items():
                    with self.subTest(client=client, bound=bound, fixture=identifier):
                        path = self.decisions / f'{identifier}.md'
                        path.write_text(text)
                        questions.write_text(f'## Question\n{identifier} · r1 · 待答\n')
                        self.assert_stop_block(self.stop_hook(f'DECIDE: {identifier} r1', client),
                                               identifier, '讀不出狀態')
                        path.unlink()
                binding_path.write_text(original)

    def test_stop_resolved_and_unrelated_unreadable_records(self):
        self.write_legacy_record()
        path = self.decisions / 'LAT-A.md'
        for status in ('approved', 'ANSWERED', 'rejected', 'resolved', 'other'):
            path.write_text(f'- Status: {status}\n')
            self.assert_stop_block(self.stop_hook(), 'LAT-A', '不是 pending')
        path.write_text('- STATUS: pending\n- advisor: needs-human\n- status: approved\n')
        self.assert_silent(self.stop_hook())
        self.decisions.joinpath('BROKEN.md').write_text('# no status\n')
        self.assert_stop_block(self.stop_hook(), 'BROKEN.md', '讀不出狀態')
        questions = self.bind_stop_panel()
        questions.write_text('## Question\nLAT-A · r1 · 待答\n')
        self.assert_stop_block(self.stop_hook(), 'BROKEN.md', '讀不出狀態')

    def test_stop_accepts_an_answer_recorded_at_submit(self):
        self.write_legacy_record()
        self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
        # As the panel's submit leaves an answered question: record answered, question 已記錄.
        self.decisions.joinpath('LAT-B.md').write_text(
            '- status: answered\n- advisor: needs-human\n\n## 答覆（r1，面板）\n\n- 答覆：A\n')
        questions = self.bind_stop_panel()
        questions.write_text(
            '## Question\nLAT-A · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'
            '## Done\nLAT-B · r1 · 已記錄 · 2026-10-19T00:00:00+00:00\n\n答覆：A\n\n- [x] 送出\n')
        self.assert_stop_pass(self.stop_hook(), 'LAT-A r1 - Question')
        self.assert_stop_block(self.stop_hook('Question\nDECIDE: LAT-B r1'), 'LAT-B', '不是 pending')

    def test_stop_reuses_reverse_panel_checks_for_both_clients(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.write_legacy_record(client=client)
                self.decisions.joinpath('LAT-A.md').write_text(
                    '- status: pending\n- advisor: needs-human\n')
                self.decisions.joinpath('OLD.md').write_text('- status: resolved\n')
                questions = self.bind_stop_panel(client)
                current = '## Question\nLAT-A · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'
                questions.write_text(current +
                    '## Old?\nOLD · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'
                    '## Missing?\nMISSING · r1 · 待答\n\n答覆：A\n\n- [x] 送出\n')
                self.assert_stop_block(self.stop_hook(client=client),
                    'OLD', '決策已非 pending', 'question cleanup',
                    'MISSING', '找不到決策紀錄', '處理使用者已送出的答覆')
                questions.write_text(current)
                self.assert_stop_pass(self.stop_hook(client=client), 'LAT-A r1 - Question')

    def test_stop_panel_own_question_revision_and_omission_check(self):
        self.write_legacy_record()
        self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
        questions = self.bind_stop_panel()
        other = self.bind_stop_panel(session=OTHER, name='other')
        other.write_text('## Question\nLAT-A · r1 · 待答\n')
        self.assert_stop_block(self.stop_hook(), '自己的面板')
        for text in ('## Question\nLAT-A · r2 · 待答\n',
                     '## Question\nLAT-A · r1 · 已記錄\n'):
            questions.write_text(text)
            self.assert_stop_block(self.stop_hook(), '自己的面板')
        questions.write_text('## Question\nLAT-A · r1 · 待答\n')
        self.assert_stop_pass(self.stop_hook(), 'LAT-A r1 - Question')
        self.decisions.joinpath('LAT-B.md').write_text('- status: pending\n- advisor: needs-human\n')
        self.assert_stop_block(self.stop_hook(), 'LAT-B', '遺漏檢查')
        self.assert_stop_block(self.stop_hook('❓ **LAT-A r2** Question\nDECIDE: LAT-A r1'),
                               'LAT-A r2')
        questions.write_text(questions.read_text() + '\n## Next\nLAT-B · r1 · 待答\n')
        self.assert_stop_pass(self.stop_hook(stop_hook_active=True), 'LAT-A r1 - Question')

    def test_stop_omission_check_skips_other_controllers_records(self):
        self.write_legacy_record()
        self.decisions.joinpath('LAT-A.md').write_text(
            f'- status: pending\n- advisor: needs-human\n- kind: help\n- session: {SESSION}\n')
        questions = self.bind_stop_panel()
        questions.write_text('## Question\nLAT-A · r1 · 待答\n')
        other = self.bind_stop_panel(session=OTHER, name='other')
        # Controller B's own gaps: no question, a recorded question, an archived one.
        self.decisions.joinpath('B-MISS.md').write_text(
            f'- status: pending\n- advisor: needs-human\n- session: {OTHER}\n')
        self.decisions.joinpath('B-REC.md').write_text(
            f'- status: pending\n- advisor: needs-human\n- session: {OTHER}\n')
        self.decisions.joinpath('B-ARCH.md').write_text('- status: pending\n- advisor: needs-human\n')
        other.write_text('## Done\nB-REC · r1 · 已記錄 · 2026-10-19T00:00:00+00:00\n')
        other.with_name(f'{other.stem}-archive.md').write_text('## Old\nB-ARCH · r1 · 已記錄\n')
        self.decisions.joinpath('B-BROKEN.md').write_text(f'# no status\n- session: {OTHER}\n')
        for tag in ('DECIDE', 'HELP'):
            self.assert_stop_pass(self.stop_hook(f'Question\n{tag}: LAT-A r1'),
                                  'LAT-A r1 - Question')
        # A record with no owner evidence still counts as ours.
        unowned = self.decisions.joinpath('U-MISS.md')
        unowned.write_text('- status: pending\n- advisor: needs-human\n')
        self.assert_stop_block(self.stop_hook(), 'U-MISS：遺漏檢查缺少面板題目')
        unowned.unlink()
        # Controller A's own gaps still block, by session line or by its own files.
        self.decisions.joinpath('A-MISS.md').write_text(
            f'- status: pending\n- advisor: needs-human\n- session: {SESSION}\n')
        self.decisions.joinpath('A-REC.md').write_text('- status: pending\n- advisor: needs-human\n')
        self.decisions.joinpath('A-ARCH.md').write_text('- status: pending\n- advisor: needs-human\n')
        questions.write_text(questions.read_text() +
                             '\n## Done\nA-REC · r1 · 已記錄 · 2026-10-19T00:00:00+00:00\n')
        questions.with_name(f'{questions.stem}-archive.md').write_text('## Old\nA-ARCH · r1 · 已記錄\n')
        self.decisions.joinpath('A-BROKEN.md').write_text(f'# no status\n- session: {SESSION}\n')
        for tag in ('DECIDE', 'HELP'):
            result = self.stop_hook(f'Question\n{tag}: LAT-A r1')
            self.assert_stop_block(result, 'A-MISS：遺漏檢查缺少面板題目',
                                   'A-REC：遺漏檢查不一致（問題檔已記錄）',
                                   'A-ARCH：遺漏檢查不一致（問題已歸檔）',
                                   'A-BROKEN.md：讀不出狀態')
            self.assertNotIn('B-', json.loads(result.stdout)['reason'])

    QUESTION_A = (
        '## **要不要**合併？\nLAT-A · r1 · 待答\n\n審查通過 ✅，見 `dev`。\n\n'
        '- A. 合併（建議）\n  第一段 **重點**。\n\n  - 子項目\n- B. 先不合併\n\n'
        '➡️ A：理由一 🚀。\n理由二。\n\n'
        '【詳細資訊】\n來由。\n\n第二段。\n【詳細資訊結束】\n\n答覆：\n\n- [ ] 送出\n')
    SHOWN_A = (
        '❓ LAT-A r1 - 要不要合併？\n\n審查通過 ✅，見 dev。\n\n'
        'A. 合併（建議）\n  第一段 重點。\n\n  - 子項目\nB. 先不合併\n\n'
        '➡️ A：理由一 🚀。\n理由二。\n\n'
        '【詳細資訊】\n來由。\n\n第二段。\n【詳細資訊結束】')
    QUESTION_B = ('## 要裝哪些？\nLAT-B · r2 · 待答\n\n背景。\n\n- [ ] Claude\n- [ ] Codex\n\n'
                  '答覆：\n\n- [ ] 送出\n')
    SHOWN_B = '❓ LAT-B r2 - 要裝哪些？\n\n背景。\n\n（複選題，可選多項）\nA. Claude\nB. Codex'

    def shown(self, result):
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {'systemMessage'})
        return output['systemMessage']

    def test_stop_shows_listed_questions_as_plain_text_without_a_chat_copy(self):
        reports = self.root / 'reports' / f'{SESSION}.jsonl'
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                def ask(message):
                    # Each ask starts with no reports, so a repeat is not held as already asked.
                    reports.unlink(missing_ok=True)
                    return self.stop_hook(message, client)
                self.activate_as(client)
                for name in ('LAT-A', 'LAT-B'):
                    self.decisions.joinpath(f'{name}.md').write_text(
                        '- status: pending\n- advisor: needs-human\n')
                questions = self.bind_stop_panel(client)
                questions.write_text(self.QUESTION_A + '\n' + self.QUESTION_B)
                # Background and the tag line are enough; the hook shows the full question.
                self.assertEqual(self.shown(ask('背景說明。\nDECIDE: LAT-A r1')), self.SHOWN_A)
                # The report keeps only the model's message.
                self.assertEqual([report['message'] for report in self.reports()],
                                 ['背景說明。\nDECIDE: LAT-A r1'])
                self.assertEqual(self.shown(ask('DECIDE: LAT-A r1')), self.SHOWN_A)
                # Several questions come in tag-line order, each once, with a separator line.
                self.assertEqual(self.shown(ask('DECIDE: LAT-B r2、LAT-A r1、LAT-B r2')),
                                 self.SHOWN_B + SEPARATOR + self.SHOWN_A)
                # Without IDs on the tag line, the `❓` headings name them in their order.
                self.assertEqual(self.shown(ask(
                    '❓ **LAT-B r2** 題\n❓ **LAT-A r1** 題\nDECIDE: 請選')),
                    self.SHOWN_B + SEPARATOR + self.SHOWN_A)
                # HELP is shown the same way.
                self.decisions.joinpath('LAT-A.md').write_text(
                    '- status: pending\n- advisor: needs-human\n- kind: help\n')
                self.assertEqual(self.shown(ask('HELP: LAT-A r1')), self.SHOWN_A)
                # Unbound: nothing shown and no chat copy compared, as before.
                (self.root / 'plugin-config/bindings.json').write_text(
                    '{"version": 2, "bindings": {}}')
                self.assert_silent(ask('HELP: LAT-A r1'))
                self.record.unlink()
                reports.unlink()

    def test_stop_held_question_is_not_shown_and_a_released_one_is(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.activate_as(client)
                path = self.decisions / 'LAT-A.md'
                path.write_text('- status: pending\n')
                self.bind_stop_panel(client).write_text(self.QUESTION_A)
                for message in ('DECIDE: LAT-A r1', 'DECIDE: LAT-A r1、LAT-B r2'):
                    # assert_stop_block also checks no systemMessage rides along with the hold.
                    self.assert_stop_block(self.stop_hook(message, client), '沒有參謀行')
                released = self.shown(self.stop_hook('DECIDE: LAT-A r1', client,
                                                     stop_hook_active=True))
                self.assertTrue(released.startswith(self.SHOWN_A + '\n\nLAT DECIDE 檢查未通過：'))
                self.assertIn('沒有參謀行', released)
                self.assertTrue(released.endswith('本回合已繼續過，不再攔下。'))
                # A released question missing from the file is named in a warning, not shown.
                released = self.shown(self.stop_hook('DECIDE: LAT-A r1、LAT-B r2', client,
                                                     stop_hook_active=True))
                self.assertTrue(released.startswith(
                    self.SHOWN_A + '\n\nLAT 題目代送失敗：自己的問題檔沒有 LAT-B r2 的待答題目，'
                    '請到面板查看。\n\nLAT DECIDE 檢查未通過：'))
                # A repeated tag line is held without delivery, then shown when released.
                path.write_text('- status: pending\n- advisor: needs-human\n')
                (self.root / 'reports' / f'{SESSION}.jsonl').unlink()
                self.assertEqual(self.shown(self.stop_hook('DECIDE: LAT-A r1', client)),
                                 self.SHOWN_A)
                self.assertEqual(set(json.loads(self.stop_hook('DECIDE: LAT-A r1', client).stdout)),
                                 {'decision', 'reason'})
                released = self.shown(self.stop_hook('DECIDE: LAT-A r1', client,
                                                     stop_hook_active=True))
                self.assertTrue(released.startswith(self.SHOWN_A + '\n\nLAT DECIDE 檢查未通過：'))
                self.assertIn('已在先前訊息', released)
                self.record.unlink()
                (self.root / 'reports' / f'{SESSION}.jsonl').unlink()

    def test_stop_delivery_failures_only_add_a_warning(self):
        self.write_legacy_record()
        path = self.decisions / 'LAT-A.md'
        path.write_text('- status: pending\n- advisor: needs-human\n')
        questions = self.bind_stop_panel()
        questions.write_text(self.QUESTION_A)
        # A check error still releases and shows the question with the error note.
        path.write_bytes(b'\xff')
        shown = self.shown(self.stop_hook())
        self.assertTrue(shown.startswith(self.SHOWN_A + '\n\nLAT DECIDE 檢查發生錯誤，未攔下：'))
        # An unreadable question file fails both the check and the delivery: warnings only.
        path.write_text('- status: pending\n- advisor: needs-human\n')
        questions.write_bytes(b'\xff')
        shown = self.shown(self.stop_hook())
        self.assertTrue(shown.startswith('LAT 題目代送失敗，請到面板查看題目：'))
        self.assertIn('LAT DECIDE 檢查發生錯誤，未攔下', shown)
        # A binding that no longer matches the record is not used for delivery.
        questions.write_text(self.QUESTION_A)
        bindings = self.root / 'plugin-config/bindings.json'
        original = bindings.read_text()
        bindings.write_text(original.replace(str(self.work), str(self.root)))
        shown = self.shown(self.stop_hook())
        self.assertIn('LAT 題目代送失敗，請到面板查看題目：面板綁定與主控紀錄不符', shown)
        self.assertNotIn('❓', shown)
        bindings.write_text(original)
        # A renderer that throws after a passing check: the check result stays a pass.
        shim = self.root / 'render-fault.py'
        shim.write_text(
            'import importlib.util\n'
            f'spec = importlib.util.spec_from_file_location("lat_session", {str(SCRIPT)!r})\n'
            'helper = importlib.util.module_from_spec(spec)\n'
            'spec.loader.exec_module(helper)\n'
            'questions = helper.panel_module("questions")\n'
            'def fail(question): raise RuntimeError("simulated render failure")\n'
            'questions.question_plain_text = fail\n'
            'raise SystemExit(helper.main())\n')
        result = self.cli('hook', script=shim, session=OTHER, payload=dict(
            hook_event_name='Stop', cwd=str(self.work), session_id=SESSION,
            stop_hook_active=False, last_assistant_message='DECIDE: LAT-A r1'))
        self.assertEqual(self.shown(result),
                         'LAT 題目代送失敗，請到面板查看題目：simulated render failure')

    def test_stop_once_per_turn_warning_and_error_outputs_for_both_clients(self):
        for client in ('codex', 'claude'):
            self.write_legacy_record(client=client)
            self.assert_stop_block(self.stop_hook(client=client), 'LAT-A')
            warning = json.loads(self.stop_hook(client=client, stop_hook_active=True).stdout)
            self.assertEqual(set(warning), {'systemMessage'})
            self.assertIn('LAT-A', warning['systemMessage'])
            self.assert_stop_block(self.stop_hook(client=client), 'LAT-A')
            self.record.write_text('{broken')
            error = json.loads(self.stop_hook(client=client).stdout)
            self.assertEqual(set(error), {'systemMessage'})
            self.assertIn('發生錯誤', error['systemMessage'])
            self.write_legacy_record(client=client, decisions_path=str(self.root / 'missing'))
            self.assertIn('systemMessage', json.loads(self.stop_hook(client=client).stdout))

    def test_stop_corrupt_binding_and_failed_file_read_warn_without_hold(self):
        self.write_legacy_record()
        self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
        self.bind_stop_panel()
        path = self.root / 'plugin-config/bindings.json'
        path.write_text('{"version": 2, "bindings": {"bad": 3}}')
        result = self.stop_hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(json.loads(result.stdout)), {'systemMessage'})
        path.write_text('{"version": 2, "bindings": {}}')
        self.decisions.joinpath('LAT-A.md').write_bytes(b'\xff')
        result = self.stop_hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(json.loads(result.stdout)), {'systemMessage'})

    def test_stop_known_identity_mismatches_and_other_sessions_are_silent(self):
        self.assert_silent(self.stop_hook())
        for key, value in (('client', 'claude'), ('session_id', OTHER), ('role', 'worker'),
                           ('workspace', str(self.root)), ('status', 'completed')):
            self.write_legacy_record(**{key: value})
            self.assert_silent(self.stop_hook())
        self.write_legacy_record()
        self.assert_silent(self.stop_hook(session_id=OTHER))
        self.assert_silent(self.stop_hook(cwd=str(self.root)))
        self.assert_silent(self.stop_hook(hook_event_name='SubagentStop'))
        child = self.work / 'child'
        child.mkdir()
        self.assert_stop_block(self.stop_hook(cwd=str(child)), 'LAT-A')
        child.joinpath('.git').mkdir()
        self.assert_silent(self.stop_hook(cwd=str(child)))

    def test_activate_records_rule_fingerprint_and_identical_rerun_succeeds(self):
        self.activate()
        first = json.loads(self.record.read_text())
        self.assertEqual(first['skill_dir'], str(SKILL))
        self.assertIn('SKILL.md', first['rule_fingerprint'])
        self.assertIn('references/recovery.md', first['rule_fingerprint'])
        self.assertTrue(all(name == 'SKILL.md' or name.startswith('references/')
                            for name in first['rule_fingerprint']))
        self.activate()
        self.assertEqual(json.loads(self.record.read_text()), first)

    def test_finished_session_starts_new_round_with_fresh_paths_and_fingerprint(self):
        self.activate()
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        previous = json.loads(self.record.read_text())
        previous['rule_fingerprint'] = {'SKILL.md': 'previous-rule-content'}
        self.record.write_text(json.dumps(previous))
        progress = self.work / 'next-progress.md'
        progress.write_text('Next round tracker links\n')
        decisions = self.work / 'next-decisions'
        decisions.mkdir()
        tasks = self.work / 'next-tasks'
        tasks.mkdir()
        env, log = self.tab_env()
        result = self.cli('activate', '--workspace', self.work, '--progress', progress,
                          '--decisions', decisions, '--tasks', tasks,
                          '--hcom-name', 'next-orch', extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(str(self.record), result.stdout.splitlines())
        self.assertIn('已開始第 2 輪', result.stdout.splitlines())
        current = json.loads(self.record.read_text())
        self.assertEqual(current['history'], [previous])
        self.assertEqual(current['status'], 'active')
        self.assertEqual(current['progress_path'], str(progress))
        self.assertEqual(current['decisions_path'], str(decisions))
        self.assertEqual(current['tasks_path'], str(tasks))
        self.assertEqual(current['hcom_name'], 'next-orch')
        self.assertNotEqual(current['rule_fingerprint'], previous['rule_fingerprint'])
        self.assertIn('references/recovery.md', current['rule_fingerprint'])
        bindings = json.loads((self.root / 'plugin-config/bindings.json').read_text())
        self.assertEqual(bindings['bindings'][SESSION]['hcom_name'], 'next-orch')
        self.assertEqual(self.tab_calls(log),
                         ['tab get herdr-tab', 'tab rename herdr-tab lat-orch'])
        self.wait_for(self.fake_uv_log.exists)
        self.assertIn(f'--orchestrator next-orch --tasks {tasks} --decisions {decisions}',
                      self.fake_uv_log.read_text())
        self.assertTrue(self.process_exists(self.watcher_pid()))

        rerun = self.cli('activate', '--workspace', self.work, '--progress', progress,
                         '--decisions', decisions, '--tasks', tasks,
                         '--hcom-name', 'next-orch', extra_env=env)
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(json.loads(self.record.read_text()), current)
        refused = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                           '--decisions', self.decisions)
        self.assertNotEqual(refused.returncode, 0)
        self.assertEqual(json.loads(self.record.read_text()), current)

    def test_activate_preserves_unnotified_baseline_and_upgrades_records_without_one(self):
        self.activate()
        record = json.loads(self.record.read_text())
        record['rule_fingerprint'] = {'SKILL.md': 'previous-rule-content'}
        self.record.write_text(json.dumps(record))
        self.activate()
        self.assertEqual(json.loads(self.record.read_text())['rule_fingerprint'],
                         record['rule_fingerprint'])
        del record['rule_fingerprint']
        self.record.write_text(json.dumps(record))
        self.activate()
        self.assertIn('references/recovery.md',
                      json.loads(self.record.read_text())['rule_fingerprint'])

    def test_two_finished_rounds_preserve_order_and_shared_workspace_files(self):
        self.activate()
        shared = [self.progress, self.decisions / 'decision.md', self.tasks / 'task.md',
                  self.work / '.lat/watch/state.json', self.work / '.lat/watch/waits.json']
        for path in shared[1:]:
            path.write_text('Shared workspace content\n')
        original = {path: path.read_bytes() for path in shared}
        archived = []
        for status, number in (('completed', 2), ('cancelled', 3)):
            result = self.cli('deactivate', '--workspace', self.work, '--status', status)
            self.assertEqual(result.returncode, 0, result.stderr)
            previous = json.loads(self.record.read_text())
            archived.append({key: value for key, value in previous.items() if key != 'history'})
            result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                              '--decisions', self.decisions)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f'已開始第 {number} 輪', result.stdout.splitlines())
            current = json.loads(self.record.read_text())
            self.assertEqual(current['history'], archived)
            pid = self.watcher_pid()
            rerun = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                             '--decisions', self.decisions)
            self.assertEqual(rerun.returncode, 0, rerun.stderr)
            self.assertIn(f'已開始第 {number} 輪', rerun.stdout.splitlines())
            self.assertEqual(json.loads(self.record.read_text()), current)
            self.assertEqual(self.watcher_pid(), pid)
        self.assertEqual({path: path.read_bytes() for path in shared}, original)

    def test_unrecognizable_finished_record_is_refused_without_changes(self):
        self.activate()
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        valid = json.loads(self.record.read_text())
        broken = [dict(valid, status='unknown'), dict(valid, client='claude'),
                  dict(valid, session_id=OTHER), dict(valid, role='worker'),
                  dict(valid, workspace=str(self.root)), dict(valid, history={}),
                  dict(valid, history=[42]), dict(valid, skill_dir=None),
                  dict(valid, progress_path='relative.md'), dict(valid, hcom_name=42)]
        broken.append({key: value for key, value in valid.items() if key != 'decisions_path'})
        for record in broken:
            with self.subTest(record=record):
                self.record.write_text(json.dumps(record))
                original = self.record.read_bytes()
                result = self.cli('activate', '--workspace', self.work,
                                  '--progress', self.progress, '--decisions', self.decisions)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.record.read_bytes(), original)

    def test_new_round_partial_failure_retry_does_not_archive_twice(self):
        self.activate()
        for failure, number in (('binding', 2), ('watcher', 3)):
            with self.subTest(failure=failure):
                result = self.cli('deactivate', '--workspace', self.work)
                self.assertEqual(result.returncode, 0, result.stderr)
                env, log = self.tab_env()
                failed_env = dict(env)
                uv = self.binary / 'uv'
                launcher = uv.read_bytes()
                if failure == 'binding':
                    failed_env['HERDR_PANE_ID'] = ''
                else:
                    uv.write_text('#!/missing-test-interpreter\n')
                    failed_env['PATH'] = str(self.binary)
                args = ('activate', '--workspace', self.work, '--progress', self.progress,
                        '--decisions', self.decisions)
                failed = self.cli(*args, extra_env=failed_env)
                self.assertNotEqual(failed.returncode, 0)
                self.assertIn('自動綁定失敗' if failure == 'binding' else 'No such file',
                              failed.stderr)
                current = json.loads(self.record.read_text())
                self.assertEqual(current['status'], 'active')
                self.assertEqual(len(current['history']), number - 1)
                self.assertIn(f'已開始第 {number} 輪', failed.stdout.splitlines())
                self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())
                uv.write_bytes(launcher)
                retry = self.cli(*args, extra_env=env)
                self.assertEqual(retry.returncode, 0, retry.stderr)
                self.assertIn(f'已開始第 {number} 輪', retry.stdout.splitlines())
                self.assertEqual(json.loads(self.record.read_text()), current)
                self.assertTrue(self.process_exists(self.watcher_pid()))
                binding = json.loads((self.root / 'plugin-config/bindings.json').read_text())
                self.assertEqual(binding['bindings'][SESSION]['herdr_pane'], 'herdr-pane')
                self.assertIn('tab rename herdr-tab lat-orch', self.tab_calls(log))

    def test_new_round_recovery_stop_and_deactivate_use_only_current_fields(self):
        self.activate()
        self.decisions.joinpath('LAT-A.md').write_text('- status: approved\n')
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        previous = json.loads(self.record.read_text())
        progress = self.work / 'new-progress.md'
        progress.write_text('New progress\n')
        decisions = self.work / 'new-decisions'
        decisions.mkdir()
        decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
        result = self.cli('activate', '--workspace', self.work, '--progress', progress,
                          '--decisions', decisions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.progress.unlink()
        for source in ('compact', 'resume'):
            recovered = self.hook(source=source)
            self.assertEqual(recovered.returncode, 0, recovered.stderr)
            pointer = json.loads(recovered.stdout)['hookSpecificOutput']['additionalContext']
            self.assertIn(f'LAT recovery record: {self.record}', pointer)
            self.assertNotIn('recovery error', pointer)
            current = json.loads(self.record.read_text())
            self.assertEqual(current['progress_path'], str(progress))
            self.assertEqual(current['decisions_path'], str(decisions))
            self.assertEqual(current['history'], [previous])
        self.assert_silent(self.stop_hook())
        decisions.joinpath('LAT-A.md').write_text('- status: approved\n')
        self.assert_stop_block(self.stop_hook(), '不是 pending')
        pid = self.watcher_pid()
        result = self.cli('deactivate', '--workspace', self.work)
        self.assertEqual(result.returncode, 0, result.stderr)
        current = json.loads(self.record.read_text())
        self.assertEqual(current['status'], 'ended')
        self.assertEqual(current['history'], [previous])
        self.assert_silent(self.hook())
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())
        self.wait_for(lambda: not self.process_exists(pid))

    def test_claude_cancelled_legacy_round_uses_current_skill_and_fresh_fingerprint(self):
        previous = self.write_legacy_record(client='claude', status='cancelled',
                                           skill_dir=str(self.root / 'old-skill'),
                                           rule_fingerprint={'SKILL.md': 'old-content'})
        env, log = self.tab_env()
        args = ('activate', '--client', 'claude', '--workspace', self.work,
                '--progress', self.progress, '--decisions', self.decisions)
        result = self.cli(*args, claude_session=SESSION, extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('已開始第 2 輪', result.stdout.splitlines())
        current = json.loads(self.record.read_text())
        self.assertEqual(current['history'], [previous])
        self.assertEqual(current['skill_dir'], str(SKILL))
        self.assertEqual(current['client'], 'claude')
        self.assertEqual(current['tasks_path'], str(self.tasks))
        self.assertIn('references/recovery.md', current['rule_fingerprint'])
        self.assertTrue(self.process_exists(self.watcher_pid()))
        self.assertIn('tab rename herdr-tab lat-orch', self.tab_calls(log))
        bindings = json.loads((self.root / 'plugin-config/bindings.json').read_text())
        self.assertEqual(bindings['bindings'][SESSION]['client'], 'claude')
        rerun = self.cli(*args, claude_session=SESSION, extra_env=env)
        self.assertEqual(rerun.returncode, 0, rerun.stderr)
        self.assertEqual(json.loads(self.record.read_text()), current)

    def watcher_pid(self, session=SESSION):
        return int((self.work / '.lat/watch' / f'{session}.pid').read_text())

    def wait_for(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.02)
        self.fail('Timed out waiting for watcher process state')

    def process_exists(self, pid):
        return Path(f'/proc/{pid}').exists()

    def stop_fake_watchers(self):
        for path in (self.work / '.lat/watch').glob('*.pid'):
            try:
                os.killpg(int(path.read_text()), 15)
            except (FileNotFoundError, ProcessLookupError, ValueError):
                pass

    def terminate_process(self, process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(1)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(1)

    def process_waits_for_lock(self, pid):
        for line in Path('/proc/locks').read_text().splitlines():
            fields = line.split()
            if len(fields) > 5 and fields[1] == '->' and fields[5] == str(pid):
                return True
        return False

    def hook(self, extra_env=None, **overrides):
        payload = dict(hook_event_name='SessionStart', source='compact',
                       cwd=str(self.work), session_id=SESSION)
        payload.update(overrides)
        return self.cli('hook', payload=payload, session=OTHER, extra_env=extra_env)

    def write_legacy_record(self, **extra):
        record = dict(
            client='codex', session_id=SESSION, role='orchestrator',
            workspace=str(self.work), status='active', skill_dir=str(SKILL),
            progress_path=str(self.progress), decisions_path=str(self.decisions),
        )
        record.update(extra)
        self.record.parent.mkdir(parents=True, exist_ok=True)
        self.record.write_text(json.dumps(record))
        return record

    def panel_env(self, herdr_body=None):
        herdr = self.binary / 'herdr'
        herdr.write_text(herdr_body or (
            '#!/bin/sh\n'
            'test "$*" = "plugin list --plugin lat.panel --json" || exit 91\n'
            'printf \'%s\\n\' \'{"result":{"plugins":[{"plugin_id":"lat.panel","enabled":true}]}}\'\n'
        ))
        herdr.chmod(0o755)
        return {
            'PATH': f'{self.binary}:{os.environ["PATH"]}',
            'HERDR_WORKSPACE_ID': 'herdr-workspace',
            'HERDR_TAB_ID': 'herdr-tab',
            'HERDR_PANE_ID': 'herdr-pane',
            'HERDR_PLUGIN_CONFIG_DIR': str(self.root / 'plugin-config'),
        }

    def test_activate_binds_enabled_panel_and_prints_questions_path(self):
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'nifo-bind-lezo',
            extra_env=self.panel_env(),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        questions = self.work / '.lat/questions/nifo-bind-lezo.md'
        self.assertIn(str(questions), result.stdout)
        bindings = json.loads(
            (self.root / 'plugin-config/bindings.json').read_text()
        )['bindings']
        self.assertEqual(bindings[SESSION]['questions_path'], str(questions))

    def test_enabled_panel_without_explicit_hcom_name_fails_before_record_creation(self):
        env = self.panel_env()
        env['HCOM_INSTANCE_NAME'] = 'stale-name-must-not-be-used'
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--tasks', self.tasks, extra_env=env,
            watch_args=False,
        )

        self.assertNotEqual(result.returncode, 0)
        remedy = (
            f'uv run --no-project python {SCRIPT} activate --client codex '
            f'--workspace {self.work} --progress {self.progress} '
            f'--decisions {self.decisions} --tasks {self.tasks} '
            '--hcom-name \'<主控-HCOM-名稱>\''
        )
        self.assertIn(remedy, result.stderr)
        self.assertFalse(self.record.exists())
        self.assertFalse((self.root / 'plugin-config/bindings.json').exists())

    def test_activate_rejects_invalid_watcher_identity_and_task_directory(self):
        invalid_name = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--tasks', self.tasks,
            '--hcom-name', 'not/a-name', watch_args=False,
        )
        missing_tasks = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--tasks', self.work / 'missing-tasks',
            '--hcom-name', 'orch', watch_args=False,
        )

        self.assertNotEqual(invalid_name.returncode, 0)
        self.assertIn('valid explicit --hcom-name', invalid_name.stderr)
        self.assertNotEqual(missing_tasks.returncode, 0)
        self.assertIn('missing-tasks', missing_tasks.stderr)
        self.assertFalse(self.record.exists())

    def test_activate_without_enabled_panel_keeps_working_and_explains_skip(self):
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.record.exists())
        self.assertIn('面板未啟用，略過綁定', result.stdout)

    def test_missing_herdr_command_counts_as_disabled_even_inside_workspace(self):
        binary = self.root / 'empty-bin'
        binary.mkdir()
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions,
            extra_env={'PATH': f'{binary}:{self.binary}',
                       'HERDR_WORKSPACE_ID': 'herdr-workspace'},
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('面板未啟用，略過綁定', result.stdout)

    def test_disabled_panel_list_entry_keeps_activation_unbound(self):
        env = self.panel_env(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'{"plugins":[{"plugin_id":"lat.panel","enabled":false}]}\'\n'
        )
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, extra_env=env,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('面板未啟用，略過綁定', result.stdout)
        self.assertFalse((self.root / 'plugin-config/bindings.json').exists())

    def test_plugin_list_failure_is_loud_and_does_not_create_record(self):
        env = self.panel_env('#!/bin/sh\necho "socket unavailable" >&2\nexit 23\n')
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'nifo-bind-lezo',
            extra_env=env,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('cannot check lat.panel: socket unavailable', result.stderr)
        self.assertIn('請修復 Herdr 後重新執行：uv run --no-project', result.stderr)
        self.assertFalse(self.record.exists())

    def test_unexpected_plugin_list_json_is_loud_and_does_not_create_record(self):
        env = self.panel_env('#!/bin/sh\nprintf \'%s\\n\' \'{}\'\n')
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'nifo-bind-lezo',
            extra_env=env,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing plugins list', result.stderr)
        self.assertFalse(self.record.exists())

    def test_bind_failure_keeps_active_record_and_prints_manual_command(self):
        env = self.panel_env()
        env.pop('HERDR_PANE_ID')
        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'nifo-bind-lezo',
            extra_env=env,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(self.record.read_text())['status'], 'active')
        manual = (
            f'uv run --no-project python {PANEL} bind '
            f'--hcom-name nifo-bind-lezo --client codex --session-id {SESSION} '
            f'--workspace {self.work}'
        )
        self.assertIn(manual, result.stderr)
        self.assertNotIn("--herdr-pane ''", result.stderr)

        env['HERDR_PANE_ID'] = 'repaired-pane'
        recovered = subprocess.run(
            [sys.executable, str(PANEL), 'bind', '--hcom-name', 'nifo-bind-lezo',
             '--client', 'codex', '--session-id', SESSION, '--workspace', self.work],
            text=True, capture_output=True, env=env, cwd=self.work,
        )
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        binding = json.loads(recovered.stdout)['binding']
        self.assertEqual(binding['herdr_pane'], 'repaired-pane')

    def test_deactivate_unbinds_own_session_and_is_idempotent(self):
        env = self.panel_env()
        activated = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'nifo-bind-lezo',
            extra_env=env,
        )
        self.assertEqual(activated.returncode, 0, activated.stderr)
        deactivate_args = (
            'deactivate', '--workspace', self.work,
            '--session-id', SESSION,
        )

        first = self.cli(*deactivate_args, session=OTHER, extra_env=env)
        second = self.cli(*deactivate_args, session=OTHER, extra_env=env)

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn('"removed": 1', first.stdout)
        self.assertIn('"removed": 0', second.stdout)
        bindings = json.loads(
            (self.root / 'plugin-config/bindings.json').read_text()
        )['bindings']
        self.assertEqual(bindings, {})

    def test_deactivate_deletes_only_its_own_empty_new_location_question_file(self):
        env = self.panel_env()
        legacy = self.work / '.lat/questions-orch.md'
        legacy.parent.mkdir(parents=True, exist_ok=True)
        legacy.write_text('## Old\nOLD · r1 · 已記錄 · 2026-10-01T00:00:00+00:00\n\n答覆：A\n\n- [x] 送出\n')
        original = legacy.read_bytes()
        questions = self.work / '.lat/questions/orch.md'
        for text, kept in (('# 問題\n', False),
                           ('## Q\nLAT-A · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n', True),
                           ('## Q\nLAT-A · r1 · 待答\n\n答覆：A\n\n- [x] 送出\n', True)):
            with self.subTest(text=text):
                activated = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                                     '--decisions', self.decisions, '--hcom-name', 'orch',
                                     extra_env=env)
                self.assertEqual(activated.returncode, 0, activated.stderr)
                self.assertIn(f'問題檔：{questions}', activated.stdout)
                questions.write_text(text)
                self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n')

                result = self.cli('deactivate', '--workspace', self.work, extra_env=env)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(questions.exists(), kept)
                self.assertEqual('已刪除空問題檔' in result.stdout, not kept)
                self.assertTrue((questions.parent / '.orch.md.lock').exists())
                self.assertEqual(legacy.read_bytes(), original)

    def test_activate_starts_one_watcher_and_deactivate_stops_it(self):
        self.activate()
        pid = self.watcher_pid()
        self.wait_for(lambda: self.fake_uv_log.exists())
        first_log = self.fake_uv_log.read_text().splitlines()
        self.assertEqual(len(first_log), 1)
        self.assertIn('lat-watch.py run', first_log[0])
        self.assertIn(f'--orchestrator orch --tasks {self.tasks}', first_log[0])

        self.activate()
        self.assertEqual(self.watcher_pid(), pid)
        self.assertEqual(self.fake_uv_log.read_text().splitlines(), first_log)

        result = self.cli('deactivate', '--workspace', self.work)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: not self.process_exists(pid))
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())

    def fake_reaper(self, body):
        """A stand-in reap command that logs its arguments; never the real reaper."""
        calls = self.root / 'reap.log'
        reaper = self.binary / 'fake-reap'
        reaper.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{calls}"\n{body}\n')
        reaper.chmod(0o755)
        return calls, {'LAT_REAP_COMMAND': str(reaper)}

    def test_deactivate_releases_own_keeps_then_reaps_and_prints_the_result(self):
        self.activate()
        calls, environment = self.fake_reaper(
            'case "$1" in release) echo "Released 1 keep(s) made by $3";;\n'
            '  reap) echo "PID 4242 (worker): exited after SIGTERM [keep ended]";; esac')

        result = self.cli('deactivate', '--workspace', self.work, extra_env=environment)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls.read_text().splitlines(),
                         ['release --by orch', 'reap --trigger deactivate'])
        self.assertIn('Released 1 keep(s) made by orch', result.stdout)
        self.assertIn('PID 4242 (worker): exited after SIGTERM [keep ended]', result.stdout)
        self.assertEqual(json.loads(self.record.read_text())['status'], 'ended')

    def test_failed_reap_prints_one_line_and_does_not_block_deactivation(self):
        self.activate()
        pid = self.watcher_pid()
        self.wait_for(lambda: self.fake_uv_log.exists())
        for step in ('release', 'reap'):
            with self.subTest(step=step):
                self.record.write_text(json.dumps(
                    dict(json.loads(self.record.read_text()), status='active')))
                calls, environment = self.fake_reaper(
                    f'test "$1" = {step} || exit 0\n'
                    'echo "Waiting for the reap lock"\n'
                    'echo "Skipped: another reap holds the lock (waited too long)"; exit 1')

                result = self.cli('deactivate', '--workspace', self.work, extra_env=environment)

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(self.record.read_text())['status'], 'ended')
                failures = [line for line in result.stdout.splitlines() if '服務回收' in line]
                self.assertEqual(len(failures), 1, result.stdout)
                self.assertIn('Skipped: another reap holds the lock', failures[0])
                self.assertNotIn('Waiting for the reap lock', result.stdout)
                calls.unlink()
        self.wait_for(lambda: not self.process_exists(pid))

    def test_deactivate_releases_only_the_controllers_own_wait(self):
        self.activate()
        waits = self.work / '.lat/watch/waits'
        waits.mkdir(parents=True, exist_ok=True)
        declaration = dict(agent='orch', kind='agent', target='worker', active=True,
                           declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                           deadline_at=3000)
        (waits / 'orch.json').write_text(json.dumps(declaration))
        (waits / 'worker.json').write_text(json.dumps(dict(declaration, agent='worker',
                                                           target='orch')))

        result = self.cli('deactivate', '--workspace', self.work)

        self.assertEqual(result.returncode, 0, result.stderr)
        own = json.loads((waits / 'orch.json').read_text())
        self.assertFalse(own['active'])
        self.assertEqual(own['released_reason'], 'deactivated')
        self.assertTrue(json.loads((waits / 'worker.json').read_text())['active'])

    def test_deactivate_drops_an_expiry_nudge_still_waiting_for_delivery(self):
        self.activate()
        waits = self.work / '.lat/watch/waits'
        waits.mkdir(parents=True, exist_ok=True)
        expired = dict(agent='orch', kind='agent', target='worker', active=False,
                       declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                       deadline_at=3000, released_reason='expired', expiry_nudge_pending=True,
                       expiry_count=2, expiry_declared_at=['a', 'b'],
                       expiry_notice=dict(target='worker', declared_at=['a', 'b'],
                                          conversation_delivered=False, delivered=False))
        (waits / 'orch.json').write_text(json.dumps(expired))

        result = self.cli('deactivate', '--workspace', self.work)

        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads((waits / 'orch.json').read_text())
        self.assertEqual(saved['released_reason'], 'deactivated')
        spec = importlib.util.spec_from_file_location('lat_watch', SCRIPT.with_name('lat-watch.py'))
        watch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watch)
        ready = watch.Observation('orch', 'listening', True, False, 10, 10, 1,
                                  is_orchestrator=True)
        _, actions, events = watch.decide_wait(saved, ready, None, None, 4000)
        self.assertEqual((actions, events), ([], []))

    def test_stale_pid_for_unrelated_process_is_replaced_without_signalling_it(self):
        unrelated = subprocess.Popen(['sleep', '30'], start_new_session=True)
        self.addCleanup(self.terminate_process, unrelated)
        pid_path = self.work / '.lat/watch' / f'{SESSION}.pid'
        pid_path.parent.mkdir(parents=True)
        pid_path.write_text(f'{unrelated.pid}\n')

        self.activate()

        self.assertNotEqual(self.watcher_pid(), unrelated.pid)
        self.assertIsNone(unrelated.poll())

    def test_deactivate_refuses_matching_process_that_is_not_group_leader(self):
        command = [
            str(self.binary / 'uv'), 'run', '--no-project', 'python',
            str(SKILL / 'scripts/lat-watch.py'), 'run', '--workspace', str(self.work),
            '--orchestrator', 'orch', '--tasks', str(self.tasks),
            '--decisions', str(self.decisions),
        ]
        env = dict(os.environ, FAKE_UV_LOG=str(self.fake_uv_log))
        process = subprocess.Popen(command, cwd=self.work, env=env)
        self.addCleanup(self.terminate_process, process)
        self.wait_for(lambda: self.fake_uv_log.exists())
        record = dict(
            client='codex', session_id=SESSION, role='orchestrator',
            workspace=str(self.work), status='active', skill_dir=str(SKILL),
            progress_path=str(self.progress), decisions_path=str(self.decisions),
            tasks_path=str(self.tasks), hcom_name='orch',
        )
        self.record.parent.mkdir(parents=True)
        self.record.write_text(json.dumps(record))
        pid_path = self.work / '.lat/watch' / f'{SESSION}.pid'
        pid_path.parent.mkdir(parents=True)
        pid_path.write_text(f'{process.pid}\n')

        result = self.cli('deactivate', '--workspace', self.work)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('process group does not match', result.stderr)
        self.assertIsNone(process.poll())
        self.assertEqual(json.loads(self.record.read_text())['status'], 'active')
        pid_path.unlink()

    def test_deactivate_escalates_when_watcher_ignores_term(self):
        uv = self.binary / 'uv'
        uv.write_text(
            '#!/bin/sh\n'
            'printf \'%s\\n\' "$$ $*" >> "$FAKE_UV_LOG"\n'
            'trap \'printf TERM\\n >> "$FAKE_TERM_LOG"\' TERM\n'
            'while :; do sleep 0.05; done\n'
        )
        term_log = self.root / 'term.log'
        activated = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions,
            extra_env={'FAKE_TERM_LOG': str(term_log)},
        )
        self.assertEqual(activated.returncode, 0, activated.stderr)
        pid = self.watcher_pid()

        stopped = self.cli('deactivate', '--workspace', self.work)

        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.wait_for(lambda: not self.process_exists(pid))
        self.assertTrue(term_log.exists())
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())

    def test_zombie_pid_is_not_considered_a_running_watcher(self):
        zombie = subprocess.Popen(['/bin/sh', '-c', 'exit 0'])
        self.addCleanup(self.terminate_process, zombie)
        stat_path = Path(f'/proc/{zombie.pid}/stat')
        self.wait_for(lambda: stat_path.exists() and
                      stat_path.read_text()[stat_path.read_text().rfind(')') + 2:].startswith('Z '))
        spec = importlib.util.spec_from_file_location('lat_session_zombie', SCRIPT)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)

        self.assertFalse(helper.watcher_process_matches(zombie.pid, ('run',)))

    def test_hook_restarts_a_dead_active_watcher_without_extra_output(self):
        self.activate()
        old_pid = self.watcher_pid()
        os.killpg(old_pid, 15)
        self.wait_for(lambda: not self.process_exists(old_pid))

        result = self.hook()

        self.assertEqual(result.returncode, 0, result.stderr)
        context = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
        self.assertEqual(context.count('LAT recovery record:'), 1)
        new_pid = self.watcher_pid()
        self.assertNotEqual(new_pid, old_pid)
        self.wait_for(lambda: len(self.fake_uv_log.read_text().splitlines()) == 2)

    def test_hook_restarts_a_watcher_that_stopped_itself_after_its_orchestrator_left(self):
        self.activate()
        old_pid = self.watcher_pid()
        spec = importlib.util.spec_from_file_location('lat_watch', SKILL / 'scripts/lat-watch.py')
        watch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watch)
        reason = 'orchestrator orch missing from HCOM for 60 minutes'

        self.assertEqual(watch.stop_self(self.work, 'orch', reason, 3600, pgid=old_pid), SESSION)
        os.killpg(old_pid, 15)
        self.wait_for(lambda: not self.process_exists(old_pid))

        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())
        record = json.loads(self.record.read_text())
        self.assertEqual(record['status'], 'active')
        self.assertEqual(record['watcher_stopped']['reason'], reason)
        self.assertIn(f'LAT watch stopped: {reason}',
                      (self.work / '.lat/watch' / f'{SESSION}.log').read_text())
        result = self.hook(source='resume')
        self.assertEqual(result.returncode, 0, result.stderr)
        new_pid = self.watcher_pid()
        self.assertNotEqual(new_pid, old_pid)
        self.assertTrue(self.process_exists(new_pid))

    def linked_worktree(self):
        main, worktree = self.root / 'repo', self.root / 'wt'
        git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
        subprocess.run([*git, 'init', '-q', str(main)], check=True)
        subprocess.run([*git, '-C', str(main), 'commit', '-q', '--allow-empty', '-m', 'init'],
                       check=True)
        subprocess.run([*git, '-C', str(main), 'worktree', 'add', '-q', str(worktree)], check=True)
        return main, worktree

    def kill_group_later(self, pid):
        def kill():
            try:
                os.killpg(pid, 15)
            except ProcessLookupError:
                pass
        self.addCleanup(kill)

    def test_worktree_controller_lives_in_main_lat_through_stop_resume_and_deactivate(self):
        main, worktree = self.linked_worktree()
        result = self.cli('activate', '--workspace', worktree, '--progress', self.progress,
                          '--decisions', self.decisions)
        self.assertEqual(result.returncode, 0, result.stderr)
        record_path = main / '.lat/sessions' / f'{SESSION}.json'
        self.assertEqual(json.loads(record_path.read_text())['workspace'], str(worktree))
        pid_path = main / '.lat/watch' / f'{SESSION}.pid'
        old_pid = int(pid_path.read_text())
        self.kill_group_later(old_pid)
        spec = importlib.util.spec_from_file_location('lat_watch', SKILL / 'scripts/lat-watch.py')
        watch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watch)

        reason = 'orchestrator orch missing from HCOM for 60 minutes'
        self.assertEqual(watch.stop_self(worktree, 'orch', reason, 3600, pgid=old_pid), SESSION)
        os.killpg(old_pid, 15)
        self.wait_for(lambda: not self.process_exists(old_pid))
        self.assertFalse(pid_path.exists())
        self.assertEqual(json.loads(record_path.read_text())['watcher_stopped']['reason'], reason)

        resumed = self.hook(source='resume', cwd=str(worktree))
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertIn(f'LAT recovery record: {record_path}', resumed.stdout)
        new_pid = int(pid_path.read_text())
        self.kill_group_later(new_pid)
        self.assertTrue(self.process_exists(new_pid))

        result = self.cli('deactivate', '--workspace', worktree)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: not self.process_exists(new_pid))
        self.assertEqual(json.loads(record_path.read_text())['status'], 'ended')
        self.assertFalse((worktree / '.lat').exists())

    def test_older_record_in_a_worktree_lat_recovers_self_stops_and_ends_in_place(self):
        main, worktree = self.linked_worktree()
        legacy = worktree / '.lat/sessions' / f'{SESSION}.json'
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps(dict(
            client='codex', session_id=SESSION, role='orchestrator', workspace=str(worktree),
            status='active', skill_dir=str(SKILL), progress_path=str(self.progress),
            decisions_path=str(self.decisions), tasks_path=str(self.tasks), hcom_name='orch')))

        resumed = self.hook(source='resume', cwd=str(worktree))
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertIn(f'LAT recovery record: {legacy}', resumed.stdout)
        pid_path = worktree / '.lat/watch' / f'{SESSION}.pid'
        old_pid = int(pid_path.read_text())
        self.kill_group_later(old_pid)
        spec = importlib.util.spec_from_file_location('lat_watch', SKILL / 'scripts/lat-watch.py')
        watch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watch)

        reason = 'orchestrator orch missing from HCOM for 60 minutes'
        self.assertEqual(watch.stop_self(worktree, 'orch', reason, 3600, pgid=old_pid), SESSION)
        os.killpg(old_pid, 15)
        self.wait_for(lambda: not self.process_exists(old_pid))
        self.assertFalse(pid_path.exists())
        self.assertEqual(json.loads(legacy.read_text())['watcher_stopped']['reason'], reason)
        self.assertIn(f'LAT watch stopped: {reason}',
                      (worktree / '.lat/watch' / f'{SESSION}.log').read_text())
        resumed = self.hook(source='resume', cwd=str(worktree))
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        pid = int(pid_path.read_text())
        self.kill_group_later(pid)
        self.assertTrue(self.process_exists(pid))
        result = self.cli('deactivate', '--workspace', worktree)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_for(lambda: not self.process_exists(pid))
        self.assertEqual(json.loads(legacy.read_text())['status'], 'ended')
        self.assertFalse((main / '.lat/sessions').exists())

    def test_deactivate_records_end_time_and_a_new_round_starts_without_one(self):
        self.activate()
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        ended = json.loads(self.record.read_text())
        self.assertEqual(datetime.fromisoformat(ended['ended_at_utc']).tzinfo, timezone.utc)
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        self.assertEqual(json.loads(self.record.read_text())['ended_at_utc'],
                         ended['ended_at_utc'])

        self.activate()
        current = json.loads(self.record.read_text())
        self.assertEqual(current['status'], 'active')
        self.assertNotIn('ended_at_utc', current)
        self.assertEqual(current['history'][0]['ended_at_utc'], ended['ended_at_utc'])

    def test_controller_preauthorization_ends_with_its_round(self):
        self.activate()
        record = json.loads(self.record.read_text())
        record['preauth'] = {'round': 1, 'settings': {'actions': {'merge': {'allow': True}}}}
        self.record.write_text(json.dumps(record))
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        self.assertNotIn('preauth', json.loads(self.record.read_text()))

        self.activate()
        current = json.loads(self.record.read_text())
        self.assertNotIn('preauth', current)
        self.assertNotIn('preauth', current['history'][0])

    def test_activate_and_deactivate_trigger_autoclean_and_never_fail_on_it(self):
        log = self.work / '.lat/cleanup.log'
        self.activate()
        self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
        self.assertEqual([line.split('\t')[4] for line in log.read_text().splitlines()],
                         ['未開啟'] * 2)

        log.unlink()
        log.mkdir()
        started = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                           '--decisions', self.decisions)
        self.assertEqual(started.returncode, 0, started.stderr)
        self.assertIn('自動清理未啟動', started.stdout)
        ended = self.cli('deactivate', '--workspace', self.work)
        self.assertEqual(ended.returncode, 0, ended.stderr)
        self.assertIn('自動清理未啟動', ended.stdout)
        self.assertEqual(json.loads(self.record.read_text())['status'], 'ended')

    def test_hook_recovers_legacy_record_without_starting_watcher(self):
        self.write_legacy_record()
        expected_command = (
            f'uv run --no-project python {SCRIPT} activate --client codex '
            f'--workspace {self.work} --progress {self.progress} '
            f'--decisions {self.decisions} --tasks \'<task-card-directory>\' '
            '--hcom-name \'<controller-HCOM-name>\''
        )

        result = self.hook(source='resume')

        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertEqual(len(result.stdout.splitlines()), 1)
        recovered = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
        self.assertTrue(recovered.startswith(f'LAT recovery record: {self.record}\n'))
        self.assertEqual(recovered.count('\nLegacy session upgrade: '), 1)
        self.assertIn(expected_command, recovered)
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())
        self.assertFalse(self.fake_uv_log.exists())

    def test_activate_upgrades_legacy_record_in_place_and_preserves_other_fields(self):
        legacy = self.write_legacy_record(legacy_note='keep me')

        result = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--tasks', self.tasks,
            '--hcom-name', 'upgraded-orch', watch_args=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        upgraded = json.loads(self.record.read_text())
        self.assertIn('SKILL.md', upgraded['rule_fingerprint'])
        self.assertEqual(upgraded, dict(
            legacy, tasks_path=str(self.tasks), hcom_name='upgraded-orch',
            rule_fingerprint=upgraded['rule_fingerprint'],
            ledger_path=str(self.work / f'.lat/ledgers/{SESSION}-r1.json'),
        ))
        pid = self.watcher_pid()

        retried = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--tasks', self.tasks,
            '--hcom-name', 'upgraded-orch', watch_args=False,
        )

        self.assertEqual(retried.returncode, 0, retried.stderr)
        self.assertEqual(json.loads(self.record.read_text()), upgraded)
        self.assertEqual(self.watcher_pid(), pid)

    def test_deactivate_legacy_record_without_watcher(self):
        legacy = self.write_legacy_record(legacy_note='keep me')

        result = self.cli(
            'deactivate', '--workspace', self.work,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        ended = json.loads(self.record.read_text())
        self.assertEqual(ended, dict(legacy, status='ended', ended_at_utc=ended['ended_at_utc']))
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())

    def activate_bound(self):
        env = self.panel_env()
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions, extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return env

    def binding(self, session=SESSION):
        path = self.root / 'plugin-config/bindings.json'
        return json.loads(path.read_text())['bindings'].get(session)

    def assert_only_pointer(self, result):
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        self.assertEqual(len(result.stdout.splitlines()), 1)
        context = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
        self.assertTrue(context.startswith(f'LAT recovery record: {self.record}\n'))
        for text in ('herdr', 'binding', '綁定'):
            self.assertNotIn(text, context)

    def test_hook_rebinds_resumed_controller_to_its_new_tab_and_pane(self):
        env = self.activate_bound()
        before = self.binding()
        self.assertEqual((before['herdr_tab'], before['herdr_pane']),
                         ('herdr-tab', 'herdr-pane'))
        resumed = dict(env, HERDR_WORKSPACE_ID='moved-workspace', HERDR_TAB_ID='new-tab',
                       HERDR_PANE_ID='new-pane')

        for source in ('resume', 'compact'):
            result = self.hook(extra_env=resumed, source=source)
            self.assert_only_pointer(result)
            self.assertEqual(self.binding(), dict(
                before, herdr_workspace='moved-workspace', herdr_tab='new-tab',
                herdr_pane='new-pane',
            ))

    def test_hook_keeps_binding_when_any_herdr_id_is_missing(self):
        env = self.activate_bound()
        before = self.binding()
        resumed = dict(env, HERDR_WORKSPACE_ID='moved-workspace', HERDR_TAB_ID='new-tab',
                       HERDR_PANE_ID='new-pane')
        for missing in ('HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID'):
            with self.subTest(missing=missing):
                partial = {key: value for key, value in resumed.items() if key != missing}
                self.assert_only_pointer(self.hook(extra_env=partial, source='resume'))
                self.assertEqual(self.binding(), before)

    def test_hook_rebind_failure_or_disabled_panel_stays_silent_and_unchanged(self):
        env = self.activate_bound()
        before = self.binding()
        resumed = dict(env, HERDR_TAB_ID='new-tab', HERDR_PANE_ID='new-pane')
        for name, herdr_body in (
            ('server unavailable', '#!/bin/sh\necho "server unavailable" >&2\nexit 7\n'),
            ('disabled', '#!/bin/sh\nprintf \'%s\\n\' \'{"result":{"plugins":'
                         '[{"plugin_id":"lat.panel","enabled":false}]}}\'\n'),
        ):
            with self.subTest(name):
                self.panel_env(herdr_body)
                self.assert_only_pointer(self.hook(extra_env=resumed, source='resume'))
                self.assertEqual(self.binding(), before)

        (self.root / 'plugin-config/bindings.json').write_text('{broken')
        self.panel_env()
        self.assert_only_pointer(self.hook(extra_env=resumed, source='resume'))
        self.assertEqual((self.root / 'plugin-config/bindings.json').read_text(), '{broken')

    def tab_env(self, label='1', fail_rename=False, fail_get=False):
        """Fake herdr: panel enabled, `tab get` reports label, calls logged."""
        log = self.root / 'herdr.log'
        env = self.panel_env(
            '#!/bin/sh\n'
            f'printf \'%s\\n\' "$*" >> {log}\n'
            'case "$*" in\n'
            '"plugin list --plugin lat.panel --json") printf \'%s\\n\' '
            '\'{"result":{"plugins":[{"plugin_id":"lat.panel","enabled":true}]}}\' ;;\n'
            f'"tab get "*) printf \'%s\\n\' \'{{"result":{{"tab":{{"label":"{label}"}}}}}}\'; '
            f'exit {7 if fail_get else 0} ;;\n'
            f'"tab rename "*) exit {7 if fail_rename else 0} ;;\n'
            '*) exit 91 ;;\n'
            'esac\n'
        )
        return env, log

    def tab_calls(self, log):
        return [line for line in log.read_text().splitlines() if line.startswith('tab ')]

    def test_activate_renames_its_herdr_tab_once(self):
        env, log = self.tab_env()
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions, extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tab_calls(log),
                         ['tab get herdr-tab', 'tab rename herdr-tab lat-orch'])

        log.unlink()
        env, log = self.tab_env(label='lat-orch')
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions, extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tab_calls(log), ['tab get herdr-tab'])

    def test_tagged_controller_uses_short_tab_label_on_activate_and_resume(self):
        env, log = self.tab_env()
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions, '--hcom-name', 'team-task-orch',
                          extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.tab_calls(log),
                         ['tab get herdr-tab', 'tab rename herdr-tab lat-orch'])

        for label, expected in (
            ('1', ['tab get new-tab', 'tab rename new-tab lat-orch']),
            ('lat-orch', ['tab get new-tab']),
        ):
            with self.subTest(label=label):
                env, log = self.tab_env(label=label)
                log.unlink()
                resumed = dict(env, HERDR_TAB_ID='new-tab', HERDR_PANE_ID='new-pane')
                self.assert_only_pointer(self.hook(extra_env=resumed, source='resume'))
                self.assertEqual(self.tab_calls(log), expected)

    def test_hook_renames_resumed_tab_and_ignores_rename_failure(self):
        self.activate_bound()
        for fail in (False, True):
            with self.subTest(fail_rename=fail):
                env, log = self.tab_env(fail_rename=fail)
                log.unlink(missing_ok=True)
                resumed = dict(env, HERDR_TAB_ID='new-tab', HERDR_PANE_ID='new-pane')
                self.assert_only_pointer(self.hook(extra_env=resumed, source='resume'))
                self.assertEqual(self.tab_calls(log),
                                 ['tab get new-tab', 'tab rename new-tab lat-orch'])

    def test_tagged_controller_activation_ignores_tab_errors(self):
        for fail_get in (True, False):
            with self.subTest(fail_get=fail_get):
                env, log = self.tab_env(fail_get=fail_get, fail_rename=True)
                log.unlink(missing_ok=True)
                result = self.cli('activate', '--workspace', self.work,
                                  '--progress', self.progress, '--decisions', self.decisions,
                                  '--hcom-name', 'team-task-orch', extra_env=env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(self.record.read_text())['status'], 'active')
                expected = ['tab get herdr-tab']
                if not fail_get:
                    expected.append('tab rename herdr-tab lat-orch')
                self.assertEqual(self.tab_calls(log), expected)

    def test_hook_does_not_rename_tab_of_deactivated_session(self):
        env = self.activate_bound()
        stopped = self.cli('deactivate', '--workspace', self.work,
                           extra_env=env)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        env, log = self.tab_env()
        self.assert_silent(self.hook(extra_env=dict(env, HERDR_TAB_ID='new-tab'),
                                     source='resume'))
        self.assertFalse(log.exists() and self.tab_calls(log))

    def test_hook_does_not_bind_a_deactivated_or_foreign_session(self):
        env = self.activate_bound()
        resumed = dict(env, HERDR_TAB_ID='new-tab', HERDR_PANE_ID='new-pane')
        before = self.binding()
        self.assert_silent(self.hook(extra_env=resumed, source='resume', session_id=OTHER))
        self.assertEqual(self.binding(), before)
        self.assertIsNone(self.binding(OTHER))

        stopped = self.cli('deactivate', '--workspace', self.work,
                           extra_env=env)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assert_silent(self.hook(extra_env=resumed, source='resume'))
        self.assertIsNone(self.binding())

    def test_deactivate_serializes_status_change_against_waiting_hook(self):
        self.activate()
        spec = importlib.util.spec_from_file_location('lat_session_race', SCRIPT)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        real_stop = helper._stop_watcher_locked
        watcher_stopped = threading.Event()
        allow_status_write = threading.Event()
        errors = []

        def paused_stop(record):
            real_stop(record)
            watcher_stopped.set()
            if not allow_status_write.wait(3):
                raise AssertionError('test did not release deactivate')

        def deactivate():
            try:
                args = argparse.Namespace(
                    workspace=self.work, client='codex', session_id=SESSION,
                    successor=None, force_unfinished=False, reason=None,
                )
                with patch('builtins.print'):
                    helper.deactivate(args)
            except BaseException as error:
                errors.append(error)

        with patch.object(helper, '_stop_watcher_locked', side_effect=paused_stop), \
                patch.object(helper, 'panel_module', return_value=SimpleNamespace(
                    unbind_controller=lambda session_id: 0,
                    resolve_session_binding=lambda session_id: {'herdr_pane': 'pane'},
                    clear_status_display=lambda binding: (True, ''),
                    new_questions_path=lambda workspace, name: self.work / f'.lat/questions/{name}.md',
                    remove_empty_questions=lambda path, decisions: False,
                )):
            deactivate_thread = threading.Thread(target=deactivate)
            deactivate_thread.start()
            self.assertTrue(watcher_stopped.wait(3))
            payload = dict(hook_event_name='SessionStart', source='compact',
                           cwd=str(self.work), session_id=SESSION)
            hook_process = subprocess.Popen(
                [sys.executable, str(SCRIPT), 'hook'], cwd=self.work,
                env=self.cli_environment(session=OTHER), stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )
            self.addCleanup(self.terminate_process, hook_process)
            hook_process.stdin.write(json.dumps(payload))
            hook_process.stdin.close()
            hook_process.stdin = None
            self.wait_for(lambda: self.process_waits_for_lock(hook_process.pid))
            allow_status_write.set()
            deactivate_thread.join(3)
            hook_stdout, hook_stderr = hook_process.communicate(timeout=3)

        self.assertFalse(deactivate_thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(json.loads(self.record.read_text())['status'], 'ended')
        self.assertEqual((hook_process.returncode, hook_stdout, hook_stderr), (0, '', ''))
        self.assertFalse((self.work / '.lat/watch' / f'{SESSION}.pid').exists())

    def test_concurrent_sessions_stop_only_their_own_watchers(self):
        self.activate()
        second = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'orch-two', '--tasks', self.tasks,
            session=OTHER,
        )
        self.assertEqual(second.returncode, 0, second.stderr)
        first_pid = self.watcher_pid(SESSION)
        second_pid = self.watcher_pid(OTHER)
        self.assertNotEqual(first_pid, second_pid)

        stopped = self.cli(
            'deactivate', '--workspace', self.work,
            '--session-id', SESSION, session=OTHER,
        )
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.wait_for(lambda: not self.process_exists(first_pid))
        self.assertTrue(self.process_exists(second_pid))
        self.assertTrue((self.work / '.lat/watch' / f'{OTHER}.pid').exists())

    def test_activate_then_compact_and_resume_from_subdirectory(self):
        self.activate()
        record = json.loads(self.record.read_text())
        self.assertEqual(record, dict(client='codex', session_id=SESSION,
                         role='orchestrator', workspace=str(self.work), status='active',
                         skill_dir=str(SKILL), progress_path=str(self.progress),
                         decisions_path=str(self.decisions), tasks_path=str(self.tasks),
                         hcom_name='orch', rule_fingerprint=record['rule_fingerprint'],
                         ledger_path=str(self.work / f'.lat/ledgers/{SESSION}-r1.json')))
        sub = self.work / 'src'
        sub.mkdir()
        for source in ('compact', 'resume', 'compact'):
            result = self.hook(source=source, cwd=str(sub))
            self.assertEqual(result.returncode, 0, result.stderr)
            context = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
            self.assertIn(str(self.record), context)
            for text in ('SKILL.md', 'references/agents.md', 'references/task-cards.md',
                         'progress_path', 'decisions_path', 'tracker'):
                self.assertIn(text, context)

    def assert_silent(self, result):
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_unrelated_sessions_events_and_worktrees_are_silent(self):
        self.activate()
        for changes in ({'session_id': OTHER}, {'source': 'startup'}, {'source': 'clear'},
                        {'source': 'fork'}, {'hook_event_name': 'SubagentStart'},
                        {'hook_event_name': 'SubagentStop'}, {'cwd': '/does-not-exist'}):
            with self.subTest(changes=changes):
                self.assert_silent(self.hook(**changes))
        nested = self.work / '.worktrees/other'
        nested.mkdir(parents=True)
        (nested / '.git').write_text('gitdir: ignored-by-helper')
        self.assert_silent(self.hook(cwd=str(nested)))
        sibling = self.root / 'other'
        sibling.mkdir()
        (sibling / '.git').mkdir()
        self.assert_silent(self.hook(cwd=str(sibling)))

    def test_record_identity_rejections_precede_dependency_errors(self):
        self.activate()
        original = json.loads(self.record.read_text())
        for field, value in (('client', 'claude'), ('session_id', OTHER),
                             ('role', 'executor'), ('workspace', str(self.root)),
                             ('status', 'ended'), ('status', 'completed'),
                             ('status', 'cancelled'),
                             ('status', 'cleared')):
            record = dict(original, progress_path='/missing')
            record[field] = value
            self.record.write_text(json.dumps(record))
            with self.subTest(field=field, value=value):
                self.assert_silent(self.hook())

    def test_missing_marker_silent_but_broken_matching_record_reports_error(self):
        self.assert_silent(self.hook())
        self.activate()
        original = self.record.read_text()
        for broken in ('{broken', '[]', '{}'):
            self.record.write_text(broken)
            result = self.hook()
            self.assertEqual(result.returncode, 0)
            self.assertIn('LAT recovery error', result.stdout)
            self.assert_silent(self.hook(session_id=OTHER))
        self.record.write_text(original)
        self.progress.unlink()
        self.assertIn('LAT recovery error', self.hook().stdout)

    def test_concurrent_controllers_get_only_their_own_record(self):
        self.activate()
        self.activate(session=OTHER)
        for sid, other in ((SESSION, OTHER), (OTHER, SESSION)):
            text = self.hook(session_id=sid).stdout
            self.assertIn(sid, text)
            self.assertNotIn(other, text)

    def test_deactivate_preserves_record_and_stops_recovery(self):
        for extra, successor in (((), None), (('--successor', 'nova'), 'nova'),
                                 (('--status', 'completed'), None),
                                 (('--status', 'cancelled'), None)):
            with self.subTest(extra=extra):
                if self.record.exists():
                    self.record.unlink()
                self.activate()
                result = self.cli('deactivate', '--workspace', self.work, *extra,
                                  '--session-id', SESSION, session=OTHER)
                self.assertEqual(result.returncode, 0, result.stderr)
                record = json.loads(self.record.read_text())
                self.assertEqual(record['status'], 'ended')
                self.assertEqual(record.get('successor'), successor)
                self.assert_silent(self.hook())
                self.assert_silent(self.hook(source='resume'))

    def test_deactivate_rejects_invalid_successor_without_changes(self):
        self.activate()
        original = self.record.read_bytes()
        pid = self.watcher_pid()
        result = self.cli('deactivate', '--workspace', self.work, '--successor', 'bad name')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid successor', result.stderr)
        self.assertEqual(self.record.read_bytes(), original)
        self.assertEqual(self.watcher_pid(), pid)

    def test_older_finished_statuses_still_start_a_new_round(self):
        for status in ('completed', 'cancelled'):
            with self.subTest(status=status):
                if self.record.exists():
                    self.record.unlink()
                self.activate()
                self.assertEqual(self.cli('deactivate', '--workspace', self.work).returncode, 0)
                previous = dict(json.loads(self.record.read_text()), status=status)
                self.record.write_text(json.dumps(previous))
                self.assert_silent(self.hook())
                self.activate()
                current = json.loads(self.record.read_text())
                self.assertEqual(current['status'], 'active')
                self.assertEqual(current['history'][-1]['status'], status)

    def test_activation_requires_environment_id_and_does_not_reset_active_record(self):
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions, session='')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())
        self.activate()
        record = json.loads(self.record.read_text())
        record['progress_path'] = str(self.work / 'other-progress.md')
        self.record.write_text(json.dumps(record))
        before = self.record.read_bytes()
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, self.record.read_bytes())

    def test_install_preview_merge_idempotence_backup_and_uninstall(self):
        home = self.root / 'codex home'
        home.mkdir()
        hooks = home / 'hooks.json'
        original = {'unknown': {'keep': [1, 2]}, 'hooks': {
            'SessionStart': [{'matcher': '*', 'unknown': True, 'hooks': [
                {'type': 'command', 'command': 'hcom hook codex session-start'},
                {'type': 'command', 'command': 'third-party --go', 'extra': 5}]}],
            'Stop': [{'hooks': [{'type': 'command', 'command': 'hcom hook codex stop'}]}]}}
        hooks.write_text(json.dumps(original))
        before = hooks.read_bytes()
        preview = self.cli('install', '--codex-home', home, '--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn('lat-codex-recovery', preview.stdout)
        self.assertEqual(hooks.read_bytes(), before)
        self.assertEqual(list(home.iterdir()), [hooks])
        installed = self.cli('install', '--codex-home', home)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        merged = json.loads(hooks.read_text())
        self.assertEqual(merged['unknown'], original['unknown'])
        self.assertEqual(merged['hooks']['Stop'][0], original['hooks']['Stop'][0])
        self.assertEqual(len(merged['hooks']['Stop']), 2)
        self.assertNotIn('matcher', merged['hooks']['Stop'][1])
        self.assertEqual(merged['hooks']['SessionStart'][0], original['hooks']['SessionStart'][0])
        self.assertEqual(len(merged['hooks']['SessionStart']), 2)
        backups = list(home.glob('hooks.json.lat-backup-*'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), before)
        first = hooks.read_bytes()
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        self.assertEqual(first, hooks.read_bytes())
        self.assertEqual(list(home.glob('hooks.json.lat-backup-*')), backups)
        self.assertEqual(self.cli('uninstall', '--codex-home', home, '--preview').returncode, 0)
        self.assertEqual(first, hooks.read_bytes())
        self.assertEqual(self.cli('uninstall', '--codex-home', home).returncode, 0)
        self.assertEqual(json.loads(hooks.read_text()), original)

    def test_invalid_hooks_config_is_not_overwritten(self):
        home = self.root / 'config'
        home.mkdir()
        hooks = home / 'hooks.json'
        for value in ('{broken', '[]', '{"hooks": []}', '{"hooks":{"SessionStart":{}}}'):
            hooks.write_text(value)
            result = self.cli('install', '--codex-home', home)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(hooks.read_text(), value)
            self.assertEqual(list(home.iterdir()), [hooks])

    def test_non_git_activation_rejected_and_hook_silent(self):
        result = self.cli('activate', '--workspace', self.root, '--progress', self.progress,
                          '--decisions', self.decisions)
        self.assertNotEqual(result.returncode, 0)
        self.assert_silent(self.hook(cwd=str(self.root)))

    def test_unknown_fields_and_added_handlers_in_lat_group_survive(self):
        home = self.root / 'config'
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        path = home / 'hooks.json'
        config = json.loads(path.read_text())
        group = config['hooks']['SessionStart'][0]
        group['future'] = {'keep': 1}
        group['hooks'][0]['timeout'] = 12
        extra = {'type': 'command', 'command': 'echo third-party'}
        group['hooks'].append(extra)
        path.write_text(json.dumps(config))
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        group = json.loads(path.read_text())['hooks']['SessionStart'][0]
        self.assertEqual(group['future'], {'keep': 1})
        self.assertEqual(group['hooks'][0]['timeout'], 12)
        self.assertEqual(group['hooks'][1], extra)
        self.assertEqual(self.cli('uninstall', '--codex-home', home).returncode, 0)
        group = json.loads(path.read_text())['hooks']['SessionStart'][0]
        self.assertEqual(group['hooks'], [extra])
        self.assertEqual(group['future'], {'keep': 1})

    def test_hook_handles_malformed_payload_without_output(self):
        for payload in ([], {}, {'hook_event_name': 'SessionStart', 'source': 'compact',
                               'session_id': '../escape', 'cwd': str(self.work)}):
            self.assert_silent(self.cli('hook', payload=payload))
        self.assert_silent(self.cli('hook'))

    def test_concurrent_config_edit_is_detected_and_preserved(self):
        # Simulate another writer at the filesystem boundary before replacement.
        spec = importlib.util.spec_from_file_location('lat_session', SCRIPT)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        home = self.root / 'config'
        home.mkdir()
        path = home / 'hooks.json'
        path.write_text('{}')
        real_read = helper.current_bytes
        calls = 0
        def competing_read(target):
            nonlocal calls
            calls += 1
            if calls == 2:
                path.write_text('{"external": true}')
            return real_read(target)
        args = argparse.Namespace(codex_home=home, action='install', preview=False,
                                  client='codex')
        with patch.object(helper, 'current_bytes', side_effect=competing_read):
            with self.assertRaisesRegex(ValueError, 'Concurrent'):
                helper.configure(args)
        self.assertEqual(json.loads(path.read_text()), {'external': True})
        self.assertEqual(list(home.iterdir()), [path])


    def test_claude_controller_record_and_hook_are_client_scoped(self):
        result = self.cli(
            'activate', '--client', 'claude', '--workspace', self.work,
            '--progress', self.progress, '--decisions', self.decisions,
            session='', claude_session=SESSION,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.record.read_text())['client'], 'claude')
        payload = dict(hook_event_name='SessionStart', source='compact',
                       cwd=str(self.work), session_id=SESSION)
        for source in ('compact', 'resume'):
            result = self.cli('hook', '--client', 'claude', payload=dict(payload, source=source))
            self.assertIn(str(self.record), result.stdout)
        for changes in ({'source': 'startup'}, {'source': 'clear'}, {'source': 'fork'}):
            self.assert_silent(self.cli('hook', '--client', 'claude',
                                        payload=dict(payload, **changes)))
        # A Codex hook never answers a Claude record.
        self.assert_silent(self.cli('hook', payload=payload))
        result = self.cli('deactivate', '--client', 'claude', '--workspace', self.work, '--session-id', SESSION, session=OTHER)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_silent(self.cli('hook', '--client', 'claude', payload=payload))

    def test_recovery_inlines_dispatch_references_for_claude_only(self):
        references = [SKILL / 'references/agents.md', SKILL / 'references/task-cards.md']
        result = self.cli(
            'activate', '--client', 'claude', '--workspace', self.work,
            '--progress', self.progress, '--decisions', self.decisions,
            session='', claude_session=SESSION,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.cli('hook', '--client', 'claude', payload=dict(
            hook_event_name='SessionStart', source='compact', cwd=str(self.work),
            session_id=SESSION))
        context = json.loads(result.stdout)['hookSpecificOutput']['additionalContext']
        for reference in references:
            self.assertIn(f'===== {reference} =====\n{reference.read_text()}', context)
        # Claude Code moves context over 10,000 characters to a file and shows a 2,000-character
        # preview; reserve 1,000 characters for paths and the legacy-upgrade suffix.
        # Charge a fixed path budget, not this checkout's absolute path lengths. Only
        # strip the generated path fields: reference prose must still count in full.
        # The work ledger section is cut to the hook limit on its own; see its tests.
        self.assertLess(len(context), 10_000)
        sized = context.split('\n\nWork ledger (', 1)[0].replace(
            f'LAT recovery record: {self.record}\n', 'LAT recovery record: \n', 1)
        for reference in references:
            sized = sized.replace(f'===== {reference} =====\n', '===== =====\n', 1)
        self.assertLess(len(sized), 9_000)
        self.cli('deactivate', '--client', 'claude', '--workspace', self.work,
                 '--session-id', SESSION, session=OTHER)
        self.record.unlink()
        self.activate()
        context = json.loads(self.hook().stdout)['hookSpecificOutput']['additionalContext']
        self.assertIn('skill_dir/references/agents.md', context)
        self.assertNotIn('=====', context)

    def test_claude_activation_requires_claude_session_id(self):
        result = self.cli('activate', '--client', 'claude', '--workspace', self.work,
                          '--progress', self.progress, '--decisions', self.decisions)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())

    def test_claude_settings_install_merge_idempotence_and_uninstall(self):
        settings = self.root / 'claude' / 'settings.json'
        settings.parent.mkdir()
        hcom = {'hooks': [{'type': 'command', 'command': 'hcom sessionstart'}]}
        original = {'permissions': {'allow': ['Bash(ls:*)']}, 'hooks': {
            'SessionStart': [hcom], 'Stop': [{'hooks': [{'type': 'command', 'command': 's'}]}]}}
        settings.write_text(json.dumps(original))
        before = settings.read_bytes()
        flags = ('--client', 'claude', '--claude-settings', settings)
        preview = self.cli('install', *flags, '--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertIn('--client claude', preview.stdout)
        self.assertEqual(settings.read_bytes(), before)
        self.assertEqual(self.cli('install', *flags).returncode, 0)
        merged = json.loads(settings.read_text())
        self.assertEqual(merged['permissions'], original['permissions'])
        self.assertEqual(merged['hooks']['Stop'][0], original['hooks']['Stop'][0])
        self.assertEqual(len(merged['hooks']['Stop']), 2)
        self.assertNotIn('matcher', merged['hooks']['Stop'][1])
        groups = merged['hooks']['SessionStart']
        self.assertEqual(groups[0], hcom)
        self.assertEqual(groups[1]['matcher'], '^(compact|resume)$')
        self.assertNotIn('name', groups[1])
        self.assertTrue(groups[1]['hooks'][0]['command'].endswith('hook --client claude'))
        self.assertEqual(len(list(settings.parent.glob('settings.json.lat-backup-*'))), 1)
        first = settings.read_bytes()
        self.assertEqual(self.cli('install', *flags).returncode, 0)
        self.assertEqual(settings.read_bytes(), first)
        self.assertEqual(self.cli('uninstall', *flags).returncode, 0)
        self.assertEqual(json.loads(settings.read_text()), original)

    def test_claude_install_refuses_shared_group_without_changes(self):
        settings = self.root / 'settings.json'
        flags = ('--client', 'claude', '--claude-settings', settings)
        self.assertEqual(self.cli('install', *flags).returncode, 0)
        config = json.loads(settings.read_text())
        group = config['hooks']['SessionStart'][0]
        group['matcher'] = '^(startup|compact|resume)$'
        group['hooks'].append({'type': 'command', 'command': 'echo third-party'})
        settings.write_text(json.dumps(config))
        before = settings.read_bytes()
        result = self.cli('install', *flags)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('shares a SessionStart group', result.stderr)
        self.assertEqual(settings.read_bytes(), before)


    def test_stop_install_preview_no_file_and_uninstall_noop_for_both_clients(self):
        for client in ('claude', 'codex'):
            path = self.root / client / ('settings.json' if client == 'claude' else 'hooks.json')
            flags = ('--client', client, '--claude-settings', path) if client == 'claude' else (
                '--codex-home', path.parent)
            result = self.cli('install', *flags, '--preview')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn('Stop', result.stdout)
            self.assertFalse(path.parent.exists())
            path.parent.mkdir()
            path.write_text('{"keep": true}')
            original = path.read_bytes()
            self.assertEqual(self.cli('uninstall', *flags).returncode, 0)
            self.assertEqual(path.read_bytes(), original)
            result = self.cli('install', *flags)
            self.assertEqual(result.returncode, 0, result.stderr)
            if client == 'codex':
                self.assertIn('/hooks', result.stdout)
            self.assertEqual(len(list(path.parent.glob('*.lat-backup-*'))), 1)
            for event in ('SessionStart', 'Stop'):
                group = json.loads(path.read_text())['hooks'][event][0]
                self.assertEqual(len(group['hooks']), 1)
            self.assertEqual(self.cli('uninstall', *flags).returncode, 0)
            removed = path.read_bytes()
            backups = list(path.parent.glob('*.lat-backup-*'))
            self.assertEqual(self.cli('uninstall', *flags).returncode, 0)
            self.assertEqual(path.read_bytes(), removed)
            self.assertEqual(list(path.parent.glob('*.lat-backup-*')), backups)

    def test_stop_group_preserves_other_handlers_on_uninstall_for_both_clients(self):
        for client in ('codex', 'claude'):
            path = self.root / client / ('hooks.json' if client == 'codex' else 'settings.json')
            flags = ('--client', client, '--claude-settings', path) if client == 'claude' else (
                '--codex-home', path.parent)
            self.assertEqual(self.cli('install', *flags).returncode, 0)
            config = json.loads(path.read_text())
            group = config['hooks']['Stop'][0]
            group['future'] = 42
            group['hooks'][0]['timeout'] = 20
            extra = {'type': 'command', 'command': 'echo third-party'}
            group['hooks'].append(extra)
            path.write_text(json.dumps(config))
            before = path.read_bytes()
            installed = self.cli('install', *flags)
            if client == 'claude':
                self.assertNotEqual(installed.returncode, 0)
                self.assertIn('shares a Stop group', installed.stderr)
                self.assertEqual(path.read_bytes(), before)
            else:
                self.assertEqual(installed.returncode, 0, installed.stderr)
                updated = json.loads(path.read_text())['hooks']['Stop'][0]
                self.assertEqual(updated['future'], 42)
                self.assertEqual(updated['hooks'][0]['timeout'], 20)
                self.assertEqual(updated['hooks'][1], extra)
            self.assertEqual(self.cli('uninstall', *flags).returncode, 0)
            updated = json.loads(path.read_text())['hooks']['Stop'][0]
            self.assertEqual(updated['hooks'], [extra])
            self.assertEqual(updated['future'], 42)

    def test_paired_install_aborts_on_invalid_stop_groups_without_writes(self):
        for client in ('claude', 'codex'):
            path = self.root / client / ('settings.json' if client == 'claude' else 'hooks.json')
            path.parent.mkdir()
            path.write_text('{"hooks": {"SessionStart": [], "Stop": {}}}')
            flags = ('--client', client, '--claude-settings', path) if client == 'claude' else (
                '--codex-home', path.parent)
            original = path.read_bytes()
            result = self.cli('install', *flags)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_claude_paired_install_concurrent_edit_aborts_without_backup(self):
        spec = importlib.util.spec_from_file_location('lat_session', SCRIPT)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        path = self.root / 'settings.json'
        path.write_text('{}')
        real_read = helper.current_bytes
        calls = 0
        def competing_read(target):
            nonlocal calls
            calls += 1
            if calls == 2:
                path.write_text('{"external": true}')
            return real_read(target)
        args = argparse.Namespace(claude_settings=path, action='install', preview=False,
                                  client='claude')
        with patch.object(helper, 'current_bytes', side_effect=competing_read):
            with self.assertRaisesRegex(ValueError, 'Concurrent'):
                helper.configure(args)
        self.assertEqual(json.loads(path.read_text()), {'external': True})
        self.assertFalse(list(self.root.glob('settings.json.lat-backup-*')))

    def test_install_migrates_pre_rename_codex_command(self):
        home = self.root / 'config'
        home.mkdir()
        path = home / 'hooks.json'
        old = 'uv run --no-project python /old/lat/scripts/codex-lat-session.py hook'
        path.write_text(json.dumps({'hooks': {'SessionStart': [
            {'name': 'lat-codex-recovery', 'matcher': '^(compact|resume)$',
             'hooks': [{'type': 'command', 'command': old}]}]}}))
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        groups = json.loads(path.read_text())['hooks']['SessionStart']
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['hooks'], [{'type': 'command', 'command':
                         f'uv run --no-project python {SCRIPT} hook'}])

    def test_stop_ticket_confirmation_without_consensus_for_both_clients(self):
        for client in ('codex', 'claude'):
            self.write_legacy_record(client=client)
            questions = self.bind_stop_panel(client)
            questions.write_text('## Question\nLAT-A · r1 · 待答\n')
            binding_path = self.root / 'plugin-config/bindings.json'
            original = binding_path.read_text()
            for bound in (False, True):
                with self.subTest(client=client, bound=bound):
                    binding_path.write_text(original if bound else '{"version": 2, "bindings": {}}')
                    path = self.decisions / 'LAT-A.md'
                    path.write_text('- status: pending\n- advisor: exempt ticket-confirmation\n')
                    self.assert_stop_pass(self.stop_hook(client=client),
                                          *['LAT-A r1 - Question'][:bound])
                    path.write_text('- status: pending\n- advisor: exempt ticket-confirmatio\n')
                    self.assert_stop_block(self.stop_hook(client=client), '不在清單內')
                    path.write_text('- status: pending\n- advisor: exempt ticket-confirmation\n')
                    self.assert_stop_pass(self.stop_hook(client=client, stop_hook_active=True),
                                          *['LAT-A r1 - Question'][:bound])
            binding_path.write_text(original)

    def activate_as(self, client):
        self.activate()
        record = json.loads(self.record.read_text())
        record['client'] = client
        self.record.write_text(json.dumps(record))

    def test_stop_repeated_question_tag_blocks_once_and_new_or_revised_pass(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.activate_as(client)
                for name, kind in (('LAT-A', ''), ('LAT-B', ''), ('LAT-H', '- kind: help\n')):
                    self.decisions.joinpath(f'{name}.md').write_text(
                        f'- status: pending\n- advisor: needs-human\n{kind}')
                self.assert_silent(self.stop_hook('❓ **LAT-A r1** 標題\nDECIDE: LAT-A r1 請選', client))
                for repeat in ('DECIDE: LAT-A r1 還在等', '❓ **LAT-A r1** 標題\nDECIDE: 請選'):
                    result = self.stop_hook(repeat, client)
                    output = json.loads(result.stdout)
                    self.assertEqual(output['decision'], 'block')
                    for detail in ('LAT-A r1', '已在先前訊息', '`NO REPLY: `'):
                        self.assertIn(detail, output['reason'])
                warning = json.loads(self.stop_hook('DECIDE: LAT-A r1', client,
                                                    stop_hook_active=True).stdout)
                self.assertEqual(set(warning), {'systemMessage'})
                self.assertIn('不再攔下', warning['systemMessage'])
                self.assert_silent(self.stop_hook('NO REPLY: 等你回答 LAT-A r1', client))
                # A new question only in a heading does not excuse an old-only tag line.
                self.assertIn('最後一行只列出 LAT-A r1', json.loads(self.stop_hook(
                    '❓ **LAT-B r1** 新題\nDECIDE: LAT-A r1', client).stdout)['reason'])
                self.assert_silent(self.stop_hook('DECIDE: LAT-A r1, LAT-B r1', client))
                self.assert_silent(self.stop_hook('DECIDE: LAT-A r2 改版', client))
                self.assert_silent(self.stop_hook('請登入\nHELP: LAT-H r1', client))
                self.assertIn('已在先前訊息',
                              json.loads(self.stop_hook('HELP: LAT-H r1', client).stdout)['reason'])
                # A blocked Stop is not reported, so it does not count as asked.
                self.decisions.joinpath('LAT-C.md').write_text('- status: pending\n')
                self.assert_stop_block(self.stop_hook('DECIDE: LAT-C r1', client), '沒有參謀行')
                self.decisions.joinpath('LAT-C.md').write_text(
                    '- status: pending\n- advisor: needs-human\n')
                self.assert_silent(self.stop_hook('DECIDE: LAT-C r1', client))
                self.record.unlink()
                (self.root / 'reports' / f'{SESSION}.jsonl').unlink()

    def test_stop_help_gets_the_same_id_status_and_panel_checks(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.write_legacy_record(client=client)
                path = self.decisions / 'LAT-H.md'
                self.assert_stop_block(self.stop_hook('HELP: 請登入', client), '沒有寫出題號')
                self.assert_stop_block(self.stop_hook('HELP: LAT-H r1', client), '沒有待決紀錄')
                path.write_text('- status: pending\n- advisor: needs-human\n')
                self.assert_stop_block(self.stop_hook('HELP: LAT-H r1', client), '- kind: help')
                path.write_text('- status: answered\n- advisor: needs-human\n- kind: help\n')
                self.assert_stop_block(self.stop_hook('HELP: LAT-H r1', client), '不是 pending')
                path.write_text('- status: pending\n- kind: help\n')
                self.assert_stop_block(self.stop_hook('HELP: LAT-H r1', client), '沒有參謀行')
                path.write_text('- status: pending\n- advisor: needs-human\n- Kind: Help\n')
                self.assert_silent(self.stop_hook('請登入\nHELP: LAT-H r1', client))
                self.assertIn('LAT HELP 檢查未通過',
                              json.loads(self.stop_hook('HELP: X r1', client).stdout)['reason'])
                questions = self.bind_stop_panel(client)
                self.assert_stop_block(self.stop_hook('HELP: LAT-H r1', client), '自己的面板')
                questions.write_text('## 請登入\nLAT-H · r1 · 待答\n')
                self.assert_stop_pass(self.stop_hook('請登入\nHELP: LAT-H r1', client),
                                      'LAT-H r1 - 請登入')
                (self.root / 'plugin-config/bindings.json').write_text(
                    '{"version": 2, "bindings": {}}')
                path.write_bytes(b'\xff')
                warning = json.loads(self.stop_hook('HELP: LAT-H r1', client).stdout)
                self.assertIn('LAT HELP 檢查發生錯誤，未攔下', warning['systemMessage'])
                path.unlink()
                questions.unlink()

    def sidebar_env(self):
        """Fake herdr: panel enabled; other calls succeed and are logged one per line."""
        log = self.root / 'herdr.log'
        env = self.panel_env(
            '#!/bin/sh\n'
            f'printf \'%s\\n\' "$*" >> {log}\n'
            'case "$*" in\n'
            '"plugin list --plugin lat.panel --json") printf \'%s\\n\' '
            '\'{"result":{"plugins":[{"plugin_id":"lat.panel","enabled":true}]}}\' ;;\n'
            '"tab get "*) printf \'%s\\n\' \'{"result":{"tab":{"label":"lat-orch"}}}\' ;;\n'
            'esac\n'
        )
        return env, log

    def sidebar_calls(self, log):
        return [re.sub(r'--seq [0-9]+ ', '', line) for line in log.read_text().splitlines()
                if line.startswith('pane report-metadata')]

    def test_activate_resume_and_deactivate_keep_the_sidebar_in_step(self):
        env, log = self.sidebar_env()
        self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n- advisor: needs-human\n')
        questions = self.work / '.lat/questions/orch.md'
        questions.parent.mkdir(parents=True, exist_ok=True)
        questions.write_text('## Q\nLAT-A · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n')
        self.assertEqual(self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                                  '--decisions', self.decisions, extra_env=env).returncode, 0)
        shown = 'pane report-metadata {} --source lat.panel.status --display-agent orch ⚠待答1'
        self.assertEqual(self.sidebar_calls(log), [shown.format('herdr-pane')])
        resumed = dict(env, HERDR_WORKSPACE_ID='w2', HERDR_TAB_ID='t2', HERDR_PANE_ID='p2')
        self.assert_only_pointer(self.hook(extra_env=resumed, source='resume'))
        self.assertEqual(self.sidebar_calls(log)[-2:], [
            'pane report-metadata herdr-pane --source lat.panel.status --clear-display-agent',
            shown.format('p2')])
        self.assert_only_pointer(self.hook(extra_env=resumed, source='resume'))
        self.assertEqual(self.sidebar_calls(log)[-1], shown.format('p2'))
        self.assertNotIn('herdr-pane', self.sidebar_calls(log)[-2])
        result = self.cli('deactivate', '--workspace', self.work,
                          extra_env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.sidebar_calls(log)[-1],
                         'pane report-metadata p2 --source lat.panel.status --clear-display-agent')
        calls = len(self.sidebar_calls(log))
        self.assertEqual(self.cli('deactivate', '--workspace', self.work,
                                  extra_env=env).returncode, 0)
        self.assertEqual(len(self.sidebar_calls(log)), calls)


    def prompt_hook(self, prompt='那題不用了，改做別的', client='codex', **overrides):
        payload = dict(hook_event_name='UserPromptSubmit', cwd=str(self.work), session_id=SESSION,
                       prompt=prompt)
        payload.update(overrides)
        return self.cli('hook', '--client', client, payload=payload, session=OTHER)

    def ask(self, identifier, title, status='pending'):
        """Write a decision record and ask its question in the controller's own questions file."""
        self.decisions.joinpath(f'{identifier}.md').write_text(
            f'- status: {status}\n- advisor: needs-human\n')
        section = self.root / f'{identifier}.section.md'
        section.write_text(f'## {title}\n\n背景。\n\nA. 好\n   影響。\n')
        result = subprocess.run(
            [sys.executable, str(PANEL), 'question', 'upsert',
             '--questions', str(self.work / '.lat/questions/orch.md'),
             '--decisions', str(self.decisions), '--id', identifier, '--file', str(section)],
            text=True, capture_output=True, env=self.cli_environment(), cwd=self.work)
        self.assertEqual(result.returncode, 0, result.stderr)

    def prompt_context(self, result):
        self.assertEqual((result.returncode, result.stderr), (0, ''))
        output = json.loads(result.stdout)
        self.assertEqual(output['hookSpecificOutput']['hookEventName'], 'UserPromptSubmit')
        return output['hookSpecificOutput']['additionalContext']

    def test_prompt_reminder_lists_own_waiting_questions_for_both_clients(self):
        self.ask('LAT-A', '要合併嗎？')
        self.ask('LAT-B', '要關閉 Spec 嗎？')
        self.ask('LAT-B', '要關閉 Spec 嗎？（改）')
        self.ask('DONE', '已答的題', status='pending')
        self.decisions.joinpath('DONE.md').write_text('- status: answered\n')
        self.ask('SENT', '已送出未記錄的題')
        questions = self.work / '.lat/questions/orch.md'
        questions.write_text(questions.read_text().replace(
            'SENT · r1 · 待答\n\n背景。\n\nA. 好\n   影響。\n\n答覆：\n\n- [ ] 送出',
            'SENT · r1 · 待答\n\n背景。\n\nA. 好\n   影響。\n\n答覆：A\n\n- [x] 送出'))
        self.assertIn('[x]', questions.read_text())
        # A question another controller asked in the same workspace is not listed.
        other = self.work / '.lat/questions/other.md'
        other.write_text('## Theirs\nOTHER · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n')
        self.decisions.joinpath('OTHER.md').write_text('- status: pending\n')
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.write_legacy_record(client=client, hcom_name='orch',
                                         tasks_path=str(self.tasks))
                text = self.prompt_context(self.prompt_hook(client=client))
                lines = text.splitlines()
                self.assertEqual(lines[0], 'LAT 待答提醒：你還有 2 題待答。')
                self.assertRegex(lines[1], r'^- LAT-A r1「要合併嗎？」，提問時間 '
                                           r'\d{4}-\d\d-\d\d \d\d:\d\d$')
                self.assertRegex(lines[2], r'^- LAT-B r2「要關閉 Spec 嗎？（改）」，提問時間 \d{4}-')
                self.assertIn('question withdraw', lines[3])
                self.assertIn('改版', lines[3])
                self.assertIn(str(SKILL / 'references/question-panel.md'), lines[3])
                self.assertNotIn('DONE', text)
                self.assertNotIn('SENT', text)
                self.assertNotIn('OTHER', text)

    def test_prompt_reminder_shows_unknown_time_without_an_upsert_entry(self):
        self.write_legacy_record(hcom_name='orch', tasks_path=str(self.tasks))
        self.decisions.joinpath('LAT-A.md').write_text('- status: pending\n')
        questions = self.work / '.lat/questions/orch.md'
        questions.parent.mkdir(parents=True)
        questions.write_text('## Q\nLAT-A · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n')
        self.assertIn('- LAT-A r1「Q」，提問時間 不明',
                      self.prompt_context(self.prompt_hook()))

    def test_prompt_reminder_silent_cases(self):
        self.ask('LAT-A', '要合併嗎？')
        record = self.write_legacy_record(hcom_name='orch', tasks_path=str(self.tasks))
        # HCOM wakes agents with a prompt holding only its marker.
        for prompt in ('<hcom>', ' <hcom>\n', '<hcom><hcom>'):
            with self.subTest(prompt=prompt):
                self.assert_silent(self.prompt_hook(prompt))
        self.assertIn('LAT-A', self.prompt_hook('<hcom> 其實那題不用了').stdout)
        for changes in ({'session_id': OTHER}, {'cwd': str(self.root)},
                        {'prompt': None}, {'hook_event_name': 'UserPromptSubmitted'}):
            with self.subTest(changes=changes):
                self.assert_silent(self.prompt_hook(**changes))
        self.assert_silent(self.prompt_hook(client='claude'))
        for field, value in (('role', 'executor'), ('status', 'ended'),
                             ('workspace', str(self.root)), ('client', 'claude')):
            with self.subTest(field=field):
                self.record.write_text(json.dumps(dict(record, **{field: value})))
                self.assert_silent(self.prompt_hook())
        # A legacy record has no HCOM name, so no questions file of its own.
        self.write_legacy_record()
        self.assert_silent(self.prompt_hook())
        self.write_legacy_record(hcom_name='orch', tasks_path=str(self.tasks))
        self.decisions.joinpath('LAT-A.md').write_text('- status: withdrawn\n')
        self.assert_silent(self.prompt_hook())
        self.record.unlink()
        self.assert_silent(self.prompt_hook())

    def test_prompt_reminder_errors_only_warn(self):
        self.ask('LAT-A', '要合併嗎？')
        self.write_legacy_record(hcom_name='orch', tasks_path=str(self.tasks))
        questions = self.work / '.lat/questions/orch.md'
        questions.write_text(questions.read_text() * 2)
        for broken in (None, '{broken', '[]'):
            with self.subTest(broken=broken):
                if broken:
                    self.record.write_text(broken)
                result = self.prompt_hook()
                self.assertEqual((result.returncode, result.stderr), (0, ''))
                output = json.loads(result.stdout)
                self.assertEqual(list(output), ['systemMessage'])
                self.assertIn('LAT 待答提醒發生錯誤，未提醒', output['systemMessage'])

    def test_install_adds_user_prompt_submit_without_matcher_for_both_clients(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                path = self.root / client / ('hooks.json' if client == 'codex' else 'settings.json')
                flags = (('--codex-home', path.parent) if client == 'codex' else
                         ('--client', 'claude', '--claude-settings', path))
                path.parent.mkdir()
                other = {'hooks': [{'type': 'command', 'command': 'hcom hook prompt'}]}
                original = {'hooks': {'UserPromptSubmit': [other]}}
                path.write_text(json.dumps(original))
                preview = self.cli('install', *flags, '--preview')
                self.assertIn('UserPromptSubmit', preview.stdout)
                self.assertEqual(json.loads(path.read_text()), original)
                self.assertEqual(self.cli('install', *flags).returncode, 0)
                groups = json.loads(path.read_text())['hooks']['UserPromptSubmit']
                self.assertEqual(groups[0], other)
                self.assertEqual(len(groups), 2)
                self.assertNotIn('matcher', groups[1])
                self.assertEqual(groups[1].get('name'),
                                 'lat-codex-recovery' if client == 'codex' else None)
                command = groups[1]['hooks'][0]['command']
                self.assertTrue(command.endswith('hook --client claude' if client == 'claude'
                                                 else 'lat-session.py hook'))
                first = path.read_bytes()
                self.assertEqual(self.cli('install', *flags).returncode, 0)
                self.assertEqual(path.read_bytes(), first)
                self.assertEqual(self.cli('uninstall', *flags).returncode, 0)
                self.assertEqual(json.loads(path.read_text())['hooks']['UserPromptSubmit'], [other])

    # ---- work ledger (#299) ------------------------------------------------------------

    def ledger_path(self, round_number=1):
        return self.work / '.lat/ledgers' / f'{SESSION}-r{round_number}.json'

    def ledger(self, *args, round_number=1):
        result = subprocess.run(
            [sys.executable, str(SKILL / 'scripts/lat-ledger.py'), args[0], '--ledger',
             str(self.ledger_path(round_number)), '--by', 'orch', *map(str, args[1:])],
            text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def open_item(self, ticket='#1'):
        """Add one item with file evidence, assigned but not closed; returns its number."""
        item = self.ledger('add', '--ticket', ticket, '--stage', 'impl', '--evidence', 'file',
                           '--deadline', '+1d').strip()
        self.ledger('assign', item, '--agent', 'worker', '--card', self.tasks / 'card.md')
        return item

    def close_item(self, item):
        report = self.root / f'report-{item}.md'
        report.write_text('done\n')
        self.ledger('done', item, '--file', report)

    def deactivate(self, *extra):
        return self.cli('deactivate', '--workspace', self.work, *extra)

    def test_ledger_is_created_per_round_and_reused_within_a_round(self):
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions)
        self.assertEqual(result.returncode, 0, result.stderr)
        first = self.ledger_path(1)
        self.assertIn(f'工作總表：{first}', result.stdout)
        self.assertEqual(json.loads(self.record.read_text())['ledger_path'], str(first))
        self.assertEqual(json.loads(first.read_text())['orchestrator'], 'orch')
        self.open_item()
        before = first.read_bytes()
        # A rerun in the same round and compact/resume keep the same ledger.
        self.activate(duty=False)
        for source in ('compact', 'resume'):
            self.assertEqual(self.hook(source=source).returncode, 0)
        self.assertEqual(json.loads(self.record.read_text())['ledger_path'], str(first))
        self.assertEqual(first.read_bytes(), before)
        self.assertEqual(self.deactivate('--force-unfinished', '--reason', 'next round').returncode, 0)
        ended = first.read_bytes()
        self.activate(duty=False)
        record = json.loads(self.record.read_text())
        self.assertEqual(record['ledger_path'], str(self.ledger_path(2)))
        self.assertEqual(record['history'][0]['ledger_path'], str(first))
        self.assertTrue(self.ledger_path(2).is_file())
        self.assertEqual(first.read_bytes(), ended)

    def test_activate_reuses_a_ledger_left_by_an_unfinished_activate(self):
        self.ledger_path().parent.mkdir(parents=True)
        subprocess.run([sys.executable, str(SKILL / 'scripts/lat-ledger.py'), 'init', '--ledger',
                        str(self.ledger_path()), '--workspace', str(self.work)], check=True,
                       capture_output=True)
        before = self.ledger_path().read_bytes()
        self.activate(duty=False)
        self.assertEqual(json.loads(self.record.read_text())['ledger_path'], str(self.ledger_path()))
        self.assertEqual(self.ledger_path().read_bytes(), before)

    def recovery_context(self, client='codex'):
        if client == 'claude':
            result = self.cli('hook', '--client', 'claude', payload=dict(
                hook_event_name='SessionStart', source='compact', cwd=str(self.work),
                session_id=SESSION))
        else:
            result = self.hook()
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)['hookSpecificOutput']['additionalContext']

    def test_recovery_prompt_carries_the_ledger_table_within_the_client_limit(self):
        self.activate()
        self.open_item('#77')
        context = self.recovery_context()
        self.assertIn(f'show --ledger {self.ledger_path()}', context)
        self.assertIn(f'工作總表 {self.ledger_path()}', context)
        self.assertIn('| 1 | #77 | 實作 | worker | 已派 |', context)
        self.assertNotIn('more lines not shown', context)
        for number in range(2, 41):
            self.open_item(f'#{number}')
        for client, limit in (('codex', 3_000), ('claude', 9_800)):
            with self.subTest(client=client):
                record = json.loads(self.record.read_text())
                record['client'] = client
                self.record.write_text(json.dumps(record))
                context = self.recovery_context(client)
                self.assertLessEqual(len(context), limit)
                self.assertIn('cut to fit the hook limit', context)
                self.assertIn(f'show --ledger {self.ledger_path()}', context)
                self.assertRegex(context, r'… [0-9]+ more lines not shown$')

    def test_recovery_prompt_reports_an_unreadable_ledger(self):
        self.activate()
        self.ledger_path().write_text('{"hand": "edit"}\n')
        context = self.recovery_context()
        self.assertIn('LAT work ledger error:', context)
        self.assertIn('repair --from-journal', context)

    def test_done_stop_checks_the_ledger_once_per_turn(self):
        self.activate()
        item = self.open_item('#5')
        # Only a DONE last line runs the check.
        self.assert_silent(self.stop_hook('NO REPLY: working'))
        result = self.stop_hook('Shipped\nDONE: delivered')
        output = json.loads(result.stdout)
        self.assertEqual(output['decision'], 'block')
        self.assertIn('LAT 交付檢查未通過', output['reason'])
        self.assertIn('item 1 (#5 impl): not closed: assigned', output['reason'])
        self.assertEqual(len(self.reports()), 1)
        warned = json.loads(self.stop_hook('DONE: delivered', stop_hook_active=True).stdout)
        self.assertNotIn('decision', warned)
        self.assertIn('item 1 (#5 impl)', warned['systemMessage'])
        self.assertIn('不再攔下', warned['systemMessage'])
        self.assertEqual(self.reports()[-1]['tag'], 'DONE')
        self.close_item(item)
        self.assert_silent(self.stop_hook('DONE: delivered'))

    def test_done_stop_holds_an_unreadable_ledger_and_skips_records_without_one(self):
        self.activate()
        self.ledger_path().write_text('not json\n')
        output = json.loads(self.stop_hook('DONE: delivered').stdout)
        self.assertEqual(output['decision'], 'block')
        self.assertIn('工作總表無法讀取', output['reason'])
        self.assertIn('repair --ledger', output['reason'])
        record = json.loads(self.record.read_text())
        del record['ledger_path']
        self.record.write_text(json.dumps(record))
        self.assert_silent(self.stop_hook('DONE: delivered'))

    def test_deactivate_refuses_unfinished_ledger_and_force_keeps_reason(self):
        self.activate()
        self.open_item('#9')
        refused = self.deactivate()
        self.assertEqual(refused.returncode, 1)
        self.assertIn('拒絕停用', refused.stderr)
        self.assertIn('item 1 (#9 impl): not closed: assigned', refused.stderr)
        self.assertIn('--force-unfinished', refused.stderr)
        self.assertEqual(json.loads(self.record.read_text())['status'], 'active')
        self.assertTrue((self.work / '.lat/watch' / f'{SESSION}.pid').exists())
        for extra in (('--force-unfinished',), ('--force-unfinished', '--reason', '  '),
                      ('--reason', 'why')):
            with self.subTest(extra=extra):
                self.assertEqual(self.deactivate(*extra).returncode, 1)
                self.assertEqual(json.loads(self.record.read_text())['status'], 'active')
        forced = self.deactivate('--force-unfinished', '--reason', 'user stopped the round')
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertIn('工作總表歷史', forced.stdout)
        ledger = json.loads(self.ledger_path().read_text())
        self.assertEqual({key: ledger['history'][-1][key] for key in ('action', 'by', 'reason')},
                         dict(action='force-unfinished', by='orch', reason='user stopped the round'))
        self.ledger('show')  # still sealed and readable
        record = json.loads(self.record.read_text())
        self.assertEqual(record['status'], 'ended')
        self.assertEqual(record['force_unfinished_saved_in'], 'ledger')
        self.assert_silent(self.stop_hook('DONE: stopped early'))
        final = self.reports()[-1]
        self.assertTrue(final['final'])
        self.assertEqual(final['force_unfinished_reason'], 'user stopped the round')
        self.assertEqual(final['force_unfinished_saved_in'], 'ledger')
        self.assertIn('item 1 (#9 impl)', final['force_unfinished_check'])

    def test_deactivate_passes_a_closed_ledger_without_force_fields(self):
        self.activate()
        self.close_item(self.open_item())
        result = self.deactivate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('force_unfinished_reason', json.loads(self.record.read_text()))
        self.assert_silent(self.stop_hook('DONE: delivered'))
        self.assertNotIn('force_unfinished_reason', self.reports()[-1])

    def test_deactivate_with_broken_ledger_repairs_first_and_forces_only_without_journal(self):
        self.activate()
        self.open_item()
        self.ledger_path().write_text('broken\n')
        for extra in ((), ('--force-unfinished', '--reason', 'gone')):
            with self.subTest(extra=extra):
                refused = self.deactivate(*extra)
                self.assertEqual(refused.returncode, 1)
                self.assertIn('repair --ledger', refused.stderr)
                self.assertIn('--from-journal', refused.stderr)
                self.assertEqual(json.loads(self.record.read_text())['status'], 'active')
        journal = self.ledger_path().with_name(self.ledger_path().name + '.journal.jsonl')
        journal.write_text('also broken\n')
        forced = self.deactivate('--force-unfinished', '--reason', 'ledger lost')
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertIn('session 紀錄', forced.stdout)
        self.assertEqual(self.ledger_path().read_text(), 'broken\n')
        record = json.loads(self.record.read_text())
        self.assertEqual((record['force_unfinished_reason'], record['force_unfinished_saved_in']),
                         ('ledger lost', 'session'))
        self.assert_silent(self.stop_hook('DONE: stopped'))
        final = self.reports()[-1]
        self.assertTrue(final['final'])
        self.assertEqual((final['force_unfinished_reason'], final['force_unfinished_saved_in']),
                         ('ledger lost', 'session'))
    def test_done_stop_and_deactivate_recheck_evidence_removed_after_closing(self):
        self.activate()
        item = self.open_item('#6')
        self.close_item(item)
        report = self.root / f'report-{item}.md'
        report.unlink()
        output = json.loads(self.stop_hook('DONE: delivered').stdout)
        self.assertEqual(output['decision'], 'block')
        self.assertIn(f'item 1 (#6 impl): file {report}: does not exist', output['reason'])
        refused = self.deactivate()
        self.assertEqual(refused.returncode, 1)
        self.assertIn(f'file {report}: does not exist', refused.stderr)
        self.assertEqual(json.loads(self.record.read_text())['status'], 'active')

    def test_hand_edited_ledger_asks_for_a_reseal_not_a_rebuild(self):
        self.activate()
        self.open_item()
        ledger = json.loads(self.ledger_path().read_text())
        ledger['items'][0]['ticket'] = '#edited'
        self.ledger_path().write_text(json.dumps(ledger))
        journal = self.ledger_path().with_name(self.ledger_path().name + '.journal.jsonl')
        journal.unlink()  # a reseal keeps the edit, so a lost journal does not allow force
        output = json.loads(self.stop_hook('DONE: delivered').stdout)
        self.assertIn('seal mismatch', output['reason'])
        self.assertIn(f'repair --ledger {self.ledger_path()} --reason', output['reason'])
        for extra in ((), ('--force-unfinished', '--reason', 'edited')):
            with self.subTest(extra=extra):
                refused = self.deactivate(*extra)
                self.assertEqual(refused.returncode, 1)
                self.assertIn(f'repair --ledger {self.ledger_path()} --reason', refused.stderr)
                self.assertNotIn('--from-journal`', refused.stderr)
                self.assertEqual(json.loads(self.record.read_text())['status'], 'active')

    def test_deleted_ledger_is_rebuilt_from_journal_before_deactivate(self):
        self.activate()
        self.open_item()
        self.ledger_path().unlink()
        refused = self.deactivate('--force-unfinished', '--reason', 'gone')
        self.assertEqual(refused.returncode, 1)
        self.assertIn('ledger missing', refused.stderr)
        self.assertIn('repair --ledger', refused.stderr)
        self.assertIn('--from-journal --reason', refused.stderr)
        self.ledger_path().with_name(self.ledger_path().name + '.journal.jsonl').unlink()
        self.assertEqual(self.deactivate().returncode, 1)
        forced = self.deactivate('--force-unfinished', '--reason', 'ledger and journal lost')
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertEqual(json.loads(self.record.read_text())['force_unfinished_saved_in'], 'session')
        self.assertFalse(self.ledger_path().exists())
    def test_recovery_ledger_error_stays_within_the_limit_and_keeps_the_hint(self):
        spec = importlib.util.spec_from_file_location('lat_session_limit', SCRIPT)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        failure = SimpleNamespace(returncode=1, stdout='',
                                  stderr='x' * 20_000 + ' rebuild it with repair --from-journal')
        with patch.object(helper, 'ledger_cli', return_value=failure):
            context = helper.ledger_context(
                dict(client='claude', ledger_path=str(self.ledger_path())), 'p' * 9_000)
        self.assertLessEqual(len(context), 9_800)
        self.assertIn('repair --from-journal', context)
        self.assertTrue(context.endswith('never recreate it by hand.'))


class InlineReferenceBudgetTests(unittest.TestCase):
    """The references lat-session inlines into the Claude recovery prompt, by its own list."""
    # Same budget as test_recovery_inlines_dispatch_references_for_claude_only: path fields
    # stripped, under 9,000 of the 10,000 characters Claude Code shows in full.
    BUDGET = 9_000

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('lat_session_budget', SCRIPT)
        cls.session = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.session)

    def sized(self, skill_dir):
        text = self.session.pointer('', dict(client='claude', skill_dir=str(skill_dir)))
        for name in self.session.INLINE_REFERENCES:
            reference = Path(skill_dir) / name
            self.assertIn(f'===== {reference} =====\n{reference.read_text()}', text)
            text = text.replace(f'===== {reference} =====\n', '===== =====\n', 1)
        return len(text)

    def test_inlined_references_fit_the_budget(self):
        size = self.sized(SKILL)
        self.assertLess(size, self.BUDGET, f'inlined references total {size} characters; '
                        'shorten them or move detail out of INLINE_REFERENCES')

    def test_the_budget_counts_every_inlined_reference(self):
        room = self.BUDGET - self.sized(SKILL)
        for grown in self.session.INLINE_REFERENCES:
            with self.subTest(reference=grown), tempfile.TemporaryDirectory() as tmp:
                for name in self.session.INLINE_REFERENCES:
                    target = Path(tmp) / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    text = (SKILL / name).read_text()
                    target.write_text(text + 'x' * room if name == grown else text)
                self.assertGreaterEqual(self.sized(tmp), self.BUDGET)

    def test_the_affected_test_map_sends_each_inlined_reference_here(self):
        root = SKILL.parents[2]
        gate = SKILL.parent / 'three-tier-testing/scripts/suite-gate.py'
        if not (root / '.suite-gate.json').is_file() or not gate.is_file():
            self.skipTest('not run from the LoopAgentTeams repo')
        spec = importlib.util.spec_from_file_location('suite_gate_map', gate)
        suite_gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(suite_gate)
        amap = suite_gate.read_map(suite_gate.load_registry(root))
        here = str(Path(__file__).resolve().relative_to(root))
        for name in self.session.INLINE_REFERENCES:
            path = str((SKILL / name).relative_to(root))
            with self.subTest(reference=path):
                selected, fallback = suite_gate.select_tests(root, [path], amap)
                self.assertEqual(fallback, [])
                self.assertIn(here, selected)

if __name__ == '__main__':
    unittest.main()
