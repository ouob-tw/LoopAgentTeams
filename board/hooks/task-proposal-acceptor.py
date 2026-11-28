#!/usr/bin/env python3
"""Accept task proposals on the board's local socket and verify who sent them, the way pd does.

The board starts this program and watches it (src/lib/server/task-proposals.ts); it never runs on
its own. Usage: `task-proposal-acceptor.py <socket path>`; the hcom command to list agents with is
the JSON array in `LAT_PROPOSAL_HCOM_COMMAND` (`["hcom"]` when not set), and the LAT skill folder
whose `scripts/_lat_common.py` gives LAT's own rules for its session records is
`LAT_PROPOSAL_LAT_DIR` (the board's `latDir`).

Each connection to the socket sends one JSON line, `{"op": "submit", "proposal": {...}}` or
`{"op": "withdraw", "id": "..."}`, and gets one JSON line back. Before anything reaches the board
the sender is verified, starting from SO_PEERCRED of this accepted connection, never from a PID or
name the sender gives:

1. the peer's account must be this program's (the board's) account;
2. walking up the parents from the peer, the first process named `claude` or `codex` is the agent;
   each step is a snapshot of /proc/<pid>/stat and status (PID, parent, start time, name);
3. its environment gives the HCOM name, client and process ID (`HCOM_INSTANCE_NAME`, `HCOM_TOOL`,
   `HCOM_PROCESS_ID`); the client must be the process's own name;
4. `hcom list --json` must hold exactly one agent with that process ID, of that client, whose name
   or base name is the environment's name; its name is the verified HCOM name;
5. the role is read from LAT's session records (never a reason to refuse here): an active record
   of the agent's session with its HCOM name is `controller` (LAT 主控), no such record `agent`
   (一般 Agent), a record, folder or LAT install that cannot be read `unknown` (無法判斷);
6. every snapshot of the walk is taken again, last, right before the request is handed on: a
   process that ended or was replaced meanwhile refuses. The peer's own snapshot is taken as soon
   as the connection is accepted, before its request is read, and the walk must start from it.

Any step that fails answers `{"ok": false, "error": "refused", "reason": ...}` and nothing reaches
the board.

Verified requests go to the board on standard output, one JSON line each with a sequence number
(`{"seq": 1, "op": ..., "proposer": {...}, ...}`); the board answers on standard input
(`{"seq": 1, "reply": {...}}`) and the reply goes back to the sender as is; a board that does not
answer in 30 seconds gets the sender `{"ok": false, "error": "board-timeout", ...}`. Lines with `event`
(`ready`, `refused`, and `lat-rules-unavailable`, after which every role is `unknown`) are for the
board's log only. Standard
input closing (the board ended) ends this program and removes the socket. The socket is bound
under umask 0177, so it is 0600 from the start; by default it is in the task-proposal folder (0700).

This verifies the process that sent the request; it is not tamper-proof against another process of
the same account, as pd's own note says.

Only the standard library.
"""
import importlib.util
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import sys
import threading

AGENT_NAMES = ('claude', 'codex')
MAX_REQUEST_BYTES = 1024 * 1024
HCOM_TIMEOUT_SECONDS = 5
GIT_TIMEOUT_SECONDS = 5
# How long one sender may take to send its request, and the board to answer it.
REQUEST_TIMEOUT_SECONDS = 10
BOARD_TIMEOUT_SECONDS = 30
SESSION_ENV = dict(claude='CLAUDE_CODE_SESSION_ID', codex='CODEX_THREAD_ID')
ENDED = ('ended', 'completed', 'cancelled')


class Refused(Exception):
    """The sender could not be verified; the message is told to it."""


