#!/usr/bin/env python3
"""Host-wide full-suite gate.

`run [--rerun "<reason>"] -- <cmd>` reuses a passing result for identical content, lets
only one of several identical requests run, and caps how many full suites run on the host
at once; in a project with an affected-test map it needs a purpose. After each full suite
that ran it checks whether the project is due for a test cleanup and opens or updates a
cleanup ticket; `cleanup-done [--command <cmd> [--baseline <s>]]` starts a new cleanup
window. `affected [--base
<rev>]` runs only the tests the map selects for this change, or the registered full suites
through the gate when the change leaves the map. `status` lists running and queued suites
and recent records. `is_full_suite()`
decides whether a shell command is a full suite run (project registry first, then the
default runner rules). `hook` is the PreToolUse hook that blocks full suites run outside
the gate (with an affected-test map it points at `affected` instead), and `install` /
`uninstall --client claude|codex` add or remove it. `pre-push` is the Git pre-push check
that refuses pushing main or a tag without a passing record of every registered full
suite; `install-pre-push` / `uninstall-pre-push --repo <dir>` add or remove it.

Linux only: slot and lock holders stay counted while their test session has live processes.
"""
import argparse
import copy
import difflib
import fcntl
import fnmatch
import hashlib
import json
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
DEFAULTS = {'max_slots': 2, 'poll_seconds': 1.0, 'report_seconds': 30.0}
TAIL_LINES = 20
TAIL_BYTES = 8192
KILL_GRACE_SECONDS = 5.0
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
LAUNCHER = 'read -r go <&3 || exit 125; exec 3<&-; exec "$@"'


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
    config = dict(DEFAULTS)
    path = config_path()
    try:
        data = json.loads(path.read_text())
    except FileNotFoundError:
        return config
    except (OSError, ValueError) as exc:
        warn(f'ignoring unreadable config {path}: {exc}')
        return config
    for key, default in DEFAULTS.items():
        value = data.get(key) if isinstance(data, dict) else None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
            config[key] = type(default)(value)
    return config


def warn(text):
    print(f'suite-gate: {text}', file=sys.stderr, flush=True)


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
    """Dict with fingerprint, tree, repo and relative cwd; None outside a Git work tree."""
    root = repo_root(cwd)
    if root is None:
        return None
    tree = content_tree(root, include_patterns(load_registry(cwd) or {}))
    rel = rel_cwd(root, cwd)
    return {'fingerprint': digest(tree, argv, rel), 'tree': tree, 'repo': str(root),
            'rel_cwd': rel}


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


def holder_alive(holder):
    if not holder.get('gate_done') and pid_alive(holder['pid'], holder['start']):
        return True
    return bool(holder.get('sid')) and bool(session_pids(holder['sid']))


