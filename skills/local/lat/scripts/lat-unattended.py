#!/usr/bin/env python3
"""LAT unattended mode: which mode a controller is in, and this round's unattended grant
(stdlib only).

The mode comes from three layers, narrowest first: the controller (`unattended` in its session
record), the project and global pre-authorization files ([unattended] in .lat/preauth.toml and
$XDG_CONFIG_HOME/lat/preauth.toml). Each value is taken from the narrowest layer that sets it; a
project `mode = "follow-global"` counts as not set; with no layer the initial values apply
(manual, all three delegations on, 12 hours). Running out of quota always stops.

The grant belongs to one round of one session (.lat/unattended/<session>-r<round>.json). Each
version has a goal, done conditions, the delegation scope, stop conditions, the source and the
human evidence, and a start; it ends when replaced, closed, at the time limit, or when the round
ends. A new round or a successor controller starts with no grant.

`status` prints the mode with each value's layer and the grant state; `versions` lists every
version; `create`, `update` and `close` change the grant; `check` says whether a version was in
effect at a moment. `--json` prints one JSON object, for the board helper.
"""
import argparse
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _lat_common import shared_lat_dir, write_json_atomic, write_text_atomic


def load_preauth():
    spec = importlib.util.spec_from_file_location(
        'lat_preauth', Path(__file__).resolve().parent / 'lat-preauth.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


preauth = load_preauth()
Refused = preauth.Refused

SCOPE_KEYS = ('ticket_confirmation', 'assume_defaults', 'prototype_decide')
SCOPE_WORDS = {'ticket-confirmation': 'ticket_confirmation', 'assume-defaults': 'assume_defaults',
               'prototype': 'prototype_decide'}
SETTING_KEYS = ('mode', *SCOPE_KEYS, 'max_hours')
INITIAL = dict(mode='manual', ticket_confirmation=True, assume_defaults=True,
               prototype_decide=True, max_hours=12)
LAYER_LABELS = {'controller': '主控', 'project': '專案', 'global': '全域', 'default': '初始值'}
MODE_LABELS = {'manual': '人工確認', 'unattended': '無人模式'}
SCOPE_LABELS = {'ticket_confirmation': '短流程票代確認', 'assume_defaults': '在固定清單內選預設',
                'prototype_decide': '做樣品再決定'}
CREATE_SOURCES = ('board-form', 'chat', 'settings-default')
UPDATE_SOURCES = ('user-edit', 'chat')
CLOSE_REASONS = {'off': '使用者關掉', 'quota': '額度用完', 'delivered': '交付',
                 'cancelled': '取消', 'handover': '換班'}
END_LABELS = dict(CLOSE_REASONS, superseded='被新版本取代', **{'time-limit': '時間上限到期'})
DRAFTED_NOTE = '目標由主控擬出'
STATE_LABELS = {'pending-goal': '無人模式，尚待目標',
                'active': '無人授權有效', 'none': '無有效授權'}


def now():
    return datetime.now(timezone.utc)


def stamp(moment):
    return moment.isoformat()


# Paths and records ------------------------------------------------------------------------

def session_file(lat, session):
    return lat / 'sessions' / f'{session}.json'


def session_lock(lat, session):
    """The lock lat-session deactivate and lat-preauth hold while they change this record."""
    return lat / 'watch' / f'{session}.lock'


def grant_file(lat, session, round_number):
    return lat / 'unattended' / f'{session}-r{round_number}.json'


def read_session(lat, session):
    """(record, its bytes, round number)."""
    path = session_file(lat, session)
    try:
        original = path.read_bytes()
        record = json.loads(original)
    except FileNotFoundError:
        raise Refused(f'no session record {path}') from None
    except ValueError as error:
        raise Refused(f'unreadable session record {path} ({error})') from None
    history = record.get('history', []) if isinstance(record, dict) else None
    if not isinstance(history, list):
        raise Refused(f'session record {path} is not an object with a list `history`')
    return record, original, len(history) + 1


def read_grant(lat, session, round_number):
    """(versions, bytes or None)."""
    path = grant_file(lat, session, round_number)
    try:
        original = path.read_bytes()
    except FileNotFoundError:
        return [], None
    try:
        versions = json.loads(original)['versions']
        if not isinstance(versions, list) or not all(isinstance(v, dict) for v in versions):
            raise ValueError('`versions` is not a list of objects')
    except (ValueError, KeyError, TypeError) as error:
        raise Refused(f'unreadable grant file {path} ({error})') from None
    return versions, original


def write_grant(lat, session, round_number, versions, original):
    path = grant_file(lat, session, round_number)
    write_json_atomic(path, dict(session=session, round=round_number, versions=versions),
                      expected=original)
    return path


def restore(path, original):
    if original is None:
        path.unlink(missing_ok=True)
    else:
        write_text_atomic(path, original.decode('utf-8'))


# Mode resolution ------------------------------------------------------------------------------

def file_problems(layer, problems):
    """Only problems that touch [unattended] or leave the file unreadable count here."""
    return [problem for problem in problems
            if '[unattended]' in problem or 'malformed TOML' in problem or 'unreadable' in problem]


def without_follow(layer):
    """The layer as `resolve` reads it, with `mode = "follow-global"` counted as not set."""
    values = preauth.section(layer, ('unattended',)) if layer.present else None
    if values and values.get('mode') == 'follow-global':
        values = {key: value for key, value in values.items() if key != 'mode'}
        return preauth.Layer(layer.name, layer.location, {'unattended': values}, True)
    return layer


def resolve_mode(lat, record):
    """({key: dict(value, layer, source)}, problems). Problems fall back to manual."""
    controller = record.get('unattended', {}) if isinstance(record, dict) else {}
    problems = preauth.unattended_problems(controller, 'session record `unattended`')
    layers = [preauth.Layer('controller', 'session record', {'unattended': controller},
                            isinstance(controller, dict))]
    for name, path in (('project', lat / 'preauth.toml'), ('global', preauth.global_path())):
        layer, found = preauth.file_layer(name, path)
        problems += file_problems(layer, found)
        layers.append(layer)
    found = preauth.resolve([without_follow(layer) for layer in layers], ('unattended',),
                            SETTING_KEYS)
    values = {key: dict(value=INITIAL[key], layer='default', source=None) for key in SETTING_KEYS}
    values.update({key: dict(value=value, layer=name, source=source)
                   for key, (value, name, source) in found.items()})
    if problems:
        values['mode'] = dict(value='manual', layer='default', source=None)
    return values, problems


# Grant state ----------------------------------------------------------------------------------

def parse(value):
    moment = datetime.fromisoformat(value)
    return moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)


