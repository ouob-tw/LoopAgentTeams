#!/usr/bin/env python3
"""Close processes that HCOM agents left behind (stdlib only).

A process belongs to the agent whose HCOM_PROCESS_ID it inherited. It is a leftover once
that agent has ended: HCOM no longer lists it, no client process of it is running, an
earlier reap saw HCOM list that id under the inherited name, and HCOM recorded the agent it
inherited (name and launch batch) as stopped. Other owners are unknown and never closed.
Keeps, the close log and the lock live in one user-level folder shared by every project.
See docs/adr/0008-lat-service-reaper.md.
"""
import argparse
import contextlib
from datetime import datetime, timezone
import fcntl
import functools
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import (full_hcom_name, process_starttime, run_cli, same_controller,
                         write_json_atomic, read_hcom_pauses)

SKILL_DIR = Path(__file__).resolve().parents[1]
MARKER = 'HCOM_PROCESS_ID'
INTERPRETER = re.compile(r'(python[0-9.]*)|bash|sh|dash|zsh')
# Interpreter options whose value is the next argument.
VALUE_OPTIONS = {'python': {'-X', '-W'}, 'shell': {'-o', '-O'}}
SHELLS = {'bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'mksh', 'tcsh', 'csh', 'ash', 'yash'}
TRIGGERS = ('periodic', 'deactivate', 'manual')
GRACE_SECONDS = 10
LOCK_SECONDS = 30
KILL_WAIT_SECONDS = 2
# How long reap --agent waits for a client HCOM already shows stopped to exit.
AGENT_WAIT_SECONDS = 5
COMMAND_CHARS = 120
RECENT_CLOSURES = 10
EVENT_LIMIT = 100000
# Names and batch ids go into an SQL filter, so only these characters are accepted.
SAFE_VALUE = re.compile(r'[A-Za-z0-9_.-]+')
KEEPS, LOG, LOCK, SEEN = 'keeps.json', 'closed.jsonl', 'reap.lock', 'seen.json'


class Process(NamedTuple):
    pid: int
    ppid: int
    starttime: int
    state: str
    comm: str
    argv: tuple
    env: dict


class Failure(Exception):
    """Something needed to judge safely could not be read; nothing is closed."""


def now_utc():
    return datetime.now(timezone.utc)


def env_number(name, default):
    value = os.environ.get(name)
    return float(value) if value else default


def state_directory():
    state = os.environ.get('XDG_STATE_HOME', '')
    base = Path(state) if state.startswith('/') else Path.home() / '.local/state'
    return base / 'lat/reaper'


def protected_ports():
    value = os.environ.get('LAT_REAP_PROTECTED_PORTS', '7100')
    return {int(port) for port in value.split(',') if port.strip()}


def read_processes(proc_root=Path('/proc')):
    """This user's processes, and {pid: error} for those of them that cannot be read.

    Other users' processes are never read, listed or signalled; one that exits while being
    read is skipped.
    """
    uid, scope = os.getuid(), os.environ.get('LAT_REAP_TEST_SCOPE')
    processes, unreadable = {}, {}
    for directory in proc_root.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            if directory.stat().st_uid != uid:
                continue
            comm, separator, fields = (directory / 'stat').read_text().rpartition(') ')
            if not separator:
                continue
            stat = fields.split()
            argv = tuple(value.decode(errors='replace')
                         for value in (directory / 'cmdline').read_bytes().split(b'\0') if value)
            env = dict(value.decode(errors='replace').partition('=')[::2]
                       for value in (directory / 'environ').read_bytes().split(b'\0') if value)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except (OSError, ValueError, IndexError) as error:
            # Tests only count unreadable processes that carry their scope on the command line.
            with contextlib.suppress(OSError):
                if not scope or scope.encode() in (directory / 'cmdline').read_bytes():
                    unreadable[int(directory.name)] = str(error)
            continue
        # Tests only see their own fake agents: other processes count as unmarked, so they
        # still form the process tree but are never judged or signalled.
        if scope and not env.get(MARKER, '').startswith(scope):
            env = {}
        processes[int(directory.name)] = Process(int(directory.name), int(stat[1]), int(stat[19]),
                                                 stat[0], comm.partition('(')[2], argv, env)
    return processes, unreadable


def same_process(process):
    return process_starttime(process.pid) == process.starttime


def hcom_agents():
    """Map HCOM_PROCESS_ID -> {name, base, starttime} for every agent HCOM lists."""
    fake = os.environ.get('LAT_REAP_HCOM_LIST')
    try:
        if fake:
            text = Path(fake).read_text()
        else:
            text = run_cli(['hcom', 'list', '--json'], timeout=30, failure='hcom list failed')
        value = json.loads(text)
    except (OSError, ValueError) as error:
        raise Failure(f'HCOM agent list unreadable: {error}') from error
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise Failure('HCOM agent list unreadable: not a list of agents')
    agents = {}
    for item in value:
        context = item.get('launch_context') or {}
        process_id = context.get('process_id') if isinstance(context, dict) else None
        if not isinstance(process_id, str) or not process_id:
            continue
        try:
            starttime = int(str(context.get('pid_identity', '')).rsplit(':', 1)[1])
        except (ValueError, IndexError):
            starttime = None
        agents[process_id] = {'name': item.get('name'), 'base': item.get('base_name'),
                              'starttime': starttime}
    return agents


def nil_id(process):
    """The all-zero id test harnesses use; it never belongs to a real agent."""
    process_id = process.env.get(MARKER)
    return bool(process_id) and not process_id.strip('0-')


def launch_owner(process):
    """(HCOM name, launch batch) the process inherited, or None when either is missing."""
    name = process.env.get('HCOM_INSTANCE_NAME', '')
    batch = process.env.get('HCOM_LAUNCH_BATCH_ID', '')
    return (name, batch) if SAFE_VALUE.fullmatch(name) and SAFE_VALUE.fullmatch(batch) else None


def stopped_owners(owners):
    """The (name, batch) owners HCOM records as stopped.

    HCOM life events never carry HCOM_PROCESS_ID, so the inherited name and launch batch tie a
    process to an agent: a batch_launched event of that batch lists the name, and a later
    stopped event names it. A stop before that launch belongs to an earlier agent of that name.
    """
    if not owners:
        return set()
    fake = os.environ.get('LAT_REAP_HCOM_EVENTS')
    try:
        if fake:
            text = Path(fake).read_text()
        else:
            def listed(values):
                return ', '.join(f"'{value}'" for value in sorted(values))
            sql = (f"(json_extract(data, '$.action') = 'batch_launched' AND json_extract(data, "
                   f"'$.batch_id') IN ({listed({batch for _, batch in owners})})) OR "
                   f"(json_extract(data, '$.action') = 'stopped' AND instance IN "
                   f"({listed({name for name, _ in owners})}))")
            text = run_cli(['hcom', 'events', '--type', 'life', '--last', str(EVENT_LIMIT),
                            '--sql', sql], timeout=30, failure='hcom events failed')
        events = [json.loads(line) for line in text.splitlines() if line.strip()]
    except (OSError, ValueError) as error:
        raise Failure(f'HCOM stop records unreadable: {error}') from error
    launched, stopped = {}, {}
    for event in events:
        data = event.get('data') if isinstance(event, dict) else None
        number = event.get('id') if isinstance(event, dict) else None
        action = data.get('action') if isinstance(data, dict) else None
        instances = data.get('instances') if action == 'batch_launched' else None
        if (not isinstance(data, dict) or not isinstance(number, int) or isinstance(number, bool)
                or (action == 'batch_launched' and (
                    not isinstance(data.get('batch_id'), str) or not isinstance(instances, list)
                    or any(not isinstance(name, str) for name in instances)))
                or (action == 'stopped' and not isinstance(event.get('instance'), str))):
            raise Failure('HCOM stop records unreadable: unexpected format')
        if action == 'batch_launched':
            for name in instances:
                key = (name, data['batch_id'])
                launched[key] = min(number, launched.get(key, number))
        elif action == 'stopped':
            stopped[event['instance']] = max(number, stopped.get(event['instance'], number))
    return {owner for owner in owners
            if owner in launched and stopped.get(owner[0], -1) > launched[owner]}


def agent_name(process_id, processes, agents):
    if process_id in agents and agents[process_id]['name']:
        return agents[process_id]['name']
    for process in processes.values():
        if process.env.get(MARKER) == process_id and process.env.get('HCOM_INSTANCE_NAME'):
            tag, base = process.env.get('HCOM_TAG'), process.env['HCOM_INSTANCE_NAME']
            return f'{tag}-{base}' if tag else base
    return None


def name_matches(process, name):
    base, tag = process.env.get('HCOM_INSTANCE_NAME'), process.env.get('HCOM_TAG')
    return bool(base) and name in (base, f'{tag}-{base}' if tag else base)


def client_processes(process_id, processes, agents):
    """Running client processes of one agent.

    With an HCOM record the client is the topmost marked process with the recorded start
    time (hcom list gives no PID; a child started in the same clock tick is not a client).
    Without one, any marked hcom wrapper, or a process whose executable or script is named
    after its HCOM_TOOL, counts as a client. Names only ever keep an agent alive.
    """
    starttime = agents.get(process_id, {}).get('starttime')
    marked = [process for process in processes.values()
              if process.env.get(MARKER) == process_id and process.state != 'Z']
    recorded = {process.pid for process in marked if process.starttime == starttime}
    clients = {pid for pid in recorded if processes[pid].ppid not in recorded}
    for process in marked:
        names = {Path(arg).name for arg in process.argv[:2]}
        tool = process.env.get('HCOM_TOOL')
        if process.comm == 'hcom' or (tool and tool in names):
            clients.add(process.pid)
    return clients


def ancestors(pid, processes):
    found = set()
    while pid in processes and processes[pid].ppid not in found and processes[pid].ppid > 0:
        pid = processes[pid].ppid
        found.add(pid)
    return found


def children_map(processes):
    children = {}
    for process in processes.values():
        children.setdefault(process.ppid, []).append(process.pid)
    return children


def base_processes(clients, processes, children):
    """Clients, their ancestors, and every branch below them down to its first shell."""
    base, seen = set(), set()
    for client in clients:
        base |= ancestors(client, processes)
        stack = [client]
        while stack:
            pid = stack.pop()
            if pid in seen:
                continue
            seen.add(pid)
            base.add(pid)
            if pid == client or processes[pid].comm not in SHELLS:
                stack.extend(children.get(pid, ()))
    return base


def listening_pids(processes, ports):
    inodes = set()
    for table in ('tcp', 'tcp6'):
        try:
            lines = Path(f'/proc/net/{table}').read_text().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            if len(fields) > 9 and fields[3] == '0A' and int(fields[1].rsplit(':', 1)[1], 16) in ports:
                inodes.add(fields[9])
    found = set()
    if not inodes:
        return found
    for process in processes.values():
        if MARKER not in process.env:
            continue
        try:
            for link in Path(f'/proc/{process.pid}/fd').iterdir():
                target = os.readlink(link)
                if target.startswith('socket:[') and target[8:-1] in inodes:
                    found.add(process.pid)
                    break
        except OSError:
            continue
    return found


@functools.cache
def is_lat_skill(directory):
    """This skill, an installed copy or a QA copy: a folder whose SKILL.md is named lat."""
    if directory == SKILL_DIR:
        return True
    try:
        with open(directory / 'SKILL.md', encoding='utf-8') as stream:
            head = [stream.readline().strip() for _ in range(3)]
    except (OSError, UnicodeDecodeError):
        return False
    return head[0] == '---' and 'name: lat' in head[1:]


def in_skill_dir(process):
    try:
        cwd = Path(os.readlink(f'/proc/{process.pid}/cwd'))
        paths = [Path(os.readlink(f'/proc/{process.pid}/exe'))]
    except OSError:
        cwd, paths = None, []
    # The executable, or the script an interpreter runs (`python [-u] x.py`, `uv run python
    # x.py`); other file arguments, such as a file open in an editor, do not count.
    interpreter, option_value = None, False
    for index, arg in enumerate(process.argv):
        if option_value:
            option_value = False
            continue
        if interpreter and arg in VALUE_OPTIONS[interpreter]:
            option_value = True
            continue
        if index == 0 or (interpreter and not arg.startswith('-')):
            paths.append(Path(arg) if arg.startswith('/') or cwd is None else cwd / arg)
        if not arg.startswith('-'):
            match = INTERPRETER.fullmatch(Path(arg).name)
            interpreter = match and ('python' if match[1] else 'shell')
    for path in paths:
        try:
            if path.is_file() and any(map(is_lat_skill, path.resolve().parents)):
                return True
        except OSError:
            continue
    return False


class World(NamedTuple):
    processes: dict
    agents: dict
    alive: set
    protected: dict
    unreadable: dict
    ended: set


def read_seen(directory):
    """{HCOM_PROCESS_ID: name} for every id an earlier reap saw HCOM list."""
    try:
        value = json.loads((directory / SEEN).read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise Failure(f'seen agent records unreadable: {error}') from error
    seen = value.get('seen') if isinstance(value, dict) else None
    if not isinstance(seen, dict) or any(not isinstance(name, str) for name in seen.values()):
        raise Failure('seen agent records unreadable: unexpected format')
    return seen


def remember_agents(directory, world, seen):
    """Record the ids HCOM lists now; forget ids neither listed nor carried by a process."""
    carried = {process.env.get(MARKER) for process in world.processes.values()}
    current = {process_id: name for process_id, name in seen.items() if process_id in carried}
    current.update((process_id, agent['base']) for process_id, agent in world.agents.items()
                   if isinstance(agent['base'], str))
    if current != seen:
        write_json_atomic(directory / SEEN, {'seen': current})


def observe(seen):
    """Read HCOM and /proc once, and work out which processes are never handled.

    A process counts as ended only when its id is not the nil UUID that test harnesses use,
    an earlier reap saw HCOM list that id under the name it inherited, and HCOM recorded that
    name and launch batch as stopped.
    """
    agents = hcom_agents()
    processes, unreadable = read_processes()
    children = children_map(processes)
    callers = {os.getpid()} | ancestors(os.getpid(), processes)
    marked = {process.env[MARKER] for process in processes.values() if process.env.get(MARKER)}
    alive, base = set(), set()
    for process_id in marked | set(agents):
        clients = client_processes(process_id, processes, agents)
        if process_id in agents or clients:
            alive.add(process_id)
            base |= base_processes(clients, processes, children)
    known = [process for process in processes.values()
             if process.env.get(MARKER) and process.env[MARKER] not in alive
             and not nil_id(process) and launch_owner(process)
             and seen.get(process.env[MARKER]) == launch_owner(process)[0]]
    stopped = stopped_owners({launch_owner(process) for process in known})
    ended = {process.pid for process in known if launch_owner(process) in stopped}
    protected = {}
    ports = listening_pids(processes, protected_ports())
    for process in processes.values():
        reason = None
        if not process.env.get(MARKER):
            reason = 'no HCOM_PROCESS_ID'
        elif process.pid in callers:
            reason = 'caller or its ancestor'
        elif ancestors(process.pid, processes) & unreadable.keys():
            # It may run under a live client whose evidence of life cannot be read.
            reason = 'ancestor unreadable'
        elif process.pid in ports:
            reason = 'listens on a protected port'
        elif process.pid in base:
            reason = 'base process of a running agent'
        elif process.comm == 'hcom':
            reason = 'hcom process'
        elif in_skill_dir(process):
            reason = 'LAT process'
        if reason:
            protected[process.pid] = reason
    return World(processes, agents, alive, protected, unreadable, ended)


def parse_time(value):
    moment = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return moment if moment.tzinfo else moment.astimezone()


def read_keeps(directory):
    path = directory / KEEPS
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as error:
        raise Failure(f'keep records unreadable: {error}') from error
    keeps = value.get('keeps') if isinstance(value, dict) else None
    fields = {'pid': int, 'starttime': int, 'process_id': str, 'reason': str, 'until': str,
              'by': str}
    if not isinstance(keeps, list) or any(
            not isinstance(keep, dict) or any(
                not isinstance(keep.get(name), kind) or isinstance(keep.get(name), bool)
                for name, kind in fields.items())
            for keep in keeps):
        raise Failure('keep records unreadable: unexpected format')
    try:
        for keep in keeps:
            parse_time(keep['until'])
    except (TypeError, ValueError) as error:
        raise Failure(f'keep records unreadable: {error}') from error
    return keeps


def keep_release(keep, agents, moment, paused=None):
    """Why a keep no longer holds, or None while it does."""
    if keep.get('released_at'):
        return 'released by its orchestrator'
    if parse_time(keep['until']) <= moment:
        return 'expired'
    paused = read_hcom_pauses() if paused is None else paused
    if keep['by'] in paused:
        return None
    if not any(keep['by'] in (agent['name'], agent['base']) for agent in agents.values()):
        return 'its orchestrator is no longer running'
    return None


def same_id_descendants(pid, world, children):
    process_id = world.processes[pid].env.get(MARKER)
    found, stack = set(), list(children.get(pid, ()))
    while stack:
        child = stack.pop()
        if child in found:
            continue
        found.add(child)
        stack.extend(children.get(child, ()))
    return {child for child in found if world.processes[child].env.get(MARKER) == process_id}


def plan(world, keeps, moment, only=None):
    """Return (targets, kept, live keeps, released keeps); targets map pid -> why."""
    children = children_map(world.processes)
    paused = read_hcom_pauses()
    targets, kept, live_keeps, released = {}, {}, [], []
    for keep in keeps:
        process = world.processes.get(keep['pid'])
        if process is None or process.starttime != keep['starttime']:
            continue
        why = keep_release(keep, world.agents, moment, paused)
        group = {process.pid} | same_id_descendants(process.pid, world, children)
        if why is None:
            live_keeps.append(keep)
            kept.update(dict.fromkeys(group, keep))
        elif only is None or process.env.get(MARKER) in only:
            released.append((keep, why))
            targets.update(dict.fromkeys(group, f'keep {why}'))
        else:
            live_keeps.append(keep)
    for process in world.processes.values():
        process_id = process.env.get(MARKER)
        if (process.pid in world.ended and process.pid not in kept
                and (only is None or process_id in only)):
            targets.setdefault(process.pid, 'owner agent ended')
    # A valid keep also holds inside the group of a released keep around it; the nil id is
    # never closed, not even by a keep that ended.
    targets = {pid: why for pid, why in targets.items()
               if pid not in world.protected and pid not in kept
               and not nil_id(world.processes[pid])
               and world.processes[pid].state != 'Z'}
    return targets, kept, live_keeps, released


def unknown_owner(world, targets, kept, only=None):
    """Leftovers whose owner is not known to have stopped; they are never closed."""
    return {process.pid for process in world.processes.values()
            if process.env.get(MARKER) and process.env[MARKER] not in world.alive
            and (only is None or process.env[MARKER] in only) and process.state != 'Z'
            and process.pid not in targets and process.pid not in kept
            and process.pid not in world.protected}


def describe(process, world):
    try:
        cwd = os.readlink(f'/proc/{process.pid}/cwd')
    except OSError:
        cwd = None
    process_id = process.env.get(MARKER)
    return {'pid': process.pid, 'starttime': process.starttime,
            'command': ' '.join(process.argv)[:COMMAND_CHARS], 'cwd': cwd,
            'agent': agent_name(process_id, world.processes, world.agents),
            'process_id': process_id}


def append_log(directory, record):
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / LOG, 'a', encoding='utf-8') as stream:
        stream.write(json.dumps(record, ensure_ascii=False) + '\n')


def wait_gone(processes, seconds):
    deadline = time.monotonic() + seconds
    while True:
        remaining = [process for process in processes if same_process(process)]
        if not remaining or time.monotonic() >= deadline:
            return remaining
        time.sleep(0.1)


def send(process, number):
    """Signal only if the PID still has the start time we saw; False when it is gone."""
    if not same_process(process):
        return False
    try:
        os.kill(process.pid, number)
    except ProcessLookupError:
        return False
    return True


def close(targets, world, directory, trigger):
    """SIGTERM the batch, SIGKILL what is still running after the grace period."""
    records, signalled = {}, []
    for pid, why in sorted(targets.items()):
        process = world.processes[pid]
        record = {'time': now_utc().isoformat(timespec='seconds'), 'trigger': trigger,
                  **describe(process, world), 'why': why}
        records[pid] = record
        try:
            if send(process, signal.SIGTERM):
                record['signal'] = 'SIGTERM'
                signalled.append(process)
            else:
                record.update(signal=None, result='gone before signal')
        except OSError as error:
            record.update(signal=None, result=f'error: {error}')
    stubborn = wait_gone(signalled, env_number('LAT_REAP_GRACE_SECONDS', GRACE_SECONDS))
    for process in signalled:
        records[process.pid]['result'] = 'exited after SIGTERM'
    killed = []
    for process in stubborn:
        record = records[process.pid]
        try:
            if send(process, signal.SIGKILL):
                record['signal'] = 'SIGKILL'
                killed.append(process)
        except OSError as error:
            record['result'] = f'error: {error}'
    for process in killed:
        records[process.pid]['result'] = 'killed'
    for process in wait_gone(killed, KILL_WAIT_SECONDS):
        records[process.pid]['result'] = 'still running after SIGKILL'
    for record in records.values():
        append_log(directory, record)
    return list(records.values())


@contextlib.contextmanager
def locked(directory, wait):
    """Yield True while holding the user-level lock, False when it was not obtained."""
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / LOCK, 'a') as stream:
        deadline = time.monotonic() + (env_number('LAT_REAP_LOCK_SECONDS', LOCK_SECONDS)
                                       if wait else 0)
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    yield False
                    return
                time.sleep(0.1)
        try:
            yield True
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def write_keeps(directory, keeps):
    write_json_atomic(directory / KEEPS, {'keeps': keeps})


