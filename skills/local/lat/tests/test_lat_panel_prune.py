"""`board prune-reports`: the board's 30-day retention of controller report files.

Only temporary report directories; the turn-end hook's real `append_report` runs
in child processes against them.
"""
from datetime import datetime, timedelta, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


LAT = Path(__file__).resolve().parents[1]
MODULE = LAT / "herdr-panel/lat_panel.py"
SESSION_SCRIPT = LAT / "scripts/lat-session.py"
NOW = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
RETENTION = timedelta(days=30)

# Runs the hook's own append under a lock-holding fsync that logs and waits, so a
# test can see when the hook holds the lock and keep it there for a while.
HOOK = """
import importlib.util, os, sys, time
from pathlib import Path
spec = importlib.util.spec_from_file_location("lat_session", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
log, name, hold = Path(sys.argv[2]), sys.argv[3], float(sys.argv[4])
def note(text):
    with log.open("a") as stream:
        stream.write(f"{name} {text}\\n")
class Os:
    def __getattr__(self, attribute):
        return getattr(os, attribute)
    def fsync(self, fd):
        note("in-lock")
        time.sleep(hold)
        os.fsync(fd)
module.os = Os()
note("start")
record = {"session_id": "s-old", "hcom_name": "luna", "client": "claude",
          "workspace": "/work/alpha", "status": "active", "history": []}
module.append_report(record, f"{name} 的回報\\n\\nDONE: {name}")
note("done")
"""


