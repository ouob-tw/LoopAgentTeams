"""Fail a test that leaves a process or its temp directory behind."""
import ctypes
import os
import signal
import time
from pathlib import Path

# Some Python builds lack os.pidfd_open / signal.pidfd_send_signal; the syscall numbers
# are the same on every Linux architecture that has them.
_libc = ctypes.CDLL(None, use_errno=True)
_SYS_PIDFD_OPEN, _SYS_PIDFD_SEND_SIGNAL = 434, 424


def _pidfd_open(pid):
    fd = _libc.syscall(_SYS_PIDFD_OPEN, pid, 0)
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'pidfd_open')
    return fd


def _pidfd_kill(fd):
    if _libc.syscall(_SYS_PIDFD_SEND_SIGNAL, fd, signal.SIGKILL, None, 0) < 0:
        raise OSError(ctypes.get_errno(), 'pidfd_send_signal')


def owned_processes(root):
    """(pidfd, pid, command) for processes (not ours) with an argv entry at or under `root`.

    The pidfd is opened before argv is read, so signalling through it can never reach a
    process that reused the PID. The caller closes the fds.
    """
    root = str(root)
    found = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        pid = int(entry.name)
        try:
            fd = _pidfd_open(pid)
        except OSError:
            continue
        try:
            argv = [a.decode(errors='replace') for a in (entry / 'cmdline').read_bytes().split(b'\0') if a]
        except OSError:
            argv = []
        if any(a == root or a.startswith(root + '/') or ('=' in a and a.split('=', 1)[1].startswith(root + '/'))
               for a in argv):
            found.append((fd, pid, ' '.join(argv)))
        else:
            os.close(fd)
    return found


def kill(owned):
    for fd, _, _ in owned:
        try:
            _pidfd_kill(fd)
        except OSError:
            pass
        os.close(fd)


def release(owned):
    for fd, _, _ in owned:
        os.close(fd)


def stop_under(root, timeout=2):
    """Kill every process owned by `root` through its pidfd; wait for them to go."""
    deadline = time.monotonic() + timeout
    while True:
        owned = owned_processes(root)
        if not owned or time.monotonic() > deadline:
            release(owned)
            return
        kill(owned)
        time.sleep(0.05)


def register(test, root):
    """Register a final cleanup (call before any other cleanup so it runs last).

    Raises through the test when something started under `root` still runs, or
    `root` still exists. Leftover processes are killed so they do not pile up.
    """
    def check():
        problems = []
        deadline = time.monotonic() + 1
        owned = owned_processes(root)
        while owned and time.monotonic() < deadline:
            release(owned)
            time.sleep(0.05)
            owned = owned_processes(root)
        for _, pid, command in owned:
            problems.append(f'process {pid} still running: {command[:200]}')
        kill(owned)
        if Path(root).exists():
            problems.append(f'temp dir {root} still exists')
        if problems:
            raise AssertionError(f'{test.id()} left behind:\n' + '\n'.join(problems))
    test.addCleanup(check)
