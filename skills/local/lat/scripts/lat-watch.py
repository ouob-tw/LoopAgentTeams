#!/usr/bin/env python3
"""Watch explicitly registered LAT work for stalled agents (stdlib only)."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lat_decision_status import DecisionStatus, read_decision_status


IDLE_SECONDS = 10 * 60
ACTIVE_SECONDS = 20 * 60
PROMPT_SECONDS = 5 * 60
PROMPT_SETTLE_SECONDS = 1
PROMPT_POLL_SECONDS = 0.05
CHECK_SECONDS = 60
FAILURE_REPEAT_SECONDS = 60 * 60
TRANSCRIPT_TAIL_BYTES = 256 * 1024
# Successful deliveries awaiting a session-record save; retained across retry cycles.
RULE_DELIVERIES = {}
NUDGE = ('[lat-watch] Read any unread HCOM messages and finish all work not blocked by pending '
         'decisions. If nothing remains, declare exactly what you are waiting for '
         'with lat-watch wait.')
NAME_PATTERN = r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}'
NAME = re.compile(NAME_PATTERN)
CARD_AGENT = re.compile(rf'({NAME_PATTERN})(?=$|[\s(（])')
CLIENT_PROFILES = {
    'codex': {
        'error': re.compile(
            r'^■\s+(?:(?P<capacity>Selected model is at capacity\b)|'
            r"(?P<usage>You've hit your usage limit\b))", re.IGNORECASE),
        'model': re.compile(
            r'^\s*((?:GPT|o)[A-Za-z0-9. -]*?)\s+'
            r'(?:minimal|low|medium|high|xhigh|max|ultra)\s+·', re.IGNORECASE),
    },
    'claude': {
        'primary': re.compile(
            r'^●\s+Usage limit reached\s+·\s+continuing automatically at\b',
            re.IGNORECASE),
        'notice': re.compile(
            r'^Usage limit reached\s+·\s+continuing automatically at\b.*'
            r'·\s+esc to cancel$', re.IGNORECASE),
        'footer': re.compile(r'^\s{2}⚠\s+Usage limit reached\b', re.IGNORECASE),
        'model': re.compile(
            r'^\s*((?:Opus|Sonnet|Haiku)[A-Za-z0-9. -]*?)\s+'
            r'(?:low|medium|high|max)\s+·', re.IGNORECASE),
    },
}
RECOVERY_ACTIONS = {
    ('codex', 'model-capacity'): 'switch to another model',
    ('codex', 'usage-limit'): (
        'switch to another subscribed account with quota; Do not switch to API billing; '
        'if no subscribed account is available, the user decides how to continue'),
    ('codex', 'rate-limit'): (
        'switch to another subscribed account with quota; Do not switch to API billing; '
        'if no subscribed account is available, the user decides how to continue'),
}


class Observation(NamedTuple):
    agent: str
    status: str
    prompt_empty: bool
    command_running: bool
    transcript_size: int
    transcript_mtime_ns: int
    event_id: int
    wait_active: bool = False
    wait_released: bool = False
    is_orchestrator: bool = False
    task_card_revision: str = ''
    task_card_updated_at: float = 0
    orchestrator_wait_started_at: float = 0
    input_text: str = ''
    unread_count: int = 0
    client: str = 'unknown'
    model: str = 'unknown'
    quota_issue: object = None


class QuotaIssue(NamedTuple):
    kind: str
    line: str
    reset_time: object = None


class Action(NamedTuple):
    kind: str
    agent: str
    message: str = ''
    text: str = ''
    category: str = ''


class Process(NamedTuple):
    pid: int
    ppid: int
    starttime: int
    state: str
    session: int
    command: tuple
    environment: tuple


def escalation_message(observation, state, now, recipient):
    stalled_minutes = int((now - state['last_progress_at']) // 60)
    nudged_minutes = int((now - state['nudged_at']) // 60)
    reason = state.get('stall_reason', 'no progress after a terminal nudge')
    if recipient == 'orchestrator':
        action_needed = ('inspect the agent and either resume or stop it, update its task '
                         'card, or declare a wait naming this agent.')
        history = (f'Already done: one terminal nudge was injected '
                   f'{nudged_minutes} minutes ago.')
    elif observation.is_orchestrator:
        action_needed = ('return to this orchestrator and resume the authorized work, or '
                         'record exactly what it is waiting for.')
        history = (f'Already done: one terminal nudge was injected '
                   f'{nudged_minutes} minutes ago.')
    else:
        action_needed = ('check the orchestrator and decide whether to resume, stop, or '
                         'reassign the stalled agent.')
        orchestrator_minutes = int((now - state['orchestrator_notified_at']) // 60)
        history = (f'Already done: one terminal nudge; the orchestrator was notified '
                   f'{orchestrator_minutes} minutes ago.')
    return (f'LAT stall watcher: agent {observation.agent} has made no progress for '
            f'{stalled_minutes} minutes. Reason: {reason}. {history} '
            f'Action needed: {action_needed}')


def owner_notice(observation, state, now, reason):
    stalled_minutes = int((now - state['last_progress_at']) // 60)
    if reason == 'active-command':
        detail = 'the screen still shows work running; this may be a possible hung command'
        action_needed = 'inspect the running command and decide whether it should continue'
    else:
        detail = 'the agent is blocked at an approval prompt'
        action_needed = 'open the agent and approve or reject the pending request'
    message = (f'LAT stall watcher: agent {observation.agent} has made no progress for '
               f'{stalled_minutes} minutes and {detail}. No terminal nudge was injected. '
               f'Action needed: {action_needed}.')
    kind = 'notify-user' if observation.is_orchestrator else 'notify-orchestrator'
    return Action(kind, observation.agent, message)


def quota_notice(observation):
    issue = observation.quota_issue
    reset = f' Reset time: {issue.reset_time}.' if issue.reset_time else ''
    action_needed = RECOVERY_ACTIONS.get(
        (observation.client.lower(), issue.kind),
        'the user decides whether to wait or choose another recovery action',
    )
    line_end = '' if issue.line.endswith(('.', '!', '?')) else '.'
    message = (f'LAT stall watcher: quota or model-capacity issue for agent '
               f'{observation.agent}. Client: {observation.client}. Model: '
               f'{observation.model}. Matched line: {issue.line}{line_end}{reset} '
               f'No terminal nudge was injected. Action needed: {action_needed}.')
    kind = 'notify-user' if observation.is_orchestrator else 'notify-orchestrator'
    return Action(kind, observation.agent, message, category='quota')


def quota_reset_time(line):
    end = r'(?:\s+·|\s+Continuing shortly\b|\s+esc to cancel\b|\.(?:\s|$)|$)'
    patterns = (
        rf'\blimit resets\s+(.+?){end}',
        rf'\bresets\s+(.+?){end}',
        rf'\bcontinuing automatically at\s+(.+?){end}',
        rf'\btry again at\s+(.+?){end}',
    )
    for pattern in patterns:
        match = re.search(pattern, line, re.IGNORECASE)
        if match:
            return match.group(1).strip().rstrip('.')
    return None


def screen_separator(line):
    stripped = line.strip()
    return len(stripped) >= 3 and set(stripped) == {'─'}


def screen_message(lines, start):
    """Join wrapped text until the next recognizable client UI boundary."""
    parts = [lines[start].strip()]
    model_patterns = tuple(profile['model'] for profile in CLIENT_PROFILES.values())
    for line in lines[start + 1:start + 5]:
        stripped = line.strip()
        if (not stripped or screen_separator(line)
                or stripped.startswith(('Working (', '• ', '› ', '■ ', '● ', '⚠ ', '✻ ', '⏵'))
                or any(pattern.search(line) for pattern in model_patterns)):
            break
        parts.append(stripped)
    return ' '.join(parts)


def codex_error_is_current(lines, index):
    for line in lines[index + 1:]:
        stripped = line.strip()
        if stripped.startswith('Working (') or line.startswith('• '):
            return False
        if line.startswith('› ') and stripped != '› Ask Codex to do anything':
            return False
    return True


def claude_primary_is_current(lines, index):
    for line in lines[index + 1:]:
        stripped = line.strip()
        if line.startswith('● ') or stripped.startswith('Working'):
            return False
        if line.startswith('❯ ') and stripped != '❯':
            return False
    return True


def current_claude_quota_notice(transcript):
    """Return an unsuperseded Claude system quota notice near transcript EOF."""
    if not isinstance(transcript, (str, Path)):
        return None
    path = Path(transcript)
    try:
        with path.open('rb') as stream:
            stream.seek(0, os.SEEK_END)
            size = stream.tell()
            start = max(0, size - TRANSCRIPT_TAIL_BYTES)
            stream.seek(start)
            data = stream.read()
    except (FileNotFoundError, OSError):
        return None
    lines = data.splitlines()
    if start:
        lines = lines[1:]
    notice = None
    pattern = CLIENT_PROFILES['claude']['notice']
    for raw in lines:
        try:
            record = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(record, dict):
            continue
        content = record.get('content')
        if (record.get('type') == 'system'
                and record.get('subtype') == 'informational'
                and record.get('level') == 'notice'
                and isinstance(content, str) and pattern.search(content)):
            notice = content
        elif notice is not None and record.get('type') in ('user', 'assistant'):
            notice = None
    return notice


def detect_screen_quota(lines, client, claude_notice=None):
    """Match quota UI in the current client turn/status region."""
    if not isinstance(lines, list) or any(not isinstance(line, str) for line in lines):
        raise ValueError('hcom term returned invalid screen lines')
    profile = CLIENT_PROFILES.get(client.lower())
    if profile is None:
        return None
    if 'error' in profile:
        for index in range(len(lines) - 1, -1, -1):
            match = profile['error'].search(lines[index])
            if match and codex_error_is_current(lines, index):
                message = screen_message(lines, index)
                kind = 'model-capacity' if match.group('capacity') else 'usage-limit'
                return QuotaIssue(kind, message, quota_reset_time(message))
        return None

    separators = [index for index, line in enumerate(lines) if screen_separator(line)]
    status_start = separators[-1] if separators else len(lines)
    footers = [index for index in range(status_start + 1, len(lines))
               if profile['footer'].search(lines[index])]
    footer = footers[-1] if footers else None
    if footer is not None:
        message = screen_message(lines, footer)
        return QuotaIssue('usage-limit', message, quota_reset_time(message))

    primaries = [index for index, line in enumerate(lines)
                 if profile['primary'].search(line)
                 and claude_primary_is_current(lines, index)]
    if primaries:
        message = screen_message(lines, primaries[-1])
        reset = quota_reset_time(message)
        visible_notice = re.sub(r'^●\s+', '', message)
        if (isinstance(claude_notice, str)
                and ' '.join(visible_notice.split()) == ' '.join(claude_notice.split())):
            return QuotaIssue('usage-limit', message, reset)
    return None


def hcom_quota_issue(info):
    context = info.get('status_context', info.get('context', ''))
    detail = info.get('status_detail', '')
    if (info.get('status') == 'inactive'
            and (context == 'failure:rate_limit' or detail == 'rate_limit')):
        return QuotaIssue('rate-limit', 'inactive (failure:rate_limit)')
    return None


def screen_model(lines, client):
    if not isinstance(lines, list):
        return 'unknown'
    profile = CLIENT_PROFILES.get(client.lower())
    if profile is None:
        return 'unknown'
    for line in reversed(lines):
        match = profile['model'].search(line)
        if match:
            return match.group(1).strip()
    return 'unknown'


def prompt_digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def validated_unread_count(info, agent):
    unread_count = info.get('unread_count', 0)
    if (not isinstance(unread_count, int) or isinstance(unread_count, bool)
            or unread_count < 0):
        raise ValueError(f'hcom list returned invalid unread_count for {agent}')
    return unread_count


def decide(previous, observation, now):
    """Return serializable state and requested actions for one observation."""
    fingerprint = [observation.transcript_size, observation.transcript_mtime_ns,
                   observation.event_id]
    progressed = previous is None or previous.get('fingerprint') != fingerprint
    quota_cleared = bool(previous and previous.get('quota_active')
                         and observation.quota_issue is None)
    reset = progressed or observation.wait_released or quota_cleared
    if reset:
        state = {
            'fingerprint': fingerprint,
            'last_progress_at': now,
            'nudged': False,
            'orchestrator_notified': False,
            'orchestrator_handled': False,
            'user_notified': False,
            'quota_notified': False,
            'quota_active': observation.quota_issue is not None,
        }
    else:
        state = dict(previous)
        state.setdefault('orchestrator_notified', False)
        state.setdefault('orchestrator_handled', False)
        state.setdefault('user_notified', False)
        state.setdefault('quota_notified', False)
        state['quota_active'] = observation.quota_issue is not None
        if state.get('nudged') and 'nudged_at' not in state:
            state['nudged_at'] = now
    queued_prompt = (not observation.prompt_empty and bool(observation.input_text)
                     and observation.unread_count > 0)
    prompt_hash = prompt_digest(observation.input_text)
    previous_prompt_hash = previous.get('prompt_text_hash') if previous else None
    if previous and previous_prompt_hash is None and 'prompt_text' in previous:
        previous_prompt_hash = prompt_digest(previous['prompt_text'])
    same_prompt = (queued_prompt and previous is not None
                   and previous_prompt_hash == prompt_hash)
    uncertain_recovery = (queued_prompt and previous is not None
                          and previous.get('prompt_recovery_uncertain', False))
    if queued_prompt:
        state.pop('prompt_text', None)
        state['prompt_text_hash'] = prompt_hash
        state['prompt_text_since'] = (
            previous.get('prompt_text_since', now) if same_prompt else now)
        if uncertain_recovery:
            state['prompt_recovery_attempted'] = True
            state.pop('prompt_recovery_uncertain', None)
        else:
            state['prompt_recovery_attempted'] = (
                previous.get('prompt_recovery_attempted', False) if same_prompt else False)
    else:
        state.pop('prompt_text', None)
        state.pop('prompt_text_hash', None)
        state.pop('prompt_text_since', None)
        state.pop('prompt_recovery_attempted', None)
        state.pop('prompt_recovery_uncertain', None)
    actions = ()
    if observation.quota_issue is None:
        state['quota_notified'] = False
    stalled = now - state['last_progress_at'] >= IDLE_SECONDS
    active_stalled = now - state['last_progress_at'] >= ACTIVE_SECONDS
    orchestrator_notified_at = state.get('orchestrator_notified_at', now + 1)
    orchestrator_deadline = orchestrator_notified_at + IDLE_SECONDS
    card_handled = (observation.task_card_revision
                    != state.get('orchestrator_notice_task_revision', '')
                    and orchestrator_notified_at <= observation.task_card_updated_at
                    <= orchestrator_deadline)
    wait_handled = (observation.orchestrator_wait_started_at > 0
                    and orchestrator_notified_at
                    <= observation.orchestrator_wait_started_at
                    <= orchestrator_deadline)
    orchestrator_handled = (state.get('orchestrator_notified')
                            and not state.get('orchestrator_handled')
                            and not observation.is_orchestrator
                            and (card_handled or wait_handled))
    if orchestrator_handled:
        state['orchestrator_handled'] = True
    prompt_stalled = (queued_prompt
                      and now - state['prompt_text_since'] >= PROMPT_SECONDS)
    if observation.quota_issue is not None and not state['quota_notified']:
        actions = (quota_notice(observation),)
        state['quota_notified'] = True
    elif observation.quota_issue is not None:
        pass
    elif prompt_stalled and not state['prompt_recovery_attempted']:
        actions = (Action(
            'recover-prompt', observation.agent, text=observation.input_text),)
        state['prompt_recovery_attempted'] = True
    elif (stalled and not observation.wait_active and not state['nudged']
            and observation.status == 'listening'
            and observation.prompt_empty and not observation.command_running):
        actions = (Action('nudge', observation.agent),)
        state['nudged'] = True
        state['nudged_at'] = now
        state['stall_reason'] = 'listening at an empty prompt with no command running'
    elif (active_stalled and not observation.wait_active and not state['nudged']
          and observation.status == 'active'
          and observation.prompt_empty and not observation.command_running):
        actions = (Action('nudge', observation.agent),)
        state['nudged'] = True
        state['nudged_at'] = now
        state['stall_reason'] = 'active status but terminal ready at an empty prompt'
    elif (state['nudged'] and not observation.wait_active
          and observation.prompt_empty and not observation.command_running
          and now - state['nudged_at'] >= IDLE_SECONDS):
        if observation.is_orchestrator and not state.get('user_notified'):
            actions = (Action(
                'notify-user', observation.agent,
                escalation_message(observation, state, now, 'user'),
            ),)
            state['user_notified'] = True
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_notified')):
            actions = (Action(
                'notify-orchestrator', observation.agent,
                escalation_message(observation, state, now, 'orchestrator'),
            ),)
            state['orchestrator_notified'] = True
            state['orchestrator_notified_at'] = now
            state['orchestrator_notice_task_revision'] = observation.task_card_revision
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_handled')
              and not state.get('user_notified')
              and now - state['orchestrator_notified_at'] >= IDLE_SECONDS):
            actions = (Action(
                'notify-user', observation.agent,
                escalation_message(observation, state, now, 'user'),
            ),)
            state['user_notified'] = True
    elif (active_stalled and not observation.wait_active
          and observation.status == 'active' and observation.command_running):
        if observation.is_orchestrator and not state.get('user_notified'):
            actions = (owner_notice(observation, state, now, 'active-command'),)
            state['user_notified'] = True
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_notified')):
            actions = (owner_notice(observation, state, now, 'active-command'),)
            state['orchestrator_notified'] = True
            state['orchestrator_notified_at'] = now
            state['orchestrator_notice_task_revision'] = observation.task_card_revision
    elif (stalled and not observation.wait_active and observation.status == 'blocked'):
        if observation.is_orchestrator and not state.get('user_notified'):
            actions = (owner_notice(observation, state, now, 'blocked'),)
            state['user_notified'] = True
        elif (not observation.is_orchestrator
              and not state.get('orchestrator_notified')):
            actions = (owner_notice(observation, state, now, 'blocked'),)
            state['orchestrator_notified'] = True
            state['orchestrator_notified_at'] = now
            state['orchestrator_notice_task_revision'] = observation.task_card_revision
    if actions:
        state['decision'] = ('quota-issue' if actions[0].category == 'quota'
                             else actions[0].kind)
    elif state.get('orchestrator_handled'):
        state['decision'] = 'orchestrator-handled'
    elif observation.wait_active:
        state['decision'] = 'valid-wait'
    elif observation.command_running:
        state['decision'] = 'command-running'
    elif queued_prompt and state.get('prompt_recovery_attempted'):
        state['decision'] = 'prompt-recovery-attempted'
    elif queued_prompt:
        state['decision'] = 'prompt-text-wait'
    elif not observation.prompt_empty:
        state['decision'] = 'prompt-not-empty'
    elif observation.status != 'listening':
        state['decision'] = 'not-listening'
    elif reset:
        state['decision'] = 'progress'
    elif state['nudged']:
        state['decision'] = 'already-nudged'
    else:
        state['decision'] = 'within-idle-threshold'
    return state, actions


def valid_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise ValueError(f'Invalid HCOM name: {value!r}')
    return value


def watch_dir(workspace):
    return workspace / '.lat/watch'


def wait_path(workspace, agent):
    return watch_dir(workspace) / 'waits' / f'{valid_name(agent)}.json'


def state_path(workspace, orchestrator):
    return watch_dir(workspace) / valid_name(orchestrator) / 'state.json'


def read_object(path, default=None):
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return default
    if not isinstance(value, dict):
        raise ValueError(f'Expected a JSON object: {path}')
    return value


def rule_fingerprint(skill_dir):
    """Hash rule-file contents by relative name, excluding generated caches."""
    skill_dir = skill_dir.resolve(strict=True)
    files = [skill_dir / 'SKILL.md']
    caches = {'__pycache__', '.cache', '.pytest_cache', '.mypy_cache', '.ruff_cache'}
    for path in (skill_dir / 'references').rglob('*'):
        relative = path.relative_to(skill_dir)
        if (path.is_file() and not caches.intersection(relative.parts)
                and path.suffix not in ('.pyc', '.pyo')):
            files.append(path)
    return {path.relative_to(skill_dir).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(files) if path.is_file()}


def write_object(path, value, *, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    original = expected if expected is not None else (path.read_bytes() if path.exists() else None)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        try:
            json.dump(value, stream, indent=2, ensure_ascii=False)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
            current = path.read_bytes() if path.exists() else None
            if current != original:
                raise ValueError(f'Concurrent change detected: {path}')
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)


def run_command(command, failure=None):
    result = subprocess.run(command, text=True, capture_output=True)
    if result.returncode:
        detail = result.stderr.strip() or result.stdout.strip() or f'exit {result.returncode}'
        message = failure or f'{command[0]} failed'
        raise ValueError(f'{message}: {detail}')
    return result.stdout


def run_json(command):
    try:
        return json.loads(run_command(command))
    except json.JSONDecodeError as error:
        raise ValueError(f'{command[0]} returned invalid JSON') from error


def run_json_lines(command):
    try:
        return [json.loads(line) for line in run_command(command).splitlines() if line.strip()]
    except json.JSONDecodeError as error:
        raise ValueError(f'{command[0]} returned invalid JSON Lines') from error


def parse_task(path):
    fields = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r'-\s+(agent|orchestrator|status|next step)：\s*(.*)', line)
        if match:
            fields[match.group(1)] = match.group(2).strip()
    return fields


def task_agent(field):
    match = CARD_AGENT.match(field)
    if not match:
        raise ValueError(f'agent field must start with an HCOM name: {field!r}')
    return match.group(1)


def card_digest(path, error):
    try:
        content = path.read_bytes()
    except OSError:
        content = str(error).encode()
    return hashlib.sha256(content).hexdigest()


def monitored_task_cards(tasks, orchestrator):
    """Return (cards by agent, skipped {card name: (digest, error)})."""
    cards, skipped = {}, {}
    if not tasks.is_dir():
        raise ValueError(f'Missing task-card directory: {tasks}')
    for path in sorted(tasks.glob('*.md')):
        try:
            card = parse_task(path)
            if card.get('orchestrator', orchestrator) != orchestrator:
                continue
            missing = [name for name in ('agent', 'orchestrator', 'status')
                       if name not in card]
            if missing:
                raise ValueError(f'missing task-card fields: {", ".join(missing)}')
            if card['status'] != 'merged':
                card['agent'] = task_agent(card['agent'])
                card['_updated_at'] = path.stat().st_mtime
                cards.setdefault(card['agent'], card)
        except (OSError, ValueError) as error:
            skipped[path.name] = (card_digest(path, error), str(error))
    return cards, skipped


def monitored_agents(tasks, orchestrator):
    cards, _ = monitored_task_cards(tasks, orchestrator)
    return [valid_name(orchestrator), *cards]


def read_watch_file(path, log, now):
    """Read a watcher-owned JSON object; move a corrupt file aside and start fresh."""
    try:
        return read_object(path, {})
    except ValueError as error:
        kept = path.with_name(f'{path.name}.corrupt-{int(now)}')
        path.replace(kept)
        append_log(log, {
            'at': now, 'decision': 'state-file-reset', 'actions': [],
            'file': path.name, 'kept': kept.name, 'error': str(error),
        })
        return {}


def reset_agent_state(path, log, now, agent, error):
    """Keep one copy of the state file for diagnosis, then log the agent's fresh start."""
    kept = path.with_name(f'{path.name}.corrupt-{int(now)}')
    if path.exists() and not kept.exists():
        shutil.copy2(path, kept)
    append_log(log, {
        'at': now, 'agent': agent, 'decision': 'agent-state-reset', 'actions': [],
        'kept': kept.name, 'error': error,
    })


