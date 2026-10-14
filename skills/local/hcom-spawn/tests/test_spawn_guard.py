import importlib.util
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
            'hcom list --name vare',
            'hcom 1 gemini --go --name vare',
            'hcom 1 opencode --go',
            'hcom claude --help',
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
                                    'gpt-6.1-sol', '--effort', 'medium', '--after-id', '41'])

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
