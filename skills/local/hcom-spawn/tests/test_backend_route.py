import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/backend-route.py'
FAIL = 'exit 1'


def usage(claude_pct, gpt_pct):
    claude = json.dumps({'active': {'usage': {'sevenDay': {'pct': claude_pct}}}})
    gpt = json.dumps({'accounts': [
        {'current': False, 'quota': {'primary': {'usedPercent': 1, 'windowMinutes': 10080},
                                     'secondary': {'usedPercent': 0, 'windowMinutes': 0}}},
        {'current': True, 'quota': {'primary': {'usedPercent': 99, 'windowMinutes': 300},
                                    'secondary': {'usedPercent': gpt_pct, 'windowMinutes': 10080}}},
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

    def test_claude_setting_routes_to_claude_without_querying(self):
        self.assert_route(route('backend = "claude"\n', *usage(40, 13)), 'claude')

    def test_split_setting_routes_to_gpt_without_querying(self):
        self.assert_route(route('backend = "split"\n', *usage(13, 40)), 'gpt')

    def test_auto_setting_routes_to_the_side_with_lower_seven_day_usage(self):
        self.assert_route(route('backend = "auto"\n', *usage(13, 40)), 'claude')
        self.assert_route(route('backend = "auto"\n', *usage(40, 13)), 'gpt')

    def test_missing_config_file_means_auto(self):
        self.assert_route(route(None, *usage(40, 13)), 'gpt')

    def test_unknown_setting_is_an_error_listing_the_valid_values(self):
        result = route('backend = "gpt"\n', *usage(40, 13))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, '')
        for value in ('claude', 'split', 'auto'):
            self.assertIn(value, result.stderr)

    def test_equal_usage_routes_to_claude(self):
        result = route('backend = "auto"\n', *usage(20, 20))
        self.assert_route(result, 'claude')
        self.assertNotIn('failed', result.stdout)

    def test_a_failed_query_on_either_side_routes_to_claude(self):
        claude_ok, gpt_ok = usage(90, 5)
        for fakes in ((FAIL, gpt_ok), (claude_ok, FAIL)):
            result = route('backend = "auto"\n', *fakes)
            self.assert_route(result, 'claude')
            self.assertIn('failed', result.stdout)


if __name__ == '__main__':
    unittest.main()
