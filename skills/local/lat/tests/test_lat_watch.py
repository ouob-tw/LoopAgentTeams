"""Behavior and CLI contract tests for the LAT stall watcher."""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import importlib.util
import json
import os
import re
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-watch.py'
SPAWN_WATCH = Path(__file__).resolve().parents[2] / 'hcom-spawn/scripts/spawn-watch.py'
TAIPEI = timezone(timedelta(hours=8))
_UNSET_LEDGER = object()


def load_watch():
    spec = importlib.util.spec_from_file_location('lat_watch', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setUpModule():
    # No test may run a real reap against the host; tests that check the call replace this.
    isolated = tempfile.TemporaryDirectory()
    unittest.addModuleCleanup(isolated.cleanup)
    patcher = patch.dict(os.environ, LAT_REAP_COMMAND='true',
                         LAT_HCOM_PAUSED_DIR=isolated.name + '/paused',
                         XDG_STATE_HOME=isolated.name + '/state')
    patcher.start()
    unittest.addModuleCleanup(patcher.stop)


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

    def test_inform_and_ack_keep_a_wait_but_request_or_no_intent_releases_it(self):
        watch = load_watch()
        declaration = {'agent': 'worker', 'target': 'reviewer'}
        delivered = [{'type': 'status', 'data': {'context': 'deliver:other', 'position': 9}}]

        def message(sender, intent):
            return {'type': 'message', 'data': {'from': sender, 'intent': intent}}

        def reason(messages, pending=True):
            return watch.wait_release_reason(
                declaration, delivered, False, pending, messages)

        self.assertIsNone(reason([message('other', 'inform'), message('x', 'ack')]))
        # A request anywhere in a delivered batch releases, even before a later inform.
        self.assertEqual(reason([message('x', 'request'), message('y', 'inform')]),
                         'message-delivered')
        # The wait target's inform/ack no longer releases; its request or bare message does.
        for sender in ('reviewer', 'rev'):
            self.assertIsNone(reason([message(sender, 'inform')]))
            self.assertIsNone(reason([message(sender, 'ack')]))
            self.assertEqual(reason([message(sender, 'request')]), 'message-delivered')
            self.assertEqual(reason([message(sender, None)]), 'message-delivered')
        # Unknown messages keep the old behaviour: release.
        self.assertEqual(reason([]), 'message-delivered')
        self.assertEqual(reason([message('x', 'inform')], pending=False), 'decision-resolved')
        self.assertEqual(watch.wait_release_reason(
            declaration, [], True, True, []), 'target-replied')

    def test_request_watch_notice_keeps_a_wait_but_other_hcom_events_release_it(self):
        watch = load_watch()
        declaration = {'agent': 'worker', 'target': 'reviewer'}
        delivered = [{'type': 'status', 'data': {'context': 'deliver:[hcom-events]', 'position': 9}}]

        def message(sender, text, intent=None):
            data = {'from': sender, 'text': text}
            if intent:
                data['intent'] = intent
            return {'type': 'message', 'data': data}

        notice = message('[hcom-events]', '@worker [sub:reqwatch-12-sofe] #14 sofe went idle '
                         'without responding to your request #12')
        idle = message('[hcom-events]', '@worker [sub:idle-sofe] #15 sofe is idle')
        request = message('lead', 'please look', 'request')

        def reason(messages):
            return watch.wait_release_reason(declaration, delivered, False, True, messages)

        self.assertIsNone(reason([notice]))
        self.assertIsNone(reason([notice, notice]))
        self.assertEqual(reason([notice, request]), 'message-delivered')
        self.assertEqual(reason([request, notice]), 'message-delivered')
        self.assertEqual(reason([idle]), 'message-delivered')
        self.assertEqual(reason([notice, idle]), 'message-delivered')
        # Only HCOM's own sender counts as a notice, and only with the subscription tag.
        self.assertEqual(reason([message('lead', '[sub:reqwatch-12-sofe] copy')]),
                         'message-delivered')
        self.assertEqual(reason([message('[hcom-events]', None)]), 'message-delivered')

    def test_lat_watch_own_notice_keeps_a_wait_but_other_agents_requests_release_it(self):
        watch = load_watch()
        declaration = {'agent': 'worker', 'target': 'reviewer'}
        delivered = [{'type': 'status', 'data': {'context': 'deliver:lat-watch', 'position': 9}}]

        def message(sender, intent='request'):
            return {'type': 'message', 'data': {
                'from': sender, 'intent': intent,
                'text': 'LAT skill rules updated. Changed files: SKILL.md.'}}

        def reason(messages):
            return watch.wait_release_reason(declaration, delivered, False, True, messages)

        self.assertIsNone(reason([message('lat-watch')]))
        self.assertIsNone(reason([message('lat-watch'), message('lat-watch')]))
        self.assertEqual(reason([message('lat-watch'), message('reviewer')]), 'message-delivered')
        self.assertEqual(reason([message('reviewer')]), 'message-delivered')
        self.assertEqual(reason([message('lat-watcher')]), 'message-delivered')

    def test_delivered_messages_reads_messages_addressed_to_the_waiter(self):
        watch = load_watch()
        events = [{'type': 'status', 'data': {'context': 'deliver:x', 'position': 7}},
                  {'type': 'status', 'data': {'context': 'tool:Bash'}}]
        sent = []
        def fake(orchestrator, *filters):
            sent.append(filters)
            return [{'type': 'message', 'id': 6, 'data': {'delivered_to': ['open']}},
                    {'type': 'message', 'id': 7, 'data': {'delivered_to': ['other']}}]
        info = {'name': 'worker-open', 'base_name': 'open'}
        with patch.object(watch, 'hcom_events', fake):
            found = watch.delivered_messages('orch', info, events, '2026-10-04T00:00:00Z')
            self.assertEqual([m['id'] for m in found], [6])
            self.assertEqual(watch.delivered_messages('orch', info, events[1:], 'x'), [])
        self.assertEqual(len(sent), 1)
        self.assertIn('id <= 7', sent[0])

    def test_request_sent_before_the_wait_but_delivered_after_it_releases_in_a_batch(self):
        watch = load_watch()
        info = {'name': 'worker-open', 'base_name': 'open', 'session_id': 'worker-session'}
        deliver = {'type': 'status', 'data': {
            'context': 'deliver:x', 'position': 12, 'session': 'worker-session'}}
        sent = []

        def fake(orchestrator, *filters):
            sent.append(filters)
            if '--context' in filters:
                return [{'type': 'status', 'data': {
                    'context': 'deliver:y', 'position': 5, 'session': 'worker-session'}}]
            # request 10 sent before the wait, inform 12 after it, both delivered after it
            return [{'type': 'message', 'id': 10, 'timestamp': '2026-10-24T23:59:59+00:00',
                     'data': {'from': 'x', 'intent': 'request', 'delivered_to': ['open']}},
                    {'type': 'message', 'id': 12, 'timestamp': '2026-10-25T00:00:01+00:00',
                     'data': {'from': 'z', 'intent': 'inform', 'delivered_to': ['open']}}]

        with patch.object(watch, 'hcom_events', fake):
            messages = watch.delivered_messages(
                'orch', info, [deliver], '2026-10-25T00:00:00+00:00')
        self.assertIn('id > 5 AND id <= 12', sent[-1])
        self.assertNotIn('--after', sent[-1])
        self.assertEqual(watch.wait_release_reason(
            {'agent': 'worker-open', 'target': 'reviewer'}, [deliver], False, True,
            messages), 'message-delivered')
        # First-ever delivery: no earlier cursor, so no lower bound at all.
        with patch.object(watch, 'hcom_events',
                          lambda o, *f: [] if '--context' in f else sent.append(f) or []):
            watch.delivered_messages('orch', info, [deliver], '2026-10-25T00:00:00+00:00')
        self.assertEqual(sent[-1][-1], 'id <= 12')
        self.assertNotIn('--after', sent[-1])
        self.assertEqual(watch.wait_release_reason(
            {'agent': 'worker-open', 'target': 'reviewer'}, [deliver], False, True,
            messages), 'message-delivered')

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

    def test_wait_release_send_check_skips_inform_and_ack_but_not_request_or_bare_sends(self):
        watch = load_watch()

        def claude(command):
            return [
                {'timestamp': '2026-10-04T14:01:41.176Z', 'type': 'assistant',
                 'message': {'content': [{'type': 'tool_use', 'id': 'tool-1', 'name': 'Bash',
                                          'input': {'command': command}}]}},
                {'timestamp': '2026-10-04T14:01:41.273Z', 'type': 'user',
                 'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'tool-1',
                                          'content': 'Sent to: worker', 'is_error': False}]}}]

        def codex(command):
            return [{'timestamp': '2026-10-04T14:01:41.273Z', 'type': 'event_msg',
                     'payload': {'type': 'item_completed', 'item': {
                         'type': 'CommandExecution', 'command': ['/bin/bash', '-lc', command],
                         'status': 'completed', 'exit_code': 0, 'stdout': 'Sent to: worker\n'}}}]

        cases = (("hcom send @worker --intent inform -- 'ok'", False),
                 ("hcom send @worker --intent ack -- 'ok'", False),
                 ("hcom send @worker --intent=inform --file /tmp/r", False),
                 ("hcom send @worker --intent 'ack' -- ok", False),
                 ('hcom send @worker "--intent" inform -- ok', False),
                 ("hcom send @o --intent ack -- 'x' && hcom send @worker --intent inform -- y",
                  False),
                 ("hcom send @worker -- 'ok' && hcom send @o --intent ack -- 'x'", True),
                 ('hcom send @worker --intent request -- "please remove --intent ack"', True),
                 ("hcom send @o --intent inform -- a && hcom send @worker --intent request -- b",
                  True),
                 ("hcom send @worker --intent inform -- progress && hcom send @other "
                  "--intent request -- review", False),
                 ('hcom send @worker --intent inform -- "phase A; phase B"', False),
                 ('hcom send @worker --intent ack -- "a | b\nc"', False),
                 ('hcom send @other --intent inform -- x', True),
                 ('hcom send @worker --intent inform --file /tmp/p\n'
                  'hcom send @other --intent request --file /tmp/r', False),
                 ('hcom send @other --intent inform --file /tmp/p\n'
                  'hcom send @worker --intent request --file /tmp/r', True),
                 ("hcom send @worker --intent request -- 'ok'", True),
                 ("hcom send @worker --intent informal -- 'ok'", True),
                 ("hcom send @worker -- 'no intent'", True))
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'agent.jsonl'
            for make in (claude, codex):
                for command, releases in cases:
                    transcript.write_text(
                        ''.join(json.dumps(row) + '\n' for row in make(command)))
                    self.assertTrue(watch.successful_hcom_send_since(
                        transcript, '2026-10-04T14:01:40+00:00'), command)
                    self.assertEqual(watch.successful_hcom_send_since(
                        transcript, '2026-10-04T14:01:40+00:00', 'worker',
                        skip_inform_ack=True), releases, (make.__name__, command))

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

    def release_wait_after_target_send(self, recipient, participant_events=(), intent='request'):
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
                            f"hcom send @{recipient} --intent {intent} -- 'ok'"],
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
            watch.write_object(watch.wait_path(root, 'waiting-agent'), declaration)
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

    def release_multi_wait(self, declaration, *, messages=(), replied=(), deliver=True,
                           decisions_text=None):
        """Run one release check; returns (reason, stored declaration)."""
        watch = load_watch()
        declaration = {'agent': 'waiting-agent', 'target': 'one-sofe', 'kind': 'agent',
                       'declared_at_utc': '2026-10-04T14:00:58+00:00', 'active': True,
                       'targets': [{'target': 'one-sofe', 'kind': 'agent'},
                                   {'target': 'two-teho', 'kind': 'agent'}], **declaration}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            decisions = root / 'decisions'
            decisions.mkdir()
            for name, text in (decisions_text or {}).items():
                (decisions / f'{name}.md').write_text(text)
            path = watch.wait_path(root, 'waiting-agent')
            watch.write_object(path, declaration)
            agents = {'waiting-agent': {'name': 'waiting-agent', 'base_name': 'waiter',
                                        'session_id': 's'}}
            for name in ('one-sofe', 'two-teho'):
                base = name.split('-')[1]
                agents[name] = {'name': name, 'base_name': base, 'session_id': name,
                                'transcript_path': str(root / name)}
                if name in replied:
                    (root / name).write_text('')
            events = [{'type': 'status', 'data': {'context': 'deliver:x', 'position': 9}}]
            with (patch.object(watch, 'session_events', return_value=events if deliver else []),
                  patch.object(watch, 'delivered_messages', return_value=list(messages)),
                  patch.object(watch, 'successful_hcom_send_since',
                               side_effect=lambda transcript, *_, **__: Path(transcript).exists())):
                reason = watch.release_wait_if_needed(root, decisions, 'orch', declaration,
                                                      agents=agents)
            return reason, json.loads(path.read_text())

    @staticmethod
    def sent(sender, intent=None):
        data = {'from': sender, 'text': 'x'}
        if intent:
            data['intent'] = intent
        return {'type': 'message', 'data': data}

    def test_multi_wait_one_reply_keeps_it_active_and_moves_to_the_next_target(self):
        reason, stored = self.release_multi_wait({}, messages=[self.sent('sofe')])
        self.assertIsNone(reason)
        self.assertTrue(stored['active'])
        self.assertEqual(stored['answered'], ['one-sofe'])
        self.assertEqual(stored['target'], 'two-teho')

    def test_multi_wait_reply_is_read_from_the_targets_transcript_too(self):
        reason, stored = self.release_multi_wait({}, replied=['two-teho'], deliver=False)
        self.assertIsNone(reason)
        self.assertEqual(stored['answered'], ['two-teho'])
        self.assertEqual(stored['target'], 'one-sofe')

    def test_multi_wait_ends_only_when_all_answered(self):
        reason, stored = self.release_multi_wait(
            {'answered': ['one-sofe'], 'target': 'two-teho'}, messages=[self.sent('teho')])
        self.assertEqual(reason, 'targets-answered')
        self.assertFalse(stored['active'])
        self.assertEqual(stored['released_reason'], 'targets-answered')

    def test_multi_wait_answered_target_writing_again_keeps_it_active(self):
        reason, stored = self.release_multi_wait(
            {'answered': ['one-sofe'], 'target': 'two-teho'},
            messages=[self.sent('sofe', 'request')])
        self.assertIsNone(reason)
        self.assertTrue(stored['active'])

    def test_multi_wait_inform_or_ack_from_a_target_is_not_an_answer(self):
        for intent in ('inform', 'ack'):
            with self.subTest(intent=intent):
                reason, stored = self.release_multi_wait(
                    {}, messages=[self.sent('sofe', intent)])
                self.assertIsNone(reason)
                self.assertNotIn('answered', stored)
                self.assertEqual(stored['target'], 'one-sofe')

    def test_multi_wait_third_party_request_still_releases(self):
        reason, stored = self.release_multi_wait(
            {}, messages=[self.sent('sofe'), self.sent('lead', 'request')])
        self.assertEqual(reason, 'message-delivered')
        self.assertFalse(stored['active'])

    def test_multi_wait_unreadable_delivery_still_releases(self):
        reason, _ = self.release_multi_wait({})
        self.assertEqual(reason, 'message-delivered')

    def test_multi_wait_with_a_decision_needs_it_resolved(self):
        mixed = {'target': 'D1', 'kind': 'decision', 'match': 'exact',
                 'targets': [{'target': 'D1', 'kind': 'decision', 'match': 'exact'},
                             {'target': 'two-teho', 'kind': 'agent'}]}
        reason, stored = self.release_multi_wait(mixed, messages=[self.sent('teho')],
                                                 decisions_text={'D1': '- status: pending\n'})
        self.assertIsNone(reason)
        self.assertEqual(stored['answered'], ['two-teho'])
        self.assertEqual((stored['target'], stored['kind']), ('D1', 'decision'))
        reason, stored = self.release_multi_wait(mixed, deliver=False,
                                                 decisions_text={'D1': '- status: approved\n'})
        self.assertIsNone(reason)
        self.assertEqual((stored['target'], stored['kind'], stored['answered']),
                         ('two-teho', 'agent', ['D1']))
        self.assertNotIn('match', stored)

    def test_multi_wait_moving_off_a_decision_past_the_deadline_restarts_it(self):
        # A deadline already moved once must not stretch the next restart.
        mixed = {'target': 'D1', 'kind': 'decision', 'match': 'exact', 'declared_at': 0,
                 'deadline_at': 900, 'wait_seconds': 300,
                 'targets': [{'target': 'D1', 'kind': 'decision', 'match': 'exact'},
                             {'target': 'two-teho', 'kind': 'agent'}]}
        before = time.time()
        _, stored = self.release_multi_wait(mixed, deliver=False,
                                            decisions_text={'D1': '- status: approved\n'})
        self.assertEqual(stored['target'], 'two-teho')
        self.assertGreaterEqual(stored['deadline_at'], before + 300)
        self.assertLess(stored['deadline_at'], before + 330)

    def test_multi_wait_moving_off_the_owning_orchestrator_restarts_the_deadline(self):
        owner = {'target': 'orch', 'declared_at': 0, 'deadline_at': 300, 'wait_seconds': 300,
                 'targets': [{'target': 'orch', 'kind': 'agent'},
                             {'target': 'two-teho', 'kind': 'agent'}]}
        before = time.time()
        _, stored = self.release_multi_wait(owner, messages=[self.sent('orch')])
        self.assertEqual(stored['target'], 'two-teho')
        self.assertGreaterEqual(stored['deadline_at'], before + 300)

    def test_multi_wait_moving_between_agents_keeps_the_deadline(self):
        _, stored = self.release_multi_wait({'declared_at': 0, 'deadline_at': 300},
                                            messages=[self.sent('sofe')])
        self.assertEqual(stored['target'], 'two-teho')
        self.assertEqual(stored['deadline_at'], 300)

    def test_multi_wait_expired_is_not_rewritten_but_can_still_be_released(self):
        expired = {'active': False, 'released_reason': 'expired', 'expiry_count': 1}
        reason, stored = self.release_multi_wait(expired, messages=[self.sent('sofe')])
        self.assertIsNone(reason)
        self.assertEqual(stored['target'], 'one-sofe')
        self.assertNotIn('answered', stored)
        reason, stored = self.release_multi_wait(
            expired, messages=[self.sent('sofe'), self.sent('teho')])
        self.assertEqual(reason, 'targets-answered')
        self.assertEqual(stored['expiry_count'], 0)

    def test_multi_wait_expiry_nudge_names_only_unanswered_targets(self):
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        saved, actions, _ = watch.decide_wait(
            dict(agent='worker', target='two', kind='agent', declared_at=0,
                 declared_at_utc='1970-01-01T00:00:00+00:00', active=True,
                 targets=[dict(target=name, kind='agent') for name in ('one', 'two', 'three')],
                 answered=['one']), idle, None, None, 3600)
        self.assertEqual(saved['released_reason'], 'expired')
        self.assertIn('wait for two, three expired', actions[0].text)
        saved['expiry_declared_at'] = ['a', 'b']
        saved['expiry_count'] = 2
        _, actions, _ = watch.decide_wait(saved, idle._replace(status='active'), None, None, 3660)
        self.assertIn('expired waits for two, three;', actions[0].message)

    def test_silent_stop_without_any_wait_still_reaches_the_orchestrator(self):
        # Dispatch no longer gets HCOM's idle notice, so the stall watch must see this alone.
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 100, 1_000, 10,
                                 orchestrator_wait_started_at=0)
        state, _ = watch.decide(None, idle, now=0)
        state, actions = watch.decide(state, idle, now=600)
        self.assertEqual([action.kind for action in actions], ['nudge'])
        state, actions = watch.decide(state, idle, now=1_200)
        self.assertEqual([action.kind for action in actions], ['notify-orchestrator'])

    def test_target_idle_with_only_a_background_process_does_not_keep_the_waiter_waiting(self):
        # A background command hides the stall from the target's own checks; the waiter's
        # deadline must still fire, since background work alone is not progress.
        watch = load_watch()
        target = watch.Observation('worker', 'listening', True, True, 100, 1_000, 10)
        state, actions = watch.decide(None, target, now=0)
        state, actions = watch.decide(state, target, now=3_000)
        self.assertEqual(actions, ())
        waiter = watch.Observation('orch', 'listening', True, False, 10, 10, 1)
        saved, _, events = watch.decide_wait(
            dict(agent='orch', target='worker', kind='agent', declared_at=0, deadline_at=3_000,
                 declared_at_utc='1970-01-01T00:00:00+00:00', active=True),
            waiter, target, dict(state, last_progress_at=0), 3_000)
        self.assertEqual(events, ['wait-expired'])
        self.assertFalse(saved['active'])

    def test_target_message_to_third_party_does_not_release_wait(self):
        self.assertIsNone(self.release_wait_after_target_send('third-agent'))

    def test_target_message_addressed_to_waiter_releases_before_delivery(self):
        self.assertEqual(
            self.release_wait_after_target_send('waiting-agent'),
            'target-replied',
        )

    def test_target_inform_or_ack_to_waiter_keeps_wait(self):
        for intent in ('inform', 'ack'):
            self.assertIsNone(
                self.release_wait_after_target_send('waiting-agent', intent=intent), intent)

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

    def test_same_starttime_clients_only_attribute_their_own_background_work(self):
        watch = load_watch()
        idle_info = {'launch_context': {
            'pid_identity': 'linux:boot-id:100', 'process_id': 'idle-id'}}
        busy_info = {'launch_context': {
            'pid_identity': 'linux:boot-id:100', 'process_id': 'busy-id'}}
        idle_client = watch.Process(10, 1, 100, 'S', 10, ('codex',),
                                    ('HCOM_PROCESS_ID=idle-id',))
        busy_client = watch.Process(20, 1, 100, 'S', 20, ('codex',),
                                    ('HCOM_PROCESS_ID=busy-id',))
        busy_command = watch.Process(21, 20, 101, 'S', 21, ('uv', 'run', 'tests'),
                                     ('HCOM_PROCESS_ID=busy-id',))
        processes = [idle_client, busy_client, busy_command]

        self.assertFalse(watch.background_process_running(
            'batch-idle', idle_info, processes, current_pid=99))
        self.assertTrue(watch.background_process_running(
            'batch-busy', busy_info, processes, current_pid=99))

    def test_tagged_detached_tool_is_attributed_by_process_id(self):
        watch = load_watch()
        info = {'base_name': 'worker', 'launch_context': {
            'pid_identity': 'linux:boot-id:100', 'process_id': 'worker-id'}}
        client = watch.Process(10, 1, 100, 'S', 10, ('codex',),
                               ('HCOM_PROCESS_ID=worker-id',))
        detached = watch.Process(11, 1, 101, 'S', 11, ('uv', 'run', 'tests'),
                                 ('HCOM_PROCESS_ID=worker-id',
                                  'HCOM_INSTANCE_NAME=worker'))

        self.assertTrue(watch.background_process_running(
            'batch-worker', info, [client, detached], current_pid=99))

    def test_tagged_detached_tool_without_process_id_uses_short_name(self):
        watch = load_watch()
        client = watch.Process(10, 1, 100, 'S', 10, ('codex',), ())
        detached = watch.Process(11, 1, 101, 'S', 11, ('uv', 'run', 'tests'),
                                 ('HCOM_INSTANCE_NAME=worker',))
        for base_name in ('worker', 'registered', None):
            with self.subTest(base_name=base_name):
                info = {'launch_context': {'pid_identity': 'linux:boot-id:100'}}
                if base_name:
                    info['base_name'] = base_name
                tool = detached._replace(environment=(
                    f'HCOM_INSTANCE_NAME={base_name or "worker"}',))
                self.assertTrue(watch.background_process_running(
                    'batch-worker', info, [client, tool], current_pid=99))

    def test_without_process_id_retains_same_starttime_collision_limitation(self):
        watch = load_watch()
        info = {'launch_context': {'pid_identity': 'linux:boot-id:100'}}
        idle_client = watch.Process(10, 1, 100, 'S', 10, ('codex',),
                                    ('HCOM_PROCESS_ID=idle-id',))
        busy_client = watch.Process(20, 1, 100, 'S', 20, ('codex',),
                                    ('HCOM_PROCESS_ID=busy-id',))
        busy_command = watch.Process(21, 20, 101, 'S', 21, ('uv', 'run', 'tests'),
                                     ('HCOM_PROCESS_ID=busy-id',))

        # Legacy root selection still sees both clients; this is a known limitation.
        self.assertTrue(watch.background_process_running(
            'batch-idle', info, [idle_client, busy_client, busy_command], current_pid=99))

    def test_unrelated_detached_tools_are_not_attributed(self):
        watch = load_watch()
        client = watch.Process(10, 1, 100, 'S', 10, ('codex',),
                               ('HCOM_PROCESS_ID=worker-id',))
        other_client = watch.Process(20, 1, 200, 'S', 20, ('codex',),
                                     ('HCOM_PROCESS_ID=other-id',))
        other_command = watch.Process(21, 20, 201, 'S', 21, ('uv', 'run', 'tests'),
                                      ('HCOM_PROCESS_ID=other-id',))
        for process_id in ('worker-id', None):
            with self.subTest(process_id=process_id):
                info = {'base_name': 'worker', 'launch_context': {
                    'pid_identity': 'linux:boot-id:100', 'process_id': process_id}}
                # With an id, even a matching short name cannot override the id.
                name = 'worker' if process_id else 'other'
                detached = watch.Process(22, 1, 202, 'S', 22, ('uv', 'run', 'tests'),
                                         ('HCOM_PROCESS_ID=other-id',
                                          f'HCOM_INSTANCE_NAME={name}'))
                self.assertFalse(watch.background_process_running(
                    'batch-worker', info,
                    [client, other_client, other_command, detached], current_pid=99))

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


class AlarmDecisionTests(unittest.TestCase):
    def test_due_alarm_requests_terminal_ring_and_busy_defers(self):
        watch = load_watch()
        alarm = dict(agent='worker', kind='alarm', reason='read results', active=True,
                     declared_at=0, due_at=60, condition={'kind': 'time', 'minutes': 1})
        idle = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        saved, actions, events = watch.decide_alarm(alarm, idle, False, 59)
        self.assertEqual(actions, [])
        saved, actions, events = watch.decide_alarm(saved, idle, False, 60)
        self.assertEqual([a.kind for a in actions], ['nudge'])
        self.assertTrue(actions[0].text.startswith('[lat-watch] '))
        self.assertIn('alarm', actions[0].text)
        self.assertIn('condition met', actions[0].text)
        self.assertIn('read results', actions[0].text)
        self.assertTrue(saved['active'])  # Only successful delivery completes it.
        busy = idle._replace(command_running=True, prompt_empty=False)
        saved, actions, events = watch.decide_alarm(saved, busy, False, 61)
        self.assertEqual(actions, [])
        self.assertEqual(saved['due_at'], 60)

    def test_post_ring_escalation_does_not_treat_active_work_as_idle(self):
        watch = load_watch()
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                idle = watch.Observation('worker', 'listening', True, True, 10, 10, 1,
                                         client=client, terminal_ready=True,
                                         codex_turn_finished=True if client == 'codex' else None)
                state, _ = watch.decide(None, idle, 0)
                state.update(nudged=True, nudged_at=60, nudge_fingerprint=state['fingerprint'],
                             stall_reason='alarm rang')
                busy = idle._replace(status='active', codex_turn_finished=False
                                     if client == 'codex' else None)
                state, actions = watch.decide(state, busy, 660)
                self.assertEqual(actions, ())
                _, actions = watch.decide(state, idle, 720)
                self.assertEqual([a.kind for a in actions], ['notify-orchestrator'])

    def test_real_a07_ready_empty_active_foreground_defers_until_turn_finishes(self):
        watch = load_watch()
        alarm = dict(agent='worker', kind='alarm', reason='read results', active=True,
                     declared_at=0, due_at=60, condition={'kind': 'time', 'minutes': 1})
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                # Exact real A07 observation: ready/empty does not mean the turn ended.
                busy = watch.Observation('worker', 'active', True, True, 10, 10, 1,
                                         client=client, terminal_ready=True,
                                         codex_turn_finished=False if client == 'codex' else None)
                saved, actions, _ = watch.decide_alarm(alarm, busy, False, 60)
                self.assertEqual(actions, [])
                self.assertTrue(saved['active'])
                self.assertEqual(saved['due_at'], 60)
                completed = busy._replace(status='listening', codex_turn_finished=True
                                          if client == 'codex' else None)
                _, actions, _ = watch.decide_alarm(saved, completed, False, 120)
                self.assertEqual([a.kind for a in actions], ['nudge'])
                expired, actions, _ = watch.decide_alarm(saved, busy, False, 660)
                self.assertFalse(expired['active'])
                self.assertEqual(expired['released_reason'], 'undelivered')
                self.assertEqual(expired['delivery_failure'], 'command running')
                self.assertEqual([a.kind for a in actions], ['notify-orchestrator'])

    def test_condition_observation_and_timeout_freeze_due_time(self):
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        for met, now, due, outcome in [(True, 40, 40, 'condition met'),
                                      (False, 120, 60, 'timed out')]:
            alarm = dict(agent='worker', kind='alarm', reason='results', active=True,
                         declared_at=0, timeout_at=60, condition={'kind': 'file', 'path': '/result'})
            saved, actions, events = watch.decide_alarm(alarm, idle, met, now)
            self.assertEqual(saved['due_at'], due)
            self.assertIn(outcome, actions[0].text)
            again, _, _ = watch.decide_alarm(saved, idle, True, now + 60)
            self.assertEqual(again['due_at'], due)
            self.assertEqual(again['outcome'], outcome)
            self.assertEqual(events, ['alarm-timeout'] if not met else [])

    def test_deadline_recovery_rings_idle_but_expires_busy_and_retries_notice(self):
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        alarm = dict(agent='worker', kind='alarm', reason='resume', active=True,
                     declared_at=0, due_at=60, condition={'kind': 'time', 'minutes': 1})
        saved, actions, _ = watch.decide_alarm(alarm, idle, False, 1000)
        self.assertEqual([a.kind for a in actions], ['nudge'])
        for busy in [idle._replace(prompt_empty=False, input_text='draft'),
                     idle._replace(command_running=True)]:
            saved, actions, events = watch.decide_alarm(alarm, busy, False, 1000)
            self.assertFalse(saved['active'])
            self.assertEqual(saved['released_reason'], 'undelivered')
            self.assertEqual(events, ['alarm-undelivered'])
            self.assertEqual([a.kind for a in actions], ['notify-orchestrator'])
            self.assertIn('resume', actions[0].message)
            self.assertIn('worker', actions[0].message)
            _, retry, _ = watch.decide_alarm(saved, idle, False, 1060)
            self.assertEqual([a.kind for a in retry], ['notify-orchestrator'])
            saved['alarm_notified'] = True
            _, done, _ = watch.decide_alarm(saved, idle, False, 1120)
            self.assertEqual(done, [])

