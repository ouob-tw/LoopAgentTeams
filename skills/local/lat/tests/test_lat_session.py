"""CLI contract tests; only disposable local files, no Codex/model calls."""
import json
import argparse
import importlib.util
from unittest.mock import patch
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-session.py'
SKILL = SCRIPT.parent.parent
SESSION = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


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
        self.record = self.work / '.lat/sessions' / f'{SESSION}.json'

    def cli(self, *args, payload=None, session=SESSION, extra_env=None):
        env = dict(os.environ, CODEX_THREAD_ID=session, CLAUDE_CODE_SESSION_ID='')
        for variable in ('HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID',
                         'HERDR_PLUGIN_CONFIG_DIR', 'HCOM_INSTANCE_NAME'):
            env.pop(variable, None)
        env['HERDR_PLUGIN_CONFIG_DIR'] = str(self.root / 'plugin-config')
        env.update(extra_env or {})
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              input=json.dumps(payload) if payload is not None else '',
                              text=True, capture_output=True, env=env, cwd=self.work)

    def activate(self, session=SESSION):
        result = self.cli('activate', '--workspace', self.work,
                          '--progress', self.progress, '--decisions', self.decisions,
                          session=session)
        self.assertEqual(result.returncode, 0, result.stderr)

    def hook(self, **overrides):
        payload = dict(hook_event_name='SessionStart', source='compact',
                       cwd=str(self.work), session_id=SESSION)
        payload.update(overrides)
        return self.cli('hook', payload=payload, session=OTHER)

    def panel_env(self, herdr_body=None):
        binary = self.root / 'bin'
        binary.mkdir(exist_ok=True)
        herdr = binary / 'herdr'
        herdr.write_text(herdr_body or (
            '#!/bin/sh\n'
            'test "$*" = "plugin list --plugin lat.panel --json" || exit 91\n'
            'printf \'%s\\n\' \'{"result":{"plugins":[{"plugin_id":"lat.panel","enabled":true}]}}\'\n'
        ))
        herdr.chmod(0o755)
        return {
            'PATH': f'{binary}:{os.environ["PATH"]}',
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
        questions = self.work / '.lat/questions-nifo-bind-lezo.md'
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
            '--decisions', self.decisions, extra_env=env,
        )

        self.assertNotEqual(result.returncode, 0)
        remedy = (
            f'uv run --no-project python {SCRIPT} activate --client codex '
            f'--workspace {self.work} --progress {self.progress} '
            f'--decisions {self.decisions} --hcom-name \'<主控-HCOM-名稱>\''
        )
        self.assertIn(remedy, result.stderr)
        self.assertFalse(self.record.exists())
        self.assertFalse((self.root / 'plugin-config/bindings.json').exists())

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
            extra_env={'PATH': str(binary), 'HERDR_WORKSPACE_ID': 'herdr-workspace'},
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
            f'uv run --no-project python {SKILL / "herdr-panel/lat_panel.py"} bind '
            f'--hcom-name nifo-bind-lezo --client codex --session-id {SESSION} '
            f'--workspace {self.work} --herdr-workspace herdr-workspace '
            f'--herdr-tab herdr-tab --herdr-pane \'\''
        )
        self.assertIn(manual, result.stderr)

    def test_deactivate_unbinds_own_session_and_is_idempotent(self):
        env = self.panel_env()
        activated = self.cli(
            'activate', '--workspace', self.work, '--progress', self.progress,
            '--decisions', self.decisions, '--hcom-name', 'nifo-bind-lezo',
            extra_env=env,
        )
        self.assertEqual(activated.returncode, 0, activated.stderr)
        deactivate_args = (
            'deactivate', '--workspace', self.work, '--status', 'completed',
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

    def test_activate_then_compact_and_resume_from_subdirectory(self):
        self.activate()
        record = json.loads(self.record.read_text())
        self.assertEqual(record, dict(client='codex', session_id=SESSION,
                         role='orchestrator', workspace=str(self.work), status='active',
                         skill_dir=str(SKILL), progress_path=str(self.progress),
                         decisions_path=str(self.decisions)))
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
                             ('status', 'completed'), ('status', 'cancelled'),
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
        for status in ('completed', 'cancelled'):
            with self.subTest(status=status):
                if self.record.exists():
                    self.record.unlink()
                self.activate()
                result = self.cli('deactivate', '--workspace', self.work,
                                  '--status', status, '--session-id', SESSION,
                                  session=OTHER)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(self.record.read_text())['status'], status)
                self.assert_silent(self.hook())
                self.assert_silent(self.hook(source='resume'))

    def test_activation_requires_environment_id_and_does_not_reset_record(self):
        result = self.cli('activate', '--workspace', self.work, '--progress', self.progress,
                          '--decisions', self.decisions, session='')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.record.exists())
        self.activate()
        record = json.loads(self.record.read_text())
        record['status'] = 'completed'
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
        self.assertEqual(merged['hooks']['Stop'], original['hooks']['Stop'])
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
        env = dict(os.environ, CODEX_THREAD_ID='', CLAUDE_CODE_SESSION_ID=SESSION)
        for variable in ('HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID',
                         'HCOM_INSTANCE_NAME'):
            env.pop(variable, None)
        env['HERDR_PLUGIN_CONFIG_DIR'] = str(self.root / 'plugin-config')
        result = subprocess.run([sys.executable, str(SCRIPT), 'activate', '--client', 'claude',
                                 '--workspace', self.work, '--progress', self.progress,
                                 '--decisions', self.decisions],
                                text=True, capture_output=True, env=env, cwd=self.work)
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
        result = self.cli('deactivate', '--client', 'claude', '--workspace', self.work,
                          '--status', 'completed', '--session-id', SESSION, session=OTHER)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_silent(self.cli('hook', '--client', 'claude', payload=payload))

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
        self.assertEqual(merged['hooks']['Stop'], original['hooks']['Stop'])
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


if __name__ == '__main__':
    unittest.main()
