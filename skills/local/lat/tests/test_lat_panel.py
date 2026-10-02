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
            "## Q1 | r1 | pending\n問題：Choose\n選項：A\n建議：Old\n影響：Impact\n"
            "答覆：Draft\n批註：Note\n\n"
            "## Q2 | r1 | pending\n問題：Keep\n選項：Yes\n建議：\n影響：\n答覆：\n批註：\n"
        )
        panel_text = before.replace("pending", "ready", 1).replace(
            "答覆：Draft", "答覆：Panel answer", 1
        )
        section = (
            "## Q1 | r1 | pending\n問題：Choose\n選項：A\n建議：Agent advice\n"
            "影響：Impact\n答覆：\n批註：\n"
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
                self.assertEqual(outcomes["agent"], 1)
                self.assertEqual(outcomes["panel"], preferred == "panel")
                final = path.read_text()
                self.assertIn("建議：Agent advice", final)
                expected_answer = "Panel answer" if preferred == "panel" else "Draft"
                self.assertIn(f"答覆：{expected_answer}", final)
                self.assertIn("## Q2 | r1 | pending", final)
                self.assertEqual(path.stat().st_mode & 0o777, 0o640)

    def test_successful_panel_save_appends_a_journal_entry_but_conflict_does_not(self):
        panel = load_module()
        before = (
            "## Q1 | r1 | pending\n問題：Q\n選項：A\n建議：\n影響：\n"
            "答覆：\n批註：\n"
        )
        after = before.replace("pending", "ready").replace("答覆：", "答覆：A")
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
            "## Q2 | r3 | pending\n問題：Keep?\n選項：Yes\n建議：Keep\n"
            "影響：Keep\n答覆：\n批註：untouched\n"
        )
        self.questions.write_text(
            "# Pending decisions\n\n"
            "## Q1 | r1 | ready\n問題：Old question\n選項：A\n建議：Old advice\n"
            "影響：Old impact\n答覆：Choose A\n批註：User note\n\n" + other
        )
        section = self.root / "section.md"
        section.write_text(
            "## Q1 | r1 | pending\n問題：New question\n選項：A or B\n建議：New advice\n"
            "影響：New impact\n答覆：agent must not supply this\n批註：agent note\n"
        )

        result = self.cli(
            "question", "upsert", "--id", "Q1", "--file", section,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.questions.read_text()
        self.assertTrue(text.startswith("# Pending decisions\n\n"))
        self.assertIn("## Q1 | r2 | pending", text)
        self.assertIn("問題：New question", text)
        self.assertIn("答覆：\n批註：\n", text)
        self.assertIn("舊版 r1（不套用至 r2）", text)
        self.assertIn("答覆：Choose A", text)
        self.assertIn("批註：User note", text)
        self.assertNotIn("agent must not supply this", text)
        self.assertNotIn("agent note", text)
        self.assertTrue(text.endswith(other))

    def test_set_status_refuses_revision_or_section_mismatch_then_updates_only_the_header(self):
        original = (
            "Intro\n\n## Q1 | r2 | ready\n問題：Question\n選項：A\n建議：Advice\n"
            "影響：Impact\n答覆：Answer\n批註：Note\n"
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
            original.replace("## Q1 | r2 | ready", "## Q1 | r2 | recorded"),
        )

    def test_provenance_survives_an_agent_upsert_to_another_question(self):
        before = (
            "## Q1 | r1 | pending\n問題：Choose\n選項：A\n建議：\n影響：\n"
            "答覆：\n批註：\n\n"
            "## Q2 | r1 | pending\n問題：Other\n選項：B\n建議：Old\n影響：\n"
            "答覆：\n批註：\n"
        )
        answered = before.replace("## Q1 | r1 | pending", "## Q1 | r1 | ready").replace(
            "答覆：\n批註：", "答覆：A\n批註：", 1
        )
        self.questions.write_text(before)
        panel = load_module()
        self.assertTrue(panel.save_panel_edit(self.questions, before, answered))
        section = self.root / "section.md"
        section.write_text(
            "## Q2 | r1 | pending\n問題：Other\n選項：B\n建議：New\n影響：\n"
            "答覆：\n批註：\n"
        )
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
        self.assertEqual(
            proof["journal_path"], str(self.questions.parent / "panel-journal.jsonl")
        )
        self.assertEqual(proof["journal_line"], 1)
        self.assertRegex(proof["time"], r"^\d{4}-\d\d-\d\dT.*Z$")
        self.assertEqual(
            proof["section_sha256"],
            hashlib.sha256(
                answered.split("\n\n## Q2", 1)[0].encode() + b"\n"
            ).hexdigest(),
        )

    def test_provenance_refuses_legacy_entry_without_a_section_hash(self):
        section = (
            "## Q1 | r1 | ready\n問題：Choose\n選項：A\n建議：\n影響：\n"
            "答覆：A\n批註：\n"
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
            "## Q1 | r1 | ready\n問題：Choose\n選項：A\n建議：\n影響：\n"
            "答覆：A\n批註：\n"
        )
        self.questions.write_text(original)
        expected_hash = hashlib.sha256(original.encode()).hexdigest()
        edited = original.replace("答覆：A", "答覆：B")
        self.questions.write_text(edited)

        result = self.cli(
            "question", "set-status", "--id", "Q1", "--revision", "1",
            "--status", "recorded", "--expected-section-sha256", expected_hash,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("section hash mismatch", result.stderr)
        self.assertEqual(self.questions.read_text(), edited)

    def test_upsert_without_question_change_keeps_revision_status_answer_and_annotation(self):
        self.questions.write_text(
            "## Q1 | r4 | ready\n問題：Same\n選項：A\n建議：Old\n影響：Old\n"
            "答覆：User answer\n批註：User note\n"
        )
        section = self.root / "section.md"
        section.write_text(
            "## Q1 | r1 | pending\n問題：Same\n選項：A\n建議：New\n影響：New\n"
            "答覆：Agent answer\n批註：Agent note\n"
        )
        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.questions.read_text(),
            "## Q1 | r4 | ready\n問題：Same\n選項：A\n建議：New\n影響：New\n"
            "答覆：User answer\n批註：User note\n",
        )

    def test_repeated_revision_does_not_apply_an_older_answer_to_the_intermediate_revision(self):
        self.questions.write_text(
            "## Q1 | r1 | ready\n問題：First\n選項：A\n建議：\n影響：\n"
            "答覆：Original answer\n批註：Original note\n"
        )
        section = self.root / "section.md"
        for question in ("Second", "Third"):
            section.write_text(
                f"## Q1 | r1 | pending\n問題：{question}\n選項：A\n建議：\n影響：\n"
                "答覆：\n批註：\n"
            )
            result = self.cli("question", "upsert", "--id", "Q1", "--file", section)
            self.assertEqual(result.returncode, 0, result.stderr)

        text = self.questions.read_text()
        self.assertIn("### 舊版 r2（不套用至 r3）\n答覆：\n批註：", text)
        self.assertEqual(text.count("答覆：Original answer"), 1)
        self.assertEqual(text.count("批註：Original note"), 1)

    def test_question_update_archives_markdown_headings_in_answer_and_annotation(self):
        original_answer = "A\n### Reason\nKeep this explanation"
        original_note = "Note\n### 使用者補充\nDo not remove this block"
        self.questions.write_text(
            "## Q1 | r2 | ready\n問題：Same\n選項：A or B\n建議：Old\n影響：Old\n"
            f"答覆：{original_answer}\n批註：{original_note}\n"
        )
        section = self.root / "section.md"
        section.write_text(
            "## Q1 | r1 | pending\n問題：Changed\n選項：A or B\n建議：New\n影響：New\n"
            "答覆：\n批註：\n"
        )

        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)

        self.assertEqual(result.returncode, 0, result.stderr)
        text = self.questions.read_text()
        self.assertIn("### 舊版 r2（不套用至 r3）", text)
        self.assertIn(f"答覆：{original_answer}\n", text)
        self.assertIn(f"批註：{original_note}\n", text)

    def test_question_update_archives_field_like_lines_inside_the_user_answer(self):
        original_user_text = (
            "答覆：A\n建議：This line is part of the user answer\n"
            "問題：This line is also part of the answer\n批註：User note\n"
        )
        self.questions.write_text(
            "## Q1 | r1 | ready\n問題：Old\n選項：A\n建議：Agent advice\n影響：Impact\n"
            + original_user_text
        )
        section = self.root / "section.md"
        section.write_text(
            "## Q1 | r1 | pending\n問題：New\n選項：A\n建議：New advice\n影響：Impact\n"
            "答覆：\n批註：\n"
        )

        result = self.cli("question", "upsert", "--id", "Q1", "--file", section)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(original_user_text.rstrip("\n"), self.questions.read_text())

    def test_advice_update_after_revision_keeps_the_following_section_byte_identical(self):
        other = (
            "## Q2 | r1 | ready\n問題：Keep\n選項：Yes\n建議：Keep\n"
            "影響：Keep\n答覆：Answer\n批註：Note\n"
        )
        self.questions.write_text(
            "## Q1 | r1 | ready\n問題：Old\n選項：A\n建議：Old\n影響：Impact\n"
            "答覆：Answer\n批註：Note\n\n" + other
        )
        section = self.root / "section.md"
        section.write_text(
            "## Q1 | r1 | pending\n問題：New\n選項：A\n建議：First\n影響：Impact\n"
            "答覆：\n批註：\n"
        )
        self.assertEqual(
            self.cli("question", "upsert", "--id", "Q1", "--file", section).returncode,
            0,
        )
        section.write_text(section.read_text().replace("建議：First", "建議：Second"))

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
