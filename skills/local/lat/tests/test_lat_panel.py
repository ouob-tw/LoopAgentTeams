"""LAT panel core contract tests; all files and processes are disposable."""
import importlib.util
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"


def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def panel_save_worker(path, expected, replacement, ready, start, results):
    panel = load_module()
    ready.set()
    start.wait()
    results.put(("panel", panel.save_panel_edit(Path(path), expected, replacement)))


def question_upsert_worker(path, section_text, ready, start, results):
    panel = load_module()
    ready.set()
    start.wait()
    results.put(("agent", panel.upsert_question(Path(path), "Q1", section_text, decisions_path=Path(path).parent)))


class LockedReplaceTests(unittest.TestCase):
    def test_panel_save_and_agent_upsert_share_a_real_process_lock_in_both_orders(self):
        context = multiprocessing.get_context("spawn")
        before = (
            "## Choose?\nQ1 · r1 · 待答\n\nA（建議）\n   Old impact\n\n"
            "答覆：\nDraft\nNote\n\n- [ ] 送出\n\n"
            "## Keep?\nQ2 · r1 · 待答\n\nYes\n\n答覆：\n\n- [ ] 送出\n"
        )
        panel_text = before.replace("- [ ] 送出", "- [x] 送出", 1).replace(
            "Draft", "Panel answer", 1
        )
        section = (
            "## Choose?\n\nA（建議）\n   Agent advice\n"
        )
        for preferred in ("panel", "agent"):
            with self.subTest(preferred=preferred), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / ".lat/questions.md"
                path.parent.mkdir()
                path.write_text(before)
                path.chmod(0o640)
                lock_path = path.with_name(f".{path.name}.lock")
                results = context.Queue()
                controls = {
                    name: (context.Event(), context.Event()) for name in ("panel", "agent")
                }
                processes = {
                    "panel": context.Process(
                        target=panel_save_worker,
                        args=(str(path), before, panel_text, *controls["panel"], results),
                    ),
                    "agent": context.Process(
                        target=question_upsert_worker,
                        args=(str(path), section, *controls["agent"], results),
                    ),
                }
                with lock_path.open("a") as held_lock:
                    fcntl.flock(held_lock.fileno(), fcntl.LOCK_EX)
                    order = (preferred, "agent" if preferred == "panel" else "panel")
                    for name in order:
                        processes[name].start()
                        self.assertTrue(controls[name][0].wait(5))
                        controls[name][1].set()
                        processes[name].join(0.2)
                        self.assertTrue(processes[name].is_alive())
                    fcntl.flock(held_lock.fileno(), fcntl.LOCK_UN)
                for process in processes.values():
                    process.join(10)
                    self.assertEqual(process.exitcode, 0)

                outcomes = dict(results.get(timeout=1) for _ in processes)
                self.assertEqual(outcomes["agent"], 2)
                self.assertEqual(outcomes["panel"], preferred == "panel")
                final = path.read_text()
                self.assertIn("   Agent advice", final)
                expected_answer = "Panel answer" if preferred == "panel" else "Draft"
                self.assertIn(f"答覆：\n{expected_answer}", final)
                self.assertIn("Q2 · r1 · 待答", final)
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_successful_panel_save_appends_a_journal_entry_but_conflict_does_not(self):
        panel = load_module()
        before = (
            "## Q?\nQ1 · r1 · 待答\n\n- A\n\n答覆：\n\n- [ ] 送出\n"
        )
        after = before.replace("答覆：\n", "答覆：\nA\n").replace("[ ]", "[x]")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".lat/questions.md"
            path.parent.mkdir()
            path.write_text(before)
            journal = path.parent / "panel-journal.jsonl"

            self.assertTrue(panel.save_panel_edit(path, before, after))
            self.assertFalse(panel.save_panel_edit(path, before, "lost"))

            entries = [json.loads(line) for line in journal.read_text().splitlines()]
            self.assertEqual(len(entries), 1)
            entry = entries[0]
            self.assertRegex(entry.pop("time"), r"^\d{4}-\d\d-\d\dT.*Z$")
            self.assertEqual(entry, {
                "questions_path": str(path.resolve()),
                "before_sha256": hashlib.sha256(before.encode()).hexdigest(),
                "after_sha256": hashlib.sha256(after.encode()).hexdigest(),
                "changed_questions": [{
                    "id": "Q1", "before_status": "pending", "after_status": "ready",
                    "section_sha256": hashlib.sha256(after.encode()).hexdigest(),
                }],
            })

    def test_panel_save_records_a_question_changed_only_in_an_archived_revision(self):
        panel = load_module()
        before = (
            "## Current?\nQ1 · r2 · 待答\n\n- A\n\n答覆：\n\n- [ ] 送出\n\n"
            "### 舊版 r1（不套用至 r2）\n答覆：\nOld\nBefore\n\n- [x] 送出\n"
        )
        after = before.replace("Before", "After")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".lat/questions.md"
            path.parent.mkdir()
            path.write_text(before)

            self.assertTrue(panel.save_panel_edit(path, before, after))

            entry = json.loads(
                (path.parent / "panel-journal.jsonl").read_text().splitlines()[-1]
            )
            self.assertEqual(entry["changed_questions"], [{
                "id": "Q1",
                "before_status": "pending",
                "after_status": "pending",
                "section_sha256": hashlib.sha256(
                    before.split("\n\n### 舊版", 1)[0].encode() + b"\n"
                ).hexdigest(),
            }])


class DutyReminderTests(unittest.TestCase):
    SID = "duty-session-1"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.decisions = self.root / ".lat/decisions"
        self.decisions.mkdir(parents=True)
        self.sessions = self.root / ".lat/sessions"
        self.sessions.mkdir()
        self.reports = self.root / "reports"
        self.reports.mkdir()
        self.section = self.root / "section.md"
        self.section.write_text("## Go?\n\nBody.\n\n- A. Yes\n- B. No\n")

    def record(self, **changes):
        record = dict(client="claude", session_id=self.SID, role="orchestrator",
                      workspace=str(self.root), status="active")
        record.update(changes)
        (self.sessions / f"{self.SID}.json").write_text(json.dumps(record))

    def upsert(self, advisor, session=SID):
        (self.decisions / "Q1.md").write_text(f"# Q\n- status: pending\n- advisor: {advisor}\n")
        env = {key: value for key, value in os.environ.items()
               if key not in ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID")}
        env.update(HERDR_PLUGIN_CONFIG_DIR=str(self.root / "plugin-config"),
                   LAT_REPORTS_DIR=str(self.reports))
        if session:
            env["CLAUDE_CODE_SESSION_ID"] = session
        return subprocess.run(
            [sys.executable, str(MODULE), "question", "upsert",
             "--questions", str(self.root / ".lat/questions.md"),
             "--decisions", str(self.decisions), "--id", "Q1", "--file", str(self.section)],
            text=True, capture_output=True, env=env, cwd=self.root)

    def test_both_confirmation_kinds_print_duty_and_overwrite_command(self):
        self.record()
        (self.reports / f"{self.SID}.duty.json").write_text(
            json.dumps(dict(text="修正浮框", expected="浮框不超出")))
        for advisor in ("exempt ticket-confirmation", "exempt spec-confirmation"):
            result = self.upsert(advisor)
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = result.stdout.splitlines()
            self.assertRegex(lines[0], r"^Q1 r\d+$")
            self.assertEqual(len(lines), 2, result.stdout)
            self.assertIn("修正浮框", lines[1])
            self.assertIn("lat-session.py duty", lines[1])
            self.assertIn("--client claude", lines[1])
            self.assertIn("涵蓋本輪所有任務", lines[1])

    def test_multiline_duty_stays_on_one_line(self):
        self.record()
        (self.reports / f"{self.SID}.duty.json").write_text(
            json.dumps(dict(text="第一行\n第二行", expected="x")))
        result = self.upsert("exempt ticket-confirmation")
        self.assertEqual(len(result.stdout.splitlines()), 2, result.stdout)
        self.assertIn("第一行 第二行", result.stdout)

    def test_record_for_another_workspace_prints_nothing_extra(self):
        self.record(workspace=str(self.root / "elsewhere"))
        result = self.upsert("exempt ticket-confirmation")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"^Q1 r\d+\n$")

    def test_other_advisor_values_print_nothing_extra(self):
        self.record()
        for advisor in ("exempt requirement-discussion", "needs-human", "late resolved"):
            result = self.upsert(advisor)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertRegex(result.stdout, r"^Q1 r\d+\n$")

    def test_missing_duty_file_says_there_is_none(self):
        self.record()
        result = self.upsert("exempt ticket-confirmation")
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual(len(lines), 2)
        self.assertIn("沒有", lines[1])
        self.assertIn("lat-session.py duty", lines[1])

    def test_no_active_orchestrator_record_prints_nothing_extra_and_succeeds(self):
        cases = (("no record", None, "claude-other"), ("not active", dict(status="ended"), self.SID),
                 ("not orchestrator", dict(role="agent"), self.SID), ("no session env", {}, None))
        for name, changes, session in cases:
            with self.subTest(name):
                if changes is not None:
                    self.record(**changes)
                result = self.upsert("exempt ticket-confirmation", session=session)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertRegex(result.stdout, r"^Q1 r\d+\n$")


class QuestionCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.questions = self.root / ".lat/questions.md"
        self.questions.parent.mkdir()

    def cli(self, *args):
        if args[:2] == ("question", "upsert"):
            args = (*args, "--decisions", self.questions.parent)
        # No command has a default questions file.
        if args[0] == "question" and "--questions" not in args:
            args = (*args, "--questions", self.questions)
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True,
            capture_output=True,
            # Question commands look up the sidebar binding; keep that lookup off the real Herdr.
            env=dict(os.environ, HERDR_PLUGIN_CONFIG_DIR=str(self.root / "plugin-config")),
            cwd=self.root,
        )

    def test_upsert_bumps_revision_archives_old_answer_and_preserves_other_sections(self):
        other = (
            "## Keep this question?\nQ2 · r3 · 待答\n\nKeep this body.\n\n"
            "答覆：\nuntouched\n\n- [ ] 送出\n"
        )
        self.questions.write_text(
            "# Pending decisions\n\n"
            "## Old question?\nQ1 · r1 · 待答\n\nOld context.\n\n"
            "答覆：\nChoose A\nUser note\n\n- [x] 送出\n\n" + other
        )
        section = self.root / "section.md"
        section.write_text(
            "## New question?\n\nNew context.\n\n"
            "A. First（建議）\n   New impact\nB. Second\n   Other impact\n"
        )

        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)

        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.questions.read_text()
        self.assertTrue(text.startswith("# Pending decisions\n\n"))
        self.assertIn("## New question?\nQ1 · r2 · 待答", text)
        self.assertIn("New context.", text)
        self.assertIn(
            "A. First（建議）\n   New impact\nB. Second\n   Other impact", text
        )
        self.assertIn("答覆：\n\n- [ ] 送出", text)
        self.assertIn("### 舊版 r1（不套用至 r2）", text)
        self.assertIn("答覆：\nChoose A\nUser note\n\n- [x] 送出", text)
        self.assertTrue(text.endswith(other))

    def board_question(self, question_id):
        result = self.cli("board", "questions", "--questions", self.questions)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return next(item for item in json.loads(result.stdout)["questions"]
                    if item["id"] == question_id)

    def test_details_block_is_its_own_field_and_editing_it_bumps_the_revision(self):
        section = self.root / "section.md"
        details = (
            "來由：上次漏寫說明。\n\n"
            "A. 這行不是選項\n   也不是影響\n\n"
            "➡️ 這段也不是推薦"
        )
        section.write_text(
            "## 要怎麼做？\n\n背景一句話。\n\n"
            f"【詳細資訊】\n{details}\n【詳細資訊結束】\n\n"
            "A. 甲（建議）\n   影響甲\nB. 乙\n\n➡️ A：理由。\n"
        )
        self.assertEqual(self.cli("question", "upsert", "--id", "Q1", "--file", section).stdout,
                         "Q1 r1\n")
        question = self.board_question("Q1")
        self.assertEqual(question["context"], "背景一句話。")
        self.assertEqual(question["details"], details)
        self.assertEqual([option["label"] for option in question["options"]], ["甲", "乙"])
        self.assertEqual(question["recommendation"], "➡️ A：理由。")

        self.questions.write_text(self.questions.read_text().replace(
            "答覆：\n\n- [ ] 送出", "答覆：A. 甲\n\n- [x] 送出"))
        section.write_text(section.read_text().replace("上次漏寫說明。", "改過的來由。"))
        self.assertEqual(self.cli("question", "upsert", "--id", "Q1", "--file", section).stdout,
                         "Q1 r2\n")
        text = self.questions.read_text()
        self.assertIn("### 舊版 r1（不套用至 r2）\n答覆：A. 甲\n\n- [x] 送出", text)
        question = self.board_question("Q1")
        self.assertEqual((question["revision"], question["answer"]), (2, ""))
        self.assertIn("改過的來由。", question["details"])

    def test_details_block_after_recommendation_parses_like_after_background(self):
        block = "【詳細資訊】\n來由。\n\nA. 不是選項\n\n➡️ 不是推薦\n【詳細資訊結束】\n\n"
        options = "- A. 甲（建議）\n  影響甲\n- B. 乙\n\n"
        recommendation = "➡️ A：理由。\n"
        sections = {
            "OLD": f"## 題目？\n\n背景。\n\n{block}{options}{recommendation}",
            "NEW": f"## 題目？\n\n背景。\n\n{options}{recommendation}\n{block}",
        }
        for question_id, text in sections.items():
            section = self.root / f"{question_id}.md"
            section.write_text(text)
            self.assertEqual(self.cli("question", "upsert", "--id", question_id,
                                      "--file", section).returncode, 0)
        parsed = {}
        for question_id in sections:
            question = self.board_question(question_id)
            parsed[question_id] = {key: question[key] for key in (
                "title", "context", "details", "kind", "options", "recommendation")}
        self.assertEqual(parsed["OLD"], parsed["NEW"])
        self.assertEqual(parsed["NEW"]["details"], "來由。\n\nA. 不是選項\n\n➡️ 不是推薦")
        self.assertEqual(parsed["NEW"]["recommendation"], "➡️ A：理由。")
        panel = load_module()
        questions = {item["id"]: item for item in panel.parse_questions(self.questions.read_text())}
        self.assertEqual(panel.question_plain_text(questions["OLD"]).replace("OLD", "NEW", 1),
                         panel.question_plain_text(questions["NEW"]))

    def test_question_without_details_has_null_details(self):
        section = self.root / "section.md"
        section.write_text("## 舊格式？\n\n背景。\n\nA. 甲\n")
        self.assertEqual(self.cli("question", "upsert", "--id", "Q1", "--file", section).returncode, 0)
        question = self.board_question("Q1")
        self.assertEqual((question["context"], question["details"]), ("背景。", None))

    def test_upsert_refuses_unbalanced_or_empty_details_markers(self):
        section = self.root / "section.md"
        for body in (
            "【詳細資訊】\n沒有結束\n",
            "沒有開始\n【詳細資訊結束】\n",
            "【詳細資訊結束】\n倒過來\n【詳細資訊】\n",
            "【詳細資訊】\n一\n【詳細資訊結束】\n【詳細資訊】\n二\n【詳細資訊結束】\n",
            "【詳細資訊】\n \n【詳細資訊結束】\n",
        ):
            with self.subTest(body=body):
                section.write_text(f"## 題目？\n\n背景。\n\n{body}\nA. 甲\n")
                result = self.cli("question", "upsert", "--id", "Q1", "--file", section)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("details block", result.stderr)
                self.assertFalse(self.questions.exists())

    def test_parser_only_treats_heading_followed_by_status_as_a_section_boundary(self):
        document = (
            "## First?\nQ1 · r1 · 待答\n\nContext.\n\n答覆：\n"
            "A long answer.\n## This is part of the answer\nStill the answer.\n\n"
            "- [x] 送出\n\n## Second?\nQ2 · r2 · 已記錄\n\n"
            "Context two.\n\n答覆：\nB\n\n- [x] 送出\n"
        )

        parsed = load_module().parse_questions(document)

        self.assertEqual([item["id"] for item in parsed], ["Q1", "Q2"])
        self.assertEqual(parsed[0]["title"], "First?")
        self.assertEqual(parsed[0]["answer"], "A long answer.\n## This is part of the answer\nStill the answer.")
        self.assertEqual(parsed[0]["status"], "ready")
        self.assertEqual(parsed[1]["status"], "recorded")

    def test_missing_current_markers_never_borrow_an_archived_submission(self):
        cases = (
            "答覆：\n\n",
            "答覆：\n\n- [] 送出\n\n",
            "- [ ] 送出\n\n",
        )
        for current_area in cases:
            with self.subTest(current_area=current_area):
                document = (
                    "## Revised?\nQ1 · r2 · 待答\n\nNew body.\n\n"
                    f"{current_area}"
                    "### 舊版 r1（不套用至 r2）\n答覆：\n"
                    "Approve the old proposal\n\n- [x] 送出\n"
                )
                self.questions.write_text(document)

                [parsed] = load_module().parse_questions(document)

                self.assertEqual(parsed["status"], "pending")
                self.assertFalse(parsed["checked"])
                self.assertIsNone(parsed["answer"])
                result = self.cli(
                    "question", "provenance", "--questions", self.questions,
                    "--journal", self.questions.parent / "panel-journal.jsonl",
                    "--id", "Q1",
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("not submitted", result.stderr)

    def test_set_status_refuses_revision_or_section_mismatch_then_marks_recorded(self):
        original = (
            "Intro\n\n## Question?\nQ1 · r2 · 待答\n\nContext.\n\n"
            "答覆：\nAnswer\n\n- [x] 送出\n"
        )
        self.questions.write_text(original)

        mismatch = self.cli(
            "question", "set-status", "--id", "Q1", "--revision", "1",
            "--status", "recorded", "--expected-section-sha256", "unused",
        )
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("revision mismatch", mismatch.stderr)
        self.assertEqual(self.questions.read_text(), original)

        hash_result = self.cli(
            "question", "section-hash", "--questions", self.questions, "--id", "Q1",
        )
        self.assertEqual(hash_result.returncode, 0, hash_result.stderr)
        result = self.cli(
            "question", "set-status", "--id", "Q1", "--revision", "2",
            "--status", "recorded", "--expected-section-sha256",
            json.loads(hash_result.stdout)["section_sha256"],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(
            self.questions.read_text(),
            r"Q1 · r2 · 已記錄 · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d",
        )

    def test_recorded_question_is_archived_after_five_minutes_without_touching_others(self):
        panel = load_module()
        first = (
            "## Answered?\nQ1 · r2 · 待答\n\nContext.\n\n"
            "答覆：\nA\n\n- [x] 送出\n\n"
            "### 舊版 r1（不套用至 r2）\n答覆：\nold\n\n- [x] 送出\n\n"
        )
        pending = (
            "## Keep pending?\nQ2 · r1 · 待答\n\nKeep exactly.\n\n"
            "答覆：\nDraft\n\n- [ ] 送出\n"
        )
        self.questions.write_text("# Decisions\n\n" + first + pending)
        recorded_at = datetime(2026, 10, 2, 18, 5, tzinfo=timezone(timedelta(hours=8)))
        expected_hash = panel._section_sha256(panel.parse_questions(self.questions.read_text())[0])

        panel.set_question_status(
            self.questions, "Q1", 2, "recorded", expected_hash, now=recorded_at,
        )
        recorded = self.questions.read_text()
        self.assertIn("Q1 · r2 · 已記錄 · 2026-10-02T18:05:00+08:00", recorded)
        self.assertEqual(
            panel.archive_recorded_questions(
                self.questions, 300, expected_text=recorded,
                now=recorded_at + timedelta(seconds=300),
            ),
            [],
        )

        archived = panel.archive_recorded_questions(
            self.questions, 300, expected_text=recorded,
            now=recorded_at + timedelta(seconds=301),
        )

        self.assertEqual(archived, ["Q1"])
        self.assertEqual(self.questions.read_text(), "# Decisions\n\n" + pending)
        archive = self.questions.with_name("questions-archive.md")
        self.assertEqual(archive.read_text(), first.replace(
            "Q1 · r2 · 待答", "Q1 · r2 · 已記錄 · 2026-10-02T18:05:00+08:00",
        ))
        journal = [
            json.loads(line)
            for line in (self.questions.parent / "panel-journal.jsonl").read_text().splitlines()
        ]
        self.assertEqual([entry["kind"] for entry in journal], ["set-status", "archive-recorded"])
        self.assertEqual(journal[-1]["archived_questions"], ["Q1"])
        self.assertEqual(journal[-1]["archive_path"], str(archive))

    def test_archive_is_conditional_append_only_and_leaves_post_recording_edits(self):
        panel = load_module()
        original = (
            "## Answered?\nQ1 · r1 · 待答\n\nContext.\n\n"
            "答覆：\nA\n\n- [x] 送出\n"
        )
        self.questions.write_text(original)
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        expected_hash = panel._section_sha256(panel.parse_questions(original)[0])
        panel.set_question_status(
            self.questions, "Q1", 1, "recorded", expected_hash, now=recorded_at,
        )
        recorded = self.questions.read_text()

        self.assertIsNone(panel.archive_recorded_questions(
            self.questions, 300, expected_text="stale snapshot",
            now=recorded_at + timedelta(seconds=301),
        ))
        self.assertEqual(self.questions.read_text(), recorded)
        self.assertFalse(self.questions.with_name("questions-archive.md").exists())

        edited = recorded.replace("答覆：\nA", "答覆：\nA, with a later note")
        self.assertTrue(panel.save_panel_edit(self.questions, recorded, edited))
        self.assertEqual(panel.archive_recorded_questions(
            self.questions, 300, expected_text=edited,
            now=recorded_at + timedelta(seconds=301),
        ), [])
        self.assertEqual(self.questions.read_text(), edited)

        self.questions.write_text(original)
        panel.set_question_status(
            self.questions, "Q1", 1, "recorded", expected_hash, now=recorded_at,
        )
        current = self.questions.read_text()
        archive = self.questions.with_name("questions-archive.md")
        archive.write_text("# Earlier archive\n\n")
        self.assertEqual(panel.archive_recorded_questions(
            self.questions, 300, expected_text=current,
            now=recorded_at + timedelta(seconds=301),
        ), ["Q1"])
        self.assertTrue(archive.read_text().startswith("# Earlier archive\n\n"))
        self.assertEqual(archive.read_text().count("## Answered?"), 1)

    def test_archive_leaves_a_question_when_its_old_revision_changed_after_recording(self):
        panel = load_module()
        original = (
            "## Answered?\nQ1 · r2 · 待答\n\nContext.\n\n"
            "答覆：\nA\n\n- [x] 送出\n\n"
            "### 舊版 r1（不套用至 r2）\n答覆：\nold\n\n- [x] 送出\n"
        )
        self.questions.write_text(original)
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        expected_hash = panel._section_sha256(panel.parse_questions(original)[0])
        panel.set_question_status(
            self.questions, "Q1", 2, "recorded", expected_hash, now=recorded_at,
        )
        recorded = self.questions.read_text()
        edited = recorded.replace("答覆：\nold", "答覆：\nold, edited later")
        self.questions.write_text(edited)

        archived = panel.archive_recorded_questions(
            self.questions, 300, expected_text=edited,
            now=recorded_at + timedelta(seconds=301),
        )

        self.assertEqual(archived, [])
        self.assertEqual(self.questions.read_text(), edited)
        self.assertFalse(self.questions.with_name("questions-archive.md").exists())

    def test_archive_recorded_cli_uses_questions_derived_archive_path(self):
        panel = load_module()
        questions = self.questions.with_name("questions-controller-a.md")
        original = (
            "## Answered?\nQ1 · r1 · 待答\n\nContext.\n\n"
            "答覆：\nA\n\n- [x] 送出\n"
        )
        questions.write_text(original)
        expected_hash = panel._section_sha256(panel.parse_questions(original)[0])
        panel.set_question_status(
            questions, "Q1", 1, "recorded", expected_hash,
            now=datetime.now().astimezone() - timedelta(seconds=1),
        )

        result = self.cli(
            "question", "archive-recorded", "--questions", questions,
            "--older-than", "0",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["archived"], ["Q1"])
        self.assertFalse(panel.parse_questions(questions.read_text()))
        archive = questions.with_name("questions-controller-a-archive.md")
        self.assertIn("## Answered?", archive.read_text())

    def test_provenance_requires_checked_submit_and_survives_other_question_upsert(self):
        before = (
            "## Choose?\nQ1 · r1 · 待答\n\n- A\n\n答覆：\nA\n\n- [ ] 送出\n\n"
            "## Other?\nQ2 · r1 · 待答\n\nOld body.\n\n答覆：\n\n- [ ] 送出\n"
        )
        draft = before.replace("答覆：\nA", "答覆：\nDraft A", 1)
        self.questions.write_text(before)
        panel = load_module()
        self.assertTrue(panel.save_panel_edit(self.questions, before, draft))
        refused = self.cli(
            "question", "provenance", "--questions", self.questions,
            "--journal", self.questions.parent / "panel-journal.jsonl", "--id", "Q1",
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("not submitted", refused.stderr)

        answered = draft.replace("- [ ] 送出", "- [x] 送出", 1)
        self.assertTrue(panel.save_panel_edit(self.questions, draft, answered))
        section = self.root / "section.md"
        section.write_text("## Other?\n\nNew body.\n")
        self.assertEqual(
            self.cli("question", "upsert", "--id", "Q2", "--file", section).returncode,
            0,
        )
        snapshot = self.root / "snapshot.md"
        snapshot.write_text(self.questions.read_text())

        result = self.cli(
            "question", "provenance", "--questions", snapshot,
            "--source-questions", self.questions,
            "--journal", self.questions.parent / "panel-journal.jsonl", "--id", "Q1",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads(result.stdout)
        self.assertEqual(proof["status"], "ok")
        self.assertEqual(proof["id"], "Q1")
        self.assertEqual(proof["questions_path"], str(self.questions.resolve()))
        self.assertEqual(proof["journal_line"], 2)
        self.assertRegex(proof["time"], r"^\d{4}-\d\d-\d\dT.*Z$")
        self.assertEqual(
            proof["section_sha256"],
            hashlib.sha256(answered.split("\n\n## Other?", 1)[0].encode() + b"\n").hexdigest(),
        )

    def test_same_line_answer_with_uppercase_submit_survives_provenance_status_and_archive(self):
        panel = load_module()
        pending = (
            "## Choose?\nQ1 · r1 · 待答\n\nA（建議）\n   No impact.\n\n"
            "答覆：\n\n- [ ] 送出\n"
        )
        answered = pending.replace(
            "答覆：\n\n- [ ] 送出", "答覆：B\n\nSecond paragraph\n\n- [X] 送出"
        )
        self.questions.write_text(pending)
        self.assertTrue(panel.save_panel_edit(self.questions, pending, answered))
        [parsed] = panel.parse_questions(answered)
        self.assertEqual(parsed["answer"], "B\n\nSecond paragraph")
        self.assertEqual(parsed["status"], "ready")

        proof = panel.question_provenance(
            self.questions,
            self.questions.parent / "panel-journal.jsonl",
            "Q1",
        )
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        panel.set_question_status(
            self.questions,
            "Q1",
            1,
            "recorded",
            proof["section_sha256"],
            now=recorded_at,
        )
        self.assertEqual(
            panel.archive_recorded_questions(
                self.questions,
                300,
                now=recorded_at + timedelta(seconds=301),
            ),
            ["Q1"],
        )
        self.assertEqual(self.questions.read_text(), "")
        self.assertIn(
            "答覆：B\n\nSecond paragraph\n\n- [X] 送出",
            self.questions.with_name("questions-archive.md").read_text(),
        )

    def test_provenance_refuses_legacy_entry_without_a_section_hash(self):
        section = (
            "## Choose?\nQ1 · r1 · 待答\n\n- A\n\n答覆：\nA\n\n- [x] 送出\n"
        )
        self.questions.write_text(section)
        journal = self.questions.parent / "panel-journal.jsonl"
        journal.write_text(json.dumps({
            "time": "2026-10-02T00:00:00Z",
            "after_sha256": hashlib.sha256(section.encode()).hexdigest(),
            "changed_questions": [{
                "id": "Q1", "before_status": "pending", "after_status": "ready",
            }],
        }) + "\n")

        result = self.cli(
            "question", "provenance", "--questions", self.questions,
            "--journal", journal, "--id", "Q1",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has no per-question section hash", result.stderr)

    def test_same_question_id_in_two_controller_files_keeps_provenance_and_archive_separate(self):
        panel = load_module()
        first = self.root / ".lat/questions-alpha.md"
        second = self.root / ".lat/questions-beta.md"
        pending = (
            "## Choose?\nQ1 · r1 · 待答\n\nA（建議）\n   No impact.\n\n"
            "答覆：\n\n- [ ] 送出\n"
        )
        first_submitted = pending.replace(
            "答覆：\n\n- [ ] 送出", "答覆：\nA\n\n- [x] 送出"
        )
        second_submitted = pending.replace(
            "答覆：\n\n- [ ] 送出", "答覆：\nB\n\n- [x] 送出"
        )
        first.write_text(pending)
        second.write_text(pending)
        self.assertTrue(panel.save_panel_edit(first, pending, first_submitted))
        self.assertTrue(panel.save_panel_edit(second, pending, second_submitted))
        journal = self.root / ".lat/panel-journal.jsonl"
        first_snapshot = self.root / "first-snapshot.md"
        first_snapshot.write_text(first.read_text())

        first_provenance = panel.question_provenance(
            first_snapshot, journal, "Q1", source_questions_path=first
        )
        second_provenance = panel.question_provenance(second, journal, "Q1")
        recorded_at = datetime(2026, 10, 2, 9, 0, tzinfo=timezone.utc)
        panel.set_question_status(
            first, "Q1", 1, "recorded", first_provenance["section_sha256"],
            now=recorded_at,
        )
        panel.set_question_status(
            second, "Q1", 1, "recorded", second_provenance["section_sha256"],
            now=recorded_at,
        )
        later = recorded_at + timedelta(seconds=301)
        self.assertEqual(panel.archive_recorded_questions(first, 300, now=later), ["Q1"])
        self.assertEqual(panel.archive_recorded_questions(second, 300, now=later), ["Q1"])
        self.assertIn("## Choose?", panel._archive_path(first).read_text())
        self.assertIn("## Choose?", panel._archive_path(second).read_text())

    def test_set_status_refuses_when_answer_changed_after_snapshot(self):
        original = (
            "## Choose?\nQ1 · r1 · 待答\n\n- A\n\n答覆：\nA\n\n- [x] 送出\n"
        )
        self.questions.write_text(original)
        expected_hash = hashlib.sha256(original.encode()).hexdigest()
        edited = original.replace("答覆：\nA", "答覆：\nB")
        self.questions.write_text(edited)

        result = self.cli(
            "question", "set-status", "--id", "Q1", "--revision", "1",
            "--status", "recorded", "--expected-section-sha256", expected_hash,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("section hash mismatch", result.stderr)
        self.assertEqual(self.questions.read_text(), edited)

    def test_identical_upsert_keeps_revision_status_answer_and_checkbox(self):
        original = (
            "## Same?\nQ1 · r4 · 待答\n\nContext.\n\n- A（建議）\n  Impact.\n\n"
            "答覆：\nUser answer\nUser note\n\n- [x] 送出\n"
        )
        self.questions.write_text(original)
        section = self.root / "section.md"
        section.write_text(
            "## Same?\n\nContext.\n\n- A（建議）\n  Impact.\n"
        )

        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.questions.read_text(), original)

    def test_repeated_revision_does_not_apply_an_older_answer_to_the_intermediate_revision(self):
        self.questions.write_text(
            "## First?\nQ1 · r1 · 待答\n\n- A\n\n答覆：\nOriginal answer\n"
            "Original note\n\n- [x] 送出\n"
        )
        section = self.root / "section.md"
        for question in ("Second?", "Third?"):
            section.write_text(f"## {question}\n\n- A\n")
            result = self.cli("question", "upsert", "--id", "Q1", "--file", section)
            self.assertEqual(result.returncode, 0, result.stderr)

        text = self.questions.read_text()
        self.assertIn(
            "### 舊版 r2（不套用至 r3）\n答覆：\n\n- [ ] 送出", text
        )
        self.assertEqual(text.count("Original answer"), 1)
        self.assertEqual(text.count("Original note"), 1)

    def test_question_update_archives_markdown_headings_in_answer(self):
        original_answer = "A\n### Reason\nKeep this explanation\n## User heading\nMore"
        self.questions.write_text(
            "## Same?\nQ1 · r2 · 待答\n\n- A\n\n"
            f"答覆：\n{original_answer}\n\n- [x] 送出\n"
        )
        section = self.root / "section.md"
        section.write_text("## Changed?\n\n- A\n")

        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)

        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.questions.read_text()
        self.assertIn("### 舊版 r2（不套用至 r3）", text)
        self.assertIn(original_answer, text)

    def test_second_revision_keeps_following_section_byte_identical(self):
        other = (
            "## Keep?\nQ2 · r1 · 已記錄\n\nKeep body.\n\n"
            "答覆：\nAnswer\nNote\n\n- [x] 送出\n"
        )
        self.questions.write_text(
            "## Old?\nQ1 · r1 · 待答\n\nOld body.\n\n"
            "答覆：\nAnswer\nNote\n\n- [x] 送出\n\n" + other
        )
        section = self.root / "section.md"
        section.write_text("## New?\n\nFirst body.\n")
        self.assertEqual(
            self.cli("question", "upsert", "--id", "Q1", "--file", section).returncode,
            0,
        )
        section.write_text("## New?\n\nSecond body.\n")

        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.questions.read_text().endswith(other))
        parsed = load_module().parse_questions(self.questions.read_text())
        self.assertEqual([item["id"] for item in parsed], ["Q1", "Q2"])


class BindingCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "plugin-config"
        self.env = dict(os.environ, HERDR_PLUGIN_CONFIG_DIR=str(self.config))
        self.first = self.root / "first"
        self.second = self.root / "second"
        self.first.mkdir()
        self.second.mkdir()

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True, capture_output=True, env=self.env, cwd=self.root,
        )

    def bind(self, name, session, workspace, herdr_workspace, tab, pane):
        return self.cli(
            "bind", "--hcom-name", name, "--client", "codex",
            "--session-id", session, "--workspace", workspace,
            "--herdr-workspace", herdr_workspace,
            "--herdr-tab", tab, "--herdr-pane", pane,
        )

    def test_bindings_are_per_session_with_separate_sanitized_question_files(self):
        first = self.bind("alpha", "s1", self.first, "herdr-1", "tab-1", "pane-1")
        second = self.bind("beta", "s2", self.second, "herdr-1", "tab-2", "pane-2")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)

        exact = self.cli("resolve", "--session-id", "s1")
        self.assertEqual(json.loads(exact.stdout)["hcom_name"], "alpha")
        self.assertEqual(
            json.loads(first.stdout)["binding"]["questions_path"],
            str(self.first / ".lat/questions/alpha.md"),
        )
        ambiguous = self.cli("resolve", "--herdr-workspace", "herdr-1")
        self.assertNotEqual(ambiguous.returncode, 0)
        self.assertIn("multiple LAT controllers", ambiguous.stderr)

        self.assertEqual(self.cli("unbind", "--session-id", "s2").returncode, 0)
        self.assertEqual(
            json.loads(self.cli("resolve", "--herdr-workspace", "herdr-1").stdout)["hcom_name"],
            "alpha",
        )

        rebound = self.bind("gamma", "s1", self.second, "herdr-2", "tab-3", "pane-3")
        payload = json.loads(rebound.stdout)
        self.assertEqual(payload["replaced"]["hcom_name"], "alpha")
        self.assertEqual(
            payload["binding"]["questions_path"],
            str(self.second / ".lat/questions/gamma.md"),
        )
        self.assertEqual(payload["binding"]["herdr_tab"], "tab-3")
        self.assertEqual(payload["binding"]["herdr_pane"], "pane-3")
        missing = self.cli("resolve", "--herdr-workspace", "herdr-1")
        self.assertNotEqual(missing.returncode, 0)
        self.assertIn("no LAT controller is bound", missing.stderr)

    def test_unbind_removes_only_its_session(self):
        self.bind("alpha", "s1", self.first, "herdr-1", "tab-1", "pane-1")
        self.bind("beta", "s2", self.second, "herdr-1", "tab-2", "pane-2")
        removed = json.loads(self.cli("unbind", "--session-id", "s1").stdout)
        self.assertEqual(removed["removed"], 1)
        self.assertEqual(
            json.loads(self.cli("resolve", "--session-id", "s2").stdout)["hcom_name"],
            "beta",
        )

    def test_legacy_workspace_bindings_are_ignored_and_reported_on_rebind(self):
        self.config.mkdir(parents=True)
        legacy_questions = self.first / ".lat/questions.md"
        legacy_questions.parent.mkdir(parents=True)
        legacy_questions.write_text("legacy questions stay here\n")
        (self.config / "bindings.json").write_text(json.dumps({"bindings": {
            "herdr-1": {"hcom_name": "old", "session_id": "old-session"},
        }}))
        stale = self.cli("resolve", "--herdr-workspace", "herdr-1")
        self.assertNotEqual(stale.returncode, 0)
        self.assertIn("legacy bindings ignored", stale.stderr)

        rebound = self.bind("alpha", "s1", self.first, "herdr-1", "tab-1", "pane-1")
        self.assertEqual(rebound.returncode, 0, rebound.stderr)
        self.assertEqual(json.loads(rebound.stdout)["legacy_ignored"], 1)
        saved = json.loads((self.config / "bindings.json").read_text())
        self.assertEqual(saved["version"], 2)
        self.assertEqual(list(saved["bindings"]), ["s1"])
        self.assertEqual(legacy_questions.read_text(), "legacy questions stay here\n")

    def test_hcom_name_is_sanitized_for_the_questions_filename_only(self):
        result = self.bind(
            "Alpha / Team", "s1", self.first, "herdr-1", "tab-1", "pane-1"
        )
        binding = json.loads(result.stdout)["binding"]
        self.assertEqual(binding["hcom_name"], "Alpha / Team")
        self.assertEqual(
            binding["questions_path"],
            str(self.first / ".lat/questions/alpha-team.md"),
        )


class PendingCheckCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.questions = self.root / '.lat/questions-alpha.md'
        self.decisions = self.root / 'decisions'
        self.decisions.mkdir()
        binary = self.root / 'bin'
        binary.mkdir()
        herdr = binary / 'herdr'
        herdr.write_text(
            '#!/bin/sh\n'
            'test "$*" = "plugin list --plugin lat.panel --json" || exit 91\n'
            'printf \'%s\\n\' \'{"plugins":[{"plugin_id":"lat.panel","enabled":true}]}\'\n'
        )
        herdr.chmod(0o755)
        self.env = dict(os.environ)
        self.env.update({
            'PATH': f'{binary}:{os.environ["PATH"]}',
            'HERDR_WORKSPACE_ID': 'herdr-workspace',
        })

    def cli(self, *args, env=None):
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True, capture_output=True, env=env or self.env, cwd=self.root,
        )

    def check(self, env=None):
        return self.cli(
            'question', 'check-pending', '--questions', self.questions,
            '--decisions', self.decisions, env=env,
        )

    def decision(self, identifier, status):
        (self.decisions / f'{identifier}.md').write_text(
            f'# {identifier}\n\n- status: {status}\n'
        )

    def test_reverse_check_reports_only_own_stale_and_missing_decisions(self):
        self.questions.parent.mkdir()
        self.questions.write_text(
            '## Old?\nOLD · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'
            '## Missing?\nMISSING · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'
            '## Sent?\nSENT · r1 · 待答\n\n答覆：A\n\n- [x] 送出\n'
        )
        self.questions.with_name('questions-other.md').write_text(
            '## Other?\nOTHER · r1 · 待答\n')
        self.decision('OLD', 'answered')
        self.decision('SENT', 'resolved')
        result = self.check()
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('OLD：題目待答但決策已非 pending', result.stdout)
        self.assertIn('question cleanup --questions', result.stdout)
        self.assertIn('MISSING：題目待答但找不到決策紀錄；補決策紀錄', result.stdout)
        self.assertIn('SENT：題目待答但決策已非 pending；處理使用者已送出的答覆', result.stdout)
        self.assertNotIn('OTHER', result.stdout)
        self.assertNotIn('沒有遺漏', result.stdout)

    def test_check_reports_pending_decision_missing_from_questions(self):
        self.decision('MISSING-1', 'pending')

        result = self.check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('遺漏待答題目：', result.stdout)
        self.assertIn('- MISSING-1', result.stdout)

    def test_check_passes_when_every_pending_decision_has_pending_question(self):
        self.decision('PENDING-1', 'pending')
        self.decision('RECORDED-1', 'recorded')
        self.decision('ARCHIVED-1', 'archived')
        self.questions.parent.mkdir()
        self.questions.write_text(
            '## Choose?\nPENDING-1 · r2 · 待答\n\n答覆：\n\n- [ ] 送出\n'
        )

        result = self.check()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'- PENDING-1：{self.questions}', result.stdout)
        self.assertIn('沒有遺漏', result.stdout)

    def test_check_finds_pending_question_in_another_controllers_file(self):
        self.decision('SHARED-1', 'pending')
        other_questions = self.questions.with_name('questions-beta.md')
        other_questions.parent.mkdir()
        other_questions.write_text(
            '## Other controller?\nSHARED-1 · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n'
        )

        result = self.check()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'- SHARED-1：{other_questions}', result.stdout)
        self.assertIn('沒有遺漏', result.stdout)
        self.assertNotIn('遺漏待答題目：', result.stdout)

    def test_check_recognizes_case_and_spacing_in_the_first_status_line(self):
        for identifier, record in {
            'UPPER': '- Status: PENDING\n',
            'COMPACT': '- status:pending\n',
            'SPACES': '- STATUS: \tPeNdInG extra context\n',
            'FIRST': '- Status: pending\n- status: approved\n',
        }.items():
            (self.decisions / f'{identifier}.md').write_text(record)

        result = self.check()

        self.assertEqual(result.returncode, 1, result.stderr)
        for identifier in ('UPPER', 'COMPACT', 'SPACES', 'FIRST'):
            self.assertIn(f'- {identifier}\n', result.stdout)
        self.assertNotIn('沒有遺漏', result.stdout)

    def test_check_fails_and_lists_each_unreadable_record_without_pending_gaps(self):
        for identifier, record in {
            'NO-LINE': '# Decision\n',
            'EMPTY': '- status:\n',
            'WHITESPACE': '- Status: \t \n',
            'FREE-TEXT': '- Status: still pending overall\n',
        }.items():
            (self.decisions / f'{identifier}.md').write_text(record)

        result = self.check()

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('讀不出狀態：', result.stdout)
        for identifier in ('NO-LINE', 'EMPTY', 'WHITESPACE', 'FREE-TEXT'):
            self.assertIn(str(self.decisions / f'{identifier}.md'), result.stdout)
        self.assertNotIn('沒有遺漏', result.stdout)
        self.assertNotIn('遺漏待答題目：', result.stdout)

    def test_check_and_wait_release_agree_on_the_same_decision_records(self):
        # HCOM is the only external service replaced; record reading and wait
        # persistence use the real tools and disposable files.
        hcom = self.root / 'bin/hcom'
        hcom.write_text('#!/bin/sh\nexit 0\n')
        hcom.chmod(0o755)
        records = {
            'UPPER': ('- Status: PENDING\n', 'pending'),
            'COMPACT': ('- status:pending\n', 'pending'),
            'SPACES': ('- STATUS:\tPeNdInG details\n', 'pending'),
            'FIRST': ('- status: pending\n- Status: approved\n', 'pending'),
            'FREE': ('- Status: still pending overall\n', 'unreadable'),
            'MISSING': ('status: pending\n', 'unreadable'),
            'EMPTY': ('- status:\n- blocks: review\n', 'unreadable'),
            'BLANK': ('- Status: \t  \n', 'unreadable'),
            'LATER': ('- status: Approved but PENDING elsewhere\n', 'unreadable'),
            'APPROVED': ('- status: approved\n- status: pending\n', 'resolved'),
            'ANSWERED': ('- Status: ANSWERED\n', 'resolved'),
            'CLOSED': ('- status:closed\n', 'resolved'),
            'DECIDED': ('- status: decided\n', 'resolved'),
            'DEFERRED': ('- status: deferred\n', 'resolved'),
            'RECORDED': ('- status: recorded\n', 'resolved'),
            'ARCHIVED': ('- status: archived\n', 'resolved'),
            'CUSTOM': ('- status: custom-result explanation\n', 'resolved'),
        }
        for identifier, (record, _) in records.items():
            (self.decisions / f'{identifier}.md').write_text(record)

        result = self.check()

        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn('讀不出狀態：', result.stdout)
        self.assertNotIn('沒有遺漏', result.stdout)
        for identifier, (_, classification) in records.items():
            if classification == 'pending':
                self.assertIn(f'- {identifier}\n', result.stdout)
            elif classification == 'unreadable':
                self.assertIn(str(self.decisions / f'{identifier}.md'), result.stdout)
            else:
                self.assertNotIn(identifier, result.stdout)
        self.assertIn('沒有狀態行', result.stdout)
        self.assertIn('狀態值為空或只有空白', result.stdout)
        self.assertIn('第一個字不是 pending', result.stdout)

        script = MODULE.parents[1] / 'scripts/lat-watch.py'
        spec = importlib.util.spec_from_file_location('lat_watch', script)
        watch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(watch)
        for identifier, (_, classification) in records.items():
            with self.subTest(identifier=identifier), patch.dict(os.environ, self.env):
                declaration = {
                    'agent': 'worker', 'target': identifier, 'reason': 'decision',
                    'declared_at_utc': '2026-10-05T00:00:00+00:00', 'active': True,
                }
                path = watch.wait_path(self.root, 'worker')
                watch.write_object(path, declaration)
                reason = watch.release_wait_if_needed(
                    self.root, self.decisions, 'orch', declaration,
                    agents={'worker': {'session_id': 'worker-session'}})
                saved = json.loads(path.read_text())
                if classification == 'resolved':
                    self.assertEqual(reason, 'decision-resolved')
                    self.assertFalse(saved['active'])
                else:
                    self.assertIsNone(reason)
                    self.assertEqual(saved, declaration)
        log = self.root / '.lat/watch/orch/watch.jsonl'
        entries = [json.loads(line) for line in log.read_text().splitlines()]
        self.assertEqual(len(entries), 5)
        self.assertEqual({entry['target'] for entry in entries},
                         {'FREE', 'MISSING', 'EMPTY', 'BLANK', 'LATER'})
        for entry in entries:
            self.assertEqual(entry['decision'], 'decision-status-unreadable')
            self.assertTrue(entry['treated_as_pending'])
            self.assertIn(entry['file'], result.stdout)
            self.assertIn(entry['error'], result.stdout)

    def test_check_reports_recorded_and_archived_questions_as_inconsistent(self):
        self.decision('RECORDED-Q', 'pending')
        self.decision('ARCHIVED-Q', 'pending')
        self.questions.parent.mkdir()
        self.questions.write_text(
            '## Done?\nRECORDED-Q · r3 · 已記錄\n\n答覆：A\n\n- [x] 送出\n'
        )
        archive = self.questions.with_name('questions-alpha-archive.md')
        archive.write_text(
            '## Old?\nARCHIVED-Q · r1 · 已記錄\n\n答覆：B\n\n- [x] 送出\n'
        )

        result = self.check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('狀態不一致（決策仍為 pending）：', result.stdout)
        self.assertIn('- RECORDED-Q：問題檔已記錄', result.stdout)
        self.assertIn('- ARCHIVED-Q：問題已歸檔', result.stdout)
        self.assertNotIn('遺漏待答題目：', result.stdout)

    def test_check_finds_recorded_question_in_another_controllers_archive(self):
        self.decision('OTHER-ARCHIVED', 'pending')
        other_archive = self.questions.with_name('questions-beta-archive.md')
        other_archive.parent.mkdir()
        other_archive.write_text(
            '## Old elsewhere?\nOTHER-ARCHIVED · r4 · 已記錄\n\n'
            '答覆：A\n\n- [x] 送出\n'
        )

        result = self.check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn(
            f'- OTHER-ARCHIVED：問題已歸檔：{other_archive}', result.stdout
        )
        self.assertNotIn('遺漏待答題目：', result.stdout)

    def test_check_skips_when_panel_is_disabled(self):
        self.decision('MISSING-1', 'pending')
        env = dict(self.env)
        env.pop('HERDR_WORKSPACE_ID')

        result = self.check(env=env)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('面板未啟用，略過檢查', result.stdout)

    def test_check_fails_when_decisions_directory_is_missing(self):
        self.decisions.rmdir()

        result = self.check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn('decisions directory does not exist', result.stderr)
        self.assertNotIn('沒有遺漏', result.stdout)


