#!/usr/bin/env python3
"""Propose a new automation task to the LAT board (任務提案), and follow what becomes of it.

  task-proposal.py submit [FILE]        send the task (a JSON object; FILE, or standard input)
  task-proposal.py status ID            what the proposal's result is now
  task-proposal.py wait ID [--timeout S] wait for a result, at most S seconds (default 600, cap 3600)
  task-proposal.py withdraw ID          take back your own waiting proposal

`submit` and `withdraw` go to the board over its local socket, where the board checks which
agent sent them; `status` and `wait` only read the result files and work without the board.
Add `--json` before the subcommand for one JSON object instead of text.

Exit codes: 0 done; 1 refused, invalid or not found; 2 a usage or format error found here;
3 看板沒在執行 (or it did not answer); 4 仍在等待 when `wait` reached its limit.

Paths (the board works them out the same way): the folder is `LAT_BOARD_PROPOSALS_DIR`, else
`$XDG_STATE_HOME/lat/task-proposals` (`~/.local/state` when XDG_STATE_HOME is not set); the
socket is `LAT_BOARD_PROPOSAL_SOCKET`, else `board.sock` in that folder.

Only the standard library; run with `uv run --no-project python`.
"""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import sys
import time

PROPOSAL_ID = re.compile(r'^[a-f0-9]{12}$')
MAX_REQUEST_BYTES = 1024 * 1024
# The acceptor gives the board 30 seconds; a little more here.
ANSWER_TIMEOUT_SECONDS = 40
WAIT_DEFAULT_SECONDS = 600
WAIT_CAP_SECONDS = 3600
POLL_SECONDS = 1.0
LABELS = dict(pending='等待中', invalid='無效', withdrawn='已撤回', expired='已過期', rejected='已拒絕',
              approving='核准中', approved='已核准', **{'approve-failed': '核准失敗'})
# Statuses `wait` keeps waiting through: 核准中 becomes 已核准 or 核准失敗 soon after.
NOT_YET = ('pending', 'approving')
OFFLINE = '看板沒在執行'


class Done(Exception):
    def __init__(self, code, text, value):
        super().__init__(text)
        self.code, self.text, self.value = code, text, value


def state_home():
    given = os.environ.get('XDG_STATE_HOME', '')
    return Path(given) if given and os.path.isabs(given) else Path.home() / '.local/state'


def given_path(name, default):
    value = os.environ.get(name, '')
    return Path(value) if value and os.path.isabs(value) else default


def socket_path():
    return given_path('LAT_BOARD_PROPOSAL_SOCKET', proposals_dir() / 'board.sock')


def proposals_dir():
    return given_path('LAT_BOARD_PROPOSALS_DIR', state_home() / 'lat/task-proposals')


def proposal_id(value):
    if not PROPOSAL_ID.match(value):
        raise argparse.ArgumentTypeError('提案編號是 12 個小寫英數字（0-9、a-f）')
    return value


def ask_board(request):
    """The board's one-line answer to one request, or Done(3) when no board takes it."""
    data = (json.dumps(request, ensure_ascii=False) + '\n').encode()
    if len(data) > MAX_REQUEST_BYTES:
        raise Done(2, f'提案太大：最多 {MAX_REQUEST_BYTES // 1024} KB', dict(ok=False, error='too-large'))
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(ANSWER_TIMEOUT_SECONDS)
    try:
        connection.connect(str(socket_path()))
    except (FileNotFoundError, ConnectionRefusedError, NotADirectoryError):
        connection.close()
        raise Done(3, OFFLINE, dict(ok=False, error='offline', reason=OFFLINE))
    answer = b''
    try:
        connection.sendall(data)
        while b'\n' not in answer:
            chunk = connection.recv(65536)
            if not chunk:
                break
            answer += chunk
    except OSError:
        pass
    finally:
        connection.close()
    try:
        value = json.loads(answer.split(b'\n', 1)[0].decode())
        if not isinstance(value, dict):
            raise ValueError
    except (ValueError, UnicodeDecodeError):
        raise Done(3, '看板沒有回應：提案可能沒送到，稍後用 status 查不到就再送一次',
                   dict(ok=False, error='no-answer'))
    return value


def refused(reply):
    reason = reply.get('reason') or '看板拒收'
    kind = reply.get('error')
    if kind == 'refused':
        raise Done(1, f'拒收：{reason}', reply)
    if kind == 'board' and reason == '看板沒有回應':
        raise Done(3, reason, reply)
    raise Done(1, reason, reply)


def error_lines(errors):
    return ''.join(f'\n- {field}：{text}' for field, text in (errors or {}).items())


