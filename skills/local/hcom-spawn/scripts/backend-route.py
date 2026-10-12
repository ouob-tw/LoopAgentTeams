#!/usr/bin/env python3
"""Print which side gets a simple backend task: one line, `claude: <reason>` or `gpt: <reason>`."""
import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path

CONFIG = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'hcom-spawn/config.toml'
WEEK_MINUTES = 7 * 24 * 60


def query(*command):
    done = subprocess.run(command, capture_output=True, text=True, check=True, timeout=60)
    return json.loads(done.stdout)


def claude_used():
    return float(query('claude-swap', 'status', '--json')['active']['usage']['sevenDay']['pct'])


def gpt_used():
    accounts = query('codex-multi-auth', 'limits', '--json')['accounts']
    quota = next(a for a in accounts if a.get('current'))['quota']
    return float(next(w['usedPercent'] for w in (quota['primary'], quota['secondary'])
                      if w['windowMinutes'] == WEEK_MINUTES))


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
        claude, gpt = claude_used(), gpt_used()
    except Exception as error:
        return f'claude: auto, usage query failed ({type(error).__name__})'
    side = 'gpt' if gpt < claude else 'claude'
    return f'{side}: auto, 7-day used claude {claude:g}% vs gpt {gpt:g}%'


if __name__ == '__main__':
    print(main())