def log_skipped_cards(path, log, skipped, now):
    """Log each skipped card once per content; forget cards that are fixed or gone."""
    logged = read_watch_file(path, log, now)
    current = {}
    for name, (digest, error) in skipped.items():
        seen = logged.get(name, [])
        if digest not in seen:
            append_log(log, {
                'at': now, 'card': name, 'decision': 'task-card-skipped',
                'actions': [], 'error': error,
            })
            seen = [*seen, digest]
        current[name] = seen
    if current != logged:
        write_object(path, current)


def task_card_revision(card):
    if card is None:
        return ''
    return json.dumps([card['status'], card.get('next step', '')], ensure_ascii=False)


def list_hcom(orchestrator):
    value = run_json(['hcom', 'list', '--json', '--name', orchestrator])
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError('hcom list returned an invalid agent list')
    return {item.get('name'): item for item in value if isinstance(item.get('name'), str)}


def event_value(event, name, nested):
    data = event.get('data', {})
    containers = [event, data]
    for container in tuple(containers):
        child = container.get(nested, {}) if isinstance(container, dict) else {}
        if isinstance(child, dict):
            containers.append(child)
    for container in containers:
        if isinstance(container, dict) and name in container:
            return container[name]
    return None


def status_context(event):
    if event.get('type') != 'status':
        return None
    return event_value(event, 'status_context', 'status') or event_value(
        event, 'context', 'status')


