#!/usr/bin/env python3
"""Host-wide full-suite gate.

`run [--rerun "<reason>"] -- <cmd>` reuses a passing result for identical content, lets
only one of several identical requests run, and starts a queued full suite when the host has
room for its measured peak (with a floor, a cap and a pressure brake); in a project with an
affected-test map it needs a purpose. After each full suite that ran it checks whether the
project is due for a test cleanup and opens or updates a cleanup ticket; `cleanup-done
[--command <cmd> [--baseline <s>]]` starts a new cleanup window. `affected [--base <rev>]`
runs only the tests the map selects for this change, or the registered full suites through
the gate when the change leaves the map. `status` lists running and queued suites, why the
queue waits, recent records and cleanup state. `is_full_suite()`
decides whether a shell command is a full suite run (project registry first, then the
default runner rules). `hook` is the PreToolUse hook that blocks full suites run outside
the gate (with an affected-test map it points at `affected` instead), and `install` /
`uninstall --client claude|codex` add or remove it. `pre-push` is the Git pre-push check
that refuses pushing main or a tag without a passing record of every registered full
suite; `install-pre-push` / `uninstall-pre-push --repo <dir>` add or remove it.

Linux only: each suite runs in its own systemd user scope (cgroup v2), and slot and lock
holders stay counted while that group has processes. Without a user scope the suite runs
in a new session instead, which is then what counts. Once a holder's gate has been seen gone
for `reclaim_grace_seconds`, the next gate that reads the state stops what is left and frees
the slot.
"""
import argparse
import contextlib
import copy
import difflib
import fcntl
import fnmatch
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

REGISTRY_NAME = '.suite-gate.json'
MAP_DIR = '.suite-gate.d'  # more affected.map rules, one file per topic
DEFAULTS = {'min_slots': 2, 'max_slots': 8, 'poll_seconds': 1.0, 'report_seconds': 30.0,
            'sample_seconds': 2.0, 'brake_io_high': 40.0, 'brake_io_low': 20.0,
            'brake_cpu_high': 50.0, 'brake_cpu_low': 25.0, 'default_cores': 4.0,
            'default_mem_gb': 4.0, 'mem_reserve_gb': 8.0, 'profile_history': 5,
            'reclaim_grace_seconds': 600.0}
# The smallest value each key accepts; an int default takes whole numbers only.
MINIMUMS = {'min_slots': 0, 'max_slots': 1, 'profile_history': 1, 'poll_seconds': 0.01,
            'report_seconds': 0.01, 'sample_seconds': 0.01}
BRAKE_PAIRS = (('brake_io_low', 'brake_io_high'), ('brake_cpu_low', 'brake_cpu_high'))
GIB = 2 ** 30
CPU_WINDOW_SECONDS = 10.0
WORKTREE_PLACEHOLDER = '<worktree>'
TAIL_LINES = 20
TAIL_BYTES = 8192
KILL_GRACE_SECONDS = 5.0
RECLAIM_HISTORY = 10  # reclaim records kept in the shared state
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
FALLBACK_NOTE = ('running the suite in a new session instead; its usage is not measured and '
                 'processes it starts in another session are not counted')
PROFILE_UNMEASURED = {'cpu_peak_cores': None, 'cpu_avg_cores': None, 'cpu_seconds': None,
                      'mem_peak_bytes': None, 'sample_seconds': None, 'fallback': True,
                      'leftover_processes': None}
LAUNCHER = 'read -r go <&3 || exit 125; exec 3<&-; exec "$@"'
# In a scope: report readiness on fd 5, wait for go on fd 3, then leave a keeper reading fd 4
# in the group (its pid goes to fd 5), so the group outlives the suite until the gate has
# read the final counters and closes fd 4. `exec` drops the keeper's copies of the output
# pipes for good (a redirected builtin would keep saved copies open).
SCOPE_LAUNCHER = ('echo ready >&5; read -r go <&3 || exit 125; exec 3<&-; '
                  '(exec </dev/null >/dev/null 2>&1 5>&-; read -r _ <&4) & echo $! >&5; '
                  'exec 4<&- 5>&-; exec "$@"')


# ---------------------------------------------------------------- locations and config

def state_dir():
    if os.environ.get('SUITE_GATE_STATE_DIR'):
        return Path(os.environ['SUITE_GATE_STATE_DIR'])
    base = os.environ.get('XDG_STATE_HOME') or str(Path.home() / '.local/state')
    return Path(base) / 'suite-gate'


def reaper_log():
    """The LAT service reaper's record of the processes it ended (lat-reap.py); may not exist."""
    state = os.environ.get('XDG_STATE_HOME', '')
    base = Path(state) if state.startswith('/') else Path.home() / '.local/state'
    return base / 'lat/reaper/closed.jsonl'


# Results lat-reap logs for a process it really ended; the other results (gone before the
# signal, a signalling error, still running after SIGKILL) are not kills.
REAPED_RESULTS = ('exited after SIGTERM', 'killed')
# lat-reap writes its records only after it has waited out the whole signalled batch, up to
# its grace period (10 s) and the kill wait, so a failed run looks for them this long.
REAP_WAIT_SECONDS = 12.0


def reaped_after_failure(cwd, since, until):
    """reaped_during, retried for a short window: the records may land after the suite exits."""
    try:
        wait = float(os.environ.get('SUITE_GATE_REAP_WAIT', REAP_WAIT_SECONDS))
    except ValueError:
        wait = REAP_WAIT_SECONDS
    deadline = time.monotonic() + wait
    while True:
        found = reaped_during(cwd, since, until)
        if found or time.monotonic() >= deadline:
            return found
        time.sleep(0.25)


def reaped_during(cwd, since, until):
    """The processes the reaper ended between since and until that ran in or under cwd."""
    try:
        lines = reaper_log().read_text(errors='replace').splitlines()
    except OSError:
        return []
    root, found = str(cwd), []
    for line in lines:
        try:
            entry = json.loads(line)
            moment = datetime.fromisoformat(entry['time'])
        except (ValueError, KeyError, TypeError):
            continue
        where = entry.get('cwd')
        if 'pid' not in entry or not isinstance(where, str) or moment.tzinfo is None:
            continue
        if entry.get('result') not in REAPED_RESULTS:
            continue
        if since <= moment <= until and (where == root or where.startswith(root + '/')):
            found.append({key: entry.get(key) for key in
                          ('time', 'pid', 'command', 'agent', 'why', 'signal', 'result')})
    return found


def config_path():
    if os.environ.get('SUITE_GATE_CONFIG'):
        return Path(os.environ['SUITE_GATE_CONFIG'])
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(base) / 'suite-gate/config.json'


def load_config():
    """The config file over the defaults. A value it cannot use (wrong type, out of range, a
    brake low mark above its high mark) keeps the default with a warning; read on every poll."""
    config = dict(DEFAULTS)
    path = config_path()
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return config
    except (OSError, ValueError) as exc:
        warn_once(f'ignoring unreadable config {path}: {exc}')
        return config
    if not isinstance(data, dict):
        warn_once(f'ignoring config {path}: expected a JSON object')
        return config
    for key, default in DEFAULTS.items():
        if key not in data:
            continue
        value = data[key]
        try:
            number = isinstance(value, (int, float)) and not isinstance(value, bool) \
                and math.isfinite(value) \
                and (not isinstance(default, int) or float(value).is_integer())
        except OverflowError:  # an integer too large for a float
            number = False
        if number and value >= MINIMUMS.get(key, 0):
            config[key] = type(default)(value)
        else:
            warn_once(f'config {key}={json.dumps(value)} is not usable; using {default}')
    for low, high in BRAKE_PAIRS:
        if config[low] > config[high]:
            warn_once(f'config {low} ({config[low]}) is above {high} ({config[high]}); '
                      f'using {DEFAULTS[low]} and {DEFAULTS[high]}')
            config[low], config[high] = DEFAULTS[low], DEFAULTS[high]
    return config


def warn(text):
    print(f'suite-gate: {text}', file=sys.stderr, flush=True)


_warned = set()


def warn_once(text):
    """warn, but only the first time this process sees the text (the config is reread on
    every poll)."""
    if text not in _warned:
        _warned.add(text)
        warn(text)


def agent_name():
    name = os.environ.get('HCOM_INSTANCE_NAME')
    if name:
        tag = os.environ.get('HCOM_TAG')
        return f'{tag}-{name}' if tag else name
    for var, client in (('CLAUDE_CODE_SESSION_ID', 'claude'), ('CODEX_THREAD_ID', 'codex')):
        if os.environ.get(var):
            return f'{client}:{os.environ[var]}'
    return 'unknown'


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds')


# ---------------------------------------------------------------- full-suite detection

OPERATORS = ('<<<', '&&', '||', ';;', '|&', '>>', '<<-', '<<', '&>', '>&', '<&', '>|',
             ';', '&', '|', '(', ')', '<', '>', '\n')
REDIRECTS = {'<<<', '>>', '<<-', '<<', '&>', '>&', '<&', '>|', '<', '>'}
SHELLS = {'sh', 'bash', 'zsh', 'dash'}
HEREDOCS = {'<<', '<<-'}

# Per runner: options that take a separate value, and options that narrow the run.
RUNNERS = {
    'pytest': {
        'value': {'-n', '-p', '-c', '-o', '--tb', '--maxfail', '--durations', '--rootdir',
                  '--basetemp', '-W', '--junitxml', '--cov', '--cov-report', '--log-level',
                  '--ignore', '--ignore-glob', '--confcutdir', '--timeout', '--dist',
                  '--import-mode', '--capture', '-r'},
        'filter': {'-k', '-m', '--deselect', '--lf', '--last-failed'},
    },
    'unittest': {'value': set(), 'filter': {'-k'}},
    'unittest-discover': {'value': {'-s', '--start-directory', '-t', '--top-level-directory'},
                          'filter': {'-k', '-p', '--pattern'}},
    'bun-test': {'value': {'--timeout', '--preload', '--rerun-each', '--coverage-reporter',
                           '--coverage-dir', '--reporter', '--reporter-outfile'},
                 'filter': {'-t', '--test-name-pattern'}},
    'vitest': {'value': {'-c', '--config', '--reporter', '--pool', '--dir', '-r', '--root',
                         '--environment', '--project', '--outputFile', '--mode'},
               'filter': {'-t', '--testNamePattern', '--shard'}},
    'jest': {'value': {'-c', '--config', '--reporters', '--maxWorkers', '-w', '--rootDir',
                       '--outputFile', '--testTimeout'},
             'filter': {'-t', '--testNamePattern', '--testPathPattern', '--testPathPatterns',
                        '--selectProjects', '--findRelatedTests', '-o', '--onlyChanged'}},
    'playwright': {'value': {'-c', '--config', '--project', '-j', '--workers', '--reporter',
                             '--retries', '--timeout', '--output', '--repeat-each'},
                   'filter': {'-g', '--grep', '--grep-invert', '--shard', '--only-changed',
                              '--last-failed'}},
    'go': {'value': {'-count', '-timeout', '-p', '-parallel', '-tags', '-coverprofile', '-cpu',
                     '-o', '-exec', '-covermode', '-coverpkg', '-shuffle'},
           'filter': {'-run', '-skip', '-bench'}},
    'cargo': {'value': {'--features', '-F', '--target', '--manifest-path', '-j', '--jobs',
                        '--profile', '--color', '-Z'},
              'filter': {'-p', '--package', '--test', '--bin', '--example', '--bench', '--lib',
                         '--doc', '--bins', '--tests', '--examples', '--benches', '--exact',
                         '--skip'}},
    # npm/pnpm/yarn/bun run test: extra arguments go to the project's own runner.
    'script': {'value': {'--workspace', '-w', '--prefix', '-C', '--dir'},
               'filter': {'--filter', '-F', '-t', '--testNamePattern', '-g', '--grep'}},
}

UV_VALUE = {'--with', '--with-requirements', '--python', '-p', '--project', '--directory',
            '--package', '--extra', '--group', '--env-file', '--index', '--default-index',
            '--with-editable', '--only-group', '--no-group', '--cache-dir'}
WRAP_VALUE = {'timeout': {'-s', '--signal', '-k', '--kill-after'}, 'nice': {'-n'},
              'env': {'-u', '--unset', '-C', '--chdir'}}


def _operator_at(text, i):
    return next((op for op in OPERATORS if text.startswith(op, i)), None)


def _tokens(text):
    """(value, is_operator, start, end) for each word and operator of shell text.

    Quotes and backslashes are removed from word values; `#` at the start of a word
    begins a comment up to the end of the line. Each heredoc body (`<<EOF` up to the
    `EOF` line) follows its line's newline as one token ((body as written, expands),
    None, start, end); expands is False when the delimiter is quoted (`<<'EOF'`).
    ValueError on an unclosed quote.
    """
    tokens, pending, i, n = [], [], 0, len(text)
    while i < n:
        if text[i] in ' \t\r':
            i += 1
        elif text.startswith('\\\n', i):
            i += 2
        elif text[i] == '#':
            end = text.find('\n', i)
            i = n if end < 0 else end
        elif _operator_at(text, i):
            op = _operator_at(text, i)
            tokens.append((op, True, i, i + len(op)))
            i += len(op)
            if op == '\n' and pending:
                i = _heredoc_bodies(text, i, pending, tokens)
        else:
            start, value = i, []
            while i < n and text[i] not in ' \t\r' and not _operator_at(text, i):
                c = text[i]
                if c == '\\':
                    if text[i + 1:i + 2] != '\n':
                        value.append(text[i + 1:i + 2])
                    i += 2
                elif c == "'":
                    end = text.find("'", i + 1)
                    if end < 0:
                        raise ValueError('unclosed quote')
                    value.append(text[i + 1:end])
                    i = end + 1
                elif c == '"':
                    i += 1
                    while i < n and text[i] != '"':
                        if text[i] == '\\' and text[i + 1:i + 2] in ('"', '\\', '$', '`'):
                            i += 1
                        value.append(text[i])
                        i += 1
                    if i >= n:
                        raise ValueError('unclosed quote')
                    i += 1
                else:
                    value.append(c)
                    i += 1
            if tokens and tokens[-1][1] and tokens[-1][0] in HEREDOCS:
                pending.append((''.join(value), tokens[-1][0] == '<<-',
                                not any(c in text[start:i] for c in '\'"\\')))
            tokens.append((''.join(value), False, start, i))
    return tokens


def _heredoc_bodies(text, i, pending, tokens):
    """Append a body token for each pending (delimiter, strip_tabs, expands), reading the
    lines from i up to the delimiter line; return the index after the last delimiter line."""
    for delimiter, strip_tabs, expands in pending:
        start = i
        while i < len(text):
            end = text.find('\n', i)
            end = len(text) if end < 0 else end
            line = text[i:end]
            if (line.lstrip('\t') if strip_tabs else line) == delimiter:
                tokens.append(((text[start:i], expands), None, start, i))
                i = min(end + 1, len(text))
                break
            i = end + 1
        else:
            tokens.append(((text[start:], expands), None, start, len(text)))
            i = len(text)
    pending.clear()
    return i


def _simple_commands(text):
    """(words, spans, heredocs, sep, depth) for each simple command, without opening `sh -c`.

    Redirections (`2>&1`, `> out`) are dropped with their target; spans are each word's
    (start, end) in text; heredocs are the (body, expands, stdin, start, end) of the
    command's `<<` redirections, stdin False for another descriptor (`3<<EOF`) or when a
    later `<` replaces it; sep is the
    operator that ends the command (`|`, `;`, `\\n`, ...) and depth how many parentheses it
    is nested in. ValueError on an unclosed quote.
    """
    commands, words, spans, heredocs = [], [], [], []
    waiting = []  # [heredocs, stdin] of commands whose bodies follow the line
    drop_next, depth = False, 0
    for value, is_operator, start, end in _tokens(text) + [('\n', True, len(text), len(text))]:
        if is_operator is None:
            if waiting:
                target, stdin = waiting.pop(0)
                target.append((value[0], value[1], stdin, start, end))
        elif is_operator and value in REDIRECTS:
            fd = None
            if words and words[-1].isdigit() and spans[-1][1] == start:
                fd = words.pop()  # the file descriptor of `2>`
                spans.pop()
            if value in HEREDOCS:
                waiting.append([heredocs, fd in (None, '0')])
            elif value in ('<', '<&') and fd in (None, '0'):
                for entry in waiting:
                    entry[1] = entry[1] and entry[0] is not heredocs
            drop_next = True
        elif is_operator:
            if words:
                commands.append((words, spans, heredocs, value, depth))
            words, spans, heredocs, drop_next = [], [], [], False
            depth = depth + 1 if value == '(' else max(depth - (value == ')'), 0)
        elif drop_next:
            drop_next = False
        else:
            words.append(value)
            spans.append((start, end))
    return commands


