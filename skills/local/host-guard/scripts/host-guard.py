#!/usr/bin/env python3
"""PreToolUse hook that keeps agents from starving a shared host.

Eight rules, for Claude Code (Bash, Grep, Glob, Write, Edit, NotebookEdit) and Codex (Bash):
- whole-disk scans: find / du / grep -r / rg / fd / tree / ls -R rooted at /, /mnt,
  /media or a configured extra root are blocked;
- CPU load generators (busy loops, stress, stress-ng, sysbench cpu, yes > /dev/null)
  must run on a limited set of cores via taskset, systemd-run or cpulimit;
- an unquoted heredoc whose body holds `...` or $(...) is blocked: the shell runs those
  commands while writing what was meant as text (a brief, a message);
- rm / trash-put / trash / gio trash is blocked when a path ends in a substitution that
  deletes the parent folder if it comes out empty, or when it targets a folder of agent
  conversation records or state (or a folder above one);
- `bunx skills add` from a LoopAgentTeams checkout is blocked: its install script installs
  only skills whose full suite passed for their current content;
- a test runner (bun test, pytest, vitest, cargo test) must run under a memory limit and a
  timeout: a runaway test can take all the memory of the host;
- pkill -f and killall are blocked: they reach every process that matches, including the
  caller's own shell, other agents and live services. Kill by PID instead;
- going around `vm` borrowing of host VMs (the vm skill) is blocked: docker power actions on
  a listed VM container, writes to the vm state files under $VM_HOME (default ~/vm, also
  through Claude's file tools), VM power schedules (systemd, at, crontab), docker run with
  /dev/kvm, docker create with /dev/kvm except by the machine's borrower, the vm user-only
  flags, and any path into the old ~/vm-busi folder.
"""
import argparse
import copy
import difflib
import fnmatch
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
# A test runner at the start of a shell command, behind any of the wrappers people put there.
# Anchored so that `grep pytest` or `uv pip install pytest` are not test runs.
FLAGS = r'(?:-\S+(?:\s+[^-\s;&|]\S*)??\s+)*'
TEST_START = r'(?:^|[;&|(`\'"\n])\s*'
RUN_WRAPPERS = (r'(?:\w+=\S*\s+'
                r'|(?:sudo|nice|ionice|env|exec|command|xargs)\s+(?:-\S+\s+(?:\d+\s+)?)*'
                r'|time\s+(?:-\S+\s+)*'
                r'|timeout\s+(?:-\S+\s+(?:[\d.]\S*\s+(?=[\d.]))?)*\S+\s+'
                r'|systemd-run\s+(?:-\S+(?:\s+\w+=\S+)?\s+)*)*')
SHELL = r'(?:[\w./~-]*/)?(?:ba|z|da)?sh\s+(?:-\S+\s+)*'
TEST_RUN = re.compile(
    TEST_START
    + r'(?P<prefix>' + RUN_WRAPPERS + r'(?:' + SHELL + r'-\w*c\s+[\'"]\s*' + RUN_WRAPPERS + r')*)'
    r'(?:uv\s+run\s+' + FLAGS + r')?'
    r'(?:bunx\s+|bun\s+x\s+|npx\s+|python3?\s+-m\s+)?'
    r'(?:[\w./~-]*/)?'
    r'(?:bun\s+' + FLAGS + r'(?:run\s+' + FLAGS + r')?test[\w:-]*'
    r'|pytest|py\.test|vitest'
    r'|cargo\s+(?:\+\S+\s+)?' + FLAGS + r'test)'
    r'(?=[\s;&|)\'"`]|$)')
MEMORY_CAP = re.compile(r'\bsystemd-run\s(?:.*\s)?(?:-p\s*|--property[=\s])MemoryMax=\d')
TIME_CAP = re.compile(r'(?:^|\s)timeout\s+(?:-\S+\s+(?:[\d.]\S*\s+(?=[\d.]))?)*'
                      r'(?!0*\.?0*[smhd]?\s)(?:\d|\.\d)')
# A shell at the start of a command, so `echo bash -c 'pytest'` stays text.
SHELL_BEFORE = re.compile(r'(?:^|[;&|(`\n])\s*' + RUN_WRAPPERS + SHELL + r'$')
DEFAULT_TEST_MEMORY = '40G'
# Heredoc bodies and quoted text are data (messages, prompts), except a script after `-c`.
HEREDOC = re.compile(r'<<-?\s*([\'"]?)([A-Za-z_]\w*)\1[^\n]*\n.*?^\s*\2\s*$', re.S | re.M)
# `<<`, not `<<<`; the delimiter word ends at whitespace or a shell operator.
HEREDOC_START = re.compile(r'(?<!<)<<(?!<)(-?)[ \t]*((?:\\.|\'[^\']*\'|"(?:\\.|[^"\\])*"|[^\s;&|()<>\'"\\])+)')
QUOTED = re.compile(r"""(-\w*c\s+)?('[^']*'|"(?:\\.|[^"\\])*")""")
DELETE = re.compile(r'(?:^|[;&|({\n]|\b(?:then|do|else|elif)\s|-\w*c\s+[\'"])\s*'
                    r'(?:\w+=\S*\s+)*' + WRAPPERS + r'(?:\w+=\S*\s+)*'
                    r'(?P<tool>(?:[\w.~-]*/)*(?:rm|trash-put|trash)|gio\s+trash)(?=\s)')
CD = re.compile(r'(?:^|[;&|(\n])\s*cd(?=\s)')
SEPARATORS = r'&&|\|\||[;&|()\n]'
# A last path component that is only a substitution: `$x`, `${x}`, `$(cmd)` or `cmd`.
# Placeholders for a $, backtick or ~ that quotes keep literal.
LITERAL = {'$': '\x01', '`': '\x02', '~': '\x03'}
BARE_SUBSTITUTION = re.compile(r'\$\{?\w+\}?|\$\(.*\)|`.*`', re.S)
# Command words for the `bunx skills add` rule, read with shell quoting.
OPERATORS = ';&|()`\n'
# Options of PREFIXES that take the next word as their value (sudo -u USER, nice -n 10).
VALUE_OPTIONS = {'sudo': {'-u', '-g', '-h', '-p', '-r', '-t', '-C', '-D', '-R', '-T', '-U',
                          '--user', '--group', '--host', '--prompt', '--role', '--type',
                          '--chdir', '--chroot', '--close-from', '--command-timeout',
                          '--other-user'},
                 'nice': {'-n', '--adjustment'},
                 'ionice': {'-c', '-n', '--class', '--classdata'},
                 'env': {'-u', '-C', '-S', '--unset', '--chdir'},
                 'exec': {'-a'},
                 'xargs': {'-I', '-n', '-P', '-L', '-s', '-a', '-d', '-E', '--max-args',
                           '--max-procs', '--max-lines', '--max-chars', '--arg-file', '--delimiter'},
                 'time': {'-f', '-o', '--format', '--output'},
                 'timeout': {'-k', '-s', '--kill-after', '--signal'},
                 'stdbuf': {'-i', '-o', '-e', '--input', '--output', '--error'},
                 'taskset': {'-c', '--cpu-list'},
                 'systemd-run': {'-p', '-u', '-E', '-H', '-M', '--property', '--unit', '--setenv',
                                 '--slice', '--uid', '--gid', '--working-directory',
                                 '--description', '--host', '--machine'}}