def read_processes(proc_root=Path('/proc')):
    processes = []
    for directory in proc_root.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            _comm, separator, fields = (directory / 'stat').read_text().rpartition(') ')
            if not separator:
                continue
            stat = fields.split()
            command = tuple(
                value.decode(errors='replace')
                for value in (directory / 'cmdline').read_bytes().split(b'\0') if value
            )
            environment = tuple(
                value.decode(errors='replace')
                for value in (directory / 'environ').read_bytes().split(b'\0') if value
            )
            processes.append(Process(int(directory.name), int(stat[1]), int(stat[19]),
                                     stat[0], int(stat[3]), command, environment))
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, IndexError):
            continue
    return processes


def process_ancestors(pid, parents):
    ancestors = set()
    while pid in parents and parents[pid] not in ancestors:
        pid = parents[pid]
        ancestors.add(pid)
    return ancestors


def descendants_below(pid, parents, roots):
    """Return (root, lineage below it), or None when unrelated."""
    lineage = []
    seen = set()
    while pid in parents and pid not in seen:
        if pid in roots:
            return pid, lineage
        seen.add(pid)
        lineage.append(pid)
        pid = parents[pid]
    return (pid, lineage) if pid in roots else None


def background_process_running(agent, info, processes, current_pid=None):
    """Detect a surviving command tied to the HCOM-bound client process."""
    identity = info.get('launch_context', {}).get('pid_identity', '')
    try:
        client_starttime = int(identity.rsplit(':', 1)[1])
    except (AttributeError, ValueError, IndexError):
        return False
    clients = {process.pid for process in processes
               if process.starttime == client_starttime}
    if not clients:
        return False
    process_by_pid = {process.pid: process for process in processes}
    parents = {process.pid: process.ppid for process in processes}
    current_pid = os.getpid() if current_pid is None else current_pid
    excluded = process_ancestors(current_pid, parents) | {current_pid}
    for client in clients:
        excluded |= process_ancestors(client, parents)
    name_marker = f'HCOM_INSTANCE_NAME={agent}'
    client_sessions = {process_by_pid[pid].session for pid in clients}
    for process in processes:
        if process.pid in clients or process.pid in excluded or process.state == 'Z':
            continue
        provenance = descendants_below(process.pid, parents, clients)
        same_agent = name_marker in process.environment
        belongs_to_client = provenance is not None
        if not same_agent and not belongs_to_client:
            continue
        if belongs_to_client:
            client, lineage = provenance
            # Tool commands run in a separate session. Resident MCP/language-server
            # helpers inherit the client session even when the client was shell-launched.
            if any(process_by_pid[pid].session != process_by_pid[client].session
                   for pid in lineage):
                return True
            continue
        # A detached tool may be reparented after its shell exits; its HCOM marker
        # and separate session retain provenance without guessing from executable names.
        if process.session not in client_sessions:
            return True
    return False


