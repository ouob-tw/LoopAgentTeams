"""question ask and question record-chat; only disposable local files, Herdr is stubbed."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import importlib.util
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"
SESSION = "11111111-1111-4111-8111-111111111111"

SECTION = (
    "## 要合併到 dev 嗎？\n\n驗收都過了。\n\n"
    "- A. 合併，不推送（建議）\n  本機與 dev 一致。\n- B. 先不合併\n\n➡️ A：先讓本機一致。\n"
)
def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel_ask", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


HELP_SECTION = "## 請登入看板\n\n要先登入才能驗收。\n\n- A. 已完成\n- B. 做不到\n"


class AskTestCase(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.questions = self.root / ".lat/questions/orch.md"
        self.questions.parent.mkdir(parents=True)
        self.decisions = self.root / ".lat/decisions"
        self.decisions.mkdir()
        binary = self.root / "bin"
        binary.mkdir()
        herdr = binary / "herdr"
        herdr.write_text(
            "#!/bin/sh\n"
            'test "$*" = "plugin list --plugin lat.panel --json" || exit 91\n'
            "printf '%s\\n' '{\"plugins\":[{\"plugin_id\":\"lat.panel\",\"enabled\":true}]}'\n"
        )
        herdr.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{binary}:{os.environ['PATH']}",
                        HERDR_WORKSPACE_ID="herdr-workspace",
                        HERDR_PLUGIN_CONFIG_DIR=str(self.root / "plugin-config"),
                        HERDR_PLUGIN_STATE_DIR=str(self.root / "plugin-state"),
                        CODEX_THREAD_ID=SESSION, CLAUDE_CODE_SESSION_ID="")

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True, capture_output=True, env=self.env, cwd=self.root,
        )

    def section(self, text, name="section.md"):
        path = self.root / name
        path.write_text(text)
        return path

    def ask(self, text=SECTION, *extra, question_id="Q1"):
        return self.cli("question", "ask", "--questions", self.questions,
                        "--decisions", self.decisions, "--id", question_id,
                        "--file", self.section(text), *extra)

    def record(self, question_id="Q1"):
        return self.decisions / f"{question_id}.md"

    def check_pending(self):
        return self.cli("question", "check-pending", "--questions", self.questions,
                        "--decisions", self.decisions, "--session-id", SESSION)


class AskTests(AskTestCase):
    def test_one_command_writes_the_record_and_question_then_checks_for_gaps(self):
        result = self.ask(SECTION, "--advisor", "exempt requirement-discussion")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], "Q1 r1")
        self.assertTrue(result.stdout.rstrip().endswith("沒有遺漏"), result.stdout)
        self.assertEqual(self.record().read_text(), (
            "# Q1 要合併到 dev 嗎？\n\n"
            "- status: pending\n"
            "- advisor: exempt requirement-discussion\n"
            f"- session: {SESSION}\n"
            "- version: r1\n"
            "- question: 要合併到 dev 嗎？\n"
            "- options: A 合併，不推送（建議） / B 先不合併\n"
            "- authority gap: 需使用者決定\n"
            "- blocked work: 未指定\n"
        ))
        self.assertIn("## 要合併到 dev 嗎？\nQ1 · r1 · 待答", self.questions.read_text())
        self.assertEqual(self.check_pending().returncode, 0)

    def test_given_fields_replace_the_defaults(self):
        result = self.ask(SECTION, "--advisor", "needs-human", "--session-id", "other-session",
                          "--question", "要不要合併", "--authority-gap", "合併要真人核准",
                          "--blocked-work", "交付")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = self.record().read_text()
        for line in ("- session: other-session\n", "- question: 要不要合併\n",
                     "- authority gap: 合併要真人核准\n", "- blocked work: 交付\n"):
            self.assertIn(line, text)

    def test_revision_follows_the_panel_and_unchanged_content_keeps_it(self):
        self.ask(SECTION, "--advisor", "needs-human")
        unchanged = self.record().read_text()

        again = self.ask(SECTION)
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(again.stdout.splitlines()[0], "Q1 r1")
        self.assertEqual(self.record().read_text(), unchanged)

        revised = self.ask(SECTION.replace("驗收都過了。", "驗收都過了，QA 也簽了。"))
        self.assertEqual(revised.returncode, 0, revised.stdout + revised.stderr)
        self.assertEqual(revised.stdout.splitlines()[0], "Q1 r2")
        self.assertIn("- version: r2\n", self.record().read_text())
        self.assertNotIn("- version: r1", self.record().read_text())
        self.assertIn("Q1 · r2 · 待答", self.questions.read_text())

    def test_revising_an_answered_record_reopens_it_and_keeps_the_old_answer(self):
        self.ask(SECTION, "--advisor", "needs-human")
        self.record().write_text(self.record().read_text().replace(
            "- status: pending", "- status: answered") + "\n## 答覆（r1，聊天）\n\n- 答覆：好\n")

        result = self.ask(SECTION.replace("驗收都過了。", "驗收過了，但要先推送嗎？"))

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        text = self.record().read_text()
        self.assertIn("- status: pending\n", text)
        self.assertIn("- version: r2\n", text)
        self.assertIn("- 答覆：好\n", text)

    def test_reasking_after_the_question_was_archived_continues_the_record_version(self):
        self.ask(SECTION, "--advisor", "needs-human")
        self.record().write_text(self.record().read_text().replace(
            "- status: pending", "- status: answered"))
        cleanup = self.cli("question", "cleanup", "--questions", self.questions,
                           "--decisions", self.decisions)
        self.assertIn({"id": "Q1", "reason": "decision-not-pending"},
                      json.loads(cleanup.stdout)["archived"])

        result = self.ask(SECTION)

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], "Q1 r2")
        self.assertIn("- status: pending\n", self.record().read_text())
        self.assertIn("- version: r2\n", self.record().read_text())
        self.assertIn("Q1 · r2 · 待答", self.questions.read_text())

    def test_a_new_record_follows_a_question_already_in_the_panel(self):
        self.ask(SECTION, "--advisor", "needs-human")
        self.ask(SECTION.replace("驗收都過了。", "改了一次。"))
        self.record().unlink()

        result = self.ask(SECTION.replace("驗收都過了。", "又改了一次。"), "--advisor", "needs-human")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.splitlines()[0], "Q1 r3")
        self.assertIn("- version: r3\n", self.record().read_text())
        self.assertNotIn("- version: r1", self.record().read_text())

    def test_unchanged_question_on_a_closed_record_is_refused_without_changes(self):
        self.ask(SECTION, "--advisor", "needs-human")
        self.record().write_text(self.record().read_text().replace(
            "- status: pending", "- status: approved"))
        record, questions = self.record().read_text(), self.questions.read_text()

        result = self.ask(SECTION)

        self.assertEqual(result.returncode, 1)
        self.assertIn("approved", result.stderr)
        self.assertEqual((self.record().read_text(), self.questions.read_text()),
                         (record, questions))

    def test_a_new_record_needs_a_valid_advisor_line(self):
        for extra, reason in (((), "--advisor"), (("--advisor", "maybe"), "未知參謀結論")):
            with self.subTest(extra=extra):
                result = self.ask(SECTION, *extra)
                self.assertEqual(result.returncode, 1)
                self.assertIn(reason, result.stderr)
                self.assertFalse(self.record().exists())
                self.assertFalse(self.questions.exists())

    def test_record_fields_are_refused_for_an_existing_record(self):
        self.ask(SECTION, "--advisor", "needs-human")
        before = self.record().read_text()

        result = self.ask(SECTION, "--blocked-work", "交付")

        self.assertEqual(result.returncode, 1)
        self.assertIn("--blocked-work", result.stderr)
        self.assertEqual(self.record().read_text(), before)

    def test_a_failed_panel_write_leaves_no_new_record(self):
        # The section parses, so the record is written; the broken panel copy fails the upsert.
        self.questions.write_text("## 要合併到 dev 嗎？\nQ1 · r1 · 待答\n\n沒有作答區\n")

        result = self.ask(SECTION, "--advisor", "needs-human")

        self.assertEqual(result.returncode, 1)
        self.assertIn("missing answer or submit marker", result.stderr)
        self.assertFalse(self.record().exists())

    def test_rerun_finishes_a_reopen_whose_record_sync_failed(self):
        self.ask(SECTION, "--advisor", "needs-human")
        self.ask(SECTION.replace("驗收都過了。", "改過一次。"))
        # As if the panel was written at r2 but the record stayed approved at r1.
        self.record().write_text(self.record().read_text().replace(
            "- status: pending", "- status: approved").replace("- version: r2", "- version: r1"))

        result = self.ask(SECTION.replace("驗收都過了。", "改過一次。"))

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("- status: pending\n", self.record().read_text())
        self.assertIn("- version: r2\n", self.record().read_text())

    def test_gaps_found_after_writing_fail_the_command(self):
        self.record("OTHER").write_text("# OTHER\n\n- status: pending\n- advisor: needs-human\n")

        result = self.ask(SECTION, "--advisor", "needs-human")

        self.assertEqual(result.returncode, 1)
        self.assertIn("遺漏待答題目：\n- OTHER", result.stdout)
        self.assertTrue(self.record().exists())


class AskHelpTests(AskTestCase):
    def test_help_question_writes_the_kind_line(self):
        result = self.ask(HELP_SECTION, "--advisor", "needs-human", "--help-question")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("- status: pending\n- advisor: needs-human\n- kind: help\n",
                      self.record().read_text())
        self.assertIn("- options: A 已完成 / B 做不到\n", self.record().read_text())

    def test_help_question_without_a_done_option_is_refused(self):
        result = self.ask(SECTION, "--advisor", "needs-human", "--help-question")

        self.assertEqual(result.returncode, 1)
        self.assertIn("已完成", result.stderr)
        self.assertFalse(self.record().exists())
        self.assertFalse(self.questions.exists())

    def test_marking_an_existing_record_as_help_checks_the_options_first(self):
        self.ask(SECTION, "--advisor", "needs-human")
        before = self.record().read_text()

        refused = self.ask(SECTION, "--help-question")
        self.assertEqual(refused.returncode, 1)
        self.assertEqual(self.record().read_text(), before)

        self.record().write_text(self.record().read_text().replace(
            "- advisor: needs-human\n", "- advisor: needs-human\n- kind: decide\n"))
        result = self.ask(HELP_SECTION, "--help-question")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("- kind: decide", self.record().read_text())
        self.assertIn("- status: pending\n- advisor: needs-human\n- kind: help\n",
                      self.record().read_text())
        self.assertIn("- version: r2\n", self.record().read_text())


class RecordChatTests(AskTestCase):
    def setUp(self):
        super().setUp()
        self.assertEqual(self.ask(SECTION, "--advisor", "needs-human").returncode, 0)

    def record_chat(self, *extra, text="A，先不推送", source="session s-1 第 3 則"):
        return self.cli("question", "record-chat", "--questions", self.questions,
                        "--decisions", self.decisions, "--id", "Q1",
                        "--text", text, "--source", source, *extra)

    def board_status(self):
        result = self.cli("board", "questions", "--questions", self.questions)
        return json.loads(result.stdout)["questions"][0]["status"]

    def test_chat_answer_is_recorded_like_a_panel_answer(self):
        result = self.record_chat(text="A，先不推送\n- status: pending")

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual((output["id"], output["revision"], output["status"]),
                         ("Q1", 1, "answered"))
        text = self.record().read_text()
        self.assertIn("- status: answered\n", text)
        self.assertRegex(text, (
            r"\n\n## 答覆（r1，聊天，[0-9T:+-]+）\n\n"
            r"- 題目：Q1 r1\n"
            r"- 答覆：A，先不推送\n  - status: pending\n"
            r"- 來源：聊天，session s-1 第 3 則，section_sha256 [0-9a-f]{64}\n"
            r"- 記錄：由 question record-chat 記錄；答覆的意思與核准範圍由主控判斷後補寫\n\Z"
        ))
        self.assertEqual(self.board_status(), "recorded")

    def test_recorded_chat_answer_can_be_approved_as_usual(self):
        self.assertEqual(self.record_chat().returncode, 0)
        self.record().write_text(self.record().read_text().replace(
            "- status: answered", "- status: approved") + "- 核准：合併到 dev，不推送\n")

        cleanup = self.cli("question", "cleanup", "--questions", self.questions,
                           "--decisions", self.decisions)

        self.assertEqual(cleanup.returncode, 0, cleanup.stderr)
        self.assertIn({"id": "Q1", "reason": "recorded"}, json.loads(cleanup.stdout)["archived"])
        self.assertEqual(self.check_pending().returncode, 0)

    def test_refusals_change_nothing(self):
        cases = (
            ("record not pending", lambda: self.record().write_text(
                self.record().read_text().replace("- status: pending", "- status: approved")),
             {}, "not pending"),
            ("record at another revision", lambda: self.record().write_text(
                self.record().read_text().replace("- version: r1", "- version: r2")),
             {}, "decision record is at r2"),
            ("blank text", lambda: None, {"text": "  "}, "--text"),
            ("blank source", lambda: None, {"source": " "}, "--source"),
        )
        for name, prepare, kwargs, reason in cases:
            with self.subTest(name):
                original = self.record().read_text()
                prepare()
                record, questions = self.record().read_text(), self.questions.read_text()
                result = self.record_chat(**kwargs)
                self.assertEqual(result.returncode, 1)
                self.assertIn(reason, result.stderr)
                self.assertEqual((self.record().read_text(), self.questions.read_text()),
                                 (record, questions))
                self.record().write_text(original)

    def test_a_failed_mark_undoes_both_files_so_a_retry_records(self):
        panel = load_module()
        original = panel.questions._append_journal
        record, questions = self.record().read_text(), self.questions.read_text()

        def refuse_mark(*args, **kwargs):
            if kwargs.get("kind") == "set-status":
                raise OSError("disk full")
            return original(*args, **kwargs)

        with patch.object(panel.questions, "_append_journal", refuse_mark):
            with self.assertRaises(OSError):
                panel.record_chat_answer(self.questions, self.decisions, "Q1", "A", "s-1")
        self.assertEqual((self.record().read_text(), self.questions.read_text()),
                         (record, questions))
        self.assertEqual(self.record_chat().returncode, 0)
        self.assertEqual(self.board_status(), "recorded")

    def test_already_recorded_question_is_refused(self):
        self.assertEqual(self.record_chat().returncode, 0)
        self.record().write_text(self.record().read_text().replace(
            "- status: answered", "- status: pending"))

        result = self.record_chat()

        self.assertEqual(result.returncode, 1)
        self.assertIn("already recorded", result.stderr)


if __name__ == "__main__":
    unittest.main()
