"""Headless Textual tests for the LAT panel popup; HCOM and Herdr are stubbed.

Run with Textual available:
  uv run --no-project --with textual==8.2.8 python -m unittest discover -s "$lat_dir/tests"
"""
import importlib.util
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import tempfile
import tomllib
import unittest
from unittest.mock import patch

HERDR_PANEL = Path(__file__).resolve().parents[1] / "herdr-panel"
HAS_TEXTUAL = importlib.util.find_spec("textual") is not None

HCOM_SHIM = """#!/usr/bin/env python3
import json, os, pathlib, sys, time
root = pathlib.Path(os.environ["LAT_TEST_HCOM_DIR"])
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
mode = (root / "mode").read_text().strip()
target = sys.argv[2].removeprefix("@")
if mode == "deliver":
    print(json.dumps({"delivered_to": [target]}))
elif mode == "undelivered":
    print(json.dumps({"delivered_to": []}))
elif mode == "offline":
    print(f"Error: No active agent for @{target}", file=sys.stderr)
    sys.exit(1)
elif mode == "broken":
    print("Error: database is locked", file=sys.stderr)
    sys.exit(1)
elif mode == "hang":
    time.sleep(5)
elif mode == "slow":
    time.sleep(0.5)
    print(json.dumps({"delivered_to": [target]}))
"""

QUESTIONS = (
    "## Choose?\nQ1 · r1 · 待答\n\nA. Yes（建議）\n   No impact.\n"
    "B. No\n   Other impact.\n\n答覆：\n\n- [ ] 送出\n"
)
# Raw-editor line between 答覆： and - [ ] 送出 in QUESTIONS.
ANSWER_LINE = 9
FAILURE_SUFFIX = "Ctrl+N 重試；再按 Ctrl+Q 保留待送並關閉"


