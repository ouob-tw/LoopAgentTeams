#!/usr/bin/env python3
"""Validate a Spec consensus block and optionally record its receipt (stdlib only)."""
import argparse
import hashlib
from pathlib import Path
import re
import sys


RESERVED = ('已拿掉', '不做', '你要留意')


def check_consensus(text, last_confirmed=None):
    lines = text.splitlines()
    first = next((i for i, line in enumerate(lines) if line.strip()), 0)
    header = re.fullmatch(r'\*\*共識 v([1-9][0-9]*)\*\*', lines[first].rstrip() if lines else '')
    if not header:
        return None, [f'第 {first + 1} 行：第一個非空行須為 **共識 v<N>**（正整數版本）']
    version = int(header[1])
    end = next((i for i in range(first + 1, len(lines)) if lines[i].startswith('#')), len(lines))
    problems = []
    topics = 0
    reserved_rank = -1
    for i in range(first + 1, end):
        line = lines[i].rstrip()
        if not line:
            continue
        top = re.fullmatch(r'- \*\*(.+?)\*\*：(.+)', line)
        child = re.fullmatch(r'  - (.+)', line)
        reason = None
        if top and top[1].strip() and top[2].strip():
            topics += 1
            topic = top[1].strip()
            if topic in RESERVED:
                rank = RESERVED.index(topic)
                if rank <= reserved_rank:
                    reason = '保留主題順序須為 已拿掉 → 不做 → 你要留意，且各只出現一次'
                reserved_rank = rank
                if topic == '已拿掉' and version == 1:
                    reason = 'v1 不得有「已拿掉」'
            elif reserved_rank >= 0:
                reason = '保留主題必須排在其他主題之後'
        elif child and child[1].strip() and topics:
            pass
        else:
            reason = '只接受第一層 - **主題**：結論與第二層（兩個空格）  - 補充；不得有第三層或其他段落'
        if reason:
            problems.append(f'第 {i + 1} 行：{reason}')
        # A version-shaped annotation must be the one canonical marker at the line end.
        annotation = re.sub(r'「[^」]*」|`[^`]*`', lambda match: ' ' * len(match[0]), line)
        starts = list(re.finditer(r'[（(]v', annotation))
        if starts:
            marker = re.search(r'（v([1-9][0-9]*) 改）$', line)
            if not marker or len(starts) != 1:
                problems.append(f'第 {i + 1} 行：變動記號須在行尾，格式為 （v<M> 改）')
            else:
                changed = int(marker[1])
                if not 2 <= changed <= version:
                    problems.append(f'第 {i + 1} 行：記號版本須滿足 2 ≤ M ≤ 目前版本；v1 不得有記號')
                if last_confirmed is not None and changed <= last_confirmed:
                    problems.append(f'第 {i + 1} 行：記號版本須大於上次確認版本 v{last_confirmed}')
    if not topics:
        problems.append(f'第 {first + 1} 行：共識至少須有一條第一層條目')
    block = '\n'.join(line.rstrip() for line in lines[first:end]).strip('\n')
    receipt = f'- consensus: v{version} {hashlib.sha256(block.encode("utf-8")).hexdigest()}'
    return receipt, problems


def positive_version(value):
    if not re.fullmatch(r'[1-9][0-9]*', value):
        raise argparse.ArgumentTypeError('版本須為正整數')
    return int(value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec', default='-', help='Spec 內文檔案；- 為標準輸入（預設）')
    parser.add_argument('--decision-id', help='既有 Spec 確認題的待決紀錄 ID；省略時只檢查')
    parser.add_argument('--decisions', type=Path, help='共用待決紀錄目錄；寫入時必填')
    parser.add_argument('--last-confirmed-version', type=positive_version, help='上次真人確認的共識版本')
    args = parser.parse_args()
    if args.decision_id and (not args.decisions or not re.fullmatch(r'[A-Za-z0-9_.-]+', args.decision_id)
                             or args.decision_id in ('.', '..')):
        parser.error('寫入須提供 --decisions 與有效的 --decision-id')
    try:
        text = sys.stdin.read() if args.spec == '-' else Path(args.spec).read_text(encoding='utf-8')
        receipt, problems = check_consensus(text, args.last_confirmed_version)
        if problems:
            print('\n'.join(problems), file=sys.stderr)
            return 1
        if args.decision_id:
            path = args.decisions / f'{args.decision_id}.md'
            original = path.read_text(encoding='utf-8')  # Never create a missing record.
            lines = original.splitlines()
            positions = [i for i, line in enumerate(lines) if re.match(r'^- consensus:', line, re.IGNORECASE)]
            if positions:
                lines[positions[0]] = receipt
                lines = [line for i, line in enumerate(lines) if i not in positions[1:]]
            else:
                lines.append(receipt)
            updated = '\n'.join(lines) + '\n'
            if updated != original:
                path.write_text(updated, encoding='utf-8')
        print(receipt)
        return 0
    except (OSError, UnicodeError) as exc:
        print(f'共識檢查錯誤：{exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
