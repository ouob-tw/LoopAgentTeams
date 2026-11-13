#!/usr/bin/env python3
"""Host-wide full-suite gate.

`run [--rerun "<reason>"] -- <cmd>` reuses a passing result for identical content, lets
only one of several identical requests run, and starts a queued full suite when the host has
room for its measured peak (with a floor, a cap and a pressure brake); in a project with an
affected-test map it needs a purpose. After each full suite that ran it checks whether the
project is due for a test cleanup and opens or updates a cleanup ticket; `cleanup-done
[--command <cmd> [--baseline <s>]]` starts a new cleanup window. `affected [--base <rev>]`
runs only the tests the map selects for this change, or the registered full suites through
the gate when the change leaves the map; with `--purpose post-merge` (after a batch is
merged, which then replaces the post-merge full suite) it runs in a temporary clean
checkout of HEAD, every record of the run shares a run_id and a final `affected-summary`
record says whether the whole run passed; `--purpose pre-merge` does the same in the work
tree for a branch's final version. In a project without a map, `affected` with a purpose
runs every registered full suite once that way instead. An affected test or check whose content (as the map
sees it) already passed is reused instead of run again. A suite or affected run that fails only in a few
test files (bun test, unittest, pytest) reruns those files once with the map's command
templates and records a pass with the flaky tests when the rerun passes. A full suite that
ran records each test file's time when the output gives it (bun test listing every test,
pytest with --durations=0), and the cleanup ticket lists the slowest files and the window's
flaky tests. `status` lists running and queued suites, why the
queue waits, recent records and cleanup state. `is_full_suite()`
decides whether a shell command is a full suite run (project registry first, then the
default runner rules). `hook` is the PreToolUse hook that blocks full suites run outside
the gate (with an affected-test map it points at `affected` instead), and `install` /
`uninstall --client claude|codex` add or remove it. `pre-push` is the Git pre-push check
that refuses pushing main or a tag without a passing record of every registered full
suite; `install-pre-push` / `uninstall-pre-push --repo <dir>` add or remove it.
`background --repo <dir>` (run hourly by the systemd user timer that `install-background` /
`uninstall-background --repo <dir>` add or remove) runs, in a clean checkout of the local
integration branch, the registered full suites whose content has no pass and whose last pass
is over a day old; a failure opens or comments on a `suite-failure` ticket, or is listed by
`status` without a tracker.

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
import functools
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
# In the fingerprint of every full suite that declares `depends_on`.
GATE_WIDE = (REGISTRY_NAME, f'{MAP_DIR}/**', '.gitignore')
DEFAULTS = {'min_slots': 1, 'max_slots': 8, 'poll_seconds': 1.0, 'report_seconds': 30.0,
            'sample_seconds': 2.0, 'brake_io_high': 40.0, 'brake_io_low': 20.0,
            'brake_cpu_high': 50.0, 'brake_cpu_low': 25.0, 'default_cores': 4.0,
            'default_mem_gb': 4.0, 'mem_reserve_gb': 8.0, 'profile_history': 5,
            'reclaim_grace_seconds': 600.0, 'light_min_slots': 1, 'light_max_slots': 4,
            'light_cores': 2.0, 'light_mem_gb': 2.0}
# The smallest value each key accepts; an int default takes whole numbers only.
MINIMUMS = {'min_slots': 0, 'max_slots': 1, 'profile_history': 1, 'poll_seconds': 0.01,
            'report_seconds': 0.01, 'sample_seconds': 0.01, 'light_max_slots': 1}
BRAKE_PAIRS = (('brake_io_low', 'brake_io_high'), ('brake_cpu_low', 'brake_cpu_high'))
GIB = 2 ** 30
TESTS_SLICE = 'lat-tests.slice'  # the user slice that caps every suite's CPU; SUITE_GATE_SLICE overrides
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
    or `%b` form or an escape other than `\\n`, or a heredoc substitution with an unclosed
    quote or a backtick pair holding a backslash. The command counts as a full suite."""


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
    """The text inside each `$(...)` and backtick pair of a heredoc body the shell expands,
    and of each one nested in those, quoted or not.

    A `$(...)` ends at the `)` that closes it outside quotes, as the shell reads it.
    UnreadableShellInput when one holds an unclosed quote, or a backtick pair holds a
    backslash, which can move its end."""
    found, i = [], 0
    while i < len(text):
        end = _substitution(text, i, found)
        if end is not None:
            i = end + 1
        else:
            i += 2 if text[i] == '\\' else 1
    return found


def _substitution(text, i, found):
    """When a `$(` or backtick starts at i, add its text and every substitution nested in
    it to found and return the index of its last character; otherwise None."""
    if text.startswith('$(', i):
        end = _substitution_end(text, i + 2, found)
        found.append(text[i + 2:end])
        return end
    if text[i] == '`':
        end = text.find('`', i + 1)
        end = len(text) if end < 0 else end
        if '\\' in text[i + 1:end]:
            raise UnreadableShellInput('escapes in a heredoc backtick substitution')
        found.append(text[i + 1:end])
        return end
    return None


def _substitution_end(text, i, found):
    """Index of the `)` that closes a `$(` whose text starts at i (len(text) when none),
    skipping quoted text and escapes; substitutions nested in it are added to found."""
    depth = 1
    while i < len(text):
        c = text[i]
        if c == '\\':
            i += 2
            continue
        if (end := _substitution(text, i, found)) is not None:
            i = end
        elif c == "'":
            i = text.find("'", i + 1)
            if i < 0:
                raise UnreadableShellInput('unclosed quote in a heredoc substitution')
        elif c == '"':
            i += 1
            while i < len(text) and text[i] != '"':
                if (end := _substitution(text, i, found)) is not None:
                    i = end
                elif text[i] == '\\':
                    i += 1
                i += 1
            if i >= len(text):
                raise UnreadableShellInput('unclosed quote in a heredoc substitution')
        elif c == '(':
            depth += 1
        elif c == ')':
            depth -= 1
            if not depth:
                return i
        i += 1
    return len(text)


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
    if isinstance(patterns, list) and patterns:
        return _matches_patterns(commands, patterns)
    for words in (words for words in commands if not _carries_text(words)):
        found = _unwrap(words)
        if found and not _is_targeted(*found):
            return True
    return False


def _matches_patterns(commands, patterns):
    """True when the simple commands (split_commands) match a registry pattern list."""
    runs = [words for words in commands if not _carries_text(words)]
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


def is_heavy(command, cwd='.', registry=None):
    """True when a shell command matches the registry's `heavy` patterns (fnmatch, read like
    `suites`): test files and builds an agent picks that run through the light path."""
    if registry is None:
        registry = load_registry(cwd) or {}
    patterns = registry.get('heavy') if isinstance(registry, dict) else None
    if not isinstance(patterns, list) or not patterns:
        return False
    try:
        return _matches_patterns(split_commands(command), patterns)
    except UnreadableShellInput:
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


def content_tree(root, include=(), commit=None, scope=None):
    """Tree hash of tracked plus unignored new files (or of commit's tree when given), plus
    the `include` paths from the work tree, via a throwaway index so the real one is
    untouched. With scope (path globs), only the files matching one of them count."""
    with tempfile.TemporaryDirectory(prefix='suite-gate-') as tmp:
        env = _fill_index(root, Path(tmp) / 'index', include, commit)
        if scope is not None:
            kept = [e for e in _index_entries(root, env)
                    if any(glob_match(e.split('\t', 1)[1], p) for p in scope)]
            env = dict(env, GIT_INDEX_FILE=str(Path(tmp) / 'scoped'))
            result = subprocess.run(['git', 'update-index', '-z', '--index-info'], cwd=root,
                                    env=env, input=''.join(e + '\0' for e in kept),
                                    capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f'git update-index failed: {result.stderr.strip()}')
        result = git(['write-tree'], root, env)
        if result.returncode != 0:
            raise RuntimeError(f'git write-tree failed: {result.stderr.strip()}')
        return result.stdout.strip()


def _fill_index(root, index, include=(), commit=None):
    """Fill the throwaway index file with tracked plus unignored new files (or commit's tree)
    and the `include` paths, as content_tree() counts them: the environment that uses it."""
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
    return env


def _index_entries(root, env):
    """The entries of the index env names, each "<mode> <object> <stage>\t<path>" (the form
    --index-info reads)."""
    listed = git(['ls-files', '--stage', '-z'], root, env)
    if listed.returncode != 0:
        raise RuntimeError(f'git ls-files failed: {listed.stderr.strip()}')
    return [e for e in listed.stdout.split('\0') if e]


def normalize_command(argv):
    """The command text: a shell string keeps its own text, since quoting and expansion
    change what runs; split arguments are quoted back into one string. The fingerprint
    also keeps the mode, because sh and a direct exec can run the same text differently."""
    if len(argv) == 1:
        return argv[0].strip()
    return shlex.join(argv)


@functools.lru_cache(maxsize=None)
def sh_has_pipefail():
    return subprocess.run(['/bin/sh', '-c', 'set -o pipefail'],
                          capture_output=True).returncode == 0


def shell_argv(command):
    """The argv that runs a shell string. A command with a pipe runs with pipefail, so a
    failing earlier stage is the run's failure instead of the last stage's status hiding it;
    one without a pipe runs under plain /bin/sh as always. /bin/sh is dash on some hosts and
    has no pipefail there, so bash in POSIX mode (the closest to sh) stands in for it. Any `|`
    in the text counts, quoted or not. pipefail alone changes nothing without a real
    pipeline, but where bash stands in for dash a command that relies on dash-only
    behaviour (e.g. `echo -e`) can behave differently. The fingerprint is made from the
    command text alone, so it does not change."""
    if '|' not in command:
        return ['/bin/sh', '-c', command]
    if sh_has_pipefail():
        return ['/bin/sh', '-o', 'pipefail', '-c', command]
    bash = shutil.which('bash')
    if bash:
        return [bash, '-o', 'posix', '-o', 'pipefail', '-c', command]
    raise OSError('the command has a pipe, and neither /bin/sh nor bash supports pipefail, '
                  'so a failing earlier stage could not be told from a pass')


def include_patterns(registry):
    return [p for p in registry.get('fingerprint_include') or [] if isinstance(p, str)]


def digest(tree, argv, rel):
    mode = 'shell' if len(argv) == 1 else 'exec'
    command = normalize_command(argv)
    return hashlib.sha256(f'{tree}\0{mode}\0{command}\0{rel}'.encode()).hexdigest()


def rel_cwd(root, cwd):
    return os.path.relpath(Path(cwd).resolve(), root.resolve())


def suite_scope(root, registry, rel, argv):
    """The path globs the fingerprint of argv run in rel covers: for a registered full suite
    that declares `depends_on`, its directory, the gate-wide files, the `fingerprint_include`
    patterns and the declared paths; None (the whole repo) for anything else."""
    if len(argv) != 1 or rel == '.':
        return None
    try:
        suites = read_full_suites(registry)
    except ValueError:
        return None
    command = normalize_command(argv)
    suite = next((s for s in suites if s['command'] == command
                  and rel_cwd(root, suite_cwd(root, s)) == rel), None)
    if suite is None or suite.get('depends_on') is None:
        return None
    return [f'{rel}/**', *GATE_WIDE, *include_patterns(registry), *suite['depends_on']]


def fingerprint(cwd, argv):
    """Dict with fingerprint, tree, repo, relative cwd and profile key; None outside a Git
    work tree."""
    root = repo_root(cwd)
    if root is None:
        return None
    registry = load_registry(cwd) or {}
    rel = rel_cwd(root, cwd)
    tree = content_tree(root, include_patterns(registry),
                        scope=suite_scope(root, registry, rel, argv))
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
    holders = [*state['locks'].values(), *state['slots'], *state['light']]
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
                  'light': any(h['id'] == holder_id for h in state['light']),
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
    state['light'] = [h for h in state['light'] if h['id'] not in expired]


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
            state['light'] = [h for h in state.get('light', []) if holder_alive(h)]
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


def admission(config, running, candidate, host, light=()):
    """(admit, reason why not) for the first suite in the queue.

    running: (cores, bytes) of unused reservation per running suite; candidate: (cores, bytes)
    it reserves; host: from host_view; light: the same for light-path runs, which count only
    in whether the reservation fits. The cap comes first, then the floor (below it nothing
    else is checked), then the brake, then whether the reservation fits.
    """
    count, cap = len(running), config['max_slots']
    if count >= cap:
        return False, f'host cap reached: {count}/{cap} suites running'
    if count < min(config['min_slots'], cap):
        return True, None
    return host_fit(config, [*running, *light], candidate, host)


def host_fit(config, running, candidate, host):
    """(admit, reason why not) past the floor: readable host data, the brake off, and the
    candidate's reservation fits beside the unused reservations in running."""
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

def scope_slice_args():
    """`--slice=` for a suite's scope: empty SUITE_GATE_SLICE puts the scope in no slice. A slice
    nobody installed is created without limits, so a host without it still runs the suite."""
    name = os.environ.get('SUITE_GATE_SLICE', TESTS_SLICE)
    return [f'--slice={name}'] if name else []


def tests_slice_cores():
    """The CPU cap of lat-tests.slice in cores, from TESTS_CPU_QUOTA (e.g. `2000%` = 20 cores) in
    the conf the slice installer reads (~/.config/lat-cpu/slices.conf, or $LAT_CPU_CONF);
    None when the file or key is missing or not a percentage."""
    conf = os.environ.get('LAT_CPU_CONF') or str(
        Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'lat-cpu/slices.conf')
    try:
        text = Path(conf).read_text()
    except OSError:
        return None
    found = re.findall(r'^TESTS_CPU_QUOTA=["\']?(\d+(?:\.\d+)?)%', text, re.M)
    return float(found[-1]) / 100 if found else None


