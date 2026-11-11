"""CLI contract tests for lat-ledger.py: subprocess, a real temp Git repo, fake gate records."""
import contextlib
import hashlib
import importlib.util
import io
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


# A fake `gh` for tracker titles: answers `gh api repos/<owner>/<repo>/issues/<n>` from a JSON
# file of {"owner/repo#n": title}, logs every call, and fails like the real one otherwise.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, re, sys
args = sys.argv[1:]
open(os.environ['FAKE_GH_LOG'], 'a').write(' '.join(args) + '\n')
titles = json.load(open(os.environ['FAKE_GH_DATA']))
match = len(args) == 2 and args[0] == 'api' and re.fullmatch(
    r'repos/([\w.-]+/[\w.-]+)/issues/(\d+)', args[1])
title = match and titles.get(match.group(1) + '#' + match.group(2))
if not title:
    sys.stderr.write('gh: Not Found (HTTP 404)\n'); sys.exit(1)
print(json.dumps({'state': 'open', 'labels': [], 'title': title}))
'''


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
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'gh').write_text(FAKE_GH)
        (bin_dir / 'gh').chmod(0o755)
        self.gh_data, self.gh_log = self.root / 'gh.json', self.root / 'gh.log'
        self.gh_data.write_text('{}')
        self.gh_env = {'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                       'FAKE_GH_DATA': str(self.gh_data), 'FAKE_GH_LOG': str(self.gh_log)}

    def set_hcom(self, *names):
        """Untagged names are their own full names; `<tag>-<base>` ones carry a tag."""
        self.hcom_list.write_text(json.dumps([
            {'name': name, 'base_name': name.rsplit('-', 1)[-1]} for name in names]))

    # Tests about other things close impl and qa rows without caring about findings: before such
    # a `done`, a clean review is recorded (impl) or --no-findings added (qa). The done-gate
    # tests turn this off.
    auto_findings = True

    def satisfy_done_gate(self, args, by, env, script):
        if script or not self.ledger.exists() or '--no-findings' in args:
            return args
        doc = self.doc()
        row = next((i for i in doc['items'] if str(i['id']) == args[1]), None)
        if not doc.get('problem_gates') or not row or row['status'] not in ('assigned',
                                                                            'in_progress'):
            return args
        if row['stage'] == 'qa':
            return (*args, '--no-findings')
        if row['stage'] == 'impl' and not any(r['row'] == row['id']
                                              for r in doc.get('reviews', [])):
            self.ok('review-result', '--row', args[1], '--reviewer', 'auto-reviewer',
                            '--clean', by=by, env=env)
        return args

    def run_ledger(self, *args, by='orch', env=None, script=None):
        environment = {**os.environ, 'LAT_LEDGER_NOW': self.now, 'HCOM_INSTANCE_NAME': by,
                       'LAT_LEDGER_HCOM_LIST': str(self.hcom_list),
                       'SUITE_GATE_STATE_DIR': str(self.gate_state),
                       'XDG_CONFIG_HOME': str(self.root / 'config'), **self.gh_env,
                       **(env or {})}
        environment.pop('SUITE_GATE_CONFIG', None)
        command, *rest = args
        return subprocess.run([sys.executable, str(script or SCRIPT), command, '--ledger', str(self.ledger),
                               *rest], capture_output=True, text=True, env=environment,
                              timeout=60)

    def ok(self, *args, **kwargs):
        if args[0] == 'done' and self.auto_findings:
            args = self.satisfy_done_gate(args, kwargs.get('by', 'orch'), kwargs.get('env'),
                                          kwargs.get('script'))
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

    def started(self, *extra, evidence='commit', card=None, ticket='#1'):
        item = self.add(*extra, evidence=evidence, ticket=ticket)
        self.ok('assign', str(item), '--agent', 'impl', '--card',
                str(card or self.card(f'card-{item}.md')))
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        return item

    def exempt_qa(self, ticket='#1'):
        """Record that this ticket needs no QA row: a cancelled one, with its reason."""
        qa = self.add(ticket=ticket, stage='qa', evidence='file')
        self.ok('cancel', str(qa), '--reason', 'tool ticket, no QA needed')

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
        self.exempt_qa()
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
        self.exempt_qa()
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

    def test_assign_needs_agent_and_card_but_no_deadline(self):
        item = self.add()
        card = str(self.card())
        self.assertEqual(self.run_ledger('assign', str(item), '--card', card).returncode, 2)
        self.assertEqual(self.run_ledger('assign', str(item), '--agent', 'a').returncode, 2)
        self.ok('assign', str(item), '--agent', 'a', '--card', card)
        row = self.item(item)
        self.assertEqual((row['status'], row['agent'], row['deadline'], row['assigned_at']),
                         ('assigned', 'a', None, NOW))

    def test_a_passed_deadline_is_ignored_with_a_notice(self):
        added = self.run_ledger('add', '--ticket', '#1', '--stage', 'impl', '--evidence',
                                'commit', '--deadline', '+5h')
        self.assertEqual(added.returncode, 0, added.stderr)
        self.assertIn('--deadline ignored', added.stderr)
        item = int(added.stdout)
        self.assertIsNone(self.item(item)['deadline'])
        assigned = self.run_ledger('assign', str(item), '--agent', 'a', '--card',
                                   str(self.card()), '--deadline', '+90m')
        self.assertEqual(assigned.returncode, 0, assigned.stderr)
        self.assertIn('--deadline ignored', assigned.stderr)
        self.assertIsNone(self.item(item)['deadline'])
        self.ok('start', str(item), '--eta', '+30m', by='a')
        updated = self.run_ledger('update', str(item), '--deadline', '+9h', '--progress', 'x',
                                  by='a')
        self.assertEqual(updated.returncode, 0, updated.stderr)
        self.assertIn('--deadline ignored', updated.stderr)
        self.assertEqual(self.item(item)['deadline'], '2026-10-24T11:30:00Z')
        self.assertIn('nothing to update', self.fails('update', str(item), '--deadline', '+9h',
                                                      '--reason', 'r', by='a'))

    def test_the_deadline_is_the_estimate_plus_an_hour_and_follows_it(self):
        item = self.add()
        self.ok('assign', str(item), '--agent', 'a', '--card', str(self.card()))
        self.ok('start', str(item), '--eta', '+45m', by='a')
        self.assertEqual(self.item(item)['deadline'], '2026-10-24T11:45:00Z')
        self.ok('update', str(item), '--eta', '2026-10-24T13:00:00Z', '--reason', 'r', by='a')
        self.assertEqual(self.item(item)['deadline'], '2026-10-24T14:00:00Z')
        self.ok('reassign', str(item), '--agent', 'b', '--reason', 'r')
        row = self.item(item)
        self.assertEqual((row['estimate'], row['deadline']), (None, None))

    def test_unblock_recomputes_the_deadline_from_the_current_estimate(self):
        item = self.add()
        self.ok('assign', str(item), '--agent', 'a', '--card', str(self.card()))
        self.ok('start', str(item), '--eta', '+1h', by='a')
        self.ok('block', str(item), '--reason', 'waits for #9')
        self.now = '2026-10-24T12:30:00Z'  # past the deadline while blocked
        self.assertNotIn('deadline', json.loads(self.ok('show', '--json'))['items'][0]
                         ['late_minutes'])
        self.ok('unblock', str(item))
        row = self.item(item)
        self.assertEqual((row['status'], row['deadline']), ('in_progress', '2026-10-24T12:00:00Z'))
        self.ok('update', str(item), '--eta', '+30m', '--reason', 'unblocked', by='a')
        self.assertEqual(self.item(item)['deadline'], '2026-10-24T14:00:00Z')

    def test_start_requires_eta_and_update_eta_requires_reason(self):
        item = self.add()
        self.ok('assign', str(item), '--agent', 'a', '--card', str(self.card()))
        self.assertEqual(self.run_ledger('start', str(item)).returncode, 2)
        self.ok('start', str(item), '--eta', '+45m', by='a')
        self.assertEqual(self.item(item)['estimate'], '2026-10-24T10:45:00Z')
        self.assertIn('--reason is required', self.fails('update', str(item), '--eta', '+2h'))
        self.ok('update', str(item), '--progress', 'tests written')
        self.ok('update', str(item), '--eta', '+2h', '--reason', 'flaky fixture', by='a')
        last = self.item(item)['history'][-1]
        self.assertEqual(last['changes'], {'estimate': ['2026-10-24T10:45:00Z',
                                                        '2026-10-24T12:00:00Z'],
                                           'deadline': ['2026-10-24T11:45:00Z',
                                                        '2026-10-24T13:00:00Z']})
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

    def closed(self, card=None):
        item = self.started(card=card or self.card())
        self.ok('done', str(item), '--commit', self.merged, by='impl')
        return item

    def test_amend_notes_a_closed_row_and_keeps_its_evidence(self):
        item = self.closed()
        self.ok('amend', str(item), '--reason', 'QA re-judged Q5: PASS', by='impl')
        row = self.item(item)
        self.assertEqual(row['status'], 'done')
        self.assertEqual(row['evidence'], {'commit': [self.merged]})
        self.assertEqual(row['history'][-1]['action'], 'amend')
        self.assertEqual(row['history'][-1]['reason'], 'QA re-judged Q5: PASS')
        self.assertIn('補記：QA re-judged Q5: PASS', self.ok('show', '--rows'))
        self.exempt_qa()
        self.ok('check')

    def test_amend_replaces_evidence_and_only_the_cards_deliverable(self):
        git(self.workspace, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
        card = self.card()
        item = self.closed(card=card)
        card.write_text(card.read_text().replace('- status：committed', '- status：merged'))
        self.ok('amend', str(item), '--commit', self.side, '--reason', 'fix after QA', by='impl')
        self.assertEqual(self.item(item)['evidence'], {'commit': [self.side]})
        text = card.read_text()
        self.assertIn('- status：merged\n', text)
        self.assertIn(f'- deliverable commit：{self.side}\n', text)
        self.exempt_qa()
        self.ok('check')

    def test_done_keeps_a_merged_card_merged_and_fills_the_commit(self):
        git(self.workspace, 'merge', '-q', '--no-ff', '-m', 'merge side', 'side')
        card = self.card(status='merged')
        item = self.started(card=card)
        self.ok('done', str(item), '--commit', self.side, by='impl')
        text = card.read_text()
        self.assertIn('- status：merged\n', text)
        self.assertIn(f'- deliverable commit：{self.side}\n', text)

    def test_amend_with_bad_or_undeclared_evidence_changes_nothing(self):
        item = self.closed()
        before = self.item(item)
        self.assertIn('is not reachable', self.fails(
            'amend', str(item), '--commit', self.side, '--reason', 'x'))
        self.assertIn('file evidence was not declared', self.fails(
            'amend', str(item), '--file', str(self.ledger), '--reason', 'x'))
        self.assertEqual(self.item(item), before)

    def test_amend_needs_a_reason_and_a_closed_row(self):
        item = self.started()
        self.assertIn('needs done', self.fails('amend', str(item), '--reason', 'x'))
        closed = self.closed()
        self.assertIn('--reason is required', self.fails('amend', str(closed), '--reason', ' '))

    def test_update_progress_on_a_closed_row_points_to_amend(self):
        item = self.closed()
        self.assertIn('use amend', self.fails('update', str(item), '--progress', 'late note'))

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

    def test_a_rerun_only_gate_record_needs_a_recorded_review_that_acknowledges_it(self):
        rerun_fp = 'abad1dea' * 8
        with (self.gate_state / 'ledger.jsonl').open('a') as records:
            records.write(json.dumps({'fingerprint': FP, 'exit_code': 0, 'reusable': True}) + '\n')
            records.write(json.dumps({
                'fingerprint': rerun_fp, 'exit_code': 0, 'reusable': True, 'rerun_only': True,
                'flaky': [{'file': 'web/tests/a.test.ts', 'tests': ['breaks']}]}) + '\n')
        first_try = self.started(evidence='gate')
        self.ok('done', str(first_try), '--gate', FP, by='impl')
        item = self.started(evidence='gate')
        error = self.fails('done', str(item), '--gate', rerun_fp, by='impl')
        self.assertIn(f'gate record {rerun_fp[:12]} PASSED ONLY ON RERUN (failed first: '
                      'web/tests/a.test.ts)', error)
        self.assertIn(f'--rerun-ack {rerun_fp[:12]} --note', error)
        review = ('review-result', '--reviewer', 'a', '--clean', '--rerun-ack', rerun_fp[:12])
        self.assertIn('needs --note', self.fails(*review, '--row', str(item), by='impl'))
        self.assertIn('12 to 64 hex', self.fails(
            'review-result', '--row', str(item), '--reviewer', 'a', '--clean', '--rerun-ack',
            rerun_fp[:11], '--note', 'x', by='impl'))
        note = ('--note', 'first failure was a timing race in the test')
        self.ok(*review, '--row', str(first_try), *note, by='impl')
        self.assertIn('PASSED ONLY ON RERUN', self.fails('done', str(item), '--gate', rerun_fp,
                                                         by='impl'),
                      'a review of another row does not count')
        self.ok(*review, '--row', str(item), *note, by='impl')
        self.assertEqual(self.doc()['reviews'][-1]['rerun_acks'], [rerun_fp[:12]])
        self.ok('done', str(item), '--gate', rerun_fp, by='impl')
        self.exempt_qa()
        self.ok('check')

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
        self.assertNotIn(str(self.other), self.ok('show', '--rows'))  # JSON keeps the path
        self.assertEqual(json.loads(self.ok('show', '--json'))['items'][0]['repo'],
                         str(self.other))
        self.exempt_qa()
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
        self.exempt_qa()
        out = self.ok('check')
        self.assertIn('ledger check: OK', out)
        self.assertIn('out of scope', out)

    def test_check_fails_when_a_report_moves_after_closing(self):
        report = self.root / 'qa-report.md'
        report.write_text('PASS\n')
        item = self.started(evidence='file')
        self.ok('done', str(item), '--file', str(report))
        self.exempt_qa()
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
        self.exempt_qa()
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


class QaCoverageTests(LedgerCase):
    """ouob-tw/LoopAgentTeams-work#480: every ticket with an impl row needs a QA row."""

    def setUp(self):
        super().setUp()
        self.init()
        self.impl = self.started()
        self.ok('done', str(self.impl), '--commit', self.merged)

    def test_check_fails_naming_a_ticket_with_no_qa_row(self):
        result = self.run_ledger('check', '--json')
        self.assertEqual(result.returncode, 1)
        failure = json.loads(result.stdout)['failures'][0]
        self.assertIn('ticket #1', failure['label'])
        self.assertIn('no qa-draft or qa item', failure['problems'][0])
        self.assertIn('ticket #1', self.run_ledger('check').stdout)

    def test_a_qa_draft_or_qa_row_covers_the_ticket(self):
        for stage in ('qa-draft', 'qa'):
            with self.subTest(stage=stage):
                self.add(ticket='#1', stage=stage, evidence='file')
                self.assertEqual(self.run_ledger('check').returncode, 1)  # still open
                self.ok('cancel', str(self.doc()['next_id'] - 1), '--reason', 'x')
                self.ok('check')
                self.exempt_qa('#9')  # unrelated row does not matter
                self.ok('check')

    def test_a_cancelled_qa_row_with_its_reason_is_a_recorded_exemption(self):
        self.exempt_qa()
        out = self.ok('check')
        self.assertIn('ledger check: OK', out)
        self.assertIn('tool ticket, no QA needed', out)

    def test_one_row_may_cover_several_tickets(self):
        other = self.started(ticket='#2')
        self.ok('done', str(other), '--commit', self.merged)
        self.add(ticket='#1, #2', stage='qa', evidence='file')
        qa = self.doc()['next_id'] - 1
        self.ok('cancel', str(qa), '--reason', 'covered')
        self.ok('check')

    def test_a_row_covering_only_some_tickets_leaves_the_rest_unfinished(self):
        other = self.started(ticket='#2')
        self.ok('done', str(other), '--commit', self.merged)
        self.exempt_qa('#1 #3')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ticket #2', result.stdout)
        self.assertNotIn('ticket #1', result.stdout)

    def test_qa_for_the_same_number_in_another_repo_does_not_cover_it(self):
        impl = self.started(ticket='alpha/project#2')
        self.ok('done', str(impl), '--commit', self.merged)
        self.exempt_qa('#1')
        self.exempt_qa('beta/project#2')
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ticket alpha/project#2', result.stdout)
        self.exempt_qa('alpha/project#2')
        self.ok('check')

    def test_a_bare_number_and_a_qualified_one_are_not_the_same_ticket(self):
        impl = self.started(ticket='org/repo#2')
        self.ok('done', str(impl), '--commit', self.merged)
        self.exempt_qa('#1')
        self.exempt_qa('#2')
        self.assertIn('ticket org/repo#2', self.run_ledger('check').stdout)
        self.exempt_qa('org/repo#2')
        self.ok('check')

    def test_qa_for_a_qualified_number_does_not_cover_a_bare_one(self):
        self.exempt_qa('#1')
        impl = self.started(ticket='#2')
        self.ok('done', str(impl), '--commit', self.merged)
        self.exempt_qa('org/repo#2')
        self.assertIn('ticket #2', self.run_ledger('check').stdout)

    def test_a_bare_number_is_the_same_ticket_as_hash_number(self):
        impl = self.started(ticket='480')
        self.ok('done', str(impl), '--commit', self.merged)
        self.exempt_qa('#1')
        self.assertEqual(self.run_ledger('check').returncode, 1)
        self.exempt_qa('#480')
        self.ok('check')

    def test_comma_lists_in_any_spelling_cover_the_same_numbers(self):
        cases = (('480,481', '480,481', True), ('480, 481', '#480,#481', True),
                 ('#480,#481', '480 481', True), ('480,481', '480', False),
                 ('org/repo#480,481', 'org/repo#480,#481', True),
                 ('org/repo#480,481', 'org/repo#480,org/repo#481', False))
        for impl_ticket, qa_ticket, covered in cases:
            with self.subTest(impl=impl_ticket, qa=qa_ticket):
                for path in (self.ledger, self.seal, self.journal):
                    path.unlink()
                self.init()
                self.exempt_qa('#1')  # setUp's #1 impl row is gone with the ledger
                impl = self.started(ticket=impl_ticket)
                self.ok('done', str(impl), '--commit', self.merged)
                self.assertEqual(self.run_ledger('check').returncode, 1)
                qa = self.add(ticket=qa_ticket, stage='qa', evidence='file')
                self.ok('cancel', str(qa), '--reason', 'covered')
                self.assertEqual(self.run_ledger('check').returncode, 0 if covered else 1)

    def test_a_ledger_with_a_hand_set_deadline_still_loads(self):
        baseline = self.root / 'baseline'
        baseline.mkdir()
        old = baseline / 'lat-ledger.py'
        old.write_text(git(Path(__file__).resolve().parents[3], 'show',
                           'e8aa8075:skills/local/lat/scripts/lat-ledger.py') + '\n')
        (baseline / '_lat_common.py').write_text((SCRIPT.parent / '_lat_common.py').read_text())
        for path in (self.ledger, self.seal, self.journal):
            path.unlink()
        def old_ok(*args, by='orch'):
            result = self.run_ledger(*args, by=by, script=old)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        old_ok('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
               '--orchestrator', 'orch')
        item = old_ok('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'commit').strip()
        old_ok('assign', item, '--agent', 'impl', '--card', str(self.card()), '--deadline', '+5h')
        old_ok('start', item, '--eta', '+1h', by='impl')
        old_ok('block', item, '--reason', 'waits')
        self.assertEqual(self.item(int(item))['deadline'], '2026-10-24T15:00:00Z')
        self.assertIn('| 受阻 |', self.ok('show', '--rows'))
        self.ok('unblock', item)
        self.assertEqual(self.item(int(item))['deadline'], '2026-10-24T12:00:00Z')

    def test_a_ledger_made_before_the_rule_is_not_held_to_it(self):
        baseline = self.root / 'baseline'
        baseline.mkdir()
        old = baseline / 'lat-ledger.py'
        old.write_text(git(Path(__file__).resolve().parents[3], 'show',
                           '2f203072:skills/local/lat/scripts/lat-ledger.py') + '\n')
        (baseline / '_lat_common.py').write_text((SCRIPT.parent / '_lat_common.py').read_text())
        for path in (self.ledger, self.seal, self.journal):
            path.unlink()
        def old_ok(*args, by='orch'):
            result = self.run_ledger(*args, by=by, script=old)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        old_ok('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
               '--orchestrator', 'orch')
        item = old_ok('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'commit').strip()
        old_ok('assign', item, '--agent', 'impl', '--card', str(self.card()), '--deadline', '+2h')
        old_ok('start', item, '--eta', '+1h', by='impl')
        old_ok('done', item, '--commit', self.merged, by='impl')
        self.assertNotIn('qa_coverage', self.doc())
        self.ok('check')
        self.ledger.unlink()
        self.ok('repair', '--from-journal', '--reason', 'rebuilt')
        self.assertNotIn('qa_coverage', self.doc())
        self.ok('check')

    def test_a_new_ledger_carries_the_rule_and_keeps_it_through_repair(self):
        self.assertTrue(self.doc()['qa_coverage'])
        self.ledger.unlink()
        self.ok('repair', '--from-journal', '--reason', 'rebuilt')
        self.assertTrue(self.doc()['qa_coverage'])
        self.assertEqual(self.run_ledger('check').returncode, 1)

    def test_a_cancelled_impl_row_needs_no_qa(self):
        self.exempt_qa()
        gone = self.add(ticket='#7')
        self.ok('cancel', str(gone), '--reason', 'dropped')
        self.ok('check')

    def test_ledgers_without_impl_rows_are_unaffected(self):
        self.ledger.unlink(); self.seal.unlink(); self.journal.unlink()
        self.init()
        qa = self.add(stage='qa', evidence='file')
        self.ok('cancel', str(qa), '--reason', 'nothing to test')
        self.ok('check')


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
        self.exempt_qa()
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
        self.exempt_qa()
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('no default branch found', result.stdout)
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
        self.exempt_qa()
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1)
        self.assertIn('is not reachable from origin/trunk', result.stdout)
        git(self.workspace, 'update-ref', 'refs/remotes/origin/trunk', self.side)
        self.ok('check')

    def test_origin_head_naming_a_gone_ref_falls_back_to_main(self):
        self.closed_on_side()
        self.merge_side_into_main()
        git(self.workspace, 'branch', '-q', '-D', 'side')
        git(self.workspace, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/gone')
        self.exempt_qa()
        self.ok('check')

    def test_a_surviving_task_branch_is_still_the_only_branch_checked(self):
        item = self.started('--branch', 'other')
        self.merge_side_into_main()
        git(self.workspace, 'branch', '-q', 'other', self.merged)
        error = self.fails('done', str(item), '--commit', self.side, by='impl')
        self.assertIn('is not reachable from other', error)


class RemovedWorktreeCase(LedgerCase):
    """ouob-tw/LoopAgentTeams-work#436: task cleanup removes the row's worktree and branch."""

    def new_repo(self, name, branch='main'):
        repo = self.root / name
        repo.mkdir()
        git(repo, 'init', '-q', '-b', branch)
        git(repo, 'config', 'user.email', 't@example.com')
        git(repo, 'config', 'user.name', 'T')
        (repo / 'o.txt').write_text('o\n')
        git(repo, 'add', 'o.txt')
        git(repo, 'commit', '-q', '-m', 'first')
        return repo

    def task_worktree(self, repo):
        """A task worktree of `repo` with one commit; returns (worktree, commit)."""
        worktree = repo / '.worktrees' / 'task'
        git(repo, 'worktree', 'add', '-q', '-b', 'task', str(worktree))
        (worktree / 't.txt').write_text('t\n')
        git(worktree, 'add', 't.txt')
        git(worktree, 'commit', '-q', '-m', 'task work')
        return worktree, git(worktree, 'rev-parse', 'HEAD')

    def closed_in_worktree(self, repo=None):
        """A row closed from a task worktree of `repo`; returns (row, worktree, commit)."""
        worktree, commit = self.task_worktree(repo or self.workspace)
        item = self.started('--repo', str(worktree), '--branch', 'task')
        self.ok('done', str(item), '--commit', commit, by='impl')
        return item, worktree, commit

    def clean_up(self, repo, worktree, merge=True, drop_branch=True):
        if merge:
            git(repo, 'merge', '-q', '--no-ff', '-m', 'merge task', 'task')
        git(repo, 'worktree', 'remove', str(worktree))
        if drop_branch:
            git(repo, 'branch', '-q', '-D', 'task')

    def check_fails(self):
        result = self.run_ledger('check')
        self.assertEqual(result.returncode, 1, result.stdout)
        return result.stdout


class RemovedWorktreeTests(RemovedWorktreeCase):
    def setUp(self):
        super().setUp()
        self.init()

    def test_passes_when_the_commit_reached_the_integration_branch(self):
        _, worktree, _ = self.closed_in_worktree()
        self.clean_up(self.workspace, worktree)
        self.exempt_qa()
        self.assertIn('ledger check: OK', self.ok('check'))

    def test_fails_when_the_commit_never_reached_the_integration_branch(self):
        _, worktree, commit = self.closed_in_worktree()
        self.clean_up(self.workspace, worktree, merge=False)
        output = self.check_fails()
        self.assertIn(f'repo {worktree} no longer exists', output)
        self.assertIn(f'{self.workspace}: commit {commit} is not reachable from dev', output)

    def test_a_surviving_task_branch_does_not_count_once_the_worktree_is_gone(self):
        _, worktree, _ = self.closed_in_worktree()
        self.clean_up(self.workspace, worktree, merge=False, drop_branch=False)
        self.assertIn('is not reachable from dev', self.check_fails())

    def test_fails_naming_where_it_looked_when_the_commit_no_longer_exists(self):
        _, worktree, commit = self.closed_in_worktree()
        self.clean_up(self.workspace, worktree, merge=False)
        git(self.workspace, 'reflog', 'expire', '--expire=now', '--all')
        git(self.workspace, 'gc', '-q', '--prune=now')
        output = self.check_fails()
        self.assertIn(f'repo {worktree} no longer exists', output)
        self.assertIn(f'{self.workspace}: commit {commit} not found', output)

    def test_a_worktree_of_another_repo_is_looked_up_in_that_repo(self):
        other = self.new_repo('other')
        _, worktree, _ = self.closed_in_worktree(other)
        self.clean_up(other, worktree)
        self.exempt_qa()
        self.ok('check')

    def test_a_worktree_outside_its_repo_is_looked_up_in_the_repo_noted_at_closing(self):
        other = self.new_repo('other')
        worktree = self.root / 'task-worktree'
        git(other, 'worktree', 'add', '-q', '-b', 'task', str(worktree))
        (worktree / 't.txt').write_text('t\n')
        git(worktree, 'add', 't.txt')
        git(worktree, 'commit', '-q', '-m', 'task work')
        commit = git(worktree, 'rev-parse', 'HEAD')
        item = self.started('--repo', str(worktree), '--branch', 'task')
        self.ok('done', str(item), '--commit', commit, by='impl')
        self.assertEqual(self.item(item)['main_checkout'], str(other))
        self.clean_up(other, worktree, merge=False)
        self.assertIn(f'{other}: commit {commit} is not reachable from main', self.check_fails())
        git(other, 'merge', '-q', '--no-ff', '-m', 'merge task', commit)
        self.exempt_qa()
        self.ok('check')

    def test_another_repo_that_is_gone_too_fails_naming_the_workspace(self):
        other = self.new_repo('other')
        _, worktree, commit = self.closed_in_worktree(other)
        self.clean_up(other, worktree)
        shutil.rmtree(other)
        self.assertIn(f'{self.workspace}: commit {commit} not found', self.check_fails())

    def test_done_closes_a_merged_row_after_the_worktree_is_gone(self):
        worktree, commit = self.task_worktree(self.workspace)
        item = self.started('--repo', str(worktree), '--branch', 'task')
        self.clean_up(self.workspace, worktree)
        self.ok('done', str(item), '--commit', commit, by='impl')

    def test_deleted_branch_in_a_surviving_repo_is_held_to_the_integration_branch(self):
        item = self.started('--branch', 'side', '--repo', str(self.workspace))
        self.ok('done', str(item), '--commit', self.side, by='impl')
        git(self.workspace, 'branch', '-q', '-D', 'side')
        self.assertIn('is not reachable from dev', self.check_fails())


class RemovedWorktreeWithoutIntegrationTests(RemovedWorktreeCase):
    """With no integration branch recorded, the repo's default branch stands in for it."""

    def setUp(self):
        super().setUp()
        self.ok('init', '--workspace', str(self.workspace), '--orchestrator', 'orch')

    def test_passes_when_the_commit_reached_the_default_branch(self):
        repo = self.new_repo('other')
        _, worktree, _ = self.closed_in_worktree(repo)
        self.clean_up(repo, worktree)
        self.exempt_qa()
        self.ok('check')

    def test_fails_with_the_way_out_when_it_only_reached_another_branch(self):
        repo = self.new_repo('other')
        git(repo, 'switch', '-q', '-c', 'dev')
        item, worktree, commit = self.closed_in_worktree(repo)
        self.clean_up(repo, worktree)
        output = self.check_fails()
        self.assertIn(f'{repo}: commit {commit} is not reachable from main', output)
        self.assertIn(f'update {item} --repo <main checkout> --branch <branch>', output)
        self.ok('update', str(item), '--repo', str(repo), '--branch', 'dev')
        self.exempt_qa()
        self.ok('check')

    def test_fails_when_no_default_branch_exists(self):
        repo = self.new_repo('other', branch='dev')
        _, worktree, _ = self.closed_in_worktree(repo)
        self.clean_up(repo, worktree)
        self.assertIn(f'{repo}: no integration or default branch', self.check_fails())

    def test_deleted_branch_in_a_surviving_repo_is_held_to_the_default_branch(self):
        repo = self.new_repo('other')
        git(repo, 'switch', '-q', '-c', 'task')
        (repo / 't.txt').write_text('t\n')
        git(repo, 'add', 't.txt')
        git(repo, 'commit', '-q', '-m', 'task work')
        commit = git(repo, 'rev-parse', 'HEAD')
        item = self.started('--repo', str(repo), '--branch', 'task')
        self.ok('done', str(item), '--commit', commit, by='impl')
        git(repo, 'switch', '-q', 'main')
        git(repo, 'branch', '-q', '-D', 'task')
        self.assertIn('is not reachable from main', self.check_fails())
        git(repo, 'merge', '-q', '--no-ff', '-m', 'merge', commit)
        self.exempt_qa()
        self.ok('check')

    def test_update_repo_refuses_a_path_that_is_not_a_git_repository(self):
        item = self.started()
        plain = self.root / 'plain'
        plain.mkdir()
        self.assertIn('not a git repository',
                      self.fails('update', str(item), '--repo', str(plain)))


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
        out = self.ok('show', '--rows')
        rows = {line.split(' | ')[0].strip('| '): line for line in out.splitlines()
                if line.startswith('| ') and not line.startswith('| #')}
        header = next(line for line in out.splitlines() if line.startswith('| #'))
        self.assertNotIn('最晚期限', header)
        self.assertNotIn('遲到', header)
        self.assertIn('| 進行中（超過預計 90 分） |', rows[str(late)])
        self.assertNotIn('期限', out)
        self.assertIn('任務卡不一致：card says committed, ledger says in_progress', rows[str(wrong)])
        self.assertIn('| 受阻 |', rows[str(blocked)])
        self.assertNotIn('超過預計', rows[str(blocked)])
        self.assertIn('受阻：waits for #9', rows[str(blocked)])
        late_json = {row['id']: row['late_minutes']
                     for row in json.loads(self.ok('show', '--json'))['items']}
        self.assertEqual(late_json[late], {'estimate': 90, 'deadline': 30})
        self.assertEqual(late_json[blocked], {})

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


class TicketTests(LedgerCase):
    """The ticket layer of `show` (#546): rows grouped by canonical ticket."""

    def setUp(self):
        super().setUp()
        (self.workspace / 'docs/agents').mkdir(parents=True)
        (self.workspace / 'docs/agents/issue-tracker.md').write_text(
            'Use `gh` and always pass `-R acme/work`.\n')
        self.init()

    def tickets(self):
        return {t['key']: t for t in json.loads(self.ok('show', '--json'))['tickets']}

    def steps(self, ticket):
        return {step['key']: step['state'] for step in ticket['steps']}

    def report(self, name='report.md'):
        path = self.root / name
        path.write_text('done\n')
        return str(path)

    def test_rows_group_under_each_canonical_ticket(self):
        shared = self.add(ticket='#348,349')
        qa = self.add(ticket='348', stage='qa', evidence='file')
        qualified = self.add(ticket='acme/work#349', stage='qa', evidence='file')
        elsewhere = self.add(ticket='other/repo#348')
        named = self.add('--title', 'Ledger fields', ticket='ledger-fields', stage='research',
                         evidence='file')
        plain = self.add(ticket='cleanup notes', stage='other', evidence='file')
        research = self.add(ticket='#350', stage='research', evidence='file')
        self.ok('assign', str(research), '--agent', 'a', '--card', str(self.card('r.md')))
        self.ok('done', str(research), '--file', self.report(), by='a')
        tickets = self.tickets()
        # A ticket with no row in any step has every step skipped.
        self.assertEqual(set(self.steps(tickets.pop('acme/work#350')).values()), {'skipped'})
        self.assertEqual(list(tickets), ['acme/work#348', 'acme/work#349', 'other/repo#348',
                                         'ledger-fields', 'cleanup notes'])
        self.assertEqual(tickets['acme/work#348']['items'], [shared, qa])
        self.assertEqual(tickets['acme/work#349']['items'], [shared, qualified])
        self.assertEqual(tickets['other/repo#348']['items'], [elsewhere])
        self.assertEqual((tickets['acme/work#348']['repo'], tickets['acme/work#348']['number']),
                         ('acme/work', 348))
        self.assertEqual(tickets['ledger-fields']['items'], [named])
        self.assertEqual(tickets['ledger-fields']['title'], 'Ledger fields')
        self.assertEqual(tickets['cleanup notes']['items'], [plain])
        self.assertEqual(tickets['cleanup notes']['title'], 'cleanup notes')
        self.assertIsNone(tickets['cleanup notes']['number'])
        view = json.loads(self.ok('show', '--json'))
        self.assertEqual(view['ticket_counts'], {'unassigned': 5, 'done': 1})
        self.assertEqual(view['items'][0]['ticket_keys'], ['acme/work#348', 'acme/work#349'])
        out = self.ok('show')
        self.assertIn('6 張票：5 張未派、1 張已結案', out)
        self.assertIn('| #348 |  |', out)  # this project's tracker is shown as a bare number
        self.assertIn('| other/repo#348 |', out)

    def test_ticket_counts_count_each_ticket_once_in_its_own_state(self):
        shared = self.started(ticket='#10,#11')
        self.ok('done', str(shared), '--commit', self.merged, by='impl')
        self.add(ticket='#10', stage='qa', evidence='file')  # waits to be assigned
        self.started(ticket='#11', evidence='file')  # in progress
        blocked = self.started(ticket='#12')
        self.ok('block', str(blocked), '--reason', 'waits for #9')
        finished = self.started(ticket='#13')
        self.ok('done', str(finished), '--commit', self.merged, by='impl')
        view = json.loads(self.ok('show', '--json'))
        self.assertEqual(view['ticket_counts'], {'unassigned': 1, 'in_progress': 1,
                                                 'blocked': 1, 'merged': 1})
        states = {t['key']: t['state'] for t in view['tickets']}
        self.assertEqual(states, {'acme/work#10': 'unassigned', 'acme/work#11': 'in_progress',
                                  'acme/work#12': 'blocked', 'acme/work#13': 'merged'})
        self.assertIn('4 張票：1 張進行中、1 張受阻、1 張未派、1 張已合併', self.ok('show'))

    def test_title_comes_from_the_flag_or_the_tracker_once_and_a_failure_still_adds(self):
        self.gh_data.write_text(json.dumps({'acme/work#5': 'Fix the thing'}))
        self.add(ticket='#5')
        self.add(ticket='#5', stage='qa', evidence='file')
        result = self.run_ledger('add', '--ticket', '#6', '--stage', 'impl', '--evidence', 'commit')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('no title for acme/work#6', result.stderr)
        self.add('--title', 'Given title', ticket='#7')
        calls = self.gh_log.read_text().splitlines()
        self.assertEqual(calls, ['api repos/acme/work/issues/5', 'api repos/acme/work/issues/6'])
        tickets = self.tickets()
        self.assertEqual({key: t['title'] for key, t in tickets.items()},
                         {'acme/work#5': 'Fix the thing', 'acme/work#6': '',
                          'acme/work#7': 'Given title'})
        self.assertEqual(len(self.doc()['items']), 4)

    def test_a_failed_title_is_not_read_again_and_reads_stop_when_time_runs_out(self):
        self.add(ticket='#8')
        self.add(ticket='#8', stage='qa', evidence='file')
        self.assertEqual(self.gh_log.read_text().splitlines(), ['api repos/acme/work/issues/8'])
        self.add('--title', 'Named later', ticket='#8', stage='review', evidence='file')
        self.assertEqual(self.tickets()['acme/work#8']['title'], 'Named later')
        spec = importlib.util.spec_from_file_location('ledger_titles', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.TITLE_BUDGET_SECONDS = 0
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(module.fetch_titles(['acme/work#9', 'acme/work#10']), {})
        self.assertEqual(err.getvalue().count('no time left'), 2)

    def test_merge_and_deploy_are_checked_in_the_row_s_own_project(self):
        other = self.root / 'other'
        other.mkdir()
        git(other, 'init', '-q', '-b', 'dev')
        git(other, 'config', 'user.email', 't@example.com')
        git(other, 'config', 'user.name', 'T')
        (other / 'o.txt').write_text('o\n')
        git(other, 'add', 'o.txt')
        git(other, 'commit', '-q', '-m', 'other work')
        commit = git(other, 'rev-parse', 'HEAD')
        row = self.started('--repo', str(other), ticket='other/work#1')
        self.ok('done', str(row), '--commit', commit, by='impl')
        (other / '.lat').mkdir()
        (other / '.lat' / 'deploy-history.jsonl').write_text(json.dumps(
            {'action': 'deploy-prod', 'commit': commit, 'result': 'succeeded'}) + '\n')
        view = json.loads(self.ok('show', '--json'))
        ticket, = view['tickets']
        self.assertEqual(self.steps(ticket)['merged'], 'done')
        self.assertEqual(self.steps(ticket)['deployed'], 'done')
        self.assertEqual(ticket['state'], 'deployed')
        self.assertTrue(view['deploy_step'])

    def test_progress_steps_follow_rows_merge_and_deploy_history(self):
        draft = self.add(ticket='#20', stage='qa-draft', evidence='file')
        self.ok('assign', str(draft), '--agent', 'a', '--card', str(self.card('d.md')))
        self.ok('done', str(draft), '--file', self.report(), by='a')
        impl = self.started('--branch', 'side', ticket='#20')
        self.assertEqual(self.steps(self.tickets()['acme/work#20']),
                         {'draft': 'done', 'impl': 'active', 'review': 'pending',
                          'qa': 'pending', 'merged': 'pending'})
        self.ok('done', str(impl), '--commit', self.side, by='impl')
        ticket = self.tickets()['acme/work#20']
        self.assertEqual(self.steps(ticket), {'draft': 'done', 'impl': 'done', 'review': 'done',
                                              'qa': 'pending', 'merged': 'pending'})
        self.assertEqual((ticket['state'], ticket['now']), ('done', '審查完成'))
        git(self.workspace, 'merge', '-q', '--no-edit', 'side')
        history = self.workspace / '.lat' / 'deploy-history.jsonl'
        history.write_text(json.dumps({'action': 'deploy-test', 'commit': self.side,
                                       'result': 'succeeded'}) + '\n')
        ticket = self.tickets()['acme/work#20']
        self.assertEqual(self.steps(ticket), {'draft': 'done', 'impl': 'done', 'review': 'done',
                                              'qa': 'skipped', 'merged': 'done'})
        self.assertEqual(ticket['state'], 'merged')
        self.assertFalse(json.loads(self.ok('show', '--json'))['deploy_step'])
        self.assertIn('草稿✓ 實作✓ 審查✓ 驗收— 合併✓ |', self.ok('show'))
        with history.open('a') as stream:
            stream.write(json.dumps({'action': 'deploy-prod', 'commit': self.merged,
                                     'result': 'succeeded'}) + '\n')
        self.assertEqual(self.steps(self.tickets()['acme/work#20'])['deployed'], 'pending')
        with history.open('a') as stream:
            stream.write(json.dumps({'action': 'deploy-prod',
                                     'commit': git(self.workspace, 'rev-parse', 'HEAD'),
                                     'result': 'succeeded'}) + '\n')
        ticket = self.tickets()['acme/work#20']
        self.assertEqual(self.steps(ticket)['deployed'], 'done')
        self.assertEqual((ticket['state'], ticket['now']), ('deployed', '已上線'))
        self.assertIn('合併✓ 上線✓ |', self.ok('show'))

    def test_now_text_and_total_time(self):
        working = self.started(ticket='#30')
        self.ok('update', str(working), '--progress', 'halfway', by='impl')
        blocked = self.started(ticket='#31')
        self.ok('block', str(blocked), '--reason', 'waits for #9')
        closed = self.started(ticket='#32')
        dropped = self.add(ticket='#33')
        self.ok('cancel', str(dropped), '--reason', 'not needed')
        self.now = '2026-10-24T10:45:00Z'
        self.ok('done', str(closed), '--commit', self.merged, by='impl')
        self.now = '2026-10-24T11:30:00Z'
        tickets = self.tickets()
        self.assertEqual(tickets['acme/work#30']['now'], '實作進行中・impl・「halfway」・超過預計 30 分')
        self.assertEqual((tickets['acme/work#30']['total_minutes'],
                          tickets['acme/work#30']['running']), (90, True))
        self.assertEqual(tickets['acme/work#31']['now'], '實作受阻・impl・受阻：waits for #9')
        self.assertEqual((tickets['acme/work#32']['total_minutes'],
                          tickets['acme/work#32']['running']), (45, False))
        self.assertEqual(tickets['acme/work#33']['now'], '已取消：not needed')
        self.assertIsNone(tickets['acme/work#33']['total_minutes'])
        out = self.ok('show')
        self.assertIn('| 已 1 小時 30 分 | 1 |', out)
        self.assertIn('| 45 分 | 3 |', out)
        rows = self.ok('show', '--rows')
        self.assertIn('| # | 票號 | 階段 | 負責 | 模型 | 狀態 | 依賴 | 預計完成 | 備註 |', rows)
        self.assertIn('進度：halfway', rows)

    def test_show_json_of_an_old_ledger_is_a_superset_with_blanks(self):
        baseline = self.root / 'baseline'
        baseline.mkdir()
        old = baseline / 'lat-ledger.py'
        old.write_text(git(Path(__file__).resolve().parents[3], 'show',
                           '729723b0:skills/local/lat/scripts/lat-ledger.py') + '\n')
        (baseline / '_lat_common.py').write_text((SCRIPT.parent / '_lat_common.py').read_text())
        for path in (self.ledger, self.seal, self.journal):
            path.unlink()
        def old_ok(*args, by='orch'):
            result = self.run_ledger(*args, by=by, script=old)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout
        old_ok('init', '--workspace', str(self.workspace), '--integration-branch', 'dev',
               '--orchestrator', 'orch')
        item = old_ok('add', '--ticket', '#40', '--stage', 'impl', '--evidence', 'commit').strip()
        old_ok('add', '--ticket', 'ledger-fields', '--stage', 'research', '--evidence', 'file')
        old_ok('assign', item, '--agent', 'impl', '--card', str(self.card()))
        old_ok('start', item, '--eta', '+1h', by='impl')
        before = json.loads(old_ok('show', '--json'))
        after = json.loads(self.ok('show', '--json'))
        for key, value in before.items():
            if key != 'items':
                self.assertEqual(after[key], value, key)
        for old_row, new_row in zip(before['items'], after['items'], strict=True):
            self.assertEqual({key: new_row[key] for key in old_row}, old_row)
        self.assertEqual([(t['key'], t['title']) for t in after['tickets']],
                         [('acme/work#40', ''), ('ledger-fields', 'ledger-fields')])
        self.assertIn('| #40 |  |', self.ok('show'))
        self.assertEqual(self.gh_log.read_text() if self.gh_log.exists() else '', '')


class ActualSettingsTests(LedgerCase):
    """Actual model and effort (#547): read from `hcom list <name> --json` and the transcript
    it names at assign and done, and for reviewers at review-result; else the card, 未查證."""

    def setUp(self):
        super().setUp()
        (self.workspace / 'docs/agents').mkdir(parents=True)
        (self.workspace / 'docs/agents/issue-tracker.md').write_text('pass `-R acme/work`\n')
        self.set_hcom('orch', 'impl', 'rev', 'two')
        self.agents = self.root / 'hcom-agents.json'
        self.agents.write_text('{}')
        self.init()

    def run_ledger(self, *args, env=None, **kwargs):
        return super().run_ledger(*args, env={'LAT_LEDGER_HCOM_AGENTS': str(self.agents),
                                              **(env or {})}, **kwargs)

    def launch(self, name, tool, model=None, turns=()):
        """Stand in for one agent's HCOM details and transcript: `turns` are (model, effort)."""
        transcript = self.root / f'{name}.jsonl'
        lines = []
        for turn_model, effort in turns:
            if tool == 'claude':
                lines.append({'type': 'assistant', 'effort': effort,
                              'message': {'model': turn_model, 'content': []}})
            else:
                lines.append({'type': 'turn_context',
                              'payload': {'model': turn_model, 'effort': effort}})
        transcript.write_text(''.join(json.dumps(line) + '\n' for line in lines))
        agents = json.loads(self.agents.read_text()) if self.agents.exists() else {}
        agents[name] = {'name': name, 'tool': tool, 'transcript_path': str(transcript),
                        'usage': {'model': model}}
        self.agents.write_text(json.dumps(agents))
        return transcript

    def model_card(self, model):
        path = self.tasks / f'card-{len(list(self.tasks.iterdir()))}.md'
        path.write_text(f'接續：無\n\n- agent：impl\n- model：{model}\n- status：dispatched\n')
        return path

    def report(self):
        path = self.root / 'report.md'
        path.write_text('done\n')
        return str(path)

    def ticket(self, key='acme/work#1'):
        return next(t for t in json.loads(self.ok('show', '--json'))['tickets']
                    if t['key'] == key)

    def stage_texts(self, ticket):
        return {stage['step']: stage['text'] for stage in ticket['settings']}

    def test_bind_and_done_readings_and_an_upgrade_in_history(self):
        transcript = self.launch('impl', 'claude', 'claude-opus-5-5',
                                 [('claude-opus-5-5', 'low')])
        item = self.add(evidence='file')
        self.ok('assign', str(item), '--agent', 'impl', '--card',
                str(self.model_card('claude-sonnet-5-5 high')))
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'assistant', 'effort': 'high',
                                     'message': {'model': 'claude-opus-5-5'}}) + '\n')
        self.ok('done', str(item), '--file', self.report(), by='impl')
        actual = self.item(item)['actual']
        self.assertEqual({k: actual['bind'][k] for k in ('client', 'model', 'effort', 'verified')},
                         {'client': 'claude', 'model': 'claude-opus-5-5', 'effort': 'low',
                          'verified': True})
        self.assertEqual(actual['bind']['sources'], {'model': 'transcript', 'effort': 'transcript'})
        self.assertEqual((actual['done']['effort'], actual['done']['verified']), ('high', True))
        history = self.item(item)['history'][-1]
        self.assertEqual((history['action'], history['changes']),
                         ('settings', {'effort': ['low', 'high']}))
        self.assertEqual(self.stage_texts(self.ticket()),
                         {'impl': 'claude-opus-5-5・low→high', 'review': '未查證'})
        self.assertIn('| impl | claude-opus-5-5・low→high |', self.ok('show', '--rows'))
        self.assertIn('實作 claude-opus-5-5・low→high', self.ok('show'))

    def test_codex_model_and_effort_come_from_the_same_latest_turn(self):
        # HCOM still names the model before a switch; the latest turn has the new one.
        self.launch('impl', 'codex', 'gpt-6.1-sol', [('gpt-6.1-sol', 'low'),
                                                      ('gpt-6.1-terra', 'medium')])
        item = self.add()
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(self.model_card('x')))
        bind = self.item(item)['actual']['bind']
        self.assertEqual((bind['client'], bind['model'], bind['effort'], bind['verified']),
                         ('codex', 'gpt-6.1-terra', 'medium', True))
        self.assertEqual(bind['sources'], {'model': 'transcript', 'effort': 'transcript'})

    def test_unreadable_hcom_falls_back_to_the_card_marked_unverified(self):
        item = self.add(evidence='file')
        self.agents.unlink()
        self.ok('assign', str(item), '--agent', 'impl', '--card',
                str(self.model_card('gpt-6-astra medium')))
        bind = self.item(item)['actual']['bind']
        self.assertEqual((bind['model'], bind['effort'], bind['verified']),
                         ('gpt-6-astra', 'medium', False))
        self.assertEqual(bind['sources'], {'model': 'card', 'effort': 'card'})
        self.assertIn('hcom agent details unreadable', bind['problem'])
        self.assertEqual(self.stage_texts(self.ticket()), {'impl': 'gpt-6-astra・medium（未查證）'})
        # HCOM answers but the transcript holds no effort: the card fills it, still unverified,
        # and an unverified bind reading is no "change" to show with an arrow.
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        self.launch('impl', 'codex', 'gpt-6.1-sol')
        self.ok('done', str(item), '--file', self.report(), by='impl')
        done = self.item(item)['actual']['done']
        self.assertEqual((done['model'], done['effort'], done['verified'], done['sources']),
                         ('gpt-6.1-sol', 'medium', False, {'model': 'hcom', 'effort': 'card'}))
        self.assertEqual(self.item(item)['history'][-1]['changes']['model'],
                         ['gpt-6-astra', 'gpt-6.1-sol'])
        self.assertEqual(self.stage_texts(self.ticket()),
                         {'impl': 'gpt-6.1-sol・medium（未查證）', 'review': '未查證'})

    def test_native_agent_is_never_looked_up(self):
        self.launch('helper', 'claude', 'claude-opus-5-5', [('claude-opus-5-5', 'high')])
        item = self.add(evidence='file')
        self.ok('assign', str(item), '--agent', 'helper', '--native', '--card',
                str(self.model_card('claude-sonnet-5-5')))
        self.ok('start', str(item), '--eta', '+1h', by='orch')
        self.ok('done', str(item), '--file', self.report(), by='orch')
        actual = self.item(item)['actual']
        for reading in actual.values():
            self.assertEqual((reading['model'], reading['effort'], reading['verified'],
                              reading['native']), ('claude-sonnet-5-5', None, False, True))
        self.assertEqual(self.stage_texts(self.ticket()),
                         {'impl': 'claude-sonnet-5-5・?（未查證）', 'review': '未查證'})

    def test_review_result_records_each_reviewer_and_feeds_the_review_stage(self):
        self.launch('impl', 'claude', 'claude-opus-5-5', [('claude-opus-5-5', 'medium')])
        self.launch('rev', 'codex', 'gpt-6-astra', [('gpt-6-astra', 'medium')])
        item = self.add(evidence='file')
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(self.model_card('m')))
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        self.assertEqual(self.steps(self.ticket())['review'], 'pending')
        out = self.ok('review-result', '--row', str(item), '--reviewer', 'rev', '--reviewer',
                      'impl-sub-agent', '--clean', '--note', 'four limits ok', by='impl')
        self.assertIn('rev gpt-6-astra・medium', out)
        doc = self.doc()
        self.assertEqual([{k: r[k] for k in ('id', 'row', 'by', 'result', 'reviewers', 'note')}
                          for r in doc['reviews']],
                         [{'id': 1, 'row': item, 'by': 'impl', 'result': 'clean',
                           'reviewers': ['rev', 'impl-sub-agent'], 'note': 'four limits ok'}])
        self.assertEqual([(p['stage'], p['name'], p['row'], p['model'], p['effort'], p['verified'])
                          for p in doc['participants']],
                         [('review', 'rev', item, 'gpt-6-astra', 'medium', True),
                          ('review', 'impl-sub-agent', item, None, None, False)])
        ticket = self.ticket()
        self.assertEqual(self.stage_texts(ticket),
                         {'impl': 'claude-opus-5-5・medium',
                          'review': 'gpt-6-astra・medium、未查證'})
        self.assertEqual(self.steps(ticket)['review'], 'done')
        shown = json.loads(self.ok('show', '--json'))
        self.assertEqual(len(shown['participants']), 2)
        self.assertEqual(shown['reviews'][0]['row'], item)

    def steps(self, ticket):
        return {step['key']: step['state'] for step in ticket['steps']}

    def test_review_result_refusals_write_nothing(self):
        item = self.add()
        before = self.ledger.read_bytes()
        self.assertIn('give either --clean or at least one --finding', self.fails(
            'review-result', '--row', str(item), '--reviewer', 'rev'))
        self.assertIn('no item 9', self.fails('review-result', '--row', '9', '--reviewer', 'rev',
                                              '--clean'))
        self.assertIn('--reviewer', self.fails('review-result', '--row', str(item), '--clean'))
        self.set_hcom('orch', 'x-rev', 'y-rev')
        self.assertIn('Ambiguous HCOM agent rev', self.fails(
            'review-result', '--row', str(item), '--reviewer', 'rev', '--clean'))
        self.assertEqual(self.ledger.read_bytes(), before)

    def test_old_ledger_without_readings_shows_blanks(self):
        item = self.add(evidence='file')
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(self.model_card('m')))
        doc = self.doc()
        del doc['items'][0]['actual']
        text = json.dumps(doc, indent=2, ensure_ascii=False) + '\n'
        self.ledger.write_text(text)
        self.ok('repair', '--reason', 'simulate an older ledger')
        self.assertEqual(self.ticket()['settings'], [])
        self.assertIn('| impl |  | 已派 |', self.ok('show', '--rows'))
        self.launch('impl', 'claude', 'claude-opus-5-5', [('claude-opus-5-5', 'max')])
        self.ok('done', str(item), '--file', self.report(), by='impl')
        actual = self.item(item)['actual']
        self.assertEqual((list(actual), actual['done']['effort']), (['done'], 'max'))
        self.assertEqual(self.stage_texts(self.ticket()),
                         {'impl': 'claude-opus-5-5・max', 'review': '未查證'})


class ProblemLogTests(LedgerCase):
    """The problem log (#549): stable ids, resolutions and corrections by id, done gates scoped
    to the row's own agent and current round, per-stage counts and the stage summary."""
    auto_findings = False

    def setUp(self):
        super().setUp()
        self.set_hcom('orch', 'impl', 'impl2', 'qa', 'qa2', 'rev')
        self.init()
        self.log = self.workspace / '.lat' / 'problems.jsonl'

    def at(self, minute):
        self.now = f'2026-10-24T10:{minute:02d}:00Z'

    def report(self):
        path = self.root / 'report.md'
        path.write_text('report\n')
        return str(path)

    def started_row(self, stage, agent, ticket='#1', evidence='commit'):
        row = self.add(ticket=ticket, stage=stage, evidence=evidence)
        self.ok('assign', str(row), '--agent', agent, '--card', str(self.card(f'card-{row}.md')))
        self.ok('start', str(row), '--eta', '+1h', by=agent)
        return row

    def problems(self, *extra):
        return json.loads(self.ok('problems', '--json', *extra))

    def view(self):
        return json.loads(self.ok('show', '--json'))

    def test_a_problem_resolved_with_a_fix_commit_counts_once_with_history(self):
        impl = self.started_row('impl', 'impl')
        self.assertEqual(self.ok('review-result', '--row', str(impl), '--reviewer', 'rev',
                                 '--finding', '乙:empty list crashes', by='impl').split()[-1],
                         'P1')
        self.at(5)
        self.ok('problem-update', 'P1', '--fixed', self.merged[:10], by='impl')
        first = self.view()
        problems = self.problems()
        self.assertEqual(len(problems), 1)
        problem = problems[0]
        self.assertEqual((problem['id'], problem['stage'], problem['finder'], problem['level'],
                          problem['text'], problem['ticket'], problem['row'], problem['caught']),
                         ('P1', 'review', 'rev', '乙', 'empty list crashes', '#1', impl, False))
        self.assertEqual(problem['resolution'], {'kind': 'fixed', 'commit': self.merged})
        self.assertEqual([line['op'] for line in problem['history']], ['record', 'update'])
        self.assertEqual(problem['candidate'], 1)
        self.assertEqual(first['finding_summary'], [{
            'stage': 'review', 'label': '審查', 'count': 1,
            'levels': {'甲': 0, '乙': 1, '丙': 0}, 'caught': 0, 'severe': True}])
        self.assertEqual(first['tickets'][0]['findings']['text'], '審查 1（乙 1）')
        self.assertEqual(self.view(), first, 'rereading gives the same state')
        self.assertEqual(self.problems(), problems)
        self.assertEqual(len(self.log.read_text().splitlines()), 2)
        self.assertEqual(self.doc()['reviews'][0]['problems'], ['P1'])
        self.assertIn('| P1 | #1 | 審查 | rev | 乙 | empty list crashes | 否 | 已修 ',
                      self.ok('problems'))

    def test_qa_done_needs_its_own_finding_of_this_round_or_no_findings(self):
        qa = self.started_row('qa', 'qa', evidence='file')
        # Another agent's acceptance finding on the same ticket does not count.
        self.ok('problem', '--ticket', '#1', '--stage', 'qa', '--level', '丙', '--text',
                'seen by someone else', by='qa2')
        error = self.fails('done', str(qa), '--file', self.report(), by='qa')
        self.assertIn(f'`problem --row {qa} --stage qa', error)
        self.assertIn('--no-findings', error)
        self.ok('problem', '--row', str(qa), '--stage', 'qa', '--level', '甲', '--text',
                'breaks on phone', by='qa')
        # Moved to another ticket by a correction, it no longer counts for this row.
        self.add(ticket='#2', stage='qa', evidence='file')
        problem = self.problems('--ticket', '#1')[-1]['id']
        self.ok('problem-update', problem, '--ticket', '#2', '--reason', 'other ticket', by='qa')
        self.assertIn('record what this acceptance found', self.fails(
            'done', str(qa), '--file', self.report(), by='qa'))
        self.ok('problem-update', problem, '--ticket', '#1', '--reason', 'back', by='qa')
        self.assertIn('drop --no-findings', self.fails(
            'done', str(qa), '--file', self.report(), '--no-findings', by='qa'))
        self.ok('done', str(qa), '--file', self.report(), by='qa')
        # The same agent's finding recorded on another row of the ticket does not count.
        other = self.started_row('qa', 'qa', evidence='file')
        mine = self.started_row('qa', 'qa', evidence='file')
        self.ok('problem', '--row', str(other), '--stage', 'qa', '--level', '丙', '--text',
                'found on the other row', by='qa')
        self.assertIn('record what this acceptance found', self.fails(
            'done', str(mine), '--file', self.report(), by='qa'))
        # Nor does one recorded through another ledger of the project, which shares the log.
        first = self.ledger
        self.ledger = first.with_name('round-2.json')
        self.init()
        self.add(ticket='#1', stage='qa', evidence='file')
        self.ok('problem', '--ticket', '#1', '--stage', 'qa', '--level', '丙', '--text',
                'found in another round', by='qa')
        self.ledger = first
        self.assertIn('record what this acceptance found', self.fails(
            'done', str(mine), '--file', self.report(), by='qa'))
        self.ok('done', str(mine), '--file', self.report(), '--no-findings', by='qa')
        self.ok('cancel', str(other), '--reason', 'test row')
        # A reassigned row starts a new round: what the earlier round recorded no longer counts.
        again = self.started_row('qa', 'qa', evidence='file')
        self.at(10)
        self.ok('reassign', str(again), '--agent', 'qa', '--reason', 'relaunched')
        self.ok('start', str(again), '--eta', '+1h', by='qa')
        self.assertIn('record what this acceptance found', self.fails(
            'done', str(again), '--file', self.report(), by='qa'))
        self.ok('done', str(again), '--file', self.report(), '--no-findings', by='qa')
        self.assertTrue(self.item(again)['no_findings'])

    def test_impl_done_needs_a_review_result_of_its_current_round(self):
        impl = self.started_row('impl', 'impl')
        self.ok('review-result', '--row', str(impl), '--reviewer', 'rev', '--clean', by='impl')
        other = self.started_row('impl', 'impl2', ticket='#2')
        self.assertIn(f'review-result --row {other}', self.fails(
            'done', str(other), '--commit', self.merged, by='impl2'),
            "another row's review does not count")
        self.at(10)
        self.ok('reassign', str(impl), '--agent', 'impl2', '--reason', 'relaunched')
        self.ok('start', str(impl), '--eta', '+1h', by='impl2')
        error = self.fails('done', str(impl), '--commit', self.merged, by='impl2')
        self.assertIn("before the row's latest start does not count", error)
        self.assertEqual(self.item(impl)['status'], 'in_progress')
        self.assertIn('for acceptance (qa) rows', self.fails(
            'done', str(impl), '--commit', self.merged, '--no-findings', by='impl2'))
        self.ok('review-result', '--row', str(impl), '--reviewer', 'rev', '--finding',
                '丙:naming', by='impl2')
        self.ok('done', str(impl), '--commit', self.merged, by='impl2')

    def test_problems_after_merge_name_the_causing_ticket_or_unknown_and_count_after_deploy(self):
        impl = self.started_row('impl', 'impl')
        self.ok('review-result', '--row', str(impl), '--reviewer', 'rev', '--clean', by='impl')
        self.ok('done', str(impl), '--commit', self.merged, by='impl')
        self.assertIn('recorded by the orchestrator', self.fails(
            'problem', '--ticket', '#1', '--stage', 'post-deploy', '--level', '乙', '--text',
            'x', by='impl'))
        self.assertIn('only for problems found after merging', self.fails(
            'problem', '--ticket', '不明', '--stage', 'qa', '--level', '乙', '--text', 'x'))
        self.assertIn('no row of this ledger covers', self.fails(
            'problem', '--ticket', '#9', '--stage', 'qa', '--level', '乙', '--text', 'x'))
        self.ok('problem', '--ticket', '#1', '--stage', 'post-deploy-user', '--level', '乙',
                '--text', 'blank page after deploy', '--finder', 'user')
        # A ticket of an earlier round of the project is taken after merging.
        self.ok('problem', '--ticket', '#40', '--stage', 'post-deploy', '--level', '丙',
                '--text', 'old ticket broke', '--finder', 'user')
        self.ok('problem', '--ticket', '不明', '--stage', 'post-deploy-user', '--level', '甲',
                '--text', 'cause unknown', '--finder', 'user', '--caught', FP[:12])
        view = self.view()
        # The old ticket's problem was recorded through this ledger, so it counts here too.
        self.assertEqual([p['id'] for p in view['problems']], ['P1', 'P2', 'P3'])
        self.assertEqual(view['finding_summary'], [{
            'stage': 'review', 'label': '審查', 'count': 0,
            'levels': {'甲': 0, '乙': 0, '丙': 0}, 'caught': 0, 'severe': False}, {
            'stage': 'post-deploy-user', 'label': '上線後（使用者）', 'count': 2,
            'levels': {'甲': 1, '乙': 1, '丙': 0}, 'caught': 1, 'severe': True}, {
            'stage': 'post-deploy', 'label': '上線後（其他）', 'count': 1,
            'levels': {'甲': 0, '乙': 0, '丙': 1}, 'caught': 0, 'severe': False}])
        self.assertEqual(view['problems'][2]['gate'], FP)
        self.assertEqual([p['ticket'] for p in self.problems('--ticket', '不明')], ['不明'])
        self.assertIn('| 上線後（使用者） | 1 | 1 | 0 | 2 | 1 |', self.ok('show'))

    def test_ticket_lines_show_zero_for_done_stages_and_the_summary_counts_each_id_once(self):
        shared = self.started_row('impl', 'impl', ticket='#1,#2')
        self.assertIn('say which ticket', self.fails(
            'review-result', '--row', str(shared), '--reviewer', 'rev', '--finding', '乙:x',
            by='impl'))
        self.ok('review-result', '--row', str(shared), '--reviewer', 'rev', '--ticket', '#2',
                '--finding', '甲:wrong total', '--finding', '丙:typo', by='impl')
        self.ok('done', str(shared), '--commit', self.merged, by='impl')
        qa = self.started_row('qa', 'qa', ticket='#1', evidence='file')
        self.ok('done', str(qa), '--file', self.report(), '--no-findings', by='qa')
        view = self.view()
        lines = {t['key']: t['findings'] for t in view['tickets']}
        self.assertEqual(lines['#1']['text'], '審查 0・驗收 0')
        self.assertFalse(lines['#1']['severe'])
        self.assertEqual(lines['#2']['text'], '審查 2（甲 1）')
        self.assertTrue(lines['#2']['severe'])
        self.assertEqual([(e['stage'], e['count']) for e in view['finding_summary']],
                         [('review', 2), ('qa', 0)])
        self.assertEqual(len(view['problems']), 2)

    def test_corrections_need_a_reason_and_review_findings_stay_review_findings(self):
        qa = self.started_row('qa', 'qa', evidence='file')
        self.ok('problem', '--row', str(qa), '--stage', 'qa', '--level', '丙', '--text',
                'slow', by='qa')
        self.assertIn('needs --reason', self.fails('problem-update', 'P1', '--level', '乙',
                                                   by='qa'))
        self.assertIn('nothing to record', self.fails('problem-update', 'P1', by='qa'))
        self.assertIn('no problem P7', self.fails('problem-update', 'P7', '--known-limit'))
        self.assertIn('review-result', self.fails(
            'problem', '--ticket', '#1', '--stage', 'review', '--level', '乙', '--text', 'x'))
        self.ok('problem-update', '1', '--level', '乙', '--reason', 'it blocks the page',
                by='qa')
        self.ok('problem-update', 'P1', '--known-limit', by='qa')
        self.add(ticket='#2', stage='qa', evidence='file')
        self.assertIn('needs --reason', self.fails('problem-update', 'P1', '--ticket', '#2',
                                                   by='qa'))
        self.ok('problem-update', 'P1', '--ticket', '#2', '--reason', 'wrong ticket', by='qa')
        self.assertEqual(self.problems()[0]['ticket'], '#2')
        self.ok('problem-update', 'P1', '--ticket', '#1', '--reason', 'it was #1', by='qa')
        [problem] = self.problems()
        self.assertEqual((problem['level'], problem['resolution']),
                         ('乙', {'kind': 'known-limit'}))
        self.assertEqual(problem['history'][1]['changes'], {'level': '乙'})
        self.assertEqual(problem['resolution_text'], '列為已知限制')

    def test_candidate_counts_deliveries_of_the_tickets_impl_rows(self):
        impl = self.started_row('impl', 'impl')
        self.ok('review-result', '--row', str(impl), '--reviewer', 'rev', '--clean', by='impl')
        self.ok('done', str(impl), '--commit', self.merged, by='impl')
        qa = self.started_row('qa', 'qa', evidence='file')
        self.ok('problem', '--row', str(qa), '--stage', 'qa', '--level', '乙', '--text', 'a',
                by='qa')
        (self.workspace / 'fix.txt').write_text('fix\n')
        git(self.workspace, 'add', 'fix.txt')
        git(self.workspace, 'commit', '-q', '-m', 'fix')
        self.ok('amend', str(impl), '--commit', git(self.workspace, 'rev-parse', 'HEAD'),
                '--reason', 'fix', by='impl')
        self.ok('problem', '--row', str(qa), '--stage', 'qa', '--level', '丙', '--text', 'b',
                by='qa')
        self.assertEqual([p['candidate'] for p in self.problems()], [1, 2])

    def test_a_ledger_made_before_the_gates_closes_without_findings(self):
        doc = self.doc()
        del doc['problem_gates']
        self.ledger.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + '\n')
        self.ok('repair', '--reason', 'stands in for a ledger made before #549')
        impl = self.started_row('impl', 'impl')
        self.ok('done', str(impl), '--commit', self.merged, by='impl')
        self.assertEqual(self.view()['problems'], [])


class NameTests(LedgerCase):
    """Names are written as HCOM full names (#394); older base names still match."""

    def test_base_names_are_written_as_full_names(self):
        self.set_hcom('lead-orch', 'team-impl', 'team-impl2')
        self.init()
        item = self.add()
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(self.card()))
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
        error = self.fails('assign', str(item), '--agent', 'impl', '--card', str(self.card()))
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
                str(self.card()), by='')
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


class RoundTests(LedgerCase):
    """`add` refuses an earlier round's `<session>-r<N>.json` when the session record names
    another ledger; other commands and other ledgers are untouched."""

    def setUp(self):
        super().setUp()
        ledgers = self.ledger.parent
        self.r1, self.r2 = ledgers / 'sid-r1.json', ledgers / 'sid-r2.json'
        for path in (self.r1, self.r2):
            self.ledger = path
            self.init()
        self.ledger = self.r1
        self.session = self.workspace / '.lat' / 'sessions' / 'sid.json'

    def record(self, ledger_path):
        self.session.parent.mkdir(exist_ok=True)
        self.session.write_text(json.dumps({'status': 'active', 'ledger_path': str(ledger_path)}))

    def snapshot(self):
        return [path.read_bytes() for path in (self.r1, self.r1.with_name('sid-r1.json.seal'),
                                               self.r1.with_name('sid-r1.json.journal.jsonl'))]

    def test_add_to_an_earlier_round_is_refused_and_writes_nothing(self):
        self.record(self.r2)
        before = self.snapshot()
        error = self.fails('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'commit')
        self.assertIn(str(self.r2), error)
        self.assertIn('--old-round', error)
        self.assertEqual(self.snapshot(), before)

    def test_old_round_adds_to_the_earlier_round(self):
        self.record(self.r2)
        self.assertEqual(self.add('--old-round'), 1)
        self.assertEqual(self.item(1)['ticket'], '#1')

    def test_current_round_other_names_and_missing_records_add_as_before(self):
        self.record(self.r2)
        self.ledger = self.r2
        self.assertEqual(self.add(), 1)
        self.ledger = self.r1.with_name('round-1.json')
        self.init()
        self.assertEqual(self.add(), 1)
        self.ledger = self.r1
        self.session.unlink()
        self.assertEqual(self.add(), 1)
        self.record('')
        self.assertEqual(self.add(), 2)

    def test_rows_already_on_an_earlier_round_keep_working(self):
        item = self.add(evidence='file')
        self.exempt_qa()
        self.record(self.r2)
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(self.card()))
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        self.ok('update', str(item), '--progress', 'half', by='impl')
        report = self.root / 'report.md'
        report.write_text('done\n')
        self.ok('done', str(item), '--file', str(report), by='impl')
        self.ok('amend', str(item), '--reason', 'rechecked', '--file', str(report), by='impl')
        self.ok('check')
        self.assertEqual(self.item(item)['status'], 'done')



class TinyLaneTests(LedgerCase):
    """The tiny-change lane mark on `add` and the reviewer's four-limit confirmation."""
    TINY = ('--tiny', '--no-feature', '--no-format-change')

    def setUp(self):
        super().setUp()
        self.init()

    def tiny_row(self, agent='impl'):
        git(self.workspace, 'switch', '-q', '-c', 'work')  # dev is the integration branch
        item = self.add(*self.TINY)
        card = self.tasks / f'tiny-{item}.md'
        card.write_text(f'接續：無\n\n- agent：{agent}\n- base commit：{self.merged[:8]}\n'
                        f'- worktree：{self.workspace}\n- status：dispatched\n')
        self.ok('assign', str(item), '--agent', agent, '--card', str(card))
        return item

    def change(self, path, lines, message):
        target = self.workspace / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(''.join(f'line {n}\n' for n in range(lines)))
        git(self.workspace, 'add', path)
        git(self.workspace, 'commit', '-q', '-m', message)

    def confirm(self, item, *extra):
        return self.run_ledger('review-result', '--row', str(item), '--reviewer', 'a', '--clean',
                               '--tiny-confirm', *extra, by='impl')

    def test_the_mark_reaches_every_row_of_the_ticket_and_only_one_ticket(self):
        first = self.add(ticket='#1', stage='qa-draft', evidence='file')
        tiny = self.add(*self.TINY)
        later = self.add(ticket='#1', stage='qa', evidence='file')
        other = self.add(ticket='#2')
        marks = {item: self.item(item).get('tiny') for item in (first, tiny, later, other)}
        self.assertEqual(marks[tiny]['declared'], ['no-feature', 'no-format-change'])
        self.assertEqual((marks[first], marks[later], marks[other]),
                         (marks[tiny], marks[tiny], None))
        self.assertEqual(self.item(first)['history'][-1]['action'], 'tiny')
        before = self.ledger.read_bytes()
        self.assertIn('exactly one numbered ticket',
                      self.fails('add', '--ticket', '#1, #3', '--stage', 'impl',
                                 '--evidence', 'commit', *self.TINY))
        self.assertIn('both declarations', self.fails('add', '--ticket', '#3', '--stage', 'impl',
                                                      '--evidence', 'commit', '--tiny'))
        self.assertEqual(self.ledger.read_bytes(), before)
        shown = json.loads(self.ok('show', '--json'))
        self.assertEqual({t['key']: t['tiny'] for t in shown['tickets']}, {'#1': True, '#2': False})
        self.assertIn('（小改動）', self.ok('show'))

    def test_tiny_off_returns_the_ticket_to_the_normal_flow(self):
        tiny = self.add(*self.TINY)
        self.ok('cancel', str(tiny), '--reason', 'over the limit')
        self.assertIn('only the orchestrator', self.fails('tiny-off', str(tiny), '--reason', 'x',
                                                          by='impl'))
        self.assertIn('rows 1', self.ok('tiny-off', str(tiny), '--reason', 'over the limit'))
        self.assertNotIn('tiny', self.item(tiny))
        self.assertEqual(self.item(tiny)['history'][-1]['action'], 'tiny-off')
        again = self.add()
        self.assertNotIn('tiny', self.item(again), 'the ordinary re-dispatch has no mark')
        self.assertIn('not on the tiny lane', self.fails('tiny-off', str(again), '--reason', 'x'))

    def test_confirmation_runs_the_check_and_must_answer_its_hints(self):
        item = self.tiny_row()
        self.change('db/schema.sql', 2, 'fix: keep the column')
        before = self.ledger.read_bytes()
        result = self.confirm(item)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--tiny-hints: data/format file db/schema.sql (pattern *schema*)',
                      result.stderr)
        self.assertEqual(self.ledger.read_bytes(), before)
        result = self.confirm(item, '--tiny-hints', 'schema.sql only reorders comments')
        self.assertEqual(result.returncode, 0, result.stderr)
        tiny = self.doc()['reviews'][-1]['tiny']
        self.assertEqual((tiny['limits'], tiny['commit'], tiny['code_added'], tiny['hints_note']),
                         (['one-ticket', 'code-lines', 'no-feature', 'no-format-change'],
                          git(self.workspace, 'rev-parse', 'HEAD'), 2,
                          'schema.sql only reorders comments'))
        self.assertEqual(tiny['hints'], ['data/format file db/schema.sql (pattern *schema*)'])
        self.assertRegex(tiny['content'], r'^[0-9a-f]{64}$')

    def test_confirmation_refusals_write_nothing(self):
        plain = self.add(ticket='#2')
        item = self.tiny_row(agent='orch')
        before = self.ledger.read_bytes()
        self.assertIn('not on the tiny lane', self.confirm(plain).stderr)
        self.assertIn('goes with --tiny-confirm', self.run_ledger(
            'review-result', '--row', str(item), '--reviewer', 'a', '--clean',
            '--tiny-hints', 'x').stderr)
        self.assertIn('under the orchestrator orch itself', self.confirm(item).stderr)
        self.change('src/big.py', 31, 'fix: big')
        refused = self.confirm(item).stderr
        self.assertIn('31 added code lines', refused)
        self.assertIn('return to the normal flow', refused)
        self.assertEqual(self.ledger.read_bytes(), before)

    def docs_row(self, evidence='commit,gate', path='docs/note.md'):
        """A tiny impl row whose work is one docs file, reviewed and confirmed but not closed."""
        git(self.workspace, 'switch', '-q', '-c', 'work')
        item = self.add(*self.TINY, '--branch', 'work', evidence=evidence)
        card = self.tasks / f'tiny-{item}.md'
        card.write_text(f'接續：無\n\n- agent：impl\n- base commit：{self.merged[:8]}\n'
                        f'- worktree：{self.workspace}\n- status：dispatched\n')
        self.ok('assign', str(item), '--agent', 'impl', '--card', str(card))
        self.ok('start', str(item), '--eta', '+1h', by='impl')
        self.change(path, 3, 'docs: note')
        return item

    def close(self, item, *extra):
        self.ok('done', str(item), '--commit', git(self.workspace, 'rev-parse', 'HEAD'),
                *extra, by='impl')

    def test_a_tiny_docs_ticket_passes_with_review_and_gate_and_no_qa_row(self):
        item = self.docs_row()
        self.confirm(item)
        self.close(item, '--gate', FP)
        self.assertEqual(self.doc()['reviews'][-1]['tiny']['files'],
                         {'code': 0, 'test': 0, 'doc': 1})
        self.assertIn('ledger check: OK', self.ok('check'))

    def test_a_tiny_docs_ticket_names_each_missing_piece(self):
        item = self.docs_row()
        self.close(item, '--gate', FP)
        missing = self.run_ledger('check')
        self.assertEqual(missing.returncode, 1)
        self.assertIn('no review result with the four-limit confirmation', missing.stdout)
        self.assertIn('no qa-draft or qa item covers it', missing.stdout)  # not yet known docs-only
        self.confirm(item)
        self.assertIn('ledger check: OK', self.ok('check'))

    def test_a_tiny_docs_ticket_without_test_evidence_is_refused(self):
        item = self.docs_row(evidence='commit')
        self.confirm(item)
        self.close(item)
        out = self.run_ledger('check')
        self.assertEqual(out.returncode, 1)
        self.assertIn('no test evidence', out.stdout)
        self.assertNotIn('no qa-draft', out.stdout)

    def test_a_tiny_code_ticket_needs_a_handson_file_and_still_a_qa_row(self):
        item = self.docs_row(path='src/refactor.py')  # even a pure refactor is code
        shot = self.root / 'handson.log'
        shot.write_text('ran it once\n')
        self.assertIn('absolute path', self.confirm(item, '--handson', 'handson.log').stderr)
        self.assertIn('does not exist', self.confirm(item, '--handson', str(self.root / 'no')).stderr)
        self.confirm(item)
        self.close(item, '--gate', FP)
        out = self.run_ledger('check').stdout
        self.assertIn('code touched: the reviewer must attach a hands-on evidence file', out)
        self.assertIn('no qa-draft or qa item covers it', out)
        result = self.confirm(item, '--handson', str(shot))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.doc()['reviews'][-1]['tiny']['handson'], [str(shot)])
        out = self.run_ledger('check').stdout
        self.assertNotIn('code touched', out)
        self.assertIn('no qa-draft or qa item covers it', out)
        self.exempt_qa()
        self.assertIn('ledger check: OK', self.ok('check'))

    def test_a_deleted_handson_file_fails_check_again(self):
        item = self.docs_row(path='src/a.py')
        shot = self.root / 'handson.log'
        shot.write_text('x\n')
        self.confirm(item, '--handson', str(shot))
        self.close(item, '--gate', FP)
        self.exempt_qa()
        self.ok('check')
        shot.unlink()
        self.assertIn('code touched', self.run_ledger('check').stdout)

    def test_a_non_tiny_ticket_is_unchanged(self):
        item = self.started(evidence='commit')
        self.ok('review-result', '--row', str(item), '--reviewer', 'a', '--clean')
        self.ok('done', str(item), '--commit', self.merged, by='impl')
        out = self.run_ledger('check')
        self.assertEqual(out.returncode, 1)
        self.assertIn('no qa-draft or qa item covers it', out.stdout)
        self.assertNotIn('tiny', out.stdout)

    def test_a_later_docs_row_does_not_exempt_an_earlier_code_row(self):
        code = self.docs_row(path='src/a.py')
        self.confirm(code)
        self.close(code, '--gate', FP)
        docs = self.add(*self.TINY, '--branch', 'work', evidence='commit,gate')
        card = self.tasks / f'tiny-{docs}.md'
        card.write_text(f'接續：無\n\n- agent：impl\n- base commit：{self.merged[:8]}\n'
                        f'- worktree：{self.workspace}\n- status：dispatched\n')
        self.ok('assign', str(docs), '--agent', 'impl', '--card', str(card))
        self.change('docs/b.md', 2, 'docs: b')
        self.confirm(docs)
        out = self.run_ledger('check').stdout
        self.assertIn('no qa-draft or qa item covers it', out)
        self.assertIn('code touched', out)


if __name__ == '__main__':
    unittest.main()
