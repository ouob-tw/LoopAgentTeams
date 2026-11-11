import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# A fake `gh` as strict as the real one: only `gh api repos/<owner>/<repo>/issues/<n>` is
# accepted; any other argument shape, an unknown issue or a logged-out state exits non-zero.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
args = sys.argv[1:]
data = json.load(open(os.environ['FAKE_GH_DATA']))
open(os.environ['FAKE_GH_LOG'], 'a').write(' '.join(args) + '\n')
if data.get('logged_out'):
    sys.stderr.write('gh: To get started with GitHub CLI, please run:  gh auth login\n'); sys.exit(4)
match = len(args) == 2 and args[0] == 'api' and re.fullmatch(
    r'repos/([\w.-]+/[\w.-]+)/issues/(\d+)', args[1])
if not match:
    sys.stderr.write('unknown gh invocation: ' + ' '.join(args) + '\n'); sys.exit(1)
issue = data['issues'].get(match.group(1) + '#' + match.group(2))
if issue is None:
    sys.stderr.write('gh: Not Found (HTTP 404)\n'); sys.exit(1)
print(json.dumps(issue))
'''


class TrackerWarningTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.work = self.root / 'work'
        (self.work / 'docs/agents').mkdir(parents=True)
        (self.work / 'docs/agents/issue-tracker.md').write_text(
            'Use `gh` and **always pass `-R acme/work`**.\n')
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text(FAKE_GH)
        gh.chmod(0o755)
        self.data = self.root / 'data.json'
        self.log = self.root / 'gh.log'
        self.env = {'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'FAKE_GH_DATA': str(self.data),
                    'FAKE_GH_LOG': str(self.log)}
        self.addCleanup(os.environ.__setitem__, 'PATH', os.environ['PATH'])
        for key, value in self.env.items():
            os.environ[key] = value
        self.set_issues({})
        self.tracker = load('lat_tracker', '_lat_tracker.py')
        self.ledger = load('lat_ledger', 'lat-ledger.py')
        self.path = self.root / 'ledger.json'

    def set_issues(self, issues, **extra):
        self.data.write_text(json.dumps(dict(issues=issues, **extra)))

    def issue(self, state, labels=(), total=0, completed=0):
        return {'state': state, 'labels': [{'name': name} for name in labels],
                'sub_issues_summary': {'total': total, 'completed': completed}}

    def ledger_with(self, *tickets):
        listing = self.root / 'list.json'
        listing.write_text(json.dumps([{'name': 'orch'}]))
        env = dict(os.environ, LAT_LEDGER_HCOM_LIST=str(listing))
        run = lambda *a: subprocess.run([sys.executable, str(SCRIPTS / 'lat-ledger.py'), *a],
                                        text=True, capture_output=True, env=env, check=True)
        run('init', '--ledger', str(self.path), '--workspace', str(self.work),
            '--orchestrator', 'orch', '--by', 'orch')
        for ticket in tickets:
            run('add', '--ledger', str(self.path), '--by', 'orch', '--ticket', ticket,
                '--stage', 'impl', '--evidence', 'file')

    def warnings(self):
        return self.tracker.tracker_warnings(self.ledger, self.path, self.work)

    def test_open_ticket_is_listed(self):
        self.set_issues({'acme/work#5': self.issue('open', ['ready-for-agent'])})
        self.ledger_with('#5')
        text = '\n'.join(self.warnings())
        self.assertIn('acme/work#5 仍開著', text)
        self.assertIn('只提醒，不擋', text)

    def test_closed_ticket_with_triage_label_gets_a_runnable_remove_command(self):
        self.set_issues({'acme/work#6': self.issue('closed', ['bug', 'ready-for-agent', 'needs-info'])})
        self.ledger_with('#6')
        text = '\n'.join(self.warnings())
        command = 'gh issue edit 6 -R acme/work --remove-label ready-for-agent --remove-label needs-info'
        self.assertIn(f'`{command}`', text)
        self.assertNotIn('bug', text)

    def test_closed_clean_ticket_and_wontfix_say_nothing(self):
        self.set_issues({'acme/work#7': self.issue('closed', ['bug']),
                         'acme/work#8': self.issue('closed', ['wontfix'])})
        self.ledger_with('#7', '#8')
        self.assertEqual(self.warnings(), [])

    def test_open_spec_whose_sub_issues_all_closed_is_flagged(self):
        self.set_issues({'acme/work#9': self.issue('open', ['spec'], total=3, completed=3),
                         'acme/work#10': self.issue('open', [], total=3, completed=2)})
        self.ledger_with('#9', '#10')
        text = '\n'.join(self.warnings())
        self.assertIn('子票 3 張全已關閉', text)
        self.assertEqual(text.count('子票'), 1)

    def test_ticket_with_its_own_repo_prefix_is_read_there(self):
        self.set_issues({'other/place#3': self.issue('open')})
        self.ledger_with('other/place#3')
        self.assertIn('other/place#3 仍開著', '\n'.join(self.warnings()))

    def test_read_failure_is_one_line_not_an_exception(self):
        self.ledger_with('#404')
        lines = self.warnings()
        self.assertEqual(len(lines), 1)
        self.assertIn('tracker 檢查略過', lines[0])
        self.set_issues({}, logged_out=True)
        lines = self.warnings()
        self.assertEqual(len(lines), 1)
        self.assertIn('gh auth login', lines[0])

    def test_missing_gh_is_one_line(self):
        self.ledger_with('#5')
        os.environ['PATH'] = str(self.root / 'nowhere')
        lines = self.warnings()
        self.assertEqual(len(lines), 1)
        self.assertIn('tracker 檢查略過', lines[0])

    def test_no_github_tracker_doc_is_one_line_and_calls_nothing(self):
        (self.work / 'docs/agents/issue-tracker.md').unlink()
        self.ledger_with('#5')
        lines = self.warnings()
        self.assertEqual(len(lines), 1)
        self.assertFalse(self.log.exists())

    def test_non_ticket_text_is_skipped(self):
        self.ledger_with('no-ticket-yet')
        self.assertEqual(self.warnings(), [])
        self.assertFalse(self.log.exists())

    def test_only_reads_with_the_api_path_form(self):
        self.set_issues({'acme/work#5': self.issue('open')})
        self.ledger_with('#5', '#5')
        self.log.write_text('')  # adding the rows read the tracker for titles
        self.warnings()
        self.assertEqual(self.log.read_text().splitlines(), ['api repos/acme/work/issues/5'])


if __name__ == '__main__':
    unittest.main()
