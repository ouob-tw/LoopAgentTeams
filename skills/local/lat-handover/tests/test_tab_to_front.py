import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/tab-to-front.py'


def load():
    spec = importlib.util.spec_from_file_location('tab_to_front', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHerdr:
    """A unix-socket server that records requests and answers with canned lines."""

    def __init__(self, directory, replies):
        self.path = os.path.join(directory, 'herdr.sock')
        self.replies = replies
        self.requests = []
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.path)
        self.server.listen(1)
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        connection, _ = self.server.accept()
        with connection:
            data = b''
            while b'\n' not in data:
                data += connection.recv(4096)
            self.requests.append(json.loads(data.split(b'\n')[0]))
            for reply in self.replies:
                connection.sendall(reply if isinstance(reply, bytes) else (json.dumps(reply) + '\n').encode())

    def close(self):
        self.thread.join(5)
        self.server.close()


def run_tool(path, *args, env=None):
    environ = dict(os.environ, HERDR_SOCKET_PATH=path)
    environ.update(env or {})
    return subprocess.run([sys.executable, str(SCRIPT), *args], text=True, capture_output=True, env=environ)


class TabToFrontTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def fake(self, replies):
        herdr = FakeHerdr(self.tmp.name, replies)
        self.addCleanup(herdr.close)
        return herdr

    def test_sends_tab_move_to_index_zero_and_reports_success(self):
        herdr = self.fake([{'id': 'lat-handover', 'result': {'type': 'ok'}}])
        done = run_tool(herdr.path, 'wV:tRT')
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(herdr.requests, [{'id': 'lat-handover', 'method': 'tab.move',
                                           'params': {'tab_id': 'wV:tRT', 'insert_index': 0}}])
        self.assertEqual(len(done.stdout.strip().splitlines()), 1)
        self.assertIn('wV:tRT', done.stdout)

    def test_error_response_exits_nonzero_with_herdr_message(self):
        herdr = self.fake([{'id': 'lat-handover', 'error': {'code': 'tab_not_found', 'message': 'tab wV:nope not found'}}])
        done = run_tool(herdr.path, 'wV:nope')
        self.assertEqual(done.returncode, 1)
        self.assertIn('tab wV:nope not found', done.stdout)
        self.assertNotIn('Traceback', done.stdout + done.stderr)

    def test_skips_lines_for_other_requests_before_the_answer(self):
        herdr = self.fake([{'id': 'someone-else', 'result': {}}, {'id': 'lat-handover', 'result': {}}])
        self.assertEqual(run_tool(herdr.path, 'wV:tRT').returncode, 0)

    def test_answer_without_result_or_error_message_is_a_failure(self):
        herdr = self.fake([{'id': 'lat-handover'}])
        done = run_tool(herdr.path, 'wV:tRT')
        self.assertEqual(done.returncode, 1)
        self.assertIn('回應裡沒有結果', done.stdout)

    def test_non_json_reply_is_a_failure(self):
        herdr = self.fake([b'not json\n'])
        done = run_tool(herdr.path, 'wV:tRT')
        self.assertEqual(done.returncode, 1)
        self.assertIn('不是預期的 JSON', done.stdout)

    def test_connection_closed_before_answer_is_a_failure(self):
        herdr = self.fake([])
        done = run_tool(herdr.path, 'wV:tRT')
        self.assertEqual(done.returncode, 1)
        self.assertIn('關閉', done.stdout)

    def test_unreachable_socket_exits_nonzero_without_traceback(self):
        done = run_tool(os.path.join(self.tmp.name, 'missing.sock'), 'wV:tRT')
        self.assertEqual(done.returncode, 1)
        self.assertIn('連不上', done.stdout)
        self.assertNotIn('Traceback', done.stdout + done.stderr)

    def test_missing_tab_id_is_a_usage_error(self):
        done = run_tool(os.path.join(self.tmp.name, 'x.sock'))
        self.assertEqual(done.returncode, 2)
        self.assertNotIn('Traceback', done.stderr)

    def test_non_object_line_is_skipped_and_error_without_message_falls_back(self):
        herdr = self.fake([[1, 2], {'id': 'lat-handover', 'error': 'boom'}])
        done = run_tool(herdr.path, 'wV:tRT')
        self.assertEqual(done.returncode, 1)
        self.assertIn('回應裡沒有結果', done.stdout)

    def test_answer_split_across_reads_is_assembled(self):
        line = (json.dumps({'id': 'lat-handover', 'result': {}}) + '\n').encode()
        herdr = self.fake([line[:10], line[10:]])
        self.assertEqual(run_tool(herdr.path, 'wV:tRT').returncode, 0)

    def test_silent_server_times_out(self):
        module = load()
        module.TIMEOUT_SECONDS = 0.3
        # A listening socket that never accepts or answers.
        silent = os.path.join(self.tmp.name, 'silent.sock')
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(silent)
        server.listen(1)
        self.addCleanup(server.close)
        self.assertIn('逾時', module.move_to_front('wV:tRT', silent))

    def test_empty_tab_id_is_a_usage_error(self):
        self.assertEqual(run_tool(os.path.join(self.tmp.name, 'x.sock'), '').returncode, 2)

    def test_relative_xdg_config_home_is_ignored(self):
        module = load()
        with mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': 'rel', 'HERDR_SOCKET_PATH': ''}):
            self.assertEqual(module.socket_path(), str(Path.home() / '.config/herdr/herdr.sock'))

    def test_socket_path_precedence(self):
        module = load()
        with mock.patch.dict(os.environ, {'HERDR_SOCKET_PATH': '/a.sock', 'XDG_CONFIG_HOME': '/xdg'}):
            self.assertEqual(module.socket_path(), '/a.sock')
        with mock.patch.dict(os.environ, {'XDG_CONFIG_HOME': '/xdg'}):
            os.environ.pop('HERDR_SOCKET_PATH', None)
            self.assertEqual(module.socket_path(), '/xdg/herdr/herdr.sock')
        with mock.patch.dict(os.environ, {}):
            os.environ.pop('HERDR_SOCKET_PATH', None)
            os.environ.pop('XDG_CONFIG_HOME', None)
            self.assertEqual(module.socket_path(), str(Path.home() / '.config/herdr/herdr.sock'))


if __name__ == '__main__':
    unittest.main()
