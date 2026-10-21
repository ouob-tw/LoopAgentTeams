"""Stop-hook activation check: a conversation started with the LAT skill must activate.

Fixtures ``*-stop.json``, ``claude-lat-command.jsonl`` and ``codex-lat-skill.jsonl`` are
scrubbed captures from real Claude Code 2.1.301 and codex-cli 0.162.1 sessions.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-session.py'
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
SESSION = '33333333-3333-4333-8333-333333333333'


def claude_tool_use(name, **tool_input):
    """One assistant record in the shape Claude writes for a tool call."""
    return dict(type='assistant', isSidechain=False, sessionId=SESSION, message=dict(
        role='assistant', type='message', content=[dict(
            type='tool_use', id='toolu_test', name=name, input=tool_input,
            caller=dict(type='direct'))]))


def claude_tool_result(text):
    return dict(type='user', isSidechain=False, sessionId=SESSION, message=dict(
        role='user', content=[dict(type='tool_result', tool_use_id='toolu_test',
                                   content=text)]))


def codex_message(role, text):
    kind = 'input_text' if role == 'user' else 'output_text'
    return dict(type='response_item', payload=dict(
        type='message', role=role, content=[dict(type=kind, text=text)]))


SKILL_TEXT = '---\nname: lat\ndescription: LAT\n---\n<command-name>/lat</command-name>\n'


class ActivationCheckTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.work = self.root / 'work'
        (self.work / '.git').mkdir(parents=True)
        self.claude_home = self.root / 'claude-home'
        self.codex_home = self.root / 'codex-home'
        self.reports = self.root / 'reports'
        self.state = self.root / 'state'

    def write_transcript(self, records, name='transcript.jsonl'):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(
            (record if isinstance(record, str) else json.dumps(record)) + '\n'
            for record in records))
        return path

    def fixture_records(self, name):
        return FIXTURES.joinpath(name).read_text().splitlines()

    def payload(self, client, transcript=None, **overrides):
        payload = json.loads(FIXTURES.joinpath(f'{client}-stop.json').read_text())
        payload.update(session_id=SESSION, cwd=str(self.work))
        if transcript is None:
            payload.pop('transcript_path')
        else:
            payload['transcript_path'] = str(transcript)
        payload.update(overrides)
        return payload

    def run_hook(self, client, payload, launched_by=None):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=str(self.claude_home),
                   CODEX_HOME=str(self.codex_home), LAT_REPORTS_DIR=str(self.reports),
                   XDG_STATE_HOME=str(self.state))
        env.pop('HCOM_LAUNCHED_BY', None)
        if launched_by is not None:
            env['HCOM_LAUNCHED_BY'] = launched_by
        args = ['hook'] + (['--client', 'claude'] if client == 'claude' else [])
        return subprocess.run([sys.executable, str(SCRIPT), *args], input=json.dumps(payload),
                              text=True, capture_output=True, env=env, cwd=self.work)

    def assert_blocked(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(set(output), {'decision', 'reason'})
        self.assertEqual(output['decision'], 'block')
        self.assertIn('activate', output['reason'])
        self.assertIn('references/recovery.md', output['reason'])
        self.assertIn('說明原因', output['reason'])

    def assert_released(self, result):
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))

    def claude_command_transcript(self):
        return self.write_transcript(self.fixture_records('claude-lat-command.jsonl'), 'claude.jsonl')

    def codex_skill_transcript(self):
        return self.write_transcript(self.fixture_records('codex-lat-skill.jsonl'), 'codex.jsonl')

    def test_claude_lat_command_blocks(self):
        self.assert_blocked(self.run_hook('claude', self.payload(
            'claude', self.claude_command_transcript())))

    def test_claude_skill_tool_blocks_with_or_without_namespace(self):
        for skill in ('lat', 'matt-skills:lat'):
            with self.subTest(skill=skill):
                transcript = self.write_transcript([claude_tool_use('Skill', skill=skill)])
                self.assert_blocked(self.run_hook('claude', self.payload('claude', transcript)))

    def test_claude_other_skills_and_commands_do_not_block(self):
        transcript = self.write_transcript([
            claude_tool_use('Skill', skill='implement'),
            claude_tool_use('Skill', skill='lat-extra'),
            dict(type='user', sessionId=SESSION, message=dict(role='user', content=(
                '<command-message>latte</command-message>\n'
                '<command-name>/latte</command-name>'))),
        ])
        self.assert_released(self.run_hook('claude', self.payload('claude', transcript)))

    def test_codex_injected_skill_blocks(self):
        self.assert_blocked(self.run_hook('codex', self.payload(
            'codex', self.codex_skill_transcript())))

    def test_no_invocation_does_not_block(self):
        claude = self.write_transcript([
            dict(type='user', sessionId=SESSION, message=dict(role='user', content='hello')),
            dict(type='assistant', sessionId=SESSION, message=dict(role='assistant', content=[
                dict(type='text', text='hi')]))], 'claude.jsonl')
        codex = self.write_transcript([
            codex_message('user', '$lat'), codex_message('assistant', 'hi')], 'codex.jsonl')
        self.assert_released(self.run_hook('claude', self.payload('claude', claude)))
        self.assert_released(self.run_hook('codex', self.payload('codex', codex)))

    def test_reading_skill_file_does_not_block(self):
        skill_file = '/home/user/.agents/skills/lat/SKILL.md'
        claude = self.write_transcript([
            claude_tool_use('Read', file_path=skill_file),
            claude_tool_result(SKILL_TEXT),
            claude_tool_use('Bash', command=f'cat {skill_file}'),
            claude_tool_result(SKILL_TEXT)], 'claude.jsonl')
        codex = self.write_transcript([
            dict(type='response_item', payload=dict(
                type='function_call', name='exec_command',
                arguments=json.dumps(dict(cmd=f'cat {skill_file}')))),
            dict(type='response_item', payload=dict(
                type='function_call_output', output='<skill>\n<name>lat</name>\n' + SKILL_TEXT)),
        ], 'codex.jsonl')
        self.assert_released(self.run_hook('claude', self.payload('claude', claude)))
        self.assert_released(self.run_hook('codex', self.payload('codex', codex)))

    def test_existing_session_record_in_any_status_does_not_block(self):
        record = self.work / '.lat/sessions' / f'{SESSION}.json'
        record.parent.mkdir(parents=True)
        transcripts = dict(claude=self.claude_command_transcript(),
                           codex=self.codex_skill_transcript())
        for content in ('completed', 'cancelled', 'active', None):
            for client in ('claude', 'codex'):
                with self.subTest(status=content, client=client):
                    record.write_text('{broken' if content is None else json.dumps(dict(
                        client=client, session_id=SESSION, role='orchestrator',
                        workspace=str(self.work), status=content)))
                    result = self.run_hook(client, self.payload(client, transcripts[client]))
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertNotIn('block', result.stdout)

    def test_outside_git_does_not_block(self):
        bases = [Path(base) for base in ('/dev/shm', tempfile.gettempdir(), Path.home())]
        base = next((base for base in bases if base.is_dir() and not any(
            (path / '.git').exists() for path in (base, *base.parents))), None)
        if base is None:
            self.skipTest('every candidate directory is inside a Git project')
        temp = tempfile.TemporaryDirectory(dir=base)
        self.addCleanup(temp.cleanup)
        outside = Path(temp.name)
        for client, transcript in (('claude', self.claude_command_transcript()),
                                   ('codex', self.codex_skill_transcript())):
            with self.subTest(client=client):
                self.assert_released(self.run_hook(client, self.payload(
                    client, transcript, cwd=str(outside))))

    def test_launched_by_agent_does_not_block_but_user_does(self):
        for client, transcript in (('claude', self.claude_command_transcript()),
                                   ('codex', self.codex_skill_transcript())):
            with self.subTest(client=client):
                payload = self.payload(client, transcript)
                self.assert_released(self.run_hook(client, payload, launched_by='zelo'))
                self.assert_blocked(self.run_hook(client, payload, launched_by='user'))
                self.assert_blocked(self.run_hook(client, payload, launched_by=''))

    def test_stop_hook_active_does_not_block(self):
        for client, transcript in (('claude', self.claude_command_transcript()),
                                   ('codex', self.codex_skill_transcript())):
            with self.subTest(client=client):
                self.assert_released(self.run_hook(client, self.payload(
                    client, transcript, stop_hook_active=True)))

    def test_missing_transcript_path_falls_back_to_session_lookup(self):
        claude = self.claude_home / 'projects/-work' / f'{SESSION}.jsonl'
        claude.parent.mkdir(parents=True)
        claude.write_text(FIXTURES.joinpath('claude-lat-command.jsonl').read_text())
        codex = self.codex_home / f'sessions/2026/10/16/rollout-2026-10-16T18-12-03-{SESSION}.jsonl'
        codex.parent.mkdir(parents=True)
        codex.write_text(FIXTURES.joinpath('codex-lat-skill.jsonl').read_text())
        self.assert_blocked(self.run_hook('claude', self.payload('claude')))
        self.assert_blocked(self.run_hook('codex', self.payload('codex')))

    def test_unreadable_transcript_warns_without_blocking(self):
        directory = self.root / 'a-directory.jsonl'
        directory.mkdir()
        binary = self.root / 'binary.jsonl'
        binary.write_bytes(b'\xff\xfe\x00')
        garbage = self.write_transcript(['not json', '[1, 2]'], 'garbage.jsonl')
        unrelated = self.write_transcript([{'unrelated': 'not a client transcript record'}],
                                          'unrelated.jsonl')
        for client in ('claude', 'codex'):
            cases = dict(missing_path=self.payload(client, self.root / 'missing.jsonl'),
                         directory=self.payload(client, directory),
                         binary=self.payload(client, binary),
                         no_records=self.payload(client, garbage),
                         other_format=self.payload(client, unrelated),
                         other_client=self.payload(client, self.codex_skill_transcript()
                                                   if client == 'claude' else
                                                   self.claude_command_transcript()),
                         lookup_fails=self.payload(client),
                         relative=self.payload(client, 'relative.jsonl'))
            for case, payload in cases.items():
                with self.subTest(client=client, case=case):
                    result = self.run_hook(client, payload)
                    self.assertEqual((result.returncode, result.stdout), (0, ''))
                    self.assertIn('LAT activation check warning:', result.stderr)

    def test_partial_lines_are_skipped(self):
        records = self.fixture_records('codex-lat-skill.jsonl')
        transcript = self.write_transcript(['{"type": "resp', *records, '{"partial'])
        self.assert_blocked(self.run_hook('codex', self.payload('codex', transcript)))

    # The scan position is remembered per session, so each Stop reads only new bytes.
    def user_line(self, text):
        return json.dumps(dict(type='user', sessionId=SESSION,
                               message=dict(role='user', content=text)))

    def lat_line(self, length):
        """A /lat command line and a plain line of exactly the same byte length."""
        command = '<command-name>/lat</command-name>'
        return (self.user_line(command + 'a' * (length - len(command))),
                self.user_line('a' * length))

    def state_file(self, client='claude'):
        return self.state / f'lat/activation/{client}-{SESSION}.json'

    def append(self, path, text):
        with path.open('a') as stream:
            stream.write(text)

    def test_second_stop_reads_only_new_bytes(self):
        lat, plain = self.lat_line(60)
        transcript = self.write_transcript([plain, self.user_line('hi')])
        payload = self.payload('claude', transcript)
        self.assert_released(self.run_hook('claude', payload))
        self.assertEqual(json.loads(self.state_file().read_text())['offset'],
                         transcript.stat().st_size)
        # Swap the scanned first line for a /lat one without changing size or inode.
        with transcript.open('r+b') as stream:
            stream.write(lat.encode())
        self.assert_released(self.run_hook('claude', payload))
        self.assert_blocked(self.run_hook('claude', self.payload(
            'claude', self.claude_command_transcript())))

    def test_lat_invoked_after_first_stop_blocks_next_stop(self):
        transcript = self.write_transcript([self.user_line('hello')])
        payload = self.payload('claude', transcript)
        self.assert_released(self.run_hook('claude', payload))
        self.append(transcript, self.user_line('<command-name>/lat</command-name>') + '\n')
        self.assert_blocked(self.run_hook('claude', payload))
        # A block records no position, so the hook keeps blocking until activated.
        self.assert_blocked(self.run_hook('claude', payload))

    def test_replaced_or_shortened_transcript_is_rescanned(self):
        lat, plain = self.lat_line(60)
        transcript = self.write_transcript([plain, self.user_line('x' * 200)])
        payload = self.payload('claude', transcript)
        self.assert_released(self.run_hook('claude', payload))
        # Shorter file whose first line invokes LAT.
        transcript.write_text(lat + '\n')
        self.assert_blocked(self.run_hook('claude', payload))
        # A different file at the same path (new inode) of larger size.
        self.assert_released(self.run_hook('claude', self.payload(
            'claude', self.write_transcript([plain], 'other.jsonl'))))
        replacement = self.root / 'replacement.jsonl'
        replacement.write_text(plain + '\n' + lat + '\n' + 'z' * 500 + '\n')
        os.replace(replacement, self.root / 'other.jsonl')
        self.assert_blocked(self.run_hook('claude', self.payload(
            'claude', self.root / 'other.jsonl')))

    def test_half_written_last_line_is_read_once_completed(self):
        line = self.user_line('<command-name>/lat</command-name>')
        transcript = self.write_transcript([self.user_line('hello')])
        self.append(transcript, line[:30])
        payload = self.payload('claude', transcript)
        self.assert_released(self.run_hook('claude', payload))
        recorded = json.loads(self.state_file().read_text())['offset']
        self.assertEqual(recorded, len(self.user_line('hello')) + 1)
        self.append(transcript, line[30:] + '\n')
        self.assert_blocked(self.run_hook('claude', payload))

    def test_codex_position_is_kept_per_client_and_session(self):
        transcript = self.write_transcript([codex_message('user', 'hi')])
        self.assert_released(self.run_hook('codex', self.payload('codex', transcript)))
        self.assertTrue(self.state_file('codex').is_file())
        self.assertFalse(self.state_file('claude').exists())

    def test_unwritable_state_dir_gives_same_result_with_one_warning(self):
        self.state.write_text('a file, not a directory')
        transcript = self.write_transcript([self.user_line('hello')])
        result = self.run_hook('claude', self.payload('claude', transcript))
        self.assertEqual((result.returncode, result.stdout), (0, ''))
        self.assertEqual(len(result.stderr.strip().splitlines()), 1)
        self.assertIn('LAT activation check warning:', result.stderr)
        self.assert_blocked(self.run_hook('claude', self.payload(
            'claude', self.claude_command_transcript())))

    def test_stale_position_files_are_removed_at_most_daily(self):
        directory = self.state / 'lat/activation'
        directory.mkdir(parents=True)
        old, recent = directory / 'claude-old.json', directory / 'claude-recent.json'
        old.write_text('{}')
        recent.write_text('{}')
        long_ago = time.time() - 31 * 86400
        os.utime(old, (long_ago, long_ago))
        transcript = self.write_transcript([self.user_line('hello')])
        payload = self.payload('claude', transcript)
        self.assert_released(self.run_hook('claude', payload))
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        old.write_text('{}')
        os.utime(old, (long_ago, long_ago))
        self.assert_released(self.run_hook('claude', payload))
        self.assertTrue(old.exists())


if __name__ == '__main__':
    unittest.main()
