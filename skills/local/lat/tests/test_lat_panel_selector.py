"""Headless Textual tests for the V2 selector mode of the LAT panel popup.

Run with Textual available:
  uv run --no-project --with textual==8.2.8 python -m unittest discover -s "$lat_dir/tests"
"""
import json
import unittest
from unittest.mock import patch

from test_lat_panel_ui import HAS_TEXTUAL, PanelTestCase

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
        return str(app.query_one("#view").render())

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
        await pilot.press(*keys)
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
                "❯ 1. 合併到 dev，不推送",
                "     dev 有了面板程式。",
                "  2. 合併到 dev，並推送到 GitHub（建議）",
                "     repo 是公開的，程式碼會公開。",
                "  3. 先不合併",
                "     繼續保留在目前分支。",
                "  4. 其他（自己輸入）",
            ])
            self.assertEqual(self.keys(app), "Enter 選擇 · ↑↓ 移動 · ←→ 換題 · Tab 備註 · Esc 關閉")
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
            await self.press(pilot, "up", "down", "down", "up")
            self.assertEqual(app.current.cursor, 1)
            await self.press(pilot, "down", "down", "down", "down")
            self.assertEqual(app.current.cursor, 3)
            self.assertIn("❯ 4. 其他（自己輸入）", self.view(app))
            self.assertEqual(self.text(), before)

    async def test_digit_and_enter_write_a_single_draft_that_replaces_the_last(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "2")
            self.assertIn("答覆：B. 合併到 dev，並推送到 GitHub（建議）\n\n- [ ] 送出", section(self.text(), "Q1"))
            self.assertIn("☒ 正式版要怎麼併…", self.tabs(app))
            self.assertIn("2. 合併到 dev，並推送到 GitHub（建議）  ✔", self.view(app))
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
            await self.press(pilot, "4", *["backspace"] * 5, "escape")
            self.assertIn("答覆：\n\n- [ ] 送出", section(self.text(), "Q1"))
            self.assertNotIn("✔", self.view(app))

    async def test_tab_adds_a_note_after_an_answer_only(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "tab")
            self.assertIsNone(app.focused)
            self.assertIn("先選擇或輸入答覆", self.status(app))
            await self.press(pilot, "1", "tab", *"why", "enter", *"more", "escape")
            self.assertIn("答覆：A. 合併到 dev，不推送\n備註：why\nmore\n\n- [ ] 送出", self.text())
            self.assertIn("備註：why", self.view(app))
            self.assertEqual(self.status(app), "")

    async def test_cursor_starts_on_first_option_even_when_another_is_recommended(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(app.current.cursor, 0)
            await self.press(pilot, "enter")
            self.assertIn("答覆：A. 合併到 dev，不推送\n", self.text())


class MultiSelectTests(SelectorTestCase):
    async def test_space_and_digits_toggle_in_selection_order_and_enter_moves_on(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right")
            self.assertIn("❯ 1. [ ] 主控綁定", self.view(app))
            await self.press(pilot, "3", "up", "up", "space")
            self.assertIn("答覆：通知；主控綁定\n\n- [ ] 送出", section(self.text(), "Q2"))
            self.assertIn("  2. [ ] 封存", self.view(app))
            self.assertIn("[x] 通知", self.view(app))
            await self.press(pilot, "down", "down", "space")
            self.assertIn("答覆：主控綁定\n", self.text())
            self.assertIn("- [ ] 主控綁定\n  綁定 tab。\n- [ ] 封存\n- [ ] 通知\n", self.text())
            await self.press(pilot, "4", *"自訂", "escape")
            self.assertIn("答覆：主控綁定；其他：自訂\n", self.text())
            await self.press(pilot, "1")
            self.assertIn("答覆：其他：自訂\n", self.text())
            await self.press(pilot, "enter")
            self.assertEqual(app.current.id, "Q3")
        self.assertEqual(self.calls(), [])

    async def test_unchecking_everything_clears_the_draft(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "2", "2")
            self.assertEqual(section(self.text(), "Q2"), MULTI + "\n")
            self.assertIn("☐ 要開哪些功能？", self.tabs(app))


class InputOnlyTests(SelectorTestCase):
    async def test_input_only_question_writes_plain_text_and_explains_why(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "right", "right")
            self.assertIn("答覆：（按 Enter 輸入）", self.view(app))
            self.assertEqual(self.status(app), "Q3：題目沒有可解析的選項，只能輸入文字")
            await self.press(pilot, "1", "space")
            self.assertTrue(self.text().endswith(TEXT))
            await self.press(pilot, "enter", *"想法", "escape")
            self.assertTrue(self.text().endswith("答覆：想法\n\n- [ ] 送出\n"))
            self.assertIn("答覆：想法", self.view(app))

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
            self.assertIn("2. 合併到 dev，並推送到 GitHub（建議）  ✔", self.view(app))
            self.assertIn("備註：hand", self.view(app))
            await self.press(pilot, "right")
            self.assertEqual(app.current.selected, [2, 0, 3])
            self.assertIn("4. [x] 其他（自己輸入）\n         x", self.view(app))
            await self.press(pilot, "right")
            self.assertIn("答覆：line1\n      line2", self.view(app))
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
            self.assertIn("☒ 正式版要怎麼併入？：Z. 不存在", self.view(app))
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
                "☒ 正式版要怎麼併入？：B. 合併到 dev，並推送到 GitHub（建議）",
                "☒ 要開哪些功能？：主控綁定",
                "☐ 還有什麼想法？：（未作答）",
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

    async def test_submitted_tab_is_read_only_until_recorded_then_shows_recorded(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.press(pilot, "1", "right", "right", "right", "enter")
            await self.settle(app, pilot)
            await self.press(pilot, "left", "left", "left")
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
            self.assertIn("❯ 1. 只合併", self.view(app))
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
            self.assertIn("3. 先不合併  ✔", self.view(app))
        self.assertEqual(self.calls(), [])

    async def test_raw_conflict_blocks_switching_back_until_f5(self):
        app = self.make_app(POLL_INTERVAL=60)
        async with app.run_test() as pilot:
            await self.press(pilot, "ctrl+e")
            self.questions.write_text(self.text() + "\n# Agent\n")
            app.editor.move_cursor((0, 0))
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


if __name__ == "__main__":
    unittest.main()
