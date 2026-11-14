"""Warning-only tracker check for the tickets on a round ledger (never blocks, never writes)."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys

TRIAGE_STATES = ('needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human')
GH_TIMEOUT_SECONDS = 30
TRACKER_DOC = Path('docs/agents/issue-tracker.md')
CLEANUP_LABEL = 'test-cleanup'
CLEANUP_OLD = timedelta(days=7)
GATE_ENV = 'LAT_LEDGER_SUITE_GATE'  # a stand-in suite-gate.py, as lat-ledger.py reads it
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


def cleanup_label(workspace):
    """The cleanup ticket label the project's suite-gate registry names, else the default."""
    try:
        label = json.loads((Path(workspace) / '.suite-gate.json').read_text(encoding='utf-8'))['cleanup']['label']
        return label.strip() if isinstance(label, str) and label.strip() else CLEANUP_LABEL
    except (OSError, ValueError, KeyError, TypeError):
        return CLEANUP_LABEL


def slowest_suite(workspace):
    """(command, median as a share of the baseline) of the project's slowest full suite from the
    suite gate's status, or None when no suite has a judged speed or the gate cannot be read."""
    script = os.environ.get(GATE_ENV) or Path(__file__).resolve().parents[2] / 'three-tier-testing/scripts/suite-gate.py'
    try:
        result = subprocess.run([sys.executable, str(script), 'status', '--json'], text=True,
                                capture_output=True, timeout=GH_TIMEOUT_SECONDS)
        units = json.loads(result.stdout)['cleanup'] if result.returncode == 0 else []
        project = str(Path(workspace).resolve())
        ratios = [(unit['median'] / unit['baseline'], unit['command']) for unit in units
                  if unit['project'] == project and unit.get('median') and unit.get('baseline')]
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None
    if not ratios:
        return None
    ratio, command = max(ratios)
    return command, ratio


def cleanup_lines(repo, workspace, now=None):
    """One line when the project has a cleanup ticket open for more than 7 days, else []."""
    label = cleanup_label(workspace)
    path = f'repos/{repo}/issues?state=open&labels={label}&sort=created&direction=asc&per_page=20'
    result = subprocess.run(['gh', 'api', path], text=True, capture_output=True, timeout=GH_TIMEOUT_SECONDS)
    if result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or f'gh exit {result.returncode}')
    now = now or datetime.now(timezone.utc)
    for issue in json.loads(result.stdout):
        if 'pull_request' in issue:
            continue
        created = datetime.fromisoformat(issue['created_at'].replace('Z', '+00:00'))
        if now - created > CLEANUP_OLD:
            line = f'- 本專案有開著超過 7 天的整理票：[{repo}#{issue["number"]}]({issue["html_url"]})，已開 {(now - created).days} 天'
            slowest = slowest_suite(workspace)
            if slowest:
                line += f'；目前最慢的一套是 `{slowest[0]}`，為基準的 {slowest[1]:.0%}'
            return [line]
    return []


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
        try:
            lines += cleanup_lines(default_repo, workspace)
        except Exception as error:  # noqa: BLE001 - the cleanup check only ever costs one line
            lines.append(f'- 整理票查詢略過（{" ".join(str(error).split()) or repr(error)}）')
    except Exception as error:  # noqa: BLE001 - a tracker problem only ever costs one line
        detail = " ".join(str(error).split()) or repr(error)
        if not lines:
            return [f'tracker 檢查略過：讀不到 tracker（{detail}）']
        lines.append(f'tracker 檢查中斷：讀不到 tracker（{detail}）；上面只列出中斷前讀到的票')
    return (['LAT tracker 警告（只提醒，不擋；不會自動關票或改標籤）：'] + lines) if lines else []
