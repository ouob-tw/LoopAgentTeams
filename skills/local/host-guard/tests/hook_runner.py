"""Run host-guard's hook inside the test process instead of starting Python per command.

One subprocess per checked command made the suite spend most of its time starting
interpreters (ouob-tw/LoopAgentTeams-work#632). The hook reads the payload on stdin, its
settings from the environment, prints the reason to stderr and returns the exit code, so
the same call runs in-process with those swapped. A few tests still start the real script
to cover the entry point as the clients run it.
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/host-guard.py'


def load():
    spec = importlib.util.spec_from_file_location('host_guard', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load()


def run_hook(payload, env):
    """Run `host-guard.py hook` with payload (a dict, or raw text) on stdin and exactly env as
    the environment; return what subprocess.run(..., capture_output=True, text=True) would."""
    text = payload if isinstance(payload, str) else json.dumps(payload)
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch('sys.stdin', io.StringIO(text)), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = guard.main(['hook'])
    return subprocess.CompletedProcess(['host-guard.py', 'hook'], code, out.getvalue(),
                                       err.getvalue())