def split_commands(command):
    """Simple commands a shell string runs, as word lists.

    `sh -c '...'` and text fed to a shell's stdin (`bash <<EOF`, `cat <<EOF | bash`,
    `echo '...' | sh`) are opened up; a heredoc fed to any other command (`cat > f <<EOF`)
    runs only its `$(...)` when the delimiter is unquoted. `$G` is read as G's
    suite-gate.py path when an earlier command of the string assigns it. Newlines separate
    commands, redirections (`2>&1`, `> out`) are dropped with their target, and `#` at the
    start of a word starts a comment up to the end of the line.
    """
    try:
        found = _simple_commands(command)
    except ValueError:
        found = [(command.split(), [], [], '\n', 0)]
    commands, piped = [], []
    for words, (_, _, heredocs, sep, _) in zip(_gate_variables(found), found):
        stdin = _stdin_heredoc(heredocs) or piped
        commands += _open_shell(words, heredocs, stdin)
        piped = _piped_text(words, stdin) if sep in ('|', '|&') else []
    return commands


def _stdin_heredoc(heredocs):
    """The heredoc a command reads on stdin, as a list of at most one: the last `<<` to 0."""
    return [heredoc for heredoc in heredocs if heredoc[2]][-1:]


class UnreadableShellInput(ValueError):
    """Text the shell runs that the hook does not read: piped echo/printf text with a `%d`
    or `%b` form or an escape other than `\\n`, or a heredoc `$(...)` holding quotes or
    backslashes. The command counts as a full suite."""


def _piped_text(words, stdin):
    """What a command writes to a pipe, as heredocs: the text of echo/printf, or its stdin
    for `cat` without files; a body of None is text that cannot be rendered. Other commands
    count as writing nothing a shell would run."""
    words = _strip_assignments(words)
    head = os.path.basename(words[0]) if words else ''
    if head in ('echo', 'printf'):
        args = words[1:]
        while head == 'echo' and args and args[0].startswith('-'):
            args = args[1:]
        form = ' '.join(args) if head == 'echo' else args[0] if args else ''
        if re.search(r'\\[^n]|%[^s%]', form) or head == 'echo' and form.endswith('\\'):
            return [(None, True, True, 0, 0)]
        text = form if head == 'echo' else _printf(form, args[1:])
        return [(text.replace('\\n', '\n'), True, True, 0, 0)]
    if head == 'cat' and all(word.startswith('-') for word in words[1:]):
        return stdin
    return []


def _printf(form, args):
    """What printf prints for a form of only `%s`, `%%` and `\\n`: each `%s` takes the next
    argument, and the form repeats while arguments are left."""
    args, out = list(args), []
    while True:
        taken = []

        def fill(match):
            if match.group() == '%%':
                return '%'
            taken.append(1)
            return args.pop(0) if args else ''
        out.append(re.sub(r'%%|%s', fill, form))
        if not args or not taken:
            return ''.join(out)


def _gate_variables(commands):
    """The words of _simple_commands' commands with `$G`/`${G}` replaced by G's value where
    an earlier command of the same shell only assigns G (`G=/path/suite-gate.py`) and the
    value is a suite-gate.py path; assignments in a subshell, pipeline or background job
    (`(...)`, either side of `|`, `&`) do not count."""
    known, resolved, after = {}, [], None
    for words, _, _, sep, depth in commands:
        if words and not _strip_assignments(words) and not depth \
                and sep not in ('|', '|&', '&') and after not in ('|', '|&'):
            for word in words:
                name, value = word.split('=', 1)
                if os.path.basename(value) == SCRIPT.name:
                    known[name] = value
                else:
                    known.pop(name, None)
        resolved.append([next((value for name, value in known.items()
                               if word in (f'${name}', f'${{{name}}}')), word)
                         for word in words])
        after = sep
    return resolved


# Commands that never run their arguments: a test command in them is only text.
TEXT_COMMANDS = {'echo', 'printf', 'gh', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'head',
                 'tail', 'wc', 'less', 'jq', 'tee'}
TEXT_SUBCOMMANDS = {'hcom': {'send'}, 'git': {'commit', 'log', 'grep', 'show'}}


def _carries_text(words):
    """True for a command whose arguments are only text (TEXT_COMMANDS, hcom send, ...)."""
    words = _strip_assignments(words)
    head = os.path.basename(words[0]) if words else ''
    return head in TEXT_COMMANDS or words[1:2] in [[sub] for sub in
                                                    TEXT_SUBCOMMANDS.get(head, ())]


def _reads_stdin_script(words):
    """True when words start a shell that runs its stdin, such as `bash` or `sh -s`."""
    words = _strip_assignments(words)
    while words and (inner := _strip_launcher(words)) is not None:
        words = inner
    if not words or os.path.basename(words[0]) not in SHELLS:
        return False
    i = _skip_options(words, 1, {'-o', '-O'})
    return i == len(words) or words[i] == '/dev/stdin' or any(
        word.startswith('-') and not word.startswith('--') and 's' in word[1:]
        for word in words[1:i])


def _shell_body_index(words):
    """Index of the `-c` text when words run a shell such as `bash -lc '<text>'`, else None."""
    skip = len(words) - len(_strip_assignments(words))
    rest = words[skip:]
    if rest and os.path.basename(rest[0]) in SHELLS:
        for i, word in enumerate(rest[1:], 1):
            if word == '-c' or (word.startswith('-') and not word.startswith('--')
                                and 'c' in word[1:]):
                return skip + i + 1 if i + 1 < len(rest) else None
    return None


def _open_shell(words, heredocs=(), stdin=()):
    """The commands words run, given its heredocs and the heredocs it reads on stdin.

    UnreadableShellInput when a shell reads text, or a heredoc holds a substitution, that
    cannot be read."""
    index = _shell_body_index(words)
    if index is not None:
        opened = split_commands(words[index])
    elif _reads_stdin_script(words):
        if any(body is None for body, *_ in stdin):
            raise UnreadableShellInput('unreadable text piped into a shell')
        opened = [inner for body, *_ in stdin for inner in split_commands(body)]
    else:
        opened = [words]
    # The shell runs the `$(...)` and backticks of an unquoted heredoc before the command
    # reads it, whatever quotes surround them in the body.
    return opened + [inner for body, expands, *_ in heredocs if expands
                     for text in _substitutions(body) for inner in split_commands(text)]


def _substitutions(text):
    """The text inside each `$(...)` and backtick pair of a heredoc body the shell expands.

    UnreadableShellInput when one holds a quote or backslash, which can move its end."""
    found, i = [], 0
    while i < len(text):
        if text.startswith('$(', i):
            depth, j = 1, i + 2
            while j < len(text) and depth:
                depth += {'(': 1, ')': -1}.get(text[j], 0)
                j += 1
            found.append(text[i + 2:j - 1 if depth == 0 else j])
            i = j
        elif text[i] == '`':
            j = text.find('`', i + 1)
            j = len(text) if j < 0 else j
            found.append(text[i + 1:j])
            i = j + 1
        else:
            i += 2 if text[i] == '\\' else 1
    if any(c in inner for inner in found for c in '\'"\\'):
        raise UnreadableShellInput('quotes or escapes in a heredoc substitution')
    return found


def _strip_assignments(words):
    i = 0
    while i < len(words) and '=' in words[i] and not words[i].startswith('-') \
            and words[i].split('=', 1)[0].replace('_', 'a').isalnum():
        i += 1
    return words[i:]


def _skip_options(words, start, value_options):
    """Index of the first non-option word from start, skipping known option values."""
    i = start
    while i < len(words) and words[i].startswith('-'):
        if words[i] == '--':
            return i + 1
        if words[i] in value_options:
            i += 1
        i += 1
    return i


def _strip_launcher(words):
    """words after a leading time/timeout/nice/env/command/exec/xvfb-run, or None."""
    head = os.path.basename(words[0])
    if head not in WRAP_VALUE and head not in ('time', 'command', 'exec', 'xvfb-run'):
        return None
    i = _skip_options(words, 1, WRAP_VALUE.get(head, set()))
    if head == 'timeout' and i < len(words):
        i += 1  # the duration
    return _strip_assignments(words[i:])


def _unwrap(words):
    """Strip env assignments and launcher words; return (runner, args) or None."""
    words = _strip_assignments(words)
    while words:
        head = os.path.basename(words[0])
        if (inner := _strip_launcher(words)) is not None:
            words = inner
        elif head == 'uv' and words[1:2] == ['run']:
            words = words[_skip_options(words, 2, UV_VALUE):]
        elif head in ('poetry', 'pipenv', 'pdm', 'hatch', 'rye') and words[1:2] == ['run']:
            words = words[_skip_options(words, 2, set()):]
        elif head in ('npx', 'bunx', 'pnpx'):
            words = words[_skip_options(words, 1, {'-p', '--package'}):]
        elif head in ('pnpm', 'npm') and words[1:2] in (['exec'], ['dlx']):
            words = words[_skip_options(words, 2, set()):]
        elif head.startswith('python') and len(words) > 2 and words[1] == '-m':
            module = words[2]
            if module == 'pytest':
                return 'pytest', words[3:]
            if module == 'unittest':
                if words[3:4] == ['discover']:
                    return 'unittest-discover', words[4:]
                return 'unittest', words[3:]
            return None
        else:
            break
    if not words:
        return None
    head, rest = os.path.basename(words[0]), words[1:]
    if head in ('pytest', 'py.test'):
        return 'pytest', rest
    if head == 'jest':
        return 'jest', rest
    if head == 'vitest':
        return 'vitest', rest[1:] if rest[:1] in (['run'], ['watch']) else rest
    if head == 'playwright' and rest[:1] == ['test']:
        return 'playwright', rest[1:]
    if head == 'bun' and rest[:1] == ['test']:
        return 'bun-test', rest[1:]
    if head == 'go' and rest[:1] == ['test']:
        return 'go', rest[1:]
    if head == 'cargo' and rest[:1] == ['test']:
        return 'cargo', rest[1:]
    if head in ('npm', 'pnpm', 'yarn', 'bun'):
        i = _skip_options(words, 1, RUNNERS['script']['value'])
        via_run = words[i:i + 1] == ['run']
        i += via_run
        if words[i:i + 1] in (['test'], ['t']) and (head != 'bun' or via_run):
            return 'script', [w for w in words[1:i] if w != 'run'] + words[i + 1:]
    return None


def _is_targeted(runner, args):
    rules = RUNNERS[runner]
    positional = 0
    i = 0
    while i < len(args):
        word = args[i]
        if word == '--':
            i += 1
            continue
        if word.startswith('-') and word != '-':
            name = word.split('=', 1)[0]
            if name in rules['filter'] or (len(name) > 2 and not name.startswith('--')
                                           and name[:2] in rules['filter']):
                return True
            if name in rules['value'] and '=' not in word:
                i += 1
        else:
            positional += 1
            if runner == 'go' and (word == './...' or word.endswith('/...')
                                   and word.count('/') == 1):
                pass
            elif runner == 'unittest-discover' and positional == 1:
                pass  # the start directory; a second positional is the pattern
            else:
                return True
        i += 1
    return False


def load_registry(cwd):
    """The project registry (repo root `.suite-gate.json`) as a dict, or None."""
    root = repo_root(Path(cwd))
    if root is None:
        return None
    path = root / REGISTRY_NAME
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        warn(f'ignoring unreadable registry {path}: {exc}')
        return None
    if not isinstance(data, dict):
        return None
    try:
        add_map_files(root, data)
    except (OSError, ValueError) as exc:
        # Still a mapped project: hook and run keep their rules, affected stops on this.
        data['map_error'] = str(exc)
    return data


def add_map_files(root, data):
    """Append the rules of each .suite-gate.d/*.json ({"map": [...]}), in name order, to
    affected.map, so parallel work adds its own file instead of editing the same lines."""
    for path in sorted((root / MAP_DIR).glob('*.json')):
        try:
            rules = json.loads(path.read_text()).get('map')
        except AttributeError:
            rules = None
        except ValueError as exc:
            raise ValueError(f'{path}: {exc}') from None
        affected = data.setdefault('affected', {})
        if not isinstance(rules, list) or not isinstance(affected, dict) \
                or not isinstance(affected.setdefault('map', []), list):
            raise ValueError(f'{path} must be {{"map": [...]}} and affected.map a list')
        for i, rule in enumerate(rules):
            if not isinstance(rule, dict):
                raise ValueError(f'{path}: map[{i}] must be {{"paths": [...], "tests": [...]}}')
            _strings(rule.get('paths'), f'{path}: map[{i}].paths', allow_empty=False)
            _strings(rule.get('tests'), f'{path}: map[{i}].tests')
        affected['map'].extend(rules)


def _normalize_words(words):
    return ' '.join(words)


def is_full_suite(command, cwd='.', registry=None):
    """True when a shell command runs a full suite.

    With a registry that lists `suites`, only those patterns (fnmatch, whitespace
    normalized) count; otherwise a known test runner with no file, path or filter
    argument counts as full, and so does text piped into a shell that cannot be rendered
    (`printf '%b' ... | sh`). The arguments of echo, printf, hcom send and gh are text, not
    commands. Pass `registry` to skip reading it from cwd.
    """
    if registry is None:
        registry = load_registry(cwd) or {}
    patterns = registry.get('suites') if isinstance(registry, dict) else None
    try:
        commands = split_commands(command)
    except UnreadableShellInput:
        return True
    runs = [words for words in commands if not _carries_text(words)]
    if isinstance(patterns, list) and patterns:
        normalized = [p for p in (_normalize_pattern(p) for p in patterns if isinstance(p, str))
                      if p]
        # A command that only carries text (echo, hcom send) counts only for a pattern that
        # names its first word, not for one whose leading wildcard takes the text in.
        named = [p for p in normalized if p[0] not in '*?[']
        candidates = [(_normalize_words(_strip_assignments(w)),
                       named if _carries_text(w) else normalized) for w in commands]
        candidates.append((_normalize_words([w for c in runs for w in c]), normalized))
        candidates.append((_normalize_words([w for c in commands for w in c]), named))
        return any(fnmatch.fnmatchcase(c, p) for c, found in candidates for p in found)
    for words in runs:
        found = _unwrap(words)
        if found and not _is_targeted(*found):
            return True
    return False


def _normalize_pattern(pattern):
    """A registry pattern read the same way as the command it is matched against."""
    return _normalize_words([w for c in split_commands(pattern) for w in c])


# ---------------------------------------------------------------- content fingerprint

def git(args, cwd, env=None):
    return subprocess.run(['git', *args], cwd=cwd, env=env, capture_output=True, text=True)


def repo_root(cwd):
    result = git(['rev-parse', '--show-toplevel'], cwd)
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return Path(result.stdout.strip())


def content_tree(root, include=(), commit=None):
    """Tree hash of tracked plus unignored new files (or of commit's tree when given), plus
    the `include` paths from the work tree, via a throwaway index so the real one is
    untouched."""
    with tempfile.TemporaryDirectory(prefix='suite-gate-') as tmp:
        index = Path(tmp) / 'index'
        env = dict(os.environ, GIT_INDEX_FILE=str(index))
        if commit:
            steps = [['read-tree', commit]]
        else:
            real = git(['rev-parse', '--git-path', 'index'], root).stdout.strip()
            if real and (root / real).is_file():
                # copy2 keeps the index mtime, which Git needs to re-check racily clean entries
                shutil.copy2(root / real, index)
            steps = [['add', '-A', '--', '.']]
        extra = sorted({str(p.relative_to(root)) for pattern in include
                        for p in root.glob(pattern) if p.is_file()})
        if extra:
            steps.append(['add', '-f', '--', *extra])
        for step in steps:
            result = git(step, root, env)
            if result.returncode != 0:
                raise RuntimeError(f'git {" ".join(step[:2])} failed: {result.stderr.strip()}')
        result = git(['write-tree'], root, env)
        if result.returncode != 0:
            raise RuntimeError(f'git write-tree failed: {result.stderr.strip()}')
        return result.stdout.strip()


