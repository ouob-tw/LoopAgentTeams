"""Board command tests for the LAT panel helper; HCOM is stubbed, files are disposable.

The Herdr comparison needs Textual:
  uv run --no-project --with textual==8.2.8 python -m unittest discover -s "$lat_dir/tests"
"""
import asyncio
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"
HAS_TEXTUAL = importlib.util.find_spec("textual") is not None

HCOM_SHIM = """#!/usr/bin/env python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ["LAT_TEST_HCOM_DIR"])
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
target = sys.argv[2].removeprefix("@")
if (root / "mode").read_text().strip() == "deliver":
    print(json.dumps({"delivered_to": [target]}))
else:
    print(f"Error: No active agent for @{target}", file=sys.stderr)
    sys.exit(1)
"""

SINGLE = (
    "## 正式版要怎麼併入？\nQ1 · r2 · 待答\n\n"
    "審查和驗收都通過了。\n\n"
    "A. 合併到 dev，不推送（建議）\n   本機會與 dev 一致。\n"
    "C. 先不合併\n\n"
    "➡️ A：先讓本機版本一致。\n\n"
    "答覆：\n\n- [ ] 送出\n"
)
MULTI = (
    "## 要開哪些功能？\nQ2 · r1 · 待答\n\n選所有需要的。\n\n"
    "- [ ] 主控綁定\n  綁定 tab。\n- [ ] 封存\n- [ ] 通知（建議）\n\n"
    "答覆：\n\n- [ ] 送出\n"
)
TEXT = "## 還有什麼想法？\nQ3 · r1 · 待答\n\n請自由回答。\n\n答覆：\n\n- [ ] 送出\n"
OTHER = (
    "## 要用哪個名稱？\nQ4 · r1 · 待答\n\n"
    "A. 看板\n   沿用草稿的名稱。\nB. 儀表板\n\n"
    "答覆：\n\n- [ ] 送出\n"
)
RECORDED = (
    "## 舊題目\nQ0 · r1 · 已記錄 · 2026-10-02T09:00:00+00:00\n\n"
    "A. Done\n\n答覆：A. Done\n\n- [x] 送出\n"
)
FOUR_KINDS = "\n".join((SINGLE, MULTI, TEXT, OTHER))
# One answer per question kind, as the board passes them.
FOUR_ANSWERS = (
    ("Q1", 2, ("--select", "2")),
    ("Q2", 1, ("--select", "3", "--select", "1")),
    ("Q3", 1, ("--text", "想法")),
    ("Q4", 1, ("--text", "ab\ncd", "--note", "why\nmore")),
)
FOUR_ANSWERED = (
    FOUR_KINDS
    .replace("答覆：\n\n- [ ] 送出", "答覆：C. 先不合併\n\n- [x] 送出", 1)
    .replace("答覆：\n\n- [ ] 送出", "答覆：通知；主控綁定\n\n- [x] 送出", 1)
    .replace("答覆：\n\n- [ ] 送出", "答覆：想法\n\n- [x] 送出", 1)
    .replace("答覆：\n\n- [ ] 送出", "答覆：其他：ab\ncd\n備註：why\nmore\n\n- [x] 送出", 1)
)


def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel_board", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BoardCli:
    """Run the helper's commands the way the board does and read their JSON."""

    def run_cli(self, *args):
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True, capture_output=True, env=self.env, cwd=self.root,
        )

    def board(self, *args, code=0):
        result = self.run_cli("board", *args)
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def section_hash(self, questions, question_id):
        result = self.run_cli("question", "section-hash", "--questions", questions, "--id", question_id)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)["section_sha256"]

    def answer(self, questions, question_id, revision, *answer, code=0, section_hash=None):
        return self.board(
            "answer", "--questions", questions, "--id", question_id, "--revision", revision,
            "--expected-section-sha256", section_hash or self.section_hash(questions, question_id),
            *answer, code=code,
        )


