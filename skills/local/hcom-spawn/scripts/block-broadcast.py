#!/usr/bin/env python3
"""PreToolUse hook: refuse `hcom send` calls that would broadcast to every agent."""
import json
import sys

REASON = ('Blocked: `hcom send` without a recipient broadcasts to every agent. '
          'Name who it is for: `hcom send @<name> ...` for one agent, or '
          '`hcom send @<tag>- ...` for one group.')
OPERATORS = ('<<<', '<<-', '&&', '||', ';;', '|&', '&>', '>>', '>&', '<&', '<<',
             ';', '|', '&', '(', ')', '\n', '<', '>')
REDIRECTS = {'<<<', '&>', '>>', '>&', '<&', '<', '>'}
SHELLS = {'sh', 'bash', 'zsh', 'dash'}
KEYWORDS = {'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{'}
WRAPPERS = {'env', 'command', 'exec', 'nohup', 'time', 'sudo', 'doas', 'timeout', 'nice',
            'ionice', 'stdbuf', 'setsid', 'xargs', 'chronic', 'unbuffer'}
VALUE_OPTIONS = {'--intent', '--reply-to', '--thread', '--from', '--name', '--file',
                 '--base64', '--title', '--description', '--events', '--files',
                 '--transcript', '--extends'}


def substitution_end(text, i):
    """Return the index of the ')' closing a group whose body starts at i."""
    quote = None
    while i < len(text):
        c = text[i]
        if quote == "'":
            if c == "'":
                quote = None
        elif c == '\\':
            i += 1
        elif text.startswith('$(', i):
            i = substitution_end(text, i + 2)
        elif c == '"':
            quote = None if quote else '"'
        elif quote is None and c == "'":
            quote = "'"
        elif quote is None and c == '(':
            i = substitution_end(text, i + 1)
        elif quote is None and c == ')':
            return i
        i += 1
    raise ValueError('unclosed command substitution')


def backtick_end(text, i):
    while i < len(text):
        if text[i] == '\\':
            i += 1
        elif text[i] == '`':
            return i
        i += 1
    raise ValueError('unclosed backtick')


def substitutions(text):
    """Commands run by $(...) or `...` inside text that is otherwise not executed."""
    found, i = [], 0
    while i < len(text):
        if text[i] == '\\':
            i += 2
        elif text.startswith('$(', i):
            end = substitution_end(text, i + 2)
            found += commands(text[i + 2:end])
            i = end + 1
        elif text[i] == '`':
            end = backtick_end(text, i + 1)
            found += commands(text[i + 1:end])
            i = end + 1
        else:
            i += 1
    return found