def resolve_agent(name, world):
    """HCOM_PROCESS_IDs carried under an agent name, and whether HCOM still lists it."""
    listed = {process_id for process_id, agent in world.agents.items()
              if name in (agent['name'], agent['base'])}
    found = {process.env[MARKER] for process in world.processes.values()
             if process.env.get(MARKER) and name_matches(process, name)}
    return listed | found, bool(listed)


def reap(args):
    directory = state_directory()
    trigger = args.trigger
    with locked(directory, wait=trigger != 'periodic') as acquired:
        if not acquired:
            print('Skipped: another reap holds the lock'
                  + ('' if trigger == 'periodic' else ' (waited too long)'))
            return 0 if trigger == 'periodic' else 1
        moment = now_utc()
        try:
            keeps = read_keeps(directory)
            seen = read_seen(directory)
            world = observe(seen)
        except Failure as error:
            append_log(directory, {'time': moment.isoformat(timespec='seconds'),
                                   'trigger': trigger, 'result': 'aborted', 'reason': str(error)})
            print(f'Nothing closed: {error}')
            return 1
        remember_agents(directory, world, seen)
        log_unjudged(directory, world, trigger, moment)
        if world.unreadable:
            print(f'Not judged: {len(world.unreadable)} unreadable process(es) (list them with scan --all)')
        only = None
        if args.agent:
            only, listed = resolve_agent(args.agent, world)
            deadline = time.monotonic() + env_number('LAT_REAP_AGENT_WAIT_SECONDS',
                                                     AGENT_WAIT_SECONDS)
            while not listed and only & world.alive and time.monotonic() < deadline:
                # HCOM shows the agent stopped; its client may still be exiting.
                time.sleep(0.5)
                try:
                    world = observe(seen)
                except Failure as error:
                    append_log(directory, {'time': moment.isoformat(timespec='seconds'),
                                           'trigger': trigger, 'result': 'aborted',
                                           'reason': str(error)})
                    print(f'Nothing closed: {error}')
                    return 1
                only, listed = resolve_agent(args.agent, world)
            running = sorted(only & world.alive)
            if listed or running:
                print(f'Nothing closed: agent {args.agent} is still running'
                      + (' (HCOM lists it)' if listed else ' (its client process is running)'))
                return 0
            if not only:
                print(f'Nothing closed: no process carries the HCOM_PROCESS_ID of {args.agent}')
                return 0
        targets, kept, live_keeps, released = plan(world, keeps, moment, only)
        unknown = unknown_owner(world, targets, kept, only)
        records = close(targets, world, directory, trigger) if targets else []
        if live_keeps != keeps:
            write_keeps(directory, live_keeps)
    for keep, why in released:
        print(f'Keep on PID {keep["pid"]} ended ({why}); closing it')
    for record in records:
        print(f'PID {record["pid"]} ({record["agent"] or "unknown agent"}): '
              f'{record["result"]} [{record["why"]}] {record["command"]}')
    if not records:
        print('Nothing to close')
    if unknown:
        print(f'Not closed: {len(unknown)} process(es) whose owner is not recorded as stopped '
              '(list them with scan)')
    return 0