def snapshot(pid):
    """(pid, parent, start time, name) of a live process, read twice over /proc so it agrees with itself."""
    try:
        raw = (Path('/proc') / str(pid) / 'stat').read_bytes().decode()
        status_text = (Path('/proc') / str(pid) / 'status').read_bytes().decode()
    except OSError:
        raise Refused('送出的程序在查證途中結束或被替換')
    try:
        head, sep, tail = raw.rpartition(') ')
        fields = tail.split()
        stat_pid, comm = head.split(' (', 1)
        status = dict(line.split(':', 1) for line in status_text.splitlines() if ':' in line)
        consistent = (sep and int(stat_pid) == pid and int(status['Pid']) == pid
                      and int(status['PPid']) == int(fields[1]) and status['Name'].strip() == comm
                      and fields[0] not in ('Z', 'X', 'x'))
        taken = pid, int(fields[1]), int(fields[19]), comm
    except (ValueError, KeyError, IndexError):
        consistent = False
    if not consistent:
        raise Refused('送出的程序在查證途中結束或被替換')
    return taken


def recheck(chain):
    for taken in reversed(chain):
        try:
            again = snapshot(taken[0])
        except Refused:
            again = None
        if again != taken:
            raise Refused('送出的程序在查證途中結束或被替換')


def agent_ancestor(pid):
    chain = []
    seen = set()
    while pid > 0 and pid not in seen and len(chain) < 256:
        seen.add(pid)
        taken = snapshot(pid)
        chain.append(taken)
        if taken[3] in AGENT_NAMES:
            return taken, chain
        pid = taken[1]
    raise Refused('找不到送出它的 Claude 或 Codex 程序：請在 Agent 裡執行這個指令')


def environment(pid):
    try:
        raw = (Path('/proc') / str(pid) / 'environ').read_bytes()
    except OSError:
        raise Refused('讀不到送出它的 Agent 的環境變數')
    return {key.decode(errors='replace'): value.decode(errors='replace')
            for key, value in (part.split(b'=', 1) for part in raw.split(b'\0') if b'=' in part)}


def label(value):
    return (isinstance(value, str) and 0 < len(value) <= 128
            and not any(ord(c) < 32 or ord(c) == 127 for c in value))


def hcom_command():
    given = os.environ.get('LAT_PROPOSAL_HCOM_COMMAND')
    if not given:
        return ['hcom']
    command = json.loads(given)
    if not isinstance(command, list) or not command or not all(isinstance(p, str) for p in command):
        raise SystemExit('LAT_PROPOSAL_HCOM_COMMAND must be a JSON array of strings')
    return command