def normalize_command(argv):
    """The command text: a shell string keeps its own text, since quoting and expansion
    change what runs; split arguments are quoted back into one string. The fingerprint
    also keeps the mode, because sh and a direct exec can run the same text differently."""
    if len(argv) == 1:
        return argv[0].strip()
    return shlex.join(argv)


def include_patterns(registry):
    return [p for p in registry.get('fingerprint_include') or [] if isinstance(p, str)]


def digest(tree, argv, rel):
    mode = 'shell' if len(argv) == 1 else 'exec'
    command = normalize_command(argv)
    return hashlib.sha256(f'{tree}\0{mode}\0{command}\0{rel}'.encode()).hexdigest()


def rel_cwd(root, cwd):
    return os.path.relpath(Path(cwd).resolve(), root.resolve())


def fingerprint(cwd, argv):
    """Dict with fingerprint, tree, repo, relative cwd and profile key; None outside a Git
    work tree."""
    root = repo_root(cwd)
    if root is None:
        return None
    tree = content_tree(root, include_patterns(load_registry(cwd) or {}))
    rel = rel_cwd(root, cwd)
    return {'fingerprint': digest(tree, argv, rel), 'tree': tree, 'repo': str(root),
            'rel_cwd': rel, 'profile_key': profile_key(root, rel, normalize_command(argv))}


def profile_key(root, rel, command):
    """What a suite's measured usage is filed under: the repository (the Git common dir its
    worktrees share), the cwd relative to the worktree, and the command with the worktree's
    absolute path replaced, so every worktree of a repo shares it and other repos do not."""
    common = git(['rev-parse', '--git-common-dir'], root).stdout.strip()
    for path in sorted({str(root), str(root.resolve())}, key=len, reverse=True):
        command = re.sub(re.escape(path) + r'(?![\w.-])', WORKTREE_PLACEHOLDER, command)
    return {'repo': str((root / common).resolve()) if common else str(root.resolve()),
            'rel_cwd': rel, 'command': command}


# ---------------------------------------------------------------- process liveness

def proc_stat(pid):
    """(state, session id, start time) of a process, or None."""
    try:
        raw = Path(f'/proc/{pid}/stat').read_text()
    except (OSError, ValueError):
        return None
    fields = raw[raw.rindex(')') + 2:].split()
    return fields[0], int(fields[3]), int(fields[19])


def pid_alive(pid, start):
    stat = proc_stat(pid)
    return stat is not None and stat[0] != 'Z' and stat[2] == start


def session_pids(sid):
    pids = []
    for entry in os.listdir('/proc'):
        if entry.isdigit():
            stat = proc_stat(entry)
            if stat and stat[1] == sid and stat[0] != 'Z':
                pids.append(int(entry))
    return pids


def gate_alive(holder):
    return not holder.get('gate_done') and pid_alive(holder['pid'], holder['start'])


def holder_alive(holder):
    """The gate runs, or the suite's group (its session, for a holder without one) has
    processes."""
    if gate_alive(holder):
        return True
    if holder.get('cgroup'):
        return bool(cgroup_pids(holder['cgroup']))
    return bool(holder.get('sid')) and bool(session_pids(holder['sid']))


def _wait_until(done, child):
    deadline = time.monotonic() + KILL_GRACE_SECONDS
    while time.monotonic() < deadline:
        if child:
            child.poll()
        if done():
            return True
        time.sleep(0.05)
    return False


def end_session(sid, child):
    """SIGTERM every process of the test session, then SIGKILL what is left."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in session_pids(sid):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        if _wait_until(lambda: not session_pids(sid), child):
            return
    if child:
        child.poll()


def end_group(group, child):
    """SIGTERM every process of the group, then kill what is left of it, sessions included."""
    for pid in cgroup_pids(group):
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    if _wait_until(lambda: not cgroup_pids(group), child):
        return
    try:
        (cgroup_dir(group) / 'cgroup.kill').write_text('1')
    except OSError:
        pass
    _wait_until(lambda: not cgroup_pids(group), child)
    if child:
        child.poll()


# ---------------------------------------------------------------- host readings
# Every reading of host load (pressure, /proc/stat, /proc/meminfo, cgroup files) is here;
# SUITE_GATE_PROC_ROOT and SUITE_GATE_CGROUP_ROOT point them at fake files in tests.

def proc_root():
    return Path(os.environ.get('SUITE_GATE_PROC_ROOT') or '/proc')


def read_pressure(name):
    """The `some avg10` percentage of /proc/pressure/<name> (io, cpu), or None."""
    try:
        lines = (proc_root() / 'pressure' / name).read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        fields = line.split()
        if fields[:1] == ['some']:
            for field in fields[1:]:
                if field.startswith('avg10='):
                    try:
                        return float(field[6:])
                    except ValueError:
                        return None
    return None


def read_cpu_times():
    """(cores, total ticks, idle ticks) of the host from /proc/stat, or None."""
    try:
        lines = (proc_root() / 'stat').read_text().splitlines()
    except OSError:
        return None
    cores = sum(1 for line in lines if re.match(r'cpu\d', line))
    total = next((line.split()[1:] for line in lines if line.startswith('cpu ')), None)
    try:
        # user nice system idle iowait irq softirq steal; guest time is already in user.
        ticks = [int(value) for value in total[:8]]
    except (TypeError, ValueError):
        return None
    if cores == 0 or len(ticks) < 5 or sum(ticks) <= 0:
        return None
    return cores, sum(ticks), ticks[3] + ticks[4]


def read_mem_available():
    """MemAvailable of /proc/meminfo in bytes, or None."""
    try:
        lines = (proc_root() / 'meminfo').read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        fields = line.split()
        if fields[:1] == ['MemAvailable:'] and len(fields) > 1 and fields[1].isdigit():
            return int(fields[1]) * 1024
    return None


def cgroup_root():
    return Path(os.environ.get('SUITE_GATE_CGROUP_ROOT') or '/sys/fs/cgroup')


def cgroup_dir(group):
    return cgroup_root() / group.lstrip('/')


def cgroup_v2():
    return (cgroup_root() / 'cgroup.controllers').is_file()


def process_cgroup(pid):
    """The cgroup v2 path of a process (`/user.slice/...`), or None."""
    try:
        lines = Path(f'/proc/{pid}/cgroup').read_text().splitlines()
    except OSError:
        return None
    return next((line[3:] for line in lines if line.startswith('0::')), None)


def cgroup_pids(group):
    """Processes in the group; none once the group is gone."""
    try:
        return [int(pid) for pid in (cgroup_dir(group) / 'cgroup.procs').read_text().split()]
    except (OSError, ValueError):
        return []


def cgroup_value(group, name, key=None):
    """An integer from a group file (from its `key value` line when key is given), or
    None when it cannot be read."""
    try:
        text = (cgroup_dir(group) / name).read_text()
    except OSError:
        return None
    try:
        if key is None:
            return int(text.split()[0])
        return next((int(value) for name_, value in (line.split() for line in text.splitlines())
                     if name_ == key), None)
    except (ValueError, IndexError):
        return None


def command_line(pid):
    try:
        raw = Path(f'/proc/{pid}/cmdline').read_bytes()
    except OSError:
        return '?'
    return raw.rstrip(b'\0').replace(b'\0', b' ').decode(errors='replace') or '?'


def holder_usage(holder):
    """Current CPU cores and memory bytes of a running suite (None when unknown).

    Cores come from the gate's latest sample, so they are unknown once the gate is gone;
    memory is read from the group now.
    """
    if not holder.get('cgroup'):
        return {'cpu_cores': None, 'mem_bytes': None}
    sample = holder.get('sample') or {}
    return {'cpu_cores': sample.get('cpu_cores') if gate_alive(holder) else None,
            'mem_bytes': cgroup_value(holder['cgroup'], 'memory.current')}


class Sampler:
    """Reads the group's CPU time and memory every interval while the suite runs."""

    def __init__(self, group, interval, report):
        self.group, self.interval, self.report = group, interval, report
        self.last = (time.monotonic(), self.cpu_usec())
        self.peak_cores = None
        self.done = threading.Event()
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def cpu_usec(self):
        return cgroup_value(self.group, 'cpu.stat', 'usage_usec')

    def _sample(self):
        now, usage = time.monotonic(), self.cpu_usec()
        (then, before), self.last = self.last, (now, usage)
        if usage is None or before is None or now <= then:
            return None
        cores = (usage - before) / 1e6 / (now - then)
        self.peak_cores = max(cores, self.peak_cores or 0.0)
        return cores

    def _loop(self):
        while not self.done.wait(self.interval):
            cores = self._sample()
            self.report(cores, cgroup_value(self.group, 'memory.current'))

    def finish(self):
        """Stop sampling and take the last, partial interval; the peak cores."""
        self.done.set()
        self.thread.join()
        self._sample()
        return self.peak_cores


# ---------------------------------------------------------------- shared state

class Interrupted(Exception):
    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


def _child_setup(fds):
    """In the forked child: put each pipe on its fd ({target: source}) and reopen the
    signals the gate blocks."""
    def setup():
        # Move the sources above the targets first, so no dup2 overwrites a later source.
        high = {target: fcntl.fcntl(source, fcntl.F_DUPFD, 10) for target, source in fds.items()}
        for target, source in high.items():
            os.dup2(source, target)
        signal.pthread_sigmask(signal.SIG_UNBLOCK, SIGNALS)
    return setup


def _raise_interrupted(signum, _frame):
    raise Interrupted(signum)


def reclaim_leftovers(state, config):
    """Stop what holders whose gate is gone left in their group (session without one) once
    it has been seen for the grace period, and drop those holders. The first time a holder is
    seen that way stamps `leftover_since` on it; a holder whose gate runs is never touched."""
    now = time.time()
    holders = [*state['locks'].values(), *state['slots']]
    expired = {}
    for holder in holders:
        if gate_alive(holder):
            continue
        since = holder.get('leftover_since')
        if not _number(since):
            holder['leftover_since'] = now
        elif now - since >= config['reclaim_grace_seconds']:
            expired[holder['id']] = holder
    for holder_id, holder in expired.items():
        group, sid = holder.get('cgroup'), holder.get('sid')
        pids = cgroup_pids(group) if group else session_pids(sid)
        processes = [{'pid': pid, 'command': command_line(pid)} for pid in pids]
        if group:
            end_group(group, None)
        else:
            end_session(sid, None)
        lock = next((fp for fp, h in state['locks'].items() if h['id'] == holder_id), None)
        record = {'time': now_iso(), 'agent': holder.get('agent'),
                  'command': holder.get('command'), 'cwd': holder.get('cwd'),
                  'fingerprint': holder.get('fingerprint'), 'cgroup': group, 'sid': sid,
                  'slot': any(h['id'] == holder_id for h in state['slots']), 'lock': lock,
                  'leftover_since': holder['leftover_since'],
                  'grace_seconds': config['reclaim_grace_seconds'],
                  'process_count': len(processes), 'processes': processes}
        state['reclaims'] = (state.get('reclaims') or [])[-(RECLAIM_HISTORY - 1):] + [record]
        warn(f"reclaimed the slot of {record['agent']} ({record['command']} in "
             f"{record['cwd']}): its gate was gone for "
             f"{fmt_seconds(now - holder['leftover_since'])}; stopped {len(processes)} "
             'process(es):\n' + '\n'.join(f"  {p['pid']} {p['command']}" for p in processes))
    state['locks'] = {k: v for k, v in state['locks'].items() if v['id'] not in expired}
    state['slots'] = [h for h in state['slots'] if h['id'] not in expired]


def with_state(change):
    """Run change(state) under the host-wide state lock, with dead holders pruned and
    leftovers past the grace period reclaimed."""
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / 'state.json'
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        with open(directory / 'state.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                state = json.loads(path.read_text())
            except (FileNotFoundError, ValueError):
                state = {}
            state.setdefault('seq', 0)
            state['locks'] = {k: v for k, v in state.get('locks', {}).items() if holder_alive(v)}
            state['slots'] = [h for h in state.get('slots', []) if holder_alive(h)]
            state['waiters'] = [h for h in state.get('waiters', []) if holder_alive(h)]
            reclaim_leftovers(state, load_config())
            result = change(state)
            tmp = path.with_suffix('.tmp')
            tmp.write_text(json.dumps(state, indent=1))
            os.replace(tmp, path)
            return result
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)


def append_record(record):
    directory = state_dir()
    directory.mkdir(parents=True, exist_ok=True)
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        with open(directory / 'ledger.jsonl', 'a') as ledger:
            fcntl.flock(ledger, fcntl.LOCK_EX)
            ledger.write(json.dumps(record, ensure_ascii=False) + '\n')
            ledger.flush()
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)


def read_records():
    path = state_dir() / 'ledger.jsonl'
    try:
        with open(path) as ledger:
            fcntl.flock(ledger, fcntl.LOCK_SH)
            lines = ledger.read().splitlines()
    except FileNotFoundError:
        return []
    records = []
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def record_fingerprint(record):
    """The content a record is about; a reuse note keeps it as `reused_fingerprint`."""
    return record.get('fingerprint') or record.get('reused_fingerprint')


def reusable_record(fp):
    """The latest record for this content when it passed; None when it failed or is absent.

    Records whose content changed mid-run describe no single content and are skipped, as
    are affected-test runs and reuse notes (records with a `kind`).
    """
    for record in reversed(read_records()):
        if record.get('kind'):
            continue
        if record.get('fingerprint') == fp and not record.get('content_changed'):
            return record if record.get('reusable') else None
    return None


# ---------------------------------------------------------------- admission

def _number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def measured_reservation(key, history):
    """The highest CPU peak and memory peak of the latest `history` measured runs filed under
    key, or None when there are none. Unmeasured runs (fallback, missing values) do not count."""
    if key is None:
        return None
    found = []
    for record in reversed(read_records()):
        if not isinstance(record, dict):
            continue
        profile = record.get('profile')
        if record.get('profile_key') == key and isinstance(profile, dict) \
                and not profile.get('fallback') and _number(profile.get('cpu_peak_cores')) \
                and _number(profile.get('mem_peak_bytes')):
            found.append(profile)
            if len(found) >= history:
                break
    if not found:
        return None
    return {'cpu_cores': max(p['cpu_peak_cores'] for p in found),
            'mem_bytes': max(p['mem_peak_bytes'] for p in found)}


def reservation_of(holder, config):
    """(cores, bytes, source) a suite reserves: its measured peak, or the configured default
    (also for holders written before reservations existed)."""
    measured = holder.get('reservation')
    if isinstance(measured, dict) and _number(measured.get('cpu_cores')) \
            and _number(measured.get('mem_bytes')):
        return measured['cpu_cores'], measured['mem_bytes'], 'measured'
    return config['default_cores'], config['default_mem_gb'] * GIB, 'default'


def unused_reservation(holder, config):
    """(cores, bytes) of a running suite's reservation it does not use yet; all of it when
    its current use is unknown."""
    cpu, mem, _ = reservation_of(holder, config)
    usage = holder_usage(holder)
    return (cpu if usage['cpu_cores'] is None else max(0.0, cpu - usage['cpu_cores']),
            mem if usage['mem_bytes'] is None else max(0, mem - usage['mem_bytes']))


def update_brake(state, pressure, config, now):
    """The shared brake after this reading: it goes on when disk or CPU wait is above its high
    mark and off only when both are below their low marks. An unreadable signal counts as
    neither above nor below."""
    old = state.get('brake') if isinstance(state.get('brake'), dict) else {}
    io, cpu = pressure['io'], pressure['cpu']
    over = (io is not None and io > config['brake_io_high']) \
        or (cpu is not None and cpu > config['brake_cpu_high'])
    under = (io is None or io < config['brake_io_low']) \
        and (cpu is None or cpu < config['brake_cpu_low'])
    on = over or (bool(old.get('on')) and not under)
    since = old.get('since') if old.get('on') and on else (now if on else None)
    state['brake'] = {'on': on, 'since': since, 'io': io, 'cpu': cpu, 'time': now}
    return state['brake']


