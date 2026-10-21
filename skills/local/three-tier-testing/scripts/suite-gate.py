#!/usr/bin/env python3
"""Host-wide full-suite gate.

`run [--rerun "<reason>"] -- <cmd>` reuses a passing result for identical content, lets
only one of several identical requests run, and starts a queued full suite when the host has
room for its measured peak (with a floor, a cap and a pressure brake). `status` lists running
and queued suites, why the queue waits, and recent records. `is_full_suite()`
decides whether a shell command is a full suite run (project registry first, then the
default runner rules). `hook` is the PreToolUse hook that blocks full suites run outside
the gate, and `install` / `uninstall --client claude|codex` add or remove it.

Linux only: each suite runs in its own systemd user scope (cgroup v2), and slot and lock
holders stay counted while that group has processes. Without a user scope the suite runs
in a new session instead, which is then what counts.
"""
import argparse
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
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

REGISTRY_NAME = '.suite-gate.json'
DEFAULTS = {'min_slots': 2, 'max_slots': 8, 'poll_seconds': 1.0, 'report_seconds': 30.0,
            'sample_seconds': 2.0, 'brake_io_high': 40.0, 'brake_io_low': 20.0,
            'brake_cpu_high': 50.0, 'brake_cpu_low': 25.0, 'default_cores': 4.0,
            'default_mem_gb': 4.0, 'mem_reserve_gb': 8.0, 'profile_history': 5}
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

OPERATORS = ('<<<', '&&', '||', ';;', '|&', '>>', '<<', '&>', '>&', '<&', '>|',
             ';', '&', '|', '(', ')', '<', '>', '\n')
