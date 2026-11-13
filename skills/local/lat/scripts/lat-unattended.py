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
effect at a moment; `draft` keeps the goal the controller proposes, which is no grant. `settings`
and `settings-write` read and write the global and project layers for the board. `--json` prints
one JSON object, for the board helper.
"""
import argparse
from dataclasses import dataclass
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
END_LABELS = dict(CLOSE_REASONS, superseded='被新版本取代', **{'time-limit': '時間上限到期',
                                                          'mode-manual': '模式改為人工確認',
                                                          'settings-error': '設定有錯'})
DRAFTED_NOTE = '目標由主控擬出'
STATE_LABELS = {'pending-goal': '無人模式，尚待目標',
                'active': '無人授權有效', 'none': '無有效授權'}
# The board's log of what a signed-in device did; a board-form or user-edit grant cites the
# request line the board wrote there before calling this tool.
SENT_LOG = 'sent-log.jsonl'
BOARD_EVIDENCE = 'board-action:'
BOARD_REQUEST_OPS = {'board-form': 'create', 'user-edit': 'update'}
# How long before the grant the user's request may have been made.
REQUEST_WINDOW = timedelta(minutes=10)


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


def draft_file(lat, session, round_number):
    """The goal the controller proposes for this round; never a grant."""
    return lat / 'unattended' / f'{session}-r{round_number}.draft.json'


def read_draft(lat, session, round_number):
    """The draft, or None; one that cannot be read is no draft: it is never a grant."""
    try:
        draft = json.loads(draft_file(lat, session, round_number).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None
    return draft if isinstance(draft, dict) else None


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
    """The bytes written."""
    return write_json_atomic(grant_file(lat, session, round_number),
                             dict(session=session, round=round_number, versions=versions),
                             expected=original)


def restore(path, original):
    if original is None:
        path.unlink(missing_ok=True)
    else:
        write_text_atomic(path, original.decode('utf-8'))


# Mode resolution ------------------------------------------------------------------------------

def layer_problems(layer, problems):
    """Problems of one file layer that matter here: all of them when the file could not be
    read at all, else only those of its [unattended] section."""
    if problems and not layer.data:
        return problems
    values = layer.data.get('unattended')
    if values is None:
        return []
    found = preauth.unattended_problems(values, f'{layer.name} layer {layer.location} [unattended]')
    if layer.name == 'global' and isinstance(values, dict) and values.get('mode') == 'follow-global':
        found.append(f'global layer {layer.location}: `mode = "follow-global"` is only for a project')
    return found


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
    if isinstance(controller, dict) and controller.get('mode') == 'follow-global':
        problems.append('session record `unattended`: `mode = "follow-global"` is only for a project')
    layers = [preauth.Layer('controller', 'session record', {'unattended': controller},
                            isinstance(controller, dict))]
    for name, path in (('project', lat / 'preauth.toml'), ('global', preauth.global_path())):
        layer, found = preauth.file_layer(name, path)
        problems += layer_problems(layer, found)
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


def is_default(values):
    return values['mode']['layer'] in ('project', 'global')


@dataclass
class Round:
    """One round's session record, resolved settings and grant, read under session_lock."""
    record: dict
    record_bytes: bytes
    number: int
    values: dict
    problems: list
    versions: list
    grant_bytes: bytes | None

    @property
    def active(self):
        return self.record.get('status') == 'active'

    def save(self, lat, session, versions=None):
        self.versions = self.versions if versions is None else versions
        self.grant_bytes = write_grant(lat, session, self.number, self.versions, self.grant_bytes)


def load_round(lat, session):
    """Read the round; the caller holds session_lock. In an active round an open version that
    is past its time limit ends at the limit, and one whose mode no longer resolves to
    unattended ends now (also when a settings error forces manual); either is saved at once."""
    record, record_bytes, number = read_session(lat, session)
    values, problems = resolve_mode(lat, record)
    versions, grant_bytes = read_grant(lat, session, number)
    found = Round(record, record_bytes, number, values, problems, versions, grant_bytes)
    current = open_version(versions)
    if found.active and current:
        if now() >= deadline(versions):
            end_version(current, deadline(versions), 'time-limit')
            found.save(lat, session)
        elif values['mode']['value'] != 'unattended':
            end_version(current, now(), 'settings-error' if problems else 'mode-manual')
            found.save(lat, session)
    return found


