"""Size and map checks for the references lat-session inlines into the Claude recovery prompt.

Kept apart from test_lat_session.py so an edit to those references runs only these tests.
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-session.py'
SKILL = SCRIPT.parent.parent


class InlineReferenceBudgetTests(unittest.TestCase):
    """The references lat-session inlines into the Claude recovery prompt, by its own list."""
    # Same budget as test_recovery_inlines_dispatch_references_for_claude_only in
    # test_lat_session.py: path fields stripped, under 9,000 of the 10,000 characters
    # Claude Code shows in full.
    BUDGET = 9_000

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('lat_session_budget', SCRIPT)
        cls.session = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.session)

    def sized(self, skill_dir):
        text = self.session.pointer('', dict(client='claude', skill_dir=str(skill_dir)))
        for name in self.session.INLINE_REFERENCES:
            reference = Path(skill_dir) / name
            self.assertIn(f'===== {reference} =====\n{reference.read_text()}', text)
            text = text.replace(f'===== {reference} =====\n', '===== =====\n', 1)
        return len(text)

    def test_inlined_references_fit_the_budget(self):
        size = self.sized(SKILL)
        self.assertLess(size, self.BUDGET, f'inlined references total {size} characters; '
                        'shorten them or move detail out of INLINE_REFERENCES')

    def test_the_budget_counts_every_inlined_reference(self):
        room = self.BUDGET - self.sized(SKILL)
        for grown in self.session.INLINE_REFERENCES:
            with self.subTest(reference=grown), tempfile.TemporaryDirectory() as tmp:
                for name in self.session.INLINE_REFERENCES:
                    target = Path(tmp) / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    text = (SKILL / name).read_text()
                    target.write_text(text + 'x' * room if name == grown else text)
                self.assertGreaterEqual(self.sized(tmp), self.BUDGET)

    def test_the_affected_test_map_sends_each_inlined_reference_here(self):
        root = SKILL.parents[2]
        gate = SKILL.parent / 'three-tier-testing/scripts/suite-gate.py'
        if not (root / '.suite-gate.json').is_file() or not gate.is_file():
            self.skipTest('not run from the LoopAgentTeams repo')
        spec = importlib.util.spec_from_file_location('suite_gate_map', gate)
        suite_gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(suite_gate)
        amap = suite_gate.read_map(suite_gate.load_registry(root))
        here = str(Path(__file__).resolve().relative_to(root))
        for name in self.session.INLINE_REFERENCES:
            path = str((SKILL / name).relative_to(root))
            with self.subTest(reference=path):
                selected, fallback = suite_gate.select_tests(root, [path], amap)
                self.assertEqual(fallback, [])
                self.assertIn(here, selected)


if __name__ == '__main__':
    unittest.main()