SHELLS = {'sh', 'bash', 'zsh', 'dash'}
PREFIXES = {'sudo', 'nice', 'ionice', 'env', 'exec', 'command', 'xargs', 'nohup', 'time',
            'timeout', 'setsid', 'stdbuf', 'taskset', 'systemd-run'}
ASSIGNMENT = re.compile(r'^[A-Za-z_]\w*=')
# A wrapper's bare argument: timeout's duration, taskset's mask.
WRAPPER_NUMBER = re.compile(r'\.?\d\S*')
# A redirection before a command; without an attached target the next word is that target.
REDIRECTION = re.compile(r'\d*[<>]+&?(?P<target>.*)')
# Words that may come before a command in a statement.
SHELL_KEYWORDS = {'{', '!', 'if', 'then', 'elif', 'else', 'while', 'until', 'do'}
# pkill short options that take a value, so the rest of a cluster such as -ufoo is that value.
PKILL_VALUE_FLAGS = 'gGOPstuUFrq'
INSTALL_SCRIPT = 'scripts/install-skills.py'
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
                '`systemd-run --user --scope --slice=lat-tests.slice -p CPUQuota={quota}% <command>` '
                '(AllowedCPUs only works where cpuset is delegated to the user manager; here it does not).')
TEST_MESSAGE = ('Blocked: this runs tests without a memory limit and a timeout. A runaway test can '
                'take all the memory of this shared host. Run it as `systemd-run --user --scope -q '
                '--slice=lat-tests.slice -p MemoryMax={limit} -p MemorySwapMax=0 -p OOMPolicy=continue timeout <seconds> '
                '<test command>`; only the test is killed if it goes over.')
HEREDOC_MESSAGE = ('Blocked: the heredoc <<{name} is unquoted and its body contains {what}, so the '
                   'shell runs that as a command while writing the text. Quote the delimiter '
                   "(<<'{name}') to keep the body literal, or write the file with the Write tool "
                   'and pass it with --file. If you meant to insert command output, run the '
                   'command into a variable first and use the variable in the heredoc.')
EMPTY_MESSAGE = ('Blocked: {tool} {word} ends in a substitution. If it comes out empty, {tool} '
                 'deletes the parent folder instead. Check the value first, or write it as '
                 '${{name:?}} so the shell stops on an empty value.')
PROTECTED_MESSAGE = ('Blocked: {tool} {word} would delete {path}, which holds agent conversation '
                     'records or state that other sessions use. Delete single files inside it '
                     'instead (as the session-manager skill does), or ask the user.')

INSTALL_MESSAGE = ('Blocked: this installs skills straight from the LoopAgentTeams repo at '
                   '{repo}, which skips the check that each skill passed its full suite for '
                   'its current content. Run the install script instead; it installs only '
                   'verified skills and otherwise lists the suites to run first:\n'
                   '  uv run --no-project python {script} [--skill NAME ...]\n'
                   'Installs from other sources (for example mattpocock/skills) are not '
                   'affected.')
KILL_MESSAGE = ('Blocked: {tool} reaches every process that matches, including your own shell, '
                'other agents and live services. Find the process with `pgrep -af PATTERN`, '
                'check that it is yours, then `kill <PID>`; for a process you start yourself, '
                'keep its PID (`$!`).')


def config_path():
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(os.environ.get('HOST_GUARD_CONFIG') or Path(base) / 'host-guard/config.json')


def load_config():
    """Extra scan roots, the core limit and the test memory limit; a bad or missing file falls back to defaults."""
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
    memory = data.get('test_memory_limit')
    if not isinstance(memory, str) or not re.fullmatch(r'\d+[KMGT]?', memory):
        memory = DEFAULT_TEST_MEMORY
    return {'roots': {r.rstrip('/') or '/' for r in (*DEFAULT_ROOTS, *extra)}, 'cores': cores,
            'test_memory': memory}


def code_only(text):
    """Shell text with heredoc bodies and quoted data blanked; `sh -c '...'` kept."""
    text = HEREDOC.sub('', text)
    return QUOTED.sub(lambda m: m.group(0) if m.group(1) else '""', text)


def substitution(body):
    """'a backtick' or '$(' for the first expansion the shell runs in a heredoc body, else None."""
    i = 0
    while i < len(body):
        if body[i] == '\\':
            i += 2
            continue
        if body[i] == '`':
            return 'a backtick'
        if body.startswith('$(', i):
            return '$('
        i += 1
    return None


def protected_dirs():
    """Folders of agent conversation records and state: never deleted as a whole."""
    home = Path.home()
    claude = Path(os.environ.get('CLAUDE_CONFIG_DIR') or home / '.claude')
    codex = Path(os.environ.get('CODEX_HOME') or home / '.codex')
    state = Path(os.environ.get('XDG_STATE_HOME') or home / '.local/state')
    return {os.path.normpath(p) for p in (claude, claude / 'projects', codex, codex / 'sessions',
                                          codex / 'archived_sessions', home / '.hcom',
                                          state / 'lat')}


def blank_data(text):
    """text with heredoc bodies and quoted data turned to spaces, same length and lines; the
    script after `-c` is kept, since it runs."""
    def spaces(match):
        return re.sub(r'[^\n]', ' ', match.group(0))
    text = HEREDOC.sub(spaces, text)
    return QUOTED.sub(lambda m: m.group(0) if m.group(1) else spaces(m), text)


def scan_word(word):
    """Yield (index, char, stack) for each char of a shell word: stack is the tuple of quotes
    and substitutions ("'", '"', '$(' or a backtick) the char sits in, innermost last. An
    escaped char is skipped."""
    stack, i = [], 0
    while i < len(word):
        char, top = word[i], stack[-1] if stack else None
        yield i, char, tuple(stack)
        if top == "'":
            if char == "'":
                stack.pop()
        elif char == '\\':
            i += 1
        elif char == top and char in '`"':
            stack.pop()
        elif word.startswith('$(', i):
            stack.append('$(')  # the ( comes next, already inside the substitution
        elif char == ')' and top == '$(':
            stack.pop()
        elif char in '`"' or char == "'" and top != '"':
            stack.append(char)
        i += 1


def in_substitution(stack):
    return '$(' in stack or '`' in stack


def command_words(text, start):
    """The raw words of the shell command starting at start, up to ; & | ) or a newline."""
    words, begin = [], None
    for i, char, stack in scan_word(text[start:] + '\n'):
        if not stack and (char.isspace() or char in ';&|)'):
            if begin is not None:
                words.append(text[start + begin:start + i])
                begin = None
            if char != ' ' and char != '\t':
                break
        elif begin is None:
            begin = i
    else:
        if begin is not None:  # an unclosed quote: the rest is one word (a `-c "..."` script)
            words.append(text[start + begin:].rstrip())
    return words


def shell_chars(word):
    """[(index, char)] of the word as the shell reads it, quotes removed. Substitutions stay as
    written; a $, backtick or ~ that quotes keep literal becomes its LITERAL placeholder."""
    out = []
    for i, char, stack in scan_word(word):
        if in_substitution(stack):
            out.append((i, char))
        elif stack[-1:] == ("'",):
            if char != "'":
                out.append((i, LITERAL.get(char, char)))
        elif char == '"' or char == "'" and not stack:
            continue
        elif stack and char == '~':
            out.append((i, LITERAL['~']))
        else:
            out.append((i, char))
    return out


def word_text(word):
    return ''.join(char for _, char in shell_chars(word))