class PluginDirectoryTests(unittest.TestCase):
    def test_fallback_matches_herdr_plugin_directory_layout(self):
        panel = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env = {
                "PATH": str(root / "no-herdr"),
                "XDG_CONFIG_HOME": str(root / "config"),
                "XDG_STATE_HOME": str(root / "state"),
            }
            self.assertEqual(
                panel.plugin_directory("config", env),
                root / "config/herdr/plugins/config/lat.panel",
            )
            self.assertEqual(
                panel.plugin_directory("state", env),
                root / "state/herdr/plugins/lat.panel",
            )


class NotificationTests(unittest.TestCase):
    def test_real_hcom_receipts_accept_exact_or_tagged_base_name_only(self):
        panel = load_module()
        cases = (
            ("zone", ["zone"], True),
            ("koma-qa-zone", ["zone"], True),
            ("koma-qa-zone", ["koma"], False),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            questions = root / "project/.lat/questions.md"
            questions.parent.mkdir(parents=True)
            questions.write_text("no answer content")
            state_dir = root / "state"
            for target, delivered_to, expected_ok in cases:
                with self.subTest(target=target, delivered_to=delivered_to):
                    panel.mark_notification_pending(questions, state_dir=state_dir)
                    receipt = subprocess.CompletedProcess(
                        ["hcom", "send"], 0,
                        json.dumps({"delivered_to": delivered_to}), "",
                    )
                    binding = {
                        "hcom_name": target,
                        "questions_path": str(questions),
                    }
                    with patch.object(panel.bindings.subprocess, "run", return_value=receipt):
                        ok, _reason = panel.send_pending_notification(
                            questions, binding, state_dir=state_dir,
                        )
                    self.assertEqual(ok, expected_ok)
                    self.assertEqual(
                        panel.notification_is_pending(
                            questions, state_dir=state_dir,
                        ),
                        not expected_ok,
                    )

    def test_pending_state_survives_failed_delivery_and_clears_after_target_delivery(self):
        panel = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_dir = root / "state"
            questions = root / "project/.lat/questions.md"
            questions.parent.mkdir(parents=True)
            questions.write_text("secret answer text")
            bin_dir = root / "bin"
            bin_dir.mkdir()
            args_path = root / "args.json"
            shim = bin_dir / "hcom"
            shim.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, pathlib, sys\n"
                "pathlib.Path(os.environ['HCOM_ARGS']).write_text(json.dumps(sys.argv[1:]))\n"
                "print(os.environ['HCOM_OUTPUT'])\n"
            )
            shim.chmod(0o755)
            env = dict(
                os.environ,
                PATH=f"{bin_dir}:{os.environ['PATH']}",
                HCOM_ARGS=str(args_path),
                HCOM_OUTPUT=json.dumps({"delivered_to": ["someone-else"]}),
            )
            binding = {"hcom_name": "alpha", "questions_path": str(questions)}

            panel.mark_notification_pending(questions, state_dir=state_dir)
            ok, reason = panel.send_pending_notification(
                questions, binding, state_dir=state_dir, env=env,
            )
            self.assertFalse(ok)
            self.assertIn("not delivered", reason)
            self.assertTrue(panel.notification_is_pending(questions, state_dir=state_dir))
            args = json.loads(args_path.read_text())
            self.assertEqual(args[:7], [
                "send", "@alpha", "--from", "lat-panel", "--intent", "inform", "--json",
            ])
            self.assertEqual(args[7], "--")
            self.assertIn(str(questions), args[8])
            self.assertIn("not approval", args[8])
            self.assertNotIn("secret answer text", args[8])
            self.assertNotIn("--name", args)

            env["HCOM_OUTPUT"] = json.dumps({"delivered_to": ["alpha"]})
            self.assertEqual(
                panel.send_pending_notification(
                    questions, binding, state_dir=state_dir, env=env,
                ),
                (True, "delivered"),
            )
            self.assertFalse(panel.notification_is_pending(questions, state_dir=state_dir))

    def test_successful_send_does_not_clear_a_newer_pending_change(self):
        panel = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            questions = root / "project/.lat/questions.md"
            state_dir = root / "state"
            binding = {"hcom_name": "alpha", "questions_path": str(questions)}
            panel.mark_notification_pending(questions, state_dir=state_dir)

            def deliver_after_new_change(command, **kwargs):
                panel.mark_notification_pending(questions, state_dir=state_dir)
                return subprocess.CompletedProcess(
                    command, 0, json.dumps({"delivered_to": ["alpha"]}), ""
                )

            with patch.object(panel.bindings.subprocess, "run", side_effect=deliver_after_new_change):
                result = panel.send_pending_notification(
                    questions, binding, state_dir=state_dir,
                )

            self.assertEqual(result, (True, "delivered"))
            self.assertTrue(panel.notification_is_pending(questions, state_dir=state_dir))



