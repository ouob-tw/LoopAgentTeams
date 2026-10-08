"""Shared decision-record status reading for LAT tools (stdlib only)."""
from pathlib import Path
import re
from typing import NamedTuple


class DecisionStatus(NamedTuple):
    status: str | None
    error: str | None


def read_decision_status(path):
    """Read the first status line; malformed values carry a diagnostic."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- status:(.*)$', line, re.IGNORECASE)
        if not match:
            continue
        value = match.group(1).strip().lower()
        if not value:
            return DecisionStatus(None, '狀態值為空或只有空白')
        status = value.split()[0]
        if status != 'pending' and 'pending' in value[len(status):]:
            return DecisionStatus(None, '第一個字不是 pending，但後面含有 pending')
        return DecisionStatus(status, None)
    return DecisionStatus(None, '沒有狀態行（- status:）')


def read_advisor_error(path):
    """Validate the first advisor line, returning a diagnostic or None."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- advisor:(.*)$', line, re.IGNORECASE)
        if not match:
            continue
        words = match.group(1).strip().lower().split()
        if not words:
            return '參謀行沒有結論'
        if words[0] == 'needs-human':
            return None
        allowed = {'exempt': ('spec-confirmation', 'requirement-discussion', 'account-quota'),
                   'late': ('needs-human', 'resolved', 'self-check')}
        if words[0] not in allowed:
            return f'未知參謀結論：{words[0]}'
        if len(words) < 2:
            return f'參謀 {words[0]} 缺少第二個字'
        if words[1] not in allowed[words[0]]:
            return f'參謀 {words[0]} 的第二個字不在清單內：{words[1]}'
        return None
    return '沒有參謀行（- advisor:）'


def read_spec_consensus_error(path, message):
    """Check the receipt and message only for the first spec-confirmation advisor line."""
    lines = Path(path).read_text(encoding='utf-8').splitlines()
    advisor = next((line.split(':', 1)[1].strip().lower().split()
                    for line in lines if re.match(r'^- advisor:', line, re.IGNORECASE)), [])
    if advisor[:2] != ['exempt', 'spec-confirmation']:
        return None
    receipts = [line for line in lines if re.match(r'^- consensus:', line, re.IGNORECASE)]
    if not receipts:
        return '缺共識行；請先跑共識檢查工具'
    receipt = re.fullmatch(r'- consensus: v([1-9][0-9]*) [0-9a-f]{64}', receipts[0])
    if len(receipts) != 1 or not receipt:
        return '共識行格式錯；須只有一行 - consensus: v<N> <sha256>'
    versions = set(re.findall(r'共識 v([1-9][0-9]*)(?![0-9A-Za-z_])', message))
    if not versions:
        return '訊息沒寫共識版本（共識 v<N>）'
    if len(versions) > 1:
        return '訊息出現多個不同共識版本'
    if versions != {receipt[1]}:
        return '訊息版本與檢查過的不同'
    return None
