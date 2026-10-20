#!/usr/bin/env python3
"""Suggest one or two /code-review reviewers for the committed diff since a base (stdlib only).

Changed lines are added + deleted lines from `git diff --numstat <base>...HEAD`.
One reviewer (Standards): only test and doc files changed, or code lines <= SMALL_CODE_LINES.
Two reviewers (Standards + Spec): anything larger. The threshold comes from 2026-09/10 LAT
merges in this repo: fix branches changed at most ~70 code lines, feature tickets 80 or more.
"""
import argparse
from pathlib import PurePosixPath
import subprocess
import sys

SMALL_CODE_LINES = 60
DOC_SUFFIXES = {'.md', '.mdx', '.rst', '.txt'}
TEST_DIRS = {'test', 'tests', '__tests__', 'e2e', 'qa_e2e'}


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


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('base', help='審查基準（commit、分支或 tag）；比較 <base>...HEAD 的已提交差異')
    parser.add_argument('-C', dest='repo', default='.', help='Git 工作區（預設目前目錄）')
    args = parser.parse_args()
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
