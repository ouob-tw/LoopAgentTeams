"""Behavior and CLI contract tests for the LAT stall watcher."""
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
        state, actions = watch.decide(state, first, now=600)
        self.assertEqual(actions, (watch.Action('nudge', 'zero'),))
        state, actions = watch.decide(state, first, now=2400)
        self.assertEqual(actions, ())

    def test_dune_new_event_resets_the_clock_and_allows_a_later_nudge(self):
        watch = load_watch()
        idle = watch.Observation('dune', 'listening', True, False, 200, 2_000, 17726)
        state, _ = watch.decide(None, idle, now=0)
        progressed = idle._replace(transcript_size=250, event_id=17735)

        state, actions = watch.decide(state, progressed, now=300)
        self.assertEqual(actions, ())
        self.assertFalse(state['nudged'])
        state, actions = watch.decide(state, progressed, now=899)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, progressed, now=900)
        self.assertEqual(actions, (watch.Action('nudge', 'dune'),))

    def test_damo_running_command_is_not_nudged_and_completion_restarts_clock(self):
        watch = load_watch()
        running = watch.Observation('damo', 'listening', True, True, 300, 3_000, 41520)
        state, _ = watch.decide(None, running, now=0)

        state, actions = watch.decide(state, running, now=1200)
        self.assertEqual(actions, ())
        completed = running._replace(command_running=False, transcript_size=350,
                                     event_id=41705)
        state, actions = watch.decide(state, completed, now=1201)
        self.assertEqual(actions, ())
        state, actions = watch.decide(state, completed, now=1801)
        self.assertEqual(actions, (watch.Action('nudge', 'damo'),))

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
        delivered = [{'type': 'message', 'msg_delivered_to': ['worker']}]
        replied = [{'type': 'message', 'msg_from': 'reviewer'}]

        self.assertEqual(watch.wait_release_reason(declaration, delivered, [], None),
                         'message-delivered')
        self.assertEqual(watch.wait_release_reason(declaration, [], replied, None),
                         'target-replied')
        self.assertEqual(watch.wait_release_reason(declaration, [], [], False),
                         'decision-resolved')
        self.assertIsNone(watch.wait_release_reason(declaration, [], [], True))

    def test_future_owner_handling_observation_can_clear_stall_state(self):
        watch = load_watch()
        idle = watch.Observation('worker', 'listening', True, False, 10, 10, 1)
        state, _ = watch.decide(None, idle, now=0)
        state, _ = watch.decide(state, idle, now=600)

        handled = idle._replace(handled=True)
        state, actions = watch.decide(state, handled, now=601)

        self.assertEqual(actions, ())
        self.assertFalse(state['nudged'])
        self.assertEqual(state['last_progress_at'], 601)


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


if __name__ == '__main__':
    unittest.main()