def deadline(versions):
    """When the open version's time limit runs out, counted from the round's first version."""
    current = versions[-1]
    return parse(versions[0]['started_at']) + timedelta(hours=current['stop']['max_hours'])


def open_version(versions):
    return versions[-1] if versions and versions[-1].get('ended_at') is None else None


def end_version(version, moment, reason):
    version['ended_at'] = stamp(moment)
    version['end_reason'] = reason


def expire(versions, moment):
    """End the open version at its deadline when that has passed; whether it did."""
    current = open_version(versions)
    if current and moment >= deadline(versions):
        end_version(current, deadline(versions), 'time-limit')
        return True
    return False


def grant_state(record, values, versions):
    """(state, the open version or None)."""
    current = open_version(versions)
    if record.get('status') != 'active' or values['mode']['value'] != 'unattended':
        return 'none', None
    if current:
        return 'active', current
    if not versions and values['mode']['layer'] in ('project', 'global'):
        return 'pending-goal', None
    return 'none', None


def snapshot(lat, session, *, persist_expiry=True):
    """Everything `status` reports. Ends an expired version on disk while holding the lock."""
    with preauth.locked(session_lock(lat, session)):
        record, _, round_number = read_session(lat, session)
        values, problems = resolve_mode(lat, record)
        versions, original = read_grant(lat, session, round_number)
        if persist_expiry and record.get('status') == 'active' and expire(versions, now()):
            write_grant(lat, session, round_number, versions, original)
    state, current = grant_state(record, values, versions)
    return dict(session=session, round=round_number, round_active=record.get('status') == 'active',
                settings=values, quota_stop=True, problems=problems, state=state,
                state_label=STATE_LABELS[state], version=current,
                ends_at=stamp(deadline(versions)) if current else None,
                last_end=None if current or not versions else dict(
                    version=versions[-1]['version'], ended_at=versions[-1]['ended_at'],
                    reason=versions[-1]['end_reason']))


# Evidence -------------------------------------------------------------------------------------

def chat_evidence_problem(record, lat, evidence):
    """A chat grant cites the panel answer record `<decision ID> r<N>` the user answered."""
    directory = record.get('decisions_path')
    directory = Path(directory) if isinstance(directory, str) else lat / 'decisions'
    problem = preauth.prior_promise_problem(evidence, directory)
    if problem:
        return problem
    path = directory / f'{evidence.split()[0]}.md'
    problems, _ = preauth.human_answer_problems(path)
    return '; '.join(problems) or None


