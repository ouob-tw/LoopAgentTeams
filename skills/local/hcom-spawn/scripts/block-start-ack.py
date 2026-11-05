#!/usr/bin/env python3
"""PreToolUse hook: refuse an `hcom send` to the agent's own launcher that only says
"received" or "starting". Anything the check cannot read is let through."""
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'block_broadcast', Path(__file__).resolve().parent / 'block-broadcast.py')
shell = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(shell)

BYPASS = 'ACK_GUARD=off'
REASON = ('Blocked: this message to {launcher} only acknowledges or announces a start, '
          'and it would wake {launcher} for nothing. Report when you have a result, '
          'are stuck, or have a question. If the message does carry one of those, '
          f'resend it with `{BYPASS}` in front: `{BYPASS} hcom send @{{launcher}} ...`.')

# Rule 1: the message opens with a bare acknowledgement ...
ACK = re.compile(r'^\W*((ack(nowledged)?|received|got it|ok(ay)?|noted|understood|roger)\b'
                 r'|收到|了解|好的)\W*', re.I)
# ... and nothing follows it, or what follows opens like a start or plan notice.
START = re.compile(r"""^\W*(
    accepted | on\ it | will\ do
  | start(ing|ed)? | begin(ning)? | began | continuing | resum(ing|ed) | proceeding | working
  | (i\ )?will | i'll | i\ am | i'm
  | re-?(review|check|verif)\w* | reviewing | checking | verifying
  | review\ (started|underway|in\ progress)
)\b | ^\W*開始""", re.I | re.X)
# Rule 2: any word that hints at a result, a blocker or a question lets the message through.
SIGNAL = re.compile(r"""(
  \b(pass(ed)? | fail(ed|s|ure)? | done | complete[ds]? | finished | ready | resolved | closed
   | blocked | blocker | blocking | stuck | halt(ed)? | paused | waiting | cannot | can't
   | unable | error | broken | found | identified | confirm(s|ed) | reproduced | committed
   | frozen | question | decide | decision | needs? | please | unproven | incident
   | no\ (findings|issues|problems|regressions) | concerns? | remains? | preliminary | never)\b
  | \? | 完成 | 卡住 | 失敗 | 問題 | 請
)""", re.I | re.X)
SEND_VALUE_OPTIONS = shell.VALUE_OPTIONS


def only_acknowledges(text):
    """True when the text is a bare acknowledgement or a start notice with no result in it."""
    text = text.strip()
    ack = ACK.match(text)
    if ack:
        text = text[ack.end():]
        if not text:
            return True
    return bool(START.match(text)) and not SIGNAL.search(text)


def addressed_to(name, launcher):
    """True for `@<launcher>` and `@<launcher's base name>`; a `@<tag>-` group never counts."""
    if name.endswith('-'):
        return False
    return name == launcher or name == launcher.rsplit('-', 1)[-1]


def start_ack(words, launcher):
    """True when this simple command is `hcom send` of an acknowledgement to the launcher."""
    if BYPASS in words:
        return False
    words = shell.executable(words)
    if words[0].rsplit('/', 1)[-1] != 'hcom':
        return False
    rest = words[1:]
    while rest[:1] and rest[0].startswith('-'):  # global options before `send`
        rest = rest[2:] if rest[0] in SEND_VALUE_OPTIONS else rest[1:]
    if rest[:1] != ['send']:
        return False
    rest, recipients, index = rest[1:], [], 0
    while index < len(rest) and rest[index] != '--':
        word = rest[index]
        if word in ('--file', '--base64', '--thread') or word.startswith('--thread='):
            return False  # text the check does not read, or a thread
        if word == '--intent' and rest[index + 1:index + 2] == ['request']:
            return False
        if word.startswith('@'):
            recipients.append(word[1:])
        index += 2 if word in SEND_VALUE_OPTIONS else 1
    text = ' '.join(rest[index + 1:])
    return (bool(recipients) and all(addressed_to(r, launcher) for r in recipients)
            and only_acknowledges(text))


def main():
    launcher = os.environ.get('HCOM_LAUNCHED_BY', '').strip()
    if not launcher:
        return 0
    try:
        command = json.load(sys.stdin).get('tool_input', {}).get('command', '')
        if not isinstance(command, str):
            return 0
        blocked = any(start_ack(words, launcher) for words in shell.commands(command))
    except Exception:  # unreadable payload or command: let it through
        return 0
    if blocked:
        print(REASON.format(launcher=launcher), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