def grant_state(found):
    """(state, the open version or None)."""
    current = open_version(found.versions)
    if not found.active or found.values['mode']['value'] != 'unattended':
        return 'none', None
    if current:
        return 'active', current
    if not found.versions and is_default(found.values):
        return 'pending-goal', None
    return 'none', None


def snapshot(lat, session):
    """Everything `status` reports."""
    with preauth.locked(session_lock(lat, session)):
        found = load_round(lat, session)
        draft = read_draft(lat, session, found.number)
    state, current = grant_state(found)
    versions = found.versions
    return dict(session=session, round=found.number, round_active=found.active,
                settings=found.values, quota_stop=True, problems=found.problems, state=state,
                state_label=STATE_LABELS[state], version=current, draft=draft,
                layer_modes=layer_modes(lat, found.record),
                files=[str(path) for path in (
                    session_file(lat, session), grant_file(lat, session, found.number),
                    draft_file(lat, session, found.number), lat / 'preauth.toml',
                    preauth.global_path())],
                ends_at=stamp(deadline(versions)) if current else None,
                last_end=None if current or not versions else dict(
                    version=versions[-1]['version'], ended_at=versions[-1]['ended_at'],
                    reason=versions[-1]['end_reason']))


def layer_modes(lat, record):
    """The mode each layer itself sets, None where it sets none; the project's may be
    follow-global. What the status card lists as 各層設定."""
    def mode_of(values):
        return values.get('mode') if isinstance(values, dict) else None

    found = dict(controller=mode_of(record.get('unattended') if isinstance(record, dict) else None))
    for name, path in (('project', lat / 'preauth.toml'), ('global', preauth.global_path())):
        layer, _ = preauth.file_layer(name, path)
        found[name] = mode_of(layer.data.get('unattended'))
    return found


# Evidence -------------------------------------------------------------------------------------

def board_request_problem(session, versions, evidence, source, version):
    """A board-form or user-edit version cites `board-action:<ID>`: the request line the board
    wrote to its log when a signed-in device sent the form. It must be for this controller and
    this kind of change, hold the same content, be recent, and not be cited by another version."""
    if not evidence.startswith(BOARD_EVIDENCE):
        return f'{source} evidence must be `{BOARD_EVIDENCE}<ID>` from the board\'s action log'
    if any(old.get('evidence') == evidence for old in versions):
        return f'{evidence} is already cited by an earlier version'
    wanted = evidence.removeprefix(BOARD_EVIDENCE)
    path = preauth.board_writes_path().with_name(SENT_LOG)
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except FileNotFoundError:
        lines = []
    entry = None
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get('kind') == 'unattended-request' \
                and item.get('id') == wanted:
            entry = item
    if entry is None:
        return f'no board request {wanted} in {path}'
    if entry.get('controllerId') != session:
        return f'board request {wanted} is for controller {entry.get("controllerId")}, not {session}'
    if entry.get('op') != BOARD_REQUEST_OPS[source]:
        return f'board request {wanted} is a {entry.get("op")}, not a {BOARD_REQUEST_OPS[source]}'
    sent = dict(goal=entry.get('goal'), done=entry.get('done'), scope=entry.get('scope'),
                max_hours=entry.get('maxHours'))
    given = dict(goal=version['goal'], done=version['done'], scope=version['scope'],
                 max_hours=version['stop']['max_hours'])
    differs = [key for key in given if sent[key] != given[key]]
    if differs:
        return f'board request {wanted} has another {", ".join(differs)} than this version'
    try:
        moment = parse(entry['time'])
    except (KeyError, TypeError, ValueError):
        return f'board request {wanted} has no readable time'
    if not timedelta(minutes=-1) <= now() - moment <= REQUEST_WINDOW:
        return (f'board request {wanted} was made at {entry["time"]}, not within '
                f'{REQUEST_WINDOW.seconds // 60} minutes before now')
    return None


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
    if not is_default(values):
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


