"""Sidebar counts, notifications and help questions; herdr is always a fake."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"
SESSION = "11111111-1111-4111-8111-111111111111"
DECIDE_SECTION = "## 要合併嗎？\n\n背景。\n\nA. 合併（建議）\n   影響。\nB. 不合併\n   影響。\n"
HELP_SECTION = (
    "## 請登入測試帳號\n\n需要你登入一次。\n\n"
    "A. 已完成\n   主控接著驗證。\n\n➡️ A：登入後回覆即可。\n"
)


def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StatusDisplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / "work"
        self.decisions = self.root / "decisions"
        self.decisions.mkdir()
        (self.work / ".lat/sessions").mkdir(parents=True)
        (self.work / ".lat/sessions" / f"{SESSION}.json").write_text(json.dumps({
            "session_id": SESSION, "decisions_path": str(self.decisions),
        }))
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.log = self.root / "herdr.log"
        herdr = self.bin / "herdr"
        herdr.write_text(
            "#!/bin/sh\n"
            f"printf '%s\\037' \"$@\" >> {self.log}\n"
            f"printf '\\n' >> {self.log}\n"
            'case "$1 $2" in\n'
            '"plugin list") printf \'{"result":{"plugins":[{"plugin_id":"lat.panel",'
            '"enabled":%s}]}}\\n\' "${FAKE_PANEL_ENABLED:-true}" ;;\n'
            '"pane report-metadata") exit "${FAKE_REPORT_EXIT:-0}" ;;\n'
            '"notification show") printf \'{"result":{"type":"notification_show",'
            '"shown":false,"reason":"%s"}}\\n\' "${FAKE_NOTIFY_REASON:-shown}" ;;\n'
            "*) exit 91 ;;\n"
            "esac\n"
        )
        herdr.chmod(0o755)
        self.env = dict(
            os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
            HERDR_PLUGIN_CONFIG_DIR=str(self.root / "plugin-config"),
            HERDR_PLUGIN_STATE_DIR=str(self.root / "plugin-state"),
            HERDR_WORKSPACE_ID="w1",
        )
        bound = self.cli(
            "bind", "--hcom-name", "zono", "--client", "claude", "--session-id", SESSION,
            "--workspace", self.work, "--herdr-workspace", "w1", "--herdr-tab", "w1:t1",
            "--herdr-pane", "w1:p1",
        )
        self.assertEqual(bound.returncode, 0, bound.stderr)
        self.questions = Path(json.loads(bound.stdout)["binding"]["questions_path"])

    def cli(self, *args, **env):
        return subprocess.run(
            [sys.executable, str(MODULE), *map(str, args)],
            text=True, capture_output=True, env=dict(self.env, **env), cwd=self.root,
        )

    def calls(self):
        if not self.log.exists():
            return []
        return [line.split("\x1f")[:-1] for line in self.log.read_text().splitlines()]

    def decision(self, identifier, kind=None, status="pending"):
        lines = [f"# {identifier}", f"- status: {status}", "- advisor: needs-human"]
        if kind:
            lines.append(f"- kind: {kind}")
        (self.decisions / f"{identifier}.md").write_text("\n".join(lines) + "\n")

    def upsert(self, identifier, section, **env):
        path = self.root / f"{identifier}.section.md"
        path.write_text(section)
        return self.cli("question", "upsert", "--questions", self.questions,
                        "--decisions", self.decisions, "--id", identifier, "--file", path, **env)

    def displays(self):
        """Display arguments of each report-metadata call, in order."""
        result = []
        for call in self.calls():
            if call[:2] != ["pane", "report-metadata"]:
                continue
            self.assertEqual(call[2:5], ["w1:p1", "--source", "lat.panel.status"])
            self.assertEqual(call[5], "--seq")
            int(call[6])
            result.append(call[7:])
        return result

    def notifications(self):
        return [call[2:] for call in self.calls() if call[:2] == ["notification", "show"]]

    def test_new_question_and_revision_show_counts_and_notify_once_each(self):
        self.decision("D1")
        self.assertEqual(self.upsert("D1", DECIDE_SECTION).stdout, "D1 r1\n")
        self.decision("H1", kind="help")
        self.assertEqual(self.upsert("H1", HELP_SECTION).returncode, 0)
        self.assertEqual(self.displays(), [["--display-agent", "zono ⚠待答1"],
                                           ["--display-agent", "zono ⚠待答1求助1"]])
        self.assertEqual(self.notifications(), [["zono ⚠待答1", "--sound", "none"],
                                                ["zono ⚠待答1求助1", "--sound", "none"]])
        # Same content: the sidebar is refreshed but no new notification.
        self.assertEqual(self.upsert("D1", DECIDE_SECTION).stdout, "D1 r1\n")
        self.assertEqual(len(self.notifications()), 2)
        self.assertEqual(self.displays()[-1], ["--display-agent", "zono ⚠待答1求助1"])
        self.assertEqual(self.upsert("D1", DECIDE_SECTION + "\n補充。\n").stdout, "D1 r2\n")
        self.assertEqual(len(self.notifications()), 3)

    def test_status_text_uses_the_short_name_and_leaves_out_zero_counts(self):
        panel = load_module()
        for name, decide, help_count, text in (
                ("zono-qa-kave-claude-tene", 1, 0, "tene ⚠待答1"),
                ("team-task-orch", 0, 2, "orch ⚠求助2"),
                ("zono", 1, 2, "zono ⚠待答1求助2"),
                ("zono-impl-sezo", 0, 0, "")):
            with self.subTest(name=name):
                self.assertEqual(panel.status_text(name, decide, help_count), text)

    def test_only_help_waiting_shows_the_help_count_alone(self):
        self.decision("H1", kind="help")
        self.upsert("H1", HELP_SECTION)
        self.assertEqual(self.displays(), [["--display-agent", "zono ⚠求助1"]])
        self.assertEqual(self.notifications(), [["zono ⚠求助1", "--sound", "none"]])

    def test_sequence_numbers_increase_so_herdr_keeps_the_latest_count(self):
        self.decision("D1")
        self.upsert("D1", DECIDE_SECTION)
        self.upsert("D1", DECIDE_SECTION)
        seqs = [int(call[6]) for call in self.calls() if call[:2] == ["pane", "report-metadata"]]
        self.assertEqual(len(seqs), 2)
        self.assertLess(seqs[0], seqs[1])

    def test_rate_limited_or_busy_notification_is_not_retried(self):
        for index, reason in enumerate(("rate_limited", "busy")):
            with self.subTest(reason=reason):
                identifier = f"D{index}"
                self.decision(identifier)
                result = self.upsert(identifier, DECIDE_SECTION, FAKE_NOTIFY_REASON=reason)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
        self.assertEqual(len(self.notifications()), 2)
        self.assertEqual(self.displays()[-1], ["--display-agent", "zono ⚠待答2"])

    def test_record_cleanup_and_zero_counts_restore_the_name(self):
        panel = load_module()
        self.decision("D1")
        self.upsert("D1", DECIDE_SECTION)
        section = panel._question_section(self.questions.read_text(), "D1")
        result = self.cli(
            "question", "set-status", "--questions", self.questions, "--id", "D1",
            "--revision", "1", "--status", "recorded",
            "--expected-section-sha256", panel._section_sha256(section),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.displays()[-1], ["--clear-display-agent"])
        self.decision("D2")
        self.upsert("D2", DECIDE_SECTION)
        self.decision("D2", status="answered")
        result = self.cli("question", "cleanup", "--questions", self.questions,
                          "--decisions", self.decisions)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.displays()[-1], ["--clear-display-agent"])
        self.assertEqual(len(self.notifications()), 2)

    def test_counts_only_this_files_waiting_questions_with_open_decisions(self):
        panel = load_module()
        self.decision("D1")
        self.decision("H1", kind="HELP")
        self.decision("OLD", status="answered")
        self.questions.write_text(
            "## a\nD1 · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n"
            "## b\nH1 · r2 · 待答\n\n答覆：A. 已完成\n\n- [x] 送出\n\n"
            "## c\nOLD · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n"
            "## d\nGONE · r1 · 已記錄 · 2026-10-16T00:00:00+00:00\n\n答覆：A\n\n- [x] 送出\n\n"
            "## e\nNOREC · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n"
        )
        other = self.questions.with_name("questions-other.md")
        other.write_text("## x\nD9 · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n")
        self.decision("D9")
        self.assertEqual(panel.status_counts(self.questions, self.decisions), (2, 1))
        self.assertEqual(panel.status_counts(self.root / "missing.md", self.decisions), (0, 0))

    def test_help_question_requires_a_single_choice_done_option(self):
        self.decision("H1", kind="help")
        for section in ("## 請登入\n\n說明。\n",
                        "## 請登入\n\n說明。\n\nA. 好了\nB. 做不到\n",
                        "## 請登入\n\n說明。\n\n- [ ] 已完成\n- [ ] 做不到\n"):
            with self.subTest(section=section):
                result = self.upsert("H1", section)
                self.assertEqual(result.returncode, 1)
                self.assertIn("已完成", result.stderr)
        self.assertFalse(self.questions.exists())
        self.assertEqual(self.upsert("H1", HELP_SECTION.replace("A. 已完成", "A. 已完成（建議）"))
                         .returncode, 0)
        self.assertEqual(self.upsert("H1", "## 請登入\n\n說明。\n\n- A. 已完成\n  主控接著驗證。\n")
                         .returncode, 0)
        # Decide records keep their free format.
        self.decision("D1")
        self.assertEqual(self.upsert("D1", "## 自由輸入\n\n說明。\n").returncode, 0)

    def test_resolve_help_records_verification_and_archives_the_question(self):
        self.decision("H1", kind="help")
        self.upsert("H1", HELP_SECTION)
        result = self.cli("question", "resolve-help", "--questions", self.questions,
                          "--decisions", self.decisions, "--id", "H1",
                          "--evidence", "登入狀態 200 OK", "--location", "curl https://x.test/me")
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "self-verified")
        self.assertEqual(output["cleanup"]["archived"], [{"id": "H1", "reason": "decision-not-pending"}])
        record = (self.decisions / "H1.md").read_text()
        self.assertIn("- status: self-verified\n", record)
        self.assertNotIn("pending", record)
        self.assertIn("## 主控查證\n- 查證：登入狀態 200 OK\n- 位置：curl https://x.test/me\n- 時間：",
                      record)
        self.assertEqual(self.displays()[-1], ["--clear-display-agent"])

    def test_resolve_help_cleanup_failure_keeps_record_closed_and_says_to_rerun(self):
        self.decision("H1", kind="help")
        self.upsert("H1", HELP_SECTION)
        (self.questions.parent / "panel-journal.jsonl").write_text("{broken\n")
        result = self.cli("question", "resolve-help", "--questions", self.questions,
                          "--decisions", self.decisions, "--id", "H1",
                          "--evidence", "ok", "--location", "here")
        self.assertEqual((result.returncode, result.stdout), (1, ""))
        self.assertIn("self-verified but cleanup failed", result.stderr)
        self.assertIn("rerun question cleanup", result.stderr)
        self.assertIn("- status: self-verified", (self.decisions / "H1.md").read_text())
        self.assertEqual(self.displays()[-1], ["--clear-display-agent"])

    def test_resolve_help_refuses_decide_records_non_pending_and_empty_evidence(self):
        self.decision("D1")
        self.decision("H2", kind="help", status="answered")
        self.decision("H3", kind="help")
        for identifier, evidence, reason in (("D1", "x", "not a help record"),
                                             ("H2", "x", "not pending"),
                                             ("H3", " ", "must not be empty")):
            with self.subTest(identifier=identifier):
                before = (self.decisions / f"{identifier}.md").read_text()
                result = self.cli("question", "resolve-help", "--questions", self.questions,
                                  "--decisions", self.decisions, "--id", identifier,
                                  "--evidence", evidence, "--location", "here")
                self.assertEqual(result.returncode, 1)
                self.assertIn(reason, result.stderr)
                self.assertEqual((self.decisions / f"{identifier}.md").read_text(), before)

    def withdraw(self, identifier, *extra):
        return self.cli("question", "withdraw", "--questions", self.questions,
                        "--decisions", self.decisions, "--id", identifier, *extra)

    def test_withdraw_records_reason_and_source_then_archives_the_question(self):
        self.decision("D1")
        self.decision("H1", kind="help")
        self.upsert("D1", DECIDE_SECTION)
        self.upsert("H1", HELP_SECTION)
        self.assertEqual(self.displays()[-1], ["--display-agent", "zono ⚠待答1求助1"])
        source = "使用者聊天原文：「合併那題不用了」\nsession cf5bf88b"
        result = self.withdraw("D1", "--reason", " 需求改了，題目前提不成立 ", "--source", source)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual((output["id"], output["status"]), ("D1", "withdrawn"))
        self.assertEqual(output["cleanup"]["archived"],
                         [{"id": "D1", "reason": "decision-not-pending"}])
        record = (self.decisions / "D1.md").read_text()
        self.assertIn("- status: withdrawn\n", record)
        self.assertNotIn("pending", record)
        self.assertRegex(record, r"\n\n## 撤回\n- 原因：需求改了，題目前提不成立\n"
                                 r"- 依據：使用者聊天原文：「合併那題不用了」\n  session cf5bf88b\n"
                                 r"- 時間：\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d\n$")
        self.assertEqual([question["id"] for question in load_module().board_questions(
            self.questions)], ["H1"])
        self.assertIn("D1 · r1", self.questions.with_name(
            f"{self.questions.stem}-archive.md").read_text())
        self.assertEqual(self.displays()[-1], ["--display-agent", "zono ⚠求助1"])
        # A help question is withdrawn the same way; nothing left clears the sidebar.
        self.assertEqual(self.withdraw("H1", "--reason", "已不需要", "--source", "FURE-X r2")
                         .returncode, 0)
        self.assertEqual(self.displays()[-1], ["--clear-display-agent"])

    def test_withdraw_refuses_blank_or_missing_fields_and_non_pending_records(self):
        self.decision("D1")
        self.decision("D2", status="answered")
        self.decision("D3", status="withdrawn")
        self.upsert("D1", DECIDE_SECTION)
        questions = self.questions.read_text()
        for identifier, extra, code, reason in (
                ("D1", ("--reason", " \n", "--source", "chat"), 1, "must not be empty"),
                ("D1", ("--reason", "old", "--source", "  "), 1, "must not be empty"),
                ("D1", ("--source", "chat"), 2, "--reason"),
                ("D1", ("--reason", "old"), 2, "--source"),
                ("D2", ("--reason", "old", "--source", "chat"), 1, "not pending"),
                ("D3", ("--reason", "old", "--source", "chat"), 1, "not pending")):
            with self.subTest(identifier=identifier, extra=extra):
                before = (self.decisions / f"{identifier}.md").read_text()
                result = self.withdraw(identifier, *extra)
                self.assertEqual(result.returncode, code)
                self.assertIn(reason, result.stderr)
                self.assertEqual((self.decisions / f"{identifier}.md").read_text(), before)
                self.assertEqual(self.questions.read_text(), questions)
        # The user already submitted an answer: record it rather than withdraw.
        self.decision("D4")
        self.upsert("D4", DECIDE_SECTION.replace("要合併嗎？", "已送出？"))
        self.questions.write_text(self.questions.read_text().replace(
            "D4 · r1 · 待答\n\n背景。\n\nA. 合併（建議）\n   影響。\nB. 不合併\n   影響。\n\n答覆：\n\n- [ ] 送出",
            "D4 · r1 · 待答\n\n背景。\n\nA. 合併（建議）\n   影響。\nB. 不合併\n   影響。\n\n答覆：A\n\n- [x] 送出"))
        questions = self.questions.read_text()
        self.assertIn("答覆：A", questions)
        before = (self.decisions / "D4.md").read_text()
        result = self.withdraw("D4", "--reason", "old", "--source", "chat")
        self.assertEqual(result.returncode, 1)
        self.assertIn("already has a submitted answer", result.stderr)
        self.assertEqual((self.decisions / "D4.md").read_text(), before)
        self.assertEqual(self.questions.read_text(), questions)
        result = self.withdraw("NOPE", "--reason", "old", "--source", "chat")
        self.assertEqual(result.returncode, 1)
        self.assertIn("decision record not found", result.stderr)
        self.assertFalse(any(self.decisions.glob("*NOPE*")))

    def test_withdraw_cleanup_failure_keeps_record_withdrawn_and_says_to_rerun(self):
        self.decision("D1")
        self.upsert("D1", DECIDE_SECTION)
        (self.questions.parent / "panel-journal.jsonl").write_text("{broken\n")
        result = self.withdraw("D1", "--reason", "old", "--source", "chat")
        self.assertEqual((result.returncode, result.stdout), (1, ""))
        self.assertIn("withdrawn but cleanup failed", result.stderr)
        self.assertIn("rerun question cleanup", result.stderr)
        self.assertIn("- status: withdrawn", (self.decisions / "D1.md").read_text())
        self.assertEqual(self.displays()[-1], ["--clear-display-agent"])

    def test_unbound_file_and_missing_herdr_skip_the_display_quietly(self):
        self.decision("D1")
        loose = self.root / "loose/questions-loose.md"
        loose.parent.mkdir()
        section = self.root / "s.md"
        section.write_text(DECIDE_SECTION)
        result = self.cli("question", "upsert", "--questions", loose, "--decisions",
                          self.decisions, "--id", "D1", "--file", section)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "D1 r1\n", ""))
        self.assertEqual(self.calls(), [])

    def test_disabled_panel_skips_sidebar_and_notification_for_a_bound_file(self):
        self.decision("D1")
        no_herdr = self.root / "empty-bin"
        no_herdr.mkdir()
        for env in ({"PATH": f"{no_herdr}:/usr/bin:/bin"}, {"HERDR_WORKSPACE_ID": ""},
                    {"FAKE_PANEL_ENABLED": "false"}):
            with self.subTest(env=env):
                result = self.upsert("D1", DECIDE_SECTION, **env)
                self.assertEqual((result.returncode, result.stdout, result.stderr),
                                 (0, "D1 r1\n", ""))
        self.assertEqual(self.displays(), [])
        self.assertEqual(self.notifications(), [])

    def test_failed_report_is_a_warning_and_the_question_is_still_written(self):
        self.decision("D1")
        result = self.upsert("D1", DECIDE_SECTION, FAKE_REPORT_EXIT="3")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "D1 r1\n")
        self.assertIn("sidebar not updated", result.stderr)
        self.assertIn("D1 · r1 · 待答", self.questions.read_text())

    def test_clear_status_display_targets_the_binding_pane(self):
        panel = load_module()
        ok, _ = panel.clear_status_display({"herdr_pane": "w1:p1"}, env=self.env)
        self.assertTrue(ok)
        self.assertEqual(self.displays(), [["--clear-display-agent"]])


if __name__ == "__main__":
    unittest.main()
