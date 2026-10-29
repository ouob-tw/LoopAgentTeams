#!/usr/bin/env python3
"""Background check started by spawn-guard.py for one `hcom N claude|codex` launch.

Finds the launch batch, subscribes the spawner to each new agent's approval-blocked status,
renames each new agent's Herdr tab to <spawner>-<agent>, compares model, effort and
permission on the agent's screen with the launch command, tells the spawner about any
mismatch or anything it could not confirm, and removes the subscriptions once the agents
stop. Until then it also types Continue once when a Codex agent stops on model capacity
and tells the spawner once when one stops on another API error (see capacity_step).
"""
import argparse
import contextlib
import fcntl
import importlib.util
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    'spawn_guard', Path(__file__).resolve().parent / 'spawn-guard.py')
guard = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(guard)

NAME = re.compile(r'^[A-Za-z0-9_-]+$')
SENDER = 'hcom-spawn'
BATCH_WAIT = 90        # seconds to wait for the launch to show up in hcom events
ARGS_WAIT = 10         # seconds to wait for a new agent's command line to be readable
SCREEN_WINDOW = 20     # seconds of screen reading after the agent is ready
DEADLINE = 180         # seconds after the launch to give up on confirming
POLL = 0.3
STOP_POLL = 5
LABEL_WAIT = 180       # seconds to keep looking up new agents' panes for tab labels
LABEL_POLL = 1
ITEMS = ('model', 'effort', 'permission')
EXPECTED_PERMISSION = {'claude': 'bypass permissions on', 'codex': 'YOLO'}
EFFORTS = 'none|minimal|low|medium|high|xhigh|max'
CLAUDE_BANNER = re.compile(r'\b([A-Z][a-z]+ \d+(?:\.\d+)?) with (\w+) effort')
CLAUDE_EFFORT = re.compile(rf'\b({EFFORTS}) · /effort')
CLAUDE_MODES = re.compile(r'(bypass permissions on|auto mode on|accept edits on|plan mode on)')
CODEX_STATUS = re.compile(rf'^\s*([^\s:│•]+(?: [^\s:│•]+){{0,1}}?) ({EFFORTS}) · ')
CODEX_BANNER = re.compile(rf'model:\s+(\S+)\s+({EFFORTS})\b')
CODEX_PERMISSION = re.compile(r'permissions:\s+(.+?)\s*(?:│|$)')
CAPACITY_POLL = 5          # seconds between capacity checks of the watched Codex agents
CAPACITY_NOTICE = 5 * 60   # seconds after Continue before telling the spawner
CAPACITY_CONTINUE = 'Continue'
CAPACITY_ERROR = re.compile(r'^■\s+Selected model is at capacity\b', re.IGNORECASE)
API_ERROR = re.compile(r'^■\s+\{"type":\s*"error"')
API_ERROR_CHARS = 1000     # longest error text quoted to the spawner
TRANSCRIPT_TAIL_BYTES = 256 * 1024

clock, sleep = time.monotonic, time.sleep
PROC = Path('/proc')
episodes = {}            # agent base name -> current capacity episode
api_errors = {}          # agent base name -> API error texts already told to the spawner
last_capacity_check = [None]


def hcom(*args, timeout=30):
    """Run hcom; return (exit code, stdout). Identity comes from the explicit flags only."""
    env = {k: v for k, v in os.environ.items()
           if k not in ('HCOM_INSTANCE_NAME', 'HCOM_PROCESS_ID')}
    try:
        done = subprocess.run(['hcom', *args], capture_output=True, text=True,
                              timeout=timeout, env=env)
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, done.stdout


