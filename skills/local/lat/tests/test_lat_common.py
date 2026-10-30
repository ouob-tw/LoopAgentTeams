"""Shared helper contracts; CLI/proc dependencies are fakes, files are disposable."""
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SKILL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SKILL / 'scripts'))
import _lat_common as common


class AtomicWriteTests(unittest.TestCase):
    def test_concurrent_change_is_kept_and_temporary_file_is_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            path.write_bytes(b'old')
            real_fsync = os.fsync

            def modify_after_flush(fd):
                real_fsync(fd)
                path.write_bytes(b'concurrent')

            with patch.object(common.os, 'fsync', side_effect=modify_after_flush):
                with self.assertRaisesRegex(ValueError, 'Concurrent change detected'):
                    common.write_json_atomic(path, {'new': True}, expected=b'old')
            self.assertEqual(path.read_bytes(), b'concurrent')
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_creation_mode_preservation_and_directory_fsync(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            types = []
            real_fsync = os.fsync

            def fsync(fd):
                types.append(stat.S_IFMT(os.fstat(fd).st_mode))
                real_fsync(fd)

            with patch.object(common.os, 'fsync', side_effect=fsync):
                result = common.write_json_atomic(path, {'文字': 1}, expected=None)
            self.assertEqual(result, path.read_bytes())
            self.assertEqual(json.loads(result), {'文字': 1})
            self.assertEqual(types, [stat.S_IFREG, stat.S_IFDIR])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            path.chmod(0o640)
            common.write_json_atomic(path, {}, expected=result)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            common.write_text_atomic(path, 'Markdown\n', mode=0o600)
            self.assertEqual(path.read_text(), 'Markdown\n')
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_missing_expected_file_conflicts_with_existing_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'state.json'
            path.write_bytes(b'existing')
            with self.assertRaises(ValueError):
                common.write_json_atomic(path, {}, expected=None)
            self.assertEqual(list(Path(directory).iterdir()), [path])


class CliTests(unittest.TestCase):
    def test_timeout_is_value_error_with_command_and_limit(self):
        with patch.object(common.subprocess, 'run', side_effect=subprocess.TimeoutExpired('herdr', 5)):
            with self.assertRaisesRegex(ValueError, 'herdr tab timed out after 5 seconds'):
                common.run_cli(['herdr', 'tab', 'get'], timeout=5)

    def test_failures_use_stderr_stdout_or_exit_and_preserve_context(self):
        for stderr, stdout, detail in [('bad', 'out', 'bad'), ('', 'out', 'out'), ('', '', 'exit 2')]:
            with self.subTest(detail=detail), patch.object(
                common.subprocess, 'run', return_value=subprocess.CompletedProcess([], 2, stdout, stderr)
            ) as run:
                with self.assertRaisesRegex(ValueError, f'lookup failed: {detail}'):
                    common.run_cli(['herdr', 'tab'], timeout=10, failure='lookup failed', env={'A': 'B'})
                self.assertEqual(run.call_args.kwargs['timeout'], 10)
                self.assertEqual(run.call_args.kwargs['env'], {'A': 'B'})
        with patch.object(common.subprocess, 'run', side_effect=FileNotFoundError('absent')):
            with self.assertRaises(ValueError):
                common.run_cli(['herdr'], timeout=5)


class NameTests(unittest.TestCase):
    """The write rule of #394 and the read rule for older base names."""

    def test_full_name_rule(self):
        agents = {'lead-orch', 'a-vega', 'b-vega', 'puvi'}
        for name, full in (('orch', 'lead-orch'), ('lead-orch', 'lead-orch'), ('puvi', 'puvi')):
            self.assertEqual(common.full_hcom_name(agents, name, '--by'), full)
        for name, problem in (('vega', 'Ambiguous HCOM agent vega: a-vega, b-vega'),
                              ('ghost', 'Unknown HCOM agent: ghost')):
            with self.assertRaises(ValueError) as caught:
                common.full_hcom_name(agents, name, '--by')
            self.assertIn(f'--by: {problem}', str(caught.exception))
            self.assertIn('HCOM lists: a-vega, b-vega, lead-orch, puvi; nothing written',
                          str(caught.exception))

    def test_stored_base_name_matches_the_full_name(self):
        self.assertTrue(common.same_controller('orch', 'lead-orch'))
        self.assertTrue(common.same_controller('lead-orch', 'lead-orch'))
        self.assertFalse(common.same_controller('lead-orch', 'orch'))
        self.assertFalse(common.same_controller('rch', 'lead-orch'))


class WatcherTests(unittest.TestCase):
    expected = ('run', '--workspace', '/work', '--orchestrator', 'owner')

    def matches(self, state, command):
        # /proc/stat field 22 is starttime; parentheses may occur in the process name.
        fields = [state] + ['0'] * 18 + ['123']
        with patch.object(Path, 'read_text', return_value='9 (watcher (worker)) ' + ' '.join(fields)), \
             patch.object(Path, 'read_bytes', return_value=b'\0'.join(arg.encode() for arg in command)):
            return common.watcher_process_matches(9, self.expected)

    def test_zombie_is_not_a_watcher(self):
        self.assertFalse(self.matches('Z', ['/skill/lat-watch.py', *self.expected]))

    def test_reused_pid_or_other_controller_is_not_a_watcher(self):
        self.assertFalse(self.matches('S', ['sleep', '30']))
        self.assertFalse(self.matches('S', ['/skill/lat-watch.py', *self.expected[:-1], 'another']))
        self.assertFalse(self.matches('S', ['/skill/lat-watch.py', *self.expected[:-1]]))

    def test_exact_argument_slice_with_launcher_and_trailing_flags(self):
        self.assertTrue(self.matches('S', ['uv', 'run', 'python', '/skill/lat-watch.py', *self.expected]))
        self.assertTrue(self.matches('S', ['/skill/lat-watch.py', *self.expected, '--once']))

    def test_missing_or_unreadable_process_is_not_a_watcher(self):
        with patch.object(Path, 'read_text', side_effect=FileNotFoundError):
            self.assertFalse(common.watcher_process_matches(9, self.expected))
        with patch.object(Path, 'read_text', return_value='malformed'):
            self.assertFalse(common.watcher_process_matches(9, self.expected))


class DirectoryTests(unittest.TestCase):
    def test_report_directory_override_and_relative_xdg_fallback(self):
        self.assertEqual(common.reports_directory({'LAT_REPORTS_DIR': '/reports'}), Path('/reports'))
        self.assertEqual(common.reports_directory({'XDG_STATE_HOME': '/state'}), Path('/state/lat/reports'))
        self.assertEqual(common.reports_directory({'XDG_STATE_HOME': 'relative'}),
                         Path.home() / '.local/state/lat/reports')
        with self.assertRaisesRegex(ValueError, 'must be absolute'):
            common.reports_directory({'LAT_REPORTS_DIR': 'relative'})

    def test_plugin_overrides_discovery_and_fallback(self):
        with patch.object(common, 'run_cli', return_value='/discovered\n') as run:
            self.assertEqual(common.plugin_directory('config', {}), Path('/discovered'))
            self.assertEqual(run.call_args.kwargs['timeout'], 10)
            run.reset_mock()
            self.assertEqual(common.plugin_directory('config', {'HERDR_PLUGIN_CONFIG_DIR': '/override'}),
                             Path('/override'))
            run.assert_not_called()
        with patch.object(common, 'run_cli', side_effect=ValueError('unavailable')):
            self.assertEqual(common.plugin_directory('config', {'XDG_CONFIG_HOME': '/config'}),
                             Path('/config/herdr/plugins/config/lat.panel'))
        self.assertEqual(common.plugin_directory('state', {'XDG_STATE_HOME': '/state'}),
                         Path('/state/herdr/plugins/lat.panel'))


class InstalledLayoutTests(unittest.TestCase):
    def test_all_entry_points_import_from_copied_skill_only(self):
        with tempfile.TemporaryDirectory() as directory:
            installed = Path(directory) / 'lat'
            shutil.copytree(SKILL, installed, ignore=shutil.ignore_patterns('__pycache__', '.git'))
            env = dict(os.environ)
            env.pop('PYTHONPATH', None)
            for relative in ('scripts/lat-watch.py', 'scripts/lat-session.py', 'herdr-panel/lat_panel.py'):
                with self.subTest(entry=relative):
                    result = subprocess.run([sys.executable, str(installed / relative), '--help'],
                                            cwd=directory, env=env, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('usage:', result.stdout)


class HcomPauseTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        environment = patch.dict(os.environ, LAT_HCOM_PAUSED_DIR=str(self.root / 'paused'),
                                 XDG_STATE_HOME=str(self.root / 'state'))
        environment.start()
        self.addCleanup(environment.stop)
        self.paused = common.hcom_paused_dir()
        self.paused.mkdir()
        self.record = dict(session_id='session-1', hcom_name='tag-full-name', client='codex',
                           pane=None, paused_at='2026-10-23T00:00:00Z')

    def test_directory_precedence_and_relative_xdg_fallback(self):
        self.assertEqual(common.hcom_paused_dir(), self.paused)
        with patch.dict(os.environ, LAT_HCOM_PAUSED_DIR=''):
            self.assertEqual(common.hcom_paused_dir(), self.root / 'state/lat/hcom-paused')
            with patch.dict(os.environ, XDG_STATE_HOME='relative'), \
                    patch.object(Path, 'home', return_value=self.root):
                self.assertEqual(common.hcom_paused_dir(), self.root / '.local/state/lat/hcom-paused')

    def test_invalid_records_warn_once_and_valid_record_survives(self):
        good = self.paused / 'session-1.json'
        good.write_text(json.dumps(self.record))
        (self.paused / 'broken.json').write_bytes(b'\xff')
        bad = self.paused / 'bad.json'
        bad.write_text('{}')
        warnings = []
        for _ in range(2):
            self.assertEqual(common.read_hcom_pauses(lambda *args: warnings.append(args)),
                             {'tag-full-name': self.record})
        self.assertEqual(len(warnings), 2)
        bad.write_text(json.dumps({**self.record, 'session_id': 'bad', 'pane': 'pane-1'}))
        self.assertEqual(common.read_hcom_pauses()['tag-full-name']['session_id'], 'session-1')
        good.unlink()
        bad.unlink()
        self.assertEqual(common.read_hcom_pauses(lambda *args: warnings.append(args)), {})

    def test_incomplete_and_invalid_fields_are_ignored(self):
        path = self.paused / 'session-1.json'
        mutations = [{key: value for key, value in self.record.items() if key != missing}
                     for missing in self.record]
        mutations += [{**self.record, **change} for change in (
            {'pane': 42}, {'session_id': 'another'}, {'paused_at': 'yesterday'},
            {'paused_at': '2026-10-23T00:00:00'}, {'paused_at': '2026-10-23T00:00:00+08:00'})]
        for record in mutations:
            with self.subTest(record=record):
                path.write_text(json.dumps(record))
                self.assertEqual(common.read_hcom_pauses(lambda *_: None), {})


if __name__ == '__main__':
    unittest.main()
