"""CLI contract tests for lat-dispatch.py: subprocess, temp dirs, a fake HCOM list file."""
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-dispatch.py'
WATCH = SCRIPT.parent / 'lat-watch.py'
LIVE = '重建 staging 最多 2 次；最長 45 分鐘；出現 429 即停'
PREFLIGHT = '測試帳號 qa-01 已登入（主控已核對）；重建失敗時切回上一個映像'
VISUAL = '看水面起伏（靜止、起浪中、轉場）；對照使用者選定的 sea-b.png；水面尖峰或黑塊算錯'
BRIEF = '''## 目標與完成條件
修正 #123 的登入逾時；驗收條件 1–3 全部有測試並通過。

### 小標題
- 清單項目

## 範圍與不能碰
只改 server/auth；不碰資料庫結構。

## 其他 Agent 與分工
QA 由 nanu-qa123-xxxx 負責。

## 現場動作額度
依任務卡；補充說明。
'''


# The orchestrator the cards name: an untagged HCOM agent, so its full name is `nanu`.
ORCH = {'name': 'nanu', 'base_name': 'nanu'}


class DispatchCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.workspace = self.root / 'ws'
        self.tasks = self.workspace / '.lat' / 'tasks'
        self.tasks.mkdir(parents=True)
        self.agents = [{'name': 'nanu-impl123-fida', 'base_name': 'fida', 'tag': 'nanu-impl123'},
                       ORCH]
        self.listing = self.root / 'hcom-list.json'

    def run_script(self, *args, agents='default', env=None):
        self.listing.write_text(json.dumps(self.agents if agents == 'default' else agents))
        env = {**os.environ, 'LAT_DISPATCH_HCOM_LIST': str(self.listing),
               'LAT_LEDGER_HCOM_LIST': str(self.listing), **(env or {})}
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                              text=True, env=env, timeout=60)

    def card_args(self, *extra, tag='nanu-impl123', live=LIVE, preflight=PREFLIGHT, visual='無'):
        args = ['card', '--tag', tag, '--tasks', str(self.tasks), '--orchestrator', 'nanu',
                '--date', '2026-10-23', '--runs', str(self.workspace / '.lat/runs/issue-123')]
        if live is not None:
            args += ['--live-actions', live]
        if preflight is not None:
            args += ['--preflight', preflight]
        if visual is not None:
            args += ['--visual-acceptance', visual]
        return args + list(extra)

    def make_card(self, **kwargs):
        result = self.run_script(*self.card_args(**kwargs))
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.splitlines()[0])

    def write_brief(self, text=BRIEF, name='brief.md'):
        path = self.root / name
        path.write_text(text)
        return path


class CardTests(DispatchCase):
    def test_unique_tag_creates_card_in_template_order_with_full_name(self):
        result = self.run_script(*self.card_args('--model', 'codex gpt-6-astra medium'))
        self.assertEqual(result.returncode, 0, result.stderr)
        card = self.tasks / '2026-10-23-nanu-impl123.md'
        self.assertEqual(result.stdout.splitlines()[0], str(card))
        lines = card.read_text().splitlines()
        self.assertEqual(lines[0], '接續：無')
        names = [re.match(r'- ([^：]+)：', line).group(1) for line in lines[2:]]
        self.assertEqual(names, [
            'agent', 'orchestrator', 'model', 'branch', 'worktree', 'base commit', 'status',
            'owned resources', 'live actions', 'preflight', '視覺驗收', '預計檢查數', '整套測試', 'runs',
            'temp paths', 'done so far', 'next step', 'deliverable commit'])
        text = card.read_text()
        self.assertIn('- agent：nanu-impl123-fida\n', text)
        self.assertIn('- orchestrator：nanu\n', text)
        self.assertIn('- model：codex gpt-6-astra medium\n', text)
        self.assertIn('- status：dispatched\n', text)
        self.assertIn(f'- live actions：{LIVE}\n', text)
        self.assertIn(f'- preflight：{PREFLIGHT}\n', text)
        self.assertIn('- branch：無\n', text)
        self.assertIn(f'- runs：{self.workspace}/.lat/runs/issue-123\n', text)

    def test_missing_or_ambiguous_tag_fails_without_creating_a_card(self):
        for agents, reason in (
                ([], 'no HCOM agent carries tag'),
                ([{'name': 'other-tag-aaaa', 'tag': 'other'}], 'no HCOM agent carries tag'),
                ([{'name': 'nanu-impl123-fida', 'tag': 'nanu-impl123'},
                  {'name': 'nanu-impl123-gape', 'tag': 'nanu-impl123'}], 'not unique')):
            with self.subTest(reason=reason, count=len(agents)):
                result = self.run_script(*self.card_args(), agents=agents)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(reason, result.stderr)
                self.assertEqual(list(self.tasks.iterdir()), [])

    def test_agent_option_picks_one_of_several_agents_sharing_a_tag(self):
        pair = [{'name': 'nanu-impl123-fida', 'tag': 'nanu-impl123'},
                {'name': 'nanu-impl123-gape', 'tag': 'nanu-impl123'}, ORCH]
        for given, number in (('nanu-impl123-gape', ''), ('gape', '-2')):
            with self.subTest(agent=given):
                result = self.run_script(*self.card_args('--agent', given), agents=pair)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn('- agent：nanu-impl123-gape\n',
                              (self.tasks / f'2026-10-23-nanu-impl123{number}.md').read_text())
        for other in ('nanu-impl123-zzzz', 'nanu-impl123'):
            with self.subTest(agent=other):
                result = self.run_script(*self.card_args('--agent', other), agents=pair)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'--agent: Unknown HCOM agent: {other}; HCOM lists: '
                              'nanu-impl123-fida, nanu-impl123-gape', result.stderr)

    def test_orchestrator_base_name_is_written_as_its_full_hcom_name(self):
        tagged = {'name': 'lat-fix-nanu', 'base_name': 'nanu', 'tag': 'lat-fix'}
        self.agents = [self.agents[0], tagged]
        self.assertIn('- orchestrator：lat-fix-nanu\n', self.make_card().read_text())

    def test_unknown_or_ambiguous_orchestrator_makes_no_card(self):
        fida = self.agents[0]
        for agents, reason in (
                ([fida], '--orchestrator: Unknown HCOM agent: nanu; HCOM lists: '
                         'nanu-impl123-fida; nothing written'),
                ([fida, {'name': 'a-nanu'}, {'name': 'b-nanu'}],
                 '--orchestrator: Ambiguous HCOM agent nanu: a-nanu, b-nanu')):
            for extra in ((), ('--native', '--agent', 'nanu-research-web')):
                with self.subTest(reason=reason, extra=extra):
                    result = self.run_script(*self.card_args(*extra), agents=agents)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(reason, result.stderr)
                    self.assertEqual(list(self.tasks.iterdir()), [])

    def test_unreadable_hcom_list_fails_without_creating_a_card(self):
        listing = self.root / 'missing.json'
        env = {**os.environ, 'LAT_DISPATCH_HCOM_LIST': str(listing)}
        for extra in ((), ('--native', '--agent', 'nanu-research-web')):
            with self.subTest(extra=extra):
                result = subprocess.run([sys.executable, str(SCRIPT), *self.card_args(*extra)],
                                        capture_output=True, text=True, env=env, timeout=60)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('unreadable', result.stderr)
                self.assertEqual(list(self.tasks.iterdir()), [])

    def test_missing_required_card_field_is_refused(self):
        for kwargs in ({'live': None}, {'preflight': None}, {'visual': None},
                       {'live': '  '}, {'preflight': ''}, {'visual': ' '}):
            with self.subTest(kwargs=kwargs):
                result = self.run_script(*self.card_args(**kwargs))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(list(self.tasks.iterdir()), [])

    def test_explicit_none_is_accepted_for_both_fields(self):
        card = self.make_card(live='無', preflight='無')
        self.assertIn('- live actions：無\n', card.read_text())
        self.assertIn('- 視覺驗收：無\n', card.read_text())

    def test_same_day_redispatch_gets_suffix_and_links_the_previous_card(self):
        first = self.make_card()
        first_text = first.read_text()
        second = self.make_card()
        third = self.make_card()
        self.assertEqual(second.name, '2026-10-23-nanu-impl123-2.md')
        self.assertEqual(third.name, '2026-10-23-nanu-impl123-3.md')
        self.assertEqual(second.read_text().splitlines()[0], f'接續：{first}')
        self.assertEqual(third.read_text().splitlines()[0], f'接續：{second}')
        self.assertEqual(first.read_text(), first_text)

    def test_other_day_or_tag_does_not_collide(self):
        self.make_card()
        result = self.run_script(*self.card_args(), '--date', '2026-10-24')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.tasks / '2026-10-24-nanu-impl123.md').is_file())

    def test_archived_card_of_the_same_day_still_counts(self):
        first = self.make_card()
        (self.tasks / 'done').mkdir()
        archived = self.tasks / 'done' / first.name
        first.rename(archived)
        second = self.make_card()
        self.assertEqual(second.name, '2026-10-23-nanu-impl123-2.md')
        self.assertEqual(second.read_text().splitlines()[0], f'接續：{archived}')

    def test_multiline_value_is_refused(self):
        result = self.run_script(*self.card_args('--branch', 'a\nb'))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(list(self.tasks.iterdir()), [])

    def test_missing_task_directory_is_refused(self):
        args = self.card_args()
        args[args.index('--tasks') + 1] = str(self.root / 'nope')
        result = self.run_script(*args)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('does not exist', result.stderr)