class WaitDeadlineDecisionTests(unittest.TestCase):
    def test_expiry_is_inactive_and_busy_window_defers_one_nudge(self):
        watch = load_watch()
        declaration = dict(agent='worker', target='reviewer', declared_at=0,
                           declared_at_utc='1970-01-01T00:00:00+00:00', active=True)
        busy = watch.Observation('worker', 'active', False, True, 10, 10, 1)
        saved, actions, events = watch.decide_wait(declaration, busy, None, None, 3600)
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'expired')
        self.assertEqual(saved['expiry_count'], 1)
        self.assertEqual(actions, [])
        self.assertEqual(events, ['wait-expired'])
        idle = busy._replace(status='listening', prompt_empty=True, command_running=False)
        saved, actions, events = watch.decide_wait(saved, idle, None, None, 3660)
        self.assertEqual([a.kind for a in actions], ['nudge'])
        self.assertTrue(actions[0].text.startswith('[lat-watch] '))
        self.assertIn('reviewer', actions[0].text)
        self.assertIn('61 minutes', actions[0].text)

    def test_real_w01_finished_ready_empty_owner_gets_expiry_nudge_despite_process(self):
        watch = load_watch()
        declaration = dict(agent='owner', target='reviewer', declared_at=0,
                           declared_at_utc='1970-01-01T00:00:00+00:00', active=True)
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                idle = watch.Observation('owner', 'listening', True, True, 10, 10, 1,
                                         is_orchestrator=True, client=client, terminal_ready=True,
                                         codex_turn_finished=True if client == 'codex' else None)
                saved, actions, _ = watch.decide_wait(declaration, idle, None, None, 3600)
                self.assertEqual(saved['expiry_count'], 1)
                self.assertTrue(saved['expiry_nudge_pending'])
                self.assertEqual([a.category for a in actions], ['wait-expiry'])
                busy = idle._replace(status='active', codex_turn_finished=False
                                     if client == 'codex' else None)
                _, actions, _ = watch.decide_wait(saved, busy, None, None, 3660)
                self.assertEqual(actions, [])
                _, actions, _ = watch.decide_wait(saved, idle._replace(prompt_empty=False), None, None, 3720)
                self.assertEqual(actions, [])

    def test_expiry_nudge_echo_is_not_progress(self):
        watch = load_watch()
        observation = watch.Observation('worker', 'listening', True, False, 0, 0, 1,
                                        client='codex')
        state, _ = watch.decide(None, observation, 0)
        text = '[lat-watch] Your wait for reviewer expired after 60 minutes. Check that agent status.'
        state.update(nudged=True, nudged_at=3600, nudge_text=text)
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / 'transcript.jsonl'
            transcript.write_text(json.dumps(dict(type='response_item', payload=dict(
                role='user', content=[dict(type='input_text', text=text)]))) + '\n')
            observed = observation._replace(transcript_size=transcript.stat().st_size,
                                            transcript_mtime_ns=1)
            observed = watch.nudge_only_observation(state, observed,
                                                    {'transcript_path': str(transcript)}, 'orch')
        saved, _ = watch.decide(state, observed, 3660)
        self.assertEqual(saved['last_progress_at'], 0)
        self.assertTrue(saved['nudged'])

    def test_extension_uses_monitored_progress_but_never_a_valid_wait(self):
        watch = load_watch()
        waiter = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        target = waiter._replace(agent='reviewer')
        declaration = dict(agent='worker', target='reviewer', declared_at=0, active=True,
                           declared_at_utc='1970-01-01T00:00:00+00:00')
        saved, actions, events = watch.decide_wait(
            declaration, waiter, target, {'last_progress_at': 2500}, 3600)
        self.assertTrue(saved['active'])
        self.assertEqual(actions, [])
        self.assertEqual(events, ['wait-extended'])
        saved, actions, events = watch.decide_wait(
            saved, waiter, target._replace(command_running=True, terminal_ready=False),
            {'last_progress_at': 0}, 4800)
        self.assertTrue(saved['active'])
        self.assertEqual(events, [])
        saved, actions, events = watch.decide_wait(
            saved, waiter, target._replace(wait_active=True, command_running=True),
            {'last_progress_at': 4800}, 4860)
        self.assertFalse(saved['active'])
        self.assertEqual(events, ['wait-expired'])

    def test_background_process_alone_does_not_extend(self):
        watch = load_watch()
        waiter = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        target = waiter._replace(agent='reviewer', command_running=True, terminal_ready=True)
        declaration = dict(agent='worker', target='reviewer', declared_at=0, active=True,
                           declared_at_utc='1970-01-01T00:00:00+00:00')
        saved, _, events = watch.decide_wait(
            declaration, waiter, target, {'last_progress_at': 0}, 3600)
        self.assertFalse(saved['active'])
        self.assertEqual(events, ['wait-expired'])

    def test_claude_target_foreground_work_is_judged_by_status(self):
        watch = load_watch()
        waiter = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        declaration = dict(agent='worker', target='reviewer', declared_at=0, active=True,
                           declared_at_utc='1970-01-01T00:00:00+00:00')
        # A background shell turns the Claude footer "not ready" while it is listening.
        for status, extended in (('listening', False), ('active', True)):
            with self.subTest(status=status):
                target = waiter._replace(agent='reviewer', status=status, client='claude',
                                         command_running=True, terminal_ready=False)
                saved, _, events = watch.decide_wait(
                    declaration, waiter, target, {'last_progress_at': 0}, 3600)
                self.assertEqual(saved['active'], extended)
                self.assertEqual(events, ['wait-extended' if extended else 'wait-expired'])

    def test_extension_stops_at_cap_while_target_stays_busy(self):
        watch = load_watch()
        waiter = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        target = waiter._replace(agent='reviewer', command_running=True, terminal_ready=False)
        declaration = dict(agent='worker', target='reviewer', declared_at=0, active=True,
                           declared_at_utc='1970-01-01T00:00:00+00:00', deadline_at=3000)
        cap = 3000 + 30 * 60
        saved, _, events = watch.decide_wait(
            declaration, waiter, target, {'last_progress_at': cap - 60}, cap - 60)
        self.assertTrue(saved['active'])
        self.assertEqual(events, ['wait-extended'])
        saved, actions, events = watch.decide_wait(
            saved, waiter, target, {'last_progress_at': cap}, cap)
        self.assertFalse(saved['active'])
        self.assertEqual(events, ['wait-expired'])
        self.assertEqual([action.category for action in actions], ['wait-expiry'])

    def test_extension_does_not_delay_a_previous_pending_notice(self):
        watch = load_watch()
        waiter = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        target = waiter._replace(agent='reviewer', command_running=True)
        declaration = dict(agent='worker', target='reviewer', declared_at=0,
                           declared_at_utc='1970-01-01T00:00:00+00:00', active=True,
                           expiry_notice=dict(target='reviewer', declared_at=['old1', 'old2'],
                                              conversation_delivered=True, delivered=False,
                                              episode_reset=True))
        saved, actions, events = watch.decide_wait(declaration, waiter, target,
                                                  {'last_progress_at': 3500}, 3600)
        self.assertTrue(saved['active'])
        self.assertEqual(events, ['wait-extended'])
        self.assertEqual([action.category for action in actions], ['wait-expiry-popup'])
        for now in (3660, 3720):
            saved, actions, events = load_watch().decide_wait(
                json.loads(json.dumps(saved)), waiter, target, {'last_progress_at': 3500}, now)
            self.assertTrue(saved['active'])
            self.assertEqual(events, [])
            self.assertEqual([action.category for action in actions], ['wait-expiry-popup'])
        saved['expiry_notice']['conversation_delivered'] = False
        _, actions, _ = watch.decide_wait(saved, waiter, target,
                                          {'last_progress_at': 3500}, 3780)
        self.assertEqual([action.category for action in actions], ['wait-expiry'])

    def test_second_and_later_expiry_notifies_only_until_success(self):
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        declaration = dict(agent='worker', target='reviewer', declared_at=3600,
                           declared_at_utc='1970-01-01T01:00:00+00:00', active=True,
                           expiry_count=1, expiry_declared_at=['1970-01-01T00:00:00+00:00'])
        saved, actions, _ = watch.decide_wait(declaration, idle, None, None, 7200)
        self.assertEqual([a.kind for a in actions], ['nudge', 'notify-orchestrator'])
        self.assertIn('1970-01-01T00:00:00+00:00', actions[1].message)
        self.assertIn('1970-01-01T01:00:00+00:00', actions[1].message)
        # A failed delivery leaves the saved pending flags, including after restart.
        saved, actions, _ = load_watch().decide_wait(
            json.loads(json.dumps(saved)), idle, None, None, 7260)
        self.assertEqual([a.kind for a in actions], ['nudge', 'notify-orchestrator'])
        saved.update(expiry_nudge_pending=False, expiry_notified=True)
        saved, actions, _ = watch.decide_wait(saved, idle, None, None, 7320)
        self.assertEqual(actions, [])
        declaration.update(expiry_count=2, expiry_notified=True)
        saved, actions, _ = watch.decide_wait(declaration, idle._replace(is_orchestrator=True),
                                             None, None, 7200)
        self.assertEqual([a.kind for a in actions], ['nudge'])
        declaration.update(expiry_count=1, expiry_notified=False)
        _, actions, _ = watch.decide_wait(declaration, idle._replace(is_orchestrator=True),
                                          None, None, 7200)
        self.assertEqual(actions[1].kind, 'notify-user')

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
        # Quota recovery must not consult the host account store in transport tests.
        cswap = binary / 'cswap'
        cswap.write_text('#!/bin/sh\nexit 1\n')
        cswap.chmod(0o755)
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
            f'- live actions：無\n'
            f'- preflight：無\n'
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

    def alarm_monitor(self):
        self.wait_session()
        path = self.work / '.lat/sessions/orch.json'
        record = json.loads(path.read_text())
        record['session_id'] = 'orch'
        path.write_text(json.dumps(record))
        # A harmless process with the watcher command identity; no live HCOM used.
        process = subprocess.Popen([
            sys.executable, '-c', 'import time; time.sleep(120)', str(SCRIPT), 'run',
            '--workspace', str(self.work), '--orchestrator', 'orch',
            '--tasks', str(self.tasks), '--decisions', record['decisions_path'],
        ])
        self.addCleanup(process.wait)
        self.addCleanup(process.terminate)
        root = self.work / '.lat/watch'
        root.mkdir(exist_ok=True)
        (root / 'orch.pid').write_text(str(process.pid))
        (root / 'orch').mkdir(exist_ok=True)
        (root / 'orch/state.json').write_text(json.dumps({
            'orch': {'feature_versions': {'wait_deadline': 1, 'alarm': 1}}}))
        return process

    def alarm_cli(self, *condition, agent='open'):
        return self.cli('alarm', '--workspace', self.work, '--agent', agent,
                        '--reason', 'resume result check', *condition)

    def test_alarm_file_and_process_registration(self):
        process = self.alarm_monitor()
        for flags, kind in [(('--file', self.root / 'result', '--timeout', 2), 'file'),
                            (('--pid', process.pid), 'process'), (('--pid', 99999999), 'process')]:
            result = self.alarm_cli(*flags)
            self.assertEqual(result.returncode, 0, result.stderr)
            saved = json.loads(result.stdout)
            self.assertEqual(saved['condition']['kind'], kind)
            self.assertEqual(saved['timeout_at'], saved['declared_at'] + (120 if kind == 'file' else 3600))
            if kind == 'process':
                self.assertEqual(saved['condition']['starttime'] is None, flags[1] == 99999999)

    def alarm_cycle_environment(self):
        self.install_hcom('''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HCOM_LOG"
case "$1" in
list) printf '%s\\n' '[{"name":"orch","status":"listening"},{"name":"worker-open","status":"listening","session_id":"worker-session"}]';;
term) if [ "$2" != inject ]; then
        if [ -f "$FAKE_HCOM_LOG.busy" ]; then printf '%s\\n' '{"ready":true,"prompt_empty":false,"input_text":"draft","lines":[]}';
        else printf '%s\\n' '{"ready":true,"prompt_empty":true,"lines":[]}'; fi
      elif [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi;;
send) if [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi;;
events) printf '%s\\n' '{"id":1,"type":"status","data":{"context":"deliver:sender","session":"worker-session"}}';;
esac
''')

    def save_alarm(self, watch, **fields):
        saved = dict(agent='worker-open', kind='alarm', reason='read results', active=True,
                     declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                     due_at=60, condition={'kind': 'time', 'minutes': 1})
        saved.update(fields)
        path = watch.wait_path(self.work, saved['agent'])
        watch.write_object(path, saved)
        return path

    def test_alarm_failed_input_restart_and_message_do_not_cancel(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        self.run_cycles(watch, 0)
        self.assertTrue(json.loads(path.read_text())['active'])
        failed = Path(str(self.hcom_log) + '.fail')
        failed.touch()
        self.run_cycles(watch, 60)
        self.assertTrue(json.loads(path.read_text())['active'])
        failed.unlink()
        self.run_cycles(load_watch(), 120, 180)
        saved = json.loads(path.read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'rang')
        state = self.watch_state()['worker-open']
        self.assertTrue(state['nudged'])
        self.assertEqual(state['nudged_at'], 120)
        self.assertEqual(state['last_progress_at'], 0)
        self.assertEqual(sum(r.get('decision') == 'alarm-ring' for r in self.watch_records()), 1)
        # Alarm is the only nudge for this stall; escalate after ten minutes.
        self.run_cycles(load_watch(), 720, 780)
        lines = self.hcom_log.read_text().splitlines()
        self.assertEqual(sum(line.startswith('term inject worker-open') for line in lines), 2)
        self.assertEqual(sum(line.startswith('send ') and 'agent worker-open' in line for line in lines), 1)

    def test_alarm_undelivered_busy_and_input_failure_retry_notification(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        self.run_cycles(watch, 0)
        failed = Path(str(self.hcom_log) + '.fail')
        failed.touch()
        self.run_cycles(load_watch(), 1000)
        saved = json.loads(path.read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'undelivered')
        self.assertEqual(saved['delivery_failure'], 'input failed')
        self.assertFalse(saved.get('alarm_notified', False))
        failed.unlink()
        self.run_cycles(load_watch(), 1060, 1120)
        self.assertTrue(json.loads(path.read_text())['alarm_notified'])
        self.assertEqual(sum(r.get('decision') == 'alarm-undelivered' for r in self.watch_records()), 1)
        notices = [line for line in self.hcom_log.read_text().splitlines()
                   if line.startswith('send ') and 'alarm was undelivered' in line]
        self.assertEqual(len(notices), 2)

    def test_alarm_cli_rejections_preserve_previous_declaration(self):
        watch = load_watch()
        path = self.save_alarm(watch)
        original = path.read_bytes()
        result = self.alarm_cli('--after', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no active orchestrator', result.stderr)
        self.wait_session()
        result = self.alarm_cli('--after', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restart', result.stderr)
        self.alarm_monitor()
        state = self.work / '.lat/watch/orch/state.json'
        state.write_text('{}')
        result = self.alarm_cli('--after', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restart', result.stderr)
        state.write_text(json.dumps({'orch': {'feature_versions': {'alarm': 1}}}))
        for flags in [(), ('--after', 1, '--file', '/result'), ('--after', 0),
                      ('--after', 721), ('--after', '1.5'), ('--file', 'relative'),
                      ('--pid', 0), ('--pid', -1), ('--file', '/result', '--timeout', 0),
                      ('--pid', 10, '--timeout', 721), ('--after', 1, '--timeout', 1)]:
            result = self.alarm_cli(*flags)
            self.assertNotEqual(result.returncode, 0, flags)
            self.assertTrue(result.stderr)
            self.assertEqual(path.read_bytes(), original)
        result = self.cli('alarm', '--workspace', self.work, '--agent', 'open',
                          '--reason', ' ', '--after', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_bytes(), original)
        # A PID for an unrelated live process is not a running watcher.
        (self.work / '.lat/watch/orch.pid').write_text(str(os.getpid()))
        result = self.alarm_cli('--after', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_bytes(), original)

    def test_alarm_file_process_and_timeout_ring_and_new_declaration_replaces(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        result_file = self.root / 'result'
        cases = [({'kind': 'file', 'path': str(result_file)}, True, 'condition met'),
                 ({'kind': 'file', 'path': str(self.root / 'absent')}, False, 'timed out'),
                 ({'kind': 'process', 'pid': 99999999, 'starttime': None}, False, 'condition met'),
                 ({'kind': 'process', 'pid': os.getpid(), 'starttime': -1}, False, 'condition met')]
        for condition, exists, wording in cases:
            with self.subTest(condition=condition):
                if exists:
                    result_file.touch()
                path = self.save_alarm(watch, due_at=None, timeout_at=60, condition=condition)
                self.run_cycles(load_watch(), 60)
                saved = json.loads(path.read_text())
                self.assertFalse(saved['active'])
                self.assertEqual(saved['outcome'], wording)
                self.assertEqual(saved['released_reason'], 'rang')
        self.assertTrue(any(r.get('decision') == 'alarm-timeout' for r in self.watch_records()))
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'absent', '--reason', 'new wait')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['kind'], 'agent')
        self.assertNotIn('condition', json.loads(path.read_text()))

    def test_alarm_live_process_waits_until_exit(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
        self.addCleanup(process.wait)
        self.addCleanup(lambda: process.terminate() if process.poll() is None else None)
        starttime = int(Path(f'/proc/{process.pid}/stat').read_text().rpartition(') ')[2].split()[19])
        path = self.save_alarm(watch, due_at=None, timeout_at=3600,
                               condition=dict(kind='process', pid=process.pid, starttime=starttime))
        self.run_cycles(watch, 0, 60)
        self.assertTrue(json.loads(path.read_text())['active'])
        process.terminate()
        process.wait()
        self.run_cycles(load_watch(), 120, 180)
        self.assertEqual(json.loads(path.read_text())['due_at'], 120)
        self.assertEqual(json.loads(path.read_text())['released_reason'], 'rang')

    def test_alarm_busy_defers_then_recovery_expires_without_sliding(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        busy = Path(str(self.hcom_log) + '.busy')
        busy.touch()
        self.run_cycles(watch, 0, 60, 600)
        self.assertTrue(json.loads(path.read_text())['active'])
        self.assertEqual(json.loads(path.read_text())['due_at'], 60)
        self.run_cycles(load_watch(), 1000, 1060)
        saved = json.loads(path.read_text())
        self.assertFalse(saved['active'])
        self.assertTrue(saved['alarm_notified'])
        self.assertEqual(saved['delivery_failure'], 'input prompt not empty')
        self.assertNotIn('term inject worker-open', self.hcom_log.read_text())
        # A distinct alarm delivered on the first idle recovery cycle after the deadline.
        path = self.save_alarm(watch)
        busy.unlink()
        self.run_cycles(load_watch(), 2000, 2060)
        self.assertEqual(json.loads(path.read_text())['released_reason'], 'rang')

    def test_alarm_upgrade_old_state_rejects_then_cycle_expires_old_wait(self):
        process = self.alarm_monitor()
        self.alarm_cycle_environment()
        watch = load_watch()
        state = watch.state_path(self.work, 'orch')
        state.write_text('{}')
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(agent='worker-open', target='absent', reason='legacy',
                                     declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00', active=True))
        original = path.read_bytes()
        result = self.alarm_cli('--after', 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(path.read_bytes(), original)
        # Upgrade with no incoming events: old waits get the default deadline.
        script = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        script.write_text(script.read_text().replace("events) printf", "events) :;; unused) printf"))
        self.run_cycles(load_watch(), 4000)
        self.assertEqual(json.loads(path.read_text())['released_reason'], 'expired')
        self.assertFalse(json.loads(path.read_text())['expiry_nudge_pending'])
        self.assertEqual(self.watch_state()['orch']['feature_versions'], {'wait_deadline': 2, 'alarm': 1, 'cache_keepalive': 5, 'claude_quota_resume': 1, 'ledger_due': 1, 'screen_errors': 1, 'capacity_continue': 1, 'wait_targets': 1})
        result = self.alarm_cli('--after', 1, agent='worker-open')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(path.read_text())['kind'], 'alarm')

    def test_new_wait_during_alarm_ring_is_not_overwritten(self):
        watch = load_watch()
        path = self.save_alarm(watch)
        replacement = dict(agent='worker-open', target='new-target', declared_at=60,
                           declared_at_utc='1970-01-01T00:01:00+00:00', active=True)
        def external_command(command, *args, **kwargs):
            output = ''
            if command[:2] == ['hcom', 'list']:
                output = json.dumps([dict(name=name, status='listening')
                                     for name in ('orch', 'worker-open')])
            elif command[:2] == ['hcom', 'term'] and command[2] != 'inject':
                output = json.dumps(dict(ready=True, prompt_empty=True, lines=[]))
            if command[:3] == ['hcom', 'term', 'inject']:
                watch.write_object(path, replacement)
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr='')
        with patch.object(watch.subprocess, 'run', side_effect=external_command):
            self.run_cycles(watch, 60)
        self.assertEqual(json.loads(path.read_text()), replacement)

    def test_orchestrator_alarm_popup_failure_retries_without_duplicate_note(self):
        self.alarm_cycle_environment()
        herdr = Path(self.env['PATH'].split(':', 1)[0]) / 'herdr'
        herdr.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HERDR_LOG"
if [ "$1" = notification ] && [ -f "$FAKE_HERDR_LOG.fail" ]; then exit 1; fi
''')
        failed = Path(str(self.herdr_log) + '.fail')
        busy = Path(str(self.hcom_log) + '.busy')
        failed.touch()
        busy.touch()
        watch = load_watch()
        path = self.save_alarm(watch, agent='orch')
        self.run_cycles(watch, 1000)
        self.assertFalse(json.loads(path.read_text())['alarm_notified'])
        self.assertTrue(json.loads(path.read_text())['alarm_conversation_delivered'])
        failed.unlink()
        self.run_cycles(load_watch(), 1060, 1120)
        self.assertTrue(json.loads(path.read_text())['alarm_notified'])
        self.assertEqual(sum(line.startswith('send ') and 'alarm was undelivered' in line
                             for line in self.hcom_log.read_text().splitlines()), 1)
        self.assertEqual(sum(line.startswith('notification show ')
                             for line in self.herdr_log.read_text().splitlines()), 2)

    def test_alarm_successful_ring_save_failure_does_not_ring_again(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        original_write = watch.write_object
        failed = False
        def fail_once(destination, value, **kwargs):
            nonlocal failed
            if destination == path and value.get('released_reason') == 'rang' and not failed:
                failed = True
                raise OSError('temporary save failure')
            return original_write(destination, value, **kwargs)
        with patch.object(watch, 'write_object', side_effect=fail_once):
            self.run_cycles(watch, 60, 120, 180)
        self.assertTrue(failed)
        self.assertEqual(sum(line.startswith('term inject worker-open')
                             for line in self.hcom_log.read_text().splitlines()), 1)
        self.assertEqual(json.loads(path.read_text())['released_reason'], 'rang')
        self.assertEqual(sum(row.get('decision') == 'alarm-ring' for row in self.watch_records()), 1)

    def test_alarm_successful_notice_save_failure_does_not_send_again(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        Path(str(self.hcom_log) + '.busy').touch()
        original_write = watch.write_object
        failed = False
        def fail_once(destination, value, **kwargs):
            nonlocal failed
            if destination == path and value.get('alarm_notified') and not failed:
                failed = True
                raise OSError('temporary save failure')
            return original_write(destination, value, **kwargs)
        with patch.object(watch, 'write_object', side_effect=fail_once):
            self.run_cycles(watch, 660, 720, 780)
        self.assertTrue(failed)
        self.assertEqual(sum(line.startswith('send ') and 'alarm was undelivered' in line
                             for line in self.hcom_log.read_text().splitlines()), 1)
        self.assertTrue(json.loads(path.read_text())['alarm_notified'])

    def test_alarm_deadline_applies_when_agent_missing_or_terminal_unreadable(self):
        for unavailable in ('missing', 'inactive', 'terminal-error'):
            with self.subTest(unavailable=unavailable):
                self.alarm_cycle_environment()
                script = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
                content = script.read_text()
                if unavailable == 'missing':
                    content = content.replace(',{"name":"worker-open","status":"listening","session_id":"worker-session"}', '')
                elif unavailable == 'inactive':
                    content = content.replace('"name":"worker-open","status":"listening"', '"name":"worker-open","status":"inactive"')
                else:
                    content = content.replace('term) if', 'term) if [ "$2" = worker-open ]; then exit 1; fi; if')
                script.write_text(content)
                watch = load_watch()
                path = self.save_alarm(watch)
                self.run_cycles(watch, 60)
                self.assertTrue(json.loads(path.read_text())['active'])
                self.run_cycles(load_watch(), 660, 720)
                saved = json.loads(path.read_text())
                self.assertFalse(saved['active'])
                self.assertEqual(saved['released_reason'], 'undelivered')
                self.assertIn('unavailable', saved['delivery_failure'])
                self.assertTrue(saved['alarm_notified'])

    def test_alarm_empty_terminal_rings_despite_surviving_background_process(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch, due_at=None, timeout_at=60,
                               condition=dict(kind='file', path=str(self.root / 'absent')))
        # The observer reports terminal readiness separately from background liveness.
        with patch.object(watch, 'background_process_running', return_value=True):
            self.run_cycles(watch, 60, 660)
        saved = json.loads(path.read_text())
        self.assertEqual(saved['released_reason'], 'rang')
        self.assertEqual(saved['outcome'], 'timed out')
        self.assertEqual(sum(line.startswith('term inject worker-open')
                             for line in self.hcom_log.read_text().splitlines()), 1)

    def test_alarm_final_state_save_failure_restores_nudge_after_restart(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        self.run_cycles(watch, 0)
        state_path = watch.state_path(self.work, 'orch')
        original_write = watch.write_object
        def fail_state(destination, value, **kwargs):
            if destination == state_path:
                raise OSError('temporary state save failure')
            return original_write(destination, value, **kwargs)
        with patch.object(watch, 'write_object', side_effect=fail_state):
            with self.assertRaises(OSError):
                self.run_cycles(watch, 60)
        self.assertEqual(json.loads(path.read_text())['released_reason'], 'rang')
        self.run_cycles(load_watch(), 660, 720)
        lines = self.hcom_log.read_text().splitlines()
        self.assertEqual(sum(line.startswith('term inject worker-open') for line in lines), 1)
        self.assertEqual(sum(line.startswith('send ') and 'agent worker-open' in line for line in lines), 1)
        state = self.watch_state()['worker-open']
        self.assertEqual(state['nudged_at'], 60)
        self.assertEqual(state['last_progress_at'], 0)

    def test_alarm_background_work_still_escalates_ten_minutes_after_ring(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        self.save_alarm(watch)
        with patch.object(watch, 'background_process_running', return_value=True):
            self.run_cycles(watch, 0, 60, 659)
            self.assertNotIn('send ', self.hcom_log.read_text())
            self.run_cycles(watch, 660, 1260)
        lines = self.hcom_log.read_text().splitlines()
        self.assertEqual(sum(line.startswith('term inject worker-open') for line in lines), 1)
        self.assertEqual(sum(line.startswith('send ') and '--intent request' in line and 'agent worker-open' in line for line in lines), 1)

    def test_alarm_new_progress_prevents_restoring_the_old_ring_nudge(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        self.save_alarm(watch)
        self.run_cycles(watch, 0, 60)
        script = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        script.write_text(script.read_text().replace('"id":1', '"id":2'))
        self.run_cycles(load_watch(), 120, 180)
        self.assertFalse(self.watch_state()['worker-open']['nudged'])
        self.assertEqual(self.watch_state()['worker-open']['last_progress_at'], 120)
        self.run_cycles(load_watch(), 720)
        self.assertEqual(sum(line.startswith('term inject worker-open')
                             for line in self.hcom_log.read_text().splitlines()), 2)

    def test_alarm_recovery_uses_newer_ring_after_progress_in_ringing_cycle(self):
        for old_nudge in (False, True):
            with self.subTest(old_nudge=old_nudge):
                self.alarm_cycle_environment()
                self.hcom_log.write_text('')
                watch = load_watch()
                path = self.save_alarm(watch)
                self.run_cycles(watch, 0)
                state_path = watch.state_path(self.work, 'orch')
                if old_nudge:
                    states = json.loads(state_path.read_text())
                    states['worker-open'].update(nudged=True, nudged_at=0,
                                                 orchestrator_notified=True, user_notified=True)
                    state_path.write_text(json.dumps(states))
                # New progress is observed BEFORE ringing; the older state file stays at event1.
                script = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
                script.write_text(script.read_text().replace('"id":1', '"id":2'))
                original_write = watch.write_object
                def fail_state(destination, value, **kwargs):
                    if destination == state_path:
                        raise OSError('temporary final state failure')
                    return original_write(destination, value, **kwargs)
                with patch.object(watch, 'write_object', side_effect=fail_state):
                    with self.assertRaises(OSError):
                        self.run_cycles(watch, 60)
                self.assertEqual(json.loads(path.read_text())['released_reason'], 'rang')
                self.run_cycles(load_watch(), 660, 1260)
                lines = self.hcom_log.read_text().splitlines()
                self.assertEqual(sum(line.startswith('term inject worker-open') for line in lines), 1)
                notices = [line for line in lines if line.startswith('send ') and '--intent request' in line
                           and 'agent worker-open' in line]
                self.assertEqual(len(notices), 1)
                self.assertEqual(self.watch_state()['worker-open']['nudged_at'], 60)

    def test_alarm_time_registration_and_status(self):
        self.alarm_monitor()
        result = self.alarm_cli('--after', 3)
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertEqual(saved['agent'], 'worker-open')
        self.assertEqual(saved['kind'], 'alarm')
        self.assertEqual(saved['condition'], {'kind': 'time', 'minutes': 3})
        self.assertEqual(saved['due_at'], saved['declared_at'] + 180)
        status = self.cli('status', '--workspace', self.work, '--orchestrator', 'orch',
                          '--tasks', self.tasks)
        row = next(r for r in json.loads(status.stdout)['targets'] if r['agent'] == 'worker-open')
        self.assertEqual(row['wait'], saved)

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

    def write_card(self, relative, agent_field, orchestrator='orch', status='in progress',
                   fields='- live actions：無\n- preflight：無\n'):
        path = self.tasks / relative
        path.write_text(f'- agent：{agent_field}\n- orchestrator：{orchestrator}\n'
                        f'- status：{status}\n{fields}')
        return path

    def write_fields_card(self, relative, agent, fields='', **card):
        return self.write_card(relative, agent, fields=fields, **card)

    def field_notices(self):
        if not self.hcom_log.exists():
            return []
        return [line for line in self.hcom_log.read_text().splitlines()
                if line.startswith('send ') and 'required field' in line]

    def field_records(self):
        return [(record['at'], record['card'], record['fields'])
                for record in self.watch_records()
                if record.get('decision') == 'task-card-fields-missing']

    def test_cards_naming_the_base_name_of_a_full_name_orchestrator_stay_monitored(self):
        self.write_card('base.md', 'poni', orchestrator='orch')
        self.write_card('other.md', 'kela', orchestrator='other-orch2')
        watch = load_watch()

        cards, _ = watch.monitored_task_cards(self.tasks, 'team-orch')
        self.assertIn('poni', cards)
        self.assertNotIn('kela', cards)
        self.assertIn('kela', watch.monitored_task_cards(self.tasks, 'other-orch2')[0])

    def test_cards_with_both_envelope_fields_are_not_reported(self):
        self.write_fields_card('filled.md', 'poni', '- live actions：重建 2 次；請求 50 個\n'
                                                   '- preflight：帳號已核對\n')

        self.run_cycles(load_watch(), 0, 60)

        self.assertEqual(self.field_notices(), [])
        self.assertEqual(self.field_records(), [])

    def test_missing_or_empty_envelope_fields_notify_the_orchestrator_once(self):
        self.write_fields_card('a-none.md', 'poni')
        self.write_fields_card('b-no-preflight.md', 'kemo', '- live actions：無\n')
        self.write_fields_card('c-empty.md', 'tabi', '- live actions：  \n- preflight：無\n')

        self.run_cycles(load_watch(), 0, 60)

        self.assertEqual(self.field_records(), [
            (0, 'a-none.md', ['live actions', 'preflight']),
            (0, 'b-no-preflight.md', ['preflight']),
            (0, 'c-empty.md', ['live actions']),
        ])
        notices = self.field_notices()
        self.assertEqual(len(notices), 3)
        self.assertTrue(all('@orch --intent request --from lat-watch --name orch -- '
                            'LAT stall watcher: task card ' in line for line in notices))
        self.assertIn('a-none.md', notices[0])
        self.assertIn('field(s): live actions, preflight. ', notices[0])
        self.assertIn('b-no-preflight.md', notices[1])
        self.assertIn('field(s): preflight. ', notices[1])
        self.assertIn('c-empty.md', notices[2])
        self.assertIn('field(s): live actions. ', notices[2])
        self.assertEqual(self.herdr_log.exists(), False)

    def test_agents_of_cards_missing_envelope_fields_stay_monitored(self):
        self.write_fields_card('a-none.md', 'poni')

        self.run_cycles(load_watch(), 0)
        status = self.cli('status', '--workspace', self.work,
                          '--orchestrator', 'orch', '--tasks', self.tasks)

        self.assertEqual([record['agent'] for record in self.watch_records()
                          if 'agent' in record], ['orch', 'poni', 'worker-open'])
        self.assertEqual([item['agent'] for item in json.loads(status.stdout)['targets']],
                         ['orch', 'poni', 'worker-open'])
        self.assertEqual([record['card'] for record in self.watch_records()
                          if record.get('decision') == 'task-card-skipped'], [])

    def test_envelope_reminder_repeats_only_when_the_card_content_changes(self):
        self.write_fields_card('card.md', 'poni')
        watch = load_watch()

        self.run_cycles(watch, 0, 60)
        self.write_fields_card('card.md', 'poni', '- next step：probe\n')
        self.run_cycles(watch, 120, 180)
        self.write_fields_card('card.md', 'poni')
        self.run_cycles(watch, 240)
        self.write_fields_card('card.md', 'poni', '- live actions：無\n- preflight：無\n')
        self.run_cycles(watch, 300, 360)

        self.assertEqual([at for at, _, _ in self.field_records()], [0, 120])
        self.assertEqual(len(self.field_notices()), 2)

        self.write_fields_card('card.md', 'poni')
        self.run_cycles(watch, 420)
        self.assertEqual([at for at, _, _ in self.field_records()], [0, 120, 420])

    def test_envelope_reminder_stops_after_the_card_is_merged_or_moved_to_done(self):
        merged = self.write_fields_card('merged-later.md', 'poni')
        moved = self.write_fields_card('moved-later.md', 'kemo')
        watch = load_watch()

        self.run_cycles(watch, 0)
        merged.write_text(merged.read_text().replace('in progress', 'merged'))
        moved.rename(self.tasks / 'done' / moved.name)
        self.run_cycles(watch, 60, 120)

        self.assertEqual([at for at, _, _ in self.field_records()], [0, 0])
        self.assertEqual(len(self.field_notices()), 2)

    def test_done_merged_and_foreign_cards_are_not_checked_for_envelope_fields(self):
        self.write_fields_card('done/old.md', 'poni')
        self.write_fields_card('merged-old.md', 'kemo', status='merged')
        self.write_fields_card('foreign.md', 'tabi', orchestrator='somebody-else')

        self.run_cycles(load_watch(), 0)

        self.assertEqual(self.field_notices(), [])
        self.assertEqual(self.field_records(), [])

    def test_failed_envelope_reminder_is_retried_next_cycle(self):
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'if [ "$1" = send ] && [ -e "$FAKE_HCOM_LOG.fail" ]; then\n'
            '  echo down >&2; exit 1\n'
            'fi\n'
            'printf \'%s\\n\' \'[{"name":"orch","status":"listening"},'
            '{"name":"poni","status":"listening"},'
            '{"name":"worker-open","status":"listening"}]\'\n'
        )
        self.write_fields_card('card.md', 'poni')
        failed = Path(str(self.hcom_log) + '.fail')
        failed.touch()
        watch = load_watch()

        self.run_cycles(watch, 0)
        failed.unlink()
        self.run_cycles(watch, 60, 120)

        records = [record for record in self.watch_records()
                   if record.get('decision') == 'task-card-fields-missing']
        self.assertEqual([(record['at'], record['action_results'][0]['status'])
                          for record in records], [(0, 'failed'), (60, 'done')])
        self.assertEqual(len(self.field_notices()), 2)
        self.assertIn('poni', [record['agent'] for record in self.watch_records()
                               if record.get('at') == 0 and 'agent' in record])

    def test_envelope_reminder_is_not_repeated_after_a_watcher_restart(self):
        self.write_fields_card('card.md', 'poni')

        self.run_cycles(load_watch(), 0)
        self.run_cycles(load_watch(), 60)

        self.assertEqual(len(self.field_notices()), 1)

    def test_unrecognized_cards_are_still_skipped_without_an_envelope_reminder(self):
        (self.tasks / 'no-agent.md').write_text('- orchestrator：orch\n- status：dispatched\n')
        (self.tasks / 'no-orchestrator.md').write_text('- agent：sora\n- status：dispatched\n')
        (self.tasks / 'no-status.md').write_text('- agent：sora\n- orchestrator：orch\n')

        self.run_cycles(load_watch(), 0)

        self.assertEqual([record['card'] for record in self.watch_records()
                          if record.get('decision') == 'task-card-skipped'],
                         ['no-agent.md', 'no-orchestrator.md', 'no-status.md'])
        self.assertEqual(self.field_notices(), [])
        self.assertEqual(self.field_records(), [])
        self.assertEqual([record['agent'] for record in self.watch_records()
                          if 'agent' in record], ['orch', 'worker-open'])

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

    def test_comma_list_waits_for_every_entry(self):
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'absent, reviewer,qa-one,absent,', '--reason', 'review round')
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertEqual(saved['target'], 'absent')
        self.assertEqual(saved['reason'], 'review round')
        self.assertEqual(saved['targets'], [{'target': name, 'kind': 'agent'}
                                            for name in ('absent', 'reviewer', 'qa-one')])
        self.assertIn('deadline_at', saved)

    def test_single_target_declaration_has_no_list(self):
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'reviewer,reviewer', '--reason', 'review round')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('targets', json.loads(result.stdout))

    def test_comma_list_mixes_decisions_and_agents(self):
        decisions = self.wait_session()
        (decisions / 'HELP.md').write_text('- status: pending\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'HELP,reviewer', '--minutes', '5', '--reason', 'both')
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertEqual((saved['kind'], saved['target'], saved['match']),
                         ('decision', 'HELP', 'exact'))
        self.assertEqual(saved['targets'], [
            {'target': 'HELP', 'kind': 'decision', 'match': 'exact'},
            {'target': 'reviewer', 'kind': 'agent'}])
        self.assertEqual(saved['deadline_at'], saved['declared_at'] + 300)
        self.assertEqual(saved['wait_seconds'], 300)

    def test_comma_list_rejects_a_resolved_decision_or_self_anywhere_and_keeps_the_old_wait(self):
        decisions = self.wait_session()
        (decisions / 'DONE.md').write_text('- status: approved\n')
        (decisions / 'OPEN.md').write_text('- status: pending\n')
        path = self.work / '.lat/watch/waits/worker-open.json'
        self.assertEqual(self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                                  '--for', 'OPEN', '--reason', 'old').returncode, 0)
        before = path.read_bytes()
        for targets, text in (('reviewer,DONE', 'Cannot wait on DONE'),
                              ('reviewer,worker-open', 'Cannot wait on yourself')):
            with self.subTest(targets=targets):
                result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                                  '--for', targets, '--reason', 'x')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(text, result.stderr)
                self.assertEqual(path.read_bytes(), before)

    def test_minutes_is_rejected_only_when_no_listed_target_has_a_deadline(self):
        decisions = self.wait_session()
        for name in ('A', 'B'):
            (decisions / f'{name}.md').write_text('- status: pending\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'A,B', '--minutes', '5', '--reason', 'x')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--minutes is not allowed', result.stderr)
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'A,B', '--reason', 'x')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('deadline_at', json.loads(result.stdout))

    def test_orchestrator_in_a_list_does_not_lift_the_other_agents_deadline(self):
        self.wait_session()
        self.install_hcom(
            '#!/bin/sh\n'
            'printf \'%s\\n\' \'[{"name":"orch"},{"name":"worker-open"},{"name":"qa"}]\'\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'orch,qa', '--reason', 'x')
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertEqual(saved['target'], 'orch')
        self.assertIn('deadline_at', saved)

    def test_comma_list_rejects_an_invalid_extra_name(self):
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'absent,bad name', '--reason', 'review round')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Invalid HCOM name', result.stderr)

    def test_normal_release_rearms_completed_expiry_notification(self):
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(agent='worker-open', target='absent', declared_at=0,
                                     declared_at_utc='1970-01-01T00:00:00+00:00', active=False,
                                     released_reason='message-delivered', expiry_count=0,
                                     expiry_notified=True,
                                     expiry_notice=dict(target='absent', declared_at=['old', 'old2'],
                                                        conversation_delivered=True, delivered=True)))
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'absent', '--reason', 'new episode')
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertFalse(saved.get('expiry_notified', False))
        self.assertNotIn('expiry_notice', saved)

    def test_failed_expiry_popup_retries_without_duplicate_conversation_note(self):
        self.install_hcom("""#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HCOM_LOG"
case "$1" in
list) printf '%s\\n' '[{"name":"orch","status":"listening","session_id":"orch-session"},{"name":"worker-open","status":"listening"}]';;
term) if [ "$2" != inject ]; then printf '%s\\n' '{"ready":true,"prompt_empty":true,"lines":[]}'; fi;;
events) if [ -f "$FAKE_HCOM_LOG.delivered" ]; then printf '%s\\n' '{"id":1,"type":"status","data":{"context":"deliver:lat-watch","session":"orch-session"}}';
        else :; fi;;
send) touch "$FAKE_HCOM_LOG.delivered";;
esac
""")
        herdr = Path(self.env['PATH'].split(':', 1)[0]) / 'herdr'
        herdr.write_text("""#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HERDR_LOG"
if [ "$1" = notification ] && [ -f "$FAKE_HERDR_LOG.fail" ]; then exit 1; fi
""")
        failed = Path(str(self.herdr_log) + '.fail')
        failed.touch()
        watch = load_watch()
        path = watch.wait_path(self.work, 'orch')
        watch.write_object(path, dict(agent='orch', target='absent', declared_at=3600,
                                     declared_at_utc='1970-01-01T01:00:00+00:00', active=True,
                                     expiry_count=1,
                                     expiry_declared_at=['1970-01-01T00:00:00+00:00']))
        self.run_cycles(watch, 7200)
        self.assertFalse(json.loads(path.read_text()).get('expiry_notified', False))
        failed.unlink()
        self.run_cycles(load_watch(), 7260, 7320)
        self.assertNotIn('expiry_notice', json.loads(path.read_text()))
        self.assertEqual(sum(row.get('decision') == 'wait-expiry-notified'
                             for row in self.watch_records()), 1)
        self.assertEqual(sum(line.startswith('send ') for line in
                             self.hcom_log.read_text().splitlines()), 1)
        self.assertEqual(sum(line.startswith('notification show ') for line in
                             self.herdr_log.read_text().splitlines()), 2)
        # A new same-target streak after normal release gets its own notification.
        Path(str(self.hcom_log) + '.delivered').unlink()
        new_times = []
        for _ in range(2):
            result = self.cli('wait', '--workspace', self.work, '--agent', 'orch',
                              '--for', 'absent', '--reason', 'new streak', '--minutes', '1')
            self.assertEqual(result.returncode, 0, result.stderr)
            declaration = json.loads(result.stdout)
            new_times.append(declaration['declared_at_utc'])
            self.run_cycles(load_watch(), declaration['deadline_at'])
        sends = [line for line in self.hcom_log.read_text().splitlines()
                 if line.startswith('send ')]
        self.assertEqual(len(sends), 2)
        for declared_at in new_times:
            self.assertIn(declared_at, sends[-1])
        self.assertEqual(sum(row.get('decision') == 'wait-expiry-notified'
                             for row in self.watch_records()), 2)

    def test_reply_before_same_target_redeclaration_resets_history(self):
        self.wait_session()
        self.install_hcom("""#!/bin/sh
case "$1" in
list) printf '%s\\n' '[{"name":"worker-open","base_name":"open","session_id":"worker-session"}]';;
events) printf '%s\\n' '{"id":1,"type":"status","data":{"context":"deliver:sender","session":"worker-session","status":"active"}}';;
esac
""")
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(agent='worker-open', target='absent', declared_at=0,
                                     declared_at_utc='1970-01-01T00:00:00+00:00', active=False,
                                     released_reason='expired', expiry_count=1,
                                     expiry_declared_at=['1970-01-01T00:00:00+00:00']))
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'absent', '--reason', 'new work')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['expiry_count'], 0)

    def test_new_wait_during_expiry_delivery_is_not_overwritten(self):
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(agent='worker-open', target='absent', declared_at=0,
                                     declared_at_utc='1970-01-01T00:00:00+00:00', active=True))
        replacement = dict(agent='worker-open', target='new-target', declared_at=3600,
                           declared_at_utc='1970-01-01T01:00:00+00:00', active=True)
        def external_command(command, *args, **kwargs):
            output = ''
            if command[:2] == ['hcom', 'list']:
                output = json.dumps([dict(name=name, status='listening')
                                     for name in ('orch', 'worker-open')])
            elif command[:2] == ['hcom', 'term'] and command[2] != 'inject':
                output = json.dumps(dict(ready=True, prompt_empty=True, lines=[]))
            if command[:3] == ['hcom', 'term', 'inject']:
                watch.write_object(path, replacement)
            return subprocess.CompletedProcess(command, 0, stdout=output, stderr='')
        with patch.object(watch.subprocess, 'run', side_effect=external_command):
            self.run_cycles(watch, 3600)
        self.assertEqual(json.loads(path.read_text()), replacement)

    def test_cycle_extends_only_until_monitored_target_declares_wait(self):
        self.write_task('target.md', 'worker-target', 'orch', 'in progress')
        self.install_hcom("""#!/bin/sh
case "$1" in
list) printf '%s\\n' '[{"name":"orch","status":"listening"},{"name":"worker-open","status":"listening"},{"name":"worker-target","status":"active"}]';;
term) if [ "$2" = worker-target ]; then printf '%s\\n' '{"ready":false,"prompt_empty":true,"lines":[]}';
      elif [ "$2" != inject ]; then printf '%s\\n' '{"ready":true,"prompt_empty":true,"lines":[]}'; fi;;
events) printf '%s\\n' '[]';;
esac
""")
        watch = load_watch()
        waiter = watch.wait_path(self.work, 'worker-open')
        watch.write_object(waiter, dict(agent='worker-open', target='worker-target',
                                       declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                                       active=True))
        self.run_cycles(watch, 0, 3600, 3660)
        self.assertTrue(json.loads(waiter.read_text())['active'])
        self.assertEqual(sum(r.get('decision') == 'wait-extended'
                             for r in self.watch_records()), 1)
        watch.write_object(watch.wait_path(self.work, 'worker-target'),
                           dict(agent='worker-target', target='absent', declared_at=3660,
                                declared_at_utc='1970-01-01T01:01:00+00:00', active=True))
        self.run_cycles(load_watch(), 3720)
        self.assertFalse(json.loads(waiter.read_text())['active'])
        self.assertEqual(json.loads(waiter.read_text())['released_reason'], 'expired')

    def test_expiry_delivery_restart_and_counter_reset(self):
        self.install_hcom('''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HCOM_LOG"
case "$1" in
list) printf '%s\\n' '[{"name":"orch","status":"listening"},{"name":"worker-open","status":"listening"}]';;
term) if [ "$2" != inject ]; then printf '%s\\n' '{"ready":true,"prompt_empty":true,"lines":[]}';
      elif [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi;;
send) if [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi;;
events) printf '%s\\n' '[]';;
esac
''')
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(agent='worker-open', target='absent',
                                     declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                                     active=True))
        self.run_cycles(watch, 0, 3600)
        saved = json.loads(path.read_text())
        self.assertFalse(saved['active'])
        self.assertFalse(saved['expiry_nudge_pending'])
        self.assertEqual(saved['expiry_count'], 1)
        self.assertEqual(self.watch_state()['orch']['feature_versions']['wait_deadline'], 2)
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'absent', '--reason', 'again', '--minutes', '1')
        self.assertEqual(result.returncode, 0, result.stderr)
        deadline = json.loads(result.stdout)['deadline_at']
        failed = Path(str(self.hcom_log) + '.fail')
        failed.touch()
        self.run_cycles(load_watch(), deadline)
        saved = json.loads(path.read_text())
        self.assertEqual(saved['expiry_count'], 2)
        self.assertTrue(saved['expiry_nudge_pending'])
        self.assertFalse(saved.get('expiry_notified', False))
        failed.unlink()
        self.run_cycles(load_watch(), deadline + 60, deadline + 120)
        saved = json.loads(path.read_text())
        self.assertFalse(saved['expiry_nudge_pending'])
        self.assertTrue(saved['expiry_notified'])
        successful = [r for r in self.watch_records()
                      if r.get('decision') == 'wait-expiry-notified']
        self.assertEqual(len(successful), 1)
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'other', '--reason', 'different')
        self.assertEqual(json.loads(result.stdout)['expiry_count'], 0)

    def test_owner_wait_names_have_no_deadline_and_reject_minutes_without_replacing(self):
        self.wait_session(name='team-orch')
        self.write_task('open.md', 'worker-open', 'team-orch', 'in progress')
        self.install_hcom("#!/bin/sh\nprintf '%s\\n' "
                          "'[{\"name\":\"team-orch\"},{\"name\":\"worker-open\"}]'\n")
        path = self.work / '.lat/watch/waits/worker-open.json'
        for target in ('orch', 'team-orch'):
            with self.subTest(target=target):
                result = self.cli('wait', '--workspace', self.work, '--agent', 'open',
                                  '--for', target, '--reason', 'await assignment')
                self.assertEqual(result.returncode, 0, result.stderr)
                declaration = json.loads(result.stdout)
                self.assertEqual(declaration['target'], 'team-orch')
                self.assertEqual(declaration['kind'], 'agent')
                self.assertNotIn('deadline_at', declaration)
                before = path.read_bytes()
                result = self.cli('wait', '--workspace', self.work, '--agent', 'open',
                                  '--for', target, '--reason', 'await assignment', '--minutes', '50')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('owning orchestrator', result.stderr)
                self.assertEqual(path.read_bytes(), before)
        # A different orchestrator is an ordinary agent target for this worker.
        result = self.cli('wait', '--workspace', self.work, '--agent', 'open',
                          '--for', 'other-orch', '--reason', 'review')
        self.assertEqual(result.returncode, 0, result.stderr)
        declaration = json.loads(result.stdout)
        self.assertEqual(declaration['deadline_at'] - declaration['declared_at'], 3000)

    def test_owner_wait_survives_restart_and_legacy_deadlines_without_expiry_actions(self):
        self.install_hcom('''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HCOM_LOG"
case "$1" in
list) printf '%s\\n' '[{"name":"orch","status":"inactive","status_context":"failure:rate_limit"},{"name":"worker-open","status":"listening"}]';;
term) printf '%s\\n' '{"ready":true,"prompt_empty":true,"lines":[]}';;
esac
''')
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                declaration = dict(agent='worker-open', target='orch', active=True,
                                   declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00')
                if legacy:
                    declaration.update(deadline_at=3000, expiry_count=2,
                                       expiry_declared_at=['old', 'older'], expiry_nudge_pending=True,
                                       expiry_notice=dict(target='orch', declared_at=['old', 'older'],
                                                          conversation_delivered=False, delivered=False))
                watch.write_object(path, declaration)
                for now in (0, 3000, 4800, 86400):
                    self.run_cycles(load_watch(), now)
                    self.assertEqual(json.loads(path.read_text()), {**declaration, 'kind': 'agent'})
                    self.assertEqual(self.watch_state()['worker-open']['decision'], 'valid-wait')
        records = self.watch_records()
        self.assertFalse([r for r in records if r.get('decision') in
                          ('wait-expired', 'wait-extended', 'wait-expiry-notified', 'observation-failed')])
        commands = self.hcom_log.read_text()
        self.assertNotIn('term inject worker-open', commands)
        self.assertNotIn('consecutive expired waits', commands)

    def test_legacy_ambiguous_target_retains_ordinary_expiry(self):
        self.install_hcom('''#!/bin/sh
case "$1" in
list) printf '%s\\n' '[{"name":"orch","status":"listening"},{"name":"worker-open","status":"listening"},{"name":"team-target","base_name":"target","status":"listening"},{"name":"other-target","base_name":"target","status":"listening"}]';;
term) printf '%s\\n' '{"ready":true,"prompt_empty":true,"lines":[]}';;
esac
''')
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(agent='worker-open', target='target', kind='agent',
                                     active=True, declared_at=0, deadline_at=60,
                                     declared_at_utc='1970-01-01T00:00:00+00:00'))
        self.run_cycles(watch, 60)
        saved = json.loads(path.read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'expired')
        self.assertEqual(saved['expiry_count'], 1)
        self.assertFalse([r for r in self.watch_records()
                          if r.get('decision') == 'observation-failed'])

    def test_owner_wait_releases_on_incoming_message_or_owner_successful_send(self):
        transcript = self.root / 'owner.jsonl'
        transcript.write_text('')
        self.install_hcom(f'''#!/bin/sh
