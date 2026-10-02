"""Headless Textual tests for the LAT panel popup; HCOM and Herdr are stubbed.

Run with Textual available:
  uv run --no-project --with textual==8.2.8 python -m unittest discover -s "$lat_dir/tests"
"""
import importlib.util
import json
import os
from pathlib import Path
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
    "## Q1 | r1 | pending\n問題：Choose\n選項：A\n建議：A\n影響：None\n答覆：\n批註：\n"
)
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
        self.assertIn('dependencies = ["textual==8.2.8"]', (HERDR_PANEL / "panel.py").read_text())


@unittest.skipUnless(HAS_TEXTUAL, "needs textual==8.2.8 (uv run --with textual==8.2.8)")
class PanelTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.panel = load_panel()
        self.core = self.panel.lat_panel
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.project = self.root / "project"
        self.questions = self.project / ".lat/questions.md"
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
        self.core.bind_controller("ctl-a", "claude", "s-a", self.project, "ws-a")

    def set_hcom(self, mode):
        (self.hcom_dir / "mode").write_text(mode)

    def calls(self):
        log = self.hcom_dir / "calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def make_app(self, error="", **timing):
        attributes = {"NOTIFY_DELAY": 0.3, "POLL_INTERVAL": 0.1, "NOTIFY_TIMEOUT": 1, **timing}
        app_class = type("TestPanel", (self.panel.Panel,), attributes)
        return app_class(str(self.questions), "ws-a", error)

    def status(self, app):
        status = app.query_one("#status")
        return str(status.render()) if status.display else ""

    def pending(self):
        return self.core.notification_is_pending(self.questions)

    async def settle(self, app, pilot, seconds=0.0):
        await pilot.pause(seconds)
        await app.workers.wait_for_complete()
        await pilot.pause()


