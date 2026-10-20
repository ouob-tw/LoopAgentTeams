"""review-size suggestion contracts through the command entry point."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/review-size.py'


class ReviewSizeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git('init', '-q', '-b', 'main')
        self.write('app.py', 1)
        self.commit('base')
        self.base = self.git('rev-parse', 'HEAD').strip()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), '-c', 'user.name=t', '-c', 'user.email=t@t',
                               *args], check=True, capture_output=True, text=True).stdout

    def write(self, path, count):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(''.join(f'line {i}\n' for i in range(count)))

    def commit(self, message):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message)

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True,
                              cwd=self.repo)

    def assert_suggests(self, who, reason):
        result = self.cli(self.base)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'建議：{who}', result.stdout)
        self.assertIn(reason, result.stdout)

    def test_small_code_change_gets_one_reviewer(self):
        self.write('src/util.py', 59)  # +59 here and +1 in app.py: 60 code lines, at the threshold
        self.write('app.py', 2)
        self.write('tests/test_util.py', 300)
        self.commit('small')
        self.assert_suggests('一位（Standards）', '小改動：程式改動 60 行 ≤ 60')

    def test_tests_only_gets_one_reviewer_regardless_of_size(self):
        self.write('tests/test_a.py', 400)
        self.write('board/src/view.test.ts', 200)
        self.write('pkg/handler_test.go', 100)
        self.commit('tests')
        self.assert_suggests('一位（Standards）', '只改測試或文件（程式 0 檔 0 行，測試 3 檔 700 行')

    def test_docs_only_gets_one_reviewer_regardless_of_size(self):
        self.write('skills/x/SKILL.md', 300)
        self.write('docs/adr/0001.txt', 50)
        self.commit('docs')
        self.assert_suggests('一位（Standards）', '只改測試或文件（程式 0 檔 0 行，測試 0 檔 0 行，文件 2 檔 350 行）')

    def test_regular_code_change_gets_two_reviewers(self):
        self.write('src/feature.py', 61)
        self.commit('feature')
        self.assert_suggests('兩位（Standards ＋ Spec）', '程式改動 61 行 > 60')

    def test_rename_counts_only_changed_lines_of_the_new_path(self):
        self.write('src/big.py', 200)
        self.commit('big')
        self.base = self.git('rev-parse', 'HEAD').strip()
        (self.repo / 'tests').mkdir()
        self.git('mv', 'src/big.py', 'tests/test_big.py')
        self.commit('move into tests')
        self.assert_suggests('一位（Standards）', '程式 0 檔 0 行，測試 1 檔 0 行')

    def test_unknown_base_exits_2_with_git_error(self):
        result = self.cli('no-such-ref')
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertIn('no-such-ref', result.stderr)


if __name__ == '__main__':
    unittest.main()
