"""Split-module import boundaries, installed layout and frozen CLI compatibility.

The baseline is the ticket's pinned pre-refactor commit. Both versions use the
same disposable files, empty provider state and no external executable paths.
"""
import ast
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SKILL = Path(__file__).resolve().parents[1]
PANEL = SKILL / 'herdr-panel'
BASE = '12d0149'
SOURCE = 'skills/local/lat/herdr-panel/lat_panel.py'
TEXT = '## Choose?\nQ1 · r1 · 待答\n\nA. Yes\nB. Later\n\n答覆：\n\n- [ ] 送出\n'


class ModuleTests(unittest.TestCase):
    def run_code(self, code, env=None, cwd=None):
        result = subprocess.run([sys.executable, '-c', code], capture_output=True,
                                text=True, env=env, cwd=cwd)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def test_transcript_import_has_no_panel_dependencies(self):
        self.run_code(f'''
import sys
sys.path.insert(0, {str(PANEL)!r})
import transcript
assert not {{'questions', 'bindings', 'board', 'lat_panel'}} & sys.modules.keys()
assert transcript.transcript_path
''')

    def test_stop_activation_without_payload_path_only_loads_transcript(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            work = root / 'work'
            (work / '.git').mkdir(parents=True)
            codex = root / 'codex'
            session = 'test-session'
            path = codex / 'sessions/2026/10/21' / f'rollout-test-{session}.jsonl'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'type': 'response_item', 'payload': {
                'type': 'message', 'role': 'user', 'content': [
                    {'type': 'input_text', 'text': 'ordinary message'}]}}) + '\n')
            env = dict(os.environ, CODEX_HOME=str(codex), LAT_REPORTS_DIR=str(root / 'reports'))
            env.pop('HCOM_LAUNCHED_BY', None)
            self.run_code(f'''
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location('lat_session', {str(SKILL / 'scripts/lat-session.py')!r})
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
sys.stdin = io.StringIO(json.dumps({{'session_id': {session!r}, 'cwd': {str(work)!r},
    'hook_event_name': 'Stop', 'last_assistant_message': 'done'}}))
sys.argv = ['lat-session.py', 'hook']
helper.main()
assert 'transcript' in sys.modules
assert not {{'questions', 'bindings', 'board', 'lat_panel'}} & sys.modules.keys()
''', env=env, cwd=work)

    def test_installed_skill_help_and_panel_import(self):
        with tempfile.TemporaryDirectory() as temp:
            installed = Path(temp) / 'lat'
            shutil.copytree(SKILL, installed, ignore=shutil.ignore_patterns('__pycache__'))
            result = subprocess.run([sys.executable, str(installed / 'herdr-panel/lat_panel.py'),
                                     '--help'], capture_output=True, cwd=temp)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.run_code(f"import sys; sys.path.insert(0, {str(installed / 'herdr-panel')!r}); import panel", cwd=temp)

    def test_all_22_parser_commands_match_pre_split_bytes_and_exit_codes(self):
        baseline = subprocess.run(['git', 'show', f'{BASE}:{SOURCE}'], cwd=SKILL,
                                  capture_output=True, check=True).stdout
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            old = root / 'old/lat'
            shutil.copytree(SKILL, old, ignore=shutil.ignore_patterns('__pycache__'))
            (old / 'herdr-panel/lat_panel.py').write_bytes(baseline)
            state = root / 'state'
            questions = state / 'questions.md'
            decisions = state / 'decisions'
            section = state / 'section.md'
            journal = state / 'panel-journal.jsonl'
            config = state / 'config'
            env = dict(os.environ, PATH='', HOME=str(state / 'home'),
                       HERDR_PLUGIN_CONFIG_DIR=str(config),
                       HERDR_PLUGIN_STATE_DIR=str(state / 'plugin-state'),
                       HCOM_DIR=str(state / 'hcom'), CODEX_HOME=str(state / 'codex'),
                       CLAUDE_CONFIG_DIR=str(state / 'claude'))
            for key in ('HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_PANE_ID'):
                env.pop(key, None)
            # Includes the two group parsers, whose help is part of the CLI.
            q = ['--questions', str(questions)]
            d = ['--decisions', str(decisions)]
            cases = [
                ['question', '--help'], ['board', '--help'],
                ['question', 'upsert', *q, *d, '--id', 'Q1', '--file', str(section)],
                ['question', 'provenance', *q, '--journal', str(journal), '--id', 'Q1'],
                ['question', 'section-hash', *q, '--id', 'Q1'],
                ['question', 'set-status', *q, '--id', 'Q1', '--revision', '1',
                 '--status', 'recorded', '--expected-section-sha256', 'stale'],
                ['question', 'archive-recorded', *q, '--older-than', '300'],
                ['question', 'cleanup', *q, *d],
                ['question', 'resolve-help', *q, *d, '--id', 'Q1', '--evidence', 'checked', '--location', 'test'],
                ['question', 'withdraw', *q, *d, '--id', 'Q1', '--reason', 'obsolete', '--source', 'test'],
                ['question', 'check-pending', *q, *d],
                ['bind', '--hcom-name', 'ctl', '--client', 'codex', '--session-id', 'session',
                 '--workspace', str(state), '--herdr-workspace', 'w', '--herdr-tab', 't', '--herdr-pane', 'p'],
                ['unbind', '--session-id', 'session'], ['resolve', '--session-id', 'session'],
                ['board', 'list'], ['board', 'questions', *q], ['board', 'answered', *q],
                ['board', 'answer', *q, '--id', 'Q1', '--revision', '1',
                 '--expected-section-sha256', 'stale', '--select', '1'],
                ['board', 'notify', *q],
                ['board', 'transcript', '--client', 'codex', '--session-id', 'session'],
                ['board', 'launch-args', '--session-id', 'session'],
                ['board', 'prune-reports', '--reports-dir', str(state / 'reports'),
                 '--now', '2026-10-21T00:00:00+00:00', '--session-id', 'session'],
            ]
            # Pin coverage to the actual parser inventory, so new commands cannot be missed.
            expected = [n.args[0].value for n in ast.walk(ast.parse(baseline))
                        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                        and n.func.attr == 'add_parser']
            actual = [c[1] if c[0] in ('question', 'board') and c[1] != '--help' else c[0]
                      for c in cases]
            self.assertEqual(sorted(actual), sorted(expected))
            self.assertEqual(len(cases), 22)
            for args in cases:
                results = []
                for script in (old / 'herdr-panel/lat_panel.py', PANEL / 'lat_panel.py'):
                    shutil.rmtree(state, ignore_errors=True)
                    config.mkdir(parents=True)
                    decisions.mkdir()
                    (config / 'bindings.json').write_text('{}')
                    questions.write_text(TEXT)
                    section.write_text('## Choose?\n\nA. Yes\nB. Later\n')
                    (decisions / 'Q1.md').write_text('# Choose?\n- version: r1\n- status: pending\n- kind: help\n')
                    results.append(subprocess.run([sys.executable, str(script), *args],
                                                  env=env, cwd=state, capture_output=True))
                if args[0] == 'bind':
                    # New bindings moved from the root .lat to .lat/questions/ after the split.
                    results[0].stdout = results[0].stdout.replace(b'questions-ctl.md', b'questions/ctl.md')
                with self.subTest(command=args[:2]):
                    self.assertEqual((results[0].returncode, results[0].stdout),
                                     (results[1].returncode, results[1].stdout), results[1].stderr)
                    self.assertNotIn(b'Traceback', results[1].stderr)