class BriefTests(DispatchCase):
    def brief(self, text=BRIEF, *extra, card=None):
        source = self.write_brief(text)
        card = card or self.make_card()
        result = self.run_script('brief', '--card', str(card), '--input', str(source), *extra)
        return source, card, result

    def test_complete_input_produces_filled_brief_and_leaves_the_input_alone(self):
        source, card, result = self.brief(
            BRIEF, '--lat-dir', '/skills/lat')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(source.read_text(), BRIEF)
        output = self.root / 'brief.brief.md'
        text = output.read_text()
        for section in ('目標與完成條件', '範圍與不能碰', '其他 Agent 與分工', '現場動作額度'):
            self.assertIn(f'## {section}\n', text)
        self.assertIn('### 小標題\n- 清單項目', text)
        agent, ws = 'nanu-impl123-fida', self.workspace
        for expected in (
                f'Report to: nanu', f'Working directory: {ws}', f'{card}',
                f'{ws}/.lat/runs/issue-123', f'{ws}/.lat/decisions',
                '`hcom send @nanu --name fida`',
                f'/skills/lat/scripts/lat-watch.py wait --workspace {ws} --agent {agent} --for',
                f'/skills/lat/scripts/lat-watch.py alarm --workspace {ws} --agent {agent} --after 30',
                'Never run `hcom send` without `@`', 'Nobody watches your terminal',
                'Stuck rule', 'Do not use background programs to message yourself'):
            self.assertIn(expected, text)
        self.assertNotIn('{', text.replace('<decision ID or agent name>', ''))

    def test_read_only_swaps_the_card_update_sentence(self):
        _, _, result = self.brief(BRIEF, '--read-only')
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.root / 'brief.brief.md').read_text()
        self.assertNotIn('Update it at the start', text)
        self.assertIn('do not edit it', text)
        self.assertNotIn('Write restrictions in this section', text)

    def test_default_brief_exempts_card_and_ledger_from_scope_write_limits(self):
        self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        scope = text.index('## 範圍與不能碰')
        note = text.index('Write restrictions in this section do not apply to updating the task card')
        self.assertIn('work-ledger commands', text[note:note + 200])
        self.assertLess(scope, note)
        self.assertLess(note, text.index('## 其他 Agent 與分工'))

    def test_default_brief_keeps_the_card_update_sentence(self):
        self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('Update it at the start, at checkpoints and at the end', text)
        self.assertNotIn('do not edit it', text)

    def test_include_sits_after_the_four_sections_and_before_live_actions(self):
        extra = self.root / 'shared.md'
        extra.write_text('SHARED-MARKER $(not run)\n')
        _, _, result = self.brief(BRIEF, '--include', str(extra))
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.root / 'brief.brief.md').read_text()
        marker = text.index('SHARED-MARKER $(not run)')
        self.assertLess(text.index('## 現場動作額度'), marker)
        self.assertLess(marker, text.index('## Task card live actions'))

    def test_missing_include_file_is_refused(self):
        _, _, result = self.brief(BRIEF, '--include', str(self.root / 'nope.md'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--include unreadable', result.stderr)
        self.assertFalse((self.root / 'brief.brief.md').exists())

    def test_wait_and_alarm_commands_quote_paths_with_spaces(self):
        import shlex
        lat = self.root / 'LAT skills'
        _, _, result = self.brief(BRIEF, '--lat-dir', str(lat))
        text = (self.root / 'brief.brief.md').read_text()
        commands = [line.strip().strip('`') for line in text.splitlines()
                    if 'lat-watch.py' in line]
        self.assertEqual(len(commands), 2)
        for command in commands:
            words = shlex.split(command.replace("<decision ID or agent name>", 'x'))
            self.assertEqual(words[4], str(lat / 'scripts/lat-watch.py'))
            self.assertEqual(words[words.index('--workspace') + 1], str(self.workspace))

    def test_fixed_section_carries_decision_and_direct_contact_rules(self):
        self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('stop work that depends on a pending decision', text)
        self.assertIn('No reply from the user is not approval', text)
        self.assertIn('contact them directly', text)

    def test_fixed_section_tells_the_agent_not_to_send_start_or_progress_acks(self):
        self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('Report only results, blockers, live-action quota hits and questions '
                      'outside the Spec; never send a start or progress ack.', text)

    def test_longer_fence_may_contain_a_shorter_fence_with_a_heading(self):
        text = BRIEF.replace('- 清單項目', '````\n```\n## 目標與完成條件\n```\n````')
        source, _, result = self.brief(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('## 目標與完成條件\n```\n````', (self.root / 'brief.brief.md').read_text())

    def test_printed_send_command_uses_file(self):
        _, _, result = self.brief()
        output = self.root / 'brief.brief.md'
        self.assertIn(
            f'hcom send @nanu-impl123-fida --name nanu --file {output}',
            result.stdout)
        self.assertEqual(
            result.stdout.splitlines()[-1],
            f'hcom send @nanu-impl123-fida --name nanu --file {output}')
        self.assertNotIn('<<', result.stdout)
        # --intent request would have HCOM wake the sender at the agent's next turn end.
        self.assertNotIn('--intent', result.stdout)

    def test_send_names_are_the_base_names_hcom_records_for_tagged_agents(self):
        self.agents.append({'name': 'lat-fix-nanu', 'base_name': 'nanu', 'tag': 'lat-fix'})
        card = self.make_card(live=LIVE)
        text = card.read_text().replace('- orchestrator：nanu\n', '- orchestrator：lat-fix-nanu\n')
        card.write_text(text)
        _, _, result = self.brief(card=card)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'brief.brief.md'
        self.assertIn(f'hcom send @nanu-impl123-fida --name nanu --file {output}',
                      result.stdout)
        self.assertIn('`hcom send @lat-fix-nanu --name fida`', output.read_text())

    def test_untagged_agent_keeps_its_name(self):
        self.agents = [{'name': 'fida', 'base_name': 'fida', 'tag': 'nanu-impl123'}, ORCH]
        _, _, result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--name nanu --file', result.stdout)
        self.assertIn('`hcom send @nanu --name fida`', (self.root / 'brief.brief.md').read_text())

    def test_live_actions_and_preflight_are_copied_verbatim_with_quota_rules(self):
        _, _, result = self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn(f'- live actions：{LIVE}', text)
        self.assertIn(f'- preflight：{PREFLIGHT}', text)
        for rule in ('Before acting, check every `preflight` item',
                     'inside the `live actions` quota yourself', 'stop and report',
                     'never replaces them',
                     'keeps at least one use of the quota for the final candidate version',
                     'after the implementer says the version is final'):
            self.assertIn(rule, text)

    def test_no_live_actions_card_still_carries_both_fields_and_rules(self):
        card = self.make_card(live='無', preflight='無')
        self.brief(BRIEF, card=card)
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('- live actions：無\n- preflight：無\n', text)
        self.assertIn('Before acting, check every `preflight` item', text)

    def test_visual_acceptance_is_copied_verbatim_with_its_rules(self):
        card = self.make_card(visual=VISUAL)
        self.brief(BRIEF, card=card)
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn(f'- 視覺驗收：{VISUAL}\n', text)
        for rule in ('someone other than the implementer', 'mid-motion and transition frames',
                     'matching a prototype', 'raise it', 'fails on the defective version',
                     'Use the `ui-copy` skill', 'explanatory text read to be understood',
                     'only examples, not the full list', 'hand it to the orchestrator',
                     "that screenshot's width and font size", 'the widths the task card lists'):
            self.assertIn(rule, text)

    def test_visual_acceptance_of_none_carries_the_field_without_the_rules(self):
        self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('- 視覺驗收：無\n', text)
        self.assertNotIn('mid-motion and transition frames', text)
        self.assertNotIn('ui-copy', text)
        self.assertNotIn('only examples, not the full list', text)

    def test_full_suite_field_is_copied_verbatim_only_when_it_has_a_value(self):
        command = '實作最終版本跑一次 `suite-gate.py affected --base <sha> --purpose pre-merge`'
        result = self.run_script(*self.card_args('--full-suite', command))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.brief(BRIEF, card=Path(result.stdout.splitlines()[0]))
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn(f'- 整套測試：{command}\n', text)
        self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertNotIn('整套測試', text)
        self.assertNotIn('full-suite test', text)
        card = self.make_card()
        card.write_text(''.join(line + '\n' for line in card.read_text().splitlines()
                                if not line.startswith('- 整套測試：')))
        self.brief(BRIEF, card=card)
        self.assertNotIn('整套測試', (self.root / 'brief.brief.md').read_text())

    def test_section_text_cannot_replace_the_card_fields(self):
        text = BRIEF.replace('依任務卡；補充說明。', '無現場動作，不必填卡片。')
        self.brief(text)
        out = (self.root / 'brief.brief.md').read_text()
        self.assertIn(f'- live actions：{LIVE}', out)

    def test_output_option_and_default_location(self):
        target = self.root / 'out' / 'task.md'
        _, _, result = self.brief(BRIEF, '--output', str(target))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(target.is_file())
        self.assertIn(f'--file {target}', result.stdout)

    def test_output_equal_to_input_is_refused(self):
        source = self.write_brief()
        card = self.make_card()
        result = self.run_script('brief', '--card', str(card), '--input', str(source),
                                 '--output', str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(source.read_text(), BRIEF)

    def test_bad_inputs_are_refused_with_the_problem_named(self):
        cases = {
            'missing': (BRIEF.replace('## 其他 Agent 與分工', '## 別的'), '其他 Agent 與分工'),
            'empty': (BRIEF.replace('只改 server/auth；不碰資料庫結構。\n', ''),
                      'empty section: ## 範圍與不能碰'),
            'before': ('前言\n' + BRIEF, 'text before the first heading'),
            'duplicate': (BRIEF + '\n## 目標與完成條件\n再寫一次\n',
                          'duplicate heading: ## 目標與完成條件'),
        }
        for name, (text, expected) in cases.items():
            with self.subTest(name):
                source, _, result = self.brief(text)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertFalse((self.root / 'brief.brief.md').exists())

    def test_heading_inside_a_code_fence_is_content_not_a_heading(self):
        text = BRIEF.replace('- 清單項目', '```\n## 目標與完成條件\n```')
        _, _, result = self.brief(text)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_missing_unreadable_or_incomplete_card_is_refused(self):
        source = self.write_brief()
        result = self.run_script('brief', '--input', str(source))
        self.assertNotEqual(result.returncode, 0)
        result = self.run_script('brief', '--card', str(self.root / 'none.md'),
                                 '--input', str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unreadable', result.stderr)
        card = self.make_card()
        values = {'live actions': LIVE, 'preflight': PREFLIGHT, '視覺驗收': '無'}
        for field, value in values.items():
            with self.subTest(field=field):
                text = card.read_text()
                broken = self.root / f'broken-{field.replace(" ", "")}.md'
                broken.write_text('\n'.join(
                    line for line in text.splitlines() if not line.startswith(f'- {field}：')))
                result = self.run_script('brief', '--card', str(broken), '--input', str(source))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(field, result.stderr)
                empty = self.root / f'empty-{field.replace(" ", "")}.md'
                empty.write_text(text.replace(f'- {field}：{value}', f'- {field}：'))
                result = self.run_script('brief', '--card', str(empty), '--input', str(source))
                self.assertNotEqual(result.returncode, 0)

    def test_card_outside_lat_tasks_needs_an_explicit_workspace(self):
        card = self.root / 'loose-card.md'
        card.write_text(self.make_card().read_text())
        source = self.write_brief()
        result = self.run_script('brief', '--card', str(card), '--input', str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--workspace', result.stderr)
        result = self.run_script('brief', '--card', str(card), '--input', str(source),
                                 '--workspace', str(self.workspace))
        self.assertEqual(result.returncode, 0, result.stderr)


class WatchCompatibilityTests(DispatchCase):
    @staticmethod
    def load_watch():
        spec = importlib.util.spec_from_file_location('lat_watch', WATCH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_hand_written_template_card_is_still_monitored(self):
        hand = self.tasks / '2026-10-23-hand.md'
        hand.write_text('接續：無（重派時填上一張任務卡路徑）\n\n'
                        '- agent：nanu-hand-kiza (HCOM tag nanu-hand)\n'
                        '- orchestrator：nanu\n- status：in progress\n'
                        f'- live actions：{LIVE}\n- preflight：{PREFLIGHT}\n- 視覺驗收：無\n'
                        '- next step：\n')
        incomplete = {}
        cards, skipped = self.load_watch().monitored_task_cards(self.tasks, 'nanu', incomplete)
        self.assertEqual(skipped, {})
        self.assertEqual(incomplete, {})
        self.assertIn('nanu-hand-kiza', cards)

    def test_tool_made_card_is_monitored_by_the_watch(self):
        self.make_card()
        cards, skipped = self.load_watch().monitored_task_cards(self.tasks, 'nanu', {})
        self.assertEqual(skipped, {})
        self.assertEqual(cards['nanu-impl123-fida']['status'], 'dispatched')

    def test_native_card_keeps_the_agent_name_and_is_marked_for_the_watch(self):
        result = self.run_script(*self.card_args('--native', '--agent', 'nanu-research-web'),
                                 agents=[ORCH])
        self.assertEqual(result.returncode, 0, result.stderr)
        card = self.tasks / '2026-10-23-nanu-impl123.md'
        self.assertIn('- agent：nanu-research-web\n- orchestrator：nanu\n- native agent：是\n',
                      card.read_text())
        watch = self.load_watch()
        cards, skipped = watch.monitored_task_cards(self.tasks, 'nanu', {})
        self.assertEqual(skipped, {})
        self.assertTrue(cards['nanu-research-web']['_native'])
        self.assertEqual(watch.monitored_agents(self.tasks, 'nanu'), ['nanu'])

    def test_native_card_without_a_valid_agent_name_is_refused(self):
        for extra in ((), ('--agent', 'bad name!')):
            with self.subTest(extra=extra):
                result = self.run_script(*self.card_args('--native', *extra))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('--native needs --agent', result.stderr)
                self.assertEqual(list(self.tasks.glob('*.md')), [])


LEDGER = SCRIPT.parent / 'lat-ledger.py'


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True,
                          text=True).stdout.strip()


class LedgerCase(DispatchCase):
    """A real temp Git workspace with an initialised ledger; commands run as the agents would."""

    def setUp(self):
        super().setUp()
        git(self.workspace, 'init', '-q', '-b', 'dev')
        git(self.workspace, 'config', 'user.email', 't@example.com')
        git(self.workspace, 'config', 'user.name', 'T')
        (self.workspace / 'a.txt').write_text('a\n')
        git(self.workspace, 'add', 'a.txt')
        git(self.workspace, 'commit', '-q', '-m', 'first')
        self.sha = git(self.workspace, 'rev-parse', 'HEAD')
        self.ledger = self.workspace / '.lat' / 'ledgers' / 'round-1.json'
        self.ledger_env = {**os.environ, 'SUITE_GATE_STATE_DIR': str(self.root / 'gate'),
                           'XDG_CONFIG_HOME': str(self.root / 'config'),
                           'LAT_LEDGER_HCOM_LIST': str(self.listing)}
        for name in ('SUITE_GATE_CONFIG', 'HCOM_INSTANCE_NAME'):
            self.ledger_env.pop(name, None)
        self.run_ledger('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
                        '--orchestrator', 'nanu')

    def review_before_done(self, row):
        """An impl row closes only after a review result (#549); tests about other things
        record a clean one first."""
        doc = json.loads(self.run_ledger('show', '--json'))
        item = next((i for i in doc['items'] if i['id'] == int(row)), None)
        if item and item['stage'] == 'impl' and not any(r['row'] == item['id']
                                                        for r in doc['reviews']):
            self.run_ledger('review-result', '--row', str(row), '--reviewer', 'auto-reviewer',
                            '--clean')

    def run_ledger(self, *args):
        if args[0] == 'done':
            self.review_before_done(args[1])
        self.listing.write_text(json.dumps(self.agents))
        result = subprocess.run(
            [sys.executable, str(LEDGER), args[0], '--ledger', str(self.ledger), *args[1:]],
            capture_output=True, text=True, env=self.ledger_env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def items(self):
        return json.loads(self.run_ledger('show', '--json'))['items']

    def ledger_card(self, *extra, evidence='commit'):
        return self.card_with(
            '--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'impl',
            '--evidence', evidence, *extra)

    def card_with(self, *extra):
        result = self.run_script(*self.card_args(*extra))
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.splitlines()[0])

    def brief_commands(self, card):
        """The four ledger commands of a generated brief, with placeholders filled in."""
        source = self.write_brief()
        result = self.run_script('brief', '--card', str(card), '--input', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.root / 'brief.brief.md').read_text()
        commands = [command for command in re.findall(r'`(uv run [^`]*lat-ledger\.py[^`]*)`', text)
                    if not re.search(r' (review-result|problem|problem-update) ', command)]
        self.assertEqual(len(commands), 4, text)
        return text, commands

    @staticmethod
    def clean_review(text):
        """The brief's command recording a clean review of the row (impl rows only)."""
        return re.search(r'`(uv run [^`]*lat-ledger\.py review-result [^`]*--clean)`',
                         text).group(1)


class LedgerCardTests(LedgerCase):
    def test_card_with_options_opens_assigns_and_records_the_row(self):
        card = self.ledger_card('--depends', '')
        row, = self.items()
        self.assertEqual((row['id'], row['ticket'], row['stage'], row['status']),
                         (1, '#123', 'impl', 'assigned'))
        self.assertEqual((row['agent'], row['card']), ('nanu-impl123-fida', str(card)))
        self.assertEqual(row['evidence_kinds'], ['commit'])
        self.assertIsNone(row['deadline'])  # set by start --eta, not by the orchestrator
        text = card.read_text()
        self.assertIn(f'- ledger row：1 ({self.ledger})\n', text)
        self.assertIn('- status：dispatched\n', text)

    def test_native_card_keeps_the_ledger_row_after_status(self):
        card = self.ledger_card('--native', '--agent', 'nanu-research-web')
        self.assertIn('- native agent：是\n', card.read_text())
        self.assertIn(f'- status：dispatched\n- ledger row：1 ({self.ledger})\n', card.read_text())
        self.assertEqual(self.items()[0]['agent'], 'nanu-research-web')

    def test_second_card_gets_the_next_row_and_can_depend_on_the_first(self):
        self.ledger_card()
        self.agents.append({'name': 'nanu-qa123-kora', 'tag': 'nanu-qa123'})
        second = self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'qa',
                                '--evidence', 'file', '--depends', '1')
        self.assertIn('- ledger row：2 (', second.read_text())
        self.assertEqual(self.items()[1]['depends_on'], [1])

    def test_title_option_names_the_ticket_in_the_ledger(self):
        self.ledger_card('--title', 'Show the ticket title')
        tickets = json.loads(self.run_ledger('show', '--json'))['tickets']
        self.assertEqual([(t['key'], t['title']) for t in tickets],
                         [('#123', 'Show the ticket title')])

    def test_repo_option_is_passed_to_the_ledger_row(self):
        repo = self.root / 'other'
        repo.mkdir()
        subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
        self.ledger_card('--repo', str(repo))
        self.assertEqual(self.items()[0]['repo'], str(repo))

    def test_card_help_says_what_ledger_needs(self):
        text = ' '.join(self.run_script('card', '--help').stdout.split())
        self.assertIn('Needs --ticket, --stage and --evidence together', text)

    def test_a_passed_deadline_is_ignored_with_a_notice(self):
        result = self.run_script(*self.card_args(
            '--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'impl',
            '--evidence', 'commit', '--deadline', '+2h'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--deadline ignored', result.stderr)
        self.assertIsNone(self.items()[0]['deadline'])

    def test_stage_implement_is_recorded_as_impl_and_help_lists_the_stages(self):
        self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'implement',
                       '--evidence', 'commit')
        self.assertEqual(self.items()[0]['stage'], 'impl')
        text = self.run_script('card', '--help').stdout
        for stage in ('impl', 'qa-draft', 'spec-review', 'implement'):
            self.assertIn(stage, text)
        self.assertIn('absolute path of the local git checkout', ' '.join(text.split()))

    def test_repo_given_as_owner_name_is_refused_with_the_absolute_path_hint(self):
        result = self.run_script(*self.card_args(
            '--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'impl',
            '--evidence', 'commit', '--repo', 'owner/name'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('absolute path of the local git checkout', result.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])

    def test_card_without_ledger_options_is_unchanged(self):
        card = self.make_card()
        self.assertNotIn('ledger row', card.read_text())
        self.assertEqual(self.items(), [])

    def test_ledger_options_need_the_ledger_and_the_ledger_needs_its_options(self):
        stray = self.run_script(*self.card_args('--ticket', '#123'))
        self.assertNotEqual(stray.returncode, 0)
        self.assertIn('need --ledger', stray.stderr)
        partial = self.run_script(*self.card_args('--ledger', str(self.ledger), '--ticket', '#1'))
        self.assertNotEqual(partial.returncode, 0)
        for name in ('--stage', '--evidence'):
            self.assertIn(name, partial.stderr)
        self.assertNotIn('--deadline', partial.stderr)
        relative = self.run_script(*self.card_args(
            '--ledger', 'ledger.json', '--ticket', '#1', '--stage', 'impl', '--evidence', 'commit'))
        self.assertIn('absolute', relative.stderr)
        missing = self.run_script(*self.card_args(
            '--ledger', str(self.root / 'none.json'), '--ticket', '#1', '--stage', 'impl',
            '--evidence', 'commit'))
        self.assertIn('does not exist', missing.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])

    def test_ledger_refusal_leaves_no_card(self):
        result = self.run_script(*self.card_args(
            '--ledger', str(self.ledger), '--ticket', '#1', '--stage', 'impl',
            '--evidence', 'commit', '--depends', '9'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unknown item', result.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])

    def test_earlier_round_ledger_is_refused_unless_old_round(self):
        self.ledger = self.ledger.with_name('sid-r1.json')
        self.run_ledger('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
                        '--orchestrator', 'nanu')
        current = self.ledger.with_name('sid-r2.json')
        sessions = self.workspace / '.lat' / 'sessions'
        sessions.mkdir()
        (sessions / 'sid.json').write_text(json.dumps({'ledger_path': str(current)}))
        args = ('--ledger', str(self.ledger), '--ticket', '#1', '--stage', 'impl',
                '--evidence', 'commit')
        result = self.run_script(*self.card_args(*args))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(current), result.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])
        card = self.card_with(*args, '--old-round')
        self.assertIn(f'- ledger row：1 ({self.ledger})\n', card.read_text())
        self.assertEqual(self.items()[0]['agent'], 'nanu-impl123-fida')

    def test_tiny_card_marks_the_ticket_rows_and_the_card(self):
        card = self.ledger_card('--tiny', '--no-feature', '--no-format-change')
        self.assertIn('- tiny lane：是；主控聲明不新增功能、不改資料或存檔格式\n', card.read_text())
        self.agents.append({'name': 'nanu-qa123-kora', 'tag': 'nanu-qa123'})
        self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'qa',
                       '--evidence', 'file', '--tag', 'nanu-qa123')
        marks = [row.get('tiny') for row in self.items()]
        self.assertEqual(marks[0]['declared'], ['no-feature', 'no-format-change'])
        self.assertEqual(marks[1], marks[0], 'a later row of the ticket carries the mark')
        self.assertIn('小改動', self.run_ledger('show', '--rows'))

    def test_tiny_card_refusals_leave_no_card_and_no_row(self):
        for extra, words in ((('--ticket', '#123, #124', '--tiny', '--no-feature',
                               '--no-format-change'), 'exactly one numbered ticket'),
                             (('--ticket', '#123', '--tiny', '--no-feature'), 'both declarations'),
                             (('--ticket', '#123', '--no-feature'), 'both declarations')):
            result = self.run_script(*self.card_args(
                '--ledger', str(self.ledger), '--stage', 'impl', '--evidence', 'commit', *extra))
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(words, result.stderr)
        self.assertIn('need --ledger', self.run_script(*self.card_args('--tiny')).stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])

    def test_untagged_agent_is_refused_before_the_ledger_is_touched(self):
        result = self.run_script(*self.card_args(
            '--ledger', str(self.ledger), '--ticket', '#1', '--stage', 'impl',
            '--evidence', 'commit'), agents=[])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.items(), [])

    def test_ledger_card_is_still_monitored_by_the_watch(self):
        self.ledger_card()
        watch = WatchCompatibilityTests.load_watch()
        cards, skipped = watch.monitored_task_cards(self.tasks, 'nanu', {})
        self.assertEqual(skipped, {})
        self.assertIn('nanu-impl123-fida', cards)


class LedgerBriefTests(LedgerCase):
    def test_fixed_section_names_the_row_and_the_four_commands_with_absolute_paths(self):
        text, commands = self.brief_commands(self.ledger_card())
        self.assertIn(f'Your ledger row is 1 in {self.ledger}', text)
        for command, verb in zip(commands, ('start', 'update', 'done', 'amend'), strict=True):
            self.assertIn(f'lat-ledger.py {verb} 1 --ledger {self.ledger} --by nanu-impl123-fida',
                          command)
            self.assertIn(str(LEDGER), command)

    def test_report_goes_to_a_file_in_the_runs_folder_named_after_the_agent(self):
        text, _ = self.brief_commands(self.ledger_card())
        path = self.workspace / '.lat/runs/issue-123/report-nanu-impl123-fida.md'
        self.assertIn(f'Write the full report to {path} first', text)
        self.assertNotIn('send the full report in the message', text)

    def test_card_without_a_runs_folder_keeps_the_report_in_the_message(self):
        text, _ = self.brief_commands(self.ledger_card('--runs', '無'))
        self.assertIn('send the full report in the message', text)
        self.assertNotIn('report-nanu', text)

    def test_qa_draft_row_asks_for_spec_coverage(self):
        card = self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage',
                              'qa-draft', '--evidence', 'file')
        text, _ = self.brief_commands(card)
        self.assertIn('## Spec coverage', text)
        self.assertIn('Put the entries no ticket covers at the top of your report', text)

    def test_only_impl_rows_are_told_to_record_review_results(self):
        text, _ = self.brief_commands(self.ledger_card())
        self.assertIn('lat-ledger.py review-result --row 1 --ledger', text)
        self.assertIn("--finding '<甲|乙|丙>:<one line>'", text)
        self.assertIn('lat-ledger.py problem-update <id> --ledger', text)
        self.assertNotIn('--no-findings', text)
        card = self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage',
                              'qa', '--evidence', 'file')
        qa = self.brief_commands(card)[0]
        self.assertNotIn('review-result', qa)
        self.assertIn('lat-ledger.py problem --row 2 --ledger', qa)
        self.assertIn('--stage qa --level <甲|乙|丙>', qa)
        self.assertIn('add `--no-findings` to `done`', qa)

    def test_other_stages_carry_no_spec_coverage(self):
        text, _ = self.brief_commands(self.ledger_card())
        self.assertNotIn('## Spec coverage', text)

    def test_unreadable_ledger_skips_spec_coverage_with_a_warning(self):
        card = self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage',
                              'qa-draft', '--evidence', 'file')
        self.ledger.write_text('not json')
        result = self.run_script('brief', '--card', str(card), '--input', str(self.write_brief()))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no spec coverage section', result.stderr)
        self.assertNotIn('## Spec coverage', (self.root / 'brief.brief.md').read_text())

    def test_ledger_path_with_spaces_is_quoted(self):
        spaced = self.workspace / '.lat' / 'my ledgers' / 'round.json'
        spaced.parent.mkdir()
        self.ledger = spaced
        self.run_ledger('init', '--workspace', str(self.workspace))
        _, commands = self.brief_commands(self.ledger_card())
        self.assertIn(f"--ledger '{spaced}'", commands[0])

    def session(self, name, status='ended', successor=None):
        sessions = self.workspace / '.lat' / 'sessions'
        sessions.mkdir(parents=True, exist_ok=True)
        (sessions / f'{name}.json').write_text(json.dumps(
            {'hcom_name': name, 'status': status, 'successor': successor}))

    def former_warning(self, text):
        card = self.make_card()
        result = self.run_script('brief', '--card', str(card), '--input', str(self.write_brief(text)))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.splitlines()[-1].startswith('hcom send @'))
        self.assertTrue((self.root / 'brief.brief.md').exists())
        return [line for line in result.stderr.splitlines() if 'former orchestrator' in line]

    def test_brief_warns_when_the_input_names_a_controller_that_handed_over(self):
        self.session('pono', successor='nanu')
        warnings = self.former_warning(BRIEF.replace('QA 由', 'Report to pono. QA 由'))
        self.assertEqual(len(warnings), 1)
        self.assertIn('pono', warnings[0])
        self.assertIn('nanu', warnings[0])

    def test_brief_warns_about_a_name_right_next_to_chinese_text(self):
        self.session('pono', successor='nanu')
        for mention in ('完成後回報給pono。', '回報給@pono並附證據。'):
            self.assertEqual(len(self.former_warning(BRIEF.replace('QA 由', f'{mention}QA 由'))), 1)

    def test_brief_follows_the_handover_chain_and_base_names(self):
        self.session('old-lead-mide', successor='pono')
        self.session('pono', successor='lead-nanu')
        self.agents = [*self.agents[:-1], {'name': 'lead-nanu', 'base_name': 'nanu'}]
        card = self.card_args()
        card[card.index('--orchestrator') + 1] = 'lead-nanu'
        self.run_script(*card)
        path = next(self.tasks.glob('*.md'))
        source = self.write_brief(BRIEF.replace('QA 由', 'Ask mide and @pono. QA 由'))
        result = self.run_script('brief', '--card', str(path), '--input', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('mide', result.stderr)
        self.assertIn('pono', result.stderr)

    def test_brief_stays_quiet_about_other_controllers_and_longer_names(self):
        self.session('pono', successor='nanu')
        self.session('sibo', status='active')
        self.session('dako', successor='other')
        self.assertEqual(self.former_warning(
            BRIEF.replace('QA 由', 'Ask sibo, dako and pono-adv-bevu. QA 由')), [])

    def test_unreadable_session_record_does_not_block_the_brief(self):
        self.session('pono', successor='nanu')
        (self.workspace / '.lat' / 'sessions' / 'bad.json').write_text('{not json')
        (self.workspace / '.lat' / 'sessions' / 'list.json').write_text('[]')
        (self.workspace / '.lat' / 'sessions' / 'types.json').write_text(
            json.dumps({'hcom_name': ['old'], 'successor': 'nanu'}))
        (self.workspace / '.lat' / 'sessions' / 'types2.json').write_text(
            json.dumps({'hcom_name': 'old2', 'successor': {'name': 'nanu'}}))
        self.assertEqual(len(self.former_warning(BRIEF.replace('QA 由', 'pono: QA 由'))), 1)

    def test_card_without_a_row_warns_but_still_produces_the_brief(self):
        card = self.make_card()
        source = self.write_brief()
        result = self.run_script('brief', '--card', str(card), '--input', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no ledger row', result.stderr)
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('This card has no ledger row', text)
        self.assertNotIn('lat-ledger.py', text)
        self.assertIn('## Fixed fields', text)


class LedgerLifecycleTests(LedgerCase):
    def run_command(self, command, **fill):
        for key, value in fill.items():
            command = command.replace(f'<{key}>', value)
        command = command.replace('+<N>m', '+30m')
        done = re.search(r'lat-ledger\.py done (\d+) ', command)
        if done:
            self.review_before_done(done.group(1))
        result = subprocess.run(shlex.split(command), capture_output=True, text=True,
                                env=self.ledger_env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_agent_runs_the_brief_commands_and_done_updates_the_card(self):
        card = self.ledger_card()
        text, (start, update, done, amend) = self.brief_commands(card)
        self.run_command(start)
        self.run_command(update, **{'one sentence': 'half way'})
        self.assertEqual(self.items()[0]['progress'], 'half way')
        self.run_command(self.clean_review(text), **{'HCOM name': 'rev'})
        done = done.replace('--gate <fingerprint> --file <absolute path>', '')
        self.run_command(done.replace('<sha>', self.sha))
        text = card.read_text()
        self.assertIn('- status：committed\n', text)
        self.assertIn(f'- deliverable commit：{self.sha}\n', text)
        self.assertEqual(self.items()[0]['status'], 'done')
        self.run_command(amend, **{'what changed': 'QA re-judged'})
        self.assertEqual(self.items()[0]['progress'], '補記：QA re-judged')

    def test_card_branch_lets_done_accept_a_commit_that_is_not_integrated_yet(self):
        git(self.workspace, 'switch', '-q', '-c', 'feat/x')
        (self.workspace / 'b.txt').write_text('b\n')
        git(self.workspace, 'add', 'b.txt')
        git(self.workspace, 'commit', '-q', '-m', 'work')
        sha = git(self.workspace, 'rev-parse', 'HEAD')
        git(self.workspace, 'switch', '-q', 'dev')
        card = self.ledger_card('--branch', 'feat/x')
        self.assertEqual(self.items()[0]['branch'], 'feat/x')
        _, (start, _update, done, _amend) = self.brief_commands(card)
        self.run_command(start)
        self.run_command(done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                                      f'--commit {sha}'))
        self.assertIn(f'- deliverable commit：{sha}\n', card.read_text())

    def test_file_evidence_closes_the_card_as_completed(self):
        card = self.ledger_card(evidence='file')
        report = self.root / 'report.md'
        report.write_text('checked\n')
        _, (start, _update, done, _amend) = self.brief_commands(card)
        self.run_command(start)
        done = done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                            f'--file {report}')
        self.run_command(done)
        self.assertIn('- status：completed\n', card.read_text())

    def test_missing_card_does_not_stop_done(self):
        card = self.ledger_card()
        _, (start, _update, done, _amend) = self.brief_commands(card)
        self.run_command(start)
        card.unlink()
        self.run_command(done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                                      f'--commit {self.sha}'))
        self.assertEqual(self.items()[0]['status'], 'done')

    def test_moving_the_card_to_done_then_updating_the_row_clears_the_mismatch(self):
        card = self.ledger_card()
        _, (start, _update, done, _amend) = self.brief_commands(card)
        self.run_command(start)
        self.run_command(done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                                      f'--commit {self.sha}'))
        (self.tasks / 'done').mkdir()
        moved = card.rename(self.tasks / 'done' / card.name)
        self.assertIn('task card unreadable', self.items_with_mismatch())
        self.run_ledger('update', '1', '--card', str(moved))
        self.assertIsNone(self.items_with_mismatch())

    def items_with_mismatch(self):
        return self.items()[0]['card_mismatch']


