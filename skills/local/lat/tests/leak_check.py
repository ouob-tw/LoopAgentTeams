"""Fail a test that leaves a process or its temp directory behind."""
import os
import signal
import time
from pathlib import Path


def processes_under(root):
    """PIDs (not ours) whose command line mentions `root`."""
    needle = str(root).encode()
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            command = (entry / 'cmdline').read_bytes()
        except OSError:
            continue
        if needle in command:
            found.append((int(entry.name), command.replace(b'\0', b' ').decode(errors='replace')))
    return found


def stop_under(root, timeout=2):
    """Kill, by PID, every process whose command line mentions `root`; wait for them to go."""
    deadline = time.monotonic() + timeout
    while True:
        leftovers = processes_under(root)
        if not leftovers or time.monotonic() > deadline:
            return
        for pid, _ in leftovers:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        time.sleep(0.05)


def register(test, root):
    """Register a final cleanup (call before any other cleanup so it runs last).

    Raises through the test when something started under `root` still runs, or
    `root` still exists. Leftover processes are killed by PID so they do not pile up.
    """
    def check():
        problems = []
        deadline = time.monotonic() + 1
        leftovers = processes_under(root)
        while leftovers and time.monotonic() < deadline:
            time.sleep(0.05)
            leftovers = processes_under(root)
        for pid, command in leftovers:
            problems.append(f'process {pid} still running: {command.strip()[:200]}')
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        if Path(root).exists():
            problems.append(f'temp dir {root} still exists')
        if problems:
            raise AssertionError(f'{test.id()} left behind:\n' + '\n'.join(problems))
    test.addCleanup(check)
