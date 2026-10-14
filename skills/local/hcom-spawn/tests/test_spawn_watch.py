import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/spawn-watch.py'

CLAUDE_START = ['▝▜██████▀  Sonnet 5.5 with low effort · Claude Pro', '❯',
                '  ⏵⏵ bypass permissions on (shift+tab to cycle)      ○ low · /effort']
CLAUDE_LATER = ['● Listing 1 directory…', '❯', '  Sonnet 5.5 L · /tmp/probe',
                '  ⏵⏵ bypass permissions on (shift+tab to cycle)', '      ○ low · /effort']
CLAUDE_AUTO = ['▝▜██████▀  Opus 5.5 with low effort · Claude Pro', '❯',
               '  ⏵⏵ auto mode on (shift+tab to cycle)']
CODEX_SCREEN = ['› Ask Codex to do anything',
                '  GPT-6.1-Sol low · /tmp/probe  ⚠ 1 warning · f2 to view']


def load():
    spec = importlib.util.spec_from_file_location('spawn_watch', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHcom:
    """Answers the hcom calls spawn-watch makes; the clock moves one second per sleep."""

    def __init__(self, tool='claude', screens=(), log=None, stop_after=None):
        self.now, self.calls, self.subs, self.sent = 0.0, [], {}, []
        self.tool, self.screens, self.log, self.stop_after = tool, list(screens), log, stop_after
        self.batch = {'id': 100, 'type': 'life', 'instance': 'vare', 'data': {
            'action': 'batch_launched', 'by': 'vare', 'batch_id': 'b1', 'tool': tool,
            'tag': 'vare-review', 'instances': ['kilo']}}
        self.batches = [self.batch]
        self.blocked_early = False
        self.unsub_fails = False

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.now += max(seconds, 1)

    def __call__(self, *args, timeout=30):
        self.calls.append(args)
        if args[:2] == ('events', 'sub') and args[2:3] != ('list',):
            sub = f'sub-{len(self.subs) + 1:08x}'
            self.subs[sub] = args
            return 0, f'Subscription {sub} created\n'
        if args[:2] == ('events', 'unsub'):
            if self.unsub_fails:
                return 1, ''
            self.subs.pop(args[2], None)
            return 0, f'Removed {args[2]}\n'
        if args[:3] == ('events', 'sub', 'list'):
            return 0, ''.join(f'{sub}         vare     continuous {{}}\n' for sub in self.subs)
        if args[0] == 'events':
            if 'batch_launched' in args:
                return 0, ''.join(json.dumps(batch) + '\n' for batch in self.batches)
            if 'stopped' in args:
                stopped = self.stop_after is not None and self.now >= self.stop_after
                return 0, ('{"id": 300, "data": {"action": "stopped"}}\n' if stopped else '')
            if 'blocked' in args:
                return 0, ('{"id": 150, "data": {"status": "blocked"}}\n'
                           if self.blocked_early else '')
            return 0, ''
        if args[0] == 'term':
            if not self.screens:
                return 1, "Error: 'kilo' has no terminal registered yet\n"
            lines = self.screens.pop(0) if len(self.screens) > 1 else self.screens[0]
            return 0, json.dumps({'lines': lines, 'ready': True})
        if args[0] == 'list':
            return 0, json.dumps({'transcript_path': self.log or ''})
        if args[0] == 'send':
            self.sent.append(args)
            return 0, ''
        raise AssertionError(f'unexpected hcom call {args}')


class SpawnWatchTests(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        patcher = mock.patch.dict(os.environ, {'XDG_STATE_HOME': self.state.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.watch = load()

    def run_watch(self, fake, tool='claude', model='claude-sonnet-5-5', effort='low', tag=None,
                  launched=None):
        """launched maps agent base name -> (model, effort) on its command line; by default
        every agent was started with this watch's model and effort."""
        self.watch.hcom, self.watch.clock, self.watch.sleep = fake, fake.clock, fake.sleep
        self.watch.process_ids = lambda: {name: name for batch in fake.batches
                                          for name in batch['data']['instances']}
        self.watch.launched_with = lambda tool, process_id: (
            (launched or {}).get(process_id, (model, effort)))
        return self.watch.main(['--spawner', 'vare', '--tool', tool, '--model', model,
                                '--effort', effort, '--after-id', '99']
                               + (['--tag', tag] if tag else []))

    def add_batch(self, fake, event_id, name):
        batch = json.loads(json.dumps(fake.batch))
        batch['id'], batch['data']['instances'] = event_id, [name]
        batch['data']['batch_id'] = f'b{event_id}'
        fake.batches.append(batch)

    def write_log(self, entries):
        path = Path(self.state.name) / 'session.jsonl'
        path.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
        return str(path)

    def test_matching_claude_screen_sends_nothing_and_removes_the_sub_after_stop(self):
        fake = FakeHcom(screens=[CLAUDE_START, CLAUDE_LATER], stop_after=50)
        self.assertEqual(self.run_watch(fake), 0)
        self.assertEqual(fake.sent, [])
        sub_calls = [call for call in fake.calls if call[:2] == ('events', 'sub')]
        self.assertEqual(sub_calls, [('events', 'sub', '--blocked', 'kilo', '--for', 'vare')])
        self.assertEqual(fake.subs, {})
        self.assertEqual(list((Path(self.state.name) / 'hcom-spawn/subs').iterdir()), [])

    def test_mismatch_names_the_spawner_with_expected_and_actual_values(self):
        fake = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        self.run_watch(fake)
        self.assertEqual(len(fake.sent), 1)
        send = fake.sent[0]
        self.assertEqual(send[1], '@vare')
        text = send[-1]
        self.assertIn('vare-review-kilo', text)
        self.assertIn('model: expected claude-sonnet-5-5, screen shows Opus 5.5', text)
        self.assertIn('permission: expected bypass permissions on, screen shows auto mode on', text)
        self.assertNotIn('effort', text)

    def test_agent_that_never_shows_a_screen_is_reported_as_unconfirmed(self):
        fake = FakeHcom(screens=[], stop_after=500)
        self.run_watch(fake)
        text = fake.sent[0][-1]
        for item in ('model', 'effort', 'permission'):
            self.assertIn(f'{item}: expected', text)
        self.assertIn('could not confirm (screen could not be read', text)

    def test_codex_reads_status_bar_and_permission_from_the_session_log(self):
        log = self.write_log([{'type': 'session_meta', 'payload': {}},
                              {'type': 'turn_context', 'payload': {
                                  'model': 'gpt-6.1-sol', 'effort': 'low',
                                  'approval_policy': 'never',
                                  'sandbox_policy': {'type': 'danger-full-access'}}}])
        fake = FakeHcom(tool='codex', screens=[CODEX_SCREEN], log=log, stop_after=60)
        self.run_watch(fake, tool='codex', model='gpt-6.1-sol')
        self.assertEqual(fake.sent, [])

    def test_codex_without_yolo_in_the_session_log_is_a_mismatch(self):
        log = self.write_log([{'type': 'turn_context', 'payload': {
            'model': 'gpt-6.1-sol', 'effort': 'low', 'approval_policy': 'on-request',
            'sandbox_policy': {'type': 'workspace-write'}}}])
        fake = FakeHcom(tool='codex', screens=[CODEX_SCREEN], log=log, stop_after=60)
        self.run_watch(fake, tool='codex', model='gpt-6.1-sol', effort='medium')
        text = fake.sent[0][-1]
        self.assertIn('effort: expected medium, screen shows low', text)
        self.assertIn('permission: expected YOLO, session log shows approval on-request, '
                      'sandbox workspace-write', text)

    def test_claude_items_missing_on_screen_come_from_the_session_log(self):
        log = self.write_log([
            {'type': 'permission-mode', 'permissionMode': 'bypassPermissions'},
            {'type': 'assistant', 'message': {'model': 'claude-sonnet-5-5'}, 'effort': 'low'}])
        fake = FakeHcom(screens=[['❯', '  ⏵⏵ bypass permissions on']], log=log, stop_after=60)
        self.run_watch(fake)
        self.assertEqual(fake.sent, [])

    def test_agent_blocked_before_the_subscription_existed_is_reported_once(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.blocked_early = True
        self.run_watch(fake)
        self.assertEqual(len(fake.sent), 1)
        self.assertIn('is waiting for approval', fake.sent[0][-1])

    def test_no_launch_within_the_wait_does_nothing(self):
        fake = FakeHcom()
        fake.batch['data']['tool'] = 'codex'
        self.assertEqual(self.run_watch(fake), 0)
        self.assertEqual(fake.subs, {})
        self.assertEqual(fake.sent, [])

    def test_each_watch_takes_the_batch_started_with_its_own_model_and_effort(self):
        # `false && hcom ... model A; hcom ... model B`: only B's batch exists.
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.batches[0]['data']['instances'] = ['mona']
        launched = {'mona': ('claude-sonnet-5-5', 'low')}
        self.run_watch(fake, model='claude-opus-5-5', launched=launched)
        self.assertEqual(fake.subs, {})
        self.assertEqual(fake.sent, [])
        second = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        second.batches = fake.batches
        self.run_watch(second, launched=launched)
        self.assertIn(('events', 'sub', '--blocked', 'mona', '--for', 'vare'), second.calls)

    def test_a_batch_taken_by_another_watch_is_not_checked_twice(self):
        first = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        self.run_watch(first)
        second = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        self.run_watch(second)
        self.assertEqual(second.subs, {})
        self.assertEqual(second.sent, [])

    def test_unreadable_command_line_falls_back_to_the_earliest_batch(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        self.run_watch(fake, launched={'kilo': None})
        self.assertIn(('events', 'sub', '--blocked', 'kilo', '--for', 'vare'), fake.calls)
        self.assertGreaterEqual(fake.now, self.watch.ARGS_WAIT)

    def test_old_claims_are_cleared(self):
        claims = Path(self.state.name) / 'hcom-spawn/claims'
        claims.mkdir(parents=True)
        (claims / 'old').touch()
        os.utime(claims / 'old', (0, 0))
        (claims / 'new').touch()
        fake = FakeHcom()
        fake.batches = []
        self.run_watch(fake)
        self.assertEqual(sorted(path.name for path in claims.iterdir()), ['new'])

    def test_tag_given_on_the_command_selects_that_tags_batch(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        self.add_batch(fake, 120, 'mona')
        fake.batches[1]['data']['tag'] = 'vare-docs'
        self.run_watch(fake, tag='vare-docs')
        self.assertTrue((Path(self.state.name) / 'hcom-spawn/claims/b120').exists())
        self.assertIn(('events', 'sub', '--blocked', 'mona', '--for', 'vare'), fake.calls)
        self.assertNotIn(('events', 'sub', '--blocked', 'kilo', '--for', 'vare'), fake.calls)

    def test_agent_already_stopped_gets_no_waiting_for_approval_notice(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=0)
        fake.blocked_early = True
        self.run_watch(fake)
        self.assertEqual(fake.sent, [])
        self.assertEqual(fake.subs, {})

    def test_agent_that_stops_during_the_check_gets_no_report_and_loses_its_sub(self):
        fake = FakeHcom(screens=[], stop_after=10)
        self.run_watch(fake)
        self.assertEqual(fake.sent, [])
        self.assertEqual(fake.subs, {})
        self.assertLess(fake.now, 20)

    def test_failed_unsubscribe_keeps_the_record_for_the_next_sweep(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.unsub_fails = True
        self.run_watch(fake)
        subs = Path(self.state.name) / 'hcom-spawn/subs'
        self.assertEqual(len(list(subs.iterdir())), 1)
        fake.unsub_fails = False
        fake.batches = []
        self.run_watch(fake)
        self.assertEqual(list(subs.iterdir()), [])
        self.assertEqual(fake.subs, {})

    def test_sweep_drops_malformed_records_and_keeps_going(self):
        subs = Path(self.state.name) / 'hcom-spawn/subs'
        subs.mkdir(parents=True)
        (subs / 'sub-1.json').write_text('{}')
        (subs / 'sub-2.json').write_text('[1]')
        (subs / 'sub-3.json').write_text('not json')
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        self.run_watch(fake)
        self.assertEqual(list(subs.iterdir()), [])
        self.assertEqual(fake.sent, [])

    def test_sweep_removes_subs_whose_agent_stopped(self):
        subs = Path(self.state.name) / 'hcom-spawn/subs'
        subs.mkdir(parents=True)
        (subs / 'sub-0000000a.json').write_text(json.dumps(
            {'sub': 'sub-0000000a', 'agent': 'kilo', 'spawner': 'vare', 'launch_id': 5}))
        fake = FakeHcom(stop_after=0)
        fake.batch['data']['tool'] = 'codex'
        self.run_watch(fake)
        self.assertIn(('events', 'unsub', 'sub-0000000a'), fake.calls)
        self.assertEqual(list(subs.iterdir()), [])

    def test_no_message_is_ever_sent_without_a_recipient(self):
        fake = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        fake.blocked_early = True
        self.run_watch(fake)
        self.assertTrue(fake.sent)
        for send in fake.sent:
            self.assertTrue(send[1].startswith('@'), send)

    def test_model_names_compare_across_id_and_display_forms(self):
        matches = self.watch.matches
        self.assertTrue(matches('claude', 'model', 'claude-opus-5-5', 'Opus 5.5'))
        self.assertTrue(matches('claude', 'model', 'claude-opus-5-5[1m]', 'claude-opus-5-5'))
        self.assertTrue(matches('codex', 'model', 'gpt-6.1-sol', 'GPT-6.1-Sol'))
        self.assertFalse(matches('claude', 'model', 'claude-opus-5-5', 'Sonnet 5.5'))
        self.assertFalse(matches('codex', 'model', 'gpt-6.1-sol', 'gpt-6-astra'))
        self.assertFalse(matches('codex', 'model', 'gpt-6.1-sol', 'gpt-6.1-sol-mini'))


if __name__ == '__main__':
    unittest.main()
