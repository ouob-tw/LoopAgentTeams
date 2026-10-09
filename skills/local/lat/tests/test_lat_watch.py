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

    def test_quota_issue_notifies_owner_immediately_once_without_nudge(self):
        watch = load_watch()
        issue = watch.QuotaIssue(
            'usage-limit', "■ You've hit your usage limit · resets Oct 10, 2026",
            'Oct 10, 2026',
        )
        exhausted = watch.Observation(
            'worker', 'listening', True, False, 100, 1_000, 10,
            client='codex', model='GPT-5.6-Sol', quota_issue=issue,
        )

        state, actions = watch.decide(None, exhausted, now=0)

        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertIn('worker', actions[0].message)
        self.assertIn('codex', actions[0].message)
        self.assertIn('GPT-5.6-Sol', actions[0].message)
        self.assertIn(issue.line, actions[0].message)
        self.assertIn('Reset time: Oct 10, 2026', actions[0].message)
        self.assertIn('another subscribed account', actions[0].message)
        self.assertIn('Do not switch to API billing', actions[0].message)
        self.assertFalse(state['nudged'])

        state, actions = watch.decide(state, exhausted, now=600)
        self.assertEqual(actions, ())

        cleared = exhausted._replace(quota_issue=None)
        state, actions = watch.decide(state, cleared, now=601)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, exhausted, now=602)
        self.assertEqual(actions, ())

        state, _ = watch.decide(state, cleared, now=603)
        state, _ = watch.decide(state, cleared, now=604)
        state, actions = watch.decide(state, exhausted, now=605)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')

    def test_quota_issue_on_orchestrator_notifies_user_once_despite_progress(self):
        watch = load_watch()
        issue = watch.QuotaIssue(
            'usage-limit', '⚠ Usage limit reached · limit resets 9:50pm', '9:50pm')
        exhausted = watch.Observation(
            'orch', 'inactive', True, False, 100, 1_000, 10,
            is_orchestrator=True, client='claude', model='Opus 5.5',
            quota_issue=issue,
        )

        state, actions = watch.decide(None, exhausted, now=0)
        self.assertEqual(actions[0].kind, 'notify-user')
        self.assertIn('user decides', actions[0].message)
        self.assertFalse(state['nudged'])

        self.assertEqual(actions[0].label, '額度不足')

        progressed = exhausted._replace(transcript_size=101, event_id=11)
        state, actions = watch.decide(state, progressed, now=1)
        self.assertEqual(actions, ())

        later = progressed._replace(quota_issue=issue._replace(reset_time='2:50am'))
        state, actions = watch.decide(state, later, now=2)
        self.assertEqual(actions[0].kind, 'notify-user')

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
        delivered = [{'type': 'status', 'data': {'context': 'deliver:sender'}}]

        self.assertEqual(watch.wait_release_reason(declaration, delivered, False, None),
                         'message-delivered')
        self.assertEqual(watch.wait_release_reason(declaration, [], True, None),
                         'target-replied')
        self.assertEqual(watch.wait_release_reason(declaration, [], False, False),
                         'decision-resolved')
        self.assertIsNone(watch.wait_release_reason(declaration, [], False, True))

    def test_real_session_status_shapes_release_canonical_agent_waits(self):
        watch = load_watch()
        declaration = {
            'agent': 'nepa-qa-gima-claude-mova',
            'target': 'nepa-qa-gima-orch2-file',
        }
        delivered = [{
            'id': 72627, 'instance': 'mova', 'type': 'status',
            'data': {
                'context': 'deliver:nepa-qa-gima-orch2-file',
                'session': 'bea32431-8599-4365-bde3-aea585d4b837',
                'status': 'active',
            },
        }]
        self.assertEqual(watch.wait_release_reason(
            declaration, delivered, False, None), 'message-delivered')
        self.assertEqual(watch.wait_release_reason(
            declaration, [], True, None), 'target-replied')

    def test_session_events_exclude_another_session_with_the_same_short_alias(self):
        watch = load_watch()
        watched = {
            'name': 'nepa-qa-gima-handled-rebe',
            'base_name': 'rebe',
            'session_id': '01a10714-b7c1-7761-9c95-055eea581383',
        }
        owned = {
            'id': 73007, 'instance': 'rebe', 'type': 'status',
            'data': {'session': watched['session_id'], 'context': 'tool:Bash'},
        }
        collision = {
            'id': 73002, 'instance': 'rebe', 'type': 'status',
            'data': {
                'session': '01a1071e-6244-7973-9a1b-67a822b04d05',
                'context': 'tool:Bash',
            },
        }

        with patch.object(watch, 'run_json_lines',
                          return_value=[collision, owned]) as run_events:
            events = watch.session_events('orch', watched, '--last', '1')

        self.assertEqual(events, [owned])
        command = run_events.call_args.args[0]
        self.assertIn('--sql', command)
        self.assertIn(watched['session_id'], command[command.index('--sql') + 1])

    def test_successful_send_in_exact_claude_transcript_releases_wait(self):
        watch = load_watch()
        records = [
            {'timestamp': '2026-10-04T14:01:41.176Z', 'type': 'assistant',
             'message': {'content': [{'type': 'tool_use', 'id': 'tool-1',
                                      'name': 'Bash', 'input': {
                                          'command': "hcom send @worker --intent inform -- 'ok'"}}]}},
            {'timestamp': '2026-10-04T14:01:41.273Z', 'type': 'user',
             'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tool-1',
                                      'content': 'Sent to: worker', 'is_error': False}]}},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'claude.jsonl'
            transcript.write_text(''.join(json.dumps(row) + '\n' for row in records))
            self.assertTrue(watch.successful_hcom_send_since(
                transcript, '2026-10-04T14:01:40+00:00'))

    def test_successful_send_in_exact_codex_transcript_releases_wait(self):
        watch = load_watch()
        record = {
            'timestamp': '2026-10-04T14:00:59.400Z', 'type': 'event_msg',
            'payload': {'type': 'item_completed', 'item': {
                'type': 'CommandExecution',
                'command': ['/bin/bash', '-lc',
                            "hcom send @worker --intent inform -- 'ok'"],
                'status': 'completed', 'exit_code': 0,
                'stdout': 'Sent to: worker\n',
            }},
        }
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'codex.jsonl'
            transcript.write_text(json.dumps(record) + '\n')
            self.assertTrue(watch.successful_hcom_send_since(
                transcript, '2026-10-04T14:00:58+00:00'))

    def test_compound_send_to_third_agent_releases_wait(self):
        watch = load_watch()
        record = {
            'timestamp': '2026-10-04T14:00:59.400Z', 'type': 'event_msg',
            'payload': {'type': 'item_completed', 'item': {
                'type': 'CommandExecution',
                'command': ['/bin/bash', '-lc',
                            "printf report > /tmp/report && hcom send @third --file /tmp/report"],
                'status': 'completed', 'exit_code': 0,
                'stdout': 'report prepared\nSent to: third\n',
            }},
        }
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'codex.jsonl'
            transcript.write_text(json.dumps(record) + '\n')
            self.assertTrue(watch.successful_hcom_send_since(
                transcript, '2026-10-04T14:00:58+00:00'))

    def test_multiline_report_then_send_releases_wait(self):
        watch = load_watch()
        record = {
            'timestamp': '2026-10-04T14:00:59.400Z', 'type': 'event_msg',
            'payload': {'type': 'item_completed', 'item': {
                'type': 'CommandExecution',
                'command': ['/bin/bash', '-lc',
                            "cat > /tmp/report <<'EOF'\nreport\nEOF\nhcom send @third --file /tmp/report"],
                'status': 'completed', 'exit_code': 0,
                'stdout': 'Sent to: third\n',
            }},
        }
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'codex.jsonl'
            transcript.write_text(json.dumps(record) + '\n')
            self.assertTrue(watch.successful_hcom_send_since(
                transcript, '2026-10-04T14:00:58+00:00'))

    def test_claude_send_started_before_wait_and_completed_after_releases(self):
        watch = load_watch()
        records = [
            {'timestamp': '2026-10-04T14:00:59.900Z', 'type': 'assistant',
             'message': {'content': [{'type': 'tool_use', 'id': 'tool-crossing',
                                      'name': 'Bash', 'input': {
                                          'command': "cat /tmp/reply | hcom send @third --intent inform"}}]}},
            {'timestamp': '2026-10-04T14:01:00.100Z', 'type': 'user',
             'message': {'content': [{'type': 'tool_result',
                                      'tool_use_id': 'tool-crossing',
                                      'content': 'Sent to: third', 'is_error': False}]}},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'claude.jsonl'
            transcript.write_text(''.join(json.dumps(row) + '\n' for row in records))
            self.assertTrue(watch.successful_hcom_send_since(
                transcript, '2026-10-04T14:01:00+00:00'))

    def test_failed_or_old_send_attempt_does_not_release_wait(self):
        watch = load_watch()
        records = [
            {'timestamp': '2026-10-04T14:00:00Z', 'type': 'event_msg',
             'payload': {'type': 'item_completed', 'item': {
                 'type': 'CommandExecution',
                 'command': ['/bin/bash', '-lc', 'hcom send --help'],
                 'status': 'completed', 'exit_code': 0, 'stdout': 'Usage: hcom send',
             }}},
            {'timestamp': '2026-10-04T14:02:00Z', 'type': 'event_msg',
             'payload': {'type': 'item_completed', 'item': {
                 'type': 'CommandExecution',
                 'command': ['/bin/bash', '-lc', "hcom send @missing -- 'ok'"],
                 'status': 'failed', 'exit_code': 1, 'stdout': '',
             }}},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'failed.jsonl'
            transcript.write_text(''.join(json.dumps(row) + '\n' for row in records))
            self.assertFalse(watch.successful_hcom_send_since(
                transcript, '2026-10-04T14:01:00+00:00'))

    def release_wait_after_target_send(self, recipient, participant_events=()):
        watch = load_watch()
        declaration = {
            'agent': 'waiting-agent', 'target': 'target-agent',
            'declared_at_utc': '2026-10-04T14:00:58+00:00', 'active': True,
        }
        record = {
            'timestamp': '2026-10-04T14:00:59.400Z', 'type': 'event_msg',
            'payload': {'type': 'item_completed', 'item': {
                'type': 'CommandExecution',
                'command': ['/bin/bash', '-lc',
                            f"hcom send @{recipient} --intent inform -- 'ok'"],
                'status': 'completed', 'exit_code': 0,
                'stdout': f'Sent to: ◉ {recipient}\n',
            }},
        }
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            transcript = root / 'target.jsonl'
            transcript.write_text(json.dumps(record) + '\n')
            decisions = root / 'decisions'
            decisions.mkdir()
            agents = {
                'waiting-agent': {
                    'name': 'waiting-agent', 'base_name': 'waiter',
                    'session_id': 'waiting-session',
                },
                'target-agent': {
                    'name': 'target-agent', 'base_name': 'target',
                    'session_id': 'target-session',
                    'transcript_path': str(transcript),
                },
            }
            with patch.object(
                    watch, 'session_events', return_value=list(participant_events)):
                return watch.release_wait_if_needed(
                    root, decisions, 'orch', declaration, agents=agents)

    def test_target_message_to_third_party_does_not_release_wait(self):
        self.assertIsNone(self.release_wait_after_target_send('third-agent'))

    def test_target_message_addressed_to_waiter_releases_before_delivery(self):
        self.assertEqual(
            self.release_wait_after_target_send('waiting-agent'),
            'target-replied',
        )

    def test_same_alias_delivery_does_not_turn_third_party_send_into_target_reply(self):
        collision = [{
            'id': 82309, 'instance': 'waiter', 'type': 'status',
            'data': {
                'context': 'deliver:target',
                'msg_ts': '2026-10-04T14:00:59.400Z',
                'session': 'waiting-session', 'status': 'active',
            },
        }]
        self.assertEqual(
            self.release_wait_after_target_send('third-agent', collision),
            'message-delivered',
        )

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

    def rule_session(self, name='orch', sid='rules', **overrides):
        skill = self.root / f'skill-{name}'
        (skill / 'references').mkdir(parents=True, exist_ok=True)
        (skill / 'SKILL.md').write_text('original rules')
        (skill / 'references/nested').mkdir(exist_ok=True)
        (skill / 'references/nested/guide.md').write_text('original guide')
        record = dict(session_id=sid, role='orchestrator', status='active',
                      workspace=str(self.work), hcom_name=name, skill_dir=str(skill))
        record.update(overrides)
        path = self.work / '.lat/sessions' / f'{sid}.json'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record))
        return skill, path

    def rule_notices(self):
        return [line for line in self.hcom_log.read_text().splitlines()
                if line.startswith('send ') and 'LAT skill rules updated' in line]

    def test_legacy_baseline_then_rule_change_notifies_once_and_survives_restart(self):
        skill, record = self.rule_session()
        self.run_cycles(load_watch(), 0)
        baseline = json.loads(record.read_text())['rule_fingerprint']
        self.assertEqual(set(baseline), {'SKILL.md', 'references/nested/guide.md'})
        self.assertEqual(self.rule_notices(), [])
        (skill / 'references/nested/guide.md').write_text('updated guide')
        self.run_cycles(load_watch(), 60, 120)
        notices = self.rule_notices()
        self.assertEqual(len(notices), 1)
        self.assertIn('@orch', notices[0])
        self.assertIn('references/nested/guide.md', notices[0])
        self.assertIn('re-read SKILL.md', notices[0])
        self.assertNotEqual(json.loads(record.read_text())['rule_fingerprint'], baseline)

    def test_failed_rule_notice_retains_baseline_and_retries_next_cycle(self):
        skill, record = self.rule_session()
        self.run_cycles(load_watch(), 0)
        baseline = record.read_text()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = send ] && [ -e "$FAIL_SEND" ]; then exit 1; fi\n'
            'printf \'%s\\n\' \'[]\'\n'
        )
        failure = self.root / 'fail-send'
        failure.touch()
        self.env['FAIL_SEND'] = str(failure)
        (skill / 'SKILL.md').write_text('second rules')
        self.run_cycles(load_watch(), 60)
        self.assertEqual(record.read_text(), baseline)
        self.assertEqual(len(self.rule_notices()), 1)
        self.assertTrue(any(row.get('decision') == 'skill-rules-check-failed'
                            for row in self.watch_records()))
        failure.unlink()
        self.run_cycles(load_watch(), 120, 180)
        self.assertEqual(len(self.rule_notices()), 2)
        self.assertNotEqual(record.read_text(), baseline)

    def test_independent_changes_additions_and_removals_each_get_one_notice(self):
        skill, record = self.rule_session()
        self.run_cycles(load_watch(), 0)
        (skill / 'SKILL.md').write_text('second rules')
        self.run_cycles(load_watch(), 60, 120)
        self.assertEqual(len(self.rule_notices()), 1)
        (skill / 'references/new.txt').write_text('new reference')
        (skill / 'references/nested/guide.md').unlink()
        self.run_cycles(load_watch(), 180, 240)
        notices = self.rule_notices()
        self.assertEqual(len(notices), 2)
        self.assertIn('references/new.txt', notices[1])
        self.assertIn('references/nested/guide.md', notices[1])
        fingerprint = json.loads(record.read_text())['rule_fingerprint']
        self.assertIn('references/new.txt', fingerprint)
        self.assertNotIn('references/nested/guide.md', fingerprint)

    def test_delivered_notice_is_not_resent_when_fingerprint_save_fails(self):
        skill, record = self.rule_session()
        watch = load_watch()
        self.run_cycles(watch, 0)
        original = record.read_text()
        # The fake send denies saves after delivery, leaving reads and stall checks working.
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = send ] && [ -e "$FAIL_SAVE" ]; then\n'
            '  chmod 500 "$RULE_DIR"\n'
            'fi\n'
            'printf \'%s\\n\' \'[]\'\n'
        )
        failure = self.root / 'fail-save'
        failure.touch()
        self.env.update(FAIL_SAVE=str(failure), RULE_DIR=str(record.parent))
        self.addCleanup(record.parent.chmod, 0o700)
        (skill / 'SKILL.md').write_text('delivered rules')
        self.run_cycles(watch, 60)
        self.assertEqual(len(self.rule_notices()), 1)
        self.assertEqual(record.read_text(), original)
        self.run_cycles(watch, 120)
        self.assertEqual(len(self.rule_notices()), 1)
        self.assertEqual(record.read_text(), original)
        failure.unlink()
        (skill / 'references/nested/guide.md').write_text('independent guide update')
        self.run_cycles(watch, 150, 160)
        self.assertEqual(len(self.rule_notices()), 2)
        self.assertEqual(record.read_text(), original)
        record.parent.chmod(0o700)
        self.run_cycles(watch, 180, 240)
        self.assertEqual(len(self.rule_notices()), 2)
        self.assertNotEqual(record.read_text(), original)
        (skill / 'SKILL.md').write_text('next independent update')
        self.run_cycles(watch, 300, 360)
        self.assertEqual(len(self.rule_notices()), 3)

    def test_failed_legacy_baseline_save_retries_without_notice(self):
        _, record = self.rule_session()
        original = record.read_text()
        self.addCleanup(record.parent.chmod, 0o700)
        record.parent.chmod(0o500)
        self.run_cycles(load_watch(), 0, 60)
        self.assertEqual(record.read_text(), original)
        self.assertEqual(self.rule_notices(), [])
        record.parent.chmod(0o700)
        self.run_cycles(load_watch(), 120)
        self.assertIn('SKILL.md', json.loads(record.read_text())['rule_fingerprint'])
        self.assertEqual(self.rule_notices(), [])

    def test_removed_skill_file_and_reference_subtree_are_listed(self):
        skill, record = self.rule_session()
        self.run_cycles(load_watch(), 0)
        (skill / 'SKILL.md').unlink()
        self.run_cycles(load_watch(), 60, 120)
        self.assertEqual(len(self.rule_notices()), 1)
        self.assertIn('SKILL.md', self.rule_notices()[0])
        (skill / 'references/nested/guide.md').unlink()
        (skill / 'references/nested').rmdir()
        (skill / 'references').rmdir()
        self.run_cycles(load_watch(), 180, 240)
        self.assertEqual(len(self.rule_notices()), 2)
        self.assertIn('references/nested/guide.md', self.rule_notices()[1])
        self.assertEqual(json.loads(record.read_text())['rule_fingerprint'], {})

    def test_program_cache_and_timestamp_changes_do_not_notify(self):
        skill, record = self.rule_session()
        self.run_cycles(load_watch(), 0)
        baseline = record.read_text()
        for relative in ('scripts/program.py', 'herdr-panel/panel.js',
                         '.cache/value', 'references/__pycache__/guide.pyc',
                         'references/.cache/value', 'references/guide.pyc'):
            path = skill / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('changed program or cache')
        os.utime(skill / 'SKILL.md', (100, 100))
        self.run_cycles(load_watch(), 60, 120)
        self.assertEqual(self.rule_notices(), [])
        self.assertEqual(record.read_text(), baseline)

    def test_coordinators_only_compare_their_own_active_session_skill_directory(self):
        own_skill, own_record = self.rule_session()
        other_skill, other_record = self.rule_session('other', 'other-rules')
        _, worker = self.rule_session('orch', 'worker-rules', role='worker')
        _, inactive = self.rule_session('orch', 'inactive-rules', status='completed')
        _, foreign = self.rule_session('orch', 'foreign-rules', workspace=str(self.root))
        self.run_cycles(load_watch(), 0)
        self.assertNotIn('rule_fingerprint', json.loads(other_record.read_text()))
        for path in (worker, inactive, foreign):
            self.assertNotIn('rule_fingerprint', json.loads(path.read_text()))
        decisions = self.work / '.lat/decisions'
        with patch.dict(os.environ, self.env):
            load_watch().run_cycle(self.work, self.tasks, decisions, 'other', now=0)
        (other_skill / 'SKILL.md').write_text('other update')
        self.run_cycles(load_watch(), 60)
        self.assertEqual(self.rule_notices(), [])
        with patch.dict(os.environ, self.env):
            load_watch().run_cycle(self.work, self.tasks, decisions, 'other', now=60)
        self.assertEqual(len(self.rule_notices()), 1)
        self.assertIn('@other', self.rule_notices()[0])
        (own_skill / 'SKILL.md').write_text('own update')
        self.run_cycles(load_watch(), 120)
        self.assertEqual(len(self.rule_notices()), 2)
        self.assertIn('@orch', self.rule_notices()[1])

    def test_missing_skill_directory_keeps_baseline_and_recovers_next_cycle(self):
        skill, record = self.rule_session()
        self.run_cycles(load_watch(), 0)
        baseline = record.read_text()
        moved = skill.with_name('temporarily-moved')
        skill.rename(moved)
        self.run_cycles(load_watch(), 60)
        self.assertEqual(record.read_text(), baseline)
        self.assertEqual(self.rule_notices(), [])
        moved.rename(skill)
        (skill / 'SKILL.md').write_text('reinstalled rules')
        self.run_cycles(load_watch(), 120, 180)
        self.assertEqual(len(self.rule_notices()), 1)

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

    def test_wait_resolves_base_name_and_watcher_recognizes_valid_wait(self):
        transcript = self.fake_transcript()
        self.write_task('advisor.md', 'team-advisor', 'orch', 'in progress')
        self.install_hcom(
            '#!/bin/sh\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening"}},'
            f'{{"name":"team-advisor","base_name":"advisor","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'fi\n'
        )
        result = self.cli('wait', '--workspace', self.work, '--agent', 'advisor',
                          '--for', 'orch', '--reason', 'standby')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['agent'], 'team-advisor')
        stored = self.work / '.lat/watch/waits/team-advisor.json'
        self.assertEqual(json.loads(stored.read_text())['agent'], 'team-advisor')
        self.assertFalse((stored.parent / 'advisor.json').exists())
        self.run_cycles(load_watch(), 0, 3600)
        self.assertEqual(self.watch_state()['team-advisor']['decision'], 'valid-wait')
        self.assertFalse(any(row['actions'] for row in self.watch_records()
                             if row.get('agent') == 'team-advisor'))

    def test_wait_rejects_ambiguous_and_unknown_names_without_writing(self):
        self.install_hcom(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'[{"name":"team-advisor"},'
            '{"name":"other-advisor"}]\'\n'
        )
        for agent, message in (('advisor', 'ambiguous'), ('missing', 'unknown')):
            for previous in (None, b'{"active": true}\n'):
                with self.subTest(agent=agent, previous=previous):
                    path = self.work / '.lat/watch/waits' / f'{agent}.json'
                    if previous is not None:
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(previous)
                    result = self.cli('wait', '--workspace', self.work, '--agent', agent,
                                      '--for', 'orch', '--reason', 'standby')
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr.lower())
                    self.assertIn(agent, result.stderr)
                    self.assertEqual(result.stdout, '')
                    if previous is None:
                        self.assertFalse(path.exists())
                    else:
                        self.assertEqual(path.read_bytes(), previous)
        self.assertEqual(sorted(p.name for p in path.parent.iterdir()),
                         ['advisor.json', 'missing.json'])

    def test_wait_resolved_name_still_checks_owning_coordinator(self):
        decisions = self.wait_session()
        (decisions / 'HELP.md').write_text('- status: approved\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'open',
                          '--for', 'HELP', '--reason', 'standby')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no pending decision for orch', result.stderr)
        self.assertFalse((self.work / '.lat/watch/waits').exists())

    def test_wait_listing_failure_accepts_given_name_with_warning(self):
        self.install_hcom('#!/bin/sh\necho unavailable >&2\nexit 1\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'advisor',
                          '--for', 'orch', '--reason', 'standby')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('hcom list', result.stderr)
        self.assertIn('advisor', result.stderr)
        self.assertEqual(json.loads(result.stdout)['agent'], 'advisor')
        path = self.work / '.lat/watch/waits/advisor.json'
        self.assertEqual(json.loads(path.read_text())['agent'], 'advisor')

    def wait_session(self, name='orch', status='active'):
        decisions = self.work / f'decisions-{name}'
        decisions.mkdir(exist_ok=True)
        sessions = self.work / '.lat/sessions'
        sessions.mkdir(exist_ok=True)
        (sessions / f'{name}.json').write_text(json.dumps({
            'role': 'orchestrator', 'status': status, 'hcom_name': name,
            'workspace': str(self.work), 'tasks_path': str(self.tasks),
            'decisions_path': str(decisions),
        }))
        return decisions

    def test_wait_refuses_resolved_decision_without_writing_or_replacing_declaration(self):
        decisions = self.wait_session()
        (decisions / 'HELP-r1.md').write_text('- status: approved\n')
        (decisions / 'HELP-r2.md').write_text('- status: rejected\n')
        declaration = self.work / '.lat/watch/waits/worker-open.json'
        for previous in (None, b'{"active": true, "target": "reviewer"}\n'):
            with self.subTest(previous=previous):
                if previous is not None:
                    declaration.parent.mkdir(parents=True, exist_ok=True)
                    declaration.write_bytes(previous)
                result = self.cli('wait', '--workspace', self.work,
                                  '--agent', 'worker-open', '--for', 'HELP',
                                  '--reason', 'waiting for manual step')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, '')
                for text in ('HELP-r1.md', 'approved', 'HELP-r2.md', 'rejected',
                             'pending decision', 'manual step'):
                    self.assertIn(text, result.stderr)
                if previous is None:
                    self.assertFalse(declaration.exists())
                else:
                    self.assertEqual(declaration.read_bytes(), previous)

    def test_wait_accepts_pending_unreadable_prefix_and_agent_targets(self):
        decisions = self.wait_session()
        cases = {
            'PENDING': [('PENDING.md', '- status: pending\n')],
            'PREFIX': [('PREFIX-r1.md', '- status: approved\n'),
                       ('PREFIX-r2.md', '- status: pending\n')],
            'UNKNOWN': [('UNKNOWN.md', '# no status\n')],
            'MALFORMED': [('MALFORMED.md', '- status: approved pending\n')],
            'reviewer': [],
        }
        for target, records in cases.items():
            with self.subTest(target=target):
                for name, content in records:
                    (decisions / name).write_text(content)
                result = self.cli('wait', '--workspace', self.work,
                                  '--agent', 'worker-open', '--for', target,
                                  '--reason', 'waiting')
                self.assertEqual(result.returncode, 0, result.stderr)
                stored = json.loads((self.work / '.lat/watch/waits/worker-open.json')
                                    .read_text())
                self.assertEqual(stored['target'], target)
                self.assertTrue(stored['active'])

    def test_wait_uses_only_owning_coordinator_for_self_and_task_agents(self):
        self.install_hcom(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'[{"name":"orch"},{"name":"worker-open"},'
            '{"name":"somebody-else"},{"name":"worker-other"}]\'\n'
        )
        own = self.wait_session()
        other = self.wait_session('somebody-else')
        for own_status, other_status in [('approved', 'pending'), ('pending', 'approved')]:
            (own / 'HELP.md').write_text(f'- status: {own_status}\n')
            (other / 'HELP.md').write_text(f'- status: {other_status}\n')
            for agent in ('orch', 'worker-open', 'somebody-else', 'worker-other'):
                with self.subTest(own_status=own_status, agent=agent):
                    result = self.cli('wait', '--workspace', self.work,
                                      '--agent', agent, '--for', 'HELP', '--reason', 'waiting')
                    expected = own_status if agent in ('orch', 'worker-open') else other_status
                    self.assertEqual(result.returncode == 0, expected == 'pending', result.stderr)

    def test_wait_accepts_decision_whose_content_cannot_be_decoded(self):
        decisions = self.wait_session()
        (decisions / 'HELP.md').write_bytes(b'- status: \xff\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'HELP', '--reason', 'waiting')
        self.assertEqual(result.returncode, 0, result.stderr)
        stored = json.loads((self.work / '.lat/watch/waits/worker-open.json').read_text())
        self.assertEqual(stored['target'], 'HELP')
        self.assertTrue(stored['active'])

    def test_wait_without_owning_active_coordinator_keeps_existing_behavior(self):
        own = self.wait_session(status='completed')
        other = self.wait_session('somebody-else')
        for decisions in (own, other):
            (decisions / 'HELP.md').write_text('- status: approved\n')
        self.install_hcom(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'[{"name":"orch"},{"name":"worker-open"},'
            '{"name":"worker-merged"},{"name":"worker-done"},{"name":"unlisted"}]\'\n'
        )
        for agent in ('orch', 'worker-open', 'worker-merged', 'worker-done', 'unlisted'):
            with self.subTest(agent=agent):
                result = self.cli('wait', '--workspace', self.work, '--agent', agent,
                                  '--for', 'HELP', '--reason', 'waiting')
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_wait_refuses_if_any_owning_coordinator_has_no_pending_decision(self):
        own = self.wait_session()
        other = self.wait_session('somebody-else')
        self.write_card('shared.md', 'worker-open', orchestrator='somebody-else')
        (own / 'HELP.md').write_text('- status: pending\n')
        (other / 'HELP.md').write_text('- status: approved\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'HELP', '--reason', 'waiting')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('somebody-else', result.stderr)
        self.assertFalse((self.work / '.lat/watch/waits/worker-open.json').exists())

    def test_wait_skips_incomplete_active_sessions_and_still_checks_valid_owner(self):
        decisions = self.wait_session()
        sessions = self.work / '.lat/sessions'
        record = json.loads((sessions / 'orch.json').read_text())
        for missing in ('hcom_name', 'tasks_path', 'decisions_path'):
            incomplete = dict(record)
            incomplete.pop(missing)
            (sessions / 'a-legacy.json').write_text(json.dumps(incomplete))
            for status in ('pending', 'approved'):
                with self.subTest(missing=missing, status=status):
                    (decisions / 'HELP.md').write_text(f'- status: {status}\n')
                    result = self.cli('wait', '--workspace', self.work,
                                      '--agent', 'worker-open', '--for', 'HELP',
                                      '--reason', 'waiting')
                    if status == 'pending':
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertTrue(json.loads(result.stdout)['active'])
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('HELP.md: approved', result.stderr)

    def test_wait_skips_corrupt_sessions_and_still_checks_valid_owner(self):
        decisions = self.wait_session()
        invalid = self.work / '.lat/sessions/a-corrupt.json'
        for content in (b'{broken', b'[]', b'\xff'):
            invalid.write_bytes(content)
            for status in ('pending', 'approved'):
                with self.subTest(content=content, status=status):
                    (decisions / 'HELP.md').write_text(f'- status: {status}\n')
                    result = self.cli('wait', '--workspace', self.work,
                                      '--agent', 'worker-open', '--for', 'HELP',
                                      '--reason', 'waiting')
                    if status == 'pending':
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertTrue(json.loads(result.stdout)['active'])
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn('HELP.md: approved', result.stderr)

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
        self.assertTrue(all(f'term inject {agent} [lat-watch] Read any unread HCOM messages '
                            in line for agent, line in zip(('orch', 'worker-open'), injections)))
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

    def finished_codex_fixture(self, client='codex'):
        transcript = self.root / 'finished.jsonl'
        # Real incident shape: completion precedes late items of the same turn.
        rows = [
            {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn-1'}},
            {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'turn-1'}},
            {'type': 'event_msg', 'payload': {'type': 'item_completed', 'turn_id': 'turn-1'}},
            {'type': 'event_msg', 'payload': {'type': 'token_count'}},
        ]
        transcript.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        agents = [{'name': name, 'status': 'active', 'tool': client,
                   'transcript_path': str(transcript),
                   'launch_context': {'pid_identity': 'linux:boot:100'}}
                  for name in ('orch', 'worker-open')]
        listing = self.root / 'agents.json'
        listing.write_text(json.dumps(agents))
        terminal = self.root / 'terminal.json'
        terminal.write_text(json.dumps({'ready': True, 'prompt_empty': True,
                                        'input_text': '', 'lines': []}))
        self.env.update(FAKE_AGENTS=str(listing), FAKE_TERMINAL=str(terminal))
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then cat "$FAKE_AGENTS";\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then cat "$FAKE_TERMINAL";\n'
            'elif [ "$1" = events ]; then printf \'%s\\n\' \'{"id":1,"type":"status"}\'; fi\n'
        )
        return transcript

    def run_finished_cycles(self, watch, *times):
        # The OS process list is an external observation seam, like fake hcom.
        processes = [watch.Process(10, 1, 100, 'S', 10, ('codex',), ()),
                     watch.Process(11, 10, 101, 'S', 11, ('sh', 'background-send'), ())]
        with patch.object(watch, 'read_processes', return_value=processes):
            self.run_cycles(watch, *times)

    def injections(self):
        return [line for line in self.hcom_log.read_text().splitlines()
                if line.startswith('term inject ')]

    def test_nudge_echo_and_client_error_escalate_without_restarting_episode(self):
        for client in ('claude', 'codex'):
            with self.subTest(client=client):
                transcript = self.finished_codex_fixture(client)
                watch = load_watch()
                self.run_cycles(watch, 0, 1_200)
                if client == 'claude':
                    rows = [
                        {'type': 'file-history-snapshot', 'snapshot': {'trackedFileBackups': {}},
                         'isSnapshotUpdate': False},
                        {'type': 'user', 'message': {'role': 'user', 'content': watch.NUDGE}},
                        {'type': 'attachment', 'attachment': {'type': 'total_tokens_reminder'}},
                        {'type': 'assistant', 'isApiErrorMessage': True,
                         'error': 'authentication_failed', 'message': {'role': 'assistant',
                         'content': [{'type': 'text', 'text': 'Login expired · Please run /login'}]}},
                        {'type': 'assistant', 'message': {'role': 'assistant',
                         'content': [{'type': 'text', 'text': watch.NUDGE}]}},
                        {'type': 'assistant', 'message': {'role': 'assistant',
                         'content': [{'type': 'text', 'text': 'OK'}]}},
                        {'type': 'assistant', 'message': {'role': 'assistant',
                         'content': [{'type': 'text', 'text': 'Nothing to do'}]}},
                        {'type': 'system', 'subtype': 'stop_hook_summary', 'hookCount': 2,
                         'hookErrors': [], 'preventedContinuation': False},
                        {'type': 'system', 'subtype': 'turn_duration'},
                        {'type': 'last-prompt', 'lastPrompt': watch.NUDGE},
                    ]
                else:
                    rows = [
                        {'type': 'event_msg', 'payload': {'type': 'task_started'}},
                        {'type': 'world_state', 'payload': {'full': False, 'state': {}}},
                        {'type': 'turn_context', 'payload': {'model': 'test'}},
                        {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': watch.NUDGE}},
                        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user',
                         'content': [{'type': 'input_text', 'text': watch.NUDGE}]}},
                        {'type': 'event_msg', 'payload': {'type': 'error', 'message': 'Authentication failed'}},
                        {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': watch.NUDGE}},
                        {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant',
                         'content': [{'type': 'output_text', 'text': watch.NUDGE}]}},
                        {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'Nothing to do'}},
                        {'type': 'response_item', 'payload': {'type': 'reasoning', 'summary': []}},
                        {'type': 'token_usage_record', 'payload': {'usage': {}}},
                        {'type': 'event_msg', 'payload': {'type': 'item_completed', 'item': {
                         'type': 'AgentMessage', 'content': [{'type': 'Text', 'text': 'OK'}]}}},
                        {'type': 'event_msg', 'payload': {'type': 'task_complete', 'last_agent_message': watch.NUDGE}},
                    ]
                with transcript.open('a') as stream:
                    stream.write(''.join(json.dumps(row) + '\n' for row in rows))
                self.run_cycles(watch, 1_260, 1_799)
                self.assertTrue(all(state['nudged'] for state in self.watch_state().values()))
                self.assertTrue(all(state['last_progress_at'] == 0
                                    for state in self.watch_state().values()))
                self.run_cycles(watch, 1_800)
                notices = [(row['agent'], action['kind']) for row in self.watch_records()[-2:]
                           if row.get('at') == 1_800 for action in row.get('actions', [])]
                self.assertEqual(notices, [('orch', 'notify-user'),
                                          ('worker-open', 'notify-orchestrator')])
                nudge_count = len(self.injections())
                self.run_cycles(watch, 2_400, 2_401, 3_000)
                self.assertEqual(len(self.injections()), nudge_count)
                later = [(row['agent'], action['kind'])
                         for row in self.watch_records()[-6:]
                         for action in row.get('actions', [])]
                self.assertEqual(later, [('worker-open', 'notify-user')])
                # Start the next client with a fresh persisted episode.
                (self.work / '.lat/watch/orch/state.json').unlink()

    def test_nudge_lifecycle_events_do_not_hide_incoming_messages_or_outgoing_work(self):
        transcript = self.finished_codex_fixture('claude')
        watch = load_watch()
        agents_path = Path(self.env['FAKE_AGENTS'])
        agents = json.loads(agents_path.read_text())
        for agent in agents:
            agent['session_id'] = agent['name'] + '-session'
        agents_path.write_text(json.dumps(agents))
        events_path = self.root / 'events.jsonl'
        events_path.write_text('')
        self.env['FAKE_EVENTS'] = str(events_path)
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then cat "$FAKE_AGENTS";\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then cat "$FAKE_TERMINAL";\n'
            'elif [ "$1" = events ]; then cat "$FAKE_EVENTS"; fi\n'
        )
        self.run_cycles(watch, 0, 1_200)
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'user', 'message': {
                'role': 'user', 'content': watch.NUDGE}}) + '\n')
        # Actual Claude incident lifecycle, including an empty ready context.
        events = [{'id': index + 1, 'type': 'status', 'data': {
            'session': agent['session_id'], 'context': context,
            'status': 'listening' if context == '' else 'active'}}
            for index, (agent, context) in enumerate(
                (agent, context) for agent in agents for context in
                ('prompt', 'failure:authentication_failed', ''))]
        events_path.write_text(''.join(json.dumps(row) + '\n' for row in events))
        self.run_cycles(watch, 1_260)
        self.assertTrue(all(state['nudged'] for state in self.watch_state().values()))
        # Delayed same-session listening observation without transcript growth.
        events.extend([{'id': 7 + index, 'type': 'status', 'data': {
            'session': agent['session_id'], 'context': '', 'status': 'listening'}}
            for index, agent in enumerate(agents)])
        events_path.write_text(''.join(json.dumps(row) + '\n' for row in events))
        self.run_cycles(watch, 1_280)
        self.assertTrue(all(state['last_progress_at'] == 0
                            for state in self.watch_state().values()))
        # Another agent's message still counts, even when a later status is latest.
        events.extend([
            {'id': 9, 'type': 'message', 'data': {'session': 'worker-open-session',
             'from': 'other', 'text': 'incoming message'}},
            {'id': 10, 'type': 'status', 'data': {'session': 'worker-open-session', 'context': ''}},
            {'id': 11, 'type': 'status', 'data': {'session': 'orch-session', 'context': 'tool:send'}},
        ])
        events_path.write_text(''.join(json.dumps(row) + '\n' for row in events))
        self.run_cycles(watch, 1_300)
        for state in self.watch_state().values():
            self.assertEqual(state['last_progress_at'], 1_300)
            self.assertFalse(state['nudged'])

    def test_real_assistant_or_tool_work_after_nudge_restarts_episode(self):
        cases = [
            ('claude', {'type': 'assistant', 'message': {'role': 'assistant',
             'content': [{'type': 'text', 'text': 'The defect is caused by the reset branch. ' * 6}]}}),
            ('claude', {'type': 'assistant', 'message': {'role': 'assistant',
             'content': [{'type': 'tool_use', 'name': 'Bash', 'input': {'command': 'rg reset'}}]}}),
            ('codex', {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant',
             'content': [{'type': 'output_text', 'text': 'The defect is caused by the reset branch. ' * 6}]}}),
            ('codex', {'type': 'response_item', 'payload': {'type': 'function_call',
             'name': 'exec_command', 'arguments': '{"cmd":"rg reset"}'}}),
        ]
        for client, work in cases:
            with self.subTest(client=client, work=work):
                state_path = self.work / '.lat/watch/orch/state.json'
                state_path.unlink(missing_ok=True)
                transcript = self.finished_codex_fixture(client)
                watch = load_watch()
                self.run_cycles(watch, 0, 1_200)
                nudge = ({'type': 'user', 'message': {'role': 'user', 'content': watch.NUDGE}}
                         if client == 'claude' else {'type': 'event_msg', 'payload': {
                             'type': 'user_message', 'message': watch.NUDGE}})
                with transcript.open('a') as stream:
                    stream.write(json.dumps(nudge) + '\n')
                self.run_cycles(watch, 1_260)
                self.assertTrue(all(state['nudged'] for state in self.watch_state().values()))
                with transcript.open('a') as stream:
                    stream.write(json.dumps(work) + '\n')
                self.run_cycles(watch, 1_300, 1_800)
                for state in self.watch_state().values():
                    self.assertEqual(state['last_progress_at'], 1_300)
                    self.assertFalse(state['nudged'])
                    self.assertFalse(state['orchestrator_notified'])
                    self.assertFalse(state['user_notified'])

    def test_short_reply_boundary_and_real_work_record_shapes(self):
        watch = load_watch()
        cases = [
            ('claude', {'type': 'assistant', 'message': {'role': 'assistant',
             'content': [{'type': 'text', 'text': 'x' * 200}]}}, True),
            ('claude', {'type': 'assistant', 'message': {'role': 'assistant',
             'content': [{'type': 'text', 'text': 'x' * 201}]}}, False),
            ('claude', {'type': 'file-history-delta', 'trackingPath': 'example.py'}, False),
            ('claude', {'type': 'assistant', 'message': {'role': 'assistant',
             'content': [{'type': 'text', 'text': 'OK'}, {'type': 'tool_use',
                          'name': 'Edit', 'input': {'file_path': 'example.py'}}]}}, False),
            ('codex', {'type': 'event_msg', 'payload': {'type': 'item_completed',
             'item': {'type': 'UserMessage', 'content': [
                 {'type': 'text', 'text': watch.NUDGE}]}}}, True),
            ('codex', {'type': 'event_msg', 'payload': {'type': 'item_completed',
             'item': {'type': 'Reasoning', 'summary_text': []}}}, True),
            ('codex', {'type': 'event_msg', 'payload': {'type': 'item_completed',
             'item': {'type': 'CommandExecution', 'command': ['hcom', 'send']}}}, False),
            ('codex', {'type': 'event_msg', 'payload': {'type': 'item_completed',
             'item': {'type': 'FileChange', 'changes': {'example.py': {'type': 'update'}}}}}, False),
            ('codex', {'type': 'response_item', 'payload': {'type': 'custom_tool_call',
             'name': 'exec', 'input': 'edit a file'}}, False),
        ]
        with tempfile.TemporaryDirectory() as directory:
            transcript = Path(directory) / 'transcript.jsonl'
            for client, record, expected in cases:
                with self.subTest(client=client, record=record):
                    nudge = ({'type': 'user', 'message': {'role': 'user', 'content': watch.NUDGE}}
                             if client == 'claude' else {'type': 'event_msg', 'payload': {
                                 'type': 'user_message', 'message': watch.NUDGE}})
                    transcript.write_text(json.dumps(nudge) + '\n' + json.dumps(record) + '\n')
                    self.assertEqual(watch.nudge_transcript_only(
                        transcript, 0, transcript.stat().st_size, client), expected)

    def test_unrecognized_or_corrupt_nudge_suffix_keeps_original_progress_rule(self):
        for suffix in ('not-json\n', json.dumps({'type': 'user', 'message': {
                'role': 'user', 'content': 'A new task from another agent'}}) + '\n'):
            with self.subTest(suffix=suffix):
                (self.work / '.lat/watch/orch/state.json').unlink(missing_ok=True)
                transcript = self.finished_codex_fixture('claude')
                watch = load_watch()
                self.run_cycles(watch, 0, 1_200)
                with transcript.open('a') as stream:
                    stream.write(json.dumps({'type': 'user', 'message': {
                        'role': 'user', 'content': watch.NUDGE}}) + '\n' + suffix)
                self.run_cycles(watch, 1_260)
                for state in self.watch_state().values():
                    self.assertEqual(state['last_progress_at'], 1_260)
                    self.assertFalse(state['nudged'])

    def test_finished_codex_with_background_process_nudges_once_at_twenty_minutes(self):
        self.finished_codex_fixture()
        watch = load_watch()
        self.run_finished_cycles(watch, 0, 1_199)
        self.assertEqual(self.injections(), [])
        self.run_finished_cycles(watch, 1_200, 1_201)
        self.assertEqual(len(self.injections()), 2)
        self.assertTrue(all('[lat-watch] Read any unread HCOM messages' in line
                            for line in self.injections()))
        for row in self.watch_records():
            self.assertTrue(row['observation']['command_running'])
            self.assertTrue(row['observation']['codex_turn_finished'])
            if row['actions']:
                self.assertEqual(row['state']['stall_reason'],
                                 'Codex turn finished but status active')

    def test_finished_codex_escalates_despite_background_process(self):
        self.finished_codex_fixture()
        watch = load_watch()
        self.run_finished_cycles(watch, 0, 1_200, 1_799)
        self.assertFalse(any(row['actions'] and row['actions'][0]['kind'].startswith('notify')
                             for row in self.watch_records()))
        self.run_finished_cycles(watch, 1_800, 1_801, 2_399)
        notices = [(row['agent'], row['actions'][0]['kind']) for row in self.watch_records()
                   if row['actions'] and row['actions'][0]['kind'].startswith('notify')]
        self.assertEqual(notices, [('orch', 'notify-user'),
                                  ('worker-open', 'notify-orchestrator')])
        self.run_finished_cycles(watch, 2_400, 2_401)
        notices = [(row['agent'], row['actions'][0]['kind']) for row in self.watch_records()
                   if row['actions'] and row['actions'][0]['kind'].startswith('notify')]
        self.assertEqual(notices[-1], ('worker-open', 'notify-user'))
        self.assertEqual(len(notices), 3)
        self.assertEqual(len(self.injections()), 2)

    def test_new_codex_turn_after_nudge_resets_clock_and_prevents_escalation(self):
        transcript = self.finished_codex_fixture()
        watch = load_watch()
        self.run_finished_cycles(watch, 0, 1_200)
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {
                'type': 'task_started', 'turn_id': 'turn-2'}}) + '\n')
        self.run_finished_cycles(watch, 1_300, 1_800, 2_499)
        self.assertEqual(len(self.injections()), 2)
        for state in self.watch_state().values():
            self.assertEqual(state['last_progress_at'], 1_300)
            self.assertFalse(state['nudged'])
            self.assertFalse(state['orchestrator_notified'])
            self.assertFalse(state['user_notified'])
        for row in self.watch_records()[-2:]:
            self.assertFalse(row['observation']['codex_turn_finished'])
            self.assertEqual(row['actions'], [])

    def test_finished_codex_valid_pending_wait_suppresses_nudge_and_escalation(self):
        self.finished_codex_fixture()
        decisions = self.wait_session()
        (decisions / 'HELP.md').write_text('- status: pending\n')
        for agent in ('orch', 'worker-open'):
            result = self.cli('wait', '--workspace', self.work, '--agent', agent,
                              '--for', 'HELP', '--reason', 'waiting for user')
            self.assertEqual(result.returncode, 0, result.stderr)
        self.run_finished_cycles(load_watch(), 0, 1_200, 1_800, 2_400)
        self.assertEqual(self.injections(), [])
        self.assertTrue(all(row['observation']['wait_active'] for row in self.watch_records()))
        self.assertTrue(all(row['actions'] == [] for row in self.watch_records()))

    def test_unfinished_codex_with_process_notifies_once_without_nudge(self):
        transcript = self.finished_codex_fixture()
        transcript.write_text(json.dumps({'type': 'event_msg', 'payload': {
            'type': 'task_started', 'turn_id': 'turn-2'}}) + '\n')
        self.run_finished_cycles(load_watch(), 0, 1_199, 1_200, 1_800, 2_400)
        self.assertEqual(self.injections(), [])
        notices = [row for row in self.watch_records() if row['actions']]
        self.assertEqual(len(notices), 2)
        self.assertTrue(all('possible hung command' in row['actions'][0]['message']
                            for row in notices))
        self.assertTrue(all(row['observation']['codex_turn_finished'] is False
                            for row in self.watch_records()))

    def test_new_user_input_after_completion_preserves_running_command_behavior(self):
        for new_input in (
                {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'next'}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user'}}):
            with self.subTest(new_input=new_input):
                transcript = self.finished_codex_fixture()
                with transcript.open('a') as stream:
                    stream.write(json.dumps(new_input) + '\n')
                self.run_finished_cycles(load_watch(), 0, 1_200)
                self.assertEqual(self.injections(), [])
                self.assertTrue(all(row['observation']['codex_turn_finished'] is False
                                    for row in self.watch_records()[-2:]))

    def test_unknown_codex_tail_preserves_running_behavior_and_other_observations(self):
        for content in (b'', b'{broken\n', b'\xff\n', b'[]\n',
                        b'{"type":"event_msg","payload":null}\n',
                        b'{"type":"event_msg","payload":{"type":"token_count"}}\n'):
            with self.subTest(content=content):
                transcript = self.finished_codex_fixture()
                transcript.write_bytes(content)
                self.run_finished_cycles(load_watch(), 0, 1_200)
                self.assertEqual(self.injections(), [])
                for row in self.watch_records()[-2:]:
                    self.assertIsNone(row['observation']['codex_turn_finished'])
                    self.assertIn('possible hung command', row['actions'][0]['message'])

    def test_decoder_limit_corruption_is_unknown_and_healthy_agent_still_nudges(self):
        for content in (b'[' * 10_000 + b']' * 10_000,
                        b'{"number":' + b'9' * 5_000 + b'}'):
            with self.subTest(content_length=len(content)):
                corrupt = self.finished_codex_fixture()
                healthy = self.root / 'healthy.jsonl'
                healthy.write_bytes(corrupt.read_bytes())
                listing = self.root / 'agents.json'
                agents = json.loads(listing.read_text())
                agents[1]['transcript_path'] = str(healthy)
                listing.write_text(json.dumps(agents))
                corrupt.write_bytes(content + b'\n')
                watch = load_watch()
                self.run_finished_cycles(watch, 0, 1_200)
                rows = self.watch_records()[-2:]
                self.assertEqual([row['agent'] for row in rows], ['orch', 'worker-open'])
                self.assertIsNone(rows[0]['observation']['codex_turn_finished'])
                self.assertIn('possible hung command', rows[0]['actions'][0]['message'])
                self.assertTrue(rows[1]['observation']['codex_turn_finished'])
                self.assertEqual(rows[1]['actions'], [{'kind': 'nudge', 'agent': 'worker-open'}])
                self.assertTrue(all('worker-open' in line for line in self.injections()))

    def test_missing_and_unreadable_codex_tail_recovers_without_losing_other_agents(self):
        transcript = self.finished_codex_fixture()
        original = transcript.read_bytes()
        watch = load_watch()
        transcript.unlink()
        self.run_finished_cycles(watch, 0, 1_200)
        for row in self.watch_records():
            self.assertIsNone(row['observation']['codex_turn_finished'])
        transcript.write_bytes(original)
        original_open = Path.open

        def denied(path, *args, **kwargs):
            if path == transcript:
                raise PermissionError('transcript inaccessible')
            return original_open(path, *args, **kwargs)

        with patch.object(Path, 'open', denied):
            self.run_finished_cycles(watch, 1_300)
        self.assertTrue(all(row['observation']['codex_turn_finished'] is None
                            for row in self.watch_records()[-2:]))
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {
                'type': 'token_count'}}) + '\n')
        self.run_finished_cycles(watch, 1_400, 2_599)
        self.assertEqual(self.injections(), [])
        self.run_finished_cycles(watch, 2_600)
        self.assertEqual(len(self.injections()), 2)

    def test_unreadable_codex_stat_is_unknown_and_other_agent_observation_survives(self):
        corrupt = self.finished_codex_fixture()
        healthy = self.root / 'healthy.jsonl'
        healthy.write_bytes(corrupt.read_bytes())
        listing = self.root / 'agents.json'
        agents = json.loads(listing.read_text())
        agents[1]['transcript_path'] = str(healthy)
        listing.write_text(json.dumps(agents))
        original_open = Path.open
        original_stat = Path.stat

        def denied_open(path, *args, **kwargs):
            if path == corrupt:
                raise PermissionError('transcript parent inaccessible')
            return original_open(path, *args, **kwargs)

        def denied_stat(path, *args, **kwargs):
            if path == corrupt:
                raise PermissionError('transcript parent inaccessible')
            return original_stat(path, *args, **kwargs)

        with patch.object(Path, 'open', denied_open), patch.object(Path, 'stat', denied_stat):
            self.run_finished_cycles(load_watch(), 0, 1_200)
        rows = self.watch_records()[-2:]
        self.assertIsNone(rows[0]['observation']['codex_turn_finished'])
        self.assertEqual(rows[0]['observation']['transcript_size'], 0)
        self.assertTrue(rows[1]['observation']['codex_turn_finished'])
        self.assertEqual(rows[1]['actions'], [{'kind': 'nudge', 'agent': 'worker-open'}])

    def test_codex_boundary_outside_tail_is_unknown(self):
        transcript = self.finished_codex_fixture()
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {
                'type': 'token_count', 'padding': 'x' * 300_000}}) + '\n')
        self.run_finished_cycles(load_watch(), 0, 1_200)
        self.assertEqual(self.injections(), [])
        self.assertTrue(all(row['observation']['codex_turn_finished'] is None
                            for row in self.watch_records()))

    def test_late_same_turn_event_resets_progress_without_reopening_codex_turn(self):
        transcript = self.finished_codex_fixture()
        watch = load_watch()
        self.run_finished_cycles(watch, 0, 1_199)
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'event_msg', 'payload': {
                'type': 'item_completed', 'turn_id': 'turn-1'}}) + '\n')
        self.run_finished_cycles(watch, 1_200, 2_399)
        self.assertEqual(self.injections(), [])
        self.run_finished_cycles(watch, 2_400)
        self.assertEqual(len(self.injections()), 2)
        self.assertTrue(all(row['observation']['codex_turn_finished']
                            for row in self.watch_records()))

    def test_claude_completed_shape_with_process_keeps_current_behavior(self):
        self.finished_codex_fixture(client='claude')
        self.run_finished_cycles(load_watch(), 0, 1_200, 1_800, 2_400)
        self.assertEqual(self.injections(), [])
        notices = [row for row in self.watch_records() if row['actions']]
        self.assertEqual(len(notices), 2)
        self.assertTrue(all('possible hung command' in row['actions'][0]['message']
                            for row in notices))
        self.assertTrue(all(row['observation']['codex_turn_finished'] is None
                            for row in self.watch_records()))

    def test_quota_screen_matchers_use_only_current_bottom_ui_lines(self):
        watch = load_watch()

        capacity = watch.detect_screen_quota([
            '', '', '', '', '', '', '', '',
            '■ Selected model is at capacity. Please try a different model.',
            '', '', '› Ask Codex to do anything', '',
            '  GPT-5.6-Sol medium · ~/repo · Context 0% used',
        ], 'codex')
        codex_limit = watch.detect_screen_quota([
            '', '', '', '', '', '', '', '',
            "■ You've hit your usage limit · resets Oct 10, 2026",
            '', '', '› Ask Codex to do anything', '',
            '  GPT-6.1-Sol medium · ~/repo · 0% left',
        ], 'codex')
        claude_limit = watch.detect_screen_quota([
            '', '', '', '', '', '──────────',
            '  ⚠ Usage limit reached · limit resets 9:50pm',
            '    Continuing shortly · esc to cancel',
            '  Opus 5.5 medium · ~/repo · Context 20% used',
            '  ⏵⏵ bypass permissions on',
        ], 'claude')

        self.assertIn('Selected model is at capacity', capacity.line)
        self.assertIsNone(capacity.reset_time)
        self.assertIn("You've hit your usage limit", codex_limit.line)
        self.assertEqual(codex_limit.reset_time, 'Oct 10, 2026')
        self.assertEqual(claude_limit.reset_time, '9:50pm')

        capacity_notice = watch.quota_notice(watch.Observation(
            'worker', 'active', True, False, 1, 1, 1,
            client='codex', model='GPT-5.6-Sol', quota_issue=capacity,
        ))
        self.assertIn('switch to another model', capacity_notice.message)
        self.assertNotIn('subscribed account', capacity_notice.message)

        historical = watch.detect_screen_quota([
            '', '', '', '', '', '', '', '',
            '■ Selected model is at capacity. Please try a different model.',
            '› Retry the previous request now',
            'Working (2m 41s · esc to interrupt)',
            '', '› Ask Codex to do anything', '',
            '  GPT-5.6-Sol medium · ~/repo · Context 2% used',
        ], 'codex')
        quoted = watch.detect_screen_quota([
            '', '', '', '', '', '', '', '',
            '• The test quotes "Selected model is at capacity" and',
            "  ■ You've hit your usage limit inside a quoted code block.",
            '', '› Ask Codex to do anything', '',
            '  GPT-5.6-Sol medium · ~/repo · Context 2% used',
        ], 'codex')
        early_warning = watch.detect_screen_quota([
            '', '', '', '', '', '', '', '',
            "  You've used 92% of your session limit · resets 10:20pm",
            '', '', '❯', '',
            '  Opus 5.5 medium · ~/repo',
        ], 'claude')

        self.assertIsNone(historical)
        self.assertIsNone(quoted)
        self.assertIsNone(early_warning)

        wrapped_current = watch.detect_screen_quota([
            "■ You've hit your usage limit. Try again at",
            'Oct 10, 2026 9:30 PM.',
            'Additional current error detail.',
            '', '', '', '', '', '', '', '', '',
            '› Ask Codex to do anything', '',
            '  GPT-5.6-Sol medium · ~/repo · 0% left',
        ], 'codex')
        self.assertEqual(wrapped_current.reset_time, 'Oct 10, 2026 9:30 PM')

    def test_claude_primary_quota_line_extracts_reset_time(self):
        watch = load_watch()
        issue = watch.detect_screen_quota([
            '● Usage limit reached · continuing automatically at',
            '  1:40am · esc to cancel',
            '', '──────────', '❯',
            '──────────',
            '  Opus 5.5 medium · ~/repo',
        ], 'claude', claude_notice=(
            'Usage limit reached · continuing automatically at 1:40am · '
            'esc to cancel'))

        self.assertIn('continuing automatically', issue.line)
        self.assertEqual(issue.reset_time, '1:40am')

        quoted = watch.detect_screen_quota([
            '● Usage limit reached · continuing automatically at 1:40am ·',
            '  esc to cancel',
            '', '──────────', '❯',
            '──────────',
            '  Opus 5.5 medium · ~/repo',
        ], 'claude')
        self.assertIsNone(quoted)

        wrapped_footer = watch.detect_screen_quota([
            '', '──────────', '❯',
            '──────────',
            '  ⚠ Usage limit reached · limit resets',
            '    tomorrow at 9:50pm',
            '  Opus 5.5 medium · ~/repo',
        ], 'claude')
        self.assertEqual(wrapped_footer.reset_time, 'tomorrow at 9:50pm')

        footer_without_model = watch.detect_screen_quota([
            '', '──────────', '❯',
            '──────────',
            '  ⚠ Usage limit reached · limit resets 9:50pm',
            '    Continuing shortly · esc to cancel',
        ], 'claude')
        self.assertEqual(footer_without_model.reset_time, '9:50pm')

        current_footer_after_old_primary = watch.detect_screen_quota([
            '● Usage limit reached · continuing automatically at 1:40am ·',
            '  esc to cancel',
            '● Later ordinary response completed a newer turn.',
            '', '──────────', '❯',
            '──────────',
            '  ⚠ Usage limit reached · limit resets 9:50pm',
            '  Opus 5.5 medium · ~/repo',
        ], 'claude')
        self.assertTrue(current_footer_after_old_primary.line.startswith('⚠'))
        self.assertEqual(current_footer_after_old_primary.reset_time, '9:50pm')

        newer_turn = watch.detect_screen_quota([
            '● Usage limit reached · continuing automatically at 1:40am ·',
            '  esc to cancel', '', '❯ Continue now',
            'Working…', '', '──────────', '❯',
            '──────────',
            '  Opus 5.5 medium · ~/repo',
        ], 'claude', claude_notice=(
            'Usage limit reached · continuing automatically at 1:40am · '
            'esc to cancel'))
        self.assertIsNone(newer_turn)

    def test_current_claude_quota_notice_requires_latest_system_record(self):
        watch = load_watch()
        transcript = self.root / 'claude.jsonl'
        notice = 'Usage limit reached · continuing automatically at 1:40am · esc to cancel'
        transcript.write_text(json.dumps({
            'type': 'system', 'subtype': 'informational', 'level': 'notice',
            'content': notice,
        }) + '\n')

        self.assertEqual(watch.current_claude_quota_notice(transcript), notice)

        with transcript.open('a') as stream:
            stream.write(json.dumps({
                'type': 'assistant',
                'message': {'role': 'assistant', 'content': notice},
            }) + '\n')
        self.assertIsNone(watch.current_claude_quota_notice(transcript))

    def disappearance_hcom(self, status=None, **fields):
        agents = [{'name': 'orch', 'status': 'listening', 'session_id': 'orch-id'}]
        if status is not None:
            agents.append(dict(name='worker-open', status=status, **fields))
        listing = self.root / 'agents.json'
        listing.write_text(json.dumps(agents))
        delivered = self.root / 'delivered'
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            f'if [ "$1" = list ]; then cat "{listing}"\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            f'elif [ "$1" = send ]; then touch "{delivered}"\n'
            f'elif [ "$1" = events ] && [ -f "{delivered}" ]; then\n'
            '  printf \'%s\\n\' \'{"id":2,"type":"status",'
            '"data":{"session":"orch-id","status_context":"deliver:lat-watch"}}\'\n'
            'fi\n'
        )

    def disappearance_notices(self):
        return [action for record in self.watch_records()
                for action in record.get('actions', [])
                if action.get('category') == 'agent-disappeared']

    def test_two_missing_cycles_notify_once_without_nudge(self):
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 0)
        self.assertEqual(self.disappearance_notices(), [])
        self.run_cycles(load_watch(), 60, 120)
        notices = self.disappearance_notices()
        self.assertEqual(len(notices), 1)
        self.assertIn('worker-open', notices[0]['message'])
        self.assertIn('open.md', notices[0]['message'])
        self.assertIn('last seen status: unknown', notices[0]['message'])
        self.assertIn('last seen time: unknown', notices[0]['message'])
        commands = self.hcom_log.read_text().splitlines()
        self.assertEqual(len([line for line in commands if line.startswith('send ')]), 1)
        self.assertFalse(any(line.startswith('term inject ') for line in commands))

    def test_one_missing_cycle_then_reappearance_does_not_notify(self):
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 0)
        self.disappearance_hcom('listening')
        self.run_cycles(load_watch(), 60)
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 120)
        self.assertEqual(self.disappearance_notices(), [])

    def test_inactive_cycles_notify_once_without_terminal_or_nudge(self):
        self.disappearance_hcom('inactive', status_context='exit:unexpected')
        self.run_cycles(load_watch(), 0)
        self.assertEqual(self.disappearance_notices(), [])
        self.run_cycles(load_watch(), 60, 120)
        notices = self.disappearance_notices()
        self.assertEqual(len(notices), 1)
        self.assertIn('last seen status: inactive', notices[0]['message'])
        self.assertIn('1970-01-01T00:01:00+00:00', notices[0]['message'])
        self.assertFalse(any(line.startswith('term worker-open') or
                             line.startswith('term inject worker-open')
                             for line in self.hcom_log.read_text().splitlines()))

    def test_reappearance_resets_episode_and_preserves_last_seen(self):
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 0, 60, 120)
        self.disappearance_hcom('listening')
        self.run_cycles(load_watch(), 180)
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 240)
        self.assertEqual(len(self.disappearance_notices()), 1)
        self.run_cycles(load_watch(), 300, 360)
        notices = self.disappearance_notices()
        self.assertEqual(len(notices), 2)
        self.assertIn('last seen status: listening', notices[-1]['message'])
        self.assertIn('1970-01-01T00:03:00+00:00', notices[-1]['message'])

    def test_card_archived_before_shutdown_does_not_notify(self):
        self.disappearance_hcom('listening')
        self.run_cycles(load_watch(), 0)
        (self.tasks / 'open.md').rename(self.tasks / 'done/open.md')
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 60, 120)
        self.assertEqual(self.disappearance_notices(), [])
        self.assertNotIn('worker-open', self.watch_state())

    def test_notification_releases_orchestrator_wait_via_message_delivery(self):
        watch = load_watch()
        declaration = {
            'agent': 'orch', 'target': 'worker-open', 'active': True,
            'declared_at': 0, 'declared_at_utc': '1970-01-01T00:00:00+00:00',
        }
        path = watch.wait_path(self.work, 'orch')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(declaration))
        self.disappearance_hcom()
        self.run_cycles(watch, 0, 60, 120)
        released = json.loads(path.read_text())
        self.assertFalse(released['active'])
        self.assertEqual(released['released_reason'], 'message-delivered')

    def test_corrupt_disappearance_state_resets_only_that_agent_and_recovers(self):
        for corrupt in ({'missing_cycles': 'bad'},
                        {'missing_cycles': -1},
                        {'missing_cycles': 1, 'last_seen_at': 'bad'},
                        {'missing_cycles': 1, 'last_seen_at': 10 ** 30}):
            with self.subTest(state=corrupt):
                watch = load_watch()
                self.disappearance_hcom()
                self.write_task('z-healthy.md', 'worker-z', 'orch', 'in progress')
                listing = self.root / 'agents.json'
                agents = json.loads(listing.read_text())
                agents.append({'name': 'worker-z', 'status': 'listening'})
                listing.write_text(json.dumps(agents))
                watch.write_object(watch.state_path(self.work, 'orch'), {
                    'worker-open': corrupt,
                })
                self.run_cycles(watch, 0)
                self.assertEqual(self.disappearance_notices(), [])
                self.assertIn('orch', self.watch_state())
                self.assertIn('worker-z', self.watch_state())
                self.run_cycles(watch, 60, 120)
                self.assertEqual(len(self.disappearance_notices()), 1)
                self.assertTrue(any(record.get('decision') == 'agent-state-reset'
                                    for record in self.watch_records()))
                self.assertTrue(list(watch.state_path(self.work, 'orch').parent.glob(
                    'state.json.corrupt-*')))
                watch.state_path(self.work, 'orch').with_name('watch.jsonl').write_text('')

    def test_disappearance_delivery_failure_retries_then_deduplicates(self):
        watch = load_watch()
        self.disappearance_hcom()
        self.run_cycles(watch, 0)
        with patch.object(watch, 'perform', side_effect=ValueError('send failed')):
            self.run_cycles(watch, 60)
        self.run_cycles(watch, 120, 180)
        results = [result for record in self.watch_records()
                   for result in record.get('action_results', [])]
        self.assertEqual([result['status'] for result in results], ['failed', 'done'])
        sends = [line for line in self.hcom_log.read_text().splitlines()
                 if line.startswith('send ')]
        self.assertEqual(len(sends), 1)

    def test_inactive_rate_limit_notifies_once_even_when_term_is_unavailable(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"tool":"claude","transcript_path":"{transcript}"}},'
            f'{{"name":"worker-open","status":"inactive",'
            f'"status_context":"failure:rate_limit","status_detail":"rate_limit",'
            f'"tool":"claude","transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" = worker-open ]; then\n'
            '  printf "inactive terminal unavailable\\n" >&2\n'
            '  exit 8\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true,'
            '"input_text":"","lines":["",">","  Opus 5.5 medium · ~/repo"]}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        watch = load_watch()

        self.run_cycles(watch, 0, 60)

        commands = self.hcom_log.read_text().splitlines()
        sends = [line for line in commands if line.startswith('send ')]
        injections = [line for line in commands if line.startswith('term inject ')]
        self.assertEqual(len(sends), 1)
        self.assertIn('--intent request', sends[0])
        self.assertIn('inactive (failure:rate_limit)', sends[0])
        self.assertIn('claude', sends[0])
        self.assertEqual(injections, [])
        self.assertEqual(self.disappearance_notices(), [])
        state = self.watch_state()['worker-open']
        self.assertTrue(state['quota_notified'])

    def test_blocked_approval_with_null_input_notifies_once_without_keys(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"tool":"codex","transcript_path":"{transcript}"}},'
            f'{{"name":"worker-open","status":"blocked",'
            f'"status_context":"approval","tool":"claude",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ] && [ "$2" = worker-open ]; then\n'
            '  printf \'%s\\n\' \'{"ready":false,"prompt_empty":false,'
            '"input_text":null,"lines":["Do you want to proceed?",'
            '"  1. Yes","  2. No"]}\'\n'
            'elif [ "$1" = term ] && [ "$2" != inject ]; then\n'
            '  printf \'%s\\n\' \'{"ready":false,"prompt_empty":true,'
            '"input_text":"","lines":[]}\'\n'
            'elif [ "$1" = events ]; then\n'
            '  printf \'%s\\n\' \'{"id":1,"type":"status"}\'\n'
            'fi\n'
        )
        watch = load_watch()

        self.run_cycles(watch, 0, 599, 600, 1_200)

        commands = self.hcom_log.read_text().splitlines()
        sends = [line for line in commands if line.startswith('send ')]
        injections = [line for line in commands if line.startswith('term inject ')]
        self.assertEqual(len(sends), 1)
        self.assertIn('--intent request', sends[0])
        self.assertIn('approval prompt', sends[0])
        self.assertEqual(injections, [])
        records = [record for record in self.watch_records()
                   if record.get('agent') == 'worker-open']
        self.assertFalse(any(record.get('decision') == 'observation-failed'
                             for record in records))
        self.assertTrue(records[-1]['state']['orchestrator_notified'])

    def test_quota_screen_with_null_input_and_missing_prompt_empty_is_valid(self):
        watch = load_watch()
        terminal = {
            'ready': True,
            'input_text': None,
            'lines': [
                '', '', '', '', '', '', '', '',
                '■ Selected model is at capacity. Please try a different model.',
                '', '', '› Ask Codex to do anything', '',
                '  GPT-5.6-Sol medium · ~/repo',
            ],
        }
        info = {'status': 'active', 'tool': 'codex', 'unread_count': 0}

        with patch.object(watch, 'run_json', return_value=terminal), \
                patch.object(watch, 'session_events', return_value=[]), \
                patch.object(watch, 'release_wait_if_needed', return_value=None), \
                patch.object(watch, 'read_processes', return_value=[]):
            observation = watch.observe(
                self.work, self.work / '.lat/decisions', 'orch', 'worker-open', info)

        self.assertEqual(observation.input_text, '')
        self.assertFalse(observation.prompt_empty)
        self.assertEqual(observation.model, 'GPT-5.6-Sol')
        self.assertIn('Selected model is at capacity', observation.quota_issue.line)
        state, actions = watch.decide(None, observation, now=0)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertFalse(state['nudged'])

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
            'list --json --name orch',
        ])
        self.assertEqual(self.herdr_log.read_text().splitlines(), [
            'notification show 停住: worker-open --sound request',
        ])

    def test_user_popup_is_one_line_with_client_workspace_tab_and_agent(self):
        watch = load_watch()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'[{"name":"orch","tool":"claude",'
            '"launch_context":{"pane_id":"w1:p1"}}]\'\n'
        )
        herdr = Path(self.env['PATH'].split(':', 1)[0]) / 'herdr'
        herdr.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HERDR_LOG"\n'
            'case "$1" in\n'
            '  pane) printf \'%s\\n\' \'{"result":{"pane":{"label":"p","tab_id":"w1:t1"}}}\';;\n'
            '  tab) printf \'%s\\n\' \'{"result":{"tab":{"label":"STUDY",'
            '"workspace_id":"w1"}}}\';;\n'
            '  workspace) printf \'%s\\n\' \'{"result":{"workspace":{"label":"LAT"}}}\';;\n'
            'esac\n'
        )
        herdr.chmod(0o755)

        with patch.dict(os.environ, self.env):
            watch.perform(watch.Action('notify-user', 'orch', 'long detail',
                                       category='quota', label='額度不足'), 'orch')

        self.assertEqual(self.herdr_log.read_text().splitlines()[-1],
                         'notification show claude額度不足: LAT STUDY orch --sound request')

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
            'list --json --name orch',
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
        popup = next(command[3] for command in commands
                     if command[:3] == ['herdr', 'notification', 'show'])
        self.assertIn(original, hcom_note)
        self.assertIn(str(saved), hcom_note)
        self.assertEqual(popup, '輸入未送出: worker-open')
        self.assertEqual(result['reason'], 'prompt text backed up and cleared')

    def test_prompt_recovery_waits_for_delayed_terminal_redraw_after_each_key(self):
        watch = load_watch()
        original = 'QA-TEST-STABLE-ORIGINAL'
        visible = original
        terminal_reads = []
        for _ in original:
            terminal_reads.extend((visible, visible[:-1]))
            visible = visible[:-1]

        with patch.object(watch, 'read_prompt_status', return_value=(original, 1)), \
                patch.object(watch, 'run_command', return_value=''), \
                patch.object(watch, 'read_terminal_input', side_effect=terminal_reads), \
                patch.object(watch.time, 'sleep', return_value=None):
            result = watch.perform(
                watch.Action('recover-prompt', 'worker-open', text=original),
                'orch', self.work,
            )

        self.assertEqual(result['reason'], 'prompt text backed up and cleared')
        self.assertEqual(result['backspaces'], len(original))

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
                patch.object(watch, 'read_terminal_input', return_value='tool banner'), \
                patch.object(watch, 'PROMPT_SETTLE_SECONDS', 0):
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
                             side_effect=lambda _agent, _orch: next(terminal_reads)), \
                patch.object(watch, 'PROMPT_SETTLE_SECONDS', 0):
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

    def test_stopped_worker_still_counts_disappearance_after_stall_notice(self):
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
        self.assertEqual(state['worker-open']['missing_cycles'], 1)
        records = self.watch_records()
        stopped = [record for record in records if record['agent'] == 'worker-open']
        self.assertEqual(
            stopped[-1]['decision'], 'agent-disappeared')

    def test_failed_hcom_user_notification_retries_without_calling_herdr(self):
        (self.tasks / 'open.md').rename(self.tasks / 'done/open.md')
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

    def test_cycle_keeps_unreadable_wait_and_releases_it_after_record_is_fixed(self):
        transcript = self.fake_transcript()
        self.install_hcom(
            '#!/bin/sh\n'
            'if [ "$1" = list ]; then\n'
            f'  printf \'%s\\n\' \'[{{"name":"orch","status":"listening",'
            f'"transcript_path":"{transcript}"}},'
            f'{{"name":"worker-open","status":"listening",'
            f'"transcript_path":"{transcript}"}}]\'\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'fi\n'
        )
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        record = decisions / 'CHOICE.md'
        record.write_text('- Status: still pending overall\n')
        declaration = {
            'agent': 'worker-open', 'target': 'CHOICE', 'reason': 'decision',
            'declared_at': 0,
            'declared_at_utc': '2026-10-05T00:00:00+00:00', 'active': True,
        }
        watch = load_watch()
        wait_file = watch.wait_path(self.work, 'worker-open')
        watch.write_object(wait_file, declaration)

        self.run_cycles(watch, 0)

        self.assertEqual(json.loads(wait_file.read_text()), declaration)
        self.assertEqual(self.watch_state()['worker-open']['decision'], 'valid-wait')
        diagnostics = [entry for entry in self.watch_records()
                       if entry.get('decision') == 'decision-status-unreadable']
        self.assertEqual(len(diagnostics), 1)
        self.assertEqual(diagnostics[0]['file'], str(record))
        self.assertIn('第一個字不是 pending', diagnostics[0]['error'])

        record.write_text('- STATUS: APPROVED\n')
        self.run_cycles(watch, 60)

        saved = json.loads(wait_file.read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'decision-resolved')
        self.assertNotEqual(self.watch_state()['worker-open']['decision'], 'valid-wait')
        self.assertEqual(sum(entry.get('decision') == 'decision-status-unreadable'
                             for entry in self.watch_records()), 1)

    def test_real_event_shape_releases_and_persists_an_inactive_wait(self):
        hcom = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'case " $* " in\n'
            '  *" list --json "*)\n'
            '    printf \'%s\\n\' \'[{"name":"worker-open","base_name":"open",'
            '"session_id":"worker-session"}]\' ;;\n'
            '  *"worker-session"*)\n'
            '    printf \'%s\\n\' \'{"id":72627,"instance":"open","type":"status",'
            '"data":{"context":"deliver:sender","session":"worker-session",'
            '"status":"active"}}\' ;;\n'
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
                              if record.get('decision') == 'agent-disappeared']), 3)
        self.assertEqual(len([record for record in records
                              if record.get('decision') == 'observation-failed']), 3)
        failures = [result for record in records for result in record.get('action_results', [])
                    if result['status'] == 'failed']
        self.assertEqual(len(failures), 4)
        state = json.loads((self.work / '.lat/watch/orch/state.json').read_text())
        self.assertFalse(state['orch']['nudged'])
        self.assertFalse(state['worker-open']['nudged'])

    def test_missing_terminal_readiness_is_logged_and_takes_no_action(self):
        (self.tasks / 'open.md').rename(self.tasks / 'done/open.md')
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
        self.assertEqual(self.watch_state(), {
            name: {'last_seen_status': 'listening', 'last_seen_at': 0}
            for name in ('orch', 'worker-open')
        })

    def test_non_object_agent_state_is_kept_aside_and_reset_for_that_agent_only(self):
        watch_dir = self.work / '.lat/watch/orch'
        watch_dir.mkdir(parents=True)
        original = '{"orch": [], "worker-open": {"nudged": true}}'
        (watch_dir / 'state.json').write_text(original)
        watch = load_watch()

        with patch.object(watch, 'observe', side_effect=ValueError('not observed')):
            self.run_cycles(watch, 0)

        records = self.watch_records()
        self.assertEqual([(record['agent'], record['decision']) for record in records],
                         [('orch', 'agent-state-reset'), ('orch', 'observation-failed'),
                          ('worker-open', 'observation-failed')])
        self.assertEqual(records[0]['kept'], 'state.json.corrupt-0')
        self.assertEqual((watch_dir / 'state.json.corrupt-0').read_text(), original)
        self.assertEqual(self.watch_state(), {
            'worker-open': {'nudged': True, 'last_seen_status': 'listening',
                            'last_seen_at': 0},
            'orch': {'last_seen_status': 'listening', 'last_seen_at': 0},
        })

    def test_malformed_agent_state_fields_restart_that_agent_fresh(self):
        watch_dir = self.work / '.lat/watch/orch'
        watch_dir.mkdir(parents=True)
        watch = load_watch()
        observation = watch.Observation('orch', 'listening', True, False, 0, 0, 0)
        healthy, _ = watch.decide(None, observation._replace(agent='worker-open'), 0)
        original = json.dumps({
            'orch': {'fingerprint': [0, 0, 0], 'last_progress_at': 'bad', 'nudged': False},
            'worker-open': healthy,
        })
        (watch_dir / 'state.json').write_text(original)

        def observe(workspace, decisions, orchestrator, agent, info, card=None):
            return observation._replace(agent=agent)

        with patch.object(watch, 'observe', side_effect=observe):
            self.run_cycles(watch, 60, 120)

        records = self.watch_records()
        resets = [record for record in records if record.get('decision') == 'agent-state-reset']
        self.assertEqual([(record['at'], record['agent']) for record in resets], [(60, 'orch')])
        self.assertTrue(resets[0]['error'].startswith('TypeError'))
        self.assertEqual((watch_dir / 'state.json.corrupt-60').read_text(), original)
        self.assertFalse([record for record in records
                          if record.get('decision') == 'observation-failed'])
        state = self.watch_state()
        self.assertEqual(state['orch']['last_progress_at'], 60)
        self.assertEqual(state['worker-open']['last_progress_at'], 0)

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