class Gate:
    light = False  # a light-path run (LightGate) keeps its fixed reservation without a group

    def __init__(self, argv, cwd, rerun, config, extra=None, template=False):
        self.argv = argv
        self.template = template  # built by the gate from an affected.commands template
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
        self.record = None  # the record this gate wrote: a run's or a reuse note
        self.reused = None  # the earlier pass this gate reused instead of running
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
            light = [unused_reservation(h, self.config) for h in state['light']]
            admit, reason = admission(self.config, running, reservation_of(mine, self.config)[:2],
                                      host_view(state, self.config), light)
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
            for holder in [*state['locks'].values(), *state['slots'], *state['light']]:
                if holder['id'] == self.me['id']:
                    holder['sid'], holder['cgroup'] = sid, group
                    if group is None and not self.light:
                        holder['reservation'] = None
        self.me['sid'], self.me['cgroup'] = sid, group
        if group is None and not self.light:
            self.me['reservation'] = None
        with_state(change)

    def store_sample(self, cores, mem):
        def change(state):
            for holder in [*state['slots'], *state['light']]:
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
            state['light'] = [h for h in state['light'] if still_held(h)]
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
        self.reused = record
        if self.extra.get('purpose'):
            self.record = {
                'kind': 'reuse', 'reused_fingerprint': info['fingerprint'], 'tree': info['tree'],
                'repo': info['repo'], 'command': self.command, 'cwd': str(self.cwd),
                'rel_cwd': info['rel_cwd'], 'exit_code': 0, 'agent': self.me['agent'],
                'time': now_iso(), 'reusable': False, 'reused_time': record.get('time'),
                'reused_agent': record.get('agent'), 'purpose': None, 'purpose_reason': None,
                'reused_failed_first': failed_first(record), **self.extra}
            append_record(self.record)
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

    def _start(self, argv, scoped, cwd):
        """Start the suite in cwd held on fd 3 until its session (and group) is recorded.

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
                      *scope_slice_args(), f'--unit={unit}', '--', '/bin/sh', '-c', SCOPE_LAUNCHER, 'suite-gate',
                      *argv]
        # An interrupt must not land between starting the session and recording it.
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            try:
                child = subprocess.Popen(launch, cwd=cwd, stdout=subprocess.PIPE,
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

    def _run_command(self, argv, cwd, scan=None):
        """Run argv in cwd as this gate's suite, its output passed through (and fed to scan),
        and wait for it: (exit code, output tail, profile, seconds, start, end), the start
        and end as UTC datetimes. OSError when it cannot start."""
        self.child = self.group = self.sampler = self.keeper = self.keeper_pid = None
        self.finished = False
        started = time.monotonic()
        # The reaper logs whole seconds; a kill in the run's first second must still count.
        started_at = datetime.now(timezone.utc).replace(microsecond=0)
        child = self._start(argv, True, cwd) if self._scope_ready() else None
        child = child or self._start(argv, False, cwd)
        tail = Tail()
        pumps = [threading.Thread(target=pump, args=(stream, out, tail, scan, key), daemon=True)
                 for key, stream, out in (('out', child.stdout, sys.stdout.buffer),
                                          ('err', child.stderr, sys.stderr.buffer))]
        for thread in pumps:
            thread.start()
        code = child.wait()
        self.finished = True
        ended_at = datetime.now(timezone.utc)
        for thread in pumps:
            thread.join(timeout=2)
        if scan:
            scan.finish()
        profile = self.measure(time.monotonic() - started)
        return (128 - code if code < 0 else code, tail, profile, time.monotonic() - started,
                started_at, ended_at)

    def plan_rerun(self, scan):
        """rerun_plan() for this run's output, with the project's affected.commands; why not
        when the project has no affected-test map."""
        root = repo_root(self.cwd)
        registry = load_registry(self.cwd) if root else None
        if not is_mapped(registry or {}):
            return 'this project has no affected-test map to rerun single test files with'
        try:
            commands = read_map(registry)['commands']
        except ValueError as exc:
            return f'the affected-test map cannot be read ({exc})'
        text = self.argv[0] if len(self.argv) == 1 else shlex.join(self.argv)
        runs = template_runs(text, self.cwd) if self.template else test_runs(text, self.cwd)
        plan = rerun_plan(scan, runs, self.cwd, root, commands)
        return plan if isinstance(plan, str) else (root, commands, *plan)

    def rerun_failed(self, root, commands, groups, first_code):
        """Run the failed test files of each affected.commands directory once with its
        template: the record's `rerun` entry, its exit_code the first failing one's."""
        runs, started = [], time.monotonic()
        for directory, tests in groups.items():
            text, cwd = affected_text(root, commands, directory, tests)
            warn(f'rerunning {len(tests)} failed test file(s) once in {directory}: {text}')
            try:
                code, tail, _, seconds, _, _ = self._run_command(shell_argv(text), cwd)
            except OSError as exc:
                warn(f'could not start the rerun: {exc}')
                code, tail, seconds = first_code, None, 0.0
            runs.append({'dir': directory, 'command': text, 'tests': tests, 'exit_code': code,
                         'duration_s': round(seconds, 1),
                         'output_tail': tail.text() if tail else ''})
        return {'exit_code': next((r['exit_code'] for r in runs if r['exit_code']), 0),
                'first_exit_code': first_code,
                'duration_s': round(time.monotonic() - started, 1), 'runs': runs}

    def execute(self, info):
        start_iso = now_iso()
        scan = TestScan()
        try:
            argv = shell_argv(self.argv[0]) if len(self.argv) == 1 else self.argv
            code, tail, profile, seconds, started_at, ended_at = self._run_command(
                argv, self.cwd, scan)
        except OSError as exc:
            warn(f'could not start the command: {exc}')
            return 127
        reaped = (reaped_during(self.cwd, started_at, ended_at) if code == 0
                  else reaped_after_failure(self.cwd, started_at, ended_at))
        duration = round(seconds, 1)
        after = fingerprint(self.cwd, self.argv) if info else None
        changed = info is not None and after['fingerprint'] != info['fingerprint']
        rerun = flaky = None
        if code and info is not None:
            plan = 'the content changed during the run' if changed else self.plan_rerun(scan)
            if isinstance(plan, str):
                rerun = {'skipped': plan}
                warn(f'failed tests not rerun: {plan}')
            else:
                root, commands, groups, names = plan
                rerun = self.rerun_failed(root, commands, groups, code)
                code = rerun['exit_code']
                changed = fingerprint(self.cwd, self.argv)['fingerprint'] != info['fingerprint']
                if code == 0:
                    flaky = [{'file': path, 'tests': tests} for path, tests in names.items()]
                    warn('PASSED ONLY ON RERUN: the rerun passed, so the run counts as passed '
                         'but is marked rerun-only for a reviewer to look at; these tests '
                         'failed first: ' + '; '.join(
                             f"{f['file']} ({', '.join(f['tests'])})" for f in flaky))
                else:
                    warn(f'the rerun failed too (exit {code}): the run counts as failed')
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
        if rerun is not None:
            record.update(rerun=rerun, flaky=flaky or [], rerun_only=bool(flaky))
        full = not self.extra.get('kind')
        files = full and scan.file_seconds(self.cwd, info and info['repo'],
                                           pytest=pytest_durations_0(self.argv, self.cwd))
        if files:
            record['file_seconds'] = files
        record.update(self.extra)
        append_record(record)
        self.record = record
        if info is not None and full:
            self.ran = {'info': info, 'seconds': seconds, 'sample': record['reusable'],
                        'time': start_iso, 'files': files if code == 0 else {},
                        'flaky': flaky or []}
        elif info is not None and flaky:
            count_flaky_in_project(info, flaky, start_iso)
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


# ---------------------------------------------------------------- light path
# Test files and builds an agent picks while editing: queued in their own slots so a short
# run never waits behind a full suite, but within the host's brake and the test slice's CPU
# limit. No fingerprint, no reuse and no record: a light run is never merge evidence.

LIGHT_BUDGET_FALLBACK = 20.0  # cores, when the test slice's CPU limit cannot be read


def light_budget():
    """The test slice's CPU limit in cores; the light path's reservations stay within it."""
    return tests_slice_cores() or LIGHT_BUDGET_FALLBACK


def light_reservation(config):
    return {'cpu_cores': config['light_cores'], 'mem_bytes': config['light_mem_gb'] * GIB}


def light_admission(config, light, reserved, candidate, host, suites=(), budget=None):
    """(admit, reason why not) for the first light run in its queue.

    light: (cores, bytes) of unused reservation per running light run; reserved: the cores
    they reserve in all; candidate: (cores, bytes); suites: the unused reservations of the
    running full suites. The light cap comes first, then the floor, then the test slice's
    CPU limit on the sum of light reservations, then host_fit().
    """
    count, cap = len(light), config['light_max_slots']
    if count >= cap:
        return False, f'light-path cap reached: {count}/{cap} running'
    if count < min(config['light_min_slots'], cap):
        return True, None
    budget = light_budget() if budget is None else budget
    if reserved + candidate[0] > budget:
        return False, (f'light-path reservations would pass the test slice CPU limit: '
                       f'{fmt_num(reserved)} reserved + {fmt_num(candidate[0])} > '
                       f'{fmt_num(budget)} cores')
    return host_fit(config, [*suites, *light], candidate, host)


def inside_gate(state):
    """True when this process runs inside a group (or session) the gate started for a full
    suite or a light run, which already holds a slot."""
    mine = process_cgroup(os.getpid())
    sid = os.getsid(0)
    for holder in [*state.get('slots', []), *state.get('light', [])]:
        group = holder.get('cgroup')
        if group and mine and (mine == group or mine.startswith(group + '/')):
            return True
        if not group and holder.get('sid') == sid:
            return True
    return False


class LightGate(Gate):
    """A light run: its own queue and slots (`state['light']`), a fixed reservation, run in
    its own scope like a suite, nothing recorded."""
    light = True

    def __init__(self, argv, cwd, config):
        super().__init__(argv, cwd, None, config)

    def acquire_slot(self):
        def attempt(state):
            mine = next((w for w in state['waiters'] if w['id'] == self.me['id']
                         and w.get('kind') == 'light'), None)
            if mine is None:
                state['seq'] += 1
                mine = self._holder(kind='light', seq=state['seq'],
                                    reservation=light_reservation(self.config))
                state['waiters'].append(mine)
            self.me['reservation'] = mine['reservation'] = light_reservation(self.config)
            ahead = [w for w in state['waiters']
                     if w.get('kind') == 'light' and w['seq'] < mine['seq']]
            if ahead:
                mine['reason'] = f'{len(ahead)} light run(s) queued ahead'
                return None
            light = [unused_reservation(h, self.config) for h in state['light']]
            reserved = sum(reservation_of(h, self.config)[0] for h in state['light'])
            suites = [unused_reservation(h, self.config) for h in state['slots']]
            admit, reason = light_admission(
                self.config, light, reserved, reservation_of(mine, self.config)[:2],
                host_view(state, self.config), suites)
            if admit:
                state['waiters'].remove(mine)
                state['light'].append(self._holder())
                return True
            mine['reason'] = reason
            return None

        def describe(state):
            mine = next((w for w in state['waiters'] if w['id'] == self.me['id']), None)
            return (f"waiting for a light-path slot ({len(state['light'])}/"
                    f"{self.config['light_max_slots']} in use): {(mine or {}).get('reason')}")

        self._wait(attempt, describe)

    def run(self):
        self.acquire_slot()
        argv = shell_argv(self.argv[0]) if len(self.argv) == 1 else self.argv
        try:
            code, _, _, seconds, _, _ = self._run_command(argv, self.cwd)
        except OSError as exc:
            warn(f'could not start the command: {exc}')
            return 127
        warn(f'light run exited {code} in {fmt_seconds(seconds)} (not recorded)')
        return code


def cmd_light(argv):
    """Run a test file or build an agent picked through the light path. A full suite is
    refused (it goes through `run` or `affected`); inside a group the gate started, the
    command runs directly, since that group already holds a slot."""
    cwd = Path.cwd()
    text = argv[0] if len(argv) == 1 else shlex.join(argv)
    if gate_rewrite(text, cwd):
        warn('this runs a full test suite; the light path is only for the test files and '
             'builds you pick. A full suite goes through `run` (or `affected` in a project '
             'with an affected-test map); run the command without `light` and the hook '
             'replies with the exact command')
        return 2
    if with_state(inside_gate):
        command = shell_argv(text) if len(argv) == 1 else list(argv)
        os.execvp(command[0], command)
    gate = LightGate(argv, cwd, load_config())
    return _guarded(lambda: _drive(gate, gate.run))


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


def pump(stream, out, tail, scan=None, key=None):
    fd = stream.fileno()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk:
            return
        tail.add(chunk)
        if scan:
            scan.add(key, chunk)
        out.write(chunk)
        out.flush()


# ---------------------------------------------------------------- failed-test rerun

RERUN_MAX_FILES = 10      # more failed test files than this are not rerun
SCAN_MAX_FAILURES = 1000  # failures kept from one output; more could never be rerun
SCAN_MAX_LINE = 65536     # bytes of an unfinished line kept while it streams
# The runners whose output the rerun reads, by the name it reports them under.
RERUN_TOOLS = {'bun-test': 'bun test', 'unittest': 'unittest',
               'unittest-discover': 'unittest', 'pytest': 'pytest'}
SHELL_KEYWORDS = {'if', 'then', 'else', 'elif', 'fi', '!', '{', '}'}
# Commands known not to start a test runner: build tools, text and file commands.
NO_TEST_COMMANDS = {'vite', 'svelte-kit', 'svelte-check', 'tsc', 'printf', 'echo', 'grep',
                    'true', 'false', ':', 'exit', 'test', '[', 'mkdir', 'rm', 'cp', 'mv',
                    'touch', 'cat'}
# Options that run a command in another directory (uv run, the test runners, package managers).
CWD_OPTIONS = {'-C', '--chdir', '--cwd', '--directory', '--project', '--prefix', '--dir',
               '--workspace', '-w'}
PYTEST_CONFIGS = ('pytest.ini', '.pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini')
PYTEST_STOP = re.compile(r'(?<![\w-])(?:-[a-wyzA-Z]*x\w*|--exitfirst|--maxfail|--sw|'
                         r'--stepwise\S*|--sw-skip)(?![\w-])')
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
BUN_HEADER = re.compile(r'(\S+\.[cm]?[jt]sx?):')
BUN_FAIL = re.compile(r'\(fail\) (.+?)(?: \[([\d.]+)(m?s)\])?')
BUN_PASS = re.compile(r'\(pass\) .+?(?: \[([\d.]+)(m?s)\])?')  # a very fast test has no time
BUN_COUNT = re.compile(r' (\d+) (pass|fail|errors?)')
BUN_FAILED_LIST = re.compile(r'\d+ tests? failed:')  # the closing list of failures
BUN_DONE = re.compile(r'Ran \d+ tests? across \d+ files?\. \[.*\]')
UT_FAIL = re.compile(r'(FAIL|ERROR): (\S+) \(([^()\s]+)\)(?: .*)?')
UT_RAN = re.compile(r'Ran \d+ tests? in [\d.]+s')
UT_END = re.compile(r'(?:OK|FAILED)(?: \((.*)\))?')
PT_ROOT = re.compile(r'rootdir: (.+?)(?:, (?:configfile|inifile|testpaths|plugins): .*)?')
PT_FAILED = re.compile(r'FAILED (\S+?)::(.+?)(?: - .*)?')
PT_ERROR = re.compile(r'ERROR (\S+?)(?:::(.+?))?(?: - .*)?')
PT_COLLECT = re.compile(r'_+ ERROR collecting .* _+')
PT_STATS = re.compile(r'(?:=+ )?(\d+ \w+(?:, \d+ \w+)*) in [\d.]+s(?: \([^)]*\))?(?: =+)?')
PT_DURATIONS = re.compile(r'=+ slowest durations =+')  # the header of --durations=0 only
PT_DURATION = re.compile(r'([\d.]+)s (?:setup|call|teardown) +(\S.*)')
PT_WORDS = {'failed', 'passed', 'error', 'errors', 'skipped', 'xfailed', 'xpassed',
            'deselected', 'warning', 'warnings', 'rerun'}


class TestScan:
    """What the failed-test rerun needs from a run's output, read line by line while it
    streams, per output stream (bun and unittest write to stderr, pytest to stdout).
    failures are (tool, where, name): where is the file (bun, pytest) or test id (unittest)
    the failure names, None when it names none; counted is how many failures the summary
    lines report and summaries how many complete summary lines each tool printed; problems
    are reasons the output shows the run is not just some failed tests. It also adds up
    each test file's time from bun's per-test times and pytest's `slowest durations`
    section (file_seconds())."""

    def __init__(self):
        self.lock = threading.Lock()  # the stdout and stderr pumps feed it from two threads
        self.partial = {}
        self.bun_file = {}
        self.bun_list = {}  # in bun's closing list of the failures already shown
        self.ut_ran = {}
        self.failures = []
        self.overflow = False
        self.summaries = dict.fromkeys(('bun test', 'unittest', 'pytest'), 0)
        self.counted = dict.fromkeys(('bun test', 'unittest', 'pytest'), 0)
        self.problems = []
        self.roots = []
        self.bun_seconds = {}
        self.bun_results = self.bun_counted = 0  # result lines under a file, summaries pass + fail
        self.pt_durations = {}
        self.pt_seconds = {}

    def add(self, key, chunk):
        *lines, rest = (self.partial.get(key, b'') + chunk).split(b'\n')
        self.partial[key] = rest[-SCAN_MAX_LINE:]
        with self.lock:
            for line in lines:
                self._line(key, line)

    def finish(self):
        for key, rest in list(self.partial.items()):
            if rest:
                self._line(key, rest)
        self.partial = {}

    def _problem(self, why):
        if why not in self.problems:
            self.problems.append(why)

    def file_seconds(self, cwd, root=None, pytest=False):
        """{test file: seconds}, slowest first; a file found in the repository at root is
        named by its repository path, as the flaky tests are. pytest's times count only
        when pytest is true (the command passes it --durations=0); bun's only when the
        output listed every passed and failed test: run by an AI agent (CLAUDECODE=1) bun
        prints only the failed ones."""
        parts = [('pytest', self.pt_seconds)] if pytest else []
        if self.bun_results and self.bun_results == self.bun_counted:
            parts.append(('bun test', self.bun_seconds))
        real_root = root and os.path.realpath(root)
        times = {}
        for tool, by_file in parts:
            for where, seconds in by_file.items():
                path = real_root and failure_file(tool, where, self, None, cwd)
                rel = path and os.path.relpath(os.path.realpath(path), real_root)
                name = rel if rel and not rel.startswith('..') else where
                times[name] = times.get(name, 0) + seconds
        return {path: round(seconds, 3)
                for path, seconds in sorted(times.items(), key=lambda item: -item[1])}

    def _bun_time(self, key, value, unit):
        """A pass or fail line under a file counts toward the summaries' pass + fail, timed
        or not: bun prints no time for a very fast test, which adds none."""
        path = self.bun_file.get(key)
        if not path:
            return
        self.bun_results += 1
        if value is not None:
            seconds = float(value) / (1000 if unit == 'ms' else 1)
            self.bun_seconds[path] = self.bun_seconds.get(path, 0) + seconds

    def _fail(self, tool, where, name):
        if len(self.failures) < SCAN_MAX_FAILURES:
            self.failures.append((tool, where, name))
        else:
            self.overflow = True

    def _line(self, key, raw):
        line = ANSI.sub('', raw.decode(errors='replace')).rstrip('\r')
        if self.ut_ran.get(key) and line.strip():
            self.ut_ran[key] = False
            if m := UT_END.fullmatch(line):
                self.summaries['unittest'] += 1
                counts = dict(part.strip().rsplit('=', 1) for part in (m[1] or '').split(',')
                              if '=' in part)
                self.counted['unittest'] += sum(
                    int(counts.get(k, 0)) for k in ('failures', 'errors', 'unexpected successes'))
                return
        if self.pt_durations.get(key):
            if m := PT_DURATION.fullmatch(line):
                path = m[2].split('::')[0]
                self.pt_seconds[path] = self.pt_seconds.get(path, 0) + float(m[1])
                return
            if line.startswith('='):
                self.pt_durations[key] = False
        if m := BUN_HEADER.fullmatch(line):
            self.bun_file[key] = m[1]
            self.bun_list[key] = False
        elif BUN_FAILED_LIST.fullmatch(line):
            self.bun_list[key] = True
        elif self.bun_list.get(key) and (m := BUN_FAIL.fullmatch(line)):
            # A repeat of a failure shown under its file: only one never shown is kept,
            # with no file, so the rerun is not trusted with it.
            if not any(f[0] == 'bun test' and f[2] == m[1] for f in self.failures):
                self._fail('bun test', None, m[1])
        elif m := BUN_PASS.fullmatch(line):
            self._bun_time(key, m[1], m[2])
        elif m := BUN_FAIL.fullmatch(line):
            self._fail('bun test', self.bun_file.get(key), m[1])
            self._bun_time(key, m[2], m[3])
        elif m := BUN_COUNT.fullmatch(line):
            self.bun_list[key] = False
            if m[2] in ('pass', 'fail'):
                self.bun_counted += int(m[1])
            if m[2] == 'fail':
                self.counted['bun test'] += int(m[1])
            elif m[2] != 'pass' and int(m[1]):
                self._problem('bun test reported an error outside the tests')
        elif BUN_DONE.fullmatch(line):
            self.summaries['bun test'] += 1
            self.bun_file[key] = None
            self.bun_list[key] = False
        elif line.startswith('Bailed out after'):
            self._problem('bun test stopped at the first failure (--bail)')
        elif line == '# Unhandled error between tests':
            self._problem('bun test reported an error outside a test, such as a test file '
                          'that failed to load')
        elif m := UT_FAIL.fullmatch(line):
            if m[3].startswith('unittest.'):
                self._problem(f'unittest could not load {m[2]}')
            else:
                self._fail('unittest', m[3], m[2])
        elif UT_RAN.fullmatch(line):
            self.ut_ran[key] = True
        elif PT_DURATIONS.fullmatch(line):
            self.pt_durations[key] = True
        elif m := PT_ROOT.fullmatch(line):
            self.roots.append(m[1])
        elif PT_COLLECT.fullmatch(line):
            self._problem('pytest could not collect every test file')
        elif line.startswith('!!!'):  # pytest's banner when a run stops early
            self._problem('pytest stopped after the first failures' if 'stopping after' in line
                          else f"pytest was interrupted ({line.strip('! ')})")
        elif m := PT_FAILED.fullmatch(line):
            self._fail('pytest', m[1], m[2])
        elif m := PT_ERROR.fullmatch(line):
            if m[2] is None:
                self._problem(f'pytest could not collect {m[1]}')
            else:
                self._fail('pytest', m[1], m[2])
        elif (m := PT_STATS.fullmatch(line)) and all(
                part.split()[1] in PT_WORDS for part in m[1].split(', ')):
            self.summaries['pytest'] += 1
            for part in m[1].split(', '):
                count, word = part.split()
                if word in ('failed', 'error', 'errors'):
                    self.counted['pytest'] += int(count)


DURATIONS_0 = re.compile(r'(?<!\S)--durations(?:=|\s+)0(?!\S)')


def pytest_durations_0(argv, cwd):
    """Whether the command passes --durations=0: in its own words, or to pytest in the
    package.json script it runs."""
    text = argv[0] if len(argv) == 1 else shlex.join(argv)
    if DURATIONS_0.search(text):
        return True
    runs = test_runs(text, cwd)
    return not isinstance(runs, str) and any(
        runner == 'pytest' and DURATIONS_0.search(shlex.join(args)) for runner, args in runs)


def package_scripts(cwd):
    """The scripts of cwd's package.json, or None when it has none that can be read."""
    try:
        scripts = json.loads((Path(cwd) / 'package.json').read_text()).get('scripts')
    except (OSError, ValueError, AttributeError):
        return None
    return scripts if isinstance(scripts, dict) else None


