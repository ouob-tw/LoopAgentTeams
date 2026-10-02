"""LAT panel core contract tests; all files and processes are disposable."""
import importlib.util
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
    results.put(("agent", panel.upsert_question(Path(path), "Q1", section_text)))


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


class QuestionCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.questions = self.root / ".lat/questions.md"
        self.questions.parent.mkdir()

    def cli(self, *args):
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True,
            capture_output=True,
            env=dict(os.environ),
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
        self.assertEqual(
            self.questions.read_text(),
            original.replace("Q1 · r2 · 待答", "Q1 · r2 · 已記錄"),
        )

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
            "--journal", self.questions.parent / "panel-journal.jsonl", "--id", "Q1",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        proof = json.loads(result.stdout)
        self.assertEqual(proof["status"], "ok")
        self.assertEqual(proof["id"], "Q1")
        self.assertEqual(proof["journal_line"], 2)
        self.assertRegex(proof["time"], r"^\d{4}-\d\d-\d\dT.*Z$")
        self.assertEqual(
            proof["section_sha256"],
            hashlib.sha256(answered.split("\n\n## Other?", 1)[0].encode() + b"\n").hexdigest(),
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

    def bind(self, name, session, workspace, herdr_workspace):
        return self.cli(
            "bind", "--hcom-name", name, "--client", "codex",
            "--session-id", session, "--workspace", workspace,
            "--herdr-workspace", herdr_workspace,
        )

    def test_binding_resolution_replacement_and_session_scoped_unbind(self):
        first = self.bind("alpha", "s1", self.first, "herdr-1")
        second = self.bind("beta", "s2", self.second, "herdr-2")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(second.returncode, 0, second.stderr)

        exact = self.cli("resolve", "--herdr-workspace", "herdr-1")
        self.assertEqual(json.loads(exact.stdout)["hcom_name"], "alpha")
        ambiguous = self.cli("resolve", "--herdr-workspace", "missing")
        self.assertNotEqual(ambiguous.returncode, 0)
        self.assertIn("no LAT controller is bound", ambiguous.stderr)

        self.assertEqual(self.cli("unbind", "--session-id", "s2").returncode, 0)
        fallback = self.cli("resolve", "--herdr-workspace", "missing")
        self.assertEqual(json.loads(fallback.stdout)["hcom_name"], "alpha")

        replaced = self.bind("gamma", "s3", self.second, "herdr-1")
        payload = json.loads(replaced.stdout)
        self.assertEqual(payload["replaced"]["hcom_name"], "alpha")
        self.assertEqual(
            payload["binding"]["questions_path"],
            str(self.second / ".lat/questions.md"),
        )
        self.assertEqual(self.cli("unbind", "--session-id", "s1").returncode, 0)
        self.assertEqual(
            json.loads(self.cli("resolve", "--herdr-workspace", "herdr-1").stdout)["hcom_name"],
            "gamma",
        )


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
                    with patch.object(panel.subprocess, "run", return_value=receipt):
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

            with patch.object(panel.subprocess, "run", side_effect=deliver_after_new_change):
                result = panel.send_pending_notification(
                    questions, binding, state_dir=state_dir,
                )

            self.assertEqual(result, (True, "delivered"))
            self.assertTrue(panel.notification_is_pending(questions, state_dir=state_dir))


if __name__ == "__main__":
    unittest.main()
