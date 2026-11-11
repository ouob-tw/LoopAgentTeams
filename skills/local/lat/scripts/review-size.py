#!/usr/bin/env python3
"""Suggest one or two /code-review reviewers for the committed diff since a base (stdlib only).

Changed lines are added + deleted lines from `git diff --numstat <base>...HEAD`.
One reviewer (Standards): only test and doc files changed, or code lines <= SMALL_CODE_LINES.
Two reviewers (Standards + Spec): anything larger. The threshold comes from 2026-09/10 LAT
merges in this repo: fix branches changed at most ~70 code lines, feature tickets 80 or more.

`--tiny` runs the tiny-lane check instead: added code lines (same classification, tests and
docs excluded) against the hard limit, and the hints a reviewer's four-limit confirmation must
address: files matching the project's data/format patterns and `feat` commits. lat-ledger's
review-result and lat-preauth's merge check load this file for the same check.
"""
import argparse
from fnmatch import fnmatch
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

SMALL_CODE_LINES = 60
DOC_SUFFIXES = {'.md', '.mdx', '.rst', '.txt'}
TEST_DIRS = {'test', 'tests', '__tests__', 'e2e', 'qa_e2e'}
TINY_CODE_LINES = 30
# Project setting: `tiny_lane.format_patterns` (fnmatch, `*` crosses `/`) in the repo root
# .suite-gate.json replaces these.
DEFAULT_FORMAT_PATTERNS = ('*migrations/*', '*migration/*', '*schema*', '*.sql')
FEAT = re.compile(r'feat(\([^)]*\))?!?:')
NORMAL_FLOW = ('return to the normal flow: the orchestrator takes the ticket off the tiny lane '
               '(`lat-ledger.py tiny-off <row> --reason "<why>"`), then re-dispatch the ticket '
               'as an ordinary one, with QA')


def kind(path):
    p = PurePosixPath(path)
    name = p.name
    if (TEST_DIRS & set(p.parts[:-1]) or name.startswith('test_')
            or p.stem.endswith('_test') or '.test.' in name or '.spec.' in name):
        return 'test'
    if p.suffix.lower() in DOC_SUFFIXES or 'docs' in p.parts[:-1]:
        return 'doc'
    return 'code'


def parse_numstat(raw):
    """Yield (added, deleted, path) from `git diff --numstat -z`; renames yield the new path."""
    fields = iter(raw.split('\0'))
    for row in fields:
        if not row:
            continue
        added, deleted, path = row.split('\t', 2)
        if not path:
            next(fields)
            path = next(fields)
        yield added, deleted, path


def suggest(numstat):
    """Return (reviewers, reason) for `git diff --numstat -z` output."""
    lines = {'code': 0, 'test': 0, 'doc': 0}
    files = {'code': 0, 'test': 0, 'doc': 0}
    for added, deleted, path in parse_numstat(numstat):
        k = kind(path)
        files[k] += 1
        # Binary files report "-"; count them as files only.
        lines[k] += sum(int(n) for n in (added, deleted) if n != '-')
    summary = '，'.join(f'{label} {files[k]} 檔 {lines[k]} 行'
                       for k, label in (('code', '程式'), ('test', '測試'), ('doc', '文件')))
    if not any(files.values()):
        return 1, f'沒有差異（{summary}）'
    if not files['code']:
        return 1, f'只改測試或文件（{summary}）'
    if lines['code'] <= SMALL_CODE_LINES:
        return 1, f'小改動：程式改動 {lines["code"]} 行 ≤ {SMALL_CODE_LINES}（{summary}）'
    return 2, f'程式改動 {lines["code"]} 行 > {SMALL_CODE_LINES}（{summary}）'


