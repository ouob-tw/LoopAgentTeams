"""scripts/nightly-tickets.py against a fake gh that records its calls; no real tracker."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'nightly-tickets.py'
FAKE_GH = '''#!/usr/bin/env python3
import json, os, sys
state = json.load(open(os.environ['FAKE_GH_STATE']))
with open(os.environ['FAKE_GH_CALLS'], 'a') as calls:
    calls.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['issue', 'list']:
    print(json.dumps(state['issues']))
elif sys.argv[1:3] == ['label', 'list']:
    print(json.dumps([{'name': name} for name in state['labels']]))
'''


def issue(number, created, *labels):
    return dict(number=number, title=f'ticket {number}', createdAt=created,
                labels=[dict(name=name) for name in ('ready-for-agent', *labels)])


class NightlyTickets(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'gh').write_text(FAKE_GH)
        (bin_dir / 'gh').chmod(0o755)
        self.state = root / 'state.json'
        self.calls = root / 'calls.jsonl'
        self.env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                    'FAKE_GH_STATE': str(self.state), 'FAKE_GH_CALLS': str(self.calls)}
        self.given([], ['nightly-hold'])

    def given(self, issues, labels):
        self.state.write_text(json.dumps(dict(issues=issues, labels=labels)))

    def run_tool(self, *args):
        done = subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env,
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def gh_calls(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_pick_orders_by_severity_then_age_skips_held_and_stops_at_three(self):
        self.given([
            issue(10, '2026-11-01T00:00:00Z', 'enhancement'),
            issue(11, '2026-11-05T00:00:00Z', 'bug'),
            issue(12, '2026-11-09T00:00:00Z', 'suite-failure'),
            issue(13, '2026-10-01T00:00:00Z', 'bug', 'nightly-hold'),
            issue(14, '2026-11-05T00:00:00Z', 'bug'),
            issue(15, '2026-10-20T00:00:00Z', 'test-cleanup'),
        ], ['nightly-hold'])
        picked = json.loads(self.run_tool('pick', '--json'))
        # Same tier and same time: the lower number first.
        self.assertEqual([item['number'] for item in picked], [12, 11, 14])
        self.assertEqual(self.run_tool('pick').splitlines()[0], '#12 ticket 12')
        listed = self.gh_calls()[0]
        self.assertEqual(listed[:2], ['issue', 'list'])
        self.assertIn('ready-for-agent', listed)
        self.assertIn('open', listed)

    def test_pick_with_fewer_candidates_prints_what_there_is(self):
        self.given([issue(20, '2026-11-01T00:00:00Z'),
                    issue(21, '2026-10-01T00:00:00Z', 'nightly-hold')], ['nightly-hold'])
        self.assertEqual(json.loads(self.run_tool('pick', '--json')),
                         [dict(number=20, title='ticket 20')])

    def test_hold_creates_a_missing_label_then_labels_and_comments(self):
        self.given([], ['bug'])
        self.run_tool('hold', '42', '--date', '2026-11-15')
        calls = self.gh_calls()
        self.assertEqual(calls[1][:3], ['label', 'create', 'nightly-hold'])
        self.assertEqual(calls[2][:3], ['issue', 'edit', '42'])
        self.assertIn('--add-label', calls[2])
        self.assertEqual(calls[3][:3], ['issue', 'comment', '42'])
        self.assertIn('Nightly round 2026-11-15', calls[3][calls[3].index('--body') + 1])

    def test_hold_with_the_label_present_does_not_create_it(self):
        self.run_tool('hold', '42', '--date', '2026-11-15')
        self.assertFalse(any(call[:2] == ['label', 'create'] for call in self.gh_calls()))

    def test_release_removes_the_label_and_blocked_keeps_it_with_the_reason(self):
        self.run_tool('release', '7')
        self.assertEqual(self.gh_calls()[-1],
                         ['issue', 'edit', '7', '-R', 'ouob-tw/LoopAgentTeams-work',
                          '--remove-label', 'nightly-hold'])
        self.run_tool('blocked', '8', '--reason', 'needs your call on the API shape')
        calls = self.gh_calls()
        self.assertIn('--add-label', calls[-2])
        body = calls[-1][calls[-1].index('--body') + 1]
        self.assertIn('needs your call on the API shape', body)
        self.assertNotIn('--remove-label', calls[-2])


if __name__ == '__main__':
    unittest.main()