def host_view(state, config):
    """Read the host and update the shared CPU window and brake in state.

    Idle CPU is measured over the last 10-20 s: state keeps up to two /proc/stat readings,
    the older one is the base. Without a recent base the gate reads twice, 0.25 s apart;
    readings that do not move (fake files) fall back to the counters since boot.
    """
    now = time.time()
    unreadable = {'load': [], 'pressure': []}
    pressure = {}
    for name, what in (('io', 'disk'), ('cpu', 'CPU')):
        pressure[name] = read_pressure(name)
        if pressure[name] is None:
            path = proc_root() / 'pressure' / name
            unreadable['pressure'].append(str(path))
            warn_once(f'cannot read {path}: the brake ignores {what} wait')
    cores = idle = None
    times = read_cpu_times()
    if times is not None:
        window = [w for w in state.get('host_cpu') or []
                  if isinstance(w, list) and len(w) == 3 and all(_number(v) for v in w)
                  and 0 <= now - w[0] < 3 * CPU_WINDOW_SECONDS]
        if not window:
            window = [[now, times[1], times[2]]]
            time.sleep(0.25)
            times = read_cpu_times() or times
            now = time.time()
        elif now - window[-1][0] >= CPU_WINDOW_SECONDS:
            window = [window[-1], [now, times[1], times[2]]]
        state['host_cpu'] = window
        cores, total, idle_ticks = times
        base = window[0]
        if total > base[1] and idle_ticks >= base[2]:
            idle = (idle_ticks - base[2]) / (total - base[1])
        else:
            idle = idle_ticks / total
    mem = read_mem_available()
    floor = min(config['min_slots'], config['max_slots'])
    for path, value in ((proc_root() / 'stat', times), (proc_root() / 'meminfo', mem)):
        if value is None:
            unreadable['load'].append(str(path))
            warn_once(f'cannot read {path}: queued suites start only while fewer than '
                      f'{floor} run')
    return {'cores': cores, 'cpu_idle': None if idle is None else round(idle, 4),
            'cpu_free_cores': None if idle is None else cores * idle,
            'mem_available_bytes': mem, 'pressure': pressure,
            'brake': update_brake(state, pressure, config, now), 'unreadable': unreadable}


def fmt_num(value):
    return f'{value:.2f}'.rstrip('0').rstrip('.')


def brake_reason(host, config):
    pressure = host['pressure']
    marks = (('disk wait', pressure['io'], config['brake_io_high'], config['brake_io_low']),
             ('CPU wait', pressure['cpu'], config['brake_cpu_high'], config['brake_cpu_low']))
    over = [f'{name} {fmt_num(value)}%, above {fmt_num(high)}%'
            for name, value, high, _ in marks if value is not None and value > high]
    if over:
        return 'brake on: ' + '; '.join(over)
    now = ', '.join(f'{name} {"?" if value is None else fmt_num(value)}%'
                    for name, value, _, _ in marks)
    return ('brake on until ' + ' and '.join(f'{name} < {fmt_num(low)}%'
                                             for name, _, _, low in marks) + f' (now {now})')


def admission(config, running, candidate, host):
    """(admit, reason why not) for the first suite in the queue.

    running: (cores, bytes) of unused reservation per running suite; candidate: (cores, bytes)
    it reserves; host: from host_view. The cap comes first, then the floor (below it nothing
    else is checked), then the brake, then whether the reservation fits.
    """
    count, cap = len(running), config['max_slots']
    if count >= cap:
        return False, f'host cap reached: {count}/{cap} suites running'
    if count < min(config['min_slots'], cap):
        return True, None
    if host['unreadable']['load']:
        return False, 'host data unreadable: ' + ', '.join(host['unreadable']['load'])
    if host['brake']['on']:
        return False, brake_reason(host, config)
    cpu_left = host['cpu_free_cores'] - sum(cpu for cpu, _ in running)
    mem_left = (host['mem_available_bytes'] - sum(mem for _, mem in running)
                - config['mem_reserve_gb'] * GIB)
    short = []
    if cpu_left < candidate[0]:
        short.append(f'not enough CPU: needs {fmt_num(candidate[0])} cores, '
                     f'{fmt_num(cpu_left)} available')
    if mem_left < candidate[1]:
        short.append(f'not enough memory: needs {fmt_num(candidate[1] / GIB)} GiB, '
                     f'{fmt_num(mem_left / GIB)} GiB available')
    return not short, '; '.join(short) or None


# ---------------------------------------------------------------- run

class Gate:
    def __init__(self, argv, cwd, rerun, config, extra=None):
        self.argv = argv
        self.cwd = cwd
        self.rerun = rerun
        self.config = config
        self.extra = extra or {}  # written into the record over the defaults
        self.command = normalize_command(argv)
        self.child = None
        self.group = None  # the suite's cgroup, None in a plain session
        self.sampler = None
        self.keeper = self.keeper_pid = None  # holds the group open until it is measured
        self.finished = False  # the suite exited by itself
        self.key = None  # what its measured usage is filed under
        self.measured = None  # ((profile_history, ledger version), reservation) for self.key
        self.scopes = None  # whether an empty user scope started, probed once before queueing
        self.ran = None  # a full suite that ran, for the cleanup check
        self.me = {'id': uuid.uuid4().hex, 'pid': os.getpid(),
                   'start': proc_stat(os.getpid())[2], 'sid': None, 'cgroup': None,
                   'agent': agent_name(), 'command': self.command, 'cwd': str(cwd),
                   'fingerprint': None, 'reservation': None}

    def _holder(self, **extra):
        return dict(self.me, since=time.time(), **extra)

    def _wait(self, attempt, describe):
        started = last = time.monotonic()
        while True:
            self.config = load_config()
            outcome = with_state(attempt)
            if outcome is not None:
                return outcome
            now = time.monotonic()
            if now - last >= self.config['report_seconds']:
                last = now
                warn(f'{with_state(describe)}; waited {fmt_seconds(now - started)}')
            time.sleep(self.config['poll_seconds'])

    def acquire_lock(self, fp):
        def attempt(state):
            mine = [w for w in state['waiters'] if w['id'] == self.me['id']]
            if fp not in state['locks']:
                state['waiters'] = [w for w in state['waiters'] if w['id'] != self.me['id']]
                state['locks'][fp] = self._holder()
                return True
            if not mine:
                state['waiters'].append(self._holder(kind='content'))
            return None

        def describe(state):
            holder = state['locks'].get(fp)
            who = holder['agent'] if holder else 'another request'
            return f'waiting for {who}, which is running the same content ({fp[:12]})'

        self._wait(attempt, describe)

    def reservation(self):
        """The measured reservation for this suite's command, read again when the ledger or
        profile_history changes; None means the configured default, which is also what a
        suite that will run without a scope (fallback) reserves."""
        if not self.scopes:
            return None
        try:
            stat = (state_dir() / 'ledger.jsonl').stat()
            version = (stat.st_size, stat.st_mtime_ns)
        except OSError:
            version = None
        seen = (self.config['profile_history'], version)
        if self.measured is None or self.measured[0] != seen:
            self.measured = (seen, measured_reservation(self.key, seen[0]))
        return self.measured[1]

    def probe_scopes(self):
        """Whether a systemd user scope starts here: an empty one is tried once, outside the
        state lock, so a suite that will fall back to a session queues with the default."""
        if self.scopes is None:
            self.scopes = bool(cgroup_v2() and shutil.which('systemd-run'))
            if self.scopes:
                prefix = os.environ.get('SUITE_GATE_UNIT_PREFIX') or 'suite-gate'
                try:
                    self.scopes = subprocess.run(
                        ['systemd-run', '--user', '--scope', '--quiet', '--collect',
                         f"--unit={prefix}-probe-{self.me['id'][:12]}", 'true'],
                        capture_output=True, timeout=30).returncode == 0
                except (OSError, subprocess.TimeoutExpired):
                    self.scopes = False
        return self.scopes

    def acquire_slot(self):
        """Queue first come, first served; only the first in the queue may start, when
        admission() lets it. Every other waiter records why it waits."""
        self.probe_scopes()

        def attempt(state):
            mine = next((w for w in state['waiters'] if w['id'] == self.me['id']
                         and w.get('kind') == 'slot'), None)
            if mine is None:
                state['seq'] += 1
                mine = self._holder(kind='slot', seq=state['seq'])
                state['waiters'].append(mine)
            self.me['reservation'] = mine['reservation'] = self.reservation()
            ahead = [w for w in state['waiters']
                     if w.get('kind') == 'slot' and w['seq'] < mine['seq']]
            if ahead:
                mine['reason'] = f'{len(ahead)} suite(s) queued ahead'
                return None
            running = [unused_reservation(h, self.config) for h in state['slots']]
            admit, reason = admission(self.config, running, reservation_of(mine, self.config)[:2],
                                      host_view(state, self.config))
            if admit:
                state['waiters'].remove(mine)
                state['slots'].append(self._holder())
                return True
            mine['reason'] = reason
            return None

        def describe(state):
            running = ', '.join(f"{h['agent']} {fmt_seconds(time.time() - h['since'])}"
                                for h in state['slots']) or 'none'
            mine = next((w for w in state['waiters'] if w['id'] == self.me['id']), None)
            ahead = sum(1 for w in state['waiters'] if w.get('kind') == 'slot'
                        and mine and w['seq'] < mine['seq'])
            return (f'waiting for a host slot ({len(state["slots"])}/{self.config["max_slots"]}'
                    f' in use: {running}; {ahead} ahead): {(mine or {}).get("reason")}')

        self._wait(attempt, describe)

    def set_session(self, sid, group=None):
        """Record the suite's session and group on this gate's lock and slot. Without a
        group (fallback) the suite reserves the default."""
        def change(state):
            for holder in [*state['locks'].values(), *state['slots']]:
                if holder['id'] == self.me['id']:
                    holder['sid'], holder['cgroup'] = sid, group
                    if group is None:
                        holder['reservation'] = None
        self.me['sid'], self.me['cgroup'] = sid, group
        if group is None:
            self.me['reservation'] = None
        with_state(change)

    def store_sample(self, cores, mem):
        def change(state):
            for holder in state['slots']:
                if holder['id'] == self.me['id']:
                    holder['sample'] = {
                        'cpu_cores': None if cores is None else round(cores, 2),
                        'mem_bytes': mem, 'time': time.time()}
        with_state(change)

    def release(self):
        """Drop this gate's entries. A lock or slot whose suite was cut short stays held while
        its group (or session) has processes; processes a finished suite left in its group do
        not hold it."""
        def still_held(holder):
            if holder['id'] != self.me['id']:
                return True
            if holder.get('cgroup'):
                alive = not self.finished and cgroup_pids(holder['cgroup'])
            else:
                alive = holder.get('sid') and session_pids(holder['sid'])
            if alive:
                holder['gate_done'] = True
                return True
            return False

        def change(state):
            state['waiters'] = [w for w in state['waiters'] if w['id'] != self.me['id']]
            state['locks'] = {k: v for k, v in state['locks'].items() if still_held(v)}
            state['slots'] = [h for h in state['slots'] if still_held(h)]
        with_state(change)

    def run(self):
        while True:
            info = fingerprint(self.cwd, self.argv)
            fp = info and info['fingerprint']
            self.me['fingerprint'] = fp
            self.key = info and info['profile_key']
            if info is None:
                warn('not in a Git work tree: queueing only, the result will not be reused')
            elif not self.rerun:
                record = reusable_record(fp)
                if record:
                    return self.reuse(record, info)
            if fp:
                self.acquire_lock(fp)
                if not self.rerun:
                    record = reusable_record(fp)
                    if record:
                        self.release()
                        return self.reuse(record, info)
            self.acquire_slot()
            if info is not None:
                again = fingerprint(self.cwd, self.argv)
                if again['fingerprint'] != fp:
                    warn('content changed while queued; starting over with the new content')
                    self.release()
                    continue
            return self.execute(info)

    def reuse(self, record, info):
        """Report the earlier pass; a run with a purpose also notes the reuse in the ledger.
        The note keeps the fingerprint as `reused_fingerprint`, so a reader that ignores
        `kind` (an older gate) still finds the pass as the latest record for it."""
        print_reuse(record, self.command)
        if self.extra.get('purpose'):
            append_record({
                'kind': 'reuse', 'reused_fingerprint': info['fingerprint'], 'tree': info['tree'],
                'repo': info['repo'], 'command': self.command, 'cwd': str(self.cwd),
                'rel_cwd': info['rel_cwd'], 'exit_code': 0, 'agent': self.me['agent'],
                'time': now_iso(), 'reusable': False, 'reused_time': record.get('time'),
                'reused_agent': record.get('agent'), 'purpose': None, 'purpose_reason': None,
                **self.extra})
        return 0

    def _scope_ready(self):
        """True when the suite can run in a systemd user scope; warns why not otherwise."""
        if not cgroup_v2():
            warn(f'cgroup v2 is not mounted at {cgroup_root()}: {FALLBACK_NOTE}')
        elif not shutil.which('systemd-run'):
            warn(f'systemd-run is not installed: {FALLBACK_NOTE}')
        else:
            return True
        return False

    def _start(self, argv, scoped):
        """Start the suite held on fd 3 until its session (and group) is recorded.

        In a scope, also sets self.group, self.sampler, self.keeper and self.keeper_pid. Returns the
        child, or None when the scope could not be set up; the suite has not run then.
        """
        # The suite waits for a byte on fd 3 until its session is recorded; if the gate is
        # killed before that, the pipe closes and the suite never runs uncounted.
        go_read, go_write = os.pipe()
        fds, launch = {3: go_read}, ['/bin/sh', '-c', LAUNCHER, 'suite-gate', *argv]
        if scoped:
            keep_read, keep_write = os.pipe()
            report_read, report_write = os.pipe()
            fds.update({4: keep_read, 5: report_write})
            prefix = os.environ.get('SUITE_GATE_UNIT_PREFIX') or 'suite-gate'
            unit = f"{prefix}-{self.me['id'][:12]}"
            launch = ['systemd-run', '--user', '--scope', '--quiet', '--collect',
                      f'--unit={unit}', '--', '/bin/sh', '-c', SCOPE_LAUNCHER, 'suite-gate',
                      *argv]
        # An interrupt must not land between starting the session and recording it.
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            try:
                child = subprocess.Popen(launch, cwd=self.cwd, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, start_new_session=True,
                                         pass_fds=tuple(fds), preexec_fn=_child_setup(fds))
            except OSError as exc:
                if not scoped:
                    raise
                warn(f'could not start a systemd user scope ({exc}): {FALLBACK_NOTE}')
                os.close(keep_write)
                os.close(report_read)
                return None
            finally:
                for fd in fds.values():
                    os.close(fd)
            if scoped:
                report = os.fdopen(report_read)
                group = process_cgroup(child.pid) if report.readline() == 'ready\n' else None
                if group is None or not group.endswith(f'/{unit}.scope') \
                        or not (cgroup_dir(group) / 'cgroup.procs').is_file():
                    os.close(go_write)  # the held launcher exits without running the suite
                    go_write = None
                    os.close(keep_write)
                    report.close()
                    child.wait()
                    child.stdout.close()
                    why = child.stderr.read().decode(errors='replace').strip()
                    child.stderr.close()
                    warn(f"could not start a systemd user scope ({why or 'no group for it'}): "
                         f'{FALLBACK_NOTE}')
                    return None
                self.group, self.keeper = group, keep_write
            self.child = child
            self.set_session(child.pid, self.group)
            if scoped:  # the CPU baseline comes before the suite can use any
                self.sampler = Sampler(group, self.config['sample_seconds'], self.store_sample)
            os.write(go_write, b'go\n')
            if scoped:
                with report:
                    line = report.readline().strip()
                self.keeper_pid = int(line) if line.isdigit() else None
            return child
        finally:
            if go_write is not None:
                os.close(go_write)
            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)

    def measure(self, duration):
        """The record's profile: the group's final counters, read before the keeper lets the
        group go. Values that cannot be read are None."""
        if not self.group:
            return dict(PROFILE_UNMEASURED)
        peak = self.sampler.finish()
        usec = cgroup_value(self.group, 'cpu.stat', 'usage_usec')
        mem_peak = cgroup_value(self.group, 'memory.peak')
        left = [pid for pid in cgroup_pids(self.group) if pid != self.keeper_pid]
        os.close(self.keeper)
        self.keeper = None
        if left:
            warn(f'the suite left {len(left)} process(es) running in its group; they are not '
                 'stopped and no longer hold the slot:\n'
                 + '\n'.join(f'  {pid} {command_line(pid)}' for pid in left))
        seconds = None if usec is None else usec / 1e6
        return {
            'cpu_peak_cores': None if peak is None else round(peak, 2),
            'cpu_avg_cores': None if seconds is None or duration <= 0
            else round(seconds / duration, 2),
            'cpu_seconds': None if seconds is None else round(seconds, 2),
            'mem_peak_bytes': mem_peak, 'sample_seconds': self.config['sample_seconds'],
            'fallback': False, 'leftover_processes': len(left),
        }

    def end_suite(self):
        """End an interrupted suite: its whole group, or its session without one."""
        if self.sampler:
            self.sampler.done.set()
        if self.group:
            end_group(self.group, self.child)
        else:
            end_session(self.child.pid, self.child)

    def execute(self, info):
        argv = ['/bin/sh', '-c', self.argv[0]] if len(self.argv) == 1 else self.argv
        started, start_iso = time.monotonic(), now_iso()
        # The reaper logs whole seconds; a kill in the run's first second must still count.
        started_at = datetime.now(timezone.utc).replace(microsecond=0)
        try:
            child = self._start(argv, True) if self._scope_ready() else None
            child = child or self._start(argv, False)
        except OSError as exc:
            warn(f'could not start /bin/sh: {exc}')
            return 127
        tail = Tail()
        pumps = [threading.Thread(target=pump, args=(stream, out, tail), daemon=True)
                 for stream, out in ((child.stdout, sys.stdout.buffer),
                                     (child.stderr, sys.stderr.buffer))]
        for thread in pumps:
            thread.start()
        code = child.wait()
        self.finished = True
        ended_at = datetime.now(timezone.utc)
        reaped = (reaped_during(self.cwd, started_at, ended_at) if code == 0
                  else reaped_after_failure(self.cwd, started_at, ended_at))
        for thread in pumps:
            thread.join(timeout=2)
        profile = self.measure(time.monotonic() - started)
        code = 128 - code if code < 0 else code
        seconds = time.monotonic() - started
        duration = round(seconds, 1)
        after = fingerprint(self.cwd, self.argv) if info else None
        changed = info is not None and after['fingerprint'] != info['fingerprint']
        record = {
            'fingerprint': info and info['fingerprint'], 'tree': info and info['tree'],
            'repo': info and info['repo'], 'command': self.command, 'cwd': str(self.cwd),
            'rel_cwd': info and info['rel_cwd'], 'exit_code': code, 'duration_s': duration,
            'output_tail': tail.text(), 'agent': self.me['agent'], 'time': start_iso,
            'finished': now_iso(), 'rerun_reason': self.rerun, 'content_changed': changed,
            'reusable': info is not None and code == 0 and not changed,
            'purpose': None, 'purpose_reason': None, 'profile': profile,
            'profile_key': info and info['profile_key'], 'reaped': reaped,
        }
        record.update(self.extra)
        append_record(record)
        if info is not None and not record.get('kind'):
            self.ran = {'info': info, 'seconds': seconds, 'sample': record['reusable']}
        if changed:
            warn('content changed during the run: this result is recorded but will not be '
                 'reused; do not edit files while the suite runs, and git-ignore files the '
                 'tests generate (e.g. __pycache__/, .pytest_cache/, build output). '
                 'Run `git status --porcelain` to see what changed')
        if reaped:
            shown = '; '.join(f"pid {e['pid']} {str(e['command'])[:80]}" for e in reaped[:3])
            warn(f'the LAT service reaper ended {len(reaped)} process(es) under {self.cwd} during '
                 f'the run, taking them for leftovers of an ended agent ({shown}). Failures such as '
                 f'connection refused may come from that rather than the change; details in '
                 f'{reaper_log()}')
        warn(f"recorded exit {code} in {duration}s"
             + (f" for fingerprint {info['fingerprint'][:12]}" if info else ''))
        return code