def _runner_form(words):
    """(runner, args) when words, after `VAR=value` assignments, are a test run the rerun
    trusts: `bun test ...`, `pytest ...` or `python -m unittest|pytest ...`, optionally
    after `uv run <options>` that keep the directory; None otherwise."""
    words = _strip_assignments(words)
    if words[:2] == ['uv', 'run']:
        i = _skip_options(words, 2, UV_VALUE)
        if any(w.split('=', 1)[0] in CWD_OPTIONS for w in words[2:i]):
            return None
        words = words[i:]
    if not words or any(w.split('=', 1)[0] in CWD_OPTIONS for w in words):
        return None
    head = os.path.basename(words[0])
    if not (head == 'bun' and words[1:2] == ['test'] or head == 'pytest'
            or head.startswith('python') and words[1:2] == ['-m']
            and words[2:3] in (['unittest'], ['pytest'])):
        return None
    return _unwrap(words)


def _bun_script(words):
    """(script name, forwarded arguments) of `bun run <script> [--] [args]`, or None."""
    if words[:2] != ['bun', 'run'] or len(words) < 3 or words[2].startswith('-'):
        return None
    extra = words[3:]
    return words[2], extra[1:] if extra[:1] == ['--'] else extra


def test_runs(command, cwd, depth=0):
    """[(runner, args)] of the test run a shell string makes in cwd, when the rerun can
    vouch that a failed test is its only failure; otherwise why not. Trusted is a single
    command with no shell operators, variables or substitutions (see _runner_form), or
    `bun run <script>` whose package.json script is such a command, optionally after
    `bun run <script> &&` steps: each of those runs in its own process, and its failure
    stops the tests. Arguments after the script name are appended to it, as bun does."""
    if any(c in command for c in '$`'):
        return 'the command expands variables or substitutions, which the gate cannot follow'
    try:
        found = _simple_commands(command)
    except ValueError:
        return 'the command cannot be read'
    if not found:
        return 'the command runs nothing'
    if any(heredocs or level for _, _, heredocs, _, level in found) \
            or any(sep != '&&' for *_, sep, _ in found[:-1]) \
            or found[-1][3] not in ('\n', ';') \
            or depth == 0 and len(found) > 1 \
            or any(_bun_script(words) is None for words, *_ in found[:-1]):
        return ('the rerun trusts only a single test command (bun test, bun run <script>, '
                'pytest, python -m unittest or pytest, optionally after uv run), and this '
                'command is more than that')
    runs = []
    for words, *_ in found[:-1]:
        inner = script_test_runs(_bun_script(words), cwd, depth)
        if isinstance(inner, str):
            return inner
        runs += inner
    words = found[-1][0]
    script = _bun_script(_strip_assignments(words))
    if script is None:
        run = _runner_form(words)
        if run is None:
            return (f'`{shlex.join(words)}` is not a test command the rerun trusts (bun '
                    'test, bun run <script>, pytest, python -m unittest or pytest, '
                    'optionally after uv run), or it changes directory')
        return runs + [run]
    inner = script_test_runs(script, cwd, depth)
    if isinstance(inner, str):
        return inner
    if not inner:
        return f'the package.json script `{script[0]}` runs no test the rerun trusts'
    return runs + inner


def script_test_runs(script, cwd, depth):
    """Every test run `bun run <script> [args]` can reach: its pre<script>, then its body
    with the arguments appended; [] when neither can start a test runner at all (a build).
    Why not when one is there that the gate cannot list, or a post<script> runs after."""
    name, extra = script
    scripts = package_scripts(cwd) or {}
    body = scripts.get(name)
    if depth >= 5 or not isinstance(body, str):
        return f'cannot read the package.json script `{name}`'
    if f'post{name}' in scripts:
        return f'the package.json script `post{name}` runs after `{name}`'
    runs = []
    if f'pre{name}' in scripts:
        runs = script_test_runs((f'pre{name}', []), cwd, depth + 1)
        if isinstance(runs, str):
            return runs
    text = ' '.join([body, *map(shlex.quote, extra)])
    inner = test_runs(text, cwd, depth + 1)
    if isinstance(inner, str):
        if may_run_tests(text, cwd, depth + 1):
            return (f'the package.json script `{name}` may run tests the gate cannot list '
                    f'({inner})')
        inner = []
    return runs + inner


def _plain_words(words):
    """words without leading shell keywords, assignments and launchers."""
    while words and words[0] in SHELL_KEYWORDS:
        words = words[1:]
    words = _strip_assignments(words)
    while words and (inner := _strip_launcher(words)) is not None:
        words = inner
    return words


def may_run_tests(text, cwd, depth):
    """Whether text could start a test runner. It cannot only when every command it runs is
    one of NO_TEST_COMMANDS (after assignments and launchers) or `bun run` of scripts that
    cannot either (with their pre and post scripts); anything else, including a wrapper,
    a command or process substitution anywhere in the text (a `${VAR:-value}` expansion is
    fine) or text that cannot be read, may."""
    if depth > 5 or any(s in text for s in ('$(', '`', '<(', '>(')):
        return True
    try:
        commands = split_commands(text)
    except UnreadableShellInput:
        return True
    scripts = package_scripts(cwd) or {}
    for words in map(_plain_words, commands):
        if not words or words[0] in NO_TEST_COMMANDS:
            continue
        script = _bun_script(words)
        if script is None or not isinstance(scripts.get(script[0]), str):
            return True
        name, extra = script
        bodies = [scripts.get(n) for n in (f'pre{name}', f'post{name}') if n in scripts]
        if any(not isinstance(b, str) or may_run_tests(b, cwd, depth + 1) for b in bodies) \
                or may_run_tests(' '.join([scripts[name], *map(shlex.quote, extra)]),
                                 cwd, depth + 1):
            return True
    return False


def template_runs(command, cwd):
    """Every test run an affected.commands template the gate filled in can reach. The
    project registered it and the gate runs it in its own directory, so its shell shape is
    trusted; each `bun run <script>` in it is listed like a script of `run`. Why not when a
    runner there is one whose output the gate cannot read, or a test run cannot be listed."""
    try:
        commands = split_commands(command)
    except UnreadableShellInput:
        return 'the command cannot be read'
    runs = []
    for words in map(_plain_words, commands):
        if not words:
            continue
        script = _bun_script(words)
        if script:
            inner = script_test_runs(script, cwd, 0)
            if isinstance(inner, str):
                return inner
            runs += inner
            continue
        run = _unwrap(words)
        if run and run[0] not in RERUN_TOOLS:
            return f'the gate cannot read the output of {run[0]}'
        if run:
            runs.append(run)
        elif may_run_tests(shlex.join(words), cwd, 1):
            return f'`{shlex.join(words)}` may run tests the gate cannot list'
    return runs or 'the command runs no bun test, unittest or pytest'


def _short_flags(word, values):
    """The one-letter options a word such as `-vx` sets, up to one that takes a value."""
    if not word.startswith('-') or word.startswith('--') or not word[1:].isalpha():
        return ''
    flags = word[1:]
    cut = next((i for i, c in enumerate(flags) if c in values), None)
    return flags if cut is None else flags[:cut]


def fail_fast(runner, args, cwd):
    """True when this test run stops at its first failure, by an option or a config file."""
    names = [w.split('=', 1)[0] for w in args]
    if runner == 'bun-test':
        try:
            bunfig = (Path(cwd) / 'bunfig.toml').read_text()
        except OSError:
            bunfig = ''
        return '--bail' in names or re.search(r'(?m)^\s*bail\s*=', bunfig) is not None
    if runner in ('unittest', 'unittest-discover'):
        return '--failfast' in names or any('f' in _short_flags(w, 'kpst') for w in args)
    if any(n in ('--exitfirst', '--maxfail', '--sw', '--stepwise', '--sw-skip',
                 '--stepwise-skip') for n in names) \
            or any('x' in _short_flags(w, 'rkmpconW') for w in args) \
            or PYTEST_STOP.search(os.environ.get('PYTEST_ADDOPTS', '')):
        return True
    for directory in (Path(cwd), *Path(cwd).parents):
        for name in PYTEST_CONFIGS:
            try:
                text = (directory / name).read_text()
            except OSError:
                continue
            if 'addopts' in text and PYTEST_STOP.search(text):
                return True
        if (directory / '.git').exists():
            break
    return False


def unittest_bases(runs, cwd):
    """The directories unittest test ids are relative to: the top-level (or start)
    directory of `discover`, cwd otherwise."""
    bases = []
    for runner, args in runs:
        if runner == 'unittest':
            bases.append(Path(cwd))
        elif runner == 'unittest-discover':
            found, positional, i = {}, [], 0
            while i < len(args):
                word = args[i]
                name, _, value = word.partition('=')
                if name in ('-s', '--start-directory', '-t', '--top-level-directory', '-p',
                            '--pattern', '-k'):
                    if not value and i + 1 < len(args):
                        i += 1
                        value = args[i]
                    found[name.lstrip('-')[0]] = value
                elif not word.startswith('-'):
                    positional.append(word)
                i += 1
            start = found.get('s') or (positional[0] if positional else '.')
            top = found.get('t') or (positional[2] if len(positional) > 2 else None)
            bases.append(Path(cwd) / (top or start))
    return bases


def failure_file(tool, where, scan, runs, cwd):
    """The file a failure names, as an existing path, or None."""
    if where is None:
        return None
    if tool == 'unittest':
        parts = where.split('.')
        candidates = [Path(base, *parts[:k - 1], parts[k - 1] + '.py')
                      for base in unittest_bases(runs, cwd) for k in range(len(parts), 0, -1)]
    elif tool == 'pytest':  # node ids are relative to the rootdir pytest printed
        candidates = [Path(cwd, root, where) for root in scan.roots] or [Path(cwd) / where]
    else:
        candidates = [Path(cwd) / where]
    return next((p for p in candidates if p.is_file()), None)


def rerun_plan(scan, tools, cwd, root, commands):
    """How to rerun the failed test files once: ({affected.commands directory: [repo
    paths]}, {repo path: [failed test names]}), or why they are not rerun. tools is what
    test_runs() returned for the command."""
    if isinstance(tools, str):
        return tools
    stopper = next((runner for runner, args in tools if fail_fast(runner, args, cwd)), None)
    if stopper:
        return f'{RERUN_TOOLS[stopper]} is set to stop at the first failure'
    if scan.problems:
        return scan.problems[0]
    used = {RERUN_TOOLS[runner] for runner, _ in tools}
    for tool in sorted(used):
        needed = sum(1 for runner, _ in tools if RERUN_TOOLS[runner] == tool)
        if scan.summaries[tool] < needed:
            return f'no complete {tool} summary line, so the tests did not all finish'
    if scan.overflow:
        return f'more than {SCAN_MAX_FAILURES} tests failed'
    for tool in sorted(used):
        named = sum(1 for t, _, _ in scan.failures if t == tool)
        if named != scan.counted[tool]:
            return (f'{tool} counted {scan.counted[tool]} failure(s) but named {named}, so not '
                    'every failure is traced to a test')
    if not scan.failures:
        return 'no test failed, so a step other than the tests failed'
    real_root, names = os.path.realpath(root), {}
    for tool, where, name in scan.failures:
        path = failure_file(tool, where, scan, tools, cwd)
        rel = path and os.path.relpath(os.path.realpath(path), real_root)
        if rel is None or rel.startswith('..'):
            return f'the failure of {name} cannot be traced to a test file in the repository'
        names.setdefault(rel, [])
        if name not in names[rel]:
            names[rel].append(name)
    if len(names) > RERUN_MAX_FILES:
        return f'{len(names)} test files failed, more than {RERUN_MAX_FILES}'
    groups = {}
    for path in names:
        directory = command_dir(path, commands)
        if directory is None:
            return f'no affected.commands directory holds {path}'
        groups.setdefault(directory, []).append(path)
    return groups, names


def affected_text(root, commands, directory, tests):
    """(command, cwd) that runs tests (repo paths) with directory's affected.commands
    template."""
    rel = [t if directory == '.' else t[len(directory) + 1:] for t in tests]
    text = commands[directory].replace('{tests}', ' '.join(map(shlex.quote, rel)))
    return text, root if directory == '.' else root / directory


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
    if failed_first(record):
        print(f"  result:      {rerun_only_text(failed_first(record))}; a reviewer must look "
              'at it before the merge')
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
    if purpose == 'large-selection':
        return (f"large selection, {len(record.get('selected_tests') or [])} of "
                f"{record.get('suite_tests')} test files")
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


PURPOSE_CHOICES = ('--purpose release (before a release), --purpose post-merge (after a batch '
                   'is merged, only in a project without an affected-test map), or --reason '
                   '"<why the full suite is needed>"')


def post_merge_command():
    return affected_command() + ' --base <commit the batch started from> --purpose post-merge'


