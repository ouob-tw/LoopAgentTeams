"""Warning-only tracker check for the tickets on a round ledger (never blocks, never writes)."""
import json
from pathlib import Path
import re
import shlex
import subprocess

TRIAGE_STATES = ('needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human')
GH_TIMEOUT_SECONDS = 30
TRACKER_DOC = Path('docs/agents/issue-tracker.md')
REPO_FLAG = re.compile(r'-R\s+`?([\w.-]+/[\w.-]+)`?')


def tracker_repo(workspace):
    """The `owner/repo` the project's tracker doc tells `gh` to use, or None (not a GitHub tracker)."""
    try:
        text = (Path(workspace) / TRACKER_DOC).read_text(encoding='utf-8')
    except (OSError, UnicodeError):
        return None
    found = REPO_FLAG.search(text)
    return found.group(1) if found else None


def read_issue(repo, number, timeout=GH_TIMEOUT_SECONDS):
    """The issue as `gh api` returns it; raises ValueError when gh fails or answers oddly."""
    command = ['gh', 'api', f'repos/{repo}/issues/{number}']
    try:
        result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as error:
        raise ValueError(f'gh 無法執行：{error}') from error
    if result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or f'gh exit {result.returncode}')
    try:
        issue = json.loads(result.stdout)
        if not (isinstance(issue, dict) and isinstance(issue.get('state'), str)
                and isinstance(issue.get('labels'), list)):
            raise ValueError('缺 state 或 labels')
    except ValueError as error:
        raise ValueError(f'gh 回傳無法解讀：{error}') from error
    return issue


def ledger_tickets(ledger, path, default_repo):
    """Each ledger ticket once, as (repo, number); text that is no ticket number is skipped."""
    seen = {}
    doc = ledger.read_only(type('Args', (), {'ledger': path})())
    for item in doc['items']:
        for repo, ref in sorted(ledger.ticket_refs(item['ticket']), key=str):
            if ref[1:].isdigit():
                seen[(repo or default_repo, int(ref[1:]))] = None
    return list(seen)


def tracker_warnings(ledger, path, workspace):
    """Warning lines for the ledger's tickets, [] when all is in order. A read failure is one line."""
    lines = []
    try:
        default_repo = tracker_repo(workspace)
        if not default_repo:
            return ['tracker 檢查略過：docs/agents/issue-tracker.md 沒有指明 GitHub repo']
        tickets = ledger_tickets(ledger, path, default_repo)
        for repo, number in tickets:
            issue = read_issue(repo, number)
            names = [label.get('name') for label in issue['labels'] if isinstance(label, dict)]
            summary = issue.get('sub_issues_summary') or {}
            if issue['state'] == 'open':
                lines.append(f'- {repo}#{number} 仍開著')
                if summary.get('total') and summary.get('completed') == summary.get('total'):
                    lines.append(f'  - 子票 {summary["total"]} 張全已關閉，這張上層票是否該關')
            else:
                stale = [name for name in names if name in TRIAGE_STATES]
                if stale:
                    command = shlex.join(['gh', 'issue', 'edit', str(number), '-R', repo] + [
                        part for name in stale for part in ('--remove-label', name)])
                    lines.append(f'- {repo}#{number} 已關閉但仍掛 {", ".join(stale)}；移除：`{command}`')
    except Exception as error:  # noqa: BLE001 - a tracker problem only ever costs one line
        detail = " ".join(str(error).split()) or repr(error)
        if not lines:
            return [f'tracker 檢查略過：讀不到 tracker（{detail}）']
        lines.append(f'tracker 檢查中斷：讀不到 tracker（{detail}）；上面只列出中斷前讀到的票')
    return (['LAT tracker 警告（只提醒，不擋；不會自動關票或改標籤）：'] + lines) if lines else []