def herdr(*args):
    """Run herdr; return (exit code, output)."""
    try:
        done = subprocess.run(['herdr', *args], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as error:
        return 1, str(error)
    return done.returncode, done.stdout if done.returncode == 0 else done.stdout + done.stderr


def log(text):
    """Write to watch.log (spawn-guard points this process's stderr there)."""
    print(f'hcom-spawn watch: {text}', file=sys.stderr, flush=True)


def events(*filters):
    _, out = hcom('events', '--last', '50', *filters)
    found = []
    for line in out.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and 'id' in event:
            found.append(event)
    return found


def state_dir():
    base = Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local/state'))
    path = base / 'hcom-spawn'
    (path / 'subs').mkdir(parents=True, exist_ok=True)
    (path / 'claims').mkdir(parents=True, exist_ok=True)
    (path / 'capacity').mkdir(parents=True, exist_ok=True)
    return path


def claim(batch_id):
    try:
        os.close(os.open(state_dir() / 'claims' / batch_id, os.O_CREAT | os.O_EXCL))
        return True
    except FileExistsError:
        return False


def process_ids():
    """hcom process id of each running agent, by base name."""
    _, out = hcom('list', '--json')
    try:
        return {agent['base_name']: agent['launch_context']['process_id']
                for agent in json.loads(out)}
    except (ValueError, KeyError, TypeError):
        return {}


def launched_with(tool, process_id):
    """(model, effort) on the command line of the agent process hcom started, or None.

    hcom puts HCOM_PROCESS_ID in the agent's environment, so the agent's own process
    tells which launch it came from.
    """
    if not process_id:
        return None
    marker = f'HCOM_PROCESS_ID={process_id}'.encode()
    for proc in PROC.glob('[0-9]*'):
        try:
            if marker not in (proc / 'environ').read_bytes().split(b'\0'):
                continue
            argv = (proc / 'cmdline').read_bytes().decode(errors='replace').split('\0')
        except OSError:
            continue
        names = [word.rsplit('/', 1)[-1] for word in argv]
        if tool in names:
            launch = guard.read_launch(tool, argv[names.index(tool) + 1:])
            if launch and launch['model']:
                return launch['model'], launch['effort'].lower()
    return None


def full_name(data, name):
    return f"{data['tag']}-{name}" if data.get('tag') else name


def tab_label(spawner, name):
    """Herdr tab label for an agent: last segment of its spawner's name, then its own."""
    return f"{spawner.rsplit('-', 1)[-1]}-{name}"


def label_tabs(spawner, agents):
    """Rename each agent's Herdr tab to tab_label; return the agents (base name -> full
    name) whose pane is not known yet. Failures only go to watch.log.

    The pane is the agent's launch_context.pane_id in `hcom list`, found by full name since
    base names can repeat under other tags; agents launched in another terminal
    (terminal_preset_effective other than herdr) are skipped.
    """
    _, listing = hcom('list', '--json')
    try:
        contexts = {agent['name']: agent.get('launch_context') or {}
                    for agent in json.loads(listing)}
    except (ValueError, KeyError, TypeError, AttributeError):
        contexts = {}
    waiting = {}
    for name, full in agents.items():
        context, label = contexts.get(full, {}), tab_label(spawner, name)
        preset, pane = context.get('terminal_preset_effective'), context.get('pane_id')
        if preset and preset != 'herdr':
            log(f'tab {label} not set: launched in {preset}, not herdr')
            continue
        if not pane:
            waiting[name] = full
            continue
        code, out = herdr('pane', 'get', pane)
        try:
            tab = json.loads(out)['result']['pane']['tab_id'] if code == 0 else None
        except (ValueError, KeyError, TypeError):
            tab = None
        if not tab:
            log(f'tab {label} not set: herdr pane get {pane}: {out.strip()[:200]}')
            continue
        code, out = herdr('tab', 'rename', tab, label)
        if code:
            log(f'tab {label} not set: herdr tab rename {tab}: {out.strip()[:200]}')
    return waiting


def start_labels(spawner, agents):
    """Retry label_tabs on its own thread until every pane is known or LABEL_WAIT
    seconds pass, so slow herdr calls never hold up the launch check."""
    def run():
        pending, end = agents, time.monotonic() + LABEL_WAIT
        while pending := label_tabs(spawner, pending):
            if time.monotonic() >= end:
                log(f"tabs not set: no herdr pane in hcom list for {', '.join(pending.values())}")
                return
            time.sleep(LABEL_POLL)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread


def watch_blocked(event, watched):
    """Subscribe the batch's spawner to its agents' approval prompts, once per batch and
    as soon as any watcher sees it, whether or not the batch is attributed yet."""
    data = event['data']
    if not claim(f"{data.get('batch_id') or event['id']}.blocked"):
        return
    spawner = data.get('by')
    if not spawner or not NAME.match(spawner):
        return
    for name in data['instances']:
        if NAME.match(name):
            full = full_name(data, name)
            watched[name] = (subscribe(name, spawner, event['id']), event['id'], full, spawner,
                             data.get('tool'))
            if data.get('tool') == 'codex':
                mark_covered(full)
            if (not stopped_since(name, event['id'])
                    and events('--type', 'status', '--status', 'blocked', '--agent', name,
                               '--sql', f"id > {event['id']}")):
                notify(spawner, f'{full_name(data, name)} is waiting for approval (blocked); '
                                f'look at it with `hcom term {full_name(data, name)}`.')


def find_batch(spawner, tool, tag, after_id, model, effort, watched):
    """The batch this command launched, and why it could not be attributed (None if it was).

    Every candidate seen also gets its approval-prompt subscription (watch_blocked).

    Candidates are batches by this spawner with this tool (and tag, when given) after
    after_id that no other watcher has taken. One whose agent was started with this model
    and effort is ours. One whose agent's command line stays unreadable for ARGS_WAIT
    seconds, or that no watcher has taken by the end of BATCH_WAIT, is taken unattributed:
    its approval prompts and permission are still checked, but its model and effort are
    not compared with this command's.

    hcom records the spawner by base name, so `--name <tag>-<base>` matches `by: <base>`.
    """
    start, first_seen, last = clock(), {}, False
    while not last:
        last = clock() - start >= BATCH_WAIT
        batches = sorted((event for event in events(
                              '--type', 'life', '--action', 'batch_launched',
                              '--sql', f"id > {after_id} AND (life_by = '{spawner}' "
                                       f"OR '{spawner}' LIKE '%-' || life_by)")
                          if event.get('data', {}).get('tool') == tool
                          and event['data'].get('instances')
                          and (not tag or event['data'].get('tag') == tag)),
                         key=lambda event: event['id'])
        processes = process_ids() if batches else {}
        for event in batches:
            watch_blocked(event, watched)
            batch_id = str(event['data'].get('batch_id') or event['id'])
            if (state_dir() / 'claims' / batch_id).exists():
                continue
            args = launched_with(tool, processes.get(event['data']['instances'][0], ''))
            if args == (model, effort.lower()):
                why = None
            elif args is None and clock() - first_seen.setdefault(batch_id, clock()) >= ARGS_WAIT:
                why = 'its command line could not be read'
            elif last and args is not None:
                why = f'it was started with model {args[0]}, effort {args[1]}'
            else:
                continue
            if claim(batch_id):
                return event, why
        check_capacity(watched)
        if not last:
            sleep(POLL)
    return None, None


def stopped_since(name, after_id):
    return bool(events('--type', 'life', '--action', 'stopped', '--agent', name,
                       '--sql', f'id > {after_id}'))


def subscribe(name, spawner, launch_id):
    code, out = hcom('events', 'sub', '--blocked', name, '--for', spawner)
    match = re.search(r'\b(sub-[0-9a-f]+)\b', out)
    if code or not match:
        return None
    sub = match.group(1)
    record = {'sub': sub, 'agent': name, 'spawner': spawner, 'launch_id': launch_id}
    (state_dir() / 'subs' / f'{sub}.json').write_text(json.dumps(record))
    return sub


def unsubscribe(sub):
    """Remove the subscription; keep its record for the next sweep if hcom still has it."""
    code, _ = hcom('events', 'unsub', sub)
    if code:
        code, listed = hcom('events', 'sub', 'list')
        if code or re.search(rf'^{re.escape(sub)}\s', listed, re.M):
            return
    (state_dir() / 'subs' / f'{sub}.json').unlink(missing_ok=True)


def sweep():
    """Remove subscriptions left by a watcher that died before its agents stopped, and
    batch claims older than a day."""
    for path in (state_dir() / 'claims').iterdir():
        try:
            if path.stat().st_mtime < time.time() - 86400:
                path.unlink()
        except OSError:
            continue
    for path in (state_dir() / 'subs').glob('*.json'):
        try:
            record = json.loads(path.read_text())
            agent, launch_id, sub = record['agent'], int(record['launch_id']), record['sub']
        except FileNotFoundError:  # another watcher removed it meanwhile
            continue
        except (OSError, ValueError, KeyError, TypeError):
            path.unlink(missing_ok=True)
            continue
        if NAME.match(str(agent)) and stopped_since(agent, launch_id):
            unsubscribe(sub)


def norm_model(text):
    text = re.sub(r'\[.*?\]', '', text.lower().strip())
    return re.sub(r'[\s._]+', '-', re.sub(r'^claude-', '', text))


def read_screen(tool, lines, seen):
    """Record model, effort and permission shown on one screen; first value seen wins."""
    def note(item, value):
        seen.setdefault(item, (value, 'screen'))

    for line in lines:
        if tool == 'claude':
            if match := CLAUDE_BANNER.search(line):
                note('model', match.group(1))
                note('effort', match.group(2))
            if match := CLAUDE_EFFORT.search(line):
                note('effort', match.group(1))
            if match := CLAUDE_MODES.search(line):
                note('permission', match.group(1))
        else:
            if match := CODEX_STATUS.search(line) or CODEX_BANNER.search(line):
                note('model', match.group(1))
                note('effort', match.group(2))
            if match := CODEX_PERMISSION.search(line):
                note('permission', match.group(1))


def read_session_log(tool, path, seen):
    """Fill items the screen did not show from the agent's session log."""
    found = {}
    try:
        with open(path) as log:
            for line in log:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if tool == 'claude':
                    if entry.get('type') == 'permission-mode' and entry.get('permissionMode'):
                        found['permission'] = entry['permissionMode']
                    if entry.get('type') == 'assistant':
                        found['model'] = entry.get('message', {}).get('model') or found.get('model')
                        found['effort'] = entry.get('effort') or found.get('effort')
                elif entry.get('type') == 'turn_context':
                    payload = entry.get('payload', {})
                    approval = payload.get('approval_policy')
                    sandbox = (payload.get('sandbox_policy') or {}).get('type')
                    found['model'] = payload.get('model')
                    found['effort'] = payload.get('effort')
                    found['permission'] = ('YOLO' if (approval, sandbox) == ('never', 'danger-full-access')
                                           else f'approval {approval}, sandbox {sandbox}')
    except OSError:
        return
    for item, value in found.items():
        if value:
            seen.setdefault(item, (value, 'session log'))


def matches(tool, item, expected, actual):
    if item == 'model':
        return norm_model(actual) == norm_model(expected)
    if item == 'effort':
        return actual.lower() == expected.lower()
    if tool == 'claude':
        return actual in ('bypass permissions on', 'bypassPermissions')
    return 'YOLO' in actual


def report(tool, full, expected, seen, reason, unattributed=None):
    """Message text for the spawner, or None when everything matched.

    Unattributed agents have no expected model or effort: those are listed as seen.
    """
    problems = []
    for item in ITEMS:
        if expected[item] is None:
            value, source = seen.get(item, ('nothing', 'screen'))
            problems.append(f'{item}: launch command unknown, {source} shows {value}')
        elif item not in seen:
            problems.append(f'{item}: expected {expected[item]}, could not confirm ({reason})')
        elif not matches(tool, item, expected[item], seen[item][0]):
            value, source = seen[item]
            problems.append(f'{item}: expected {expected[item]}, {source} shows {value}')
    if not problems:
        return None
    if unattributed:
        return (f'hcom-spawn launch check: could not tell which launch command started {full} '
                f'({tool}): {unattributed}. ' + '; '.join(problems)
                + f'. Look at it with `hcom term {full}`; it was not stopped.')
    return (f'hcom-spawn launch check: {full} ({tool}) does not match its launch command. '
            + '; '.join(problems)
            + f'. Look at it with `hcom term {full}`; it was not stopped.')


def release_stopped(watched):
    """Unsubscribe watched agents that stopped since their launch."""
    for name, (sub, launch_id, full, *_) in list(watched.items()):
        if stopped_since(name, launch_id):
            if sub:
                unsubscribe(sub)
            release(name, full)
            del watched[name]


def release(name, full):
    """Stop covering an agent's capacity: lat-watch takes it over again."""
    episodes.pop(name, None)
    api_errors.pop(name, None)
    (state_dir() / 'capacity' / f'{full}.json').unlink(missing_ok=True)
    (state_dir() / 'capacity' / f'{full}.continued.json').unlink(missing_ok=True)


@contextlib.contextmanager
def capacity_lock():
    """Lock shared with lat-watch, which checks coverage and types Continue while holding it."""
    fd = os.open(state_dir() / 'capacity', os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def process_start(pid):
    """Start time of a process (field 22 of /proc/<pid>/stat), or None."""
    try:
        stat = (PROC / str(pid) / 'stat').read_text()
        return int(stat.rsplit(')', 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def mark_covered(full):
    """Record that this process handles the agent's capacity, so lat-watch skips it.

    lat-watch trusts the record while the process with this pid and start time runs.
    """
    pid = os.getpid()
    record = {'agent': full, 'pid': pid, 'start': process_start(pid)}
    with capacity_lock():
        (state_dir() / 'capacity' / f'{full}.json').write_text(json.dumps(record))


def lat_continue(full, transcript):
    """(clock() time, transcript size) of a Continue lat-watch typed into this transcript
    before this watcher covered the agent, or None. lat-watch writes
    <agent>.continued.json while holding capacity_lock, so it exists by the time
    mark_covered returns; a record for another transcript is left over from an earlier
    agent with the same name."""
    path = state_dir() / 'capacity' / f'{full}.continued.json'
    try:
        record = json.loads(path.read_text())
        at, size = float(record['at']), record.get('size')
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    path.unlink(missing_ok=True)
    if record.get('transcript') not in (None, transcript):
        return None
    return clock() - max(0.0, time.time() - at), size if isinstance(size, int) else None


def check_capacity(watched):
    """Run capacity_step for the watched Codex agents at most every CAPACITY_POLL seconds."""
    if last_capacity_check[0] is not None and clock() - last_capacity_check[0] < CAPACITY_POLL:
        return
    last_capacity_check[0] = clock()
    for name, (_, launch_id, full, spawner, tool) in list(watched.items()):
        if tool == 'codex' and not stopped_since(name, launch_id):
            capacity_step(name, full, spawner)


def capacity_on_screen(lines, input_text=''):
    """True when the last error on a Codex screen is the model-capacity error."""
    for index in range(len(lines) - 1, -1, -1):
        if CAPACITY_ERROR.search(lines[index]):
            return capacity_is_current(lines, index, input_text)
    return False


def api_error_on_screen(lines, input_text=''):
    """Text of the last `■ {"type":"error",...}` on a Codex screen when it is still current
    (capacity_is_current), else None. Rows the error wrapped onto are joined until its JSON
    is complete, a blank row or the next prompt, reply or error."""
    for index in range(len(lines) - 1, -1, -1):
        if API_ERROR.search(lines[index]):
            if not capacity_is_current(lines, index, input_text):
                return None
            text = lines[index].strip()
            for line in lines[index + 1:]:
                try:
                    json.loads(text[1:])
                    break
                except ValueError:
                    pass
                if not line.strip() or line.lstrip().startswith(('› ', '• ', '■ ', 'Working (')):
                    break
                text += line.strip()
            return text[:API_ERROR_CHARS]
    return None


def capacity_is_current(lines, index, input_text=''):
    """Same rule as lat-watch: any later reply, error, work or submitted prompt replaces it.

    The last prompt row showing the unsent input_text is the input box, not a new prompt.
    """
    prompts = [i for i in range(index + 1, len(lines)) if lines[i].startswith('› ')]
    typed = (input_text or '').strip().split('\n')[0].strip()
    for i, line in enumerate(lines[index + 1:], index + 1):
        stripped = line.strip()
        if stripped.startswith('Working (') or line.startswith(('• ', '■ ')):
            return False
        if line.startswith('› ') and stripped != '› Ask Codex to do anything':
            shown = stripped[2:].strip()
            if not (typed and shown and i == prompts[-1]
                    and (typed.startswith(shown) or shown.startswith(typed))):
                return False
    return True


def transcript_records(transcript, offset, size):
    """Complete records of the transcript between offset and size (at most the last
    TRANSCRIPT_TAIL_BYTES); unreadable is none."""
    if not transcript or size <= offset:
        return []
    start = max(offset, size - TRANSCRIPT_TAIL_BYTES)
    try:
        with Path(transcript).open('rb') as stream:
            stream.seek(start)
            lines = stream.read(size - start).split(b'\n')
    except OSError:
        return []
    # The last piece is empty or a record still being written; a cut first line is partial.
    lines = lines[1:-1] if start > offset else lines[:-1]
    records = []
    for raw in lines:
        try:
            record = json.loads(raw)
        except (ValueError, RecursionError):
            continue
        if isinstance(record, dict) and isinstance(record.get('payload'), dict):
            records.append(record)
    return records


def is_output(record):
    """A complete Codex reply or tool record (same rule as lat-watch)."""
    payload = record['payload']
    if record.get('type') == 'response_item':
        return (payload.get('role') == 'assistant'
                or payload.get('type') not in ('message', 'reasoning'))
    item = payload.get('item')
    return record.get('type') == 'event_msg' and (
        payload.get('type') == 'agent_message'
        or (payload.get('type') == 'item_completed' and isinstance(item, dict)
            and item.get('type') == 'AgentMessage'))


def output_since(transcript, offset, size):
    """True only for a complete Codex reply or tool record after offset; unknown is False."""
    return any(is_output(record) for record in transcript_records(transcript, offset, size))


def capacity_step(name, full, spawner):
    """Handle one check of a Codex agent that may be stopped on model capacity.

    An episode starts when the last error on the screen is the capacity error. With an
    empty input box Continue + Enter is typed once; with text in it the spawner is told at
    once instead. Still on capacity CAPACITY_NOTICE seconds after Continue, the spawner is
    told once. Only a complete agent reply or tool call in the transcript after the episode
    began ends it. A Continue lat-watch typed before this watcher covered the agent starts
    the episode instead of a new one. When the last error is another API error
    (`■ {"type":"error",...}`) the spawner is told once per distinct error text, with
    nothing typed. Inactive agents are left alone; failed sends are retried next check.
    """
    code, out = hcom('list', full, '--json')
    try:
        info = json.loads(out) if code == 0 else None
    except ValueError:
        info = None
    if not isinstance(info, dict) or info.get('status') == 'inactive':
        return
    transcript = info.get('transcript_path') or ''
    try:
        size = Path(transcript).stat().st_size if transcript else 0
    except OSError:
        size = 0
    episode = episodes.get(name)
    if episode and output_since(transcript, episode['offset'], size):
        del episodes[name]
        episode = None
    if episode is None and (handed := lat_continue(full, transcript)) is not None:
        # lat-watch typed Continue for this episode; the 5 minutes count from then, and
        # output written since then already ended it.
        at, offset = handed
        offset = size if offset is None else offset
        if not output_since(transcript, offset, size):
            episode = episodes[name] = {'offset': offset, 'at': at, 'continued': True}
    code, out = hcom('term', full, '--json', timeout=10)
    try:
        screen = json.loads(out) if code == 0 else None
    except ValueError:
        screen = None
    if not isinstance(screen, dict):
        return
    lines = [str(line) for line in screen.get('lines') or []]
    if not capacity_on_screen(lines, screen.get('input_text')):
        error = api_error_on_screen(lines, screen.get('input_text'))
        told = api_errors.setdefault(name, set())
        if error and error not in told and notify(
                spawner, f'hcom-spawn: {full} (codex) stopped on an API error: {error} '
                         f'It was not retried. Look at it with `hcom term {full}`; switch '
                         'model or account, or hand the work to another agent.') == 0:
            told.add(error)
        return
    where = f'{full} (codex) stopped on "Selected model is at capacity".'
    if episode is None:
        if screen.get('prompt_empty') is not True or screen.get('input_text'):
            if notify(spawner, f'hcom-spawn: {where} Continue was not typed because its input '
                               f'box has text. Look at it with `hcom term {full}`; switch '
                               'model or hand the work to another agent.') == 0:
                episodes[name] = {'offset': size, 'at': clock(), 'continued': False}
            return
        code, out = hcom('term', 'inject', full, CAPACITY_CONTINUE, '--enter')
        if code:
            log(f'Continue not typed into {full}: {out.strip()[:200]}')
            return
        episodes[name] = {'offset': size, 'at': clock(), 'continued': True}
    elif (episode['continued'] and not episode.get('notified')
          and clock() - episode['at'] >= CAPACITY_NOTICE):
        if notify(spawner, f'hcom-spawn: {where} Continue was sent '
                           f"{int((clock() - episode['at']) // 60)} minutes ago with no "
                           f'reaction. Switch model or hand the work to another agent '
                           f'(`hcom term {full}`).') == 0:
            episode['notified'] = True


def check(tool, agents, expected, watched, launch_id, start, unattributed=None):
    """Read screens (then session logs) until every item is known or time runs out.

    Agents that stop meanwhile get no report.
    """
    seen = {name: {} for name in agents}
    reasons = {name: 'agent did not become ready' for name in agents}
    ready_at, logs, pending, stopped = {}, {}, set(agents), set()
    while pending and clock() - start < DEADLINE:
        release_stopped(watched)
        check_capacity(watched)
        stopped |= {name for name in pending if stopped_since(name, launch_id)}
        pending -= stopped
        for name in sorted(pending):
            full = agents[name]
            code, out = hcom('term', full, '--json', timeout=10)
            try:
                screen = json.loads(out) if code == 0 else None
            except ValueError:
                screen = None
            if screen:
                read_screen(tool, [str(line) for line in screen.get('lines', [])], seen[name])
                if screen.get('ready'):
                    ready_at.setdefault(name, clock())
                    reasons[name] = 'not shown on the screen or in the session log'
            elif name not in ready_at:
                reasons[name] = 'screen could not be read: ' + (out.strip() or 'no output')[:120]
            if name in ready_at and clock() - ready_at[name] > SCREEN_WINDOW:
                if name not in logs:
                    _, listed = hcom('list', full, '--json')
                    try:
                        logs[name] = json.loads(listed).get('transcript_path') or ''
                    except (ValueError, AttributeError):
                        logs[name] = ''
                if logs[name]:
                    read_session_log(tool, logs[name], seen[name])
            if all(item in seen[name] for item in ITEMS):
                pending.discard(name)
        sleep(POLL)
    stopped |= {name for name in agents if stopped_since(name, launch_id)}
    return {name: report(tool, agents[name], expected, seen[name],
                         f'{reasons[name]} within {DEADLINE}s', unattributed)
            for name in agents if name not in stopped}


def notify(spawner, text):
    return hcom('send', f'@{spawner}', '--intent', 'inform', '--from', SENDER, '--', text)[0]


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--spawner', required=True)
    parser.add_argument('--tool', required=True, choices=sorted(EXPECTED_PERMISSION))
    parser.add_argument('--model', required=True)
    parser.add_argument('--effort', required=True)
    parser.add_argument('--after-id', required=True, type=int)
    parser.add_argument('--tag', default='')
    args = parser.parse_args(argv)
    if not NAME.match(args.spawner):
        return 1
    sweep()
    watched = {}
    batch, unattributed = find_batch(args.spawner, args.tool, args.tag, args.after_id,
                                     args.model, args.effort, watched)
    if batch:
        start = clock()
        data, launch_id = batch['data'], batch['id']
        spawner = data.get('by') or args.spawner
        agents = {name: full_name(data, name) for name in data['instances'] if NAME.match(name)}
        labels = start_labels(spawner, agents)
        expected = {'model': None if unattributed else args.model,
                    'effort': None if unattributed else args.effort,
                    'permission': EXPECTED_PERMISSION[args.tool]}
        for text in check(args.tool, agents, expected, watched, launch_id, start,
                          unattributed).values():
            if text:
                notify(spawner, text)
    try:
        while watched:
            sleep(STOP_POLL)
            release_stopped(watched)
            check_capacity(watched)
    finally:
        for name, (_, _, full, *_) in watched.items():
            release(name, full)
    if batch:
        labels.join()
    return 0

if __name__ == '__main__':
    sys.exit(main())