def last_component(word):
    """(parent, last) of the shell text of a word, split on its last slash outside a
    substitution, trailing slashes ignored; parent is empty when there is no such slash."""
    chars = shell_chars(word)
    cut = None
    for i, char, stack in scan_word(word):
        if char == '/' and not in_substitution(stack) and word[i + 1:].strip("/'\""):
            cut = i
    if cut is None:
        return '', ''.join(char for _, char in chars).rstrip('/')
    parent = ''.join(char for i, char in chars if i < cut)
    last = ''.join(char for i, char in chars if i > cut)
    return parent or '/', last.rstrip('/')


def resolve_path(text, cwd):
    """The path a shell word names, or None when it holds a substitution the hook cannot
    know. ~ and the variables of the folders the rules protect are expanded."""
    path = text
    for name, default in (('CLAUDE_CONFIG_DIR', None), ('CODEX_HOME', None),
                          ('XDG_STATE_HOME', None), ('VM_HOME', None),
                          ('HOME', str(Path.home()))):
        value = os.environ.get(name) or default
        if value:
            path = re.sub(r'\$\{?' + name + r'\}?(?![\w])', lambda _: value, path)
    path = str(Path.home()) + path[1:] if path == '~' or path.startswith('~/') else path
    if '$' in path or '`' in path:
        return None
    for char, placeholder in LITERAL.items():
        path = path.replace(placeholder, char)
    return os.path.normpath(os.path.join(str(cwd), path))


def cd_target(words):
    """The folder word of a `cd` command's words; ~ when it names none."""
    target = [w for w in words[1:] if w not in ('--', '-L', '-P', '-e', '-@')]
    return target[0] if target else '~'


def operators(code):
    """The separators in code, without a newline that only continues a line after && || |."""
    found, end = [], 0
    for match in re.finditer(SEPARATORS, code):
        sep = match.group(0)
        waiting = (found[-1:] in (['&&'], ['||'], ['|'])
                   and not code[end:match.start()].strip(' \t\\'))
        if not (sep == '\n' and waiting):
            found.append(sep)
        end = match.end()
    return found


def places(command, code, before, cwd):
    """Every folder a command may run in at offset before. A cd that starts a statement and
    is joined to the delete only by && is sure to apply; any other cd (skipped after ||, in
    a pipeline or a subshell, followed by ;) may or may not."""
    found = {cwd}
    for match in CD.finditer(code):
        if match.start() >= before:
            break
        words = command_words(command, match.end())
        if not words:
            continue
        moved = [resolve_path(word_text(words[0]), here) for here in found]
        ahead = operators(code[:match.end() - 2])
        between = operators(code[match.end():before])
        sure = (all(moved) and ahead[-1:] != ['||'] and ahead[-1:] != ['|']
                and between and all(sep == '&&' for sep in between))
        found = set(moved) if sure else found | {p for p in moved if p}
    return found


def risky_delete(command, cwd):
    """(message, fields) for a delete that can wipe a folder by mistake, or None."""
    code = blank_data(command)
    protected = protected_dirs()
    projects = os.path.join(os.path.normpath(Path(os.environ.get('CLAUDE_CONFIG_DIR')
                                                  or Path.home() / '.claude')), 'projects')
    for match in DELETE.finditer(code):
        tool = os.path.basename(' '.join(match.group('tool').split()))
        folders = places(command, code, match.start('tool'), cwd)
        for word in command_words(command, match.end()):
            text = word_text(word)
            shown = text.translate({ord(v): k for k, v in LITERAL.items()})
            if text.startswith('-'):
                continue
            parent, last = last_component(word)
            if parent and BARE_SUBSTITUTION.fullmatch(last):
                return EMPTY_MESSAGE, {'tool': tool, 'word': shown}
            for folder in folders:
                path = resolve_path(text, folder)
                if path and (path in protected or os.path.dirname(path) == projects
                             or any(p.startswith(path.rstrip('/') + '/') for p in protected)):
                    return PROTECTED_MESSAGE, {'tool': tool, 'word': shown, 'path': path}
    return None


def heredoc_word(word):
    """(delimiter, quoted) for the word after `<<`."""
    name = re.sub(r'\\(.)|\'([^\']*)\'|"((?:\\.|[^"\\])*)"',
                  lambda m: m.group(1) or m.group(2) or m.group(3) or '', word)
    return name, any(c in word for c in '\'"\\')


def _quote_states(line):
    """Yield (index, char, quote) with the quote in force before each character; a backslash
    outside single quotes escapes the next character."""
    quote, skip = None, False
    for i, char in enumerate(line):
        if skip:
            skip = False
        elif quote == "'":
            yield i, char, quote
            quote = None if char == "'" else quote
            continue
        elif char == '\\':
            yield i, char, quote
            skip = True
            continue
        else:
            yield i, char, quote
            if quote:
                quote = None if char == quote else quote
            elif char in '\'"':
                quote = char
            continue
        yield i, char, quote


def shell_text_end(line):
    """Where the live shell text of a line ends: the start of an unquoted `# comment`."""
    for i, char, quote in _quote_states(line):
        if char == '#' and not quote and (i == 0 or line[i - 1] in ' \t'):
            return i
    return len(line)


def quoted_at(line, index):
    """True when index sits inside a quoted string of the line."""
    return any(i == index and quote for i, _, quote in _quote_states(line))


def heredoc_end(text, opener, position):
    """The match of the delimiter line closing a heredoc whose body starts at position, or None."""
    strip = r'\t*' if opener.group(1) else ''
    name = heredoc_word(opener.group(2))[0]
    return re.compile(r'^' + strip + re.escape(name) + r'$', re.M).search(text, position)


def expanding_heredoc(command):
    """(delimiter, what) for the first unquoted heredoc whose body substitutes a command.

    Walks the heredocs in order and skips each body, so text inside a quoted heredoc that
    looks like another heredoc is not read as one. Several openers on one line take their
    bodies one after the other.
    """
    position = 0
    while True:
        match = HEREDOC_START.search(command, position)
        if not match:
            return None
        line_end = command.find('\n', match.end())
        if line_end < 0:
            return None
        header = command[match.end():line_end]
        header = header[:shell_text_end(header)]
        openers = [match, *(m for m in HEREDOC_START.finditer(header)
                            if not quoted_at(header, m.start()))]
        position = line_end + 1
        for opener in openers:
            name, quoted = heredoc_word(opener.group(2))
            end = heredoc_end(command, opener, position)
            if not quoted:
                found = substitution(command[position:end.start() if end else len(command)])
                if found:
                    return name, found
            if not end:
                return None
            position = end.end() + 1


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


def memory_limit_usable():
    """systemd-run --user needs the binary and a running user manager; elsewhere the
    suggested command would fail, so the rule stays out of the way."""
    runtime = os.environ.get('XDG_RUNTIME_DIR') or f'/run/user/{os.getuid()}'
    return bool(shutil.which('systemd-run')) and Path(runtime, 'systemd/private').exists()


def shell_code(text):
    """Like code_only, but a quoted word after -c stays only as a shell's script: in
    `grep -c 'pytest' file` it is data."""
    def keep(match):
        script = match.group(1) and SHELL_BEFORE.search(match.string[:match.start()])
        return match.group(0) if script else '""'
    return QUOTED.sub(keep, HEREDOC.sub('', text))