def git_out(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(f'git {args[0]} failed: {result.stderr.strip() or result.returncode}')
    return result.stdout


def format_patterns(repo):
    """The project's data/format file patterns, or the defaults when it sets none."""
    try:
        root = git_out(repo, 'rev-parse', '--show-toplevel').strip()
        data = json.loads((Path(root) / '.suite-gate.json').read_text())
        patterns = data['tiny_lane']['format_patterns']
    except (ValueError, OSError, KeyError, TypeError):
        return list(DEFAULT_FORMAT_PATTERNS)
    if not isinstance(patterns, list) or not all(isinstance(p, str) for p in patterns):
        raise ValueError('.suite-gate.json tiny_lane.format_patterns must be a list of strings')
    return patterns


def tiny_check(repo, base, head='HEAD', integration=None):
    """The tiny-lane check of base...head in repo. When the integration branch was merged into
    the work after base, its newer merge base is used, so changes it brought in do not count.
    Returns base, head, code_added, files {kind: count}, problems (hard limits) and hints
    (format-pattern hits and feat commits). ValueError when Git cannot answer."""
    head = git_out(repo, 'rev-parse', '--verify', f'{head}^{{commit}}').strip()
    base = git_out(repo, 'rev-parse', '--verify', f'{base}^{{commit}}').strip()
    if integration:
        joined = subprocess.run(['git', '-C', str(repo), 'merge-base', head, integration],
                                capture_output=True, text=True).stdout.strip()
        if joined and not subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor',
                                          base, joined], capture_output=True).returncode:
            base = joined
    numstat = git_out(repo, 'diff', '--numstat', '-z', '-M', f'{base}...{head}')
    patterns = format_patterns(repo)
    files, code_added, hints = {'code': 0, 'test': 0, 'doc': 0}, 0, []
    for added, _, path in parse_numstat(numstat):
        k = kind(path)
        files[k] += 1
        if k == 'code' and added != '-':
            code_added += int(added)
        hit = next((p for p in patterns if fnmatch(path, p)), None)
        if hit:
            hints.append(f'data/format file {path} (pattern {hit})')
    log = git_out(repo, 'log', '--no-merges', '--format=%H %s', f'{base}..{head}')
    for line in log.splitlines():
        sha, _, subject = line.partition(' ')
        if FEAT.match(subject):
            hints.append(f'feat commit {sha[:12]} {subject}')
    # The change byte for byte, without context, line numbers or blob IDs, so integration
    # changes merged in elsewhere (even in the same file) do not alter it but any edit of the
    # work's own lines does.
    diff = subprocess.run(['git', '-C', str(repo), 'diff', '--no-color', '--no-ext-diff',
                           '--full-index', '--binary', '-U0', '-M', f'{base}...{head}'],
                          capture_output=True)
    if diff.returncode:
        raise ValueError(f'git diff failed: {diff.stderr.decode(errors="replace").strip()}')
    own = re.sub(rb'(?m)^index [0-9a-f]+\.\.[0-9a-f]+', b'index',  # blob IDs cover the whole file
                 re.sub(rb'(?m)^@@ [^@]* @@', b'@@', diff.stdout))
    problems = []
    if code_added > TINY_CODE_LINES:
        problems.append(f'{code_added} added code lines (tests and docs excluded) exceed the '
                        f'tiny-lane limit of {TINY_CODE_LINES}')
    content = hashlib.sha256(own).hexdigest()
    return {'base': base, 'head': head, 'code_added': code_added, 'files': files,
            'problems': problems, 'hints': hints, 'content': content}


def card_fields(path):
    """A task card's `- name：value` fields (first of each); ValueError when unreadable."""
    try:
        text = Path(path).read_text(encoding='utf-8')
    except (OSError, UnicodeError, TypeError) as error:
        raise ValueError(f'task card {path} unreadable: {error}') from None
    fields = {}
    for line in text.splitlines():
        match = re.fullmatch(r'-\s+([^：:\n]+)[：:]\s*(.*)', line.strip())
        if match:
            fields.setdefault(match.group(1).strip(), match.group(2).strip())
    return fields


def card_base(fields, card):
    base = fields.get('base commit', '')
    if not re.fullmatch(r'[0-9a-fA-F]{7,64}', base):
        raise ValueError(f'task card {card} names no base commit')
    return base


def orchestrator_problems(rows, *orchestrators):
    """A tiny ticket is always implemented by a dispatched implementer: a refusal per impl row
    (of the ticket's ledger rows) owned by one of the orchestrator names."""
    names = {name for name in orchestrators if name}
    return [f'ledger row {row.get("id")} implements the ticket under the orchestrator '
            f'{row.get("agent")} itself; tiny changes are implemented by a dispatched implementer'
            for row in rows if isinstance(row, dict) and row.get('stage') == 'impl'
            and row.get('status') != 'cancelled' and row.get('agent') in names]


def tiny_text(check):
    scope = 'code-touching' if check['files']['code'] else 'docs/skill-text/test-only'
    lines = [f'tiny check {check["base"][:12]}...{check["head"][:12]} (content '
             f'{check["content"][:12]}): {scope}, '
             f'{check["code_added"]} added code lines (limit {TINY_CODE_LINES}; code '
             f'{check["files"]["code"]}, test {check["files"]["test"]}, doc '
             f'{check["files"]["doc"]} files)']
    lines += [f'refused: {problem}; {NORMAL_FLOW}' for problem in check['problems']]
    lines += [f'hint: {hint}' for hint in check['hints']]
    if check['hints']:
        lines.append('The reviewer\'s four-limit confirmation must say how each hint was '
                     'checked (review-result --tiny-hints).')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('base', help='審查基準（commit、分支或 tag）；比較 <base>...HEAD 的已提交差異')
    parser.add_argument('-C', dest='repo', default='.', help='Git 工作區（預設目前目錄）')
    parser.add_argument('--tiny', action='store_true',
                        help='run the tiny-lane check (limits and hints) instead')
    parser.add_argument('--integration',
                        help='with --tiny: integration branch merged into the work')
    args = parser.parse_args()
    if args.tiny:
        try:
            check = tiny_check(args.repo, args.base, integration=args.integration)
        except ValueError as error:
            print(error, file=sys.stderr)
            return 2
        print(tiny_text(check))
        return 1 if check['problems'] else 0
    result = subprocess.run(['git', '-C', args.repo, 'diff', '--numstat', '-z', '-M', f'{args.base}...HEAD'],
                            capture_output=True, text=True)
    if result.returncode:
        print(result.stderr.strip() or 'git diff 失敗', file=sys.stderr)
        return 2
    reviewers, reason = suggest(result.stdout)
    who = '一位（Standards）' if reviewers == 1 else '兩位（Standards ＋ Spec）'
    print(f'建議：{who}\n理由：{reason}\n這是建議，由主控決定。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
