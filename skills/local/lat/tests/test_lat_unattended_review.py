"""The unattended round's review file: when it is created and updated, its layout, stable item
ids, that actions taken under the pre-authorization stay out of it, that it never holds DONE: or
deactivate, and that a review file from before #662 still opens. Temp HOME/XDG dirs, a temp Git
repo and a fake controller record, as in test_lat_unattended_decisions."""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_lat_unattended_decisions import (  # noqa: E402
    OTHER, PREAUTH, SESSION, SESSION_SCRIPT, UnattendedStopCase)

PARKED = '- status: parked\n- advisor: exempt spec-confirmation\n- session: {session}\n' \
         '- grant: r1 v1\n- version: r1\n- question: Spec 要不要加匯出\n' \
         '- parked-reason: 屬 Spec 確認，一定擱置\n- blocks: 匯出功能那張票\n'


class ReviewCase(UnattendedStopCase):
    def setUp(self):
        super().setUp()
        self.md = self.lat / 'unattended' / f'{SESSION}-r1-review.md'

    def review(self, *args, code=0):
        return self.unattended('review', *args, code=code)

    def parked(self, name='LAT-P'):
        (self.decisions / f'{name}.md').write_text(
            f'# {name} 要不要加匯出\n\n' + PARKED.format(session=SESSION))

    def ledger(self, rows):
        path = self.lat / 'ledgers' / f'{SESSION}-r1.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(dict(items=rows, titles={'o/w#7': '登入頁'})))

    def park_row(self, row_id=3, status='parked', unparked=False):
        history = [dict(at='2026-11-13T01:00:00+00:00', action='park', reason='定版後重開兩次仍有甲級',
                        changes=dict(status=['in_progress', 'parked'],
                                     parked_from=[None, 'in_progress'],
                                     parked_reason=[None, '定版後重開兩次仍有甲級']))]
        if unparked:
            history.append(dict(at='2026-11-13T02:00:00+00:00', action='unpark',
                                reason='使用者：照 B 做', changes={}))
        return dict(id=row_id, ticket='7', stage='impl', status=status, history=history,
                    parked_cause=None, evidence={})

    def autos(self, *entries):
        path = self.lat / 'preauth-records' / f'{SESSION}-r1.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(entry, ensure_ascii=False) + '\n' for entry in entries))

    def headings(self):
        return [line[3:] for line in self.md.read_text().splitlines() if line.startswith('## ')]

    def item_ids(self):
        return re.findall(r'^### (\S+) ', self.md.read_text(), re.MULTILINE)