class Tail:
    def __init__(self):
        self.data = bytearray()
        self.lock = threading.Lock()

    def add(self, chunk):
        with self.lock:
            self.data += chunk
            del self.data[:-TAIL_BYTES]

    def text(self):
        with self.lock:
            lines = self.data.decode(errors='replace').splitlines()
        return '\n'.join(lines[-TAIL_LINES:])


def pump(stream, out, tail):
    fd = stream.fileno()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            return
        tail.add(chunk)
        out.write(chunk)
        out.flush()


def fmt_seconds(seconds):
    seconds = int(seconds)
    if seconds < 60:
        return f'{seconds}s'
    if seconds < 3600:
        return f'{seconds // 60}m{seconds % 60:02d}s'
    return f'{seconds // 3600}h{seconds % 3600 // 60:02d}m'


def fmt_bytes(count):
    for unit in ('B', 'KiB', 'MiB'):
        if count < 1024:
            return f'{count:.0f} {unit}' if unit == 'B' else f'{count:.1f} {unit}'
        count /= 1024
    return f'{count:.1f} GiB'


def print_reuse(record, command):
    print('suite-gate: this content already passed with the same command; not running it again.')
    print(f"  fingerprint: {record['fingerprint']}")
    print(f"  ran by:      {record.get('agent')} at {record.get('time')} "
          f"({record.get('duration_s')}s, exit {record.get('exit_code')})")
    print(f"  command:     {record.get('command')}")
    print(f"  cwd:         {record.get('cwd')}")
    if record.get('purpose'):
        print(f"  purpose:     {describe_purpose(record)}")
    if record.get('rerun_reason'):
        print(f"  rerun reason: {record['rerun_reason']}")
    if record.get('output_tail'):
        print('  output tail:')
        for line in record['output_tail'].splitlines():
            print(f'    {line}')
    print('This is the result for the current content: report it. Being asked to run the '
          'suite again is not by itself a reason to rerun. With a concrete reason (for '
          'example a database, service or ignored config changed, or a flaky test is being '
          'investigated), rerun with:')
    print(f'  suite-gate.py run --rerun "<reason>" -- {command}')


def describe_purpose(record):
    purpose = record.get('purpose')
    if purpose == 'reason':
        return f"reason: {record.get('purpose_reason')}"
    if purpose == 'map-fallback':
        return 'map fallback, triggered by ' + ', '.join(record.get('trigger_files') or [])
    return purpose


def _drive(gate, action):
    """action() with the gate's entries released after, then the cleanup check of a full
    suite that ran; an interrupt ends the test session and is raised again."""
    try:
        result = action()
    except Interrupted:
        if gate.child is not None and not gate.finished:
            for sig in SIGNALS:
                signal.signal(sig, signal.SIG_IGN)
            warn('interrupted: ending the suite and everything it started; no record written')
            gate.end_suite()
        elif gate.child is not None:
            warn('interrupted: no record written')
        raise
    finally:
        gate.release()
    if gate.ran:
        check_cleanup(gate.ran, gate.command, gate.cwd)
    return result


def _guarded(body):
    """body() with interrupts and gate errors turned into exit codes."""
    for sig in SIGNALS:
        signal.signal(sig, _raise_interrupted)
    try:
        return body()
    except Interrupted as exc:
        return 128 + exc.signum
    except RuntimeError as exc:
        warn(str(exc))
        return 2


PURPOSE_CHOICES = ('--purpose post-merge (after a batch is merged), --purpose release (before '
                   'a release), or --reason "<why the full suite is needed>"')


def run_args_error(rerun, purpose, reason):
    """What is wrong with run's --rerun, --purpose and --reason, or None."""
    if rerun is not None and not rerun.strip():
        return '--rerun needs a reason'
    if reason is not None and not reason.strip():
        return '--reason needs text'
    if purpose and reason:
        return 'give either --purpose or --reason, not both'
    return None


def purpose_flags(purpose, reason):
    if reason:
        return ('--reason', reason.strip())
    return ('--purpose', purpose) if purpose else ()


def command_words(argv):
    """argv as the words it runs: a shell string split as sh would, None when it cannot be."""
    if len(argv) != 1:
        return list(argv)
    try:
        return shlex.split(argv[0])
    except ValueError:
        return None


def registered_form(cwd, argv):
    """The registered full suite that argv runs in cwd but written in another form (split
    arguments or other spelling of the same words), so its fingerprint differs; None when
    argv matches a registered suite exactly or none."""
    root = repo_root(cwd)
    if root is None:
        return None
    try:
        suites = read_full_suites(load_registry(cwd) or {})
    except ValueError:
        return None
    here = rel_cwd(root, cwd)
    suites = [s for s in suites if rel_cwd(root, suite_cwd(root, s)) == here]
    if any(len(argv) == 1 and normalize_command(argv) == s['command'] for s in suites):
        return None
    words = command_words(argv)
    return next((s for s in suites if words and words == command_words([s['command']])),
                None)


def cmd_run(rerun, purpose, reason, argv):
    error = run_args_error(rerun, purpose, reason)
    if error:
        warn(error)
        return 2
    flags = purpose_flags(purpose, reason)
    if reason:
        purpose = 'reason'
    if purpose is None and is_mapped(load_registry(Path.cwd()) or {}):
        warn('this project has an affected-test map, so a full suite needs a purpose. '
             'For the tests this change affects, run instead:\n'
             f'  {affected_command()}\n'
             f'For a full suite, add one after `run`: {PURPOSE_CHOICES}')
        return 2
    suite = registered_form(Path.cwd(), argv)
    if suite:
        warn('this is the registered full suite written in another form, so its result will '
             'not be accepted by the push and install checks. The registered form:\n'
             f"  {gate_command(suite['command'], flags)}\n"
             'or run every registered full suite with: suite-gate.py run --registered '
             '--purpose <purpose>')
    extra = {'purpose': purpose, 'purpose_reason': reason.strip() if reason else None}
    gate = Gate(argv, Path.cwd(), rerun.strip() if rerun else None, load_config(), extra)
    return _guarded(lambda: _drive(gate, gate.run))


# Dependencies a suite directory gets installed in a fresh checkout, by the lockfile it holds.
PREPARE_STEPS = (('bun.lock', ['bun', 'install', '--frozen-lockfile']),
                 ('bun.lockb', ['bun', 'install', '--frozen-lockfile']))


@contextlib.contextmanager
def clean_checkout(root, commit):
    """A temporary detached checkout of commit, a worktree of root's repository under the
    state dir; the directory and its worktree entry are removed however the block ends."""
    parent = state_dir() / 'checkouts'
    parent.mkdir(parents=True, exist_ok=True)
    # No signal between creating the directory and the try that removes it.
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        path = Path(tempfile.mkdtemp(prefix='checkout-', dir=parent))
    except OSError:
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        raise
    try:
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        result = git(['worktree', 'add', '--detach', '--quiet', str(path), commit], root)
        if result.returncode != 0:
            raise RuntimeError(f'git worktree add failed: {result.stderr.strip()}')
        yield path
    finally:
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            git(['worktree', 'remove', '--force', '--force', str(path)], root)
            shutil.rmtree(path, ignore_errors=True)
            git(['worktree', 'prune'], root)
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        if path.exists():
            warn(f'could not remove the temporary checkout {path}; remove it and run '
                 '`git worktree prune`')


def prepare_dependencies(directory):
    """Install the dependencies directory's lockfile names; what failed, or None. It runs
    in its own session, ended with whatever it left running however it ends."""
    for lockfile, command in PREPARE_STEPS:
        if (directory / lockfile).is_file():
            warn(f'preparing {directory}: {shlex.join(command)}')
            # No signal between starting it and the try that ends it.
            old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
            try:
                child = subprocess.Popen(command, cwd=directory, start_new_session=True,
                                         preexec_fn=_child_setup({}))
            except OSError as exc:
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
                return f'{shlex.join(command)} could not start: {exc}'
            try:
                signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
                code = child.wait()
            finally:
                end_session(child.pid, child)
            return f'{shlex.join(command)} exited {code}' if code else None
    return None


def cmd_run_registered(names, rerun, purpose, reason):
    """Run the registered full suites, all or those named by directory or command, in their
    registered form, each through the gate, in a temporary clean checkout of HEAD."""
    error = run_args_error(rerun, purpose, reason)
    if error:
        warn(error)
        return 2
    if not purpose and not reason:
        warn(f'run --registered needs a purpose: add {PURPOSE_CHOICES}')
        return 2
    root = repo_root(Path.cwd())
    if root is None:
        warn('run --registered: not in a Git work tree')
        return 2
    head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root)
    if head.returncode != 0:
        warn('run --registered: HEAD is not a commit yet')
        return 2
    commit = head.stdout.strip()
    extra = {'purpose': 'reason' if reason else purpose,
             'purpose_reason': reason.strip() if reason else None}

    def named(suite, name):
        return name.strip() == suite['command'] or _dir_key(name) == suite['cwd']

    def run_suites(checkout):
        registry = load_registry(checkout) or {}
        try:
            suites = read_full_suites(registry)
        except ValueError as exc:
            warn(f'run --registered: {exc}')
            return 2
        # The fingerprint takes these files from the work tree, so the checkout gets the
        # original tree's ignored ones and its records match that tree; tracked and new
        # files stay as HEAD has them.
        found = sorted({str(p.relative_to(root)) for pattern in include_patterns(registry)
                        for p in root.glob(pattern) if p.is_file()})
        if found:
            for rel in _git_paths(['ls-files', '--others', '--ignored', '--exclude-standard',
                                   '--', *found], root):
                target = checkout / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(root / rel, target)
        unknown = [n for n in names if not any(named(s, n) for s in suites)]
        if unknown:
            warn(f"run --registered: no registered full suite {', '.join(unknown)}; the "
                 'registered ones (name one by its directory or command):')
            for suite in suites:
                warn(f"  {suite['cwd']}: {suite['command']}")
            return 2
        if names:
            suites = [s for s in suites if any(named(s, n) for n in names)]
        code, prepared = 0, {}
        for suite in suites:
            warn(f"full suite in {suite['cwd']}: {suite['command']}")
            cwd = suite_cwd(checkout, suite)
            if cwd not in prepared:
                prepared[cwd] = prepare_dependencies(cwd)
            if prepared[cwd]:
                warn(f"not run: preparing {suite['cwd']} failed ({prepared[cwd]}); this is "
                     'not a test result')
                code = code or 2
                continue
            gate = Gate([suite['command']], cwd, rerun.strip() if rerun else None,
                        load_config(), extra)
            result = _drive(gate, gate.run)
            code = code or result
        return code

    def body():
        warn(f'testing HEAD {commit[:12]} in a temporary clean checkout; later changes to '
             f'{root} do not affect the run')
        if git(['status', '--porcelain'], root).stdout.strip():
            warn(f'{root} has uncommitted changes; they are not tested. Commit them first '
                 'to include them.')
        with clean_checkout(root, commit) as checkout:
            warn(f'temporary checkout: {checkout} (removed when the run ends)')
            return run_suites(checkout)
    return _guarded(body)


# ---------------------------------------------------------------- affected tests

def is_mapped(registry):
    """True when the registry has an affected-test map."""
    if isinstance(registry, dict) and registry.get('map_error'):
        return True
    affected = registry.get('affected') if isinstance(registry, dict) else None
    return isinstance(affected, dict) and bool(affected.get('map'))


def affected_command():
    return shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'affected'])


def _strings(value, what, allow_empty=True):
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value) \
            or (not allow_empty and not value):
        raise ValueError(f'{what} must be a list of non-empty strings')
    return value


def _dir_key(path):
    path = path.strip('/')
    return '.' if path in ('', '.') else os.path.normpath(path)


def read_map(registry):
    """The checked affected-test map: commands by directory, rules, shared paths, full
    suites and the integration branch. ValueError names the bad field."""
    if registry.get('map_error'):
        raise ValueError(registry['map_error'])
    affected = registry['affected']
    commands = affected.get('commands')
    if not isinstance(commands, dict) or not commands:
        raise ValueError('affected.commands must map directories to command templates')
    for directory, template in commands.items():
        if not isinstance(template, str) or '{tests}' not in template:
            raise ValueError(f'affected.commands["{directory}"] must be a string with {{tests}}')
    rules = affected['map']
    if not isinstance(rules, list) or not all(isinstance(r, dict) for r in rules):
        raise ValueError('affected.map must be a list of {"paths": [...], "tests": [...]}')
    for i, rule in enumerate(rules):
        _strings(rule.get('paths'), f'affected.map[{i}].paths', allow_empty=False)
        _strings(rule.get('tests'), f'affected.map[{i}].tests')
    shared = _strings(affected.get('shared', []), 'affected.shared')
    suites = read_full_suites(registry)
    branch = registry.get('integration_branch')
    if branch is not None and (not isinstance(branch, str) or not branch):
        raise ValueError('integration_branch must be a branch name')
    return {'commands': {_dir_key(k): v for k, v in commands.items()}, 'rules': rules,
            'shared': shared, 'branch': branch, 'suites': suites}