def keep(args):
    directory = state_directory()
    try:
        until = parse_time(args.until)
    except ValueError:
        print(f'Refused: --until is not an ISO 8601 time: {args.until}')
        return 1
    if not args.reason.strip() or not args.until.strip():
        print('Refused: a keep needs a reason and an expiry time')
        return 1
    if until <= now_utc():
        print('Refused: the expiry time has already passed')
        return 1
    with locked(directory, wait=True) as acquired:
        if not acquired:
            print('Refused: another reap holds the lock')
            return 1
        try:
            keeps = read_keeps(directory)
            seen = read_seen(directory)
            world = observe(seen)
        except Failure as error:
            print(f'Refused: {error}')
            return 1
        remember_agents(directory, world, seen)
        process = world.processes.get(args.pid)
        if args.pid in world.unreadable:
            print(f'Refused: PID {args.pid} cannot be read ({world.unreadable[args.pid]})')
            return 1
        if process is None or process.state == 'Z':
            print(f'Refused: PID {args.pid} is not running')
            return 1
        if nil_id(process):
            print(f'Refused: PID {args.pid} carries the nil HCOM_PROCESS_ID of test harnesses')
            return 1
        if args.pid in world.protected:
            print(f'Refused: PID {args.pid} is never handled ({world.protected[args.pid]})')
            return 1
        try:
            by = full_hcom_name({agent['name'] for agent in world.agents.values()}, args.by,
                                '--by')
        except ValueError as error:
            print(f'Refused: {error}')
            return 1
        record = {'pid': process.pid, 'starttime': process.starttime,
                  'process_id': process.env[MARKER],
                  'agent': agent_name(process.env[MARKER], world.processes, world.agents),
                  'command': ' '.join(process.argv)[:COMMAND_CHARS], 'reason': args.reason.strip(),
                  'until': until.isoformat(timespec='seconds'), 'by': by,
                  'session': args.session, 'created_at': now_utc().isoformat(timespec='seconds')}
        keeps = [item for item in keeps
                 if (item['pid'], item['starttime']) != (process.pid, process.starttime)]
        write_keeps(directory, keeps + [record])
    print(f'Kept PID {process.pid} until {record["until"]}: {record["reason"]}')
    return 0


