import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/close-self.py'

# A fake `herdr`: answers `pane get` / `tab get` from a JSON state file and logs every call.
FAKE = '''#!/usr/bin/env python3
import json, os, sys
state = json.load(open(os.environ['FAKE_STATE']))
with open(os.environ['FAKE_LOG'], 'a') as log:
    log.write(' '.join(sys.argv[1:]) + '\\n')
key = ' '.join(sys.argv[1:3])
if sys.argv[2] == 'close':
    sys.exit(0)
reply = state.get(key)
if reply is None:
    print('{"error":{"code":"not_found","message":"no such object"}}')
    sys.exit(1)
if isinstance(reply, str):
    print(reply)
    sys.exit(state.get('exit', 0))
print(json.dumps({'id': 'x', 'result': reply}))
'''


class CloseSelfTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        binary = self.dir / 'bin'
        binary.mkdir()
        fake = binary / 'herdr'
        fake.write_text(FAKE)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.state_file = self.dir / 'state.json'
        self.log = self.dir / 'log'
        self.log.touch()
        self.bin = str(binary)

    def run_tool(self, state, env=None):
        self.state_file.write_text(json.dumps(state))
        environ = {k: v for k, v in os.environ.items() if not k.startswith('HERDR_')}
        environ.update(PATH=self.bin + os.pathsep + environ['PATH'], FAKE_STATE=str(self.state_file),
                       FAKE_LOG=str(self.log), HERDR_PANE_ID='w:p1', HERDR_TAB_ID='w:stale')
        environ.update(env or {})
        for key in [k for k, v in environ.items() if v is None]:
            del environ[key]
        return subprocess.run([sys.executable, str(SCRIPT)], text=True, capture_output=True, env=environ)

    def calls(self):
        return self.log.read_text().splitlines()

    @staticmethod
    def state(tab_id='w:t2', count=1):
        return {'pane get': {'pane': {'pane_id': 'w:p1', 'tab_id': tab_id}},
                'tab get': {'tab': {'tab_id': tab_id, 'pane_count': count}}}

    def test_moved_pane_closes_current_tab_not_env_tab(self):
        done = self.run_tool(self.state('w:t2', 1))
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertEqual(self.calls(), ['pane get w:p1', 'tab get w:t2', 'tab close w:t2'])
        self.assertNotIn('stale', ' '.join(self.calls()))
        self.assertIn('w:t2', done.stdout)
        self.assertEqual(len(done.stdout.splitlines()), 1)

    def test_other_panes_close_only_own_pane(self):
        done = self.run_tool(self.state('w:t2', 3))
        self.assertEqual(done.returncode, 0, done.stdout)
        self.assertEqual(self.calls(), ['pane get w:p1', 'tab get w:t2', 'pane close w:p1'])
        self.assertEqual(len(done.stdout.splitlines()), 1)

    def test_missing_pane_id_closes_nothing(self):
        done = self.run_tool(self.state(), env={'HERDR_PANE_ID': None})
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.calls(), [])
        self.assertIn('HERDR_PANE_ID', done.stdout)
        self.assertEqual(len(done.stdout.splitlines()), 1)

    def test_pane_lookup_failure_closes_nothing(self):
        done = self.run_tool({})
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.calls(), ['pane get w:p1'])
        self.assertEqual(len(done.stdout.splitlines()), 1)

    def test_tab_lookup_failure_closes_nothing(self):
        state = self.state()
        del state['tab get']
        done = self.run_tool(state)
        self.assertEqual(done.returncode, 1)
        self.assertEqual(self.calls(), ['pane get w:p1', 'tab get w:t2'])

    def test_unreadable_answers_close_nothing(self):
        for state in ({'pane get': 'not json'},
                      {'pane get': {'pane': {'pane_id': 'w:p1'}}},
                      {**self.state(), 'tab get': {'tab': {'pane_count': 'many'}}},
                      {**self.state(), 'tab get': {'tab': {'pane_count': 0}}}):
            with self.subTest(state=state):
                self.log.write_text('')
                done = self.run_tool(state)
                self.assertEqual(done.returncode, 1)
                self.assertFalse([c for c in self.calls() if ' close ' in c])

    def test_missing_herdr_command_closes_nothing(self):
        self.state_file.write_text('{}')
        environ = dict(os.environ, PATH=str(self.dir), HERDR_PANE_ID='w:p1')
        done = subprocess.run([sys.executable, str(SCRIPT)], text=True, capture_output=True, env=environ)
        self.assertEqual(done.returncode, 1)
        self.assertIn('herdr', done.stdout)

    def test_arguments_are_a_usage_error(self):
        done = subprocess.run([sys.executable, str(SCRIPT), 'x'], text=True, capture_output=True)
        self.assertEqual(done.returncode, 2)


if __name__ == '__main__':
    unittest.main()
