import importlib.util
import io
import json
import os
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/spawn-guard.py'
CLAUDE = ('hcom 1 claude --tag vare-review --go --name vare --model claude-opus-5-5 '
          '--effort medium --dangerously-skip-permissions')
CODEX = ("hcom 1 codex --tag vare-review --go --name vare --model gpt-6.1-sol "
         "-c 'model_reasoning_effort=\"medium\"' --yolo")


def run_hook(command):
    """Run the hook with no working hcom on PATH, so allowed launches start no watcher."""
    with tempfile.TemporaryDirectory() as empty:
        env = dict(os.environ, PATH=empty)
        payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': command}})
        return subprocess.run([sys.executable, str(SCRIPT)], input=payload, text=True,
                              capture_output=True, env=env)


def load():
    spec = importlib.util.spec_from_file_location('spawn_guard', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SpawnGuardTests(unittest.TestCase):
    def test_launch_missing_a_flag_is_blocked_with_the_gap_and_an_example(self):
        for command, gap in (
            (CLAUDE.replace(' --dangerously-skip-permissions', ''), '--dangerously-skip-permissions'),
            (CLAUDE.replace(' --model claude-opus-5-5', ''), '--model <id>'),
            (CLAUDE.replace(' --effort medium', ''), '--effort <level>'),
            (CODEX.replace(' --yolo', ''), '--yolo'),
            (CODEX.replace(' --model gpt-6.1-sol', ''), '--model <id>'),
            (CODEX.replace(" -c 'model_reasoning_effort=\"medium\"'", ''),
             'model_reasoning_effort'),
            ('hcom claude --go --name vare', '--dangerously-skip-permissions'),
            ('HERDR_WORKSPACE_ID=w1 hcom 1 claude --terminal herdr --model claude-opus-5-5 '
             '--effort medium', '--dangerously-skip-permissions'),
            ('cd /repo && env X=1 hcom 2 codex --model gpt-6.1-sol --yolo',
             'model_reasoning_effort'),
            ("bash -lc 'hcom 1 claude --model claude-opus-5-5 --effort low'",
             '--dangerously-skip-permissions'),
            (['bash', '-c', 'hcom 1 codex --yolo -m gpt-6.1-sol'], 'model_reasoning_effort'),
            ("hcom 1 claude --model claude-opus-5-5 --effort medium "
             "--hcom-prompt 'remember --dangerously-skip-permissions'",
             '--dangerously-skip-permissions'),
            ('hcom 1 codex --model gpt-6.1-sol --yolo -c model_reasoning_effort=', 'model_reasoning_effort'),
            ('hcom 1 claude --model= --effort medium --dangerously-skip-permissions', '--model <id>'),
            ('hcom 1 claude --effort medium --dangerously-skip-permissions --model', '--model <id>'),
            ('echo start; hcom 1 claude --go "unterminated', 'could not read'),
            ("hcom 1 claude --go --hcom-prompt '--help'", '--dangerously-skip-permissions'),
            ("hcom 1 claude --go --hcom-prompt -h --model m --effort low", '--dangerously-skip-permissions'),
            ('hcom 1 claude --model --effort medium --dangerously-skip-permissions', '--model <id>'),
            ('hcom 1 codex --yolo -m -c model_reasoning_effort=low', '--model <id>'),
            ('hcom --name meru 1 claude --tag t --model opus --effort high', '--dangerously-skip-permissions'),
            ('hcom --name meru 1 codex --tag t --model gpt-6.1-sol --yolo', 'model_reasoning_effort'),
            ('hcom --name=meru claude --effort high --dangerously-skip-permissions', '--model <id>'),
            ('HERDR_WORKSPACE_ID=w1 hcom --name meru 2 codex --go -c model_reasoning_effort="low"', '--yolo'),
            ('env X=1 hcom --go --name meru 1 claude --model m --dangerously-skip-permissions', '--effort <level>'),
            ('hcom --tag codex 1 claude --go --model m --effort low', '--dangerously-skip-permissions'),
            ('hcom --hcom-prompt claude codex --go --yolo --model gpt-6.1-sol', 'model_reasoning_effort'),
            ('hcom --unknown value 1 claude --go', '--dangerously-skip-permissions'),
        ):
            with self.subTest(command=command):
                result = run_hook(command)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(gap, result.stderr)
                self.assertIn('hcom 1 ', result.stderr)

    def test_complete_launches_and_other_commands_pass(self):
        for command in (
            CLAUDE,
            CODEX,
            CLAUDE.replace('--model claude-opus-5-5', '--model=claude-opus-5-5')
                  .replace('--effort medium', '--effort=high'),
            CODEX.replace('--yolo', '--dangerously-bypass-approvals-and-sandbox')
                 .replace('--model gpt-6.1-sol', '-m gpt-6.1-sol'),
            "hcom 1 codex --model gpt-6.1-sol --config model_reasoning_effort='low' --yolo",
            'HERDR_WORKSPACE_ID=w1 ' + CLAUDE + ' --terminal herdr',
            "bash -lc '" + CLAUDE + "'",
            'hcom r vare-review-kilo --go --name vare',
            'hcom f vare-review-kilo --go --name vare --effort high',
            'hcom r kilo --go --name vare -c \'model_reasoning_effort="high"\'',
            'hcom send @luna --name vare -- hcom 1 claude --go',
            'hcom --name vare send @luna -- 1 claude',
            'hcom --name vare r kilo --go',
            '/usr/bin/hcom --name vare ' + CLAUDE[5:],
            'HERDR_WORKSPACE_ID=w1 hcom --name vare ' + CODEX[5:],
            'hcom --tag claude 1 gemini --go',
            'hcom --tag claude 1 ' + CODEX[7:],
            'hcom --hcom-prompt codex 1 ' + CLAUDE[7:],
            'hcom --name claude send @luna -- hi',
            'hcom --tag codex 1 claude --go --model claude-opus-5-5 --effort medium '
            '--dangerously-skip-permissions',
            'hcom --name claude ' + CODEX[5:],
            'hcom list --name vare',
            'hcom 1 gemini --go --name vare',
            'hcom 1 opencode --go',
            'hcom claude --help',
            'hcom 1 codex --model gpt-6.1-sol -h',
            "grep -n 'hcom 1 claude' SKILL.md",
            'echo hcom 1 claude',
            ['hcom', 'events', 'sub', 'list'],
        ):
            with self.subTest(command=command):
                result = run_hook(command)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_unreadable_payload_never_blocks(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input='not json',
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)

    def test_allowed_launch_starts_one_background_watch_per_launch(self):
        guard = load()
        launch = guard.read_launch('codex', shlex.split(CODEX)[3:])
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.dict(os.environ, {'XDG_STATE_HOME': state, 'HCOM_INSTANCE_NAME': 'zeta'}), \
                mock.patch.object(guard.subprocess, 'Popen') as popen:
            guard.start_watch(launch, 41)
            argv = popen.call_args.args[0]
            self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertTrue(argv[1].endswith('spawn-watch.py'))
        self.assertEqual(argv[2:], ['--spawner', 'vare', '--tool', 'codex', '--model',
                                    'gpt-6.1-sol', '--effort', 'medium', '--after-id', '41',
                                    '--tag', 'vare-review'])

    def test_global_options_before_the_client_still_start_the_watch(self):
        guard = load()
        command = ("hcom --name meru 1 codex --tag t --go --model gpt-6.1-sol "
                   "-c 'model_reasoning_effort=\"low\"' --yolo")
        payload = json.dumps({'tool_input': {'command': command}})
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.dict(os.environ, {'XDG_STATE_HOME': state}), \
                mock.patch.object(guard, 'latest_event_id', return_value=55), \
                mock.patch.object(guard.sys, 'stdin', io.StringIO(payload)), \
                mock.patch.object(guard.subprocess, 'Popen') as popen:
            self.assertEqual(guard.main(), 0)
        self.assertEqual(popen.call_args.args[0][2:], [
            '--spawner', 'meru', '--tool', 'codex', '--model', 'gpt-6.1-sol', '--effort', 'low',
            '--after-id', '55', '--tag', 't'])

    def test_multi_line_launch_with_dir_reads_the_same_as_one_line(self):
        for client, flags, model, effort in (
                ('claude', '--model claude-opus-5-5 --effort medium '
                           '--dangerously-skip-permissions', 'claude-opus-5-5', 'medium'),
                ('codex', "--model gpt-6.1-sol -c 'model_reasoning_effort=\"low\"' --yolo",
                 'gpt-6.1-sol', 'low')):
            with self.subTest(client=client):
                guard = load()
                command = (f'hcom 1 {client} --tag t --go --name vare \\\n'
                           f'  --dir /tmp/some-dir \\\n  {flags}')
                payload = json.dumps({'tool_input': {'command': command}})
                with tempfile.TemporaryDirectory() as state, \
                        mock.patch.dict(os.environ, {'XDG_STATE_HOME': state}), \
                        mock.patch.object(guard, 'latest_event_id', return_value=55), \
                        mock.patch.object(guard.sys, 'stdin', io.StringIO(payload)), \
                        mock.patch.object(guard.subprocess, 'Popen') as popen:
                    self.assertEqual(guard.main(), 0)
                self.assertEqual(popen.call_args.args[0][2:], [
                    '--spawner', 'vare', '--tool', client, '--model', model, '--effort', effort,
                    '--after-id', '55', '--tag', 't'])

    def test_previews_start_no_watch(self):
        guard = load()
        command = '; '.join([CLAUDE.replace(' --go', ''), CODEX,
                             CLAUDE.replace('vare-review', 'vare-docs')])
        payload = json.dumps({'tool_input': {'command': command}})
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.dict(os.environ, {'XDG_STATE_HOME': state}), \
                mock.patch.object(guard, 'latest_event_id', return_value=55), \
                mock.patch.object(guard.sys, 'stdin', io.StringIO(payload)), \
                mock.patch.object(guard.subprocess, 'Popen') as popen:
            self.assertEqual(guard.main(), 0)
        started = [(call.args[0][5], call.args[0][-1]) for call in popen.call_args_list]
        self.assertEqual(started, [('codex', 'vare-review'), ('claude', 'vare-docs')])

    def run_main(self, guard, command):
        payload = json.dumps({'tool_input': {'command': command}})
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.dict(os.environ, {'XDG_STATE_HOME': state}), \
                mock.patch.object(guard, 'latest_event_id', return_value=55), \
                mock.patch.object(guard.sys, 'stdin', io.StringIO(payload)), \
                mock.patch.object(guard.subprocess, 'Popen') as popen:
            self.assertEqual(guard.main(), 0)
        return [call.args[0][2:] for call in popen.call_args_list]

    def test_variable_tag_is_passed_to_the_watch_unexpanded(self):
        guard = load()
        started = self.run_main(guard, CLAUDE.replace('vare-review', 'vare-t$n'))
        self.assertEqual(started, [['--spawner', 'vare', '--tool', 'claude', '--model',
                                    'claude-opus-5-5', '--effort', 'medium', '--after-id', '55',
                                    '--tag', 'vare-t$n']])

    def test_launch_in_a_loop_starts_a_watch_that_keeps_looking(self):
        guard = load()
        launch = CLAUDE.replace('vare-review', 'vare-t$n')
        for command in (f'for n in 1 2 3; do {launch}; done',
                        f'n=0; while [ $n -lt 3 ]; do n=$((n+1)); {launch}; done',
                        f"bash -c 'for n in 1 2; do {launch}; done'",
                        f'seq 3 | xargs -I{{}} {launch}'):
            with self.subTest(command=command):
                started = self.run_main(guard, command)
                self.assertEqual(len(started), 1)
                self.assertEqual(started[0][-1], '--repeat')

    def test_loop_words_inside_a_prompt_are_not_a_loop(self):
        guard = load()
        started = self.run_main(guard, CLAUDE + " --hcom-prompt 'for each file; do review'")
        self.assertNotIn('--repeat', started[0])

    def test_failing_to_start_the_watch_does_not_block_the_launch(self):
        guard = load()
        payload = json.dumps({'tool_input': {'command': CLAUDE}})
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.dict(os.environ, {'XDG_STATE_HOME': state}), \
                mock.patch.object(guard, 'latest_event_id', return_value=55), \
                mock.patch.object(guard.sys, 'stdin', io.StringIO(payload)), \
                mock.patch.object(guard.subprocess, 'Popen', side_effect=OSError('no python')):
            self.assertEqual(guard.main(), 0)

    def test_spawner_falls_back_to_own_hcom_name_and_no_name_means_no_watch(self):
        guard = load()
        launch = guard.read_launch('claude', ['--model', 'm', '--effort', 'low'])
        with tempfile.TemporaryDirectory() as state, \
                mock.patch.object(guard.subprocess, 'Popen') as popen:
            with mock.patch.dict(os.environ, {'XDG_STATE_HOME': state, 'HCOM_INSTANCE_NAME': 'zeta'}):
                guard.start_watch(launch, 7)
            self.assertEqual(popen.call_args.args[0][3], 'zeta')
            popen.reset_mock()
            env = {k: v for k, v in os.environ.items() if k != 'HCOM_INSTANCE_NAME'}
            with mock.patch.dict(os.environ, dict(env, XDG_STATE_HOME=state), clear=True):
                guard.start_watch(launch, 7)
                guard.start_watch(dict(launch, name='vare'), None)
            popen.assert_not_called()


if __name__ == '__main__':
    unittest.main()
