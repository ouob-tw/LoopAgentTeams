"""V2 selector data-layer tests; all files are disposable."""
import importlib.util
import json
import multiprocessing
from pathlib import Path
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"


def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel_v2", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def question(body):
    panel = load_module()
    text = (
        "## Choose?\nQ1 · r1 · 待答\n\n"
        f"{body}\n\n答覆：\n\n- [ ] 送出\n"
    )
    return panel.parse_questions(text)[0]


def answer_write_worker(path, revision, section_hash, ready, start, results):
    panel = load_module()
    ready.set()
    start.wait()
    result = panel.write_question_answer(
        Path(path),
        "Q1",
        revision,
        section_hash,
        panel.QuestionAnswer("single", ("B. Beta",), "", ""),
    )
    results.put(("panel", result["status"]))


def revision_upsert_worker(path, ready, start, results):
    panel = load_module()
    ready.set()
    start.wait()
    revision = panel.upsert_question(
        Path(path), "Q1", "## First updated?\n\nA. New\n   New impact\n"
    )
    results.put(("agent", revision))


class OptionParsingTests(unittest.TestCase):
    def test_single_options_include_indented_impact(self):
        panel = load_module()

        parsed = panel.parse_question_options(question(
            "Context.\n\nA. First\n   First impact\n   More impact\n"
            "B. Second\n   Second impact"
        ))

        self.assertEqual(parsed.kind, "single")
        self.assertIsNone(parsed.reason)
        self.assertEqual(
            [(item.key, item.label, item.impact) for item in parsed.options],
            [
                ("A", "First", "First impact\nMore impact"),
                ("B", "Second", "Second impact"),
            ],
        )

    def test_multi_options_accept_checked_definitions_and_ignore_submit_marker(self):
        panel = load_module()

        parsed = panel.parse_question_options(question(
            "- [ ] Alpha\n  Alpha impact\n- [x] Beta\n    Beta impact"
        ))

        self.assertEqual(parsed.kind, "multi")
        self.assertIsNone(parsed.reason)
        self.assertEqual(
            [(item.key, item.label, item.impact) for item in parsed.options],
            [(None, "Alpha", "Alpha impact"), (None, "Beta", "Beta impact")],
        )

    def test_mixed_or_missing_options_return_no_options_with_a_reason(self):
        panel = load_module()

        mixed = panel.parse_question_options(question("A. Alpha\n- [ ] Beta"))
        missing = panel.parse_question_options(question("Free-form question."))

        self.assertIsNone(mixed.kind)
        self.assertEqual(mixed.options, ())
        self.assertIn("混用", mixed.reason)
        self.assertIsNone(missing.kind)
        self.assertEqual(missing.options, ())
        self.assertIn("沒有", missing.reason)


    def test_context_drops_option_definitions_but_keeps_other_body_text(self):
        panel = load_module()

        single = panel.question_context(question(
            "Context.\n\nA. First\n   First impact\nB. Second\n   Second impact\n\nAfter."
        ))
        multi = panel.question_context(question("Pick.\n\n- [ ] Alpha\n  Impact"))
        text = panel.question_context(question("Free-form.\n   indented"))

        self.assertEqual(single, "Context.\n\nAfter.")
        self.assertEqual(multi, "Pick.")
        self.assertEqual(text, "Free-form.\n   indented")