def wait_release_reason(declaration, participant_events, target_replied, decision_pending):
    """Explain why a wait is no longer valid, or return None."""
    if target_replied:
        return 'target-replied'
    for event in participant_events:
        context = status_context(event)
        if isinstance(context, str) and context.startswith('deliver:'):
            return 'message-delivered'
    if decision_pending is False:
        return 'decision-resolved'
    return None


def pending_decision(decisions, target, *, log=None, agent=None):
    matches = [path for path in decisions.glob(f'{target}*') if path.is_file()]
    if not matches:
        return None
    pending = False
    for path in matches:
        try:
            status = read_decision_status(path)
        except (OSError, UnicodeError) as error:
            status = DecisionStatus(None, str(error))
        if status.error:
            pending = True
            if log is not None:
                append_log(log, {
                    'at': time.time(), 'agent': agent,
                    'decision': 'decision-status-unreadable', 'actions': [],
                    'file': str(path), 'error': status.error,
                    'target': target, 'treated_as_pending': True,
                })
        elif status.status == 'pending':
            pending = True
    return pending


def latest_event_id(events):
    ids = []
    for event in events:
        value = event.get('id')
        if isinstance(value, int):
            ids.append(value)
        elif isinstance(value, str) and value.isdigit():
            ids.append(int(value))
    return max(ids, default=0)