case "$1" in
list) printf '%s\\n' '[{{"name":"orch","status":"listening","transcript_path":"{transcript}"}},{{"name":"worker-open","status":"listening","session_id":"waiter-session"}}]';;
term) printf '%s\\n' '{{"ready":true,"prompt_empty":true,"lines":[]}}';;
events) if [ -f "$FAKE_HCOM_LOG.message" ]; then
          printf '%s\\n' '{{"id":1,"type":"status","data":{{"session":"waiter-session","context":"deliver:someone-else"}}}}'; fi;;
esac
''')
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        for reason in ('message-delivered', 'target-replied'):
            with self.subTest(reason=reason):
                watch.write_object(path, dict(agent='worker-open', kind='agent', target='orch',
                                             active=True, declared_at=0,
                                             declared_at_utc='1970-01-01T00:00:00+00:00'))
                if reason == 'message-delivered':
                    Path(f'{self.hcom_log}.message').touch()
                else:
                    Path(f'{self.hcom_log}.message').unlink()
                    transcript.write_text(json.dumps(dict(
                        timestamp='1970-01-02T00:00:00+00:00', type='event_msg',
                        payload=dict(type='item_completed', item=dict(
                            type='CommandExecution', command=['hcom send @worker-open -- done'],
                            status='completed', exit_code=0, stdout='Sent to: worker-open')))) + '\n')
                self.run_cycles(load_watch(), 86400)
                saved = json.loads(path.read_text())
                self.assertFalse(saved['active'])
                self.assertEqual(saved['released_reason'], reason)
                self.assertNotIn('deadline_at', saved)

    def test_wait_deadline_range_and_decision_rejection(self):
        decisions = self.wait_session()
        (decisions / 'HELP.md').write_text('- status: pending\n')
        for minutes in ('0', '721', 'no', '1.5'):
            result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                              '--for', 'reviewer', '--reason', 'review',
                              '--minutes', minutes)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.work / '.lat/watch/waits').exists())
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'HELP', '--reason', 'decision', '--minutes', '1')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('decision', result.stderr)
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'HELP', '--reason', 'decision')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('deadline_at', json.loads(result.stdout))
        for minutes, seconds in (('1', 60), ('720', 43200)):
            result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                              '--for', 'reviewer', '--reason', 'review',
                              '--minutes', minutes)
            self.assertEqual(result.returncode, 0, result.stderr)
            saved = json.loads(result.stdout)
            self.assertEqual(saved['deadline_at'] - saved['declared_at'], seconds)

    def test_wait_default_deadline_and_self_wait_contract(self):
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'reviewer', '--reason', 'review')
        self.assertEqual(result.returncode, 0, result.stderr)
        saved = json.loads(result.stdout)
        self.assertEqual(saved['kind'], 'agent')
        self.assertEqual(saved['deadline_at'] - saved['declared_at'], 3000)
        path = self.work / '.lat/watch/waits/worker-open.json'
        before = path.read_bytes()
        for target in ('worker-open', 'open'):
            result = self.cli('wait', '--workspace', self.work, '--agent', 'open',
                              '--for', target, '--reason', 'self')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('alarm', result.stderr)
            self.assertEqual(path.read_bytes(), before)

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
                    self.assertIn('HCOM lists: other-advisor, team-advisor', result.stderr)
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
        (decisions / 'HELP.md').write_text('- status: approved\n')
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
                for text in ('HELP.md', 'approved', 'pending decision', 'manual step'):
                    self.assertIn(text, result.stderr)
                if previous is None:
                    self.assertFalse(declaration.exists())
                else:
                    self.assertEqual(declaration.read_bytes(), previous)

    def test_wait_accepts_pending_unreadable_and_agent_targets(self):
        decisions = self.wait_session()
        cases = {
            'PENDING': [('PENDING.md', '- status: pending\n')],
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

    def test_wait_for_agent_name_that_prefixes_a_decision_id(self):
        decisions = self.wait_session()
        self.install_hcom(
            '#!/bin/sh\n'
            '[ "$1 $2 $3" = "list --json --name" ] && [ $# -eq 4 ] || exit 2\n'
            'printf \'%s\\n\' \'[{"name":"orch"},{"name":"worker-open"},{"name":"teho"}]\'\n'
        )
        wait = self.work / '.lat/watch/waits/worker-open.json'
        for status in ('approved', 'pending'):
            with self.subTest(status=status):
                (decisions / 'teho-lid-1.md').write_text(f'- status: {status}\n')
                result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                                  '--for', 'teho', '--reason', 'waiting')
                self.assertEqual(result.returncode, 0, result.stderr)
                stored = json.loads(wait.read_text())
                self.assertEqual((stored['kind'], stored['target']), ('agent', 'teho'))
                self.assertIn('deadline_at', stored)

    def test_wait_for_ambiguous_short_name_falls_back_to_exact_decision(self):
        decisions = self.wait_session()
        self.install_hcom(
            '#!/bin/sh\n'
            '[ "$1 $2 $3" = "list --json --name" ] && [ $# -eq 4 ] || exit 2\n'
            'printf \'%s\\n\' \'[{"name":"orch"},{"name":"worker-open"},'
            '{"name":"a-teho"},{"name":"b-teho"}]\'\n'
        )
        (decisions / 'teho.md').write_text('- status: pending\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'teho', '--reason', 'waiting')
        self.assertEqual(result.returncode, 0, result.stderr)
        stored = json.loads((self.work / '.lat/watch/waits/worker-open.json').read_text())
        self.assertEqual(stored['kind'], 'decision')
        (decisions / 'teho.md').unlink()
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'teho', '--reason', 'waiting')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Ambiguous', result.stderr)

    def test_wait_for_decision_needs_the_full_id(self):
        decisions = self.wait_session()
        (decisions / 'teho-lid-1.md').write_text('- status: pending\n')
        wait = self.work / '.lat/watch/waits/worker-open.json'
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'teho-lid-1', '--reason', 'waiting')
        self.assertEqual(result.returncode, 0, result.stderr)
        stored = json.loads(wait.read_text())
        self.assertEqual((stored['kind'], stored['match']), ('decision', 'exact'))
        (decisions / 'teho-lid-1.md').write_text('- status: approved\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'teho-lid-1', '--reason', 'waiting')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('no pending decision', result.stderr)
        # Neither a bare prefix of the ID nor an unknown name is a decision.
        (decisions / 'teho-lid-1.md').write_text('- status: pending\n')
        result = self.cli('wait', '--workspace', self.work, '--agent', 'worker-open',
                          '--for', 'teho-lid', '--reason', 'waiting')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(wait.read_text())['kind'], 'agent')

    def test_release_ignores_decision_files_for_agent_declaration(self):
        watch = load_watch()
        decisions = self.work / 'decisions'
        decisions.mkdir()
        (decisions / 'teho-lid-1.md').write_text('- status: approved\n')
        self.install_hcom('#!/bin/sh\n[ "$1 $2 $3" = "list --json --name" ] && [ $# -eq 4 ] || exit 2\nprintf \'[]\\n\'\n')
        base = {'agent': 'worker-open', 'target': 'teho', 'reason': 'x',
                'declared_at': time.time(), 'declared_at_utc': '2026-10-04T00:00:00+00:00',
                'active': True}
        cases = [({**base, 'kind': 'agent'}, None),
                 ({**base, 'target': 'teho-lid-1', 'kind': 'decision'}, 'decision-resolved'),
                 ({**base, 'target': 'teho-lid-1', 'kind': 'decision', 'match': 'exact'},
                  'decision-resolved'),
                 ({**base, 'target': 'teho-lid'}, 'decision-resolved'),
                 ({**base, 'target': 'teho-lid', 'kind': 'decision', 'match': 'exact'}, None)]
        for declaration, expected in cases:
            with self.subTest(declaration=declaration):
                watch.write_object(watch.wait_path(self.work, 'worker-open'), declaration)
                with patch.dict(os.environ, self.env):
                    reason = watch.release_wait_if_needed(
                        self.work, decisions, 'orch', declaration, {})
                self.assertEqual(reason, expected)

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

    def test_working_screen_defers_alarm_and_expiry_despite_ready_empty_prompt(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                self.finished_codex_fixture(client)
                listing = Path(self.env['FAKE_AGENTS'])
                agents = json.loads(listing.read_text())
                for agent in agents:
                    agent['status'] = 'listening'
                listing.write_text(json.dumps(agents))
                terminal = Path(self.env['FAKE_TERMINAL'])
                screen = json.loads(terminal.read_text())
                screen['lines'] = (['Working (56s • esc to interrupt) · 1 background terminal running']
                                   if client == 'codex' else ['✻ Working… (56s · esc to interrupt)'])
                terminal.write_text(json.dumps(screen))
                self.hcom_log.write_text('')
                watch = load_watch()
                alarm_path = self.save_alarm(watch)
                wait_path = watch.wait_path(self.work, 'orch')
                watch.write_object(wait_path, dict(agent='orch', kind='agent', target='absent',
                                   declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                                   deadline_at=60, active=True))
                self.run_finished_cycles(watch, 0, 60)
                self.assertEqual(self.injections(), [])
                self.assertTrue(json.loads(alarm_path.read_text())['active'])
                self.assertTrue(json.loads(wait_path.read_text())['expiry_nudge_pending'])
                screen['lines'] = []
                terminal.write_text(json.dumps(screen))
                self.run_finished_cycles(watch, 120)
                self.assertEqual(len(self.injections()), 2)
                self.assertEqual(json.loads(alarm_path.read_text())['released_reason'], 'rang')
                self.assertFalse(json.loads(wait_path.read_text())['expiry_nudge_pending'])

    def test_claude_alarm_and_expiry_follow_hcom_status_not_the_footer(self):
        # Screen shapes recorded live for issue #268; the footer text is arbitrary.
        model_menu = ['   Select model', '   ❯ 3.  Sonnet 5.5 ✔', '   ○ Low effort ←/→ to adjust']
        approval = [' Do you want to proceed?', ' ❯ 1. Yes', '   4. No', ' Esc to cancel · Tab to amend']
        idle = ['❯', '─' * 40, '  ⏵⏵ some future mode · 7 widgets · ↓ to manage']
        cases = {
            'listening, background footer, not ready': ('listening', False, True, '', idle, 2),
            'active': ('active', True, True, '', idle, 0),
            'blocked approval': ('blocked', False, None, None, approval, 0),
            'prompt has text': ('listening', True, False, 'draft', idle, 0),
            'listening /model menu': ('listening', False, None, None, model_menu, 0),
        }
        for name, (status, ready, empty, text, lines, sent) in cases.items():
            with self.subTest(name):
                self.finished_codex_fixture('claude')
                listing = Path(self.env['FAKE_AGENTS'])
                agents = json.loads(listing.read_text())
                for agent in agents:
                    agent['status'] = status
                listing.write_text(json.dumps(agents))
                Path(self.env['FAKE_TERMINAL']).write_text(json.dumps(
                    {'ready': ready, 'prompt_empty': empty, 'input_text': text, 'lines': lines}))
                self.hcom_log.write_text('')
                watch = load_watch()
                alarm_path = self.save_alarm(watch)
                wait_path = watch.wait_path(self.work, 'orch')
                watch.write_object(wait_path, dict(agent='orch', kind='agent', target='absent',
                                   declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00',
                                   deadline_at=60, active=True))
                self.run_finished_cycles(watch, 0, 60)
                self.assertEqual(len(self.injections()), sent)
                self.assertEqual(json.loads(alarm_path.read_text()).get('released_reason'),
                                 'rang' if sent else None)
                self.assertEqual(json.loads(wait_path.read_text())['expiry_nudge_pending'],
                                 not sent)
                self.assertFalse([r for r in self.watch_records()
                                  if r.get('decision') == 'observation-failed'])

    def test_real_a07_cycle_preserves_alarm_during_foreground_work(self):
        for client in ('codex', 'claude'):
            with self.subTest(client=client):
                transcript = self.finished_codex_fixture(client)
                with transcript.open('a') as stream:
                    stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'task_started'}}) + '\n')
                self.hcom_log.write_text('')
                watch = load_watch()
                path = self.save_alarm(watch)
                self.run_finished_cycles(watch, 0, 60)
                row = next(r for r in reversed(self.watch_records()) if r.get('agent') == 'worker-open')
                observed = row['observation']
                self.assertEqual(observed['status'], 'active')
                self.assertTrue(observed['command_running'])
                self.assertTrue(observed['terminal_ready'])
                self.assertTrue(observed['prompt_empty'])
                self.assertEqual(self.injections(), [])
                self.assertTrue(json.loads(path.read_text())['active'])
                if client == 'codex':
                    with transcript.open('a') as stream:
                        stream.write(json.dumps({'type': 'event_msg', 'payload': {'type': 'task_complete'}}) + '\n')
                else:
                    listing = Path(self.env['FAKE_AGENTS'])
                    agents = json.loads(listing.read_text())
                    for agent in agents:
                        agent['status'] = 'listening'
                    listing.write_text(json.dumps(agents))
                self.run_finished_cycles(watch, 120, 180)
                self.assertEqual(len(self.injections()), 1)
                self.assertEqual(json.loads(path.read_text())['released_reason'], 'rang')

    def test_stale_active_finished_codex_can_ring_and_nudge_expiry_with_background(self):
        self.finished_codex_fixture()
        watch = load_watch()
        alarm_path = self.save_alarm(watch)
        wait_path = watch.wait_path(self.work, 'orch')
        watch.write_object(wait_path, dict(agent='orch', kind='agent', target='absent', declared_at=0,
                           declared_at_utc='1970-01-01T00:00:00+00:00', deadline_at=60, active=True))
        self.run_finished_cycles(watch, 0, 60)
        self.assertEqual(len(self.injections()), 2)
        self.assertEqual(json.loads(alarm_path.read_text())['released_reason'], 'rang')
        self.assertFalse(json.loads(wait_path.read_text())['expiry_nudge_pending'])

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
                notices = [(row['agent'], action['kind']) for row in self.watch_records()
                           if row.get('at') == 1_800 for action in row.get('actions', [])]
                self.assertEqual(notices, [('orch', 'notify-user'),
                                          ('worker-open', 'notify-orchestrator')])
                nudge_count = len(self.injections())
                self.run_cycles(watch, 2_400, 2_401, 3_000)
                self.assertEqual(len(self.injections()), nudge_count)
                later = [(row['agent'], action['kind'])
                         for row in self.watch_records() if row.get('at', 0) >= 2_400
                         for action in row.get('actions', [])]
                self.assertEqual(later, [('worker-open', 'notify-user')])
                # Start the next client with a fresh persisted episode and log.
                (self.work / '.lat/watch/orch/state.json').unlink()
                (self.work / '.lat/watch/orch/watch.jsonl').unlink()

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

    def test_codex_usage_limit_accepts_curly_apostrophe(self):
        watch = load_watch()
        issue = watch.detect_screen_quota([
            '', '', '', '', '', '', '', '',
            '■ You’ve hit your usage limit · resets Oct 10, 2026',
            '', '', '› Ask Codex to do anything', '',
            '  GPT-6.1-Sol medium · ~/repo · 0% left',
        ], 'codex')

        self.assertIn('You’ve hit your usage limit', issue.line)
        self.assertEqual(issue.reset_time, 'Oct 10, 2026')

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

    def test_native_agent_card_is_field_checked_but_never_reported_missing_or_nudged(self):
        self.write_card('native.md', 'vuho-uitext-web（Claude 內建 Agent）',
                        fields='- native agent：是\n- live actions：無\n')
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 0, 60, 120, 1800)
        notices = self.disappearance_notices()
        self.assertEqual(len(notices), 1)
        self.assertIn('worker-open', notices[0]['message'])
        self.assertFalse(any(record.get('agent') == 'vuho-uitext-web'
                             for record in self.watch_records()))
        commands = self.hcom_log.read_text().splitlines()
        self.assertFalse(any('vuho-uitext-web' in line for line in commands
                             if not line.startswith('send @orch ')))
        self.assertEqual([card for _, card, _ in self.field_records()], ['native.md'])
        status = self.cli('status', '--workspace', self.work,
                          '--orchestrator', 'orch', '--tasks', self.tasks)
        self.assertEqual([item['agent'] for item in json.loads(status.stdout)['targets']],
                         ['orch', 'worker-open'])

    def test_card_archived_before_shutdown_does_not_notify(self):
        self.disappearance_hcom('listening')
        self.run_cycles(load_watch(), 0)
        (self.tasks / 'open.md').rename(self.tasks / 'done/open.md')
        self.disappearance_hcom()
        self.run_cycles(load_watch(), 60, 120)
        self.assertEqual(self.disappearance_notices(), [])
        self.assertNotIn('worker-open', self.watch_state())

    def listing_hcom(self, **statuses):
        listing = self.root / 'agents.json'
        listing.write_text(json.dumps([{'name': name.replace('_', '-'), 'status': status}
                                       for name, status in statuses.items()]))
        self.install_hcom(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            f'if [ "$1" = list ]; then cat "{listing}"\n'
            'elif [ "$1" = term ]; then\n'
            '  printf \'%s\\n\' \'{"ready":true,"prompt_empty":true}\'\n'
            'fi\n'
        )

    def test_unchanged_status_writes_nothing_for_ten_minutes_and_a_change_writes_one(self):
        self.listing_hcom(orch='active', worker_open='active')
        watch = load_watch()
        self.run_cycles(watch, 0)
        first = self.watch_records()
        self.assertEqual([record['agent'] for record in first], ['orch', 'worker-open'])
        self.run_cycles(watch, *range(60, 601, 60))
        self.assertEqual(self.watch_records(), first)
        self.listing_hcom(orch='active', worker_open='blocked')
        self.run_cycles(watch, 660)
        added = self.watch_records()[len(first):]
        self.assertEqual([(record['agent'], record['observation']['status'])
                          for record in added], [('worker-open', 'blocked')])
        self.run_cycles(watch, 720)
        self.assertEqual(len(self.watch_records()), len(first) + 1)

    def test_watch_log_over_one_megabyte_rotates_keeping_one_old_file(self):
        watch = load_watch()
        log = watch.state_path(self.work, 'orch').with_name('watch.jsonl')
        log.parent.mkdir(parents=True)
        for marker in ('first', 'second'):
            log.write_text(json.dumps({'old': marker}) + '\n' + 'x' * watch.LOG_ROTATE_BYTES)
            watch.append_log(log, {'new': marker})
            self.assertEqual(log.read_text().splitlines(), [json.dumps({'new': marker},
                                                                       separators=(',', ':'))])
            self.assertIn(marker, log.with_name('watch.jsonl.1').read_text().splitlines()[0])
        self.assertEqual(sorted(path.name for path in log.parent.iterdir()),
                         ['watch.jsonl', 'watch.jsonl.1'])
        watch.append_log(log, {'new': 'third'})
        self.assertEqual(len(log.read_text().splitlines()), 2)

    def test_watch_log_rotation_threshold_is_exactly_one_mebibyte(self):
        watch = load_watch()
        one_mib = 1024 * 1024
        log = watch.state_path(self.work, 'orch').with_name('watch.jsonl')
        old = log.with_name('watch.jsonl.1')
        log.parent.mkdir(parents=True)
        for size in (one_mib - 1, one_mib):
            log.write_text('x' * size)
            watch.append_log(log, {'new': size})
            self.assertFalse(old.exists(), size)
            self.assertEqual(log.stat().st_size, size + len('{"new":%d}\n' % size))
            log.unlink()
        log.write_text('x' * (one_mib + 1))
        watch.append_log(log, {'new': 'over'})
        self.assertEqual(log.read_text(), '{"new":"over"}\n')
        self.assertEqual(old.stat().st_size, one_mib + 1)
        self.assertEqual(sorted(path.name for path in log.parent.iterdir()),
                         ['watch.jsonl', 'watch.jsonl.1'])

    def test_orchestrator_gone_sixty_minutes_stops_but_a_short_absence_does_not(self):
        watch = load_watch()
        self.listing_hcom(worker_open='active')
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        with patch.dict(os.environ, self.env):
            results = [watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=now)
                       for now in range(0, 1801, 60)]
            self.listing_hcom(orch='listening', worker_open='active')
            results.append(watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=1860))
            self.assertNotIn('missing_since', self.watch_state()['orch'])
            # A listed inactive identity is still found, so it never counts as gone.
            self.listing_hcom(orch='inactive', worker_open='active')
            results += [watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=now)
                        for now in range(1920, 1920 + 3601, 60)]
            self.assertNotIn('missing_since', self.watch_state()['orch'])
            self.listing_hcom(worker_open='active')
            results += [watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=now)
                        for now in range(5580, 5580 + 3600, 60)]
            self.assertEqual(set(results), {None})
            reason = watch.run_cycle(self.work, self.tasks, decisions, 'orch', now=9180)
        self.assertEqual(reason, 'orchestrator orch missing from HCOM for 60 minutes')
        self.assertNotIn('missing_since', self.watch_state()['orch'])
        self.assertEqual(len([record for record in self.watch_records()
                              if record.get('decision') == 'not-observable']), 2)

    def test_watcher_stops_itself_removing_pid_and_noting_reason_in_active_session(self):
        watch = load_watch()
        self.listing_hcom(worker_open='active')
        sessions = self.work / '.lat/sessions'
        sessions.mkdir(parents=True)
        record = dict(session_id='sid', role='orchestrator', status='active',
                      workspace=str(self.work), hcom_name='orch')
        (sessions / 'sid.json').write_text(json.dumps(record))
        root = self.work / '.lat/watch'
        root.mkdir()
        (root / 'sid.pid').write_text(str(os.getpgrp()))
        (root / 'other.pid').write_text('999999')
        self.run_cycles(watch, *range(0, 3541, 60))
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks, ledger=None,
                                  decisions=self.work / '.lat/decisions', orchestrator='orch')
        with patch.dict(os.environ, self.env), patch.object(watch.time, 'time', return_value=3600), \
                patch.object(watch.time, 'sleep', side_effect=AssertionError('kept running')):
            self.assertIsNone(watch.run_forever(args))
        self.assertFalse((root / 'sid.pid').exists())
        self.assertTrue((root / 'other.pid').exists())
        saved = json.loads((sessions / 'sid.json').read_text())
        self.assertEqual(saved['status'], 'active')
        self.assertEqual(saved['watcher_stopped']['reason'],
                         'orchestrator orch missing from HCOM for 60 minutes')
        self.assertEqual(saved['watcher_stopped']['at_utc'], '1970-01-01T01:00:00+00:00')
        self.assertEqual((root / 'sid.log').read_text(),
                         '1970-01-01T01:00:00+00:00 LAT watch stopped: '
                         'orchestrator orch missing from HCOM for 60 minutes\n')
        self.assertEqual(self.watch_records()[-1]['decision'], 'watcher-stopped')

    def test_watcher_started_in_a_linked_worktree_uses_the_main_checkout_lat(self):
        main = self.root / 'main'
        main.mkdir()
        git = ['git', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid']
        subprocess.run([*git, 'init', '-q', str(main)], check=True)
        subprocess.run([*git, '-C', str(main), 'commit', '-q', '--allow-empty', '-m', 'init'],
                       check=True)
        worktree = self.root / 'wt'
        subprocess.run([*git, '-C', str(main), 'worktree', 'add', '-q', str(worktree)],
                       check=True)
        self.listing_hcom(orch='active')
        decisions = main / '.lat/decisions'
        decisions.mkdir(parents=True)
        watch = load_watch()
        with patch.dict(os.environ, self.env):
            watch.run_cycle(worktree, main / '.lat/tasks', decisions, 'orch', now=0)
        self.assertFalse((worktree / '.lat').exists())
        self.assertTrue((main / '.lat/watch/orch/watch.jsonl').is_file())
        self.assertEqual(watch.wait_path(worktree, 'orch'), main / '.lat/watch/waits/orch.json')

    def test_log_append_and_rotation_wait_for_another_writer(self):
        watch = load_watch()
        log = watch.state_path(self.work, 'orch').with_name('watch.jsonl')
        log.parent.mkdir(parents=True)
        log.write_text('x' * (watch.LOG_ROTATE_BYTES + 1))
        directory = os.open(log.parent, os.O_RDONLY)
        self.addCleanup(os.close, directory)
        fcntl.flock(directory, fcntl.LOCK_EX)
        writer = threading.Thread(target=watch.append_log, args=(log, {'new': 1}))
        writer.start()
        writer.join(0.3)
        self.assertTrue(writer.is_alive())
        self.assertFalse(log.with_name('watch.jsonl.1').exists())
        fcntl.flock(directory, fcntl.LOCK_UN)
        writer.join(5)
        self.assertEqual(log.read_text(), '{"new":1}\n')
        self.assertTrue(log.with_name('watch.jsonl.1').exists())

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
                patch.object(watch, 'read_processes') as read_processes:
            observation = watch.observe(
                self.work, self.work / '.lat/decisions', 'orch', 'worker-open', info,
                processes=[])
        read_processes.assert_not_called()

        self.assertEqual(observation.input_text, '')
        self.assertFalse(observation.prompt_empty)
        self.assertEqual(observation.model, 'GPT-5.6-Sol')
        self.assertIn('Selected model is at capacity', observation.quota_issue.line)
        state, actions = watch.decide(None, observation, now=0)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertFalse(state['nudged'])

    def observe_screen(self, terminal, status='active'):
        watch = load_watch()
        info = {'status': status, 'tool': 'codex', 'unread_count': 0}
        with patch.object(watch, 'run_json', return_value=terminal), \
                patch.object(watch, 'session_events', return_value=[]), \
                patch.object(watch, 'release_wait_if_needed', return_value=None):
            return watch, watch.observe(
                self.work, self.work / '.lat/decisions', 'orch', 'worker-open', info,
                processes=[])

    def test_active_agent_screen_errors_notify_and_repeat_every_20_minutes(self):
        codex_ui = ['', '› Ask Codex to do anything', '',
                    '  GPT-6.1-Sol medium · ~/repo · Context 0% used']
        healthy = {'ready': False, 'prompt_empty': True, 'input_text': '', 'lines': [
            '■ Selected model is at capacity. Please try a different model.',
            '• Retrying the previous step now.', 'Working (5s · esc to interrupt)',
            *codex_ui]}
        screens = {
            # Typed text keeps the watcher from sending Continue, so it only notifies.
            'model-capacity': {'ready': True, 'prompt_empty': False, 'input_text': 'draft',
                               'lines': [
                '■ Selected model is at capacity. Please try a different model.', *codex_ui]},
            'usage-limit': {'ready': True, 'prompt_empty': True, 'input_text': '', 'lines': [
                '■ Quota exceeded. Check your plan and billing details.', *codex_ui]},
            # A Codex panic leaves the raw crash text with no prompt or input box.
            'crash': {'ready': False, 'prompt_empty': None, 'input_text': None, 'lines': [
                'Warning: SpanTrace capture is Unsupported.',
                'The application panicked (crashed).',
                'Message:  provider auth cwd must resolve: No such file or dire',
                'ctory (os error 2)',
                'Location: protocol/src/config_types.rs:629',
                '',
                'Backtrace omitted. Run with RUST_BACKTRACE=1 environment varia',
                'ble to display it.']},
        }
        for kind, terminal in screens.items():
            with self.subTest(kind=kind):
                watch, stuck = self.observe_screen(terminal)
                self.assertEqual(stuck.quota_issue.kind, kind)

                # Capacity and quota notify at once; a crash waits for the stall threshold.
                first = 20 * 60 if kind == 'crash' else 0
                state, actions = watch.decide(None, stuck, now=0)
                if first:
                    self.assertEqual(actions, ())
                    state, actions = watch.decide(state, stuck, now=first - 1)
                    self.assertEqual(actions, ())
                    state, actions = watch.decide(state, stuck, now=first)
                self.assertEqual(actions[0].kind, 'notify-orchestrator')
                self.assertIn('worker-open', actions[0].message)
                state, actions = watch.decide(state, stuck, now=first + 20 * 60 - 1)
                self.assertEqual(actions, ())
                state, actions = watch.decide(state, stuck, now=first + 20 * 60)
                self.assertEqual(actions[0].kind, 'notify-orchestrator')
                self.assertIn(f'unchanged for {(first + 20 * 60) // 60} minutes',
                              actions[0].message)
                state, actions = watch.decide(state, stuck, now=first + 40 * 60)
                self.assertEqual(actions[0].kind, 'notify-orchestrator')

                _, recovered = self.observe_screen(healthy)
                self.assertIsNone(recovered.quota_issue)
                for minute in (61, 81, 101, 140):
                    state, actions = watch.decide(
                        state, recovered._replace(event_id=minute), now=minute * 60)
                    self.assertEqual(actions, ())

        crash = screens['crash']
        self.assertIn('The application panicked',
                      self.observe_screen(crash)[1].quota_issue.line)
        self.assertEqual(watch.quota_notice(self.observe_screen(crash)[1]).label, '程式崩潰')

        # Crash text on the screen of an agent that keeps making progress never notifies.
        _, crashed = self.observe_screen(crash)
        state = None
        for minute in range(0, 61, 5):
            state, actions = watch.decide(
                state, crashed._replace(transcript_size=minute + 1), now=minute * 60)
            self.assertEqual(actions, ())

    def test_changed_error_screen_restarts_the_repeat_timer(self):
        lines = ['■ Selected model is at capacity. Please try a different model.', '',
                 '› Ask Codex to do anything', '', '  GPT-6.1-Sol medium · ~/repo']
        terminal = {'ready': True, 'prompt_empty': False, 'input_text': 'draft', 'lines': lines}
        watch, stuck = self.observe_screen(terminal)
        state, _ = watch.decide(None, stuck, now=0)
        _, moved = self.observe_screen(dict(terminal, lines=['scrolled', *lines]))
        state, actions = watch.decide(state, moved, now=15 * 60)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, moved, now=34 * 60)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, moved, now=35 * 60)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')

    def test_old_error_in_scrollback_with_healthy_last_screen_does_not_notify(self):
        codex_ui = ['', '› Ask Codex to do anything', '',
                    '  GPT-6.1-Sol medium · ~/repo · Context 3% used']
        old_errors = [
            ['■ Quota exceeded. Check your plan and billing details.',
             '• Switched accounts; continuing the task.', *codex_ui],
            ['thread \'main\' panicked at src/main.rs:3:5:', 'stack backtrace:',
             '╭──────────────────────────╮', '│ >_ OpenAI Codex          │',
             '╰──────────────────────────╯', *codex_ui],
            ['The application panicked (crashed).',
             '■ Selected model is at capacity. Please try a different model.',
             '• Resumed after capacity returned.', *codex_ui],
            ['• The failing test printed "thread \'main\' panicked at lib.rs" and',
             '  a Backtrace line; both are fixed now.', *codex_ui],
            # A newer error the watcher does not classify still replaces the older one.
            ['■ Selected model is at capacity. Please try a different model.',
             '■ Error: stream disconnected before completion.', *codex_ui],
        ]
        for lines in old_errors:
            with self.subTest(lines=lines[0]):
                watch, observation = self.observe_screen(
                    {'ready': True, 'prompt_empty': True, 'input_text': '', 'lines': lines})
                self.assertIsNone(observation.quota_issue)
                _, actions = watch.decide(None, observation, now=0)
                self.assertEqual(actions, ())
                _, actions = watch.decide(_, observation, now=40 * 60)
                self.assertNotIn('notify-orchestrator', [action.kind for action in actions])

    CAPACITY_LINES = ['■ Selected model is at capacity. Please try a different model.', '',
                      '› Ask Codex to do anything', '', '  GPT-6.1-Sol medium · ~/repo']
    RECOVERED_LINES = ['■ Selected model is at capacity. Please try a different model.',
                       '› Continue', '• Picking up the task again.',
                       'Working (3s · esc to interrupt)', '', '› Ask Codex to do anything']

    def capacity_screen(self, input_text=''):
        terminal = {'ready': True, 'prompt_empty': not input_text, 'input_text': input_text,
                    'lines': self.CAPACITY_LINES}
        return self.observe_screen(terminal)

    def test_codex_capacity_sends_continue_once_and_notifies_after_5_minutes(self):
        watch, stuck = self.capacity_screen()
        state, actions = watch.decide(None, stuck, now=0)
        self.assertEqual([(a.kind, a.agent, a.text) for a in actions],
                         [('capacity-continue', 'worker-open', 'Continue')])
        self.assertEqual(state['decision'], 'capacity-continue')

        # The injected Continue changes the transcript; the screen is still on capacity.
        for minute in (1, 2, 3, 4):
            state, actions = watch.decide(
                state, stuck._replace(transcript_size=minute), now=minute * 60 + 59)
            self.assertEqual(actions, ())
        state, actions = watch.decide(state, stuck._replace(transcript_size=4), now=5 * 60)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertIn('Continue was sent 5 minutes ago with no reaction', actions[0].message)
        self.assertIn('hand the work to another agent', actions[0].message)
        state, actions = watch.decide(state, stuck._replace(transcript_size=4), now=6 * 60)
        self.assertEqual(actions, ())

        # Then the B1 repeat: every 20 minutes while the same screen stays.
        state, actions = watch.decide(state, stuck._replace(transcript_size=4), now=25 * 60)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertIn('Still on screen', actions[0].message)
        self.assertIn('Continue was sent 25 minutes ago', actions[0].message)

    def test_codex_capacity_new_output_cancels_the_notice_and_opens_a_new_episode(self):
        watch, stuck = self.capacity_screen()
        _, recovered = self.observe_screen({'ready': False, 'prompt_empty': True,
                                            'input_text': '', 'lines': self.RECOVERED_LINES})
        self.assertIsNone(recovered.quota_issue)
        state, actions = watch.decide(None, stuck, now=0)
        self.assertEqual(actions[0].kind, 'capacity-continue')
        for minute in range(1, 12):
            state, actions = watch.decide(
                state, recovered._replace(transcript_size=minute, capacity_output=True),
                now=minute * 60)
            self.assertEqual(actions, ())

        # Capacity again right after one round of new output is a new episode.
        _, again = self.observe_screen({'ready': True, 'prompt_empty': True, 'input_text': '',
                                        'lines': [*self.RECOVERED_LINES[:3],
                                                  *self.CAPACITY_LINES]})
        self.assertEqual(again.quota_issue.kind, 'model-capacity')
        _, actions = watch.decide(state, again._replace(transcript_size=20, capacity_output=True),
                                  now=13 * 60)
        self.assertEqual([a.kind for a in actions], ['capacity-continue'])
        state, _ = watch.decide(None, stuck, now=0)
        # Even a heading identical to the old screen counts once the transcript shows output.
        state, actions = watch.decide(
            state, stuck._replace(transcript_size=20, capacity_output=True), now=120)
        self.assertEqual([a.kind for a in actions], ['capacity-continue'])
        state, actions = watch.decide(state, stuck._replace(transcript_size=21), now=180)
        self.assertEqual(actions, ())

    def test_capacity_output_is_any_transcript_record_beyond_the_continue_echo(self):
        watch = load_watch()
        transcript = self.work / 'codex.jsonl'
        echo = [{'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Continue'}},
                {'type': 'event_msg', 'payload': {'type': 'error',
                                                  'message': 'Selected model is at capacity.'}}]
        outputs = {
            'tool call': {'type': 'response_item', 'payload': {
                'type': 'function_call', 'name': 'shell', 'arguments': '{"command":"pwd"}'}},
            'short reply': {'type': 'event_msg', 'payload': {'type': 'agent_message',
                                                             'message': 'OK'}},
        }
        other_user = {'type': 'event_msg', 'payload': {'type': 'user_message',
                                                       'message': 'New instructions'}}
        # Only complete reply or tool records count; unknown data keeps the episode.
        developer = {'type': 'response_item', 'payload': {'type': 'message', 'role': 'developer',
                                                          'content': []}}
        cases = {'echo only': ([], '', False),
                 'other user input': ([other_user, developer], '', False),
                 'partial record': ([], '{"type":"response_item","payload":{"ty', False),
                 'unreadable': ([], None, False),
                 **{name: ([record], '', True) for name, record in outputs.items()}}
        for name, (extra, tail, expected) in cases.items():
            with self.subTest(name=name):
                transcript.write_text('{"type":"session_meta","payload":{}}\n')
                offset = transcript.stat().st_size
                with transcript.open('a') as stream:
                    for record in [*echo, *extra]:
                        stream.write(json.dumps(record) + '\n')
                    stream.write(tail or '')
                size = transcript.stat().st_size
                if tail is None:
                    transcript.unlink()
                observation = watch.Observation(
                    agent='worker-open', status='active', prompt_empty=True,
                    command_running=False, transcript_size=size,
                    transcript_mtime_ns=1, event_id=0, client='codex')
                result = watch.nudge_only_observation(
                    {'fingerprint': [offset, 0, 0], 'capacity_offset': offset}, observation,
                    {'transcript_path': str(transcript)}, 'orch')
                self.assertEqual(result.capacity_output, expected)

    def test_codex_capacity_working_without_new_output_is_still_the_same_episode(self):
        watch, stuck = self.capacity_screen()
        _, working = self.observe_screen({'ready': False, 'prompt_empty': True, 'input_text': '',
                                          'lines': [*self.CAPACITY_LINES[:1], '› Continue',
                                                    'Working (3s · esc to interrupt)']})
        self.assertIsNone(working.quota_issue)
        state, _ = watch.decide(None, stuck, now=0)
        for minute in (1, 2, 3):
            state, actions = watch.decide(
                state, working._replace(transcript_size=minute), now=minute * 60)
            self.assertEqual(actions, ())
        state, actions = watch.decide(state, stuck._replace(transcript_size=4), now=4 * 60)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, stuck._replace(transcript_size=4), now=5 * 60)
        self.assertIn('Continue was sent 5 minutes ago', actions[0].message)

    def test_codex_capacity_followed_by_another_error_or_close_skips_the_handoff_notice(self):
        watch, stuck = self.capacity_screen()
        _, quota = self.observe_screen({'ready': True, 'prompt_empty': True, 'input_text': '',
                                        'lines': ['■ Quota exceeded. Check your plan.',
                                                  *self.CAPACITY_LINES[1:]]})
        state, _ = watch.decide(None, stuck, now=0)
        state, actions = watch.decide(state, quota._replace(transcript_size=1), now=2 * 60)
        self.assertEqual(actions[0].kind, 'notify-orchestrator')
        self.assertNotIn('Continue was sent', actions[0].message)
        for minute in (5, 10):
            state, actions = watch.decide(state, quota._replace(transcript_size=1),
                                          now=minute * 60)
            self.assertEqual(actions, ())

        state, _ = watch.decide(None, stuck, now=0)
        for minute in (5, 30):
            state, actions = watch.decide(state, stuck._replace(status='inactive'),
                                          now=minute * 60)
            self.assertEqual(actions, ())

    def test_codex_capacity_with_text_in_the_input_box_only_notifies(self):
        watch, stuck = self.capacity_screen(input_text='half typed reply')
        state, actions = watch.decide(None, stuck, now=0)
        self.assertEqual([a.kind for a in actions], ['notify-orchestrator'])
        self.assertIn('input box has text', actions[0].message)
        _, emptied = self.capacity_screen()
        for minute in (1, 5, 10):
            state, actions = watch.decide(state, emptied, now=minute * 60)
            self.assertEqual(actions, ())

    def test_capacity_continue_is_not_sent_for_other_clients_or_closed_agents(self):
        watch, stuck = self.capacity_screen()
        for changes in ({'client': 'claude'}, {'status': 'inactive'}):
            with self.subTest(changes=changes):
                _, actions = watch.decide(None, stuck._replace(**changes), now=0)
                self.assertNotIn('capacity-continue', [a.kind for a in actions])

    def test_capacity_continue_types_continue_and_enter_and_rolls_back_on_failure(self):
        watch = load_watch()
        action = watch.Action('capacity-continue', 'worker-open', text='Continue')
        with patch.dict(os.environ, self.env):
            self.assertEqual(watch.perform(action, 'orch'), {'delivery': 'terminal'})
        # The transcript length goes to spawn-watch with the Continue (see continued.json).
        self.assertEqual(self.hcom_log.read_text().splitlines(),
                         ['list worker-open --json --name orch',
                          'term inject worker-open Continue --enter --name orch'])

        _, stuck = self.capacity_screen()
        state, _ = watch.decide(None, stuck, now=0)
        watch.roll_back(action, state)
        _, actions = watch.decide(state, stuck, now=60)
        self.assertEqual([a.kind for a in actions], ['capacity-continue'])

        # A failed notice after the Continue retries the notice, never a second Continue.
        state, _ = watch.decide(state, stuck, now=60)
        for now in (6 * 60, 30 * 60):
            state, actions = watch.decide(state, stuck, now=now)
            self.assertEqual(actions[0].kind, 'notify-orchestrator')
            watch.roll_back(actions[0], state)
            state, actions = watch.decide(state, stuck, now=now + 60)
            self.assertEqual([a.kind for a in actions], ['notify-orchestrator'])
            self.assertIn('Continue was sent', actions[0].message)

    def capacity_marker(self, **changes):
        """Write spawn-watch's coverage record for worker-open, naming this process."""
        marker = Path(os.environ['XDG_STATE_HOME']) / 'hcom-spawn/capacity/worker-open.json'
        marker.parent.mkdir(parents=True, exist_ok=True)
        start = int(Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19])
        marker.write_text(json.dumps({'agent': 'worker-open', 'pid': os.getpid(),
                                      'start': start, **changes}))
        self.addCleanup(marker.unlink, missing_ok=True)
        return marker

    def test_capacity_covered_by_spawn_watch_gets_no_continue_or_5_minute_notice(self):
        self.capacity_marker()
        for input_text in ('', 'half typed reply'):
            with self.subTest(input_text=input_text):
                watch, stuck = self.capacity_screen(input_text)
                self.assertTrue(stuck.capacity_covered)
                state, actions = watch.decide(None, stuck, now=0)
                self.assertEqual((actions, state['decision']), ((), 'capacity-covered'))
                for minute in (5, 6, 19):
                    state, actions = watch.decide(state, stuck, now=minute * 60)
                    self.assertEqual(actions, ())
                # The 20-minute repeat to the orchestrator is unchanged.
                state, actions = watch.decide(state, stuck, now=20 * 60)
                self.assertEqual(actions[0].kind, 'notify-orchestrator')
                self.assertIn('Still on screen', actions[0].message)
                self.assertIn('spawn-watch handles Continue', actions[0].message)

    def test_coverage_after_lat_watch_typed_continue_leaves_the_notice_to_spawn_watch(self):
        watch, stuck = self.capacity_screen()
        state, actions = watch.decide(None, stuck, now=0)
        self.assertEqual([a.kind for a in actions], ['capacity-continue'])
        covered = stuck._replace(capacity_covered=True, transcript_size=1)
        for minute in (5, 6, 19):
            state, actions = watch.decide(state, covered, now=minute * 60)
            self.assertEqual(actions, ())

    def test_capacity_marker_counts_only_while_its_spawn_watch_runs(self):
        for marker in ({'start': -1}, {'pid': 2 ** 22 + 1}, None):
            with self.subTest(marker=marker):
                path = self.capacity_marker(**(marker or {}))
                if marker is None:
                    path.write_text('not json')
                _, stuck = self.capacity_screen()
                self.assertFalse(stuck.capacity_covered)

    @unittest.skipUnless(SPAWN_WATCH.exists(), 'hcom-spawn is not next to lat')
    def test_covered_agent_gets_one_continue_and_one_notice_across_both_watchers(self):
        spec = importlib.util.spec_from_file_location('spawn_watch', SPAWN_WATCH)
        spawn = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(spawn)
        transcript = self.work / 'codex.jsonl'
        transcript.write_text('{"type": "session_meta", "payload": {}}\n')
        now, injected, sent = [0], [], []

        def hcom(*args, timeout=30):
            if args[0] == 'list':
                return 0, json.dumps({'status': 'listening', 'transcript_path': str(transcript)})
            if args[:2] == ('term', 'inject'):
                injected.append(args)
                return 0, ''
            if args[0] == 'term':
                return 0, json.dumps({'lines': self.CAPACITY_LINES, 'ready': True,
                                      'prompt_empty': True, 'input_text': ''})
            sent.append(args[-1])
            return 0, ''
        spawn.hcom, spawn.clock = hcom, lambda: now[0]
        self.addCleanup(spawn.release, 'worker-open', 'worker-open')
        lat_typed = []
        watch = load_watch()

        def lat_cycle(state, minute, perform=True):
            """One lat-watch cycle; returns (state, actions decided, actions not yet done)."""
            now[0] = minute * 60
            _, stuck = self.capacity_screen()
            state, actions = watch.decide(state, stuck, now=minute * 60)
            continues = [a for a in actions if a.kind == 'capacity-continue']
            if perform:
                for action in continues:
                    watch.perform(action, 'orch')
                continues = []
            return state, list(actions), continues

        # covered: spawn-watch covers before the error; lat_first: lat-watch types Continue
        # at minute 0 and spawn-watch covers at minute 2; lat_paused: lat-watch decides at
        # minute 0, spawn-watch covers and types, then lat-watch performs its decision.
        for order in ('covered', 'lat_first', 'lat_paused'):
            with self.subTest(order=order), \
                    patch('time.time', lambda: 1_000_000 + now[0]), \
                    patch.object(watch, 'perform_nudge',
                                 lambda action, *_: lat_typed.append(action) or {}), \
                    patch.object(watch, 'transcript_now',
                                 lambda *_: (str(transcript), transcript.stat().st_size)):
                spawn.release('worker-open', 'worker-open')
                injected.clear()
                sent.clear()
                lat_typed.clear()
                state, lat_actions, first = None, [], 0
                if order == 'lat_first':
                    state, lat_actions, _ = lat_cycle(None, 0)
                    first = 2
                    now[0] = first * 60
                if order == 'lat_paused':
                    state, lat_actions, queued = lat_cycle(None, 0, perform=False)
                    spawn.mark_covered('worker-open')
                    spawn.capacity_step('worker-open', 'worker-open', 'orch')
                    for action in queued:
                        self.assertEqual(watch.perform(action, 'orch')['delivery'], 'skipped')
                else:
                    spawn.mark_covered('worker-open')
                notices_at = []
                for minute in range(first, 31):
                    now[0] = minute * 60
                    before = len(sent)
                    spawn.capacity_step('worker-open', 'worker-open', 'orch')
                    if any('Continue was sent' in text for text in sent[before:]):
                        notices_at.append(minute)
                    state, actions, _ = lat_cycle(state, minute)
                    lat_actions += actions
                    # The 20-minute repeats ("Still on screen") are not 5-minute notices.
                    if any('Continue was sent' in a.message and 'Still on screen' not in a.message
                           for a in actions):
                        notices_at.append(minute)
                self.assertEqual(len(injected) + len(lat_typed), 1)
                self.assertEqual(notices_at, [5])

        # Once spawn-watch no longer covers it, lat-watch types Continue itself.
        spawn.release('worker-open', 'worker-open')
        _, stuck = self.capacity_screen()
        _, actions = watch.decide(None, stuck, now=0)
        self.assertEqual([a.kind for a in actions], ['capacity-continue'])

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

    def popup_with_tab(self, tab_label):
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
            f'  tab) printf \'%s\\n\' \'{{"result":{{"tab":{{"label":"{tab_label}",'
            '"workspace_id":"w1"}}}\';;\n'
            '  workspace) printf \'%s\\n\' \'{"result":{"workspace":{"label":"LAT"}}}\';;\n'
            'esac\n'
        )
        herdr.chmod(0o755)

        with patch.dict(os.environ, self.env):
            watch.perform(watch.Action('notify-user', 'orch', 'long detail',
                                       category='quota', label='額度不足'), 'orch')
        return self.herdr_log.read_text().splitlines()[-1]

    def test_user_popup_is_one_line_with_client_workspace_tab_and_agent(self):
        self.assertEqual(self.popup_with_tab('STUDY'),
                         'notification show claude額度不足: LAT STUDY orch --sound request')

    def test_user_popup_leaves_out_a_tab_named_after_the_agent(self):
        self.assertEqual(self.popup_with_tab('lat-ORCH'),
                         'notification show claude額度不足: LAT orch --sound request')

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

        result, = [record['action_results'][0] for record in self.watch_records()
                   if record['at'] == 1_200 and record.get('action_results')]
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
            'agent': 'orch', 'target': 'someone-else', 'kind': 'agent',
            'targets': [{'target': 'someone-else', 'kind': 'agent'},
                        {'target': 'worker-wait', 'kind': 'agent'}],
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

        self.assertEqual(json.loads(wait_file.read_text()), {**declaration, 'kind': 'decision'})
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
            'expiry_count': 2, 'expiry_notified': True,
            'released_reason': 'expired',
        }
        watch.write_object(watch.wait_path(self.work, 'worker-open'), declaration)

        with patch.dict(os.environ, self.env):
            reason = watch.release_wait_if_needed(
                self.work, decisions, 'orch', declaration)

        self.assertEqual(reason, 'message-delivered')
        saved = json.loads(watch.wait_path(self.work, 'worker-open').read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['released_reason'], 'message-delivered')
        self.assertEqual(saved['expiry_count'], 0)
        self.assertFalse(saved['expiry_notified'])
        declaration['active'] = False
        watch.write_object(watch.wait_path(self.work, 'worker-open'), declaration)
        with patch.dict(os.environ, self.env):
            reason = watch.release_wait_if_needed(self.work, decisions, 'orch', declaration)
        self.assertEqual(reason, 'message-delivered')
        self.assertEqual(json.loads(watch.wait_path(self.work, 'worker-open').read_text())
                         ['expiry_count'], 0)

    def test_unrelated_inform_leaves_wait_active_and_request_releases_it(self):
        hcom = Path(self.env['PATH'].split(':', 1)[0]) / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'case " $* " in\n'
            '  *" list --json "*)\n'
            '    printf \'%s\\n\' \'[{"name":"worker-open","base_name":"open",'
            '"session_id":"worker-session"}]\' ;;\n'
            '  *"--type message"*)\n'
            '    printf \'%s\\n\' "{\\"id\\":89,\\"type\\":\\"message\\",'
            '\\"data\\":{\\"from\\":\\"$FAKE_FROM\\",\\"delivered_to\\":[\\"open\\"],'
            '\\"intent\\":\\"$FAKE_INTENT\\"}}";'
            '    printf \'%s\\n\' \'{"id":90,"type":"message","data":{"from":"b",'
            '"delivered_to":["open"],"intent":"inform"}}\' ;;\n'
            '  *"worker-session"*)\n'
            '    printf \'%s\\n\' \'{"id":91,"type":"status","data":{'
            '"context":"deliver:stranger","position":90,"session":"worker-session"}}\' ;;\n'
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
        # Sender 'reviewer' is the wait target; 'a' is someone else.
        for sender, intent, expected in (
                ('a', 'inform', None), ('a', 'ack', None), ('a', 'request', 'message-delivered'),
                ('reviewer', 'inform', None), ('reviewer', 'ack', None),
                ('reviewer', 'request', 'message-delivered')):
            watch.write_object(watch.wait_path(self.work, 'worker-open'), declaration)
            with patch.dict(os.environ, {**self.env, 'FAKE_INTENT': intent,
                                         'FAKE_FROM': sender}):
                reason = watch.release_wait_if_needed(
                    self.work, decisions, 'orch', declaration)
            self.assertEqual(reason, expected, (sender, intent))
            saved = json.loads(watch.wait_path(self.work, 'worker-open').read_text())
            self.assertEqual(saved['active'], expected is None)

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
        # First missing cycle and the notice; the cycle in between writes nothing.
        self.assertEqual(len([record for record in records
                              if record.get('decision') == 'agent-disappeared']), 2)
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
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks, ledger=None,
                                  decisions=decisions, orchestrator='orch')
        stop = RuntimeError('stop test loop')

        with patch.object(watch, 'run_cycle', return_value=None) as cycle, \
                patch.object(watch.time, 'sleep', side_effect=[None, stop]) as sleeper:
            with self.assertRaisesRegex(RuntimeError, 'stop test loop'):
                watch.run_forever(args)

        self.assertEqual(cycle.call_count, 2)
        self.assertEqual(sleeper.call_args_list,
                         [unittest.mock.call(60), unittest.mock.call(60)])


    def fake_reaper(self, body='exit 0'):
        """A stand-in reap command that logs its arguments; never the real reaper."""
        calls = self.root / 'reap.log'
        reaper = self.root / 'fake-reap'
        reaper.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{calls}"\n{body}\n')
        reaper.chmod(0o755)
        return calls, {'LAT_REAP_COMMAND': str(reaper)}

    def test_default_reap_command_is_the_reaper_beside_the_running_watcher(self):
        watch = load_watch()
        environment = {key: value for key, value in os.environ.items()
                       if key != 'LAT_REAP_COMMAND'}
        with patch.dict(os.environ, environment, clear=True):
            command = watch.reap_command('reap', '--trigger', 'periodic')
        self.assertEqual(command, [sys.executable, str(SCRIPT.with_name('lat-reap.py')),
                                   'reap', '--trigger', 'periodic'])

    def test_every_cycle_runs_one_periodic_reap(self):
        watch = load_watch()
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks, ledger=None,
                                  decisions=decisions, orchestrator='orch')
        calls, environment = self.fake_reaper()
        stop = RuntimeError('stop test loop')

        with patch.dict(os.environ, environment), \
                patch.object(watch, 'run_cycle', return_value=None) as cycle, \
                patch.object(watch.time, 'sleep', side_effect=[None, None, stop]):
            with self.assertRaisesRegex(RuntimeError, 'stop test loop'):
                watch.run_forever(args)

        self.assertEqual(cycle.call_count, 3)
        self.assertEqual(calls.read_text().splitlines(), ['reap --trigger periodic'] * 3)

    def test_failed_or_slow_reap_is_logged_and_watching_continues(self):
        self.listing_hcom(orch='listening', worker_open='listening')
        watch = load_watch()
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks, ledger=None,
                                  decisions=decisions, orchestrator='orch')
        calls, environment = self.fake_reaper(
            'test -e "$0.slow" && exec sleep 5\ntouch "$0.slow"\n'
            'echo "Nothing closed: HCOM list unreadable"; exit 1')
        stop = RuntimeError('stop test loop')

        with patch.dict(os.environ, {**self.env, **environment}), patch('sys.stderr'), \
                patch.object(watch, 'REAP_TIMEOUT_SECONDS', 0.5), \
                patch.object(watch.time, 'sleep', side_effect=[None, stop]) as sleeper:
            with self.assertRaisesRegex(RuntimeError, 'stop test loop'):
                watch.run_forever(args)

        self.assertEqual(len(calls.read_text().splitlines()), 2)
        self.assertEqual(sleeper.call_args_list,
                         [unittest.mock.call(60), unittest.mock.call(60)])
        failed = [record for record in self.watch_records()
                  if record.get('decision') == 'reap-failed']
        self.assertEqual(len(failed), 2)
        self.assertIn('Nothing closed: HCOM list unreadable', failed[0]['error'])
        self.assertIn('timed out', failed[1]['error'])
        self.assertFalse(any(record.get('decision') == 'cycle-failed'
                             for record in self.watch_records()))
        self.assertIn('worker-open', self.watch_state())

    def test_failed_cycles_are_logged_rate_limited_and_the_loop_continues(self):
        watch = load_watch()
        decisions = self.work / '.lat/decisions'
        decisions.mkdir()
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks, ledger=None,
                                  decisions=decisions, orchestrator='orch')
        failures = [ValueError('hcom failed: busy'), ValueError('hcom failed: busy'),
                    ValueError('hcom failed: busy'), OSError('disk'), None,
                    ValueError('hcom failed: busy')]
        clock = iter([0, 60, 3600, 3660, 3720, 3780])

        def cycle(*_, **__):
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
        args = argparse.Namespace(workspace=self.work, tasks=self.tasks, ledger=None,
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
            'orch': {'last_seen_status': 'listening', 'last_seen_at': 0,
                     'feature_versions': {'wait_deadline': 2, 'alarm': 1, 'cache_keepalive': 5, 'claude_quota_resume': 1, 'ledger_due': 1, 'screen_errors': 1, 'capacity_continue': 1, 'wait_targets': 1}},
            'worker-open': {'last_seen_status': 'listening', 'last_seen_at': 0},
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
            'orch': {'last_seen_status': 'listening', 'last_seen_at': 0,
                     'feature_versions': {'wait_deadline': 2, 'alarm': 1, 'cache_keepalive': 5, 'claude_quota_resume': 1, 'ledger_due': 1, 'screen_errors': 1, 'capacity_continue': 1, 'wait_targets': 1}},
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

        def observe(workspace, decisions, orchestrator, agent, info, card=None, *, processes):
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

    def test_command_timeout_names_the_command(self):
        watch = load_watch()
        timeout = subprocess.TimeoutExpired(['hcom', 'term'], watch.COMMAND_TIMEOUT_SECONDS)
        with patch.object(watch.subprocess, 'run', side_effect=timeout) as run:
            with self.assertRaisesRegex(ValueError, r'hcom term .*timed out after 30 seconds'):
                watch.run_command(['hcom', 'term', 'worker-open', '--json'])
        self.assertEqual(run.call_args.kwargs['timeout'], 30)

    def test_cycle_logs_observation_timeout_and_keeps_observing_others(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        real_run = subprocess.run
        commands = []

        def run(command, **kwargs):
            commands.append((command, kwargs))
            if command[:3] == ['hcom', 'term', 'orch']:
                raise subprocess.TimeoutExpired(command, kwargs['timeout'])
            return real_run(command, **kwargs)

        with patch.object(watch.subprocess, 'run', side_effect=run):
            self.run_cycles(watch, 0)

        self.assertTrue(commands)
        for command, kwargs in commands:
            self.assertEqual(kwargs.get('timeout'), watch.COMMAND_TIMEOUT_SECONDS, command)
        records = self.watch_records()
        failed = [record for record in records if record.get('decision') == 'observation-failed']
        self.assertEqual([record['agent'] for record in failed], ['orch'])
        self.assertIn('hcom term timed out after 30 seconds', failed[0]['error'])
        self.assertEqual([record['agent'] for record in records if 'observation' in record],
                         ['worker-open'])

    def test_cycle_reads_processes_once_for_all_agents(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        with patch.object(watch, 'read_processes', return_value=[]) as read_processes:
            self.run_cycles(watch, 0)
        self.assertEqual(read_processes.call_count, 1)
        self.assertEqual([record['agent'] for record in self.watch_records()
                          if 'observation' in record], ['orch', 'worker-open'])

    def test_wait_holds_lock_from_read_to_write(self):
        self.wait_session()
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        real_write = watch.write_object
        paused, resume = threading.Event(), threading.Event()
        order, errors = [], []

        def write(target, value, **kwargs):
            if threading.current_thread() is declaring and target == path:
                paused.set()
                resume.wait(10)
                order.append('wait-written')
            return real_write(target, value, **kwargs)

        def declare():
            try:
                with patch.dict(os.environ, self.env):
                    watch.declare_wait(argparse.Namespace(
                        workspace=self.work, agent='worker-open', target='reviewer',
                        reason='review', minutes=None))
            except Exception as error:  # surfaced through the assertion below
                errors.append(error)

        def monitor():
            with watch.wait_lock(path):
                order.append('monitor-locked')
                real_write(path, {'agent': 'worker-open', 'monitor': True})

        declaring = threading.Thread(target=declare)
        competing = threading.Thread(target=monitor)
        with patch.object(watch, 'write_object', side_effect=write):
            declaring.start()
            self.assertTrue(paused.wait(10))
            competing.start()
            competing.join(0.3)
            self.assertTrue(competing.is_alive())
            resume.set()
            declaring.join(10)
            competing.join(10)

        self.assertEqual(errors, [])
        self.assertEqual(order, ['wait-written', 'monitor-locked'])
        self.assertEqual(json.loads(path.read_text()), {'agent': 'worker-open', 'monitor': True})

    def assert_wait_lock_available_during_command(self, path, command):
        # A fresh descriptor in another thread bypasses wait_lock's reentrancy.
        results = []

        def probe():
            try:
                with path.with_name(f'.{path.stem}.lock').open('a') as lock:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(lock, fcntl.LOCK_UN)
                results.append('acquired')
            except OSError as error:
                results.append(error)

        competing = threading.Thread(target=probe)
        competing.start()
        competing.join(10)
        self.assertFalse(competing.is_alive(), command)
        self.assertEqual(results, ['acquired'], command)

    def test_expired_wait_unlocks_before_observing_target_command(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = watch.wait_path(self.work, 'orch')
        watch.write_object(path, dict(
            agent='orch', kind='agent', target='worker-open', active=True,
            declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00', deadline_at=60))
        real_run = watch.run_command
        intercepted = []

        def run(command, **kwargs):
            if command[:3] == ['hcom', 'term', 'worker-open']:
                intercepted.append(command[:3])
                self.assert_wait_lock_available_during_command(path, command)
            return real_run(command, **kwargs)

        with patch.object(watch, 'run_command', side_effect=run):
            self.run_cycles(watch, 60)

        self.assertEqual(intercepted, [['hcom', 'term', 'worker-open']])
        self.assertTrue(json.loads(path.read_text())['deadline_extended'])

    def test_wait_release_unlocks_before_reading_hcom_events(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, dict(
            agent='worker-open', kind='agent', target='absent', active=True,
            declared_at=0, declared_at_utc='1970-01-01T00:00:00+00:00', deadline_at=3600))
        real_run = watch.run_command
        intercepted = []

        def run(command, **kwargs):
            if command[:2] == ['hcom', 'events'] and '--after' in command:
                intercepted.append(command[:2])
                self.assert_wait_lock_available_during_command(path, command)
            return real_run(command, **kwargs)

        with patch.object(watch, 'run_command', side_effect=run):
            self.run_cycles(watch, 0)

        self.assertEqual(intercepted, [['hcom', 'events']])
        self.assertEqual(json.loads(path.read_text())['released_reason'], 'message-delivered')

    def test_alarm_delivery_unlocks_before_hcom_and_herdr_commands(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch, agent='orch')
        # A busy prompt makes the normal deadline path notify the user.
        Path(str(self.hcom_log) + '.busy').touch()
        real_run = watch.run_command
        intercepted = []

        def run(command, **kwargs):
            if (command[:2] == ['hcom', 'send']
                    or command[:3] == ['herdr', 'notification', 'show']):
                intercepted.append(command[:2])
                self.assert_wait_lock_available_during_command(path, command)
            return real_run(command, **kwargs)

        with patch.object(watch, 'run_command', side_effect=run):
            self.run_cycles(watch, 660)

        self.assertEqual(intercepted, [['hcom', 'send'], ['herdr', 'notification']])
        self.assertTrue(json.loads(path.read_text())['alarm_notified'])

    def test_alarm_write_back_after_external_command_detects_change(self):
        watch = load_watch()
        path = watch.wait_path(self.work, 'worker-open')
        watch.write_object(path, {'agent': 'worker-open', 'kind': 'alarm', 'active': True})
        declaration, original = watch.read_wait(path)

        def perform(action, orchestrator, workspace):
            # The agent replaces its declaration while the notice command runs.
            with watch.wait_lock(path):
                watch.write_object(path, {'agent': 'worker-open', 'kind': 'alarm', 'new': True})
            return {}

        action = watch.Action('notify-orchestrator', 'worker-open', 'alarm', category='alarm-notice')
        with patch.object(watch, 'perform', side_effect=perform):
            with self.assertRaisesRegex(ValueError, 'Concurrent change detected'):
                watch.deliver_alarm_notice(action, declaration, path, original, 'orch', self.work)
        self.assertEqual(json.loads(path.read_text())['new'], True)

    def test_cycle_holds_wait_lock_from_read_to_write(self):
        self.alarm_cycle_environment()
        watch = load_watch()
        path = self.save_alarm(watch)
        real_decide = watch.decide_alarm
        real_write = watch.write_object
        blocked = []

        def replace():
            with watch.wait_lock(path):
                real_write(path, {'agent': 'worker-open', 'kind': 'alarm', 'replaced': True})

        competing = threading.Thread(target=replace)

        def decide_alarm(*args):
            competing.start()
            competing.join(0.3)
            blocked.append(competing.is_alive())
            return real_decide(*args)

        with patch.object(watch, 'decide_alarm', side_effect=decide_alarm):
            self.run_cycles(watch, 0)
        competing.join(10)

        self.assertEqual(blocked, [True])
        self.assertFalse([record for record in self.watch_records()
                          if record.get('decision') == 'observation-failed'])
        self.assertTrue(json.loads(path.read_text())['replaced'])


# Prompt-cache keep-alive (temp usage dir, pinned Asia/Taipei time zone).
def taipei(hour, minute=0, second=0):
    return datetime(2026, 10, 22, hour, minute, second, tzinfo=TAIPEI).timestamp()


class PinnedEnvironment(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.usage = self.root / 'usage'
        self.usage.mkdir()
        environment = patch.dict(os.environ, {'LAT_USAGE_DIR': str(self.usage),
                                              'TZ': 'Asia/Taipei',
                                              'LAT_HCOM_PAUSED_DIR': str(self.root / 'paused')})
        environment.start()
        self.addCleanup(time.tzset)
        self.addCleanup(environment.stop)
        time.tzset()

    def write_usage(self, expires_at, session='claude-session', warm=True):
        (self.usage / f'{session}.json').write_text(json.dumps({
            'session_id': session, 'observed_at': expires_at - 3600,
            'prompt_cache': {'caching_observed': True, 'warm': warm, 'hit_ratio': 0.9,
                             'expires_at': expires_at}}))


class KeepaliveDecisionTests(PinnedEnvironment):
    def setUp(self):
        super().setUp()
        self.watch = load_watch()
        self.idle = self.watch.Observation('worker', 'listening', True, False, 10, 10, 1,
                                           wait_active=True, client='claude',
                                           terminal_ready=True, is_orchestrator=True)
        self.info = {'session_id': 'claude-session'}

    def check(self, declaration, now, observation=None, state=None, info=None, busy=False):
        return self.watch.keepalive_due(declaration, observation or self.idle,
                                        self.info if info is None else info, state or {}, now,
                                        busy=busy)

    def due(self, *args, **fields):
        """The expiry a keep-alive is typed for, or None when it is skipped or not due."""
        expires_at, reason = self.check(*args, **fields)
        return None if reason else expires_at

    def agent_wait(self, **fields):
        return {**dict(agent='worker', kind='agent', target='reviewer', active=True,
                       declared_at=taipei(10), deadline_at=taipei(10) + 3000), **fields}

    def test_agent_wait_with_four_minutes_left_is_kept_warm_once_per_expiry(self):
        now = taipei(10, 30)
        self.write_usage(now + 240)
        self.assertEqual(self.due(self.agent_wait(), now), now + 240)
        sent = {'keepalive': {'expires_at': now + 240}}
        self.assertIsNone(self.due(self.agent_wait(), now + 60, state=sent))
        self.write_usage(now + 3900)
        self.assertEqual(self.due(self.agent_wait(), now + 3700, state=sent), now + 3900)

    def test_subordinate_is_ineligible_for_every_wait_kind_even_without_usage(self):
        now = taipei(10, 30)
        self.write_usage(now + 240)
        for kind in ('agent', 'decision', 'alarm'):
            for info in (self.info, {}):
                with self.subTest(kind=kind, info=info):
                    self.assertEqual(self.check(self.agent_wait(kind=kind), now,
                                                self.idle._replace(is_orchestrator=False),
                                                info=info), (None, None))

    def test_threshold_is_ten_minutes_and_expired_cache_is_given_up(self):
        now = taipei(10, 30)
        for remaining, expected in ((601, False), (600, True), (301, True), (1, True), (0, False),
                                    (-60, False)):
            with self.subTest(remaining=remaining):
                self.write_usage(now + remaining)
                self.assertEqual(self.due(self.agent_wait(), now) is not None, expected)

    def test_alarm_wait_is_kept_warm(self):
        now = taipei(3)
        self.write_usage(now + 120)
        alarm = dict(agent='worker', kind='alarm', active=True, declared_at=now - 3600,
                     due_at=now + 1800, condition={'kind': 'time', 'minutes': 90})
        # Agent waits are not limited by the quiet hours; alarms are (see the alarm tests below).
        self.assertIsNone(self.due(alarm, now))
        self.write_usage(taipei(10) + 120)
        self.assertEqual(self.due(dict(alarm, declared_at=taipei(10) - 3600), taipei(10)),
                         taipei(10) + 120)
        self.write_usage(now + 120)
        self.assertEqual(self.due(self.agent_wait(declared_at=now - 5 * 3600), now), now + 120)

    def test_decision_wait_stops_after_three_hours(self):
        declared = taipei(10)
        decision = dict(agent='worker', kind='decision', target='HELP-1', active=True,
                        declared_at=declared)
        for elapsed, expected in ((3 * 3600 - 1, True), (3 * 3600, False), (5 * 3600, False)):
            with self.subTest(elapsed=elapsed):
                self.write_usage(declared + elapsed + 120)
                self.assertEqual(self.due(decision, declared + elapsed) is not None, expected)

    def test_decision_wait_is_quiet_from_one_to_nine_local_time(self):
        cases = [(taipei(0, 59), True), (taipei(1), False), (taipei(4, 30), False),
                 (taipei(8, 59), False), (taipei(9), True)]
        for now, expected in cases:
            with self.subTest(hour=datetime.fromtimestamp(now, TAIPEI).strftime('%H:%M')):
                decision = dict(agent='worker', kind='decision', target='HELP-1', active=True,
                                declared_at=now - 3600)
                self.write_usage(now + 120)
                self.assertEqual(self.due(decision, now) is not None, expected)
        # 09:00 resumes only inside the three-hour limit.
        late = dict(agent='worker', kind='decision', target='HELP-1', active=True,
                    declared_at=taipei(5, 59))
        self.write_usage(taipei(9) + 120)
        self.assertIsNone(self.due(late, taipei(9)))

    def test_quiet_hours_follow_host_local_time_zone(self):
        now = taipei(4)  # 20:00 UTC the previous day
        decision = dict(agent='worker', kind='decision', target='HELP-1', active=True,
                        declared_at=now - 60)
        self.write_usage(now + 120)
        self.assertIsNone(self.due(decision, now))
        try:
            with patch.dict(os.environ, {'TZ': 'UTC'}):
                time.tzset()
                self.assertEqual(self.due(decision, now), now + 120)
        finally:
            time.tzset()

    def test_no_keepalive_without_a_valid_wait_or_ready_claude_prompt(self):
        now = taipei(10, 30)
        self.write_usage(now + 240)
        wait = self.agent_wait()
        cases = {
            'no declaration': (None, self.idle, self.info),
            'released wait': (dict(wait, active=False, released_reason='expired'),
                              self.idle, self.info),
            'codex agent': (wait, self.idle._replace(client='codex', codex_turn_finished=True),
                            self.info),
            'turn not ended': (wait, self.idle._replace(status='active'), self.info),
            'working screen': (wait, self.idle._replace(screen_working=True), self.info),
            'prompt has text': (wait, self.idle._replace(prompt_empty=False, input_text='x'),
                                self.info),
            'no session id': (wait, self.idle, {}),
            'unsafe session id': (wait, self.idle, {'session_id': '../claude-session'}),
            'unknown session': (wait, self.idle, {'session_id': 'other-session'}),
        }
        for name, (declaration, observation, info) in cases.items():
            with self.subTest(name):
                self.assertIsNone(self.due(declaration, now, observation, info=info))

    def test_missing_corrupt_or_cold_usage_file_sends_nothing(self):
        now = taipei(10, 30)
        path = self.usage / 'claude-session.json'
        cases = {
            'missing': None,
            'corrupt': '{"prompt_cache": ',
            'not an object': '[]',
            'no cache': json.dumps({'session_id': 'claude-session'}),
            'warm false': json.dumps({'prompt_cache': {'warm': False, 'expires_at': now + 60}}),
            'warm missing': json.dumps({'prompt_cache': {'expires_at': now + 60}}),
            'expiry text': json.dumps({'prompt_cache': {'warm': True, 'expires_at': '1'}}),
            'expiry bool': json.dumps({'prompt_cache': {'warm': True, 'expires_at': True}}),
        }
        for name, content in cases.items():
            with self.subTest(name):
                path.unlink(missing_ok=True)
                if content is not None:
                    path.write_text(content)
                self.assertIsNone(self.due(self.agent_wait(), now))

    def test_usage_directory_resolution_matches_the_status_line_recorder(self):
        cases = [
            ({'LAT_USAGE_DIR': '/custom/usage', 'XDG_STATE_HOME': '/state'}, '/custom/usage'),
            ({'LAT_USAGE_DIR': '', 'XDG_STATE_HOME': '/state'}, '/state/lat/usage'),
            ({'XDG_STATE_HOME': 'relative'}, str(Path.home() / '.local/state/lat/usage')),
            ({}, str(Path.home() / '.local/state/lat/usage')),
        ]
        for environment, expected in cases:
            with self.subTest(environment=environment):
                with patch.dict(os.environ, environment):
                    for name in {'LAT_USAGE_DIR', 'XDG_STATE_HOME'} - environment.keys():
                        os.environ.pop(name, None)
                    self.assertEqual(str(self.watch.usage_dir()), expected)

    def test_keepalive_reply_is_not_progress(self):
        watch = self.watch
        observation = self.idle._replace(transcript_size=0)
        state, _ = watch.decide(None, observation, 0)
        state['keepalive'] = {'expires_at': 300, 'fingerprint': state['fingerprint'],
                              'sent_at': 60}
        transcript = self.root / 'transcript.jsonl'
        transcript.write_text(
            json.dumps({'type': 'user', 'message': {'role': 'user', 'content': watch.KEEPALIVE}})
            + '\n' + json.dumps({'type': 'assistant', 'message': {
                'role': 'assistant', 'content': [{'type': 'text', 'text': 'Still waiting.'}]}})
            + '\n')
        observed = observation._replace(transcript_size=transcript.stat().st_size,
                                        transcript_mtime_ns=99)
        observed = watch.nudge_only_observation(state, observed,
                                                {'transcript_path': str(transcript)}, 'orch')
        self.assertTrue(observed.keepalive_only)
        # Claude writes extended thinking as its own content blocks before the short reply.
        for thinking in ({'type': 'thinking', 'thinking': 'y' * 500, 'signature': 'sig'},
                         {'type': 'redacted_thinking', 'data': 'opaque'}):
            with self.subTest(thinking=thinking['type']):
                with transcript.open('a') as stream:
                    stream.write(json.dumps({'type': 'assistant', 'message': {
                        'role': 'assistant', 'content': [thinking]}}) + '\n')
                    stream.write(json.dumps({'type': 'assistant', 'message': {
                        'role': 'assistant', 'content': [thinking, {
                            'type': 'text', 'text': 'Waiting.'}]}}) + '\n')
                observed = observed._replace(transcript_size=transcript.stat().st_size,
                                             keepalive_only=False)
                self.assertTrue(watch.nudge_only_observation(
                    state, observed, {'transcript_path': str(transcript)},
                    'orch').keepalive_only)
        saved, _ = watch.decide(state, observed._replace(keepalive_only=True), 120)
        self.assertEqual(saved['last_progress_at'], 0)
        # Real work after the keep-alive is progress again.
        with transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'assistant', 'message': {'role': 'assistant',
                         'content': [{'type': 'tool_use', 'name': 'Edit', 'input': {}}]}}) + '\n')
        later = observed._replace(transcript_size=transcript.stat().st_size,
                                  transcript_mtime_ns=100, keepalive_only=False)
        later = watch.nudge_only_observation(saved, later,
                                             {'transcript_path': str(transcript)}, 'orch')
        self.assertFalse(later.keepalive_only)
        saved, _ = watch.decide(saved, later, 180)
        self.assertEqual(saved['last_progress_at'], 180)


class KeepaliveCycleTests(PinnedEnvironment):
    """run_cycle with a fake hcom: one Claude orchestrator and one task agent at an empty ready prompt."""

    def setUp(self):
        super().setUp()
        self.work = self.root / 'work'
        (self.work / '.git').mkdir(parents=True)
        self.tasks = self.work / '.lat/tasks'
        self.tasks.mkdir(parents=True)
        (self.tasks / 'open.md').write_text(
            '- agent：helper (Claude)\n- orchestrator：worker\n- status：in progress\n'
            '- live actions：無\n- preflight：無\n- next step：\n')
        self.decisions = self.work / '.lat/decisions'
        self.decisions.mkdir()
        self.transcript = self.root / 'transcript.jsonl'
        self.transcript.write_text('')
        self.hcom_log = self.root / 'hcom.log'
        self.hcom_log.write_text('')
        binary = self.root / 'bin'
        binary.mkdir()
        # Quota recovery must not consult the host account store in transport tests.
        cswap = binary / 'cswap'
        cswap.write_text('#!/bin/sh\nexit 1\n')
        cswap.chmod(0o755)
        agents = json.dumps([
            {'name': 'helper', 'status': 'listening', 'tool': 'claude'},
            {'name': 'worker', 'status': 'listening', 'tool': 'claude',
             'session_id': 'claude-session', 'transcript_path': str(self.transcript)}])
        hcom = binary / 'hcom'
        hcom.write_text(f'''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HCOM_LOG"