def read_full_suites(registry):
    """The registry's full suites as [{command, cwd}]. ValueError when missing or bad."""
    suites = registry.get('full_suites')
    if not isinstance(suites, list) or not suites or not all(
            isinstance(s, dict) and isinstance(s.get('command'), str) and s['command'].strip()
            and isinstance(s.get('cwd', '.'), str) for s in suites):
        raise ValueError('full_suites must list {"command": "...", "cwd": "<dir>"} entries')
    return [{'command': s['command'].strip(), 'cwd': _dir_key(s.get('cwd', '.'))}
            for s in suites]


def suite_cwd(root, suite):
    """The directory a registered full suite runs in."""
    return root if suite['cwd'] == '.' else root / suite['cwd']


def glob_match(path, pattern):
    """Path glob: `*` and `?` stay within one directory, `**` spans directories."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith('**/', i):
            out.append('(?:.*/)?')
            i += 3
        elif pattern.startswith('**', i):
            out.append('.*')
            i += 2
        else:
            out.append({'*': '[^/]*', '?': '[^/]'}.get(pattern[i]) or re.escape(pattern[i]))
            i += 1
    return re.fullmatch(''.join(out), path) is not None


def _git_paths(args, root):
    result = git([args[0], '-z', *args[1:]], root)
    if result.returncode != 0:
        raise RuntimeError(f'git {" ".join(args[:2])} failed: {result.stderr.strip()}')
    return [p for p in result.stdout.split('\0') if p]


def change_base(root, base, branch):
    """(commit, description) the change is measured from: base when given, else the
    merge-base of HEAD and the integration branch."""
    if base is None and branch is None:
        raise RuntimeError('the registry names no integration_branch; add it or pass --base')
    if base is not None:
        result = git(['rev-parse', '--verify', '--quiet', base + '^{commit}'], root)
        if result.returncode != 0:
            raise RuntimeError(f'--base {base} is not a commit')
        return result.stdout.strip(), base
    result = git(['merge-base', 'HEAD', branch], root)
    if result.returncode != 0:
        raise RuntimeError(f'no merge-base of HEAD and {branch}: {result.stderr.strip()}')
    return result.stdout.strip(), f'merge-base of HEAD and {branch}'


def changed_files(root, base):
    """Files that differ from base: committed, uncommitted and new files not ignored."""
    diff = _git_paths(['diff', '--name-only', '--no-renames', base, '--'], root)
    new = _git_paths(['ls-files', '--others', '--exclude-standard'], root)
    return sorted(set(diff) | set(new))


def _split_registry(data):
    """(registry without affected.map, [rule as sorted JSON]), or None when it has no map list."""
    affected = data.get('affected') if isinstance(data, dict) else None
    if not isinstance(affected, dict) or not isinstance(affected.get('map'), list):
        return None
    rest = dict(data, affected={k: v for k, v in affected.items() if k != 'map'})
    return rest, [json.dumps(rule, sort_keys=True) for rule in affected['map']]


def base_registry(root, base):
    """The parsed .suite-gate.json at commit base, or None when it is missing or unreadable."""
    result = git(['show', f'{base}:{REGISTRY_NAME}'], root)
    try:
        return json.loads(result.stdout) if result.returncode == 0 else None
    except ValueError:
        return None


def shares_registry(data):
    """True when registry data lists .suite-gate.json itself in affected.shared."""
    affected = data.get('affected') if isinstance(data, dict) else None
    shared = affected.get('shared') if isinstance(affected, dict) else None
    return isinstance(shared, list) and any(
        isinstance(p, str) and glob_match(REGISTRY_NAME, p) for p in shared)


def registry_map_changes(root, before):
    """The affected.map rules .suite-gate.json added or changed since before (its parsed
    base version), or a reason the change needs the full suite: a rule was removed. None
    means more than the map changed (including a registry new since the base)."""
    try:
        old = _split_registry(before)
        new = _split_registry(json.loads((root / REGISTRY_NAME).read_text()))
    except (OSError, ValueError):
        return None
    if old is None or new is None or old[0] != new[0]:
        return None
    added = []
    matcher = difflib.SequenceMatcher(None, old[1], new[1], autojunk=False)
    for op, i1, i2, j1, j2 in matcher.get_opcodes():
        # A changed rule is replaced in place; an old rule left without a new one in its
        # place was removed, even when other rules are added elsewhere.
        if op in ('delete', 'replace') and i2 - i1 > j2 - j1:
            return 'a map rule was removed'
        if op in ('insert', 'replace'):
            added.extend(json.loads(rule) for rule in new[1][j1:j2])
    return added


def select_tests(root, changed, amap, base=None):
    """({test: [why]}, [(file, why)] that need the full suite) for the changed files.
    base (the commit the change is measured from) lets a changed .suite-gate.json select
    the tests of its added or changed map rules instead of falling back."""
    files = [p for p in _git_paths(['ls-files', '-co', '--exclude-standard'], root)
             if (root / p).is_file()]
    rules = amap['rules']
    test_patterns = [p for rule in rules for p in rule['tests']]
    selected, fallback = {}, []

    def select_rules(path, new_rules):
        """Select what each of new_rules (rules added in path) maps to."""
        for rule in new_rules:
            tests = [t for t in files if any(glob_match(t, p) for p in rule['tests'])]
            if rule['tests'] and not tests:
                fallback.append((path, f'{path} maps to tests that match no file: '
                                       + ', '.join(rule['tests'])))
            for test in tests:
                selected.setdefault(test, []).append(f"{path} maps {', '.join(rule['paths'])}")

    for path in changed:
        if glob_match(path, f'{MAP_DIR}/*.json') and (root / path).is_file():
            # A map file only adds rules: run the tests it maps to, even when shared.
            select_rules(path, json.loads((root / path).read_text())['map'])
            continue
        shared = next((p for p in amap['shared'] if glob_match(path, p)), None)
        if path == REGISTRY_NAME and base is not None:
            before = base_registry(root, base)
            # Shared at the base too, so dropping it from shared still counts as a change.
            if shared or shares_registry(before):
                changes = registry_map_changes(root, before)
                if isinstance(changes, list):
                    select_rules(path, changes)
                else:
                    fallback.append((path, changes or (f'shared path {shared}' if shared
                                                       else 'no longer a shared path')))
                continue
        if shared:
            fallback.append((path, f'shared path {shared}'))
            continue
        handled = False
        if any(glob_match(path, p) for p in test_patterns):
            handled = True
            if (root / path).is_file():
                selected.setdefault(path, []).append('test file changed')
        for rule in rules:
            hit = next((p for p in rule['paths'] if glob_match(path, p)), None)
            if hit is None:
                continue
            handled = True
            tests = [t for t in files if any(glob_match(t, p) for p in rule['tests'])]
            if rule['tests'] and not tests:
                fallback.append((path, f'{hit} maps to tests that match no file: '
                                       + ', '.join(rule['tests'])))
            for test in tests:
                selected.setdefault(test, []).append(f'{path} matches {hit}')
        if not handled:
            fallback.append((path, 'not in the affected-test map'))
    return selected, fallback


def command_dir(test, commands):
    """The longest directory in commands that holds test, or None."""
    found = [d for d in commands if d == '.' or test.startswith(d + '/')]
    return max(found, key=len) if found else None


def cmd_affected(base):
    def body():
        root = repo_root(Path.cwd())
        registry = load_registry(Path.cwd()) if root else None
        if not is_mapped(registry or {}):
            warn('no affected-test map in this project (`affected.map` in '
                 f'{REGISTRY_NAME}); run the full suite through `suite-gate.py run`')
            return 2
        try:
            amap = read_map(registry)
        except ValueError as exc:
            warn(f'{root / REGISTRY_NAME}: {exc}')
            return 2
        commit, origin = change_base(root, base, amap['branch'])
        changed = changed_files(root, commit)
        warn(f'change against {origin} ({commit[:12]}): {len(changed)} file(s)')
        for path in changed:
            warn(f'  {path}')
        selected, fallback = select_tests(root, changed, amap, commit)
        groups = {}
        for test in sorted(selected):
            directory = command_dir(test, amap['commands'])
            if directory is None:
                fallback.append((test, 'no affected.commands directory holds this test'))
            else:
                groups.setdefault(directory, []).append(test)
        code = 0
        if fallback:
            suites = fallback_suites(amap['suites'], [path for path, _ in fallback])
            code = run_fallback(root, suites, fallback)
            # The full suites run the tests in their directories; the rest still run here.
            groups = {d: kept for d, tests in groups.items()
                      if (kept := [t for t in tests if not any(
                          s['cwd'] == '.' or t.startswith(s['cwd'] + '/') for s in suites)])}
            if not groups:
                return code
        elif not groups:
            warn('no tests selected for this change; nothing to run')
            warn('hint: on an integration branch the base must be given with --base <commit> '
                 '(the commit this work started from); without it the change is empty')
            return 0
        warn('selected tests:')
        for test in sorted(t for tests in groups.values() for t in tests):
            warn(f"  {test}  ({'; '.join(selected[test])})")
        for directory, tests in groups.items():
            rel = [t if directory == '.' else t[len(directory) + 1:] for t in tests]
            text = amap['commands'][directory].replace('{tests}', ' '.join(map(shlex.quote, rel)))
            cwd = root if directory == '.' else root / directory
            warn(f'running in {directory}: {text}')
            gate = Gate([text], cwd, None, load_config(), {
                'kind': 'affected', 'reusable': False, 'base': commit,
                'changed_files': changed, 'selected_tests': tests,
                'why': {t: selected[t] for t in tests}})
            info = fingerprint(cwd, [text])
            result = _drive(gate, lambda: gate.execute(info))
            code = code or result
        return code
    return _guarded(body)


def fallback_suites(suites, triggers):
    """The full suites a fallback runs: those whose directory holds a trigger file, or all of
    them when some trigger lies in no suite directory (a suite run from `.` holds none)."""
    chosen = set()
    for path in triggers:
        holders = {i for i, s in enumerate(suites)
                   if s['cwd'] != '.' and path.startswith(s['cwd'] + '/')}
        if not holders:
            return suites
        chosen |= holders
    return [s for i, s in enumerate(suites) if i in chosen]


def run_fallback(root, suites, fallback):
    """Run (or reuse) the given full suites through the gate."""
    warn('this change needs the full suite (map fallback):')
    for path, why in fallback:
        warn(f'  {path}: {why}')
    triggers = sorted({path for path, _ in fallback})
    code = 0
    for suite in suites:
        warn(f"full suite in {suite['cwd']}: {suite['command']}")
        gate = Gate([suite['command']], suite_cwd(root, suite), None, load_config(),
                    {'purpose': 'map-fallback', 'trigger_files': triggers})
        result = _drive(gate, gate.run)
        code = code or result
    return code


# ---------------------------------------------------------------- test cleanup

CLEANUP_DAYS = 30        # due when the last cleanup is more than this many days ago
CLEANUP_GROWTH = 1.3     # due when the median of later passes reaches baseline x this
CLEANUP_MIN_SAMPLES = 3  # later passes needed before the speed is judged
CLEANUP_LATEST = 5       # the median is taken over at most this many latest passes
CLEANUP_LABEL = 'test-cleanup'
TRACKER_TIMEOUT = 10


def today():
    """Today's date. SUITE_GATE_TEST_TODAY (YYYY-MM-DD) replaces it; for tests only."""
    fake = os.environ.get('SUITE_GATE_TEST_TODAY')
    return date.fromisoformat(fake) if fake else date.today()


def project_root(root):
    """The main work tree of root's repository, shared by all of its worktrees."""
    common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root).stdout.strip()
    return Path(common).parent if common and Path(common).name == '.git' else root


def unit_key(project, rel, command):
    return json.dumps([str(project), rel, command])


def new_window(unit, baseline=None):
    """Start a cleanup window today: the baseline is given or the next pass. The day of
    the last tracker action stays, so a reset never allows a second action that day."""
    unit.update(last_cleanup=today().isoformat(), window_start=now_iso(), baseline=baseline,
                baseline_source='given' if baseline else None, samples=[], sample_count=0)
    return unit


def new_unit(project, rel, command, baseline=None):
    return new_window({'project': str(project), 'rel_cwd': rel, 'command': command,
                       'acted': None}, baseline)


def secs(value):
    return f'{round(value, 2)}s'


def add_sample(unit, seconds):
    """A reusable pass: the window's first one is the baseline, later ones are samples."""
    if unit['baseline'] is None:
        unit['baseline'], unit['baseline_source'] = seconds, 'first pass'
    else:
        unit['samples'] = (unit['samples'] + [seconds])[-CLEANUP_LATEST:]
        unit['sample_count'] += 1


def cleanup_median(unit):
    """Median of the latest later passes, or None until enough of them exist."""
    if not unit['baseline'] or unit['sample_count'] < CLEANUP_MIN_SAMPLES:
        return None
    return statistics.median(unit['samples'])


def cleanup_due(unit):
    """The reasons this unit is due for a cleanup; empty when it is not."""
    reasons = []
    days = (today() - date.fromisoformat(unit['last_cleanup'])).days
    if days > CLEANUP_DAYS:
        reasons.append(f"{days} days since the last cleanup ({unit['last_cleanup']}), "
                       f'more than {CLEANUP_DAYS}')
    median = cleanup_median(unit)
    if median is not None and median >= unit['baseline'] * CLEANUP_GROWTH:
        reasons.append(f"median {secs(median)} of the latest {len(unit['samples'])} passes "
                       f"is {median / unit['baseline']:.0%} of the baseline "
                       f"{secs(unit['baseline'])}, "
                       f'at least {CLEANUP_GROWTH:.0%}')
    return reasons


def cleanup_numbers(unit):
    """The unit's cleanup state as Markdown list lines."""
    median = cleanup_median(unit)
    if unit['baseline'] is None:
        speed = 'no baseline yet (set by the next passing run)'
    elif median is None:
        speed = (f"{unit['sample_count']} pass(es) after the baseline; "
                 f'{CLEANUP_MIN_SAMPLES} needed before the speed is judged')
    else:
        speed = (f"{secs(median)}, median of the latest {len(unit['samples'])} passes "
                 f"({median / unit['baseline']:.0%} of the baseline)")
    return [f"- Project: {unit['project']}",
            f"- Suite: `{unit['command']}` in `{unit['rel_cwd']}`",
            f"- Last cleanup: {unit['last_cleanup']} (window since {unit['window_start']})",
            "- Baseline: " + (f"{secs(unit['baseline'])} ({unit['baseline_source']})"
                               if unit['baseline'] is not None else 'none yet'),
            f'- Current: {speed}']


def cleanup_ticket(unit, reasons):
    """(title, body, comment) for a cleanup ticket of this unit's project."""
    numbers = [f'- Due ({today().isoformat()}): ' + '; '.join(reasons), *cleanup_numbers(unit)]
    title = f"Test cleanup: {Path(unit['project']).name}"
    body = '\n'.join([
        'The suite gate found this project due for a test cleanup.', '', *numbers, '',
        'Follow the cleanup procedure in the three-tier-testing skill '
        '(`references/cleanup.md`). When closing this ticket, run '
        '`suite-gate.py cleanup-done` in the project to start a new window.'])
    comment = '\n'.join(['Updated numbers from the suite gate:', '', *numbers])
    return title, body, comment


def read_tracker(registry):
    """{'repo', 'label'} from the registry's `cleanup`, or None without a GitHub repo."""
    cleanup = registry.get('cleanup')
    if not isinstance(cleanup, dict):
        return None
    repo, label = cleanup.get('github_repo'), cleanup.get('label', CLEANUP_LABEL)
    if not isinstance(repo, str) or not repo.strip() or not isinstance(label, str) \
            or not label.strip():
        return None
    return {'repo': repo.strip(), 'label': label.strip()}