def release(args):
    """End every keep one orchestrator made; the next reap closes those processes."""
    directory = state_directory()
    with locked(directory, wait=True) as acquired:
        if not acquired:
            print('Not released: another reap holds the lock')
            return 1
        try:
            keeps = read_keeps(directory)
        except Failure as error:
            print(f'Not released: {error}')
            return 1
        moment = now_utc().isoformat(timespec='seconds')
        count = 0
        for item in keeps:
            # Either side may be a base name: older keeps, or a session record made before #389.
            if ((same_controller(item['by'], args.by) or same_controller(args.by, item['by']))
                    and not item.get('released_at')):
                item['released_at'] = moment
                count += 1
        if count:
            write_keeps(directory, keeps)
    print(f'Released {count} keep(s) made by {args.by}')
    return 0


def unjudged(world):
    """Unreadable processes, and the agent processes protected because one is above them."""
    return {'unreadable': {str(pid): why for pid, why in sorted(world.unreadable.items())},
            'ancestor_unreadable': sorted(pid for pid, why in world.protected.items()
                                          if why == 'ancestor unreadable')}


def log_unjudged(directory, world, trigger, moment):
    """Log the unjudged processes once each time they change, not on every periodic reap."""
    current = unjudged(world)
    previous = {'unreadable': {}, 'ancestor_unreadable': []}
    for record in reversed(recent_closures(directory, 0)):
        if record.get('result') == 'not judged':
            previous = {key: record.get(key) for key in previous}
            break
    if current != previous:
        append_log(directory, {'time': moment.isoformat(timespec='seconds'), 'trigger': trigger,
                               'result': 'not judged', **current})