class PreauthBriefTests(DispatchCase):
    """brief --preauth carries the actions lat-preauth check allows now, and nothing else."""

    def setUp(self):
        super().setUp()
        git(self.workspace, 'init', '-q', '-b', 'dev')
        (self.workspace / '.lat' / 'preauth.toml').write_text(
            '[actions.merge]\nallow = true\nbranches = ["dev"]\nsource = "FUBE-PA-3"\n')
        self.env = {'XDG_CONFIG_HOME': str(self.root / 'xdg'), 'CLAUDE_CODE_SESSION_ID': '',
                    'CODEX_THREAD_ID': ''}

    def brief(self, *extra):
        source = self.write_brief()
        card = self.make_card()
        result = self.run_script('brief', '--card', str(card), '--input', str(source),
                                 *extra, env=self.env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return (self.root / 'brief.brief.md').read_text(), result

    def test_allowed_actions_go_into_the_brief_with_the_recheck_command(self):
        text, result = self.brief('--preauth', 'merge:dev', '--preauth', 'merge:main',
                                  '--session-id', 'sess-1')
        section = text[text.index('## Pre-authorized actions'):text.index('## Fixed fields')]
        self.assertLess(text.index('## Task card live actions'), text.index(section))
        self.assertIn('- allow merge dev — basis: allow=true from project (source FUBE-PA-3)',
                      section)
        self.assertNotIn('main', section.split('These held')[0])
        self.assertIn(f'lat-preauth.py check --workspace {self.workspace} --session-id sess-1 '
                      '--action <action> [--branch <branch>]', section)
        self.assertIn('report the action, the commit and that line to nanu', section)
        self.assertIn('not pre-authorized, left out of the brief: ask merge main', result.stderr)

    def test_no_section_when_nothing_is_pre_authorized_or_asked_for(self):
        for extra in ((), ('--preauth', 'push:dev')):
            with self.subTest(extra=extra):
                text, _ = self.brief(*extra)
                self.assertNotIn('Pre-authorized actions', text)

    def test_deploy_brief_has_the_controller_send_the_notices(self):
        suite = {'command': 'uv run pytest', 'cwd': '.'}
        (self.workspace / '.suite-gate.json').write_text(json.dumps({'full_suites': [suite]}))
        for item in (['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'],
                     ['add', '.suite-gate.json'], ['commit', '-q', '-m', 'first']):
            git(self.workspace, *item)
        spec = importlib.util.spec_from_file_location(
            'suite_gate_for_dispatch', SCRIPT.parents[2] / 'three-tier-testing/scripts/suite-gate.py')
        gate = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gate)
        tree = gate.content_tree(self.workspace, (), git(self.workspace, 'rev-parse', 'HEAD'))
        state = self.root / 'gate-state'
        state.mkdir()
        (state / 'ledger.jsonl').write_text(json.dumps({'fingerprint': gate.digest(
            tree, [suite['command']], gate.rel_cwd(self.workspace, self.workspace)),
            'reusable': True, 'exit_code': 0}) + '\n')
        (self.workspace / '.lat' / 'preauth.toml').write_text(
            'integration_branch = "dev"\n[actions.merge]\nallow = true\nbranches = ["dev"]\n'
            '[actions.deploy-test]\nallow = true\ntarget = "staging"\n')
        self.env.update(SUITE_GATE_STATE_DIR=str(state), SUITE_GATE_CONFIG='',
                        XDG_STATE_HOME=str(self.root / 'state'))
        text, result = self.brief('--preauth', 'deploy-test')
        self.assertIn('- allow deploy-test — basis: ', text, result.stderr)
        self.assertIn('Deploying and installing (deploy-test) also need two HCOM notices that '
                      'nanu itself sends', text)
        self.assertIn('report the start time and the result to nanu', text)
        text, _ = self.brief('--preauth', 'merge:dev')
        self.assertIn('- allow merge dev', text)
        self.assertNotIn('HCOM notices', text)

    def test_malformed_request_is_refused(self):
        result = self.run_script('brief', '--card', str(self.make_card()), '--input',
                                 str(self.write_brief()), '--preauth', 'Merge dev', env=self.env)
        self.assertEqual(result.returncode, 1)
        self.assertIn("--preauth must be ACTION or ACTION:BRANCH, not 'Merge dev'", result.stderr)


