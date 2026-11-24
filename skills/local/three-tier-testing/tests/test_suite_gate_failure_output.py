"""A failed run keeps its full output (bounded) as a file the record names, a passing run
keeps none, status finds the file after a passing rerun, and old files expire."""
import hashlib
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_suite_gate import GateCase, gate

DAY = 86400


class FailureFileTests(GateCase):
    def failing_suite(self, marker='FIRST-FAILURE-MARKER'):
        """A suite that fails first, in unittest's format, then prints ~3 MB."""
        script = self.tmp / f'noisy-{marker}.py'
        script.write_text(
            'import sys\n'
            'print("filler " * 20000)\n'
            'print("=" * 70)\n'
            f'print("FAIL: test_first (mod.Case.test_first)")\n'
            'print("-" * 70)\n'
            f'print("AssertionError: {marker}")\n'
            'print()\n'
            'print("-" * 70)\n'
            'for i in range(50000):\n'
            '    print("later output line %d with some padding to make it longer" % i)\n'
            'sys.exit(1)\n')
        return f'{sys.executable} {script}'

    def failure_files(self):
        folder = self.state / 'failures'
        return sorted(folder.iterdir()) if folder.is_dir() else []

    def test_failed_run_keeps_bounded_output_with_the_first_failure(self):
        result = self.gate('run', '--', self.failing_suite())
        self.assertEqual(result.returncode, 1)
        [record] = self.records()
        self.assertNotIn('FIRST-FAILURE-MARKER', record['output_tail'])
        kept = record['failure_output']
        path = Path(kept['path'])
        self.assertEqual(path.parent, self.state / 'failures')
        data = path.read_bytes()
        self.assertEqual(kept['sha256'], hashlib.sha256(data).hexdigest())
        self.assertEqual(kept['bytes'], len(data))
        self.assertLessEqual(len(data), gate.FAILURE_FILE_BYTES + 1024)
        self.assertTrue(kept['truncated'])
        text = data.decode()
        self.assertIn('AssertionError: FIRST-FAILURE-MARKER', text)
        self.assertIn('TRUNCATED', text.splitlines()[0])
        self.assertEqual(self.failure_files(), [path], 'no live file is left behind')
        self.assertIn(str(path), result.stderr)

    def test_passing_run_keeps_no_output_file_and_the_tail(self):
        self.assertEqual(self.gate('run', '--', self.suite()).returncode, 0)
        [record] = self.records()
        self.assertIn('suite-out', record['output_tail'])
        self.assertNotIn('failure_output', record)
        self.assertEqual(self.failure_files(), [])

    def test_small_output_is_kept_whole(self):
        self.assertEqual(self.gate('run', '--', self.suite(code=1)).returncode, 1)
        [record] = self.records()
        self.assertFalse(record['failure_output']['truncated'])
        # stdout and stderr are read by two threads, so their order is not fixed
        self.assertEqual(sorted(Path(record['failure_output']['path']).read_text().split()),
                         ['suite-err', 'suite-out'])

    def test_status_still_names_the_file_after_a_passing_rerun(self):
        self.gate('run', '--', self.failing_suite())
        path = self.records()[0]['failure_output']['path']
        (self.repo / 'app.py').write_text('x = 2\n')
        self.assertEqual(self.gate('run', '--', self.suite()).returncode, 0)
        shown = self.gate('status', '--limit', '1')
        self.assertIn(path, shown.stdout)
        self.assertNotIn('EXPIRED', shown.stdout)
        [entry] = self.status()['failure_outputs']
        self.assertEqual(entry['path'], path)
        self.assertEqual(entry['sha256'], self.records()[0]['failure_output']['sha256'])

    def test_output_expires_with_the_cleanup_window(self):
        self.gate('run', '--', self.failing_suite('one'))
        old = Path(self.records()[0]['failure_output']['path'])
        stale = time.time() - (gate.CLEANUP_DAYS + 1) * DAY
        os.utime(old, (stale, stale))
        self.assertEqual(self.gate('run', '--', self.failing_suite('two')).returncode, 1)
        self.assertFalse(old.exists())
        new = Path(self.records()[1]['failure_output']['path'])
        self.assertTrue(new.exists())
        shown = self.gate('status').stdout
        self.assertIn(f'{old} (', shown)
        self.assertIn('EXPIRED', shown)

    def test_live_file_of_a_gone_run_is_swept(self):
        folder = self.state / 'failures'
        folder.mkdir(parents=True)
        live = folder / 'live-1-abcd.log'
        live.write_text('x')
        stale = time.time() - 2 * DAY
        os.utime(live, (stale, stale))
        self.gate('run', '--', self.suite(code=1))
        self.assertFalse(live.exists())


