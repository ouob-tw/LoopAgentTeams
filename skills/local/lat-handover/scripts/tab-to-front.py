#!/usr/bin/env python3
"""Move a Herdr tab to the front of its workspace through the Herdr socket.

Usage: tab-to-front.py <tab_id>

Prints one result line. Exit 0 when the tab was moved, 1 when it was not (the line says why),
2 on a usage error. Herdr's command line has no tab-move command, so this speaks to the socket.
"""
import json
import os
import socket
import sys
import time
from pathlib import Path

REQUEST_ID = 'lat-handover'
TIMEOUT_SECONDS = 5


def socket_path():
    if os.environ.get('HERDR_SOCKET_PATH'):
        return os.environ['HERDR_SOCKET_PATH']
    config = os.environ.get('XDG_CONFIG_HOME', '')
    if not os.path.isabs(config):  # a relative value is ignored, as the board does
        config = str(Path.home() / '.config')
    return str(Path(config) / 'herdr' / 'herdr.sock')


def move_to_front(tab_id, path):
    """Return None when Herdr moved the tab, else the reason it did not."""
    request = json.dumps({'id': REQUEST_ID, 'method': 'tab.move',
                          'params': {'tab_id': tab_id, 'insert_index': 0}}) + '\n'
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            deadline = time.monotonic() + TIMEOUT_SECONDS
            client.settimeout(TIMEOUT_SECONDS)
            client.connect(path)
            client.sendall(request.encode())
            buffer = b''
            while True:
                # One JSON object per line; lines that answer some other request are skipped.
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    try:
                        body = json.loads(line)
                    except ValueError:
                        return '回應不是預期的 JSON'
                    if not isinstance(body, dict) or body.get('id') != REQUEST_ID:
                        continue
                    if 'result' in body:
                        return None
                    error = body.get('error')
                    message = error.get('message') if isinstance(error, dict) else None
                    return message or '回應裡沒有結果'
                client.settimeout(max(deadline - time.monotonic(), 0.001))
                chunk = client.recv(4096)
                if not chunk:
                    return '連線在回應前就關閉了'
                buffer += chunk
    except socket.timeout:
        return '逾時沒有回應'
    except OSError as error:
        return f'連不上 Herdr socket（{path}）：{error}'


def main(argv):
    if len(argv) != 2 or not argv[1]:
        print('用法：tab-to-front.py <tab_id>', file=sys.stderr)
        return 2
    reason = move_to_front(argv[1], socket_path())
    if reason is None:
        print(f'已把分頁 {argv[1]} 移到工作區最前面')
        return 0
    print(f'移動分頁 {argv[1]} 失敗：{reason}')
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