def unlimited_tests(command):
    """True when a test runner starts without both a memory limit and a timeout."""
    for match in TEST_RUN.finditer(shell_code(command)):
        prefix = match.group('prefix')
        if not MEMORY_CAP.search(prefix) or not TIME_CAP.search(prefix):
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


def lat_repo(path):
    """The LoopAgentTeams checkout that holds path (it has the install script), or None."""
    for folder in (path, *path.parents):
        if (folder / INSTALL_SCRIPT).is_file() and (folder / 'skills').is_dir():
            return folder
    return None


def repo_install(command, cwd):
    """The LoopAgentTeams checkout a `bunx skills add` in command installs from, or None.

    The command is split into words and operators with shell quoting, so quoted text is
    data (`echo "x; bunx skills add ..."`); a `sh -c` body is read as a command of its own.
    `cd DIR` moves the directory relative sources are read from, within its `( )` or
    `sh -c` scope. A source is a word that looks like a path (~, /, ., $VAR or a slash);
    skill names and options are not."""
    tokens = shell_tokens(command)
    base, scopes, words, in_backticks = Path(cwd), [], [], False
    for token in [*tokens, (';',)]:
        if isinstance(token, str):
            words.append(token)
            continue
        repo, base = command_install(words, base)
        if repo:
            return repo
        words = []
        opening = token == ('(',) or token == ('`',) and not in_backticks
        if token == ('`',):
            in_backticks = not in_backticks
        if opening:
            scopes.append(base)
        elif token in ((')',), ('`',)) and scopes:
            base = scopes.pop()
    return None


def double_quote_end(text, start):
    """Where the double quote opened before start closes. A heredoc inside `$(...)` is skipped
    whole, so quotes in its body do not close it (git commit -m "$(cat <<'EOF' ...)."""
    i, substituting = start, False
    while i < len(text) and text[i] != '"':
        if text[i] == '\\':
            i += 2
            continue
        substituting = substituting or text.startswith('$(', i)
        opener = HEREDOC_START.match(text, i) if substituting else None
        line_end = text.find('\n', opener.end()) if opener else -1
        end = heredoc_end(text, opener, line_end + 1) if line_end >= 0 else None
        i = end.end() if end else i + 1
    return i


def shell_tokens(text):
    """Words (quotes removed) and operators (1-tuples) of shell text. An operator is only
    an unquoted, unescaped character of OPERATORS; `#` starting a word comments out the
    rest of the line. An unclosed quote runs to the end of the text. Heredoc bodies are
    dropped, up to their delimiter line or the end of the text; `<<` within `((...))` is a
    shift. The & of `>&` stays in its word."""
    tokens, word, quoted, i, bodies, arithmetic = [], [], False, 0, [], 0

    def end_word():
        nonlocal word, quoted
        if word or quoted:
            tokens.append(''.join(word))
        word, quoted = [], False

    while i < len(text):
        char = text[i]
        if char == '\\' and i + 1 < len(text):
            if text[i + 1] != '\n':  # a line continuation joins the lines
                word.append(text[i + 1])
            i += 2
            continue
        if char in '\'"':
            close = double_quote_end(text, i + 1) if char == '"' else text.find("'", i + 1)
            close = len(text) if close < 0 else close
            word.append(text[i + 1:close])
            quoted, i = True, close + 1
            continue
        if char == '#' and not word and not quoted:
            i = text.find('\n', i)
            i = len(text) if i < 0 else i
            continue
        if char == '(' and (arithmetic or text.startswith('((', i)):
            arithmetic += 1
        elif char == ')' and arithmetic:
            arithmetic -= 1
        opener = HEREDOC_START.match(text, i) if char == '<' and not arithmetic else None
        if opener:
            end_word()
            bodies.append(opener)
            i = opener.end()
            continue
        if char == '&' and word[-1:] in (['>'], ['<']):
            word.append(char)
        elif char in OPERATORS:
            end_word()
            tokens.append((char,))
            if char == '\n':
                for body in bodies:
                    end = heredoc_end(text, body, i + 1)
                    i = end.end() if end else len(text)
                bodies = []
        elif char in ' \t\r':
            end_word()
        else:
            word.append(char)
        i += 1
    end_word()
    return tokens


def after_prefixes(words):
    """The words of a simple command past shell keywords, assignments, redirections and
    PREFIXES with their options and bare numbers; empty for `command -v NAME`, which only looks NAME up."""
    prefix = None
    while words:
        word, name = words[0], os.path.basename(words[0])
        redirection = REDIRECTION.fullmatch(word)
        if redirection:
            words = words[1:] if redirection.group('target') else words[2:]
        elif name in PREFIXES:
            prefix, words = name, words[1:]
        elif (ASSIGNMENT.match(word) or word in SHELL_KEYWORDS
              or prefix and WRAPPER_NUMBER.fullmatch(word)):
            words = words[1:]
        elif prefix and word.startswith('-'):
            if prefix == 'command' and word in ('-v', '-V'):
                return []
            words = words[2:] if word in VALUE_OPTIONS.get(prefix, ()) else words[1:]
        else:
            break
    return words


def shell_script(words):
    """The script of a shell command's -c option, or None."""
    flag = next((i for i, w in enumerate(words[1:], 1)
                 if w.startswith('-') and not w.startswith('--') and 'c' in w), None)
    return words[flag + 1] if flag is not None and flag + 1 < len(words) else None


def command_install(words, base):
    """(checkout the simple command installs from or None, directory after it)."""
    def where(word):
        return base / os.path.expanduser(os.path.expandvars(word))

    words = after_prefixes(words)
    name = os.path.basename(words[0]) if words else ''
    if name == 'cd':
        return None, where(cd_target(words))
    if name in SHELLS:
        body = shell_script(words)
        return (repo_install(body, base) if body else None), base
    if name in ('bunx', 'npx'):
        rest = words[1:]
    elif (name, words[1:2]) in (('bun', ['x']), ('pnpm', ['dlx'])):
        rest = words[2:]
    else:
        return None, base
    while rest and rest[0].startswith('-'):
        rest = rest[1:]
    if len(rest) < 2 or not re.fullmatch(r'skills(@\S+)?', rest[0]) \
            or rest[1] not in ('add', 'a', 'install', 'i'):
        return None, base
    for word in rest[2:]:
        if word.startswith('-') or not (word.startswith(('~', '.', '$')) or '/' in word):
            continue
        source = where(word).resolve()
        repo = source.is_dir() and lat_repo(source)
        if repo:
            return repo, base
    return None, base


def pkill_full(args):
    """True when pkill arguments ask to match the full command line."""
    for word in args:
        if word == '--':
            return False
        if word.startswith('--'):
            if '--full'.startswith(word):
                return True
        elif word.startswith('-'):
            for char in word[1:]:
                if char == 'f':
                    return True
                if char in PKILL_VALUE_FLAGS:
                    break
    return False


def pattern_kill(command):
    """'pkill -f' or 'killall' when a command of the shell text runs it, else None. The text is
    read with shell quoting, so quoted text and heredoc bodies are data; a `sh -c` script is
    read as a command of its own."""
    words = []
    for token in [*shell_tokens(command), (';',)]:
        if isinstance(token, str):
            words.append(token)
            continue
        words = after_prefixes(words)
        name = os.path.basename(words[0]) if words else ''
        if name in SHELLS:
            found = pattern_kill(shell_script(words) or '')
            if found:
                return found
        elif name == 'killall':
            return name
        elif name == 'pkill' and pkill_full(words[1:]):
            return 'pkill -f'
        words = []
    return None