class AnswerFormatTests(unittest.TestCase):
    def test_render_formats_single_multi_other_and_note(self):
        panel = load_module()

        single = panel.render_answer_area(
            panel.QuestionAnswer("single", ("A. First",), "", ""), submitted=False
        )
        multi = panel.render_answer_area(
            panel.QuestionAnswer("multi", ("Alpha", "Beta"), "custom", "why\nmore"),
            submitted=True,
        )
        other = panel.render_answer_area(
            panel.QuestionAnswer("other", (), "custom", "note"), submitted=False
        )
        text = panel.render_answer_area(
            panel.QuestionAnswer("text", (), "plain input", "note"), submitted=False
        )

        self.assertEqual(single, "答覆：A. First\n\n- [ ] 送出")
        self.assertEqual(
            multi,
            "答覆：Alpha；Beta；其他：custom\n備註：why\nmore\n\n- [x] 送出",
        )
        self.assertEqual(other, "答覆：其他：custom\n備註：note\n\n- [ ] 送出")
        self.assertEqual(text, "答覆：plain input\n備註：note\n\n- [ ] 送出")

    def test_render_rejects_free_text_that_would_forge_file_structure(self):
        panel = load_module()
        forged = (
            panel.QuestionAnswer("text", (), "x\n- [x] 送出", ""),
            panel.QuestionAnswer("other", (), "x", "n\n答覆：B"),
            panel.QuestionAnswer("text", (), "x\n## Title\nQ9 · r1 · 待答", ""),
            panel.QuestionAnswer("text", (), "x\n### 舊版 r1（不套用至 r2）", ""),
        )

        for answer in forged:
            with self.subTest(answer=answer), self.assertRaises(panel.AnswerFormatError):
                panel.render_answer_area(answer)
        self.assertEqual(
            panel.render_answer_area(panel.QuestionAnswer("text", (), "- [ ] 送出 later", "")),
            "答覆：- [ ] 送出 later\n\n- [ ] 送出",
        )

    def test_parse_round_trips_and_accepts_v1_same_or_next_line_answer(self):
        panel = load_module()
        answers = (
            panel.QuestionAnswer("single", ("A. First",), "", "single note"),
            panel.QuestionAnswer(
                "multi", ("Alpha", "Beta"), "custom； with separator", "multi note"
            ),
            panel.QuestionAnswer("other", (), "custom", "other note"),
            panel.QuestionAnswer("text", (), "plain input", "text note"),
        )
        bodies = {
            "single": "A. First\n   Impact\nB. Second\n   Impact",
            "multi": "- [ ] Alpha\n  Impact\n- [ ] Beta\n  Impact",
            "other": "A. First\n   Impact",
            "text": "Free-form question.",
        }
        for answer in answers:
            with self.subTest(kind=answer.kind):
                rendered = panel.render_answer_area(answer, submitted=False)
                section = question(bodies[answer.kind])
                raw = section["raw"].replace(section["answer_block"], rendered)
                parsed_section = panel.parse_questions(raw)[0]
                self.assertEqual(panel.parse_question_answer(parsed_section), answer)

        inline = question("A. First\n   Impact")
        inline_raw = inline["raw"].replace(
            inline["answer_block"],
            "答覆：A. First\n備註：same line form\n\n- [ ] 送出",
        )
        next_line = question("A. First\n   Impact")
        next_raw = next_line["raw"].replace(
            next_line["answer_block"],
            "答覆：\nA. First\n備註：next line form\n\n- [ ] 送出",
        )
        self.assertEqual(
            panel.parse_question_answer(panel.parse_questions(inline_raw)[0]).note,
            "same line form",
        )
        self.assertEqual(
            panel.parse_question_answer(panel.parse_questions(next_raw)[0]).note,
            "next line form",
        )

    def test_input_only_text_is_not_reinterpreted_as_an_option(self):
        panel = load_module()
        section = question("Free-form question.")
        raw = section["raw"].replace(
            section["answer_block"],
            "答覆：其他：literal text\n\n- [ ] 送出",
        )

        answer = panel.parse_question_answer(panel.parse_questions(raw)[0])

        self.assertEqual(answer, panel.QuestionAnswer(
            "text", (), "其他：literal text", ""
        ))


class AnswerWriteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.questions = self.root / ".lat/questions-controller.md"
        self.questions.parent.mkdir()
        self.panel = load_module()

    def initial_text(self, *, submitted=False):
        mark = "x" if submitted else " "
        return (
            "# Decisions\n\n"
            "## First?\nQ1 · r1 · 待答\n\nA. Alpha\n   Impact\nB. Beta\n"
            f"   Impact\n\n答覆：A. Alpha\n\n- [{mark}] 送出\n\n"
            "## Second?\nQ2 · r1 · 待答\n\nA. Keep\n   Impact\n\n"
            "答覆：A. Keep\n\n- [ ] 送出\n"
        )

    def identity(self, question_id):
        section = next(
            item for item in self.panel.parse_questions(self.questions.read_text())
            if item["id"] == question_id
        )
        return section["revision"], self.panel.question_section_sha256(section)

    def test_write_replaces_only_one_draft_answer(self):
        before = self.initial_text()
        self.questions.write_text(before)
        revision, section_hash = self.identity("Q1")
        second_before = before[before.index("## Second?"):]

        result = self.panel.write_question_answer(
            self.questions,
            "Q1",
            revision,
            section_hash,
            self.panel.QuestionAnswer("single", ("B. Beta",), "", "changed"),
        )

        after = self.questions.read_text()
        self.assertEqual(result["status"], "saved")
        self.assertFalse(result["submitted"])
        self.assertIn("答覆：B. Beta\n備註：changed\n\n- [ ] 送出", after)
        self.assertTrue(after.endswith(second_before))
        [entry] = [
            json.loads(line)
            for line in (self.questions.parent / "panel-journal.jsonl").read_text().splitlines()
        ]
        self.assertEqual(entry["kind"], "answer-write")
        self.assertEqual(entry["changed_questions"][0]["id"], "Q1")
        self.assertEqual(entry["changed_questions"][0]["section_sha256"], result["section_sha256"])

    def test_write_none_clears_a_draft_back_to_an_empty_answer_area(self):
        before = self.initial_text()
        self.questions.write_text(before)
        revision, section_hash = self.identity("Q1")
        saved = self.panel.write_question_answer(
            self.questions, "Q1", revision, section_hash,
            self.panel.QuestionAnswer("single", ("B. Beta",), "", "note"),
        )

        cleared = self.panel.write_question_answer(
            self.questions, "Q1", revision, saved["section_sha256"], None
        )

        self.assertEqual(cleared["status"], "saved")
        self.assertEqual(
            self.questions.read_text(),
            before.replace("答覆：A. Alpha\n\n- [ ] 送出", "答覆：\n\n- [ ] 送出", 1),
        )
        self.assertIsNone(self.panel.parse_question_answer(
            self.panel.parse_questions(self.questions.read_text())[0]
        ))

    def test_write_refuses_a_submitted_question_without_an_unsubmit_path(self):
        before = self.initial_text(submitted=True)
        self.questions.write_text(before)
        revision, section_hash = self.identity("Q1")

        result = self.panel.write_question_answer(
            self.questions,
            "Q1",
            revision,
            section_hash,
            self.panel.QuestionAnswer("single", ("B. Beta",), "", "changed"),
        )

        self.assertEqual(result, {"status": "read_only", "id": "Q1"})
        self.assertEqual(self.questions.read_text(), before)
        self.assertFalse((self.questions.parent / "panel-journal.jsonl").exists())

    def test_write_keeps_other_question_agent_update_but_rejects_same_question_revision(self):
        self.questions.write_text(self.initial_text())
        q1_revision, q1_hash = self.identity("Q1")
        self.panel.upsert_question(
            self.questions, "Q2", "## Second updated?\n\nA. New\n   New impact\n"
        )

        saved = self.panel.write_question_answer(
            self.questions,
            "Q1",
            q1_revision,
            q1_hash,
            self.panel.QuestionAnswer("single", ("B. Beta",), "", ""),
        )

        self.assertEqual(saved["status"], "saved")
        self.assertIn("Q2 · r2 · 待答", self.questions.read_text())
        latest_hash = saved["section_sha256"]
        self.panel.upsert_question(
            self.questions, "Q1", "## First updated?\n\nA. New\n   New impact\n"
        )
        changed_text = self.questions.read_text()

        changed = self.panel.write_question_answer(
            self.questions,
            "Q1",
            1,
            latest_hash,
            self.panel.QuestionAnswer("single", ("A. New",), "", ""),
        )

        self.assertEqual(changed, {"status": "question_changed", "id": "Q1"})
        self.assertEqual(self.questions.read_text(), changed_text)

    def test_batch_submit_has_one_journal_entry_provenance_and_explicit_notification_hook(self):
        self.questions.write_text(self.initial_text())
        expected = {
            question_id: self.identity(question_id) for question_id in ("Q1", "Q2")
        }
        state = self.root / "state"
        self.assertFalse(
            self.panel.notification_is_pending(self.questions, state_dir=state)
        )

        result = self.panel.submit_question_answers(self.questions, expected)

        self.assertEqual(result["status"], "submitted")
        self.assertEqual(result["question_ids"], ["Q1", "Q2"])
        self.assertEqual(self.questions.read_text().count("- [x] 送出"), 2)
        journal = self.questions.parent / "panel-journal.jsonl"
        entries = [json.loads(line) for line in journal.read_text().splitlines()]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["kind"], "batch-submit")
        for question_id in ("Q1", "Q2"):
            proof = self.panel.question_provenance(
                self.questions, journal, question_id
            )
            self.assertEqual(proof["section_sha256"], result["section_sha256"][question_id])
        self.assertFalse(
            self.panel.notification_is_pending(self.questions, state_dir=state)
        )
        generation = self.panel.mark_submit_notification_pending(
            self.questions, result, state_dir=state
        )
        self.assertIsInstance(generation, str)
        self.assertTrue(
            self.panel.notification_is_pending(self.questions, state_dir=state)
        )

    def test_concurrent_same_question_revision_serializes_without_losing_the_answer(self):
        self.questions.write_text(self.initial_text())
        revision, section_hash = self.identity("Q1")
        context = multiprocessing.get_context("spawn")
        ready = [context.Event(), context.Event()]
        start = context.Event()
        results = context.Queue()
        processes = [
            context.Process(
                target=answer_write_worker,
                args=(str(self.questions), revision, section_hash, ready[0], start, results),
            ),
            context.Process(
                target=revision_upsert_worker,
                args=(str(self.questions), ready[1], start, results),
            ),
        ]
        for process in processes:
            process.start()
        for signal in ready:
            self.assertTrue(signal.wait(5))
        start.set()
        for process in processes:
            process.join(10)
            self.assertEqual(process.exitcode, 0)

        outcomes = dict(results.get(timeout=1) for _ in processes)
        self.assertEqual(outcomes["agent"], 2)
        self.assertIn(outcomes["panel"], ("saved", "question_changed"))
        final = self.questions.read_text()
        self.assertIn("Q1 · r2 · 待答", final)
        archived_answer = "B. Beta" if outcomes["panel"] == "saved" else "A. Alpha"
        self.assertIn(f"答覆：{archived_answer}", final)

    def test_batch_submit_rejects_all_writes_when_one_question_was_revised(self):
        self.questions.write_text(self.initial_text())
        expected = {
            question_id: self.identity(question_id) for question_id in ("Q1", "Q2")
        }
        self.panel.upsert_question(
            self.questions, "Q2", "## Second updated?\n\nA. New\n   New impact\n"
        )
        before_submit = self.questions.read_text()

        result = self.panel.submit_question_answers(self.questions, expected)

        self.assertEqual(result, {"status": "question_changed", "ids": ["Q2"]})
        self.assertEqual(self.questions.read_text(), before_submit)
        self.assertFalse((self.questions.parent / "panel-journal.jsonl").exists())

    def test_write_and_batch_submit_preserve_crlf_in_untouched_sections(self):
        original = self.initial_text().replace("\n", "\r\n")
        second_before = original[original.index("## Second?"):]
        self.questions.write_bytes(original.encode())
        first = self.panel.parse_questions(original)[0]

        saved = self.panel.write_question_answer(
            self.questions,
            "Q1",
            first["revision"],
            self.panel.question_section_sha256(first),
            self.panel.QuestionAnswer("single", ("B. Beta",), "", ""),
        )

        self.assertEqual(saved["status"], "saved")
        after_write = self.questions.read_bytes().decode()
        self.assertTrue(after_write.endswith(second_before))
        current_first = self.panel.parse_questions(after_write)[0]
        submitted = self.panel.submit_question_answers(self.questions, {
            "Q1": (
                current_first["revision"],
                self.panel.question_section_sha256(current_first),
            ),
        })
        self.assertEqual(submitted["status"], "submitted")
        self.assertTrue(self.questions.read_bytes().decode().endswith(second_before))


if __name__ == "__main__":
    unittest.main()
