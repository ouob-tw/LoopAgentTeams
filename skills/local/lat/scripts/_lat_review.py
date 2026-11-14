"""The unattended round's review (references/unattended.md「回顧」), built from its sources
(stdlib only).

`collect` reads one round of one session: the grant versions it is given, the session's parked
and delegated decision records (and those the user has since answered from the review), the
round's work ledger (parked rows, done rows) and its pre-authorization records (auto actions).
Every item has an id taken from its source, so it stays the same across updates: the decision
ID, `row-<ledger row>`, or `auto-<line>` for the auto record on that line of the round's
pre-authorization records.
`render_body` turns the view into the Markdown body; `render_header` adds the verification
status and the update time, which the body hash leaves out.
"""
import json
from pathlib import Path
import re
import subprocess

from lat_decision_status import (DELEGATED, PARKED, read_decision_session,
                                 read_decision_status)

ANSWERED = ('answered', 'approved')
REVIEW_SOURCE = '（回顧項目）'  # what `question record-chat` adds to a review item's answer
WORD_STATUS = {word: status for status, (word, _) in DELEGATED.items()}
# Assumptions that sit on the edge of what the acceptance conditions say: the text and layout
# the user sees, and defaults the user meets in use.
BOUNDARY_CLASSES = ('ui-detail', 'setting-default')
TOP_LIMIT = 5

KIND_LABELS = {PARKED: '擱置', 'parked-row': '擱置的票', 'proxy-confirmed': '代確認',
               'assumed': '假設', 'prototype-decided': '樣品決定', 'auto': '自動動作'}
# (section key, heading), in the Spec's order.
SECTIONS = (('parked', '擱置等你的事'), ('goal', '本輪目標與做完條件'), ('top', '最該先看的幾項'),
            ('assumed', '假設'), ('proxy-confirmed', '代確認的票'),
            ('prototype-decided', '樣品決定'), ('auto', '自動做的動作'), ('done', '本輪完成的票'))
SECTION_OF = {PARKED: 'parked', 'parked-row': 'parked', 'proxy-confirmed': 'proxy-confirmed',
              'assumed': 'assumed', 'prototype-decided': 'prototype-decided', 'auto': 'auto'}
ROW_STATES = {'unassigned': '未派工', 'assigned': '已派工', 'in_progress': '進行中',
              'blocked': '受阻'}
SOURCE_LABELS = {'settings-default': '主控擬出（設定預設開啟）', 'board-form': '你在看板開啟',
                 'chat': '你在聊天確認', 'user-edit': '你修改',
                 'board-task': '你在看板自動化任務設定'}
OPINION = re.compile(r'^(?:- )?(\S+?（[^）]*）)：\s*(agree|disagree)\s*；\s*(\S.*)$',
                     re.IGNORECASE)
ANSWER_HEADING = re.compile(r'^## 答覆（r\d+，[^，]+，(.+)）\s*$')


def one_line(text):
    return ' '.join(str(text or '').split())


# Decision records -------------------------------------------------------------------------------

def field(lines, key):
    for line in lines:
        match = re.match(rf'^- {re.escape(key)}:(.*)$', line, re.IGNORECASE)
        if match:
            return match.group(1).strip()
    return None


def section_lines(lines, heading):
    found, inside = [], False
    for line in lines:
        if line.startswith('## '):
            if inside:
                break
            inside = line[3:].strip() == heading
            continue
        if inside and line.strip():
            found.append(line.strip())
    return found


def review_answer(lines):
    """(time, text) of the last answer recorded from the review, or None."""
    found, current = None, None
    for line in lines:
        if line.startswith('## '):
            match = ANSWER_HEADING.match(line)
            current = dict(at=match[1], text='', review=False) if match else None
            continue
        if current is None:
            continue
        if line.startswith('- 答覆：'):
            current['text'] = line[len('- 答覆：'):].strip()
        elif line.startswith('- 來源：') and REVIEW_SOURCE in line:
            current['review'] = True
            found = (current['at'], current['text'])
    return found


def record_round(lines):
    cited = re.fullmatch(r'r([1-9][0-9]*) v[1-9][0-9]*', field(lines, 'grant') or '')
    return int(cited[1]) if cited else None


def title_of(lines, identifier):
    for line in lines:
        if line.startswith('# '):
            heading = line[2:].strip()
            if heading.startswith(identifier):
                heading = heading[len(identifier):].strip()
            return heading or identifier
    return field(lines, 'question') or identifier


