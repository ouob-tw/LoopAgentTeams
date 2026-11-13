"""scripts/install-cpu-slices.sh against a fake config home and a fake systemctl."""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'install-cpu-slices.sh'


class InstallCpuSlices(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.home = root / 'config'
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        self.calls = root / 'calls'
        fake = bin_dir / 'systemctl'
        fake.write_text(f'#!/bin/sh\necho "$@" >> {self.calls}\n')
        fake.chmod(0o755)
        self.env = {**os.environ, 'XDG_CONFIG_HOME': str(self.home),
                    'PATH': f'{bin_dir}:{os.environ["PATH"]}'}
        self.env.pop('LAT_CPU_CONF', None)
        self.unit_dir = self.home / 'systemd/user'

    def run_script(self, *args):
        return subprocess.run(['sh', str(SCRIPT), *args], env=self.env, capture_output=True,
                              text=True, check=True)

    def test_writes_defaults_and_is_repeatable(self):
        self.run_script()
        first = (self.unit_dir / 'lat-tests.slice').read_text()
        self.assertIn('CPUWeight=30', first)
        self.assertIn('CPUQuota=2000%', first)
        self.assertIn('CPUWeight=500',
                      (self.unit_dir / 'lat-board.service.d/cpu-weight.conf').read_text())
        self.run_script()
        self.assertEqual((self.unit_dir / 'lat-tests.slice').read_text(), first)
        self.assertEqual(self.calls.read_text().splitlines(), ['--user daemon-reload'] * 2)

    def test_config_file_values_are_used(self):
        conf = self.home / 'lat-cpu/slices.conf'
        conf.parent.mkdir(parents=True)
        conf.write_text('TESTS_CPU_WEIGHT=10\nTESTS_CPU_QUOTA=800%\nBOARD_CPU_WEIGHT=900\n')
        self.run_script()
        text = (self.unit_dir / 'lat-tests.slice').read_text()
        self.assertIn('CPUWeight=10', text)
        self.assertIn('CPUQuota=800%', text)
        self.assertIn('CPUWeight=900',
                      (self.unit_dir / 'lat-board.service.d/cpu-weight.conf').read_text())

    def test_remove_deletes_both_and_keeps_the_config(self):
        self.run_script()
        self.run_script('--remove')
        self.assertFalse((self.unit_dir / 'lat-tests.slice').exists())
        self.assertFalse((self.unit_dir / 'lat-board.service.d').exists())
        self.assertTrue((self.home / 'lat-cpu/slices.conf').exists())
        self.run_script('--remove')  # nothing left: still no error


if __name__ == '__main__':
    unittest.main()