class CreationTests(ReviewCase):
    def test_created_at_the_first_item_and_updated_on_every_change(self):
        self.grant()
        self.assertIsNone(self.review('update')['path'])
        self.assertEqual(self.stop(), {})
        self.assertFalse(self.md.exists())
        self.parked()
        self.stop()
        self.assertTrue(self.md.exists())
        self.assertIn('第 1 版：你在看板開啟', self.md.read_text())
        request = self.board_request(('ticket-confirmation', 'assume-defaults', 'prototype'),
                                     op='update', goal='修好登入頁與註冊頁')
        self.unattended('update', '--goal', '修好登入頁與註冊頁', '--source', 'user-edit',
                        '--evidence', request)
        text = self.md.read_text()
        self.assertIn('第 2 版：你修改', text)
        self.assertIn('修好登入頁與註冊頁', text)
        self.unattended('close', '--reason', 'off')
        self.assertIn('- 無人授權：已結束（第 2 版，使用者關掉', self.md.read_text())

    def command(self, line='ls'):
        """The controller's next shell command: the PreToolUse hook runs before it."""
        payload = dict(hook_event_name='PreToolUse', cwd=str(self.work), session_id=SESSION,
                       tool_name='Bash', tool_input=dict(command=line))
        result = self.run_script(SESSION_SCRIPT, 'hook', '--client', 'codex',
                                 stdin=json.dumps(payload), session=OTHER)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def edited(self, tool_name, tool_input):
        """The controller's file tool just ran: the PostToolUse hook runs after it."""
        payload = dict(hook_event_name='PostToolUse', cwd=str(self.work), session_id=SESSION,
                       tool_name=tool_name, tool_input=tool_input)
        result = self.run_script(SESSION_SCRIPT, 'hook', '--client', 'codex',
                                 stdin=json.dumps(payload), session=OTHER)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def test_a_record_written_with_the_editor_is_in_the_review_right_after_the_write(self):
        """#568: Claude's Write/Edit and Codex's apply_patch of a decision record rebuild the
        review at once, before any further command; other files do not."""
        self.grant()
        (self.work / 'notes.md').write_text('x')
        self.edited('Write', dict(file_path=str(self.work / 'notes.md'), content='x'))
        self.assertFalse(self.md.exists())
        self.parked()
        self.edited('Write', dict(file_path=str(self.decisions / 'LAT-P.md'), content='...'))
        self.assertEqual(self.item_ids(), ['LAT-P'])
        self.parked('LAT-Q')
        patch = '*** Begin Patch\n*** Add File: .lat/decisions/LAT-Q.md\n+...\n*** End Patch\n'
        self.edited('apply_patch', dict(command=patch))
        self.assertEqual(self.item_ids(), ['LAT-P', 'LAT-Q'])
        (self.decisions / 'LAT-Q.md').unlink()
        self.edited('apply_patch', dict(command='*** Begin Patch\n*** Delete File: '
                                        '.lat/decisions/LAT-Q.md\n*** End Patch\n'))
        self.assertEqual(self.item_ids(), ['LAT-P'])

    def test_each_new_or_changed_item_is_in_the_review_before_the_turn_ends(self):
        """#568: a record written with the editor is in the review by the controller's next
        command. #662: a pre-authorization record is no review item, and writing one leaves
        the review as it was."""
        self.grant()
        self.command()
        self.assertFalse(self.md.exists())
        self.parked()
        self.command()
        self.assertEqual(self.item_ids(), ['LAT-P'])
        before = self.md.read_bytes()
        self.autos(dict(kind='auto', action='merge', target='dev', commit='a' * 40,
                        basis='allow merge dev', result='succeeded'))
        result = self.run_script(PREAUTH, 'record', '--kind', 'correction', '--commit', 'a' * 40,
                                 '--note', '合錯分支')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.md.read_bytes(), before)
        self.review('update')
        self.assertEqual(self.md.read_bytes(), before)
        self.assertEqual(self.item_ids(), ['LAT-P'])

    def test_no_review_for_a_round_without_a_grant(self):
        self.autos(dict(kind='auto', action='merge', target='dev', commit='a' * 40,
                        basis='allow', result='succeeded'))
        self.assertIn('no unattended grant', self.review('update')['reason'])
        self.stop()
        self.assertFalse(self.md.exists())

    def test_a_first_ticket_parked_with_nothing_done_shows_only_parked_and_goal(self):
        self.grant()
        self.ledger([self.park_row()])
        result = self.review('update')
        self.assertTrue(result['path'])
        self.assertEqual(self.headings(), ['擱置等你的事', '本輪目標與做完條件', '最該先看的幾項'])
        self.assertEqual(self.item_ids(), ['row-3'])
        self.assertIn('#7 登入頁（impl，row 3）', self.md.read_text())