class CardCloseMergedTests(LedgerCase):
    """ouob-tw/LoopAgentTeams-work#436: normal close-out on a ledger with no integration branch,
    where the integration branch is not the repo's default branch."""

    def setUp(self):
        super().setUp()
        self.ledger = self.ledger.with_name('round-2.json')
        self.run_ledger('init', '--workspace', str(self.workspace), '--orchestrator', 'nanu')
        git(self.workspace, 'branch', 'main', self.sha)

    def closed_row(self, repo=None):
        """A row closed from a task worktree of `repo`; returns (card, worktree, commit)."""
        repo = repo or self.workspace
        worktree = repo / '.worktrees' / 'task'
        git(repo, 'worktree', 'add', '-q', '-b', 'task', str(worktree))
        (worktree / 't.txt').write_text('t\n')
        git(worktree, 'add', 't.txt')
        git(worktree, 'commit', '-q', '-m', 'task work')
        commit = git(worktree, 'rev-parse', 'HEAD')
        card = self.ledger_card('--repo', str(worktree))
        self.run_ledger('update', '1', '--by', 'nanu', '--branch', 'task')
        self.run_ledger('start', '1', '--by', 'nanu-impl123-fida', '--eta', '+1h')
        self.run_ledger('done', '1', '--by', 'nanu-impl123-fida', '--commit', commit)
        return card, worktree, commit

    def clean_up(self, repo, worktree, merge=True):
        if merge:
            git(repo, 'merge', '-q', '--no-ff', '-m', 'merge task', 'task')
        git(repo, 'worktree', 'remove', str(worktree))
        git(repo, 'branch', '-q', '-D', 'task')

    def close(self, card, *extra, status='merged'):
        return self.run_script('card', 'close', '--card', str(card), '--status', status,
                               '--deliverable', 'abc', '--by', 'nanu', *extra)

    def exempt_qa(self):
        qa = self.run_ledger('add', '--ticket', '#123', '--stage', 'qa', '--evidence', 'file',
                             '--by', 'nanu').strip()
        self.run_ledger('cancel', qa, '--by', 'nanu', '--reason', 'no QA needed')

    def check(self):
        return subprocess.run([sys.executable, str(LEDGER), 'check', '--ledger', str(self.ledger)],
                              capture_output=True, text=True, env=self.ledger_env, timeout=60)

    def assert_refused(self, card, result, message):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(message, result.stderr)
        self.assertTrue(card.exists())
        self.assertFalse((self.tasks / 'done' / card.name).exists())
        self.assertEqual(self.items()[0]['card'], str(card))

    def test_close_out_passes_check_with_the_commit_only_on_dev(self):
        card, worktree, _ = self.closed_row()
        self.clean_up(self.workspace, worktree)
        self.exempt_qa()
        result = self.close(card, '--merged-into', 'dev')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.check().returncode, 0, self.check().stdout)
        row = self.items()[0]
        self.assertEqual((row['repo'], row['branch']), (str(self.workspace), 'dev'))
        self.assertEqual(row['card'], str(self.tasks / 'done' / card.name))

    def test_close_out_of_a_worktree_of_another_repo(self):
        other = self.root / 'other'
        other.mkdir()
        git(other, 'init', '-q', '-b', 'dev')
        git(other, 'config', 'user.email', 't@example.com')
        git(other, 'config', 'user.name', 'T')
        (other / 'o.txt').write_text('o\n')
        git(other, 'add', 'o.txt')
        git(other, 'commit', '-q', '-m', 'first')
        card, worktree, _ = self.closed_row(other)
        self.clean_up(other, worktree)
        self.exempt_qa()
        result = self.close(card, '--merged-into', 'dev')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.check().returncode, 0, self.check().stdout)
        self.assertEqual(self.items()[0]['repo'], str(other))

    def test_an_unmerged_commit_is_refused_and_check_still_fails(self):
        card, worktree, commit = self.closed_row()
        self.clean_up(self.workspace, worktree, merge=False)
        result = self.close(card, '--merged-into', 'dev')
        self.assert_refused(card, result, f'{self.workspace}: {commit} is not reachable from dev')
        self.assertEqual(self.check().returncode, 1)

    def test_a_commit_dropped_from_the_branch_later_fails_check(self):
        card, worktree, _ = self.closed_row()
        self.clean_up(self.workspace, worktree)
        self.assertEqual(self.close(card, '--merged-into', 'dev').returncode, 0)
        git(self.workspace, 'reset', '-q', '--hard', self.sha)
        self.assertEqual(self.check().returncode, 1)

    def test_merged_into_must_name_a_local_branch(self):
        card, worktree, _ = self.closed_row()
        self.clean_up(self.workspace, worktree)
        self.assert_refused(card, self.close(card, '--merged-into', 'HEAD'), 'no branch HEAD')

    def test_merged_with_a_ledger_row_needs_the_branch(self):
        card, _, _ = self.closed_row()
        self.assert_refused(card, self.close(card), '--merged-into')

    def test_merged_into_needs_status_merged(self):
        card, _, _ = self.closed_row()
        self.assert_refused(card, self.close(card, '--merged-into', 'dev', status='committed'),
                            '--status merged')


