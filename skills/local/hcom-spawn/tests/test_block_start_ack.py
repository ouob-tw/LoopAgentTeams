import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/block-start-ack.py'


def run_hook(command, launcher='vude'):
    env = {k: v for k, v in os.environ.items() if k != 'HCOM_LAUNCHED_BY'}
    if launcher:
        env['HCOM_LAUNCHED_BY'] = launcher
    payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': command}})
    return subprocess.run([sys.executable, str(SCRIPT)], input=payload, env=env,
                          text=True, capture_output=True)


class BlockStartAckTests(unittest.TestCase):
    def test_acknowledgement_to_launcher_is_blocked_with_the_way_out(self):
        for command in (
            "hcom send @vude --intent ack --name bape -- 'Received, starting now.'",
            'hcom send @vude --name bape -- ok',
            "hcom send @vude --name bape -- 'Accepted #78; will implement the label store, "
            "run affected tests, then commit.'",
            "hcom send @vude --intent inform --name bape -- 'Starting #79 in the assigned "
            "worktree. I will read the issue and implement only this scope.'",
            "hcom send @vude --name bape -- 'Re-reviewing only edf2446..abcbe28, read-only.'",
            "hcom send @vude --name bape -- 'Ack. Will gather the evidence after the gate ends.'",
            "hcom send @vude --name bape -- 'Review underway against dev...HEAD, read-only.'",
            "hcom send @vude --name bape -- '收到，開始做'",
            "cd /repo && hcom send @vude --name bape -- 'I will review the pinned diff.'",
            "hcom --name bape send @vude -- 'Starting the review.'",
        ):
            with self.subTest(command=command):
                result = run_hook(command)
                self.assertEqual(result.returncode, 2)
                self.assertIn('ACK_GUARD=off hcom send @vude', result.stderr)

    def test_launcher_base_name_counts_as_the_launcher(self):
        result = run_hook("hcom send @luna --name bape -- 'Starting now.'", launcher='x-luna')
        self.assertEqual(result.returncode, 2)

    def test_results_blockers_questions_and_other_recipients_pass(self):
        for command in (
            "hcom send @vude --intent ack --name bape -- 'Final QA on 09c3018: AC1-AC7 PASS.'",
            "hcom send @vude --name bape -- 'Review complete: FAIL, three reproductions.'",
            "hcom send @vude --name bape -- 'Re-review da276ae..ce01b13: no findings.'",
            "hcom send @vude --name bape -- 'Starting the deploy; I am blocked on the port.'",
            "hcom send @vude --name bape -- 'I will wait; should I use port 7100?'",
            "hcom send @vude --name bape -- 'Review underway. Found likely blocker in parse().'",
            "hcom send @vude --name bape -- 'ok: lidan line has no running process.'",
            "hcom send @vude --name bape -- 'Received the hand-over a1089651; screenshot saved.'",
            "hcom send @vude --intent request --name bape -- 'Starting now.'",
            "hcom send @vude --name bape --file /tmp/report.md",
            "hcom send @vude --thread plan --name bape -- 'Starting now.'",
            "hcom send @vude --name bape <<'EOF'\nStarting now.\nEOF",
            "hcom send @luna --name bape -- 'Starting now.'",
            "hcom send @vude @luna --name bape -- 'Starting now.'",
            "hcom send @vude-t463- --name bape -- 'Starting now.'",
            "ACK_GUARD=off hcom send @vude --name bape -- 'Starting now.'",
            "echo 'hcom send @vude -- Starting now.'",
            "hcom send @vude --name bape -- 'Starting now.",
        ):
            with self.subTest(command=command):
                result = run_hook(command)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_agent_without_a_launcher_is_never_blocked(self):
        result = run_hook("hcom send @vude --name bape -- 'Starting now.'", launcher=None)
        self.assertEqual(result.returncode, 0)

    def test_unreadable_payload_never_blocks(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input='not json',
                                env={**os.environ, 'HCOM_LAUNCHED_BY': 'vude'},
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