def post_merge_refused(purpose):
    """2 after refusing a post-merge full suite in a project with an affected-test map in
    the current directory; None when it may run."""
    if purpose != 'post-merge' or not is_mapped(load_registry(Path.cwd()) or {}):
        return None
    warn('this project has an affected-test map, so after a batch is merged the gate runs the '
         'tests the batch affects instead of the full suite:\n'
         f'  {post_merge_command()}\n'
         'It writes one summary record of the whole run. When a full suite is really needed, '
         'run it with --reason "<why the full suite is needed>" instead of --purpose post-merge.')
    return 2


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
             f'After a batch is merged: {post_merge_command()}\n'
             'For a full suite, add one after `run`: --purpose release (before a release) or '
             '--reason "<why the full suite is needed>"')
        return 2
    refused = post_merge_refused(purpose)
    if refused:
        return refused
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


def copy_included(root, checkout, registry):
    """Copy the ignored `fingerprint_include` files of root into checkout. The fingerprint
    takes these files from the work tree, so the checkout gets the original tree's ignored
    ones and its records match that tree; tracked and new files stay as checked out."""
    found = sorted({str(p.relative_to(root)) for pattern in include_patterns(registry)
                    for p in root.glob(pattern) if p.is_file()})
    if found:
        for rel in _git_paths(['ls-files', '--others', '--ignored', '--exclude-standard',
                               '--', *found], root):
            target = checkout / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(root / rel, target)


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
                # A second signal must not cut the grace wait short and leave it running.
                signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
                try:
                    end_session(child.pid, child)
                finally:
                    signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
            return f'{shlex.join(command)} exited {code}' if code else None
    return None


def start_registered(suite, cwd, flags, started, relay):
    """Start `run` of a registered suite in cwd as its own gate process, so it queues for a
    host slot like any other suite while the others run; with relay its output lines carry
    the suite's directory. The process gets no terminal signals: stop_registered forwards
    them."""
    argv = [sys.executable, str(SCRIPT), 'run', *flags, '--', suite['command']]
    pipe = subprocess.PIPE if relay else None
    # No signal between starting it and listing it in started with its output read; a
    # failure after Popen leaves it in started, for stop_registered.
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
    try:
        child = subprocess.Popen(argv, cwd=cwd, stdout=pipe, stderr=pipe,
                                 start_new_session=True, preexec_fn=_child_setup({}))
        child.relays = []  # the relay threads that started
        started.append(child)
        if relay:
            prefix = f"[{suite['cwd']}] ".encode()
            for stream, out in ((child.stdout, sys.stdout.buffer),
                                (child.stderr, sys.stderr.buffer)):
                thread = threading.Thread(target=relay_lines, args=(stream, out, prefix),
                                          daemon=True)
                thread.start()
                child.relays.append(thread)
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
    return child


RELAY_LOCK = threading.Lock()


def relay_lines(stream, out, prefix):
    for line in iter(stream.readline, b''):
        with RELAY_LOCK:
            out.write(prefix + line + (b'' if line.endswith(b'\n') else b'\n'))
            out.flush()


def wait_registered(child):
    code = child.wait()
    for thread in child.relays:
        thread.join()
    return 128 - code if code < 0 else code


def stop_registered(started, signum):
    """Pass an interrupt (or SIGTERM when a start failed) on to the registered suites still
    running and wait until each has ended its suite, so the checkout is removed only after
    them."""
    for sig in SIGNALS:
        signal.signal(sig, signal.SIG_IGN)
    running = [child for child in started if child.poll() is None]
    if running:
        warn(f'stopping {len(running)} running suite(s)')
    for child in running:
        child.send_signal(signum)
    for child in started:
        # A pipe whose relay never started would fill up unread and hold the child.
        for stream in (child.stdout, child.stderr)[len(child.relays):]:
            if stream:
                stream.close()
        wait_registered(child)


def cmd_run_registered(names, rerun, purpose, reason):
    """Run the registered full suites, all or those named by directory or command, in their
    registered form, each through the gate, in a temporary clean checkout of HEAD. They
    start together and the gate's host-slot admission decides how many run at once; every
    suite runs whatever the others do, and the exit code is the first failing one's."""
    error = run_args_error(rerun, purpose, reason)
    if error:
        warn(error)
        return 2
    if not purpose and not reason:
        warn(f'run --registered needs a purpose: add {PURPOSE_CHOICES}')
        return 2
    refused = post_merge_refused(purpose)
    if refused:
        return refused
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
        copy_included(root, checkout, registry)
        unknown = [n for n in names if not any(named(s, n) for s in suites)]
        if unknown:
            warn(f"run --registered: no registered full suite {', '.join(unknown)}; the "
                 'registered ones (name one by its directory or command):')
            for suite in suites:
                warn(f"  {suite['cwd']}: {suite['command']}")
            return 2
        if names:
            suites = [s for s in suites if any(named(s, n) for n in names)]
        flags = (*purpose_flags(purpose, reason), *(('--rerun', rerun.strip()) if rerun else ()))
        started, results, prepared = [], [], {}
        try:
            for suite in suites:
                warn(f"full suite in {suite['cwd']}: {suite['command']}")
                cwd = suite_cwd(checkout, suite)
                if cwd not in prepared:
                    prepared[cwd] = prepare_dependencies(cwd)
                if prepared[cwd]:
                    warn(f"not run: preparing {suite['cwd']} failed ({prepared[cwd]}); this "
                         'is not a test result')
                    results.append((suite, None))
                    continue
                try:
                    child = start_registered(suite, cwd, flags, started, len(suites) > 1)
                except OSError as exc:
                    warn(f"not run: {suite['cwd']} could not start ({exc}); this is not a "
                         'test result')
                    child = None
                results.append((suite, child))
            codes = [2 if child is None else wait_registered(child) for _, child in results]
        except BaseException as exc:
            # Whatever ends this early, the started suites stop before the checkout goes.
            stop_registered(started, exc.signum if isinstance(exc, Interrupted)
                            else signal.SIGTERM)
            raise
        if len(suites) > 1:
            for (suite, child), code in zip(results, codes):
                outcome = ('not run' if child is None else 'passed' if code == 0
                           else f'exit {code}')
                warn(f"{suite['cwd']}: {outcome}")
        return next((code for code in codes if code), 0)

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
    checks = affected.get('checks', [])
    if not isinstance(checks, list) or not all(
            isinstance(c, dict) and isinstance(c.get('command'), str) and c['command'].strip()
            and isinstance(c.get('cwd', '.'), str) for c in checks):
        raise ValueError('affected.checks must list {"paths": [...], "command": "...", '
                         '"cwd": "<dir>"} entries')
    for i, check in enumerate(checks):
        _strings(check.get('paths'), f'affected.checks[{i}].paths', allow_empty=False)
    share = affected.get('full_suite_share')
    if share is not None and (isinstance(share, bool) or not isinstance(share, (int, float))
                              or not 0 < share <= 1):
        raise ValueError('affected.full_suite_share must be a number above 0 and at most 1')
    suites = read_full_suites(registry)
    branch = registry.get('integration_branch')
    if branch is not None and (not isinstance(branch, str) or not branch):
        raise ValueError('integration_branch must be a branch name')
    return {'commands': {_dir_key(k): v for k, v in commands.items()}, 'rules': rules,
            'shared': shared, 'branch': branch, 'suites': suites, 'share': share,
            'checks': [dict(c, cwd=_dir_key(c.get('cwd', '.'))) for c in checks]}


def due_checks(amap, changed):
    """The affected.checks (a command run in a directory, such as a type check) whose paths
    the changed files touch."""
    return [c for c in amap['checks']
            if any(glob_match(path, p) for path in changed for p in c['paths'])]


def read_full_suites(registry):
    """The registry's full suites as [{command, cwd}], plus depends_on where declared.
    ValueError when missing or bad."""
    suites = registry.get('full_suites')
    if not isinstance(suites, list) or not suites or not all(
            isinstance(s, dict) and isinstance(s.get('command'), str) and s['command'].strip()
            and isinstance(s.get('cwd', '.'), str) for s in suites):
        raise ValueError('full_suites must list {"command": "...", "cwd": "<dir>"} entries')
    for i, suite in enumerate(suites):
        if 'depends_on' in suite:
            _strings(suite['depends_on'], f'full_suites[{i}].depends_on')
    return [dict({'command': s['command'].strip(), 'cwd': _dir_key(s.get('cwd', '.'))},
                 **({'depends_on': s['depends_on']} if 'depends_on' in s else {}))
            for s in suites]


def suite_cwd(root, suite):
    """The directory a registered full suite runs in."""
    return root if suite['cwd'] == '.' else root / suite['cwd']


def glob_match(path, pattern):
    """Path glob: `*` and `?` stay within one directory, `**` spans directories."""
    return _glob_regex(pattern).fullmatch(path) is not None


@functools.lru_cache(maxsize=1024)
def _glob_regex(pattern):
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
    return re.compile(''.join(out))


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


def _test_shape(names):
    """(prefix, suffix) the test names of one directory share, cut at a word break, such as
    ('test_', '.py') or ('', '.test.ts'); None when that is no more than an extension."""
    prefix = os.path.commonprefix(names)
    prefix = prefix[:max(prefix.rfind(c) for c in '._-') + 1]
    suffix = os.path.commonprefix([n[::-1] for n in names])[::-1]
    suffix = suffix[suffix.find('.'):] if '.' in suffix else ''
    return (prefix, suffix) if prefix or suffix.count('.') > 1 else None


def unselected_new_tests(root, base, changed, amap, selected):
    """Files the change adds (absent at base) that the map did not select although they match
    its test patterns or are named like the tests it knows in the same directory (at least
    two of them)."""
    at_base = set(_git_paths(['ls-tree', '-r', '--name-only', base], root))
    patterns = [p for rule in amap['rules'] for p in rule['tests']]
    known = {}
    for path in _git_paths(['ls-files', '-co', '--exclude-standard'], root):
        if any(glob_match(path, p) for p in patterns):
            known.setdefault(os.path.dirname(path), set()).add(os.path.basename(path))
    missing = []
    for path in changed:
        if path in at_base or path in selected or not (root / path).is_file():
            continue
        if any(glob_match(path, p) for p in patterns):
            missing.append(path)
            continue
        directory, name = os.path.split(path)
        names = sorted(known.get(directory, set()) - {name})
        shape = _test_shape(names) if len(names) > 1 else None
        if shape and name.startswith(shape[0]) and name.endswith(shape[1]) \
                and len(name) > len(shape[0]) + len(shape[1]):
            missing.append(path)
    return missing


def command_dir(test, commands):
    """The longest directory in commands that holds test, or None."""
    found = [d for d in commands if d == '.' or test.startswith(d + '/')]
    return max(found, key=len) if found else None


def head_commit(root):
    """The full commit HEAD points at, or None before the first commit."""
    result = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root)
    return result.stdout.strip() if result.returncode == 0 else None


def write_summary(root, checkout, run_id, base, changed, start, results, *, nothing_selected,
                  interrupted, started_at, purpose='post-merge'):
    """Write the summary of one affected run with a purpose (`kind: affected-summary`) for
    the repo at root, run in checkout: it passed only when every group exited 0 (a pass after
    the rerun of failed files, or a reused pass, counts), nothing was interrupted and the
    checkout's content (HEAD and its tree) did not change."""
    end = (head_commit(checkout), content_tree(checkout))
    changed_content = end != start or any(r['content_changed'] for r in results)
    passed = (not interrupted and not changed_content
              and all(r['exit_code'] == 0 for r in results))
    record = {
        'kind': 'affected-summary', 'purpose': purpose, 'run_id': run_id,
        'repo': str(root), 'base': base, 'commit': start[0], 'tree': start[1],
        'changed_files': changed, 'groups': results, 'nothing_selected': nothing_selected,
        'interrupted': interrupted, 'content_changed': changed_content, 'passed': passed,
        'rerun_only': [{'kind': r['kind'], 'dir': r['dir'], **r['rerun_only']}
                       for r in results if r.get('rerun_only')],
        'exit_code': 0 if passed else 1, 'reusable': False, 'agent': agent_name(),
        'time': started_at, 'finished': now_iso()}
    append_record(record)
    if nothing_selected:
        warn(f'{purpose} summary: no tests were selected for this change; nothing ran'
             + ('; it counts as passed' if passed else ''))
    if changed_content:
        warn(f'{purpose} summary: the content changed during the run, so it counts as failed; '
             'run it again on unchanged content')
    reused = sum(1 for r in results if r.get('reused'))
    warn(f"{purpose} summary {run_id[:12]}: {'passed' if passed else 'FAILED'} "
         f'({len(results)} group(s), {reused} reused, base {base[:12]}, '
         f'commit {(start[0] or "-")[:12]})')
    for group in record['rerun_only']:
        warn(f"{purpose} summary: {group['kind']} in {group['dir']} "
             f"{rerun_only_text(group['failed_first'])}, fingerprint {group['fingerprint']}; "
             'a reviewer must look at it before the merge')
    return record


