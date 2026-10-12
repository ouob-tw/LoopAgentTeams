import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/backend-route.py'
FAIL = 'exit 1'
NOW = time.time()
HOUR = 3600
DAY = 24 * HOUR


def usage():
    """Fake quota output: two Claude accounts and three GPT accounts, with made-up identities."""
    reset = time.strftime('%Y-%m-%dT%H:%M:%S+00:00', time.gmtime(NOW + 2 * DAY + 3.5 * HOUR))
    claude = json.dumps({'activeAccountNumber': 2, 'accounts': [
        {'number': 1, 'active': False, 'email': 'one@example.test', 'organizationName': 'Acme Org',
         'usage': {'fiveHour': {'pct': 0}, 'sevenDay': {'pct': 92, 'resetsAt': reset}},
         'usageAgeSeconds': 420.4},
        {'number': 2, 'active': True, 'email': 'two@example.test', 'organizationName': 'Acme Org',
         'usage': {'fiveHour': {'pct': 28, 'resetsAt': reset}, 'sevenDay': {'pct': 15, 'resetsAt': reset}},
         'usageAgeSeconds': 8.3},
    ]})

    def window(used, minutes, left=None):
        return {'usedPercent': used, 'windowMinutes': minutes,
                'resetAtMs': left and int((NOW + left) * 1000)}

    gpt = json.dumps({'accounts': [
        {'index': 0, 'current': False, 'enabled': True, 'email': 'three@example.test',
         'quota': {'updatedAt': int((NOW - 600.5) * 1000), 'planType': 'prolite',
                   'primary': window(79, 10080, 6 * DAY + 1.5 * HOUR), 'secondary': window(0, 0)}},
        {'index': 1, 'current': True, 'enabled': True, 'email': 'four@example.test',
         'quota': {'updatedAt': int((NOW - 600.5) * 1000), 'planType': 'plus',
                   'primary': window(40, 300, 1.51 * HOUR),
                   'secondary': window(17, 10080, 6 * DAY + 1.5 * HOUR)}},
        {'index': 2, 'current': False, 'enabled': True, 'email': 'five@example.test',
         'quota': {'updatedAt': int((NOW - 600.5) * 1000), 'planType': 'free',
                   'primary': window(3, 43200, 20 * DAY + 1.5 * HOUR), 'secondary': window(0, 0)}},
    ]})
    return f"echo '{claude}'", f"echo '{gpt}'"


def route(config, claude_swap=FAIL, codex_multi_auth=FAIL):
    """Run the helper with a temp home and fake quota commands on PATH."""
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        if config is not None:
            (tmp / '.config/hcom-spawn').mkdir(parents=True)
            (tmp / '.config/hcom-spawn/config.toml').write_text(config)
        for name, body in (('claude-swap', claude_swap), ('codex-multi-auth', codex_multi_auth)):
            fake = tmp / name
            fake.write_text(f'#!/bin/sh\n{body}\n')
            fake.chmod(0o755)
        env = {'HOME': str(tmp), 'PATH': f"{tmp}:{os.environ['PATH']}"}
        return subprocess.run([sys.executable, str(SCRIPT)], env=env,
                              text=True, capture_output=True)


class BackendRouteTests(unittest.TestCase):
    def assert_route(self, result, expected):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(result.stdout.splitlines()), 1)
        self.assertTrue(result.stdout.startswith(f'{expected}: '), result.stdout)

    def table(self, config='backend = "auto"\n'):
        result = route(config, *usage())
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def test_claude_setting_routes_to_claude_without_querying(self):
        self.assert_route(route('backend = "claude"\n'), 'claude')

    def test_split_setting_routes_to_gpt_without_querying(self):
        self.assert_route(route('backend = "split"\n'), 'gpt')

    def test_unknown_setting_is_an_error_listing_the_valid_values(self):
        result = route('backend = "gpt"\n', *usage())
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        for value in ('claude', 'split', 'auto'):
            self.assertIn(value, result.stderr)

    def test_a_failed_query_on_either_side_routes_to_claude(self):
        claude_ok, gpt_ok = usage()
        for fakes in ((FAIL, gpt_ok), (claude_ok, FAIL)):
            result = route('backend = "auto"\n', *fakes)
            self.assert_route(result, 'claude')
            self.assertIn('failed', result.stdout)

    def test_auto_lists_every_account_of_both_sides_and_marks_the_active_ones(self):
        lines = self.table()
        self.assertTrue(lines[0].startswith('auto: '), lines[0])
        self.assertEqual([line.split(':')[0] for line in lines[1:]],
                         ['claude 1', 'claude 2*', 'gpt 0 prolite', 'gpt 1* plus', 'gpt 2 free'])
        self.assertEqual(lines[2], 'claude 2*: 5h 28% resets in 2d3h, 7d 15% resets in 2d3h, data 0m old')
        self.assertEqual(lines[4], 'gpt 1* plus: 5h 40% resets in 1h30m, 7d 17% resets in 6d1h, data 10m old')
        for identity in ('example.test', 'Acme'):
            self.assertNotIn(identity, '\n'.join(lines))

    def test_missing_config_file_means_auto(self):
        self.assertEqual(self.table(None), self.table())

    def test_a_window_the_source_lacks_is_not_printed(self):
        lines = self.table()
        self.assertEqual(lines[1], 'claude 1: 5h 0%, 7d 92% resets in 2d3h, data 7m old')
        self.assertEqual(lines[3], 'gpt 0 prolite: 7d 79% resets in 6d1h, data 10m old')

    def test_a_window_of_another_length_is_printed_with_its_own_length(self):
        self.assertEqual(self.table()[5], 'gpt 2 free: 30d 3% resets in 20d1h, data 10m old')


if __name__ == '__main__':
    unittest.main()
