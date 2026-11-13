"""Shared decision-record status reading for LAT tools (stdlib only)."""
from datetime import datetime, timezone
from pathlib import Path
import re
from typing import NamedTuple


# Exemptions that need a `- exempt-basis:` line, checked by lat-preauth's exempt_basis_problem.
EXEMPT_BASIS_CATEGORIES = ('prior-promise', 'must-ask')

# Unattended mode (references/unattended.md): a parked item waits for the user like a pending one
# but is never sent; a delegated record is the two advisors' decision under the grant.
PARKED = 'parked'
WAITABLE_STATUSES = ('pending', PARKED)
# Delegated status -> (the word after `- advisor: proxy`, the grant scope key that allows it).
DELEGATED = {'proxy-confirmed': ('ticket-confirmation', 'ticket_confirmation'),
             'assumed': ('assume-defaults', 'assume_defaults'),
             'prototype-decided': ('prototype', 'prototype_decide')}
# The fixed list an assumption must fall in, in the Spec's order.
ASSUME_CLASSES = ('naming', 'ui-detail', 'test', 'setting-default', 'ordering')
OPINION = re.compile(r'^(?:- )?(\S+?)（[^）]*）：\s*(agree|disagree)\s*；\s*(\S.*)$', re.IGNORECASE)
CONFIRM_LINE = re.compile(r'^- (\S.*?) ← 「(.+?)」\s*(\S.*)$')


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
        if match:
            return advisor_error(match.group(1), read_decision_kind(path) == 'help')
    return '沒有參謀行（- advisor:）'


def advisor_error(value, help_record=False):
    """Validate one advisor line's value, returning a diagnostic or None.

    `exempt user-account` is only valid on a help record (`- kind: help`).
    """
    words = value.strip().lower().split()
    if not words:
        return '參謀行沒有結論'
    if words[0] == 'needs-human':
        return None
    allowed = {'exempt': ('spec-confirmation', 'ticket-confirmation',
                           'requirement-discussion', 'account-quota', 'preauth-ask',
                           'user-account') + EXEMPT_BASIS_CATEGORIES,
               'late': ('needs-human', 'resolved', 'self-check')}
    if words[0] not in allowed:
        return f'未知參謀結論：{words[0]}'
    if len(words) < 2:
        return f'參謀 {words[0]} 缺少第二個字'
    if words[1] not in allowed[words[0]]:
        return f'參謀 {words[0]} 的第二個字不在清單內：{words[1]}'
    if words[:2] == ['exempt', 'user-account'] and not help_record:
        return '參謀 exempt user-account 只能用在求助紀錄（須有 `- kind: help`）'
    return None


def read_advisor_words(path):
    """The first advisor line's value as lowercase words; [] without one."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- advisor:(.*)$', line, re.IGNORECASE)
        if match:
            return match.group(1).strip().lower().split()
    return []


def exempt_basis_category(words):
    """The category of advisor words that need a basis line, or None for any other words."""
    if words[:1] == ['exempt'] and words[1:2] and words[1] in EXEMPT_BASIS_CATEGORIES:
        return words[1]
    return None


def read_exempt_basis(path):
    """The first `- exempt-basis:` value with its case kept, or None when empty or absent."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- exempt-basis:(.*)$', line, re.IGNORECASE)
        if match:
            return match.group(1).strip() or None
    return None


def read_tried(path):
    """The first `- tried:` value, or None when empty or absent."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- tried:(.*)$', line, re.IGNORECASE)
        if match:
            return match.group(1).strip() or None
    return None


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


def read_decision_session(path):
    """The first `- session:` value, or None when the record names no session."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- session:(.*)$', line, re.IGNORECASE)
        if match:
            return match.group(1).strip() or None
    return None


def read_decision_kind(path):
    """Return 'help' when the first kind line says help; every other record is 'decide'."""
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- kind:(.*)$', line, re.IGNORECASE)
        if match:
            words = match.group(1).strip().lower().split()
            return 'help' if words[:1] == ['help'] else 'decide'
    return 'decide'


def read_decision_action(path):
    """`(action, branch, commit)` from the first `- action:` line, or None without one.

    merge and push name the branch before the commit; the other actions take no branch,
    so their second word is the commit. Missing words are None; an empty line gives ''.
    """
    for line in Path(path).read_text(encoding='utf-8').splitlines():
        match = re.match(r'^- action:(.*)$', line, re.IGNORECASE)
        if match:
            words = match.group(1).split() + [None, None]
            action = words[0] or ''
            if action in ('merge', 'push'):
                return action, words[1], words[2]
            return action, None, words[1]
    return None


