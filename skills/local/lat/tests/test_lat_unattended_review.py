"""The unattended round's review file: when it is created and updated, its layout, stable item
ids, the cross-check and the DONE: hold at the turn end. Temp HOME/XDG dirs, a temp Git repo and
a fake controller record, as in test_lat_unattended_decisions."""
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_lat_unattended_decisions import (  # noqa: E402
    SESSION, SESSION_SCRIPT, UnattendedStopCase)

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

    def verify(self, *extra, family='claude', code=0, total=None):
        total = total if total is not None else len(self.item_ids())
        return self.review('verify', '--checker', 'puma', '--family', family, '--total',
                           total, '--matched', total - len(extra) // 2, *extra, code=code)


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
                                           '假設', '代確認的票', '樣品決定', '自動做的動作',
                                           '本輪完成的票'])
        text = self.md.read_text()
        top = re.findall(r'^\d+\. (\S+)（', text, re.MULTILINE)
        # parked -> proxy-confirmed -> boundary assumption -> auto deploy -> the rest
        self.assertEqual(top, ['LAT-P', 'row-3', 'LAT-PC', 'LAT-AU', 'auto-2'])
        self.assertTrue(text.startswith(f'# 無人模式回顧：session {SESSION} 第 1 輪\n\n- 核對：尚未核對'))

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
        self.assertEqual(set(after) - set(before), {'LAT-AA', 'auto-3'})
        view = self.review('show')['view']
        self.assertEqual(sorted(item['id'] for item in view['items']), sorted(after))

    def test_an_unreadable_record_line_is_listed_and_leaves_the_other_ids_alone(self):
        self.grant()
        path = self.lat / 'preauth-records' / f'{SESSION}-r1.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{broken\n' + json.dumps(dict(kind='auto', action='merge', target='dev',
                                                         commit='e' * 40, basis='allow',
                                                         result='succeeded')) + '\n')
        self.review('update')
        self.assertEqual(self.item_ids(), ['auto-2'])
        self.assertIn('## 讀不出的來源', self.md.read_text())

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


class CrossCheckTests(ReviewCase):
    def setUp(self):
        super().setUp()
        self.grant()
        self.parked()
        self.delegated('LAT-AN')
        self.review('update')

    def test_the_conclusion_is_written_and_a_later_change_resets_it(self):
        self.assertIn('- 核對：尚未核對', self.md.read_text())
        refused = self.verify(family='gpt', code=1)  # the controller is Codex
        self.assertIn('another model family', refused['reason'])
        self.assertIn('2 items', self.verify(total=3, code=1)['reason'])
        self.assertIn('--mismatch', self.review(
            'verify', '--checker', 'puma', '--family', 'claude', '--total', 2, '--matched', 1,
            code=1)['reason'])
        self.verify('--mismatch', 'LAT-AN：紀錄寫的是 LoginForm')
        text = self.md.read_text()
        self.assertIn('- 核對：puma（claude）於 ', text)
        self.assertIn('2 項中 1 項相符，1 項不符\n  - 不符 LAT-AN：紀錄寫的是 LoginForm', text)
        self.assertTrue(self.review('show')['verified'])
        # The grant ending changes the body but not what was checked.
        self.unattended('close', '--reason', 'delivered')
        self.assertIn('- 核對：puma（claude）', self.md.read_text())
        self.delegated('LAT-AB')
        self.review('update')
        self.assertIn('- 核對：尚未核對（', self.md.read_text())
        self.assertFalse(self.review('show')['verified'])


class DoneHoldTests(ReviewCase):
    def test_done_is_held_once_until_the_review_is_cross_checked(self):
        self.grant()
        self.parked()
        self.assert_held(self.stop('完成\nDONE: 交付'), 'LAT 回顧核對未通過', 'review verify',
                         '--total 1')
        released = self.stop('完成\nDONE: 交付', active=True)
        self.assertNotEqual(released.get('decision'), 'block')
        self.verify()
        self.assertEqual(self.stop('完成\nDONE: 交付'), {})

    def test_a_grant_that_already_ended_still_needs_the_check(self):
        self.grant()
        self.parked()
        self.unattended('close', '--reason', 'off')
        self.assert_held(self.stop('完成\nDONE: 交付'), 'LAT 回顧核對未通過')

    def test_no_hold_without_a_grant_or_without_items(self):
        self.parked()
        self.assertEqual(self.stop('完成\nDONE: 交付'), {})
        (self.decisions / 'LAT-P.md').unlink()
        self.grant()
        self.assertEqual(self.stop('完成\nDONE: 交付'), {})


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
