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
                   CODEX_HOME=str(self.codex_home), LAT_REPORTS_DIR=str(self.reports))
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
            dict(type='user', message=dict(role='user', content=(
                '<command-message>latte</command-message>\n'
                '<command-name>/latte</command-name>'))),
        ])
        self.assert_released(self.run_hook('claude', self.payload('claude', transcript)))

    def test_codex_injected_skill_blocks(self):
        self.assert_blocked(self.run_hook('codex', self.payload(
            'codex', self.codex_skill_transcript())))

    def test_no_invocation_does_not_block(self):
        claude = self.write_transcript([
            dict(type='user', message=dict(role='user', content='hello')),
            dict(type='assistant', message=dict(role='assistant', content=[
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
        for client in ('claude', 'codex'):
            cases = dict(missing_path=self.payload(client, self.root / 'missing.jsonl'),
                         directory=self.payload(client, directory),
                         binary=self.payload(client, binary),
                         no_records=self.payload(client, garbage),
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


if __name__ == '__main__':
    unittest.main()