def opinions(lines):
    return [f'{match[1]} 同意：{match[3].strip()}'
            for match in map(OPINION.match, section_lines(lines, '參謀意見'))
            if match and match[2].lower() == 'agree']


def chosen(lines, identifier, question, decision):
    if decision and question:
        return f'{question} → {decision}'
    return decision or question or title_of(lines, identifier)


def decision_item(path, lines, kind, answer, workspace):
    identifier = path.stem
    question = field(lines, 'question')
    decision = field(lines, 'decision')
    evidence = [relative(path, workspace)]
    why = '；'.join(opinions(lines))
    if kind == PARKED:
        did = '擱置，等你決定' + (f'：{question}' if question else '')
        blocks = field(lines, 'blocks')
        if blocks:
            did += f'；受阻：{blocks}'
        reason = field(lines, 'parked-reason')
        advisor = field(lines, 'advisor')
        why = reason or why or (f'參謀結論 {advisor}' if advisor else '紀錄沒寫原因')
        revert = '按「回覆」寫下你的決定；主控記成你的答覆後解除擱置'
    elif kind == 'proxy-confirmed':
        did = (chosen(lines, identifier, question, decision) if decision else
               '兩位參謀拿你的原話對照驗收條件，代你確認開工' + (f'：{question}' if question else ''))
        rows = section_lines(lines, '驗收對照')
        evidence += [row.lstrip('- ') for row in rows]
        revert = '按「推翻」寫明哪條驗收條件不對；這張票只合併到整合分支，推送與部署仍照預先授權'
    elif kind == 'assumed':
        did = chosen(lines, identifier, question, decision)
        assume = field(lines, 'assume-class')
        why = (f'固定清單 {assume}；' if assume else '') + why
        revert = f'按「推翻」；可以改成：{field(lines, "revert") or "紀錄沒寫"}'
    else:
        did = chosen(lines, identifier, question, decision)
        sample = field(lines, 'sample')
        if sample:
            evidence.append(f'樣品：{sample}')
        revert = '按「推翻」改選另一個做法' + (f'（樣品在 {sample}）' if sample else '')
    item = dict(id=identifier, kind=kind, title=title_of(lines, identifier), did=did,
                why=why or '紀錄沒寫理由', evidence=evidence, revert=revert,
                assume_class=(field(lines, 'assume-class') or '').lower() or None)
    return with_state(item, answer, PARKED if kind == PARKED else 'delegated')


def with_state(item, answer, family):
    if answer:
        at, text = answer
        state = 'answered' if family == PARKED else 'overturned'
        label = '已由你回覆' if family == PARKED else '已由你推翻'
        item.update(state=state, state_label=f'{label}（{at}）', answered_at=at, answer=text)
    else:
        item.update(state='open', answered_at=None, answer=None,
                    state_label='等你回覆' if family == PARKED else '照這樣做了')
    return item


def decision_items(directory, session, round_number, workspace):
    """(items, problems) for this session's review records of this round. A record that cites
    a grant belongs to that round; a parked record without one counts in the current round."""
    items, problems = [], []
    if not directory.is_dir():
        return items, problems
    for path in sorted(directory.glob('*.md')):
        try:
            status = read_decision_status(path).status
            if status not in (PARKED, *DELEGATED, *ANSWERED):
                continue
            if read_decision_session(path) != session:
                continue
            lines = path.read_text(encoding='utf-8').splitlines()
        except (OSError, UnicodeDecodeError) as error:
            problems.append(f'{relative(path, workspace)}：讀不出（{error}）')
            continue
        cited = record_round(lines)
        if cited is not None and cited != round_number:
            continue
        answer = review_answer(lines)
        if status in ANSWERED:
            if not answer:
                continue
            words = (field(lines, 'advisor') or '').lower().split()
            kind = WORD_STATUS.get(words[1]) if words[:1] == ['proxy'] and len(words) > 1 \
                else PARKED
            if kind is None:
                continue
        else:
            kind, answer = status, None
        if kind in DELEGATED and cited is None:
            continue
        items.append(decision_item(path, lines, kind, answer, workspace))
    return items, problems


# Work ledger -----------------------------------------------------------------------------------