# ---------------------------------------------------------------- host VMs (vm skill)

VM_SCRIPT = SCRIPT.parents[2] / 'vm/scripts/vm.py'
VM_COMMAND = shlex.join(['uv', 'run', '--no-project', 'python', str(VM_SCRIPT)])
VM_STATE_FILES = ('machines.json', 'leases.json', 'watch-state.json', 'vm.log', '.lock')
OLD_VM_FOLDER = 'vm-busi'
DOCKER_POWER = {'start', 'stop', 'restart', 'kill', 'rm', 'pause', 'unpause'}
COMPOSE_STARTS = {'up', 'create', 'run', 'start', 'restart'}
COMPOSE_ACTIONS = DOCKER_POWER | COMPOSE_STARTS | {'down'}
DOCKER_VALUE_OPTIONS = {'-H', '--host', '-c', '--context', '--config', '-l', '--log-level',
                        '--tlscacert', '--tlscert', '--tlskey'}
COMPOSE_VALUE_OPTIONS = {'-f', '--file', '-p', '--project-name', '--project-directory',
                         '--env-file', '--profile', '--ansi', '--progress', '--parallel'}
COMPOSE_FILES = ('compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml')
DESTROY_TOOLS = {'rm', 'rmdir', 'unlink', 'shred', 'trash-put', 'trash'}
WRITE_TOOLS = {'tee', 'truncate', 'touch', 'sponge'}
IN_PLACE_TOOLS = {'sed', 'perl'}
COPY_TOOLS = {'cp', 'install', 'ln', 'rsync', 'scp'}
SYSTEMCTL_STARTS = {'start', 'enable', 'restart', 'reenable', 'link', 'try-restart',
                    'reload-or-restart', 'try-reload-or-restart'}
# The one sanctioned VM service: the vm watcher.
VM_WATCH_UNIT = 'vm-watch'
UNIT_SUFFIXES = ('.service', '.timer')
SYSTEMCTL_VALUE_OPTIONS = {'-H', '--host', '-M', '--machine', '-p', '--property', '-t', '--type',
                           '--state', '-n', '--lines', '-o', '--output', '--root', '-s',
                           '--signal', '--kill-whom', '--job-mode', '--what', '--timestamp'}
SEARCH_TOOLS = {'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack'}
INTERPRETERS = ('python', 'uv')
OUT_REDIRECT = re.compile(r'(?:\d*|&)>{1,2}\|?(?P<target>.*)')
GLOB_CHARS = '*?['
FILE_TOOLS = {'Write': 'file_path', 'Edit': 'file_path', 'NotebookEdit': 'notebook_path'}

VM_USAGE = ('`vm` is `{vm}`: `vm list` shows who has each machine, `vm borrow <machine> '
            '"<purpose>" [--hours N]` borrows and starts one, `vm extend <machine>` keeps it '
            'longer, `vm start <machine>` starts one you already borrowed, `vm return <machine>` '
            'stops it and gives it back.')
VM_POWER_MESSAGE = ('Blocked: {container} is the host VM `{machine}`. Starting or stopping it '
                    'directly goes around its borrow record, so another agent\'s machine can go '
                    'down, or stay on with nobody owning it. Use the vm command instead. ' + VM_USAGE)
VM_STATE_MESSAGE = ('Blocked: {path} is vm state (machine list, leases, watcher state, log or '
                    'lock); only the vm command writes it, inside its lock. Change a lease with '
                    'the vm command (`vm extend`, `vm return`, `vm add` for a new machine) and read '
                    'the files or `vm list` to look. ' + VM_USAGE)
VM_SCHEDULE_MESSAGE = ('Blocked: this sets up a {kind} that turns a host VM on or off. The vm '
                       'watcher already stops a machine when its lease ends, and it is the only '
                       'scheduler for VMs. Borrow for the time you need (`vm borrow <machine> '
                       '"<purpose>" --hours N`, at most 8), `vm extend` to keep it, and `vm return` '
                       'when done. ' + VM_USAGE)
VM_RUN_MESSAGE = ('Blocked: {what} with /dev/kvm starts a VM at once, which skips the memory '
                  'check and the borrow record. For a new machine: `vm add <machine> --container '
                  '<name> ...` (you become its borrower), then `docker create` (not run) with the '
                  'registered name and mounts only under {root}/<machine>/, then `vm start '
                  '<machine>`. ' + VM_USAGE)
VM_CREATE_MESSAGE = ('Blocked: docker create with /dev/kvm makes a VM; {why} Only the current '
                     'borrower of a listed machine may create its container, with the registered '
                     'name and mounts only under {root}/<machine>/. Register a new machine with '
                     '`vm add <machine> --container <name> ...` first; then `vm start <machine>`. '
                     + VM_USAGE)
VM_HUMAN_MESSAGE = ('Blocked: `{flag}` is for the user only, in their own terminal. Agents borrow '
                    'as themselves (their HCOM name). If you need a machine someone else holds, '
                    'ask that borrower over HCOM or ask the user. ' + VM_USAGE)
VM_OLD_MESSAGE = ('Blocked: {path} is in the old VM folder ~/{old}, which is retired; VM data now '
                  'lives in {root}. {hint}')
VM_OLD_HINTS = (
    (('vmctl',), 'vmctl is replaced by the vm command: `vm borrow <machine> "<purpose>"` to start, '
                 '`vm return <machine>` to stop. ' + VM_USAGE),
    (('deadline', 'control.lock'), 'The deadline file is replaced by leases: `vm extend <machine>` '
                                   'keeps a machine longer. ' + VM_USAGE),
    (('guard.py', 'guard.log'), 'guard.py is replaced by the vm watcher (one systemd service); '
                                'its log is {root}/vm.log. ' + VM_USAGE),
    (('ssh-config',), 'Use `ssh -F {root}/ssh/config <ssh host>`; `vm status <machine>` shows the '
                      'ssh host and ports.'),
    (('creds', 'win-key', 'mac-key'), 'ssh keys now live in {root}/ssh/; connect with '
                                      '`ssh -F {root}/ssh/config <ssh host>`.'),
    (('browser',), 'Browser data for VM screens is in {root}/browser{rest}.'),
)
VM_OLD_MOVED = 'The same data is under {root}{rest} after the move. ' + VM_USAGE
VM_OLD_FALLBACK = 'Each machine has its folder {root}/<machine>/. ' + VM_USAGE


class VmRegistry:
    """The vm data root, the machine list and the leases as this hook sees them. Missing or
    unreadable files read as empty, so only VM writes and creates are blocked then."""

    def __init__(self):
        root = os.environ.get('VM_HOME') or str(Path.home() / 'vm')
        self.root = os.path.normpath(os.path.join(os.getcwd(), os.path.expanduser(root)))
        self.old = os.path.join(str(Path.home()), OLD_VM_FOLDER)
        self.machines = self._read('machines.json', 'machines')
        self.leases = self._read('leases.json', 'leases')
        self.containers = {m['container']: name for name, m in self.machines.items()
                           if isinstance(m.get('container'), str)}
        self.states = {os.path.join(self.root, f) for f in VM_STATE_FILES}
        self.destroy = self.states | {self.root, *map(str, Path(self.root).parents)}
        words = '|'.join(re.escape(c) for c in self.containers)
        self.terms = re.compile(
            r'/dev/kvm|vm-busi|busi-vm|(?<![\w.-])(?:vmctl|guard\.py)(?![\w.-])'
            r'|(?<![\w.-])vm\.py(?![\w.-])(?!\s+(?:list|status)\b)'
            r'|~/vm(?![\w.-])|' + re.escape(self.root) + r'(?![\w.-])'
            + (r'|(?<![\w.-])(?:' + words + r')(?![\w.-])' if words else ''))

    def _read(self, name, key):
        try:
            data = json.loads(Path(self.root, name).read_text())
        except (OSError, ValueError):
            return {}
        value = data.get(key) if isinstance(data, dict) else None
        return {k: v for k, v in value.items() if isinstance(v, dict)} \
            if isinstance(value, dict) else {}