class BoardTestCase(BoardCli, unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.config = self.root / "plugin-config"
        self.state = self.root / "plugin-state"
        self.hcom_dir = self.root / "hcom"
        (self.hcom_dir / "bin").mkdir(parents=True)
        shim = self.hcom_dir / "bin/hcom"
        shim.write_text(HCOM_SHIM)
        shim.chmod(0o755)
        self.set_hcom("deliver")
        self.env = dict(
            os.environ,
            PATH=f"{self.hcom_dir / 'bin'}:{os.environ['PATH']}",
            LAT_TEST_HCOM_DIR=str(self.hcom_dir),
            HERDR_PLUGIN_CONFIG_DIR=str(self.config),
            HERDR_PLUGIN_STATE_DIR=str(self.state),
            # Question commands refresh the bound pane's sidebar; outside Herdr they skip it.
            HERDR_WORKSPACE_ID="",
        )
        self.core = load_module()
        self.questions = self.bind("ctl-a", "s-a", "project-a")
        self.questions.write_text(FOUR_KINDS)

    def bind(self, name, session, project):
        workspace = self.root / project
        (workspace / ".lat").mkdir(parents=True, exist_ok=True)
        binding, _, _ = self.core.bind_controller(
            name, "claude", session, workspace, "ws-1", f"tab-{session}", f"pane-{session}",
            config_dir=self.config,
        )
        questions = Path(binding["questions_path"])
        questions.parent.mkdir(exist_ok=True)
        return questions

    def set_hcom(self, mode):
        (self.hcom_dir / "mode").write_text(mode)

    def calls(self):
        log = self.hcom_dir / "calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def journal(self):
        path = self.questions.parents[1] / "panel-journal.jsonl"
        return path.read_text() if path.exists() else ""

    def pending(self, questions=None):
        return self.core.notification_is_pending(questions or self.questions, state_dir=self.state)


class ListTests(BoardTestCase):
    def test_list_gives_every_bound_controller_with_each_current_question(self):
        self.questions.write_text("\n".join((
            SINGLE,
            MULTI.replace("答覆：\n", "答覆：主控綁定；其他：再加一項\n備註：先這樣\n第二行\n"),
            TEXT.replace("答覆：\n\n- [ ]", "答覆：沒有\n\n- [x]"),
            RECORDED,
        )))
        other = self.bind("ctl-b", "s-b", "project-b")
        other.write_text(OTHER)
        self.core.mark_notification_pending(other, state_dir=self.state)

        first, second = self.board("list")["controllers"]

        self.assertEqual({key: value for key, value in first.items() if key != "questions"}, {
            "hcom_name": "ctl-a",
            "client": "claude",
            "session_id": "s-a",
            "workspace": str(self.root / "project-a"),
            "questions_path": str(self.root / "project-a/.lat/questions/ctl-a.md"),
            "herdr_workspace": "ws-1",
            "herdr_tab": "tab-s-a",
            "herdr_pane": "pane-s-a",
            "notification_pending": False,
            "error": None,
        })
        self.assertEqual(first["questions"], [
            {
                "id": "Q1",
                "revision": 2,
                "status": "pending",
                "title": "正式版要怎麼併入？",
                "context": "審查和驗收都通過了。",
                "details": None,
                "kind": "single",
                "options": [
                    {
                        "letter": "A", "label": "合併到 dev，不推送",
                        "impact": "本機會與 dev 一致。", "recommended": True,
                    },
                    {"letter": "C", "label": "先不合併", "impact": "", "recommended": False},
                ],
                "recommendation": "➡️ A：先讓本機版本一致。",
                "answer": "",
                "note": "",
                "asked_at": None,
                "recorded_at": None,
                "section_sha256": self.section_hash(self.questions, "Q1"),
            },
            {
                "id": "Q2",
                "revision": 1,
                "status": "pending",
                "title": "要開哪些功能？",
                "context": "選所有需要的。",
                "details": None,
                "kind": "multi",
                "options": [
                    {"letter": "A", "label": "主控綁定", "impact": "綁定 tab。", "recommended": False},
                    {"letter": "B", "label": "封存", "impact": "", "recommended": False},
                    {"letter": "C", "label": "通知", "impact": "", "recommended": True},
                ],
                "recommendation": "",
                "answer": "主控綁定；其他：再加一項",
                "note": "先這樣\n第二行",
                "asked_at": None,
                "recorded_at": None,
                "section_sha256": self.section_hash(self.questions, "Q2"),
            },
            {
                "id": "Q3",
                "revision": 1,
                "status": "submitted",
                "title": "還有什麼想法？",
                "context": "請自由回答。",
                "details": None,
                "kind": "text",
                "options": [],
                "recommendation": "",
                "answer": "沒有",
                "note": "",
                "asked_at": None,
                "recorded_at": None,
                "section_sha256": self.section_hash(self.questions, "Q3"),
            },
            {
                "id": "Q0",
                "revision": 1,
                "status": "recorded",
                "title": "舊題目",
                "context": "",
                "details": None,
                "kind": "single",
                "options": [{"letter": "A", "label": "Done", "impact": "", "recommended": False}],
                "recommendation": "",
                "answer": "A. Done",
                "note": "",
                "asked_at": None,
                "recorded_at": "2026-10-02T09:00:00+00:00",
                "section_sha256": self.section_hash(self.questions, "Q0"),
            },
        ])
        self.assertEqual(second["hcom_name"], "ctl-b")
        self.assertTrue(second["notification_pending"])
        self.assertEqual([item["id"] for item in second["questions"]], ["Q4"])

    def test_unreadable_questions_file_marks_only_its_own_controller(self):
        self.questions.write_bytes(b"## Broken\nQ1 \xff\xfe")
        other = self.bind("ctl-b", "s-b", "project-b")
        other.write_text(TEXT)
        self.bind("ctl-c", "s-c", "project-c")  # bound, nothing asked yet

        broken, healthy, silent = self.board("list")["controllers"]

        self.assertEqual(broken["hcom_name"], "ctl-a")
        self.assertIn("utf-8", broken["error"])
        self.assertEqual(broken["questions"], [])
        self.assertIsNone(healthy["error"])
        self.assertEqual([item["id"] for item in healthy["questions"]], ["Q3"])
        self.assertIsNone(silent["error"])
        self.assertEqual(silent["questions"], [])


    def test_duplicate_question_ids_mark_only_their_own_controller(self):
        self.questions.write_text("\n".join((TEXT, TEXT)))
        other = self.bind("ctl-b", "s-b", "project-b")
        other.write_text(TEXT)
        broken, healthy = self.board("list")["controllers"]
        self.assertIn("duplicate question ID: Q3", broken["error"])
        self.assertEqual(broken["questions"], [])
        self.assertEqual([item["id"] for item in healthy["questions"]], ["Q3"])

    def test_multi_options_past_z_have_no_letter(self):
        options = "".join(f"- [ ] 選項{number}\n" for number in range(1, 28))
        self.questions.write_text(
            f"## 很多選項？\nQ5 · r1 · 待答\n\n{options}\n答覆：\n\n- [ ] 送出\n"
        )
        [controller] = self.board("list")["controllers"]
        letters = [option["letter"] for option in controller["questions"][0]["options"]]
        self.assertEqual(letters[24:], ["Y", "Z", ""])
        self.answer(self.questions, "Q5", 1, "--select", "27")
        self.assertIn("答覆：選項27\n\n- [x] 送出", self.questions.read_text())

    def test_list_item_options_give_the_board_their_whole_markdown_body(self):
        self.questions.write_text(
            "## 要怎麼做？\nQ6 · r1 · 待答\n\n背景。\n\n"
            "- A. 甲（建議）\n  第一段。\n\n  - 子項目\n    - 更深\n- B. 乙\n\n"
            "答覆：\n\n- [ ] 送出\n"
        )
        [controller] = self.board("list")["controllers"]
        [question] = controller["questions"]
        self.assertEqual(question["context"], "背景。")
        self.assertEqual(question["options"], [
            {"letter": "A", "label": "甲", "impact": "第一段。\n\n- 子項目\n  - 更深", "recommended": True},
            {"letter": "B", "label": "乙", "impact": "", "recommended": False},
        ])
        self.answer(self.questions, "Q6", 1, "--select", "2")
        self.assertIn("答覆：B. 乙\n\n- [x] 送出", self.questions.read_text())

    def test_journal_line_that_is_not_an_entry_does_not_break_the_list(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")
        with (self.questions.parents[1] / "panel-journal.jsonl").open("a") as journal:
            journal.write("[]\n")
        [controller] = self.board("list")["controllers"]
        self.assertIsNone(controller["error"])
        self.assertEqual(controller["questions"][2]["status"], "submitted")

    def test_unreadable_binding_registry_is_reported_as_json(self):
        (self.config / "bindings.json").write_text("not json")
        result = self.board("list", code=1)
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["reason"])


class AskedAtTests(BoardTestCase):
    def setUp(self):
        super().setUp()
        self.questions.unlink()
        self.decisions = self.root / "decisions"
        self.decisions.mkdir()
        (self.decisions / "Q1.md").write_text("- status: pending\n")
        self.journal_path = self.questions.parents[1] / "panel-journal.jsonl"

    def upsert(self, body):
        """Ask Q1 with the controller's command; return when it ran as (before, after)."""
        section = self.root / "section.md"
        section.write_text(f"## 要用哪個名稱？\n\n{body}\n")
        before = datetime.now(timezone.utc)
        result = self.run_cli(
            "question", "upsert", "--questions", self.questions,
            "--decisions", self.decisions, "--id", "Q1", "--file", section,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return before, datetime.now(timezone.utc), result.stdout

    def listed(self):
        [controller] = self.board("list")["controllers"]
        self.assertIsNone(controller["error"])
        [question] = controller["questions"]
        return question

    def asked_at(self):
        value = self.listed()["asked_at"]
        self.assertTrue(value.endswith("Z"), value)
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    def provenance(self):
        return self.run_cli(
            "question", "provenance", "--questions", self.questions,
            "--journal", self.journal_path, "--id", "Q1",
        )

    def test_asked_at_is_when_the_current_revision_was_written(self):
        before, after, output = self.upsert("A. 看板\nB. 儀表板")
        self.assertEqual(output, "Q1 r1\n")
        first = self.asked_at()
        self.assertTrue(before <= first <= after, (before, first, after))

        self.upsert("A. 看板\nB. 儀表板")  # same content: no new revision
        self.assertEqual(self.listed()["revision"], 1)
        self.assertEqual(self.asked_at(), first)

        before, after, output = self.upsert("A. 看板\nB. 儀表板\nC. 面板")
        self.assertEqual(output, "Q1 r2\n")
        second = self.asked_at()
        self.assertTrue(first < before <= second <= after, (first, before, second, after))

    def test_answering_and_recording_keep_asked_at(self):
        self.upsert("A. 看板\nB. 儀表板")
        asked = self.listed()["asked_at"]
        self.assertIsNone(self.listed()["recorded_at"])
        self.answer(self.questions, "Q1", 1, "--select", "1")
        self.assertEqual(self.listed()["asked_at"], asked)
        proof = self.provenance()
        self.assertEqual(proof.returncode, 0, proof.stderr)
        recorded = self.run_cli(
            "question", "set-status", "--questions", self.questions, "--id", "Q1",
            "--revision", 1, "--status", "recorded",
            "--expected-section-sha256", json.loads(proof.stdout)["section_sha256"],
        )
        self.assertEqual(recorded.returncode, 0, recorded.stderr)
        question = self.listed()
        self.assertEqual(question["status"], "recorded")
        self.assertEqual(question["asked_at"], asked)
        datetime.fromisoformat(question["recorded_at"])

    def test_submitted_answer_of_an_older_revision_does_not_prove_the_new_one(self):
        self.upsert("A. 看板\nB. 儀表板")
        self.answer(self.questions, "Q1", 1, "--select", "1")
        self.upsert("A. 看板\nB. 儀表板\nC. 面板")
        proof = self.provenance()
        self.assertEqual(proof.returncode, 1)
        self.assertEqual(proof.stderr, "lat-panel: question is not submitted: Q1\n")

    def test_submit_written_outside_the_panel_still_fails_the_source_check(self):
        self.upsert("A. 看板\nB. 儀表板")
        self.questions.write_text(
            self.questions.read_text().replace("答覆：\n\n- [ ]", "答覆：A. 看板\n\n- [x]")
        )
        proof = self.provenance()
        self.assertEqual(proof.returncode, 1)
        self.assertEqual(proof.stderr, "lat-panel: no panel journal entry touched question: Q1\n")

    def test_upsert_that_carries_its_own_checked_answer_is_not_a_panel_answer(self):
        self.upsert("A. 看板\n\n答覆：A. 看板\n\n- [x] 送出")
        self.assertEqual(self.listed()["status"], "submitted")
        proof = self.provenance()
        self.assertEqual(proof.returncode, 1)
        self.assertEqual(proof.stderr, "lat-panel: no panel journal entry touched question: Q1\n")

    def test_snapshot_of_an_answered_revision_still_proves_itself_after_a_bump(self):
        self.upsert("A. 看板\nB. 儀表板")
        self.answer(self.questions, "Q1", 1, "--select", "1")
        snapshot = self.root / "snapshot.md"
        snapshot.write_text(self.questions.read_text())
        self.upsert("A. 看板\nB. 儀表板\nC. 面板")
        proof = self.run_cli(
            "question", "provenance", "--questions", snapshot,
            "--source-questions", self.questions, "--journal", self.journal_path, "--id", "Q1",
        )
        self.assertEqual(proof.returncode, 0, proof.stderr)
        self.assertEqual(json.loads(proof.stdout)["status"], "ok")

    def test_missing_or_unreadable_journal_gives_no_time_and_no_error(self):
        self.upsert("A. 看板\nB. 儀表板")
        damaged = json.dumps({
            "kind": "upsert", "questions_path": str(self.questions),
            "upsert_question": ["Q1"], "revision": {}, "time": "never",
        })
        self.journal_path.write_text(
            f"not json\n[]\n{damaged}\n" + self.journal_path.read_text()
        )
        self.assertIsNotNone(self.listed()["asked_at"])
        self.journal_path.write_bytes(b"\xff\xfe")
        self.assertIsNone(self.listed()["asked_at"])
        self.journal_path.unlink()
        self.assertIsNone(self.listed()["asked_at"])
        self.journal_path.mkdir()
        self.assertIsNone(self.listed()["asked_at"])


class AnswerTests(BoardTestCase):
    def test_multi_select_takes_other_text_alone_or_after_selections(self):
        self.answer(self.questions, "Q2", 1, "--select", "2", "--text", "再加一項")
        self.assertIn("答覆：封存；其他：再加一項\n\n- [x] 送出", self.questions.read_text())
        self.questions.write_text(MULTI)
        self.answer(self.questions, "Q2", 1, "--text", "都不要")
        self.assertIn("答覆：其他：都不要\n\n- [x] 送出", self.questions.read_text())

    def test_each_question_kind_is_written_submitted_and_notified(self):
        for question_id, revision, answer in FOUR_ANSWERS:
            result = self.answer(self.questions, question_id, revision, *answer)
            self.assertEqual(result, {
                "status": "submitted",
                "id": question_id,
                "revision": revision,
                "section_sha256": self.section_hash(self.questions, question_id),
                # This controller has no session record, so the answer stays submitted.
                "recorded": False,
                "record_reason": "controller session record cannot be read: [Errno 2] "
                f"No such file or directory: '{self.root / 'project-a/.lat/sessions/s-a.json'}'",
                "notified": True,
            })
        self.assertEqual(self.questions.read_text(), FOUR_ANSWERED)
        self.assertEqual(
            [call[:7] for call in self.calls()],
            [["send", "@ctl-a", "--from", "lat-panel", "--intent", "inform", "--json"]] * 4,
        )
        self.assertFalse(self.pending())

    def test_controller_can_verify_the_source_and_mark_the_answer_recorded(self):
        for question_id, revision, answer in FOUR_ANSWERS:
            self.answer(self.questions, question_id, revision, *answer)
        snapshot = self.root / "snapshot.md"
        snapshot.write_text(self.questions.read_text())
        for question_id, revision, _ in FOUR_ANSWERS:
            proof = self.run_cli(
                "question", "provenance", "--questions", snapshot,
                "--source-questions", self.questions,
                "--journal", self.questions.parents[1] / "panel-journal.jsonl", "--id", question_id,
            )
            self.assertEqual(proof.returncode, 0, proof.stderr)
            proof = json.loads(proof.stdout)
            self.assertEqual(proof["status"], "ok")
            recorded = self.run_cli(
                "question", "set-status", "--questions", self.questions, "--id", question_id,
                "--revision", revision, "--status", "recorded",
                "--expected-section-sha256", proof["section_sha256"],
            )
            self.assertEqual(recorded.returncode, 0, recorded.stderr)
        [controller] = self.board("list")["controllers"]
        self.assertEqual(
            [item["status"] for item in controller["questions"]], ["recorded"] * 4
        )

    def assert_refused(self, status, question_id, revision, *answer, section_hash=None):
        before = self.questions.read_bytes()
        journal = self.journal()
        result = self.answer(
            self.questions, question_id, revision, *answer, code=1, section_hash=section_hash,
        )
        self.assertEqual(result["status"], status)
        self.assertTrue(result["reason"])
        self.assertEqual(self.questions.read_bytes(), before)
        self.assertEqual(self.journal(), journal)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.pending())

    def test_stale_revision_or_section_hash_is_refused_without_writing(self):
        loaded = self.section_hash(self.questions, "Q1")
        self.assert_refused("question_changed", "Q1", 1, "--select", "1")
        self.assert_refused("question_changed", "Q9", 1, "--select", "1", section_hash=loaded)
        # The controller rewrites the impact line after the board loaded the question.
        self.questions.write_text(FOUR_KINDS.replace("本機會與 dev 一致。", "本機會更新。"))
        self.assert_refused("question_changed", "Q1", 2, "--select", "1", section_hash=loaded)

    def test_question_that_is_not_waiting_for_an_answer_is_refused(self):
        self.questions.write_text("\n".join((
            TEXT.replace("答覆：\n\n- [ ]", "答覆：沒有\n\n- [x]"), RECORDED,
        )))
        self.assert_refused("not_pending", "Q3", 1, "--text", "改答案")
        self.assert_refused("not_pending", "Q0", 1, "--select", "1")

    def test_answer_that_does_not_fit_the_question_kind_is_refused(self):
        for question_id, revision, answer in (
            ("Q1", 2, ()),
            ("Q1", 2, ("--select", "1", "--select", "2")),
            ("Q1", 2, ("--select", "3")),
            ("Q1", 2, ("--select", "0")),
            ("Q1", 2, ("--select", "1", "--text", "也要這個")),
            ("Q1", 2, ("--text", "   ")),
            ("Q1", 2, ("--note", "只有備註")),
            ("Q2", 1, ()),
            ("Q2", 1, ("--select", "1", "--select", "1")),
            ("Q2", 1, ("--select", "4")),
            ("Q3", 1, ()),
            ("Q3", 1, ("--select", "1")),
            ("Q3", 1, ("--text", "\n")),
            ("Q3", 1, ("--text", "好\n- [x] 送出")),
            ("Q3", 1, ("--text", "好", "--note", "看這裡\n## Forged\nQ9 · r1 · 待答")),
            ("Q3", 1, ("--text", "備註：只有備註")),
        ):
            with self.subTest(question_id=question_id, answer=answer):
                self.assert_refused("invalid_answer", question_id, revision, *answer)

    def test_unexpected_failure_is_reported_as_json_without_writing(self):
        self.questions.write_text("## Broken?\nQ1 · r1 · 待答\n\nNo answer area.\n")
        self.assert_refused("error", "Q1", 1, "--text", "好")
        # Another question appears twice: the submit step would fail after the draft write.
        self.questions.write_text("\n".join((SINGLE, TEXT, TEXT)))
        self.assert_refused("error", "Q1", 2, "--select", "1")
        missing = self.board(
            "answer", "--questions", self.root / "missing.md", "--id", "Q1", "--revision", 1,
            "--expected-section-sha256", "0" * 64, "--text", "好", code=1,
        )
        self.assertEqual(missing["status"], "error")
        self.assertIn("missing.md", missing["reason"])

    def test_answer_replaces_a_draft_left_in_the_herdr_panel(self):
        self.questions.write_text(FOUR_KINDS.replace(
            "答覆：\n\n- [ ] 送出", "答覆：A. 合併到 dev，不推送\n備註：再想想\n\n- [ ] 送出", 1,
        ))
        self.answer(self.questions, "Q1", 2, "--select", "2")
        self.assertIn("答覆：C. 先不合併\n\n- [x] 送出", self.questions.read_text())
        self.assertNotIn("再想想", self.questions.read_text())


class NotificationTests(BoardTestCase):
    def test_failed_notification_keeps_the_answer_and_one_resend_delivers_it(self):
        self.set_hcom("offline")
        result = self.answer(self.questions, "Q3", 1, "--text", "想法")
        self.assertEqual(result["status"], "submitted")
        self.assertFalse(result["notified"])
        self.assertIn("No active agent for @ctl-a", result["reason"])
        self.assertIn("答覆：想法\n\n- [x] 送出", self.questions.read_text())
        self.assertTrue(self.pending())
        [controller] = self.board("list")["controllers"]
        self.assertTrue(controller["notification_pending"])
        self.assertEqual(controller["questions"][2]["status"], "submitted")

        written = self.questions.read_bytes()
        journal = self.journal()
        failed = self.board("notify", "--questions", self.questions, code=1)
        self.assertEqual(failed["status"], "failed")
        self.assertIn("No active agent for @ctl-a", failed["reason"])
        self.assertTrue(self.pending())

        self.set_hcom("deliver")
        calls = len(self.calls())
        self.assertEqual(
            self.board("notify", "--questions", self.questions), {"status": "delivered"}
        )
        self.assertEqual(len(self.calls()), calls + 1)
        self.assertEqual(self.calls()[-1][:4], ["send", "@ctl-a", "--from", "lat-panel"])
        self.assertFalse(self.pending())
        self.assertEqual(
            self.board("notify", "--questions", self.questions), {"status": "no_pending"}
        )
        self.assertEqual(len(self.calls()), calls + 1)
        self.assertEqual(self.questions.read_bytes(), written)
        self.assertEqual(self.journal(), journal)
        proof = self.run_cli(
            "question", "provenance", "--questions", self.questions,
            "--journal", self.questions.parents[1] / "panel-journal.jsonl", "--id", "Q3",
        )
        self.assertEqual(proof.returncode, 0, proof.stderr)

    def test_answer_for_a_questions_file_without_a_controller_reports_the_failure(self):
        self.core.unbind_controller("s-a", config_dir=self.config)
        result = self.answer(self.questions, "Q3", 1, "--text", "想法")
        self.assertEqual(result["status"], "submitted")
        self.assertFalse(result["notified"])
        self.assertIn("no LAT controller", result["reason"])
        self.assertEqual(self.calls(), [])
        self.assertTrue(self.pending())
        failed = self.board("notify", "--questions", self.questions, code=1)
        self.assertEqual(failed["status"], "failed")

    def test_answer_is_kept_when_the_pending_notification_cannot_be_stored(self):
        self.state.write_text("")  # a file where the state directory should be
        result = self.answer(self.questions, "Q3", 1, "--text", "想法")
        self.assertEqual(result["status"], "submitted")
        self.assertFalse(result["notified"])
        self.assertTrue(result["reason"])
        self.assertIn("答覆：想法\n\n- [x] 送出", self.questions.read_text())
        self.assertEqual(self.calls(), [])

    def test_resend_reaches_only_the_controller_of_that_questions_file(self):
        other = self.bind("ctl-b", "s-b", "project-b")
        other.write_text(TEXT)
        self.core.mark_notification_pending(self.questions, state_dir=self.state)
        self.core.mark_notification_pending(other, state_dir=self.state)
        self.assertEqual(self.board("notify", "--questions", other), {"status": "delivered"})
        self.assertEqual([call[1] for call in self.calls()], ["@ctl-b"])
        self.assertTrue(self.pending())
        self.assertFalse(self.pending(other))


class LostNotificationTests(BoardTestCase):
    """The answer is written, but the pending notification could not be stored."""

    def setUp(self):
        super().setUp()
        self.state.write_text("")  # a file where the state directory should be
        result = self.answer(self.questions, "Q3", 1, "--text", "想法")
        self.assertEqual((result["status"], result["notified"]), ("submitted", False))
        self.assertEqual(self.calls(), [])

    def listed(self):
        [controller] = self.board("list")["controllers"]
        self.assertIsNone(controller["error"])
        return controller

    def notify(self, code=0):
        return self.board("notify", "--questions", self.questions, code=code)

    def record(self, question_id="Q3", revision=1):
        result = self.run_cli(
            "question", "set-status", "--questions", self.questions, "--id", question_id,
            "--revision", revision, "--status", "recorded",
            "--expected-section-sha256", self.section_hash(self.questions, question_id),
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_list_says_written_and_not_notified_while_the_state_is_unusable(self):
        controller = self.listed()
        self.assertEqual(controller["questions"][2]["status"], "submitted")
        self.assertEqual(controller["questions"][2]["answer"], "想法")
        self.assertTrue(controller["notification_pending"])
        failed = self.notify(code=1)
        self.assertEqual(failed["status"], "error")
        self.assertTrue(failed["reason"])
        self.assertEqual(self.calls(), [])

    def test_resend_delivers_once_after_the_state_is_usable_again(self):
        self.state.unlink()
        written = self.questions.read_bytes()
        journal = self.journal()
        self.assertTrue(self.listed()["notification_pending"])

        self.assertEqual(self.notify(), {"status": "delivered"})

        self.assertEqual([call[:4] for call in self.calls()], [["send", "@ctl-a", "--from", "lat-panel"]])
        self.assertFalse(self.listed()["notification_pending"])
        self.assertEqual(self.notify(), {"status": "no_pending"})
        # Resending rewrote neither the answer nor the journal.
        self.assertEqual(self.questions.read_bytes(), written)
        self.assertEqual(self.journal(), journal)
        self.record()
        self.assertEqual(self.notify(), {"status": "no_pending"})
        self.assertFalse(self.listed()["notification_pending"])
        self.assertEqual(len(self.calls()), 1)

    def test_resend_that_failed_is_not_repeated_once_the_answer_is_recorded(self):
        self.state.unlink()
        self.set_hcom("offline")
        self.assertEqual(self.notify(code=1)["status"], "failed")
        self.set_hcom("deliver")
        self.record()
        self.assertFalse(self.listed()["notification_pending"])
        self.assertEqual(self.notify(), {"status": "no_pending"})
        self.assertEqual(len(self.calls()), 1)

    def test_resend_that_fails_stays_pending_and_delivers_later(self):
        self.state.unlink()
        self.set_hcom("offline")
        self.assertEqual(self.notify(code=1)["status"], "failed")
        self.assertTrue(self.listed()["notification_pending"])
        self.set_hcom("deliver")
        self.assertEqual(self.notify(), {"status": "delivered"})
        self.assertEqual(self.notify(), {"status": "no_pending"})
        self.assertEqual(len(self.calls()), 2)

    def test_answer_the_controller_already_recorded_is_not_notified(self):
        self.state.unlink()
        self.record()
        self.assertFalse(self.listed()["notification_pending"])
        self.assertEqual(self.notify(), {"status": "no_pending"})
        self.assertEqual(self.calls(), [])

    def test_answer_to_a_version_the_controller_replaced_is_not_notified(self):
        self.state.unlink()
        decisions = self.root / "decisions"
        decisions.mkdir()
        (decisions / "Q3.md").write_text("- status: pending\n")
        section = self.root / "section.md"
        section.write_text("## 還有什麼想法？\n\n請再想一次。\n")
        result = self.run_cli(
            "question", "upsert", "--questions", self.questions,
            "--decisions", decisions, "--id", "Q3", "--file", section,
        )
        self.assertEqual(result.stdout.strip(), "Q3 r2", result.stderr)
        self.assertFalse(self.listed()["notification_pending"])
        self.assertEqual(self.notify(), {"status": "no_pending"})
        self.assertEqual(self.calls(), [])

    def test_another_controller_notified_first_does_not_hide_the_lost_notification(self):
        self.state.unlink()
        other = self.bind("ctl-b", "s-b", "project-b")
        other.write_text(TEXT)
        self.assertTrue(self.answer(other, "Q3", 1, "--text", "別題")["notified"])

        first, second = self.board("list")["controllers"]
        self.assertTrue(first["notification_pending"])
        self.assertFalse(second["notification_pending"])
        self.assertEqual(self.notify(), {"status": "delivered"})
        self.assertEqual([call[1] for call in self.calls()], ["@ctl-b", "@ctl-a"])

    def test_later_answer_is_owed_its_own_notification(self):
        self.state.unlink()
        self.assertEqual(self.notify(), {"status": "delivered"})
        self.state.chmod(0o500)  # readable, but nothing new can be stored
        self.addCleanup(self.state.chmod, 0o700)
        later = self.answer(self.questions, "Q1", 2, "--select", "1")
        self.assertFalse(later["notified"])
        self.assertTrue(self.listed()["notification_pending"])
        self.state.chmod(0o700)
        self.assertTrue(self.listed()["notification_pending"])
        self.assertEqual(self.notify(), {"status": "delivered"})
        self.assertEqual(self.notify(), {"status": "no_pending"})
        self.assertEqual(len(self.calls()), 2)


class DeliveredNotificationTests(BoardTestCase):
    def test_answer_submitted_and_delivered_through_the_panel_api_is_not_pending(self):
        question = self.core.parse_questions(self.questions.read_text())[2]
        saved = self.core.write_question_answer(
            self.questions, "Q3", 1, self.core.question_section_sha256(question),
            self.core.QuestionAnswer("text", (), "想法", ""),
        )
        submitted = self.core.submit_question_answers(
            self.questions, {"Q3": (1, saved["section_sha256"])}
        )
        self.core.mark_submit_notification_pending(self.questions, submitted, state_dir=self.state)
        [binding] = self.core.list_bindings(config_dir=self.config)
        self.assertEqual(
            self.core.send_pending_notification(
                self.questions, binding, state_dir=self.state, env=self.env
            ),
            (True, "delivered"),
        )

        [controller] = self.board("list")["controllers"]
        self.assertFalse(controller["notification_pending"])
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "no_pending"})
        self.assertEqual(len(self.calls()), 1)

    def test_answer_delivered_before_deliveries_were_noted_is_not_notified_again(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")
        # As an earlier helper left it: the notification came and went, nothing noted the delivery.
        (self.state / "delivered-notifications.json").unlink()

        [controller] = self.board("list")["controllers"]
        self.assertFalse(controller["notification_pending"])
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "no_pending"})
        self.assertEqual(len(self.calls()), 1)

    def test_delivery_record_that_cannot_be_used_costs_a_repeat_not_a_lost_notification(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")
        (self.state / "delivered-notifications.json").write_text('{"delivered": {}, "since": "garbage"}')
        [controller] = self.board("list")["controllers"]
        self.assertTrue(controller["notification_pending"])
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "delivered"})
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "no_pending"})

    def test_answer_lost_before_deliveries_were_noted_is_still_owed(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")
        (self.state / "delivered-notifications.json").unlink()
        self.state.chmod(0o500)  # readable, but nothing new can be stored
        self.addCleanup(self.state.chmod, 0o700)
        lost = self.answer(self.questions, "Q1", 2, "--select", "1")
        self.assertFalse(lost["notified"])
        self.state.chmod(0o700)

        [controller] = self.board("list")["controllers"]
        self.assertTrue(controller["notification_pending"])
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "delivered"})
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "no_pending"})
        self.assertEqual(len(self.calls()), 2)

    def test_submit_checked_outside_the_panel_is_owed_no_notification(self):
        self.questions.write_text(TEXT.replace("答覆：\n\n- [ ]", "答覆：沒有\n\n- [x]"))
        [controller] = self.board("list")["controllers"]
        self.assertFalse(controller["notification_pending"])
        self.assertEqual(self.board("notify", "--questions", self.questions), {"status": "no_pending"})
        self.assertEqual(self.calls(), [])