def set_controller_mode(lat, session, found, mode):
    """Write the controller layer's mode into the session record."""
    controller = dict(found.record.get('unattended') or {}, mode=mode)
    write_json_atomic(session_file(lat, session), dict(found.record, unattended=controller),
                      expected=found.record_bytes)


def undo_grant(lat, session, found, before, error):
    """Put the grant file back after the session record could not follow it."""
    try:
        restore(grant_file(lat, session, found.number), before)
    except (OSError, ValueError) as undo:
        raise ValueError(f'could not set the controller mode ({error}) nor restore '
                         f'{grant_file(lat, session, found.number)} ({undo}); fix it by hand') \
            from None
    raise ValueError(f'could not set the controller mode ({error}); the grant was restored') \
        from None


def settings_default_problem(lat, found, evidence, scope, max_hours):
    """A default start writes only version 1, with exactly the scope and time limit the
    settings give, citing the board write that set the mode."""
    if found.problems:
        return '; '.join(found.problems)
    if found.versions:
        return 'the round already had a grant; a default start only writes version 1'
    values = found.values
    wanted = {key: values[key]['value'] for key in SCOPE_KEYS}
    if scope != wanted or max_hours != values['max_hours']['value']:
        words = [word for word, key in SCOPE_WORDS.items() if wanted[key]] or ['none']
        return ('a default start takes the scope and time limit from the settings: '
                f'--scope {" ".join(words)} --max-hours {values["max_hours"]["value"]}')
    return settings_evidence_problem(lat, values, evidence)


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
        found = load_round(lat, session)
        if not found.active:
            raise Refused(f'session {session} is not active; only an active round has a grant')
        versions = found.versions
        if open_version(versions):
            raise Refused(f'version {versions[-1]["version"]} is in effect; change it with update')
        version = dict(version=len(versions) + 1, goal=goal, done=done, scope=scope,
                       stop=dict(quota=True, max_hours=args.max_hours), source=args.source,
                       evidence=evidence, started_at=stamp(now()), ended_at=None,
                       end_reason=None)
        if args.source == 'chat':
            problem = chat_evidence_problem(found.record, lat, evidence)
        elif args.source == 'settings-default':
            problem = settings_default_problem(lat, found, evidence, scope, args.max_hours)
        else:
            problem = board_request_problem(session, versions, evidence, args.source, version)
        if problem:
            raise Refused(problem)
        if args.source == 'settings-default':
            version['note'] = DRAFTED_NOTE
        before = found.grant_bytes
        found.save(lat, session, [*versions, version])
        if args.source != 'settings-default' and found.values['mode']['value'] != 'unattended':
            try:
                set_controller_mode(lat, session, found, 'unattended')
            except (OSError, ValueError) as error:
                undo_grant(lat, session, found, before, error)
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
        found = load_round(lat, session)
        if not found.active:
            raise Refused(f'session {session} is not active')
        versions, moment = found.versions, now()
        current = open_version(versions)
        if not current:
            raise Refused('no grant in effect; start one with create')
        if args.max_hours is not None and moment >= parse(versions[0]['started_at']) + timedelta(
                hours=args.max_hours):
            raise Refused(f'{args.max_hours} hours since {versions[0]["started_at"]} have already '
                          'passed; give a longer --max-hours or close the grant')
        version = dict(
            version=current['version'] + 1,
            goal=(args.goal or '').strip() or current['goal'],
            done=text_list(args.done) or current['done'],
            scope=scope_of(args.scope) if args.scope else current['scope'],
            stop=dict(current['stop'], **({} if args.max_hours is None
                                          else dict(max_hours=args.max_hours))),
            source=args.source, evidence=evidence, started_at=stamp(moment), ended_at=None,
            end_reason=None)
        problem = (chat_evidence_problem(found.record, lat, evidence) if args.source == 'chat'
                   else board_request_problem(session, versions, evidence, args.source, version))
        if problem:
            raise Refused(problem)
        end_version(current, moment, 'superseded')
        found.save(lat, session, [*versions, version])
    return report(args, dict(status='ok', created=version),
                  f'已改為第 {version["version"]} 版無人授權，立即生效')


def end_grant(lat, session, found, reason):
    """End the round's open version; the version ended, or None."""
    current = open_version(found.versions)
    if current:
        end_version(current, now(), reason)
        found.save(lat, session)
    return current