def within(path, folder):
    """True when path is folder or inside it."""
    return path == folder or path.startswith(folder.rstrip('/') + '/')


def path_hits(path, targets):
    """The targets a path names; * ? [ match within one path component, as the shell's do."""
    if path is None:
        return []
    forms = {path, os.path.realpath(path)}
    if not any(c in path for c in GLOB_CHARS):
        return [t for t in targets if t in forms or os.path.realpath(t) in forms]
    parts = path.split('/')
    return [t for t in targets if len(t.split('/')) == len(parts)
            and all(fnmatch.fnmatchcase(a, b) for a, b in zip(t.split('/'), parts))]


def substitutions(word):
    """The command texts of $(...) and backtick substitutions in a word."""
    found, i = [], 0
    while i < len(word):
        if word.startswith('$(', i) and not word.startswith('$((', i):
            depth, j = 1, i + 2
            while j < len(word) and depth:
                depth += {'(': 1, ')': -1}.get(word[j], 0)
                j += 1
            found.append(word[i + 2:j - 1] if not depth else word[i + 2:])
            i = j
        elif word[i] == '`':
            j = word.find('`', i + 1)
            j = len(word) if j < 0 else j
            found.append(word[i + 1:j])
            i = j + 1
        else:
            i += 1
    return found


def vm_statements(command, cwd, depth=0):
    """Yield (words, folder) for each simple command of shell text, including those in
    `sh -c` scripts and in $(...) or backtick substitutions. folder is where a relative path
    points: a cd moves it for the rest of its ( ) or backtick scope."""
    base, scopes, words, in_backticks = Path(cwd), [], [], False
    for token in [*shell_tokens(command), (';',)]:
        if isinstance(token, str):
            words.append(token)
            continue
        if words:
            yield words, base
            rest = after_prefixes(words)
            name = os.path.basename(rest[0]) if rest else ''
            if name == 'cd':
                moved = resolve_path(cd_target(rest), base)
                base = Path(moved) if moved else base
            if depth < 4:
                script = shell_script(rest) if name in SHELLS else None
                if script:
                    yield from vm_statements(script, base, depth + 1)
                for word in words:
                    for inner in substitutions(word):
                        yield from vm_statements(inner, base, depth + 1)
        words = []
        opening = token == ('(',) or token == ('`',) and not in_backticks
        if token == ('`',):
            in_backticks = not in_backticks
        if opening:
            scopes.append(base)
        elif token in ((')',), ('`',)) and scopes:
            base = scopes.pop()


def split_redirections(words):
    """(words without redirections, the targets of output redirections)."""
    kept, targets, i = [], [], 0
    while i < len(words):
        word = words[i]
        out = OUT_REDIRECT.fullmatch(word)
        if out and not out.group('target').startswith('&'):
            target = out.group('target')
            if not target and i + 1 < len(words):
                i += 1
                target = words[i]
            targets.append(target)
        elif (inward := REDIRECTION.fullmatch(word)):  # an input: its target is only read
            i += 0 if inward.group('target') else 1
        else:
            kept.append(word)
        i += 1
    return kept, targets


def file_text(path, limit=SCRIPT_MAX_BYTES):
    try:
        with open(path, errors='replace') as handle:
            return handle.read(limit)
    except OSError:
        return ''


def unit_dirs():
    home = Path.home()
    config = Path(os.environ.get('XDG_CONFIG_HOME') or home / '.config')
    return [str(p) for p in (config / 'systemd/user', home / '.local/share/systemd/user',
                             Path('/etc/systemd/user'), Path('/etc/systemd/system'))]


def schedule_places():
    return [*unit_dirs(), '/etc/cron.d', '/etc/crontab', '/var/spool/cron']


def vm_unit(unit, place):
    """True when a systemd unit powers a VM: by the unit files behind it (a timer with its
    service), or by its name when no unit file is found. The vm watcher is the exception."""
    name = os.path.basename(unit)
    stem = name[:-len(name.rsplit('.', 1)[-1]) - 1] if name.endswith(UNIT_SUFFIXES) else name
    if stem == VM_WATCH_UNIT:
        return False
    files = [unit] if '/' in unit else [os.path.join(d, stem + s) for d in unit_dirs()
                                        for s in UNIT_SUFFIXES]
    texts = [file_text(f) for f in files if os.path.isfile(f)]
    return any(place.terms.search(t) for t in texts) if texts else bool(place.terms.search(name))


def schedule_problem(words, rest, name, command, folder, place):
    """The kind of VM power schedule a simple command sets up, or None."""
    runner = next((i for i, w in enumerate(words) if os.path.basename(w) == 'systemd-run'), None)
    if runner is not None:
        args = words[runner + 1:]
        if '--scope' not in args and place.terms.search(' '.join(args)):
            return 'systemd service or timer'
    if name == 'systemctl':
        args = operands(rest, SYSTEMCTL_VALUE_OPTIONS)
        if args and args[0] in SYSTEMCTL_STARTS and any(vm_unit(u, place) for u in args[1:]):
            return 'systemd service or timer'
    if name in ('at', 'batch'):
        files = [rest[i + 1] for i, w in enumerate(rest[:-1]) if w == '-f']
        texts = [command, *(file_text(p) for p in (resolve_path(f, folder) for f in files) if p)]
        if any(place.terms.search(t) for t in texts):
            return 'job with at'
    if name == 'crontab':
        files = operands(rest, {'-u'})
        if any(w in ('-l', '-r', '-e') for w in rest[1:]) and not files:
            return None
        texts = [command, *(file_text(p) for p in (resolve_path(f, folder) for f in files) if p)]
        if any(place.terms.search(t) for t in texts):
            return 'crontab entry'
    return None


def operands(rest, value_options=()):
    """The words after a command name that are not options or the values of value_options."""
    found, skip = [], False
    for word in rest[1:]:
        if skip:
            skip = False
        elif word.startswith('-'):
            skip = word in value_options
        else:
            found.append(word)
    return found


def written_paths(rest, name, folder):
    """(paths a command may delete or move away, paths it writes) from its words; a path
    the hook cannot resolve is left out."""
    moved, writes = word_paths(rest, name, folder)
    return [p for p in moved if p], [p for p in writes if p]


