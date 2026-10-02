"""CJK-aware soft wrap for the LAT panel editor (herdr-panel/cjk_wrap.py).

Run with Textual available:
  uv run --no-project --with textual==8.2.8 python -m unittest discover -s "$lat_dir/tests"
"""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERDR_PANEL = Path(__file__).resolve().parents[1] / "herdr-panel"
HAS_TEXTUAL = importlib.util.find_spec("textual") is not None

SAMPLES = (
    "本機和 GitHub 都更新；repo 是公開的，程式碼會公開（已查過沒有本機路徑或個人資料）。",
    "dev 有了面板程式，之後執行 skill 更新就不會再把面板蓋掉；GitHub 不變，推送可之後和其他提交一起做。",
)


@unittest.skipUnless(HAS_TEXTUAL, "needs textual==8.2.8 (uv run --with textual==8.2.8)")
class CJKWrapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if str(HERDR_PANEL) not in sys.path:
            sys.path.insert(0, str(HERDR_PANEL))
        import cjk_wrap
        from rich.cells import cell_len
        from textual import _wrap
        from textual.document import _wrapped_document

        cls.cjk_wrap, cls.textual_wrap = cjk_wrap, _wrap
        cls.wrapped_document = _wrapped_document
        cls.cell_len = staticmethod(cell_len)

    def wrap(self, text, width):
        offsets = self.cjk_wrap.compute_wrap_offsets(text, width, 4)
        bounds = [0, *offsets, len(text)]
        return [text[start:end] for start, end in zip(bounds, bounds[1:])]

    def test_private_textual_hook_is_pinned_and_installed_by_panel(self):
        import textual

        # Fails loudly when the pinned Textual internals this hook relies on change.
        self.assertEqual(textual.__version__, "8.2.8")
        self.assertEqual(self.textual_wrap.re_chunk.pattern, r"\S+\s*|\s+")
        self.assertIn("chunks", self.textual_wrap.compute_wrap_offsets.__code__.co_names)
        document = self.wrapped_document.WrappedDocument
        for method in (document.wrap, document.wrap_range):
            self.assertIn("compute_wrap_offsets", method.__code__.co_names)
        with patch.object(
            self.wrapped_document, "compute_wrap_offsets", self.textual_wrap.compute_wrap_offsets
        ):
            spec = importlib.util.spec_from_file_location(
                "lat_panel_wrap_check", HERDR_PANEL / "panel.py"
            )
            spec.loader.exec_module(importlib.util.module_from_spec(spec))
            self.assertEqual(self.textual_wrap.chunks.__module__, "textual._wrap")
            self.assertIs(
                self.wrapped_document.compute_wrap_offsets, self.cjk_wrap.compute_wrap_offsets
            )

    def test_real_user_samples_fill_lines_without_avoidable_gaps(self):
        self.assertEqual(self.wrap(SAMPLES[0], 24), [
            "本機和 GitHub 都更新；",
            "repo 是公開的，程式碼會",
            "公開（已查過沒有本機路徑",
            "或個人資料）。",
        ])
        self.assertEqual(self.wrap(SAMPLES[1], 40), [
            "dev 有了面板程式，之後執行 skill 更新就",
            "不會再把面板蓋掉；GitHub 不變，推送可之",
            "後和其他提交一起做。",
        ])
        for text in SAMPLES:
            for width in range(8, 81):
                with self.subTest(text=text[:6], width=width):
                    lines = self.wrap(text, width)
                    self.assertEqual("".join(lines), text)
                    for line, following in zip(lines, lines[1:]):
                        self.assertLessEqual(self.cell_len(line), width)
                        # The next unbreakable piece must not fit; a CJK piece is a
                        # single character unless kinsoku glued a mark to it.
                        _, _, piece = next(self.cjk_wrap.chunks(following))
                        self.assertGreater(self.cell_len(line + piece), width)
                        word = piece.rstrip()
                        if self.cjk_wrap.is_cjk(word[0]) and len(word) > 1:
                            self.assertTrue(
                                word[0] in self.cjk_wrap.NO_END
                                or word[1] in self.cjk_wrap.NO_START,
                                (line, following),
                            )

    def test_kinsoku_keeps_closing_marks_off_line_starts_and_openers_off_ends(self):
        cases = (
            ("一二三四五，六", 10, ["一二三四", "五，六"]),
            ("一二三四五……六", 10, ["一二三四", "五……六"]),
            ("一二三「四五」", 8, ["一二三", "「四五」"]),
            ("中文中文中文)", 12, ["中文中文中", "文)"]),
            ("中文中文 GitHub）好", 14, ["中文中文 ", "GitHub）好"]),
            ("中文中文中 。", 10, ["中文中文", "中 。"]),
        )
        for text, width, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(self.wrap(text, width), expected)

    def test_folded_over_wide_words_keep_kinsoku(self):
        cases = (
            ("中文https://example.com/abcdefghijklmnopqrst）好", 20,
             ["中文", "https://example.com/", "abcdefghijklmnopqrs", "t）好"]),
            ("abcdefghij）。好", 10, ["abcdefghi", "j）。好"]),
            ("（（（（（（", 4, ["（（", "（（", "（（"]),
        )
        for text, width, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(self.wrap(text, width), expected)
        # From width 6 every character plus its glued marks fits on one line.
        for width in range(6, 30):
            for text in (cases[0][0], cases[0][0] + "\t尾", "abcdefghijklmnopqr\t）好",
                         "abcde（\t" + "y" * 30, "說明：" + "x" * 50 + "」，結束"):
                with self.subTest(text=text[:6], width=width):
                    lines = self.wrap(text, width)
                    self.assertEqual("".join(lines), text)
                    for line in lines:
                        self.assertLessEqual(self.cell_len(line), width)
                    for line in lines[1:]:
                        self.assertNotIn(line[0], self.cjk_wrap.CJK_NO_START)
                    for line in lines[:-1]:
                        self.assertNotIn(line.rstrip()[-1], self.cjk_wrap.CJK_NO_END)

    def test_long_lines_wrap_through_the_installed_document_hook(self):
        from textual.document._document import Document

        text = "abcdefghij）。好 " * 1100
        with patch.object(
            self.wrapped_document, "compute_wrap_offsets", self.cjk_wrap.compute_wrap_offsets
        ):
            document = self.wrapped_document.WrappedDocument(Document(text), width=10)
        offsets = document.get_offsets(0)
        self.assertEqual(len(offsets) + 1, document.height)
        self.assertFalse(any(text[offset] in self.cjk_wrap.CJK_NO_START for offset in offsets))

    def test_latin_words_numbers_and_urls_stay_whole_and_english_is_unchanged(self):
        self.assertEqual(
            self.wrap("中文中文 https://example.com/x 中文", 24),
            ["中文中文 ", "https://example.com/x 中", "文"],
        )
        self.assertEqual(self.wrap("版本2026年10月", 6), ["版本", "2026年", "10月"])
        english = (
            "Keep Latin words whole; fold only words longer than the width.",
            "see https://example.com/a/very/long/path/that/exceeds/the/width ok",
            "  indented\ttabs\tand  double  spaces ",
            "",
        )
        for text in english:
            for width in range(1, 41):
                with self.subTest(text=text[:10], width=width):
                    self.assertEqual(
                        self.cjk_wrap.compute_wrap_offsets(text, width, 4),
                        self.textual_wrap.compute_wrap_offsets(text, width, 4),
                    )

    def test_wide_characters_never_split_or_overflow(self):
        for text in ("한국어문장입니다한국어", "ひらがなカタカナ漢字", "ＡＢＣ１２３"):
            for width in range(2, 13):
                with self.subTest(text=text, width=width):
                    lines = self.wrap(text, width)
                    self.assertEqual("".join(lines), text)
                    self.assertTrue(all(self.cell_len(line) <= width for line in lines))
                    self.assertTrue(all(width - self.cell_len(line) <= 1 for line in lines[:-1]))


if __name__ == "__main__":
    unittest.main()
