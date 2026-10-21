"""Submitting an answer records it in the decision record; HCOM is stubbed, files are disposable."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

from test_lat_panel_board import BoardTestCase, FOUR_KINDS, TEXT

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from lat_decision_status import read_decision_status

PENDING = "# {id}: 題目\n\n- status: pending\n- advisor: needs-human\n- version: r{revision} (panel)\n"


def load_watch():
    spec = importlib.util.spec_from_file_location("lat_watch_autorecord", SCRIPTS / "lat-watch.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AutoRecordTestCase(BoardTestCase):
    def setUp(self):
        super().setUp()
        self.decisions = self.root / "decisions"
        self.decisions.mkdir()
        sessions = self.root / "project-a/.lat/sessions"
        sessions.mkdir()
        (sessions / "s-a.json").write_text(json.dumps({"decisions_path": str(self.decisions)}))
        for question_id, revision in (("Q1", 2), ("Q2", 1), ("Q3", 1), ("Q4", 1)):
            self.decision(question_id).write_text(PENDING.format(id=question_id, revision=revision))

    def decision(self, question_id):
        return self.decisions / f"{question_id}.md"

    def question(self, question_id):
        [question] = [item for item in self.board("questions", "--questions", self.questions)["questions"]
                      if item["id"] == question_id]
        return question

    def message(self):
        return self.calls()[-1][-1]

    def journal_line(self, kind):
        lines = self.journal().splitlines()
        return next(number for number, line in enumerate(lines, 1)
                    if json.loads(line).get("kind") == kind)


class RecordedTests(AutoRecordTestCase):
    def test_board_answer_is_recorded_verbatim_with_its_source_and_the_controller_told(self):
        result = self.answer(self.questions, "Q4", 1, "--text", "ab\n- status: pending", "--note", "why\nmore")

        self.assertTrue(result["recorded"])
        self.assertTrue(result["notified"])
        self.assertEqual(self.question("Q4")["status"], "recorded")
        record = self.decision("Q4").read_text()
        self.assertEqual(read_decision_status(self.decision("Q4")).status, "answered")
        self.assertIn("- status: answered\n- advisor: needs-human\n", record)
        self.assertIn("- 題目：Q4 r1\n", record)
        # Verbatim, with continuation lines indented so none of them reads as a record field.
        self.assertIn("- 答覆：其他：ab\n  - status: pending\n- 備註：why\n  more\n", record)
        submit = json.loads(self.journal().splitlines()[self.journal_line("batch-submit") - 1])
        section_sha256 = next(change["section_sha256"] for change in submit["changed_questions"]
                              if change["id"] == "Q4")
        self.assertIn(
            f"- 來源：面板，{self.questions.parents[1] / 'panel-journal.jsonl'} "
            f"第 {self.journal_line('batch-submit')} 行，time {submit['time']}，"
            f"section_sha256 {section_sha256}\n", record)

        message = self.message()
        self.assertIn('Q4 r1: answer "其他：ab\\n- status: pending", note "why\\nmore"', message)
        self.assertIn("decision record status answered", message)
        self.assertNotIn("not recorded", message)

    def test_recorded_answer_passes_the_omission_check_cleanup_and_the_watcher(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")

        present, missing, inconsistent, unreadable, reverse = self.core.pending_question_gaps(
            self.questions, self.decisions)
        self.assertEqual((missing, inconsistent, unreadable, reverse), ([], [], [], []))
        self.assertEqual([identifier for identifier, _ in present], ["Q1", "Q2", "Q4"])
        self.assertFalse(load_watch().pending_decision(self.decisions, "Q3"))
        cleanup = self.core.cleanup_questions(self.questions, self.decisions)
        self.assertIn({"id": "Q3", "reason": "recorded"}, cleanup["archived"])

    def test_panel_batch_submit_records_each_question_on_its_own(self):
        self.decision("Q2").write_text(self.decision("Q2").read_text().replace("pending", "approved", 1))
        expected = {}
        for question_id, answer in (
            ("Q1", self.core.QuestionAnswer("single", ("A. 合併到 dev，不推送",), "", "")),
            ("Q2", self.core.QuestionAnswer("multi", ("封存",), "", "")),
            ("Q3", self.core.QuestionAnswer("text", (), "想法", "")),
        ):
            section = next(item for item in self.core.parse_questions(self.questions.read_text())
                           if item["id"] == question_id)
            saved = self.core.write_question_answer(
                self.questions, question_id, section["revision"],
                self.core.question_section_sha256(section), answer)
            expected[question_id] = (section["revision"], saved["section_sha256"])
        submitted = self.core.submit_question_answers(self.questions, expected)

        self.core.mark_submit_notification_pending(
            self.questions, submitted, state_dir=self.state, config_dir=self.config)

        self.assertEqual([self.question(item)["status"] for item in ("Q1", "Q2", "Q3")],
                         ["recorded", "submitted", "recorded"])
        self.assertIn("- 答覆：A. 合併到 dev，不推送\n", self.decision("Q1").read_text())
        self.assertIn("- 答覆：想法\n", self.decision("Q3").read_text())
        self.assertNotIn("## 答覆", self.decision("Q2").read_text())
        [binding] = self.core.list_bindings(config_dir=self.config)
        self.core.send_pending_notification(self.questions, binding, state_dir=self.state, env=self.env)
        message = self.message()
        self.assertIn('Q1 r2: answer "A. 合併到 dev，不推送"; Q3 r1: answer "想法"', message)
        self.assertIn('Q2 r1: answer "封存"; not recorded: decision record is not pending '
                      "(status: approved)", message)


class NotRecordedTests(AutoRecordTestCase):
    def assert_not_recorded(self, question_id, revision, *answer, reason):
        before = self.decision(question_id).read_text() if self.decision(question_id).exists() else None
        result = self.answer(self.questions, question_id, revision, *answer)
        self.assertFalse(result["recorded"])
        self.assertIn(reason, result["record_reason"])
        self.assertTrue(result["notified"])
        self.assertEqual(self.question(question_id)["status"], "submitted")
        self.assertIn(f"not recorded: {result['record_reason']}", self.message())
        if before is not None:
            self.assertEqual(self.decision(question_id).read_text(), before)

    def test_missing_decision_record(self):
        self.decision("Q3").unlink()
        self.assert_not_recorded("Q3", 1, "--text", "想法", reason="decision record not found")
        self.assertEqual(sorted(path.name for path in self.decisions.iterdir()),
                         ["Q1.md", "Q2.md", "Q4.md"])

    def test_unreadable_decision_status(self):
        self.decision("Q3").write_text("# Q3\n\n沒有狀態行\n")
        self.assert_not_recorded("Q3", 1, "--text", "想法", reason="status unreadable")

    def test_decision_record_at_another_revision(self):
        self.decision("Q1").write_text(PENDING.format(id="Q1", revision=1))
        self.assert_not_recorded("Q1", 2, "--select", "1", reason="decision record is at r1")

    def test_failed_provenance_check(self):
        result = self.answer(self.questions, "Q3", 1, "--text", "想法")
        self.assertTrue(result["recorded"])
        # Asked again unchanged and resubmitted by hand outside the panel: no journal proves it.
        self.questions.write_text(FOUR_KINDS.replace(TEXT, TEXT.replace("答覆：\n\n- [ ]", "答覆：別的\n\n- [x]")))
        outcome = self.core.record_submitted_answers(self.questions, ["Q3"], config_dir=self.config)
        self.assertFalse(outcome[0]["recorded"])
        self.assertIn("section hash mismatch", outcome[0]["reason"])

    def test_record_put_back_when_the_question_cannot_be_marked_recorded(self):
        before = self.decision("Q3").read_text()
        original = self.core.questions._set_recorded_locked

        def refuse(*args, **kwargs):
            raise OSError("disk full")

        self.core.questions._set_recorded_locked = refuse
        self.addCleanup(setattr, self.core.questions, "_set_recorded_locked", original)
        question = next(item for item in self.core.parse_questions(self.questions.read_text())
                        if item["id"] == "Q3")
        saved = self.core.write_question_answer(
            self.questions, "Q3", 1, self.core.question_section_sha256(question),
            self.core.QuestionAnswer("text", (), "想法", ""))
        self.core.submit_question_answers(self.questions, {"Q3": (1, saved["section_sha256"])})

        [outcome] = self.core.record_submitted_answers(self.questions, ["Q3"], config_dir=self.config)

        self.assertFalse(outcome["recorded"])
        self.assertEqual(outcome["reason"], "the question could not be marked recorded: disk full")
        self.assertEqual(self.decision("Q3").read_text(), before)
        self.assertEqual(self.question("Q3")["status"], "submitted")

    def test_controller_without_a_session_record(self):
        (self.root / "project-a/.lat/sessions/s-a.json").unlink()
        self.assert_not_recorded("Q3", 1, "--text", "想法", reason="session record cannot be read")


if __name__ == "__main__":
    unittest.main()