class BoundTests(unittest.TestCase):
    def bound(self, lines, cap=3000):
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp, 'in'), Path(tmp, 'out')
            source.write_text('\n'.join(lines) + '\n')
            with mock.patch.multiple(gate, FAILURE_HEAD_BYTES=200, FAILURE_TAIL_BYTES=300,
                                     FAILURE_BLOCK_BYTES=800,
                                     FAILURE_BLOCK_MIN_BYTES=200, FAILURE_BLOCK_PREFIX_BYTES=40):
                cut = gate.bound_failure_output(source, target, cap)
            return cut, target.read_text()

    def test_every_failure_block_survives_in_each_runner_format(self):
        filler = [f'noise {i} ' + 'x' * 40 for i in range(300)]
        bun = (['bun test v1', 'a.test.ts:'] + [f'(pass) t{i} [1ms]' for i in range(50)]
               + ['error: expected BUN-ASSERT', '    at a.test.ts:3', '(fail) a > one [1.0ms]'])
        pytest = (['rootdir: /x'] + filler[50:100] + ['=== FAILURES ===',
                  '___ test_two ___', 'E   assert PYTEST-ASSERT', '___ test_three ___',
                  'E   assert PYTEST-THREE', '=== short test summary info ==='])
        unittest = (filler[100:150] + ['=' * 70, 'FAIL: test_four (m.C.test_four)',
                    '-' * 70, 'AssertionError: UNITTEST-ASSERT', '', '-' * 70,
                    'Ran 4 tests in 0.1s'])
        cut, text = self.bound(bun + pytest + unittest + filler[150:])
        self.assertTrue(cut)
        self.assertIn('TRUNCATED', text.splitlines()[0])
        for marker in ('BUN-ASSERT', 'PYTEST-ASSERT', 'PYTEST-THREE', 'UNITTEST-ASSERT'):
            self.assertIn(marker, text)
        self.assertIn('left out', text)
        self.assertLess(len(text), 3500)

    def test_output_within_the_cap_is_copied_whole(self):
        cut, text = self.bound(['one', 'two'])
        self.assertFalse(cut)
        self.assertEqual(text, 'one\ntwo\n')

    def test_a_long_block_is_cut_and_said_so(self):
        lines = ['x' * 50] * 100 + ['___ test_big ___'] + ['E   y' * 20] * 200 + ['=== end ===']
        cut, text = self.bound(lines + ['z' * 50] * 100, cap=2500)
        self.assertTrue(cut)
        self.assertIn('___ test_big ___', text)

    def test_multibyte_and_very_long_lines_stay_within_the_bound(self):
        lines = ['y' * 3_000_000] + ['失敗的輸出行，內容很長很長' * 20] * 6000 + ['尾端'] * 100
        cut, text = self.bound(lines, cap=100_000)
        self.assertTrue(cut)
        self.assertLess(len(text.encode()), 100_000 + 5000)
        self.assertIn('line cut', text)

    def test_long_pytest_test_name_block_is_found(self):
        filler = ['noise ' + 'x' * 40] * 200
        cut, text = self.bound(filler + ['_ test_a_very_long_parametrized_name[case-1] _',
                                         'E   assert LONG-NAME-ASSERT', '=== summary ==='] + filler)
        self.assertIn('LONG-NAME-ASSERT', text)

    def test_a_block_overlapping_the_head_is_not_written_twice(self):
        filler = ['noise ' + 'x' * 40] * 200
        cut, text = self.bound(['___ test_early ___', 'E   assert EARLY-ASSERT'] * 1 + filler)
        self.assertEqual(text.count('EARLY-ASSERT'), 1)

    def test_many_blocks_that_do_not_fit_are_all_kept_cut_to_their_share(self):
        filler = ['noise ' + 'x' * 40] * 40
        lines = list(filler)
        for i in range(30):
            lines += [f'___ test_{i} ___'] + [f'E   detail {i} ' + 'd' * 60] * 10 \
                + [f'E   assert FIRST-LINE-{i}', f'=== end {i} ===']
        lines += filler * 20
        cut, text = self.bound(lines, cap=3000)
        self.assertTrue(cut)
        for i in range(30):
            self.assertIn(f'assert FIRST-LINE-{i}', text)
            block = '\n'.join([f'___ test_{i} ___'] + [f'E   detail {i} ' + 'd' * 60] * 10)
            self.assertIn(block[:40], text, 'the first bytes of every block are kept')
        self.assertIn('middle of this failure block cut', text)
        self.assertLess(len(text.encode()), 3000 + 30 * 250, 'the total stays near the cap')

    def test_first_block_is_whole_and_the_file_stays_under_the_ceiling_in_the_worst_case(self):
        def body(i, count):
            return [f'___ test_{i} ___'] + [f'E   {i:04d} ' + 'z' * 3000] * count \
                + [f'E   assert LAST-LINE-{i}']
        lines = ['noise ' + 'x' * 100] * 3000
        blocks = [body(0, 20)] + [body(i, 40) for i in range(1, 1200)]  # the first is ~60 KiB
        for block in blocks:
            lines += block + ['=== end ===']
        lines += ['tail ' + 'y' * 100] * 3000
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp, 'in'), Path(tmp, 'out')
            source.write_text('\n'.join(lines) + '\n')
            self.assertTrue(gate.bound_failure_output(source, target))
            data = target.read_bytes()
        self.assertLessEqual(len(data), gate.FAILURE_CEILING_BYTES)
        text = data.decode()
        self.assertIn('\n'.join(blocks[0]), text, 'the first block is kept whole')
        for i in (1, 2, 500, 999):
            joined = '\n'.join(blocks[i])
            self.assertIn(joined[:gate.FAILURE_BLOCK_PREFIX_BYTES], text,
                          f'block {i} keeps exactly its first 1 KiB')
            self.assertIn(f'assert LAST-LINE-{i}', text)
        self.assertIn('more were not collected', text.splitlines()[0])

    def test_a_long_block_keeps_its_assertion_message_at_the_end(self):
        lines = ['noise ' + 'x' * 100] * 2000
        for i in range(40):
            lines += [f'___ test_{i} ___'] + [f'    context {i} ' + 'c' * 100] * 600 \
                + [f'E   AssertionError: MSG-{i}', '=== end ===']
        lines += ['tail ' + 'y' * 100] * 2000
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp, 'in'), Path(tmp, 'out')
            source.write_text('\n'.join(lines) + '\n')
            self.assertTrue(gate.bound_failure_output(source, target))
            data = target.read_bytes()
        text = data.decode()
        for i in range(40):
            self.assertIn(f'MSG-{i}', text)
        self.assertIn(f'___ test_0 ___', text)
        self.assertLessEqual(len(data), gate.FAILURE_CEILING_BYTES)

    def test_long_lines_do_not_stop_a_block_from_being_whole_or_a_prefix_from_being_exact(self):
        first = ['___ test_first ___', 'E   ' + 'L' * 20000, 'E   assert FIRST-END']  # ~20 KB
        lines = ['noise ' + 'x' * 100] * 3000 + first + ['=== end ===']
        later = []
        for i in range(200):
            block = [f'___ test_{i} ___', 'E   ' + 'M' * 10000, f'E   assert LATE-END-{i}']
            later.append(block)
            lines += block + ['=== end ===']
        lines += ['padding ' + 'p' * 100] * 12000 + ['tail ' + 'y' * 100] * 3000
        with tempfile.TemporaryDirectory() as tmp:
            source, target = Path(tmp, 'in'), Path(tmp, 'out')
            source.write_text('\n'.join(lines) + '\n')
            self.assertTrue(gate.bound_failure_output(source, target))
            text = target.read_text()
        self.assertIn('\n'.join(first), text, 'a block under 64 KiB is whole around a long line')
        for i in (0, 100, 199):
            joined = '\n'.join(later[i])
            self.assertIn(joined[:gate.FAILURE_BLOCK_PREFIX_BYTES], text)
            self.assertIn(f'LATE-END-{i}', text)

    def test_output_past_the_live_copy_cap_keeps_its_last_bytes(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.dict(os.environ, {'SUITE_GATE_STATE_DIR': tmp}), \
                mock.patch.multiple(gate, FAILURE_SPOOL_BYTES=5000, FAILURE_LATE_BYTES=300):
            path, spool = gate.spool_open()
            tail = gate.Tail(spool)
            tail.spool_path = path
            for i in range(400):
                tail.add(f'line {i:04d} ' .encode() + b'-' * 20 + b'\n')
            tail.add(b'LAST-FAILURE-SUMMARY\n')
            kept = gate.keep_failure_output(tail, path)
            text = Path(kept['path']).read_text()
        self.assertTrue(kept['truncated'])
        self.assertTrue(text.startswith('[CAPTURE STOPPED at 5000 bytes'), text[:120])
        self.assertIn('not examined', text.splitlines()[0])
        self.assertTrue(text.rstrip().endswith('LAST-FAILURE-SUMMARY'))
        self.assertIn('LAST-FAILURE-SUMMARY', text)
        self.assertIn('line 0399', text)
        self.assertNotIn('line 0300', text, 'only the last bytes follow the marker')
        self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
