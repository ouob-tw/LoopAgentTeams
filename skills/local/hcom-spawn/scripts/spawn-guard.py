#!/usr/bin/env python3
"""PreToolUse hook: refuse `hcom N claude|codex` launches without permission, model and
effort flags; for launches it lets through, start spawn-watch.py in the background."""
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('block_broadcast', HERE / 'block-broadcast.py')
shell = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shell)

CLIENTS = ('claude', 'codex')
HCOM_VALUE_OPTIONS = {'--tag', '--terminal', '--dir', '--hcom-prompt', '--hcom-system-prompt',
                      '--device', '--name'}
EXAMPLES = {
    'claude': ('hcom 1 claude --tag <name>-<topic> --go --name <name> '
               '--model claude-opus-5-5 --effort medium --dangerously-skip-permissions'),
    'codex': ('hcom 1 codex --tag <name>-<topic> --go --name <name> '
              "--model gpt-6.1-sol -c 'model_reasoning_effort=\"medium\"' --yolo"),
}
UNREADABLE = re.compile(r'\bhcom\s+(\d+\s+)?(claude|codex)\b')
SPAWNER = re.compile(r'^[A-Za-z0-9_-]+$')


def option_value(words, index, names):
    """Value of `--opt value` or `--opt=value` at index, or None when words[index] is not one.

    A following word that is itself an option is not taken as the value: the value is ''.
    """
    word = words[index]
    for name in names:
        if word == name:
            value = words[index + 1] if index + 1 < len(words) else ''
            return '' if value.startswith('-') else value
        if word.startswith(name + '=') and name.startswith('--'):
            return word[len(name) + 1:]
    return None


def read_launch(client, args):
    """What the launch arguments set: permission flag, model, effort, plus hcom's --name,
    --tag and --go.

    None when the arguments ask for help instead of launching.
    """
    found = {'client': client, 'permission': False, 'model': '', 'effort': '', 'name': '',
             'tag': '', 'go': False}
    index = 0
    while index < len(args):
        word = args[index]
        if word in ('--help', '-h'):
            return None
        for option in ('name', 'tag'):
            value = option_value(args, index, ['--' + option])
            if value is not None:
                found[option] = value
        found['go'] |= word == '--go'
        if word.split('=', 1)[0] in HCOM_VALUE_OPTIONS:
            index += 1 if '=' in word else 2
            continue
        model = option_value(args, index, ['--model', '-m'] if client == 'codex' else ['--model'])
        if model is not None:
            found['model'] = model
        if client == 'claude':
            found['permission'] |= word == '--dangerously-skip-permissions'
            effort = option_value(args, index, ['--effort'])
            if effort is not None:
                found['effort'] = effort
        else:
            found['permission'] |= word in ('--yolo', '--dangerously-bypass-approvals-and-sandbox')
            config = option_value(args, index, ['-c', '--config'])
            if config is not None and config.startswith('model_reasoning_effort='):
                found['effort'] = config.split('=', 1)[1].strip('"\'')
        index += 1
    return found


def missing(launch):
    if launch['client'] == 'claude':
        need = [('--dangerously-skip-permissions', launch['permission']),
                ('--model <id>', launch['model']), ('--effort <level>', launch['effort'])]
    else:
        need = [('--yolo', launch['permission']), ('--model <id>', launch['model']),
                ('-c \'model_reasoning_effort="<level>"\'', launch['effort'])]
    return [flag for flag, present in need if not present]


def hcom_launch(args):
    """Launch arguments when args (the words after `hcom`) start a new claude or codex agent."""
    if args[:1] and args[0].isdigit():
        args = args[1:]
    if args[:1] and args[0] in CLIENTS:
        return read_launch(args[0], args[1:])
    return None