def load_module():
    spec = importlib.util.spec_from_file_location("lat_panel_prune", MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def record(issued, **overrides):
    return json.dumps({
        "time": issued.isoformat().replace("+00:00", "Z"), "session_id": "s", "hcom_name": "luna",
        "client": "claude", "workspace": "/work/alpha", "round": 1, "tag": "DONE",
        "summary": "完成", "message": "完成\n\nDONE: 完成", "final": False, **overrides,
    }, ensure_ascii=False)


class PruneTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.reports = self.root / "reports"
        self.reports.mkdir()
        self.core = load_module()

    def write(self, session, *lines, lock=True):
        (self.reports / f"{session}.jsonl").write_text("".join(line + "\n" for line in lines))
        if lock:
            (self.reports / f"{session}.lock").touch()

    def prune(self, *sessions):
        """Prune the named sessions, or every report file there is."""
        named = list(sessions) or sorted(path.stem for path in self.reports.glob("*.jsonl"))
        return self.core.prune_reports(self.reports, NOW, named)

    def exists(self, session, suffix=".jsonl"):
        return (self.reports / f"{session}{suffix}").exists()


class RetentionTests(PruneTestCase):
    def test_deletes_only_files_whose_newest_complete_record_is_30_days_old(self):
        self.write("s-exact", record(NOW - RETENTION))
        self.write("s-day-31", record(NOW - RETENTION - timedelta(days=1)), record(NOW - RETENTION))
        self.write("s-young", record(NOW - RETENTION + timedelta(seconds=1)))
        # The newest record decides, wherever it sits in the file.
        self.write("s-newer-first", record(NOW - timedelta(days=1)), record(NOW - RETENTION - timedelta(days=5)))
        # Lines the board cannot read as a report do not keep a file, and alone never delete one.
        self.write("s-old-then-broken", record(NOW - RETENTION), '{"time": "' + NOW.isoformat() + '"}', "not json")
        self.write("s-only-broken", "not json", json.dumps({"time": (NOW - RETENTION * 2).isoformat()}))
        self.write("s-bad-time", record(NOW - RETENTION, time="yesterday"))
        self.write("s-bad-tag", record(NOW - RETENTION, tag=[]), record(NOW - RETENTION, tag={"DONE": 1}))

        deleted = self.prune()[0]

        self.assertEqual(sorted(deleted), ["s-day-31", "s-exact", "s-old-then-broken"])
        for session in deleted:
            self.assertFalse(self.exists(session))
            # The lock file is never deleted.
            self.assertTrue(self.exists(session, ".lock"))
        for session in ("s-young", "s-newer-first", "s-only-broken", "s-bad-time", "s-bad-tag"):
            self.assertTrue(self.exists(session), session)

    def test_only_the_named_sessions_are_looked_at(self):
        self.write("s-named", record(NOW - RETENTION))
        self.write("s-other", record(NOW - RETENTION))
        self.assertEqual(self.prune("s-named", "s-missing"), (["s-named"], []))
        self.assertTrue(self.exists("s-other"))

    def test_a_name_that_is_not_a_report_file_is_refused(self):
        outside = self.root / "outside.jsonl"
        outside.write_text(record(NOW - RETENTION) + "\n")
        deleted, failed = self.prune("../outside", ".hidden", "")
        self.assertEqual(deleted, [])
        self.assertEqual([item["session_id"] for item in failed], ["../outside", ".hidden", ""])
        self.assertTrue(outside.exists())

    def test_a_busy_lock_leaves_the_file_for_a_later_run(self):
        self.write("s-old", record(NOW - RETENTION - timedelta(days=2)))
        with (self.reports / "s-old.lock").open("a") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            self.assertEqual(self.prune()[0], [])
            self.assertTrue(self.exists("s-old"))
        self.assertEqual(self.prune()[0], ["s-old"])
        self.assertTrue(self.exists("s-old", ".lock"))

    def test_a_file_that_cannot_be_read_is_reported_and_the_others_still_go(self):
        self.write("s-a", record(NOW - RETENTION))
        self.write("s-b", record(NOW - RETENTION))
        self.write("s-c", record(NOW - RETENTION))
        (self.reports / "s-b.jsonl").chmod(0)
        self.addCleanup((self.reports / "s-b.jsonl").chmod, 0o600)
        if os.access(self.reports / "s-b.jsonl", os.R_OK):
            self.skipTest("running as a user that reads any file")

        deleted, failed = self.prune()

        self.assertEqual(deleted, ["s-a", "s-c"])
        self.assertEqual([item["session_id"] for item in failed], ["s-b"])
        self.assertIn("Permission denied", failed[0]["reason"])
        self.assertTrue(self.exists("s-b"))

    def test_a_record_appended_before_the_lock_is_taken_keeps_the_file(self):
        self.write("s-old", record(NOW - RETENTION - timedelta(days=2)))
        real = self.core._report_expired
        calls = []

        def checked(path, now):
            expired = real(path, now)
            calls.append(expired)
            if len(calls) == 1:
                # A hook appends between the first look and the lock.
                with path.open("a") as stream:
                    stream.write(record(NOW) + "\n")
            return expired

        with mock.patch.object(self.core, "_report_expired", checked):
            self.assertEqual(self.prune()[0], [])
        self.assertEqual(calls, [True, False])
        self.assertEqual(len((self.reports / "s-old.jsonl").read_text().splitlines()), 2)

    def test_a_hook_waiting_on_the_lock_and_one_arriving_after_the_deletion_write_in_turn(self):
        self.write("s-old", record(NOW - RETENTION - timedelta(days=2), session_id="s-old"))
        lock_inode = (self.reports / "s-old.lock").stat().st_ino
        log = self.root / "hooks.log"
        env = dict(os.environ, LAT_REPORTS_DIR=str(self.reports))
        hooks = {}

        def start(name, hold):
            hooks[name] = subprocess.Popen(
                [sys.executable, "-c", HOOK, str(SESSION_SCRIPT), str(log), name, str(hold)],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            )

        def logged():
            return log.read_text().splitlines() if log.exists() else []

        def wait_for(line):
            deadline = time.monotonic() + 10
            while line not in logged():
                self.assertLess(time.monotonic(), deadline, f"no {line!r} in {logged()}")
                time.sleep(0.02)

        real = self.core._report_expired
        calls = []

        def checked(path, now):
            calls.append(path.name)
            if len(calls) == 2:
                # Prune holds the lock: the first hook arrives and has to wait on it.
                start("first", 1.0)
                wait_for("first start")
                time.sleep(0.5)
                self.assertIsNone(hooks["first"].poll())
                self.assertNotIn("first in-lock", logged())
            return real(path, now)

        with mock.patch.object(self.core, "_report_expired", checked):
            self.assertEqual(self.prune()[0], ["s-old"])

        # The first hook gets the lock once the old file is gone, and writes a new one.
        wait_for("first in-lock")
        start("second", 0)
        time.sleep(0.5)
        # The second hook arrived after the deletion and waits while the first holds the lock.
        self.assertIsNone(hooks["second"].poll())
        self.assertNotIn("second in-lock", logged())
        self.assertEqual(len((self.reports / "s-old.jsonl").read_text().splitlines()), 1)

        for name, hook in hooks.items():
            _, stderr = hook.communicate(timeout=10)
            self.assertEqual(hook.returncode, 0, f"{name}: {stderr}")
        events = logged()
        self.assertLess(events.index("first in-lock"), events.index("second in-lock"))
        written = [json.loads(line) for line in (self.reports / "s-old.jsonl").read_text().splitlines()]
        self.assertEqual([item["summary"] for item in written], ["first", "second"])
        self.assertEqual((self.reports / "s-old.lock").stat().st_ino, lock_inode)


class CommandTests(PruneTestCase):
    def board(self, *args, code=0):
        result = subprocess.run(
            [sys.executable, str(MODULE), "board", "prune-reports", *map(str, args)],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, code, result.stderr + result.stdout)
        return json.loads(result.stdout)

    def test_prints_the_deleted_session_ids_for_the_time_the_board_passes(self):
        self.write("s-old", record(NOW - RETENTION))
        self.write("s-young", record(NOW - timedelta(days=29)))
        now = NOW.isoformat().replace("+00:00", "Z")

        self.assertEqual(self.board("--reports-dir", self.reports, "--now", now, "--session-id", "s-old", "--session-id", "s-young"), {"status": "ok", "deleted": ["s-old"], "failed": []})
        self.assertEqual(self.board("--reports-dir", self.reports, "--now", now, "--session-id", "s-old"), {"status": "ok", "deleted": [], "failed": []})
        self.assertTrue(self.exists("s-young"))
        self.assertTrue(self.exists("s-old", ".lock"))

    def test_a_missing_directory_deletes_nothing(self):
        self.assertEqual(
            self.board("--reports-dir", self.root / "none", "--now", NOW.isoformat(), "--session-id", "s-old"),
            {"status": "ok", "deleted": [], "failed": []},
        )

    def test_the_sessions_must_be_named(self):
        self.write("s-old", record(NOW - RETENTION))
        result = subprocess.run(
            [sys.executable, str(MODULE), "board", "prune-reports", "--reports-dir", str(self.reports), "--now", NOW.isoformat()],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertTrue(self.exists("s-old"))

    def test_a_time_without_a_zone_is_refused(self):
        self.write("s-old", record(NOW - RETENTION))
        result = self.board("--reports-dir", self.reports, "--now", "2026-06-01T12:00:00", "--session-id", "s-old", code=1)
        self.assertEqual(result["status"], "error")
        self.assertTrue(self.exists("s-old"))


if __name__ == "__main__":
    unittest.main()