def cmd_affected(base, purpose=None):
    def select(root, amap, commit, origin):
        """(changed, selected, fallback) against commit, or None after naming new test files
        the map does not select."""
        changed = changed_files(root, commit)
        warn(f'change against {origin} ({commit[:12]}): {len(changed)} file(s)')
        for path in changed:
            warn(f'  {path}')
        selected, fallback = select_tests(root, changed, amap, commit)
        missing = unselected_new_tests(root, commit, changed, amap, selected)
        if missing:
            warn('the affected-test map selects none of these new test files:')
            for path in missing:
                warn(f'  {path}')
            warn(f'add rules in {MAP_DIR}/<topic>.json that map the files they test to them, '
                 'then run affected again; nothing ran')
            return None
        return changed, selected, fallback

    def post_merge(root, commit, origin):
        """Run the batch's affected tests in a temporary clean checkout of HEAD, so a merge
        into root during the run does not change what is tested; the summary names root."""
        head = head_commit(root)
        if head is None:
            warn('affected --purpose post-merge: HEAD is not a commit yet')
            return 2
        warn(f'testing HEAD {head[:12]} in a temporary clean checkout; later changes to '
             f'{root} do not affect the run')
        if git(['status', '--porcelain'], root).stdout.strip():
            warn(f'{root} has uncommitted changes; they are not tested. Commit them first '
                 'to include them.')
        with clean_checkout(root, head) as checkout:
            warn(f'temporary checkout: {checkout} (removed when the run ends)')
            registry = load_registry(checkout) or {}
            if not is_mapped(registry):
                warn(f'the {REGISTRY_NAME} committed at HEAD {head[:12]} has no affected-test '
                     'map; commit the map first')
                return 2
            try:
                amap = read_map(registry)
            except ValueError as exc:
                warn(f'{REGISTRY_NAME} at HEAD {head[:12]}: {exc}')
                return 2
            copy_included(root, checkout, registry)
            prepared = {}

            def prepare(cwd):
                if cwd not in prepared:
                    prepared[cwd] = prepare_dependencies(cwd)
                return prepared[cwd]
            return summarized(root, checkout, amap, commit, origin, prepare)

    def pre_merge(root, amap, commit, origin):
        """Run the change's affected tests in the work tree as the final version before it
        is merged, under one run_id with a summary, so a later run (the post-merge one)
        reuses the groups whose content stays the same."""
        if head_commit(root) is None:
            warn('affected --purpose pre-merge: HEAD is not a commit yet')
            return 2
        if git(['status', '--porcelain'], root).stdout.strip():
            warn(f'{root} has uncommitted changes; they are tested and recorded with the rest, '
                 'but the merged content will not match them. Commit them first.')
        return summarized(root, root, amap, commit, origin)

    def summarized(root, checkout, amap, commit, origin, prepare=None):
        """Select and run the change's tests in checkout under one run_id and write the
        summary of the run for root."""
        start = (head_commit(checkout), content_tree(checkout))
        started_at = now_iso()
        chosen = select(checkout, amap, commit, origin)
        if chosen is None:
            return 2
        changed, selected, fallback = chosen
        run_id = uuid.uuid4().hex
        warn(f'{purpose} run {run_id[:12]}: every record of this run carries this run_id')
        results = []
        extra = {'base': commit, 'changed_files': changed, 'run_id': run_id}
        if purpose == 'pre-merge':
            extra['purpose'] = purpose
        try:
            code = run_selected(checkout, amap, selected, fallback, extra, prepare,
                                results=results)[0]
        except Interrupted:
            write_summary(root, checkout, run_id, commit, changed, start, results,
                          nothing_selected=False, interrupted=True, started_at=started_at,
                          purpose=purpose)
            raise
        summary = write_summary(root, checkout, run_id, commit, changed, start, results,
                                nothing_selected=code is None, interrupted=False,
                                started_at=started_at, purpose=purpose)
        return code or summary['exit_code']

    def full_suites(root, checkout, commit, origin, prepare=None):
        """No affected-test map: run every registered full suite of checkout once through
        the gate (a pass on the same content is reused) under one run_id, and write the
        summary of the run for root."""
        start = (head_commit(checkout), content_tree(checkout))
        started_at = now_iso()
        try:
            suites = read_full_suites(load_registry(checkout) or {})
        except ValueError as exc:
            warn(f'no affected-test map, so affected --purpose {purpose} runs the registered '
                 f'full suites, but {REGISTRY_NAME}: {exc}')
            return 2
        changed = changed_files(checkout, commit)
        warn(f'change against {origin} ({commit[:12]}): {len(changed)} file(s)')
        warn(f'no affected-test map: the {purpose} check runs every registered full suite '
             'once; a pass on the same content is reused')
        run_id = uuid.uuid4().hex
        warn(f'{purpose} run {run_id[:12]}: every record of this run carries this run_id')
        results, code = [], 0
        try:
            for suite in suites:
                warn(f"full suite in {suite['cwd']}: {suite['command']}")
                cwd = suite_cwd(checkout, suite)
                # A suite whose content already passed is reused, so it needs no preparing.
                info = fingerprint(cwd, [suite['command']]) if prepare else None
                passed = info is not None and reusable_record(info['fingerprint'])
                reason = prepare(cwd) if prepare and not passed else None
                if reason:
                    warn(f"not run: preparing {suite['cwd']} failed ({reason}); this is not a "
                         'test result')
                    results.append(group_result('full-suite', suite['cwd'], suite['command'],
                                                2, not_run='preparing the directory failed'))
                    result = 2
                else:
                    gate = Gate([suite['command']], cwd, None, load_config(),
                                {'purpose': purpose, 'run_id': run_id})
                    result = drive_group(results, 'full-suite', suite['cwd'], suite['command'],
                                         gate, gate.run)
                code = code or result
        except Interrupted:
            write_summary(root, checkout, run_id, commit, changed, start, results,
                          nothing_selected=False, interrupted=True, started_at=started_at,
                          purpose=purpose)
            raise
        summary = write_summary(root, checkout, run_id, commit, changed, start, results,
                                nothing_selected=False, interrupted=False,
                                started_at=started_at, purpose=purpose)
        return code or summary['exit_code']

    def unmapped(root, registry):
        """affected in a project without an affected-test map: with a purpose, the registered
        full suites once (pre-merge in the work tree, post-merge in a clean checkout)."""
        if not purpose:
            warn('no affected-test map in this project (`affected.map` in '
                 f'{REGISTRY_NAME}). While editing, run the test files you choose. Before '
                 'merging, run the registered full suites once on the final version:\n'
                 f'  {pre_merge_command(registry)}\n'
                 f'or one full suite through `suite-gate.py run -- <cmd>`')
            return 2
        commit, origin = change_base(root, base, (registry or {}).get('integration_branch'))
        if head_commit(root) is None:
            warn(f'affected --purpose {purpose}: HEAD is not a commit yet')
            return 2
        if purpose == 'pre-merge':
            if git(['status', '--porcelain'], root).stdout.strip():
                warn(f'{root} has uncommitted changes; they are tested and recorded with the '
                     'rest, but the merged content will not match them. Commit them first.')
            return full_suites(root, root, commit, origin)
        head = head_commit(root)
        warn(f'testing HEAD {head[:12]} in a temporary clean checkout; later changes to '
             f'{root} do not affect the run')
        if git(['status', '--porcelain'], root).stdout.strip():
            warn(f'{root} has uncommitted changes; they are not tested. Commit them first '
                 'to include them.')
        with clean_checkout(root, head) as checkout:
            warn(f'temporary checkout: {checkout} (removed when the run ends)')
            copy_included(root, checkout, load_registry(checkout) or {})
            prepared = {}

            def prepare(cwd):
                if cwd not in prepared:
                    prepared[cwd] = prepare_dependencies(cwd)
                return prepared[cwd]
            return full_suites(root, checkout, commit, origin, prepare)

    def body():
        root = repo_root(Path.cwd())
        if root is None:
            warn('affected: not in a Git work tree')
            return 2
        registry = load_registry(Path.cwd())
        if purpose == 'post-merge' and base is None:
            warn('affected --purpose post-merge needs --base <commit>: the commit this batch '
                 'of work started from')
            return 2
        if not is_mapped(registry or {}):
            return unmapped(root, registry)
        try:
            amap = read_map(registry)
        except ValueError as exc:
            warn(f'{root / REGISTRY_NAME}: {exc}')
            return 2
        commit, origin = change_base(root, base, amap['branch'])
        if purpose == 'pre-merge':
            return pre_merge(root, amap, commit, origin)
        if purpose:
            return post_merge(root, commit, origin)
        chosen = select(root, amap, commit, origin)
        if chosen is None:
            return 2
        changed, selected, fallback = chosen
        prepared = {}

        def prepare(cwd):
            # Unlike a clean checkout, the work tree may already hold its dependencies.
            if cwd not in prepared:
                prepared[cwd] = None if (cwd / 'node_modules').is_dir() \
                    else prepare_dependencies(cwd)
            return prepared[cwd]
        code = run_selected(root, amap, selected, fallback,
                            {'base': commit, 'changed_files': changed}, prepare)[0]
        if code is None:
            warn('no tests selected for this change; nothing to run')
            warn('hint: on an integration branch the base must be given with --base <commit> '
                 '(the commit this work started from); without it the change is empty')
            return 0
        return code
    return _guarded(body)


def drive_group(results, kind, directory, command, gate, action, tests=None):
    """_drive(gate, action) for one group of an affected run, appending its group_result()
    to results, also when it is interrupted (exit_code None, interrupted true)."""
    try:
        code = _drive(gate, action)
    except Interrupted:
        results.append(group_result(kind, directory, command, None, gate, tests,
                                    interrupted=True))
        raise
    results.append(group_result(kind, directory, command, code, gate, tests))
    return code


def group_result(kind, directory, command, code, gate=None, tests=None, not_run=None,
                 interrupted=False, earlier=None):
    """One group of an affected run, as the post-merge summary lists it; earlier is the
    passing affected record reused instead of running it."""
    record = gate.record if gate else None
    reused = gate.reused if gate else earlier
    ran = reused or record  # a reused pass keeps the mark of the record it reuses
    return {
        'kind': kind, 'dir': directory, 'command': command, 'tests': tests,
        'exit_code': code,
        'fingerprint': (gate.me['fingerprint'] if gate
                        else earlier.get('fingerprint') if earlier else None),
        'flaky': bool(ran and ran.get('flaky')),
        'rerun_only': ({'fingerprint': ran.get('fingerprint'), 'failed_first': failed_first(ran)}
                       if ran and failed_first(ran) else None),
        'content_changed': bool(record and record.get('content_changed')),
        'reused': None if reused is None else {
            'time': reused.get('time'), 'agent': reused.get('agent'),
            'purpose': reused.get('purpose'), 'fingerprint': reused.get('fingerprint'),
            'run_id': reused.get('run_id')},
        'not_run': not_run, 'interrupted': interrupted}


def failed_first(record):
    """The test files of a pass only on the automatic rerun (`rerun_only`; older records
    carry only `flaky`), which failed at the first try; [] for any other record."""
    if record.get('exit_code') != 0 or not (record.get('rerun_only') or record.get('flaky')):
        return []
    return [f.get('file') for f in record.get('flaky') or []]


def rerun_only_text(files):
    return f"PASSED ONLY ON RERUN (failed first: {', '.join(files)})"


def is_gate_config(path):
    return path == REGISTRY_NAME or glob_match(path, f'{MAP_DIR}/**')


class MapContent:
    """The content of root as content_tree() counts it, seen through the affected-test map,
    for the fingerprints of single tests and checks that let a later run reuse their pass
    when the merged content differs only in files the map ties to other tests. The registry
    and map files count for a test only when a rule that selects it names them in `paths`;
    otherwise what they decide (the template, the rules of a test) is part of the
    fingerprint instead."""

    def __init__(self, root, amap):
        self.amap = amap
        include = include_patterns(load_registry(root) or {})
        with tempfile.TemporaryDirectory(prefix='suite-gate-') as tmp:
            entries = _index_entries(root, _fill_index(root, Path(tmp) / 'index', include))
        patterns = [p for rule in amap['rules'] for p in rule['tests']]
        self.entries = entries
        self.files = []  # (entry, path, indexes of the rules whose paths hold it, shared, unmapped)
        for entry in entries:
            path = entry.split('\t', 1)[1]
            hits = frozenset(i for i, rule in enumerate(amap['rules'])
                             if any(glob_match(path, p) for p in rule['paths']))
            config = is_gate_config(path)
            shared = not config and any(glob_match(path, p) for p in amap['shared'])
            unmapped = not config and not hits and not any(glob_match(path, p)
                                                           for p in patterns)
            self.files.append((entry, path, hits, shared, unmapped))

    @staticmethod
    def _digest(what, kept):
        return hashlib.sha256(json.dumps([what, sorted(kept)]).encode()).hexdigest()

    def test(self, directory, test):
        """Fingerprint of test run with directory's template: the template, the map rules
        whose tests hold it, and the files it may depend on as the map sees them (itself,
        shared and unmapped files, and the paths of those rules)."""
        rules = {i for i, rule in enumerate(self.amap['rules'])
                 if any(glob_match(test, p) for p in rule['tests'])}
        kept = [entry for entry, path, hits, shared, unmapped in self.files
                if path == test or shared or unmapped or hits & rules]
        return self._digest([directory, self.amap['commands'][directory],
                             [self.amap['rules'][i] for i in sorted(rules)]], kept)

    def check(self, check):
        """Fingerprint of an affected.checks entry: its command and directory, and all of
        the content (its paths say when it runs, not everything it reads)."""
        return self._digest([check['cwd'], check['command']], self.entries)


def passed_affected(record):
    """True for an affected-test record that passed on unchanged content at the first try
    (a pass only on the rerun of failed files is not reused)."""
    return (record.get('kind') == 'affected' and record.get('exit_code') == 0
            and not record.get('content_changed') and not record.get('flaky'))


def earlier_test_passes(fps):
    """([passing affected records to reuse], [tests left to run]) for fps ({test:
    fingerprint}), newest record first: a record counts when every test it ran is still
    left and has the same fingerprint now."""
    left, found = dict(fps), []
    for record in reversed(read_records()):
        ran = record.get('test_fingerprints')
        if not left:
            break
        if not isinstance(ran, dict) or not ran or not passed_affected(record):
            continue
        if all(left.get(test) == fp for test, fp in ran.items()):
            found.append(record)
            for test in ran:
                del left[test]
    return found, sorted(left)


def earlier_check_pass(fp):
    """The newest passing record of an affected check with this check fingerprint, or None."""
    return next((r for r in reversed(read_records())
                 if r.get('check_fingerprint') == fp and passed_affected(r)), None)


def warn_reuse(what, record):
    run = f", run {record['run_id'][:12]}" if record.get('run_id') else ''
    purpose = f", purpose {record['purpose']}" if record.get('purpose') else ''
    warn(f"{what}: same tests and content already passed; reusing the record of "
         f"{record.get('time')} by {record.get('agent')} (fingerprint "
         f"{(record.get('fingerprint') or '-')[:12]}{run}{purpose}), not running again")


def run_selected(root, amap, selected, fallback, extra, prepare=None, via=None, results=None):
    """Run the selected tests per affected.commands directory, and the full suites a fallback
    needs, through the gate. (exit code, [(directory, command, tests) that failed]); the code
    is None when nothing was selected. prepare(cwd) installs a directory's dependencies first
    and returns what failed, or None; via is recorded as what started the run. Each group
    (a check, a directory's tests or a full suite) is appended to results as group_result()."""
    results = [] if results is None else results
    groups = {}
    for test in sorted(selected):
        directory = command_dir(test, amap['commands'])
        if directory is None:
            fallback.append((test, 'no affected.commands directory holds this test'))
        else:
            groups.setdefault(directory, []).append(test)
    code, failed = 0, []
    checks = due_checks(amap, extra['changed_files'])

    def prepared(cwd, what):
        reason = prepare(cwd) if prepare else None
        if reason:
            warn(f'not run: preparing {what} failed ({reason}); this is not a test result')
        return not reason

    if fallback:
        suites = fallback_suites(amap['suites'], [path for path, _ in fallback])
        code, failed = run_fallback(root, suites, fallback, prepared, via, extra.get('run_id'),
                                    results)
        # The full suites run the tests in their directories; the rest still run here.
        groups = {d: kept for d, tests in groups.items()
                  if (kept := [t for t in tests if not any(
                      s['cwd'] == '.' or t.startswith(s['cwd'] + '/') for s in suites)])}
        if not groups and not checks:
            return code, failed
    elif not groups and not checks:
        return None, []
    content = MapContent(root, amap)
    fps = {d: {t: content.test(d, t) for t in tests} for d, tests in groups.items()}
    taken = []  # (reused result, fingerprint it was taken for, fingerprint of MapContent now)
    for directory in list(groups):
        earlier, left = earlier_test_passes(fps[directory])
        for record in earlier:
            warn_reuse(f'{len(record["test_fingerprints"])} test(s) in {directory}', record)
            results.append(group_result('affected', directory, record.get('command'), 0,
                                        tests=sorted(record['test_fingerprints']),
                                        earlier=record))
            taken.append((results[-1], record['test_fingerprints'],
                          lambda now, d=directory, ts=list(record['test_fingerprints']):
                          {t: now.test(d, t) for t in ts}))
        if left:
            groups[directory] = left
        else:
            del groups[directory]
    code, failed = _run_left(root, amap, selected, groups, checks, extra, prepared, via,
                             results, content, taken, code, failed)
    if taken:
        # A reuse whose content something run after it changed no longer describes this
        # content: it counts as content changed and fails the run.
        now = MapContent(root, amap)
        for result, was, fp in taken:
            if fp(now) != was:
                result['content_changed'] = True
                code = code or 1
                failed.append((result['dir'], result['command'], result['tests'] or ['check']))
                warn(f"the content of the reused {result['kind']} in {result['dir']} changed "
                     'during the run; it counts as content changed and fails the run')
    return code, failed


def _run_left(root, amap, selected, groups, checks, extra, prepared, via, results, content,
              taken, code, failed):
    """The rest of run_selected(): large selections, checks and test groups that were not
    reused. (exit code, failed)."""
    if not groups and not checks:
        return code, failed
    if amap.get('share') is not None:
        large = large_selections(root, amap, groups)
        if large:
            result, more = run_large(root, large, amap['share'], prepared, via,
                                     extra.get('run_id'), results)
            code, failed = code or result, failed + more
            covered = {t for _, selected, _ in large for t in selected}
            groups = {d: kept for d, tests in groups.items()
                      if (kept := [t for t in tests if t not in covered])}
            if not groups and not checks:
                return code, failed
    if groups:
        warn('selected tests:')
    for test in sorted(t for tests in groups.values() for t in tests):
        warn(f"  {test}  ({'; '.join(selected[test])})")
    for check in checks:
        check_fp = content.check(check)
        earlier = earlier_check_pass(check_fp)
        if earlier:
            warn_reuse(f"check in {check['cwd']}", earlier)
            results.append(group_result('check', check['cwd'], check['command'], 0,
                                        earlier=earlier))
            taken.append((results[-1], check_fp, lambda now, c=check: now.check(c)))
            continue
        cwd = suite_cwd(root, check)
        if not prepared(cwd, check['cwd']):
            code = code or 2
            failed.append((check['cwd'], check['command'], ['check']))
            results.append(group_result('check', check['cwd'], check['command'], 2,
                                        not_run='preparing the directory failed'))
            continue
        warn(f"checking in {check['cwd']}: {check['command']}")
        gate = Gate([check['command']], cwd, None, load_config(), dict(
            extra, kind='affected', reusable=False, selected_tests=[], why={},
            check_fingerprint=MapContent(root, amap).check(check),
            **({'via': via} if via else {})))
        result = drive_group(results, 'check', check['cwd'], check['command'], gate,
                             lambda: gate.execute(fingerprint(cwd, [check['command']])))
        if result:
            failed.append((check['cwd'], check['command'], ['check']))
        code = code or result
    for directory, tests in groups.items():
        text, cwd = affected_text(root, amap['commands'], directory, tests)
        if not prepared(cwd, directory):
            code = code or 2
            failed.append((directory, text, tests))
            results.append(group_result('affected', directory, text, 2, tests=tests,
                                        not_run='preparing the directory failed'))
            continue
        warn(f'running in {directory}: {text}')
        # Taken again right before the run, so the record describes what an earlier group
        # or check left; a change during the run marks it content_changed (never reused).
        now = MapContent(root, amap)
        gate = Gate([text], cwd, None, load_config(), dict(
            extra, kind='affected', reusable=False, selected_tests=tests,
            why={t: selected[t] for t in tests},
            test_fingerprints={t: now.test(directory, t) for t in tests},
            **({'via': via} if via else {})), template=True)
        info = fingerprint(cwd, [text])
        result = drive_group(results, 'affected', directory, text, gate,
                             lambda: gate.execute(info), tests)
        if result:
            failed.append((directory, text, tests))
        code = code or result
    return code, failed