def word_paths(rest, name, folder):
    """written_paths before unresolved paths are dropped."""
    args = [w for w in rest[1:] if not w.startswith('-')]
    if name == 'gio' and args[:1] == ['trash']:
        return [resolve_path(w, folder) for w in args[1:]], []
    if name in DESTROY_TOOLS:
        return [resolve_path(w, folder) for w in args], []
    if name in WRITE_TOOLS:
        return [], [resolve_path(w, folder) for w in args]
    if name in IN_PLACE_TOOLS and any(
            w == '--in-place' or w.startswith('--in-place=')
            or re.fullmatch(r'-[A-Za-z]*i\S*', w) for w in rest[1:]):
        return [], [resolve_path(w, folder) for w in args]
    if name == 'dd':
        return [], [resolve_path(w[3:], folder) for w in rest[1:] if w.startswith('of=')]
    if name in COPY_TOOLS or name == 'mv':
        target = next((rest[i + 1] for i, w in enumerate(rest[:-1]) if w == '-t'), None)
        target = target or next((w.split('=', 1)[1] for w in rest
                                 if w.startswith('--target-directory=')), None)
        sources = args if target else args[:-1]
        dest = target or (args[-1] if len(args) > 1 else None)
        if dest is None:
            return [], []
        dest = resolve_path(dest, folder)
        writes = [dest] + ([os.path.join(dest, os.path.basename(s.rstrip('/'))) for s in sources]
                           if dest else [])
        moved = [resolve_path(s, folder) for s in sources] if name == 'mv' else []
        return moved, writes
    return [], []


def docker_command(rest):
    """(subcommand, its args) of docker past global options, `docker container X` read as X;
    ('compose', args) for docker compose and docker-compose; (None, []) otherwise."""
    name = os.path.basename(rest[0]) if rest else ''
    if name == 'docker-compose':
        return 'compose', rest[1:]
    if name != 'docker':
        return None, []
    args = rest[1:]
    while args and args[0].startswith('-'):
        args = args[2:] if args[0] in DOCKER_VALUE_OPTIONS else args[1:]
    if args[:1] == ['container']:
        args = args[1:]
    return (args[0], args[1:]) if args else (None, [])


def compose_problem(args, folder, place):
    """(message, fields) for docker compose acting on a VM, or None."""
    files, project, i = [], None, 0
    while i < len(args) and args[i].startswith('-'):
        flag, eq, value = args[i].partition('=')
        if flag in COMPOSE_VALUE_OPTIONS:
            if not eq:
                i += 1
                value = args[i] if i < len(args) else ''
            if flag in ('-f', '--file'):
                files.append(resolve_path(value, folder))
            elif flag == '--project-directory':
                project = resolve_path(value, folder)
        i += 1
    action = args[i] if i < len(args) else ''
    if action not in COMPOSE_ACTIONS:
        return None
    files = [f for f in files if f]
    project = project or (os.path.dirname(files[0]) if files else str(folder))
    files = files or [os.path.join(project, f) for f in COMPOSE_FILES]
    hit = next((w for w in args[i + 1:] if w in place.containers), None)
    if hit:
        return power_message(hit, place)
    if within(project, place.root) or within(project, place.old):
        return VM_POWER_MESSAGE, {'container': f'the compose project in {project}',
                                  'machine': os.path.basename(project)}
    if action in COMPOSE_STARTS and any('/dev/kvm' in file_text(f) for f in files):
        return VM_RUN_MESSAGE, {'what': 'docker compose ' + action}
    return None


def create_problem(args, folder, place):
    """The reason a docker create with /dev/kvm is not the sanctioned new-machine path, or None."""
    name, mounts, i = None, [], 0
    while i < len(args):
        word = args[i]
        flag, eq, value = word.partition('=')
        if flag in ('--name', '-v', '--volume', '--mount') and not eq:
            i += 1
            value = args[i] if i < len(args) else ''
        elif word.startswith('-v') and not word.startswith('--') and len(word) > 2:
            flag, value = '-v', word[2:]
        if flag == '--name':
            name = value
        elif flag in ('-v', '--volume') and ':' in value:
            mounts.append(value.split(':', 1)[0])
        elif flag == '--mount':
            fields = dict(part.partition('=')[::2] for part in value.split(','))
            source = fields.get('source') or fields.get('src')
            if fields.get('type', 'volume') != 'tmpfs' and source:
                mounts.append(source)
        i += 1
    machine = place.containers.get(name)
    if machine is None:
        return f'container name {name or "(none given)"} is not on the machine list.'
    caller = os.environ.get('HCOM_INSTANCE_NAME', '').strip()
    if not caller:
        return ('there is no HCOM name (HCOM_INSTANCE_NAME) to check you against the borrower; '
                'run it from an agent started under HCOM.')
    lease = place.leases.get(machine)
    if not lease:
        return f'nobody has borrowed {machine}.'
    if lease.get('borrower') != caller or lease.get('human'):
        return f'{machine} is borrowed by {lease.get("borrower")}, not by you ({caller}).'
    allowed = os.path.join(place.root, str(place.machines[machine].get('folder') or machine))
    for source in mounts:
        if source.startswith('/dev/'):
            continue
        path = resolve_path(source, folder) if source.startswith(('/', '~', '.', '$')) else None
        if not path or not within(path, allowed):
            return f'it mounts {source}; it may use mounts only under {allowed}/.'
    return None


def human_flag(rest):
    """The user-only flag or action a vm command uses, or None. The vm command is `vm`, or
    vm.py run directly or by python or uv."""
    first = os.path.basename(rest[0]) if rest else ''
    start = 0 if first in ('vm', 'vm.py') else next(
        (i for i, w in enumerate(rest) if os.path.basename(w) == 'vm.py'), None) \
        if first.startswith(INTERPRETERS) else None
    if start is None:
        return None
    args = rest[start + 1:]
    for word in args:
        flag = word.split('=', 1)[0]
        if len(flag) >= 4 and '--human'.startswith(flag):  # argparse takes --hu for --human
            return '--human'
    action = operands(['vm', *args], {'--root'})
    return 'vm reclaim' if action[:1] == ['reclaim'] else None


def search_patterns(rest):
    """The pattern words of a grep-like search: the -e values, else the first operand."""
    if not rest or os.path.basename(rest[0]) not in SEARCH_TOOLS:
        return []
    given = [rest[i + 1] for i, w in enumerate(rest[:-1]) if w in ('-e', '--regexp')]
    return given or operands(rest, {'-e', '--regexp', '-f', '--file', '-g', '--glob', '-t',
                                     '--type', '-A', '-B', '-C', '-m', '--max-count'})[:1]


def old_folder_problem(words, folder, place, skip=()):
    """(message, fields) for a word naming a path in the old ~/vm-busi folder, or None.
    Words in skip are text (a search pattern), not paths."""
    for word in words:
        if any(c.isspace() for c in word) or word in skip:
            continue  # text, such as a commit message
        out = OUT_REDIRECT.fullmatch(word)
        candidates = [word, out.group('target')] if out else [word]
        if '=' in word:
            candidates.append(word.split('=', 1)[1])
        if word.startswith('-') and len(word) > 2 and not word.startswith('--'):
            candidates.append(word[2:])
        for text in candidates:
            path_like = '/' in text or text.startswith(('~', '.', '$'))
            if not path_like and not within(str(folder), place.old):
                continue
            path = resolve_path(text, folder)
            if path and within(path, place.old) and (path_like or os.path.lexists(path)):
                return VM_OLD_MESSAGE, old_folder_fields(path, place)
    return None


def old_folder_fields(path, place):
    rel = os.path.relpath(path, place.old)
    first = '' if rel == '.' else rel.split('/')[0]
    rest = '' if rel == '.' else '/' + rel
    hint = next((h for names, h in VM_OLD_HINTS if first in names),
                VM_OLD_MOVED if first else VM_OLD_FALLBACK)
    if first == 'browser':
        rest = rest[len('/browser'):]
    return {'path': path, 'old': OLD_VM_FOLDER,
            'hint': hint.format(root=place.root, rest=rest, vm=VM_COMMAND)}