class EditorTests(PanelTestCase):
    async def test_layout_is_editor_and_one_key_line_with_herdr_theme(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            self.assertEqual(app.theme, "catppuccin-latte")
            self.assertEqual(app.editor.text, QUESTIONS)
            self.assertEqual(str(app.query_one("#keys").render()), self.panel.KEYS)
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

    async def test_typing_saves_immediately_with_journal_and_undo_redo(self):
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            app.editor.move_cursor((5, 3))
            await pilot.press("B")
            await pilot.pause()
            self.assertIn("答覆：B\n", self.questions.read_text())
            self.assertEqual(self.status(app), "")
            journal = (self.questions.parent / "panel-journal.jsonl").read_text().splitlines()
            self.assertEqual(json.loads(journal[-1])["changed_questions"][0]["id"], "Q1")
            await pilot.press("ctrl+z")
            await pilot.pause()
            self.assertEqual(self.questions.read_text(), QUESTIONS)
            await pilot.press("ctrl+y")
            await pilot.pause()
            self.assertIn("答覆：B\n", self.questions.read_text())
            self.assertEqual(len(
                (self.questions.parent / "panel-journal.jsonl").read_text().splitlines()
            ), 3)

    async def test_external_update_loads_without_notification_and_resets_undo(self):
        app = self.make_app()
        async with app.run_test() as pilot:
            updated = QUESTIONS.replace("建議：A", "建議：B")
            self.core.upsert_question(self.questions, "Q1", updated)
            await pilot.pause(0.4)
            self.assertEqual(app.editor.text, updated)
            await pilot.press("ctrl+z")
            await self.settle(app, pilot, 0.5)
            self.assertEqual(app.editor.text, updated)
            self.assertEqual(self.questions.read_text(), updated)
            self.assertEqual(self.calls(), [])
            self.assertFalse(self.pending())
            self.assertEqual(self.status(app), "")

    async def test_conflict_pauses_saving_and_f5_backs_up_draft_then_loads_disk(self):
        app = self.make_app(POLL_INTERVAL=60, NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            agent_text = QUESTIONS.replace("建議：A", "建議：Agent")
            self.questions.write_text(agent_text)
            app.editor.move_cursor((5, 3))
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
            [backup] = self.questions.parent.glob("questions-draft-*.md")
            self.assertIn("答覆：xy\n", backup.read_text())
            self.assertEqual(app.editor.text, agent_text)
            self.assertEqual(self.status(app), "")
            await pilot.press("z")
            await pilot.pause()
            self.assertIn("建議：Agent", self.questions.read_text())

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
    def open(self, workspace):
        requests = []

        def request(method, params, env):
            requests.append((method, params))
            return {"result": "ok"}

        self.panel.open_popup({"HERDR_WORKSPACE_ID": workspace}, request=request)
        [(method, params)] = requests
        self.assertEqual(method, "plugin.pane.open")
        self.assertEqual(
            (params["plugin_id"], params["entrypoint"], params["placement"]),
            ("lat.panel", "popup", "popup"),
        )
        return params["env"]

    def test_open_resolves_each_workspace_binding_and_never_guesses(self):
        other = self.root / "other"
        self.assertEqual(self.open("ws-a")["LAT_PANEL_FILE"], str(self.questions))
        self.assertEqual(self.open("ws-unknown")["LAT_PANEL_FILE"], str(self.questions))
        self.core.bind_controller("ctl-b", "codex", "s-b", other, "ws-b")
        self.assertEqual(self.open("ws-b")["LAT_PANEL_FILE"], str(other / ".lat/questions.md"))
        self.assertEqual(self.open("ws-a")["LAT_PANEL_HERDR_WORKSPACE"], "ws-a")
        unbound = self.open("ws-unknown")
        self.assertNotIn("LAT_PANEL_FILE", unbound)
        self.assertEqual(unbound["LAT_PANEL_ERROR"], self.panel.NO_BINDING)
        self.assertEqual(
            self.panel.Panel.from_env({"LAT_PANEL_ERROR": self.panel.NO_BINDING}).notices["file"],
            self.panel.NO_BINDING,
        )


class NotificationTests(PanelTestCase):
    async def type_and_wait(self, app, pilot, keys, wait, gap=0.1):
        app.editor.move_cursor((5, 3))
        for key in keys:
            await pilot.press(key)
            await pilot.pause(gap)
        await self.settle(app, pilot, wait)

    async def test_idle_debounce_coalesces_typing_into_one_notification(self):
        app = self.make_app(NOTIFY_DELAY=1.0)
        async with app.run_test() as pilot:
            # Typing spans longer than the idle delay; only the final pause sends.
            await self.type_and_wait(app, pilot, "abcdefg", 0, gap=0.25)
            self.assertEqual(self.calls(), [])
            self.assertTrue(self.pending())
            await self.settle(app, pilot, 1.5)
            [call] = self.calls()
            self.assertEqual(call[:4], ["send", "@ctl-a", "--from", "lat-panel"])
            self.assertIn(str(self.questions), call[-1])
            self.assertNotIn("答覆", call[-1])
            self.assertFalse(self.pending())
            self.assertEqual(self.status(app), "")

    async def test_notification_goes_to_the_current_workspace_binding(self):
        self.core.bind_controller("ctl-new", "codex", "s-new", self.project, "ws-a")
        app = self.make_app()
        async with app.run_test() as pilot:
            await self.type_and_wait(app, pilot, "a", 0.6)
            self.assertEqual([call[1] for call in self.calls()], ["@ctl-new"])

    async def test_close_flushes_pending_notification_before_exit(self):
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.type_and_wait(app, pilot, "a", 0)
            self.assertEqual(self.calls(), [])
            await pilot.press("ctrl+q")
            await self.settle(app, pilot)
            self.assertEqual(len(self.calls()), 1)
            self.assertFalse(self.pending())
            self.assertIsNotNone(app.return_code)

    async def test_each_failure_kind_is_visible_and_ctrl_n_retries(self):
        cases = (
            ("offline", "通知失敗：ctl-a 不在線。"),
            ("undelivered", "通知失敗：ctl-a 未收到通知（不在線或未送達）。"),
            ("broken", "通知失敗：HCOM 錯誤：Error: database is locked。"),
            ("hang", "通知失敗：通知逾時。"),
        )
        for mode, expected in cases:
            with self.subTest(mode=mode):
                self.set_hcom(mode)
                app = self.make_app()
                async with app.run_test() as pilot:
                    await self.type_and_wait(app, pilot, "a", 0.6 if mode != "hang" else 1.5)
                    self.assertEqual(self.status(app), expected + FAILURE_SUFFIX)
                    self.assertTrue(self.pending())
                    self.set_hcom("deliver")
                    await pilot.press("ctrl+n")
                    await self.settle(app, pilot)
                    self.assertEqual(self.status(app), "")
                    self.assertFalse(self.pending())

    async def test_failed_flush_closes_only_on_second_ctrl_q_and_keeps_pending(self):
        self.set_hcom("offline")
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.type_and_wait(app, pilot, "a", 0)
            await pilot.press("ctrl+q")
            await self.settle(app, pilot)
            self.assertIsNone(app.return_code)
            self.assertIn("通知失敗：ctl-a 不在線", self.status(app))
            self.assertTrue(self.pending())
            await pilot.press("ctrl+q")
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
                await self.type_and_wait(app, pilot, "a", 0)
            self.assertIn("答覆：a\n", self.questions.read_text())
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
                await self.type_and_wait(app, pilot, "a", 0)
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
        self.set_hcom("slow")
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.type_and_wait(app, pilot, "a", 0)
            await pilot.press("ctrl+q")
            await pilot.pause(0.1)
            await pilot.press("b")
            await self.settle(app, pilot)
            self.assertIsNotNone(app.return_code)
        self.assertIn("答覆：a\n", self.questions.read_text())
        self.assertFalse(self.pending())
        self.assertEqual(len(self.calls()), 1)

    async def test_pending_notification_is_resent_on_next_open(self):
        self.core.mark_notification_pending(self.questions)
        app = self.make_app(NOTIFY_DELAY=30)
        async with app.run_test() as pilot:
            await self.settle(app, pilot, 0.1)
            self.assertEqual(len(self.calls()), 1)
            self.assertFalse(self.pending())


if __name__ == "__main__":
    unittest.main()
