#!/usr/bin/env python3
"""Host-wide full-suite gate.

`run [--rerun "<reason>"] -- <cmd>` reuses a passing result for identical content, lets
only one of several identical requests run, and caps how many full suites run on the host
at once. `status` lists running and queued suites and recent records. `is_full_suite()`
decides whether a shell command is a full suite run (project registry first, then the
default runner rules) and is meant to be reused by a pre-tool hook.

Linux only: slot and lock holders stay counted while their test session has live processes.
"""
import argparse
import fcntl
import fnmatch
import hashlib
import json
import os
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
DEFAULTS = {'max_slots': 2, 'poll_seconds': 1.0, 'report_seconds': 30.0}
TAIL_LINES = 20
TAIL_BYTES = 8192
KILL_GRACE_SECONDS = 5.0
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)


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

SEPARATORS = {';', '&&', '||', '|', '&', '(', ')', '|&', ';;'}
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


def split_commands(command):
    """Simple commands of a shell string, as word lists; `sh -c '...'` is opened up."""
    lexer = shlex.shlex(command, posix=True, punctuation_chars=';&|()')
    lexer.whitespace_split = True
    lexer.commenters = '#'
    try:
        tokens = list(lexer)
    except ValueError:
        tokens = command.split()
    commands, words = [], []
    for token in tokens + [';']:
        if token in SEPARATORS or token == '\n':
            if words:
                commands.extend(_open_shell(words))
            words = []
        else:
            words.append(token)
    return commands


def _open_shell(words):
    rest = _strip_assignments(words)
    if rest and os.path.basename(rest[0]) in SHELLS:
        for i, word in enumerate(rest[1:], 1):
            if word == '-c' or (word.startswith('-') and not word.startswith('--')
                                and 'c' in word[1:]):
                if i + 1 < len(rest):
                    return split_commands(rest[i + 1])
                break
    return [words]


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
    try:
        return ' '.join(shlex.split(pattern))
    except ValueError:
        return ' '.join(pattern.split())


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
    """One spelling for `-- pytest -q` and `-- 'pytest -q'` (the latter runs via sh -c)."""
    if len(argv) == 1:
        try:
            return shlex.join(shlex.split(argv[0]))
        except ValueError:
            return ' '.join(argv[0].split())
    return shlex.join(argv)


def fingerprint(cwd, argv):
    """Dict with fingerprint, tree, repo and relative cwd; None outside a Git work tree."""
    root = repo_root(cwd)
    if root is None:
        return None
    registry = load_registry(cwd) or {}
    include = registry.get('fingerprint_include') or []
    include = [p for p in include if isinstance(p, str)]
    tree = content_tree(root, include)
    rel = os.path.relpath(Path(cwd).resolve(), root.resolve())
    command = normalize_command(argv)
    digest = hashlib.sha256(f'{tree}\0{command}\0{rel}'.encode()).hexdigest()
    return {'fingerprint': digest, 'tree': tree, 'repo': str(root), 'rel_cwd': rel}


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


# ---------------------------------------------------------------- run

class Gate:
    def __init__(self, argv, cwd, rerun, config):
        self.argv = argv
        self.cwd = cwd
        self.rerun = rerun
        self.config = config
        self.command = normalize_command(argv)
        self.child = None
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
        """Drop this gate's entries; a slot whose test session still runs stays counted."""
        def change(state):
            state['waiters'] = [w for w in state['waiters'] if w['id'] != self.me['id']]
            state['locks'] = {k: v for k, v in state['locks'].items() if v['id'] != self.me['id']}
            kept = []
            for holder in state['slots']:
                if holder['id'] != self.me['id']:
                    kept.append(holder)
                elif holder.get('sid') and session_pids(holder['sid']):
                    holder['gate_done'] = True
                    kept.append(holder)
            state['slots'] = kept
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

    def execute(self, info):
        argv = ['/bin/sh', '-c', self.argv[0]] if len(self.argv) == 1 else self.argv
        started, start_iso = time.monotonic(), now_iso()
        # An interrupt must not land between starting the session and recording it.
        old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, SIGNALS)
        try:
            child = subprocess.Popen(argv, cwd=self.cwd, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, start_new_session=True)
            self.child = child
            self.set_session(child.pid)
        except OSError as exc:
            warn(f'could not start {argv[0]}: {exc}')
            return 127
        finally:
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
        duration = round(time.monotonic() - started, 1)
        after = fingerprint(self.cwd, self.argv) if info else None
        changed = info is not None and after['fingerprint'] != info['fingerprint']
        record = {
            'fingerprint': info and info['fingerprint'], 'tree': info and info['tree'],
            'repo': info and info['repo'], 'command': self.command, 'cwd': str(self.cwd),
            'rel_cwd': info and info['rel_cwd'], 'exit_code': code, 'duration_s': duration,
            'output_tail': tail.text(), 'agent': self.me['agent'], 'time': start_iso,
            'finished': now_iso(), 'rerun_reason': self.rerun, 'content_changed': changed,
            'reusable': info is not None and code == 0 and not changed,
        }
        append_record(record)
        if changed:
            warn('content changed during the run: this result is recorded but will not be '
                 'reused; do not edit files while the suite runs')
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
    if record.get('rerun_reason'):
        print(f"  rerun reason: {record['rerun_reason']}")
    if record.get('output_tail'):
        print('  output tail:')
        for line in record['output_tail'].splitlines():
            print(f'    {line}')
    print(f'To run it anyway: suite-gate.py run --rerun "<reason>" -- {command}')


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
        child = gate.child
        if child is not None:
            for sig in SIGNALS:
                signal.signal(sig, signal.SIG_IGN)
            warn('interrupted: ending the test session; no record written')
            end_session(child.pid, child)
        return 128 + exc.signum
    except RuntimeError as exc:
        warn(str(exc))
        return 2
    finally:
        gate.release()


# ---------------------------------------------------------------- status

def cmd_status(as_json, fp_prefix, limit):
    state = with_state(lambda current: current)
    records = read_records()
    if fp_prefix:
        records = [r for r in records if (r.get('fingerprint') or '').startswith(fp_prefix)]
    records = records[-limit:]
    max_slots = load_config()['max_slots']
    if as_json:
        print(json.dumps({'max_slots': max_slots, 'running': state['slots'],
                          'waiting': state['waiters'], 'locks': state['locks'],
                          'records': records}, ensure_ascii=False, indent=1))
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
        rerun = f"  rerun: {r['rerun_reason']}" if r.get('rerun_reason') else ''
        print(f"  {r.get('time')}  {result}  fp {(r.get('fingerprint') or '-')[:12]}  "
              f"{r.get('agent')}  {r.get('duration_s')}s  {r.get('cwd')}  "
              f"{r.get('command')}{rerun}")
    return 0


# ---------------------------------------------------------------- entry

def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not sys.platform.startswith('linux'):
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
    args = parser.parse_args(argv)
    if args.action == 'run':
        if not command:
            parser.error('run needs the suite command after --')
        return cmd_run(args.rerun, command)
    if command:
        parser.error('status takes no command')
    return cmd_status(args.json, args.fingerprint, args.limit)


if __name__ == '__main__':
    sys.exit(main())