def commands(text):
    """Split shell text into simple commands, including ones run by substitutions."""
    found, words = [], []
    word, quoted, quote = None, False, None
    drop_next, heredoc_next, heredocs = False, None, []
    herestring_next, herestrings, line_shell = False, [], False  # per physical line
    i = 0

    def finish_word():
        nonlocal word, quoted, drop_next, heredoc_next, herestring_next
        if word is None:
            return
        if heredoc_next is not None:
            heredocs.append((word, quoted, heredoc_next))
        elif herestring_next:
            herestrings.append(word)
        elif not drop_next:
            words.append(word)
        word, quoted, drop_next, heredoc_next = None, False, False, None
        herestring_next = False

    def finish_command():
        nonlocal words, drop_next, line_shell
        finish_word()
        drop_next = False
        if words:
            found.append(words)
            line_shell = line_shell or runs_shell(words)
        words = []

    def finish_line():
        nonlocal herestrings
        if line_shell:
            for text in herestrings:
                found.extend(commands(text))
        herestrings = []

    while i < len(text):
        c = text[i]
        if quote == "'":
            if c == "'":
                quote = None
            else:
                word += c
            i += 1
        elif c == '\\':
            if text.startswith('\\\n', i):
                i += 2
                continue
            word, quoted = (word or '') + text[i + 1:i + 2], True
            i += 2
        elif text.startswith('$(', i):
            end = substitution_end(text, i + 2)
            found += commands(text[i + 2:end])
            word = (word or '') + text[i:end + 1]
            i = end + 1
        elif c == '`':
            end = backtick_end(text, i + 1)
            found += commands(text[i + 1:end])
            word = (word or '') + text[i:end + 1]
            i = end + 1
        elif quote == '"':
            if c == '"':
                quote = None
            else:
                word += c
            i += 1
        elif c in '\'"':
            word, quoted, quote = word or '', True, c
            i += 1
        elif c in ' \t':
            finish_word()
            i += 1
        elif c == '#' and word is None:
            i = text.find('\n', i) if '\n' in text[i:] else len(text)
        else:
            op = next((o for o in OPERATORS if text.startswith(o, i)), None)
            if op is None:
                word = (word or '') + c
                i += 1
                continue
            if op in REDIRECTS or op in ('<<', '<<-'):
                if word is not None and word.isdigit() and not quoted:
                    word = None
            finish_word()
            i += len(op)
            if op in ('<<', '<<-'):
                heredoc_next = op
            elif op == '<<<':
                herestring_next = True
            elif op in REDIRECTS:
                drop_next = True
            else:
                finish_command()
            if op == '\n':
                finish_line()
                for delimiter, literal, kind in heredocs:
                    body = []
                    while i < len(text):
                        end = text.find('\n', i)
                        end = len(text) if end < 0 else end
                        line = text[i:end]
                        i = end + 1
                        if (line.lstrip('\t') if kind == '<<-' else line) == delimiter:
                            break
                        body.append(line)
                    if line_shell:
                        found += commands('\n'.join(body))
                    elif not literal:
                        found += substitutions('\n'.join(body))
                heredocs, line_shell = [], False
    if quote:
        raise ValueError('unclosed quote')
    finish_command()
    finish_line()
    return found


def runs_shell(words):
    """True when the command is a shell, directly or behind a wrapper such as env."""
    words = executable(words)
    names = [word.rsplit('/', 1)[-1] for word in words]
    return names[0] in SHELLS or (names[0] in WRAPPERS and bool(SHELLS & set(names)))


def executable(words):
    """Words from the command position on, past assignments and compound keywords."""
    index = 0
    while index < len(words) and (words[index] in KEYWORDS or (
            '=' in words[index] and words[index].split('=', 1)[0].isidentifier())):
        index += 1
    return words[index:] or ['']


def nested_broadcasts(text):
    try:
        return any(broadcasts(words) for words in commands(text))
    except ValueError:
        return 'hcom' in text and 'send' in text


def send_broadcasts(options):
    index = 0
    while index < len(options):
        option = options[index]
        if option == '--':
            break
        if option in ('--help', '-h', '--thread') or option.startswith('--thread='):
            return False
        if option.startswith('@'):
            return False
        index += 2 if option in VALUE_OPTIONS else 1
    return True


def broadcasts(words):
    """Check the command; behind a wrapper like sudo or env -u X, check every word."""
    words = executable(words)
    if words[0].rsplit('/', 1)[-1] not in WRAPPERS | SHELLS | {'hcom'}:
        return False
    shell_seen = False
    for index, word in enumerate(words):
        name = word.rsplit('/', 1)[-1]
        following = words[index + 1:]
        if name == 'hcom' and following[:1] == ['send']:
            # The rest of the line is this send's options and message text.
            return send_broadcasts(following[1:])
        shell_seen = shell_seen or name in SHELLS
        shell_flag = (shell_seen and word.startswith('-') and not word.startswith('--')
                      and 'c' in word)
        if following and (shell_flag or word in ('-S', '--split-string')):
            if nested_broadcasts(following[0]):
                return True
    return False


def main():
    try:
        command = json.load(sys.stdin).get('tool_input', {}).get('command', '')
    except (ValueError, AttributeError):
        return 0
    try:
        if isinstance(command, list):
            found = [[str(word) for word in command]]
        else:
            found = commands(command) if isinstance(command, str) else []
        blocked = any(broadcasts(words) for words in found)
    except Exception:  # unparseable text or a hook bug must not let a send through
        text = ' '.join(map(str, command)) if isinstance(command, list) else str(command)
        blocked = 'hcom' in text and 'send' in text
    if blocked:
        print(REASON, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