class LayoutTests(ReviewCase):
    def fill(self):
        self.grant()
        self.parked()
        self.delegated('LAT-AN', extra='- decision: 叫 LoginPanel\n')
        self.delegated('LAT-AU', extra='', drop=('- assume-class',)).write_text(
            self.delegated('LAT-AU').read_text().replace('assume-class: naming',
                                                         'assume-class: ui-detail'))
        self.delegated('LAT-PC', 'proxy-confirmed')
        self.delegated('LAT-PR', 'prototype-decided')
        self.ledger([self.park_row(), dict(id=4, ticket='8', stage='impl', status='done',
                                           history=[], evidence={'commit': 'abc1234'})])
        self.autos(dict(kind='auto', action='merge', target='dev', commit='b' * 40,
                        basis='allow merge dev', result='succeeded'),
                   dict(kind='auto', action='deploy', commit='c' * 40, basis='allow deploy',
                        result='succeeded'))

    def test_sections_follow_the_spec_and_the_top_items_are_sorted(self):
        self.fill()
        self.review('update')
        self.assertEqual(self.headings(), ['擱置等你的事', '本輪目標與做完條件', '最該先看的幾項',
                                           '假設', '代確認的票', '樣品決定', '本輪完成的票'])
        text = self.md.read_text()
        top = re.findall(r'^\d+\. (\S+)（', text, re.MULTILINE)
        # parked -> proxy-confirmed -> boundary assumption -> the rest; no auto action
        self.assertEqual(top, ['LAT-P', 'row-3', 'LAT-PC', 'LAT-AU', 'LAT-AN'])
        self.assertTrue(text.startswith(f'# 無人模式回顧：session {SESSION} 第 1 輪\n\n- 更新：'))
        self.assertNotIn('核對', text)
        self.assertNotIn('auto-', text)

    def test_every_item_has_each_field_and_ids_survive_updates(self):
        self.fill()
        self.review('update')
        before = self.item_ids()
        blocks = self.md.read_text().split('\n### ')[1:]
        self.assertEqual(len(blocks), len(before))
        for block in blocks:
            for label in ('種類', '狀態', '做了什麼', '為什麼', '證據', '怎麼推翻'):
                self.assertRegex(block, rf'\n- {label}：\S', block)
        self.delegated('LAT-AA')
        self.autos(*[json.loads(line) for line in (
            self.lat / 'preauth-records' / f'{SESSION}-r1.jsonl').read_text().splitlines()],
                   dict(kind='auto', action='merge', target='dev', commit='d' * 40,
                        basis='allow merge dev', result='succeeded'))
        self.review('update')
        after = self.item_ids()
        self.assertEqual([i for i in after if i in before], before)
        self.assertEqual(set(after) - set(before), {'LAT-AA'})
        view = self.review('show')['view']
        self.assertEqual(sorted(item['id'] for item in view['items']), sorted(after))

    def test_pre_authorization_records_are_not_read(self):
        """#662: an unreadable or auto line in the pre-authorization records is neither an
        item nor an unreadable source."""
        self.grant()
        self.parked()
        path = self.lat / 'preauth-records' / f'{SESSION}-r1.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{broken\n' + json.dumps(dict(kind='auto', action='merge', target='dev',
                                                         commit='e' * 40, basis='allow',
                                                         result='succeeded')) + '\n')
        self.review('update')
        self.assertEqual(self.item_ids(), ['LAT-P'])
        self.assertNotIn('## 讀不出的來源', self.md.read_text())

    def test_a_reply_or_override_is_marked_with_its_time(self):
        self.grant()
        self.parked()
        self.delegated('LAT-AS')
        self.ledger([self.park_row(status='unassigned', unparked=True)])
        for name, text in (('LAT-P', '照 B 做'), ('LAT-AS', '推翻：改叫 SignIn')):
            result = self.run_script(SESSION_SCRIPT.parent.parent / 'herdr-panel/lat_panel.py',
                                     'question', 'record-chat', '--id', name, '--text', text,
                                     '--source', 'session s-1 回顧頁', '--decisions',
                                     self.decisions)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        items = {item['id']: item for item in self.review('show')['view']['items']}
        self.assertEqual(items['LAT-P']['state'], 'answered')
        self.assertEqual(items['LAT-AS']['state'], 'overturned')
        self.assertEqual(items['row-3']['state'], 'answered')
        text = self.md.read_text()
        self.assertRegex(text, r'- 狀態：已由你回覆（20\d\d-')
        self.assertRegex(text, r'- 狀態：已由你推翻（20\d\d-')
        self.assertIn('- 狀態：已解除擱置（2026-11-13T02:00:00+00:00）：使用者：照 B 做', text)
        self.assertNotIn('## 最該先看的幾項', text)