def hcom_events(orchestrator, *filters):
    return run_json_lines(['hcom', 'events', *filters, '--full', '--name', orchestrator])


def agent_info(agents, name):
    """Resolve a canonical name, or an unambiguous base name, from hcom list."""
    if name in agents:
        return agents[name]
    matches = [item for item in agents.values() if item.get('base_name') == name]
    return matches[0] if len(matches) == 1 else None


def session_events(orchestrator, info, *filters):
    """Read only events carrying the exact session identity from hcom list."""
    session_id = info.get('session_id') if isinstance(info, dict) else None
    if not isinstance(session_id, str) or not session_id:
        return []
    quoted = session_id.replace("'", "''")
    events = hcom_events(
        orchestrator, *filters,
        '--sql', f"json_extract(data, '$.session') = '{quoted}'",
    )
    return [event for event in events
            if event_value(event, 'session', 'status') == session_id]


def after_timestamp(value, threshold):
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        boundary = datetime.fromisoformat(threshold.replace('Z', '+00:00'))
    except (AttributeError, TypeError, ValueError):
        return False
    try:
        return parsed >= boundary
    except TypeError:
        return False


def hcom_send_command(value):
    return (isinstance(value, str)
            and re.search(r'(?:^|&&|\|\||[;|\r\n])\s*hcom\s+send(?:\s|$)', value)
            is not None)


def successful_send_output(value, recipient=None):
    if not isinstance(value, str):
        return False
    matches = re.findall(r'^Sent to:\s*(.+)$', value, re.MULTILINE)
    if recipient is None:
        return bool(matches)
    if not isinstance(recipient, str) or not recipient:
        return False
    pattern = rf'(?<![A-Za-z0-9_-]){re.escape(recipient)}(?![A-Za-z0-9_-])'
    return any(re.search(pattern, recipients) for recipients in matches)


def successful_hcom_send_since(transcript, declared_at, recipient=None):
    """Find a completed hcom send in one exact agent transcript."""
    claude_hcom_send_ids = set()
    try:
        lines = Path(transcript).open()
    except (FileNotFoundError, OSError):
        return False
    with lines:
        for line in lines:
            try:
                record = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(record, dict):
                continue
            completed_after_wait = after_timestamp(record.get('timestamp'), declared_at)

            message = record.get('message', {})
            content = message.get('content', []) if isinstance(message, dict) else []
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict):
                        continue
                    command = item.get('input', {}).get('command') \
                        if isinstance(item.get('input'), dict) else None
                    if (item.get('type') == 'tool_use' and item.get('name') == 'Bash'
                            and isinstance(item.get('id'), str)
                            and hcom_send_command(command)):
                        claude_hcom_send_ids.add(item['id'])
                    if (completed_after_wait and item.get('type') == 'tool_result'
                            and item.get('tool_use_id') in claude_hcom_send_ids
                            and item.get('is_error') is False
                            and successful_send_output(
                                item.get('content'), recipient=recipient)):
                        return True

            if not completed_after_wait:
                continue

            payload = record.get('payload', {})
            item = payload.get('item', {}) if isinstance(payload, dict) else {}
            if not isinstance(item, dict):
                item = {}
            command = item.get('command') if isinstance(item, dict) else None
            shell_command = command[-1] if isinstance(command, list) and command else None
            if (record.get('type') == 'event_msg'
                    and payload.get('type') == 'item_completed'
                    and item.get('type') == 'CommandExecution'
                    and hcom_send_command(shell_command)
                    and item.get('status') == 'completed'
                    and item.get('exit_code') == 0
                    and successful_send_output(
                        item.get('stdout'), recipient=recipient)):
                return True
    return False


def release_wait_if_needed(workspace, decisions, orchestrator, declaration, agents=None):
    if not declaration or not declaration.get('active', True):
        return None
    after = declaration['declared_at_utc']
    agent = declaration['agent']
    target = declaration['target']
    agents = list_hcom(orchestrator) if agents is None else agents
    waiting_info = agent_info(agents, agent)
    participant = session_events(
        orchestrator, waiting_info, '--after', after)
    decision = pending_decision(
        decisions, target,
        log=state_path(workspace, orchestrator).with_name('watch.jsonl'), agent=agent)
    target_info = agent_info(agents, target)
    transcript = target_info.get('transcript_path') if target_info else None
    waiting_name = waiting_info.get('name') if waiting_info else None
    target_replied = bool(
        decision is None and transcript and waiting_name
        and successful_hcom_send_since(transcript, after, waiting_name))
    reason = wait_release_reason(declaration, participant, target_replied, decision)
    if reason:
        updated = dict(declaration, active=False, released_reason=reason,
                       released_at_utc=datetime.now(timezone.utc).isoformat())
        write_object(wait_path(workspace, agent), updated)
    return reason


