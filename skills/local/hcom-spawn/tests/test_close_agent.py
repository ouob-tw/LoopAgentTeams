import contextlib
import importlib.util
import io
import json
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/close-agent.py'


def load():
    spec = importlib.util.spec_from_file_location('close_agent', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def row(name, pane=None, tag=None):
    return {'name': name, 'tag': tag,
            'launch_context': {'pane_id': pane} if pane else {}}


class Host:
    """Fake hcom and herdr sharing one state; the clock moves one second per sleep."""

    def __init__(self, agents, panes, tracked=()):
        self.agents = {agent['name']: agent for agent in agents}
        self.panes, self.tracked = set(panes), set(tracked)
        self.calls, self.now = [], 0.0
        self.stop_leaves_name = False
        self.close_fails = False
        self.kill_error = None

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += 1

    def hcom(self, *args):
        self.calls.append(('hcom', *args))
        if args[0] == 'list':
            return 0, json.dumps(list(self.agents.values()))
        name = args[1]
        if args[0] == 'kill':
            if self.kill_error:
                return 1, self.kill_error
            if name not in self.tracked:
                return 1, (f"Error: No tracked PID for '{name}' — use 'hcom stop {name}' instead\n"
                           + json.dumps({'ok': False}))
            self.panes.discard(self.agents.pop(name)['launch_context'].get('pane_id'))
            return 0, json.dumps({'ok': True, 'results': [{'pane_closed': True}]})
        if args[0] == 'stop':
            if not self.stop_leaves_name:
                self.agents.pop(name)
            return 0, f'Stopped {name}\n'
        raise AssertionError(args)

    def herdr(self, *args):
        self.calls.append(('herdr', *args))
        pane = args[2]
        if args[:2] == ('pane', 'get'):
            if pane in self.panes:
                return 0, json.dumps({'result': {'pane': {'pane_id': pane}}})
            return 1, json.dumps({'error': {'code': 'pane_not_found'}})
        if args[:2] == ('pane', 'close'):
            if self.close_fails:
                return 1, 'RPC timeout'
            self.panes.discard(pane)
            return 0, ''
        raise AssertionError(args)

    def closed_panes(self):
        return [call[3] for call in self.calls if call[1:3] == ('pane', 'close')]


class CloseAgentTest(unittest.TestCase):
    def run_helper(self, host, *targets):
        module = load()
        out = io.StringIO()
        with mock.patch.object(module, 'hcom', host.hcom), \
                mock.patch.object(module, 'herdr', host.herdr), \
                mock.patch.object(module, 'clock', host.clock), \
                mock.patch.object(module, 'sleep', host.sleep), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = module.main(['--name', 'vare', *targets])
        return code, out.getvalue()

    def test_tracked_agent_is_killed_and_reported_gone(self):
        host = Host([row('vare', 'p1'), row('vare-review-kilo', 'p2')], {'p1', 'p2'},
                    tracked={'vare-review-kilo'})
        code, out = self.run_helper(host, 'vare-review-kilo')
        self.assertEqual(code, 0)
        self.assertIn('vare-review-kilo: killed; name gone from hcom list; pane p2 gone', out)
        self.assertNotIn(('hcom', 'stop', 'vare-review-kilo', '--name', 'vare'), host.calls)
        self.assertEqual(host.closed_panes(), [])

    def test_agent_without_tracked_pid_is_stopped_and_its_pane_closed(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu', 'p2'), row('other', 'p3')],
                    {'p1', 'p2', 'p3'})
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 0)
        self.assertIn('vare-board-gazu: stopped; name gone from hcom list; pane p2 gone', out)
        self.assertIn(('hcom', 'stop', 'vare-board-gazu', '--name', 'vare'), host.calls)
        self.assertEqual(host.closed_panes(), ['p2'])
        self.assertEqual(host.panes, {'p1', 'p3'})

    def test_pane_shared_with_another_agent_is_not_touched(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu', 'p2'), row('other', 'p2')],
                    {'p1', 'p2'})
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 1)
        self.assertIn('vare-board-gazu: not closed: pane p2 is also recorded for other', out)
        self.assertEqual([c for c in host.calls if c[1] in ('kill', 'stop', 'close')], [])

    def test_the_callers_own_pane_is_not_touched(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu', 'p1')], {'p1'})
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 1)
        self.assertIn("pane p1 is the caller's own pane", out)
        self.assertEqual(host.closed_panes(), [])

    def test_the_caller_cannot_close_itself(self):
        host = Host([row('vare', 'p1')], {'p1'}, tracked={'vare'})
        code, out = self.run_helper(host, 'vare')
        self.assertEqual(code, 1)
        self.assertIn('vare: not closed: the agent is the caller itself', out)
        self.assertEqual([c for c in host.calls if c[1] != 'list'], [])

    def test_agent_with_no_recorded_pane_is_stopped_but_reported_as_left_over(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu')], {'p1'})
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 1)
        self.assertIn('vare-board-gazu: stopped; left: pane not checked: no Herdr pane recorded', out)
        self.assertEqual(host.closed_panes(), [])

    def test_name_still_listed_after_the_wait_is_reported(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu', 'p2')], {'p1', 'p2'})
        host.stop_leaves_name = True
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 1)
        self.assertIn('vare-board-gazu: stopped; left: name still in hcom list', out)

    def test_failed_pane_close_still_checks_and_reports_what_is_left(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu', 'p2')], {'p1', 'p2'})
        host.close_fails = True
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 1)
        self.assertIn('vare-board-gazu: stopped: herdr pane close p2 failed: RPC timeout; '
                      'left: pane p2 still open', out)

    def test_failed_kill_still_checks_and_reports_the_name_left(self):
        host = Host([row('vare', 'p1'), row('vare-board-gazu', 'p2')], {'p1', 'p2'})
        host.kill_error = 'Error: database is locked'
        code, out = self.run_helper(host, 'vare-board-gazu')
        self.assertEqual(code, 1)
        self.assertIn('vare-board-gazu: failed: Error: database is locked; '
                      'left: name still in hcom list; pane p2 still open', out)
        self.assertEqual(host.closed_panes(), [])

    def test_unknown_name_is_reported_and_nothing_is_run(self):
        host = Host([row('vare', 'p1')], {'p1'})
        code, out = self.run_helper(host, 'vare-nope')
        self.assertEqual(code, 1)
        self.assertIn('vare-nope: not closed: not in hcom list', out)
        self.assertEqual([c for c in host.calls if c[1] != 'list'], [])

    def test_tag_closes_every_agent_with_that_tag(self):
        host = Host([row('vare', 'p1'), row('vare-review-kilo', 'p2', 'vare-review'),
                     row('vare-review-mona', 'p3', 'vare-review'), row('other', 'p4', 'x')],
                    {'p1', 'p2', 'p3', 'p4'}, tracked={'vare-review-kilo'})
        code, out = self.run_helper(host, 'tag:vare-review')
        self.assertEqual(code, 0)
        self.assertIn('vare-review-kilo: killed', out)
        self.assertIn('vare-review-mona: stopped', out)
        self.assertEqual(host.panes, {'p1', 'p4'})


if __name__ == '__main__':
    unittest.main()