def owning_dir(suites, path):
    """The most specific full-suite directory holding path (a repo path), `.` included, or
    None."""
    found = [s['cwd'] for s in suites
             if s['cwd'] == '.' or path == s['cwd'] or path.startswith(s['cwd'] + '/')]
    return max(found, key=lambda cwd: -1 if cwd == '.' else len(cwd)) if found else None


# File names test runners pick up by default (pytest/unittest, Go, bun/jest/vitest).
TEST_NAME = re.compile(r'test_.+\.py|.+_test\.(?:py|go)|.+\.(?:test|spec)\.[cm]?[jt]sx?')


def large_selections(root, amap, groups):
    """[(suite, selected, known)] for each full suite whose directory holds more than
    amap['share'] of its test files among the selected tests. A file belongs to the most
    specific suite directory holding it (`.` holds what no other suite directory does), so
    nested suites are not counted twice. selected are the selected tests it holds, known how
    many test files it holds (existing files named like tests or matching the map's test
    patterns, plus the selected ones)."""
    patterns = [p for rule in amap['rules'] for p in rule['tests']]
    files = [p for p in _git_paths(['ls-files', '-co', '--exclude-standard'], root)
             if (TEST_NAME.fullmatch(os.path.basename(p))
                 or any(glob_match(p, pattern) for pattern in patterns))
             and (root / p).is_file()]
    suites = amap['suites']
    tests = [t for d, chosen in groups.items() for t in chosen]
    large = []
    for cwd in dict.fromkeys(s['cwd'] for s in suites):
        selected = [t for t in tests if owning_dir(suites, t) == cwd]
        if not selected:
            continue
        known = set(selected) | {f for f in files if owning_dir(suites, f) == cwd}
        if len(selected) > amap['share'] * len(known):
            large += [(s, selected, len(known)) for s in suites if s['cwd'] == cwd]
    return large


def run_large(root, large, share, prepared, via=None, run_id=None, results=None):
    """Run (or reuse) the full suite of each large selection through the gate instead of
    its selected tests: (exit code, [(directory, command, None) that failed])."""
    code, failed = 0, []
    for suite, selected, known in large:
        warn(f"the selection covers {len(selected)} of {known} test files in {suite['cwd']}, "
             f'over the share of {share:g} set in affected.full_suite_share; running its full '
             'suite instead:')
        warn(f"full suite in {suite['cwd']}: {suite['command']}")
        cwd = suite_cwd(root, suite)
        if not prepared(cwd, suite['cwd']):
            result = 2
            results.append(group_result('full-suite', suite['cwd'], suite['command'], 2,
                                        not_run='preparing the directory failed'))
        else:
            gate = Gate([suite['command']], cwd, None, load_config(),
                        {'purpose': 'large-selection', 'selected_tests': selected,
                         'suite_tests': known, 'share': share,
                         **({'via': via} if via else {}),
                         **({'run_id': run_id} if run_id else {})})
            result = drive_group(results, 'full-suite', suite['cwd'], suite['command'], gate,
                                 gate.run, selected)
        if result:
            failed.append((suite['cwd'], suite['command'], None))
        code = code or result
    return code, failed


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


def run_fallback(root, suites, fallback, prepared=None, via=None, run_id=None, results=None):
    """Run (or reuse) the given full suites through the gate: (exit code, [(directory,
    command, None) that failed]). prepared(cwd, what) is False when a suite's directory
    could not be prepared; via and run_id are recorded with each suite, and each suite is
    appended to results as group_result()."""
    results = [] if results is None else results
    warn('this change needs the full suite (map fallback):')
    for path, why in fallback:
        warn(f'  {path}: {why}')
    triggers = sorted({path for path, _ in fallback})
    code, failed = 0, []
    for suite in suites:
        warn(f"full suite in {suite['cwd']}: {suite['command']}")
        cwd = suite_cwd(root, suite)
        if prepared and not prepared(cwd, suite['cwd']):
            result = 2
            results.append(group_result('full-suite', suite['cwd'], suite['command'], 2,
                                        not_run='preparing the directory failed'))
        else:
            gate = Gate([suite['command']], cwd, None, load_config(),
                        {'purpose': 'map-fallback', 'trigger_files': triggers,
                         **({'via': via} if via else {}),
                         **({'run_id': run_id} if run_id else {})})
            result = drive_group(results, 'full-suite', suite['cwd'], suite['command'], gate,
                                 gate.run)
        if result:
            failed.append((suite['cwd'], suite['command'], None))
        code = code or result
    return code, failed


# ---------------------------------------------------------------- test cleanup

CLEANUP_DAYS = 30        # due when the last cleanup is more than this many days ago
CLEANUP_GROWTH = 1.3     # due when the median of later passes reaches baseline x this
CLEANUP_MIN_SAMPLES = 3  # later passes needed before the speed is judged
CLEANUP_LATEST = 5       # the median is taken over at most this many latest passes
CLEANUP_LABEL = 'test-cleanup'
CLEANUP_SLOWEST = 10     # test files listed on the cleanup ticket
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
                baseline_source='given' if baseline else None, samples=[], sample_count=0,
                slowest=None, flaky={})
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


def add_flaky(unit, flaky, time):
    """Count a run's flaky tests (failed first, passed on the rerun) in the unit's window."""
    counted = unit.setdefault('flaky', {})
    for entry in flaky:
        for test in entry['tests']:
            seen = counted.setdefault(f"{entry['file']}::{test}",
                                      {'file': entry['file'], 'test': test, 'count': 0})
            seen.update(count=seen['count'] + 1, last=time)


def add_run_details(unit, finished):
    """Keep the slowest test files of the latest pass that recorded per-file times, and count
    the run's flaky tests in the window."""
    if finished['files']:
        unit['slowest'] = {'time': finished['time'],
                           'files': list(finished['files'].items())[:CLEANUP_SLOWEST]}
    add_flaky(unit, finished['flaky'], finished['time'])


def count_flaky_in_project(info, flaky, time):
    """Count an affected run's flaky tests in the window of each full suite of its project
    the gate has seen; never changes the run's output or exit."""
    try:
        project = str(project_root(Path(info['repo'])))

        def update(state):
            for unit in state.get('cleanup', {}).values():
                if unit['project'] == project:
                    add_flaky(unit, flaky, time)
        with_state(update)
    except Interrupted:
        raise
    except Exception as exc:  # the cleanup state must never fail the run
        warn(f'flaky tests not counted for the test cleanup: {exc}')


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


def cleanup_leads(unit):
    """Markdown lines with the slowest test files and the window's flaky tests."""
    slowest = unit.get('slowest')
    if slowest:
        lines = [f"Slowest test files (the pass of {slowest['time']}):",
                 *(f'- `{path}` {secs(seconds)}' for path, seconds in slowest['files'])]
    else:
        lines = ['Slowest test files: no pass in this window recorded per-file times '
                 '(bun test lists them unless run by an AI agent; pytest only with '
                 '`--durations=0`; unittest never).']
    flaky = sorted((unit.get('flaky') or {}).values(), key=lambda f: (-f['count'], f['file']))
    lines.append('')
    if flaky:
        lines += ['Flaky tests in this window (failed first, passed on the rerun):',
                  *(f"- `{f['file']}`: {f['test']} ({f['count']} time(s), last {f['last']})"
                    for f in flaky)]
    else:
        lines.append('Flaky tests in this window: none.')
    return lines


def cleanup_ticket(unit, reasons):
    """(title, body, comment) for a cleanup ticket of this unit's project."""
    numbers = [f'- Due ({today().isoformat()}): ' + '; '.join(reasons), *cleanup_numbers(unit),
               '', *cleanup_leads(unit)]
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
        add_run_details(unit, finished)
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
        def shown(holder, source=None):
            cpu, mem, measured = reservation_of(holder, config)
            return dict(holder, usage=holder_usage(holder), unused=unused_reservation(
                holder, config), reservation={'cpu_cores': cpu, 'mem_bytes': mem,
                                              'source': source or measured})
        return (copy.deepcopy(state), host, [shown(h) for h in state['slots']],
                [shown(h, 'light') for h in state['light']])

    state, host, running, light = with_state(look)
    records = read_records()
    if fp_prefix:
        records = [r for r in records if (record_fingerprint(r) or '').startswith(fp_prefix)]
    records = records[-limit:]
    cap, floor = config['max_slots'], min(config['min_slots'], config['max_slots'])
    unused_cpu = sum(h['unused'][0] for h in running + light)
    unused_mem = sum(h['unused'][1] for h in running + light)
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
    background = unhandled_background(state, read_records())
    if as_json:
        shown = [{k: v for k, v in h.items() if k != 'unused'} for h in running]
        print(json.dumps({'min_slots': floor, 'max_slots': cap, 'config': config,
                          'host': host, 'running': shown, 'waiting': waiting,
                          'light': {'running': [{k: v for k, v in h.items() if k != 'unused'}
                                                for h in light],
                                    'cpu_budget_cores': light_budget()},
                          'locks': state['locks'], 'records': records, 'cleanup': cleanup,
                          'background_failures': background,
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
        if h.get('kind') == 'light':
            continue
        if h.get('kind') == 'slot':
            why = f"host slot: {h.get('reason') or 'not checked yet'}  {fmt_reservation(h)}"
        else:
            why = 'same content running'
        print(f"  {h['agent']}  {fmt_seconds(now - h['since'])}  {why}  "
              f"fp {(h.get('fingerprint') or '-')[:12]}  {h['cwd']}  {h['command']}")
    if not [h for h in waiting if h.get('kind') != 'light']:
        print('  none')
    reserved = sum(h['reservation']['cpu_cores'] for h in light)
    print(f"Light path: picked test files and builds, not recorded "
          f"({len(light)}/{config['light_max_slots']} light slots, reserving "
          f"{fmt_num(reserved)} of {fmt_num(light_budget())} cores):")
    for h in light:
        cores, mem = h['usage']['cpu_cores'], h['usage']['mem_bytes']
        print(f"  running  {h['agent']}  {fmt_seconds(now - h['since'])}  "
              f"cpu {'-' if cores is None else f'{cores:.1f} cores'}, "
              f"mem {'-' if mem is None else fmt_bytes(mem)}  {h['cwd']}  {h['command']}")
    for h in sorted((w for w in waiting if w.get('kind') == 'light'), key=lambda w: w['seq']):
        print(f"  waiting  {h['agent']}  {fmt_seconds(now - h['since'])}  "
              f"{h.get('reason') or 'not checked yet'}  {h['cwd']}  {h['command']}")
    if not light and not any(w.get('kind') == 'light' for w in waiting):
        print('  none')
    print(f'Recent records ({len(records)}):')
    for r in records:
        if r.get('kind') == 'affected-summary':
            print_affected_summary(r)
            continue
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
        files = r.get('reused_failed_first') if r.get('kind') == 'reuse' else failed_first(r)
        if files:
            result += ' ' + rerun_only_text(files)
        rerun = f"  rerun: {r['rerun_reason']}" if r.get('rerun_reason') else ''
        purpose = f"  purpose: {describe_purpose(r)}" if r.get('purpose') else ''
        print(f"  {r.get('time')}  {result}  fp {(record_fingerprint(r) or '-')[:12]}  "
              f"{r.get('agent')}  {r.get('duration_s')}s  {r.get('cwd')}  "
              f"{r.get('command')}{rerun}{purpose}")
        retry = r.get('rerun')
        if isinstance(retry, dict) and retry.get('skipped'):
            print(f"    failed tests not rerun: {retry['skipped']}")
        elif isinstance(retry, dict):
            print(f"    failed tests rerun once (first run exit {retry.get('first_exit_code')}): "
                  f"exit {retry.get('exit_code')} in {retry.get('duration_s')}s")
            for run in retry.get('runs') or []:
                print(f"      {run.get('dir')}: exit {run.get('exit_code')} in "
                      f"{run.get('duration_s')}s  {run.get('command')}")
    flaky = [(r, f) for r in records for f in r.get('flaky') or []]
    print(f'Flaky tests in these records (failed first, passed on the rerun): {len(flaky)}')
    for r, f in flaky:
        print(f"  {r.get('time')}  {f.get('file')}: {', '.join(f.get('tests') or [])}")
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
    print(f'Background full-suite failures without a ticket ({len(background)}):')
    for a in background:
        print(f"  {a['time']}  exit {a['exit_code']}  {a['project']}/{a['rel_cwd']}  "
              f"{a['command']}  commit {a['commit'][:12]}  fp {a['fingerprint'][:12]}")
    return 0


def print_affected_summary(r):
    """status lines for an affected summary record."""
    notes = [why for why, on in (('nothing selected', r.get('nothing_selected')),
                                 ('interrupted', r.get('interrupted')),
                                 ('content changed', r.get('content_changed'))) if on]
    rerun_only = r.get('rerun_only') or []
    if rerun_only:
        notes.append(f'{len(rerun_only)} group(s) PASSED ONLY ON RERUN')
    print(f"  {r.get('time')}  {'PASS' if r.get('passed') else 'FAIL'} ({r.get('purpose')} summary"
          f"{': ' + ', '.join(notes) if notes else ''})  run {(r.get('run_id') or '-')[:12]}  "
          f"{r.get('agent')}  {r.get('repo')}  base {(r.get('base') or '-')[:12]}  "
          f"commit {(r.get('commit') or '-')[:12]}  tree {(r.get('tree') or '-')[:12]}  "
          f"{len(r.get('changed_files') or [])} changed file(s)")
    for g in r.get('groups') or []:
        if g.get('not_run'):
            outcome = f"not run ({g['not_run']})"
        elif g.get('interrupted'):
            outcome = 'interrupted'
        elif g.get('reused'):
            run = g['reused'].get('run_id')
            outcome = (f"REUSED pass of {g['reused'].get('time')} by {g['reused'].get('agent')}"
                       + (f" (run {run[:12]})" if run else ''))
            if g.get('rerun_only'):
                outcome += (f" {rerun_only_text(g['rerun_only']['failed_first'])}  "
                            f"fp {(g['rerun_only']['fingerprint'] or '-')[:12]}")
        else:
            outcome = 'PASS' if g.get('exit_code') == 0 else f"FAIL exit {g.get('exit_code')}"
            if g.get('rerun_only'):
                outcome += (f" {rerun_only_text(g['rerun_only']['failed_first'])}  "
                            f"fp {(g['rerun_only']['fingerprint'] or '-')[:12]}")
            elif g.get('flaky') and g.get('exit_code') == 0:
                outcome += ' after rerun'  # summaries written before rerun_only
        print(f"    {g.get('kind')} in {g.get('dir')}: {outcome}  {g.get('command')}")


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
    return any(os.path.basename(word) == SCRIPT.name and words[i + 1:i + 2] in (['run'],
                                                                              ['light'])
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


def _wrap_suites(text, cwd, registry, wrap, match=is_full_suite):
    """text with each full-suite simple command (or each one match() takes) replaced in
    place by wrap(command text).

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
            body = _wrap_suites(words[index], cwd, registry, wrap, match)
            if body != words[index]:
                edits.append((*spans[index], shlex.quote(body)))
        elif _reads_stdin_script(words):
            for body, _, _, start, end in _stdin_heredoc(heredocs):
                wrapped = _wrap_suites(body, cwd, registry, wrap, match)
                if wrapped != body:
                    edits.append((start, end, wrapped))
        elif match(shlex.join(words), cwd, registry):
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


# systemd-run options that take a value; the light path runs the command in its own scope.
SYSTEMD_RUN_VALUE = {'-p', '--property', '-u', '--unit', '-E', '--setenv', '-H', '--host',
                     '-M', '--machine', '--slice', '--description', '--uid', '--gid',
                     '--nice', '--working-directory'}


def light_command(text):
    """The ready-to-run command that sends text through the light path; a leading
    systemd-run is left out, since its own scope would take the command out of the gate's."""
    try:
        words = shlex.split(text) if len(split_commands(text)) == 1 else None
    except (ValueError, UnreadableShellInput):
        words = None
    if words and os.path.basename(words[0]) == 'systemd-run':
        rest = words[_skip_options(words, 1, SYSTEMD_RUN_VALUE):]
        if rest:
            text = shlex.join(rest)
    return shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'light', '--', text])


def light_rewrite(text, cwd):
    """The command to run instead of text, or None when text runs no registered heavy
    command outside the gate."""
    try:
        commands = [words for words in split_commands(text) if not _is_gate_run(words)]
        if not commands:
            return None
        registry = load_registry(cwd) or {}
        if not is_heavy(' ; '.join(shlex.join(words) for words in commands), cwd, registry):
            return None
        rewritten = _wrap_suites(text, cwd, registry, light_command, is_heavy)
        return rewritten if rewritten != text else light_command(text)
    except Exception:  # unreadable text or a hook bug: never block on the light path
        return None


def read_state():
    """The shared state as last written, read without the lock or any change; {} when
    there is none."""
    try:
        state = json.loads((state_dir() / 'state.json').read_text())
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


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


def pre_merge_command(registry):
    """The pre-merge run; it names --base when the registry gives no integration_branch."""
    base = '' if (registry or {}).get('integration_branch') else \
        ' --base <commit this branch started from>'
    return f'{affected_command()}{base} --purpose pre-merge'


def timing_note(final, registry):
    """When to run what, for the hook's reply; final names what the pre-merge run tests."""
    return ('When to test: while editing, run the test files you choose (naming them is not '
            'blocked). Once, on the final version before merging to the integration branch, '
            f'run {final} through the gate:\n'
            f'  {pre_merge_command(registry)}\n'
            'It is recorded, and a pass on the same content is reused after the merge.')


def registered_suites(cwd):
    """True when the registry in cwd lists full suites."""
    try:
        return bool(read_full_suites(load_registry(cwd) or {}))
    except ValueError:
        return False


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
        light = text.strip() and light_rewrite(text, cwd)
        if not light or inside_gate(read_state()):
            return 0
        print('Blocked: this runs a heavy command (a browser test file or a build the project '
              'lists under `heavy` in .suite-gate.json) outside the gate. Run this instead; '
              'it waits for a light-path slot only while the host is busy, then runs at once. '
              'Nothing is recorded, so it is not merge evidence:\n'
              f'  {light}\n'
              'Only the heavy command is wrapped; the rest of your command is unchanged. It '
              'runs under /bin/sh in its own group, so it sees only exported variables and '
              'needs no systemd-run around it.' + _variable_gate_hint(text), file=sys.stderr)
        return 2
    if is_mapped(load_registry(cwd) or {}):
        affected = gate_rewrite(text, cwd, lambda _suite: affected_command())
        full = gate_rewrite(text, cwd, lambda suite: gate_command(suite, REASON_FLAGS))
        print('Blocked: this project has an affected-test map, so a branch runs only the '
              'tests its change affects, not the full suite. Run this instead:\n'
              f'  {affected}\n'
              'It runs the tests the map selects for the changed files, or the registered '
              'full suites through the gate when a change is not covered by the map.\n'
              'When a full suite is really needed, run it through the gate with a purpose:\n'
              f'  {full}\n'
              'Replace --reason \'<...>\' with --purpose release before a release. After a batch '
              'is merged, run the affected tests of the whole batch instead:\n'
              f'  {post_merge_command()}\n'
              'The purpose is recorded with the result.\n'
              + timing_note('the tests it affects', load_registry(cwd))
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
          'or a filter.'
          + (('\n' + timing_note('the registered full suites', load_registry(cwd)))
             if registered_suites(cwd) else '')
          + _variable_gate_hint(text),
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

HOOKS = ('pre-push', 'pre-commit')
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


def suite_fingerprint(root, registry, suite, commit=None):
    """The fingerprint the gate computes for a registered full suite run in its directory:
    commit's content (the work tree's when None) within the suite's scope, plus the
    `fingerprint_include` files from the work tree, the command and its directory."""
    rel, argv = rel_cwd(root, suite_cwd(root, suite)), [suite['command']]
    tree = content_tree(root, include_patterns(registry), commit,
                        suite_scope(root, registry, rel, argv))
    return digest(tree, argv, rel)


def lacking_full_suites(root, commit, registry):
    """The registered full suites with no reusable pass for commit's content
    (suite_fingerprint). ValueError when the registry lists no full suites, RuntimeError
    when Git fails. LAT's pre-authorization check calls this too."""
    suites = read_full_suites(registry)
    return [s for s in suites if not reusable_record(suite_fingerprint(root, registry, s, commit))]


SKILL_NAME = re.compile(r'^name:\s*["\']?([^"\'\s]+)', re.M)


def skill_folders(root):
    """{name: folder relative to root} for every SKILL.md under skills/ in the work tree,
    skipping folders inside a dot-directory. ValueError when a SKILL.md names no skill."""
    found = {}
    for path in sorted((root / 'skills').rglob('SKILL.md')):
        rel = path.parent.relative_to(root)
        if any(part.startswith('.') for part in rel.parts):
            continue
        text = path.read_text()
        match = SKILL_NAME.search(text.split('---', 2)[1]) if text.startswith('---\n') else None
        if not match:
            raise ValueError(f'no name in the frontmatter of {path}')
        found[match.group(1)] = rel.as_posix()
    return found


def subtrees(root, specs):
    """The object each `<tree>:<path>` names, or None when it does not exist."""
    if not specs:
        return []
    result = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname)'], cwd=root,
                            input=''.join(f'{spec}\n' for spec in specs),
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'git cat-file failed: {result.stderr.strip()}')
    return [None if line.endswith(' missing') else line
            for line in result.stdout.splitlines()]


def folder_suite_result(root, records, suite, folder, current):
    """'passed', 'failed' or 'missing': the latest full run of this suite (records newest
    first) whose content of folder equals current decides, as reusable_record does for the
    whole fingerprint."""
    runs = [r for r in records if not r.get('kind') and not r.get('content_changed')
            and r.get('rel_cwd') == suite['cwd'] and r.get('command') == suite['command']
            and isinstance(r.get('tree'), str)]
    for record, tree in zip(runs, subtrees(root, [f"{r['tree']}:{folder}" for r in runs])):
        if tree == current:
            return 'passed' if record.get('reusable') else 'failed'
    return 'missing'


def lacking_folder_suites(root, registry, folders, commit=None):
    """(content tree, [(folder, suite, 'failed' or 'missing')]) for each registered full suite
    run inside one of folders whose latest run on the same folder content did not pass.
    Content is commit's (the work tree's when None). Changes outside a folder keep its
    suites' passes. The skill installer and LAT's install-host check both call this."""
    suites = read_full_suites(registry)
    tree = content_tree(root, include_patterns(registry), commit)
    records = list(reversed(read_records()))
    lacking = []
    for folder in folders:
        current = subtrees(root, [f'{tree}:{folder}'])[0]
        if current is None:
            raise RuntimeError(f'{folder} is not in the content the gate fingerprints')
        for suite in suites:
            if suite['cwd'] == folder or suite['cwd'].startswith(folder + '/'):
                result = folder_suite_result(root, records, suite, folder, current)
                if result != 'passed':
                    lacking.append((folder, suite, result))
    return tree, lacking


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


HOOK_CREATED = '# suite-gate created this file; uninstall removes it.\n'


def hook_marks(hook):
    """The lines that open and close this check's block in a Git hook."""
    return f'# >>> suite-gate {hook} >>>', f'# <<< suite-gate {hook} <<<'


def hook_block(hook, created=False):
    run = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), hook])
    begin, end = hook_marks(hook)
    head = (f'{begin}\n' + (HOOK_CREATED if created else '') +
            f'# Added by suite-gate.py install-{hook}; remove with uninstall-{hook}.\n')
    if hook == 'pre-commit':
        return head + f'{run} || exit 1\n{end}\n'
    return (head +
            '# The pushed refs are kept for the rest of this hook on stdin.\n'
            'suite_gate_refs=$(mktemp) || exit 1\n'
            'trap \'rm -f "$suite_gate_refs"; exit 1\' HUP INT TERM\n'
            'cat > "$suite_gate_refs" || { rm -f "$suite_gate_refs"; exit 1; }\n'
            f'{run} "$@" < "$suite_gate_refs" || {{ rm -f "$suite_gate_refs"; exit 1; }}\n'
            'exec < "$suite_gate_refs"\n'
            'rm -f "$suite_gate_refs"\n'
            'trap - HUP INT TERM\n'
            f'{end}\n')