def settings_evidence_problem(lat, values, evidence):
    """A settings-default grant cites the board write that set the mode to unattended in the
    layer the mode now comes from, and no later board write changed that key."""
    layer = values['mode']['layer']
    if layer not in ('project', 'global'):
        return (f'the mode comes from the {LAYER_LABELS[layer]} layer, not a project or global '
                'default')
    target = str(lat / 'preauth.toml' if layer == 'project' else preauth.global_path())
    path = preauth.board_writes_path()
    latest = None
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except FileNotFoundError:
        lines = []
    for line in lines:
        try:
            entry = json.loads(line)
            changes = [change for change in entry['changes']
                       if change['section'] == 'unattended' and change['key'] == 'mode']
        except (ValueError, KeyError, TypeError):
            continue
        if entry.get('file') == target and changes:
            latest = (entry.get('source'), changes[-1]['value'])
    if latest is None or latest[0] != evidence:
        return (f'{evidence} is not the latest board write of [unattended] mode to {target} '
                f'(that is {latest[0] if latest else "none"} in {path})')
    if latest[1] != 'unattended':
        return f'board write {evidence} set mode to {latest[1]}, not unattended'
    return None


# Writes ---------------------------------------------------------------------------------------

def scope_of(words):
    if words == ['none']:
        return {key: False for key in SCOPE_KEYS}
    if 'none' in words:
        raise Refused('--scope none cannot go with other scopes')
    return {key: word in words for word, key in SCOPE_WORDS.items()}


def text_list(values):
    return [value.strip() for value in values or [] if value and value.strip()]


def owner(args):
    top, session = preauth.round_owner(args)
    return shared_lat_dir(top), session


def set_controller_mode(lat, session, record, original, mode):
    """Write the controller layer's mode into the session record; (path, bytes before)."""
    controller = dict(record.get('unattended') or {}, mode=mode)
    path = session_file(lat, session)
    write_json_atomic(path, dict(record, unattended=controller), expected=original)
    return path, original


def cmd_create(args):
    goal = (args.goal or '').strip()
    done = text_list(args.done)
    evidence = (args.evidence or '').strip()
    missing = [flag for flag, value in (('--goal', goal), ('--done', done),
                                         ('--scope', args.scope),
                                         ('--max-hours', args.max_hours),
                                         ('--source', args.source),
                                         ('--evidence', evidence)) if not value]
    if missing:
        raise Refused('a grant needs ' + ', '.join(missing))
    if args.max_hours <= 0:
        raise Refused('--max-hours must be above 0')
    scope = scope_of(args.scope)
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        record, record_bytes, round_number = read_session(lat, session)
        if record.get('status') != 'active':
            raise Refused(f'session {session} is not active; only an active round has a grant')
        values, problems = resolve_mode(lat, record)
        versions, original = read_grant(lat, session, round_number)
        moment = now()
        if expire(versions, moment):
            write_grant(lat, session, round_number, versions, original)
            original = grant_file(lat, session, round_number).read_bytes()
        if open_version(versions):
            raise Refused(f'version {versions[-1]["version"]} is in effect; change it with update')
        if args.source == 'chat':
            problem = chat_evidence_problem(record, lat, evidence)
        elif args.source == 'settings-default':
            problem = ('; '.join(problems) if problems else
                       'the round already had a grant; a default start only writes version 1'
                       if versions else settings_evidence_problem(lat, values, evidence))
        else:
            problem = None  # board-form: the board checks its signed-in device before calling
        if problem:
            raise Refused(problem)
        version = dict(version=len(versions) + 1, goal=goal, done=done, scope=scope,
                       stop=dict(quota=True, max_hours=args.max_hours), source=args.source,
                       evidence=evidence, started_at=stamp(moment), ended_at=None,
                       end_reason=None)
        if args.source == 'settings-default':
            version['note'] = DRAFTED_NOTE
        written = write_grant(lat, session, round_number, [*versions, version], original)
        if args.source != 'settings-default' and values['mode']['value'] != 'unattended':
            try:
                set_controller_mode(lat, session, record, record_bytes, 'unattended')
            except (OSError, ValueError) as error:
                restore(written, original)
                raise ValueError(f'could not set the controller mode ({error}); grant removed') \
                    from None
    return report(args, dict(status='ok', created=version), f'已建立第 {version["version"]} 版無人授權')


