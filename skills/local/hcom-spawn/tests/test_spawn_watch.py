import importlib.util
import io
import json
import os
import tempfile
import threading
import time
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
CAPACITY = '■ Selected model is at capacity. Please try a different model.'
CAPACITY_SCREEN = [CAPACITY, '', *CODEX_SCREEN]
RECOVERED_SCREEN = [CAPACITY, '› Continue', '• Picking up the task again.',
                    'Working (3s · esc to interrupt)', *CODEX_SCREEN]
REPLY = {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'OK'}}
ECHO = {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Continue'}}


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
        self.injected, self.on_inject = [], None
        self.agents = None  # `hcom list --json` rows; None answers like `hcom list <name>`

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
        if args[:2] == ('term', 'inject'):
            self.injected.append(args)
            if self.on_inject:
                self.on_inject()
            return 0, ''
        if args[0] == 'term':
            if not self.screens:
                return 1, "Error: 'kilo' has no terminal registered yet\n"
            lines = self.screens.pop(0) if len(self.screens) > 1 else self.screens[0]
            return 0, json.dumps({'lines': lines, 'ready': True, 'prompt_empty': True,
                                  'input_text': ''})
        if args == ('list', '--json') and self.agents is not None:
            return 0, json.dumps(self.agents)
        if args[0] == 'list':
            return 0, json.dumps({'transcript_path': self.log or ''})
        if args[0] == 'send':
            self.sent.append(args)
            return 0, ''
        raise AssertionError(f'unexpected hcom call {args}')


class FakeHerdr:
    """Answers `herdr pane get` and `herdr tab rename`; panes maps pane id -> tab id."""

    def __init__(self, panes=None, get_fails=False, rename_fails=False, missing=False):
        self.panes, self.calls = panes or {}, []
        self.get_fails, self.rename_fails, self.missing = get_fails, rename_fails, missing

    def __call__(self, *args):
        self.calls.append(args)
        if self.missing:
            return 1, "[Errno 2] No such file or directory: 'herdr'"
        if args[:2] == ('pane', 'get'):
            if self.get_fails or args[2] not in self.panes:
                return 1, json.dumps({'error': {'code': 'pane_not_found'}})
            return 0, json.dumps({'result': {'pane': {'pane_id': args[2],
                                                      'tab_id': self.panes[args[2]]}}})
        if args[:2] == ('tab', 'rename'):
            return (1, 'rename failed') if self.rename_fails else (0, '{}')
        raise AssertionError(f'unexpected herdr call {args}')


def agent_row(name, pane=None, preset='herdr', tag='vare-review'):
    context = {'process_id': name, 'terminal_preset_effective': preset}
    if pane:
        context['pane_id'] = pane
    return {'base_name': name, 'name': f'{tag}-{name}', 'launch_context': context}


class SpawnWatchTests(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        patcher = mock.patch.dict(os.environ, {'XDG_STATE_HOME': self.state.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.watch = load()
        self.watch.herdr = FakeHerdr()
        self.watch.LABEL_WAIT, self.watch.LABEL_POLL = 0.3, 0.01

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

    def test_a_watch_skips_a_batch_started_with_another_model_while_its_owner_takes_it(self):
        # `false && hcom ... opus; hcom ... sonnet`: only the Sonnet batch exists.
        fake = FakeHcom(stop_after=50)
        fake.batches[0]['data']['instances'] = ['mona']
        self.watch.hcom, self.watch.clock = fake, fake.clock
        self.watch.process_ids = lambda: {'mona': 'mona'}
        self.watch.launched_with = lambda tool, process_id: ('claude-sonnet-5-5', 'low')
        polls = []

        def sleep(seconds):
            fake.sleep(seconds)
            polls.append(seconds)
            if len(polls) == 20:  # the Sonnet watch claims its batch meanwhile
                self.assertTrue(self.watch.claim('b1'))
        self.watch.sleep = sleep
        watched = {}
        found, _ = self.watch.find_batch('vare', 'claude', '', 99, 'claude-opus-5-5', 'low',
                                         watched)
        self.assertIsNone(found)
        self.assertGreater(len(polls), 20)
        self.assertEqual(list(watched), ['mona'])  # approval prompts watched all along

    def test_unattributed_agent_that_blocks_at_once_is_reported_within_a_minute(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=500)
        fake.blocked_early = True
        sends = []
        real = fake.__call__

        def call(*args, timeout=30):
            if args[0] == 'send':
                sends.append((fake.now, args))
            return real(*args, timeout=timeout)
        self.watch.process_ids = lambda: {'kilo': 'kilo'}
        self.watch.launched_with = lambda tool, process_id: ('claude-haiku-5-5', 'low')
        self.watch.hcom, self.watch.clock, self.watch.sleep = call, fake.clock, fake.sleep
        self.watch.main(['--spawner', 'vare', '--tool', 'claude', '--model', 'claude-opus-5-5',
                         '--effort', 'low', '--after-id', '99'])
        self.assertIn(('events', 'sub', '--blocked', 'kilo', '--for', 'vare'), fake.calls)
        first = sends[0]
        self.assertLess(first[0], 60)
        self.assertIn('is waiting for approval', first[1][-1])

    def test_a_batch_taken_by_another_watch_is_not_checked_twice(self):
        first = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        self.run_watch(first)
        second = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        self.run_watch(second)
        self.assertEqual(second.subs, {})
        self.assertEqual(second.sent, [])

    def test_unreadable_command_line_is_checked_without_borrowing_expectations(self):
        fake = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        self.run_watch(fake, model='claude-sonnet-5-5', launched={'kilo': None})
        self.assertIn(('events', 'sub', '--blocked', 'kilo', '--for', 'vare'), fake.calls)
        self.assertGreaterEqual(fake.now, self.watch.ARGS_WAIT)
        text = fake.sent[0][-1]
        self.assertIn('could not tell which launch command started vare-review-kilo', text)
        self.assertIn('its command line could not be read', text)
        self.assertIn('model: launch command unknown, screen shows Opus 5.5', text)
        self.assertIn('permission: expected bypass permissions on, screen shows auto mode on', text)
        self.assertNotIn('expected claude-sonnet-5-5', text)

    def test_batch_no_watch_claims_is_taken_unattributed_at_the_end(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=500)
        self.run_watch(fake, model='claude-opus-5-5',
                       launched={'kilo': ('claude-haiku-5-5', 'low')})
        self.assertGreaterEqual(fake.now, self.watch.BATCH_WAIT)
        text = fake.sent[0][-1]
        self.assertIn('it was started with model claude-haiku-5-5, effort low', text)
        self.assertNotIn('expected claude-opus-5-5', text)
        self.assertNotIn('permission', text.split('): ')[1].split('. ')[1])

    def test_agent_process_is_found_by_its_hcom_process_id(self):
        proc = Path(self.state.name) / 'proc'
        for pid, env, argv in (
                ('10', b'HCOM_PROCESS_ID=other', [b'codex', b'--model', b'x']),
                ('11', b'HOME=/h\0HCOM_PROCESS_ID=p1', [b'hcom', b'pty', b'codex',
                        b'--hcom-tool-path', b'/bin/codex', b'--model', b'gpt-6.1-sol', b'-c',
                        b'model_reasoning_effort="Low"', b'--yolo']),
                ('12', b'HCOM_PROCESS_ID=p1', [b'bash', b'-l'])):
            (proc / pid).mkdir(parents=True)
            (proc / pid / 'environ').write_bytes(env + b'\0')
            (proc / pid / 'cmdline').write_bytes(b'\0'.join(argv) + b'\0')
        self.watch.PROC = proc
        self.assertEqual(self.watch.launched_with('codex', 'p1'), ('gpt-6.1-sol', 'low'))
        self.assertIsNone(self.watch.launched_with('codex', 'p2'))
        self.assertIsNone(self.watch.launched_with('codex', ''))

    def test_unsubscribe_keeps_the_record_when_hcom_cannot_list_subs(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.unsub_fails = True
        real = fake.__call__
        fake_call = lambda *args, timeout=30: ((1, '') if args[:3] == ('events', 'sub', 'list')
                                              else real(*args, timeout=timeout))
        self.watch.process_ids = lambda: {}
        self.watch.launched_with = lambda tool, process_id: ('claude-sonnet-5-5', 'low')
        self.watch.hcom, self.watch.clock, self.watch.sleep = fake_call, fake.clock, fake.sleep
        self.watch.main(['--spawner', 'vare', '--tool', 'claude', '--model', 'claude-sonnet-5-5',
                         '--effort', 'low', '--after-id', '99'])
        self.assertEqual(len(list((Path(self.state.name) / 'hcom-spawn/subs').iterdir())), 1)

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

    def test_label_is_last_segment_of_spawner_and_agent_base_name(self):
        self.assertEqual(self.watch.tab_label('bivu-i182-guzu', 'fizo'), 'guzu-fizo')
        self.assertEqual(self.watch.tab_label('bivu', 'feho'), 'bivu-feho')

    def test_each_agent_of_the_batch_gets_its_tab_renamed(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.batch['data']['instances'] = ['kilo', 'mona']
        fake.agents = [agent_row('kilo', 'w1:p1'), agent_row('mona', 'w1:p2')]
        self.watch.herdr = FakeHerdr(panes={'w1:p1': 'w1:t1', 'w1:p2': 'w1:t2'})
        self.assertEqual(self.run_watch(fake), 0)
        renames = [call for call in self.watch.herdr.calls if call[0] == 'tab']
        self.assertEqual(renames, [('tab', 'rename', 'w1:t1', 'vare-kilo'),
                                   ('tab', 'rename', 'w1:t2', 'vare-mona')])
        self.assertEqual(fake.sent, [])

    def test_spawner_with_a_tag_uses_only_its_last_segment(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.batch['data']['by'] = 'bivu-i182-guzu'
        fake.agents = [agent_row('kilo', 'w1:p1')]
        self.watch.herdr = FakeHerdr(panes={'w1:p1': 'w1:t1'})
        self.run_watch(fake)
        self.assertIn(('tab', 'rename', 'w1:t1', 'guzu-kilo'), self.watch.herdr.calls)

    def test_agent_with_the_same_base_name_under_another_tag_keeps_its_tab(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.agents = [agent_row('kilo', 'w1:p1'), agent_row('kilo', 'w1:p9', tag='mefa-docs')]
        self.watch.herdr = FakeHerdr(panes={'w1:p1': 'w1:t1', 'w1:p9': 'w1:t9'})
        self.run_watch(fake)
        self.assertEqual(self.watch.herdr.calls, [('pane', 'get', 'w1:p1'),
                                                  ('tab', 'rename', 'w1:t1', 'vare-kilo')])

    def test_agent_without_a_pane_is_skipped_and_still_checked(self):
        fake = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        fake.agents = [agent_row('kilo')]
        with mock.patch('sys.stderr', new=io.StringIO()) as log:
            self.assertEqual(self.run_watch(fake), 0)
        self.assertEqual(self.watch.herdr.calls, [])
        self.assertIn('no herdr pane in hcom list for vare-review-kilo', log.getvalue())
        self.assertEqual(len(fake.sent), 1)
        self.assertIn('permission: expected bypass permissions on', fake.sent[0][-1])

    def test_agent_missing_from_hcom_list_is_skipped_at_the_end_of_the_check(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=500)
        fake.agents = []
        with mock.patch('sys.stderr', new=io.StringIO()) as log:
            self.assertEqual(self.run_watch(fake), 0)
        self.assertEqual(self.watch.herdr.calls, [])
        self.assertIn('no herdr pane in hcom list for vare-review-kilo', log.getvalue())
        self.assertEqual(fake.sent, [])

    def test_pane_recorded_after_the_check_still_gets_its_tab_renamed(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.agents = [agent_row('kilo')]
        real = fake.__call__
        lookups = []

        def call(*args, timeout=30):
            if args == ('list', '--json'):
                lookups.append(args)
                if len(lookups) == 3:  # hcom records the pane a little later
                    fake.agents = [agent_row('kilo', 'w1:p1')]
            return real(*args, timeout=timeout)
        self.watch.herdr = FakeHerdr(panes={'w1:p1': 'w1:t1'})
        self.watch.LABEL_WAIT = 5
        self.watch.process_ids = lambda: {'kilo': 'kilo'}
        self.watch.launched_with = lambda tool, process_id: ('claude-sonnet-5-5', 'low')
        self.watch.hcom, self.watch.clock, self.watch.sleep = call, fake.clock, fake.sleep
        self.watch.main(['--spawner', 'vare', '--tool', 'claude', '--model', 'claude-sonnet-5-5',
                         '--effort', 'low', '--after-id', '99'])
        self.assertIn(('tab', 'rename', 'w1:t1', 'vare-kilo'), self.watch.herdr.calls)
        self.assertEqual(fake.sent, [])

    def test_slow_herdr_does_not_hold_up_the_check(self):
        fake = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        fake.agents = [agent_row('kilo', 'w1:p1')]
        real = fake.__call__
        reported, herdr_saw_report = threading.Event(), []

        def call(*args, timeout=30):
            if args[0] == 'send':
                reported.set()
            return real(*args, timeout=timeout)

        def herdr(*args):  # hangs until the check has reported, or gives up after 5s
            herdr_saw_report.append(reported.wait(5))
            return 1, 'timed out'
        self.watch.herdr = herdr
        self.watch.process_ids = lambda: {'kilo': 'kilo'}
        self.watch.launched_with = lambda tool, process_id: ('claude-sonnet-5-5', 'low')
        self.watch.hcom, self.watch.clock, self.watch.sleep = call, fake.clock, fake.sleep
        with mock.patch('sys.stderr', new=io.StringIO()):
            self.watch.main(['--spawner', 'vare', '--tool', 'claude',
                             '--model', 'claude-sonnet-5-5', '--effort', 'low',
                             '--after-id', '99'])
        self.assertEqual(herdr_saw_report, [True])
        self.assertIn('permission: expected bypass permissions on', fake.sent[0][-1])

    def test_agent_launched_in_another_terminal_is_skipped(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.agents = [agent_row('kilo', '%14', preset='tmux')]
        with mock.patch('sys.stderr', new=io.StringIO()) as log:
            self.assertEqual(self.run_watch(fake), 0)
        self.assertEqual(self.watch.herdr.calls, [])
        self.assertIn('launched in tmux, not herdr', log.getvalue())
        self.assertEqual(fake.sent, [])

    def assert_herdr_failure_only_logged(self, herdr):
        fake = FakeHcom(screens=[CLAUDE_AUTO], stop_after=50)
        fake.agents = [agent_row('kilo', 'w1:p1')]
        self.watch.herdr = herdr
        with mock.patch('sys.stderr', new=io.StringIO()) as log:
            self.assertEqual(self.run_watch(fake), 0)
        self.assertIn('tab vare-kilo not set', log.getvalue())
        self.assertEqual(len(fake.sent), 1)
        self.assertIn('permission: expected bypass permissions on', fake.sent[0][-1])

    def test_failed_pane_lookup_is_logged_and_does_not_affect_the_check(self):
        self.assert_herdr_failure_only_logged(FakeHerdr(get_fails=True))

    def test_failed_tab_rename_is_logged_and_does_not_affect_the_check(self):
        self.assert_herdr_failure_only_logged(FakeHerdr(panes={'w1:p1': 'w1:t1'},
                                                        rename_fails=True))

    def test_missing_herdr_command_is_logged_and_does_not_affect_the_check(self):
        self.assert_herdr_failure_only_logged(FakeHerdr(missing=True))

    def test_unparsable_pane_info_is_a_failure(self):
        fake = FakeHcom(screens=[CLAUDE_START], stop_after=50)
        fake.agents = [agent_row('kilo', 'w1:p1')]
        self.watch.herdr = lambda *args: (0, 'not json')
        with mock.patch('sys.stderr', new=io.StringIO()) as log:
            self.assertEqual(self.run_watch(fake), 0)
        self.assertIn('vare-kilo', log.getvalue())
        self.assertEqual(fake.sent, [])


if __name__ == '__main__':
    unittest.main()


class CapacityHcom:
    """One Codex agent's `hcom list` row and screen; records Continue and notices."""

    def __init__(self, transcript, screen=CAPACITY_SCREEN, status='listening'):
        self.transcript, self.screen, self.status = transcript, screen, status
        self.input_text, self.now, self.injected, self.sent = '', 0.0, [], []
        self.inject_fails = False

    def clock(self):
        return self.now

    def __call__(self, *args, timeout=30):
        if args[0] == 'list':
            return 0, json.dumps({'status': self.status, 'transcript_path': self.transcript})
        if args[:2] == ('term', 'inject'):
            if self.inject_fails:
                return 1, 'inject failed'
            self.injected.append(args)
            return 0, ''
        if args[0] == 'term':
            return 0, json.dumps({'lines': self.screen, 'ready': True,
                                  'prompt_empty': not self.input_text,
                                  'input_text': self.input_text})
        if args[0] == 'send':
            self.sent.append(args[-1])
            return 0, ''
        raise AssertionError(f'unexpected hcom call {args}')


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        patcher = mock.patch.dict(os.environ, {'XDG_STATE_HOME': self.state.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.watch = load()
        self.transcript = Path(self.state.name) / 'codex.jsonl'
        self.transcript.write_text('{"type": "session_meta", "payload": {}}\n')
        self.fake = CapacityHcom(str(self.transcript))
        self.watch.hcom, self.watch.clock = self.fake, self.fake.clock

    def write(self, *records):
        with self.transcript.open('a') as stream:
            stream.write(''.join(json.dumps(record) + '\n' for record in records))

    def step_at(self, seconds):
        self.fake.now = seconds
        self.watch.capacity_step('kilo', 'vare-review-kilo', 'vare')

    def test_one_continue_per_episode_and_one_notice_after_5_minutes(self):
        self.step_at(0)
        self.assertEqual(self.fake.injected,
                         [('term', 'inject', 'vare-review-kilo', 'Continue', '--enter')])
        # The echoed Continue and another capacity error are not agent output.
        self.write(ECHO)
        for seconds in (5, 60, 299):
            self.step_at(seconds)
        self.assertEqual((len(self.fake.injected), self.fake.sent), (1, []))
        self.step_at(300)
        self.assertEqual(len(self.fake.sent), 1)
        self.assertIn('vare-review-kilo (codex) stopped on "Selected model is at capacity"',
                      self.fake.sent[0])
        self.assertIn('Continue was sent 5 minutes ago with no reaction', self.fake.sent[0])
        for seconds in (305, 1500):
            self.step_at(seconds)
        self.assertEqual((len(self.fake.injected), len(self.fake.sent)), (1, 1))

    def test_new_output_ends_the_episode_and_a_new_one_may_send_again(self):
        self.step_at(0)
        self.write(ECHO, REPLY)
        self.fake.screen = RECOVERED_SCREEN
        self.step_at(60)
        self.fake.screen = CAPACITY_SCREEN
        self.step_at(400)
        self.assertEqual(len(self.fake.injected), 2)
        self.assertEqual(self.fake.sent, [])  # the first episode recovered in time

    def test_working_without_output_is_still_the_same_episode(self):
        self.step_at(0)
        self.fake.screen = RECOVERED_SCREEN[:2] + RECOVERED_SCREEN[3:]
        self.step_at(60)
        self.fake.screen = CAPACITY_SCREEN
        self.step_at(120)
        self.assertEqual(len(self.fake.injected), 1)

    def test_text_in_the_input_box_only_notifies(self):
        self.fake.input_text = 'half typed reply'
        self.step_at(0)
        self.assertEqual(self.fake.injected, [])
        self.assertEqual(len(self.fake.sent), 1)
        self.assertIn('Continue was not typed because its input box has text',
                      self.fake.sent[0])
        self.fake.input_text = ''
        for seconds in (60, 400):
            self.step_at(seconds)
        self.assertEqual((self.fake.injected, len(self.fake.sent)), ([], 1))

    def test_text_shown_in_the_prompt_row_still_counts_as_capacity_with_text(self):
        self.fake.input_text = 'half typed reply'
        self.fake.screen = [CAPACITY, '', '› half typed reply', '', *CODEX_SCREEN[1:]]
        self.step_at(0)
        self.assertEqual(self.fake.injected, [])
        self.assertIn('input box has text', self.fake.sent[0])
        # A submitted prompt above the input box still replaces the error.
        self.fake.sent.clear()
        self.watch.episodes.clear()
        self.fake.screen = [CAPACITY, '› older prompt', '', '› half typed reply',
                            *CODEX_SCREEN[1:]]
        self.step_at(10)
        self.assertEqual((self.fake.injected, self.fake.sent), ([], []))

    def hand_over(self, ago, transcript=None):
        """Write the record lat-watch leaves after typing Continue `ago` seconds earlier."""
        handed = Path(self.state.name) / 'hcom-spawn/capacity/vare-review-kilo.continued.json'
        handed.parent.mkdir(parents=True, exist_ok=True)
        handed.write_text(json.dumps({'at': time.time() - ago,
                                      'transcript': transcript or str(self.transcript),
                                      'size': self.transcript.stat().st_size}))
        return handed

    def test_continue_lat_watch_typed_before_coverage_is_not_typed_again(self):
        handed = self.hand_over(120)
        self.write(ECHO)
        self.step_at(0)
        self.assertEqual(self.fake.injected, [])
        self.assertFalse(handed.exists())
        self.step_at(170)
        self.assertEqual(self.fake.sent, [])
        self.step_at(185)  # 5 minutes after lat-watch's Continue
        self.assertEqual(len(self.fake.sent), 1)
        self.assertIn('Continue was sent', self.fake.sent[0])
        # After a reply, the next capacity episode gets its own Continue.
        self.write(REPLY)
        self.step_at(190)
        self.assertEqual(len(self.fake.injected), 1)

    def test_output_after_lat_watchs_continue_ends_that_episode_before_takeover(self):
        self.hand_over(120)
        self.write(ECHO, REPLY)  # recovered, then on capacity again
        self.step_at(0)
        self.assertEqual(len(self.fake.injected), 1)
        self.step_at(299)
        self.assertEqual(self.fake.sent, [])
        self.step_at(300)
        self.assertEqual(len(self.fake.sent), 1)

    def test_record_for_another_transcript_is_ignored(self):
        self.hand_over(120, transcript='/elsewhere/old.jsonl')
        self.step_at(0)
        self.assertEqual(len(self.fake.injected), 1)

    def test_inactive_agent_gets_nothing(self):
        self.fake.status = 'inactive'
        for seconds in (0, 400):
            self.step_at(seconds)
        self.assertEqual((self.fake.injected, self.fake.sent), ([], []))

    def test_screen_without_a_current_capacity_error_gets_nothing(self):
        for screen in (CODEX_SCREEN, RECOVERED_SCREEN,
                       [CAPACITY, '■ Quota exceeded. Check your plan.', *CODEX_SCREEN]):
            with self.subTest(screen=screen):
                self.fake.screen = screen
                self.step_at(0)
                self.assertEqual(self.fake.injected, [])

    def test_failed_continue_is_retried_on_the_next_check(self):
        self.fake.inject_fails = True
        self.step_at(0)
        self.fake.inject_fails = False
        self.step_at(5)
        self.assertEqual(len(self.fake.injected), 1)
        self.step_at(300)
        self.assertEqual(self.fake.sent, [])  # counted from the Continue that went through
        self.step_at(305)
        self.assertEqual(len(self.fake.sent), 1)


class CapacityWatchTests(unittest.TestCase):
    """The whole watch: covers its Codex agents until they stop."""

    def setUp(self):
        self.state = tempfile.TemporaryDirectory()
        self.addCleanup(self.state.cleanup)
        patcher = mock.patch.dict(os.environ, {'XDG_STATE_HOME': self.state.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_codex(self, fake):
        watch = load()
        watch.herdr = FakeHerdr()
        watch.LABEL_WAIT, watch.LABEL_POLL = 0.3, 0.01
        watch.hcom, watch.clock, watch.sleep = fake, fake.clock, fake.sleep
        watch.process_ids = lambda: {'kilo': 'kilo'}
        watch.launched_with = lambda tool, process_id: ('gpt-6.1-sol', 'low')
        watch.main(['--spawner', 'vare', '--tool', 'codex', '--model', 'gpt-6.1-sol',
                    '--effort', 'low', '--after-id', '99'])

    def test_codex_agent_on_capacity_gets_one_continue_and_is_covered_until_it_stops(self):
        log = Path(self.state.name) / 'session.jsonl'
        log.write_text(json.dumps({'type': 'turn_context', 'payload': {
            'model': 'gpt-6.1-sol', 'effort': 'low', 'approval_policy': 'never',
            'sandbox_policy': {'type': 'danger-full-access'}}}) + '\n')
        fake = FakeHcom(tool='codex', screens=[CAPACITY_SCREEN], log=str(log), stop_after=400)
        marker = Path(self.state.name) / 'hcom-spawn/capacity/vare-review-kilo.json'
        covered = []
        fake.on_inject = lambda: covered.append(json.loads(marker.read_text()))
        self.run_codex(fake)
        self.assertEqual(fake.injected,
                         [('term', 'inject', 'vare-review-kilo', 'Continue', '--enter')])
        self.assertEqual([record['pid'] for record in covered], [os.getpid()])
        notices = [send[-1] for send in fake.sent if 'Continue was sent' in send[-1]]
        self.assertEqual(len(notices), 1)
        self.assertEqual(fake.sent[0][1], '@vare')
        self.assertFalse(marker.exists())

    def test_agent_that_already_ended_gets_nothing(self):
        fake = FakeHcom(tool='codex', screens=[CAPACITY_SCREEN], stop_after=0)
        self.run_codex(fake)
        self.assertEqual(fake.injected, [])
        self.assertEqual([send for send in fake.sent if 'capacity' in send[-1]], [])
        self.assertEqual(list((Path(self.state.name) / 'hcom-spawn/capacity').iterdir()), [])

    def test_claude_agents_are_not_marked_or_checked_for_capacity(self):
        watch = load()
        watch.herdr = FakeHerdr()
        watch.LABEL_WAIT, watch.LABEL_POLL = 0.3, 0.01
        fake = FakeHcom(screens=[CLAUDE_START, CAPACITY_SCREEN], stop_after=400)
        watch.hcom, watch.clock, watch.sleep = fake, fake.clock, fake.sleep
        watch.process_ids = lambda: {'kilo': 'kilo'}
        watch.launched_with = lambda tool, process_id: ('claude-sonnet-5-5', 'low')
        watch.main(['--spawner', 'vare', '--tool', 'claude', '--model', 'claude-sonnet-5-5',
                    '--effort', 'low', '--after-id', '99'])
        self.assertEqual(fake.injected, [])
        self.assertEqual(list((Path(self.state.name) / 'hcom-spawn/capacity').iterdir()), [])
