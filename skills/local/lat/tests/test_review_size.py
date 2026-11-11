"""review-size suggestion contracts through the command entry point."""
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/review-size.py'


class RepoCase(unittest.TestCase):
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


class ReviewSizeTests(RepoCase):
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


class TinyCheckTests(RepoCase):
    """`--tiny`: the hard line limit and the hints, through the command entry point."""

    def tiny(self, *extra):
        return self.cli(self.base, '--tiny', *extra)

    def test_thirty_added_code_lines_pass_and_thirty_one_are_refused(self):
        self.write('src/fix.py', 29)
        self.write('app.py', 2)  # +1: 30 added code lines
        self.write('tests/test_fix.py', 200)
        self.commit('fix: thirty')
        result = self.tiny()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('code-touching, 30 added code lines (limit 30', result.stdout)
        self.write('app.py', 3)
        self.commit('fix: one more')
        result = self.tiny()
        self.assertEqual(result.returncode, 1)
        self.assertIn('refused: 31 added code lines', result.stdout)
        self.assertIn('return to the normal flow', result.stdout)

    def test_docs_skill_text_and_tests_only_pass_at_any_size(self):
        self.write('skills/x/SKILL.md', 300)
        self.write('docs/notes.txt', 80)
        self.write('tests/test_a.py', 500)
        self.commit('docs: many lines')
        result = self.tiny()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('docs/skill-text/test-only, 0 added code lines', result.stdout)

    def test_format_patterns_and_feat_commits_are_hints_not_refusals(self):
        self.write('db/migrations/0002_add.sql', 3)
        self.commit('feat(db): add a column')
        result = self.tiny()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('hint: data/format file db/migrations/0002_add.sql (pattern *migrations/*)',
                      result.stdout)
        self.assertRegex(result.stdout, r'hint: feat commit [0-9a-f]{12} feat\(db\): add a column')
        self.assertIn('--tiny-hints', result.stdout)

    def test_the_project_setting_replaces_the_default_patterns(self):
        (self.repo / '.suite-gate.json').write_text(
            '{"tiny_lane": {"format_patterns": ["store/*.json"]}}')
        self.write('store/records.json', 2)
        self.write('db/schema.sql', 2)
        self.commit('fix: data')
        result = self.tiny()
        self.assertIn('hint: data/format file store/records.json (pattern store/*.json)',
                      result.stdout)
        self.assertNotIn('schema.sql', result.stdout)

    def test_changes_the_integration_branch_brought_in_do_not_count(self):
        self.git('switch', '-q', '-c', 'work')
        self.write('src/own.py', 5)
        self.commit('fix: own')
        before = re.search(r'\(content (\w+)\)', self.tiny().stdout)[1]
        self.git('switch', '-q', 'main')
        self.write('app.py', 3)  # the integration branch also edits a file near the work
        self.write('src/other.py', 100)
        self.commit('feat: other ticket')
        self.git('switch', '-q', 'work')
        self.git('merge', '-q', '--no-edit', 'main')
        self.assertIn('refused: 107', self.tiny().stdout)
        result = self.tiny('--integration', 'main')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('5 added code lines', result.stdout)
        self.assertNotIn('feat commit', result.stdout)
        self.assertIn(f'(content {before})', result.stdout, 'the own change is the same')


if __name__ == '__main__':
    unittest.main()
