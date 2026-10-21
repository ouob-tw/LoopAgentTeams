"""Question files under .lat/questions/ next to older root files; HCOM is stubbed, files are disposable."""
from datetime import datetime, timedelta, timezone
import json
import subprocess

from test_lat_panel_board import BoardTestCase, RECORDED, SINGLE, TEXT

PENDING = "# {id}: 題目\n\n- status: pending\n- advisor: needs-human\n- version: r{revision} (panel)\n"
LATER = datetime.now(timezone.utc) + timedelta(days=1)


class QuestionDirTestCase(BoardTestCase):
    def setUp(self):
        super().setUp()
        self.workspace = self.root / "project-q"
        self.lat = self.workspace / ".lat"
        self.legacy = self.lat / "questions-ctl.md"
        self.new = self.lat / "questions/ctl.md"
        self.decisions = self.root / "decisions"
        self.decisions.mkdir()
        # The setUp binding of ctl-a is not part of these scenarios.
        self.core.unbind_controller("s-a", config_dir=self.config)

    def bind_ctl(self, session):
        sessions = self.lat / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        (sessions / f"{session}.json").write_text(json.dumps({"decisions_path": str(self.decisions)}))
        binding, _, _ = self.core.bind_controller(
            "ctl", "claude", session, self.workspace, "ws-1", "tab", "pane", config_dir=self.config,
        )
        return binding["questions_path"]

    def decide(self, question_id, revision=1):
        (self.decisions / f"{question_id}.md").write_text(PENDING.format(id=question_id, revision=revision))

    def journal_bytes(self):
        return (self.lat / "panel-journal.jsonl").read_bytes()


class NewLocationTests(QuestionDirTestCase):
    def test_new_binding_writes_answers_and_journals_at_the_lat_root(self):
        self.assertEqual(self.bind_ctl("s-1"), str(self.new))
        self.decide("Q3")
        section = self.root / "section.md"
        section.write_text("## 還有什麼想法？\n\n請自由回答。\n")
        upsert = self.run_cli("question", "upsert", "--questions", self.new,
                              "--decisions", self.decisions, "--id", "Q3", "--file", section)
        self.assertEqual(upsert.returncode, 0, upsert.stderr)
        self.assertTrue(self.new.exists())
        self.assertTrue((self.lat / "questions/.ctl.md.lock").exists())
        self.assertFalse((self.lat / "questions/panel-journal.jsonl").exists())

        result = self.answer(self.new, "Q3", 1, "--text", "想法")

        self.assertTrue(result["recorded"])
        journal = [json.loads(line) for line in self.journal_bytes().decode().splitlines()]
        self.assertEqual({entry["questions_path"] for entry in journal}, {str(self.new)})
        self.assertIn(f"來源：面板，{self.lat / 'panel-journal.jsonl'}", (self.decisions / "Q3.md").read_text())
        [controller] = self.board("list")["controllers"]
        self.assertEqual(controller["questions_path"], str(self.new))
        [entry] = self.board("answered", "--questions", self.new)["files"]
        self.assertEqual([item["id"] for item in entry["questions"]], ["Q3"])
        self.assertIsNotNone(entry["questions"][0]["asked_at"])
        self.assertEqual(self.core.archive_recorded_questions(self.new, 0, now=LATER), ["Q3"])
        self.assertIn("Q3 · r1 · 已記錄", (self.lat / "questions/ctl-archive.md").read_text())

    def test_no_command_defaults_to_the_old_questions_md(self):
        for command in ("upsert", "set-status", "archive-recorded"):
            with self.subTest(command=command):
                result = self.run_cli("question", command)
                self.assertEqual(result.returncode, 2)
                self.assertIn("--questions", result.stderr)


class LegacyLocationTests(QuestionDirTestCase):
    def test_root_file_answers_record_archive_and_journal_stay_as_they_were(self):
        # Before the update: a controller bound to the root file; Q1 is submitted but could not
        # be recorded (no decision record yet), Q3 is answered and recorded.
        self.lat.mkdir(parents=True)
        self.legacy.write_text("\n".join((SINGLE, TEXT)))
        self.decide("Q3")
        self.assertEqual(self.bind_ctl("s-old"), str(self.legacy))
        self.assertFalse(self.answer(self.legacy, "Q1", 2, "--select", "1")["recorded"])
        self.assertTrue(self.answer(self.legacy, "Q3", 1, "--text", "想法")["recorded"])
        before = self.journal_bytes()
        self.core.unbind_controller("s-old", config_dir=self.config)

        # The same name keeps the root file while Q1 still waits to be recorded.
        self.assertEqual(self.bind_ctl("s-new"), str(self.legacy))
        self.decide("Q1", revision=2)
        [outcome] = self.core.record_submitted_answers(self.legacy, ["Q1"], config_dir=self.config)
        self.assertTrue(outcome["recorded"], outcome)
        record = (self.decisions / "Q1.md").read_text()
        source_line = int(record.split("panel-journal.jsonl 第 ")[1].split(" 行")[0])
        self.assertLessEqual(source_line, len(before.splitlines()))
        self.assertEqual(sorted(self.core.archive_recorded_questions(self.legacy, 0, now=LATER)), ["Q1", "Q3"])
        self.assertTrue(self.journal_bytes().startswith(before))

        # Once nothing waits in the root file, a new round of that name gets .lat/questions/.
        self.core.unbind_controller("s-new", config_dir=self.config)
        self.assertEqual(self.bind_ctl("s-next"), str(self.new))
        self.assertTrue(self.journal_bytes().startswith(before))

    def test_a_bound_session_keeps_its_file_for_the_rest_of_its_round(self):
        self.lat.mkdir(parents=True)
        self.legacy.write_text(SINGLE)
        self.assertEqual(self.bind_ctl("s-1"), str(self.legacy))
        self.legacy.write_text(RECORDED)

        self.assertEqual(self.bind_ctl("s-1"), str(self.legacy))
        self.assertEqual(self.bind_ctl("s-2"), str(self.new))

    def test_omission_check_sees_both_locations_and_their_archives(self):
        self.new.parent.mkdir(parents=True)
        self.legacy.write_text(SINGLE)
        self.new.write_text(TEXT)
        (self.lat / "questions/other-archive.md").write_text(RECORDED.replace("Q0", "Q8"))
        for question_id in ("Q1", "Q3", "Q8", "Q9"):
            self.decide(question_id)

        present, missing, inconsistent, _, _ = self.core.pending_question_gaps(self.new, self.decisions)

        self.assertEqual(present, [("Q1", self.legacy), ("Q3", self.new)])
        self.assertEqual(missing, ["Q9"])
        self.assertEqual(inconsistent, [("Q8", "問題已歸檔", self.lat / "questions/other-archive.md")])