def end_session(sid, child):
    """SIGTERM every process of the test session, then SIGKILL what is left."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in session_pids(sid):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + KILL_GRACE_SECONDS
        while time.monotonic() < deadline:
            child.poll()
            if not session_pids(sid):
                return
            time.sleep(0.05)
    child.poll()


# ---------------------------------------------------------------- shared state

class Interrupted(Exception):
    def __init__(self, signum):
        super().__init__(signum)
        self.signum = signum


def _child_setup(go_read):
    """In the forked child: put the go pipe on fd 3 and reopen the signals the gate blocks."""
    def setup():
        os.dup2(go_read, 3)
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

    Records whose content changed mid-run describe no single content and are skipped, as
    are affected-test runs and reuse notes (records with a `kind`).
    """
    for record in reversed(read_records()):
        if record.get('kind'):
            continue
        if record.get('fingerprint') == fp and not record.get('content_changed'):
            return record if record.get('reusable') else None
    return None


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
        self.finished = None  # a full suite that ran, for the cleanup check
        self.me = {'id': uuid.uuid4().hex, 'pid': os.getpid(),
                   'start': proc_stat(os.getpid())[2], 'sid': None, 'agent': agent_name(),
                   'command': self.command, 'cwd': str(cwd), 'fingerprint': None}

    def _holder(self, **extra):
        return dict(self.me, since=time.time(), **extra)

    def _wait(self, attempt, describe):
        started = last = time.monotonic()
        while True:
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

    def acquire_slot(self):
        def attempt(state):
            mine = next((w for w in state['waiters'] if w['id'] == self.me['id']
                         and w.get('kind') == 'slot'), None)
            if mine is None:
                state['seq'] += 1
                mine = self._holder(kind='slot', seq=state['seq'])
                state['waiters'].append(mine)
            ahead = [w for w in state['waiters']
                     if w.get('kind') == 'slot' and w['seq'] < mine['seq']]
            if len(state['slots']) + len(ahead) < self.config['max_slots']:
                state['waiters'].remove(mine)
                state['slots'].append(self._holder())
                return True
            return None

        def describe(state):
            running = ', '.join(f"{h['agent']} {fmt_seconds(time.time() - h['since'])}"
                                for h in state['slots']) or 'none'
            mine = next((w for w in state['waiters'] if w['id'] == self.me['id']), None)
            ahead = sum(1 for w in state['waiters'] if w.get('kind') == 'slot'
                        and mine and w['seq'] < mine['seq'])
            return (f'waiting for a host slot ({len(state["slots"])}/{self.config["max_slots"]}'
                    f' in use: {running}; {ahead} ahead)')

        self._wait(attempt, describe)

    def set_session(self, sid):
        def change(state):
            for holder in [*state['locks'].values(), *state['slots']]:
                if holder['id'] == self.me['id']:
                    holder['sid'] = sid
        self.me['sid'] = sid
        with_state(change)

    def release(self):
        """Drop this gate's entries; a lock or slot whose test session still runs stays held."""
        def still_held(holder):
            if holder['id'] != self.me['id']:
                return True
            if holder.get('sid') and session_pids(holder['sid']):
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
        """Report the earlier pass; a run with a purpose also notes the reuse in the ledger."""
        print_reuse(record, self.command)
        if self.extra.get('purpose'):
            append_record({
                'kind': 'reuse', 'fingerprint': info['fingerprint'], 'tree': info['tree'],
                'repo': info['repo'], 'command': self.command, 'cwd': str(self.cwd),
                'rel_cwd': info['rel_cwd'], 'exit_code': 0, 'agent': self.me['agent'],
                'time': now_iso(), 'reusable': False, 'reused_time': record.get('time'),
                'reused_agent': record.get('agent'), 'purpose': None, 'purpose_reason': None,
                **self.extra})
        return 0

    def execute(self, info):
        argv = ['/bin/sh', '-c', self.argv[0]] if len(self.argv) == 1 else self.argv
        started, start_iso = time.monotonic(), now_iso()
        # The suite waits for a byte on fd 3 until its session is recorded; if the gate is
        # killed before that, the pipe closes and the suite never runs uncounted.
        go_read, go_write = os.pipe()
        # An interrupt must not land between starting the session and recording it.
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            child = subprocess.Popen(['/bin/sh', '-c', LAUNCHER, 'suite-gate', *argv],
                                     cwd=self.cwd, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, start_new_session=True,
                                     pass_fds=(3,), preexec_fn=_child_setup(go_read))
            self.child = child
            self.set_session(child.pid)
            os.write(go_write, b'go\n')
        except OSError as exc:
            warn(f'could not start /bin/sh: {exc}')
            return 127
        finally:
            os.close(go_read)
            os.close(go_write)
            signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        tail = Tail()
        pumps = [threading.Thread(target=pump, args=(stream, out, tail), daemon=True)
                 for stream, out in ((child.stdout, sys.stdout.buffer),
                                     (child.stderr, sys.stderr.buffer))]
        for thread in pumps:
            thread.start()
        code = child.wait()
        for thread in pumps:
            thread.join(timeout=2)
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
            'purpose': None, 'purpose_reason': None,
        }
        record.update(self.extra)
        append_record(record)
        if info is not None and not record.get('kind'):
            self.finished = {'info': info, 'seconds': seconds, 'sample': record['reusable']}
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
        child = gate.child
        if child is not None:
            for sig in SIGNALS:
                signal.signal(sig, signal.SIG_IGN)
            warn('interrupted: ending the test session; no record written')
            end_session(child.pid, child)
        raise
    finally:
        gate.release()
    if gate.finished:
        check_cleanup(gate.finished, gate.command, gate.cwd)
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


