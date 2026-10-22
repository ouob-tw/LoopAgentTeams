#!/usr/bin/env python3
"""PreToolUse hook that keeps agents from starving a shared host.

Three rules, for Claude Code (Bash, Grep, Glob) and Codex (Bash):
- whole-disk scans: find / du / grep -r / rg / fd / tree / ls -R rooted at /, /mnt,
  /media or a configured extra root are blocked;
- CPU load generators (busy loops, stress, stress-ng, sysbench cpu, yes > /dev/null)
  must run on a limited set of cores via taskset, systemd-run or cpulimit;
- an unquoted heredoc whose body holds `...` or $(...) is blocked: the shell runs those
  commands while writing what was meant as text (a brief, a message).
"""
import argparse
import copy
import difflib
import json
import os
import re
import shlex
import shutil
import sys
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).resolve()
DEFAULT_ROOTS = ('/', '/mnt', '/media')
SCRIPT_MAX_BYTES = 256 * 1024

# A command word at the start of a shell command (after ; && | ( ` a quote or a newline),
# optionally behind wrappers such as sudo or timeout; args run to the end of that command.
WRAPPERS = r'(?:(?:sudo|nice|ionice|env|xargs|exec|command|timeout\s+\S+)\s+(?:-\S+\s+)*)*'
SCAN = re.compile(r'(?:^|[;&|(`\'"\n])\s*' + WRAPPERS
                  + r'(?P<tool>find|bfs|fd|fdfind|du|rg|grep|tree|ls)\b(?P<args>[^;&|\n\'"`)]*)')
LOAD = re.compile(r'while\s+(?::|true)\s*;\s*do\s*:?\s*;?\s*done'
                  r'|(?:^|[\s;&|(`\'"])(?:stress-ng|stress)\s[^;&|\n]*?'
                  r'(?:--cpu\b|-c\s|--matrix\b|--all\b|--sequential\b)'
                  r'|\bsysbench\b[^;&|\n]*\bcpu\b'
                  r'|(?:^|[\s;&|(`\'"])yes(?:\s[^;&|\n]*)?>\s*/dev/null')
LIMIT = re.compile(r'\btaskset\b|\bcpulimit\b|\bsystemd-run\b[^\n]*(?:AllowedCPUs|CPUQuota)=')
TASKSET_LIST = re.compile(r'\btaskset\s+(?:-\S*c\S*\s+|--cpu-list\s+)(?P<list>[\d,\-]+)')
# Heredoc bodies and quoted text are data (messages, prompts), except a script after `-c`.
HEREDOC = re.compile(r'<<-?\s*([\'"]?)([A-Za-z_]\w*)\1[^\n]*\n.*?^\s*\2\s*$', re.S | re.M)
# An unquoted delimiter (`<<EOF`, not `<<'EOF'` or `<<\EOF`) lets the shell expand the body.
UNQUOTED_HEREDOC = re.compile(r'(?<!<)<<-?\s*([A-Za-z_]\w*)[^\n]*\n(.*?)^\s*\1\s*$', re.S | re.M)
SUBSTITUTION = re.compile(r'(?<!\\)(?:`|\$\()')
QUOTED = re.compile(r"""(-\w*c\s+)?('[^']*'|"(?:\\.|[^"\\])*")""")
SCRIPT_RUN = re.compile(r'(?:^|[;&|(\s])(?:(?:ba|z|da)?sh\s+(?:-\S+\s+)*)?'
                        r'(?P<path>(?:[\w.~/-]*/)?[\w.-]+\.sh)\b')

SCAN_MESSAGE = ('Blocked: this scans the whole filesystem (rooted at {root}). On a shared host '
                'that keeps large or slow disks busy for hours and slows every other agent and '
                'service. Search a narrower path instead: the project folder, a folder under '
                '$HOME, /etc, /usr or /opt. To find a program on PATH use `command -v NAME`; '
                '`find / -maxdepth 3 ...` is allowed.')
LOAD_MESSAGE = ('Blocked: this generates CPU load on every core ({where}). Other agents and '
                'services share this host. Pin the load to at most {cores} cores, for example '
                '`taskset -c 0-{last} <command>` (child processes inherit the limit, so wrapping '
                'the script that starts the load is enough), or '
                '`systemd-run --user --scope -p AllowedCPUs=0-{last} <command>`.')
HEREDOC_MESSAGE = ('Blocked: the heredoc <<{name} is unquoted and its body contains {what}, so the '
                   'shell runs that as a command while writing the text. Quote the delimiter '
                   "(<<'{name}') to keep the body literal, or write the file with the Write tool "
                   'and pass it with --file. If you meant to insert command output, run the '
                   'command into a variable first and use the variable in the heredoc.')


def config_path():
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(os.environ.get('HOST_GUARD_CONFIG') or Path(base) / 'host-guard/config.json')