def read_ledger(path):
    try:
        doc = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return None, None
    except (OSError, ValueError, UnicodeDecodeError) as error:
        return None, f'{path}：讀不出（{error}）'
    if not isinstance(doc, dict) or not isinstance(doc.get('items'), list):
        return None, f'{path}：不是工作總表'
    return doc, None


def ticket_title(doc, ticket):
    titles = doc.get('titles') or {}
    if ticket in titles:
        return titles[ticket]
    for key, title in titles.items():
        if str(key).endswith(f'#{ticket}') and title:
            return title
    return ''


def row_label(doc, row):
    ticket = str(row.get('ticket') or '')
    title = ticket_title(doc, ticket)
    head = f'#{ticket}' if ticket.isdigit() else ticket
    return f'{head} {title}'.strip() + f'（{row.get("stage")}，row {row.get("id")}）'


def self_park(row):
    """The last history entry that parked this row by itself (not after a dependency)."""
    found = None
    for entry in row.get('history') or []:
        changes = entry.get('changes') or {}
        if (entry.get('action') == 'park' and (changes.get('status') or [None, None])[1] == PARKED
                and (changes.get('parked_cause') or [None, None])[1] is None):
            found = entry
    return found


def ledger_items(doc, path, workspace):
    items, done = [], []
    for row in doc['items']:
        if not isinstance(row, dict):
            continue
        if row.get('status') == 'done':
            evidence = row.get('evidence') or {}
            proof = '、'.join(f'{key} {value}' for key, value in sorted(evidence.items())
                             if isinstance(value, str)) or '沒有證據欄'
            done.append(f'{row_label(doc, row)}：{proof}')
        parked = self_park(row)
        if not parked:
            continue
        followers = [str(other.get('id')) for other in doc['items']
                     if isinstance(other, dict) and other.get('status') == PARKED
                     and other.get('parked_cause') == row.get('id')]
        before = (parked['changes'].get('parked_from') or [None, None])[1]
        did = f'擱置這張票（原本{ROW_STATES.get(before, before)}）'
        if followers:
            did += f'；依賴它的 row {"、".join(followers)} 一併擱置'
        later = [entry for entry in row.get('history') or []
                 if entry.get('action') == 'unpark' and entry.get('at', '') >= parked.get('at', '')]
        answer = (later[-1].get('at'), later[-1].get('reason') or '') \
            if later and row.get('status') != PARKED else None
        item = dict(id=f'row-{row.get("id")}', kind='parked-row', title=row_label(doc, row),
                    did=did, why=parked.get('reason') or '總表沒寫原因',
                    evidence=[f'{relative(path, workspace)} row {row.get("id")}'],
                    revert='按「回覆」寫下你的決定；主控照你的話解除擱置（lat-ledger unpark）',
                    assume_class=None)
        item = with_state(item, None, PARKED)
        if answer:
            # The ledger records that the row was released and why, not who decided.
            item.update(state='answered', state_label=f'已解除擱置（{answer[0]}）：{answer[1]}',
                        answered_at=answer[0], answer=answer[1],
                        revert='已解除；要改回擱置或改做法，告訴主控')
        items.append(item)
    return items, done


# Pre-authorization records --------------------------------------------------------------------

def same_commit(one, other):
    if not isinstance(one, str) or not isinstance(other, str):
        return False
    shorter, longer = sorted((one.lower(), other.lower()), key=len)
    return len(shorter) >= 7 and longer.startswith(shorter)


def merge_commit(repo, target, commit):
    """The commit the merge of `commit` produced on `target`: the oldest first-parent merge on the
    way from `commit` to `target`. None when git cannot tell: no repo, no such branch, or a
    fast-forward (no merge commit exists)."""
    if not (repo and isinstance(target, str) and isinstance(commit, str)) \
            or target.startswith('-') or commit.startswith('-'):
        return None
    def rev_list(*args):
        out = subprocess.run(['git', '-C', str(repo), 'rev-list', *args, '--'],
                             capture_output=True, text=True, timeout=20)
        return None if out.returncode else out.stdout.split()
    try:
        between = rev_list('--merges', '--ancestry-path', f'{commit}..{target}')
        mainline = set(rev_list('--first-parent', target) or ()) if between else ()
    except (OSError, subprocess.SubprocessError):
        return None
    found = [sha for sha in between or () if sha in mainline]
    return found[-1] if found else None