def launches(words):
    """Launches in one simple command; behind a wrapper or `bash -c`, look inside it too."""
    words = shell.executable(words)
    if words[0].rsplit('/', 1)[-1] not in shell.WRAPPERS | shell.SHELLS | {'hcom'}:
        return []
    found, shell_seen = [], False
    for index, word in enumerate(words):
        name = word.rsplit('/', 1)[-1]
        following = words[index + 1:]
        if name == 'hcom':
            launch = hcom_launch(following)
            return found + ([launch] if launch else [])
        shell_seen = shell_seen or name in shell.SHELLS
        shell_flag = (shell_seen and word.startswith('-') and not word.startswith('--')
                      and 'c' in word)
        if following and (shell_flag or word in ('-S', '--split-string')):
            found += [launch for inner in shell.commands(following[0])
                      for launch in launches(inner)]
    return found


def latest_event_id():
    try:
        out = subprocess.run(['hcom', 'events', '--last', '1'], capture_output=True,
                             text=True, timeout=10).stdout
        return int(json.loads(out.strip().splitlines()[-1])['id'])
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        return None


def start_watch(launch, after_id, ordinal):
    """Start spawn-watch.py for the ordinal-th launch of the command that it can tell apart
    by client (and --tag when given).

    Each run also appends after_id to runs/<spawner>, so a watcher whose launch never
    happened (a preview or a failed launch) cannot take the batch of a later command.
    """
    spawner = launch['name'] or os.environ.get('HCOM_INSTANCE_NAME', '')
    if not spawner or after_id is None or not SPAWNER.match(spawner):
        return
    state = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state')) / 'hcom-spawn'
    (state / 'runs').mkdir(parents=True, exist_ok=True)
    runs = state / 'runs' / spawner
    try:
        kept = runs.read_text().split()[-50:]
    except OSError:
        kept = []
    if str(after_id) not in kept:
        runs.write_text('\n'.join(kept + [str(after_id)]) + '\n')
    with open(state / 'watch.log', 'a') as log:
        subprocess.Popen(
            [sys.executable, str(HERE / 'spawn-watch.py'), '--spawner', spawner,
             '--tool', launch['client'], '--model', launch['model'],
             '--effort', launch['effort'], '--after-id', str(after_id),
             '--ordinal', str(ordinal)] + (['--tag', launch['tag']] if launch['tag'] else []),
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)


def main():
    try:
        command = json.load(sys.stdin).get('tool_input', {}).get('command', '')
    except (ValueError, AttributeError):
        return 0
    try:
        if isinstance(command, list):
            found = launches([str(word) for word in command])
        else:
            found = [launch for words in (shell.commands(command) if isinstance(command, str)
                                          else []) for launch in launches(words)]
    except Exception:  # unparseable text or a hook bug must not let a bad launch through
        text = ' '.join(map(str, command)) if isinstance(command, list) else str(command)
        if UNREADABLE.search(text):
            print('Blocked: could not read this hcom launch command. Rewrite it as a plain '
                  'command, e.g.:\n  ' + '\n  '.join(EXAMPLES.values()), file=sys.stderr)
            return 2
        return 0
    problems = [(launch, missing(launch)) for launch in found]
    problems = [(launch, gaps) for launch, gaps in problems if gaps]
    if problems:
        lines = [f'Blocked: this `hcom {launch["client"]}` launch is missing '
                 f'{", ".join(gaps)}. Write it like:\n  {EXAMPLES[launch["client"]]}'
                 for launch, gaps in problems]
        print('\n'.join(lines), file=sys.stderr)
        return 2
    started = [launch for launch in found if launch['go']]  # without --go hcom only previews
    if started:
        after_id = latest_event_id()
        for index, launch in enumerate(started):
            ordinal = sum(other['client'] == launch['client']
                          and (not launch['tag'] or other['tag'] == launch['tag'])
                          for other in started[:index])
            try:
                start_watch(launch, after_id, ordinal)
            except OSError as error:  # the launch itself is fine; only its check is lost
                print(f'hcom-spawn: background check not started: {error}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
