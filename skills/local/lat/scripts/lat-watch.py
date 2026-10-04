#!/usr/bin/env python3
"""Watch explicitly registered LAT work for stalled agents (stdlib only)."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import NamedTuple


IDLE_SECONDS = 10 * 60
ACTIVE_SECONDS = 20 * 60
PROMPT_SECONDS = 5 * 60
CHECK_SECONDS = 60
NUDGE = ('Read any unread HCOM messages and finish all work not blocked by pending '
         'decisions. If nothing remains, declare exactly what you are waiting for '
         'with lat-watch wait.')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}')


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


class Action(NamedTuple):
    kind: str
    agent: str
    message: str = ''
    text: str = ''


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


def decide(previous, observation, now):
    """Return serializable state and requested actions for one observation."""
    fingerprint = [observation.transcript_size, observation.transcript_mtime_ns,
                   observation.event_id]
    progressed = previous is None or previous.get('fingerprint') != fingerprint
    reset = progressed or observation.wait_released
    if reset:
        state = {
            'fingerprint': fingerprint,
            'last_progress_at': now,
            'nudged': False,
            'orchestrator_notified': False,
            'orchestrator_handled': False,
            'user_notified': False,
        }
    else:
        state = dict(previous)
        state.setdefault('orchestrator_notified', False)
        state.setdefault('orchestrator_handled', False)
        state.setdefault('user_notified', False)
        if state.get('nudged') and 'nudged_at' not in state:
            state['nudged_at'] = now
    queued_prompt = (not observation.prompt_empty and bool(observation.input_text)
                     and observation.unread_count > 0)
    prompt_hash = hashlib.sha256(observation.input_text.encode()).hexdigest()
    previous_prompt_hash = previous.get('prompt_text_hash') if previous else None
    if previous and previous_prompt_hash is None and 'prompt_text' in previous:
        previous_prompt_hash = hashlib.sha256(previous['prompt_text'].encode()).hexdigest()
    same_prompt = (queued_prompt and previous is not None
                   and previous_prompt_hash == prompt_hash)
    if queued_prompt:
        state.pop('prompt_text', None)
        state['prompt_text_hash'] = prompt_hash
        state['prompt_text_since'] = (
            previous.get('prompt_text_since', now) if same_prompt else now)
        state['prompt_recovery_attempted'] = (
            previous.get('prompt_recovery_attempted', False) if same_prompt else False)
    else:
        state.pop('prompt_text', None)
        state.pop('prompt_text_hash', None)
        state.pop('prompt_text_since', None)
        state.pop('prompt_recovery_attempted', None)
    actions = ()
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
    if prompt_stalled and not state['prompt_recovery_attempted']:
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
        state['decision'] = actions[0].kind
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


def write_object(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    original = path.read_bytes() if path.exists() else None
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
    if not all(name in fields for name in ('agent', 'orchestrator', 'status')):
        return None
    fields['agent'] = fields['agent'].split(maxsplit=1)[0]
    return fields


def monitored_task_cards(tasks, orchestrator):
    cards = {}
    if not tasks.is_dir():
        raise ValueError(f'Missing task-card directory: {tasks}')
    for path in sorted(tasks.glob('*.md')):
        card = parse_task(path)
        if (card and card['orchestrator'] == orchestrator
                and card['status'] != 'merged'):
            card['_updated_at'] = path.stat().st_mtime
            cards.setdefault(valid_name(card['agent']), card)
    return cards


def monitored_agents(tasks, orchestrator):
    return [valid_name(orchestrator), *monitored_task_cards(tasks, orchestrator)]


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


def message_event(event):
    data = event.get('data', {})
    return (event.get('type') == 'message' or isinstance(event.get('message'), dict)
            or isinstance(data, dict) and isinstance(data.get('message'), dict))


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


def wait_release_reason(declaration, participant_events, target_events, decision_pending):
    """Explain why a wait is no longer valid, or return None."""
    agent = declaration['agent']
    target = declaration['target']
    for event in participant_events:
        delivered = (event_value(event, 'msg_delivered_to', 'message')
                     or event_value(event, 'delivered_to', 'message') or [])
        if message_event(event) and agent in delivered:
            return 'message-delivered'
    for event in target_events:
        sender = (event_value(event, 'msg_from', 'message')
                  or event_value(event, 'from', 'message'))
        if message_event(event) and sender == target:
            return 'target-replied'
    if decision_pending is False:
        return 'decision-resolved'
    return None


def pending_decision(decisions, target):
    matches = [path for path in decisions.glob(f'{target}*') if path.is_file()]
    if not matches:
        return None
    for path in matches:
        match = re.search(r'^- status:\s*(\S+)', path.read_text(), re.MULTILINE)
        if match and match.group(1) == 'pending':
            return True
    return False


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


def release_wait_if_needed(workspace, decisions, orchestrator, declaration):
    if not declaration or not declaration.get('active', True):
        return None
    after = declaration['declared_at_utc']
    agent = declaration['agent']
    target = declaration['target']
    participant = hcom_events(orchestrator, '--after', after, '--participant', agent)
    decision = pending_decision(decisions, target)
    target_events = [] if decision is not None else hcom_events(
        orchestrator, '--after', after, '--from', target)
    reason = wait_release_reason(declaration, participant, target_events, decision)
    if reason:
        updated = dict(declaration, active=False, released_reason=reason,
                       released_at_utc=datetime.now(timezone.utc).isoformat())
        write_object(wait_path(workspace, agent), updated)
    return reason


def observe(workspace, decisions, orchestrator, agent, info, card=None):
    terminal = run_json(['hcom', 'term', agent, '--json', '--name', orchestrator])
    if not isinstance(terminal, dict):
        raise ValueError(f'hcom term returned invalid data for {agent}')
    if not isinstance(terminal.get('ready'), bool):
        raise ValueError(f'hcom term omitted boolean ready for {agent}')
    if not isinstance(terminal.get('prompt_empty'), bool):
        raise ValueError(f'hcom term omitted boolean prompt_empty for {agent}')
    input_text = terminal.get('input_text', '')
    if not isinstance(input_text, str):
        raise ValueError(f'hcom term returned invalid input_text for {agent}')
    unread_count = info.get('unread_count', 0)
    if (not isinstance(unread_count, int) or isinstance(unread_count, bool)
            or unread_count < 0):
        raise ValueError(f'hcom list returned invalid unread_count for {agent}')
    transcript_size = 0
    transcript_mtime_ns = 0
    transcript = info.get('transcript_path')
    if isinstance(transcript, str) and transcript:
        try:
            stat = Path(transcript).stat()
            transcript_size = stat.st_size
            transcript_mtime_ns = stat.st_mtime_ns
        except FileNotFoundError:
            pass
    own_events = hcom_events(orchestrator, '--agent', agent, '--last', '1')
    participant_events = hcom_events(orchestrator, '--participant', agent, '--last', '1')
    event_id = max(latest_event_id(own_events), latest_event_id(participant_events))
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
        prompt_empty=terminal.get('prompt_empty') is True,
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


def read_prompt_status(agent, orchestrator):
    info = list_hcom(orchestrator).get(agent)
    if info is None:
        raise ValueError(f'agent missing from hcom list: {agent}')
    unread_count = info.get('unread_count', 0)
    if (not isinstance(unread_count, int) or isinstance(unread_count, bool)
            or unread_count < 0):
        raise ValueError(f'hcom list returned invalid unread_count for {agent}')
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
            updated = read_terminal_input(action.agent, orchestrator)
        except (OSError, ValueError) as error:
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
        **send_prompt_notification(orchestrator, message, popup),
    }


def apply_prompt_recovery_result(state, result, now):
    remaining = result.pop('_remaining_input', None)
    rearm = result.pop('_prompt_rearm', False)
    if remaining is None:
        return
    if remaining:
        state.pop('prompt_text', None)
        state['prompt_text_hash'] = hashlib.sha256(remaining.encode()).hexdigest()
        state['prompt_recovery_attempted'] = not rearm
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
    if flag is not None:
        state[flag] = False
    for field in cleanup_fields:
        state.pop(field, None)


def run_cycle(workspace, tasks, decisions, orchestrator, now=None):
    """Observe every owned agent once, execute actions, and persist state/logs."""
    now = time.time() if now is None else now
    orchestrator = valid_name(orchestrator)
    cards = monitored_task_cards(tasks, orchestrator)
    agents = [orchestrator, *cards]
    hcom = list_hcom(orchestrator)
    path = state_path(workspace, orchestrator)
    states = read_object(path, {})
    log = path.with_name('watch.jsonl')
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
            state, actions = decide(states.get(agent), observation, now)
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


def run_forever(args):
    workspace = args.workspace.resolve(strict=True)
    tasks = args.tasks.resolve(strict=True)
    decisions = args.decisions.resolve(strict=True)
    while True:
        run_cycle(workspace, tasks, decisions, args.orchestrator)
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
