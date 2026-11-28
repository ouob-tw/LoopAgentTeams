#!/usr/bin/env python3
"""Accept task proposals on the board's local socket and verify who sent them, the way pd does.

The board starts this program and watches it (src/lib/server/task-proposals.ts); it never runs on
its own. Usage: `task-proposal-acceptor.py <socket path>`; the hcom command to list agents with is
the JSON array in `LAT_PROPOSAL_HCOM_COMMAND` (`["hcom"]` when not set).

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
5. every snapshot of the walk is taken again: a process that ended or was replaced meanwhile refuses.

Any step that fails answers `{"ok": false, "error": "refused", "reason": ...}` and nothing reaches
the board. Then the role is read from LAT's session records (never a reason to refuse here): an
active record of the agent's session with its HCOM name is `controller` (LAT 主控), no such record
`agent` (一般 Agent), a record or folder that cannot be read `unknown` (無法判斷).

Verified requests go to the board on standard output, one JSON line each with a sequence number
(`{"seq": 1, "op": ..., "proposer": {...}, ...}`); the board answers on standard input
(`{"seq": 1, "reply": {...}}`) and the reply goes back to the sender as is. Lines with `event`
(`ready`, `refused`) are for the board's log only. Standard
input closing (the board ended) ends this program and removes the socket. The socket is bound
under umask 0177, so it is 0600 from the start; by default it is in the task-proposal folder (0700).

This verifies the process that sent the request; it is not tamper-proof against another process of
the same account, as pd's own note says.

Only the standard library.
"""
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
    head, sep, tail = raw.rpartition(') ')
    fields = tail.split()
    stat_pid, comm = head.split(' (', 1)
    status = dict(line.split(':', 1) for line in status_text.splitlines() if ':' in line)
    if (not sep or int(stat_pid) != pid or int(status['Pid']) != pid
            or int(status['PPid']) != int(fields[1]) or status['Name'].strip() != comm
            or fields[0] in ('Z', 'X', 'x')):
        raise Refused('送出的程序在查證途中結束或被替換')
    return pid, int(fields[1]), int(fields[19]), comm


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


def verify(peer_pid, command):
    """The verified proposer of a connection whose peer is `peer_pid`; raises Refused."""
    agent, chain = agent_ancestor(peer_pid)
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
    recheck(chain)
    return dict(name=record['name'], client=client, pid=agent[0], startTime=agent[2],
                processId=process_id, sessionId=session_id or None, folder=folder)


def shared_lat_dir(folder):
    """Where LAT keeps the session records for `folder`: the main checkout's .lat (linked worktrees
    share it), or the folder's own .lat outside git. None when git fails in an unexpected way."""
    try:
        result = subprocess.run(['git', '-C', folder, 'rev-parse', '--path-format=absolute',
                                 '--git-common-dir'], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=GIT_TIMEOUT_SECONDS)
    except FileNotFoundError:
        return Path(folder) / '.lat'
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode == 0 and result.stdout.strip():
        return Path(result.stdout.strip()).parent / '.lat'
    # 128: not a git repository.
    return Path(folder) / '.lat' if result.returncode == 128 else None


def same_controller(stored, full_name):
    """LAT's own rule: older records may hold the base name where the full HCOM name is now."""
    return isinstance(stored, str) and bool(stored) and (stored == full_name or full_name.endswith(f'-{stored}'))


def role(proposer):
    """`controller`, `agent` or `unknown` from LAT's session record of the proposer's session."""
    session_id = proposer.get('sessionId')
    if not session_id:
        return 'agent'
    if '/' in session_id or session_id in ('.', '..'):
        return 'unknown'
    lat = shared_lat_dir(proposer['folder'])
    if lat is None:
        return 'unknown'
    paths = [lat / 'sessions' / f'{session_id}.json', Path(proposer['folder']) / '.lat/sessions' / f'{session_id}.json']
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
            and same_controller(record.get('hcom_name'), proposer['name'])):
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

    def ask(self, value):
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
            return dict(ok=False, error='board', reason='看板沒有回應')
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


def answer(connection, value):
    try:
        connection.sendall((json.dumps(value, ensure_ascii=False) + '\n').encode())
    except OSError:
        pass


def handle(connection, board, command):
    try:
        pid, uid = peer_of(connection)
        if uid != os.getuid():
            board.emit(dict(event='refused', reason='other account', peer_pid=pid))
            return answer(connection, dict(ok=False, error='refused', reason='送出的程序不是看板的系統帳號'))
        request = read_request(connection)
        op = request.get('op') if request else None
        if op not in ('submit', 'withdraw'):
            return answer(connection, dict(ok=False, error='bad-request', reason='看不懂這個請求'))
        try:
            proposer = verify(pid, command)
        except Refused as refused:
            board.emit(dict(event='refused', reason=str(refused), peer_pid=pid))
            return answer(connection, dict(ok=False, error='refused', reason=str(refused)))
        proposer['role'] = role(proposer)
        if op == 'submit':
            ask = dict(op='submit', proposer=proposer, proposal=request.get('proposal'))
        else:
            ask = dict(op='withdraw', proposer=proposer, id=request.get('id'))
        answer(connection, board.ask(ask))
    except (OSError, ValueError) as error:
        answer(connection, dict(ok=False, error='bad-request', reason=f'這個請求沒能處理：{error}'))
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
            threading.Thread(target=handle, args=(connection, board, command), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    board.emit(dict(event='ready', pid=os.getpid()))
    board.closed.wait()
    server.close()
    try:
        if path.stat().st_ino == identity:
            path.unlink()
    except OSError:
        pass


if __name__ == '__main__':
    main()