def power_message(container, place):
    """The block for a docker power action on a listed VM container."""
    return VM_POWER_MESSAGE, {'container': container, 'machine': place.containers[container]}


def find_problem(rest, folder, place):
    """The vm state file a find deletes or changes, by its start folders and its -name and
    -path tests, or None."""
    changing = '-delete' in rest or any(
        w in ('-exec', '-execdir', '-ok') and os.path.basename(n) in DESTROY_TOOLS | WRITE_TOOLS
        | IN_PLACE_TOOLS | {'mv'} for w, n in zip(rest, rest[1:]))
    if not changing:
        return None
    starts = [p for p in (resolve_path(w, folder) for w in rest[1:]
                          if not w.startswith(('-', '(', '!', ')'))) if p]
    starts = starts[:1] or [str(folder)]
    names = [n for w, n in zip(rest, rest[1:]) if w in ('-name', '-iname')]
    paths = [n for w, n in zip(rest, rest[1:]) if w in ('-path', '-wholename')]
    return next((state for state in sorted(place.states) if within(state, starts[0])
                 and all(fnmatch.fnmatchcase(os.path.basename(state), n) for n in names)
                 and all(fnmatch.fnmatchcase(state, p) for p in paths)), None)


def vm_statement_problem(words, folder, command, place):
    """(message, fields) for one simple command that goes around vm borrowing, or None."""
    plain, targets = split_redirections(words)
    rest = after_prefixes(plain)
    name = os.path.basename(rest[0]) if rest else ''
    found = old_folder_problem(words, folder, place, search_patterns(rest))
    if found:
        return found
    if name == 'vmctl':
        return VM_OLD_MESSAGE, {**old_folder_fields(os.path.join(place.old, 'vmctl'), place),
                                'path': 'vmctl'}
    flag = human_flag(rest)
    if flag:
        return VM_HUMAN_MESSAGE, {'flag': flag}
    state = find_problem(rest, folder, place) if name == 'find' else None
    if state:
        return VM_STATE_MESSAGE, {'path': state}
    moved, writes = written_paths(rest, name, folder)
    writes = [p for p in (*writes, *(resolve_path(t, folder) for t in targets)) if p]
    for path in moved:
        hits = path_hits(path, place.destroy)
        if hits:
            return VM_STATE_MESSAGE, {'path': hits[0]}
    for path in writes:
        hits = path_hits(path, place.states)
        if hits:
            return VM_STATE_MESSAGE, {'path': hits[0]}
    kind = schedule_problem(plain, rest, name, command, folder, place)
    if kind is None and any(any(within(p, d) for d in schedule_places())
                            and os.path.basename(p).split('.')[0] != VM_WATCH_UNIT
                            for p in writes):
        sources = [resolve_path(w, folder) for w in rest[1:-1] if not w.startswith('-')]
        if any(place.terms.search(t) for t in [command, *(file_text(p) for p in sources if p)]):
            kind = 'systemd unit or cron entry'
    if kind:
        return VM_SCHEDULE_MESSAGE, {'kind': kind}
    sub, args = docker_command(rest)
    if sub == 'compose':
        return compose_problem(args, folder, place)
    hit = next((w for w in args if w in place.containers), None)
    restart = next((w.split('=', 1)[1] if '=' in w else args[i + 1] if i + 1 < len(args) else ''
                    for i, w in enumerate(args) if w.split('=', 1)[0] == '--restart'), 'no')
    if hit and (sub in DOCKER_POWER or sub == 'update' and restart != 'no'):
        return power_message(hit, place)
    if sub in ('run', 'create') and any('/dev/kvm' in w for w in args):
        if sub == 'run':
            return VM_RUN_MESSAGE, {'what': 'docker run'}
        why = create_problem(args, folder, place)
        if why:
            return VM_CREATE_MESSAGE, {'why': why}
    return None


def vm_problem(command, cwd):
    """The block message for a shell command that goes around vm borrowing, or None."""
    place = VmRegistry()
    for words, folder in vm_statements(command, cwd):
        found = vm_statement_problem(words, folder, command, place)
        if found:
            message, fields = found
            return message.format(vm=VM_COMMAND, root=place.root, **fields)
    return None


def vm_file_problem(path, cwd):
    """The block message for a Claude file tool writing vm state or the old folder, or None."""
    if not isinstance(path, str) or not path:
        return None
    place = VmRegistry()
    full = resolve_path(path, cwd) or os.path.normpath(os.path.join(cwd, path))
    if path_hits(full, place.states):
        return VM_STATE_MESSAGE.format(vm=VM_COMMAND, root=place.root, path=full)
    if within(full, place.old):
        return VM_OLD_MESSAGE.format(vm=VM_COMMAND, root=place.root,
                                     **old_folder_fields(full, place))
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
    cwd = payload.get('cwd') or os.getcwd()
    cwd = cwd if os.path.isdir(cwd) else os.getcwd()
    if payload.get('tool_name') in FILE_TOOLS:
        problem = vm_file_problem(tool_input.get(FILE_TOOLS[payload['tool_name']]), cwd)
        if problem:
            print(problem, file=sys.stderr)
            return 2
        return 0
    if payload.get('tool_name') in ('Grep', 'Glob'):
        path = tool_input.get('path')
        root = (path.rstrip('/') or '/') if isinstance(path, str) and path else None
        if root in config['roots']:
            print(SCAN_MESSAGE.format(root=root), file=sys.stderr)
            return 2
        return 0
    command = shell_text(tool_input.get('command'))
    root = scan_root(command, config['roots'])
    if root:
        print(SCAN_MESSAGE.format(root=root), file=sys.stderr)
        return 2
    heredoc = expanding_heredoc(command)
    if heredoc:
        print(HEREDOC_MESSAGE.format(name=heredoc[0], what=heredoc[1]), file=sys.stderr)
        return 2
    deleting = risky_delete(command, cwd)
    if deleting:
        print(deleting[0].format(**deleting[1]), file=sys.stderr)
        return 2
    repo = repo_install(command, cwd)
    if repo:
        print(INSTALL_MESSAGE.format(repo=repo, script=repo / INSTALL_SCRIPT), file=sys.stderr)
        return 2
    killer = pattern_kill(command)
    if killer:
        print(KILL_MESSAGE.format(tool=killer), file=sys.stderr)
        return 2
    vm = vm_problem(command, cwd)
    if vm:
        print(vm, file=sys.stderr)
        return 2
    if unlimited_tests(command) and memory_limit_usable():
        print(TEST_MESSAGE.format(limit=config['test_memory']), file=sys.stderr)
        return 2
    where = load_problem(command, cwd, config['cores'])
    if where:
        cores = config['cores']
        print(LOAD_MESSAGE.format(where=where, cores=cores, last=cores - 1, quota=cores * 100), file=sys.stderr)
        return 2
    return 0


# ---------------------------------------------------------------- install

HOOK_COMMAND = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'hook'])
GROUP_NAME = 'host-guard'
BACKUP_PREFIX = '.host-guard-backup-'
MATCHER = {'claude': 'Bash|Grep|Glob|Write|Edit|NotebookEdit', 'codex': 'Bash'}


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