def end_round_grant(lat, session, reason):
    """For deactivate, which already holds session_lock: end this round's open version."""
    return end_grant(lat, session, load_round(lat, session), reason)


def cmd_close(args):
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        found = load_round(lat, session)
        before = found.grant_bytes
        ended = end_grant(lat, session, found, args.reason)
        if args.reason == 'off' and found.active:
            # The user turned it off: this controller goes back to asking.
            try:
                set_controller_mode(lat, session, found, 'manual')
            except (OSError, ValueError) as error:
                undo_grant(lat, session, found, before, error)
    text = (f'已結束第 {ended["version"]} 版無人授權（{CLOSE_REASONS[args.reason]}）' if ended
            else '沒有生效中的無人授權')
    return report(args, dict(status='ok', ended=ended), text)


def cmd_check(args):
    """Whether version N was in effect at a moment; delegated decisions cite it."""
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        found_round = load_round(lat, session)
    versions, round_number = found_round.versions, found_round.number
    moment = parse(args.at) if args.at else now()
    found = next((v for v in versions if v['version'] == args.version), None)
    if found is None:
        reason = f'version {args.version} does not exist in round {round_number}'
    elif moment < parse(found['started_at']):
        reason = f'version {args.version} started at {found["started_at"]}'
    elif found['ended_at'] and moment >= parse(found['ended_at']):
        reason = (f'version {args.version} ended at {found["ended_at"]} '
                  f'({END_LABELS.get(found["end_reason"], found["end_reason"])})')
    elif found['ended_at'] is None and not found_round.active:
        reason = f'round {round_number} has ended'
    else:
        reason = None
    result = dict(status='ok', effective=reason is None, reason=reason, version=found)
    report(args, result, '有效' if reason is None else f'無效：{reason}')
    return 0 if reason is None else 1


def cmd_draft(args):
    """Keep the goal and done conditions the controller proposes from the user's first message;
    the board's form starts from them. A draft is never a grant."""
    goal, done = (args.goal or '').strip(), text_list(args.done)
    missing = [flag for flag, value in (('--goal', goal), ('--done', done)) if not value]
    if missing:
        raise Refused('a draft needs ' + ', '.join(missing))
    lat, session = owner(args)
    with preauth.locked(session_lock(lat, session)):
        found = load_round(lat, session)
        if not found.active:
            raise Refused(f'session {session} is not active')
        draft = dict(goal=goal, done=done, at=stamp(now()))
        write_json_atomic(draft_file(lat, session, found.number), draft)
    return report(args, dict(status='ok', draft=draft), '已存下目標草稿（不是授權）')


# Settings for the board ---------------------------------------------------------------------

def project_lat(root):
    top = preauth.git(Path(root), 'rev-parse', '--show-toplevel')
    if not top:
        raise Refused(f'{root} is not in a Git repository')
    return shared_lat_dir(Path(top))


def settings_view(layer, problems):
    values = layer.data.get('unattended') if not problems else None
    values = values if isinstance(values, dict) else {}
    return dict(path=layer.location, exists=layer.present, sha256=layer.sha256,
                problems=problems,
                values={key: values[key] for key in (*SETTING_KEYS, 'source') if key in values})


def cmd_settings(args):
    """The global layer and each project's [unattended] section, as the board edits them. A
    project is named by any folder in it; worktrees of one project are listed once."""
    layer, problems = preauth.file_layer('global', preauth.global_path())
    projects = {}
    for root in args.project or []:
        lat = project_lat(root)
        if str(lat.parent) in projects:
            continue
        found, found_problems = preauth.file_layer('project', lat / 'preauth.toml')
        projects[str(lat.parent)] = dict(root=str(lat.parent), name=lat.parent.name,
                                         **settings_view(found, found_problems))
    result = dict(status='ok', initial=INITIAL, **{'global': settings_view(layer, problems)},
                  projects=list(projects.values()))
    return report(args, result, json.dumps(result, ensure_ascii=False, indent=2))