def observe(workspace, decisions, orchestrator, agent, info, card=None):
    status_issue = hcom_quota_issue(info)
    try:
        terminal = run_json(['hcom', 'term', agent, '--json', '--name', orchestrator])
    except (OSError, ValueError):
        if status_issue is None:
            raise
        terminal = {'ready': True, 'prompt_empty': True, 'input_text': '', 'lines': []}
    if not isinstance(terminal, dict):
        raise ValueError(f'hcom term returned invalid data for {agent}')
    if not isinstance(terminal.get('ready'), bool):
        raise ValueError(f'hcom term omitted boolean ready for {agent}')
    input_text = terminal.get('input_text', '')
    if input_text is None:
        input_text = ''
    elif not isinstance(input_text, str):
        raise ValueError(f'hcom term returned invalid input_text for {agent}')
    lines = terminal.get('lines', [])
    client = info.get('tool', 'unknown')
    if not isinstance(client, str):
        client = 'unknown'
    transcript = info.get('transcript_path')
    claude_notice = current_claude_quota_notice(transcript)
    screen_issue = detect_screen_quota(lines, client, claude_notice=claude_notice)
    prompt_empty = terminal.get('prompt_empty')
    if not isinstance(prompt_empty, bool):
        if info.get('status') == 'blocked' or screen_issue or status_issue:
            prompt_empty = False
        else:
            raise ValueError(f'hcom term omitted boolean prompt_empty for {agent}')
    model = info.get('model')
    if not isinstance(model, str) or not model:
        model = screen_model(lines, client)
    unread_count = validated_unread_count(info, agent)
    transcript_size = 0
    transcript_mtime_ns = 0
    if isinstance(transcript, str) and transcript:
        try:
            stat = Path(transcript).stat()
            transcript_size = stat.st_size
            transcript_mtime_ns = stat.st_mtime_ns
        except FileNotFoundError:
            pass
    own_events = session_events(orchestrator, info, '--last', '1')
    event_id = latest_event_id(own_events)
    declaration = read_object(wait_path(workspace, agent))
    released = release_wait_if_needed(
        workspace, decisions, orchestrator, declaration)
    active_wait = bool(declaration and declaration.get('active', True) and not released)
    orchestrator_wait_started_at = 0
    if agent != orchestrator:
        orchestrator_wait = read_object(wait_path(workspace, orchestrator))
        if orchestrator_wait and orchestrator_wait.get('target') == agent:
            declared_at = orchestrator_wait.get('declared_at', 0)
            if isinstance(declared_at, (int, float)):
                orchestrator_wait_started_at = declared_at
    ready = terminal.get('ready') is True
    background_running = background_process_running(agent, info, read_processes())
    return Observation(
        agent=agent,
        status=info.get('status', 'missing'),
        prompt_empty=prompt_empty,
        command_running=not ready or background_running,
        transcript_size=transcript_size,
        transcript_mtime_ns=transcript_mtime_ns,
        event_id=event_id,
        wait_active=active_wait,
        wait_released=released is not None,
        is_orchestrator=agent == orchestrator,
        task_card_revision=task_card_revision(card),
        task_card_updated_at=card.get('_updated_at', 0) if card else 0,
        orchestrator_wait_started_at=orchestrator_wait_started_at,
        input_text=input_text,
        unread_count=unread_count,
        client=client,
        model=model,
        quota_issue=screen_issue or status_issue,
    )


def append_log(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def action_record(action):
    record = {'kind': action.kind, 'agent': action.agent}
    if action.message:
        record['message'] = action.message
    if action.category:
        record['category'] = action.category
    return record


def perform_nudge(action, orchestrator, workspace=None):
    run_command(
        ['hcom', 'term', 'inject', action.agent, NUDGE,
         '--enter', '--name', orchestrator],
        failure=f'hcom inject failed for {action.agent}',
    )
    return {'delivery': 'terminal'}


def send_notification(action, orchestrator, intent):
    run_command(
        ['hcom', 'send', f'@{orchestrator}', '--intent', intent,
         '--from', 'lat-watch', '--name', orchestrator, '--', action.message],
        failure=f'hcom notification failed for {orchestrator}',
    )


def perform_notify_orchestrator(action, orchestrator, workspace=None):
    send_notification(action, orchestrator, 'request')
    return {'delivery': 'hcom'}


def perform_notify_user(action, orchestrator, workspace=None):
    send_notification(action, orchestrator, 'inform')
    try:
        run_command(
            ['herdr', 'notification', 'show', 'LAT needs attention',
             '--body', action.message, '--sound', 'request'],
            failure='Herdr notification failed',
        )
    except (OSError, ValueError) as error:
        return {'delivery': 'hcom-only', 'herdr_error': str(error)}
    return {'delivery': 'hcom+herdr'}


def backup_prompt_text(workspace, agent, text):
    directory = watch_dir(workspace)
    directory.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        dir=directory, prefix=f'prompt-{valid_name(agent)}-', suffix='.txt')
    path = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            descriptor = -1
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        path.unlink(missing_ok=True)
        raise
    return path


def read_terminal_input(agent, orchestrator):
    terminal = run_json(['hcom', 'term', agent, '--json', '--name', orchestrator])
    text = terminal.get('input_text') if isinstance(terminal, dict) else None
    if not isinstance(text, str):
        raise ValueError(f'hcom term omitted input_text for {agent}')
    return text


def wait_for_terminal_edit(agent, orchestrator, previous):
    """Poll briefly for a keypress to appear in the terminal snapshot."""
    deadline = time.monotonic() + PROMPT_SETTLE_SECONDS
    while True:
        current = read_terminal_input(agent, orchestrator)
        if current != previous or time.monotonic() >= deadline:
            return current
        time.sleep(PROMPT_POLL_SECONDS)


def read_prompt_status(agent, orchestrator):
    info = list_hcom(orchestrator).get(agent)
    if info is None:
        raise ValueError(f'agent missing from hcom list: {agent}')
    unread_count = validated_unread_count(info, agent)
    text = read_terminal_input(agent, orchestrator)
    return text, unread_count


def prompt_excerpt(text, limit=20):
    compact = ' '.join(text.splitlines())
    return compact if len(compact) <= limit else compact[:limit] + '…'


def send_prompt_notification(orchestrator, message, popup):
    result = {}
    try:
        send_notification(Action('notify-user', orchestrator, message), orchestrator, 'inform')
        result['hcom'] = 'done'
    except (OSError, ValueError) as error:
        result['hcom'] = 'failed'
        result['hcom_error'] = str(error)
    try:
        run_command(
            ['herdr', 'notification', 'show', 'LAT needs attention',
             '--body', popup, '--sound', 'request'],
            failure='Herdr notification failed',
        )
        result['herdr'] = 'done'
    except (OSError, ValueError) as error:
        result['herdr'] = 'failed'
        result['herdr_error'] = str(error)
    return result