case "$1" in
list) if [ -f "$FAKE_HCOM_LOG.agents" ]; then cat "$FAKE_HCOM_LOG.agents";
      else printf '%s\\n' '{agents}'; fi;;
term) if [ "$2" = inject ]; then
        if [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi
      elif [ -f "$FAKE_HCOM_LOG.term" ]; then cat "$FAKE_HCOM_LOG.term"
      elif [ -f "$FAKE_HCOM_LOG.busy" ]; then
        printf '%s\\n' '{{"ready":true,"prompt_empty":false,"input_text":"draft","lines":[]}}'
      else printf '%s\\n' '{{"ready":true,"prompt_empty":true,"lines":[]}}'; fi;;
esac
''')
        hcom.chmod(0o755)
        environment = patch.dict(os.environ, {'PATH': f'{binary}:{os.environ["PATH"]}',
                                              'FAKE_HCOM_LOG': str(self.hcom_log)})
        environment.start()
        self.addCleanup(environment.stop)
        self.watch = load_watch()
        self.wait_file = self.watch.wait_path(self.work, 'worker')
        self.agents = json.loads(agents)
        self.start = taipei(10)

    def pause(self, agent):
        directory = self.root / 'paused'
        directory.mkdir(exist_ok=True)
        path = directory / f'{agent}-session.json'
        path.write_text(json.dumps(dict(session_id=f'{agent}-session', hcom_name=agent,
                                        client='claude', pane=None,
                                        paused_at='2026-10-23T00:00:00Z')))
        return path

    def test_paused_missing_agents_do_not_notify_or_stop_and_resume_next_cycle(self):
        paths = [self.pause(agent) for agent in ('worker', 'helper')]
        Path(f'{self.hcom_log}.agents').write_text('[]')
        self.declare(kind='alarm', due_at=self.start, expires_at=self.start + 60)
        for now in (self.start, self.start + 7200, self.start + 10800):
            self.assertIsNone(self.watch.run_cycle(
                self.work, self.tasks, self.decisions, 'worker', now=now))
        self.assertEqual(len(self.records('paused')), 2)
        self.assertNotIn('missing_since', self.state()['worker'])
        self.assertNotIn('missing_cycles', self.state()['helper'])
        self.assertEqual(self.records('agent-disappeared'), [])
        self.assertEqual(self.records('alarm-notified'), [])
        self.assertFalse(any(line.startswith(('term inject', 'send '))
                             for line in self.hcom_log.read_text().splitlines()))
        for path in paths:
            path.unlink()
        self.cycle(self.start + 10860, self.start + 10920)
        self.assertEqual(self.state()['helper']['missing_cycles'], 2)
        self.assertTrue(self.records('agent-disappeared'))
        self.assertTrue(self.records('alarm-notified'))
        self.assertIsNotNone(self.watch.run_cycle(
            self.work, self.tasks, self.decisions, 'worker', now=self.start + 14460))

    def test_paused_listed_agents_skip_due_nudges_and_alarm_then_resume(self):
        self.cycle(self.start)
        paths = [self.pause(agent) for agent in ('worker', 'helper')]
        self.declare(kind='alarm', due_at=self.start + 30, expires_at=self.start + 3600)
        self.cycle(self.start + 600, self.start + 900)
        self.assertEqual(self.injections(), [])
        self.assertEqual(self.records('alarm-ring'), [])
        self.assertFalse(any(line.startswith('term inject helper')
                             for line in self.hcom_log.read_text().splitlines()))
        for path in paths:
            path.unlink()
        self.cycle(self.start + 960)
        self.assertEqual(len(self.records('alarm-ring')), 1)
        self.assertTrue(any(line.startswith('term inject helper')
                            for line in self.hcom_log.read_text().splitlines()))
        self.pause('worker')
        self.cycle(self.start + 1020)
        self.assertEqual(len(self.records('paused')), 3)

    def test_pause_suppresses_keepalive_until_record_is_removed(self):
        path = self.pause('worker')
        self.declare(deadline_at=self.start + 3600)
        self.write_usage(self.start + 600)
        self.cycle(self.start, self.start + 60)
        self.assertEqual(self.injections(), [])
        path.unlink()
        self.cycle(self.start + 120)
        self.assertEqual(len(self.injections()), 1)
        self.assertIn('Prompt cache keep-alive', self.injections()[0])

    def test_invalid_pause_records_warn_once_without_aborting_cycle(self):
        directory = self.root / 'paused'
        directory.mkdir()
        (directory / 'broken.json').write_text('{')
        (directory / 'incomplete.json').write_text('{"hcom_name":"worker"}')
        self.cycle(self.start, self.start + 600)
        self.assertEqual(len(self.records('pause-record-invalid')), 2)
        self.assertEqual(len(self.injections()), 1)

    def show(self, status='listening', **terminal):
        """Make the worker report this HCOM status and hcom term result."""
        agents = [dict(agent) for agent in self.agents]
        agents[1]['status'] = status
        Path(f'{self.hcom_log}.agents').write_text(json.dumps(agents))
        Path(f'{self.hcom_log}.term').write_text(json.dumps(
            {'ready': True, 'prompt_empty': True, 'input_text': '', 'lines': [], **terminal}))

    def declare(self, **fields):
        self.watch.write_object(self.wait_file, {**dict(
            agent='worker', target='reviewer', reason='review', active=True,
            declared_at=self.start, declared_at_utc=datetime.fromtimestamp(
                self.start, timezone.utc).isoformat()), **fields})

    def cycle(self, *times):
        for now in times:
            self.watch.run_cycle(self.work, self.tasks, self.decisions, 'worker', now=now)

    def injections(self):
        return [line for line in self.hcom_log.read_text().splitlines()
                if line.startswith('term inject worker')]

    def records(self, decision='cache-keepalive'):
        path = self.work / '.lat/watch/worker/watch.jsonl'
        return [record for record in map(json.loads, path.read_text().splitlines())
                if record.get('decision') == decision]

    def state(self):
        return json.loads((self.work / '.lat/watch/worker/state.json').read_text())

    def reply_to_keepalive(self):
        with self.transcript.open('a') as stream:
            stream.write(json.dumps({'type': 'user', 'message': {
                'role': 'user', 'content': self.watch.KEEPALIVE}}) + '\n')
            stream.write(json.dumps({'type': 'assistant', 'message': {
                'role': 'assistant', 'content': [{'type': 'text', 'text': 'Waiting.'}]}}) + '\n')

    def test_agent_wait_keepalive_is_sent_once_and_reply_changes_nothing(self):
        self.start = taipei(10)
        self.declare(kind='agent', deadline_at=self.start + 3000)
        self.cycle(self.start)
        before = self.wait_file.read_bytes()
        self.write_usage(self.start + 1200 + 240)
        self.cycle(self.start + 1200, self.start + 1260)
        self.assertEqual(len(self.injections()), 1)
        self.assertIn(self.watch.KEEPALIVE, self.injections()[0])
        self.assertEqual([(r['agent'], r['kind'], r['expires_at'], r['result'])
                          for r in self.records()],
                         [('worker', 'agent', self.start + 1440, 'sent')])
        self.reply_to_keepalive()
        self.write_usage(self.start + 1320 + 3600)
        self.cycle(self.start + 1320, self.start + 1380)
        state = self.state()
        self.assertEqual(state['worker']['last_progress_at'], self.start)
        self.assertFalse(state['worker']['nudged'])
        self.assertEqual(state['worker']['decision'], 'valid-wait')
        self.assertEqual(self.wait_file.read_bytes(), before)
        self.assertEqual(state['worker']['feature_versions'],
                         {'wait_deadline': 2, 'alarm': 1, 'cache_keepalive': 5, 'claude_quota_resume': 1, 'ledger_due': 1, 'screen_errors': 1, 'capacity_continue': 1, 'wait_targets': 1})
        # The wait still expires at its original deadline, counted once, with the real
        # idle time, and the agent is nudged for the expiry rather than as a stall.
        self.cycle(self.start + 3000)
        saved = json.loads(self.wait_file.read_text())
        self.assertFalse(saved['active'])
        self.assertEqual(saved['expiry_count'], 1)
        self.assertEqual(len(self.injections()), 2)
        self.assertIn('expired after 50 minutes', self.injections()[1])
        self.assertFalse(any(line.startswith('send ') and 'agent worker' in line
                             for line in self.hcom_log.read_text().splitlines()))

    def test_busy_or_failed_input_retries_and_expired_cache_is_given_up(self):
        self.start = taipei(10)
        self.declare(kind='agent', deadline_at=self.start + 3000)
        self.write_usage(self.start + 240)
        busy = Path(f'{self.hcom_log}.busy')
        busy.touch()
        self.cycle(self.start)
        self.assertEqual(self.injections(), [])
        busy.unlink()
        failed = Path(f'{self.hcom_log}.fail')
        failed.touch()
        self.cycle(self.start + 60)
        self.assertEqual(self.records()[-1]['result'], 'failed')
        self.assertNotIn('expires_at', self.state()['worker'].get('keepalive', {}))
        self.assertFalse(self.state()['worker']['nudged'])
        failed.unlink()
        self.cycle(self.start + 120)
        self.assertEqual([r['result'] for r in self.records()], ['failed', 'sent'])
        # A cache that already expired is not chased.
        self.write_usage(self.start + 600)
        busy.touch()
        self.cycle(self.start + 400)
        busy.unlink()
        self.cycle(self.start + 600, self.start + 660)
        # One failed attempt and one delivered keep-alive; nothing after expiry.
        self.assertEqual(len(self.injections()), 2)

    def test_subordinate_and_advisor_waits_never_receive_or_log_keepalive(self):
        self.start = taipei(10)
        (self.decisions / 'HELP.md').write_text('- status: pending\n')
        self.agents[0]['session_id'] = 'helper-session'
        self.write_usage(self.start + 240, session='helper-session')
        path = self.watch.wait_path(self.work, 'helper')
        for role in ('Implementer', 'Advisor'):
            (self.tasks / 'open.md').write_text(
                f'- agent：helper ({role})\n- orchestrator：worker\n- status：in progress\n'
                '- live actions：無\n- preflight：無\n')
            for status in ('listening', 'inactive'):
                self.agents[1].update(status=status, status_context='failure:rate_limit')
                self.show(status=status)
                for kind in ('agent', 'decision', 'alarm'):
                    with self.subTest(role=role, status=status, kind=kind):
                        self.watch.write_object(path, dict(
                            agent='helper', kind=kind, target='HELP' if kind == 'decision' else 'worker',
                            active=True, declared_at=self.start,
                            declared_at_utc=datetime.fromtimestamp(self.start, timezone.utc).isoformat(),
                            due_at=self.start + 600, condition={'kind': 'time', 'minutes': 10}))
                        self.cycle(self.start, self.start + 60)
                        self.assertTrue(json.loads(path.read_text())['active'])
        self.assertEqual(self.records(), [])
        self.assertEqual(self.records('cache-keepalive-skipped'), [])
        self.assertNotIn('term inject helper', self.hcom_log.read_text())
        self.assertEqual(self.records('observation-failed'), [])

    def test_rate_limited_orchestrator_skips_once_and_recovers(self):
        self.start = taipei(10)
        self.declare(kind='agent', deadline_at=self.start + 3000)
        self.write_usage(self.start + 240)
        for field, value in (('status_context', 'failure:rate_limit'),
                             ('context', 'failure:rate_limit'), ('status_detail', 'rate_limit')):
            with self.subTest(field=field):
                agents = [self.agents[0], {**self.agents[1], 'status': 'inactive', field: value}]
                Path(f'{self.hcom_log}.agents').write_text(json.dumps(agents))
                self.cycle(self.start, self.start + 60)
                self.assertEqual(self.injections(), [])
                self.assertEqual([r['reason'] for r in self.records('cache-keepalive-skipped')],
                                 ['rate-limited'])
                cache = self.watch.cache_status(agents[1], self.state()['worker'], self.start)
                self.assertEqual((cache['can_keep_alive'], cache['reason']), (False, 'rate-limited'))
        self.assertIsNone(self.cache(self.start)['can_keep_alive'])
        self.show()
        self.cycle(self.start + 120)
        self.assertEqual(len(self.injections()), 1)
        self.assertEqual(self.records()[0]['result'], 'sent')

    def test_alarm_is_kept_warm_and_still_rings_on_time(self):
        self.start = taipei(10)
        self.declare(kind='alarm', due_at=self.start + 90 * 60,
                     condition={'kind': 'time', 'minutes': 90})
        self.write_usage(self.start + 3000)
        self.cycle(self.start, self.start + 2800)
        self.assertEqual(len(self.injections()), 1)
        self.assertIn(self.watch.KEEPALIVE, self.injections()[0])
        self.assertEqual(self.records()[0]['kind'], 'alarm')
        self.reply_to_keepalive()
        self.write_usage(self.start + 2860 + 3600)
        self.cycle(self.start + 2860, self.start + 5340)
        self.assertEqual(len(self.injections()), 1)
        self.cycle(self.start + 5400)
        self.assertEqual(len(self.injections()), 2)
        self.assertIn('Your alarm condition met', self.injections()[1])
        self.assertEqual(json.loads(self.wait_file.read_text())['rang_at'], self.start + 5400)

    def test_alarm_keepalive_stops_after_3h_and_in_quiet_hours(self):
        self.start = taipei(22)
        self.declare(kind='alarm', due_at=self.start + 20 * 3600,
                     condition={'kind': 'time', 'minutes': 1200})
        # Within 3 h and outside quiet hours: sent.
        self.write_usage(taipei(23, 3))
        self.cycle(taipei(23))
        self.assertEqual(len(self.injections()), 1)
        self.reply_to_keepalive()
        # Past 3 h from declaration (01:00 is also quiet; the 3 h cap is checked first).
        after_3h = taipei(1) + 86400
        self.write_usage(after_3h + 180)
        self.cycle(after_3h)
        self.assertEqual(self.records('cache-keepalive-skipped')[-1]['reason'], 'alarm-over-3h')
        self.assertEqual(len(self.injections()), 1)
        # Alarm ring time is unchanged by the skipped keep-alive.
        self.assertTrue(json.loads(self.wait_file.read_text())['active'])
        self.assertEqual(json.loads(self.wait_file.read_text())['due_at'], self.start + 20 * 3600)

    def test_alarm_keepalive_stops_after_3h_outside_quiet_hours(self):
        self.start = taipei(10)
        self.declare(kind='alarm', due_at=self.start + 20 * 3600,
                     condition={'kind': 'time', 'minutes': 1200})
        self.write_usage(taipei(14, 3))
        self.cycle(taipei(14))
        self.assertEqual(self.injections(), [])
        self.assertEqual([r['reason'] for r in self.records('cache-keepalive-skipped')],
                         ['alarm-over-3h'])

    def test_alarm_keepalive_skips_quiet_hours_and_resumes_at_nine(self):
        self.start = taipei(0, 30)
        self.declare(kind='alarm', due_at=self.start + 20 * 3600,
                     condition={'kind': 'time', 'minutes': 1200})
        self.write_usage(taipei(1))
        self.cycle(taipei(0, 56))
        self.assertEqual(len(self.injections()), 1)
        self.reply_to_keepalive()
        self.write_usage(taipei(2))
        self.cycle(taipei(1, 56), taipei(1, 58))
        self.assertEqual(len(self.injections()), 1)
        self.assertEqual([r['reason'] for r in self.records('cache-keepalive-skipped')],
                         ['alarm-quiet-hours'])
        self.assertEqual(self.records('cache-keepalive-skipped')[0]['kind'], 'alarm')
        # 09:00 onwards the keep-alive resumes while still within 3 h of the declaration.
        self.start = taipei(8, 30)
        self.declare(kind='alarm', due_at=self.start + 20 * 3600,
                     condition={'kind': 'time', 'minutes': 1200})
        self.write_usage(taipei(9, 5))
        self.cycle(taipei(9))
        self.assertEqual(len(self.injections()), 2)

    def test_agent_wait_keepalive_ignores_3h_cap_and_quiet_hours(self):
        self.start = taipei(0, 30)
        self.declare(kind='agent', deadline_at=self.start + 20 * 3600)
        self.write_usage(taipei(4, 3))
        self.cycle(taipei(4))
        self.assertEqual(len(self.injections()), 1)
        self.assertEqual(self.records('cache-keepalive-skipped'), [])

    def test_decision_wait_is_skipped_during_quiet_hours(self):
        (self.decisions / 'HELP-1.md').write_text('# Q\n- version: r1\n- status: pending\n')
        self.start = taipei(0, 30)
        self.declare(kind='decision', target='HELP-1')
        self.write_usage(taipei(1))
        self.cycle(taipei(0, 56))
        self.assertEqual(len(self.injections()), 1)
        self.assertEqual(self.records()[0]['kind'], 'decision')
        self.reply_to_keepalive()
        self.write_usage(taipei(2))
        self.cycle(taipei(1, 56), taipei(1, 58))
        self.assertEqual(len(self.injections()), 1)
        self.assertTrue(json.loads(self.wait_file.read_text())['active'])

    def test_claude_keepalive_follows_hcom_status_not_the_footer(self):
        footer = ['❯', '─' * 40, '  ⏵⏵ some future mode · 2 monitors · ↓ to manage']
        cases = {
            'listening, not ready, background footer': (
                dict(status='listening', ready=False, lines=footer), None),
            'active': (dict(status='active', lines=footer), 'status-active'),
            'blocked': (dict(status='blocked', ready=False, prompt_empty=None,
                             input_text=None), 'status-blocked'),
            'prompt has text': (dict(prompt_empty=False, input_text='draft'),
                                'prompt-not-empty'),
            'menu': (dict(ready=False, prompt_empty=None, input_text=None,
                          lines=['   Select model']), 'prompt-unreadable'),
        }
        for name, (terminal, reason) in cases.items():
            with self.subTest(name):
                self.hcom_log.write_text('')
                shutil.rmtree(self.work / '.lat/watch', ignore_errors=True)
                self.start = taipei(10)
                self.declare(kind='agent', deadline_at=self.start + 3000)
                self.show(**terminal)
                self.write_usage(self.start + 240)
                self.cycle(self.start, self.start + 60)
                self.assertEqual(len(self.injections()), 0 if reason else 1)
                self.assertEqual([r['reason'] for r in self.records('cache-keepalive-skipped')],
                                 [reason] if reason else [])
                if reason:
                    self.assertEqual(self.records('cache-keepalive-skipped')[0]['expires_at'],
                                     self.start + 240)
                    self.assertEqual(self.state()['worker']['keepalive_check']['reason'], reason)

    def test_skip_reasons_are_logged_once_per_expiry_and_reason(self):
        self.start = taipei(10)
        self.declare(kind='agent', deadline_at=self.start + 10000)
        self.show(status='active')
        # Far from expiry nothing is logged.
        self.write_usage(self.start + 3000)
        self.cycle(self.start)
        self.assertEqual(self.records('cache-keepalive-skipped'), [])
        self.write_usage(self.start + 280)
        self.cycle(self.start + 60, self.start + 120)
        self.show(prompt_empty=False, input_text='draft')
        self.cycle(self.start + 180)
        self.show(status='active')
        self.cycle(self.start + 200)
        self.assertEqual([(r['reason'], r['expires_at'], r['kind'])
                          for r in self.records('cache-keepalive-skipped')],
                         [('status-active', self.start + 280, 'agent'),
                          ('prompt-not-empty', self.start + 280, 'agent')])
        # A missing usage file in between does not forget what was logged for this expiry.
        (self.usage / 'claude-session.json').unlink()
        self.cycle(self.start + 220, self.start + 230)
        self.write_usage(self.start + 280)
        self.cycle(self.start + 240)
        self.assertEqual([r['reason'] for r in self.records('cache-keepalive-skipped')],
                         ['status-active', 'prompt-not-empty', 'usage-missing'])
        # A new expiry starts a new record set.
        self.write_usage(self.start + 3800)
        self.cycle(self.start + 3600)
        self.assertEqual([r['expires_at'] for r in self.records('cache-keepalive-skipped')],
                         [self.start + 280] * 2 + [None, self.start + 3800])
        # Without a valid wait nothing is logged.
        self.watch.write_object(self.wait_file, {**json.loads(self.wait_file.read_text()),
                                                 'active': False})
        self.write_usage(self.start + 7400)
        self.cycle(self.start + 7200)
        self.assertEqual(len(self.records('cache-keepalive-skipped')), 4)
        (self.usage / 'claude-session.json').unlink()
        self.cycle(self.start + 7260)
        self.assertEqual(len(self.records('cache-keepalive-skipped')), 4)

    def test_decision_other_action_and_missing_usage_reasons(self):
        (self.decisions / 'HELP-1.md').write_text('# Q\n- version: r1\n- status: pending\n')
        self.start = taipei(0, 30)
        self.declare(kind='decision', target='HELP-1')
        self.show()
        self.write_usage(taipei(1, 3))
        self.cycle(taipei(1))
        self.write_usage(taipei(4, 3))
        self.cycle(taipei(4))
        (self.usage / 'claude-session.json').unlink()
        self.cycle(taipei(4, 1), taipei(4, 2))
        self.assertEqual([(r['reason'], r['expires_at'])
                          for r in self.records('cache-keepalive-skipped')],
                         [('decision-quiet-hours', taipei(1, 3)),
                          ('decision-over-3h', taipei(4, 3)), ('usage-missing', None)])
        # An alarm ringing in the same cycle takes the turn.
        self.declare(kind='alarm', due_at=taipei(10), condition={'kind': 'time', 'minutes': 1})
        self.write_usage(taipei(10, 3))
        self.cycle(taipei(10))
        self.assertEqual(self.records('cache-keepalive-skipped')[-1]['reason'], 'other-action')
        self.assertIn('Your alarm', self.injections()[-1])

    def test_unreadable_listening_prompt_is_logged_once_after_fifteen_minutes(self):
        # The fake shows the same screen for the helper; count the orchestrator only.
        self.unreadable = lambda: [r for r in self.records('prompt-unreadable')
                                   if r['agent'] == 'worker']
        self.start = taipei(10)
        menu = [f'line {index} ' + 'x' * 300 for index in range(12)]
        self.show(ready=False, prompt_empty=None, input_text=None, lines=menu)
        self.cycle(*(self.start + minute * 60 for minute in range(15)))
        self.assertEqual(self.unreadable(), [])
        self.cycle(self.start + 900, self.start + 960)
        records = self.unreadable()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['since'], self.start)
        self.assertEqual(len(records[0]['lines']), 12)
        self.assertTrue(records[0]['lines'][0].startswith('line 0 '))
        self.assertEqual(len(records[0]['lines'][0]), 200)
        self.assertEqual(self.records('observation-failed'), [])
        # A readable prompt ends the episode; the next one is logged again.
        self.show()
        self.cycle(self.start + 1020)
        self.show(ready=False, prompt_empty=None, input_text=None, lines=menu)
        self.cycle(self.start + 1080, self.start + 1080 + 900)
        self.assertEqual(len(self.unreadable()), 2)
        # Other states do not count toward it.
        self.show(status='blocked', ready=False, prompt_empty=None, input_text=None)
        self.cycle(self.start + 3000, self.start + 3000 + 1800)
        self.assertEqual(len(self.unreadable()), 2)

    def unreadable_notices(self):
        # The notice is multi-line, so split the log by command rather than by line.
        sends = re.findall(r'^send .*?(?=^(?:send|term|list) |\Z)', self.hcom_log.read_text(),
                           re.MULTILINE | re.DOTALL)
        return [send for send in sends if 'agent worker has shown' in send]

    def test_unreadable_screen_notifies_once_with_last_lines_and_restarts_on_change(self):
        self.start = taipei(10)
        menu = [f'menu {index}' for index in range(20)] + ['Autocompact at 400k?']
        self.show(ready=False, prompt_empty=None, input_text=None, lines=menu)
        self.cycle(*(self.start + minute * 60 for minute in range(15)))
        self.assertEqual(self.unreadable_notices(), [])
        self.cycle(self.start + 900, self.start + 960, self.start + 1800)
        notices = self.unreadable_notices()
        self.assertEqual(len(notices), 1)
        self.assertIn('worker', notices[0])
        self.assertIn('Autocompact at 400k?', notices[0])
        self.assertIn('menu 6', notices[0])
        self.assertNotIn('menu 5', notices[0])
        # A changed screen restarts the timer; the new one is announced after its own 15 minutes.
        changed = menu[:-1] + ['Autocompact at 500k?']
        self.show(ready=False, prompt_empty=None, input_text=None, lines=changed)
        self.cycle(self.start + 1860, self.start + 1860 + 899)
        self.assertEqual(len(self.unreadable_notices()), 1)
        self.cycle(self.start + 1860 + 900)
        self.assertEqual(len(self.unreadable_notices()), 2)
        self.assertIn('Autocompact at 500k?', self.unreadable_notices()[1])

    def test_unreadable_screen_changing_every_cycle_never_notifies(self):
        self.start = taipei(10)
        for minute in range(40):
            self.show(ready=False, prompt_empty=None, input_text=None,
                      lines=[f'tick {minute}'])
            self.cycle(self.start + minute * 60)
        self.assertEqual(self.unreadable_notices(), [])

    def status(self):
        result = subprocess.run([sys.executable, str(SCRIPT), 'status', '--workspace', self.work,
                                 '--orchestrator', 'worker', '--tasks', self.tasks],
                                capture_output=True, text=True, check=True)
        return {row['agent']: row for row in json.loads(result.stdout)['targets']}

    def cache(self, now, status=None):
        """status's cache block for the worker as the CLI computes it at this time."""
        info = {**self.agents[1], 'status': status or self.agents[1]['status']}
        return self.watch.cache_status(info, self.state()['worker'], now)

    def test_status_shows_cache_expiry_keepalive_possibility_and_last_try(self):
        self.start = taipei(10)
        self.declare(kind='agent', deadline_at=self.start + 3000)
        self.show(status='active')
        self.write_usage(self.start + 1000)
        self.cycle(self.start)
        self.assertEqual(self.cache(self.start, 'active'),
                         {'expires_at': self.start + 1000, 'warm': True,
                          'can_keep_alive': False, 'reason': 'status-active',
                          'checked_at': self.start, 'last_keepalive': None})
        # Back at listening, the stale status reason no longer applies and is unknown.
        self.assertEqual((self.cache(self.start)['can_keep_alive'],
                          self.cache(self.start)['reason']), (None, None))
        Path(f'{self.hcom_log}.fail').touch()
        self.show()
        self.write_usage(self.start + 240)
        self.cycle(self.start + 60)
        Path(f'{self.hcom_log}.fail').unlink()
        cache = self.cache(self.start + 60)
        self.assertTrue(cache['can_keep_alive'])
        self.assertIsNone(cache['reason'])
        self.assertEqual({key: cache['last_keepalive'][key] for key in ('at', 'result')},
                         {'at': self.start + 60, 'result': 'failed'})
        # Current HCOM status and cache file win over the last cycle's judgement.
        self.assertEqual(self.cache(self.start + 60, 'active')['reason'], 'status-active')
        self.assertEqual(self.cache(self.start + 300)['reason'], 'cache-expired')
        self.write_usage(self.start + 240, warm=False)
        self.assertEqual((self.cache(self.start + 60)['can_keep_alive'],
                          self.cache(self.start + 60)['reason']), (False, 'cache-cold'))
        self.write_usage(self.start + 240)
        self.cycle(self.start + 120)
        # The reply to a keep-alive is not progress, so the last try survives it.
        self.reply_to_keepalive()
        self.cycle(self.start + 180)
        self.assertEqual(self.cache(self.start + 180)['last_keepalive'],
                         {'at': self.start + 120, 'result': 'sent', 'expires_at': self.start + 240})
        (self.usage / 'claude-session.json').unlink()
        cache = self.cache(self.start + 180)
        self.assertEqual((cache['expires_at'], cache['can_keep_alive'], cache['reason']),
                         (None, False, 'usage-missing'))
        # The CLI shows the block for Claude agents only.
        self.assertEqual(self.status()['worker']['cache']['reason'], 'usage-missing')
        self.assertEqual(self.status()['helper']['cache']['reason'], 'usage-missing')
        agents = Path(f'{self.hcom_log}.agents')
        agents.write_text(json.dumps([{**self.agents[0], 'tool': 'codex'}, self.agents[1]]))
        self.assertNotIn('cache', self.status()['helper'])

    def test_send_time_not_cycle_start_decides_quiet_hours(self):
        (self.decisions / 'HELP-1.md').write_text('# Q\n- version: r1\n- status: pending\n')
        self.start = taipei(0, 30)
        self.declare(kind='decision', target='HELP-1')
        self.write_usage(taipei(1, 3))
        # The cycle starts at 00:59:58 but observing the agents takes five seconds.
        clock = iter([100.0])
        with patch.object(time, 'monotonic', side_effect=lambda: next(clock, 105.0)):
            self.cycle(taipei(0, 59, 58))
        self.assertEqual(self.injections(), [])
        with patch.object(time, 'monotonic', return_value=100.0):
            self.cycle(taipei(0, 59, 59))
        self.assertEqual(len(self.injections()), 1)


class CacheHistoryTests(PinnedEnvironment):
    # Request rows (UTC time, request ID, cache read, cache write) excerpted from a real
    # orchestrator session: 22:23 -> 23:33 local rewrote the cache, 00:00 -> 00:40 hit it.
    # Streamed replies repeat a request's usage on every content block.
    REAL_REQUESTS = [
        ('2026-10-22T14:23:42.722Z', 'req-1', 175230, 844),
        ('2026-10-22T15:33:12.004Z', 'req-2', 28437, 147948),
        ('2026-10-22T15:33:13.676Z', 'req-2', 28437, 147948),
        ('2026-10-22T15:35:42.963Z', 'req-3', 199873, 1365),
        ('2026-10-22T16:00:10.550Z', 'req-4', 214179, 344),
        ('2026-10-22T16:40:28.640Z', 'req-5', 214523, 1215),
        ('2026-10-22T16:40:30.259Z', 'req-5', 214523, 1215),
    ]

    def setUp(self):
        super().setUp()
        self.watch = load_watch()
        self.transcript = self.root / 'nahu.jsonl'
        self.transcript.write_text(''.join(json.dumps({
            'type': 'assistant', 'timestamp': at, 'requestId': request, 'isSidechain': False,
            'message': {'id': request, 'model': 'claude-opus-5-5', 'role': 'assistant',
                        'content': [], 'usage': {'cache_read_input_tokens': read,
                                                 'cache_creation_input_tokens': write}}}) + '\n'
            for at, request, read, write in self.REAL_REQUESTS))

    def gap(self, gaps, start):
        return next(gap for gap in gaps if datetime.fromtimestamp(
            gap['start_at'], TAIPEI).strftime('%m-%d %H:%M') == start)

    def test_real_transcript_rewrite_and_hit(self):
        gaps = self.watch.cache_history(self.transcript)
        rewrite = self.gap(gaps, '10-22 22:23')
        self.assertEqual(datetime.fromtimestamp(rewrite['end_at'], TAIPEI).strftime('%H:%M'),
                         '23:33')
        self.assertEqual(rewrite['idle_seconds'] // 60, 69)
        self.assertEqual((rewrite['cache_read_tokens'], rewrite['cache_write_tokens'],
                          rewrite['verdict']), (28437, 147948, 'rewrite'))
        hit = self.gap(gaps, '10-23 00:00')
        self.assertEqual(hit['idle_seconds'] // 60, 40)
        self.assertEqual((hit['cache_read_tokens'], hit['cache_write_tokens'], hit['verdict']),
                         (214523, 1215, 'hit'))
        self.assertTrue(all(gap['idle_seconds'] > 300 for gap in gaps))

    def test_idle_gap_threshold_stays_five_minutes_apart_from_keepalive_window(self):
        self.assertEqual(self.watch.IDLE_GAP_SECONDS, 300)
        self.assertEqual(self.watch.KEEPALIVE_SECONDS, 600)
        transcript = self.root / 'threshold.jsonl'
        def reply(clock, request):
            return json.dumps({'type': 'assistant', 'timestamp': f'2026-10-23T{clock}Z',
                               'requestId': request, 'message': {'id': request, 'model': 'claude',
                               'usage': {'cache_read_input_tokens': 10,
                                         'cache_creation_input_tokens': 1}}})
        def user(clock):
            return json.dumps({'type': 'user', 'timestamp': f'2026-10-23T{clock}Z'})
        # 300 s is not a gap; 301 s and a 9-minute pause (inside the keep-alive window) are.
        rows = [reply('01:00:00', 'a'), user('01:05:00'), reply('01:05:01', 'b'),
                user('01:10:02'), reply('01:10:03', 'c'), user('01:19:03'), reply('01:19:04', 'd')]
        transcript.write_text('\n'.join(rows) + '\n')
        gaps = self.watch.cache_history(transcript)
        self.assertEqual([gap['idle_seconds'] for gap in gaps], [301, 540])

    def test_repeated_blocks_sidechains_and_error_placeholders_are_not_requests(self):
        transcript = self.root / 'session.jsonl'
        def entry(clock, request, read, write, **fields):
            return json.dumps({'type': 'assistant', 'timestamp': f'2026-10-23T{clock}Z',
                               'requestId': request, **fields, 'message': {
                                   'id': request, 'model': fields.pop('model', 'claude'),
                                   'usage': {'cache_read_input_tokens': read,
                                             'cache_creation_input_tokens': write}}})
        rows = [entry('01:00:00', 'a', 100, 5), entry('01:00:02', 'a', 100, 5),
                entry('01:20:00', 'side', 0, 900, isSidechain=True),
                '{not json', json.dumps({'type': 'user', 'timestamp': '2026-10-23T01:30:00Z'}),
                entry('01:40:00', 'err', 0, 0, model='<synthetic>'),
                entry('02:00:00', 'b', 0, 0), entry('02:03:00', 'c', 50, 9)]
        transcript.write_text('\n'.join(rows) + '\n')
        gaps = self.watch.cache_history(transcript)
        self.assertEqual([(gap['idle_seconds'], gap['verdict']) for gap in gaps],
                         [(3598, 'unknown')])

    def test_idle_runs_from_the_last_reply_block_to_the_next_user_entry(self):
        # Real shape: the reply ends 14:08:34, the prompt arrives 14:13:30 and its first reply
        # block is written later, which must not stretch the idle time past five minutes.
        transcript = self.root / 'latency.jsonl'
        def reply(clock, request):
            return {'type': 'assistant', 'timestamp': f'2026-10-23T{clock}Z', 'requestId': request,
                    'message': {'id': request, 'model': 'claude', 'usage': {
                        'cache_read_input_tokens': 10, 'cache_creation_input_tokens': 1}}}
        rows = [reply('06:08:20.000', 'a'), reply('06:08:34.971', 'a'),
                {'type': 'user', 'timestamp': '2026-10-23T06:13:30.760Z'},
                reply('06:13:36.000', 'b'),
                {'type': 'user', 'timestamp': '2026-10-23T06:20:00.000Z'},
                reply('06:20:05.000', 'c')]
        transcript.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        gaps = self.watch.cache_history(transcript)
        self.assertEqual([gap['idle_seconds'] for gap in gaps], [384])

    def test_keepalives_between_requests_are_marked_and_cli_supports_json(self):
        work = self.root / 'work'
        (work / '.git').mkdir(parents=True)
        log = work / '.lat/watch/orch/watch.jsonl'
        log.parent.mkdir(parents=True)
        at = datetime(2026, 10, 22, 23, 20, tzinfo=TAIPEI).timestamp()
        log.write_text(''.join(json.dumps(record) + '\n' for record in [
            {'at': at, 'agent': 'nahu', 'decision': 'cache-keepalive-skipped',
             'kind': 'agent', 'expires_at': at + 200, 'reason': 'status-active'},
            {'at': at, 'agent': 'other', 'decision': 'cache-keepalive', 'result': 'sent'},
            {'at': at + 3600 * 3, 'agent': 'nahu', 'decision': 'cache-keepalive',
             'result': 'sent'}]))
        binary = self.root / 'bin'
        binary.mkdir()
        hcom = binary / 'hcom'
        hcom.write_text('#!/bin/sh\nprintf \'%s\\n\' \'' + json.dumps([
            {'name': 'nahu', 'session_id': 'nahu-session',
             'transcript_path': str(self.transcript)}]) + '\'\n')
        hcom.chmod(0o755)
        environment = {**os.environ, 'PATH': f'{binary}:{os.environ["PATH"]}'}
        def history(*args):
            return subprocess.run([sys.executable, str(SCRIPT), 'cache-history', *args],
                                  capture_output=True, text=True, check=True, env=environment)
        result = json.loads(history('--agent', 'nahu', '--workspace', work, '--json').stdout)
        self.assertEqual((result['agent'], result['session_id']), ('nahu', 'nahu-session'))
        rewrite = self.gap(result['gaps'], '10-22 22:23')
        self.assertEqual(rewrite['keepalives'],
                         [{'at': at, 'decision': 'cache-keepalive-skipped',
                           'reason': 'status-active', 'expires_at': at + 200}])
        self.assertEqual(sum(len(gap['keepalives']) for gap in result['gaps']), 1)
        text = history('--session', 'nahu-session', '--workspace', work).stdout
        self.assertIn('2026-10-22 22:23 -> 23:33  idle 69m  read 28437  write 147948  rewrite'
                      '  [cache-keepalive-skipped 23:20 status-active]', text)
        self.assertIn('2026-10-23 00:00 -> 00:40  idle 40m  read 214523  write 1215  hit', text)
        # Without HCOM the session is found under the Claude config directory.
        config = self.root / 'claude'
        (config / 'projects/repo').mkdir(parents=True)
        (config / 'projects/repo/lost-session.jsonl').write_text(self.transcript.read_text())
        hcom.write_text('#!/bin/sh\nexit 1\n')
        environment['CLAUDE_CONFIG_DIR'] = str(config)
        result = json.loads(history('--session', 'lost-session', '--json').stdout)
        self.assertIsNone(result['agent'])
        self.assertEqual(self.gap(result['gaps'], '10-23 00:00')['verdict'], 'hit')
        missing = subprocess.run([sys.executable, str(SCRIPT), 'cache-history', '--session',
                                  'none'], capture_output=True, text=True, env=environment)
        self.assertEqual(missing.returncode, 1)
        self.assertIn('No Claude transcript found for session none', missing.stderr)


# Raw hcom terminal fixtures from private issue #271, captured 2026-10-23.
# exhausted: .lat/runs/issue-271/screen-vete-1405.json (real quota limit).
# manual: probe-menu-status.txt (manual opening; HCOM listening, Herdr blocked).
# HCOM 0.7.31 / Herdr 0.9.5 / Claude Code 2.1.309. Cursor/text variants below are synthetic.
CLAUDE_QUOTA_SCREENS = {'manual': {'cursor': [9, 2],
            'input_text': None,
            'lines': ['▝▜██████▀  Sonnet 5.5 with low effort · Claude Max',
                      ' ▝▝   ▝▝   ~/LoopAgentTeams',
                      '',
                      '',
                      '❯ /rate-limit-options',
                      '',
                      '──────────────────────────────────────────────────────────────',
                      '  What do you want to do?',
                      '',
                      '  ❯ 1. Stop and wait for limit to reset',
                      '    2. Add funds to continue with usage credits',
                      '    3. Upgrade your plan',
                      '',
                      '  Enter to confirm · Esc to cancel',
                      ''],
            'prompt_empty': None,
            'ready': False,
            'size': [15, 62]},
 'exhausted': {'cursor': [8, 2],
               'input_text': None,
               'lines': ['',
                         '✻ Churned for 0s · done 下午1:55',
                         '',
                         '❯ /rate-limit-options',
                         '',
                         '──────────────────────────────────────────────────────────────',
                         '  What do you want to do?',
                         '',
                         '  ❯ 1. Stop and wait for limit to reset',
                         '    2. Wait here, then continue automatically at 4:50pm',
                         '    3. Switch to usage credits',
                         '    4. Upgrade your plan',
                         '',
                         '  Enter to confirm · Esc to cancel',
                         ''],
               'prompt_empty': None,
               'ready': False,
               'size': [15, 62]}}


class ClaudeQuotaRecoveryTests(unittest.TestCase):
    """Synthetic cswap/terminal transport; real screen provenance is above the fixtures."""

    def setUp(self):
        self.watch = load_watch()
        self.temp = tempfile.TemporaryDirectory(prefix='huve-impl271-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.log = self.root / 'watch.jsonl'
        self.terminal = self.fixture('manual')
        self.commands = []
        self.quota = {
            'schemaVersion': 1, 'cachedOnly': True, 'activeAccountNumber': 1,
            'accounts': [{'number': 1, 'active': True, 'usageStatus': 'ok',
                          'usage': {'fiveHour': {'pct': 12}, 'sevenDay': {'pct': 35}}}],
        }
        self.state = {}
        self.corrupt_after_up = False
        self.fail_key = None
        self.notifications = []
        patcher = patch.object(self.watch, 'run_command', side_effect=self.command)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(self.watch, 'perform', side_effect=self.notify)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.watch.PROMPT_SETTLE_SECONDS = 0

    def fixture(self, name):
        return json.loads(json.dumps(CLAUDE_QUOTA_SCREENS[name]))

    def select(self, index):
        self.terminal['lines'] = [line.replace('❯ ', '  ') if re_option(line) else line
                                  for line in self.terminal['lines']]
        rows = [i for i, line in enumerate(self.terminal['lines']) if re_option(line)]
        self.terminal['lines'][rows[index]] = '  ❯ ' + self.terminal['lines'][rows[index]].strip()
        self.terminal['cursor'] = [rows[index], 2]

    def command(self, command, failure=None):
        self.commands.append(command)
        if command[0] == 'cswap':
            self.assertEqual(command, ['cswap', 'list', '--json', '--cached-only'])
            return json.dumps(self.quota)
        if command[:2] == ['hcom', 'term'] and command[2] != 'inject':
            return json.dumps(self.terminal)
        if command[:3] == ['hcom', 'term', 'inject']:
            value = command[4]
            if self.fail_key == value:
                raise ValueError('injection delivery uncertain')
            if value == '\x1b[A':
                selected = self.watch.quota_menu_selection(
                    self.watch.claude_quota_menu(self.terminal))
                self.select(selected - 1)
                if self.corrupt_after_up:
                    self.terminal['lines'][-2] = 'Changed screen'
            elif value == '--enter':
                if self.watch.claude_quota_menu(self.terminal):
                    self.assertEqual(self.watch.quota_menu_selection(
                        self.watch.claude_quota_menu(self.terminal)), 0)
                self.terminal = {'ready': True, 'prompt_empty': True,
                                 'input_text': '', 'lines': []}
            else:
                self.terminal.update(input_text=value, prompt_empty=False, ready=False)
            return ''
        raise AssertionError(command)

    def notify(self, action, orchestrator, workspace):
        self.notifications.append(action)
        return {'delivery': 'fake'}

    def observation(self, **changes):
        menu = self.watch.claude_quota_menu(self.terminal)
        values = dict(agent='worker', status='listening', prompt_empty=False,
                      command_running=True, transcript_size=1, transcript_mtime_ns=1,
                      event_id=0, client='claude', quota_screen=menu,
                      quota_issue=self.watch.QuotaIssue('rate-limit', 'menu') if menu else None)
        values.update(changes)
        return self.watch.Observation(**values)

    def recover(self, **changes):
        previous = self.state
        self.state = {}  # simulate decide() resetting unrelated progress state
        self.watch.recover_claude_quota(self.observation(**changes), previous, self.state,
                                       'orch', self.root, self.log, 1000)

    def keys(self):
        return [c[4] for c in self.commands if c[:3] == ['hcom', 'term', 'inject']]

    def records(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_both_real_menu_shapes_all_cursor_positions(self):
        for name, count in [('manual', 3), ('exhausted', 4)]:
            for selected in range(count):
                with self.subTest(name=name, selected=selected):
                    self.terminal = self.fixture(name)
                    self.select(selected)
                    self.state, self.commands = {}, []
                    self.recover()
                    self.assertEqual(self.keys(), ['\x1b[A'] * selected + [
                        '--enter', self.watch.QUOTA_CONTINUE, '--enter'])
                    self.assertTrue(self.state['quota_recovery']['completed'])
                    self.assertEqual(self.commands[0][0], 'cswap')
        self.assertEqual(self.notifications, [])
        records = self.records()
        self.assertTrue(any(r['step'] == 'detected' and r['screen'] for r in records))
        key_index = next(i for i, r in enumerate(records) if r['step'] == 'key')
        self.assertTrue(any(r['step'] == 'verified' for r in records[:key_index]))
        self.assertEqual(records[-1]['text'], self.watch.QUOTA_CONTINUE)

    def test_exhausted_and_unknown_quota_send_no_keys_then_retry_same_episode(self):
        for window in ('fiveHour', 'sevenDay'):
            self.quota['accounts'][0]['usage'][window]['pct'] = 100
            self.recover()
            self.recover()
            self.assertEqual(self.keys(), [])
            self.quota['accounts'][0]['usage'][window]['pct'] = 0
        self.assertEqual(sum(c[0] == 'cswap' for c in self.commands), 4)
        self.assertFalse(self.state['quota_recovery'].get('attempted'))
        self.recover()
        self.assertEqual(self.keys(), ['--enter', self.watch.QUOTA_CONTINUE, '--enter'])
        # Same episode may keep showing the menu even after progress/events change.
        self.terminal = self.fixture('manual')
        self.recover(event_id=200, transcript_size=300)
        self.assertEqual(len(self.keys()), 3)

    def test_quota_reader_fails_closed_on_missing_invalid_or_other_account_data(self):
        original = json.dumps(self.quota)
        variants = [None, {}, {'schemaVersion': 2},
                    {**self.quota, 'activeAccountNumber': None},
                    {**self.quota, 'activeAccountNumber': 2},
                    {**self.quota, 'accounts': []}]
        for field, value in [('usageStatus', 'unavailable'), ('usage', None), ('active', False)]:
            data = json.loads(original)
            data['accounts'][0][field] = value
            variants.append(data)
        for value in (None, True, '0', -1, 101, float('nan'), float('inf')):
            data = json.loads(original)
            data['accounts'][0]['usage']['fiveHour']['pct'] = value
            variants.append(data)
        data = json.loads(original)
        data['accounts'][0]['usage']['sevenDay'] = {}
        variants.append(data)
        data = json.loads(original)
        data['accounts'].append({'number': 2, 'active': True, 'usageStatus': 'ok',
                                 'usage': data['accounts'][0]['usage']})
        variants.append(data)
        for data in variants:
            with self.subTest(data=data):
                self.quota = data
                self.recover()
                self.assertEqual(self.keys(), [])
                self.assertFalse(self.records()[-1].get('available', False))
        with patch.object(self.watch, 'run_command', side_effect=OSError('cswap missing')):
            self.assertFalse(self.watch.active_claude_quota()['available'])

    def test_unknown_menu_cursor_or_labels_notifies_once_without_keys(self):
        for change in ('label', 'cursor', 'two-cursors'):
            self.state, self.notifications = {}, []
            self.terminal = self.fixture('manual')
            if change == 'label':
                self.terminal['lines'][9] = '  ❯ 1. Different action'
            elif change == 'cursor':
                self.terminal['lines'][9] = '    1. Stop and wait for limit to reset'
            else:
                self.terminal['lines'][10] = '  ❯ 2. Add funds to continue with usage credits'
            self.recover()
            self.recover()
            self.assertEqual(self.keys(), [])
            self.assertEqual(len(self.notifications), 1)
            self.assertEqual(self.notifications[0].kind, 'notify-orchestrator')

    def test_navigation_screen_race_stops_before_enter_and_never_retries_keys(self):
        self.select(2)
        self.corrupt_after_up = True
        self.recover(is_orchestrator=True)
        self.assertEqual(self.keys(), ['\x1b[A'])
        self.assertEqual(self.notifications[0].kind, 'notify-user')
        self.terminal = self.fixture('manual')
        self.recover()
        self.assertEqual(self.keys(), ['\x1b[A'])

    def test_enter_rechecks_current_selection_and_failed_typing_is_not_submitted(self):
        original = self.command
        reads = 0

        def race(command, failure=None):
            nonlocal reads
            if command[:3] == ['hcom', 'term', 'worker']:
                reads += 1
                if reads == 2:
                    self.select(1)
            return original(command, failure)

        with patch.object(self.watch, 'run_command', side_effect=race):
            self.recover()
        self.assertEqual(self.keys(), [])
        self.state = {}
        self.terminal = self.fixture('manual')
        self.fail_key = self.watch.QUOTA_CONTINUE
        self.recover()
        self.assertEqual(self.keys(), ['--enter', self.watch.QUOTA_CONTINUE])
        self.assertFalse(self.state['quota_recovery'].get('completed'))

    def test_new_episode_requires_two_clear_observations(self):
        self.recover()
        self.recover()  # clear once
        self.terminal = self.fixture('manual')
        self.recover()
        self.assertEqual(len(self.keys()), 3)
        self.terminal = {'ready': True, 'prompt_empty': True, 'input_text': '', 'lines': []}
        self.recover()
        self.recover()
        self.terminal = self.fixture('manual')
        self.recover()
        self.assertEqual(len(self.keys()), 6)

    def test_truncated_input_is_not_submitted_and_failed_notice_retries_without_keys(self):
        original = self.command

        def truncated(command, failure=None):
            result = original(command, failure)
            if command[:3] == ['hcom', 'term', 'inject'] and command[4] == self.watch.QUOTA_CONTINUE:
                self.terminal['input_text'] = '[lat-watch]'
            return result

        with patch.object(self.watch, 'run_command', side_effect=truncated), \
                patch.object(self.watch, 'perform', side_effect=ValueError('notice unavailable')):
            self.recover()
        self.assertEqual(self.keys(), ['--enter', self.watch.QUOTA_CONTINUE])
        self.assertFalse(self.state['quota_recovery'].get('notified'))
        self.recover()  # menu exited, but fallback delivery still needs retry
        self.assertEqual(len(self.notifications), 1)
        self.assertEqual(len(self.keys()), 2)

    def test_non_quota_screens_and_codex_never_receive_recovery_keys(self):
        sample = self.fixture('manual')
        for title in ('Select model', 'Do you want to proceed?', 'Which option?'):
            terminal = json.loads(json.dumps(sample))
            terminal['lines'][7] = title
            self.assertFalse(self.watch.claude_quota_menu(terminal))
        # Quoted content, historical menu above a new prompt, and an ordinary question.
        for terminal in (
                {**sample, 'ready': True, 'prompt_empty': True, 'input_text': ''},
                {**sample, 'lines': ['● ' + line for line in sample['lines']]},
                {**sample, 'lines': sample['lines'] + ['────', '❯ ']},
                {**sample, 'lines': ['────', 'What do you want to do?', '❯ 1. Yes',
                                    '2. No', 'Enter to confirm · Esc to cancel']}):
            self.assertFalse(self.watch.claude_quota_menu(terminal))
        self.recover(client='codex')
        self.assertEqual(self.commands, [])
        self.recover(quota_issue=self.watch.QuotaIssue('crash', 'The application panicked'))
        self.assertEqual(self.commands, [])

    def test_cycle_recovers_owner_and_task_card_despite_hcom_listening(self):
        tasks = self.root / '.lat/tasks'
        tasks.mkdir(parents=True)
        (self.root / '.git').mkdir()
        (tasks / 'worker.md').write_text('- agent：worker\n- orchestrator：orch\n'
                                        '- status：active\n- live actions：none\n- preflight：none\n')
        hcom = {name: {'name': name, 'status': 'listening', 'tool': 'claude',
                       'session_id': name} for name in ('orch', 'worker')}
        original = self.command
        terminals = {name: self.fixture('manual') for name in hcom}

        def transport(command, failure=None):
            if command[0] == 'hcom' and command[1] == 'term':
                name = command[3] if command[2] == 'inject' else command[2]
                self.terminal = terminals[name]
                result = original(command, failure)
                terminals[name] = self.terminal
                return result
            return original(command, failure)

        with patch.object(self.watch, 'list_hcom', return_value=hcom), \
                patch.object(self.watch, 'session_events', return_value=[]), \
                patch.object(self.watch, 'read_processes', return_value=[]), \
                patch.object(self.watch, 'run_command', side_effect=transport):
            self.watch.run_cycle(self.root, tasks, self.root / '.lat/decisions', 'orch', now=1000)
        self.assertEqual(len(self.keys()), 6)
        state = json.loads(self.watch.state_path(self.root, 'orch').read_text())
        for name in hcom:
            self.assertTrue(state[name]['quota_recovery']['completed'])
            self.assertTrue(state[name]['quota_notified'])
        self.assertEqual(state['orch']['feature_versions']['claude_quota_resume'], 1)
        self.assertEqual([a.kind for a in self.notifications], ['notify-user', 'notify-orchestrator'])

    def test_status_only_quota_logs_unknown_or_missing_screen_each_cycle_without_keys(self):
        info = {'status': 'inactive', 'status_context': 'failure:rate_limit', 'tool': 'claude'}
        for lines in (['Changed quota dialog', 'x' * 400], []):
            for available in (True, False):
                with self.subTest(lines=lines, available=available):
                    self.state, self.notifications = {}, []
                    self.terminal = {'ready': False, 'prompt_empty': None,
                                     'input_text': None, 'lines': lines}
                    self.quota['accounts'][0]['usage']['fiveHour']['pct'] = 0 if available else 100
                    with patch.object(self.watch, 'session_events', return_value=[]):
                        observation = self.watch.observe(
                            self.root, self.root / 'decisions', 'orch', 'worker', info,
                            processes=[])
                    before = len(self.records()) if self.log.exists() else 0
                    for _ in range(2):
                        previous, self.state = self.state, {}
                        self.watch.recover_claude_quota(observation, previous, self.state,
                                                       'orch', self.root, self.log, 1000)
                    records = self.records()[before:] if self.log.exists() else []
                    detected = [r for r in records if r['step'] == 'detected']
                    self.assertEqual([r['screen'] for r in detected],
                                     [[line[:300] for line in lines]] * 2)
                    self.assertEqual(len([r for r in records if r['step'] == 'skip']), 2)
                    self.assertEqual(self.keys(), [])
                    self.assertEqual(len(self.notifications), 1 if available else 0)

    def test_changed_footer_listening_menu_notifies_once_without_keys(self):
        self.terminal['lines'][-2] = '  Enter to confirm · Escape to cancel'
        info = {'status': 'listening', 'tool': 'claude'}
        with patch.object(self.watch, 'session_events', return_value=[]):
            observation = self.watch.observe(self.root, self.root / 'decisions',
                                             'orch', 'worker', info, processes=[])
        self.assertIsNotNone(observation.quota_issue)
        for _ in range(2):
            previous, self.state = self.state, {}
            self.watch.recover_claude_quota(observation, previous, self.state,
                                           'orch', self.root, self.log, 1000)
        self.assertEqual(self.keys(), [])
        self.assertEqual(len(self.notifications), 1)
        self.assertEqual(self.notifications[0].kind, 'notify-orchestrator')


def re_option(line):
    return bool(re.match(r'^\s*(?:❯\s*)?\d\.', line))


class LedgerDueTests(unittest.TestCase):
    """Ledger due checks against a real ledger, fake hcom/herdr and fixed clocks."""
    START = datetime(2026, 10, 24, tzinfo=timezone.utc).timestamp()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.work = self.root / 'work'
        (self.work / '.git').mkdir(parents=True)
        self.tasks = self.work / '.lat/tasks'
        self.tasks.mkdir(parents=True)
        self.decisions = self.work / '.lat/decisions'
        self.decisions.mkdir()
        self.ledger_path = self.work / '.lat/ledgers/round.json'
        binary = self.root / 'bin'
        binary.mkdir()
        self.hcom_log = self.root / 'hcom.log'
        self.herdr_log = self.root / 'herdr.log'
        self.hcom_log.touch()
        self.herdr_log.touch()
        (binary / 'hcom').write_text('''#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HCOM_LOG"
case "$1" in
list) if [ -f "$FAKE_HCOM_LOG.gone" ]; then printf '%s\\n' '[{"name":"orch","status":"listening"}]';
      else printf '%s\\n' '[{"name":"orch","status":"listening"},{"name":"worker","status":"listening","tool":"claude"}]'; fi;;
