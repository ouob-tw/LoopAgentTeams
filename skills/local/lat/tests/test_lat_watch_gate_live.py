"""Contract: lat-watch finds a running suite-gate's live output where suite-gate writes it (#715)."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2]
WATCH = SCRIPTS / 'lat/scripts/lat-watch.py'
GATE = SCRIPTS / 'three-tier-testing/scripts/suite-gate.py'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GateLiveFileContractTests(unittest.TestCase):
    def test_watch_resolves_the_live_file_suite_gate_opens(self):
        watch, gate = load('lat_watch_contract', WATCH), load('suite_gate_contract', GATE)
        self.assertEqual(watch.GATE_LIVE_CAP_BYTES, gate.FAILURE_SPOOL_BYTES)
        with tempfile.TemporaryDirectory() as home:
            for env in ({'SUITE_GATE_STATE_DIR': f'{home}/gate'},
                        {'XDG_STATE_HOME': f'{home}/xdg', 'HOME': home},
                        {'HOME': home}):
                with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                    path, handle = gate.spool_open()
                    handle.close()
                    process = watch.Process(os.getpid(), 1, 0, 'S', 1, ('python',),
                                            tuple(f'{k}={v}' for k, v in env.items()))
                    self.assertEqual(path.parent,
                                     watch.gate_state_dir(process) / 'failures')
                    match = watch.GATE_LIVE_FILE.fullmatch(path.name)
                    self.assertIsNotNone(match)
                    self.assertEqual(int(match[1]), os.getpid())


if __name__ == '__main__':
    unittest.main()
