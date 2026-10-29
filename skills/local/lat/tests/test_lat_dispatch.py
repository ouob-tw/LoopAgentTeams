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
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-dispatch.py'
WATCH = SCRIPT.parent / 'lat-watch.py'
LIVE = '重建 staging 最多 2 次；最長 45 分鐘；出現 429 即停'
PREFLIGHT = '測試帳號 qa-01 已登入（主控已核對）；重建失敗時切回上一個映像'
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


class DispatchCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.workspace = self.root / 'ws'
        self.tasks = self.workspace / '.lat' / 'tasks'
        self.tasks.mkdir(parents=True)
        self.agents = [{'name': 'nanu-impl123-fida', 'base_name': 'fida', 'tag': 'nanu-impl123'}]

    def run_script(self, *args, agents='default', env=None):
        listing = self.root / 'hcom-list.json'
        listing.write_text(json.dumps(self.agents if agents == 'default' else agents))
        env = {**os.environ, 'LAT_DISPATCH_HCOM_LIST': str(listing), **(env or {})}
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True,
                              text=True, env=env, timeout=60)

    def card_args(self, *extra, tag='nanu-impl123', live=LIVE, preflight=PREFLIGHT):
        args = ['card', '--tag', tag, '--tasks', str(self.tasks), '--orchestrator', 'nanu',
                '--date', '2026-10-23', '--runs', str(self.workspace / '.lat/runs/issue-123')]
        if live is not None:
            args += ['--live-actions', live]
        if preflight is not None:
            args += ['--preflight', preflight]
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
            'owned resources', 'live actions', 'preflight', '預計檢查數', '整套測試', 'runs',
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
                {'name': 'nanu-impl123-gape', 'tag': 'nanu-impl123'}]
        result = self.run_script(*self.card_args('--agent', 'nanu-impl123-gape'), agents=pair)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('- agent：nanu-impl123-gape\n',
                      (self.tasks / '2026-10-23-nanu-impl123.md').read_text())
        for other in ('nanu-impl123-zzzz', 'nanu-impl123'):
            with self.subTest(agent=other):
                result = self.run_script(*self.card_args('--agent', other), agents=pair)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('is not among the agents', result.stderr)

    def test_unreadable_hcom_list_fails_without_creating_a_card(self):
        listing = self.root / 'missing.json'
        env = {**os.environ, 'LAT_DISPATCH_HCOM_LIST': str(listing)}
        result = subprocess.run([sys.executable, str(SCRIPT), *self.card_args()],
                                capture_output=True, text=True, env=env, timeout=60)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unreadable', result.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])

    def test_missing_live_actions_or_preflight_is_refused(self):
        for kwargs in ({'live': None}, {'preflight': None}, {'live': '  '}, {'preflight': ''}):
            with self.subTest(kwargs=kwargs):
                result = self.run_script(*self.card_args(**kwargs))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(list(self.tasks.iterdir()), [])

    def test_explicit_none_is_accepted_for_both_fields(self):
        card = self.make_card(live='無', preflight='無')
        self.assertIn('- live actions：無\n', card.read_text())

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

    def test_longer_fence_may_contain_a_shorter_fence_with_a_heading(self):
        text = BRIEF.replace('- 清單項目', '````\n```\n## 目標與完成條件\n```\n````')
        source, _, result = self.brief(text)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('## 目標與完成條件\n```\n````', (self.root / 'brief.brief.md').read_text())

    def test_printed_send_command_uses_file(self):
        _, _, result = self.brief()
        output = self.root / 'brief.brief.md'
        self.assertIn(
            f'hcom send @nanu-impl123-fida --intent request --name nanu --file {output}',
            result.stdout)
        self.assertNotIn('<<', result.stdout)

    def test_send_names_are_the_base_names_hcom_records_for_tagged_agents(self):
        self.agents.append({'name': 'lat-fix-nanu', 'base_name': 'nanu', 'tag': 'lat-fix'})
        card = self.make_card(live=LIVE)
        text = card.read_text().replace('- orchestrator：nanu\n', '- orchestrator：lat-fix-nanu\n')
        card.write_text(text)
        _, _, result = self.brief(card=card)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = self.root / 'brief.brief.md'
        self.assertIn(f'hcom send @nanu-impl123-fida --intent request --name nanu --file {output}',
                      result.stdout)
        self.assertIn('`hcom send @lat-fix-nanu --name fida`', output.read_text())

    def test_untagged_agent_keeps_its_name(self):
        self.agents = [{'name': 'fida', 'base_name': 'fida', 'tag': 'nanu-impl123'}]
        _, _, result = self.brief()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--intent request --name nanu --file', result.stdout)
        self.assertIn('`hcom send @nanu --name fida`', (self.root / 'brief.brief.md').read_text())

    def test_live_actions_and_preflight_are_copied_verbatim_with_quota_rules(self):
        _, _, result = self.brief()
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn(f'- live actions：{LIVE}', text)
        self.assertIn(f'- preflight：{PREFLIGHT}', text)
        for rule in ('Before acting, check every `preflight` item',
                     'inside the `live actions` quota yourself', 'stop and report',
                     'never replaces them'):
            self.assertIn(rule, text)

    def test_no_live_actions_card_still_carries_both_fields_and_rules(self):
        card = self.make_card(live='無', preflight='無')
        self.brief(BRIEF, card=card)
        text = (self.root / 'brief.brief.md').read_text()
        self.assertIn('- live actions：無\n- preflight：無\n', text)
        self.assertIn('Before acting, check every `preflight` item', text)

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
        for field in ('live actions', 'preflight'):
            with self.subTest(field=field):
                text = card.read_text()
                broken = self.root / f'broken-{field.replace(" ", "")}.md'
                broken.write_text('\n'.join(
                    line for line in text.splitlines() if not line.startswith(f'- {field}：')))
                result = self.run_script('brief', '--card', str(broken), '--input', str(source))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(field, result.stderr)
                empty = self.root / f'empty-{field.replace(" ", "")}.md'
                empty.write_text(text.replace(
                    f'- {field}：{LIVE if field == "live actions" else PREFLIGHT}',
                    f'- {field}：'))
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
                        f'- live actions：{LIVE}\n- preflight：{PREFLIGHT}\n'
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
                           'XDG_CONFIG_HOME': str(self.root / 'config')}
        self.ledger_env.pop('SUITE_GATE_CONFIG', None)
        self.run_ledger('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
                        '--orchestrator', 'nanu')

    def run_ledger(self, *args):
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
            '--evidence', evidence, '--deadline', '+2h', *extra)

    def card_with(self, *extra):
        result = self.run_script(*self.card_args(*extra))
        self.assertEqual(result.returncode, 0, result.stderr)
        return Path(result.stdout.splitlines()[0])

    def brief_commands(self, card):
        """The three ledger commands of a generated brief, with placeholders filled in."""
        source = self.write_brief()
        result = self.run_script('brief', '--card', str(card), '--input', str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        text = (self.root / 'brief.brief.md').read_text()
        commands = re.findall(r'`(uv run [^`]*lat-ledger\.py[^`]*)`', text)
        self.assertEqual(len(commands), 3, text)
        return text, commands


class LedgerCardTests(LedgerCase):
    def test_card_with_options_opens_assigns_and_records_the_row(self):
        card = self.ledger_card('--depends', '')
        row, = self.items()
        self.assertEqual((row['id'], row['ticket'], row['stage'], row['status']),
                         (1, '#123', 'impl', 'assigned'))
        self.assertEqual((row['agent'], row['card']), ('nanu-impl123-fida', str(card)))
        self.assertEqual(row['evidence_kinds'], ['commit'])
        self.assertIsNotNone(row['deadline'])
        text = card.read_text()
        self.assertIn(f'- ledger row：1 ({self.ledger})\n', text)
        self.assertIn('- status：dispatched\n', text)

    def test_second_card_gets_the_next_row_and_can_depend_on_the_first(self):
        self.ledger_card()
        self.agents.append({'name': 'nanu-qa123-kora', 'tag': 'nanu-qa123'})
        second = self.card_with('--ledger', str(self.ledger), '--ticket', '#123', '--stage', 'qa',
                                '--evidence', 'file', '--deadline', '+3h', '--depends', '1')
        self.assertIn('- ledger row：2 (', second.read_text())
        self.assertEqual(self.items()[1]['depends_on'], [1])

    def test_repo_option_is_passed_to_the_ledger_row(self):
        repo = self.root / 'other'
        repo.mkdir()
        subprocess.run(['git', '-C', str(repo), 'init', '-q'], check=True)
        self.ledger_card('--repo', str(repo))
        self.assertEqual(self.items()[0]['repo'], str(repo))

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
        for name in ('--stage', '--evidence', '--deadline'):
            self.assertIn(name, partial.stderr)
        relative = self.run_script(*self.card_args(
            '--ledger', 'ledger.json', '--ticket', '#1', '--stage', 'impl', '--evidence', 'commit',
            '--deadline', '+1h'))
        self.assertIn('absolute', relative.stderr)
        missing = self.run_script(*self.card_args(
            '--ledger', str(self.root / 'none.json'), '--ticket', '#1', '--stage', 'impl',
            '--evidence', 'commit', '--deadline', '+1h'))
        self.assertIn('does not exist', missing.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])

    def test_ledger_refusal_leaves_no_card(self):
        result = self.run_script(*self.card_args(
            '--ledger', str(self.ledger), '--ticket', '#1', '--stage', 'impl',
            '--evidence', 'commit', '--deadline', '+1h', '--depends', '9'))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unknown item', result.stderr)
        self.assertEqual(list(self.tasks.iterdir()), [])
        self.assertEqual(self.items(), [])

    def test_untagged_agent_is_refused_before_the_ledger_is_touched(self):
        result = self.run_script(*self.card_args(
            '--ledger', str(self.ledger), '--ticket', '#1', '--stage', 'impl',
            '--evidence', 'commit', '--deadline', '+1h'), agents=[])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.items(), [])

    def test_ledger_card_is_still_monitored_by_the_watch(self):
        self.ledger_card()
        watch = WatchCompatibilityTests.load_watch()
        cards, skipped = watch.monitored_task_cards(self.tasks, 'nanu', {})
        self.assertEqual(skipped, {})
        self.assertIn('nanu-impl123-fida', cards)