class QuestionPlainTextTests(unittest.TestCase):
    """The turn-end hook shows ``question_plain_text`` after the controller's message."""

    def render(self, section):
        panel = load_module()
        text = f"## {section}\n\n答覆：\n\n- [ ] 送出\n"
        header, body = text.split("\n", 1)
        question = panel.parse_questions(f"{header}\nQ1 · r3 · 待答\n{body}")[0]
        return panel.question_plain_text(question)

    def test_single_select_with_details_multi_paragraph_options_and_emoji(self):
        section = (
            "**要不要** 合併 `dev`？\n\n"
            "審查已通過 ✅，只差 **合併**；見 [說明](https://example.com/a)。\n\n"
            "- A. 合併到 `dev`（建議）\n"
            "  本機會與 **dev** 一致。\n\n"
            "  - 推送前跑 `make test`\n"
            "  - 不改遠端\n"
            "- B. 先不合併\n"
            "  ```bash\n"
            "  echo **kept**\n"
            "  ```\n\n"
            "➡️ A：先讓 **本機** 一致 🚀。\n"
            "第二行理由。\n\n"
            "【詳細資訊】\n"
            "### 來由\n"
            "`dev` 是安裝來源。\n\n"
            "第二段。\n"
            "【詳細資訊結束】\n"
        )
        self.assertEqual(self.render(section), (
            "❓ Q1 r3 - 要不要 合併 dev？\n\n"
            "審查已通過 ✅，只差 合併；見 說明 (https://example.com/a)。\n\n"
            "A. 合併到 dev（建議）\n"
            "  本機會與 dev 一致。\n\n"
            "  - 推送前跑 make test\n"
            "  - 不改遠端\n"
            "B. 先不合併\n"
            "  echo **kept**\n\n"
            "➡️ A：先讓 本機 一致 🚀。\n"
            "第二行理由。\n\n"
            "【詳細資訊】\n"
            "來由\n"
            "dev 是安裝來源。\n\n"
            "第二段。\n"
            "【詳細資訊結束】"
        ))

    def test_multi_select_options_get_letters_and_a_hint(self):
        section = (
            "要裝哪些？\n\n背景。\n\n"
            "- [ ] Claude\n  主控用。\n"
            "- [ ] **Codex**\n"
        )
        self.assertEqual(self.render(section), (
            "❓ Q1 r3 - 要裝哪些？\n\n背景。\n\n"
            "（複選題，可選多項）\n"
            "A. Claude\n  主控用。\n"
            "B. Codex"
        ))

    def test_question_without_options_or_body_keeps_what_it_has(self):
        self.assertEqual(self.render("自由回答？\n\n寫下 `路徑`。\n"),
                         "❓ Q1 r3 - 自由回答？\n\n寫下 路徑。")
        panel = load_module()
        question = panel.parse_questions("## 只有標題\nQ2 · r1 · 待答\n")[0]
        self.assertEqual(panel.question_plain_text(question), "❓ Q2 r1 - 只有標題")

    def test_plain_markdown_drops_emphasis_but_keeps_code_and_ordinary_symbols(self):
        panel = load_module()
        cases = {
            "__重要__、*斜體*、~~舊方案~~、這是*強調*的": "重要、斜體、舊方案、這是強調的",
            "_底線_ 與 **粗體**": "底線 與 粗體",
            "`a*b*c` 與 `__init__`、snake_case_name、2*3*4": "a*b*c 與 __init__、snake_case_name、2*3*4",
            "* 清單項目\n- 另一項": "* 清單項目\n- 另一項",
            "```保留這段文字```": "保留這段文字",
            "``` `x` ```": "`x`",
            "*請執行 `make test` 再合併*": "請執行 make test 再合併",
            "__請確認 `dev`__ 與 **`a**b`**": "請確認 dev 與 a**b",
        }
        for text, plain in cases.items():
            with self.subTest(text=text):
                self.assertEqual(panel.plain_markdown(text), plain)

    def test_plain_markdown_fences_need_a_matching_closing_line(self):
        panel = load_module()
        self.assertEqual(
            panel.plain_markdown("````md\n```\n**內容**\n````\n**之後**"),
            "```\n**內容**\n之後")
        self.assertEqual(panel.plain_markdown("~~~\n`code`\n~~~\n`after`"), "`code`\nafter")

    def test_legacy_unlisted_options_render_like_listed_ones(self):
        self.assertEqual(
            self.render("舊格式？\n\n背景。\n\nA. 甲（建議）\n   影響甲\nB. 乙\n"),
            "❓ Q1 r3 - 舊格式？\n\n背景。\n\nA. 甲（建議）\n  影響甲\nB. 乙")

if __name__ == "__main__":
    unittest.main()
