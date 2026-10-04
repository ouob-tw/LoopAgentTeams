"""Behavior and CLI contract tests for the LAT stall watcher."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-watch.py'


def load_watch():
    spec = importlib.util.spec_from_file_location('lat_watch', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WatchDecisionTests(unittest.TestCase):
    def test_zero_idle_work_is_nudged_once_after_ten_minutes(self):
        watch = load_watch()
        first = watch.Observation(
            agent='zero', status='listening', prompt_empty=True,
            command_running=False, transcript_size=100,
            transcript_mtime_ns=1_000, event_id=9154,
        )

        state, actions = watch.decide(None, first, now=0)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, first, now=59)
        self.assertEqual(actions, ())
        heartbeat = first._replace(event_id=9155)
        state, actions = watch.decide(state, heartbeat, now=60)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, heartbeat, now=659)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, heartbeat, now=660)
        self.assertEqual(actions, (watch.Action('nudge', 'zero'),))
        state, actions = watch.decide(state, heartbeat, now=2400)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')

    def test_dune_new_event_resets_the_clock_and_allows_a_later_nudge(self):
        watch = load_watch()
        idle = watch.Observation('dune', 'listening', True, False, 200, 2_000, 17726)
        state, _ = watch.decide(None, idle, now=0)
        progressed = idle._replace(transcript_size=250, event_id=17735)

        state, actions = watch.decide(state, progressed, now=300)
        self.assertEqual(actions, ())
        self.assertFalse(state['nudged'])
        heartbeat = progressed._replace(event_id=17737)
        state, actions = watch.decide(state, heartbeat, now=360)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, heartbeat, now=959)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, heartbeat, now=960)
        self.assertEqual(actions, (watch.Action('nudge', 'dune'),))

    def test_dune_orchestrator_is_nudged_then_user_notified_once(self):
        watch = load_watch()
        idle = watch.Observation(
            'dune', 'listening', True, False, 200, 2_000, 17726,
            is_orchestrator=True,
        )

        state, _ = watch.decide(None, idle, now=0)
        state, actions = watch.decide(state, idle, now=600)
        self.assertEqual(actions, (watch.Action('nudge', 'dune'),))
        state, actions = watch.decide(state, idle, now=1_199)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, idle, now=1_200)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, 'notify-user')
        self.assertEqual(actions[0].agent, 'dune')
        self.assertIn('20 minutes', actions[0].message)
        self.assertIn('one terminal nudge', actions[0].message)
        state, actions = watch.decide(state, idle, now=2_400)
        self.assertEqual(actions, ())

    def test_execution_agent_escalates_to_orchestrator_then_user_once(self):
        watch = load_watch()
        idle = watch.Observation(
            'worker', 'listening', True, False, 100, 1_000, 10,
            task_card_revision='in progress\nrun tests',
        )

        state, _ = watch.decide(None, idle, now=0)
        state, _ = watch.decide(state, idle, now=600)
        state, actions = watch.decide(state, idle, now=1_200)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertIn('worker', actions[0].message)
        self.assertIn('inspect the agent', actions[0].message)
        state, actions = watch.decide(state, idle, now=1_799)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, idle, now=1_800)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, 'notify-user')
        self.assertIn('orchestrator was notified 10 minutes ago', actions[0].message)
        state, actions = watch.decide(state, idle, now=3_000)
        self.assertEqual(actions, ())

    def test_orchestrator_card_update_or_new_wait_handles_worker_escalation(self):
        watch = load_watch()
        idle = watch.Observation(
            'worker', 'listening', True, False, 100, 1_000, 10,
            task_card_revision='in progress\nrun tests',
        )

        state, _ = watch.decide(None, idle, now=0)
        state, _ = watch.decide(state, idle, now=600)
        state, _ = watch.decide(state, idle, now=1_200)
        updated = idle._replace(
            task_card_revision='in progress\ninspect failure',
            task_card_updated_at=1_700,
        )
        state, actions = watch.decide(state, updated, now=1_800)
        self.assertEqual(actions, ())
        self.assertEqual(state['decision'], 'orchestrator-handled')

        state, _ = watch.decide(None, idle, now=0)
        state, _ = watch.decide(state, idle, now=600)
        state, _ = watch.decide(state, idle, now=1_200)
        waiting = idle._replace(orchestrator_wait_started_at=1_300)
        state, actions = watch.decide(state, waiting, now=1_800)
        self.assertEqual(actions, ())
        self.assertEqual(state['decision'], 'orchestrator-handled')

    def test_pre_escalation_nudged_state_waits_full_threshold_after_upgrade(self):
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 100, 1_000, 10)
        legacy = {
            'fingerprint': [100, 1_000, 10],
            'last_progress_at': 0,
            'nudged': True,
        }

        state, actions = watch.decide(legacy, idle, now=1_000)
        self.assertEqual(actions, ())
        self.assertEqual(state['nudged_at'], 1_000)
        state, actions = watch.decide(state, idle, now=1_600)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')

    def test_orchestrator_card_change_uses_change_time_not_observation_time(self):
        watch = load_watch()
        idle = watch.Observation(
            'worker', 'listening', True, False, 100, 1_000, 10,
            task_card_revision='in progress\nrun tests',
        )

        state, _ = watch.decide(None, idle, now=0)
        state, _ = watch.decide(state, idle, now=600)
        state, _ = watch.decide(state, idle, now=1_200)
        timely = idle._replace(
            task_card_revision='in progress\ntimely update',
            task_card_updated_at=1_790,
        )
        state, actions = watch.decide(state, timely, now=1_801)

        self.assertEqual(actions, ())
        self.assertTrue(state['orchestrator_handled'])

        state, _ = watch.decide(None, idle, now=0)
        state, _ = watch.decide(state, idle, now=600)
        state, _ = watch.decide(state, idle, now=1_200)
        late = idle._replace(
            task_card_revision='in progress\nlate update',
            task_card_updated_at=1_801,
        )
        state, actions = watch.decide(state, late, now=1_801)

        self.assertEqual(actions[0].kind, 'notify-user')
        self.assertFalse(state['orchestrator_handled'])

    def test_damo_running_command_is_not_nudged_and_completion_restarts_clock(self):
        watch = load_watch()
        running = watch.Observation('damo', 'listening', True, True, 300, 3_000, 41520)
        state, _ = watch.decide(None, running, now=0)

        state, actions = watch.decide(state, running, now=493)
        self.assertEqual(actions, ())
        completed = running._replace(status='active', command_running=False,
                                     transcript_size=350, event_id=41705)
        state, actions = watch.decide(state, completed, now=494)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, completed, now=1_693)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, completed, now=1_694)
        self.assertEqual(actions, (watch.Action('nudge', 'damo'),))

    def test_rezo_stale_active_empty_prompt_is_nudged_at_twenty_minutes(self):
        watch = load_watch()
        stale = watch.Observation(
            'rezo', 'active', True, False, 400, 4_000, 62344,
            task_card_revision='in progress\nreview round two',
        )

        state, _ = watch.decide(None, stale, now=0)
        state, actions = watch.decide(state, stale, now=1_199)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, stale, now=1_200)
        self.assertEqual(actions, (watch.Action('nudge', 'rezo'),))
        self.assertIn('active', state['stall_reason'])
        state, actions = watch.decide(state, stale, now=1_800)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')

    def test_active_running_command_notifies_owner_once_without_nudge(self):
        watch = load_watch()
        running = watch.Observation(
            'worker', 'active', True, True, 100, 1_000, 10,
            task_card_revision='in progress\nrun tests',
        )

        state, _ = watch.decide(None, running, now=0)
        state, actions = watch.decide(state, running, now=1_200)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertIn('possible hung command', actions[0].message)
        self.assertFalse(state['nudged'])
        state, actions = watch.decide(state, running, now=2_400)
        self.assertEqual(actions, ())
        self.assertFalse(state['user_notified'])

        orchestrator = running._replace(agent='orch', is_orchestrator=True)
        state, _ = watch.decide(None, orchestrator, now=0)
        state, actions = watch.decide(state, orchestrator, now=1_200)
        self.assertEqual(actions[0].kind, 'notify-user')
        self.assertFalse(state['nudged'])

    def test_blocked_notifies_owner_once_after_ten_minutes_without_nudge(self):
        watch = load_watch()
        blocked = watch.Observation(
            'worker', 'blocked', True, False, 100, 1_000, 10,
            task_card_revision='in progress\nwaiting for approval',
        )

        state, _ = watch.decide(None, blocked, now=0)
        state, actions = watch.decide(state, blocked, now=599)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, blocked, now=600)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertIn('approval', actions[0].message)
        self.assertFalse(state['nudged'])
        state, actions = watch.decide(state, blocked, now=1_200)
        self.assertEqual(actions, ())

        orchestrator = blocked._replace(agent='orch', is_orchestrator=True)
        state, _ = watch.decide(None, orchestrator, now=0)
        state, actions = watch.decide(state, orchestrator, now=600)
        self.assertEqual(actions[0].kind, 'notify-user')
        self.assertFalse(state['nudged'])

    def test_wait_declaration_suppresses_nudge_until_it_is_released(self):
        watch = load_watch()
        waiting = watch.Observation('worker', 'listening', True, False, 10, 10, 1,
                                    wait_active=True)
        state, _ = watch.decide(None, waiting, now=0)

        state, actions = watch.decide(state, waiting, now=3600)
        self.assertEqual(actions, ())
        released = waiting._replace(wait_active=False, wait_released=True)
        state, actions = watch.decide(state, released, now=3601)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, released._replace(wait_released=False), now=4201)
        self.assertEqual(actions, (watch.Action('nudge', 'worker'),))

    def test_nifo_queued_message_recovers_unchanged_prompt_after_five_minutes(self):
        watch = load_watch()
        typed = watch.Observation(
            'lat-v2-nifo', 'listening', False, False, 10, 10, 1,
            input_text='A', unread_count=1,
        )
        state, _ = watch.decide(None, typed, now=0)

        state, actions = watch.decide(state, typed, now=299)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, typed, now=300)
        self.assertEqual(actions, (
            watch.Action('recover-prompt', 'lat-v2-nifo', text='A'),
        ))
        self.assertTrue(state['prompt_recovery_attempted'])
        state, actions = watch.decide(state, typed, now=600)
        self.assertEqual(actions, ())

    def test_changed_prompt_text_restarts_five_minute_timer(self):
        watch = load_watch()
        typed = watch.Observation(
            'writer', 'listening', False, False, 10, 10, 1,
            input_text='draft', unread_count=1,
        )
        state, _ = watch.decide(None, typed, now=0)
        changed = typed._replace(input_text='draft!')

        state, actions = watch.decide(state, changed, now=299)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, changed, now=598)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, changed, now=599)
        self.assertEqual(actions, (
            watch.Action('recover-prompt', 'writer', text='draft!'),
        ))

    def test_prompt_text_without_queued_messages_is_never_cleared(self):
        watch = load_watch()
        typed = watch.Observation(
            'writer', 'listening', False, False, 10, 10, 1,
            input_text='keep me', unread_count=0,
        )
        state, _ = watch.decide(None, typed, now=0)

        state, actions = watch.decide(state, typed, now=3_600)
        self.assertEqual(actions, ())

    def test_every_specified_wait_release_condition_is_recognized(self):
        watch = load_watch()
        declaration = {'agent': 'worker', 'target': 'reviewer'}
        delivered = [{'type': 'message', 'data': {'delivered_to': ['worker']}}]
        replied = [{'type': 'message', 'data': {'from': 'reviewer'}}]

        self.assertEqual(watch.wait_release_reason(declaration, delivered, [], None),
                         'message-delivered')
        self.assertEqual(watch.wait_release_reason(declaration, [], replied, None),
                         'target-replied')
        self.assertEqual(watch.wait_release_reason(declaration, [], [], False),
                         'decision-resolved')
        self.assertIsNone(watch.wait_release_reason(declaration, [], [], True))

    def test_background_process_from_hcom_identity_blocks_idle_nudge(self):
        watch = load_watch()
        info = {'launch_context': {'pid_identity': 'linux:boot-id:100'}}
        launcher = watch.Process(5, 1, 90, 'S', 5, ('bash',), ())
        client = watch.Process(10, 5, 100, 'S', 5, ('codex',),
                               ('HCOM_INSTANCE_NAME=worker',))
        shell = watch.Process(11, 10, 101, 'S', 11, ('bash', '-lc', 'uv run tests'),
                              ('HCOM_INSTANCE_NAME=worker',))
        command = watch.Process(12, 11, 102, 'S', 11, ('uv', 'run', 'tests'),
                                ('HCOM_INSTANCE_NAME=worker',))
        resident_helper = watch.Process(13, 10, 103, 'S', 5, ('node', 'server.js'),
                                        ('HCOM_INSTANCE_NAME=worker',))
        reparented_command = watch.Process(14, 1, 104, 'S', 14,
                                           ('python3', 'validate.py'),
                                           ('HCOM_INSTANCE_NAME=worker',))
        reparented_helper = watch.Process(15, 1, 105, 'S', 5, ('node', 'server.js'),
                                          ('HCOM_INSTANCE_NAME=worker',))
        reparented_node_command = watch.Process(16, 1, 106, 'S', 16,
                                                ('node', 'test.js'),
                                                ('HCOM_INSTANCE_NAME=worker',))

        self.assertTrue(watch.background_process_running(
            'worker', info, [launcher, client, shell, command, resident_helper], current_pid=99))
        self.assertFalse(watch.background_process_running(
            'worker', info, [launcher, client, resident_helper], current_pid=99))
        self.assertTrue(watch.background_process_running(
            'worker', info, [client, reparented_command], current_pid=99))
        self.assertFalse(watch.background_process_running(
            'worker', info, [client, reparented_helper], current_pid=99))
        self.assertTrue(watch.background_process_running(
            'worker', info, [client, reparented_node_command], current_pid=99))

    def test_process_reader_decodes_proc_and_skips_disappeared_or_denied_entries(self):
        watch = load_watch()
        with tempfile.TemporaryDirectory() as temporary:
            proc = Path(temporary)
            valid = proc / '123'
            valid.mkdir()
            fields = ['S', '7', *(['0'] * 17), '456']
            (valid / 'stat').write_text(f'123 (name with spaces) {" ".join(fields)}\n')
            (valid / 'cmdline').write_bytes(b'uv\0run\0\xff\0')
            (valid / 'environ').write_bytes(b'HCOM_INSTANCE_NAME=worker\0')
            denied = proc / '124'
            denied.mkdir()
            (proc / 'not-a-pid').mkdir()
            original_read_text = Path.read_text

            def read_text(path, *args, **kwargs):
                if path == denied / 'stat':
                    raise PermissionError('denied')
                return original_read_text(path, *args, **kwargs)

            with patch.object(Path, 'read_text', read_text):
                processes = watch.read_processes(proc)

        self.assertEqual(processes, [watch.Process(
            123, 7, 456, 'S', 0, ('uv', 'run', '\ufffd'),
            ('HCOM_INSTANCE_NAME=worker',),
        )])


class WatchCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        self.work.mkdir()
        (self.work / '.git').mkdir()
        self.tasks = self.work / '.lat/tasks'
        (self.tasks / 'done').mkdir(parents=True)
        self.write_task('open.md', 'worker-open', 'orch', 'in progress')
        self.write_task('merged.md', 'worker-merged', 'orch', 'merged')
        self.write_task('other.md', 'worker-other', 'somebody-else', 'in progress')
        self.write_task('done/finished.md', 'worker-done', 'orch', 'in progress')
        binary = self.root / 'bin'
        binary.mkdir()
        self.hcom_log = self.root / 'hcom.log'
        self.herdr_log = self.root / 'herdr.log'
        hcom = binary / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'printf \'%s\\n\' \'[{"name":"orch","status":"listening"},'
            '{"name":"worker-open","status":"listening"},'
            '{"name":"worker-merged","status":"listening"}]\'\n'
        )
        hcom.chmod(0o755)
        herdr = binary / 'herdr'
        herdr.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HERDR_LOG"\n'
        )
        herdr.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{binary}:{os.environ["PATH"]}',
                        FAKE_HCOM_LOG=str(self.hcom_log),
                        FAKE_HERDR_LOG=str(self.herdr_log))

    def write_task(self, relative, agent, orchestrator, status, next_step=''):
        path = self.tasks / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f'- agent：{agent} (Codex)\n'
            f'- orchestrator：{orchestrator}\n'
            f'- status：{status}\n'
            f'- next step：{next_step}\n'
        )

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              text=True, capture_output=True, cwd=self.work, env=self.env)

    def fake_transcript(self):
        path = self.root / 'transcript.jsonl'
        path.write_text('unchanged\n')
        return path

    def install_hcom(self, script):
        path = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        path.write_text(script)
        path.chmod(0o755)

    def run_cycles(self, watch, *times):
        decisions = self.work / '.lat/decisions'
        decisions.mkdir(exist_ok=True)
        with patch.dict(os.environ, self.env):
            for now in times:
                watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=now)

    def watch_state(self):
        return json.loads((self.work / '.lat/watch/orch/state.json').read_text())

    def watch_records(self):
        path = self.work / '.lat/watch/orch/watch.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()]

    def test_status_lists_only_orchestrator_and_owned_unfinished_agents(self):
        result = self.cli('status', '--workspace', self.work,
                          '--orchestrator', 'orch', '--tasks', self.tasks)

        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual([item['agent'] for item in output['targets']],
                         ['orch', 'worker-open'])
        self.assertEqual(output['targets'][0]['hcom_status'], 'listening')
        self.assertEqual(self.hcom_log.read_text().splitlines(),
                         ['list --json --name orch'])

    def write_card(self, relative, agent_field, orchestrator='orch', status='in progress'):
        path = self.tasks / relative
        path.write_text(f'- agent：{agent_field}\n- orchestrator：{orchestrator}\n'
                        f'- status：{status}\n')
        return path

    def test_agent_name_may_be_followed_by_ascii_or_full_width_parentheses(self):
        self.write_card('a-full.md', 'poni（QA）')
        self.write_card('b-ascii.md', 'kemo(Codex)')
        self.write_card('c-space.md', 'tabi\t(HCOM tag `t`)')
        self.write_card('d-full-space.md', 'lune　（QA）')
        self.write_card('e-bare.md', 'sora')

        result = self.cli('status', '--workspace', self.work,
                          '--orchestrator', 'orch', '--tasks', self.tasks)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([item['agent'] for item in json.loads(result.stdout)['targets']],
                         ['orch', 'poni', 'kemo', 'tabi', 'lune', 'sora', 'worker-open'])

    def test_malformed_cards_are_skipped_and_logged_once_per_content(self):
        empty = self.write_card('empty.md', '')
        self.write_card('glued.md', 'poni:QA')
        (self.tasks / 'binary.md').write_bytes(b'- agent\xef\xbc\x9a\xff\xfe\n')
        self.write_card('foreign.md', '', orchestrator='somebody-else')
        (self.tasks / 'blank.md').write_text('')
        (self.tasks / 'no-status.md').write_text('- agent：sora\n- orchestrator：orch\n')
        watch = load_watch()

        self.run_cycles(watch, 0, 60)
        status = self.cli('status', '--workspace', self.work,
                          '--orchestrator', 'orch', '--tasks', self.tasks)
        empty.write_text(empty.read_text().replace('in progress', 'committed'))
        self.run_cycles(watch, 120)

        records = self.watch_records()
        skipped = [(record['at'], record['card']) for record in records
                   if record.get('decision') == 'task-card-skipped']
        self.assertEqual(skipped, [(0, 'binary.md'), (0, 'blank.md'), (0, 'empty.md'),
                                   (0, 'glued.md'), (0, 'no-status.md'), (120, 'empty.md')])
        self.assertTrue(all(record['error'] for record in records if 'card' in record))
        observed = [(record['at'], record['agent']) for record in records if 'agent' in record]
        self.assertEqual(observed, [(at, agent) for at in (0, 60, 120)
                                    for agent in ('orch', 'worker-open')])
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual([item['agent'] for item in json.loads(status.stdout)['targets']],
                         ['orch', 'worker-open'])

    def test_fixed_card_is_watched_and_logged_again_if_it_breaks_again(self):
        card = self.write_card('flaky.md', '')
        watch = load_watch()

        self.run_cycles(watch, 0)
        self.write_card('flaky.md', 'poni（QA）')
        self.run_cycles(watch, 60)
        self.write_card('flaky.md', '')
        self.run_cycles(watch, 120)

        records = self.watch_records()
        self.assertEqual([record['at'] for record in records
                          if record.get('card') == card.name], [0, 120])
        self.assertIn((60, 'poni'), [(record['at'], record['agent'])
                                     for record in records if 'agent' in record])

    def test_card_returning_to_earlier_malformed_content_is_not_logged_again(self):
        card = self.write_card('flaky.md', '')
        watch = load_watch()

        self.run_cycles(watch, 0)
        self.write_card('flaky.md', 'poni:QA')
        self.run_cycles(watch, 60)
        self.write_card('flaky.md', '')
        self.run_cycles(watch, 120)

        self.assertEqual([record['at'] for record in self.watch_records()
                          if record.get('card') == card.name], [0, 60])

    def test_card_that_raises_during_parsing_does_not_stop_the_cycle(self):
        watch = load_watch()
        parse_task = watch.parse_task
        broken = self.tasks / 'open.md'

        def parse_or_fail(path):
            if path == broken:
                raise OSError('simulated read failure')
            return parse_task(path)

        self.write_card('second.md', 'sora (Codex)')
        with patch.object(watch, 'parse_task', parse_or_fail):
            self.run_cycles(watch, 0)

        records = self.watch_records()
        self.assertEqual([(record['card'], record['error']) for record in records
                          if 'card' in record],
                         [('open.md', 'simulated read failure')])
        self.assertEqual([record['agent'] for record in records if 'agent' in record],
                         ['orch', 'sora'])

    def test_wait_writes_declaration_and_status_displays_it(self):
        waited = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'reviewer', '--reason', 'waiting for independent review')
        self.assertEqual(waited.returncode, 0, waited.stderr)
        declaration = json.loads(waited.stdout)
        self.assertEqual(declaration['agent'], 'worker-open')
        self.assertEqual(declaration['target'], 'reviewer')
        self.assertEqual(declaration['reason'], 'waiting for independent review')

        status = self.cli('status', '--workspace', self.work,
                          '--orchestrator', 'orch', '--tasks', self.tasks)
        self.assertEqual(status.returncode, 0, status.stderr)
        targets = {item['agent']: item for item in json.loads(status.stdout)['targets']}
        self.assertEqual(targets['worker-open']['wait']['target'], 'reviewer')

    def test_run_cycle_injects_enter_once_and_logs_every_decision(self):
        transcript = self.root / 'transcript.jsonl'
        transcript.write_text('unchanged\n')
        hcom = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}},{{"name":"worker-open",'
            f'"status":"listening","transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true,"input_text":""}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        hcom.chmod(0o755)
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        watch = load_watch()

        with patch.dict(os.environ, self.env):
            watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=0)
            watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=600)

        commands = self.hcom_log.read_text().splitlines()
        injections = [line for line in commands if line.startswith('term inject ')]
        self.assertEqual(len(injections), 2)
        self.assertTrue(all('--enter --name orch' in line for line in injections))
        records = [json.loads(line) for line in
                   (self.work / '.lat/watch/orch/watch.jsonl').read_text().splitlines()]
        self.assertEqual(len(records), 4)
        self.assertEqual([record['actions'] for record in records[-2:]],
                         [[{'kind': 'nudge', 'agent': 'orch'}],
                          [{'kind': 'nudge', 'agent': 'worker-open'}]])

    def test_reproduced_stale_active_term_shapes_inject_after_twenty_minutes(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"active",'
            f'"context":"tool:send","transcript_path":"{transcript}"}},'
            f'{{"name":"worker-open","status":"active","context":"tool:Bash",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true,'
            '"input_text":""}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        watch = load_watch()
        self.run_cycles(watch, 0, 1_199, 1_200)

        injections = [command for command in self.hcom_log.read_text().splitlines()
                      if command.startswith('term inject ')]
        self.assertEqual(len(injections), 2)
        self.assertTrue(any('term inject orch ' in command for command in injections))
        self.assertTrue(any('term inject worker-open ' in command for command in injections))
        self.assertTrue(all('--enter --name orch' in command for command in injections))

    def test_escalation_actions_use_hcom_and_request_sound_without_real_services(self):
        watch = load_watch()

        with patch.dict(os.environ, self.env):
            orchestrator = watch.perform(
                watch.Action(
                    'notify-orchestrator', 'worker-open', 'orchestrator detail'), 'orch')
            user = watch.perform(
                watch.Action('notify-user', 'worker-open', 'user detail'), 'orch')

        self.assertEqual(orchestrator, {'delivery': 'hcom'})
        self.assertEqual(user, {'delivery': 'hcom+herdr'})
        self.assertEqual(self.hcom_log.read_text().splitlines(), [
            'send @orch --intent request --from lat-watch --name orch -- orchestrator detail',
            'send @orch --intent inform --from lat-watch --name orch -- user detail',
        ])
        self.assertEqual(self.herdr_log.read_text().splitlines(), [
            'notification show LAT needs attention --body user detail --sound request',
        ])

    def test_user_notification_degrades_to_hcom_and_reports_herdr_failure(self):
        herdr = Path(self.env['PATH'].split(':', 1)[0]) / 'herdr'
        herdr.write_text('#!/bin/sh\nprintf "unavailable\\n" >&2\nexit 7\n')
        herdr.chmod(0o755)
        watch = load_watch()

        with patch.dict(os.environ, self.env):
            result = watch.perform(
                watch.Action('notify-user', 'worker-open', 'user detail'), 'orch')

        self.assertEqual(result['delivery'], 'hcom-only')
        self.assertIn('unavailable', result['herdr_error'])
        self.assertEqual(self.hcom_log.read_text().splitlines(), [
            'send @orch --intent inform --from lat-watch --name orch -- user detail',
        ])

    def test_prompt_recovery_saves_0600_then_clears_and_notifies_with_full_text(self):
        watch = load_watch()
        original = 'A private draft\nwith another line'
        terminal_reads = iter(['A private draft\nwith another lin', ''])
        commands = []

        def fake_run(command, failure=None):
            commands.append(command)
            if command[:3] == ['hcom', 'term', 'inject']:
                backups = list((self.work / '.lat/watch').glob('prompt-worker-open-*.txt'))
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups[0].read_text(), original)
            return ''

        with patch.object(watch, 'read_prompt_status', return_value=(original, 1)), \
                patch.object(watch, 'run_command', side_effect=fake_run), \
                patch.object(watch, 'read_terminal_input',
                             side_effect=lambda _agent, _orch: next(terminal_reads)):
            result = watch.perform(
                watch.Action('recover-prompt', 'worker-open', text=original),
                'orch', self.work,
            )

        saved = Path(result['saved_path'])
        self.assertEqual(saved.read_text(), original)
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        injects = [command for command in commands if command[:3] ==
                   ['hcom', 'term', 'inject']]
        self.assertEqual(len(injects), 2)
        hcom_note = next(command[-1] for command in commands
                         if command[:2] == ['hcom', 'send'])
        popup = next(command[command.index('--body') + 1] for command in commands
                     if command[:3] == ['herdr', 'notification', 'show'])
        self.assertIn(original, hcom_note)
        self.assertIn(str(saved), hcom_note)
        self.assertIn(str(saved), popup)
        self.assertNotIn(original, popup)
        self.assertEqual(result['reason'], 'prompt text backed up and cleared')

    def test_prompt_backup_failure_does_not_clear_and_still_notifies(self):
        watch = load_watch()
        commands = []

        def fake_run(command, failure=None):
            commands.append(command)
            return ''

        with patch.object(watch, 'backup_prompt_text',
                          side_effect=OSError('disk full')), \
                patch.object(watch, 'run_command', side_effect=fake_run):
            result = watch.perform(
                watch.Action('recover-prompt', 'worker-open', text='do not lose'),
                'orch', self.work,
            )

        self.assertEqual(result['reason'], 'prompt text backup failed; input not cleared')
        self.assertFalse(any(command[:3] == ['hcom', 'term', 'inject']
                             for command in commands))
        note = next(command[-1] for command in commands
                    if command[:2] == ['hcom', 'send'])
        self.assertIn('do not lose', note)
        self.assertIn('disk full', note)

    def test_first_backspace_that_does_not_shorten_text_stops_without_retry(self):
        watch = load_watch()
        commands = []

        def fake_run(command, failure=None):
            commands.append(command)
            return ''

        with patch.object(watch, 'read_prompt_status',
                          return_value=('tool banner', 1)), \
                patch.object(watch, 'run_command', side_effect=fake_run), \
                patch.object(watch, 'read_terminal_input', return_value='tool banner'):
            result = watch.perform(
                watch.Action('recover-prompt', 'worker-open', text='tool banner'),
                'orch', self.work,
            )

        injects = [command for command in commands if command[:3] ==
                   ['hcom', 'term', 'inject']]
        self.assertEqual(len(injects), 1)
        self.assertEqual(
            result['reason'], 'input text not editable (possible tool UI text)')
        note = next(command[-1] for command in commands
                    if command[:2] == ['hcom', 'send'])
        self.assertIn(result['reason'], note)

    def test_prompt_change_before_first_backspace_is_not_cleared_and_rearms_timer(self):
        watch = load_watch()
        original = 'old draft'
        typed = watch.Observation(
            'worker-open', 'listening', False, False, 10, 10, 1,
            input_text=original, unread_count=1,
        )
        state, _ = watch.decide(None, typed, now=0)
        state, actions = watch.decide(state, typed, now=300)
        commands = []

        with patch.object(watch, 'read_prompt_status', return_value=('new draft', 1)), \
                patch.object(watch, 'run_command',
                             side_effect=lambda command, failure=None: commands.append(command)):
            result = watch.perform(actions[0], 'orch', self.work)
        watch.apply_prompt_recovery_result(state, result, now=300)

        self.assertFalse(any(command[:3] == ['hcom', 'term', 'inject']
                             for command in commands))
        self.assertEqual(result['reason'], 'prompt text changed before clearing; not cleared')
        changed = typed._replace(input_text='new draft')
        state, actions = watch.decide(state, changed, now=599)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, changed, now=600)
        self.assertEqual(actions, (
            watch.Action('recover-prompt', 'worker-open', text='new draft'),
        ))

    def test_partial_failed_clear_does_not_rearm_on_its_own_residue(self):
        watch = load_watch()
        typed = watch.Observation(
            'worker-open', 'listening', False, False, 10, 10, 1,
            input_text='ABC', unread_count=1,
        )
        state, _ = watch.decide(None, typed, now=0)
        state, actions = watch.decide(state, typed, now=300)
        terminal_reads = iter(['AB', 'AB'])

        with patch.object(watch, 'read_prompt_status', return_value=('ABC', 1)), \
                patch.object(watch, 'run_command', return_value=''), \
                patch.object(watch, 'read_terminal_input',
                             side_effect=lambda _agent, _orch: next(terminal_reads)):
            result = watch.perform(actions[0], 'orch', self.work)
        watch.apply_prompt_recovery_result(state, result, now=300)

        residue = typed._replace(input_text='AB')
        state, later = watch.decide(state, residue, now=3_600)
        self.assertEqual(later, ())
        self.assertTrue(state['prompt_recovery_attempted'])

    def test_failed_read_after_backspace_blocks_first_observed_residue(self):
        watch = load_watch()
        typed = watch.Observation(
            'worker-open', 'listening', False, False, 10, 10, 1,
            input_text='ABC', unread_count=1,
        )
        state, _ = watch.decide(None, typed, now=0)
        state, actions = watch.decide(state, typed, now=300)

        with patch.object(watch, 'read_prompt_status', return_value=('ABC', 1)), \
                patch.object(watch, 'run_command', return_value=''), \
                patch.object(watch, 'read_terminal_input',
                             side_effect=ValueError('screen read failed')):
            result = watch.perform(actions[0], 'orch', self.work)
        watch.apply_prompt_recovery_result(state, result, now=300)

        residue = typed._replace(input_text='AB')
        state, later = watch.decide(state, residue, now=3_600)
        self.assertEqual(later, ())
        self.assertTrue(state['prompt_recovery_attempted'])
        self.assertNotIn('prompt_recovery_uncertain', state)

        user_edit = residue._replace(input_text='AB!')
        state, later = watch.decide(state, user_edit, now=3_601)
        self.assertEqual(later, ())
        state, later = watch.decide(state, user_edit, now=3_901)
        self.assertEqual(later, (
            watch.Action('recover-prompt', 'worker-open', text='AB!'),
        ))

    def test_unexpected_shorter_replacement_stops_instead_of_clearing_it(self):
        watch = load_watch()
        commands = []

        def fake_run(command, failure=None):
            commands.append(command)
            return ''

        with patch.object(watch, 'read_prompt_status', return_value=('abcdef', 1)), \
                patch.object(watch, 'run_command', side_effect=fake_run), \
                patch.object(watch, 'read_terminal_input', return_value='x'):
            result = watch.perform(
                watch.Action('recover-prompt', 'worker-open', text='abcdef'),
                'orch', self.work,
            )

        injects = [command for command in commands if command[:3] ==
                   ['hcom', 'term', 'inject']]
        self.assertEqual(len(injects), 1)
        self.assertEqual(result['reason'], 'prompt text changed while clearing; stopped')

    def test_queued_messages_are_rechecked_before_any_backspace(self):
        watch = load_watch()
        commands = []

        with patch.object(watch, 'read_prompt_status', return_value=('keep me', 0)), \
                patch.object(watch, 'run_command',
                             side_effect=lambda command, failure=None: commands.append(command)):
            result = watch.perform(
                watch.Action('recover-prompt', 'worker-open', text='keep me'),
                'orch', self.work,
            )

        self.assertFalse(any(command[:3] == ['hcom', 'term', 'inject']
                             for command in commands))
        self.assertEqual(
            result['reason'], 'queued messages no longer present; input not cleared')

    def test_run_cycle_logs_hcom_only_user_notification_degradation(self):
        transcript = self.fake_transcript()
        binary = Path(self.env['PATH'].split(':', 1)[0])
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        herdr = binary / 'herdr'
        herdr.write_text('#!/bin/sh\nprintf "no display\\n" >&2\nexit 7\n')
        herdr.chmod(0o755)
        watch = load_watch()
        self.run_cycles(watch, 0, 600, 1_200)

        records = self.watch_records()
        result = records[-2]['action_results'][0]
        self.assertEqual(result['kind'], 'notify-user')
        self.assertEqual(result['delivery'], 'hcom-only')
        self.assertIn('no display', result['herdr_error'])

    def test_task_update_and_orchestrator_wait_prevent_user_escalation(self):
        self.write_task('open.md', 'worker-open', 'orch', 'in progress', 'run tests')
        self.write_task('waiting.md', 'worker-wait', 'orch', 'in progress', 'review')
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}},{{"name":"worker-open",'
            f'"status":"listening","transcript_path":"{transcript}"}},'
            f'{{"name":"worker-wait","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" = orch ]; then\n'
            '  printf \'%s\\n\' \'{"ready":false,"prompt_empty":true}\'\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        watch = load_watch()
        self.run_cycles(watch, 0, 600, 1_200)
        self.write_task(
            'open.md', 'worker-open', 'orch', 'in progress', 'inspect failure')
        os.utime(self.tasks / 'open.md', (1_700, 1_700))
        watch.write_object(watch.wait_path(self.work, 'orch'), {
            'agent': 'orch', 'target': 'worker-wait',
            'reason': 'orchestrator handling',
            'declared_at': 1_300, 'declared_at_utc': '2026-10-04T00:00:00+00:00',
            'active': False, 'released_reason': 'message-delivered',
        })
        self.run_cycles(watch, 1_800)

        state = self.watch_state()
        self.assertTrue(state['worker-open']['orchestrator_handled'])
        self.assertTrue(state['worker-wait']['orchestrator_handled'])
        self.assertFalse(state['worker-open']['user_notified'])
        self.assertFalse(state['worker-wait']['user_notified'])
        self.assertFalse(self.herdr_log.exists())

    def test_stopped_worker_counts_as_handled_after_orchestrator_notice(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"ready":false,"prompt_empty":true}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        watch = load_watch()
        state_file = watch.state_path(self.work, 'orch')
        watch.write_object(state_file, {
            'worker-open': {
                'fingerprint': [10, 10, 1], 'last_progress_at': 0,
                'nudged': True, 'nudged_at': 600, 'orchestrator_notified': True,
                'orchestrator_notified_at': 1_200,
                'orchestrator_handled': False,
                'user_notified': False,
            },
        })

        self.run_cycles(watch, 1_800)

        state = json.loads(state_file.read_text())
        self.assertNotIn('worker-open', state)
        records = self.watch_records()
        stopped = [record for record in records if record['agent'] == 'worker-open']
        self.assertEqual(
            stopped[-1]['decision'], 'orchestrator-handled-agent-stopped')

    def test_failed_hcom_user_notification_retries_without_calling_herdr(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'elif [ "$1" = send ]; then\n'
            '  printf "send failed\\n" >&2\n'
            '  exit 8\n'
            'fi\n'
        )
        watch = load_watch()
        self.run_cycles(watch, 0, 600, 1_200, 1_260)

        commands = self.hcom_log.read_text().splitlines()
        sends = [command for command in commands if command.startswith('send ')]
        self.assertEqual(len(sends), 2)
        self.assertFalse(self.herdr_log.exists())
        state = self.watch_state()
        self.assertFalse(state['orch']['user_notified'])

    def test_real_event_shape_releases_and_persists_an_inactive_wait(self):
        hcom = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'case " $* " in\n'
            '  *" --participant worker-open "*)\n'
            '    printf \'%s\\n\' \'{"type":"message","data":'
            '{"from":"sender","delivered_to":["worker-open"]}}\' ;;\n'
            'esac\n'
        )
        hcom.chmod(0o755)
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        watch = load_watch()
        declaration = {
            'agent': 'worker-open', 'target': 'reviewer', 'reason': 'review',
            'declared_at_utc': '2026-10-04T00:00:00+00:00', 'active': True,
        }
        watch.write_object(watch.wait_path(self.work, 'worker-open'), declaration)

        with patch.dict(os.environ, self.env):
            reason = watch.release_wait_if_needed(
                self.work, decisions, 'orch', declaration)

        self.assertEqual(reason, 'message-delivered')
        saved = json.loads(watch.wait_path(self.work, 'worker-open').read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'message-delivered')

    def test_run_cycle_logs_missing_observation_failure_and_retries_failed_nudge(self):
        self.write_task('broken.md', 'worker-broken', 'orch', 'in progress')
        self.write_task('missing.md', 'worker-missing', 'orch', 'in progress')
        transcript = self.root / 'transcript.jsonl'
        transcript.write_text('unchanged\n')
        hcom = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}},{{"name":"worker-open",'
            f'"status":"listening","transcript_path":"{transcript}"}},'
            f'{{"name":"worker-broken","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" = inject ]; then\n'
            '  exit 9\n'
            'elif [ "$1" = term ] && [ "$2" = worker-broken ]; then\n'
            '  printf \'not-json\\n\'\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        hcom.chmod(0o755)
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        watch = load_watch()

        with patch.dict(os.environ, self.env):
            for now in (0, 600, 660):
                watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=now)

        records = [json.loads(line) for line in
                   (self.work / '.lat/watch/orch/watch.jsonl').read_text().splitlines()]
        self.assertEqual(len([record for record in records
                              if record.get('decision') == 'not-observable']), 3)
        self.assertEqual(len([record for record in records
                              if record.get('decision') == 'observation-failed']), 3)
        failures = [result for record in records for result in record.get('action_results', [])
                    if result['status'] == 'failed']
        self.assertEqual(len(failures), 4)
        state = json.loads((self.work / '.lat/watch/orch/state.json').read_text())
        self.assertFalse(state['orch']['nudged'])
        self.assertFalse(state['worker-open']['nudged'])

    def test_missing_terminal_readiness_is_logged_and_takes_no_action(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"active",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"input_text":""}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        watch = load_watch()
        self.run_cycles(watch, 0, 1_200)

        records = [record for record in self.watch_records()
                   if record['agent'] == 'orch']
        self.assertEqual([record['decision'] for record in records],
                         ['observation-failed', 'observation-failed'])
        self.assertTrue(all(record['actions'] == [] for record in records))
        self.assertTrue(all('ready' in record['error'] for record in records))
        commands = self.hcom_log.read_text().splitlines()
        self.assertFalse(any(command.startswith('term inject ') for command in commands))
        self.assertFalse(any(command.startswith('send ') for command in commands))

    def test_run_forever_uses_sixty_second_intervals(self):
        watch = load_watch()
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks,
                                  decisions=decisions, orchestrator='orch')
        stop = RuntimeError('stop test loop')

        with patch.object(watch, 'run_cycle') as cycle, \
                patch.object(watch.time, 'sleep', side_effect=[None, stop]) as sleeper:
            with self.assertRaisesRegex(RuntimeError, 'stop test loop'):
                watch.run_forever(args)

        self.assertEqual(cycle.call_count, 2)
        self.assertEqual(sleeper.call_args_list,
                         [unittest.mock.call(60), unittest.mock.call(60)])


    def test_failed_cycles_are_logged_rate_limited_and_the_loop_continues(self):
        watch = load_watch()
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks,
                                  decisions=decisions, orchestrator='orch')
        failures = [ValueError('hcom failed: busy'), ValueError('hcom failed: busy'),
                    ValueError('hcom failed: busy'), OSError('disk'), None,
                    ValueError('hcom failed: busy')]
        clock = iter([0, 60, 3600, 3660, 3720, 3780])

        def cycle(*_):
            error = failures.pop(0)
            if error:
                raise error

        stop = RuntimeError('stop test loop')
        with patch.object(watch, 'run_cycle', side_effect=cycle) as runner, \
                patch.object(watch.time, 'time', side_effect=lambda: next(clock)), \
                patch.object(watch.time, 'sleep', side_effect=[None] * 5 + [stop]), \
                patch('sys.stderr'):
            with self.assertRaisesRegex(RuntimeError, 'stop test loop'):
                watch.run_forever(args)

        self.assertEqual(runner.call_count, 6)
        self.assertEqual([(record['at'], record['error'], record.get('repeats'))
                          for record in self.watch_records()],
                         [(0, 'ValueError: hcom failed: busy', None),
                          (3600, 'ValueError: hcom failed: busy', 2),
                          (3660, 'OSError: disk', None),
                          (3780, 'ValueError: hcom failed: busy', None)])
        self.assertTrue(all(record['decision'] == 'cycle-failed'
                            for record in self.watch_records()))

    def test_real_cycle_exception_does_not_end_run_forever(self):
        self.install_hcom('#!/bin/sh\necho down >&2\nexit 1\n')
        watch = load_watch()
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks,
                                  decisions=decisions, orchestrator='orch')
        stop = RuntimeError('stop test loop')

        with patch.dict(os.environ, self.env), patch('sys.stderr'), \
                patch.object(watch.time, 'sleep', side_effect=[None, stop]):
            with self.assertRaisesRegex(RuntimeError, 'stop test loop'):
                watch.run_forever(args)

        failed = [record for record in self.watch_records()
                  if record['decision'] == 'cycle-failed']
        self.assertEqual([record['error'] for record in failed],
                         ['ValueError: hcom failed: down'])

    def test_corrupt_state_files_are_kept_aside_and_watching_continues(self):
        watch_dir = self.work / '.lat/watch/orch'
        watch_dir.mkdir(parents=True)
        (watch_dir / 'state.json').write_text('{"orch": {"nudged": tru')
        (watch_dir / 'skipped-cards.json').write_text('[]')
        watch = load_watch()

        self.run_cycles(watch, 0)

        self.assertEqual((watch_dir / 'state.json.corrupt-0').read_text(),
                         '{"orch": {"nudged": tru')
        self.assertEqual((watch_dir / 'skipped-cards.json.corrupt-0').read_text(), '[]')
        records = self.watch_records()
        self.assertEqual(sorted((record['file'], record['kept']) for record in records
                                if record.get('decision') == 'state-file-reset'),
                         [('skipped-cards.json', 'skipped-cards.json.corrupt-0'),
                          ('state.json', 'state.json.corrupt-0')])
        self.assertEqual([record['agent'] for record in records if 'agent' in record],
                         ['orch', 'worker-open'])
        self.assertEqual(self.watch_state(), {})

    def test_non_object_agent_state_is_reset_for_that_agent_only(self):
        watch_dir = self.work / '.lat/watch/orch'
        watch_dir.mkdir(parents=True)
        (watch_dir / 'state.json').write_text(
            '{"orch": [], "worker-open": {"nudged": true}}')
        watch = load_watch()

        with patch.object(watch, 'observe', side_effect=ValueError('not observed')):
            self.run_cycles(watch, 0)

        records = self.watch_records()
        self.assertEqual([(record['agent'], record['decision']) for record in records],
                         [('orch', 'agent-state-reset'), ('orch', 'observation-failed'),
                          ('worker-open', 'observation-failed')])
        self.assertEqual(self.watch_state(), {'worker-open': {'nudged': True}})

    def test_missing_task_directory_watches_orchestrator_and_logs_once(self):
        watch = load_watch()
        missing = self.work / '.lat/no-tasks'
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()

        with patch.dict(os.environ, self.env):
            for now in (0, 60):
                watch.run_cycle(self.work, missing, decisions, 'orch', now=now)
            watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=120)
            watch.run_cycle(self.work, missing, decisions, 'orch', now=180)

        records = self.watch_records()
        self.assertEqual([record['at'] for record in records
                          if record.get('decision') == 'task-directory-missing'], [0, 180])
        self.assertEqual([(record['at'], record['agent']) for record in records
                          if 'observation' in record or
                          record.get('decision') == 'observation-failed'],
                         [(0, 'orch'), (60, 'orch'), (120, 'orch'), (120, 'worker-open'),
                          (180, 'orch')])


if __name__ == '__main__':
    unittest.main()