def perform_prompt_recovery(action, orchestrator, workspace=None):
    if workspace is None:
        raise ValueError('Prompt recovery requires a workspace')
    excerpt = prompt_excerpt(action.text)
    try:
        saved = backup_prompt_text(workspace, action.agent, action.text)
    except (OSError, ValueError) as error:
        reason = 'prompt text backup failed; input not cleared'
        message = (f'LAT stall watcher: agent {action.agent}. Reason: {reason}: {error}. '
                   f'Original prompt text:\n{action.text}')
        popup = (f'{action.agent}: backup failed; input not cleared. '
                 f'Excerpt: {excerpt!r}. No saved file.')
        return {'reason': reason, **send_prompt_notification(
            orchestrator, message, popup)}

    backspaces = 0
    reason = 'prompt text backed up and cleared'
    rearm = False
    uncertain = False
    try:
        current, unread_count = read_prompt_status(action.agent, orchestrator)
    except (OSError, ValueError) as error:
        current = action.text
        unread_count = 0
        reason = f'prompt clear could not be confirmed; no retry: {error}'
    if reason == 'prompt text backed up and cleared' and current != action.text:
        reason = 'prompt text changed before clearing; not cleared'
        rearm = True
    elif reason == 'prompt text backed up and cleared' and unread_count == 0:
        reason = 'queued messages no longer present; input not cleared'
    while reason == 'prompt text backed up and cleared' and current:
        try:
            run_command(
                ['hcom', 'term', 'inject', action.agent, '\x7f',
                 '--name', orchestrator],
                failure=f'hcom backspace failed for {action.agent}',
            )
            backspaces += 1
            updated = wait_for_terminal_edit(action.agent, orchestrator, current)
        except (OSError, ValueError) as error:
            uncertain = True
            reason = f'prompt clear could not be confirmed; no retry: {error}'
            break
        if len(updated) >= len(current):
            reason = ('input text not editable (possible tool UI text)'
                      if backspaces == 1 else 'prompt text did not clear; no retry')
            break
        if not current.startswith(updated):
            reason = 'prompt text changed while clearing; stopped'
            current = updated
            break
        current = updated

    saved_text = str(saved)
    message = (f'LAT stall watcher: agent {action.agent}. Reason: {reason}. '
               f'Saved file: {saved_text}. Backspaces sent: {backspaces}. '
               f'Original prompt text:\n{action.text}')
    popup = (f'{action.agent}: {reason}. Excerpt: {excerpt!r}. '
             f'Saved file: {saved_text}')
    return {
        'reason': reason,
        'saved_path': saved_text,
        'backspaces': backspaces,
        '_remaining_input': current,
        '_prompt_rearm': rearm,
        '_prompt_uncertain': uncertain,
        **send_prompt_notification(orchestrator, message, popup),
    }


def apply_prompt_recovery_result(state, result, now):
    remaining = result.pop('_remaining_input', None)
    rearm = result.pop('_prompt_rearm', False)
    uncertain = result.pop('_prompt_uncertain', False)
    if remaining is None:
        return
    if remaining:
        state.pop('prompt_text', None)
        state['prompt_text_hash'] = prompt_digest(remaining)
        state['prompt_recovery_attempted'] = not rearm
        if uncertain:
            state['prompt_recovery_uncertain'] = True
            state['prompt_recovery_attempted'] = True
        if rearm:
            state['prompt_text_since'] = now
    else:
        state.pop('prompt_text', None)
        state.pop('prompt_text_hash', None)
        state.pop('prompt_text_since', None)
        state.pop('prompt_recovery_attempted', None)


def observation_record(observation):
    record = observation._asdict()
    text = record.pop('input_text')
    record['input_text_length'] = len(text)
    return record


ACTION_POLICIES = {
    'nudge': (perform_nudge, 'nudged', ('nudged_at',)),
    'notify-orchestrator': (
        perform_notify_orchestrator,
        'orchestrator_notified',
        ('orchestrator_notified_at', 'orchestrator_notice_task_revision'),
    ),
    'notify-user': (perform_notify_user, 'user_notified', ()),
    'recover-prompt': (perform_prompt_recovery, None, ()),
}


def action_policy(kind):
    try:
        return ACTION_POLICIES[kind]
    except KeyError as error:
        raise ValueError(f'Unsupported watch action: {kind}') from error


def perform(action, orchestrator, workspace=None):
    handler, _flag, _cleanup_fields = action_policy(action.kind)
    return handler(action, valid_name(orchestrator), workspace)


def roll_back(action, state):
    _handler, flag, cleanup_fields = action_policy(action.kind)
    if action.category == 'quota':
        state['quota_notified'] = False
        return
    if flag is not None:
        state[flag] = False
    for field in cleanup_fields:
        state.pop(field, None)


def check_rule_changes(workspace, orchestrator, log, now):
    """Advance each owning session's rule baseline only after delivery succeeds."""
    for path in sorted((workspace / '.lat/sessions').glob('*.json')):
        try:
            lock_path = watch_dir(workspace) / f'{path.stem}.lock'
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                original = path.read_bytes()
                record = json.loads(original)
                if not isinstance(record, dict):
                    raise ValueError(f'Expected a JSON object: {path}')
                expected = dict(role='orchestrator', status='active',
                                workspace=str(workspace), hcom_name=orchestrator,
                                session_id=path.stem)
                if any(record.get(key) != value for key, value in expected.items()):
                    continue
                current = rule_fingerprint(Path(record['skill_dir']))
                delivery_key = (str(path), record['skill_dir'])
                delivery = RULE_DELIVERIES.get(delivery_key)
                baseline = delivery['fingerprint'] if delivery else record.get('rule_fingerprint')
                if baseline is None:
                    record['rule_fingerprint'] = current
                    write_object(path, record, expected=original)
                    continue
                if not isinstance(baseline, dict):
                    raise ValueError('Expected a rule fingerprint object')
                changed = sorted(name for name in baseline.keys() | current.keys()
                                 if baseline.get(name) != current.get(name))
                if not changed and delivery_key not in RULE_DELIVERIES:
                    continue
                if changed:
                    message = ('LAT skill rules updated. Changed files: '
                               + ', '.join(changed)
                               + '. Please re-read SKILL.md and the changed references in '
                               + record['skill_dir']
                               + '; removed files are no longer available. Continue without '
                               'asking the user to re-enter /lat.')
                    send_notification(Action('notify-orchestrator', orchestrator, message),
                                      orchestrator, 'request')
                    RULE_DELIVERIES[delivery_key] = {'fingerprint': current, 'changed_files': changed}
                record['rule_fingerprint'] = current
                write_object(path, record, expected=original)
                delivered = RULE_DELIVERIES.pop(delivery_key)
                append_log(log, {'at': now, 'agent': orchestrator,
                                 'decision': 'skill-rules-updated',
                                 'changed_files': delivered['changed_files'],
                                 'session_id': path.stem, 'actions': []})
        except (OSError, ValueError, TypeError, KeyError) as error:
            append_log(log, {'at': now, 'agent': orchestrator,
                             'decision': 'skill-rules-check-failed', 'session_id': path.stem,
                             'actions': [], 'error': str(error)})