def recent_closures(directory, limit):
    try:
        lines = (directory / LOG).read_text().splitlines()
    except FileNotFoundError:
        return []
    records = []
    for line in lines[-limit:]:
        with contextlib.suppress(ValueError):
            records.append(json.loads(line))
    return records


def scan(args):
    directory = state_directory()
    moment = now_utc()
    try:
        keeps = read_keeps(directory)
        world = observe(read_seen(directory))
    except Failure as error:
        print(f'Cannot judge: {error}')
        return 1
    targets, kept, _live, _released = plan(world, keeps, moment)
    unknown = unknown_owner(world, targets, kept)
    rows = {'Agent still running': [], 'Leftover': [], 'Kept': [], 'Unknown owner': [],
            'Never handled': []}
    for process in sorted(world.processes.values(), key=lambda item: item.pid):
        process_id = process.env.get(MARKER)
        if not process_id:
            continue
        info = describe(process, world)
        line = f'PID {process.pid} {info["agent"] or "unknown agent"} [{process_id[:8]}] {info["command"]}'
        if process.pid in targets:
            rows['Leftover'].append(f'{line} ({targets[process.pid]})')
        elif process.pid in kept:
            keep_record = kept[process.pid]
            rows['Kept'].append(f'{line} (until {keep_record["until"]} by {keep_record["by"]}: '
                                f'{keep_record["reason"]})')
        elif process.pid in unknown:
            rows['Unknown owner'].append(f'{line} (owner not recorded as stopped; never closed)')
        elif process.pid in world.protected:
            rows['Never handled'].append(f'{line} ({world.protected[process.pid]})')
        elif process_id in world.alive:
            rows['Agent still running'].append(line)
    rows['Unreadable'] = [f'PID {pid} ({why})' for pid, why in sorted(world.unreadable.items())]
    for title, lines in rows.items():
        if title in ('Never handled', 'Unreadable') and not args.all:
            print(f'{title}: {len(lines)} (show with --all)')
            continue
        print(f'{title}: {len(lines)}')
        for line in lines:
            print(f'  {line}')
    closures = recent_closures(directory, args.limit)
    print(f'Recent close records: {len(closures)}')
    judged = [record for record in closures if record.get('result') == 'not judged']
    # By default only the latest "not judged" record shows, as a count; older ones fold.
    folded = [] if args.all else judged[:-1]
    for record in closures:
        if record.get('result') == 'aborted':
            print(f'  {record.get("time")} {record.get("trigger")} aborted: {record.get("reason")}')
        elif record.get('result') == 'not judged':
            if any(record is old for old in folded):
                continue
            if args.all:
                listing = (f'unreadable PIDs {", ".join(record.get("unreadable") or {}) or "none"}; '
                           f'agent processes below them {record.get("ancestor_unreadable")}')
            else:
                listing = f'另有 {len(record.get("unreadable") or {})} 個無法判斷，加 --all 可列出'
            print(f'  {record.get("time")} {record.get("trigger")} not judged: {listing}')
        else:
            print(f'  {record.get("time")} {record.get("trigger")} PID {record.get("pid")} '
                  f'{record.get("agent")} {record.get("signal")} {record.get("result")} '
                  f'{record.get("command")}')
    if folded:
        print(f'  另有 {len(folded)} 筆較舊的無法判斷紀錄')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='action', required=True)
    look = sub.add_parser('scan', help='List agent processes, leftovers and keeps; changes nothing')
    look.add_argument('--all', action='store_true', help='Also list never-handled and unreadable processes, and every not-judged record')
    look.add_argument('--limit', type=int, default=RECENT_CLOSURES, help='Close records to show')
    run = sub.add_parser('reap', help='Close leftovers and processes whose keep ended')
    run.add_argument('--agent', help='Only this HCOM agent (call right after hcom kill)')
    run.add_argument('--trigger', choices=TRIGGERS, default='manual',
                     help='periodic skips when another reap holds the lock')
    hold = sub.add_parser('keep', help='Keep one agent process for the user until a set time')
    hold.add_argument('--pid', type=int, required=True)
    hold.add_argument('--reason', required=True)
    hold.add_argument('--until', required=True, help='ISO 8601 expiry time')
    hold.add_argument('--by', required=True,
                      help='HCOM name of the orchestrator keeping it, stored as the full name')
    hold.add_argument('--session', required=True, help="The orchestrator's LAT session ID")
    free = sub.add_parser('release', help='End every keep an orchestrator made (on deactivate)')
    free.add_argument('--by', required=True, help='HCOM name of the orchestrator')
    args = parser.parse_args()
    return {'scan': scan, 'reap': reap, 'keep': keep, 'release': release}[args.action](args)


if __name__ == '__main__':
    sys.exit(main())
