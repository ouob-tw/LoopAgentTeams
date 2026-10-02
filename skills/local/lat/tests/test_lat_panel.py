"""LAT panel core contract tests; all files and processes are disposable."""
import importlib.util
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"


def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def race_replace(path, expected, replacement, start, results):
    panel = load_module()
    start.wait()
    results.put(panel.locked_replace(Path(path), expected, replacement))


class LockedReplaceTests(unittest.TestCase):
    def test_only_one_racing_writer_can_replace_the_expected_content(self):
        panel = load_module()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "questions.md"
            path.write_text("before")
            path.chmod(0o640)
            context = multiprocessing.get_context("spawn")
            start = context.Event()
            results = context.Queue()
            processes = [
                context.Process(
                    target=race_replace,
                    args=(str(path), "before", replacement, start, results),
                )
                for replacement in ("first", "second")
            ]
            for process in processes:
                process.start()
            start.set()
            for process in processes:
                process.join(10)
                self.assertEqual(process.exitcode, 0)

            self.assertEqual(sorted(results.get(timeout=1) for _ in processes), [False, True])
            self.assertIn(path.read_text(), {"first", "second"})
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

    def test_set_status_refuses_revision_mismatch_then_updates_only_the_header(self):
        original = (
            "Intro\n\n## Q1 | r2 | ready\n問題：Question\n選項：A\n建議：Advice\n"
            "影響：Impact\n答覆：Answer\n批註：Note\n"
        )
        self.questions.write_text(original)

        mismatch = self.cli(
            "question", "set-status", "--id", "Q1", "--revision", "1",
            "--status", "recorded",
        )
        self.assertNotEqual(mismatch.returncode, 0)
        self.assertIn("revision mismatch", mismatch.stderr)
        self.assertEqual(self.questions.read_text(), original)

        result = self.cli(
            "question", "set-status", "--id", "Q1", "--revision", "2",
            "--status", "recorded",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            self.questions.read_text(),
            original.replace("## Q1 | r2 | ready", "## Q1 | r2 | recorded"),
        )

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


class NotificationTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
