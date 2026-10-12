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


def duration(seconds):
    days, rest = divmod(max(int(seconds), 0) // 60, 24 * 60)
    hours, minutes = divmod(rest, 60)
    if days:
        return f'{days}d{hours}h' if hours else f'{days}d'
    if hours:
        return f'{hours}h{minutes}m' if minutes else f'{hours}h'
    return f'{minutes}m'


def row(name, windows, age):
    """windows: (length in seconds, used percent, reset as epoch seconds or falsy);
    age: seconds since the source fetched the data, or None."""
    cells = [f'{duration(length)} {used:g}%'
             + (f' resets in {duration(reset - time.time())}' if reset else '')
             for length, used, reset in windows]
    if age is not None:
        cells.append(f'data {duration(age)} old')
    return f"{name}: {', '.join(cells) or 'no usage data'}"


def claude_plan(organization):
    """Plan of the account Claude Code is logged in to, when it belongs to this organization."""
    try:
        oauth = json.loads((Path.home() / '.claude.json').read_text()).get('oauthAccount') or {}
    except FileNotFoundError:
        return ''
    if oauth.get('organizationUuid') != organization:
        return ''
    return oauth.get('organizationRateLimitTier') or oauth.get('organizationType') or ''


def claude_rows():
    for account in query('claude-swap', 'list', '--json')['accounts']:
        windows = [(length, window['pct'], 'resetsAt' in window
                    and datetime.fromisoformat(window['resetsAt']).timestamp())
                   for key, length in (('fiveHour', 5 * 3600), ('sevenDay', 7 * 86400))
                   if (window := (account.get('usage') or {}).get(key))]
        name = f"claude {account['number']}"
        if account['active']:
            name = f"{name}* {claude_plan(account['organizationUuid'])}".rstrip()
        yield row(name, windows, account.get('usageAgeSeconds'))


def gpt_rows():
    for account in query('codex-multi-auth', 'limits', '--json')['accounts']:
        quota = account.get('quota') or {}
        windows = [(window['windowMinutes'] * 60, window['usedPercent'],
                    window['resetAtMs'] and window['resetAtMs'] / 1000)
                   for key in ('primary', 'secondary')
                   if (window := quota.get(key)) and window['windowMinutes']]
        name = f"gpt {account['index']}{'*' * account['current']} {quota.get('planType', '')}"
        yield row(name.rstrip(), windows,
                  'updatedAt' in quota and time.time() - quota['updatedAt'] / 1000 or None)


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