def read_task(source):
    try:
        text = sys.stdin.read() if source in (None, '-') else Path(source).read_text(encoding='utf-8')
    except (OSError, UnicodeDecodeError) as error:
        raise Done(2, f'讀不到提案：{error}', dict(ok=False, error='unreadable'))
    try:
        task = json.loads(text)
    except ValueError as error:
        raise Done(2, f'提案不是 JSON：{error}', dict(ok=False, error='not-json'))
    problems = []
    if not isinstance(task, dict):
        raise Done(2, '提案要是一個 JSON 物件，欄位和看板的「新增任務」相同', dict(ok=False, error='not-object'))
    if not isinstance(task.get('name'), str) or not task['name'].strip():
        problems.append('name：請填名稱')
    if task.get('kind') not in ('command', 'agent'):
        problems.append('kind：要是 command 或 agent')
    elif not isinstance(task.get(task['kind']), dict):
        problems.append(f'{task["kind"]}：要是一個物件')
    if problems:
        raise Done(2, '提案格式不對：' + ''.join(f'\n- {line}' for line in problems),
                   dict(ok=False, error='format', problems=problems))
    return task


def submit(args):
    task = read_task(args.file)
    reply = ask_board(dict(op='submit', proposal=task))
    if not reply.get('ok'):
        refused(reply)
    if reply.get('status') == 'invalid':
        raise Done(1, f'無效：{reply["id"]}{error_lines(reply.get("errors"))}', reply)
    raise Done(0, f'已送出：{reply["id"]}\n等使用者在看板核准；查詢結果：task-proposal.py status {reply["id"]}', reply)


def withdraw(args):
    reply = ask_board(dict(op='withdraw', id=args.id))
    if not reply.get('ok'):
        refused(reply)
    raise Done(0, f'已撤回：{args.id}', reply)


def current(proposal):
    """The proposal's status as its files say now; None when there is no such proposal."""
    folder = proposals_dir()
    try:
        result = json.loads((folder / f'{proposal}.result.json').read_text(encoding='utf-8'))
        if isinstance(result, dict) and result.get('status') in LABELS:
            return result
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        # Being rewritten (核准中 → 已核准) or broken: read again on the next look.
        return dict(status='pending', unreadable=True)
    if (folder / f'{proposal}.json').exists():
        return dict(status='pending')
    return None


def described(proposal, result):
    status = result['status']
    text = f'{LABELS[status]}：{proposal}'
    if status == 'approved' and result.get('taskId'):
        text += f'\n任務編號：{result["taskId"]}'
    if result.get('reason'):
        text += f'\n原因：{result["reason"]}'
    if status == 'invalid':
        text += error_lines(result.get('errors'))
    return text


def status(args):
    result = current(args.id)
    if result is None:
        raise Done(1, f'找不到這個提案：{args.id}', dict(ok=False, error='not-found'))
    raise Done(0, described(args.id, result), dict(result, ok=True, id=args.id))


def wait(args):
    limit = min(max(args.timeout, 0), WAIT_CAP_SECONDS)
    deadline = time.monotonic() + limit
    while True:
        result = current(args.id)
        if result is None:
            raise Done(1, f'找不到這個提案：{args.id}', dict(ok=False, error='not-found'))
        if result['status'] not in NOT_YET:
            raise Done(0, described(args.id, result), dict(result, ok=True, id=args.id))
        if time.monotonic() >= deadline:
            raise Done(4, f'仍在等待：{args.id}（等了 {limit:g} 秒）',
                       dict(result, ok=True, id=args.id, waiting=True))
        time.sleep(min(POLL_SECONDS, max(deadline - time.monotonic(), 0)))


def main(argv=None):
    parser = argparse.ArgumentParser(prog='task-proposal.py', description='向 LAT 看板提出新的自動化任務（任務提案）')
    parser.add_argument('--json', action='store_true', help='印一個 JSON 物件，不印文字')
    commands = parser.add_subparsers(dest='command', required=True)
    sent = commands.add_parser('submit', help='送出提案')
    sent.add_argument('file', nargs='?', help='提案的 JSON 檔；不給或 - 讀標準輸入')
    sent.set_defaults(run=submit)
    for name, run, text in (('status', status, '查詢結果'), ('withdraw', withdraw, '撤回自己還在等的提案')):
        command = commands.add_parser(name, help=text)
        command.add_argument('id', type=proposal_id)
        command.set_defaults(run=run)
    waiting = commands.add_parser('wait', help='等待結果')
    waiting.add_argument('id', type=proposal_id)
    waiting.add_argument('--timeout', type=float, default=WAIT_DEFAULT_SECONDS,
                         help=f'最多等幾秒（預設 {WAIT_DEFAULT_SECONDS}，上限 {WAIT_CAP_SECONDS}）')
    waiting.set_defaults(run=wait)
    args = parser.parse_args(argv)
    try:
        args.run(args)
    except Done as done:
        if args.json:
            print(json.dumps(done.value, ensure_ascii=False))
        else:
            print(done.text)
        return done.code
    return 0


if __name__ == '__main__':
    sys.exit(main())
