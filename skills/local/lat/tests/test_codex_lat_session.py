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

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/codex-lat-session.py'
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

    def cli(self, *args, payload=None, session=SESSION):
        env = dict(os.environ, CODEX_THREAD_ID=session)
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

    def test_lat_position_survives_hcom_re_setup_and_migrates_old_install(self):
        home = self.root / 'config'
        home.mkdir()
        path = home / 'hooks.json'
        herdr = {'hooks': [{'type': 'command', 'command': 'bash herdr.sh session'}]}
        hcom = {'matcher': 'startup|resume|clear|fork', 'hooks': [
            {'type': 'command', 'command': 'hcom codex-sessionstart'}]}
        original = {'hooks': {'SessionStart': [herdr, hcom]}}
        path.write_text(json.dumps(original))
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        config = json.loads(path.read_text())
        groups = config['hooks']['SessionStart']
        self.assertEqual(groups[0], herdr)
        self.assertEqual(groups[1].get('name'), 'lat-codex-recovery')
        self.assertEqual(groups[2], hcom)
        lat = groups[1]
        # HCOM re-setup removes its empty group and appends its replacement.
        groups.remove(hcom)
        groups.append(hcom)
        self.assertEqual(groups[1], lat)
        # An old install appended LAT after HCOM; reinstall migrates it.
        groups[:] = [herdr, hcom, lat]
        path.write_text(json.dumps(config))
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        self.assertEqual(json.loads(path.read_text())['hooks']['SessionStart'],
                         [herdr, lat, hcom])
        before = path.read_bytes()
        self.assertEqual(self.cli('install', '--codex-home', home).returncode, 0)
        self.assertEqual(path.read_bytes(), before)

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
        args = argparse.Namespace(codex_home=home, action='install', preview=False)
        with patch.object(helper, 'current_bytes', side_effect=competing_read):
            with self.assertRaisesRegex(ValueError, 'Concurrent'):
                helper.configure(args)
        self.assertEqual(json.loads(path.read_text()), {'external': True})
        self.assertEqual(list(home.iterdir()), [path])


if __name__ == '__main__':
    unittest.main()
