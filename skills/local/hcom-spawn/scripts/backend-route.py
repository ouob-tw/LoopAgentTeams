#!/usr/bin/env python3
"""Print who gets a simple backend task: one line `claude: <reason>` or `gpt: <reason>`,
or in auto mode a usage table of every account for the spawner to judge."""
import json
import subprocess
import sys
import time
import tomllib
from datetime import datetime
from pathlib import Path

CONFIG = Path.home() / '.config/hcom-spawn/config.toml'


def query(*command):
    result = subprocess.run(command, capture_output=True, text=True, check=True, timeout=60)
    return json.loads(result.stdout)


def span(seconds):
    days, rest = divmod(max(int(seconds), 0) // 60, 24 * 60)
    hours, minutes = divmod(rest, 60)
    if days:
        return f'{days}d{hours}h' if hours else f'{days}d'
    if hours:
        return f'{hours}h{minutes}m' if minutes else f'{hours}h'
    return f'{minutes}m'


def row(name, windows, age):
    """windows: (length in seconds, used percent, reset as epoch seconds or None)."""
    cells = [f'{span(length)} {used:g}%' + (f' resets in {span(reset - time.time())}' if reset else '')
             for length, used, reset in windows]
    return f"{name}: {', '.join(cells)}, data {span(age)} old"


def claude_rows():
    for account in query('claude-swap', 'list', '--json')['accounts']:
        windows = [(length, window['pct'],
                    'resetsAt' in window and datetime.fromisoformat(window['resetsAt']).timestamp())
                   for key, length in (('fiveHour', 5 * 3600), ('sevenDay', 7 * 86400))
                   if (window := account['usage'].get(key))]
        yield row(f"claude {account['number']}{'*' * account['active']}", windows,
                  account['usageAgeSeconds'])


def gpt_rows():
    for account in query('codex-multi-auth', 'limits', '--json')['accounts']:
        quota = account['quota']
        windows = [(window['windowMinutes'] * 60, window['usedPercent'],
                    window['resetAtMs'] and window['resetAtMs'] / 1000)
                   for window in (quota['primary'], quota['secondary']) if window['windowMinutes']]
        name = f"gpt {account['index']}{'*' * account['current']} {quota['planType']}"
        yield row(name + ' disabled' * (not account['enabled']), windows,
                  time.time() - quota['updatedAt'] / 1000)


def main():
    try:
        setting = tomllib.loads(CONFIG.read_text()).get('backend', 'auto')
    except FileNotFoundError:
        setting = 'auto'
    if setting == 'claude':
        return 'claude: backend = "claude"'
    if setting == 'split':
        return 'gpt: backend = "split"'
    if setting != 'auto':
        sys.exit(f'{CONFIG}: backend = {setting!r} is not valid; use "claude", "split" or "auto"')
    try:
        rows = [*claude_rows(), *gpt_rows()]
    except Exception as error:
        return f'claude: auto, usage query failed ({type(error).__name__})'
    return '\n'.join(['auto: you decide from the usage below (* = account in use)', *rows])


if __name__ == '__main__':
    print(main())