def load_config():
    """Extra scan roots and the core limit; a bad or missing file falls back to defaults."""
    try:
        data = json.loads(config_path().read_text())
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    extra = [r for r in data.get('extra_scan_roots', []) if isinstance(r, str) and r.startswith('/')]
    cores = data.get('max_load_cores')
    if not isinstance(cores, int) or isinstance(cores, bool) or cores < 1:
        cores = max(1, (os.cpu_count() or 4) // 4)
    return {'roots': {r.rstrip('/') or '/' for r in (*DEFAULT_ROOTS, *extra)}, 'cores': cores}


def code_only(text):
    """Shell text with heredoc bodies and quoted data blanked; `sh -c '...'` kept."""
    text = HEREDOC.sub('', text)
    return QUOTED.sub(lambda m: m.group(0) if m.group(1) else '""', text)


def expanding_heredoc(command):
    """(delimiter, what) for the first unquoted heredoc whose body substitutes a command."""
    for match in UNQUOTED_HEREDOC.finditer(command):
        found = SUBSTITUTION.search(match.group(2))
        if found:
            return match.group(1), 'a backtick' if found.group(0) == '`' else '$('
    return None


def scan_root(command, roots):
    """The protected root a shell command scans, or None."""
    for match in SCAN.finditer(code_only(command)):
        tool, args = match.group('tool'), match.group('args')
        words = args.split()
        hit = next((w for w in words if w.startswith('/') and (w.rstrip('/') or '/') in roots), None)
        if hit is None:
            continue
        if tool == 'ls' and not re.search(r'(?:^|\s)-\w*R', args):
            continue
        if tool == 'grep' and not re.search(
                r'(?:^|\s)(?:-\w*[rR]|--recursive|--dereference-recursive)', args):
            continue
        if tool in ('find', 'bfs') and re.search(r'-maxdepth\s+[0-3]\b', args):
            continue
        return hit.rstrip('/') or '/'
    return None


def taskset_cores(text):
    """Number of cores in the first `taskset -c LIST`, or None when absent."""
    match = TASKSET_LIST.search(text)
    if not match:
        return None
    count = 0
    for part in match.group('list').split(','):
        low, _, high = part.partition('-')
        if low.isdigit():
            count += (int(high) - int(low) + 1) if high.isdigit() else 1
    return count


def unlimited_load(text, cores):
    """True when a line of text starts CPU load without a core limit (or above it)."""
    for line in code_only(text).splitlines():
        if not LOAD.search(line):
            continue
        if not LIMIT.search(line):
            return True
        used = taskset_cores(line)
        if used is not None and used > cores:
            return True
    return False


def called_scripts(command, cwd):
    """Readable shell scripts a command runs, with their text."""
    found = []
    for match in SCRIPT_RUN.finditer(command):
        path = Path(os.path.expanduser(match.group('path')))
        path = path if path.is_absolute() else Path(cwd) / path
        try:
            if path.is_file() and path.stat().st_size <= SCRIPT_MAX_BYTES:
                found.append((str(path), path.read_text(errors='replace')))
        except OSError:
            continue
    return found


def load_problem(command, cwd, cores):
    """Where unlimited CPU load starts, or None."""
    limited_outside = LIMIT.search(command) and (taskset_cores(command) or 0) <= cores
    if unlimited_load(command, cores):
        return 'in this command'
    if limited_outside:
        return None  # the whole command, scripts included, already runs on few cores
    for path, text in called_scripts(command, cwd):
        if unlimited_load(text, cores):
            return f'in {path}'
    return None


def shell_text(command):
    if isinstance(command, list):
        return command[-1] if command[:1] and command[0].endswith('sh') else ' '.join(command)
    return command if isinstance(command, str) else ''


def cmd_hook():
    try:
        payload = json.load(sys.stdin)
        tool_input = payload.get('tool_input') or {}
    except (ValueError, AttributeError):
        return 0  # nothing to read; never leave the agent stuck
    config = load_config()
    if payload.get('tool_name') in ('Grep', 'Glob'):
        path = tool_input.get('path')
        root = (path.rstrip('/') or '/') if isinstance(path, str) and path else None
        if root in config['roots']:
            print(SCAN_MESSAGE.format(root=root), file=sys.stderr)
            return 2
        return 0
    command = shell_text(tool_input.get('command'))
    cwd = payload.get('cwd') or os.getcwd()
    root = scan_root(command, config['roots'])
    if root:
        print(SCAN_MESSAGE.format(root=root), file=sys.stderr)
        return 2
    heredoc = expanding_heredoc(command)
    if heredoc:
        print(HEREDOC_MESSAGE.format(name=heredoc[0], what=heredoc[1]), file=sys.stderr)
        return 2
    where = load_problem(command, cwd if os.path.isdir(cwd) else os.getcwd(), config['cores'])
    if where:
        cores = config['cores']
        print(LOAD_MESSAGE.format(where=where, cores=cores, last=cores - 1), file=sys.stderr)
        return 2
    return 0


# ---------------------------------------------------------------- install

HOOK_COMMAND = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'hook'])
GROUP_NAME = 'host-guard'
BACKUP_PREFIX = '.host-guard-backup-'
MATCHER = {'claude': 'Bash|Grep|Glob', 'codex': 'Bash'}


