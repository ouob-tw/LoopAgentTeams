"""CLI contract tests for lat-ledger.py: subprocess, a real temp Git repo, fake gate records."""
import hashlib
import json
import os
from pathlib import Path
import shutil
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
        self.hcom_list = self.root / 'hcom-list.json'
        self.set_hcom('orch', 'impl', 'impl2', 'a', 'b', 'new')

    def set_hcom(self, *names):
        """Untagged names are their own full names; `<tag>-<base>` ones carry a tag."""
        self.hcom_list.write_text(json.dumps([
            {'name': name, 'base_name': name.rsplit('-', 1)[-1]} for name in names]))

    def run_ledger(self, *args, by='orch', env=None):
        environment = {**os.environ, 'LAT_LEDGER_NOW': self.now, 'HCOM_INSTANCE_NAME': by,
                       'LAT_LEDGER_HCOM_LIST': str(self.hcom_list),
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

    def test_unjournaled_write_is_refused_until_repair(self):
        self.init()
        item = self.started(evidence='file')
        report = self.root / 'r.md'
        report.write_text('ok\n')
        lines = self.journal_lines()
        self.ok('done', str(item), '--file', str(report))
        self.journal.write_text('\n'.join(lines) + '\n')  # the done entry never reached it
        self.assertIn('journal does not end with this ledger state', self.fails('show'))
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.ok('repair', '--reason', 'journal append failed after the done write')
        self.assertEqual(self.item(item)['status'], 'done')
        self.ok('check')
        self.assertIn('nothing to repair', self.fails('repair', '--reason', 'again'))

    def test_partial_journal_append_is_repaired_and_history_kept(self):
        self.init()
        item = self.started(evidence='file')
        report = self.root / 'r.md'
        report.write_text('ok\n')
        lines = self.journal_lines()
        self.ok('done', str(item), '--file', str(report))
        self.journal.write_text('\n'.join(lines) + '\n{"at":')  # append cut off mid-line
        self.assertEqual(self.run_ledger('check').returncode, 1)
        self.ok('repair', '--reason', 'partial journal append')
        self.ok('check')
        self.assertEqual(len(self.journal_lines()), len(lines) + 2)
        self.ledger.write_text('broken')
        result = self.run_ledger('repair', '--from-journal', '--reason', 'disk')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'skipped unreadable journal line {len(lines) + 1}', result.stderr)
        self.assertEqual(self.item(item)['status'], 'done')

    def test_append_cut_inside_a_multibyte_character_is_repaired(self):
        self.init()
        item = self.add()
        before = self.journal.read_bytes()
        self.ok('block', str(item), '--reason', '等待決定')
        self.journal.write_bytes(before + '{"reason":"等'.encode()[:-2])
        self.assertEqual(self.run_ledger('check').returncode, 1)
        self.ok('repair', '--reason', 'append cut mid-character')
        self.ledger.write_text('broken')
        result = self.run_ledger('repair', '--from-journal', '--reason', 'disk')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('skipped unreadable journal line 3', result.stderr)
        self.assertEqual(self.item(item)['blocked_reason'], '等待決定')

    def test_concurrent_writers_all_land(self):
        self.init()
        environment = {**os.environ, 'LAT_LEDGER_NOW': NOW, 'HCOM_INSTANCE_NAME': 'orch',
                       'LAT_LEDGER_HCOM_LIST': str(self.hcom_list)}
        writers = [subprocess.Popen([sys.executable, str(SCRIPT), 'add', '--ledger',
                                     str(self.ledger), '--ticket', f'#{n}', '--stage', 'impl',
                                     '--evidence', 'file'], env=environment,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                   for n in range(8)]
        ids = []
        for writer in writers:
            out, err = writer.communicate(timeout=60)
            self.assertEqual(writer.returncode, 0, err)
            ids.append(int(out))
        self.assertEqual(sorted(ids), list(range(1, 9)))
        self.assertEqual(sorted(i['ticket'] for i in self.doc()['items']),
                         sorted(f'#{n}' for n in range(8)))
        self.assertEqual(len(self.journal_lines()), 9)
        self.ok('show')

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

    def test_dependency_changes_and_cancel_keep_cancelled_dependencies_blocking(self):
        first = self.add()
        running = self.started()
        self.ok('cancel', str(first), '--reason', 'dropped')
        self.ok('update', str(running), '--depends', str(first), '--reason', 'needs it')
        row = self.item(running)
        self.assertEqual((row['status'], row['blocked_from'], row['blocked_reason']),
                         ('blocked', 'in_progress', '依賴已取消'))
        self.assertIn('needs assigned or in_progress',
                      self.fails('done', str(running), '--commit', self.merged))
        other = self.add()
        waiting = self.add('--depends', str(other))
        self.ok('block', str(waiting), '--reason', 'waits for TEVU-REG-11')
        self.ok('cancel', str(other), '--reason', 'merged into another ticket')
        self.assertEqual(self.item(waiting)['blocked_reason'], '依賴已取消；waits for TEVU-REG-11')
        self.ok('update', str(waiting), '--depends', '', '--reason', 'dependency dropped')
        row = self.item(waiting)
        self.assertEqual((row['status'], row['blocked_reason']),
                         ('blocked', 'waits for TEVU-REG-11'))

    def test_reassign_needs_a_prior_assignment(self):
        item = self.add()
        self.ok('block', str(item), '--reason', 'x')
        self.assertIn('never assigned', self.fails('reassign', str(item), '--agent', 'new',
                                                   '--reason', 'replacement'))

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

    def test_commit_merged_then_task_branch_deleted_still_passes(self):
        item = self.started('--branch', 'side')
        git(self.workspace, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
        git(self.workspace, 'branch', '-q', '-D', 'side')
        self.ok('done', str(item), '--commit', self.side, by='impl')

    def test_commit_outside_integration_branch_fails_once_task_branch_is_gone(self):
        item = self.started('--branch', 'side')
        git(self.workspace, 'branch', '-q', '-D', 'side')
        error = self.fails('done', str(item), '--commit', self.side, by='impl')
        self.assertIn('is not reachable from side or dev', error)
        self.assertEqual(self.item(item)['status'], 'in_progress')

    def test_update_branch_sets_it_on_a_row_created_without_one(self):
        item = self.started()
        self.fails('done', str(item), '--commit', self.side, by='impl')
        self.ok('update', str(item), '--branch', 'side')
        self.assertEqual(self.item(item)['branch'], 'side')
        self.assertEqual(self.item(item)['history'][-1]['changes'], {'branch': [None, 'side']})
        self.ok('done', str(item), '--commit', self.side, by='impl')

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
        error = self.fails('done', str(item), '--commit', 'deadbeef')
        self.assertIn('file evidence is required', error)
        self.assertIn('commit deadbeef: not found', error)

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


class RepoTests(LedgerCase):
    def setUp(self):
        super().setUp()
        self.init()
        self.other = self.root / 'other'
        self.other.mkdir()
        git(self.other, 'init', '-q', '-b', 'main')
        git(self.other, 'config', 'user.email', 't@example.com')
        git(self.other, 'config', 'user.name', 'T')
        (self.other / 'o.txt').write_text('o\n')
        git(self.other, 'add', 'o.txt')
        git(self.other, 'commit', '-q', '-m', 'other work')
        self.foreign = git(self.other, 'rev-parse', 'HEAD')

    def test_add_repo_then_done_verifies_in_that_repo_and_shows_it(self):
        item = self.started('--repo', str(self.other))
        self.assertEqual(self.item(item)['repo'], str(self.other))
        self.fails('done', str(item), '--commit', self.merged, by='impl')
        self.ok('done', str(item), '--commit', self.foreign[:10], by='impl')
        self.assertEqual(self.item(item)['evidence'], {'commit': [self.foreign]})
        self.assertIn(f'repo：{self.other}', self.ok('show'))
        self.assertEqual(json.loads(self.ok('show', '--json'))['items'][0]['repo'],
                         str(self.other))
        checked = self.ok('check')
        self.assertIn('ledger check: OK', checked)
        self.assertIn(f'item {item} repo: {self.other}', checked)
        self.assertEqual(json.loads(self.ok('check', '--json'))['repos'],
                         [{'id': item, 'repo': str(self.other)}])

    def test_done_repo_sets_the_row_repo_and_records_the_change(self):
        item = self.started()
        self.fails('done', str(item), '--commit', self.foreign, by='impl')
        self.ok('done', str(item), '--commit', self.foreign, '--repo', str(self.other), by='impl')
        row = self.item(item)
        self.assertEqual(row['repo'], str(self.other))
        self.assertEqual(row['history'][-1]['changes']['repo'], [None, str(self.other)])

    def test_repo_must_be_an_absolute_git_repository(self):
        plain = self.root / 'plain'
        plain.mkdir()
        error = self.fails('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'commit',
                           '--repo', str(plain))
        self.assertIn('not a git repository', error)
        self.assertIn('absolute', self.fails('add', '--ticket', '#1', '--stage', 'impl',
                                             '--evidence', 'commit', '--repo', 'other'))
        item = self.started()
        error = self.fails('done', str(item), '--commit', self.merged, '--repo', str(plain),
                           by='impl')
        self.assertIn('not a git repository', error)
        self.assertEqual(self.item(item)['status'], 'in_progress')

    def test_commit_missing_from_the_repo_is_refused_with_the_repo_named(self):
        item = self.started('--repo', str(self.other))
        error = self.fails('done', str(item), '--commit', self.side, by='impl')
        self.assertIn(f'not found in {self.other}', error)

    def test_branches_that_exist_in_the_repo_still_apply(self):
        git(self.other, 'switch', '-q', '-c', 'work')
        (self.other / 'w.txt').write_text('w\n')
        git(self.other, 'add', 'w.txt')
        git(self.other, 'commit', '-q', '-m', 'on work')
        work = git(self.other, 'rev-parse', 'HEAD')
        git(self.other, 'switch', '-q', 'main')
        item = self.started('--repo', str(self.other), '--branch', 'main')
        error = self.fails('done', str(item), '--commit', work, by='impl')
        self.assertIn('is not reachable from main', error)

    def test_check_fails_when_the_repo_disappears(self):
        item = self.started('--repo', str(self.other))
        self.ok('done', str(item), '--commit', self.foreign, by='impl')
        shutil.rmtree(self.other)
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'repo {self.other}', result.stdout)


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

    def test_check_passes_after_the_task_branch_is_merged_then_deleted(self):
        item = self.started('--branch', 'side')
        self.ok('done', str(item), '--commit', self.side)
        git(self.workspace, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
        git(self.workspace, 'branch', '-q', '-D', 'side')
        self.ok('check')

    def test_check_fails_for_a_surviving_commit_outside_the_integration_branch(self):
        item = self.started('--branch', 'side')
        self.ok('done', str(item), '--commit', self.side)
        git(self.workspace, 'branch', '-q', '-D', 'side')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('is not reachable from side or dev', result.stdout)

    def test_check_fails_when_a_closed_commit_disappears(self):
        item = self.started('--branch', 'side')
        self.ok('done', str(item), '--commit', self.side)
        git(self.workspace, 'branch', '-q', '-D', 'side')
        git(self.workspace, 'reflog', 'expire', '--expire=now', '--all')
        git(self.workspace, 'gc', '-q', '--prune=now')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'commit {self.side}: not found', result.stdout)


class DeletedBranchWithoutIntegrationTests(LedgerCase):
    """ouob-tw/LoopAgentTeams-work#402: no integration branch recorded, task branch deleted."""

    def setUp(self):
        super().setUp()
        self.ok('init', '--workspace', str(self.workspace), '--orchestrator', 'orch')

    def closed_on_side(self):
        item = self.started('--branch', 'side')
        self.ok('done', str(item), '--commit', self.side)
        return item

    def merge_side_into_main(self):
        git(self.workspace, 'branch', '-q', '-m', 'dev', 'main')
        git(self.workspace, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')

    def test_check_passes_when_the_commit_reached_the_default_branch(self):
        self.closed_on_side()
        self.merge_side_into_main()
        git(self.workspace, 'branch', '-q', '-D', 'side')
        self.ok('check')

    def test_done_accepts_a_commit_merged_before_the_branch_was_deleted(self):
        item = self.started('--branch', 'side')
        self.merge_side_into_main()
        git(self.workspace, 'branch', '-q', '-D', 'side')
        self.ok('done', str(item), '--commit', self.side, by='impl')

    def test_check_fails_when_the_commit_is_not_on_the_default_branch(self):
        item = self.closed_on_side()
        git(self.workspace, 'branch', '-q', '-m', 'dev', 'main')
        git(self.workspace, 'branch', '-q', '-D', 'side')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('is not reachable from main', result.stdout)
        self.assertIn('task branch side no longer exists', result.stdout)
        self.assertIn(f'update {item} --branch <branch>', result.stdout)

    def test_check_gives_guidance_when_no_default_branch_exists(self):
        item = self.closed_on_side()
        git(self.workspace, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
        git(self.workspace, 'branch', '-q', '-D', 'side')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('task branch side no longer exists', result.stdout)
        self.assertIn(f'update {item} --branch <branch>', result.stdout)
        self.ok('update', str(item), '--branch', 'dev')
        self.ok('check')

    def test_origin_head_names_the_default_branch(self):
        self.closed_on_side()
        self.merge_side_into_main()
        git(self.workspace, 'branch', '-q', '-D', 'side')
        git(self.workspace, 'update-ref', 'refs/remotes/origin/trunk', self.merged)
        git(self.workspace, 'symbolic-ref', 'refs/remotes/origin/HEAD',
            'refs/remotes/origin/trunk')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('is not reachable from origin/trunk', result.stdout)
        git(self.workspace, 'update-ref', 'refs/remotes/origin/trunk', self.side)
        self.ok('check')

    def test_a_surviving_task_branch_is_still_the_only_branch_checked(self):
        item = self.started('--branch', 'other')
        self.merge_side_into_main()
        git(self.workspace, 'branch', '-q', 'other', self.merged)
        error = self.fails('done', str(item), '--commit', self.side, by='impl')
        self.assertIn('is not reachable from other', error)


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


class NameTests(LedgerCase):
    """Names are written as HCOM full names (#394); older base names still match."""

    def test_base_names_are_written_as_full_names(self):
        self.set_hcom('lead-orch', 'team-impl', 'team-impl2')
        self.init()
        item = self.add()
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(self.card()),
                '--deadline', '+2h')
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        self.ok('reassign', str(item), '--agent', 'impl2', '--reason', 'impl vanished',
                '--by', 'orch')
        doc = self.doc()
        self.assertEqual(doc['orchestrator'], 'lead-orch')
        self.assertEqual(doc['history'][0]['by'], 'lead-orch')
        self.assertEqual(self.item(item)['agent'], 'team-impl2')
        self.assertEqual([entry['by'] for entry in self.item(item)['history']],
                         ['lead-orch', 'lead-orch', 'team-impl', 'lead-orch'])

    def test_ambiguous_unknown_or_unreadable_names_write_nothing(self):
        self.init()
        item = self.add()
        before = self.ledger.read_bytes()
        self.set_hcom('orch', 'x-impl', 'y-impl')
        error = self.fails('assign', str(item), '--agent', 'impl', '--card', str(self.card()),
                           '--deadline', '+2h')
        self.assertIn('--agent: Ambiguous HCOM agent impl: x-impl, y-impl', error)
        error = self.fails('block', str(item), '--reason', 'r', by='ghost')
        self.assertIn('--by: Unknown HCOM agent: ghost; HCOM lists: orch, x-impl, y-impl; '
                      'nothing written', error)
        self.hcom_list.unlink()
        self.assertIn('HCOM agent list unreadable', self.fails('block', str(item), '--reason', 'r'))
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_os_user_and_native_agent_need_no_hcom(self):
        self.init()
        self.hcom_list.unlink()
        item = int(self.ok('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'file',
                           by='').strip())
        self.ok('assign', str(item), '--agent', 'nanu-research-web', '--native', '--card',
                str(self.card()), '--deadline', '+2h', by='')
        self.ok('reassign', str(item), '--agent', 'nanu-research-two', '--native', '--reason',
                'first one left', by='')
        self.assertEqual(self.item(item)['agent'], 'nanu-research-two')
        self.assertTrue(all(entry['by'] for entry in self.item(item)['history']))

    def test_base_name_orchestrator_from_older_ledgers_may_still_cancel(self):
        self.init()
        item = self.add()
        self.set_hcom('lead-orch')
        self.ok('cancel', str(item), '--reason', 'dropped')
        self.assertEqual(self.item(item)['status'], 'cancelled')


if __name__ == '__main__':
    unittest.main()