def auto_items(path, workspace):
    """(items, problems): one item per auto record of the round, `auto-<line number>`."""
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except FileNotFoundError:
        return [], []
    except (OSError, UnicodeDecodeError) as error:
        return [], [f'{relative(path, workspace)}：讀不出（{error}）']
    entries, problems = [], []
    for number, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            problems.append(f'{relative(path, workspace)} 第 {number} 行讀不懂')
            continue
        if isinstance(entry, dict):
            entries.append((number, entry))
    items = []
    for number, entry in entries:
        if entry.get('kind') != 'auto':
            continue
        action, target, commit = entry.get('action'), entry.get('target'), entry.get('commit')
        head = ' '.join(str(part) for part in (action, target, commit) if part)
        if action == 'merge':
            merged = merge_commit(entry.get('action_repo') or workspace, target, commit)
            where = target or '整合分支'
            revert = (f'按「推翻」；主控在 {where} 還原合併提交 {merged[:12]}'
                      if merged else
                      f'按「推翻」；紀錄只存了被合併進來的提交 {commit}，查不到合併提交；'
                      f'主控在 {where} 用 git log --first-parent --merges 找出併入它的那個合併提交再還原；'
                      f'若是快轉合併就沒有合併提交，改還原它帶進來的那幾個提交')
        elif action == 'push':
            revert = f'按「推翻」；主控在 {target or "遠端"} 還原這次推送的提交'
        else:
            revert = f'按「推翻」；主控把 {action} 退回前一版'
        corrections = [(n, e) for n, e in entries if n > number and e.get('kind') == 'correction'
                       and same_commit(commit, e.get('commit'))
                       and e.get('action') in (None, action)]
        item = dict(id=f'auto-{number}', kind='auto', title=head or f'第 {number} 行',
                    did=f'依預先授權自動執行，結果 {entry.get("result")}', why=f'預先授權：{entry.get("basis")}',
                    evidence=[f'{relative(path, workspace)} 第 {number} 行'], revert=revert,
                    assume_class=None, action=action)
        if corrections:
            n, last = corrections[-1]
            label = '已由你推翻' if last.get('question') else '已更正'
            item.update(state='overturned' if last.get('question') else 'corrected',
                        state_label=f'{label}（{last.get("at")}）：{last.get("note")}',
                        answered_at=last.get('at'), answer=last.get('note'))
            item['evidence'].append(f'{relative(path, workspace)} 第 {n} 行（更正）')
        else:
            item.update(state='open', state_label='已執行', answered_at=None, answer=None)
        items.append(item)
    return items, problems


# The view ---------------------------------------------------------------------------------------

def relative(path, workspace):
    try:
        return str(Path(path).relative_to(workspace))
    except ValueError:
        return str(path)


def top_rank(item):
    """The Spec's order for 最該先看的幾項; None leaves the item out."""
    if item['state'] != 'open':
        return None
    if item['kind'] in (PARKED, 'parked-row'):
        return 0
    if item['kind'] == 'proxy-confirmed':
        return 1
    if item['kind'] == 'assumed' and item.get('assume_class') in BOUNDARY_CLASSES:
        return 2
    if item['kind'] == 'auto' and item.get('action') not in ('merge', 'push'):
        return 3
    return 4


def collect(*, lat, workspace, session, round_number, versions, decisions, end_labels,
            scope_labels):
    """Everything the review shows, as one JSON-ready dict."""
    items, problems = decision_items(Path(decisions), session, round_number, workspace)
    ledger_path = lat / 'ledgers' / f'{session}-r{round_number}.json'
    doc, problem = read_ledger(ledger_path)
    done = []
    if problem:
        problems.append(problem)
    if doc:
        rows, done = ledger_items(doc, ledger_path, workspace)
        items += rows
    autos, more = auto_items(lat / 'preauth-records' / f'{session}-r{round_number}.jsonl',
                             workspace)
    items += autos
    problems += more
    for item in items:
        item['kind_label'] = KIND_LABELS[item['kind']]
        item['section'] = SECTION_OF[item['kind']]
    ranked = sorted((rank, index) for index, item in enumerate(items)
                    if (rank := top_rank(item)) is not None)
    top = [items[index]['id'] for _, index in ranked[:TOP_LIMIT]]
    goals = [dict(version=v['version'], goal=v['goal'], done=v['done'],
                  source=v['source'], source_label=SOURCE_LABELS.get(v['source'], v['source']),
                  note=v.get('note'), started_at=v['started_at'], ended_at=v['ended_at'],
                  end_label=end_labels.get(v['end_reason'], v['end_reason']),
                  scope=[scope_labels[key] for key in scope_labels if v['scope'].get(key)],
                  max_hours=v['stop']['max_hours']) for v in versions]
    last = versions[-1] if versions else None
    grant = ('沒有無人授權' if last is None else
             f'第 {last["version"]} 版生效中' if last['ended_at'] is None else
             f'已結束（第 {last["version"]} 版，{end_labels.get(last["end_reason"], last["end_reason"])}，'
             f'{last["ended_at"]}）')
    return dict(session=session, round=round_number, grant=grant, goals=goals, items=items,
                top=top, done_tickets=done, problems=problems,
                sections=[dict(key=key, heading=heading) for key, heading in SECTIONS])


