import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/block-broadcast.py'


def run_hook(command):
    payload = json.dumps({'tool_name': 'Bash', 'tool_input': {'command': command}})
    return subprocess.run([sys.executable, str(SCRIPT)], input=payload,
                          text=True, capture_output=True)


class BlockBroadcastTests(unittest.TestCase):
    def test_send_without_recipient_is_blocked_with_a_fix_hint(self):
        for command in (
            'hcom send --name vare -- hello everyone',
            'hcom send --intent inform --name vare --file /tmp/note.md',
            'cd /repo && HCOM_DIR=/x /home/swy/.local/bin/hcom send -- done',
            "echo done | hcom send --name vare",
            ['bash', '-lc', 'hcom send -- done'],
            'cd /tmp\nhcom send --name pula -- hello',
            'hcom send @luna -- hi\nhcom send -- everyone',
            'cat <<EOF\n$(hcom send --name pula -- hello)\nEOF',
            'echo "$(hcom send -- hi)"',
            'echo `hcom send -- hi`',
            'command hcom send --name pula -- hello',
            'exec hcom send --name pula -- hello',
            'env -i X=1 hcom send -- hello',
            "bash -c 'hcom send -- hello'",
            'hcom send --title @topic --description desc --name pula -- hello',
            'hcom send --file @note.md --name pula',
            'hcom send -- ok\necho "unterminated',
            '>/tmp/out hcom send -- hello',
            '2>/dev/null hcom send -- hello',
            'cat <(hcom send -- hello)',
            'tee >(hcom send -- hello) < note',
            'env -u HOME hcom send -- hello',
            '/usr/bin/env hcom send -- hello',
            "env -S 'hcom send -- hello'",
            'sudo -u swy timeout 5 hcom send -- hello',
            'if true; then hcom send -- hello; fi',
            '{ hcom send -- hello; }',
            'for x in 1; do hcom send -- hello; done',
            ['bash', '-lc', 'hcom send -- hi; echo "'],
            "bash <<'EOF'\nhcom send --name pula -- hello\nEOF",
            'bash <<EOF\nhcom send --name pula -- hello\nEOF',
            "cat <<'EOF' | sh\nhcom send -- hello\nEOF",
            "bash <<< 'hcom send -- hello'",
            'X=1 hcom send -- hello',
            'if hcom send -- hello; then :; fi',
            '! hcom send -- hello',
            "env bash <<'EOF'\nhcom send --name pula -- hello\nEOF",
            "cat <<< 'hcom send --name pula -- hello' | bash",
        ):
            with self.subTest(command=command):
                result = run_hook(command)
                self.assertEqual(result.returncode, 2)
                self.assertIn('@<tag>-', result.stderr)

    def test_addressed_thread_and_unrelated_commands_pass(self):
        for command in (
            'hcom send @luna --intent request --name vare -- hello',
            'hcom send @vare-review- --name vare --file /tmp/note.md',
            'hcom send --thread plan --name vare -- next step',
            'hcom send --help',
            'hcom list --name vare',
            "hcom send @luna --name vare -- run 'hcom send -- hi' yourself",
            "hcom send @luna --name vare <<'EOF'\nexample: hcom send -- hi\nEOF",
            "grep -n 'hcom send -- ' notes.md",
            'echo "unbalanced',
            "hcom send --title '|' --description desc @vare -- hello",
            'cd /tmp\nhcom send @luna --name vare -- hello',
            "cat <<'EOF'\n$(hcom send -- hi)\nEOF",
            'cat <<EOF\nexample: hcom send -- hi\nEOF\necho done',
            'echo $((1 + 2)) && hcom send @luna -- hi',
            'hcom send --thread=plan -- next',
            'hcom send @luna -- done 2>&1 | tail -1',
            'hcom send @luna --name vare -- please run hcom send -- hi yourself',
            'echo hcom send',
            "printf '%s\\n' hcom send",
            "cat <<'EOF'\nhcom send -- hi\nEOF",
            "bash <<'EOF'\nhcom send @luna -- hi\nEOF",
        ):
            with self.subTest(command=command):
                result = run_hook(command)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_unreadable_payload_never_blocks(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input='not json',
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)


if __name__ == '__main__':
    unittest.main()