def load_panel():
    spec = importlib.util.spec_from_file_location("lat_panel_ui", HERDR_PANEL / "panel.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ManifestTests(unittest.TestCase):
    def test_manifest_declares_lat_panel_open_action_and_95_percent_popup(self):
        manifest = tomllib.loads((HERDR_PANEL / "herdr-plugin.toml").read_text())
        self.assertEqual(manifest["id"], "lat.panel")
        self.assertEqual(manifest["min_herdr_version"], "0.9.3")
        for key in ("name", "version", "platforms"):
            self.assertIn(key, manifest)
        [action] = manifest["actions"]
        self.assertEqual(action["id"], "open")
        self.assertEqual(action["command"][-2:], ["panel.py", "open"])
        [pane] = manifest["panes"]
        self.assertEqual(
            (pane["id"], pane["placement"], pane["width"], pane["height"]),
            ("popup", "popup", "95%", "95%"),
        )
        self.assertEqual(pane["command"][-2:], ["panel.py", "edit"])
        panel_source = (HERDR_PANEL / "panel.py").read_text()
        self.assertIn('dependencies = ["textual==8.2.8"]', panel_source)
        self.assertIn('NO_BINDING = "此 workspace 沒有綁定的 LAT 主控"', panel_source)
        self.assertNotIn("中控", panel_source)


@unittest.skipUnless(HAS_TEXTUAL, "needs textual==8.2.8 (uv run --with textual==8.2.8)")
class PanelTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.panel = load_panel()
        self.core = self.panel.lat_panel
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.project = self.root / "project"
        self.questions = self.project / ".lat/questions-ctl-a.md"
        self.questions.parent.mkdir(parents=True)
        self.questions.write_text(QUESTIONS)
        self.hcom_dir = self.root / "hcom"
        (self.hcom_dir / "bin").mkdir(parents=True)
        shim = self.hcom_dir / "bin/hcom"
        shim.write_text(HCOM_SHIM)
        shim.chmod(0o755)
        self.set_hcom("deliver")
        self.config = self.root / "herdr.toml"
        self.config.write_text('[theme]\nname = "catppuccin-latte"\n')
        environment = patch.dict(os.environ, {
            "PATH": f"{self.hcom_dir / 'bin'}:{os.environ['PATH']}",
            "LAT_TEST_HCOM_DIR": str(self.hcom_dir),
            "HERDR_PLUGIN_CONFIG_DIR": str(self.root / "plugin-config"),
            "HERDR_PLUGIN_STATE_DIR": str(self.root / "plugin-state"),
            "HERDR_CONFIG_PATH": str(self.config),
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.core.bind_controller(
            "ctl-a", "claude", "s-a", self.project, "ws-a", "tab-a", "pane-a"
        )

    def set_hcom(self, mode):
        (self.hcom_dir / "mode").write_text(mode)

    def calls(self):
        log = self.hcom_dir / "calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def make_app(self, error="", **timing):
        attributes = {"NOTIFY_DELAY": 0.3, "POLL_INTERVAL": 0.1, "NOTIFY_TIMEOUT": 1, **timing}
        app_class = type("TestPanel", (self.panel.Panel,), attributes)
        return app_class(str(self.questions), "ws-a", error, session_id="s-a")

    def status(self, app):
        status = app.query_one("#status")
        return str(status.render()) if status.display else ""

    def pending(self):
        return self.core.notification_is_pending(self.questions)

    async def settle(self, app, pilot, seconds=0.0):
        await pilot.pause(seconds)
        await app.workers.wait_for_complete()
        await pilot.pause()

    async def raw(self, pilot):
        """Switch the selector to the V1 raw-file editor (Ctrl+E)."""
        await pilot.press("ctrl+e")
        await pilot.pause()

    async def submit_first_option(self, app, pilot):
        """Draft option 1 on the first tab, then 送出 from the review tab."""
        await pilot.press("1", "right", "enter")
        await pilot.pause()


class RawEditorTests(PanelTestCase):
    async def test_ctrl_e_shows_raw_file_with_one_key_line_and_herdr_theme(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(app.theme, "catppuccin-latte")
            self.assertFalse(app.editor.display)
            await self.raw(pilot)
            self.assertTrue(app.editor.display)
            self.assertEqual(app.editor.text, QUESTIONS)
            self.assertEqual(str(app.query_one("#keys").render()), self.panel.RAW_KEYS)
            self.assertEqual(self.status(app), "")
            await pilot.press("ctrl+q")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)

    async def test_unusable_or_unreadable_theme_falls_back_with_visible_notice(self):
        for config, expected in (
            ('[theme]\nname = "no-such-theme"\n', "no-such-theme 無法套用"),
            (None, "無法讀取 Herdr 設定"),
        ):
            with self.subTest(expected=expected):
                if config is None:
                    self.config.unlink()
                else:
                    self.config.write_text(config)
                app = self.make_app()
                async with app.run_test():
                    self.assertNotEqual(app.theme, "no-such-theme")
                    self.assertIn(expected, self.status(app))
                    self.assertIn("使用預設配色", self.status(app))

    async def test_checked_malformed_submission_shows_persistent_status_error(self):
        malformed = QUESTIONS.replace("答覆：\n\n- [ ] 送出", "- [X] 送出")
        self.questions.write_text(malformed)
        app = self.make_app()

        async with app.run_test() as pilot:
            expected = "送出格式錯誤：Q1 已勾選送出，但找不到完整的答覆格式"
            self.assertEqual(self.status(app), expected)
            await pilot.pause(0.2)
            self.assertEqual(self.status(app), expected)

    async def test_typing_saves_immediately_with_journal_and_undo_redo(self):
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.raw(pilot)
            app.editor.move_cursor((ANSWER_LINE, 0))
            await pilot.press("B")
            await pilot.pause()
            self.assertIn("答覆：\nB\n", self.questions.read_text())
            self.assertEqual(self.status(app), "")
            journal = (self.questions.parent / "panel-journal.jsonl").read_text().splitlines()
            self.assertEqual(json.loads(journal[-1])["changed_questions"][0]["id"], "Q1")
            await pilot.press("ctrl+z")
            await pilot.pause()
            self.assertEqual(self.questions.read_text(), QUESTIONS)
            await pilot.press("ctrl+y")
            await pilot.pause()
            self.assertIn("答覆：\nB\n", self.questions.read_text())
            self.assertEqual(len(
                (self.questions.parent / "panel-journal.jsonl").read_text().splitlines()
            ), 3)

    async def test_mixed_cjk_lines_wrap_between_characters_and_stay_editable(self):
        sample = "本機和 GitHub 都更新；repo 是公開的，程式碼會公開（已查過沒有本機路徑或個人資料）。"
        self.questions.write_text(sample + "\n")
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test(size=(26, 10)) as pilot:
            await self.raw(pilot)
            self.assertEqual(app.editor.wrap_width, 23)
            self.assertEqual([app.editor.render_line(y).text.rstrip() for y in range(4)], [
                "本機和 GitHub 都更新；",
                "repo 是公開的，程式碼會",
                "公開（已查過沒有本機路",
                "徑或個人資料）。",
            ])
            await pilot.press("down")
            self.assertEqual(app.editor.cursor_location, (0, 15))
            await pilot.press("shift+down")
            self.assertEqual(app.editor.selected_text, "repo 是公開的，程式碼會")
            await pilot.press("right", "X")
            await pilot.pause()
            self.assertEqual(self.questions.read_text(), sample.replace("會公開", "會X公開") + "\n")
            await pilot.press("ctrl+z")
            await pilot.pause()
            self.assertEqual(self.questions.read_text(), sample + "\n")

    async def test_external_update_loads_without_notification_and_resets_undo(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.raw(pilot)
            self.core.upsert_question(
                self.questions,
                "Q1",
                "## Choose?\n\nA. Yes（建議）\n   Changed impact.\n",
            )
            updated = self.questions.read_text()
            await pilot.pause(0.4)
            self.assertEqual(app.editor.text, updated)
            await pilot.press("ctrl+z")
            await self.settle(app, pilot, 0.5)
            self.assertEqual(app.editor.text, updated)
            self.assertEqual(self.questions.read_text(), updated)
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.pending())
            self.assertEqual(self.status(app), "")

    async def test_recorded_question_is_archived_on_open_without_notify(self):
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        expected_hash = self.core._section_sha256(
            self.core.parse_questions(self.questions.read_text())[0]
        )
        self.core.set_question_status(
            self.questions, "Q1", 1, "recorded", expected_hash, now=recorded_at,
        )
        app = self.make_app(
            ARCHIVE_AFTER=300,
            archive_now=lambda _self: recorded_at + timedelta(seconds=301),
        )

        async with app.run_test():
            self.assertNotIn("Q1 · r1", app.saved)
            self.assertEqual(app.tab_ids, [])
            self.assertIn(
                "## Choose?", self.core._archive_path(self.questions).read_text()
            )
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.pending())

    async def test_recorded_questions_are_archived_periodically_without_notify(self):
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        expected_hash = self.core._section_sha256(
            self.core.parse_questions(self.questions.read_text())[0]
        )
        self.core.set_question_status(
            self.questions, "Q1", 1, "recorded", expected_hash, now=recorded_at,
        )
        clock = [recorded_at + timedelta(seconds=299)]
        app = self.make_app(
            POLL_INTERVAL=0.05,
            ARCHIVE_AFTER=300,
            archive_now=lambda _self: clock[0],
        )

        async with app.run_test() as pilot:
            await self.raw(pilot)
            self.assertIn("Q1 · r1 · 已記錄", app.editor.text)
            self.assertFalse(self.core._archive_path(self.questions).exists())
            clock[0] = recorded_at + timedelta(seconds=301)
            await pilot.pause(0.2)
            self.assertNotIn("Q1 · r1", app.editor.text)
            self.assertEqual(app.editor.text, self.questions.read_text())
            self.assertIn(
                "## Choose?", self.core._archive_path(self.questions).read_text()
            )
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.pending())

    async def test_conflict_pauses_saving_and_f5_backs_up_draft_then_loads_disk(self):
        app = self.make_app(POLL_INTERVAL=60, NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.raw(pilot)
            agent_text = QUESTIONS.replace("No impact.", "Agent impact.")
            self.questions.write_text(agent_text)
            app.editor.move_cursor((ANSWER_LINE, 0))
            await pilot.press("x")
            await pilot.pause()
            self.assertEqual(self.status(app), self.panel.CONFLICT)
            await pilot.press("y")
            await pilot.pause()
            self.assertEqual(self.questions.read_text(), agent_text)
            await pilot.press("ctrl+q")
            await pilot.pause()
            self.assertIsNone(app.return_code)
            self.assertIn("先按 F5", self.status(app))

            await pilot.press("f5")
            await pilot.pause()
            [backup] = self.questions.parent.glob("questions-ctl-a-draft-*.md")
            self.assertIn("答覆：\nxy\n", backup.read_text())
            self.assertEqual(app.editor.text, agent_text)
            self.assertEqual(self.status(app), "")
            await pilot.press("z")
            await pilot.pause()
            self.assertIn("Agent impact.", self.questions.read_text())

    async def test_periodic_archive_leaves_a_recorded_section_with_conflict_draft(self):
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        expected_hash = self.core._section_sha256(
            self.core.parse_questions(self.questions.read_text())[0]
        )
        self.core.set_question_status(
            self.questions, "Q1", 1, "recorded", expected_hash, now=recorded_at,
        )
        self.core.upsert_question(self.questions, "Q2", "## Other?\n\nFree text.\n")
        recorded = self.questions.read_text()
        clock = [recorded_at + timedelta(seconds=299)]
        app = self.make_app(
            ARCHIVE_AFTER=300,
            archive_now=lambda _self: clock[0],
        )

        with patch.object(app, "set_interval", return_value=None):
            async with app.run_test() as pilot:
                await self.raw(pilot)
                self.questions.write_text("# Agent note\n\n" + recorded)
                # Q1 is recorded and read-only; the conflicting draft goes into Q2.
                app.editor.move_cursor((recorded.splitlines().index("Free text."), 0))
                await pilot.press("x")
                await pilot.pause()
                self.assertTrue(app.conflict)
                clock[0] = recorded_at + timedelta(seconds=301)
                app.check_external()
                await pilot.pause()
                self.assertEqual(self.questions.read_text(), "# Agent note\n\n" + recorded)
                self.assertFalse(self.core._archive_path(self.questions).exists())
                self.assertIn("外部內容已變更", self.status(app))

    async def test_missing_binding_or_file_opens_read_only_with_reason(self):
        for error, expected in (
            (self.panel.NO_BINDING, self.panel.NO_BINDING),
            ("", f"問題檔不存在：{self.questions}"),
        ):
            with self.subTest(expected=expected):
                if not error:
                    self.questions.unlink()
                app = self.make_app(error)
                async with app.run_test() as pilot:
                    self.assertIn(expected, self.status(app))
                    self.assertTrue(app.editor.read_only)
                    await pilot.press("a")
                    await pilot.pause()
                    self.assertEqual(app.editor.text, "")
                    self.assertEqual(self.questions.exists(), bool(error))
                    await pilot.press("ctrl+q")
                    await pilot.pause()
                    self.assertIsNotNone(app.return_code)


class OpenActionTests(PanelTestCase):
    def open(self, workspace, tab, panes=None, *, snapshot_error=None):
        requests = []

        def request(method, params, env):
            requests.append((method, params))
            if method == "session.snapshot":
                if snapshot_error:
                    raise RuntimeError(snapshot_error)
                return {"result": {"type": "session_snapshot", "snapshot": {
                    "panes": panes or [],
                }}}
            return {"result": "ok"}

        self.panel.open_popup(
            {"HERDR_WORKSPACE_ID": workspace, "HERDR_TAB_ID": tab}, request=request
        )
        method, params = requests[-1]
        self.assertEqual(method, "plugin.pane.open")
        self.assertEqual(
            (params["plugin_id"], params["entrypoint"], params["placement"]),
            ("lat.panel", "popup", "popup"),
        )
        return params["env"]

    def test_tab_match_uses_current_pane_tab_instead_of_recorded_tab(self):
        other = self.root / "other"
        self.core.bind_controller(
            "ctl-b", "codex", "s-b", other, "ws-a", "old-tab", "pane-b"
        )
        opened = self.open("ws-a", "new-tab", [
            {"pane_id": "pane-a", "tab_id": "tab-a", "workspace_id": "ws-a"},
            {"pane_id": "pane-b", "tab_id": "new-tab", "workspace_id": "ws-a"},
        ])
        self.assertEqual(opened["LAT_PANEL_SESSION_ID"], "s-b")
        self.assertEqual(opened["LAT_PANEL_FILE"], str(other / ".lat/questions-ctl-b.md"))

    def test_snapshot_failure_falls_back_to_recorded_tab(self):
        opened = self.open("ws-a", "tab-a", snapshot_error="unavailable")
        self.assertEqual(opened["LAT_PANEL_SESSION_ID"], "s-a")

    def test_single_picker_and_none_routes(self):
        self.assertEqual(self.open("ws-a", "third", [])["LAT_PANEL_SESSION_ID"], "s-a")
        other = self.root / "other"
        self.core.bind_controller(
            "ctl-b", "codex", "s-b", other, "ws-a", "tab-b", "pane-b"
        )
        picker = self.open("ws-a", "third", [])
        choices = json.loads(picker["LAT_PANEL_CHOICES"])
        self.assertEqual([item["session_id"] for item in choices], ["s-a", "s-b"])
        self.assertNotIn("LAT_PANEL_FILE", picker)

        unbound = self.open("ws-unknown", "tab-z", [])
        self.assertNotIn("LAT_PANEL_FILE", unbound)
        self.assertEqual(unbound["LAT_PANEL_ERROR"], self.panel.NO_BINDING)
        self.assertEqual(
            self.panel.Panel.from_env({"LAT_PANEL_ERROR": self.panel.NO_BINDING}).notices["file"],
            self.panel.NO_BINDING,
        )

    async def test_picker_accepts_digit_ignores_invalid_key_and_ctrl_q_closes(self):
        other = self.root / "other"
        other_questions = other / ".lat/questions-ctl-b.md"
        other_questions.parent.mkdir(parents=True)
        other_questions.write_text(QUESTIONS.replace("Q1", "Q2"))
        choices = [
            {
                "hcom_name": "ctl-a", "workspace": str(self.project),
                "questions_path": str(self.questions), "session_id": "s-a",
            },
            {
                "hcom_name": "ctl-b", "workspace": str(other),
                "questions_path": str(other_questions), "session_id": "s-b",
            },
        ]
        panel_env = {
            "LAT_PANEL_HERDR_WORKSPACE": "ws-a",
            "LAT_PANEL_CHOICES": json.dumps(choices),
            "HERDR_CONFIG_PATH": str(self.config),
        }
        close_app = self.panel.Panel.from_env(panel_env)
        async with close_app.run_test() as pilot:
            await pilot.press("ctrl+q")
            await pilot.pause()
            self.assertIsNotNone(close_app.return_code)

        app = self.panel.Panel.from_env(panel_env)
        async with app.run_test() as pilot:
            self.assertEqual(
                str(app.query_one("#picker").render()),
                "1 ctl-a（project）  2 ctl-b（other）",
            )
            await pilot.press("x")
            await pilot.pause()
            self.assertTrue(app.picker_active)
            await pilot.press("2")
            await pilot.pause()
            self.assertFalse(app.picker_active)
            self.assertEqual(app.session_id, "s-b")
            self.assertEqual(app.tab_ids, ["Q2"])
            await pilot.press("ctrl+q")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)

    async def test_picker_pages_past_nine_controllers_with_single_digit_choices(self):
        choices = []
        for index in range(1, 11):
            questions = self.root / f"project-{index}/.lat/questions-ctl-{index}.md"
            questions.parent.mkdir(parents=True)
            questions.write_text(QUESTIONS.replace("Q1", f"Q{index}"))
            choices.append({
                "hcom_name": f"ctl-{index}",
                "workspace": str(self.root / f"project-{index}"),
                "questions_path": str(questions),
                "session_id": f"s-{index}",
            })
        app = self.panel.Panel.from_env({
            "LAT_PANEL_HERDR_WORKSPACE": "ws-a",
            "LAT_PANEL_CHOICES": json.dumps(choices),
            "HERDR_CONFIG_PATH": str(self.config),
        })
        async with app.run_test() as pilot:
            self.assertIn("[1/2] ←/→ 換頁", str(app.query_one("#picker").render()))
            await pilot.press("right")
            await pilot.pause()
            self.assertIn("1 ctl-10（project-10）", str(app.query_one("#picker").render()))
            await pilot.press("1")
            await pilot.pause()
            self.assertEqual(app.session_id, "s-10")
            self.assertEqual(app.tab_ids, ["Q10"])


class NotificationTests(PanelTestCase):
    async def test_drafts_stay_silent_and_raw_submit_check_notifies_once_after_idle(self):
        app = self.make_app(NOTIFY_DELAY=1.0)
        async with app.run_test() as pilot:
            await pilot.press("1", "tab", *"why", "escape")
            await self.settle(app, pilot, 0.3)
            await self.raw(pilot)
            app.editor.move_cursor((ANSWER_LINE, 0))
            for key in "more":
                await pilot.press(key)
                await pilot.pause(0.25)
            await self.settle(app, pilot, 1.2)
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.pending())
            submit_line = app.editor.text.splitlines().index("- [ ] 送出")
            app.editor.replace("- [x] 送出", (submit_line, 0), (submit_line, 8))
            await pilot.pause()
            self.assertTrue(self.pending())
            self.assertEqual(self.calls(), [])
            await self.settle(app, pilot, 1.5)
            [call] = self.calls()
            self.assertEqual(call[:4], ["send", "@ctl-a", "--from", "lat-panel"])
            self.assertIn(str(self.questions), call[-1])
            self.assertNotIn("答覆", call[-1])
            self.assertFalse(self.pending())
            self.assertEqual(self.status(app), "")

    async def test_two_controllers_same_project_keep_files_and_notifications_separate(self):
        second, _replaced, _legacy = self.core.bind_controller(
            "ctl-new", "codex", "s-new", self.project, "ws-a", "tab-a", "pane-new"
        )
        self.assertNotEqual(second["questions_path"], str(self.questions))
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.submit_first_option(app, pilot)
            await self.settle(app, pilot, 0.2)
            self.assertEqual([call[1] for call in self.calls()], ["@ctl-a"])

    async def test_notification_does_not_use_another_workspaces_sole_binding(self):
        self.core.unbind_controller("s-a")
        self.core.bind_controller(
            "ctl-b", "codex", "s-b", self.project, "ws-b", "tab-b", "pane-b"
        )
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.submit_first_option(app, pilot)
            await self.settle(app, pilot, 0.2)
            self.assertEqual(self.calls(), [])
            self.assertTrue(self.pending())
            self.assertIn("no LAT controller binding for session: s-a", self.status(app))

    async def test_each_failure_kind_is_visible_and_ctrl_n_retries(self):
        cases = (
            ("offline", "通知失敗：ctl-a 不在線。"),
            ("undelivered", "通知失敗：ctl-a 未收到通知（不在線或未送達）。"),
            ("broken", "通知失敗：HCOM 錯誤：Error: database is locked。"),
            ("hang", "通知失敗：通知逾時。"),
        )
        for mode, expected in cases:
            with self.subTest(mode=mode):
                self.questions.write_text(QUESTIONS)
                self.set_hcom(mode)
                app = self.make_app()
                async with app.run_test() as pilot:
                    await self.submit_first_option(app, pilot)
                    await self.settle(app, pilot, 0.2 if mode != "hang" else 1.2)
                    self.assertEqual(self.status(app), expected + FAILURE_SUFFIX)
                    self.assertTrue(self.pending())
                    self.set_hcom("deliver")
                    await pilot.press("ctrl+n")
                    await self.settle(app, pilot)
                    self.assertEqual(self.status(app), "")
                    self.assertFalse(self.pending())

    async def test_failed_submit_flush_closes_only_on_ctrl_q_and_keeps_pending(self):
        for close_key in ("ctrl+q", "escape"):
            with self.subTest(close_key=close_key):
                self.questions.write_text(QUESTIONS)
                (self.hcom_dir / "calls.jsonl").unlink(missing_ok=True)
                shutil.rmtree(self.root / "plugin-state", ignore_errors=True)
                self.set_hcom("offline")
                app = self.make_app(NOTIFY_DELAY=30)
                async with app.run_test() as pilot:
                    await self.submit_first_option(app, pilot)
                    await self.settle(app, pilot)
                    self.assertIsNone(app.return_code)
                    self.assertIn("通知失敗：ctl-a 不在線", self.status(app))
                    self.assertTrue(self.pending())
                    await pilot.press(close_key)
                    await self.settle(app, pilot)
                    self.assertIsNotNone(app.return_code)
                self.assertEqual(len(self.calls()), 1)
                self.assertTrue(self.pending())

    async def test_failed_pending_persistence_is_retried_before_success_or_close(self):
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            with patch.object(
                self.core, "mark_notification_pending", side_effect=OSError("disk full"),
            ):
                await self.submit_first_option(app, pilot)
            self.assertIn("- [x] 送出", self.questions.read_text())
            self.assertEqual(
                self.status(app), "通知失敗：無法記錄待送通知：disk full。" + FAILURE_SUFFIX,
            )
            self.assertFalse(self.pending())
            await pilot.press("ctrl+n")
            await self.settle(app, pilot)
            self.assertEqual(len(self.calls()), 1)
            self.assertFalse(self.pending())
            self.assertEqual(self.status(app), "")

    async def test_failed_pending_persistence_blocks_first_close(self):
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            with patch.object(
                self.core, "mark_notification_pending", side_effect=OSError("disk full"),
            ):
                await self.submit_first_option(app, pilot)
                for _ in range(2):
                    await pilot.press("ctrl+q")
                    await self.settle(app, pilot)
                    self.assertIsNone(app.return_code)
                    self.assertIn("無法記錄待送通知", self.status(app))
            await pilot.press("ctrl+q")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)
        self.assertEqual(self.calls(), [])
        self.assertTrue(self.pending())

    async def test_editing_is_frozen_while_close_flush_is_in_flight(self):
        for mode, keys in (("raw", ("b",)), ("raw", ("ctrl+z",)), ("selector", ("left", "2"))):
            with self.subTest(mode=mode, keys=keys):
                self.questions.write_text(QUESTIONS)
                (self.hcom_dir / "calls.jsonl").unlink(missing_ok=True)
                self.core.mark_notification_pending(self.questions)
                self.set_hcom("offline")
                app = self.make_app(NOTIFY_DELAY=30)
                async with app.run_test() as pilot:
                    await self.settle(app, pilot)
                    if mode == "raw":
                        await self.raw(pilot)
                        app.editor.move_cursor((ANSWER_LINE, 0))
                    await pilot.press("a" if mode == "raw" else "1")
                    await pilot.pause()
                    self.set_hcom("slow")
                    await pilot.press("ctrl+q")
                    await pilot.pause(0.1)
                    await pilot.press(*keys)
                    await self.settle(app, pilot)
                    self.assertIsNotNone(app.return_code)
                if mode == "raw":
                    self.assertIn("答覆：\na\n", self.questions.read_text())
                else:
                    self.assertIn("答覆：A. Yes\n", self.questions.read_text())
                self.assertFalse(self.pending())
                self.assertEqual(len(self.calls()), 2)

    async def test_pending_notification_is_resent_on_next_open(self):
        self.core.mark_notification_pending(self.questions)
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.settle(app, pilot, 0.1)
            self.assertEqual(len(self.calls()), 1)
            self.assertFalse(self.pending())


if __name__ == "__main__":
    unittest.main()
