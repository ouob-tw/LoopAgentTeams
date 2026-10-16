"""Same-file cleanup contracts; only disposable files and fake Herdr are used."""
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_lat_panel import MODULE, load_module


class CleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.questions = self.root / 'questions-own.md'
        self.decisions = self.root / 'decisions'
        self.decisions.mkdir()
        self.panel = load_module()
        # Question commands look up the sidebar binding; keep that lookup off the real Herdr.
        environment = patch.dict(os.environ, HERDR_PLUGIN_CONFIG_DIR=str(self.root / 'plugin-config'))
        environment.start()
        self.addCleanup(environment.stop)

    def test_upsert_immediately_archives_hash_verified_recorded_question(self):
        self.questions.write_text('## Old?\nOLD · r1 · 待答\n\n答覆：A\n\n- [x] 送出\n')
        old = self.panel.parse_questions(self.questions.read_text())[0]
        self.panel.set_question_status(
            self.questions, 'OLD', 1, 'recorded',
            self.panel.question_section_sha256(old),
        )
        recorded = self.questions.read_text()
        source = self.root / 'new.md'
        source.write_text('## New?\n\nA. Yes\n')
        result = subprocess.run(
            [sys.executable, str(MODULE), 'question', 'upsert', '--questions', str(self.questions),
             '--decisions', str(self.decisions), '--id', 'NEW', '--file', str(source)],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'NEW r1')
        self.assertNotIn('OLD ·', self.questions.read_text())
        self.assertEqual((self.root / 'questions-own-archive.md').read_text(), recorded)
        journal = [json.loads(line) for line in (self.root / 'panel-journal.jsonl').read_text().splitlines()]
        self.assertEqual(journal[-2]['kind'], 'cleanup')
        self.assertEqual(journal[-2]['archived'], [{'id': 'OLD', 'reason': 'recorded'}])

    def test_upsert_cleans_only_resolved_unsubmitted_questions_and_keeps_original_text(self):
        cases = {
            'RESOLVED': ('- Status: ANSWERED\n', '- [ ] 送出'),
            'PENDING': ('- status: pending\n', '- [ ] 送出'),
            'MISSING': (None, '- [ ] 送出'),
            'UNREADABLE': ('# no status\n', '- [ ] 送出'),
            'BADUTF8': (b'\xff', '- [ ] 送出'),
            'SUBMITTED': ('- status: answered\n', '- [X] 送出'),
            'MALFORMED': ('- status: answered\n', '- [x] 送出'),
            'SAME': ('- status: answered\n', '- [ ] 送出'),
        }
        sections = {}
        for identifier, (decision, submit) in cases.items():
            answer = 'missing marker' if identifier == 'MALFORMED' else '答覆：draft'
            sections[identifier] = f'## {identifier}?\n{identifier} · r3 · 待答\n\nA. Yes\n\n{answer}\n\n{submit}\n\n'
            if decision is not None:
                (self.decisions / f'{identifier}.md').write_bytes(
                    decision if isinstance(decision, bytes) else decision.encode())
        self.questions.write_text('# Questions\n\n' + ''.join(sections.values()))
        sibling = self.root / 'questions-other.md'
        sibling.write_text(sections['RESOLVED'])
        self.panel.upsert_question(self.questions, 'SAME', '## Revised?\n\nB. No\n', decisions_path=self.decisions)
        actual = self.questions.read_text()
        self.assertNotIn('RESOLVED ·', actual)
        for identifier in cases.keys() - {'RESOLVED', 'SAME'}:
            self.assertIn(sections[identifier], actual)
        self.assertIn('SAME · r4 · 待答', actual)
        self.assertIn('### 舊版 r3', actual)
        self.assertTrue(actual.startswith('# Questions\n\n'))
        self.assertEqual((self.root / 'questions-own-archive.md').read_text(), sections['RESOLVED'])
        self.assertEqual(sibling.read_text(), sections['RESOLVED'])
        cleanup = json.loads((self.root / 'panel-journal.jsonl').read_text().splitlines()[-2])
        self.assertEqual(cleanup['archived'], [{'id': 'RESOLVED', 'reason': 'decision-not-pending'}])
        self.assertEqual({item['id']: item['reason'] for item in cleanup['kept']}, {
            'PENDING': 'pending', 'MISSING': 'missing-decision',
            'UNREADABLE': 'unreadable-decision', 'BADUTF8': 'unreadable-decision',
            'SUBMITTED': 'submitted-not-recorded', 'MALFORMED': 'submitted-not-recorded',
            'SAME': 'same-id',
        })

    def test_cleanup_cli_reports_moves_and_kept_questions_and_is_repeatable(self):
        raw = '## Done?\nDONE · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'
        legacy = '## Legacy?\nLEGACY · r1 · 已記錄\n\n答覆：A\n\n- [x] 送出\n'
        self.questions.write_text(raw + legacy)
        (self.decisions / 'DONE.md').write_text('- status: resolved\n')
        command = [sys.executable, str(MODULE), 'question', 'cleanup',
                   '--questions', str(self.questions), '--decisions', str(self.decisions)]
        result = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            'archived': [{'id': 'DONE', 'reason': 'decision-not-pending'}],
            'kept': [{'id': 'LEGACY', 'reason': 'unverified-recorded'}],
        })
        again = subprocess.run(command, text=True, capture_output=True)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)['archived'], [])
        self.assertEqual(self.questions.read_text(), legacy)
        self.assertEqual((self.root / 'questions-own-archive.md').read_text(), raw)
        self.assertEqual(len((self.root / 'panel-journal.jsonl').read_text().splitlines()), 2)

    def test_cleanup_refuses_concurrent_modification_without_archive_or_journal(self):
        snapshot = '## Done?\nDONE · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n'
        changed = snapshot.replace('答覆：', '答覆：new answer')
        self.questions.write_text(changed)
        (self.decisions / 'DONE.md').write_text('- status: resolved\n')
        with self.assertRaisesRegex(ValueError, 'questions changed'):
            self.panel.cleanup_questions(self.questions, self.decisions, expected_text=snapshot)
        self.assertEqual(self.questions.read_text(), changed)
        self.assertFalse((self.root / 'questions-own-archive.md').exists())
        self.assertFalse((self.root / 'panel-journal.jsonl').exists())

    def test_missing_decisions_argument_and_directory_refuse_without_mutation(self):
        source = self.root / 'section.md'
        source.write_text('## New?\n\nA. Yes\n')
        self.questions.write_text('original\n')
        for command in ('upsert', 'cleanup'):
            args = [sys.executable, str(MODULE), 'question', command,
                    '--questions', str(self.questions)]
            if command == 'upsert':
                args += ['--id', 'NEW', '--file', str(source)]
            missing = subprocess.run(args, text=True, capture_output=True)
            self.assertEqual(missing.returncode, 2)
            self.assertIn('--decisions', missing.stderr)
            invalid = subprocess.run(args + ['--decisions', str(self.root / 'absent')],
                                     text=True, capture_output=True)
            self.assertEqual(invalid.returncode, 1)
            self.assertIn('decisions directory does not exist', invalid.stderr)
            self.assertEqual(self.questions.read_text(), 'original\n')
        self.assertFalse((self.root / 'panel-journal.jsonl').exists())

    def test_cleanup_keeps_modified_recorded_and_upsert_keeps_recorded_same_id(self):
        original = '## Old?\nOLD · r1 · 待答\n\nA. Yes\n\n答覆：A\n\n- [x] 送出\n'
        self.questions.write_text(original)
        old = self.panel.parse_questions(original)[0]
        self.panel.set_question_status(self.questions, 'OLD', 1, 'recorded',
                                       self.panel.question_section_sha256(old))
        recorded = self.questions.read_text()
        revision = self.panel.upsert_question(self.questions, 'OLD', '## Old?\n\nA. Yes\n',
                                             decisions_path=self.decisions)
        self.assertEqual(revision, 1)
        self.assertEqual(self.questions.read_text(), recorded)
        self.assertFalse((self.root / 'questions-own-archive.md').exists())
        changed = recorded.replace('答覆：A', '答覆：B')
        self.questions.write_text(changed)
        result = self.panel.cleanup_questions(self.questions, self.decisions)
        self.assertEqual(result['archived'], [])
        self.assertEqual(result['kept'], [{'id': 'OLD', 'reason': 'unverified-recorded'}])
        self.assertEqual(self.questions.read_text(), changed)
        revision = self.panel.upsert_question(self.questions, 'OLD', '## Changed?\n\nB. No\n',
                                             decisions_path=self.decisions)
        self.assertEqual(revision, 2)
        self.assertIn('OLD · r2 · 待答', self.questions.read_text())
        self.assertIn('答覆：B', self.questions.read_text())

    def test_cleanup_preserves_crlf_bytes_and_does_not_expire_pending_questions(self):
        stale = b'## Old?\r\nOLD \xc2\xb7 r1 \xc2\xb7 ' + '待答\r\n\r\n答覆：\r\n\r\n- [ ] 送出\r\n\r\n'.encode()
        pending = stale.replace(b'OLD', b'PENDING')
        self.questions.write_bytes(stale + pending)
        (self.decisions / 'OLD.md').write_text('- status: answered\n')
        (self.decisions / 'PENDING.md').write_text('- status: pending\n- created: 2000-01-01\n')
        result = self.panel.cleanup_questions(self.questions, self.decisions)
        self.assertEqual(result['archived'], [{'id': 'OLD', 'reason': 'decision-not-pending'}])
        self.assertEqual(self.questions.read_bytes(), pending)
        self.assertEqual((self.root / 'questions-own-archive.md').read_bytes(), stale)

    def test_cleanup_does_not_deduplicate_against_normalized_archive_text(self):
        raw = '## Old?\nOLD · r1 · 待答\n\n答覆：\n\n- [ ] 送出\n\n'.encode()
        archived_crlf = raw.replace(b'\n', b'\r\n')
        archive = self.root / 'questions-own-archive.md'
        archive.write_bytes(archived_crlf)
        self.questions.write_bytes(raw)
        (self.decisions / 'OLD.md').write_text('- status: answered\n')

        result = self.panel.cleanup_questions(self.questions, self.decisions)

        self.assertEqual(result['archived'], [{'id': 'OLD', 'reason': 'decision-not-pending'}])
        self.assertEqual(self.questions.read_bytes(), b'')
        self.assertTrue(archive.read_bytes().startswith(archived_crlf))
        self.assertIn(raw, archive.read_bytes())
