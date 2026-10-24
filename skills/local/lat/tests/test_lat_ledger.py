"""CLI contract tests for lat-ledger.py: subprocess, a real temp Git repo, fake gate records."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-ledger.py'
NOW = '2026-10-24T10:00:00Z'
FP = 'f00dfeed' * 8


def git(cwd, *args):
    return subprocess.run(['git', '-C', str(cwd), *args], check=True, capture_output=True,
                          text=True).stdout.strip()


class LedgerCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.workspace = self.root / 'ws'
        self.workspace.mkdir()
        git(self.workspace, 'init', '-q', '-b', 'dev')
        git(self.workspace, 'config', 'user.email', 't@example.com')
        git(self.workspace, 'config', 'user.name', 'T')
        (self.workspace / 'a.txt').write_text('a\n')
        git(self.workspace, 'add', 'a.txt')
        git(self.workspace, 'commit', '-q', '-m', 'first')
        self.merged = git(self.workspace, 'rev-parse', 'HEAD')
        git(self.workspace, 'switch', '-q', '-c', 'side')
        (self.workspace / 'b.txt').write_text('b\n')
        git(self.workspace, 'add', 'b.txt')
        git(self.workspace, 'commit', '-q', '-m', 'side work')
        self.side = git(self.workspace, 'rev-parse', 'HEAD')
        git(self.workspace, 'switch', '-q', 'dev')
        self.gate_state = self.root / 'gate-state'
        self.gate_state.mkdir()
        (self.gate_state / 'ledger.jsonl').write_text(
            json.dumps({'fingerprint': FP, 'reusable': True}) + '\n')
        self.ledger = self.workspace / '.lat' / 'ledgers' / 'round-1.json'
        self.seal = self.ledger.with_name('round-1.json.seal')
        self.journal = self.ledger.with_name('round-1.json.journal.jsonl')
        self.tasks = self.workspace / '.lat' / 'tasks'
        self.tasks.mkdir(parents=True)
        self.now = NOW

    def run_ledger(self, *args, by='orch', env=None):
        environment = {**os.environ, 'LAT_LEDGER_NOW': self.now, 'HCOM_INSTANCE_NAME': by,
                       'SUITE_GATE_STATE_DIR': str(self.gate_state),
                       'XDG_CONFIG_HOME': str(self.root / 'config'), **(env or {})}
        environment.pop('SUITE_GATE_CONFIG', None)
        command, *rest = args
        return subprocess.run([sys.executable, str(SCRIPT), command, '--ledger', str(self.ledger),
                               *rest], capture_output=True, text=True, env=environment,
                              timeout=60)

    def ok(self, *args, **kwargs):
        result = self.run_ledger(*args, **kwargs)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def fails(self, *args, **kwargs):
        result = self.run_ledger(*args, **kwargs)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        return result.stderr

    def init(self):
        self.ok('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
                '--orchestrator', 'orch')

    def card(self, name='card.md', status='dispatched'):
        path = self.tasks / name
        path.write_text(f'接續：無\n\n- agent：impl\n- status：{status}\n'
                        '- deliverable commit：待 Orchestrator 從 Git 查證後填入\n')
        return path

    def add(self, *extra, evidence='commit', ticket='#1', stage='impl'):
        return int(self.ok('add', '--ticket', ticket, '--stage', stage, '--evidence', evidence,
                           *extra).strip())

    def started(self, *extra, evidence='commit', card=None):
        item = self.add(*extra, evidence=evidence)
        self.ok('assign', str(item), '--agent', 'impl', '--card',
                str(card or self.card(f'card-{item}.md')), '--deadline', '+2h')
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        return item

    def doc(self):
        return json.loads(self.ledger.read_text())

    def item(self, item_id):
        return next(i for i in self.doc()['items'] if i['id'] == item_id)

    def journal_lines(self):
        return self.journal.read_text().splitlines()


class StorageTests(LedgerCase):
    def test_init_writes_ledger_seal_and_journal_and_never_overwrites(self):
        self.init()
        data = self.ledger.read_bytes()
        self.assertEqual(self.seal.read_text().strip(), hashlib.sha256(data).hexdigest())
        self.assertEqual(len(self.journal_lines()), 1)
        self.assertIn('already exists', self.fails('init', '--workspace', str(self.workspace)))
        self.assertEqual(self.ledger.read_bytes(), data)

    def test_ledger_path_must_be_absolute(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'show', '--ledger', 'rel.json'],
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn('absolute', result.stderr)

    def test_each_write_appends_journal_and_reseals_failed_write_changes_nothing(self):
        self.init()
        item = self.add()
        self.assertEqual(len(self.journal_lines()), 2)
        entry = json.loads(self.journal_lines()[-1])
        self.assertEqual((entry['action'], entry['item'], entry['by']), ('add', None, 'orch'))
        self.assertEqual(entry['snapshot'], self.doc())
        self.assertEqual(self.seal.read_text().strip(),
                         hashlib.sha256(self.ledger.read_bytes()).hexdigest())
        before = self.ledger.read_bytes()
        self.fails('start', str(item), '--eta', '+1h')
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(len(self.journal_lines()), 2)

    def test_well_formed_hand_edit_is_refused_until_repair_with_reason(self):
        self.init()
        self.add()
        doc = self.doc()
        doc['items'][0]['ticket'] = '#999'
        self.ledger.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
        for command in (('show',), ('next',), ('check',), ('add', '--ticket', '#2', '--stage',
                                                           'impl', '--evidence', 'file')):
            self.assertIn('modified outside lat-ledger', self.fails(*command))
        self.assertIn('--reason', self.fails('repair'))
        self.ok('repair', '--reason', 'orchestrator fixed the ticket number by hand')
        repaired = self.doc()
        self.assertEqual(repaired['items'][0]['ticket'], '#999')
        self.assertEqual(repaired['history'][-1]['action'], 'repair-seal')
        self.assertEqual(repaired['history'][-1]['reason'],
                         'orchestrator fixed the ticket number by hand')
        self.ok('show')
        self.assertIn('nothing to repair', self.fails('repair', '--reason', 'again'))

    def test_corrupt_ledger_is_refused_and_rebuilt_from_journal(self):
        self.init()
        self.add()
        good = self.doc()
        self.ledger.write_text('{"version": 1, "items": [')
        self.assertIn('malformed', self.fails('show'))
        self.assertIn('--from-journal', self.fails('repair', '--reason', 'try'))
        out = self.ok('repair', '--from-journal', '--reason', 'disk hiccup')
        self.assertIn('| 1 | #1 |', out)
        rebuilt = self.doc()
        self.assertEqual(rebuilt['items'], good['items'])
        self.assertEqual(rebuilt['history'][-1]['action'], 'repair-from-journal')
        self.assertEqual(rebuilt['history'][-1]['reason'], 'disk hiccup')
        self.ok('show')

    def test_missing_ledger_points_to_journal_rebuild(self):
        self.init()
        self.add()
        self.ledger.unlink()
        self.assertIn('repair --from-journal', self.fails('show'))
        self.ok('repair', '--from-journal', '--reason', 'deleted by mistake')
        self.assertEqual(len(self.doc()['items']), 1)

    def test_unusable_journal_keeps_the_error_and_creates_no_empty_ledger(self):
        self.init()
        self.add()
        self.ledger.unlink()
        lines = self.journal_lines()
        self.journal.write_text('\n'.join(lines[:-1] + ['{broken']) + '\n')
        self.assertIn('journal line 2 is corrupt',
                      self.fails('repair', '--from-journal', '--reason', 'x'))
        self.assertFalse(self.ledger.exists())
        self.journal.unlink()
        self.assertIn('journal missing', self.fails('repair', '--from-journal', '--reason', 'x'))
        self.assertFalse(self.ledger.exists())
        self.assertIn('no ledger', self.fails('show'))

    def test_journal_snapshot_not_matching_its_seal_is_corrupt(self):
        self.init()
        lines = self.journal_lines()
        entry = json.loads(lines[0])
        entry['snapshot']['workspace'] = '/elsewhere'
        self.journal.write_text(json.dumps(entry) + '\n')
        self.ledger.write_text('garbage')
        self.assertIn('does not match its seal',
                      self.fails('repair', '--from-journal', '--reason', 'x'))
        self.assertEqual(self.ledger.read_text(), 'garbage')


class FieldTests(LedgerCase):
    def setUp(self):
        super().setUp()
        self.init()

    def test_add_requires_ticket_stage_and_known_evidence_kinds(self):
        self.assertEqual(self.run_ledger('add', '--stage', 'impl', '--evidence', 'commit')
                         .returncode, 2)
        self.assertEqual(self.run_ledger('add', '--ticket', '#1', '--evidence', 'commit')
                         .returncode, 2)
        self.assertEqual(self.run_ledger('add', '--ticket', '#1', '--stage', 'impl').returncode, 2)
        self.assertIn('unknown evidence kind', self.fails('add', '--ticket', '#1', '--stage',
                                                          'impl', '--evidence', 'vibes'))
        item = self.add(evidence='commit,file', ticket='#7', stage='qa')
        self.assertEqual(self.item(item)['evidence_kinds'], ['commit', 'file'])
        self.assertEqual(self.item(item)['status'], 'unassigned')

    def test_assign_needs_agent_card_and_a_deadline(self):
        item = self.add()
        card = str(self.card())
        self.assertEqual(self.run_ledger('assign', str(item), '--card', card).returncode, 2)
        self.assertEqual(self.run_ledger('assign', str(item), '--agent', 'a').returncode, 2)
        self.assertIn('--deadline is required',
                      self.fails('assign', str(item), '--agent', 'a', '--card', card))
        self.ok('assign', str(item), '--agent', 'a', '--card', card, '--deadline', '+90m')
        row = self.item(item)
        self.assertEqual((row['status'], row['agent'], row['deadline'], row['assigned_at']),
                         ('assigned', 'a', '2026-10-24T11:30:00Z', NOW))
        later = self.add('--deadline', '2026-10-24T18:00:00+08:00')
        self.ok('assign', str(later), '--agent', 'b', '--card', card)
        self.assertEqual(self.item(later)['deadline'], '2026-10-24T10:00:00Z')

    def test_start_requires_eta_and_update_eta_requires_reason(self):
        item = self.add()
        self.ok('assign', str(item), '--agent', 'a', '--card', str(self.card()),
                '--deadline', '+2h')
        self.assertEqual(self.run_ledger('start', str(item)).returncode, 2)
        self.ok('start', str(item), '--eta', '+45m', by='a')
        self.assertEqual(self.item(item)['estimate'], '2026-10-24T10:45:00Z')
        self.assertIn('--reason is required', self.fails('update', str(item), '--eta', '+2h'))
        self.ok('update', str(item), '--progress', 'tests written')
        self.ok('update', str(item), '--eta', '+2h', '--reason', 'flaky fixture', by='a')
        last = self.item(item)['history'][-1]
        self.assertEqual(last['changes'], {'estimate': ['2026-10-24T10:45:00Z',
                                                        '2026-10-24T12:00:00Z']})
        self.assertEqual((last['by'], last['reason']), ('a', 'flaky fixture'))

    def test_block_and_cancel_require_a_reason(self):
        item = self.add()
        self.assertEqual(self.run_ledger('block', str(item)).returncode, 2)
        self.assertIn('must not be empty', self.fails('block', str(item), '--reason', ' '))
        self.assertEqual(self.run_ledger('cancel', str(item)).returncode, 2)
        self.assertIn('must not be empty', self.fails('cancel', str(item), '--reason', ''))
        self.ok('block', str(item), '--reason', 'waits for TEVU-REG-11')
        self.assertEqual(self.item(item)['blocked_reason'], 'waits for TEVU-REG-11')
        self.ok('unblock', str(item))
        self.assertEqual(self.item(item)['status'], 'unassigned')

    def test_only_the_orchestrator_cancels(self):
        item = self.add()
        self.assertIn('only the orchestrator', self.fails('cancel', str(item), '--reason', 'x',
                                                          by='impl'))
        self.ok('cancel', str(item), '--reason', 'superseded')

    def test_cancel_blocks_dependents_until_dependencies_change(self):
        first = self.add()
        second = self.add('--depends', str(first))
        replacement = self.add('--follows', str(first))
        self.ok('cancel', str(first), '--reason', 'split into two tickets')
        row = self.item(second)
        self.assertEqual((row['status'], row['blocked_reason']), ('blocked', '依賴已取消'))
        self.assertIn('cancelled item(s) 1', self.fails('unblock', str(second)))
        self.ok('update', str(second), '--depends', str(replacement), '--reason', 'new split')
        row = self.item(second)
        self.assertEqual((row['status'], row['depends_on'], row['blocked_reason']),
                         ('unassigned', [replacement], None))

    def test_reassign_keeps_the_row_and_history(self):
        item = self.started()
        self.ok('reassign', str(item), '--agent', 'impl2', '--reason', 'impl vanished')
        row = self.item(item)
        self.assertEqual((row['agent'], row['status'], row['estimate']),
                         ('impl2', 'assigned', None))
        self.assertEqual([h['action'] for h in row['history']],
                         ['add', 'assign', 'start', 'reassign'])

    def test_history_records_time_actor_change_and_reason(self):
        item = self.add()
        self.ok('block', str(item), '--reason', 'waiting on #2')
        entry = self.item(item)['history'][-1]
        self.assertEqual(entry, {'at': NOW, 'by': 'orch', 'action': 'block',
                                 'changes': {'status': ['unassigned', 'blocked'],
                                             'blocked_from': [None, 'unassigned'],
                                             'blocked_reason': [None, 'waiting on #2']},
                                 'reason': 'waiting on #2'})


class DoneTests(LedgerCase):
    def setUp(self):
        super().setUp()
        self.init()

    def test_commit_reachable_from_integration_branch_closes_and_updates_card(self):
        card = self.card()
        item = self.started(card=card)
        self.ok('done', str(item), '--commit', self.merged[:10], by='impl')
        row = self.item(item)
        self.assertEqual(row['status'], 'done')
        self.assertEqual(row['evidence'], {'commit': [self.merged]})
        self.assertEqual(row['history'][-1]['by'], 'impl')
        text = card.read_text()
        self.assertIn('- status：committed\n', text)
        self.assertIn(f'- deliverable commit：{self.merged}\n', text)

    def test_commit_on_the_item_branch_counts(self):
        item = self.started('--branch', 'side')
        self.ok('done', str(item), '--commit', self.side)

    def test_each_failed_evidence_is_listed_and_status_unchanged(self):
        item = self.started(evidence='commit,gate,file')
        before = self.ledger.read_bytes()
        empty = self.root / 'empty.md'
        empty.write_text('')
        error = self.fails('done', str(item), '--commit', 'deadbeef', '--gate', 'nope',
                           '--file', str(empty))
        self.assertIn('commit deadbeef: not found', error)
        self.assertIn('gate record nope: no suite-gate record', error)
        self.assertIn(f'file {empty}: is empty', error)
        self.assertEqual(self.ledger.read_bytes(), before)
        error = self.fails('done', str(item), '--commit', self.side, '--gate', FP,
                           '--file', str(self.root / 'gone.md'))
        self.assertIn('is not reachable from dev', error)
        self.assertIn('does not exist', error)
        self.assertNotIn('gate record', error)
        self.assertEqual(self.item(item)['status'], 'in_progress')

    def test_missing_or_undeclared_evidence_kinds_are_refused(self):
        item = self.started(evidence='commit,file')
        self.assertIn('file evidence is required', self.fails('done', str(item), '--commit',
                                                              self.merged))
        self.assertIn('gate evidence was not declared',
                      self.fails('done', str(item), '--gate', FP, '--commit', self.merged))

    def test_gate_fingerprint_and_file_evidence_close(self):
        report = self.root / 'report.md'
        report.write_text('all good\n')
        card = self.card()
        item = self.started(evidence='gate,file', card=card)
        self.assertIn('absolute path', self.fails('done', str(item), '--gate', FP,
                                                  '--file', 'report.md'))
        self.ok('done', str(item), '--gate', FP[:12], '--file', str(report))
        self.assertEqual(self.item(item)['evidence'], {'gate': [FP], 'file': [str(report)]})
        self.assertIn('- status：completed\n', card.read_text())

    def test_blocked_item_cannot_close(self):
        item = self.started()
        self.ok('block', str(item), '--reason', 'x')
        self.assertIn('needs assigned or in_progress',
                      self.fails('done', str(item), '--commit', self.merged))


class NextAndCheckTests(LedgerCase):
    def setUp(self):
        super().setUp()
        self.init()

    def test_next_lists_unassigned_items_whose_dependencies_are_all_done(self):
        first = self.started()
        second = self.add('--depends', str(first), ticket='#2')
        third = self.add(ticket='#3')
        listed = [i['id'] for i in json.loads(self.ok('next', '--json'))]
        self.assertEqual(listed, [third])
        self.ok('done', str(first), '--commit', self.merged)
        self.assertEqual([i['id'] for i in json.loads(self.ok('next', '--json'))],
                         [second, third])
        self.assertIn(f'{second}\t#2\timpl', self.ok('next'))

    def test_cancelled_dependency_is_not_done(self):
        first = self.add()
        second = self.add('--depends', str(first))
        self.ok('cancel', str(first), '--reason', 'dropped')
        self.ok('update', str(second), '--depends', '', '--reason', 'no longer needed')
        third = self.add('--depends', str(first))
        listed = [i['id'] for i in json.loads(self.ok('next', '--json'))]
        self.assertEqual(listed, [second])
        self.assertEqual(self.item(third)['status'], 'blocked')

    def test_check_fails_on_open_items_and_lists_cancelled_without_blocking(self):
        first = self.started()
        second = self.add()
        self.ok('cancel', str(second), '--reason', 'out of scope')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'item {first} (#1 impl): not closed: in_progress', result.stdout)
        self.assertIn(f'cancelled item {second} (#1 impl): out of scope', result.stdout)
        self.ok('done', str(first), '--commit', self.merged)
        out = self.ok('check')
        self.assertIn('ledger check: OK', out)
        self.assertIn('out of scope', out)

    def test_check_fails_when_a_report_moves_after_closing(self):
        report = self.root / 'qa-report.md'
        report.write_text('PASS\n')
        item = self.started(evidence='file')
        self.ok('done', str(item), '--file', str(report))
        self.ok('check')
        report.rename(self.root / 'elsewhere.md')
        result = self.run_ledger('check', '--json')
        self.assertEqual(result.returncode, 1)
        failure = json.loads(result.stdout)['failures'][0]
        self.assertEqual(failure['id'], item)
        self.assertIn(str(report), failure['problems'][0])

    def test_check_fails_when_the_lookup_itself_errors(self):
        item = self.started(evidence='gate')
        self.ok('done', str(item), '--gate', FP)
        broken = self.root / 'broken-gate.py'
        broken.write_text('import sys\nsys.exit(3)\n')
        result = self.run_ledger('check', env={'LAT_LEDGER_SUITE_GATE': str(broken)})
        self.assertEqual(result.returncode, 1)
        self.assertIn('lookup failed', result.stdout)

    def test_check_fails_when_a_closed_commit_disappears(self):
        item = self.started('--branch', 'side')
        self.ok('done', str(item), '--commit', self.side)
        git(self.workspace, 'branch', '-q', '-D', 'side')
        git(self.workspace, 'reflog', 'expire', '--expire=now', '--all')
        git(self.workspace, 'gc', '-q', '--prune=now')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'commit {self.side}: not found', result.stdout)


class ShowTests(LedgerCase):
    def setUp(self):
        super().setUp()
        self.init()

    def test_show_marks_late_items_and_card_mismatch(self):
        late = self.started()
        closed_card = self.card('closed.md', status='committed')
        wrong = self.started(card=closed_card)
        blocked = self.started()
        self.ok('block', str(blocked), '--reason', 'waits for #9')
        self.now = '2026-10-24T12:30:00Z'
        out = self.ok('show')
        rows = {line.split(' | ')[0].strip('| '): line for line in out.splitlines()
                if line.startswith('| ') and not line.startswith('| #')}
        self.assertIn('超過預計 1h30m；超過期限 30m', rows[str(late)])
        self.assertIn('任務卡不一致：card says committed, ledger says in_progress', rows[str(wrong)])
        self.assertIn('超過期限 30m', rows[str(blocked)])
        self.assertNotIn('超過預計', rows[str(blocked)])
        self.assertIn('受阻：waits for #9', rows[str(blocked)])

    def test_show_json_gives_board_fields(self):
        item = self.started()
        self.now = '2026-10-24T11:10:00Z'
        view = json.loads(self.ok('show', '--json'))
        self.assertEqual((view['ledger'], view['now'], view['workspace']),
                         (str(self.ledger), '2026-10-24T11:10:00Z', str(self.workspace)))
        row = view['items'][0]
        self.assertEqual(row['id'], item)
        self.assertEqual(row['late_minutes'], {'estimate': 10})
        self.assertEqual((row['status_label'], row['stage_label']), ('進行中', '實作'))
        self.assertIsNone(row['card_mismatch'])
        for field in ('ticket', 'agent', 'card', 'depends_on', 'follows', 'started_at',
                      'estimate', 'deadline', 'evidence_kinds', 'evidence', 'history'):
            self.assertIn(field, row)

    def test_done_item_after_card_moves_is_consistent_once_path_updated(self):
        card = self.card()
        item = self.started(card=card)
        self.ok('done', str(item), '--commit', self.merged)
        (self.tasks / 'done').mkdir()
        moved = card.rename(self.tasks / 'done' / card.name)
        self.assertIn('task card unreadable',
                      json.loads(self.ok('show', '--json'))['items'][0]['card_mismatch'])
        self.ok('update', str(item), '--card', str(moved))
        self.assertIsNone(json.loads(self.ok('show', '--json'))['items'][0]['card_mismatch'])


if __name__ == '__main__':
    unittest.main()