def updated_hook(text, action, hook='pre-push'):
    """The hook text with this check installed or removed; None removes the file."""
    lines = (text or '').splitlines(True)
    begin, end = hook_marks(hook)
    marks = [i for i, line in enumerate(lines) if line.rstrip('\n') in (begin, end)]
    if marks and [lines[i].rstrip('\n') for i in marks] != [begin, end]:
        raise ValueError('the suite-gate block is broken; inspect the hook')
    # Only a file this installer created is removed; any other keeps all its own lines.
    created = bool(marks) and HOOK_CREATED in lines[marks[0]:marks[1]]
    if action == 'uninstall':
        if not marks:
            return text
        rest = lines[:marks[0]] + lines[marks[1] + 1:]
        return None if created and ''.join(rest) == '#!/bin/sh\n' else ''.join(rest)
    block = hook_block(hook, created)
    if marks:
        return ''.join(lines[:marks[0]]) + block + ''.join(lines[marks[1] + 1:])
    if text is None:
        return '#!/bin/sh\n' + hook_block(hook, created=True)
    if not lines or not SH_SHEBANG.fullmatch(lines[0].strip()):
        stdin = ' (passing stdin on)' if hook == 'pre-push' else ''
        raise ValueError(f'the existing {hook} hook is not a sh or bash script, so it was '
                         'left unchanged. To chain it, move it to another name, make '
                         f'{hook} a sh script that runs it with "$@"{stdin}, then install '
                         'again')
    head = lines[0] if lines[0].endswith('\n') else lines[0] + '\n'
    return head + block + ''.join(lines[1:])


def cmd_hook_configure(hook, action, repo, preview):
    """Install or remove this check's block in repo's own Git hook (pre-push or pre-commit)."""
    root = repo_root(Path(repo))
    if root is None:
        raise ValueError(f'{repo} is not a Git work tree')
    if action == 'install':
        registry = load_registry(root)
        if registry is None:
            raise ValueError(f'no {REGISTRY_NAME} at {root}: the {hook} check is only for '
                             'repos with a registry')
        if hook == 'pre-push':
            read_full_suites(registry)
        elif not is_mapped(registry):
            raise ValueError(f'{root / REGISTRY_NAME} has no affected-test map '
                             '(`affected.map`); the pre-commit check runs the tests it selects')
        elif not read_map(registry)['branch']:
            raise ValueError(f'{root / REGISTRY_NAME} names no integration_branch; the '
                             'pre-commit check runs only on commits to that branch')
    # Always the repo's own hooks dir: a core.hooksPath may be shared by every repo.
    common = git(['rev-parse', '--git-common-dir'], root).stdout.strip()
    path = (root / common).resolve() / 'hooks' / hook
    active = (root / git(['rev-parse', '--git-path', 'hooks'], root).stdout.strip()).resolve()
    inactive = None
    if action == 'install' and active != path.parent:
        inactive = (f'Installed but NOT active: core.hooksPath={active} runs hooks from '
                    f'there, not from {path.parent}. Add a hand-over to {active}/{hook}, '
                    'for example:\n'
                    f'  local_hook="$(git rev-parse --git-common-dir)/hooks/{hook}"\n'
                    '  [ -x "$local_hook" ] && exec "$local_hook" "$@"\n'
                    '  exit 0')
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        original = None
    before = original.decode() if original is not None else None
    if action == 'install' and original is not None and not os.access(path, os.X_OK):
        raise ValueError(f'{path} exists but is not executable, so Git ignores it; it was '
                         f'left unchanged. Make it executable (it will then run on every '
                         f'{hook.split("-")[1]}) or remove it, then install again')
    after = updated_hook(before, action, hook)
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


# ---------------------------------------------------------------- pre-commit

def staged_tree(root):
    """Tree hash of the index the commit records (Git names it in GIT_INDEX_FILE while the
    hook runs), written from a copy so the index itself is untouched."""
    index = root / git(['rev-parse', '--git-path', 'index'], root).stdout.strip()
    with tempfile.TemporaryDirectory(prefix='suite-gate-') as tmp:
        copy = Path(tmp) / 'index'
        shutil.copy2(index, copy)
        result = git(['write-tree'], root, dict(os.environ, GIT_INDEX_FILE=str(copy)))
    if result.returncode != 0:
        raise RuntimeError(f'git write-tree failed: {result.stderr.strip()}')
    return result.stdout.strip()


def cmd_pre_commit():
    """Git pre-commit: on the integration branch, run the tests the affected-test map selects
    for the staged change against HEAD, on the staged content in a temporary checkout, and
    refuse the commit when any fails. Merge commits are not checked."""
    root = repo_root(Path.cwd())
    if root is None:
        return 0
    # The staged registry, so an unstaged edit cannot turn the check off; when it is
    # unreadable HEAD's names the branch, and the check below refuses it.
    registry = None
    for rev in ('', 'HEAD'):
        shown = git(['show', f'{rev}:{REGISTRY_NAME}'], root)
        if shown.returncode != 0:
            break
        try:
            registry = json.loads(shown.stdout)
        except ValueError:
            continue
        if isinstance(registry, dict):
            break
    branch = registry.get('integration_branch') if isinstance(registry, dict) else None
    if not branch or git(['symbolic-ref', '--quiet', '--short', 'HEAD'],
                         root).stdout.strip() != branch:
        return 0
    if git(['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'], root).returncode == 0:
        warn('pre-commit: a merge commit; not checked')
        return 0
    head = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], root).stdout.strip()
    if not head:
        return 0
    rerun = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'pre-commit'])

    def body():
        tree = staged_tree(root)
        # The tests start Git in other repos (and the checkout has its own index), so none
        # of the hook's repository settings may reach them.
        for name in git(['rev-parse', '--local-env-vars'], root).stdout.split():
            os.environ.pop(name, None)
        changed = _git_paths(['diff', '--name-only', '--no-renames', head, tree, '--'], root)
        if not changed:
            return 0
        with clean_checkout(root, head) as checkout:
            result = git(['read-tree', '-u', '--reset', tree], checkout)
            if result.returncode != 0:
                raise RuntimeError(f'git read-tree failed: {result.stderr.strip()}')
            staged = load_registry(checkout)
            if staged is None and (checkout / REGISTRY_NAME).exists():
                warn(f'commit refused: the staged {REGISTRY_NAME} is not a readable JSON '
                     'object. `git commit --no-verify` skips this check.')
                return 1
            if not is_mapped(staged or {}):
                return 0
            try:
                amap = read_map(staged)
            except ValueError as exc:
                warn(f'commit refused: the staged {REGISTRY_NAME}: {exc}. '
                     '`git commit --no-verify` skips this check.')
                return 1
            copy_included(root, checkout, staged)
            selected, fallback = select_tests(checkout, changed, amap, head)
            if not selected and not fallback and not due_checks(amap, changed):
                return 0
            warn(f'pre-commit: testing the staged change against HEAD ({len(changed)} '
                 f'file(s)) in a temporary checkout: {checkout}')
            prepared = {}

            def prepare(cwd):
                if cwd not in prepared:
                    prepared[cwd] = prepare_dependencies(cwd)
                return prepared[cwd]
            code, failed = run_selected(checkout, amap, selected, fallback,
                                        {'base': head, 'changed_files': changed}, prepare,
                                        'pre-commit')
        if not code:
            return 0
        warn('commit refused: these failed on the staged content:')
        for directory, command, tests in failed:
            warn(f"  {directory}: {', '.join(tests) if tests else 'full suite ' + command}")
        warn(f'Fix them, stage the fix and commit again. To repeat this check on what is '
             f'staged: cd {shlex.quote(str(root))} && {rerun}')
        for directory, command, tests in failed:
            if tests:
                cwd = root if directory == '.' else root / directory
                warn(f'  the tests in the work tree: cd {shlex.quote(str(cwd))} && {command}')
        warn('`git commit --no-verify` skips this check.')
        return code
    return _guarded(body)


# ---------------------------------------------------------------- background full suites

BACKGROUND_STALE_SECONDS = 24 * 3600  # a suite runs when its last pass is older than this
FAILURE_LABEL = 'suite-failure'
FAILURE_TITLE = 'Background full suite failed'
UNIT_CREATED = '# suite-gate created this file; uninstall-background removes it.\n'


def suite_key(root, suite):
    """What a registered suite's runs are filed under in every worktree and checkout of its
    repository: the same key as its measured usage."""
    return profile_key(root, suite['cwd'], suite['command'])


def parse_time(text):
    try:
        return datetime.fromisoformat(text).timestamp()
    except (TypeError, ValueError):
        return None


def last_pass(records, key):
    """When the latest reusable pass of the suite filed under key ended (any content, any
    purpose), as a timestamp; None when it never passed."""
    times = [parse_time(r.get('finished') or r.get('time')) for r in records
             if not r.get('kind') and r.get('reusable') and r.get('profile_key') == key]
    return max((t for t in times if t is not None), default=None)


