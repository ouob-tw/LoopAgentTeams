import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from test_spawn_watch import FakeHerdr, agent_row, fake_process

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/empty-panes.py'
HCOM = {'HCOM_INSTANCE_NAME': 'kilo', 'HCOM_TOOL': 'claude'}


def load():
    spec = importlib.util.spec_from_file_location('empty_panes', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class EmptyPanesTests(unittest.TestCase):
    """Fake herdr, hcom list and /proc. Panes: p1 hcom leftover, p2 user shell in a deleted
    folder, p3 user shell in an existing folder, p4 the caller's own pane (an idle hcom
    leftover too), p5 a pane hcom list records for a live agent."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cli = load()
        self.watch = self.cli.watch
        self.watch.PROC = Path(self.tmp.name)
        self.line_modes = {}
        self.watch.line_mode = lambda pid: self.line_modes.get(int(pid), False)
        self.herdr = self.watch.herdr = FakeHerdr(
            panes={f'w1:p{n}': f'w1:t{n}' for n in range(1, 6)},
            cwds={'w1:p2': '/ws/.worktrees/old (deleted)', 'w1:p3': '/ws'})
        self.rows = [agent_row('mona', 'w1:p5')]
        self.watch.hcom = lambda *args, timeout=30: (
            (0, json.dumps(self.rows)) if self.rows is not None else (1, 'hcom down'))
        patcher = mock.patch.dict(os.environ, {'HERDR_PANE_ID': 'w1:p4'})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.process(501, 'w1:p1', **HCOM)
        self.process(502, 'w1:p2', cwd='/ws/.worktrees/old (deleted)')
        self.process(503, 'w1:p3', cwd='/ws')
        self.process(504, 'w1:p4', HCOM_INSTANCE_NAME='zero', HCOM_TOOL='codex')
        self.process(505, 'w1:p5', HCOM_INSTANCE_NAME='mona', HCOM_TOOL='claude')

    def process(self, pid, pane, **options):
        fake_process(self.tmp.name, self.herdr, pid, HERDR_PANE_ID=pane, **options)

    def run_cli(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = self.cli.main(list(args))
        return code, [line.split('\t') for line in out.getvalue().splitlines()]

    def closes(self):
        return [call[2] for call in self.herdr.calls if call[:2] == ('pane', 'close')]

    def test_lists_only_the_two_kinds_and_never_the_callers_or_a_recorded_pane(self):
        code, lines = self.run_cli()
        self.assertEqual(code, 0)
        self.assertEqual(lines, [['w1:p1', 'hcom', '/home/u', 'kilo', 'empty'],
                                 ['w1:p2', 'deleted', '/ws/.worktrees/old (deleted)', '-',
                                  'empty']])
        self.assertEqual(self.closes(), [])

    def test_close_closes_the_empty_ones_only(self):
        code, lines = self.run_cli('--close')
        self.assertEqual([line[-1] for line in lines], ['closed', 'closed'])
        self.assertEqual(self.closes(), ['w1:p1', 'w1:p2'])
        self.assertIn('w1:p3', self.herdr.panes)
        self.assertIn('w1:p4', self.herdr.panes)
        self.assertIn('w1:p5', self.herdr.panes)

    def test_pane_where_something_runs_is_listed_as_kept_and_not_closed(self):
        self.herdr.processes = {}
        self.process(601, 'w1:p1', argv=('bash', '/tmp/work.sh'), **HCOM)
        self.process(602, 'w1:p2', cwd='/ws/.worktrees/old (deleted)')
        self.line_modes[602] = True  # e.g. waiting in `read -t`
        code, lines = self.run_cli('--close')
        self.assertEqual(lines, [
            ['w1:p1', 'hcom', '/home/u', 'kilo', 'kept: `bash /tmp/work.sh` runs in it'],
            ['w1:p2', 'deleted', '/ws/.worktrees/old (deleted)', '-',
             'kept: its shell (process 602) is not waiting at its prompt']])
        self.assertEqual(self.closes(), [])

    def test_pane_that_changed_since_the_listing_is_kept(self):
        real = self.herdr.__call__
        seen = []

        def herdr(*args):
            if args[:2] == ('pane', 'process-info') and args[3] == 'w1:p1':
                seen.append(args)
                if len(seen) == 2:  # the re-check before closing: someone typed a command
                    self.line_modes[501] = True
            return real(*args)
        self.watch.herdr = herdr
        code, lines = self.run_cli('--close')
        self.assertEqual(lines[0][-1], 'kept: its shell (process 501) is not waiting at its prompt')
        self.assertEqual(self.closes(), ['w1:p2'])

    def test_shell_that_left_the_deleted_folder_since_the_listing_is_kept(self):
        real = self.herdr.__call__
        seen = []

        def herdr(*args):
            if args[:2] == ('pane', 'process-info') and args[3] == 'w1:p2':
                seen.append(args)
                if len(seen) == 2:  # the user ran `cd ~/work` before the re-check
                    link = self.watch.PROC / '502' / 'cwd'
                    link.unlink()
                    link.symlink_to('/home/u/work')
            return real(*args)
        self.watch.herdr = herdr
        code, lines = self.run_cli('--close')
        self.assertEqual(lines[1][-1], 'kept: process 502 is no longer the deleted shell it was')
        self.assertEqual(self.closes(), ['w1:p1'])

    def test_unreadable_hcom_list_lists_and_closes_nothing(self):
        self.rows = None
        with mock.patch('sys.stderr', new=io.StringIO()):
            code, lines = self.run_cli('--close')
        self.assertEqual((code, lines, self.closes()), (1, [], []))


if __name__ == '__main__':
    unittest.main()
