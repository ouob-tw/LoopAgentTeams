"""Consensus validator contracts through the command entry point."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-consensus.py'


class ConsensusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.record = self.root / 'SPEC.md'
        self.record.write_text('- status: pending\n- advisor: exempt spec-confirmation\n')

    def cli(self, text, *args):
        return subprocess.run([sys.executable, str(SCRIPT), '--spec', '-', *map(str, args)],
                              input=text, text=True, capture_output=True, cwd=self.root)

    def test_v1_check_only_prints_receipt_without_writing(self):
        before = self.record.read_bytes()
        result = self.cli('**共識 v1**\n- **位置**：只放在最上面。\n\n# Spec\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r'^- consensus: v1 [0-9a-f]{64}\n$')
        self.assertEqual(self.record.read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ['SPEC.md'])

    def test_quoted_marker_example_is_prose_in_live_spec(self):
        text = '**共識 v3**\n- **更新**：行尾標「（v3 改）」這類記號。\n# Spec\n'
        result = self.cli(text)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_valid_versions_reserved_topics_and_unconfirmed_changes(self):
        cases = [
            '**共識 v2**\n- **目標**：完成。（v2 改）\n',
            '**共識 v3**\n- **目標**：完成。（v2 改）\n  - 加上說明。（v3 改）\n',
            '**共識 v3**\n- **目標**：完成。\n- **已拿掉**：以下項目已移除。\n  - 舊主題。（v2 改）\n- **不做**：不安裝。\n- **你要留意**：需自行閱讀。\n',
            '**共識 v1**\n- **不做**：不安裝。\n- **你要留意**：需自行閱讀。\n',
        ]
        for text in cases:
            with self.subTest(text=text):
                result = self.cli(text + '# Spec\n')
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_structures_report_lines_and_preserve_record(self):
        bodies = [
            '# Spec\n正文', '開場\n**共識 v1**\n- **主題**：結論',
            '**共識 v0**\n- **主題**：結論', '**共識 v1*\n- **主題**：結論',
            '**共識 v1**\n\n# Spec',
            '**共識 v1**\n- 主題：結論', '**共識 v1**\n- **主題**:結論',
            '**共識 v1**\n- **主題**： ', '**共識 v1**\n- ****：結論',
            '**共識 v1**\n  - 沒有父項',
            '**共識 v1**\n- **主題**：結論\n    - 第三層',
            '**共識 v1**\n- **主題**：結論\n其他段落',
            '**共識 v1**\n- **不做**：結論\n- **主題**：結論',
            '**共識 v1**\n- **你要留意**：結論\n- **不做**：結論',
            '**共識 v2**\n- **不做**：結論\n- **已拿掉**：結論',
            '**共識 v1**\n- **已拿掉**：結論',
            '**共識 v1**\n- **主題**：結論（v1 改）',
            '**共識 v2**\n- **主題**：結論（v1 改）',
            '**共識 v2**\n- **主題**：結論（v3 改）',
            '**共識 v2**\n- **主題**：結論（v2改）',
            '**共識 v2**\n- **主題**：結論（v2 改）尾巴',
            '**共識 v2**\n- **主題**：結論(v2 改)',
        ]
        before = self.record.read_bytes()
        for text in bodies:
            with self.subTest(text=text):
                result = self.cli(text, '--decisions', self.root, '--decision-id', 'SPEC')
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr, r'第 [0-9]+ 行：.+')
                self.assertEqual(result.stdout, '')
                self.assertEqual(self.record.read_bytes(), before)

    def test_last_confirmed_version_bounds_markers(self):
        text = '**共識 v3**\n- **主題**：結論（v2 改）\n  - 補充（v3 改）\n'
        self.assertEqual(self.cli(text, '--last-confirmed-version', '1').returncode, 0)
        before = self.record.read_bytes()
        result = self.cli(text, '--last-confirmed-version', '2', '--decisions', self.root,
                          '--decision-id', 'SPEC')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('第 2 行：記號版本須大於上次確認版本 v2', result.stderr)
        self.assertEqual(self.record.read_bytes(), before)

    def test_receipt_updates_deduplicates_and_is_stable(self):
        self.record.write_text(self.record.read_text() + '- consensus: broken\n- CONSENSUS: old\n')
        args = ('--decisions', self.root, '--decision-id', 'SPEC')
        text = '**共識 v1**\n- **主題**：結論\n\n# Spec\n'
        first = self.cli(text, *args)
        self.assertEqual(first.returncode, 0, first.stderr)
        saved = self.record.read_bytes()
        self.assertEqual(self.record.read_text().count('- consensus:'), 1)
        self.assertIn(first.stdout.strip(), self.record.read_text())
        second = self.cli(text, *args)
        self.assertEqual(second.stdout, first.stdout)
        self.assertEqual(self.record.read_bytes(), saved)
        normalized = self.cli('\n \n**共識 v1**  \n- **主題**：結論\t \n \n\n# Different body\n', *args)
        self.assertEqual(normalized.stdout, first.stdout)
        self.assertEqual(self.record.read_bytes(), saved)
        changed = self.cli(text.replace('結論', '改動結論'), *args)
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertNotEqual(changed.stdout, first.stdout)
        self.assertEqual(self.record.read_text().count('- consensus:'), 1)

    def test_file_input_and_missing_record_do_not_create_record(self):
        spec = self.root / 'body.md'
        spec.write_text('**共識 v1**\n- **主題**：結論\n# Spec\n')
        result = self.cli('', '--spec', spec, '--decisions', self.root, '--decision-id', 'MISSING')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('共識檢查錯誤', result.stderr)
        self.assertFalse((self.root / 'MISSING.md').exists())
        result = self.cli('', '--spec', spec)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_invalid_arguments_and_unreadable_input_fail_without_writing(self):
        before = self.record.read_bytes()
        for args in (('--decision-id', 'SPEC'), ('--decision-id', '../SPEC', '--decisions', self.root),
                     ('--last-confirmed-version', '0'), ('--spec', self.root / 'absent.md')):
            with self.subTest(args=args):
                result = self.cli('**共識 v1**\n- **主題**：結論', *args)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.record.read_bytes(), before)