class QuestionsTests(BoardTestCase):
    def test_questions_of_one_file_are_listed_as_board_list_gives_them(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")
        [controller] = self.board("list")["controllers"]
        self.assertEqual(
            self.board("questions", "--questions", self.questions),
            {"questions": controller["questions"]},
        )

    def test_questions_file_of_an_unbound_controller_can_still_be_read(self):
        self.answer(self.questions, "Q3", 1, "--text", "想法")
        recorded = self.run_cli(
            "question", "set-status", "--questions", self.questions, "--id", "Q3",
            "--revision", 1, "--status", "recorded",
            "--expected-section-sha256", self.section_hash(self.questions, "Q3"),
        )
        self.assertEqual(recorded.returncode, 0, recorded.stderr)
        self.core.unbind_controller("s-a", config_dir=self.config)
        before = self.questions.read_bytes()

        self.assertEqual(self.board("list"), {"controllers": []})
        questions = self.board("questions", "--questions", self.questions)["questions"]

        self.assertEqual([item["id"] for item in questions], ["Q1", "Q2", "Q3", "Q4"])
        self.assertEqual(questions[2]["status"], "recorded")
        self.assertEqual(questions[2]["answer"], "想法")
        self.assertTrue(questions[2]["recorded_at"])
        self.assertEqual(self.questions.read_bytes(), before)

    def test_missing_file_has_no_questions_and_an_unreadable_one_is_an_error(self):
        self.assertEqual(
            self.board("questions", "--questions", self.root / "missing.md"), {"questions": []}
        )
        self.questions.write_text("\n".join((TEXT, TEXT)))
        result = self.board("questions", "--questions", self.questions, code=1)
        self.assertEqual(result["status"], "error")
        self.assertIn("duplicate question ID: Q3", result["reason"])


class AnsweredTests(BoardTestCase):
    def archive(self, questions=None):
        questions = questions or self.questions
        return questions.with_name(f"{questions.stem}-archive.md")

    def test_answered_questions_come_from_the_file_and_its_archive(self):
        self.questions.write_text("\n".join((RECORDED, SINGLE)))
        older = RECORDED.replace("舊題目", "封存的題目").replace("Q0", "Q8")
        self.archive().write_text(older)

        [entry] = self.board("answered", "--questions", self.questions)["files"]

        self.assertEqual(entry["questions_path"], str(self.questions))
        self.assertIsNone(entry["error"])
        self.assertEqual([item["id"] for item in entry["questions"]], ["Q8", "Q0"])
        self.assertEqual(entry["questions"][1], self.board("list")["controllers"][0]["questions"][0])
        self.assertEqual(entry["questions"][0]["answer"], "A. Done")
        self.assertEqual(entry["questions"][0]["recorded_at"], "2026-10-02T09:00:00+00:00")

    def test_latest_section_of_an_id_wins_and_only_an_answered_recorded_one_is_listed(self):
        unanswered = "## 沒答就記錄\nQ7 · r1 · 已記錄 · 2026-10-02T09:00:00+00:00\n\n答覆：\n\n- [x] 送出\n"
        again = RECORDED.replace("答覆：A. Done", "答覆：A. Done\n備註：第二次").replace("Q0 · r1", "Q0 · r2")
        # Q0 was archived twice; Q1 was answered, archived, then asked again and waits.
        self.archive().write_text("\n".join((RECORDED, again, RECORDED.replace("Q0", "Q1"), unanswered)))
        self.questions.write_text(SINGLE)

        [entry] = self.board("answered", "--questions", self.questions)["files"]

        self.assertEqual([(item["id"], item["revision"], item["note"]) for item in entry["questions"]], [("Q0", 2, "第二次")])

    def test_each_file_is_read_on_its_own(self):
        other = self.bind("ctl-b", "s-b", "project-b")
        other.write_text("\n".join((RECORDED, RECORDED)))
        self.questions.write_text(RECORDED)
        missing = self.root / "project-c/.lat/questions-gone.md"

        files = self.board(
            "answered", f"--questions={self.questions}", f"--questions={other}", f"--questions={missing}"
        )["files"]

        self.assertEqual([len(entry["questions"]) for entry in files], [1, 1, 0])
        self.assertEqual([entry["error"] for entry in files], [None, None, None])
        other.write_bytes(b"\xff")
        broken = self.board("answered", f"--questions={self.questions}", f"--questions={other}")["files"]
        self.assertEqual(len(broken[0]["questions"]), 1)
        self.assertTrue(broken[1]["error"])
        self.assertEqual(broken[1]["questions"], [])

    def test_an_unbound_controllers_file_is_found_from_its_workspace_and_name(self):
        other = self.bind("Ctl.B", "s-b", "project-b")
        self.archive(other).write_text(RECORDED)
        self.core.unbind_controller("s-b", config_dir=self.config)
        workspace = self.root / "project-b"

        files = self.board(
            "answered", f"--workspace={workspace}", "--hcom-name=Ctl.B",
            f"--workspace={workspace}", "--hcom-name=--",
        )["files"]

        self.assertEqual(files[0]["questions_path"], str(other))
        self.assertEqual((files[0]["workspace"], files[0]["hcom_name"]), (str(workspace), "Ctl.B"))
        self.assertEqual([item["id"] for item in files[0]["questions"]], ["Q0"])
        self.assertIsNone(files[1]["questions_path"])
        self.assertTrue(files[1]["error"])
        unpaired = self.board("answered", f"--workspace={workspace}", code=1)
        self.assertEqual(unpaired["status"], "error")


if HAS_TEXTUAL:
    from test_lat_panel_selector import SelectorTestCase

    class HerdrPanelComparisonTests(BoardCli, SelectorTestCase):
        async def test_board_answers_leave_the_same_file_as_the_herdr_panel(self):
            self.env = dict(os.environ)
            self.questions.write_text(FOUR_KINDS)
            app = self.make_app()
            async with app.run_test() as pilot:
                await self.press(
                    pilot, "2", "right", "3", "1", "right", *"想法", "escape", "right",
                    "3", *"ab", "enter", *"cd", "escape", "tab", *"why", "enter", *"more",
                    "escape", "right", "enter",
                )
                await self.settle(app, pilot)

            binding, _, _ = self.core.bind_controller(
                "ctl-b", "claude", "s-b", self.root / "board-project", "ws-b", "tab-b", "pane-b"
            )
            board_questions = Path(binding["questions_path"])
            board_questions.parent.mkdir(parents=True)
            board_questions.write_text(FOUR_KINDS)
            for question_id, revision, answer in FOUR_ANSWERS:
                await asyncio.to_thread(
                    self.answer, board_questions, question_id, revision, *answer
                )

            self.assertEqual(self.questions.read_text(), FOUR_ANSWERED)
            self.assertEqual(board_questions.read_bytes(), self.questions.read_bytes())


if __name__ == "__main__":
    unittest.main()