class WorktreeTests(QuestionDirTestCase):
    def setUp(self):
        super().setUp()
        self.main = self.root / "main"
        self.main.mkdir()
        git = ["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.hooksPath=/dev/null"]
        subprocess.run([*git, "init", "-q", self.main], check=True)
        subprocess.run([*git, "-C", self.main, "commit", "-q", "--allow-empty", "-m", "init"], check=True)
        self.workspace = self.root / "wt"
        subprocess.run([*git, "-C", self.main, "worktree", "add", "-q", self.workspace], check=True)
        self.lat = self.main.resolve() / ".lat"
        self.new = self.lat / "questions/ctl.md"

    def test_worktree_controller_files_and_records_are_in_the_main_checkouts_lat(self):
        self.assertEqual(self.bind_ctl("s-1"), str(self.new))
        self.decide("Q3")
        self.new.parent.mkdir(parents=True)
        self.new.write_text(TEXT)

        self.assertTrue(self.answer(self.new, "Q3", 1, "--text", "想法")["recorded"])
        self.assertIn(f"來源：面板，{self.lat / 'panel-journal.jsonl'}", (self.decisions / "Q3.md").read_text())

    def test_omission_check_sees_a_worktrees_own_root_files_and_the_shared_ones(self):
        legacy = self.workspace / ".lat/questions-old.md"
        legacy.parent.mkdir()
        legacy.write_text(SINGLE)
        self.new.parent.mkdir(parents=True)
        self.new.write_text(TEXT)
        for question_id in ("Q1", "Q3"):
            self.decide(question_id)

        for questions in (legacy, self.new):
            with self.subTest(questions=questions):
                present, missing, _, _, _ = self.core.pending_question_gaps(questions, self.decisions)
                self.assertEqual(sorted(present), [("Q1", legacy.resolve()), ("Q3", self.new)])
                self.assertEqual(missing, [])


class MixedBoardTests(QuestionDirTestCase):
    def test_processed_list_reads_both_files_of_a_name(self):
        self.new.parent.mkdir(parents=True)
        self.legacy.with_name("questions-ctl-archive.md").write_text(RECORDED)
        self.new.write_text(RECORDED.replace("Q0", "Q5"))
        workspace = str(self.workspace)

        by_name, by_path = self.board(
            "answered", f"--workspace={workspace}", "--hcom-name=ctl", f"--questions={self.new}",
        )["files"][::-1]

        self.assertEqual(by_name["questions_path"], str(self.new))
        for entry in (by_name, by_path):
            self.assertEqual([item["id"] for item in entry["questions"]], ["Q0", "Q5"])


class DeactivateCleanupTests(QuestionDirTestCase):
    def test_empty_file_is_deleted_but_its_archive_and_lock_stay(self):
        self.assertEqual(self.bind_ctl("s-1"), str(self.new))
        self.decide("Q3")
        section = self.root / "section.md"
        section.write_text("## 還有什麼想法？\n\n請自由回答。\n")
        self.assertEqual(self.run_cli("question", "upsert", "--questions", self.new, "--decisions",
                                      self.decisions, "--id", "Q3", "--file", section).returncode, 0)
        self.assertTrue(self.answer(self.new, "Q3", 1, "--text", "想法")["recorded"])

        self.assertTrue(self.core.remove_empty_questions(self.new, self.decisions))

        self.assertFalse(self.new.exists())
        self.assertIn("Q3 · r1 · 已記錄", (self.lat / "questions/ctl-archive.md").read_text())
        self.assertTrue((self.lat / "questions/.ctl.md.lock").exists())
        self.assertFalse(self.core.remove_empty_questions(self.new, self.decisions))

    def test_waiting_or_submitted_questions_keep_the_file(self):
        self.new.parent.mkdir(parents=True)
        self.decide("Q1", revision=2)
        submitted = SINGLE.replace("答覆：\n\n- [ ] 送出", "答覆：A\n\n- [x] 送出")
        for text in (SINGLE, submitted):
            with self.subTest(submitted=text is submitted):
                self.new.write_text(text)
                self.assertFalse(self.core.remove_empty_questions(self.new, self.decisions))
                self.assertEqual(self.new.read_text(), text)