def cmd_update(args):
    evidence = (args.evidence or '').strip()
    missing = [flag for flag, value in (('--source', args.source), ('--evidence', evidence))
               if not value]
    if missing:
        raise Refused('an update needs ' + ', '.join(missing))
    if args.max_hours is not None and args.max_hours <= 0:
        raise Refused('--max-hours must be above 0')
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        record, _, round_number = read_session(lat, session)
        if record.get('status') != 'active':
            raise Refused(f'session {session} is not active')
        versions, original = read_grant(lat, session, round_number)
        moment = now()
        if expire(versions, moment):
            write_grant(lat, session, round_number, versions, original)
            raise Refused('the grant reached its time limit and ended; start a new one with create')
        current = open_version(versions)
        if not current:
            raise Refused('no grant in effect; start one with create')
        if args.source == 'chat' and (problem := chat_evidence_problem(record, lat, evidence)):
            raise Refused(problem)
        version = dict(
            version=current['version'] + 1,
            goal=(args.goal or '').strip() or current['goal'],
            done=text_list(args.done) or current['done'],
            scope=scope_of(args.scope) if args.scope else current['scope'],
            stop=dict(current['stop'], **({} if args.max_hours is None
                                          else dict(max_hours=args.max_hours))),
            source=args.source, evidence=evidence, started_at=stamp(moment), ended_at=None,
            end_reason=None)
        end_version(current, moment, 'superseded')
        write_grant(lat, session, round_number, [*versions, version], original)
    return report(args, dict(status='ok', created=version),
                  f'已改為第 {version["version"]} 版無人授權，立即生效')


def end_round_grant(lat, session, round_number, reason):
    """End this round's open version; the caller holds session_lock. The version ended, or None."""
    versions, original = read_grant(lat, session, round_number)
    moment = now()
    if expire(versions, moment):
        write_grant(lat, session, round_number, versions, original)
        return None
    current = open_version(versions)
    if current:
        end_version(current, moment, reason)
        write_grant(lat, session, round_number, versions, original)
    return current


def cmd_close(args):
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        record, record_bytes, round_number = read_session(lat, session)
        ended = end_round_grant(lat, session, round_number, args.reason)
        if args.reason == 'off' and record.get('status') == 'active':
            # The user turned it off: this controller goes back to asking.
            set_controller_mode(lat, session, record, record_bytes, 'manual')
    text = (f'已結束第 {ended["version"]} 版無人授權（{CLOSE_REASONS[args.reason]}）' if ended
            else '沒有生效中的無人授權')
    return report(args, dict(status='ok', ended=ended), text)


def cmd_check(args):
    """Whether version N was in effect at a moment; delegated decisions cite it."""
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        record, _, round_number = read_session(lat, session)
        versions, original = read_grant(lat, session, round_number)
        if record.get('status') == 'active' and expire(versions, now()):
            write_grant(lat, session, round_number, versions, original)
    moment = parse(args.at) if args.at else now()
    found = next((v for v in versions if v['version'] == args.version), None)
    if found is None:
        reason = f'version {args.version} does not exist in round {round_number}'
    elif moment < parse(found['started_at']):
        reason = f'version {args.version} started at {found["started_at"]}'
    elif found['ended_at'] and moment >= parse(found['ended_at']):
        reason = (f'version {args.version} ended at {found["ended_at"]} '
                  f'({END_LABELS.get(found["end_reason"], found["end_reason"])})')
    elif found['ended_at'] is None and record.get('status') != 'active':
        reason = f'round {round_number} has ended'
    else:
        reason = None
    result = dict(status='ok', effective=reason is None, reason=reason, version=found)
    report(args, result, '有效' if reason is None else f'無效：{reason}')
    return 0 if reason is None else 1


# Output ---------------------------------------------------------------------------------------

def report(args, result, text):
    print(json.dumps(result, ensure_ascii=False) if args.json else text)
    return 0


def version_lines(version):
    scope = '、'.join(SCOPE_LABELS[key] for key in SCOPE_KEYS if version['scope'][key]) or '無'
    ended = (f'{version["ended_at"]}（{END_LABELS.get(version["end_reason"], version["end_reason"])}）'
             if version['ended_at'] else '生效中')
    lines = [f'第 {version["version"]} 版：{version["started_at"]} → {ended}',
             f'  目標：{version["goal"]}', '  做完條件：',
             *[f'    - {item}' for item in version['done']],
             f'  可代決：{scope}',
             f'  停止條件：額度用完；時間上限 {version["stop"]["max_hours"]} 小時',
             f'  來源：{version["source"]}（證據 {version["evidence"]}）']
    if version.get('note'):
        lines.append(f'  註：{version["note"]}')
    return lines