class TruthfulTextTests(ReviewCase):
    def item(self, identifier):
        text = self.md.read_text()
        return text.split(f'### {identifier} ', 1)[1].split('\n### ', 1)[0].split('\n## ', 1)[0]

    def test_a_proxy_confirmed_item_takes_the_decision_line(self):
        self.grant()
        self.delegated('LAT-PC', 'proxy-confirmed', extra='- decision: 開工，先做登入頁\n')
        self.review('update')
        self.assertIn('開工，先做登入頁', self.item('LAT-PC').split('做了什麼：', 1)[1].split('\n', 1)[0])

class NoCrossCheckTests(ReviewCase):
    def test_review_verify_is_gone(self):
        result = self.run_script(SESSION_SCRIPT.parent / 'lat-unattended.py', 'review', '--help')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('verify', result.stdout)
        result = self.run_script(SESSION_SCRIPT.parent / 'lat-unattended.py', 'review', 'verify',
                                 '--checker', 'puma', '--family', 'claude', '--total', '1',
                                 '--matched', '1')
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid choice: 'verify'", result.stderr)

    def test_done_and_deactivate_pass_with_an_unchecked_review(self):
        self.grant()
        self.delegated('LAT-AN')
        self.review('update')
        self.assertEqual(self.item_ids(), ['LAT-AN'])
        self.assertEqual(self.stop('完成\nDONE: 交付'), {})
        self.unattended('close', '--reason', 'off')
        self.assertEqual(self.stop('完成\nDONE: 交付'), {})
        result = self.run_script(SESSION_SCRIPT, 'deactivate', '--client', 'codex',
                                 '--workspace', self.work, '--session-id', SESSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('核對', result.stdout)

    def test_an_old_review_with_a_check_line_and_auto_items_opens_and_is_not_rewritten(self):
        """A state file with a cross-check and a review file with the check line and an auto
        item open without errors; the files stay as they were, and both the JSON and the printed
        text come from the sources."""
        self.grant()
        self.delegated('LAT-AN')
        self.review('update')
        state_path = self.md.with_suffix('.json')
        state = json.loads(state_path.read_text())
        state.update(content_sha='0' * 64, verification=dict(
            checker='puma', family='claude', at='2026-11-01T00:00:00+00:00', total=2, matched=2,
            mismatches=[], content_sha='0' * 64))
        state_path.write_text(json.dumps(state))
        old = self.md.read_text().replace(
            '\n- 更新：', '\n- 核對：puma（claude）於 2026-11-01T00:00:00+00:00 核對，2 項中 2 項相符，'
            '0 項不符\n- 更新：') + ('\n## 自動做的動作\n\n### auto-1 merge dev aaaaaaa\n\n'
                                  '- 種類：自動動作\n- 狀態：已執行\n')
        self.md.write_text(old)
        self.autos(dict(kind='auto', action='merge', target='dev', commit='a' * 40,
                        basis='allow merge dev', result='succeeded'))
        first = self.review('show')['body_sha']
        self.delegated('LAT-AB')
        saved = state_path.read_text()
        shown = self.review('show')
        # The board reloads the tab when this changes, though the file is not rewritten.
        self.assertNotEqual(shown['body_sha'], first)
        self.assertEqual([item['id'] for item in shown['view']['items']], ['LAT-AB', 'LAT-AN'])
        self.assertNotIn('verified', shown)
        printed = self.run_script(SESSION_SCRIPT.parent / 'lat-unattended.py', 'review', 'show')
        self.assertEqual(printed.returncode, 0, printed.stderr)
        self.assertIn('### LAT-AB ', printed.stdout)
        self.assertNotIn('核對', printed.stdout)
        self.assertNotIn('自動做的動作', printed.stdout)
        self.assertEqual(self.stop('完成\nDONE: 交付'), {})
        self.assertEqual((self.md.read_text(), state_path.read_text()), (old, saved))


class DoneTicketTests(ReviewCase):
    def row(self, row_id, stage, status, ticket='7', commit=None):
        return dict(id=row_id, ticket=ticket, stage=stage, status=status, history=[],
                    parked_cause=None, evidence=dict(commit=[commit]) if commit else {})

    def done_lines(self):
        text = self.md.read_text()
        return text.split('## 本輪完成的票\n\n', 1)[1].split('\n\n', 1)[0].splitlines() \
            if '## 本輪完成的票' in text else []

    def test_done_tickets_are_one_line_per_delivered_ticket(self):
        self.grant()
        self.parked()
        self.ledger([self.row(1, 'advisor', 'done'), self.row(2, 'impl', 'done', commit='abc1234'),
                     self.row(3, 'review', 'done'), self.row(4, 'other', 'done'),
                     self.row(5, 'impl', 'in_progress', ticket='8'),
                     self.row(6, 'research', 'done', ticket='9'),
                     self.row(7, 'impl', 'done', ticket='#10, o/w#11', commit='fed9876'),
                     self.row(8, 'review', 'in_progress', ticket='o/w#11')])
        self.review('update')
        # Ticket 11 waits for its review row; a row naming two tickets counts for each.
        self.assertEqual(self.done_lines(), ['- #7 登入頁：commit abc1234', '- #10：commit fed9876'])


class HandoverTests(ReviewCase):
    def test_deactivate_prints_the_review_path_and_another_session_can_read_it(self):
        self.grant()
        self.parked()
        result = self.run_script(SESSION_SCRIPT, 'deactivate', '--client', 'codex',
                                 '--workspace', self.work, '--session-id', SESSION)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'本輪回顧檔：{self.md}', result.stdout)
        self.assertIn('已結束（第 1 版，交付', self.md.read_text())
        shown = self.run_script(SESSION_SCRIPT.parent / 'lat-unattended.py', 'review', 'show',
                                '--session-id', SESSION, session='3' * 8 + SESSION[8:])
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertIn('### LAT-P 要不要加匯出', shown.stdout)