def cmd_run(rerun, purpose, reason, argv):
    if rerun is not None and not rerun.strip():
        warn('--rerun needs a reason')
        return 2
    if reason is not None and not reason.strip():
        warn('--reason needs text')
        return 2
    if purpose and reason:
        warn('give either --purpose or --reason, not both')
        return 2
    if reason:
        purpose = 'reason'
    if purpose is None and is_mapped(load_registry(Path.cwd()) or {}):
        warn('this project has an affected-test map, so a full suite needs a purpose. '
             'For the tests this change affects, run instead:\n'
             f'  {affected_command()}\n'
             'For a full suite, add one after `run`: --purpose post-merge (after a batch '
             'is merged), --purpose release (before a release), or --reason "<why the full '
             'suite is needed>"')
        return 2
    extra = {'purpose': purpose, 'purpose_reason': reason.strip() if reason else None}
    gate = Gate(argv, Path.cwd(), rerun.strip() if rerun else None, load_config(), extra)
    return _guarded(lambda: _drive(gate, gate.run))


# ---------------------------------------------------------------- affected tests

def is_mapped(registry):
    """True when the registry has an affected-test map."""
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


def select_tests(root, changed, amap):
    """({test: [why]}, [(file, why)] that need the full suite) for the changed files."""
    files = [p for p in _git_paths(['ls-files', '-co', '--exclude-standard'], root)
             if (root / p).is_file()]
    rules = amap['rules']
    test_patterns = [p for rule in rules for p in rule['tests']]
    selected, fallback = {}, []
    for path in changed:
        shared = next((p for p in amap['shared'] if glob_match(path, p)), None)
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
        selected, fallback = select_tests(root, changed, amap)
        groups = {}
        for test in sorted(selected):
            directory = command_dir(test, amap['commands'])
            if directory is None:
                fallback.append((test, 'no affected.commands directory holds this test'))
            else:
                groups.setdefault(directory, []).append(test)
        if fallback:
            return run_fallback(root, amap, fallback)
        if not groups:
            warn('no tests selected for this change; nothing to run')
            return 0
        warn('selected tests:')
        for test in sorted(selected):
            warn(f"  {test}  ({'; '.join(selected[test])})")
        code = 0
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