def cmd_status(args):
    lat, session = owner(args)
    result = snapshot(lat, session)
    if args.json:
        return report(args, dict(status='ok', **result), '')
    values = result['settings']

    def origin(key):
        return LAYER_LABELS[values[key]['layer']]

    lines = [f'模式：{MODE_LABELS[values["mode"]["value"]]} ← {origin("mode")}', '代決範圍：']
    lines += [f'  {SCOPE_LABELS[key]}：{"開" if values[key]["value"] else "關"} ← {origin(key)}'
              for key in SCOPE_KEYS]
    lines.append(f'停止條件：額度用完一律停；時間上限 {values["max_hours"]["value"]} 小時 ← '
                 f'{origin("max_hours")}')
    if result['problems']:
        lines.append('設定有錯，視為人工確認：')
        lines += [f'  - {problem}' for problem in result['problems']]
    lines.append(f'無人授權：{result["state_label"]}')
    if result['version']:
        lines += version_lines(result['version'])
        lines.append(f'  時間上限到：{result["ends_at"]}')
    elif result['last_end']:
        end = result['last_end']
        lines.append(f'  第 {end["version"]} 版已於 {end["ended_at"]} 結束'
                     f'（{END_LABELS.get(end["reason"], end["reason"])}）')
    print('\n'.join(lines))
    return 0


def cmd_versions(args):
    lat, session = owner(args)
    snapshot(lat, session)  # ends an expired version first
    record, _, round_number = read_session(lat, session)
    versions, _ = read_grant(lat, session, round_number)
    if args.json:
        return report(args, dict(status='ok', round=round_number, versions=versions), '')
    print('\n'.join(line for version in versions for line in version_lines(version))
          or f'第 {round_number} 輪沒有無人授權')
    return 0


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--workspace', help='Git worktree of the controller; default the current '
                                            'directory')
    common.add_argument('--session-id', help='controller session ID; default '
                                             '$CLAUDE_CODE_SESSION_ID, then $CODEX_THREAD_ID')
    common.add_argument('--json', action='store_true', help='print one JSON object')
    parser = argparse.ArgumentParser(description='LAT unattended mode and grant')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('status', parents=[common],
                        help='mode, delegations and time limit with their layers; grant state')
    commands.add_parser('versions', parents=[common], help="every version of this round's grant")
    for name, text in (('create', 'start a grant (version 1, or after one ended)'),
                       ('update', 'replace the grant in effect with a new version')):
        sub = commands.add_parser(name, parents=[common], help=text)
        sub.add_argument('--goal', help='the goal of this round')
        sub.add_argument('--done', action='append', help='one done condition; repeat per line')
        sub.add_argument('--scope', nargs='+', choices=(*SCOPE_WORDS, 'none'),
                         help='what the advisors may decide; `none` for nothing')
        sub.add_argument('--max-hours', type=int, help='time limit in hours')
        sub.add_argument('--source', choices=CREATE_SOURCES if name == 'create' else UPDATE_SOURCES,
                         help='board-form/user-edit: the board form; chat: a confirmation '
                              'question; settings-default: the project or global default')
        sub.add_argument('--evidence', help='board-form/user-edit: the board action record; chat: '
                                            '`<decision ID> r<N>` the user answered; '
                                            'settings-default: the board settings write '
                                            '(`board:<time>`)')
    sub = commands.add_parser('close', parents=[common], help='end the grant in effect')
    sub.add_argument('--reason', required=True, choices=CLOSE_REASONS,
                     help='off: the user turned it off (the controller goes back to manual); '
                          'quota: quota ran out; delivered, cancelled, handover: the round ended')
    sub = commands.add_parser('check', parents=[common],
                              help='exit 0 when a version was in effect at a moment, else 1')
    sub.add_argument('--version', type=int, required=True)
    sub.add_argument('--at', help='ISO time; default now')
    return parser


COMMANDS = dict(status=cmd_status, versions=cmd_versions, create=cmd_create, update=cmd_update,
                close=cmd_close, check=cmd_check)


def main():
    args = build_parser().parse_args()
    args.controller_workspace = None  # preauth.round_owner reads it
    try:
        return COMMANDS[args.command](args)
    except Refused as error:
        if args.json:
            print(json.dumps(dict(status='refused', reason=str(error)), ensure_ascii=False))
        print(f'lat-unattended: refused, nothing changed: {error}', file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f'lat-unattended: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