def hcom_records(command):
    try:
        result = subprocess.run([*command, 'list', '--json'], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=HCOM_TIMEOUT_SECONDS)
        records = json.loads(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        records = None
    if not isinstance(records, list):
        raise Refused('讀不到 hcom 的名單，無法查證 HCOM 名稱')
    return [record for record in records if isinstance(record, dict)]


def hcom_record(command, env_name, client, process_id):
    matches = [record for record in hcom_records(command)
               if isinstance(record.get('launch_context'), dict)
               and record['launch_context'].get('process_id') == process_id]
    if len(matches) != 1:
        raise Refused(f'HCOM 名稱對不上：hcom 的名單裡沒有 {env_name} 這個程序')
    record = matches[0]
    if not label(record.get('name')) or env_name not in (record.get('name'), record.get('base_name')):
        raise Refused(f'HCOM 名稱對不上：{env_name} 和 hcom 名單裡的名稱不同')
    if record.get('tool') not in (None, client):
        raise Refused(f'HCOM 名稱對不上：hcom 名單裡的 {record["name"]} 不是 {client}')
    return record


def verify(peer, command, lat):
    """The verified proposer of a connection whose peer was `peer` (its snapshot when the connection
    was accepted); raises Refused."""
    agent, chain = agent_ancestor(peer[0])
    if chain[0] != peer:
        raise Refused('送出的程序在查證途中結束或被替換')
    recheck(chain)
    env = environment(agent[0])
    env_name, client, process_id = (env.get(key, '') for key in
                                    ('HCOM_INSTANCE_NAME', 'HCOM_TOOL', 'HCOM_PROCESS_ID'))
    if not label(env_name):
        raise Refused('這個 Agent 沒有 HCOM 名稱：請在 hcom 啟動的 Agent 裡執行')
    if client != agent[3]:
        raise Refused(f'HCOM 記錄的 client（{client or "沒有"}）和送出的程序（{agent[3]}）不符')
    if not label(process_id):
        raise Refused('這個 Agent 沒有 HCOM 程序 ID，無法對到 hcom 的名單')
    try:
        folder = os.readlink(f'/proc/{agent[0]}/cwd')
    except OSError:
        raise Refused('送出的程序在查證途中結束或被替換')
    record = hcom_record(command, env_name, client, process_id)
    session_id = record.get('session_id') if label(record.get('session_id')) else env.get(SESSION_ENV[client], '')
    proposer = dict(name=record['name'], client=client, pid=agent[0], startTime=agent[2],
                    processId=process_id, sessionId=session_id or None, folder=folder)
    proposer['role'] = role(proposer, lat)
    recheck(chain)
    return proposer


def lat_rules():
    """LAT's own `_lat_common` (where a folder's session records are, which stored name is the
    controller's), from the board's LAT skill folder; None when it cannot be loaded."""
    folder = os.environ.get('LAT_PROPOSAL_LAT_DIR', '')
    path = Path(folder) / 'scripts/_lat_common.py'
    try:
        spec = importlib.util.spec_from_file_location('_lat_common', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module if callable(getattr(module, 'shared_lat_dir', None)) and callable(getattr(module, 'same_controller', None)) else None
    except Exception:  # noqa: BLE001 - no LAT install leaves every role unknown
        return None


def checkout_top(folder):
    """The top of the git checkout or worktree `folder` is in, as LAT's records name workspaces;
    the folder itself outside git."""
    try:
        result = subprocess.run(['git', '-C', folder, 'rev-parse', '--show-toplevel'], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS)
    except (OSError, subprocess.TimeoutExpired):
        return folder
    top = result.stdout.strip()
    return top if result.returncode == 0 and top else folder


def role(proposer, lat):
    """`controller`, `agent` or `unknown` from LAT's session record of the proposer's session, found
    the way LAT finds it (the shared .lat, then an older one in the folder's own .lat)."""
    session_id = proposer.get('sessionId')
    if not session_id:
        return 'agent'
    if lat is None or '/' in session_id or session_id in ('.', '..'):
        return 'unknown'
    top = checkout_top(proposer['folder'])
    try:
        shared = Path(lat.shared_lat_dir(top))
    except Exception:  # noqa: BLE001 - git failing in an unexpected way
        return 'unknown'
    paths = [shared / 'sessions' / f'{session_id}.json', Path(top) / '.lat/sessions' / f'{session_id}.json']
    found = None
    for path in paths:
        try:
            if path.exists():
                found = path
                break
            if path.parent.exists() and not os.access(path.parent, os.R_OK | os.X_OK):
                return 'unknown'
        except OSError:
            return 'unknown'
    if found is None:
        return 'agent'
    try:
        record = json.loads(found.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return 'unknown'
    if not isinstance(record, dict) or not isinstance(record.get('status'), str):
        return 'unknown'
    if (record['status'] == 'active' and record.get('session_id') == session_id
            and isinstance(record.get('hcom_name'), str) and record['hcom_name']
            and lat.same_controller(record['hcom_name'], proposer['name'])):
        return 'controller'
    return 'agent'


class Board:
    """The pipe to the board: requests out on standard output, replies in on standard input."""

    def __init__(self):
        self.lock = threading.Lock()
        self.waiting = {}
        self.seq = 0
        self.closed = threading.Event()

    def emit(self, value):
        line = json.dumps(value, ensure_ascii=False) + '\n'
        with self.lock:
            sys.stdout.write(line)
            sys.stdout.flush()

    def forward(self, value):
        """Hand a verified request to the board and wait for its reply."""
        done = threading.Event()
        box = {}
        with self.lock:
            self.seq += 1
            seq = self.seq
            self.waiting[seq] = (done, box)
        self.emit(dict(value, seq=seq))
        if not done.wait(BOARD_TIMEOUT_SECONDS):
            with self.lock:
                self.waiting.pop(seq, None)
            return dict(ok=False, error='board-timeout', reason='看板沒有回應')
        return box['reply']

    def read_replies(self):
        for line in sys.stdin:
            try:
                value = json.loads(line)
                seq, reply = value['seq'], value['reply']
            except (ValueError, KeyError, TypeError):
                continue
            with self.lock:
                entry = self.waiting.pop(seq, None)
            if entry:
                entry[1]['reply'] = reply
                entry[0].set()
        self.closed.set()


def peer_of(connection):
    creds = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    pid, uid, _gid = struct.unpack('3i', creds)
    return pid, uid


def read_request(connection):
    connection.settimeout(REQUEST_TIMEOUT_SECONDS)
    data = b''
    while b'\n' not in data:
        chunk = connection.recv(65536)
        if not chunk:
            break
        data += chunk
        if len(data) > MAX_REQUEST_BYTES:
            return None
    try:
        value = json.loads(data.split(b'\n', 1)[0].decode())
    except (ValueError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def reply_to_sender(connection, value):
    try:
        connection.sendall((json.dumps(value, ensure_ascii=False) + '\n').encode())
    except OSError:
        pass


def handle(connection, board, command, lat):
    """Take the sender's snapshot at once, read its request, verify it, and hand it straight on."""
    try:
        pid, uid = peer_of(connection)
        if uid != os.getuid():
            board.emit(dict(event='refused', reason='other account', peer_pid=pid))
            return reply_to_sender(connection, dict(ok=False, error='refused', reason='送出的程序不是看板的系統帳號'))
        try:
            peer = snapshot(pid)
        except Refused as refused:
            board.emit(dict(event='refused', reason=str(refused), peer_pid=pid))
            return reply_to_sender(connection, dict(ok=False, error='refused', reason=str(refused)))
        request = read_request(connection)
        op = request.get('op') if request else None
        if op not in ('submit', 'withdraw'):
            return reply_to_sender(connection, dict(ok=False, error='bad-request', reason='看不懂這個請求'))
        try:
            proposer = verify(peer, command, lat)
        except Refused as refused:
            board.emit(dict(event='refused', reason=str(refused), peer_pid=pid))
            return reply_to_sender(connection, dict(ok=False, error='refused', reason=str(refused)))
        if op == 'submit':
            forwarded = dict(op='submit', proposer=proposer, proposal=request.get('proposal'))
        else:
            forwarded = dict(op='withdraw', proposer=proposer, id=request.get('id'))
        reply_to_sender(connection, board.forward(forwarded))
    except (OSError, ValueError) as error:
        reply_to_sender(connection, dict(ok=False, error='bad-request', reason=f'這個請求沒能處理：{error}'))
    finally:
        connection.close()


def listen(path):
    # A folder made here is the board's own (0700); one that is there already is left as it is.
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists() or path.is_symlink():
        if not stat.S_ISSOCK(path.lstat().st_mode):
            raise SystemExit(f'{path} is not a socket; refusing to replace it')
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(str(path))
            raise SystemExit(f'another acceptor already listens on {path}')
        except (ConnectionRefusedError, FileNotFoundError):
            path.unlink(missing_ok=True)
        finally:
            probe.close()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    try:
        server.bind(str(path))
    finally:
        os.umask(old)
    os.chmod(path, 0o600)
    server.listen(16)
    return server


def main():
    if len(sys.argv) != 2:
        raise SystemExit('usage: task-proposal-acceptor.py <socket path>')
    path = Path(sys.argv[1])
    command = hcom_command()
    lat = lat_rules()
    server = listen(path)
    board = Board()
    threading.Thread(target=board.read_replies, daemon=True).start()
    identity = path.stat().st_ino

    def accept():
        while True:
            try:
                connection, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=handle, args=(connection, board, command, lat), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    board.emit(dict(event='ready', pid=os.getpid()))
    if lat is None:
        board.emit(dict(event='lat-rules-unavailable', lat_dir=os.environ.get('LAT_PROPOSAL_LAT_DIR', '')))
    board.closed.wait()
    server.close()
    try:
        if path.stat().st_ino == identity:
            path.unlink()
    except OSError:
        pass


if __name__ == '__main__':
    main()
