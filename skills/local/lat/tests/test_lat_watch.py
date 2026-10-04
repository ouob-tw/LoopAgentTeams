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
        state, actions = watch.decide(state, first, now=599)
        self.assertEqual(actions, ())
        heartbeat = first._replace(event_id=9155)
        state, actions = watch.decide(state, heartbeat, now=60)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, heartbeat, now=659)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, heartbeat, now=660)
        self.assertEqual(actions, (watch.Action('nudge', 'zero'),))
        state, actions = watch.decide(state, heartbeat, now=2400)
        self.assertEqual(actions, ())

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
        state, actions = watch.decide(state, completed, now=3600)
        self.assertEqual(actions, ())

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

    def test_uncommitted_prompt_text_is_untouched_by_this_ticket(self):
        watch = load_watch()
        typed = watch.Observation('writer', 'listening', False, False, 10, 10, 1)
        state, _ = watch.decide(None, typed, now=0)

        state, actions = watch.decide(state, typed, now=3600)
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
        client = watch.Process(10, 1, 100, 'S', ('codex',), ('HCOM_INSTANCE_NAME=worker',))
        command = watch.Process(11, 10, 101, 'S', ('uv', 'run', 'tests'),
                                ('HCOM_INSTANCE_NAME=worker',))

        self.assertTrue(watch.background_process_running(
            'worker', info, [client, command], current_pid=99))
        self.assertFalse(watch.background_process_running(
            'worker', info, [client], current_pid=99))


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
        hcom = binary / 'hcom'
        hcom.write_text(
            '#!/bin/sh\n'
            'printf "%s\\n" "$*" >> "$FAKE_HCOM_LOG"\n'
            'printf \'%s\\n\' \'[{"name":"orch","status":"listening"},'
            '{"name":"worker-open","status":"listening"},'
            '{"name":"worker-merged","status":"listening"}]\'\n'
        )
        hcom.chmod(0o755)
        self.env = dict(os.environ, PATH=f'{binary}:{os.environ["PATH"]}',
                        FAKE_HCOM_LOG=str(self.hcom_log))

    def write_task(self, relative, agent, orchestrator, status):
        path = self.tasks / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            f'- agent：{agent} (Codex)\n'
            f'- orchestrator：{orchestrator}\n'
            f'- status：{status}\n'
        )

    def cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *map(str, args)],
                              text=True, capture_output=True, cwd=self.work, env=self.env)

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


if __name__ == '__main__':
    unittest.main()
