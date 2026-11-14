"""When the gate comments on an open cleanup ticket, and the labels of a ticket it opens (#622).
The `gh` is the fake of test_suite_gate; the real one is never reached."""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import CleanupCase


class CommentCase(CleanupCase):
    def setUp(self):
        super().setUp()
        (self.gh_dir / 'open.json').write_text(
            json.dumps([{'number': 5, 'url': 'https://github.com/o/r/issues/5'}]))
        self.run_suite('2026-01-01')

    def day(self, day):
        """A failed run on day (it adds no sample) with the speed pinned at 100%."""
        self.set_speed(100, [100, 100, 100])
        return self.run_suite(day, code=1)

    def comments(self):
        return [call for call in self.gh_calls() if call[:2] == ['issue', 'comment']]

    def set_flaky(self, *names):
        path = self.state / 'state.json'
        state = json.loads(path.read_text())
        [unit] = state['cleanup'].values()
        unit['flaky'] = {f'a.py::{n}': {'file': 'a.py', 'test': n, 'count': 1, 'last': 't'}
                         for n in names}
        path.write_text(json.dumps(state))

    def commented(self):
        [unit] = json.loads((self.state / 'state.json').read_text())['cleanup'].values()
        return unit['commented']


class CommentRuleTests(CommentCase):
    def test_the_first_comment_on_a_ticket_is_made(self):
        result = self.day('2026-02-01')
        self.assertIn('commented on https://github.com/o/r/issues/5', result.stderr)
        self.assertEqual(self.commented()['5']['kinds'], ['days'])

    def test_the_same_trigger_the_next_day_prints_one_line_and_no_comment(self):
        self.day('2026-02-01')
        result = self.day('2026-02-02')
        self.assertEqual(len(self.comments()), 1)
        [line] = [l for l in result.stderr.splitlines() if 'cleanup' in l]
        self.assertIn('no comment on https://github.com/o/r/issues/5', line)

    def test_a_trigger_kind_not_commented_before_is_made(self):
        self.day('2026-02-01')  # days
        self.set_speed(100, [130, 130, 130])
        self.run_suite('2026-02-02', code=1)
        self.assertEqual(len(self.comments()), 2)
        self.assertEqual(self.commented()['5']['kinds'], ['days', 'speed'])

    def test_the_speed_trigger_first_then_days_is_a_new_kind_too(self):
        self.set_speed(100, [130, 130, 130])
        self.run_suite('2026-01-02', code=1)
        self.assertEqual(self.commented()['5']['kinds'], ['speed'])
        self.run_suite('2026-01-03', code=1)
        self.assertEqual(len(self.comments()), 1)
        self.run_suite('2026-02-05', code=1)
        self.assertEqual(len(self.comments()), 2)

    def test_the_median_ratio_must_rise_20_points_since_the_last_comment(self):
        self.set_speed(100, [130, 130, 130])
        self.run_suite('2026-01-02', code=1)
        self.set_speed(100, [149, 149, 149])
        self.run_suite('2026-01-03', code=1)
        self.assertEqual(len(self.comments()), 1, '19 points more is not enough')
        self.set_speed(100, [150, 150, 150])
        self.run_suite('2026-01-04', code=1)
        self.assertEqual(len(self.comments()), 2, '20 points more is')
        self.assertEqual(self.commented()['5']['ratio'], 1.5)
        self.set_speed(100, [140, 140, 140])
        self.run_suite('2026-01-05', code=1)
        self.assertEqual(len(self.comments()), 2, 'faster again is no news')

    def test_a_flaky_test_not_listed_last_time_is_made_but_a_listed_one_is_not(self):
        self.set_flaky('one')
        self.day('2026-02-01')
        self.day('2026-02-02')
        self.assertEqual(len(self.comments()), 1)
        self.set_flaky('one', 'two')
        self.day('2026-02-03')
        self.assertEqual(len(self.comments()), 2)
        self.assertEqual(self.commented()['5']['flaky'], ['a.py::one', 'a.py::two'])
        self.set_flaky('two')
        self.day('2026-02-04')
        self.assertEqual(len(self.comments()), 2)

    def test_a_ticket_this_suite_never_commented_on_gets_the_first_comment(self):
        self.day('2026-02-01')
        (self.gh_dir / 'open.json').write_text(
            json.dumps([{'number': 9, 'url': 'https://github.com/o/r/issues/9'}]))
        self.day('2026-02-02')
        self.assertEqual([c[2] for c in self.comments()], ['5', '9'])

    def test_a_failed_comment_is_not_counted_and_is_judged_again(self):
        self.day('2026-02-01')
        self.set_speed(100, [130, 130, 130])
        (self.gh_dir / 'fail').touch()
        result = self.run_suite('2026-02-02', code=3)
        self.assertIn('could not be updated', result.stderr)
        self.assertEqual(self.commented()['5']['kinds'], ['days'])
        (self.gh_dir / 'fail').unlink()
        self.run_suite('2026-02-02', code=1)
        self.assertEqual(len(self.comments()), 2)
        self.assertEqual(self.commented()['5']['kinds'], ['days', 'speed'])

    def test_a_new_window_forgets_what_was_commented(self):
        self.day('2026-02-01')
        self.assertEqual(self.gate('cleanup-done').returncode, 0)
        self.assertEqual(self.commented(), {})


class OpenedTicketLabelTests(CleanupCase):
    def create_call(self):
        return next(c for c in self.gh_calls() if c[:2] == ['issue', 'create'])

    def test_a_new_ticket_carries_the_tracker_label_and_ready_for_agent(self):
        self.run_suite('2026-01-01')
        self.run_suite('2026-03-01')
        call = self.create_call()
        labels = [call[i + 1] for i, a in enumerate(call) if a == '--label']
        self.assertEqual(labels, ['test-cleanup', 'ready-for-agent'])

    def test_a_repo_without_that_label_still_gets_the_ticket_with_the_tracker_label(self):
        (self.gh_dir / 'no-ready-label').touch()
        self.run_suite('2026-01-01')
        result = self.run_suite('2026-03-01')
        creates = [c for c in self.gh_calls() if c[:2] == ['issue', 'create']]
        self.assertEqual(len(creates), 2)
        self.assertNotIn('ready-for-agent', creates[1])
        self.assertIn('--label', creates[1])
        self.assertIn('opened https://github.com/o/r/issues/7', result.stderr)

    def test_the_new_ticket_counts_as_its_first_comment(self):
        self.run_suite('2026-01-01')
        self.run_suite('2026-03-01')
        result = self.run_suite('2026-03-02')
        self.assertIn('no comment on https://github.com/o/r/issues/7', result.stderr)


if __name__ == '__main__':
    unittest.main()