def background_lock(root):
    """An exclusive lock on this repository's background run, or None when one holds it."""
    directory = state_dir() / 'background'
    directory.mkdir(parents=True, exist_ok=True)
    name = hashlib.sha256(profile_key(root, '.', '')['repo'].encode()).hexdigest()[:16]
    lock = open(directory / f'{name}.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return None
    return lock


def background_plan(root, registry, commit):
    """[(suite, fingerprint, why not run or None)] for the registered full suites on
    commit's content, by the background steps 2 to 4."""
    records = read_records()
    attempts = with_state(lambda state: copy.deepcopy(state.get('background', {})))
    plan = []
    for suite in read_full_suites(registry):
        fp = suite_fingerprint(root, registry, suite, commit)
        key = suite_key(root, suite)
        attempt = attempts.get(json.dumps(key, sort_keys=True)) or {}
        passed = last_pass(records, key)
        if reusable_record(fp):
            why = 'this content already passed'
        elif attempt.get('fingerprint') == fp and attempt.get('result') == 'failed':
            why = f"the background run on this content failed at {attempt.get('time')}"
        elif passed is not None and time.time() - passed <= BACKGROUND_STALE_SECONDS:
            why = (f'it passed {fmt_seconds(time.time() - passed)} ago, within '
                   f'{BACKGROUND_STALE_SECONDS // 3600} hours')
        else:
            why = None
        plan.append((suite, fp, why))
    return plan


def failure_ticket(root, suite, commit, fp, code, gate):
    """(title, body, comment) for the ticket of a failed background suite."""
    project = project_root(root).name
    title = f"{FAILURE_TITLE}: {project} ({suite['cwd']}) {suite['command']}"[:250]
    record = gate.record if gate else None
    facts = [f"- Project: {project}", f"- Directory: {suite['cwd']}",
             f"- Command: `{suite['command']}`", f'- Commit: {commit}',
             f'- Fingerprint: {fp}', f'- Exit code: {code}',
             f"- Time: {now_iso()}"]
    if record and record.get('content_changed'):
        facts.append('- The tests changed tracked files during the run, so it does not count '
                     'as a pass')
    tail = (record or {}).get('output_tail')
    if tail:
        facts += ['', 'Output tail:', '', '```', tail.rstrip(), '```']
    elif gate is None:
        facts.append('- The suite did not run: preparing its directory failed')
    look = f'`suite-gate.py status --fingerprint {fp[:12]}` on the host has the record.'
    body = '\n'.join(['The hourly background full suite failed on the integration branch, '
                      'after rerunning the failed tests once.', '', *facts, '', look,
                      'Close this ticket when the suite passes again.'])
    comment = '\n'.join(['The background full suite failed again on new content.', '',
                         *facts, '', look])
    return title, body, comment


def post_failure(tracker, title, body, comment, opened):
    """Comment on the open ticket of this suite, or open one; returns (what was done, its
    URL, its number). opened is the ticket this gate last used for the suite in this
    tracker, asked first; then open tickets are matched by title, labelled or not."""
    if opened is not None:
        issue = json.loads(gh(['issue', 'view', str(opened), '--json', 'state,title,url'],
                              tracker))
        if issue['state'] == 'OPEN' and issue.get('title') == title:
            gh(['issue', 'comment', str(opened), '--body', comment], tracker)
            return 'commented on', issue['url'], opened
    found = json.loads(gh(['issue', 'list', '--state', 'open', '--search',
                           f'"{FAILURE_TITLE}" in:title', '--json', 'number,title,url',
                           '--limit', '100'], tracker))
    same = [i for i in found if i.get('title') == title]
    if same:
        gh(['issue', 'comment', str(same[0]['number']), '--body', comment], tracker)
        return 'commented on', same[0]['url'], same[0]['number']
    create = ['issue', 'create', '--title', title, '--body', body]
    try:
        url = gh([*create, '--label', FAILURE_LABEL], tracker).strip()
    except RuntimeError as exc:
        warn(f'opening the ticket with the {FAILURE_LABEL} label failed ({exc}); opening it '
             'without a label, found again by its title')
        url = gh(create, tracker).strip()
    number = re.search(r'/issues/(\d+)$', url)
    return 'opened', url, int(number.group(1)) if number else None


def report_failure(root, registry, suite, key, commit, fp, code, gate):
    """Open or update the suite's failure ticket; the ticket URL, or None when the failure
    stays unhandled (no tracker, or the tracker could not be updated)."""
    tracker = read_tracker(registry)
    if tracker is None:
        warn(f'no tracker (`cleanup.github_repo` in {REGISTRY_NAME}): the failure is kept '
             'in the gate state and `suite-gate.py status` lists it')
        return None
    title, body, comment = failure_ticket(root, suite, commit, fp, code, gate)
    issue_key = json.dumps([tracker['repo'], key])
    opened = with_state(lambda state: state.get('background_issues', {}).get(issue_key))
    try:
        done, url, number = post_failure(tracker, title, body, comment, opened)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        warn(f"the tracker {tracker['repo']} could not be updated ({exc}); "
             '`suite-gate.py status` lists the failure')
        return None
    if number is not None:
        def remember(state):
            state.setdefault('background_issues', {})[issue_key] = number
        with_state(remember)
    warn(f'suite failure ticket: {done} {url}')
    return url


def run_background_suite(root, checkout, registry, suite, commit, fp, prepared):
    """Run one suite through the gate in the checkout (purpose background) and store the
    attempt under the fingerprint it ran on; the exit code. Files an earlier suite changed
    or added in the checkout are reset to the commit first."""
    for step in (['reset', '-q', '--hard'], ['clean', '-fdq']):
        result = git(step, checkout)
        if result.returncode != 0:
            raise RuntimeError(f'git {step[0]} in the checkout failed: {result.stderr.strip()}')
    cwd = suite_cwd(checkout, suite)
    if cwd not in prepared:
        prepared[cwd] = prepare_dependencies(cwd)
    gate = None
    if prepared[cwd]:
        warn(f"not run: preparing {suite['cwd']} failed ({prepared[cwd]})")
        code = 2
    else:
        gate = Gate([suite['command']], cwd, None, load_config(), {'purpose': 'background'})
        code = _drive(gate, gate.run)
        if code == 0 and gate.record and gate.record.get('content_changed'):
            warn('the tests changed tracked files, so this pass is not reusable; counted as '
                 'a failure')
            code = 1
        if gate.me['fingerprint'] and gate.me['fingerprint'] != fp:
            warn('the suite ran on other content than planned (an ignored file changed); '
                 'the attempt is kept for the content it ran on')
            fp = gate.me['fingerprint']
    key = json.dumps(suite_key(root, suite), sort_keys=True)
    attempt = {'project': str(project_root(root)), 'rel_cwd': suite['cwd'],
               'command': suite['command'], 'commit': commit, 'fingerprint': fp,
               'time': now_iso(), 'result': 'failed' if code else 'passed',
               'exit_code': code, 'ticket': None}
    if code:
        attempt['ticket'] = report_failure(root, registry, suite, key, commit, fp, code, gate)

    def store(state):
        state.setdefault('background', {})[key] = attempt
    with_state(store)
    return code


def cmd_background(repo):
    """Fill in missing full-suite passes on the local integration branch: the steps in
    references/suite-gate.md (Background full suites)."""
    root = repo_root(Path(repo))
    if root is None:
        warn(f'background: {repo} is not a Git work tree')
        return 2
    branch = (load_registry(root) or {}).get('integration_branch')
    if not isinstance(branch, str) or not branch:
        warn(f'background: {root / REGISTRY_NAME} names no integration_branch')
        return 2
    lock = background_lock(root)
    if lock is None:
        print(f'suite-gate background: another background run of {root} is going; done')
        return 0
    with lock:
        result = git(['rev-parse', '--verify', '--quiet', f'refs/heads/{branch}^{{commit}}'],
                     root)
        if result.returncode != 0:
            warn(f'background: no local branch {branch}')
            return 2
        commit = result.stdout.strip()
        registry = base_registry(root, commit)
        try:
            plan = background_plan(root, registry or {}, commit)
        except (RuntimeError, ValueError) as exc:
            warn(f'background: {branch} at {commit[:12]}: {exc}')
            return 2
        warn(f'background: {branch} at {commit[:12]}')
        for suite, _fp, why in plan:
            warn(f"  {suite['cwd']}: {suite['command']}: "
                 + (f'not run, {why}' if why else 'runs'))
        due = [(suite, fp) for suite, fp, why in plan if why is None]
        if not due:
            return 0

        def body():
            with clean_checkout(root, commit) as checkout:
                copy_included(root, checkout, registry)
                prepared, code = {}, 0
                for suite, fp in due:
                    result = run_background_suite(root, checkout, registry, suite, commit,
                                                  fp, prepared)
                    code = code or result
                return code
        return _guarded(body)


def unhandled_background(state, records):
    """The stored background failures with no ticket and no later pass of the suite."""
    out = []
    for key, attempt in (state.get('background') or {}).items():
        if attempt.get('result') != 'failed' or attempt.get('ticket'):
            continue
        passed = last_pass(records, json.loads(key))
        failed = parse_time(attempt.get('time'))
        if passed is None or failed is None or passed < failed:
            out.append(attempt)
    return out


def unit_paths(root):
    """The service and timer files of root's background timer, in the user's systemd dir."""
    base = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config') / 'systemd/user'
    slug = re.sub(r'[^A-Za-z0-9]+', '-', root.name).strip('-') or 'repo'
    name = f"suite-gate-background-{slug}-{hashlib.sha256(str(root).encode()).hexdigest()[:8]}"
    return base / f'{name}.service', base / f'{name}.timer'


def systemd_word(word):
    """word as one ExecStart= argument: quoted, with systemd's % and $ escaped."""
    escaped = word.replace('\\', '\\\\').replace('"', '\\"')
    return '"' + escaped.replace('%', '%%').replace('$', '$$') + '"'


def unit_texts(root, uv):
    """(service, timer) text for root's hourly background run; PATH is the installer's, so
    the suites find the same tools."""
    command = ' '.join(systemd_word(w) for w in [uv, 'run', '--no-project', 'python',
                                                  str(SCRIPT), 'background', '--repo',
                                                  str(root)])
    path = os.environ.get('PATH', '').replace('%', '%%').replace('\\', '\\\\') \
        .replace('"', '\\"')
    head = (UNIT_CREATED + '# Added by suite-gate.py install-background.\n[Unit]\n'
            f'Description=suite-gate background full suites of {root}\n')
    service = (head + '\n[Service]\nType=oneshot\nNice=10\n'
               f'Environment="PATH={path}"\nExecStart={command}\n')
    timer = (head + '\n[Timer]\nOnCalendar=hourly\nPersistent=true\n\n'
             '[Install]\nWantedBy=timers.target\n')
    return service, timer


def systemctl(*args):
    result = subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True,
                            stdin=subprocess.DEVNULL, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"systemctl --user {' '.join(args)} failed: "
                           f"{result.stderr.strip() or f'exit {result.returncode}'}")


def ensure_failure_label(registry):
    """Create the suite-failure label in the registry's tracker; skipped when it exists."""
    tracker = read_tracker(registry)
    if tracker is None:
        print(f'No tracker (`cleanup.github_repo` in {REGISTRY_NAME}): no label created; '
              '`suite-gate.py status` lists background failures')
        return
    try:
        gh(['label', 'create', FAILURE_LABEL, '--color', 'B60205', '--description',
            'A background full suite failed'], tracker)
        print(f"Created the {FAILURE_LABEL} label in {tracker['repo']}")
    except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
        if 'already exists' in str(exc):
            print(f"The {FAILURE_LABEL} label already exists in {tracker['repo']}")
        else:
            warn(f'could not create the {FAILURE_LABEL} label ({exc}); failure tickets are '
                 'then opened without it and found by title')


def cmd_background_configure(action, repo, preview):
    """Install or remove root's hourly background timer (a systemd user timer)."""
    root = repo_root(Path(repo))
    if root is None:
        raise ValueError(f'{repo} is not a Git work tree')
    root = root.resolve()
    registry = None
    if action == 'install':
        registry = load_registry(root)
        if registry is None:
            raise ValueError(f'no {REGISTRY_NAME} at {root}: the background run is only for '
                             'repos with a registry')
        read_full_suites(registry)
        if not isinstance(registry.get('integration_branch'), str) \
                or not registry['integration_branch']:
            raise ValueError(f'{root / REGISTRY_NAME} names no integration_branch; the '
                             'background run tests that branch')
        uv = shutil.which('uv')
        if uv is None:
            raise ValueError('uv is not on PATH; the timer runs the gate with it')
        texts = unit_texts(root, uv)
    paths = unit_paths(root)
    befores = [p.read_text() if p.exists() else None for p in paths]
    for path, before in zip(paths, befores):
        if before is not None and UNIT_CREATED not in before:
            raise ValueError(f'{path} exists and suite-gate did not create it; it was left '
                             'unchanged')
    afters = texts if action == 'install' else (None, None)
    timer = paths[1].name
    if afters == tuple(befores):
        print(f'No changes: {paths[0]}, {paths[1]}')
    else:
        for path, before, after in zip(paths, befores, afters):
            print(''.join(difflib.unified_diff((before or '').splitlines(True),
                                               (after or '').splitlines(True),
                                               fromfile=str(path), tofile=str(path))), end='')
        if preview:
            print(f'Would run: systemctl --user daemon-reload; systemctl --user '
                  f"{'enable --now' if action == 'install' else 'disable --now'} {timer}")
            return 0
        if action == 'uninstall' and befores[1] is not None:
            systemctl('disable', '--now', timer)
        for path, after in zip(paths, afters):
            if after is None:
                path.unlink(missing_ok=True)
            else:
                # Not write_file: its backup would sit among the user's unit files.
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(after)
        systemctl('daemon-reload')
        if action == 'install':
            systemctl('enable', '--now', timer)
        print(f"{'Installed' if action == 'install' else 'Removed'} {timer}")
    if action == 'install' and not preview:
        ensure_failure_label(registry)
    return 0


# ---------------------------------------------------------------- entry

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # A hook that exits 2 would block every command, so the hook does not check this.
    if not sys.platform.startswith('linux') and argv[:1] in (
            ['run'], ['light'], ['status'], ['affected'], ['cleanup-done'], ['pre-commit'],
            ['background'],
            ['install-background']):
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
    sub.add_parser('light', help='run a test file or build you picked through the light path: '
                   'light -- <cmd>; queued in its own slots, nothing recorded')
    affected = sub.add_parser('affected', help='run the tests the affected-test map selects '
                                               'for this change: affected [--base <rev>] '
                                               '[--purpose pre-merge|post-merge]')
    affected.add_argument('--base', metavar='REV', help='measure the change from this commit '
                          'instead of the merge-base of HEAD and the integration branch')
    affected.add_argument('--purpose', choices=('pre-merge', 'post-merge'),
                          help='pre-merge: the final version of a branch before it is merged; '
                               'post-merge: after a batch is merged, needs --base (where the '
                               'batch started). Both write a summary record of the whole run; '
                               'without an affected-test map they run every registered full '
                               'suite once')
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
    sub.add_parser('pre-commit', help='Git pre-commit hook: on the integration branch, run '
                   'the tests the affected-test map selects on the staged content')
    background = sub.add_parser('background', help='run the registered full suites the local '
                                'integration branch lacks a recent pass of (the hourly timer '
                                'runs this)')
    background.add_argument('--repo', required=True, help='the repo (work tree) to test')
    for action in ('install-background', 'uninstall-background'):
        config = sub.add_parser(action, help=f"{action.split('-')[0]} the hourly systemd user "
                                'timer that runs `background` for a repo with a registry')
        config.add_argument('--repo', required=True, help='the repo (work tree) to change')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    for action in (f'{a}-{h}' for h in HOOKS for a in ('install', 'uninstall')):
        config = sub.add_parser(action, help=f'{action.split("-")[0]} the '
                                f'{action.split("-", 1)[1]} check in a repo with a registry')
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
    if args.action == 'light':
        if not command:
            parser.error('light needs the command after --')
        return cmd_light(command)
    if command:
        parser.error(f'{args.action} takes no command')
    if args.action == 'hook':
        return cmd_hook()
    if args.action == 'affected':
        return cmd_affected(args.base, args.purpose)
    if args.action == 'cleanup-done':
        return cmd_cleanup_done(args.command, args.baseline)
    if args.action == 'pre-push':
        return cmd_pre_push()
    if args.action == 'pre-commit':
        return cmd_pre_commit()
    if args.action == 'background':
        return cmd_background(args.repo)
    if args.action in ('install-background', 'uninstall-background'):
        try:
            return cmd_background_configure(args.action.split('-')[0], args.repo, args.preview)
        except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
            warn(str(exc))
            return 1
    if args.action.split('-', 1)[-1] in HOOKS:
        try:
            action, hook = args.action.split('-', 1)
            return cmd_hook_configure(hook, action, args.repo, args.preview)
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