if __name__ == '__main__':
    unittest.main()


def load_board():
    """herdr-panel/board.py, imported by path as lat_panel does."""
    import importlib
    panel = Path(__file__).resolve().parents[1] / 'herdr-panel'
    if str(panel) not in sys.path:
        sys.path.insert(0, str(panel))
    return importlib.import_module('board')


class DelegatedCardTests(ReviewCase):
    """#663: what the board's 代決 cards are built from: each delegated item carries its record's
    own lines, and a grant ending takes the cards made before it off the controller page."""

    def items(self):
        return {item['id']: item for item in self.review('show')['view']['items']}

    def cards(self):
        return [card['id'] for card in load_board().delegated_cards(self.review('show')['view'])]

    def test_each_kind_carries_its_own_lines(self):
        self.grant()
        self.parked()
        self.delegated('LAT-AS', extra='- decision: 叫 SignIn\n')
        self.delegated('LAT-PC', 'proxy-confirmed')
        self.delegated('LAT-PR', 'prototype-decided', extra='- decision: 用卡片版\n')
        items = self.items()
        assumed, confirmed, sample = items['LAT-AS'], items['LAT-PC'], items['LAT-PR']
        for item in (assumed, confirmed, sample):
            self.assertEqual(item['question'], '元件要叫什麼名字')
            self.assertEqual(item['grant_version'], 1)
            self.assertEqual([(o['who'], o['stance']) for o in item['opinions']],
                             [('puma（claude opus）', 'agree'), ('kiwi（codex gpt-6-astra）', 'agree')])
            self.assertEqual(item['opinions'][0]['text'], '只改命名，不動驗收')
        self.assertEqual((assumed['decision'], assumed['revert_to'], assumed['checks'], assumed['sample']),
                         ('叫 SignIn', '改成 LoginPanel', [], None))
        self.assertEqual((confirmed['decision'], confirmed['revert_to'], confirmed['sample']), (None, None, None))
        self.assertEqual(confirmed['checks'], ['登入成功跳到首頁 ← 「登入後要回首頁」 session s-1 第 2 則'])
        self.assertEqual((sample['revert_to'], sample['checks'], sample['sample']),
                         (None, [], '.lat/runs/issue-1/proto/index.html'))
        self.assertNotIn('opinions', items['LAT-P'])
        # Only the delegated ones are cards; the parked record is a question of its own.
        self.assertEqual(self.cards(), ['LAT-AS', 'LAT-PC', 'LAT-PR'])

    def test_an_update_keeps_the_cards_and_an_end_takes_them_for_good(self):
        self.grant()
        self.delegated('LAT-A1')
        self.assertEqual(self.cards(), ['LAT-A1'])
        self.unattended('update', '--goal', '改目標', '--source', 'user-edit', '--evidence',
                        self.board_request(('ticket-confirmation', 'assume-defaults', 'prototype'),
                                           op='update', goal='改目標'))
        self.delegated('LAT-A2', version=2)
        self.assertEqual(self.cards(), ['LAT-A1', 'LAT-A2'])
        self.unattended('close', '--reason', 'off')
        self.assertEqual(self.cards(), [])
        self.grant()
        self.delegated('LAT-A3', version=3)
        self.assertEqual(self.cards(), ['LAT-A3'])
        # The review itself still lists every one of them.
        self.assertEqual(sorted(self.items()), ['LAT-A1', 'LAT-A2', 'LAT-A3'])

    def test_every_way_a_grant_ends_takes_the_cards(self):
        for reason in ('off', 'quota', 'delivered', 'cancelled', 'handover'):
            with self.subTest(reason=reason):
                for path in self.decisions.glob('*.md'):
                    path.unlink()
                version = self.grant()['version']
                self.delegated(f'LAT-{reason}', version=version)
                self.assertEqual(self.cards(), [f'LAT-{reason}'])
                self.unattended('close', '--reason', reason)
                self.assertEqual(self.cards(), [])