term) if [ "$2" != inject ]; then
        if [ "$2" = worker ] && [ -f "$FAKE_HCOM_LOG.busy" ]; then
          printf '%s\\n' '{"ready":true,"prompt_empty":false,"input_text":"draft","lines":[]}';
        else printf '%s\\n' '{"ready":true,"prompt_empty":true,"input_text":"","lines":[]}'; fi
      elif [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi;;
send) if [ -f "$FAKE_HCOM_LOG.fail" ]; then exit 1; fi;;
esac
''')
        (binary / 'herdr').write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$FAKE_HERDR_LOG"\n')
        for tool in ('hcom', 'herdr'):
            (binary / tool).chmod(0o755)
        self.env = dict(os.environ, PATH=f'{binary}:{os.environ["PATH"]}',
                        FAKE_HCOM_LOG=str(self.hcom_log), FAKE_HERDR_LOG=str(self.herdr_log))
        self.ledger('init', '--workspace', self.work)
        self.ledger('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'file')

    def ledger(self, command, *args, at=0):
        when = datetime.fromtimestamp(self.START + at, timezone.utc).isoformat()
        listing = self.root / 'ledger-hcom-list.json'
        listing.write_text(json.dumps([{'name': name} for name in ('orch', 'worker', 'worker2')]))
        result = subprocess.run(
            [sys.executable, str(SCRIPT.with_name('lat-ledger.py')), command,
             '--ledger', str(self.ledger_path), '--by', 'orch', *map(str, args)],
            text=True, capture_output=True,
            env=dict(self.env, LAT_LEDGER_NOW=when, LAT_LEDGER_HCOM_LIST=str(listing)))
        self.assertEqual(result.returncode, 0, result.stderr)

    def assign(self, deadline='+2h'):
        self.ledger('assign', 1, '--agent', 'worker', '--card', self.tasks / 'worker.md',
                    '--deadline', deadline)

    def flag(self, name, present=True):
        path = Path(f'{self.hcom_log}.{name}')
        path.touch() if present else path.unlink()

    def cycles(self, *offsets, watch=None, ledger=_UNSET_LEDGER):
        watch = watch or load_watch()
        location = self.ledger_path if ledger is _UNSET_LEDGER else ledger
        with patch.dict(os.environ, self.env):
            for offset in offsets:
                watch.run_cycle(self.work, self.tasks, self.decisions, 'orch',
                                now=self.START + offset, ledger=location)
        return watch

    def injects(self, words):
        return [line for line in self.hcom_log.read_text().splitlines()
                if line.startswith('term inject worker') and words in line]

    def notices(self, words):
        return [line for line in self.hcom_log.read_text().splitlines()
                if line.startswith('send ') and words in line]

    def records(self, decision):
        path = self.work / '.lat/watch/orch/watch.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()
                if json.loads(line).get('decision') == decision]

    def deliveries(self):
        state = json.loads((self.work / '.lat/watch/orch/state.json').read_text())
        return state['orch']['ledger']['deliveries']

    def test_unstarted_item_is_nudged_once_ten_minutes_after_dispatch(self):
        self.assign()
        watch = self.cycles(0, 599)
        self.assertEqual(self.injects('Ledger item 1'), [])
        self.cycles(600, 660, watch=watch)
        nudges = self.injects('Ledger item 1 (#1) was assigned to you')
        self.assertEqual(len(nudges), 1)
        self.assertIn(f'start 1 --ledger {self.ledger_path}', nudges[0])
        # A restarted watcher keeps the delivered check.
        self.cycles(720, 780)
        self.assertEqual(len(self.injects('Ledger item 1')), 1)
        [record] = self.records('ledger-start-missing')
        self.assertEqual((record['item'], record['result'], record['agent']), (1, 'sent', 'worker'))
        state = json.loads((self.work / '.lat/watch/orch/state.json').read_text())
        self.assertEqual(state['orch']['feature_versions']['ledger_due'], 1)
        [entry] = state['orch']['ledger']['deliveries'].values()
        self.assertEqual((entry['kind'], entry['status'], entry['sent_at']),
                         ('start', 'sent', self.START + 600))

    def test_passed_estimate_is_nudged_once_and_update_restarts_the_check(self):
        self.assign()
        self.ledger('start', 1, '--eta', '+5m', at=60)
        watch = self.cycles(359, 600)
        self.assertEqual(len(self.injects('passed your estimate')), 1)
        self.assertEqual(self.injects('was assigned to you'), [])
        self.ledger('update', 1, '--eta', '+20m', '--reason', 'tests slow', at=700)
        self.cycles(720, 1899, watch=watch)
        self.assertEqual(len(self.injects('passed your estimate')), 1)
        self.cycles(1900, 1960, watch=watch)
        nudges = self.injects('passed your estimate')
        self.assertEqual(len(nudges), 2)
        self.assertIn('--reason', nudges[1])
        self.assertEqual([r['due'] for r in self.records('ledger-estimate-passed')],
                         ['2026-10-24T00:06:00Z', '2026-10-24T00:31:40Z'])

    def test_deadline_notifies_orchestrator_then_user_ten_minutes_after_delivery(self):
        self.assign(deadline='+30m')
        self.ledger('start', 1, '--eta', '+3h', at=60)
        self.flag('fail')
        watch = self.cycles(1799, 1800)
        # The fake hcom logs the failed attempt too.
        self.assertEqual(len(self.notices('Check the agent')), 1)
        self.flag('fail', present=False)
        self.cycles(1860, 2459, watch=watch)
        notice = self.notices('Check the agent')[-1]
        self.assertIn('--intent request', notice)
        self.assertIn('owned by worker is in_progress', notice)
        self.assertEqual(self.herdr_log.read_text(), '')
        self.cycles(2460, 2520, 4000, watch=watch)
        user = self.notices('The orchestrator was notified 10 minutes ago')
        self.assertEqual(len(user), 1)
        self.assertIn('passed its deadline 2026-10-24T00:30:00Z by 11 minutes', user[0])
        self.assertIn('--intent inform', user[0])
        self.assertEqual(len(self.notices('Check the agent')), 2)
        # The idle orchestrator gets its own stall popup; count only the overdue one.
        popups = [line for line in self.herdr_log.read_text().splitlines()
                  if line.startswith('notification show') and '逾期' in line]
        self.assertEqual(popups, ['notification show claude逾期: worker --sound request'])
        deadline = self.records('ledger-deadline-passed')
        self.assertEqual([r['result'] for r in deadline], ['failed', 'sent'])
        [user_record] = self.records('ledger-user-notified')
        self.assertEqual((user_record['at'], user_record['result']), (self.START + 2460, 'sent'))

    def test_owner_change_after_deadline_notice_keeps_the_user_out(self):
        self.assign(deadline='+30m')
        watch = self.cycles(1800)
        self.ledger('reassign', 1, '--agent', 'worker2', '--reason', 'worker left', at=1900)
        self.cycles(2400, 3000, watch=watch)
        self.assertEqual(len(self.notices('Check the agent')), 1)
        self.assertEqual(self.records('ledger-user-notified'), [])

    def test_block_and_unblock_between_polls_counts_as_handling(self):
        self.assign(deadline='+30m')
        watch = self.cycles(1800)
        self.ledger('block', 1, '--reason', 'waits for TEVU-1', at=1810)
        self.ledger('unblock', 1, '--reason', 'answered', at=1820)
        self.cycles(1860, 2400, 2500, watch=watch)
        self.assertEqual(self.records('ledger-user-notified'), [])

    def test_a_change_just_before_the_notice_still_lets_the_user_be_notified(self):
        self.assign(deadline='+30m')
        self.ledger('block', 1, '--reason', 'waits for TEVU-1', at=1800)
        self.cycles(1800.5, 2401, 2460)
        self.assertEqual(len(self.records('ledger-user-notified')), 1)

    def test_a_delivered_estimate_is_not_repeated_after_block_and_unblock(self):
        self.assign()
        self.ledger('start', 1, '--eta', '+5m', at=60)
        watch = self.cycles(360)
        self.ledger('block', 1, '--reason', 'waits for TEVU-1', at=400)
        self.cycles(420, watch=watch)
        self.ledger('unblock', 1, at=440)
        self.cycles(480, 540, watch=watch)
        self.assertEqual(len(self.injects('passed your estimate')), 1)

    def test_a_new_round_ledger_starts_with_no_deliveries(self):
        self.assign(deadline='+30m')
        watch = self.cycles(1800)
        self.ledger_path = self.work / '.lat/ledgers/next.json'
        self.ledger('init', '--workspace', self.work)
        self.ledger('add', '--ticket', '#1', '--stage', 'impl', '--evidence', 'file')
        self.assign(deadline='+30m')
        self.cycles(1860, watch=watch)
        self.assertEqual(len(self.notices('Check the agent')), 2)

    def test_blocked_item_is_not_nudged_but_its_deadline_is_reported_once(self):
        self.assign(deadline='+30m')
        self.ledger('start', 1, '--eta', '+5m', at=60)
        self.ledger('block', 1, '--reason', 'waits for TEVU-1', at=120)
        self.cycles(700, 1800, 1860)
        self.assertEqual(self.injects('Ledger item'), [])
        [notice] = self.notices('Check the agent')
        self.assertIn('is blocked', notice)

    def test_input_text_send_failure_and_missing_window_retry_until_delivered(self):
        self.assign()
        self.flag('busy')
        watch = self.cycles(600)
        self.flag('busy', present=False)
        self.flag('gone')
        self.cycles(660, watch=watch)
        self.flag('gone', present=False)
        self.flag('fail')
        self.cycles(720, 780, watch=watch)
        self.flag('fail', present=False)
        self.cycles(840, 900, watch=watch)
        self.assertEqual(len([line for line in self.injects('Ledger item 1')]), 3)
        results = [(r['result'], r.get('error', '')) for r in self.records('ledger-start-missing')]
        self.assertEqual([result for result, _ in results], ['failed'] * 3 + ['sent'])
        self.assertEqual(results[0][1], 'input box has text')
        self.assertIn('missing from HCOM list', results[1][1])
        self.assertIn('hcom inject failed', results[2][1])
        self.assertEqual(self.records('ledger-start-missing')[-1]['attempt'], 5)

    def interrupted(self, offset):
        """A watcher that delivers, then dies before its state file is saved."""
        watch = load_watch()
        state = watch.state_path(self.work, 'orch')
        original = watch.write_object

        def write(path, *args, **kwargs):
            if path == state:
                raise OSError('killed before the state save')
            return original(path, *args, **kwargs)

        with patch.object(watch, 'write_object', write), self.assertRaises(OSError):
            self.cycles(offset, watch=watch)

    def test_interrupted_saves_repeat_a_delivery_once_per_interruption(self):
        self.assign()
        self.cycles(0)
        self.interrupted(600)
        self.cycles(660, 720)
        self.assertEqual(len(self.injects('was assigned to you')), 2)
        self.ledger('update', 1, '--deadline', '+1m', '--reason', 'tight', at=730)
        self.interrupted(800)
        self.interrupted(860)
        self.cycles(920, 980)
        self.assertEqual(len(self.notices('Check the agent')), 3)

    def test_normal_operation_never_repeats_a_delivery(self):
        self.assign(deadline='+15m')
        self.cycles(*range(0, 3600, 60))
        self.assertEqual(len(self.injects('was assigned to you')), 1)
        self.assertEqual(len(self.notices('Check the agent')), 1)
        self.assertEqual(len(self.notices('The orchestrator was notified')), 1)

    def test_session_record_names_the_ledger_and_bad_ledgers_are_logged_once(self):
        self.assign()
        skill = self.root / 'skill'
        (skill / 'references').mkdir(parents=True)
        (skill / 'SKILL.md').write_text('rules')
        session = self.work / '.lat/sessions/sid.json'
        session.parent.mkdir(parents=True)
        session.write_text(json.dumps({
            'session_id': 'sid', 'role': 'orchestrator', 'status': 'active',
            'workspace': str(self.work), 'hcom_name': 'orch', 'skill_dir': str(skill),
            'ledger_path': str(self.ledger_path)}))
        watch = self.cycles(600, ledger=None)
        self.assertEqual(len(self.injects('was assigned to you')), 1)
        self.ledger_path.write_text(self.ledger_path.read_text() + ' ')
        self.cycles(660, 720, watch=watch, ledger=None)
        [record] = self.records('ledger-unreadable')
        self.assertIn('seal mismatch', record['error'])
        self.assertIn('start:1:', next(iter(self.deliveries())))
        session.write_text(json.dumps({**json.loads(session.read_text()), 'ledger_path': None}))
        self.cycles(780, watch=watch, ledger=None)
        state = json.loads((self.work / '.lat/watch/orch/state.json').read_text())
        self.assertNotIn('ledger', state['orch'])


if __name__ == '__main__':
    unittest.main()