def run_fallback(root, amap, fallback):
    """Run (or reuse) every registered full suite through the gate."""
    warn('this change needs the full suite (map fallback):')
    for path, why in fallback:
        warn(f'  {path}: {why}')
    triggers = sorted({path for path, _ in fallback})
    code = 0
    for suite in amap['suites']:
        cwd = root if suite['cwd'] == '.' else root / suite['cwd']
        warn(f"full suite in {suite['cwd']}: {suite['command']}")
        gate = Gate([suite['command']], cwd, None, load_config(),
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


def post_cleanup(tracker, title, body, comment):
    """Comment on the open cleanup issue, or open one; returns what was done."""
    found = json.loads(gh(['issue', 'list', '--state', 'open', '--label', tracker['label'],
                           '--json', 'number,url', '--limit', '1'], tracker))
    if found:
        gh(['issue', 'comment', str(found[0]['number']), '--body', comment], tracker)
        return f"commented on {found[0]['url']}"
    url = gh(['issue', 'create', '--title', title, '--label', tracker['label'],
              '--body', body], tracker).strip()
    return f'opened {url}'


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
        return dict(unit), reasons, claimed, previous

    unit, reasons, claimed, previous = with_state(update)
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
        done = post_cleanup(tracker, title, body, comment)
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
    state = with_state(lambda current: current)
    records = read_records()
    if fp_prefix:
        records = [r for r in records if (r.get('fingerprint') or '').startswith(fp_prefix)]
    records = records[-limit:]
    max_slots = load_config()['max_slots']
    cleanup = [dict(unit, median=cleanup_median(unit), due=cleanup_due(unit))
               for unit in state.get('cleanup', {}).values()]
    if as_json:
        print(json.dumps({'max_slots': max_slots, 'running': state['slots'],
                          'waiting': state['waiters'], 'locks': state['locks'],
                          'records': records, 'cleanup': cleanup},
                         ensure_ascii=False, indent=1))
        return 0
    now = time.time()
    print(f"Running ({len(state['slots'])}/{max_slots} host slots):")
    for h in state['slots'] or []:
        note = ' (gate gone, test session still alive)' if h.get('gate_done') or not \
            pid_alive(h['pid'], h['start']) else ''
        print(f"  {h['agent']}  {fmt_seconds(now - h['since'])}  "
              f"fp {(h.get('fingerprint') or '-')[:12]}  {h['cwd']}  {h['command']}{note}")
    if not state['slots']:
        print('  none')
    print('Waiting:')
    for h in sorted(state['waiters'], key=lambda w: w['since']):
        why = 'host slot' if h.get('kind') == 'slot' else 'same content running'
        print(f"  {h['agent']}  {fmt_seconds(now - h['since'])}  {why}  "
              f"fp {(h.get('fingerprint') or '-')[:12]}  {h['cwd']}  {h['command']}")
    if not state['waiters']:
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
        print(f"  {r.get('time')}  {result}  fp {(r.get('fingerprint') or '-')[:12]}  "
              f"{r.get('agent')}  {r.get('duration_s')}s  {r.get('cwd')}  "
              f"{r.get('command')}{rerun}{purpose}")
    print(f'Test cleanup ({len(cleanup)} suites):')
    for unit in cleanup:
        print(f"  {'DUE' if unit['due'] else 'not due'}: `{unit['command']}` in "
              f"{unit['project']}/{unit['rel_cwd']}")
        # The first two lines name the project and suite, already on the heading line.
        for line in cleanup_numbers(unit)[2:] + [f'- Due: {why}' for why in unit['due']]:
            print(f'    {line[2:]}')
    return 0


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
    rewritten, so the shell's assignments, options and isolation stay.
    """
    parts, last = [], 0
    for words, spans in _simple_commands(text):
        if _is_gate_run(words):
            continue
        index = _shell_body_index(words)
        if index is not None:
            body = _wrap_suites(words[index], cwd, registry, wrap)
            start, end = spans[index]
            replacement = None if body == words[index] else shlex.quote(body)
        elif is_full_suite(shlex.join(words), cwd, registry):
            start, end = spans[0][0], spans[-1][1]
            replacement = wrap(text[start:end])
        else:
            replacement = None
        if replacement is not None:
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
    except Exception:  # unreadable text or a hook bug: block what looks like a runner
        if SCRIPT.name not in text and LOOKS_LIKE_TESTS.search(text):
            return wrap(text)
        return None


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
              'or --purpose release before a release. The purpose is recorded with the result.',
              file=sys.stderr)
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
    cwd = root if suite['cwd'] == '.' else root / suite['cwd']
    run = gate_command(suite['command'], ('--purpose', 'release'))
    return f'cd {shlex.quote(str(cwd))} && {run}'


def cmd_pre_push():
    """Git pre-push: refuse pushing main or a tag unless every registered full suite has a
    reusable pass for the pushed commit (its tree plus `fingerprint_include` files from the
    work tree, the command and its directory: the fingerprint the gate would compute)."""
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
        suites = read_full_suites(registry)
        include = include_patterns(registry)
        missing, differs = {}, []
        for commit, refs in commits.items():
            tree = content_tree(root, include, commit)
            lacking = [s for s in suites if not reusable_record(
                digest(tree, [s['command']], rel_cwd(root, root / s['cwd'])))]
            if lacking:
                missing[commit] = (refs, lacking)
                if content_tree(root, include) != tree:
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
    run = sub.add_parser('run', help='run a full suite through the gate: run [--rerun "<reason>"] -- <cmd>')
    run.add_argument('--rerun', metavar='REASON', help='run even if this content already passed')
    run.add_argument('--purpose', choices=('post-merge', 'release'),
                     help='why a full suite runs; required with an affected-test map')
    run.add_argument('--reason', metavar='TEXT',
                     help='a free-text purpose instead of --purpose')
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