def run_cycle(workspace, tasks, decisions, orchestrator, now=None):
    """Observe every owned agent once, execute actions, and persist state/logs."""
    now = time.time() if now is None else now
    orchestrator = valid_name(orchestrator)
    path = state_path(workspace, orchestrator)
    log = path.with_name('watch.jsonl')
    check_rule_changes(workspace, orchestrator, log, now)
    missing_tasks = path.with_name('tasks-missing')
    if tasks.is_dir():
        missing_tasks.unlink(missing_ok=True)
        cards, skipped = monitored_task_cards(tasks, orchestrator)
    else:
        cards, skipped = {}, {}
        if not missing_tasks.exists():
            append_log(log, {
                'at': now, 'decision': 'task-directory-missing', 'actions': [],
                'error': f'Missing task-card directory: {tasks}',
            })
            missing_tasks.touch()
    agents = [orchestrator, *cards]
    log_skipped_cards(path.with_name('skipped-cards.json'), log, skipped, now)
    hcom = list_hcom(orchestrator)
    states = read_watch_file(path, log, now)
    for agent, state in list(states.items()):
        if not isinstance(state, dict):
            reset_agent_state(path, log, now, agent,
                              f'Expected a JSON object, got {type(state).__name__}')
            states.pop(agent)
    for agent in set(states) - set(agents):
        append_log(log, {
            'at': now, 'agent': agent,
            'decision': 'orchestrator-handled-left-watch-set',
            'actions': [],
        })
        states.pop(agent)
    for agent in agents:
        if agent not in hcom:
            state = states.get(agent)
            if (agent != orchestrator and state
                    and state.get('orchestrator_notified')):
                append_log(log, {
                    'at': now, 'agent': agent,
                    'decision': 'orchestrator-handled-agent-stopped', 'actions': [],
                })
                states.pop(agent)
            else:
                append_log(log, {
                    'at': now, 'agent': agent, 'decision': 'not-observable',
                    'actions': [], 'error': 'agent missing from hcom list',
                })
            continue
        try:
            observation = observe(
                workspace, decisions, orchestrator, agent, hcom[agent], cards.get(agent))
            previous = states.get(agent)
            try:
                state, actions = decide(previous, observation, now)
            except (TypeError, ValueError, KeyError, AttributeError) as error:
                if previous is None:
                    raise
                reset_agent_state(path, log, now, agent, f'{type(error).__name__}: {error}')
                state, actions = decide(None, observation, now)
            results = []
            for action in actions:
                try:
                    delivery = perform(action, orchestrator, workspace)
                    if action.kind == 'recover-prompt':
                        apply_prompt_recovery_result(state, delivery, now)
                    results.append({'kind': action.kind, 'status': 'done', **delivery})
                except (OSError, ValueError) as error:
                    roll_back(action, state)
                    results.append({'kind': action.kind, 'status': 'failed',
                                    'error': str(error)})
            states[agent] = state
            append_log(log, {
                'at': now, 'agent': agent, 'observation': observation_record(observation),
                'state': state, 'actions': [action_record(action) for action in actions],
                'action_results': results,
            })
        except (OSError, ValueError, TypeError, KeyError) as error:
            append_log(log, {
                'at': now, 'agent': agent, 'decision': 'observation-failed',
                'actions': [], 'error': str(error),
            })
    write_object(path, states)


def log_cycle_failure(log, previous, error, now):
    """Log a failed cycle; repeat an identical failure at most once per hour."""
    message = f'{type(error).__name__}: {error}'
    repeats = previous['repeats'] + 1 if previous and previous['error'] == message else 0
    if repeats and now - previous['logged_at'] < FAILURE_REPEAT_SECONDS:
        return {**previous, 'repeats': repeats}
    record = {'at': now, 'decision': 'cycle-failed', 'actions': [], 'error': message}
    if repeats:
        record['repeats'] = repeats
    print(f'LAT watch cycle failed: {message}', file=sys.stderr, flush=True)
    try:
        append_log(log, record)
    except OSError as log_error:
        print(f'LAT watch log failed: {log_error}', file=sys.stderr, flush=True)
    return {'error': message, 'logged_at': now, 'repeats': repeats}


def run_forever(args):
    workspace = args.workspace.resolve(strict=True)
    tasks = args.tasks.resolve()
    decisions = args.decisions.resolve(strict=True)
    log = state_path(workspace, args.orchestrator).with_name('watch.jsonl')
    failure = None
    while True:
        now = time.time()
        try:
            run_cycle(workspace, tasks, decisions, args.orchestrator, now)
            failure = None
        except Exception as error:
            failure = log_cycle_failure(log, failure, error, now)
        time.sleep(CHECK_SECONDS)


def declare_wait(args):
    workspace = args.workspace.resolve(strict=True)
    declaration = {
        'agent': valid_name(args.agent),
        'target': valid_name(args.target),
        'reason': args.reason.strip(),
        'declared_at': time.time(),
        'declared_at_utc': datetime.now(timezone.utc).isoformat(),
        'active': True,
    }
    if not declaration['reason']:
        raise ValueError('--reason must not be empty')
    for path in sorted((workspace / '.lat/sessions').glob('*.json')):
        try:
            record = read_object(path, {})
        except (OSError, ValueError):
            continue
        if (record.get('role') != 'orchestrator'
                or record.get('status') != 'active'
                or record.get('workspace') != str(workspace)):
            continue
        if any(not isinstance(record.get(key), str) or not record[key]
               for key in ('hcom_name', 'tasks_path', 'decisions_path')):
            continue
        owner = record['hcom_name']
        if owner != args.agent:
            tasks = Path(record['tasks_path'])
            if not tasks.is_dir():
                continue
            cards, _ = monitored_task_cards(tasks, owner)
            if args.agent not in cards:
                continue
        decisions = Path(record['decisions_path'])
        if pending_decision(decisions, args.target) is False:
            matches = sorted(path for path in decisions.glob(f'{args.target}*')
                             if path.is_file())
            statuses = ', '.join(f'{path}: {read_decision_status(path).status}'
                                 for path in matches)
            raise ValueError(
                f'Cannot wait on {args.target}: no pending decision for {owner}; '
                f'matching records: {statuses}. To wait on the user\'s reply or a '
                'manual step, record it as a pending decision and wait on that ID.')
    write_object(wait_path(workspace, args.agent), declaration)
    print(json.dumps(declaration, ensure_ascii=False))


def show_status(args):
    workspace = args.workspace.resolve(strict=True)
    agents = monitored_agents(args.tasks.resolve(strict=True), args.orchestrator)
    hcom = list_hcom(args.orchestrator)
    states = read_object(state_path(workspace, args.orchestrator), {})
    target_rows = []
    for agent in agents:
        info = hcom.get(agent, {})
        row = {'agent': agent, 'hcom_status': info.get('status', 'missing'),
               'state': states.get(agent)}
        declaration = read_object(wait_path(workspace, agent))
        if declaration is not None:
            row['wait'] = declaration
        target_rows.append(row)
    print(json.dumps({'orchestrator': args.orchestrator, 'targets': target_rows},
                     indent=2, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    waiting = commands.add_parser('wait', help='Declare an agent wait condition')
    waiting.add_argument('--workspace', type=Path, required=True)
    waiting.add_argument('--agent', required=True)
    waiting.add_argument('--for', dest='target', required=True)
    waiting.add_argument('--reason', required=True)
    status = commands.add_parser('status', help='List watched agents and current state')
    status.add_argument('--workspace', type=Path, required=True)
    status.add_argument('--orchestrator', required=True)
    status.add_argument('--tasks', type=Path, required=True)
    run = commands.add_parser('run', help='Run one watcher loop per orchestrator')
    run.add_argument('--workspace', type=Path, required=True)
    run.add_argument('--orchestrator', required=True)
    run.add_argument('--tasks', type=Path, required=True)
    run.add_argument('--decisions', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == 'wait':
            declare_wait(args)
        elif args.command == 'status':
            show_status(args)
        else:
            run_forever(args)
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f'LAT watch error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