def _field(lines, key):
    """The first `- <key>:` value stripped, '' when empty, None when absent."""
    for line in lines:
        match = re.match(rf'^- {re.escape(key)}:(.*)$', line, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def _section(lines, heading):
    """The lines under the first `## <heading>` up to the next `## ` heading."""
    found, inside = [], False
    for line in lines:
        if line.startswith('## '):
            if inside:
                break
            inside = line[3:].strip() == heading
            continue
        if inside:
            found.append(line)
    return found


class DelegatedGrant(NamedTuple):
    round: int
    version: int
    decided_at: datetime


def delegated_record_problems(path, status):
    """`(problems, grant)` from a delegated record's own text. `grant` is the cited round,
    version and decision time, or None when they cannot be read; the caller checks them against
    the grant file, the scope and whether the question was already asked."""
    lines = Path(path).read_text(encoding='utf-8').splitlines()
    word = DELEGATED[status][0]
    problems = []
    advisor = (_field(lines, 'advisor') or '').lower().split()
    if advisor[:1] == ['exempt']:
        problems.append(f'參謀行是 exempt {" ".join(advisor[1:2])}，屬一定擱置類別')
    elif advisor[:2] != ['proxy', word]:
        problems.append(f'參謀行須為 `- advisor: proxy {word}`')
    for key, label in (('action', '預先授權動作（`- action:`）'), ('exempt-basis', '免諮詢依據'),
                       ('kind', None)):
        value = _field(lines, key)
        if key == 'kind':
            if value is not None and value.lower().split()[:1] == ['help']:
                problems.append('求助題（`- kind: help`）屬一定擱置類別')
        elif value is not None:
            problems.append(f'有{label}行，屬一定擱置類別')
    if any(line.startswith('## 答覆') for line in lines):
        problems.append('含真人答覆段落（`## 答覆`）；代決不得記成真人答覆')
    if not _field(lines, 'session'):
        problems.append('缺 `- session:` 行')
    grant = None
    cited = re.fullmatch(r'r([1-9][0-9]*) v([1-9][0-9]*)', _field(lines, 'grant') or '')
    decided = _field(lines, 'decided-at')
    moment = None
    try:
        moment = datetime.fromisoformat(decided) if decided else None
    except ValueError:
        pass
    if not cited:
        problems.append('缺授權版本或格式錯；寫 `- grant: r<輪> v<版本>`')
    if moment is None:
        problems.append('缺作成時間或格式錯；寫 `- decided-at: <ISO 時間>`')
    elif moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    if cited and moment:
        grant = DelegatedGrant(int(cited[1]), int(cited[2]), moment)
    opinions = [OPINION.match(line.strip()) for line in _section(lines, '參謀意見')]
    opinions = [match for match in opinions if match]
    if any(match[2].lower() == 'disagree' for match in opinions):
        problems.append('有參謀不同意；應記為擱置（`- status: parked`）')
    agreed = {match[1] for match in opinions if match[2].lower() == 'agree'}
    if len(agreed) < 2:
        problems.append('缺參謀結論：`## 參謀意見` 須有兩位不同參謀各一行 '
                        '`<名稱>（<client> <模型>）：agree；<理由>`')
    if status == 'assumed':
        value = (_field(lines, 'assume-class') or '').lower()
        if value not in ASSUME_CLASSES:
            problems.append(f'假設類別未標或不在固定清單：`- assume-class:` 須為 '
                            f'{"、".join(ASSUME_CLASSES)} 其中之一')
        if not _field(lines, 'revert'):
            problems.append('缺 `- revert:`（使用者可以改成什麼）')
    elif status == 'prototype-decided':
        if not _field(lines, 'sample'):
            problems.append('缺 `- sample:`（樣品位置）')
    else:
        rows = [line for line in _section(lines, '驗收對照') if line.strip()]
        if not rows or not all(CONFIRM_LINE.match(line) for line in rows):
            problems.append('`## 驗收對照` 須逐條寫 `- <驗收條件> ← 「<使用者原話>」 <來源>`')
    return problems, grant