class CardCloseTests(LedgerCase):
    EVIDENCE = '無（證據為 issue #5 留言 a/b\\c & $x）'

    def close(self, card, *extra, status='completed', deliverable=EVIDENCE):
        return self.run_script('card', 'close', '--card', str(card), '--status', status,
                               '--deliverable', deliverable, '--by', 'nanu', *extra)

    def done_ledger_card(self):
        """A ledger-row card whose row is already done (the order card close requires)."""
        card = self.ledger_card(evidence='file')
        report = self.root / 'report.md'
        report.write_text('checked\n')
        self.run_ledger('start', '1', '--by', 'nanu-impl123-fida', '--eta', '+1h')
        self.run_ledger('done', '1', '--by', 'nanu-impl123-fida', '--file', str(report))
        return card

    def test_open_row_refuses_every_status_and_changes_nothing(self):
        card = self.ledger_card()
        for state in ('assigned', 'in_progress'):
            if state == 'in_progress':
                self.run_ledger('start', '1', '--by', 'nanu-impl123-fida', '--eta', '+1h')
            for status in ('committed', 'merged', 'completed'):
                with self.subTest(state=state, status=status):
                    before, stored = card.read_text(), self.ledger.read_text()
                    extra = ('--merged-into', 'main') if status == 'merged' else ()
                    result = self.close(card, *extra, status=status)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f'ledger row 1 is still {state}', result.stderr)
                    self.assertIn('lat-ledger.py done 1', result.stderr)
                    self.assertEqual(card.read_text(), before)
                    self.assertEqual(self.ledger.read_text(), stored)
                    self.assertFalse((self.tasks / 'done' / card.name).exists())

    def test_cancelled_row_closes_the_card(self):
        card = self.ledger_card()
        self.run_ledger('cancel', '1', '--by', 'nanu', '--reason', 'dropped')
        result = self.close(card)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.tasks / 'done' / card.name).exists())

    def test_close_sets_fields_moves_the_card_and_repoints_the_ledger_row(self):
        card = self.done_ledger_card()
        result = self.close(card)
        self.assertEqual(result.returncode, 0, result.stderr)
        done = self.tasks / 'done' / card.name
        self.assertEqual(result.stdout.strip(), str(done))
        self.assertFalse(card.exists())
        text = done.read_text()
        self.assertIn('- status：completed\n', text)
        self.assertIn(f'- deliverable commit：{self.EVIDENCE}\n', text)
        self.assertIn('- agent：nanu-impl123-fida\n', text)
        self.assertEqual(self.items()[0]['card'], str(done))

    def test_close_without_a_ledger_row_still_closes_the_card(self):
        card = self.make_card()
        result = self.close(card, status='merged', deliverable='abc1234')
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.tasks / 'done' / card.name).read_text()
        self.assertIn('- status：merged\n- ', text)
        self.assertIn('- deliverable commit：abc1234\n', text)

    def test_wrong_ledger_row_leaves_card_and_ledger_unchanged(self):
        card = self.ledger_card()
        card.write_text(card.read_text().replace('ledger row：1', 'ledger row：99'))
        before, items = card.read_text(), self.items()
        result = self.close(card)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('99', result.stderr)
        self.assertEqual(card.read_text(), before)
        self.assertFalse((self.tasks / 'done' / card.name).exists())
        self.assertEqual(self.items(), items)

    def test_unwritable_done_directory_leaves_card_and_ledger_untouched(self):
        card = self.done_ledger_card()
        (self.tasks / 'done').write_text('a file where the done/ directory should be')
        before, stored = card.read_text(), self.ledger.read_text()
        result = self.close(card)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('card not closed', result.stderr)
        self.assertEqual(card.read_text(), before)
        self.assertEqual(self.ledger.read_text(), stored)

    def close_in_process(self, card, wrap_ledger=None, fail_unlink=None, fail_show=False):
        spec = importlib.util.spec_from_file_location('lat_dispatch_close', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        args = module.build_parser().parse_args(
            ['card-close', '--card', str(card), '--status', 'completed', '--deliverable', 'x',
             '--by', 'nanu'])
        original, run, updated = Path.unlink, module.run_ledger, []
        self.listing.write_text(json.dumps(self.agents))

        def unlink(path, *a, **k):
            if path == fail_unlink:
                raise PermissionError('injected')
            return original(path, *a, **k)

        def ledger(args, command, *rest):
            if fail_show and command == 'show' and updated:
                raise module.Failure('lat-ledger show timed out')
            result = run(args, command, *rest)
            if command == 'update':
                updated.append(1)
            if wrap_ledger and command == 'update':
                raise module.Failure('lat-ledger update timed out')
            return result

        with mock.patch.dict(os.environ, {'LAT_LEDGER_HCOM_LIST': str(self.listing)}), \
                mock.patch.object(Path, 'unlink', unlink), \
                mock.patch.object(module, 'run_ledger', ledger):
            with self.assertRaises(module.Failure) as raised:
                module.close_card(args)
        return str(raised.exception)

    def assert_back_in_place(self, card, before):
        self.assertEqual(card.read_text(), before)
        self.assertEqual(self.items()[0]['card'], str(card))
        self.assertFalse((self.tasks / 'done' / card.name).exists())

    def test_failing_to_remove_the_original_card_puts_card_and_ledger_row_back(self):
        card = self.done_ledger_card()
        before = card.read_text()
        message = self.close_in_process(card, fail_unlink=card)
        self.assertIn('injected', message)
        self.assert_back_in_place(card, before)

    def test_ledger_update_that_committed_before_failing_is_compensated(self):
        card = self.done_ledger_card()
        before = card.read_text()
        message = self.close_in_process(card, wrap_ledger=True)
        self.assertIn('timed out', message)
        self.assert_back_in_place(card, before)

    def test_unreadable_row_after_a_failed_update_names_the_fix_command(self):
        card = self.done_ledger_card()
        message = self.close_in_process(card, wrap_ledger=True, fail_show=True)
        self.assertIn('could not be put back', message)
        self.assertIn(f'lat-ledger.py update 1 --ledger {self.ledger} --card {card}', message)
        self.assertEqual(list((self.tasks / 'done').iterdir()), [])
        self.assertTrue(card.exists())

    def test_malformed_ledger_row_field_is_refused_before_anything_changes(self):
        card = self.ledger_card()
        card.write_text(card.read_text().replace('ledger row：1', 'ledger row：one'))
        before = card.read_text()
        result = self.close(card)
        self.assertIn('ledger row', result.stderr)
        self.assertEqual(card.read_text(), before)
        self.assertFalse((self.tasks / 'done').exists())

    def test_existing_target_unknown_status_and_missing_field_change_nothing(self):
        card = self.make_card()
        done = self.tasks / 'done'
        done.mkdir()
        (done / card.name).write_text('keep')
        before = card.read_text()
        result = self.close(card)
        self.assertIn('already exists', result.stderr)
        self.assertEqual((done / card.name).read_text(), 'keep')
        self.assertNotEqual(self.close(card, status='dispatched').returncode, 0)
        (done / card.name).unlink()
        card.write_text(before.replace('- deliverable commit：', '- other：'))
        broken = card.read_text()
        result = self.close(card)
        self.assertIn('deliverable commit', result.stderr)
        self.assertEqual(card.read_text(), broken)
        self.assertEqual(list(done.iterdir()), [])


class BeforeLaunchTests(LedgerCase):
    """`card --before-launch`, `brief` for that card, and the agent's own `card bind`."""

    def setUp(self):
        super().setUp()
        self.agents = [ORCH]  # the agent is launched only after its card and brief exist

    def launch(self):
        self.agents.append({'name': 'nanu-impl123-fida', 'base_name': 'fida',
                            'tag': 'nanu-impl123'})

    def pending_card(self, *extra):
        return self.card_with('--before-launch', *extra)

    def pending_ledger_card(self, *extra):
        return self.pending_card('--ledger', str(self.ledger), '--ticket', '#123', '--stage',
                                 'impl', '--evidence', 'commit', *extra)

    def agent_env(self, base='fida', tag='nanu-impl123'):
        return {'HCOM_INSTANCE_NAME': base, 'HCOM_TAG': tag}

    def bind(self, card, *extra, env=None):
        return self.run_script('card', 'bind', '--card', str(card), *extra,
                               env=self.agent_env() if env is None else env)

    def test_card_needs_no_launched_agent_and_waits_for_binding(self):
        card = self.pending_card()
        text = card.read_text()
        self.assertIn('- agent：待綁定\n', text)
        self.assertIn('- tag：nanu-impl123\n', text)
        self.assertIn('- status：dispatched\n', text)

    def test_ledger_row_is_added_but_assigned_only_at_binding(self):
        card = self.pending_ledger_card()
        row, = self.items()
        self.assertEqual((row['status'], row['agent']), ('unassigned', None))
        self.assertIn(f'- ledger row：1 ({self.ledger})\n', card.read_text())
        self.launch()
        result = self.bind(card)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'agent: nanu-impl123-fida')
        self.assertIn('- agent：nanu-impl123-fida\n', card.read_text())
        row, = self.items()
        self.assertEqual((row['status'], row['agent'], row['card']),
                         ('assigned', 'nanu-impl123-fida', str(card)))

    def test_binding_records_what_the_agent_really_runs_on(self):
        card = self.pending_ledger_card('--model', 'claude-sonnet-5-5 high')
        self.launch()
        transcript = self.root / 'fida.jsonl'
        transcript.write_text(json.dumps({'type': 'assistant', 'effort': 'low',
                                          'message': {'model': 'claude-opus-5-5'}}) + '\n')
        details = self.root / 'hcom-agents.json'
        details.write_text(json.dumps({'nanu-impl123-fida': {
            'tool': 'claude', 'usage': {'model': 'claude-opus-5-5'},
            'transcript_path': str(transcript)}}))
        result = self.bind(card, env={**self.agent_env(),
                                      'LAT_LEDGER_HCOM_AGENTS': str(details)})
        self.assertEqual(result.returncode, 0, result.stderr)
        bind = self.items()[0]['actual']['bind']
        self.assertEqual((bind['client'], bind['model'], bind['effort'], bind['verified']),
                         ('claude', 'claude-opus-5-5', 'low', True))

    def test_before_launch_refuses_agent_and_native(self):
        for extra in (('--agent', 'fida'), ('--native', '--agent', 'fida')):
            with self.subTest(extra=extra):
                result = self.run_script(*self.card_args('--before-launch', *extra))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('--before-launch', result.stderr)
                self.assertEqual(list(self.tasks.glob('*.md')), [])

    def test_bind_refuses_another_tag_a_bound_card_and_an_unlaunched_agent(self):
        card = self.pending_card()
        result = self.bind(card)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no HCOM agent carries tag', result.stderr)
        self.launch()
        result = self.bind(card, env=self.agent_env(tag='nanu-other'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("tag 'nanu-other'", result.stderr)
        self.assertIn('- agent：待綁定\n', card.read_text())
        self.assertEqual(self.bind(card).returncode, 0)
        result = self.bind(card)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already bound to nanu-impl123-fida', result.stderr)

    def test_orchestrator_can_bind_with_the_agent_option(self):
        card = self.pending_ledger_card()
        self.launch()
        result = self.bind(card, '--agent', 'fida', env={'HCOM_INSTANCE_NAME': 'nanu'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('- agent：nanu-impl123-fida\n', card.read_text())
        self.assertEqual(self.items()[0]['history'][-1]['by'], 'nanu')

    def test_failed_ledger_assignment_leaves_the_card_unbound(self):
        card = self.pending_ledger_card()
        self.launch()
        self.run_ledger('assign', '1', '--agent', 'fida', '--card', str(card))
        result = self.bind(card)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('- agent：待綁定\n', card.read_text())

    def test_brief_names_the_agent_through_its_environment_and_prints_the_launch_prompt(self):
        card = self.pending_ledger_card()
        source = self.write_brief()
        result = self.run_script('brief', '--card', str(card), '--input', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'brief.brief.md'
        text = output.read_text()
        self.assertIn('# Task brief for the agent tagged nanu-impl123\n', text)
        bind = re.search(r'`(uv run [^`]*lat-dispatch\.py card bind --card [^`]*)`', text)
        self.assertIsNotNone(bind, text)
        self.assertLess(text.index('card bind'), text.index('## 目標與完成條件'))
        self.assertIn('`hcom send @nanu --name "$HCOM_INSTANCE_NAME"`', text)
        self.assertIn('--agent "$HCOM_INSTANCE_NAME" --for', text)
        self.assertIn('--by "$HCOM_INSTANCE_NAME"', text)
        self.assertIn(str(self.workspace / f'.lat/runs/issue-123/report-{card.stem}.md'), text)
        self.assertNotIn('待綁定', text)
        last = result.stdout.splitlines()[-1]
        self.assertTrue(last.startswith('--hcom-prompt '), result.stdout)
        prompt, = shlex.split(last)[1:]
        self.assertIn(str(output), prompt)
        self.assertNotIn('\n', prompt)
        self.assertNotIn('hcom send', result.stdout)

    def test_agent_binds_then_runs_the_ledger_commands_from_its_brief(self):
        card = self.pending_ledger_card()
        _, (start, update, done, _) = self.brief_commands(card)
        text = (self.root / 'brief.brief.md').read_text()
        bind = re.search(r'`(uv run [^`]*lat-dispatch\.py card bind --card [^`]*)`', text).group(1)
        self.launch()
        self.listing.write_text(json.dumps(self.agents))
        env = {**self.ledger_env, **self.agent_env(),
               'LAT_DISPATCH_HCOM_LIST': str(self.listing)}
        for command in (bind, start.replace('+<N>m', '+30m'),
                        update.replace('<one sentence>', 'half way'),
                        self.clean_review(text).replace('<HCOM name>', 'rev'),
                        done.replace('<sha>', self.sha)
                            .replace('--gate <fingerprint> --file <absolute path>', '')):
            # The agent's shell expands "$HCOM_INSTANCE_NAME"; uv is replaced by this Python.
            command = command.replace('uv run --no-project python', shlex.quote(sys.executable))
            result = subprocess.run(['bash', '-c', command], capture_output=True, text=True,
                                    env=env, timeout=60)
            self.assertEqual(result.returncode, 0, f'{command}\n{result.stderr}')
        row, = self.items()
        self.assertEqual((row['status'], row['agent']), ('done', 'nanu-impl123-fida'))
        self.assertIn('- status：committed\n', card.read_text())

    def brief_text(self, card, *extra):
        source = self.write_brief()
        output = self.root / f'{card.stem}.brief.md'
        result = self.run_script('brief', '--card', str(card), '--input', str(source),
                                 '--output', str(output), *extra)
        self.assertEqual(result.returncode, 0, result.stderr)
        return output.read_text()

    def test_two_cards_for_one_tag_get_their_own_report_files(self):
        first, second = self.pending_card(), self.pending_card()
        reports = {re.search(r'report-[^ ]+\.md', self.brief_text(card)).group(0)
                   for card in (first, second)}
        self.assertEqual(reports, {f'report-{first.stem}.md', f'report-{second.stem}.md'})

    def test_read_only_brief_still_lets_the_agent_bind_its_card(self):
        text = self.brief_text(self.pending_card(), '--read-only')
        self.assertIn('card bind --card', text)
        self.assertIn('Apart from the bind step at the top, the orchestrator maintains the '
                      'task card; do not edit it.', text)
        self.assertIn('do not apply to the bind step at the top', text)

    def test_overlapping_binds_leave_the_card_bound_once(self):
        """A second bind started while the first is inside `hcom list` waits for it, then
        finds the card bound; the first bind's work stays."""
        card = self.pending_ledger_card()
        self.launch()
        self.listing.write_text(json.dumps(self.agents))
        spec = importlib.util.spec_from_file_location('lat_dispatch_bind', SCRIPT)
        dispatch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dispatch)
        env = {**self.ledger_env, **self.agent_env(),
               'LAT_DISPATCH_HCOM_LIST': str(self.listing)}
        inner = []
        real_list = dispatch.read_hcom_list

        def list_while_another_bind_starts():
            inner.append(subprocess.Popen(
                [sys.executable, str(SCRIPT), 'card', 'bind', '--card', str(card), '--agent',
                 'fida'], env={**env, 'HCOM_INSTANCE_NAME': 'nanu'}, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            time.sleep(1)  # the second bind is now blocked on the lock
            return real_list()

        dispatch.read_hcom_list = list_while_another_bind_starts
        args = dispatch.build_parser().parse_args(['card-bind', '--card', str(card)])
        with mock.patch.dict(os.environ, env, clear=True):
            dispatch.bind_card(args)
        _, stderr = inner[0].communicate(timeout=60)
        self.assertNotEqual(inner[0].returncode, 0)
        self.assertIn('already bound to nanu-impl123-fida', stderr)
        self.assertIn('- agent：nanu-impl123-fida\n', card.read_text())
        row, = self.items()
        self.assertEqual((row['status'], row['agent']), ('assigned', 'nanu-impl123-fida'))

    def test_pending_card_is_skipped_by_the_watch_until_bound(self):
        card = self.pending_card()
        watch = WatchCompatibilityTests.load_watch()
        cards, skipped = watch.monitored_task_cards(self.tasks, 'nanu', {})
        self.assertEqual(cards, {})
        self.assertIn(card.name, skipped)
        self.launch()
        self.assertEqual(self.bind(card).returncode, 0)
        cards, skipped = watch.monitored_task_cards(self.tasks, 'nanu', {})
        self.assertEqual(skipped, {})
        self.assertIn('nanu-impl123-fida', cards)


if __name__ == '__main__':
    unittest.main()
