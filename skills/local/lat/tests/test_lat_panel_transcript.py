"""`board transcript` tests: the conversation history the LAT board shows for a controller.

The samples in fixtures/ keep the record shapes of real Claude session and Codex rollout
files, with every piece of content replaced; whatever must never reach the board is
marked SECRET.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


MODULE = Path(__file__).resolve().parents[1] / "herdr-panel/lat_panel.py"
FIXTURES = Path(__file__).resolve().parent / "fixtures"
CLAUDE_SESSION = "5e1c0b7a-0000-4000-8000-00000000c1a0"
CODEX_SESSION = "01a13a73-0000-7000-8000-00000000c0de"


def shown(item):
    """One item as the board would show it, without its time and position."""
    if item["kind"] == "tool":
        mark = "✗ " if item["error"] else ""
        return ("tool", f"{mark}{item['label']}" + (f"：{item['detail']}" if item["detail"] else ""))
    return (item["kind"], item["text"])


class TranscriptTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.claude = self.root / "claude-config"
        self.codex = self.root / "codex-home"
        self.env = dict(
            os.environ, HOME=str(self.root / "home"),
            CLAUDE_CONFIG_DIR=str(self.claude), CODEX_HOME=str(self.codex),
        )

    def transcript(self, client, session, *extra, code=0):
        result = subprocess.run(
            [sys.executable, str(MODULE), "board", "transcript", "--client", client,
             "--session-id", session, *map(str, extra)],
            text=True, capture_output=True, env=self.env,
        )
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def claude_file(self, session=CLAUDE_SESSION, root=None):
        path = (root or self.claude) / "projects/-work-demo" / f"{session}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    def codex_file(self, session=CODEX_SESSION, folder="sessions/2026/10/14"):
        path = self.codex / folder / f"rollout-2026-10-14T09-00-00-{session}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        return path


class ClaudeSampleTests(TranscriptTestCase):
    def setUp(self):
        super().setUp()
        shutil.copy(FIXTURES / "claude-session.jsonl", self.claude_file())
        self.page = self.transcript("claude", CLAUDE_SESSION)

    EXPECTED = [
        ("tool", "hook 提示"),
        ("user", "幫我看一下登入頁為什麼會轉圈"),
        ("assistant", "我先看登入頁的程式。"),
        ("tool", "讀檔：src/login.ts"),
        ("tool", "搜尋：spinner"),
        ("tool", "執行指令：cat …"),
        ("tool", "✗ 執行指令：npm test"),
        ("assistant", "測試失敗了，原因是逾時。\n\n我接著改設定。"),
        ("tool", "收到 hcom 通知"),
        ("tool", "寫檔：src/config.ts"),
        ("tool", "改檔：/elsewhere/other.ts"),
        ("tool", "mcp__demo__lookup"),
        ("user", "順便看一下登出"),
        ("tool", "召喚子 Agent：查登出流程"),
        ("assistant", "改好了，登出也正常。"),
        ("tool", "收到 hcom 通知"),
        ("assistant", "收到 nova 的訊息。"),
        ("user", "/copy"),
        ("user", "/lat 開新一輪"),
        ("tool", "hook 提示"),
        ("assistant", "好，開始新一輪。"),
    ]

    def test_texts_and_operations_come_in_the_order_they_happened(self):
        self.assertEqual([shown(item) for item in self.page["items"]], self.EXPECTED)
        self.assertEqual([item["seq"] for item in self.page["items"]], list(range(21)))
        self.assertIsNone(self.page["before"])
        self.assertEqual(self.page["path"], str(self.claude_file()))
        self.assertEqual(self.page["items"][1]["time"], "2026-10-14T09:00:01.000Z")

    def test_only_what_a_person_typed_is_a_user_message(self):
        users = [item["text"] for item in self.page["items"] if item["kind"] == "user"]
        # Typed, typed while the controller was busy, and slash commands; not the HCOM
        # wake-up, a task notification, a skill body, a compact summary or hook feedback.
        self.assertEqual(users, ["幫我看一下登入頁為什麼會轉圈", "順便看一下登出", "/copy", "/lat 開新一輪"])

    def test_no_content_output_sub_agent_or_broken_line_reaches_the_board(self):
        self.assertNotIn("SECRET", json.dumps(self.page, ensure_ascii=False))
        self.assertEqual(self.page["skipped"], 1)

    def test_each_text_appears_once(self):
        texts = [item["text"] for item in self.page["items"] if item["kind"] != "tool"]
        self.assertEqual(len(texts), len(set(texts)))

    def test_a_record_written_twice_is_listed_once(self):
        lines = self.claude_file().read_text().splitlines()
        self.claude_file().write_text("\n".join(lines + lines[2:6]) + "\n")
        self.assertEqual(self.transcript("claude", CLAUDE_SESSION)["items"], self.page["items"])


class CodexSampleTests(TranscriptTestCase):
    def setUp(self):
        super().setUp()
        shutil.copy(FIXTURES / "codex-rollout.jsonl", self.codex_file())
        self.page = self.transcript("codex", CODEX_SESSION)

    EXPECTED = [
        ("user", "$lat 修好匯出功能"),
        ("assistant", "我先找匯出的程式。"),
        ("tool", "執行指令：rg -n export src"),
        ("tool", "執行指令：python …"),
        ("tool", "✗ 執行指令：npm test -- " + "x" * 67 + "…"),
        ("tool", "收到 hcom 通知"),
        ("assistant", "找到了，問題在日期格式。"),
        ("tool", "改檔：src/export.ts"),
        ("tool", "改檔：a.ts 等 2 個檔案"),
        ("tool", "MCP 工具：context7.query-docs"),
        ("tool", "hook 提示"),
        ("assistant", "改好了，\n匯出正常。"),
        ("tool", "收到 lat-watch 提醒"),
        ("user", "還有一件事"),
    ]

    def test_texts_and_operations_come_in_the_order_they_happened(self):
        self.assertEqual([shown(item) for item in self.page["items"]], self.EXPECTED)
        self.assertIsNone(self.page["before"])

    def test_no_content_output_system_prompt_or_broken_line_reaches_the_board(self):
        self.assertNotIn("SECRET", json.dumps(self.page, ensure_ascii=False))
        self.assertEqual(self.page["skipped"], 1)

    def test_a_rollout_moved_to_the_archive_is_still_found(self):
        archived = self.codex_file(folder="archived_sessions")
        self.codex_file().rename(archived)
        page = self.transcript("codex", CODEX_SESSION)
        self.assertEqual(page["path"], str(archived))
        self.assertEqual(page["items"], self.page["items"])


class ToolSummaryTests(TranscriptTestCase):
    def tool_line(self, name, arguments):
        record = {
            "type": "assistant", "uuid": "u-1", "cwd": "/work/demo", "timestamp": "t",
            "message": {"model": "m", "role": "assistant", "content": [
                {"type": "tool_use", "id": "tool-1", "name": name, "input": arguments},
            ]},
        }
        self.claude_file().write_text(json.dumps(record) + "\n")
        (item,) = self.transcript("claude", CLAUDE_SESSION)["items"]
        return shown(item)[1]

    def test_command_shows_its_first_line_at_80_characters(self):
        self.assertEqual(self.tool_line("Bash", {"command": "git status\ngit diff"}), "執行指令：git status")
        summary = self.tool_line("Bash", {"command": "echo " + "y" * 200})
        self.assertEqual(len(summary.removeprefix("執行指令：")), 80)
        self.assertTrue(summary.endswith("…"))

    def test_writing_a_file_shows_only_its_path(self):
        self.assertEqual(
            self.tool_line("Write", {"file_path": "/work/demo/a.md", "content": "SECRET"}), "寫檔：a.md",
        )
        self.assertEqual(
            self.tool_line("Edit", {"file_path": "/work/demo/b.md", "old_string": "SECRET", "new_string": "SECRET"}),
            "改檔：b.md",
        )

    def test_a_web_address_is_shown_without_its_query_string(self):
        self.assertEqual(
            self.tool_line("WebFetch", {"url": "https://example.com/a?token=SECRET#x", "prompt": "SECRET"}),
            "讀網頁：https://example.com/a",
        )

    def test_a_tool_whose_arguments_are_not_known_to_be_safe_shows_only_its_name(self):
        self.assertEqual(self.tool_line("TodoWrite", {"todos": [{"content": "SECRET"}]}), "TodoWrite")
        self.assertEqual(self.tool_line("Read", {"file_path": ["not", "a", "path"]}), "Read")


# Commands that may carry what they write to a file, as QA wrote them, and what they show.
WRITING_COMMANDS = (
    ("printf QA_FILE_CONTENT_SENTINEL > file.txt", "printf …"),
    ("echo QA_FILE_CONTENT_SENTINEL >> file.txt", "echo …"),
    ("echo QA_FILE_CONTENT_SENTINEL >| file.txt", "echo …"),
    ("printf QA_FILE_CONTENT_SENTINEL &> file.txt", "printf …"),
    ("printf QA_FILE_CONTENT_SENTINEL 1> file.txt", "printf …"),
    ("printf QA_FILE_CONTENT_SENTINEL 2>file.txt", "printf …"),
    ("printf QA_FILE_CONTENT_SENTINEL >&file.txt", "printf …"),
    ("echo QA_FILE_CONTENT_SENTINEL | tee file.txt", "echo …"),
    ("echo QA_FILE_CONTENT_SENTINEL | sudo /usr/bin/tee -a file.txt", "echo …"),
    ("printf QA_FILE_CONTENT_SENTINEL | dd of=file.txt status=none", "printf …"),
    ("cat <<'EOF' > file.txt\nQA_FILE_CONTENT_SENTINEL\nEOF", "cat …"),
    ("python - <<'PY'  # QA_FILE_CONTENT_SENTINEL\nprint(1)\nPY", "python …"),
    ("LANG=C printf QA_FILE_CONTENT_SENTINEL>file.txt", "printf …"),
    # An open quote leaves no way to tell what is written: the safe side.
    ("echo 'QA_FILE_CONTENT_SENTINEL > file.txt", "echo …"),
    ("printf QA_FILE_CONTENT_SENTINEL > '/dev/null'", "printf …"),
)
# Commands that write no file keep their first line.
OTHER_COMMANDS = (
    "npm test 2>&1",
    "npm test >&2",
    "npm test > /dev/null",
    "npm test >/dev/null 2>&1",
    "npm test 2>/dev/null",
    "npm test &>/dev/null",
    "npm test >> /dev/null",
    "grep '>' file.txt",
    'grep ">" file.txt',
    "echo 'a > b' | wc -c",
    "rg 'tee' src",
)


class WritingCommandTests(TranscriptTestCase):
    def summaries(self, client, commands):
        if client == "claude":
            records = [{
                "type": "assistant", "uuid": f"u{index}", "timestamp": "t",
                "message": {"model": "m", "role": "assistant", "content": [
                    {"type": "tool_use", "id": f"t{index}", "name": "Bash", "input": {"command": command}},
                ]},
            } for index, command in enumerate(commands)]
            self.claude_file().write_text("".join(json.dumps(record) + "\n" for record in records))
            page = self.transcript("claude", CLAUDE_SESSION)
        else:
            records = [{
                "timestamp": "t", "type": "event_msg", "payload": {"type": "item_completed", "item": {
                    "type": "CommandExecution", "command": ["/bin/bash", "-lc", command], "exit_code": 0,
                }},
            } for command in commands]
            self.codex_file().write_text("".join(json.dumps(record) + "\n" for record in records))
            page = self.transcript("codex", CODEX_SESSION)
        return [item["detail"] for item in page["items"]]

    def test_a_command_that_writes_a_file_shows_only_its_program(self):
        for client in ("claude", "codex"):
            with self.subTest(client=client):
                shown_details = self.summaries(client, [command for command, _ in WRITING_COMMANDS])
                self.assertEqual(shown_details, [summary for _, summary in WRITING_COMMANDS])
                self.assertNotIn("QA_FILE_CONTENT_SENTINEL", json.dumps(shown_details))

    def test_a_command_that_writes_no_file_keeps_its_first_line(self):
        for client in ("claude", "codex"):
            with self.subTest(client=client):
                self.assertEqual(self.summaries(client, OTHER_COMMANDS), list(OTHER_COMMANDS))


class LookupTests(TranscriptTestCase):
    def test_missing_record_is_a_clear_error(self):
        page = self.transcript("claude", CLAUDE_SESSION, code=1)
        self.assertEqual(page["status"], "not_found")
        self.assertIn(CLAUDE_SESSION, page["reason"])
        self.assertEqual(self.transcript("codex", CODEX_SESSION, code=1)["status"], "not_found")

    def test_unsupported_client_and_odd_session_id_are_refused(self):
        self.assertEqual(self.transcript("gemini", CLAUDE_SESSION, code=1)["status"], "error")
        self.assertEqual(self.transcript("claude", "../../etc/passwd", code=1)["status"], "error")

    def test_without_the_variables_the_clients_default_directories_are_used(self):
        del self.env["CLAUDE_CONFIG_DIR"], self.env["CODEX_HOME"]
        home = self.root / "home"
        shutil.copy(FIXTURES / "claude-session.jsonl", self.claude_file(root=home / ".claude"))
        path = home / ".codex/sessions/2026/10/14" / f"rollout-x-{CODEX_SESSION}.jsonl"
        path.parent.mkdir(parents=True)
        shutil.copy(FIXTURES / "codex-rollout.jsonl", path)
        self.assertEqual(len(self.transcript("claude", CLAUDE_SESSION)["items"]), 21)
        self.assertEqual(self.transcript("codex", CODEX_SESSION)["path"], str(path))

    def test_a_line_still_being_written_is_neither_shown_nor_counted_as_broken(self):
        path = self.claude_file()
        line = json.dumps({
            "type": "assistant", "uuid": "u-1", "timestamp": "t",
            "message": {"model": "m", "role": "assistant", "content": [{"type": "text", "text": "寫到一半"}]},
        })
        path.write_text(line[:30])
        page = self.transcript("claude", CLAUDE_SESSION)
        self.assertEqual((page["items"], page["skipped"]), ([], 0))
        path.write_text(line + "\n")
        self.assertEqual([shown(item) for item in self.transcript("claude", CLAUDE_SESSION)["items"]],
                         [("assistant", "寫到一半")])


class RecordVariantTests(TranscriptTestCase):
    def test_older_claude_records_without_origin_still_tell_typed_text_from_client_text(self):
        typed = [
            "舊版打的字",
            "<div>這段 HTML 是我打的</div>",
            "<command-message>lat</command-message>\n<command-name>/lat</command-name>\n<command-args>開新一輪</command-args>",
        ]
        client = [
            "<local-command-stdout>SECRET</local-command-stdout>",
            "<local-command-caveat>Caveat: SECRET</local-command-caveat>",
            "<bash-input>SECRET</bash-input>",
            "<bash-stdout>SECRET</bash-stdout>",
            "<task-notification>SECRET</task-notification>",
            "[Request interrupted by user]",
        ]
        records = [
            {"type": "user", "uuid": str(index), "timestamp": "t", "message": {"role": "user", "content": text}}
            for index, text in enumerate(typed + client)
        ]
        self.claude_file().write_text("".join(json.dumps(record) + "\n" for record in records))
        items = self.transcript("claude", CLAUDE_SESSION)["items"]
        self.assertEqual([shown(item) for item in items], [
            ("user", "舊版打的字"), ("user", "<div>這段 HTML 是我打的</div>"), ("user", "/lat 開新一輪"),
        ])

    def test_each_claude_record_is_judged_by_its_own_origin_in_a_mixed_version_session(self):
        records = [
            # Written by an older version before the session was resumed.
            {"type": "user", "uuid": "1", "timestamp": "t", "message": {"role": "user", "content": "舊版打的字"}},
            {"type": "user", "uuid": "2", "timestamp": "t",
             "message": {"role": "user", "content": "<local-command-stdout>SECRET</local-command-stdout>"}},
            # Written by the newer version.
            {"type": "user", "uuid": "3", "timestamp": "t", "origin": {"kind": "human"},
             "message": {"role": "user", "content": "<div>新版打的</div>"}},
            {"type": "user", "uuid": "4", "timestamp": "t", "origin": {"kind": "task-notification"},
             "message": {"role": "user", "content": "SECRET_TASK"}},
        ]
        self.claude_file().write_text("".join(json.dumps(record) + "\n" for record in records))
        page = self.transcript("claude", CLAUDE_SESSION)
        self.assertEqual([shown(item) for item in page["items"]], [
            ("user", "舊版打的字"), ("user", "<div>新版打的</div>"),
        ])

    def test_a_malformed_record_with_an_origin_changes_nothing_else(self):
        records = [
            {"type": "user", "uuid": "1", "timestamp": "t", "message": {"role": "user", "content": "舊版打的字"}},
            {"type": "user", "uuid": [], "timestamp": "t", "origin": {"kind": "human"},
             "message": {"role": "user", "content": "SECRET_1"}},
            {"type": "user", "uuid": "2", "timestamp": "t", "origin": "human",
             "message": {"role": "user", "content": "SECRET_2"}},
            {"type": "user", "uuid": "3", "timestamp": "t", "isSidechain": True, "origin": {"kind": "human"},
             "message": {"role": "user", "content": "SECRET_3"}},
            {"type": "user", "uuid": "4", "timestamp": "t", "message": {"role": "user", "content": "<div>再一句</div>"}},
        ]
        self.claude_file().write_text("".join(json.dumps(record) + "\n" for record in records))
        page = self.transcript("claude", CLAUDE_SESSION)
        self.assertEqual([shown(item) for item in page["items"]], [
            ("user", "舊版打的字"), ("user", "<div>再一句</div>"),
        ])
        self.assertEqual(page["skipped"], 2)

    def test_a_claude_record_with_fields_of_the_wrong_type_is_dropped_alone(self):
        good = (FIXTURES / "claude-session.jsonl").read_text().splitlines()
        odd = [
            {"type": "user", "uuid": [], "origin": {"kind": "human"}, "message": {"role": "user", "content": "SECRET_1"}},
            {"type": "assistant", "uuid": "x1", "timestamp": 5,
             "message": {"model": "m", "content": [{"type": "text", "text": "SECRET_2"}]}},
            {"type": "assistant", "uuid": "x2", "timestamp": "t",
             "message": {"model": "m", "content": [{"type": "text", "text": {"SECRET_3": 1}}]}},
            {"type": "assistant", "uuid": "x3", "timestamp": "t",
             "message": {"model": "m", "content": [{"type": "tool_use", "id": "i", "name": {"SECRET_4": 1}, "input": {}}]}},
        ]
        # Records of no interest whose fields look odd are not broken lines.
        unrelated = [{"type": "mode", "mode": [1, 2]}, {"type": "file-history-snapshot", "uuid": None}]
        lines = good[:5] + [json.dumps(record) for record in odd + unrelated] + good[5:]
        self.claude_file().write_text("\n".join(lines) + "\n")
        page = self.transcript("claude", CLAUDE_SESSION)
        expected = ClaudeSampleTests.EXPECTED
        self.assertEqual([shown(item) for item in page["items"]], expected)
        self.assertEqual(page["skipped"], 1 + len(odd))
        self.assertNotIn("SECRET", json.dumps(page, ensure_ascii=False))

    def test_a_codex_record_with_fields_of_the_wrong_type_is_dropped_alone(self):
        good = (FIXTURES / "codex-rollout.jsonl").read_text().splitlines()
        def completed(item, time="t"):
            return {"timestamp": time, "type": "event_msg", "payload": {"type": "item_completed", "item": item}}
        odd = [
            completed({"type": "CommandExecution", "command": ["bash", "-lc", {"SECRET_1": 1}], "exit_code": 0}),
            completed({"type": "AgentMessage", "content": [{"type": "Text", "text": ["SECRET_2"]}]}),
            completed({"type": "UserMessage", "content": [{"type": "text", "text": "SECRET_3"}]}, time=7),
            completed({"type": "McpToolCall", "server": {"SECRET_4": 1}, "tool": "x"}),
            completed({"type": ["SECRET_5"]}),
        ]
        lines = good[:6] + [json.dumps(record) for record in odd] + good[6:]
        self.codex_file().write_text("\n".join(lines) + "\n")
        page = self.transcript("codex", CODEX_SESSION)
        self.assertEqual([shown(item) for item in page["items"]], CodexSampleTests.EXPECTED)
        self.assertEqual(page["skipped"], 1 + len(odd))
        self.assertNotIn("SECRET", json.dumps(page, ensure_ascii=False))

    def test_a_codex_sub_agent_thread_has_no_conversation_of_the_person(self):
        lines = (FIXTURES / "codex-rollout.jsonl").read_text().splitlines()
        meta = json.loads(lines[0])
        meta["payload"]["source"] = {"subagent": {"thread_spawn": {"parent_thread_id": "p"}}}
        self.codex_file().write_text("\n".join([json.dumps(meta), *lines[1:]]) + "\n")
        self.assertEqual(self.transcript("codex", CODEX_SESSION)["items"], [])

    def test_the_newest_of_several_records_of_one_session_is_read(self):
        older = self.claude_file()
        newer = self.claude.joinpath("projects/-work-other", f"{CLAUDE_SESSION}.jsonl")
        newer.parent.mkdir(parents=True)
        shutil.copy(FIXTURES / "claude-session.jsonl", older)
        newer.write_text("")
        os.utime(older, (1, 1))
        self.assertEqual(self.transcript("claude", CLAUDE_SESSION)["path"], str(newer))


class PagingTests(TranscriptTestCase):
    def setUp(self):
        super().setUp()
        records = []
        for turn in range(65):
            records.append({
                "type": "user", "uuid": f"q{turn}", "timestamp": "t", "origin": {"kind": "human"},
                "message": {"role": "user", "content": f"問題 {turn}"},
            })
            for step in range(turn % 3):
                records.append({
                    "type": "assistant", "uuid": f"t{turn}-{step}", "timestamp": "t",
                    "message": {"model": "m", "role": "assistant", "content": [
                        {"type": "tool_use", "id": f"x{turn}-{step}", "name": "Bash", "input": {"command": "ls"}},
                    ]},
                })
            records.append({
                "type": "assistant", "uuid": f"a{turn}", "timestamp": "t",
                "message": {"model": "m", "role": "assistant", "content": [{"type": "text", "text": f"回答 {turn}"}]},
            })
        self.claude_file().write_text("".join(json.dumps(record) + "\n" for record in records))
        self.total = sum(2 + turn % 3 for turn in range(65))

    def test_pages_of_50_texts_cover_everything_once_from_newest_to_oldest(self):
        pages = [self.transcript("claude", CLAUDE_SESSION)]
        while pages[-1]["before"] is not None:
            pages.append(self.transcript("claude", CLAUDE_SESSION, "--before", pages[-1]["before"]))
        texts = [[item for item in page["items"] if item["kind"] != "tool"] for page in pages]
        self.assertEqual([len(page) for page in texts], [50, 50, 30])
        # Each page starts at a text, so the operations before it belong to the earlier page.
        for page in pages[:-1]:
            self.assertNotEqual(page["items"][0]["kind"], "tool")
            self.assertEqual(page["before"], page["items"][0]["seq"])
        joined = [item for page in reversed(pages) for item in page["items"]]
        self.assertEqual([item["seq"] for item in joined], list(range(self.total)))
        self.assertEqual(joined[-1]["text"], "回答 64")

    def test_a_cursor_past_the_start_gives_an_empty_first_page(self):
        page = self.transcript("claude", CLAUDE_SESSION, "--before", 0)
        self.assertEqual((page["items"], page["before"]), ([], None))


if __name__ == "__main__":
    unittest.main()