class AskedQuestionTests(ReviewCase):
    """#664: the questions asked during this round's grant, for the board's review tab: told by
    their `- grant:` line, waiting or answered with the answer; never delegated or parked ones,
    and the review file does not list them."""

    def question(self, name, *, status='pending', grant='r1 v1', session=SESSION, advisor='needs-human',
                 tail=''):
        lines = [f'# {name} 通知卡片要不要加關閉鈕？', '', f'- status: {status}', f'- advisor: {advisor}',
                 f'- session: {session}']
        if grant:
            lines.append(f'- grant: {grant}')
        lines += ['- version: r1', '- question: 通知卡片要不要加關閉鈕', '- options: A 要加 / B 不加']
        (self.decisions / f'{name}.md').write_text('\n'.join(lines) + '\n' + tail)

    def test_waiting_and_answered_questions_of_this_grant_are_listed(self):
        self.grant()
        self.question('Q-OPEN')
        self.question('Q-DONE', status='approved', tail=(
            '\n## 答覆（r1，面板，2026-11-16T10:00:00+08:00）\n\n- 答覆：A. 要加\n- 核准：加關閉鈕\n'))
        self.question('Q-OLD', grant='r2 v1')
        self.question('Q-NOGRANT', grant=None)
        self.question('Q-OTHER', session=OTHER)
        self.question('Q-RESOLVED', status='advisor-resolved', advisor='resolved')
        self.question('Q-OVERTURN', status='answered', advisor='proxy assume-defaults', tail=(
            '\n## 答覆（r1，聊天，2026-11-16T10:00:00+08:00）\n\n- 答覆：推翻\n'
            '- 來源：聊天（回顧項目）\n'))
        self.parked()
        self.delegated('LAT-AS')
        result = self.review('show')
        asked = result['view']['asked']
        self.assertEqual([entry['id'] for entry in asked], ['Q-DONE', 'Q-OPEN'])
        done, waiting = asked
        self.assertEqual((done['state'], done['answer'], done['answered_at'], done['grant_version']),
                         ('answered', 'A. 要加', '2026-11-16T10:00:00+08:00', 1))
        self.assertEqual(done['title'], '通知卡片要不要加關閉鈕？')
        self.assertEqual((waiting['state'], waiting['answer'], waiting['answered_at']),
                         ('open', None, None))
        self.assertEqual(waiting['question'], '通知卡片要不要加關閉鈕')
        # They stay out of the items and out of the review file.
        self.assertNotIn('Q-OPEN', [item['id'] for item in result['view']['items']])
        self.assertNotIn('Q-OPEN', self.md.read_text())