def content_key(view):
    """What a cross-check vouches for: the items, the goal versions, the done tickets and the
    unreadable sources, without when the grant ended."""
    goals = [{key: value for key, value in goal.items() if key not in ('ended_at', 'end_label')}
             for goal in view['goals']]
    return json.dumps(dict(items=view['items'], goals=goals, done=view['done_tickets'],
                           problems=view['problems']), ensure_ascii=False, sort_keys=True)


def item_lines(item):
    return [f'### {item["id"]} {item["title"]}', '',
            f'- 種類：{item["kind_label"]}',
            f'- 狀態：{item["state_label"]}',
            f'- 做了什麼：{one_line(item["did"])}',
            f'- 為什麼：{one_line(item["why"])}',
            f'- 證據：{"；".join(one_line(e) for e in item["evidence"])}',
            f'- 怎麼推翻：{one_line(item["revert"])}', '']


def render_body(view):
    """The Markdown after the header; its hash decides whether the review changed."""
    by_id = {item['id']: item for item in view['items']}
    lines = [f'- 無人授權：{view["grant"]}',
             f'- 項目：{len(view["items"])} 項', '']
    for key, heading in SECTIONS:
        if key == 'goal':
            lines += [f'## {heading}', '']
            for goal in view['goals']:
                until = (f'～{goal["ended_at"]}（{goal["end_label"]}）' if goal['ended_at']
                         else '起，生效中')
                lines += [f'- 第 {goal["version"]} 版：{goal["source_label"]}，'
                          f'{goal["started_at"]}{until}',
                          f'  - 目標：{one_line(goal["goal"])}', '  - 做完條件：',
                          *[f'    - {one_line(done)}' for done in goal['done']],
                          f'  - 參謀可代決：{"、".join(goal["scope"]) or "無"}',
                          f'  - 何時停：額度用完；時間上限 {goal["max_hours"]} 小時']
            lines.append('')
            continue
        if key == 'top':
            if view['top']:
                lines += [f'## {heading}', '']
                lines += [f'{n}. {by_id[i]["id"]}（{by_id[i]["kind_label"]}）{by_id[i]["title"]}'
                          f'：{one_line(by_id[i]["did"])}' for n, i in enumerate(view['top'], 1)]
                lines.append('')
            continue
        if key == 'done':
            if view['done_tickets']:
                lines += [f'## {heading}', '', *[f'- {one_line(t)}' for t in view['done_tickets']],
                          '']
            continue
        members = [item for item in view['items'] if item['section'] == key]
        if members:
            lines += [f'## {heading}', '']
            for item in members:
                lines += item_lines(item)
    if view['problems']:
        lines += ['## 讀不出的來源', '', *[f'- {one_line(p)}' for p in view['problems']], '']
    return '\n'.join(lines).rstrip('\n') + '\n'


def render_header(view, verification, stale, updated_at):
    lines = [f'# 無人模式回顧：session {view["session"]} 第 {view["round"]} 輪', '']
    if verification:
        mismatches = verification['mismatches']
        lines.append(f'- 核對：{verification["checker"]}（{verification["family"]}）於 '
                     f'{verification["at"]} 核對，{verification["total"]} 項中 '
                     f'{verification["matched"]} 項相符，{len(mismatches)} 項不符')
        lines += [f'  - 不符 {m["id"]}：{one_line(m["text"])}' for m in mismatches]
    else:
        lines.append('- 核對：尚未核對' + (f'（{stale["at"]} 的核對之後內容有更新）' if stale else ''))
    lines.append(f'- 更新：{updated_at}')
    return '\n'.join(lines) + '\n'
