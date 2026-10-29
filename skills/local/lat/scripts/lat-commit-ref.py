#!/usr/bin/env python3
"""Git commit-msg check: a commit on a ticket branch must cite the ticket (stdlib only).

`check <msg-file>` is what the hook runs. The ticket number comes from the branch name
(`fix/370`, `fix/issue-366-x`, `issue-366`); the message must contain `#<N>`, optionally
written `owner/repo#<N>`. Branches without a number (dev, main), a detached HEAD and merge
commits are not checked. `install` / `uninstall --repo <dir>` add or remove the hook block in
the repo's own hooks dir, keeping any hook already there.
"""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

SCRIPT = Path(__file__).resolve()
BEGIN = '# >>> lat-commit-ref commit-msg >>>'
END = '# <<< lat-commit-ref commit-msg <<<'
CREATED = '# lat-commit-ref created this file; uninstall removes it.'
SH_SHEBANG = re.compile(r'#!\s*(?:\S*/)?(?:env\s+)?(?:\S*/)?(?:sh|bash|dash|zsh)(?:\s.*)?')
ISSUE_WORD = re.compile(r'(?:^|[/_-])issue[-_](\d{1,6})(?=$|[-_/])', re.I)
NUMBER_SEGMENT = re.compile(r'(?:^|/)(\d{1,6})(?=$|[-_/])')


def git(args, cwd=None):
    return subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True)


def ticket_of(branch):
    """The ticket number a branch name carries, or None."""
    found = ISSUE_WORD.search(branch) or NUMBER_SEGMENT.search(branch)
    return str(int(found.group(1))) if found else None


def cites(message, number):
    """True when a non-comment line of message holds `#<number>` (not `#<number>0`).
    Comment lines are Git's template ones (`# ...` or a bare `#`); `#370 fix` is text."""
    body = ''.join(line for line in message.splitlines(True) if not re.match(r'#(\s|$)', line))
    return re.search(rf'#{number}(?!\d)', body) is not None


def cmd_check(msg_file):
    branch = git(['symbolic-ref', '--short', '-q', 'HEAD']).stdout.strip()
    number = ticket_of(branch) if branch else None
    if number is None:
        return 0
    if git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).returncode == 0:
        return 0
    if cites(Path(msg_file).read_text(errors='replace'), number):
        return 0
    print(f'commit-msg: branch {branch} is for ticket #{number}, but the message does not '
          f'mention #{number}.\nAdd a line such as `Refs owner/repo#{number}` (or just '
          f'`#{number}`) and commit again. `git commit --no-verify` skips this check.',
          file=sys.stderr)
    return 1


def hook_block(created):
    run = shlex.join(['uv', 'run', '--no-project', 'python', str(SCRIPT), 'check'])
    return (f'{BEGIN}\n' + (f'{CREATED}\n' if created else '') +
            '# Added by lat-commit-ref.py install; remove with uninstall.\n'
            f'{run} "$1" || exit 1\n{END}\n')


def updated_hook(text, action):
    """The hook text with the block installed or removed; None removes the file."""
    lines = (text or '').splitlines(True)
    marks = [i for i, line in enumerate(lines) if line.rstrip('\n') in (BEGIN, END)]
    if marks and [lines[i].rstrip('\n') for i in marks] != [BEGIN, END]:
        raise ValueError('the lat-commit-ref block is broken; inspect the hook')
    created = bool(marks) and CREATED + '\n' in lines[marks[0]:marks[1]]
    if action == 'uninstall':
        if not marks:
            return text
        rest = lines[:marks[0]] + lines[marks[1] + 1:]
        return None if created and ''.join(rest) == '#!/bin/sh\n' else ''.join(rest)
    if marks:
        return ''.join(lines[:marks[0]]) + hook_block(created) + ''.join(lines[marks[1] + 1:])
    if text is None:
        return '#!/bin/sh\n' + hook_block(True)
    if not lines or not SH_SHEBANG.fullmatch(lines[0].strip()):
        raise ValueError('the existing commit-msg hook is not a sh or bash script, so it was '
                         'left unchanged. Move it to another name, make commit-msg a sh '
                         'script that runs it with "$@", then install again')
    head = lines[0] if lines[0].endswith('\n') else lines[0] + '\n'
    return head + hook_block(False) + ''.join(lines[1:])


def write_file(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as tmp:
        tmp.write(text)
    if path.exists():
        os.chmod(tmp.name, path.stat().st_mode)
    else:
        os.chmod(tmp.name, 0o755)
    os.replace(tmp.name, path)


def cmd_configure(action, repo, preview):
    root = git(['rev-parse', '--show-toplevel'], repo).stdout.strip()
    if not root:
        raise ValueError(f'{repo} is not a Git work tree')
    # Always the repo's own hooks dir: a core.hooksPath may be shared by every repo.
    common = Path(root, git(['rev-parse', '--git-common-dir'], root).stdout.strip()).resolve()
    path = common / 'hooks' / 'commit-msg'
    active = Path(root, git(['rev-parse', '--git-path', 'hooks'], root).stdout.strip()).resolve()
    try:
        before = path.read_text()
    except FileNotFoundError:
        before = None
    if action == 'install' and before is not None and not os.access(path, os.X_OK):
        raise ValueError(f'{path} exists but is not executable, so Git ignores it; make it '
                         'executable or remove it, then install again')
    after = updated_hook(before, action)
    if after == before:
        print(f'No changes: {path}')
    elif preview:
        print(f'Would {"remove" if after is None else "update"} {path}')
    elif after is None:
        path.unlink()
        print(f'Removed {path}')
    else:
        write_file(path, after)
        print(f'Updated {path}')
    shim = active / 'commit-msg'
    if action == 'install' and active != path.parent and not os.access(shim, os.X_OK):
        print(f'Installed but NOT active: core.hooksPath={active} runs hooks from there, not '
              f'from {path.parent}. Add a commit-msg file there (chmod +x) with:\n'
              '  #!/bin/sh\n'
              '  local_hook="$(git rev-parse --git-common-dir)/hooks/commit-msg"\n'
              '  [ -x "$local_hook" ] && exec "$local_hook" "$@"\n'
              '  exit 0')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest='action', required=True)
    check = sub.add_parser('check', help='the commit-msg hook: check one message file')
    check.add_argument('msg_file')
    for name in ('install', 'uninstall'):
        one = sub.add_parser(name, help=f'{name} the commit-msg hook block in --repo')
        one.add_argument('--repo', default='.')
        one.add_argument('--preview', action='store_true', help='show the change only')
    args = parser.parse_args(argv)
    if args.action == 'check':
        return cmd_check(args.msg_file)
    try:
        return cmd_configure(args.action, args.repo, args.preview)
    except ValueError as exc:
        print(f'lat-commit-ref: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
