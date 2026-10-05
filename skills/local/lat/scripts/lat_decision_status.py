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
