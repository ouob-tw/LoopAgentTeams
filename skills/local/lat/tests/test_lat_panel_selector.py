"""Headless Textual tests for the V2 selector mode of the LAT panel popup.

Run with Textual available:
  uv run --no-project --with textual==8.2.8 python -m unittest discover -s "$lat_dir/tests"
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time
import unittest
from unittest.mock import patch

from test_lat_panel_ui import HAS_TEXTUAL, HERDR_PANEL, PanelTestCase

SINGLE = (
    "## 正式版要怎麼併入？\nQ1 · r1 · 待答\n\n"
    "審查和驗收都通過了，現在只差要不要把它併進 dev。\n\n"
    "A. 合併到 dev，不推送\n   dev 有了面板程式。\n"
    "B. 合併到 dev，並推送到 GitHub（建議）\n   repo 是公開的，程式碼會公開。\n"
    "C. 先不合併\n   繼續保留在目前分支。\n\n"
    "答覆：\n\n- [ ] 送出\n"
)
MULTI = (
    "## 要開哪些功能？\nQ2 · r1 · 待答\n\n選所有需要的。\n\n"
    "- [ ] 主控綁定\n  綁定 tab。\n- [ ] 封存\n- [ ] 通知\n\n"
    "答覆：\n\n- [ ] 送出\n"
)
TEXT = "## 還有什麼想法？\nQ3 · r1 · 待答\n\n請自由回答。\n\n答覆：\n\n- [ ] 送出\n"
# The question the real user answered when reporting that the view cannot scroll.
CHECK = (
    "## V2 選擇框用起來符合你要的樣子嗎？\nQ1 · r1 · 待答\n\n"
    "V2 已經裝好了。這題是實際試用，請用 Ctrl+A → a 打開面板，用選擇框作答。\n\n"
    "A. 符合，可以結案（建議）\n   我會收尾：清掉 V2 分支與暫存工作區、關閉 #27 與 #30。\n"
    "B. 大致可以，但有地方想改\n   請按 Tab 在備註寫想改的地方；我會先整理成新的提案再問你。\n"
    "C. 不符合，先別結案\n   請在備註寫原因。\n\n"
    "答覆：\n\n- [ ] 送出\n"
)
RECORDED = (
    "## 舊題目\nQ0 · r1 · 已記錄 · 2026-10-02T09:00:00+00:00\n\n"
    "A. Done\n\n答覆：A. Done\n\n- [x] 送出\n"
)


def section(text, question_id):
    start = text.index(f"\n{question_id} · ")
    start = text.rindex("## ", 0, start)
    following = text.find("\n## ", start + 1)
    return text[start:] if following < 0 else text[start:following + 1]


@unittest.skipUnless(HAS_TEXTUAL, "needs textual==8.2.8 (uv run --with textual==8.2.8)")
class SelectorTestCase(PanelTestCase):
    def setUp(self):
        super().setUp()
        self.questions.write_text("\n".join((RECORDED, SINGLE, MULTI, TEXT)))

    def view(self, app):
        """The question text without its focus-bar column."""
        return "\n".join(line[1:] for line in str(app.query_one("#view").render()).split("\n"))

    def screen(self, app):
        """The terminal rows as drawn, so scrolled-off content is absent."""
        return "\n".join(
            "".join(segment.text for segment in strip).rstrip()
            for strip in app.screen._compositor.render_strips()
        )

    def rows(self, app):
        """Screen rows without the scrollbar thumb."""
        return [re.sub(r"\s+[▁-█]+$", "", line) for line in self.screen(app).splitlines()]

    def focused(self, app):
        """Screen rows carrying the focus bar."""
        return [line for line in self.rows(app) if line.startswith("▌")]

    def tabs(self, app):
        return str(app.query_one("#tabs").render())

    def keys(self, app):
        return str(app.query_one("#keys").render())

    def text(self):
        return self.questions.read_text()

    def journal(self):
        path = self.questions.parent / "panel-journal.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    async def press(self, pilot, *keys):
        """Press keys; ``@options`` steps the focus down to the first option."""
        for key in keys:
            if key != "@options":
                await pilot.press(key)
                continue
            for _ in range(50):
                if pilot.app.current.cursor is not None:
                    break
                await pilot.press("down")
                await pilot.pause()
            else:
                self.fail("the focus never reached an option")
        await pilot.pause()


class LayoutTests(SelectorTestCase):
    async def test_opens_on_pending_tabs_with_options_impacts_and_footer(self):
        app = self.make_app()
        async with app.run_test(size=(80, 30)):
            self.assertEqual(
                self.tabs(app), "← ☐ 正式版要怎麼併…   ☐ 要開哪些功能？   ☐ 還有什麼想法？   ✔ 送出 →",
            )
            self.assertEqual(app.tab_ids, ["Q1", "Q2", "Q3"])
            self.assertEqual(self.view(app).splitlines(), [
                "正式版要怎麼併入？",
                "",
                "審查和驗收都通過了，現在只差要不要把它併進 dev。",
                "",
                "  A. 合併到 dev，不推送",
                "     dev 有了面板程式。",
                "  B. 合併到 dev，並推送到 GitHub（建議）",
                "     repo 是公開的，程式碼會公開。",
                "  C. 先不合併",
                "     繼續保留在目前分支。",
                "  D. 其他（自己輸入）",
            ])
            self.assertEqual(self.keys(app), "A–I／Enter 選擇 · ↑↓ 移動 · ←→ 換題 · Tab 備註 · Esc 關閉")
            self.assertEqual(self.status(app), "")

    async def test_view_wraps_mixed_cjk_text_between_characters(self):
        sample = "本機和 GitHub 都更新；repo 是公開的，程式碼會公開（已查過沒有本機路徑或個人資料）。"
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", sample))
        app = self.make_app()
        async with app.run_test(size=(27, 30)):
            self.assertEqual(self.view(app).splitlines()[2:6], [
                "本機和 GitHub 都更新；",
                "repo 是公開的，程式碼會",
                "公開（已查過沒有本機路",
                "徑或個人資料）。",
            ])

    async def test_no_pending_questions_shows_one_line_and_esc_closes(self):
        self.questions.write_text(RECORDED)
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(self.view(app), "目前沒有待答問題")
            self.assertEqual(self.tabs(app), "")
            await self.press(pilot, "1", "enter", "right")
            self.assertEqual(self.text(), RECORDED)
            await self.press(pilot, "ctrl+e")
            self.assertEqual(app.editor.text, RECORDED)
            await self.press(pilot, "ctrl+e")
            await pilot.press("escape")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)

    async def test_ctrl_q_closes_main_view_without_notification(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "2")
            await pilot.press("ctrl+q")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.pending())


class SingleSelectTests(SelectorTestCase):
    async def test_arrows_move_without_writing_and_stop_at_both_ends(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            before = self.text()
            await self.press(pilot, "up", "@options", "down", "down", "up")
            self.assertEqual(app.current.cursor, 1)
            await self.press(pilot, "down", "down", "down", "down")
            self.assertEqual(app.current.cursor, 3)
            self.assertIn("❯ D. 其他（自己輸入）", self.view(app))
            await self.press(pilot, *["up"] * 8)
            self.assertEqual(app.current.focus[:3], ("text", 0, 0))
            self.assertNotIn("❯", self.view(app))
            self.assertEqual(self.text(), before)

    async def test_digit_and_enter_write_a_single_draft_that_replaces_the_last(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "2")
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub\n\n- [ ] 送出", section(self.text(), "Q1"))
            self.assertIn("☒ 正式版要怎麼併…", self.tabs(app))
            self.assertIn("B. 合併到 dev，並推送到 GitHub（建議）  ✔", self.view(app))
            await self.press(pilot, "down", "enter")
            self.assertIn("答覆：C. 先不合併\n\n- [ ] 送出", section(self.text(), "Q1"))
            await self.press(pilot, "9")
            self.assertIn("答覆：C. 先不合併\n", self.text())
            self.assertEqual(self.journal()[-1]["kind"], "answer-write")
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.pending())

    async def test_other_opens_multiline_input_and_esc_only_leaves_it(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "4")
            self.assertIs(app.focused, app.input)
            self.assertEqual(self.keys(app), "Enter 換行 · Esc 離開輸入框")
            await self.press(pilot, *"ab", "enter", *"cd")
            self.assertIn("答覆：其他：ab\ncd\n\n- [ ] 送出", self.text())
            await self.press(pilot, "escape")
            self.assertIsNone(app.return_code)
            self.assertIsNone(app.focused)
            self.assertIn("其他（自己輸入）  ✔", self.view(app))
            await self.press(pilot, "enter", *["backspace"] * 5, "escape")
            self.assertIn("答覆：\n\n- [ ] 送出", section(self.text(), "Q1"))
            self.assertNotIn("✔", self.view(app))

    async def test_typing_on_the_other_row_goes_straight_into_its_text(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(pilot, "@options", "down", "down", "down", "a")
            self.assertIs(app.focused, app.input)
            await self.press(pilot, "1", "space", "b")
            self.assertEqual(app.input.text, "a1 b")
            self.assertIn("答覆：其他：a1 b\n\n- [ ] 送出", self.text())
            screen = self.screen(app)
            self.assertIn("❯ D. 其他（自己輸入）  ✔", screen)
            self.assertIn("Q1 其他（自己輸入）", screen)
            await self.press(pilot, "escape", "c")
            self.assertEqual(app.input.text, "a1 bc")
            await self.press(pilot, "escape", "up", "1")
            self.assertIn("答覆：A. 合併到 dev，不推送\n", self.text())

    async def test_typing_on_the_other_row_checks_it_in_multi_select(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "1", "down", "down", "down", "x", "space", "2")
            self.assertEqual(app.input.text, "x 2")
            self.assertIn("答覆：主控綁定；其他：x 2\n", self.text())

    async def test_space_selects_the_option_and_stays_on_the_question(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "down", "space")
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub\n", self.text())
            self.assertEqual(app.current.id, "Q1")
            self.assertIn("❯ B. 合併到 dev，並推送到 GitHub（建議）  ✔", self.view(app))

    async def test_enter_selects_a_single_option_and_moves_to_the_next_tab(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "down", "enter")
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub\n", self.text())
            self.assertEqual(app.current.id, "Q2")
            await self.press(pilot, "left", "2")
            self.assertEqual(app.current.id, "Q1")
            await self.press(pilot, "down", "down", "enter")
            self.assertEqual(app.current.id, "Q1")
            self.assertIs(app.focused, app.input)

    async def test_enter_on_the_last_single_question_moves_to_the_review_tab(self):
        self.questions.write_text(SINGLE)
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "enter")
            self.assertIsNone(app.current)
            self.assertIn("❯ Enter 送出 1 題", self.view(app))
            self.assertIn("- [ ] 送出", self.text())

    async def test_tab_selects_the_option_and_opens_its_note(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "down", "tab")
            self.assertIs(app.focused, app.input)
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub\n", self.text())
            await self.press(pilot, *"why", "enter", *"more", "escape")
            self.assertIn(
                "答覆：B. 合併到 dev，並推送到 GitHub\n備註：why\nmore\n\n- [ ] 送出", self.text(),
            )
            self.assertIn("備註：why", self.view(app))
            self.assertEqual(self.status(app), "")
            self.assertEqual(app.current.id, "Q1")
            await self.press(pilot, "enter")
            self.assertEqual(app.current.id, "Q2")
            self.assertIn("備註：why\nmore\n", section(self.text(), "Q1"))

    async def test_enter_stays_on_the_question_when_the_choice_was_not_saved(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "tab", "n", "enter", *"- [x]", "space", *"送出", "escape")
            self.assertIn("這次輸入沒有儲存", self.status(app))
            await self.press(pilot, "down", "enter")
            self.assertEqual(app.current.id, "Q1")
            self.assertIn("答覆：A. 合併到 dev，不推送\n", self.text())

    async def test_tab_on_the_other_row_needs_other_to_be_the_answer(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "down", "down", "down", "x", "escape", "up", "up", "up", "1")
            await self.press(pilot, "down", "down", "down", "tab")
            self.assertIsNone(app.focused)
            self.assertEqual(self.status(app), "先在「其他」輸入內容，再按 Tab 加備註")

    async def test_tab_on_the_other_row_needs_its_text_first(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "@options", "down", "down", "down", "tab")
            self.assertIsNone(app.focused)
            self.assertEqual(self.status(app), "先在「其他」輸入內容，再按 Tab 加備註")
            await self.press(pilot, "x", "escape", "tab", "n", "escape")
            self.assertIn("答覆：其他：x\n備註：n\n", self.text())

    async def test_focus_starts_on_the_title_where_choosing_keys_do_nothing(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            before = self.text()
            self.assertEqual(app.current.focus[:3], ("text", 0, 0))
            await self.press(pilot, "enter", "space", "tab")
            self.assertEqual(self.text(), before)
            self.assertEqual(app.current.id, "Q1")
            self.assertIsNone(app.focused)
            await self.press(pilot, "down")
            self.assertEqual(app.current.focus[:3], ("text", 1, 0))
            await self.press(pilot, "down")
            self.assertEqual(app.current.cursor, 0)
            await self.press(pilot, "enter")
            self.assertIn("答覆：A. 合併到 dev，不推送\n", self.text())


class MultiSelectTests(SelectorTestCase):
    async def test_space_and_digits_toggle_in_selection_order(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "@options")
            self.assertIn("❯ A. [ ] 主控綁定", self.view(app))
            await self.press(pilot, "3", "up", "up", "space")
            self.assertIn("答覆：通知；主控綁定\n\n- [ ] 送出", section(self.text(), "Q2"))
            self.assertIn("  B. [ ] 封存", self.view(app))
            self.assertIn("[x] 通知", self.view(app))
            await self.press(pilot, "down", "down", "space")
            self.assertIn("答覆：主控綁定\n", self.text())
            self.assertIn("- [ ] 主控綁定\n  綁定 tab。\n- [ ] 封存\n- [ ] 通知\n", self.text())
            await self.press(pilot, "4", *"自訂", "escape")
            self.assertIn("答覆：主控綁定；其他：自訂\n", self.text())
            await self.press(pilot, "up", "1")
            self.assertIn("答覆：其他：自訂\n", self.text())
        self.assertEqual(self.calls(), [])

    async def test_tab_checks_the_option_once_and_opens_the_note(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "@options", "tab", "n", "escape", "tab", "2", "escape")
            self.assertIn("答覆：主控綁定\n備註：n2\n", self.text())

    async def test_enter_on_the_other_row_always_opens_its_input(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "@options", "down", "down", "down", "enter")
            self.assertIs(app.focused, app.input)
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")
            await self.press(pilot, "x", "escape")
            self.assertIn("答覆：其他：x\n", self.text())
            await self.press(pilot, "enter")
            self.assertIs(app.focused, app.input)
            self.assertEqual(app.input.text, "x")
            self.assertIn("答覆：其他：x\n", self.text())
            await self.press(pilot, "backspace", "escape")
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")

    async def test_enter_checks_an_unchecked_other_row_that_still_has_text(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "1", "down", "down", "down", "x", "escape", "up", "4")
            self.assertIn("答覆：主控綁定\n", self.text())
            await self.press(pilot, "down", "enter")
            self.assertIs(app.focused, app.input)
            self.assertEqual(app.input.text, "x")
            self.assertIn("答覆：主控綁定；其他：x\n", self.text())

    async def test_blank_text_on_the_other_row_is_dropped_when_leaving(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "@options", "down", "down", "down", "space", "escape")
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")
            await self.press(pilot, "x", "escape")
            self.assertIn("答覆：其他：x\n", self.text())

    async def test_enter_toggles_the_option_and_stays_on_the_question(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "@options", "enter", "down", "enter")
            self.assertEqual(app.current.id, "Q2")
            self.assertIn("答覆：主控綁定；封存\n", self.text())
            await self.press(pilot, "enter")
            self.assertIn("答覆：主控綁定\n", self.text())

    async def test_recommended_marker_is_display_only_and_old_answers_still_restore(self):
        self.questions.write_text(MULTI.replace("- [ ] 封存", "- [ ] 封存（建議）"))
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertIn("B. [ ] 封存（建議）", self.view(app))
            await self.press(pilot, "2", "1")
            self.assertIn("答覆：封存；主控綁定\n", self.text())
        self.questions.write_text(MULTI.replace("- [ ] 封存", "- [ ] 封存（建議）").replace(
            "答覆：\n", "答覆：封存（建議）；通知\n"
        ) + "\n" + SINGLE.replace("Q1 · r1", "Q4 · r1").replace(
            "答覆：\n", "答覆：B. 合併到 dev，並推送到 GitHub（建議）\n"
        ))
        reopened = self.make_app()
        async with reopened.run_test():
            self.assertEqual(reopened.drafts["Q2"].selected, [1, 2])
            self.assertEqual(reopened.drafts["Q2"].unmatched, "")
            self.assertEqual(reopened.drafts["Q4"].selected, [1])

    async def test_unchecking_everything_clears_the_draft(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "2", "2")
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")
            self.assertIn("☐ 要開哪些功能？", self.tabs(app))


class LetterKeyTests(SelectorTestCase):
    async def test_single_options_show_file_letters_and_letter_keys_select(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertIn("  A. 合併到 dev，不推送", self.view(app))
            self.assertIn("  D. 其他（自己輸入）", self.view(app))
            self.assertNotIn("1.", self.view(app))
            await self.press(pilot, "b")
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub\n\n- [ ] 送出", section(self.text(), "Q1"))
            self.assertIn("❯ B. 合併到 dev，並推送到 GitHub（建議）  ✔", self.view(app))
            self.assertEqual(app.current.id, "Q1")
            await self.press(pilot, "C")
            self.assertIn("答覆：C. 先不合併\n", self.text())
            await self.press(pilot, "j")
            self.assertIn("答覆：C. 先不合併\n", self.text())

    async def test_other_row_and_its_input_keep_letters_as_text(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "d")
            self.assertIs(app.focused, app.input)
            await self.press(pilot, "a", "B", "escape")
            self.assertIn("答覆：其他：aB\n", self.text())
            self.assertEqual(app.current.cursor, 3)
            await self.press(pilot, "c", "escape")
            self.assertIn("答覆：其他：aBc\n", self.text())
            await self.press(pilot, "up", "a")
            self.assertIn("答覆：A. 合併到 dev，不推送\n", self.text())
            await self.press(pilot, "tab", "b", "escape")
            self.assertIn("答覆：A. 合併到 dev，不推送\n備註：b\n", self.text())

    async def test_multi_options_get_letters_by_order_and_letters_toggle(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right")
            self.assertIn("  A. [ ] 主控綁定", self.view(app))
            self.assertIn("  D. [ ] 其他（自己輸入）", self.view(app))
            await self.press(pilot, "c", "A")
            self.assertIn("答覆：通知；主控綁定\n", section(self.text(), "Q2"))
            self.assertIn("❯ A. [x] 主控綁定", self.view(app))
            await self.press(pilot, "a", "D", *"xy", "escape")
            self.assertIn("答覆：通知；其他：xy\n", section(self.text(), "Q2"))

    async def test_each_letter_key_picks_its_own_row(self):
        options = "".join(f"{chr(65 + index)}. 選項{index + 1}\n" for index in range(9))
        self.questions.write_text(TEXT.replace("請自由回答。", options))
        app = self.make_app()
        async with app.run_test() as pilot:
            for key in "abcdefghiABCDEFGHI":
                await self.press(pilot, key)
                letter = key.upper()
                self.assertIn(f"答覆：{letter}. 選項{ord(letter) - 64}\n", self.text(), key)

    async def test_raw_editor_keeps_letters_as_text(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "ctrl+e")
            app.editor.move_cursor(app.editor.document.end)
            await self.press(pilot, "a", "B")
            self.assertTrue(app.editor.text.endswith("aB"))
            self.assertIn("答覆：\n\n- [ ] 送出", section(app.editor.text, "Q1"))

    async def test_multi_rows_past_z_have_no_letter(self):
        options = "".join(f"- [ ] 選項{index + 1}\n" for index in range(27))
        self.questions.write_text(TEXT.replace("請自由回答。", options))
        app = self.make_app()
        async with app.run_test(size=(80, 60)):
            self.assertIn("  Z. [ ] 選項26", self.view(app))
            self.assertIn("\n  [ ] 選項27", self.view(app))
            self.assertIn("\n  [ ] 其他（自己輸入）", self.view(app))
            self.assertNotIn("[.", self.view(app))

    async def test_input_only_question_types_letters(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "right", "a", "b", "escape")
            self.assertTrue(self.text().endswith("答覆：ab\n\n- [ ] 送出\n"))

    async def test_gaps_in_file_letters_are_kept_and_other_takes_the_next(self):
        self.questions.write_text(SINGLE.replace("B. 合併到 dev，並推送", "D. 合併到 dev，並推送").replace(
            "C. 先不合併", "E. 先不合併"))
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertIn("  D. 合併到 dev，並推送到 GitHub（建議）", self.view(app))
            self.assertIn("  F. 其他（自己輸入）", self.view(app))
            await self.press(pilot, "b")
            self.assertIn("答覆：\n\n- [ ] 送出", self.text())
            await self.press(pilot, "e")
            self.assertIn("答覆：E. 先不合併\n", self.text())
            await self.press(pilot, "2")
            self.assertIn("答覆：D. 合併到 dev，並推送到 GitHub\n", self.text())


class InputOnlyTests(SelectorTestCase):
    async def test_input_only_question_shows_the_box_and_typing_starts_the_answer(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "right")
            self.assertTrue(app.input.display)
            self.assertIsNone(app.focused)
            self.assertEqual(self.status(app), "Q3：題目沒有可解析的選項，只能輸入文字")
            await self.press(pilot, *"想法", "1", "space", "enter", "x", "escape")
            self.assertTrue(self.text().endswith("答覆：想法1 \nx\n\n- [ ] 送出\n"))
            self.assertIsNone(app.focused)
            self.assertTrue(app.input.display)
            await self.press(pilot, "enter")
            self.assertIs(app.focused, app.input)
            await self.press(pilot, "escape", "left")
            self.assertFalse(app.input.display)

    async def test_clicking_the_input_only_box_still_saves_what_is_typed(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "right")
            await pilot.click("#input")
            await self.press(pilot, *"hi")
            self.assertTrue(self.text().endswith("答覆：hi\n\n- [ ] 送出\n"))

    async def test_text_that_would_forge_a_submit_box_is_not_saved(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "right", *"x", "enter")
            for key in "- [x] 送出":
                await pilot.press("space" if key == " " else key)
            await pilot.pause()
            self.assertIn("這次輸入沒有儲存", self.status(app))
            self.assertIs(app.focused, app.input)
            self.assertTrue(self.text().endswith("答覆：x\n- [x] 送\n\n- [ ] 送出\n"))
            self.assertEqual(self.core.parse_questions(self.text())[-1]["status"], "pending")
            await self.press(pilot, "escape", "right")
            self.assertIn("☐ 還有什麼想法？\n  （未儲存：答覆或備註含不允許的行）", self.view(app))
            self.assertIn("☐ 還有什麼想法？", self.tabs(app))
            await self.press(pilot, "enter")
            self.assertIn("沒有可送出的答覆", self.status(app))
            await self.press(pilot, "left", "enter", "backspace", "backspace", "escape")
            self.assertNotIn("沒有儲存", self.status(app))
            self.assertTrue(self.text().endswith("答覆：x\n- [x] \n\n- [ ] 送出\n"))

    async def test_mixed_option_styles_fall_back_to_input(self):
        self.questions.write_text(TEXT.replace("請自由回答。", "A. One\n- [ ] Two"))
        app = self.make_app()
        async with app.run_test():
            self.assertIn("題目混用了單選與複選格式", self.status(app))
            self.assertNotIn("1.", self.view(app))


class DraftRestoreTests(SelectorTestCase):
    async def test_hand_written_answers_restore_and_reopen_keeps_drafts(self):
        text = (
            SINGLE.replace("答覆：\n", "答覆：B\n備註：hand\n")
            + "\n" + MULTI.replace("答覆：\n", "答覆：通知；主控綁定；其他：x\n")
            + "\n" + TEXT.replace("答覆：\n", "答覆：\nline1\nline2\n")
        )
        self.questions.write_text(text)
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(self.tabs(app).count("☒"), 3)
            self.assertIn("B. 合併到 dev，並推送到 GitHub（建議）  ✔", self.view(app))
            self.assertIn("備註：hand", self.view(app))
            await self.press(pilot, "right")
            self.assertEqual(app.current.selected, [2, 0, 3])
            self.assertIn("D. [x] 其他（自己輸入）\n         x", self.view(app))
            await self.press(pilot, "right")
            self.assertTrue(app.input.display)
            self.assertEqual(app.input.text, "line1\nline2")
            await pilot.press("escape")
            await self.settle(app, pilot)
        self.assertEqual(self.text(), text)
        reopened = self.make_app()
        async with reopened.run_test():
            self.assertEqual(reopened.current.selected, [1])
            self.assertEqual(reopened.current.note, "hand")

    async def test_answer_that_matches_no_option_is_shown_and_not_submitted(self):
        self.questions.write_text(SINGLE.replace("答覆：\n", "答覆：Z. 不存在\n"))
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertIn("目前答覆無法對應選項：Z. 不存在", self.view(app))
            await self.press(pilot, "right")
            self.assertIn("☒ 正式版要怎麼併入？\n  Z. 不存在", self.view(app))
            await self.press(pilot, "enter")
            self.assertIn("沒有可送出的答覆", self.status(app))
            self.assertIn("- [ ] 送出", self.text())


class SubmitTests(SelectorTestCase):
    async def test_review_lists_answers_and_submits_only_answered_with_one_notification(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "2", "right", "1", "right", "right")
            self.assertIsNone(app.current)
            self.assertEqual(self.view(app).splitlines(), [
                "送出前檢查",
                "",
                "☒ 正式版要怎麼併入？",
                "  B. 合併到 dev，並推送到 GitHub",
                "☒ 要開哪些功能？",
                "  主控綁定",
                "☐ 還有什麼想法？",
                "  （未作答）",
                "",
                "❯ Enter 送出 2 題",
            ])
            self.assertEqual(self.calls(), [])
            await self.press(pilot, "enter")
            await self.settle(app, pilot)
            text = self.text()
            self.assertIn("- [x] 送出", section(text, "Q1"))
            self.assertIn("- [x] 送出", section(text, "Q2"))
            self.assertIn("- [ ] 送出", section(text, "Q3"))
            [call] = self.calls()
            self.assertEqual(call[:2], ["send", "@ctl-a"])
            self.assertFalse(self.pending())
            self.assertEqual(self.journal()[-1]["kind"], "batch-submit")
            for question_id in ("Q1", "Q2"):
                proof = self.core.question_provenance(
                    self.questions, self.questions.parent / "panel-journal.jsonl", question_id,
                )
                self.assertEqual(proof["status"], "ok")
            self.assertIn("已送出，等待記錄", self.view(app))
            self.assertIn("沒有可送出的答覆", self.view(app))

    async def test_successful_submit_closes_the_panel_after_one_notification(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "right", "right", "right")
            self.assertIsNone(app.return_code)
            await self.press(pilot, "enter")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)
        self.assertEqual(len(self.calls()), 1)
        self.assertFalse(self.pending())
        self.assertIn("- [x] 送出", section(self.text(), "Q1"))

    async def test_submit_stays_open_when_the_notification_fails(self):
        self.set_hcom("offline")
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "right", "right", "right", "enter")
            await self.settle(app, pilot)
            self.assertIsNone(app.return_code)
            self.assertIn("通知失敗：ctl-a 不在線", self.status(app))
            self.assertIn("已送出，等待記錄", self.view(app))
            self.assertTrue(self.pending())
            await self.press(pilot, "ctrl+q")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue(self.pending())

    async def test_submitted_tab_is_read_only_until_recorded_then_shows_recorded(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "right", "right", "right", "enter")
            await self.settle(app, pilot)
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(app.current.id, "Q1")
            self.assertIn("已送出，等待記錄", self.view(app))
            self.assertNotIn("❯", self.view(app))
            submitted = self.text()
            await self.press(pilot, "2", "down", "enter", "tab", "space")
            self.assertEqual(self.text(), submitted)
            self.assertIsNone(app.focused)
            proof = self.core.question_provenance(
                self.questions, self.questions.parent / "panel-journal.jsonl", "Q1",
            )
            self.core.set_question_status(
                self.questions, "Q1", 1, "recorded", proof["section_sha256"]
            )
            await pilot.pause(0.3)
            self.assertIn("✔ 已記錄", self.view(app))
            self.assertIn("✔ 正式版要怎麼併…", self.tabs(app))
        reopened = self.make_app()
        async with reopened.run_test():
            self.assertEqual(reopened.tab_ids, ["Q2", "Q3"])

    async def test_empty_submit_explains_and_does_not_notify(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "left", "right", "right", "right", "enter")
            self.assertIn("沒有可送出的答覆", self.status(app))
            await self.settle(app, pilot)
        self.assertNotIn("[x] 送出", self.text().replace(RECORDED, ""))
        self.assertEqual(self.calls(), [])

    async def test_submit_refuses_all_when_a_question_changed_after_loading(self):
        app = self.make_app(POLL_INTERVAL=60)
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "right", "1")
            self.core.upsert_question(self.questions, "Q2", "## 要開哪些功能？\n\n- [ ] 只剩一個\n")
            await self.press(pilot, "right", "right", "enter")
            await self.settle(app, pilot)
            self.assertNotIn("[x] 送出", self.text().replace(RECORDED, ""))
            self.assertIn("送出前題目已變更：Q2", self.status(app))
            self.assertEqual(self.calls(), [])


class LiveUpdateTests(SelectorTestCase):
    async def test_agent_adds_or_changes_other_questions_without_touching_the_draft(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "2")
            draft = section(self.text(), "Q1")
            self.core.upsert_question(self.questions, "Q4", "## 新題目\n\nA. Yes\nB. No\n")
            self.core.upsert_question(self.questions, "Q3", "## 還有什麼想法？\n\n改過的說明。\n")
            await pilot.pause(0.3)
            self.assertEqual(app.tab_ids, ["Q1", "Q2", "Q3", "Q4"])
            self.assertIn("☐ 新題目", self.tabs(app))
            self.assertEqual(app.current.id, "Q1")
            self.assertEqual(app.current.selected, [1])
            self.assertEqual(section(self.text(), "Q1"), draft)
            await self.press(pilot, "right", "right")
            self.assertIn("改過的說明。", self.view(app))
            self.assertNotIn("題目已更新", self.status(app))
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.pending())

    async def test_revision_of_the_open_question_resets_it_with_a_notice(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "4", *"舊答案", "escape")
            self.core.upsert_question(
                self.questions, "Q1", "## 正式版要怎麼併入？\n\nA. 只合併\nB. 不合併\n",
            )
            await pilot.pause(0.3)
            self.assertIn("題目已更新：Q1 r2，這題的選擇已重設", self.status(app))
            self.assertEqual(app.current.revision, 2)
            self.assertEqual(app.current.selected, [])
            self.assertEqual(app.current.focus[:3], ("text", 0, 0))
            self.assertIn("  A. 只合併", self.view(app))
            self.assertIn("☐ 正式版要怎麼併…", self.tabs(app))
            self.assertIn("### 舊版 r1（不套用至 r2）\n答覆：其他：舊答案", self.text())
            await self.press(pilot, "2")
            self.assertEqual(self.status(app), "")
            self.assertIn("答覆：B. 不合併\n", section(self.text(), "Q1"))

    async def test_revision_while_typing_closes_the_input_without_writing_old_text(self):
        app = self.make_app(POLL_INTERVAL=0.05)
        async with app.run_test() as pilot:
            await self.press(pilot, "4", *"abc")
            self.core.upsert_question(self.questions, "Q1", "## 正式版要怎麼併入？\n\nA. 只合併\n")
            await pilot.pause(0.3)
            self.assertIsNone(app.focused)
            self.assertFalse(app.input.display)
            self.assertIn("答覆：\n\n- [ ] 送出", section(self.text(), "Q1").split("###")[0])

    async def test_failed_write_shows_error_and_disk_state(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            with patch.object(
                self.core, "write_question_answer", side_effect=OSError("disk full"),
            ):
                await self.press(pilot, "2")
            self.assertIn("儲存失敗：disk full", self.status(app))
            self.assertEqual(app.current.selected, [])
            self.assertIn("☐ 正式版要怎麼併…", self.tabs(app))
            await self.press(pilot, "3")
            self.assertNotIn("儲存失敗", self.status(app))
            self.assertIn("答覆：C. 先不合併\n", self.text())


class RawModeTests(SelectorTestCase):
    async def test_ctrl_e_round_trips_between_selector_and_raw_editor(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "ctrl+e")
            self.assertTrue(app.editor.display)
            self.assertIs(app.focused, app.editor)
            self.assertIn("答覆：A. 合併到 dev，不推送\n", app.editor.text)
            line = app.editor.text.splitlines().index("答覆：A. 合併到 dev，不推送")
            app.editor.replace("答覆：C. 先不合併", (line, 0), (line, len("答覆：A. 合併到 dev，不推送")))
            await pilot.pause()
            self.assertIn("答覆：C. 先不合併\n", self.text())
            await self.press(pilot, "ctrl+e")
            self.assertFalse(app.editor.display)
            self.assertEqual(app.current.selected, [2])
            self.assertIn("C. 先不合併  ✔", self.view(app))
        self.assertEqual(self.calls(), [])

    async def test_raw_conflict_blocks_switching_back_until_f5(self):
        app = self.make_app(POLL_INTERVAL=60)
        async with app.run_test() as pilot:
            await self.press(pilot, "ctrl+e")
            self.questions.write_text(self.text() + "\n# Agent\n")
            app.editor.move_cursor(app.editor.document.end)
            await self.press(pilot, "x")
            await self.press(pilot, "ctrl+e")
            self.assertTrue(app.editor.display)
            self.assertIn("再切換到選擇框", self.status(app))
            await self.press(pilot, "f5", "ctrl+e")
            self.assertFalse(app.editor.display)
            self.assertEqual(app.tab_ids, ["Q1", "Q2", "Q3"])

    async def test_malformed_raw_edit_shows_persistent_error_back_in_selector(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "ctrl+e")
            app.editor.load_text(self.text().replace(
                "B. 合併到 dev，並推送到 GitHub（建議）\n   repo 是公開的，程式碼會公開。\n"
                "C. 先不合併\n   繼續保留在目前分支。\n\n答覆：\n\n- [ ] 送出",
                "B. 合併\n\n- [x] 送出",
            ))
            app.save()
            await self.press(pilot, "ctrl+e")
            self.assertIn("送出格式錯誤：Q1 已勾選送出，但找不到完整的答覆格式", self.status(app))
            self.assertIn("題目格式錯誤", self.view(app))
            await pilot.pause(0.3)
            self.assertIn("送出格式錯誤", self.status(app))


class ReviewFixTests(SelectorTestCase):
    async def test_tab_inside_an_input_keeps_focus_and_esc_only_leaves_it(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "4", *"ab", "tab")
            self.assertIs(app.focused, app.input)
            await self.press(pilot, "escape")
            self.assertIsNone(app.return_code)
            self.assertIsNone(app.focused)
            await self.press(pilot, "down")
            self.assertEqual(app.current.cursor, 3)

    async def test_raw_editor_refuses_changes_to_submitted_questions(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "right", "right", "right", "enter")
            await self.settle(app, pilot)
        app = self.make_app()
        async with app.run_test() as pilot:
            submitted = self.text()
            await self.press(pilot, "ctrl+e")
            line = app.editor.text.splitlines().index("答覆：A. 合併到 dev，不推送")
            app.editor.replace("答覆：C. 先不合併", (line, 0), (line, len("答覆：A. 合併到 dev，不推送")))
            await pilot.pause()
            self.assertEqual(self.text(), submitted)
            self.assertEqual(app.editor.text, submitted)
            self.assertIn("已送出或已記錄的題目不能修改", self.status(app))
            app.editor.move_cursor(app.editor.document.end)
            await self.press(pilot, "z")
            self.assertEqual(self.text(), submitted + "z")
            self.assertNotIn("不能修改", self.status(app))
            await self.press(pilot, "ctrl+e")
            self.assertIn("已送出，等待記錄", self.view(app))

    async def test_malformed_unchecked_question_shows_persistent_status_error(self):
        self.questions.write_text(SINGLE.replace("答覆：\n", "") + "\n" + MULTI)
        app = self.make_app()
        async with app.run_test() as pilot:
            expected = "題目格式錯誤：Q1 找不到答覆或送出標記，請按 Ctrl+E 修正"
            self.assertEqual(self.status(app), expected)
            await self.press(pilot, "right", "1")
            self.assertEqual(self.status(app), expected)

    async def test_review_wraps_long_titles_without_a_huge_indent(self):
        long_title = "這是一個非常非常長的題目標題用來測試送出頁的換行是否正常"
        self.questions.write_text(SINGLE.replace("正式版要怎麼併入？", long_title))
        app = self.make_app()
        async with app.run_test(size=(44, 30)) as pilot:
            await self.press(pilot, "1", "right")
            lines = self.view(app).splitlines()
            self.assertEqual(lines[2:5], [
                "☒ 這是一個非常非常長的題目標題用來測試送",
                "  出頁的換行是否正常",
                "  A. 合併到 dev，不推送",
            ])

    async def test_partially_unmatched_multi_answer_is_shown_and_not_submitted(self):
        self.questions.write_text(MULTI.replace("答覆：\n", "答覆：通知；不存在\n"))
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "enter")
            self.assertIn("通知（無法對應選項：不存在）", self.view(app))
            self.assertIn("沒有可送出的答覆", self.status(app))
            self.assertIn("- [ ] 送出", self.text())
            await self.press(pilot, "left", "1", "right", "enter")
            await self.settle(app, pilot)
            self.assertIn("答覆：通知；主控綁定\n\n- [x] 送出", self.text())

    async def test_revised_notice_stays_until_that_question_is_answered_again(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "1", "left")
            self.core.upsert_question(self.questions, "Q2", "## 要開哪些功能？\n\n- [ ] 只剩一個\n")
            await pilot.pause(0.3)
            notice = "題目已更新：Q2 r2，這題的選擇已重設"
            self.assertIn(notice, self.status(app))
            await self.press(pilot, "down", "2", "right")
            self.assertIn(notice, self.status(app))
            await self.press(pilot, "1")
            self.assertNotIn(notice, self.status(app))

    async def test_cancelled_other_keeps_the_previous_single_answer(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "tab", "n", "escape", "4", "escape")
            self.assertIn("答覆：A. 合併到 dev，不推送\n備註：n\n", self.text())
            self.assertEqual(app.current.selected, [0])
            await self.press(pilot, "x", "escape")
            self.assertIn("答覆：其他：x\n備註：n\n", self.text())

    async def test_note_is_hidden_while_there_is_no_answer_to_keep_it(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "1", "tab", "n", "escape", "1")
            self.assertNotIn("備註", self.view(app))
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")

    async def test_more_than_nine_options_use_arrows_for_the_rest(self):
        options = "".join(f"{chr(65 + index)}. 選項{index + 1}\n" for index in range(10))
        self.questions.write_text(TEXT.replace("請自由回答。", options))
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertIn("K. 其他（自己輸入）", self.view(app))
            await self.press(pilot, "9")
            self.assertIn("答覆：I. 選項9\n", self.text())
            await self.press(pilot, "down", "enter")
            self.assertIn("答覆：J. 選項10\n", self.text())

    async def test_hand_written_other_and_note_restore_into_inputs(self):
        self.questions.write_text(SINGLE.replace("答覆：\n", "答覆：其他：自訂\n備註：說明\n"))
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(app.current.selected, [3])
            self.assertIn("D. 其他（自己輸入）  ✔\n     自訂", self.view(app))
            await self.press(pilot, "4")
            self.assertEqual(app.input.text, "自訂")
            await self.press(pilot, "escape", "tab")
            self.assertEqual(app.input.text, "說明")


class SmallTerminalTests(SelectorTestCase):
    def setUp(self):
        super().setUp()
        self.questions.write_text(CHECK)

    async def test_moving_the_cursor_keeps_the_focused_option_on_screen(self):
        for size in ((40, 12), (30, 10), (60, 9)):
            app = self.make_app()
            async with app.run_test(size=size) as pilot:
                await self.press(pilot, "@options", "down")
                self.assertIn("❯ B. 大致可以", self.screen(app), size)
                await self.press(pilot, "down")
                self.assertIn("❯ C. 不符合", self.screen(app), size)
                self.assertIn("請在備註寫原因。", self.screen(app), size)
                await self.press(pilot, "down")
                self.assertIn("❯ D. 其他（自己輸入）", self.screen(app), size)

    async def test_stepping_back_up_brings_the_title_back(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(pilot, "@options", "down", "down", "down")
            self.assertNotIn("V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))
            await self.press(pilot, *["up"] * 5)
            self.assertIn("▌V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))
            self.assertNotIn("❯", self.screen(app))

    async def test_first_option_stays_on_screen_when_the_text_above_is_too_tall(self):
        app = self.make_app()
        async with app.run_test(size=(30, 8)) as pilot:
            await self.press(pilot, "@options")
            self.assertIn("▌❯ A. 符合，可以結案", self.screen(app))

    async def test_last_option_shows_the_note_below_it(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(pilot, "3", "tab", *"note", "escape", "down")
            screen = self.screen(app)
            self.assertIn("❯ D. 其他（自己輸入）", screen)
            self.assertIn("備註：note", screen)

    async def test_chosen_option_stays_on_screen_while_typing_a_note(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(pilot, "3", "tab", *"note")
            screen = self.screen(app)
            self.assertIn("❯ C. 不符合，先別結案  ✔", screen)
            self.assertIn("Q1 備註", screen)

    async def test_focused_option_stays_on_screen_in_a_very_narrow_terminal(self):
        app = self.make_app()
        async with app.run_test(size=(20, 10)) as pilot:
            await self.press(pilot, "@options")
            # Options taller than this body take more than one step each.
            for _ in range(20):
                if app.current.cursor == 3:
                    break
                await self.press(pilot, "down")
            self.assertIn("▌❯ D. 其他（自己", self.screen(app))

    async def test_tall_note_leaves_the_chosen_option_and_footer_on_screen(self):
        app = self.make_app()
        async with app.run_test(size=(40, 8)) as pilot:
            await self.press(pilot, "3", "tab", "a", "enter", "b", "enter", "c", "enter", "d")
            screen = self.screen(app)
            self.assertIn("❯ C. 不符合，先別結案  ✔", screen)
            self.assertIn("Enter 換行 · Esc 離開輸入框", screen)
            self.assertEqual(app.current.note, "a\nb\nc\nd")

    async def test_shrinking_the_terminal_keeps_the_focused_option_on_screen(self):
        for size in ((40, 12), (30, 10)):
            app = self.make_app()
            async with app.run_test(size=(80, 24)) as pilot:
                await self.press(pilot, "@options", "down", "down", "down")
                await pilot.resize_terminal(*size)
                await pilot.pause()
                self.assertIn("❯ D. 其他（自己輸入）", self.screen(app), size)

    async def test_long_text_in_every_input_keeps_its_end_and_the_footer_on_screen(self):
        for keys in (("3", "tab"), ("4",), ("right", "enter")):
            self.questions.write_text(CHECK + "\n" + TEXT)
            app = self.make_app()
            async with app.run_test(size=(40, 8)) as pilot:
                await self.press(pilot, *keys, *["n", "enter"] * 9, *"END")
                screen = self.screen(app)
                self.assertIn("END", screen, keys)
                self.assertIn("Enter 換行 · Esc 離開輸入框", screen, keys)

    async def test_submitted_question_opens_at_its_title(self):
        self.questions.write_text(CHECK.replace(
            "答覆：\n\n- [ ] 送出", "答覆：C. 不符合，先別結案\n備註：a\nb\nc\nd\ne\nf\n\n- [x] 送出",
        ))
        app = self.make_app()
        async with app.run_test(size=(40, 12)):
            screen = self.screen(app)
            self.assertIn("V2 選擇框用起來符合你要的樣子嗎？", screen)
            self.assertIn("已送出，等待記錄", screen)

    async def test_wrapped_notice_and_tall_note_leave_the_option_and_footer_on_screen(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(
                pilot, "3", "tab", *"a|b|c|d|".replace("|", " enter ").split(),
                *"- [x]", "space", *"送出",
            )
            screen = self.screen(app)
            self.assertIn("沒有儲存", screen)
            self.assertIn("▊ - [x] 送出", screen)
            self.assertIn("❯ C. 不符合，先別結案", screen)
            self.assertIn("Enter 換行 · Esc 離開輸入框", screen)

    async def test_shrinking_the_terminal_keeps_the_text_being_typed_on_screen(self):
        app = self.make_app()
        async with app.run_test(size=(80, 24)) as pilot:
            await self.press(pilot, "3", "tab", *["n", "enter"] * 12, *"END")
            await pilot.resize_terminal(100, 15)
            await pilot.pause()
            await pilot.pause()
            self.assertIn("END", self.screen(app))

    async def test_arrows_step_the_focus_through_every_paragraph_and_option(self):
        paragraphs = "\n\n".join(
            "\n".join(f"說明第 {first + line} 行" for line in range(3)) for first in (1, 4, 7, 10)
        )
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", paragraphs))
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            self.assertEqual(self.rows(app)[2], "▌正式版要怎麼併入？")
            focused = []
            for _ in range(4):
                await self.press(pilot, "down")
                focused.append(self.focused(app))
            self.assertEqual(focused, [
                [f"▌說明第 {first + line} 行" for line in range(3)] for first in (1, 4, 7, 10)
            ])
            # Past the top of the text the focus stays on the middle row of the body.
            self.assertEqual(self.rows(app)[5], "▌說明第 10 行")
            await self.press(pilot, "down")
            self.assertEqual(self.rows(app)[5], "▌❯ A. 合併到 dev，不推送")
            await self.press(pilot, *["down"] * 6)
            self.assertEqual(app.current.cursor, 3)
            self.assertIn("▌❯ D. 其他（自己輸入）", self.screen(app))
            await self.press(pilot, *["up"] * 4)
            self.assertEqual(self.rows(app)[5], "▌說明第 10 行")
            await self.press(pilot, *["up"] * 6)
            self.assertEqual(self.rows(app)[2], "▌正式版要怎麼併入？")

    async def test_a_paragraph_taller_than_the_screen_is_stepped_through_in_parts(self):
        long = "\n".join(f"說明第 {number} 行" for number in range(1, 21))
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", long))
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            seen = []
            for _ in range(20):
                if app.current.cursor is not None:
                    break
                await self.press(pilot, "down")
                seen += [line for line in self.focused(app) if "說明" in line]
            self.assertEqual(seen, [f"▌說明第 {number} 行" for number in range(1, 21)])
            self.assertEqual(app.current.cursor, 0)

    async def test_resizing_keeps_the_reading_place_in_a_long_paragraph(self):
        long = "\n".join(f"LINE{number:02}" for number in range(1, 81))
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", long))
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, *["down"] * 5)
            self.assertEqual(self.focused(app), [f"▌LINE{number}" for number in range(21, 26)])
            await pilot.resize_terminal(40, 22)
            await pilot.pause(0.3)
            self.assertEqual(self.focused(app), [f"▌LINE{number}" for number in range(21, 31)])
            await self.press(pilot, "down")
            self.assertEqual(self.focused(app)[0], "▌LINE31")

    async def test_rewrapping_keeps_the_reading_place_in_a_long_paragraph(self):
        words = " ".join(f"W{number:03}" for number in range(1, 121))
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", words))
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, *["down"] * 3)
            reading = self.focused(app)[0].split()[0].lstrip("▌")
            for size in ((70, 12), (30, 12), (40, 12)):
                await pilot.resize_terminal(*size)
                await pilot.pause(0.3)
                shown = " ".join(self.focused(app)).replace("▌", "").split()
                self.assertLessEqual(shown[0], reading, size)
                self.assertGreaterEqual(shown[-1], reading, size)

    async def test_unevenly_wrapped_text_keeps_its_reading_place_when_widened(self):
        long = "\n".join(
            [f"LONG{number:02}" + "x" * 100 for number in range(1, 21)]
            + [f"SHORT{number:02}" for number in range(1, 41)]
        )
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", long))
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await pilot.pause(0.3)
            for _ in range(60):
                if self.focused(app) and self.focused(app)[0] == "▌SHORT01":
                    break
                await self.press(pilot, "down")
            self.assertEqual(self.focused(app), [f"▌SHORT{number:02}" for number in range(1, 6)])
            await pilot.resize_terminal(120, 12)
            await pilot.pause(0.3)
            self.assertIn("▌SHORT01", self.focused(app))
            last = int(self.focused(app)[-1][-2:])
            await self.press(pilot, "down")
            self.assertEqual(self.focused(app)[0], f"▌SHORT{last + 1:02}")

    async def test_an_option_taller_than_the_screen_is_stepped_through_in_parts(self):
        impact = "".join(f"第{number:02}句說明文字放在這裡。" for number in range(1, 31))
        self.questions.write_text(SINGLE.replace("dev 有了面板程式。", impact))
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, "@options")
            seen = ""
            for _ in range(20):
                if app.current.cursor != 0:
                    break
                seen += "".join(line.lstrip("▌❯ ") for line in self.focused(app))
                self.assertIn("❯ A. 合併到 dev，不推送", self.view(app))
                await self.press(pilot, "down")
            self.assertIn(impact, seen)
            self.assertEqual(app.current.cursor, 1)
            await self.press(pilot, "up", "enter")
            self.assertIn("答覆：A. 合併到 dev，不推送\n", self.text())

    async def test_blank_lines_with_spaces_still_separate_paragraphs(self):
        self.questions.write_text(SINGLE.replace("審查和驗收都通過了，現在只差要不要把它併進 dev。", "第一段\n \n第二段"))
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "down")
            self.assertEqual(self.focused(app), ["▌第一段"])
            await self.press(pilot, "down")
            self.assertEqual(self.focused(app), ["▌第二段"])

    async def test_stepping_down_past_the_options_reads_a_long_note(self):
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await self.press(pilot, "3", "tab", *"a|b|c|d|e|f|g|h|z".replace("|", " enter ").split())
            await self.press(pilot, "escape", "down")
            self.assertIn("▌❯ D. 其他（自己輸入）", self.screen(app))
            self.assertNotIn("z", self.screen(app))
            await self.press(pilot, *["down"] * 4)
            self.assertIn("z", self.screen(app))
            self.assertIsNone(app.current.cursor)
            await self.press(pilot, *["up"] * 4)
            self.assertIn("▌❯ C. 不符合，先別結案  ✔", self.screen(app))

    async def test_arrows_scroll_the_review(self):
        self.questions.write_text("\n".join(
            CHECK.replace("Q1", f"Q{number}") for number in range(1, 6)
        ))
        app = self.make_app()
        async with app.run_test(size=(40, 8)) as pilot:
            await self.press(pilot, *["right"] * 5)
            self.assertNotIn("沒有可送出的答覆", self.screen(app))
            await self.press(pilot, *["down"] * 12)
            self.assertIn("沒有可送出的答覆", self.screen(app))
            await self.press(pilot, *["up"] * 12)
            self.assertIn("送出前檢查", self.screen(app))

    async def test_manual_scroll_survives_a_change_to_another_question(self):
        self.questions.write_text(CHECK + "\n" + MULTI)
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, "pagedown")
            before = self.screen(app).split("\n", 1)[1]
            self.assertNotIn("▌", before)
            self.core.upsert_question(self.questions, "Q2", "## 要開哪些功能？\n\n- [ ] 只剩一個\n")
            await pilot.pause(0.4)
            self.assertEqual(self.screen(app).split("\n", 1)[1], before)
            await self.press(pilot, "down")
            self.assertIn("▌V2 已經裝好了。", self.screen(app))

    async def test_manual_scroll_survives_a_notice_appearing(self):
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, "pagedown")
            self.assertNotIn("▌", self.screen(app))
            app.set_notice("notify", "通知失敗：ctl-a 不在線。")
            await pilot.pause(0.3)
            self.assertIn("通知失敗", self.screen(app))
            self.assertNotIn("▌", self.screen(app))

    async def test_layout_changes_alone_never_leave_the_focused_option_off_screen(self):
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await self.press(pilot, "@options", "down", "down", "down")
            for size in ((40, 16), (40, 10), (40, 8)):
                await pilot.resize_terminal(*size)
                await pilot.pause(0.2)
                self.assertIn("❯ D. 其他（自己輸入）", self.screen(app), size)
            await pilot.resize_terminal(40, 10)
            for notice in ("通知失敗：ctl-a 不在線。", "", "通知失敗：ctl-a 不在線。"):
                app.set_notice("notify", notice)
                await pilot.pause(0.2)
                self.assertIn("❯ D. 其他（自己輸入）", self.screen(app), notice)

    async def test_manual_scroll_survives_rewrapping_and_a_new_tab_before_it(self):
        description = "\n".join(f"說明第 {number} 行" for number in range(1, 13))
        self.questions.write_text(CHECK.replace("V2 已經裝好了。", description + "\nV2 已經裝好了。"))
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, "pageup", "pageup", "pageup")
            self.assertIn("V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))
            await pilot.resize_terminal(60, 12)
            await pilot.pause(0.3)
            self.assertIn("V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))
            self.questions.write_text(TEXT.replace("Q3", "Q0") + "\n" + self.text())
            await pilot.pause(0.4)
            self.assertEqual(app.tab_ids, ["Q0", "Q1"])
            self.assertEqual(app.current.id, "Q1")
            self.assertIn("V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))

    async def test_wheel_scroll_survives_a_change_to_another_question(self):
        from textual import events
        self.questions.write_text(CHECK + "\n" + MULTI)
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            body = app.query_one("#body")
            for _ in range(3):
                body.post_message(events.MouseScrollDown(body, 5, 5, 0, 0, 0, False, False, False))
            await pilot.pause(0.3)
            self.assertNotIn("▌", self.screen(app))
            self.core.upsert_question(self.questions, "Q2", "## 要開哪些功能？\n\n- [ ] 只剩一個\n")
            await pilot.pause(0.4)
            self.assertNotIn("▌", self.screen(app))

    async def test_acting_on_the_focused_option_brings_it_back_on_screen(self):
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, "1", "pagedown")
            self.assertNotIn("❯", self.screen(app))
            await self.press(pilot, "1")
            self.assertIn("❯ A. 符合，可以結案（建議）  ✔", self.screen(app))

    async def test_change_to_the_open_question_brings_the_focus_back(self):
        app = self.make_app()
        async with app.run_test(size=(40, 10)) as pilot:
            await pilot.pause(0.3)
            await self.press(pilot, "pagedown")
            self.assertNotIn("▌", self.screen(app))
            self.core.upsert_question(self.questions, "Q1", CHECK.split("\n", 2)[0] + "\n\nA. 新選項\n")
            await pilot.pause(0.4)
            self.assertIn("▌V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))
            self.assertIn("A. 新選項", self.screen(app))

    async def test_mouse_wheel_scrolls_the_body(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(pilot, "@options", "down", "down", "down")
            from textual import events
            body = app.query_one("#body")
            for _ in range(3):
                body.post_message(events.MouseScrollUp(body, 5, 5, 0, 0, 0, False, False, False))
            await pilot.pause(0.5)
            self.assertIn("V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))

    async def test_page_keys_scroll_the_question(self):
        app = self.make_app()
        async with app.run_test(size=(40, 8)) as pilot:
            self.assertNotIn("D. 其他（自己輸入）", self.screen(app))
            await self.press(pilot, "pagedown", "pagedown")
            self.assertIn("D. 其他（自己輸入）", self.screen(app))
            self.assertEqual(app.current.focus[:3], ("text", 0, 0))
            await self.press(pilot, "pageup", "pageup")
            self.assertIn("V2 選擇框用起來符合你要的樣子嗎？", self.screen(app))

    async def test_page_keys_scroll_the_review(self):
        self.questions.write_text("\n".join(
            CHECK.replace("Q1", f"Q{number}") for number in range(1, 6)
        ))
        app = self.make_app()
        async with app.run_test(size=(40, 8)) as pilot:
            await self.press(pilot, *["right"] * 5)
            self.assertIn("送出前檢查", self.screen(app))
            self.assertNotIn("沒有可送出的答覆", self.screen(app))
            await self.press(pilot, "pagedown", "pagedown", "pagedown")
            self.assertIn("沒有可送出的答覆", self.screen(app))

    async def test_page_keys_stay_with_the_input_while_typing(self):
        app = self.make_app()
        async with app.run_test(size=(40, 12)) as pilot:
            await self.press(pilot, "3", "tab", *"note")
            before = self.screen(app)
            await self.press(pilot, "pageup")
            self.assertEqual(self.screen(app), before)
            self.assertIs(app.focused, app.input)


class ClickTests(SelectorTestCase):
    async def click_row(self, app, pilot, text):
        """Click the screen row that shows ``text``."""
        row = next(number for number, line in enumerate(self.rows(app)) if text in line)
        await pilot.click(offset=(6, row))
        await pilot.pause()

    async def test_clicking_a_tab_or_an_arrow_switches_question(self):
        app = self.make_app()
        from rich.cells import cell_len
        async with app.run_test(size=(80, 24)) as pilot:
            column = cell_len(self.tabs(app).split("☐ 還有什麼想法？")[0]) + 2
            await pilot.click("#tabs", offset=(column, 0))
            await pilot.pause()
            self.assertEqual(app.current.id, "Q3")
            await pilot.click("#tabs", offset=(1, 0))
            await pilot.pause()
            self.assertEqual(app.current.id, "Q2")
            await pilot.click("#tabs", offset=(cell_len(self.tabs(app)), 0))
            await pilot.pause()
            self.assertEqual(app.current.id, "Q3")

    async def test_clicking_a_single_option_selects_it_and_stays(self):
        app = self.make_app()
        async with app.run_test(size=(80, 24)) as pilot:
            await self.click_row(app, pilot, "B. 合併到 dev，並推送到 GitHub")
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub\n", self.text())
            self.assertEqual(app.current.id, "Q1")
            self.assertIn("▌❯ B. 合併到 dev，並推送到 GitHub（建議）  ✔", self.rows(app))
            await self.click_row(app, pilot, "繼續保留在目前分支。")
            self.assertIn("答覆：C. 先不合併\n", self.text())

    async def test_clicking_a_multi_option_toggles_it(self):
        app = self.make_app()
        async with app.run_test(size=(80, 24)) as pilot:
            await self.press(pilot, "right")
            await self.click_row(app, pilot, "[ ] 封存")
            await self.click_row(app, pilot, "[ ] 通知")
            self.assertIn("答覆：封存；通知\n", self.text())
            await self.click_row(app, pilot, "[x] 封存")
            self.assertIn("答覆：通知\n", self.text())
            self.assertEqual(app.current.id, "Q2")

    async def test_clicking_other_opens_its_input(self):
        app = self.make_app()
        async with app.run_test(size=(80, 24)) as pilot:
            await self.click_row(app, pilot, "D. 其他（自己輸入）")
            self.assertIs(app.focused, app.input)
            self.assertEqual(self.keys(app), "Enter 換行 · Esc 離開輸入框")
            await self.press(pilot, "x")
            self.assertIn("答覆：其他：x\n", self.text())

    async def test_clicking_a_paragraph_moves_the_focus_there_without_choosing(self):
        app = self.make_app()
        async with app.run_test(size=(80, 24)) as pilot:
            before = self.text()
            await self.click_row(app, pilot, "審查和驗收都通過了")
            self.assertEqual(app.current.focus[:3], ("text", 1, 0))
            self.assertEqual(self.focused(app), ["▌審查和驗收都通過了，現在只差要不要把它併進 dev。"])
            self.assertEqual(self.text(), before)

    async def test_clicking_a_submitted_question_only_moves_the_focus(self):
        self.questions.write_text(SINGLE.replace("答覆：\n\n- [ ] 送出", "答覆：A. 合併到 dev，不推送\n\n- [x] 送出"))
        app = self.make_app()
        async with app.run_test(size=(80, 24)) as pilot:
            before = self.text()
            await self.click_row(app, pilot, "C. 先不合併")
            self.assertEqual(self.text(), before)
            self.assertEqual(app.current.focus[:2], ("option", 2))


class TerminalMouseTests(SelectorTestCase):
    """The real panel process on a pty that answers the way a Herdr pane does."""

    def setUp(self):
        super().setUp()
        self.questions.write_text(CHECK)

    def run_panel(self, columns, rows):
        environment = dict(
            os.environ, LAT_PANEL_FILE=str(self.questions), LAT_PANEL_SESSION_ID="s-a",
            LAT_PANEL_HERDR_WORKSPACE="ws-a", TERM="xterm-256color",
        )
        for name in ("LAT_PANEL_CHOICES", "LAT_PANEL_ERROR"):
            environment.pop(name, None)
        pid, terminal = pty.fork()
        if pid == 0:
            os.execve(
                sys.executable, [sys.executable, str(HERDR_PANEL / "panel.py"), "edit"],
                environment,
            )
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

        def stop():
            try:
                os.write(terminal, b"\x11")
            except OSError:
                pass
            deadline = time.monotonic() + 5
            while os.waitpid(pid, os.WNOHANG) == (0, 0):
                if time.monotonic() > deadline:
                    os.kill(pid, 9)
                    os.waitpid(pid, 0)
                    break
                self.read(terminal, 0.1)
            os.close(terminal)

        self.addCleanup(stop)
        return terminal

    def read(self, terminal, seconds):
        if not select.select([terminal], [], [], seconds)[0]:
            return b""
        try:
            return os.read(terminal, 65536)
        except OSError:
            return b""

    def read_until(self, terminal, wanted, output=b"", replies=()):
        """Collect panel output until ``wanted`` appears, answering mode requests."""
        replies = dict(replies)
        deadline = time.monotonic() + 10
        while wanted not in output and time.monotonic() < deadline:
            output += self.read(terminal, 0.1)
            for request in [request for request in replies if request in output]:
                os.write(terminal, replies.pop(request))
        return output

    def test_wheel_scrolls_when_the_terminal_offers_in_band_resize(self):
        terminal = self.run_panel(40, 12)
        # Herdr reports in-band resize as supported, then keeps sending the
        # wheel in cell coordinates even after SGR-pixel mouse is requested.
        output = self.read_until(terminal, "符合，可以結案".encode(), replies={
            b"\x1b[?2048$p": b"\x1b[?2048;2$y",
            b"\x1b[?2048h": b"\x1b[48;12;40;936;1360t",
        })
        self.assertIn("符合，可以結案".encode(), output)
        self.assertNotIn("其他（自己輸入）".encode(), output)
        output += self.read(terminal, 0.5)
        os.write(terminal, b"\x1b[<65;31;6M" * 4)
        output = self.read_until(terminal, "其他（自己輸入）".encode(), output)
        self.assertIn("其他（自己輸入）".encode(), output)
        self.assertNotIn(b"\x1b[?1016h", output)

    def test_growing_the_terminal_still_redraws_without_in_band_resize(self):
        terminal = self.run_panel(40, 12)
        output = self.read_until(terminal, "符合，可以結案".encode(), replies={
            b"\x1b[?2048$p": b"\x1b[?2048;2$y",
        })
        self.assertNotIn("其他（自己輸入）".encode(), output)
        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        output = self.read_until(terminal, "其他（自己輸入）".encode(), output)
        self.assertIn("其他（自己輸入）".encode(), output)
        self.assertNotIn(b"\x1b[?2048h", output)


if __name__ == "__main__":
    unittest.main()