def is_hook_handler(handler):
    """A handler running some copy of this script's hook, wherever it is installed."""
    if not isinstance(handler, dict) or not isinstance(handler.get('command'), str):
        return False
    try:
        words = shlex.split(handler['command'])
    except ValueError:
        return False
    return any(os.path.basename(word) == SCRIPT.name for word in words) \
        and words[-1:] == ['hook']


def settings_path(client, claude_settings, codex_home):
    if client == 'codex':
        home = codex_home or os.environ.get('CODEX_HOME') or '~/.codex'
        return Path(home).expanduser().resolve() / 'hooks.json'
    if claude_settings:
        return Path(claude_settings).expanduser().resolve()
    home = os.environ.get('CLAUDE_CONFIG_DIR') or '~/.claude'
    return Path(home).expanduser().resolve() / 'settings.json'


def updated_config(config, client, action):
    """A copy of config with this hook installed or removed under PreToolUse."""
    if not isinstance(config, dict) or not isinstance(config.get('hooks', {}), dict):
        raise ValueError('expected a JSON object whose "hooks" is an object')
    updated = copy.deepcopy(config)
    if action == 'uninstall' and 'PreToolUse' not in updated.get('hooks', {}):
        return updated
    events = updated.setdefault('hooks', {})
    groups = events.setdefault('PreToolUse', [])
    if not isinstance(groups, list) or any(not isinstance(g, dict) for g in groups):
        raise ValueError('expected PreToolUse to be a list of matcher groups')
    for group in groups:
        if 'hooks' in group and not isinstance(group['hooks'], list):
            raise ValueError('expected every PreToolUse group to hold a "hooks" list')
    mine = [(group, handler) for group in groups for handler in group.get('hooks', [])
            if is_hook_handler(handler)]
    if action == 'install':
        handler = {'type': 'command', 'command': HOOK_COMMAND}
        if len(mine) > 1:
            raise ValueError('the host-guard hook is listed more than once; inspect the file')
        if mine:
            group, existing = mine[0]
            existing.update(handler)  # a moved skill gets the new path; other fields stay
            if all(is_hook_handler(h) for h in group['hooks']):
                group['matcher'] = MATCHER[client]
        else:
            group = {'matcher': MATCHER[client], 'hooks': [handler]}
            if client == 'codex':
                group = {'name': GROUP_NAME, **group}
            groups.append(group)
        return updated
    for group, handler in mine:
        group['hooks'].remove(handler)
    emptied = [group for group, _ in mine
               if not group['hooks'] and set(group) <= {'name', 'matcher', 'hooks'}]
    groups[:] = [g for g in groups if not any(g is e for e in emptied)]
    if not groups:
        del events['PreToolUse']
    return updated


def cmd_configure(action, client, claude_settings, codex_home, preview):
    path = settings_path(client, claude_settings, codex_home)
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    config = json.loads(original) if original is not None else {}
    updated = updated_config(config, client, action)
    if updated == config:
        print(f'No changes: {path}')
        return 0
    before = original.decode() if original is not None else ''
    after = json.dumps(updated, indent=2, ensure_ascii=False) + '\n'
    diff = ''.join(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
                                        fromfile=str(path), tofile=str(path)))
    if preview:
        print(diff, end='')
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_bytes() if path.exists() else None
    if current != original:
        raise ValueError(f'{path} changed while it was being read; retry')
    if original is not None:
        with tempfile.NamedTemporaryFile(prefix=path.name + BACKUP_PREFIX, dir=path.parent,
                                         delete=False) as backup:
            backup.write(original)
        print(f'Backup: {backup.name}')
    with tempfile.NamedTemporaryFile('w', prefix=path.name + '.', dir=path.parent,
                                     delete=False) as tmp:
        tmp.write(after)
    if original is not None:
        shutil.copymode(path, tmp.name)
    os.replace(tmp.name, path)
    print(diff, end='')
    if client == 'codex':
        print(f'Updated {path}; restart Codex and trust the hook in /hooks')
    else:
        print(f'Updated {path}; restart Claude Code and confirm the hook in /hooks')
    return 0


# ---------------------------------------------------------------- entry

def main(argv=None):
    parser = argparse.ArgumentParser(prog='host-guard.py', description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='action', required=True)
    sub.add_parser('hook', help='PreToolUse hook for Claude and Codex; reads the payload on stdin')
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action} the hook in a client\'s settings')
        config.add_argument('--client', choices=('claude', 'codex'), required=True)
        config.add_argument('--claude-settings', metavar='PATH',
                            help='default: $CLAUDE_CONFIG_DIR/settings.json or '
                                 '~/.claude/settings.json')
        config.add_argument('--codex-home', metavar='DIR', help='default: $CODEX_HOME or ~/.codex')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    args = parser.parse_args(argv)
    if args.action == 'hook':
        return cmd_hook()
    try:
        return cmd_configure(args.action, args.client, args.claude_settings,
                             args.codex_home, args.preview)
    except (OSError, ValueError) as exc:
        print(f'host-guard: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
