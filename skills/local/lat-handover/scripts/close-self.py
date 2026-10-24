#!/usr/bin/env python3
"""Close the Herdr pane this agent runs in, or its whole tab when it is the only pane there.

Usage: close-self.py

Reads HERDR_PANE_ID, asks Herdr which tab that pane is in now (HERDR_TAB_ID goes stale once the
pane is moved to another tab, so it is never used), and closes the tab when pane_count is 1,
otherwise only the pane. Prints one result line. Exit 0 when something was closed, 1 when nothing
was closed (the line says why), 2 on a usage error.
"""
import json
import os
import subprocess
import sys

TIMEOUT_SECONDS = 10


def run_herdr(*args):
    """Run a herdr command and return its stdout, or raise RuntimeError with the reason."""
    try:
        done = subprocess.run(['herdr', *args], text=True, capture_output=True, timeout=TIMEOUT_SECONDS)
    except FileNotFoundError:
        raise RuntimeError('找不到 herdr 指令')
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'herdr {" ".join(args)} 逾時沒有回應')
    if done.returncode != 0:
        detail = (done.stdout.strip() or done.stderr.strip()).splitlines()
        raise RuntimeError(f'herdr {" ".join(args)} 失敗：{detail[0] if detail else f"結束碼 {done.returncode}"}')
    return done.stdout


def herdr(*args):
    """Return the parsed `result` of a herdr query, or raise RuntimeError with the reason."""
    try:
        body = json.loads(run_herdr(*args))
        result = body['result']
    except (ValueError, KeyError, TypeError):
        raise RuntimeError(f'herdr {" ".join(args)} 的回應不是預期的 JSON')
    if not isinstance(result, dict):
        raise RuntimeError(f'herdr {" ".join(args)} 的回應不是預期的 JSON')
    return result


def current_tab(pane_id):
    pane = herdr('pane', 'get', pane_id).get('pane')
    tab_id = pane.get('tab_id') if isinstance(pane, dict) else None
    if not tab_id or not isinstance(tab_id, str):
        raise RuntimeError(f'查不到窗格 {pane_id} 目前所在的分頁')
    return tab_id


def pane_count(tab_id):
    tab = herdr('tab', 'get', tab_id).get('tab')
    count = tab.get('pane_count') if isinstance(tab, dict) else None
    if not isinstance(count, int) or isinstance(count, bool) or count < 1:
        raise RuntimeError(f'查不到分頁 {tab_id} 的窗格數')
    return count


def main(argv):
    if len(argv) != 1:
        print('用法：close-self.py', file=sys.stderr)
        return 2
    pane_id = os.environ.get('HERDR_PANE_ID', '')
    if not pane_id:
        print('沒有 HERDR_PANE_ID，不關閉，請自行結束本對話')
        return 1
    try:
        tab_id = current_tab(pane_id)
        count = pane_count(tab_id)
        if count == 1:
            run_herdr('tab', 'close', tab_id)
            print(f'已關閉分頁 {tab_id}（只有自己一個窗格）')
        else:
            run_herdr('pane', 'close', pane_id)
            print(f'已關閉窗格 {pane_id}（分頁 {tab_id} 還有其他 {count - 1} 個窗格）')
    except RuntimeError as error:
        print(f'沒有關閉：{error}')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