class LedgerBriefTests(LedgerCase):
    def test_fixed_section_names_the_row_and_the_three_commands_with_absolute_paths(self):
        text, commands = self.brief_commands(self.ledger_card())
        self.assertIn(f'Your ledger row is 1 in {self.ledger}', text)
        for command, verb in zip(commands, ('start', 'update', 'done')):
            self.assertIn(f'lat-ledger.py {verb} 1 --ledger {self.ledger} --by nanu-impl123-fida',
                          command)
            self.assertIn(str(LEDGER), command)

    def test_ledger_path_with_spaces_is_quoted(self):
        spaced = self.workspace / '.lat' / 'my ledgers' / 'round.json'
        spaced.parent.mkdir()
        self.ledger = spaced
        self.run_ledger('init', '--workspace', str(self.workspace))
        _, commands = self.brief_commands(self.ledger_card())
        self.assertIn(f"--ledger '{spaced}'", commands[0])

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
        result = subprocess.run(shlex.split(command), capture_output=True, text=True,
                                env=self.ledger_env, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_agent_runs_the_brief_commands_and_done_updates_the_card(self):
        card = self.ledger_card()
        _, (start, update, done) = self.brief_commands(card)
        self.run_command(start)
        self.run_command(update, **{'one sentence': 'half way'})
        self.assertEqual(self.items()[0]['progress'], 'half way')
        done = done.replace('--gate <fingerprint> --file <absolute path>', '')
        self.run_command(done.replace('<sha>', self.sha))
        text = card.read_text()
        self.assertIn('- status：committed\n', text)
        self.assertIn(f'- deliverable commit：{self.sha}\n', text)
        self.assertEqual(self.items()[0]['status'], 'done')

    def test_card_branch_lets_done_accept_a_commit_that_is_not_integrated_yet(self):
        git(self.workspace, 'switch', '-q', '-c', 'feat/x')
        (self.workspace / 'b.txt').write_text('b\n')
        git(self.workspace, 'add', 'b.txt')
        git(self.workspace, 'commit', '-q', '-m', 'work')
        sha = git(self.workspace, 'rev-parse', 'HEAD')
        git(self.workspace, 'switch', '-q', 'dev')
        card = self.ledger_card('--branch', 'feat/x')
        self.assertEqual(self.items()[0]['branch'], 'feat/x')
        _, (start, _update, done) = self.brief_commands(card)
        self.run_command(start)
        self.run_command(done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                                      f'--commit {sha}'))
        self.assertIn(f'- deliverable commit：{sha}\n', card.read_text())

    def test_file_evidence_closes_the_card_as_completed(self):
        card = self.ledger_card(evidence='file')
        report = self.root / 'report.md'
        report.write_text('checked\n')
        _, (start, _update, done) = self.brief_commands(card)
        self.run_command(start)
        done = done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                            f'--file {report}')
        self.run_command(done)
        self.assertIn('- status：completed\n', card.read_text())

    def test_missing_card_does_not_stop_done(self):
        card = self.ledger_card()
        _, (start, _update, done) = self.brief_commands(card)
        self.run_command(start)
        card.unlink()
        self.run_command(done.replace('--commit <sha> --gate <fingerprint> --file <absolute path>',
                                      f'--commit {self.sha}'))
        self.assertEqual(self.items()[0]['status'], 'done')

    def test_moving_the_card_to_done_then_updating_the_row_clears_the_mismatch(self):
        card = self.ledger_card()
        _, (start, _update, done) = self.brief_commands(card)
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


if __name__ == '__main__':
    unittest.main()
