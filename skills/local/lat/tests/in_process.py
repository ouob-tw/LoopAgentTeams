"""Run a LAT script's main() inside the test process, for CLI tests that call it many times.

Starting Python for each command, and flushing every write to disk, was most of the time of
the ledger CLI tests (ouob-tw/LoopAgentTeams-work#632). main() runs with exactly
the given environment, argv, stdin and folder, and the result reads like
subprocess.run(..., capture_output=True, text=True). Flushes are skipped (os.fstat only checks
the handle): no CLI test can observe them, and test_lat_common covers them. Tests that need a
real process (a second writer, an older copy of a script) still start one.
"""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
from unittest import mock


def load(script, name):
    """Import `script` by path under `name`, with its folder importable as a direct start has."""
    folder = str(Path(script).resolve().parent)
    if folder not in sys.path:
        sys.path.insert(0, folder)
    spec = importlib.util.spec_from_file_location(name, script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(module, argv, env, stdin='', cwd=None):
    """`python <module's script> *argv` with env, stdin and cwd, as a CompletedProcess."""
    argv = [str(module.__file__), *map(str, argv)]
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, 'argv', argv), \
            mock.patch.object(sys, 'stdin', io.StringIO(stdin)), \
            mock.patch.object(os, 'fsync', os.fstat), \
            contextlib.chdir(cwd) if cwd else contextlib.nullcontext(), \
            contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = module.main()
        except SystemExit as stop:  # argparse refusing the arguments, or an explicit exit
            code = stop.code if isinstance(stop.code, int) else (0 if stop.code is None else 1)
    return subprocess.CompletedProcess(argv, code or 0, out.getvalue(), err.getvalue())