def gh(args, tracker):
    result = subprocess.run(['gh', *args, '--repo', tracker['repo']], capture_output=True,
                            text=True, stdin=subprocess.DEVNULL, timeout=TRACKER_TIMEOUT)
    if result.returncode != 0:
        detail = (result.stderr.strip().splitlines() or [f'exit {result.returncode}'])[-1]
        raise RuntimeError(f'gh {args[0]} {args[1]} failed: {detail}')
    return result.stdout


def tracker_key(tracker):
    return json.dumps([tracker['repo'], tracker['label']])


def post_cleanup(tracker, title, body, comment, opened):
    """Comment on the open cleanup issue, or open one; returns (what was done, the number of
    an issue opened now or None). opened is the issue this gate opened last: it is asked
    first, since a new issue can be missing from the label list for a while."""
    if opened is not None:
        issue = json.loads(gh(['issue', 'view', str(opened), '--json', 'state,url'], tracker))
        if issue['state'] == 'OPEN':
            gh(['issue', 'comment', str(opened), '--body', comment], tracker)
            return f"commented on {issue['url']}", None
    found = json.loads(gh(['issue', 'list', '--state', 'open', '--label', tracker['label'],
                           '--json', 'number,url', '--limit', '1'], tracker))
    if found:
        gh(['issue', 'comment', str(found[0]['number']), '--body', comment], tracker)
        return f"commented on {found[0]['url']}", None
    url = gh(['issue', 'create', '--title', title, '--label', tracker['label'],
              '--body', body], tracker).strip()
    number = re.search(r'/issues/(\d+)$', url)
    return f'opened {url}', int(number.group(1)) if number else None


def check_cleanup(finished, command, cwd):
    """After a full suite ran: count a reusable pass as a speed sample, then open or update
    the cleanup ticket when the unit is due. Never changes the suite's output or exit."""
    try:
        _check_cleanup(finished, command, cwd)
    except Interrupted:
        raise
    except Exception as exc:  # the cleanup check must never fail the suite
        warn(f'test cleanup check skipped: {exc}')


def _check_cleanup(finished, command, cwd):
    info = finished['info']
    project = project_root(Path(info['repo']))
    key = unit_key(project, info['rel_cwd'], command)
    tracker = read_tracker(load_registry(cwd) or {})
    day = today().isoformat()

    def update(state):
        unit = state.setdefault('cleanup', {}).setdefault(
            key, new_unit(project, info['rel_cwd'], command))
        if finished['sample']:
            add_sample(unit, finished['seconds'])
        reasons = cleanup_due(unit)
        previous = unit['acted']
        claimed = bool(reasons) and tracker is not None and previous != day
        if claimed:
            unit['acted'] = day  # at most one tracker action per unit per day
        opened = state.get('cleanup_issues', {}).get(tracker_key(tracker)) if claimed else None
        return dict(unit), reasons, claimed, previous, opened

    unit, reasons, claimed, previous, opened = with_state(update)
    if not reasons:
        return
    title, body, comment = cleanup_ticket(unit, reasons)
    if tracker is None:
        warn('test cleanup is due, and the registry names no tracker (`cleanup.github_repo` '
             f'in {REGISTRY_NAME}). Open a cleanup ticket in this project\'s tracker:\n'
             f'Title: {title}\n{body}')
        return
    if not claimed:
        warn(f"test cleanup is due; the cleanup ticket in {tracker['repo']} was already "
             'updated today')
        return
    try:
        done, number = post_cleanup(tracker, title, body, comment, opened)
    except Interrupted:
        raise
    except Exception as exc:
        def unclaim(state):
            stored = state.get('cleanup', {}).get(key)
            if stored and stored['acted'] == day:
                stored['acted'] = previous
        with_state(unclaim)
        warn(f"test cleanup is due, but the tracker {tracker['repo']} could not be updated "
             f"({exc}). Open or update the open `{tracker['label']}` issue by hand:\n"
             f'Title: {title}\n{body}')
        return
    if number is not None:
        def remember(state):
            state.setdefault('cleanup_issues', {})[tracker_key(tracker)] = number
        with_state(remember)
    warn(f'test cleanup is due: {done}')


def cmd_cleanup_done(command, baseline):
    if baseline is not None and (command is None or baseline <= 0):
        warn('--baseline needs --command and a number of seconds above 0')
        return 2
    root = repo_root(Path.cwd())
    if root is None:
        warn('not in a Git work tree')
        return 2
    project = project_root(root)
    rel = rel_cwd(root, Path.cwd())

    def change(state):
        units = state.setdefault('cleanup', {})
        if command is not None:
            text = normalize_command([command])
            key = unit_key(project, rel, text)
            if key not in units:
                units[key] = new_unit(project, rel, text, baseline)
                return [dict(units[key])]
            keys = [key]
        else:
            keys = [k for k, u in units.items() if u['project'] == str(project)]
        return [dict(new_window(units[k], baseline)) for k in keys]

    done = with_state(change)
    if not done:
        print(f'No full suite of {project} has run through the gate yet; the first one '
              'starts its cleanup window today.')
        return 0
    for unit in done:
        print(f"New cleanup window for `{unit['command']}` in {unit['project']}/"
              f"{unit['rel_cwd']}: last cleanup {unit['last_cleanup']}, baseline "
              + (secs(unit['baseline']) if unit['baseline'] else 'the next passing run'))
    return 0


# ---------------------------------------------------------------- status

def cmd_status(as_json, fp_prefix, limit):
    config = load_config()

    def look(state):
        host = host_view(state, config)
        running = []
        for holder in state['slots']:
            cpu, mem, source = reservation_of(holder, config)
            running.append(dict(holder, usage=holder_usage(holder), unused=unused_reservation(
                holder, config), reservation={'cpu_cores': cpu, 'mem_bytes': mem,
                                              'source': source}))
        return copy.deepcopy(state), host, running

    state, host, running = with_state(look)
    records = read_records()
    if fp_prefix:
        records = [r for r in records if (record_fingerprint(r) or '').startswith(fp_prefix)]
    records = records[-limit:]
    cap, floor = config['max_slots'], min(config['min_slots'], config['max_slots'])
    unused_cpu = sum(h['unused'][0] for h in running)
    unused_mem = sum(h['unused'][1] for h in running)
    reserve = config['mem_reserve_gb'] * GIB
    free, avail = host['cpu_free_cores'], host['mem_available_bytes']
    host.update({
        'unused_reservation': {'cpu_cores': unused_cpu, 'mem_bytes': unused_mem},
        'mem_reserve_bytes': reserve,
        'cpu_left_cores': None if free is None else free - unused_cpu,
        'mem_left_bytes': None if avail is None else avail - unused_mem - reserve})
    waiting = []
    for waiter in state['waiters']:
        cpu, mem, source = reservation_of(waiter, config)
        waiting.append(dict(waiter, reservation={'cpu_cores': cpu, 'mem_bytes': mem,
                                                 'source': source}))
    cleanup = [dict(unit, median=cleanup_median(unit), due=cleanup_due(unit))
               for unit in state.get('cleanup', {}).values()]
    if as_json:
        shown = [{k: v for k, v in h.items() if k != 'unused'} for h in running]
        print(json.dumps({'min_slots': floor, 'max_slots': cap, 'config': config,
                          'host': host, 'running': shown, 'waiting': waiting,
                          'locks': state['locks'], 'records': records, 'cleanup': cleanup,
                          'reclaims': state.get('reclaims') or []},
                         ensure_ascii=False, indent=1))
        return 0
    now = time.time()
    brake, pressure = host['brake'], host['pressure']
    waits = ', '.join(f'{name} wait {"?" if pressure[key] is None else fmt_num(pressure[key])}%'
                      for key, name in (('io', 'disk'), ('cpu', 'CPU')))
    cpu_text = ('CPU unreadable' if free is None else
                f"CPU {fmt_num(free)} of {host['cores']} cores idle, "
                f"{fmt_num(host['cpu_left_cores'])} left after unused reservations")
    mem_text = ('memory unreadable' if avail is None else
                f'memory {fmt_num(avail / GIB)} GiB available, '
                f"{fmt_num(host['mem_left_bytes'] / GIB)} GiB left after unused reservations "
                f'and the {fmt_num(config["mem_reserve_gb"])} GiB reserve')
    print(f"Host: {cpu_text}; {mem_text}; brake {'on' if brake['on'] else 'off'} ({waits}); "
          f'{floor} start regardless of load, at most {cap} run')
    for path in host['unreadable']['load'] + host['unreadable']['pressure']:
        print(f'  cannot read {path}' + (': the brake ignores it' if '/pressure/' in path
                                         else f': only {floor} start until it can be read'))
    print(f"Running ({len(running)}/{cap} host slots):")
    for h in running:
        note = ''
        if not gate_alive(h):
            left = ('its group still has processes' if h.get('cgroup')
                    else 'test session still alive')
            note = (f' (gate gone, {left}; reclaimed in {reclaim_due(h, config, now)} '
                    'if still there)')
        cores, mem = h['usage']['cpu_cores'], h['usage']['mem_bytes']
        usage = (f"cpu {'-' if cores is None else f'{cores:.1f} cores'}, "
                 f"mem {'-' if mem is None else fmt_bytes(mem)}")
        print(f"  {h['agent']}  {fmt_seconds(now - h['since'])}  {fmt_reservation(h)}  "
              f"{usage}  fp {(h.get('fingerprint') or '-')[:12]}  {h['cwd']}  "
              f"{h['command']}{note}")
    if not running:
        print('  none')
    print('Waiting:')
    for h in sorted(waiting, key=lambda w: w['since']):
        if h.get('kind') == 'slot':
            why = f"host slot: {h.get('reason') or 'not checked yet'}  {fmt_reservation(h)}"
        else:
            why = 'same content running'
        print(f"  {h['agent']}  {fmt_seconds(now - h['since'])}  {why}  "
              f"fp {(h.get('fingerprint') or '-')[:12]}  {h['cwd']}  {h['command']}")
    if not waiting:
        print('  none')
    print(f'Recent records ({len(records)}):')
    for r in records:
        if r.get('reusable'):
            result = 'PASS'
        elif r.get('exit_code') == 0:
            result = 'PASS (not reusable: ' + (
                'content changed' if r.get('content_changed') else 'not in Git') + ')'
        else:
            result = f"FAIL exit {r.get('exit_code')}"
        if r.get('kind') == 'reuse':
            result = f"REUSED pass of {r.get('reused_time')}"
        elif r.get('kind') == 'affected':
            result = ('PASS' if r.get('exit_code') == 0 else f"FAIL exit {r.get('exit_code')}") \
                + ' (affected tests)'
        rerun = f"  rerun: {r['rerun_reason']}" if r.get('rerun_reason') else ''
        purpose = f"  purpose: {describe_purpose(r)}" if r.get('purpose') else ''
        print(f"  {r.get('time')}  {result}  fp {(record_fingerprint(r) or '-')[:12]}  "
              f"{r.get('agent')}  {r.get('duration_s')}s  {r.get('cwd')}  "
              f"{r.get('command')}{rerun}{purpose}")
    reclaim = (state.get('reclaims') or [None])[-1]
    if reclaim:
        print(f"Latest reclaim: {reclaim['time']} stopped {reclaim['process_count']} "
              f"process(es) left by {reclaim['agent']}  {reclaim['cwd']}  {reclaim['command']}")
        for process in reclaim['processes']:
            print(f"  {process['pid']} {process['command']}")
    print(f'Test cleanup ({len(cleanup)} suites):')
    for unit in cleanup:
        print(f"  {'DUE' if unit['due'] else 'not due'}: `{unit['command']}` in "
              f"{unit['project']}/{unit['rel_cwd']}")
        # The first two lines name the project and suite, already on the heading line.
        for line in cleanup_numbers(unit)[2:] + [f'- Due: {why}' for why in unit['due']]:
            print(f'    {line[2:]}')
    return 0


def reclaim_due(holder, config, now):
    """How long until a leftover holder is reclaimed; one whose gate ended after the state was
    read is not stamped yet and has the whole grace period."""
    left = config['reclaim_grace_seconds'] - (now - holder.get('leftover_since', now))
    return fmt_seconds(max(0.0, left))


def fmt_reservation(holder):
    reservation = holder['reservation']
    return (f"reserves {fmt_num(reservation['cpu_cores'])} cores, "
            f"{fmt_num(reservation['mem_bytes'] / GIB)} GiB ({reservation['source']})")


# ---------------------------------------------------------------- hook

SCRIPT = Path(__file__).resolve()
# Seen when the command text could not be read: block anything that looks like a runner.
LOOKS_LIKE_TESTS = re.compile(
    r'\b(pytest|py\.test|unittest|jest|vitest|playwright\s+test|go\s+test|cargo\s+test'
    r'|bun\s+test|(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t))\b')


REASON_FLAGS = ('--reason', '<why the full suite is needed>')


def gate_command(text, flags=()):
    """The ready-to-run command that sends text through the gate."""
    return shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'run', *flags,
                       '--', text])


def _is_gate_run(words):
    return any(os.path.basename(word) == SCRIPT.name and words[i + 1:i + 2] == ['run']
               for i, word in enumerate(words))


def shell_text(command):
    """The shell text of a hook's command: Codex may send `["bash", "-lc", "<text>"]`."""
    if isinstance(command, list):
        words = [str(word) for word in command]
        if len(words) == 3 and os.path.basename(words[0]) in SHELLS \
                and words[1].startswith('-') and 'c' in words[1]:
            return words[2]
        return shlex.join(words)
    return command if isinstance(command, str) else ''


def _wrap_suites(text, cwd, registry, wrap):
    """text with each full-suite simple command replaced in place by wrap(command text).

    The rest of the text (cd, export, pipes, a later echo) stays as written, so the gate
    records the suite's own exit code. In `bash -c '<body>'` only the body argument is
    rewritten, so the shell's assignments, options and isolation stay; in `bash <<EOF`
    only the heredoc body is.
    """
    edits = []
    found = _simple_commands(text)
    for (words, spans, heredocs, _, _), resolved in zip(found, _gate_variables(found)):
        if _is_gate_run(resolved):
            continue
        index = _shell_body_index(words)
        if index is not None:
            body = _wrap_suites(words[index], cwd, registry, wrap)
            if body != words[index]:
                edits.append((*spans[index], shlex.quote(body)))
        elif _reads_stdin_script(words):
            for body, _, _, start, end in _stdin_heredoc(heredocs):
                wrapped = _wrap_suites(body, cwd, registry, wrap)
                if wrapped != body:
                    edits.append((start, end, wrapped))
        elif is_full_suite(shlex.join(words), cwd, registry):
            start, end = spans[0][0], spans[-1][1]
            edits.append((start, end, wrap(text[start:end])))
    parts, last = [], 0
    for start, end, replacement in sorted(edits):
        parts += [text[last:start], replacement]
        last = end
    return ''.join(parts) + text[last:]


def gate_rewrite(text, cwd, wrap=gate_command):
    """The command to run instead of text, or None when text runs no full suite outside
    `suite-gate.py run`. wrap turns a suite's text into what replaces it."""
    try:
        commands = [words for words in split_commands(text) if not _is_gate_run(words)]
        if not commands:
            return None
        registry = load_registry(cwd) or {}
        if not is_full_suite(' ; '.join(shlex.join(words) for words in commands), cwd,
                             registry):
            return None
        rewritten = _wrap_suites(text, cwd, registry, wrap)
        # Only the commands together match a registry pattern: send all of them.
        return rewritten if rewritten != text else wrap(text)
    except UnreadableShellInput:
        return wrap(text)
    except Exception:  # unreadable text or a hook bug: block what looks like a runner
        if SCRIPT.name not in text and LOOKS_LIKE_TESTS.search(text):
            return wrap(text)
        return None


def _variable_gate_hint(text):
    """A note for the block message when text runs `$VAR run` the hook cannot read as a gate."""
    try:
        commands = split_commands(text)
    except UnreadableShellInput:
        return ''
    if any(word.startswith('$') and words[i + 1:i + 2] == ['run']
           for words in commands for i, word in enumerate(words)):
        return ('\nA gate call through a variable counts only when the same command first sets '
                'the variable to the suite-gate.py path (G=/path/suite-gate.py; ... "$G" run); '
                'otherwise call suite-gate.py by its full path.')
    return ''