REDIRECTS = {'<<<', '>>', '<<', '&>', '>&', '<&', '>|', '<', '>'}
SHELLS = {'sh', 'bash', 'zsh', 'dash'}

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
    begins a comment up to the end of the line. ValueError on an unclosed quote.
    """
    tokens, i, n = [], 0, len(text)
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
            tokens.append((''.join(value), False, start, i))
    return tokens


def _simple_commands(text):
    """(words, spans) for each simple command, without opening `sh -c`.

    Redirections (`2>&1`, `> out`) are dropped with their target; spans are each word's
    (start, end) in text. ValueError on an unclosed quote.
    """
    commands, words, spans = [], [], []
    drop_next = False
    for value, is_operator, start, end in _tokens(text) + [('\n', True, len(text), len(text))]:
        if is_operator and value in REDIRECTS:
            if words and words[-1].isdigit() and spans[-1][1] == start:
                words.pop()  # the file descriptor of `2>`
                spans.pop()
            drop_next = True
        elif is_operator:
            if words:
                commands.append((words, spans))
            words, spans, drop_next = [], [], False
        elif drop_next:
            drop_next = False
        else:
            words.append(value)
            spans.append((start, end))
    return commands


def split_commands(command):
    """Simple commands of a shell string, as word lists; `sh -c '...'` is opened up.

    Newlines separate commands, redirections (`2>&1`, `> out`) are dropped with their
    target, and `#` at the start of a word starts a comment up to the end of the line.
    """
    try:
        found = [words for words, _ in _simple_commands(command)]
    except ValueError:
        found = [command.split()]
    return [inner for words in found for inner in _open_shell(words)]


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


def _open_shell(words):
    index = _shell_body_index(words)
    return [words] if index is None else split_commands(words[index])


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


def _unwrap(words):
    """Strip env assignments and launcher words; return (runner, args) or None."""
    words = _strip_assignments(words)
    while words:
        head = os.path.basename(words[0])
        if head in WRAP_VALUE or head in ('time', 'command', 'exec', 'xvfb-run'):
            i = _skip_options(words, 1, WRAP_VALUE.get(head, set()))
            if head == 'timeout' and i < len(words):
                i += 1  # the duration
            words = _strip_assignments(words[i:])
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
    return data if isinstance(data, dict) else None


def _normalize_words(words):
    return ' '.join(words)


def is_full_suite(command, cwd='.', registry=None):
    """True when a shell command runs a full suite.

    With a registry that lists `suites`, only those patterns (fnmatch, whitespace
    normalized) count; otherwise a known test runner with no file, path or filter
    argument counts as full. Pass `registry` to skip reading it from cwd.
    """
    if registry is None:
        registry = load_registry(cwd) or {}
    patterns = registry.get('suites') if isinstance(registry, dict) else None
    commands = split_commands(command)
    if isinstance(patterns, list) and patterns:
        normalized = [p for p in (_normalize_pattern(p) for p in patterns if isinstance(p, str))
                      if p]
        candidates = [_normalize_words(_strip_assignments(w)) for w in commands]
        candidates.append(_normalize_words([w for c in commands for w in c]))
        return any(fnmatch.fnmatchcase(c, p) for c in candidates for p in normalized)
    for words in commands:
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


def content_tree(root, include=()):
    """Tree hash of tracked plus unignored new files (and `include` paths), via a
    throwaway index so the real one is untouched."""
    with tempfile.TemporaryDirectory(prefix='suite-gate-') as tmp:
        index = Path(tmp) / 'index'
        real = git(['rev-parse', '--git-path', 'index'], root).stdout.strip()
        if real and (root / real).is_file():
            # copy2 keeps the index mtime, which Git needs to re-check racily clean entries
            shutil.copy2(root / real, index)
        env = dict(os.environ, GIT_INDEX_FILE=str(index))
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


def fingerprint(cwd, argv):
    """Dict with fingerprint, tree, repo, relative cwd and profile key; None outside a Git
    work tree."""
    root = repo_root(cwd)
    if root is None:
        return None
    registry = load_registry(cwd) or {}
    include = registry.get('fingerprint_include') or []
    include = [p for p in include if isinstance(p, str)]
    tree = content_tree(root, include)
    rel = os.path.relpath(Path(cwd).resolve(), root.resolve())
    mode = 'shell' if len(argv) == 1 else 'exec'
    command = normalize_command(argv)
    digest = hashlib.sha256(f'{tree}\0{mode}\0{command}\0{rel}'.encode()).hexdigest()
    return {'fingerprint': digest, 'tree': tree, 'repo': str(root), 'rel_cwd': rel,
            'profile_key': profile_key(root, rel, command)}


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


def with_state(change):
    """Run change(state) under the host-wide state lock, with dead holders pruned."""
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
            records.append(json.loads(line))
        except ValueError:
            continue
    return records


def reusable_record(fp):
    """The latest record for this content when it passed; None when it failed or is absent.

    Records whose content changed mid-run describe no single content and are skipped.
    """
    for record in reversed(read_records()):
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
    def __init__(self, argv, cwd, rerun, config):
        self.argv = argv
        self.cwd = cwd
        self.rerun = rerun
        self.config = config
        self.command = normalize_command(argv)
        self.child = None
        self.group = None  # the suite's cgroup, None in a plain session
        self.sampler = None
        self.keeper = self.keeper_pid = None  # holds the group open until it is measured
        self.finished = False  # the suite exited by itself
        self.key = None  # what its measured usage is filed under
        self.measured = None  # (profile_history, measured reservation) read for self.key
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
        """The measured reservation for this suite's command, read again when
        profile_history changes; None means the configured default."""
        history = self.config['profile_history']
        if self.measured is None or self.measured[0] != history:
            self.measured = (history, measured_reservation(self.key, history))
        return self.measured[1]

    def acquire_slot(self):
        """Queue first come, first served; only the first in the queue may start, when
        admission() lets it. Every other waiter records why it waits."""
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
        """Record the suite's session and group on this gate's lock and slot."""
        def change(state):
            for holder in [*state['locks'].values(), *state['slots']]:
                if holder['id'] == self.me['id']:
                    holder['sid'], holder['cgroup'] = sid, group
        self.me['sid'], self.me['cgroup'] = sid, group
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
                    print_reuse(record, self.command)
                    return 0
            if fp:
                self.acquire_lock(fp)
                if not self.rerun:
                    record = reusable_record(fp)
                    if record:
                        self.release()
                        print_reuse(record, self.command)
                        return 0
            self.acquire_slot()
            if info is not None:
                again = fingerprint(self.cwd, self.argv)
                if again['fingerprint'] != fp:
                    warn('content changed while queued; starting over with the new content')
                    self.release()
                    continue
            return self.execute(info)

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
        for thread in pumps:
            thread.join(timeout=2)
        profile = self.measure(time.monotonic() - started)
        code = 128 - code if code < 0 else code
        duration = round(time.monotonic() - started, 1)
        after = fingerprint(self.cwd, self.argv) if info else None
        changed = info is not None and after['fingerprint'] != info['fingerprint']
        record = {
            'fingerprint': info and info['fingerprint'], 'tree': info and info['tree'],
            'repo': info and info['repo'], 'command': self.command, 'cwd': str(self.cwd),
            'rel_cwd': info and info['rel_cwd'], 'exit_code': code, 'duration_s': duration,
            'output_tail': tail.text(), 'agent': self.me['agent'], 'time': start_iso,
            'finished': now_iso(), 'rerun_reason': self.rerun, 'content_changed': changed,
            'reusable': info is not None and code == 0 and not changed, 'profile': profile,
            'profile_key': info and info['profile_key'],
        }
        append_record(record)
        if changed:
            warn('content changed during the run: this result is recorded but will not be '
                 'reused; do not edit files while the suite runs, and git-ignore files the '
                 'tests generate (e.g. __pycache__/, .pytest_cache/, build output). '
                 'Run `git status --porcelain` to see what changed')
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


def cmd_run(rerun, argv):
    if rerun is not None and not rerun.strip():
        warn('--rerun needs a reason')
        return 2
    gate = Gate(argv, Path.cwd(), rerun.strip() if rerun else None, load_config())
    for sig in SIGNALS:
        signal.signal(sig, _raise_interrupted)
    try:
        return gate.run()
    except Interrupted as exc:
        if gate.child is not None and not gate.finished:
            for sig in SIGNALS:
                signal.signal(sig, signal.SIG_IGN)
            warn('interrupted: ending the suite and everything it started; no record written')
            gate.end_suite()
        elif gate.child is not None:
            warn('interrupted: no record written')
        return 128 + exc.signum
    except RuntimeError as exc:
        warn(str(exc))
        return 2
    finally:
        gate.release()


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
        records = [r for r in records if (r.get('fingerprint') or '').startswith(fp_prefix)]
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
    if as_json:
        shown = [{k: v for k, v in h.items() if k != 'unused'} for h in running]
        print(json.dumps({'min_slots': floor, 'max_slots': cap, 'config': config,
                          'host': host, 'running': shown, 'waiting': waiting, 'locks': state['locks'], 'records': records},
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
        note = '' if gate_alive(h) else (' (gate gone, its group still has processes)'
                                         if h.get('cgroup') else
                                         ' (gate gone, test session still alive)')
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
        rerun = f"  rerun: {r['rerun_reason']}" if r.get('rerun_reason') else ''
        print(f"  {r.get('time')}  {result}  fp {(r.get('fingerprint') or '-')[:12]}  "
              f"{r.get('agent')}  {r.get('duration_s')}s  {r.get('cwd')}  "
              f"{r.get('command')}{rerun}")
    return 0


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


def gate_command(text):
    """The ready-to-run command that sends text through the gate."""
    return shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'run', '--', text])


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


def _wrap_suites(text, cwd, registry):
    """text with each full-suite simple command replaced in place by its gate command.

    The rest of the text (cd, export, pipes, a later echo) stays as written, so the gate
    records the suite's own exit code. In `bash -c '<body>'` only the body argument is
    rewritten, so the shell's assignments, options and isolation stay.
    """
    parts, last = [], 0
    for words, spans in _simple_commands(text):
        if _is_gate_run(words):
            continue
        index = _shell_body_index(words)
        if index is not None:
            body = _wrap_suites(words[index], cwd, registry)
            start, end = spans[index]
            replacement = None if body == words[index] else shlex.quote(body)
        elif is_full_suite(shlex.join(words), cwd, registry):
            start, end = spans[0][0], spans[-1][1]
            replacement = gate_command(text[start:end])
        else:
            replacement = None
        if replacement is not None:
            parts += [text[last:start], replacement]
            last = end
    return ''.join(parts) + text[last:]


def gate_rewrite(text, cwd):
    """The command to run instead of text, or None when text runs no full suite outside
    `suite-gate.py run`."""
    try:
        commands = [words for words in split_commands(text) if not _is_gate_run(words)]
        if not commands:
            return None
        registry = load_registry(cwd) or {}
        if not is_full_suite(' ; '.join(shlex.join(words) for words in commands), cwd,
                             registry):
            return None
        rewritten = _wrap_suites(text, cwd, registry)
        # Only the commands together match a registry pattern: send all of them.
        return rewritten if rewritten != text else gate_command(text)
    except Exception:  # unreadable text or a hook bug: block what looks like a runner
        if SCRIPT.name not in text and LOOKS_LIKE_TESTS.search(text):
            return gate_command(text)
        return None


def cmd_hook():
    """PreToolUse (matcher Bash) for Claude and Codex: exit 2 with the rewrite on stderr."""
    try:
        payload = json.load(sys.stdin)
        text = shell_text(payload.get('tool_input', {}).get('command', ''))
        cwd = payload.get('cwd') or os.getcwd()
    except (ValueError, AttributeError):
        return 0  # nothing to read; never leave the agent stuck
    rewrite = text.strip() and gate_rewrite(text, cwd if os.path.isdir(cwd) else os.getcwd())
    if not rewrite:
        return 0
    print('Blocked: this runs a full test suite outside the suite gate. Run this instead; '
          'the gate reuses a passing result for the same content and queues when the host '
          'is busy:\n'
          f'  {rewrite}\n'
          'Only the suite command itself is wrapped, so the gate records its own exit code; '
          'the rest of your command is unchanged. The wrapped part runs under /bin/sh and '
          'sees only exported variables. '
          'Add --rerun "<reason>" after `run` only when the gate reports an earlier pass and '
          'you have a concrete reason to run again. To run only some tests, name the files '
          'or a filter.',
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
    argv = list(sys.argv[1:] if argv is None else argv)
    # A hook that exits 2 would block every command, so only run and status check this.
    if not sys.platform.startswith('linux') and argv[:1] in (['run'], ['status']):
        warn('only Linux is supported')
        return 2
    command = []
    if '--' in argv:
        cut = argv.index('--')
        argv, command = argv[:cut], argv[cut + 1:]
    parser = argparse.ArgumentParser(prog='suite-gate.py', description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='action', required=True)
    run = sub.add_parser('run', help='run a full suite through the gate: run [--rerun "<reason>"] -- <cmd>')
    run.add_argument('--rerun', metavar='REASON', help='run even if this content already passed')
    status = sub.add_parser('status', help='show running and queued suites and recent records')
    status.add_argument('--json', action='store_true')
    status.add_argument('--fingerprint', metavar='PREFIX', help='only records for this fingerprint')
    status.add_argument('--limit', type=int, default=10)
    sub.add_parser('hook', help='PreToolUse hook (matcher Bash) for Claude and Codex; '
                                'reads the payload on stdin')
    for action in ('install', 'uninstall'):
        config = sub.add_parser(action, help=f'{action} the hook in a client\'s settings')
        config.add_argument('--client', choices=('claude', 'codex'), required=True)
        config.add_argument('--claude-settings', metavar='PATH',
                            help='default: $CLAUDE_CONFIG_DIR/settings.json or '
                                 '~/.claude/settings.json')
        config.add_argument('--codex-home', metavar='DIR', help='default: $CODEX_HOME or ~/.codex')
        config.add_argument('--preview', action='store_true', help='show the diff, write nothing')
    args = parser.parse_args(argv)
    if args.action == 'run':
        if not command:
            parser.error('run needs the suite command after --')
        return cmd_run(args.rerun, command)
    if command:
        parser.error(f'{args.action} takes no command')
    if args.action == 'hook':
        return cmd_hook()
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