def setting_value(layer, key, value):
    """The value to write, None to remove the key, or Refused."""
    if value is None:
        return None
    if key == 'mode':
        allowed = ('manual', 'unattended', *(('follow-global',) if layer == 'project' else ()))
        if value not in allowed:
            raise Refused(f'mode must be one of {", ".join(allowed)}')
    elif key == 'max_hours':
        if type(value) is not int or value <= 0:
            raise Refused('max_hours must be a whole number of hours above 0')
    elif type(value) is not bool:
        raise Refused(f'{key} must be true or false')
    return value


def cmd_settings_write(args):
    """Write the changed keys of one layer's [unattended] for the board, stamped and logged
    like the board's pre-authorization writes; refused when the file is not the one read."""
    try:
        changes = json.loads(args.changes)
    except ValueError as error:
        raise Refused(f'--changes is not JSON ({error})') from None
    if not isinstance(changes, dict) or not changes or changes.keys() - set(SETTING_KEYS):
        raise Refused(f'--changes must set some of {", ".join(SETTING_KEYS)}')
    if args.layer == 'project':
        if not args.project:
            raise Refused('a project layer needs --project')
        target = project_lat(args.project) / 'preauth.toml'
    else:
        target = preauth.global_path()
    with preauth.locked(target.with_name(f'.{target.name}.lock')):
        loaded, problems = preauth.file_layer(args.layer, target)
        if problems:
            return report(args, dict(status='invalid', reason='設定檔有錯，沒有寫入，修好檔案後重新載入',
                                     problems=problems), '設定檔有錯，沒有寫入')
        if loaded.sha256 != args.expected_sha256:
            return report(args, dict(status='conflict', reason='設定檔已被改過，沒有寫入，請重新載入',
                                     problems=[]), '設定檔已被改過，沒有寫入')
        current = loaded.data.get('unattended', {})
        values = {}
        for key, value in changes.items():
            value = setting_value(args.layer, key, value)
            if value != current.get(key):
                values[key] = value
        if not values:
            return report(args, dict(status='ok', changes=[]), '沒有改動')
        source = f'board:{datetime.now().astimezone().isoformat(timespec="seconds")}'
        listed = [dict(section='unattended', key=key, value=value) for key, value in values.items()]
        before, written = preauth.write_file_layer(
            target, {('unattended',): dict(values, source=source)},
            expected_sha256=args.expected_sha256)
        try:
            preauth.append_board_write(dict(layer=args.layer, file=str(target), changes=listed,
                                            source=source))
        except (OSError, ValueError) as error:
            # A write the report cannot list must not stay in effect.
            preauth.restore(target, before, written)
            raise ValueError(f'紀錄寫不進去（{error}），設定已還原') from None
    return report(args, dict(status='ok', changes=listed, source=source), f'已寫入 {target}')


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
    with preauth.locked(session_lock(lat, session)):
        found = load_round(lat, session)
    versions, round_number = found.versions, found.number
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
                              help='exit 0 when a version was in effect at a moment, else 1; '
                                   'like status, first ends a version past its limit or mode')
    sub.add_argument('--version', type=int, required=True)
    sub.add_argument('--at', help='ISO time; default now')
    sub = commands.add_parser('draft', parents=[common],
                              help="keep the controller's proposed goal; the board's form starts "
                                   'from it; never a grant')
    sub.add_argument('--goal', help='the proposed goal of this round')
    sub.add_argument('--done', action='append', help='one done condition; repeat per line')
    sub = commands.add_parser('settings', parents=[common],
                              help="the global and projects' [unattended] sections, for the board")
    sub.add_argument('--project', action='append', help='any folder of a project; repeatable')
    sub = commands.add_parser('settings-write', parents=[common],
                              help="write changed keys of one layer's [unattended], for the board")
    sub.add_argument('--layer', required=True, choices=('global', 'project'))
    sub.add_argument('--project', help='any folder of the project, for --layer project')
    sub.add_argument('--expected-sha256', required=True,
                     help='hash of the file as read; refused when it changed since')
    sub.add_argument('--changes', required=True,
                     help='JSON {key: value or null}; null removes the key')
    return parser


COMMANDS = dict(status=cmd_status, versions=cmd_versions, create=cmd_create, update=cmd_update,
                close=cmd_close, check=cmd_check, draft=cmd_draft, settings=cmd_settings,
                **{'settings-write': cmd_settings_write})


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