def cmd_hook():
    """PreToolUse (matcher Bash) for Claude and Codex: exit 2 with the rewrite on stderr.

    In a project with an affected-test map the rewrite runs the affected tests instead,
    and the reply shows how to run a full suite with a purpose."""
    try:
        payload = json.load(sys.stdin)
        text = shell_text(payload.get('tool_input', {}).get('command', ''))
        cwd = payload.get('cwd') or os.getcwd()
    except (ValueError, AttributeError):
        return 0  # nothing to read; never leave the agent stuck
    cwd = cwd if os.path.isdir(cwd) else os.getcwd()
    rewrite = text.strip() and gate_rewrite(text, cwd)
    if not rewrite:
        return 0
    if is_mapped(load_registry(cwd) or {}):
        affected = gate_rewrite(text, cwd, lambda _suite: affected_command())
        full = gate_rewrite(text, cwd, lambda suite: gate_command(suite, REASON_FLAGS))
        print('Blocked: this project has an affected-test map, so a ticket runs only the '
              'tests its change affects, not the full suite. Run this instead:\n'
              f'  {affected}\n'
              'It runs the tests the map selects for the changed files, or the registered '
              'full suites through the gate when a change is not covered by the map.\n'
              'When a full suite is really needed, run it through the gate with a purpose:\n'
              f'  {full}\n'
              'Replace --reason \'<...>\' with --purpose post-merge after a batch is merged, '
              'or --purpose release before a release. The purpose is recorded with the result.'
              + _variable_gate_hint(text), file=sys.stderr)
        return 2
    print('Blocked: this runs a full test suite outside the suite gate. Run this instead; '
          'the gate reuses a passing result for the same content and queues when the host '
          'is busy:\n'
          f'  {rewrite}\n'
          'Only the suite command itself is wrapped, so the gate records its own exit code; '
          'the rest of your command is unchanged. The wrapped part runs under /bin/sh and '
          'sees only exported variables. '
          'Add --rerun "<reason>" after `run` only when the gate reports an earlier pass and '
          'you have a concrete reason to run again. To run only some tests, name the files '
          'or a filter.' + _variable_gate_hint(text),
          file=sys.stderr)
    return 2


# ---------------------------------------------------------------- install

HOOK_COMMAND = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'hook'])
GROUP_NAME = 'suite-gate'
BACKUP_PREFIX = '.suite-gate-backup-'


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
            raise ValueError('the suite-gate hook is listed more than once; inspect the file')
        if mine:
            group, existing = mine[0]
            existing.update(handler)  # a moved skill gets the new path; other fields stay
            if all(is_hook_handler(h) for h in group['hooks']):
                group['matcher'] = 'Bash'
        else:
            group = {'matcher': 'Bash', 'hooks': [handler]}
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
    write_file(path, original, after)
    print(diff, end='')
    if client == 'codex':
        print(f'Updated {path}; restart Codex and trust the hook in /hooks')
    else:
        print(f'Updated {path}; restart Claude Code and confirm the hook in /hooks')
    return 0


def write_file(path, original, after, mode=0o644):
    """Replace path with after (None removes it) after backing up original; refuses when
    path changed since original was read. A new file gets mode, an old one keeps its own."""
    path.parent.mkdir(parents=True, exist_ok=True)
    current = path.read_bytes() if path.exists() else None
    if current != original:
        raise ValueError(f'{path} changed while it was being read; retry')
    if original is not None:
        with tempfile.NamedTemporaryFile(prefix=path.name + BACKUP_PREFIX, dir=path.parent,
                                         delete=False) as backup:
            backup.write(original)
        print(f'Backup: {backup.name}')
    if after is None:
        path.unlink()
        return
    with tempfile.NamedTemporaryFile('w', prefix=path.name + '.', dir=path.parent,
                                     delete=False) as tmp:
        tmp.write(after)
    if original is not None:
        shutil.copymode(path, tmp.name)
    else:
        os.chmod(tmp.name, mode)
    os.replace(tmp.name, path)


# ---------------------------------------------------------------- pre-push

PRE_PUSH_BEGIN = '# >>> suite-gate pre-push >>>'
PRE_PUSH_END = '# <<< suite-gate pre-push <<<'
SH_SHEBANG = re.compile(r'#!\s*(?:\S*/)?(?:env\s+)?(?:\S*/)?(?:sh|bash|dash|zsh)(?:\s.*)?')


def is_release_ref(ref):
    return ref == 'refs/heads/main' or ref.startswith('refs/tags/')


def pushed_commits(root, lines):
    """{commit: [remote refs]} for pre-push stdin lines that push main or a tag; other
    branches and deletions are not checked."""
    found = {}
    for line in lines:
        parts = line.split()
        if len(parts) != 4:
            continue
        _local_ref, local_oid, remote_ref, _remote_oid = parts
        if not local_oid.strip('0') or not is_release_ref(remote_ref):
            continue
        result = git(['rev-parse', '--verify', '--quiet', local_oid + '^{commit}'], root)
        if result.returncode != 0:
            raise RuntimeError(f'{remote_ref}: {local_oid} is not a commit')
        found.setdefault(result.stdout.strip(), []).append(remote_ref)
    return found


def release_command(root, suite):
    run = gate_command(suite['command'], ('--purpose', 'release'))
    return f'cd {shlex.quote(str(suite_cwd(root, suite)))} && {run}'


def lacking_full_suites(root, commit, registry):
    """The registered full suites with no reusable pass for commit's content (its tree plus
    `fingerprint_include` files from the work tree, the command and its directory: the
    fingerprint the gate would compute). ValueError when the registry lists no full suites,
    RuntimeError when Git fails. LAT's pre-authorization check calls this too."""
    suites = read_full_suites(registry)
    tree = content_tree(root, include_patterns(registry), commit)
    return [s for s in suites if not reusable_record(
        digest(tree, [s['command']], rel_cwd(root, root / s['cwd'])))]


def cmd_pre_push():
    """Git pre-push: refuse pushing main or a tag unless every registered full suite has a
    reusable pass for the pushed commit (lacking_full_suites)."""
    root = repo_root(Path.cwd())
    lines = sys.stdin.read().splitlines()
    if root is None:
        warn('pre-push: not in a Git work tree; nothing checked')
        return 0
    try:
        commits = pushed_commits(root, lines)
        if not commits:
            return 0
        registry = load_registry(root) or {}
        include = include_patterns(registry)
        missing, differs = {}, []
        for commit, refs in commits.items():
            lacking = lacking_full_suites(root, commit, registry)
            if lacking:
                missing[commit] = (refs, lacking)
                if content_tree(root, include) != content_tree(root, include, commit):
                    differs.append(commit)
    except (RuntimeError, ValueError) as exc:
        warn(f'push refused: {exc}. `git push --no-verify` skips this check.')
        return 1
    if not missing:
        warn('pre-push: every registered full suite passed for the pushed content')
        return 0
    warn('push refused: no passing full-suite record for the pushed content:')
    commands = []
    for commit, (refs, lacking) in missing.items():
        warn(f"  {', '.join(refs)} at {commit[:12]}:")
        for suite in lacking:
            warn(f"    {suite['cwd']}: {suite['command']}")
            if release_command(root, suite) not in commands:
                commands.append(release_command(root, suite))
    warn('Run each missing suite through the gate on that content (purpose release), then '
         'push again:')
    for command in commands:
        warn(f'  {command}')
    for commit in differs:
        warn(f'The work tree differs from {commit[:12]}; run the commands in a clean checkout '
             f'of it (for example `git switch --detach {commit[:12]}`).')
    warn('`git push --no-verify` skips this check.')
    return 1


PRE_PUSH_CREATED = '# suite-gate created this file; uninstall removes it.\n'


def pre_push_block(created=False):
    run = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'pre-push'])
    return (f'{PRE_PUSH_BEGIN}\n'
            + (PRE_PUSH_CREATED if created else '') +
            '# Added by suite-gate.py install-pre-push; remove with uninstall-pre-push.\n'
            '# The pushed refs are kept for the rest of this hook on stdin.\n'
            'suite_gate_refs=$(mktemp) || exit 1\n'
            'trap \'rm -f "$suite_gate_refs"; exit 1\' HUP INT TERM\n'
            'cat > "$suite_gate_refs" || { rm -f "$suite_gate_refs"; exit 1; }\n'
            f'{run} "$@" < "$suite_gate_refs" || {{ rm -f "$suite_gate_refs"; exit 1; }}\n'
            'exec < "$suite_gate_refs"\n'
            'rm -f "$suite_gate_refs"\n'
            'trap - HUP INT TERM\n'
            f'{PRE_PUSH_END}\n')


def updated_hook(text, action):
    """The pre-push hook text with this check installed or removed; None removes the file."""
    lines = (text or '').splitlines(True)
    marks = [i for i, line in enumerate(lines) if line.rstrip('\n') in (PRE_PUSH_BEGIN,
                                                                          PRE_PUSH_END)]
    if marks and [lines[i].rstrip('\n') for i in marks] != [PRE_PUSH_BEGIN, PRE_PUSH_END]:
        raise ValueError('the suite-gate block is broken; inspect the hook')
    # Only a file this installer created is removed; any other keeps all its own lines.
    created = bool(marks) and PRE_PUSH_CREATED in lines[marks[0]:marks[1]]
    if action == 'uninstall':
        if not marks:
            return text
        rest = lines[:marks[0]] + lines[marks[1] + 1:]
        return None if created and ''.join(rest) == '#!/bin/sh\n' else ''.join(rest)
    block = pre_push_block(created)
    if marks:
        return ''.join(lines[:marks[0]]) + block + ''.join(lines[marks[1] + 1:])
    if text is None:
        return '#!/bin/sh\n' + pre_push_block(created=True)
    if not lines or not SH_SHEBANG.fullmatch(lines[0].strip()):
        raise ValueError('the existing pre-push hook is not a sh or bash script, so it was '
                         'left unchanged. To chain it, move it to another name, make '
                         'pre-push a sh script that runs it with "$@" (passing stdin on), '
                         'then install again')
    head = lines[0] if lines[0].endswith('\n') else lines[0] + '\n'
    return head + block + ''.join(lines[1:])


def cmd_pre_push_configure(action, repo, preview):
    root = repo_root(Path(repo))
    if root is None:
        raise ValueError(f'{repo} is not a Git work tree')
    if action == 'install':
        registry = load_registry(root)
        if registry is None:
            raise ValueError(f'no {REGISTRY_NAME} at {root}: the pre-push check is only for '
                             'repos with a registry')
        read_full_suites(registry)
    # Always the repo's own hooks dir: a core.hooksPath may be shared by every repo.
    common = git(['rev-parse', '--git-common-dir'], root).stdout.strip()
    path = (root / common).resolve() / 'hooks/pre-push'
    active = (root / git(['rev-parse', '--git-path', 'hooks'], root).stdout.strip()).resolve()
    inactive = None
    if action == 'install' and active != path.parent:
        inactive = (f'Installed but NOT active: core.hooksPath={active} runs hooks from '
                    f'there, not from {path.parent}. Add a hand-over to {active}/pre-push, '
                    'for example:\n'
                    '  local_hook="$(git rev-parse --git-common-dir)/hooks/pre-push"\n'
                    '  [ -x "$local_hook" ] && exec "$local_hook" "$@"\n'
                    '  exit 0')
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    before = original.decode() if original is not None else None
    if action == 'install' and original is not None and not os.access(path, os.X_OK):
        raise ValueError(f'{path} exists but is not executable, so Git ignores it; it was '
                         'left unchanged. Make it executable (it will then run on every push) '
                         'or remove it, then install again')
    after = updated_hook(before, action)
    if after == before:
        print(f'No changes: {path}')
    else:
        diff = ''.join(difflib.unified_diff((before or '').splitlines(True),
                                            (after or '').splitlines(True),
                                            fromfile=str(path), tofile=str(path)))
        print(diff, end='')
        if not preview:
            write_file(path, original, after, mode=0o755)
            print(f'Removed {path}' if after is None else f'Updated {path}')
    if inactive:
        print(inactive)
    return 0


# ---------------------------------------------------------------- entry

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # A hook that exits 2 would block every command, so only run and status check this.
    if not sys.platform.startswith('linux') and argv[:1] in (['run'], ['status'], ['affected'],
                                                             ['cleanup-done']):
        warn('only Linux is supported')
        return 2
    command = []
    if '--' in argv:
        cut = argv.index('--')
        argv, command = argv[:cut], argv[cut + 1:]
    parser = argparse.ArgumentParser(prog='suite-gate.py', description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='action', required=True)
    run = sub.add_parser('run', help='run a full suite through the gate: run [--rerun "<reason>"] -- <cmd>, '
                         'or run --registered [suite ...] --purpose <purpose>')
    run.add_argument('--rerun', metavar='REASON', help='run even if this content already passed')
    run.add_argument('--purpose', choices=('post-merge', 'release'),
                     help='why a full suite runs; required with an affected-test map')
    run.add_argument('--reason', metavar='TEXT',
                     help='a free-text purpose instead of --purpose')
    run.add_argument('--registered', nargs='*', metavar='SUITE',
                     help='run the registered full suites (all, or those named by directory '
                          'or command) in their registered form, in a temporary clean '
                          'checkout of HEAD; needs a purpose')
    affected = sub.add_parser('affected', help='run the tests the affected-test map selects '
                                               'for this change: affected [--base <rev>]')
    affected.add_argument('--base', metavar='REV', help='measure the change from this commit '
                          'instead of the merge-base of HEAD and the integration branch')
    status = sub.add_parser('status', help='show running and queued suites and recent records')
    status.add_argument('--json', action='store_true')
    status.add_argument('--fingerprint', metavar='PREFIX', help='only records for this fingerprint')
    status.add_argument('--limit', type=int, default=10)
    done = sub.add_parser('cleanup-done', help='a test cleanup of this project is finished: '
                          'start a new cleanup window for its full suites')
    done.add_argument('--command', metavar='TEXT', help='only this full-suite command, as '
                      'run through the gate from the current directory')
    done.add_argument('--baseline', type=float, metavar='SECONDS', help='the new baseline '
                      '(needs --command); default: the next passing run')
    sub.add_parser('hook', help='PreToolUse hook (matcher Bash) for Claude and Codex; '
                                'reads the payload on stdin')
    pre_push = sub.add_parser('pre-push', help='Git pre-push hook: refuse pushing main or a '
                              'tag without a passing record of every registered full suite')
    pre_push.add_argument('remote', nargs='*', help='remote name and URL, as Git passes them')
    for action in ('install-pre-push', 'uninstall-pre-push'):
        config = sub.add_parser(action, help=f'{action.split("-")[0]} the pre-push check in '
                                'a repo with a registry')
        config.add_argument('--repo', required=True, help='the repo (work tree) to change')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action} the hook in a client\'s settings')
        config.add_argument('--client', choices=('claude', 'codex'), required=True)
        config.add_argument('--claude-settings', metavar='PATH',
                            help='default: $CLAUDE_CONFIG_DIR/settings.json or '
                                 '~/.claude/settings.json')
        config.add_argument('--codex-home', metavar='DIR', help='default: $CODEX_HOME or ~/.codex')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    args = parser.parse_args(argv)
    if args.action == 'run' and args.registered is not None:
        if command:
            parser.error('run --registered takes no command after --')
        return cmd_run_registered(args.registered, args.rerun, args.purpose, args.reason)
    if args.action == 'run':
        if not command:
            parser.error('run needs the suite command after --')
        return cmd_run(args.rerun, args.purpose, args.reason, command)
    if command:
        parser.error(f'{args.action} takes no command')
    if args.action == 'hook':
        return cmd_hook()
    if args.action == 'affected':
        return cmd_affected(args.base)
    if args.action == 'cleanup-done':
        return cmd_cleanup_done(args.command, args.baseline)
    if args.action == 'pre-push':
        return cmd_pre_push()
    if args.action in ('install-pre-push', 'uninstall-pre-push'):
        try:
            return cmd_pre_push_configure(args.action.split('-')[0], args.repo, args.preview)
        except (OSError, ValueError) as exc:
            warn(str(exc))
            return 1
    if args.action in ('install', 'uninstall'):
        try:
            return cmd_configure(args.action, args.client, args.claude_settings,
                                 args.codex_home, args.preview)
        except (OSError, ValueError) as exc:
            warn(str(exc))
            return 1
    return cmd_status(args.json, args.fingerprint, args.limit)


if __name__ == '__main__':
    sys.exit(main())
