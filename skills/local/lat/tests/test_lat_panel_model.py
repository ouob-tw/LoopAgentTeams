"""`board transcript` current settings and `board launch-args`: what the LAT board shows as a
controller's model and effort, and whether a Codex controller was started with a fixed model.

Records keep the shapes of real Claude session and Codex rollout lines, cut down to the fields
these commands read.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"
CLAUDE_SESSION = "5e1c0b7a-0000-4000-8000-00000000c1a1"
CODEX_SESSION = "01a13a73-0000-7000-8000-00000000c0df"


def claude_user(time, text):
    return {"type": "user", "timestamp": time, "uuid": f"u-{time}", "origin": {"kind": "human"},
            "message": {"role": "user", "content": text}}


def claude_tool_result(time):
    return {"type": "user", "timestamp": time, "uuid": f"r-{time}",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}


def claude_reply(time, model, effort=None, **extra):
    record = {"type": "assistant", "timestamp": time, "uuid": f"a-{time}",
              "message": {"role": "assistant", "model": model,
                          "content": [{"type": "text", "text": f"reply at {time}"}]}, **extra}
    if effort is not None:
        record["effort"] = effort
    return record


def codex_turn(time, model, effort):
    return {"type": "turn_context", "timestamp": time,
            "payload": {"turn_id": f"turn-{time}", "model": model, "effort": effort,
                        "collaboration_mode": {"mode": "default", "settings": {
                            "model": model, "reasoning_effort": effort}}}}


class ModelTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.env = dict(
            os.environ, HOME=str(self.root / "home"),
            CLAUDE_CONFIG_DIR=str(self.root / "claude-config"),
            CODEX_HOME=str(self.root / "codex-home"),
            HCOM_DIR=str(self.root / "hcom"),
        )

    def board(self, *args, code=0):
        result = subprocess.run(
            [sys.executable, str(MODULE), "board", *args],
            text=True, capture_output=True, env=self.env,
        )
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def write(self, path, records, tail=""):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(record) + "\n" for record in records) + tail)

    def claude(self, records, tail=""):
        self.write(self.root / "claude-config/projects/-work-demo" / f"{CLAUDE_SESSION}.jsonl", records, tail)
        return self.board("transcript", "--client", "claude", "--session-id", CLAUDE_SESSION)["current"]

    def codex(self, records, tail=""):
        path = self.root / "codex-home/sessions/2026/10/14" / f"rollout-2026-10-14T09-00-00-{CODEX_SESSION}.jsonl"
        self.write(path, records, tail)
        return self.board("transcript", "--client", "codex", "--session-id", CODEX_SESSION)["current"]


class ClaudeCurrentTests(ModelTestCase):
    def test_the_last_reply_gives_the_model_and_effort_and_its_turn_start(self):
        current = self.claude([
            claude_user("2026-10-14T09:00:00Z", "first"),
            claude_reply("2026-10-14T09:00:01Z", "claude-opus-5-5", "high"),
            claude_user("2026-10-14T09:01:00Z", "second"),
            claude_reply("2026-10-14T09:01:01Z", "claude-sonnet-5-5", "low"),
            claude_tool_result("2026-10-14T09:01:02Z"),
            claude_reply("2026-10-14T09:01:03Z", "claude-sonnet-5-5", "low"),
        ])
        self.assertEqual(current, {"model": "claude-sonnet-5-5", "effort": "low",
                                   "time": "2026-10-14T09:01:00Z"})

    def test_synthetic_and_sub_agent_replies_do_not_count(self):
        current = self.claude([
            claude_user("2026-10-14T09:00:00Z", "first"),
            claude_reply("2026-10-14T09:00:01Z", "claude-opus-5-5", "high"),
            claude_reply("2026-10-14T09:00:02Z", "claude-haiku-5-5", "low", isSidechain=True),
            claude_reply("2026-10-14T09:00:03Z", "<synthetic>"),
        ])
        self.assertEqual(current["model"], "claude-opus-5-5")
        self.assertEqual(current["effort"], "high")

    def test_a_reply_without_an_effort_field_has_unknown_effort(self):
        current = self.claude([
            claude_user("2026-10-14T09:00:00Z", "first"),
            claude_reply("2026-10-14T09:00:01Z", "claude-opus-5-5"),
        ])
        self.assertEqual(current, {"model": "claude-opus-5-5", "effort": None, "time": "2026-10-14T09:00:00Z"})

    def test_settings_typed_after_the_last_reply_do_not_move_its_turn(self):
        current = self.claude([
            claude_user("2026-10-14T09:00:00Z", "first"),
            claude_reply("2026-10-14T09:00:01Z", "claude-opus-5-5", "high"),
            claude_user("2026-10-14T09:02:00Z", "<command-name>/model</command-name><command-args>claude-haiku-5-5</command-args>"),
        ])
        self.assertEqual(current["time"], "2026-10-14T09:00:00Z")

    def test_no_reply_yet_is_null(self):
        self.assertIsNone(self.claude([claude_user("2026-10-14T09:00:00Z", "first")]))

    def test_a_reply_with_a_model_of_the_wrong_type_is_passed_over(self):
        current = self.claude([
            claude_user("2026-10-14T09:00:00Z", "first"),
            claude_reply("2026-10-14T09:00:01Z", "claude-opus-5-5", "high"),
            claude_reply("2026-10-14T09:00:02Z", ["not", "text"], "low"),
        ], tail="{broken\n")
        self.assertEqual(current["model"], "claude-opus-5-5")


class CodexCurrentTests(ModelTestCase):
    def test_the_last_turn_context_gives_the_model_effort_and_turn_start(self):
        current = self.codex([
            {"type": "session_meta", "timestamp": "2026-10-14T09:00:00Z", "payload": {"cwd": "/work"}},
            codex_turn("2026-10-14T09:00:01Z", "gpt-6.1-sol", "medium"),
            codex_turn("2026-10-14T09:05:00Z", "gpt-6-astra", "xhigh"),
            {"type": "event_msg", "timestamp": "2026-10-14T09:05:01Z", "payload": {"type": "task_complete"}},
        ])
        self.assertEqual(current, {"model": "gpt-6-astra", "effort": "xhigh", "time": "2026-10-14T09:05:00Z"})

    def test_no_turn_yet_is_null(self):
        current = self.codex([
            {"type": "session_meta", "timestamp": "2026-10-14T09:00:00Z", "payload": {"cwd": "/work"}},
        ])
        self.assertIsNone(current)

    def test_a_turn_without_effort_has_unknown_effort(self):
        current = self.codex([codex_turn("2026-10-14T09:00:01Z", "gpt-6-astra", None)])
        self.assertEqual(current["effort"], None)
        self.assertEqual(current["model"], "gpt-6-astra")


class LaunchArgsTests(ModelTestCase):
    def database(self, rows, *, columns=("name", "session_id", "launch_args")):
        path = self.root / "hcom/hcom.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.execute(f"create table instances ({', '.join(columns)})")
            connection.executemany(
                f"insert into instances values ({', '.join('?' for _ in columns)})", rows)
        connection.close()
        return path

    def test_the_stored_launch_args_of_the_session_are_printed(self):
        self.database([
            ("dova", CODEX_SESSION, '["--model","gpt-6.1-sol","-c","model_reasoning_effort=\\"medium\\""]'),
            ("seru", "other-session", '["--oss"]'),
        ])
        result = self.board("launch-args", "--session-id", CODEX_SESSION)
        self.assertEqual(result, {"status": "ok",
                                  "args": ["--model", "gpt-6.1-sol", "-c", 'model_reasoning_effort="medium"']})

    def test_an_empty_value_is_no_arguments(self):
        self.database([("dova", CODEX_SESSION, "")])
        self.assertEqual(self.board("launch-args", "--session-id", CODEX_SESSION), {"status": "ok", "args": []})

    def test_the_database_is_only_read(self):
        path = self.database([("dova", CODEX_SESSION, "[]")])
        before = path.read_bytes()
        os.chmod(path, 0o444)
        self.board("launch-args", "--session-id", CODEX_SESSION)
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse((path.parent / "hcom.db-journal").exists())

    def test_what_cannot_be_read_is_unknown_with_a_reason(self):
        cases = {
            "no database": None,
            "no such agent": [("dova", "other", "[]")],
            "not a list": [("dova", CODEX_SESSION, '{"model": 1}')],
            "not JSON": [("dova", CODEX_SESSION, "--model x")],
            "not all text": [("dova", CODEX_SESSION, '["-c", 3]')],
        }
        for case, rows in cases.items():
            with self.subTest(case):
                (self.root / "hcom/hcom.db").unlink(missing_ok=True)
                if rows is not None:
                    self.database(rows)
                result = self.board("launch-args", "--session-id", CODEX_SESSION, code=1)
                self.assertEqual(result["status"], "unknown")
                self.assertTrue(result["reason"])

    def test_a_table_without_the_column_is_unknown(self):
        self.database([("dova", CODEX_SESSION)], columns=("name", "session_id"))
        result = self.board("launch-args", "--session-id", CODEX_SESSION, code=1)
        self.assertEqual(result["status"], "unknown")

    def test_without_hcom_dir_the_default_folder_is_used(self):
        del self.env["HCOM_DIR"]
        home = self.root / "home/.hcom"
        home.mkdir(parents=True)
        with sqlite3.connect(home / "hcom.db") as connection:
            connection.execute("create table instances (name, session_id, launch_args)")
            connection.execute("insert into instances values ('dova', ?, '[\"--oss\"]')", (CODEX_SESSION,))
        connection.close()
        self.assertEqual(self.board("launch-args", "--session-id", CODEX_SESSION)["args"], ["--oss"])


if __name__ == "__main__":
    unittest.main()
