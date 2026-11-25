"""Stand-in for `ps`, `adb`, `kill` and the Android `emulator` in the vm tests.

Called as `fake_android.py <role> <args...>`. FAKE_ANDROID_STATE holds
{"procs": {pid: argv}, "next_pid": int, "fail_start": [avd], "crash_after_start": [avd]
 (the process is gone after the next ps), "ignore_emu_kill": [avd],
 "ignore_term": [avd], "ignore_kill": [avd], "ps_fail": bool, "adb_fail": bool}.
Every call except ps is appended to FAKE_EVENTS. Only the exact call shapes vm.py may use
are accepted; anything else fails like a wrong call to the real program."""
import fcntl
import json
import os
import sys
from pathlib import Path

ENGINE = '/fake-sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless'
BOOT = ['-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect']
state_path = Path(os.environ['FAKE_ANDROID_STATE'])
role, args = sys.argv[1], sys.argv[2:]


def fail(text, code=1):
    print(text, file=sys.stderr)
    sys.exit(code)


def avd_of(argv):
    return argv[argv.index('-avd') + 1] if '-avd' in argv else None


def port_of(argv):
    return int(argv[argv.index('-port') + 1]) if '-port' in argv else None


with open(state_path.with_suffix('.lock'), 'a') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    state = json.loads(state_path.read_text())
    procs = state.setdefault('procs', {})
    if role != 'ps':
        with open(os.environ['FAKE_EVENTS'], 'a') as events:
            events.write(json.dumps([role, *args]) + '\n')
    if role == 'ps':
        if args != ['-ww', '-eo', 'pid=,args=']:
            fail(f'fake ps: unexpected call {args}')
        if state.get('ps_fail'):
            fail('ps: cannot read /proc')
        for pid, argv in sorted(procs.items(), key=lambda item: int(item[0])):
            print(f'{int(pid):>7} {" ".join(argv)}')
        for pid in state.pop('crashing', []):  # an engine that dies right after it shows up
            procs.pop(pid, None)
        state_path.write_text(json.dumps(state))
        sys.exit(0)
    if role == 'adb':
        if state.get('adb_fail'):
            fail('adb: cannot connect to daemon')
        if args == ['devices']:
            print('List of devices attached')
            for argv in procs.values():
                if avd_of(argv) and port_of(argv):
                    print(f'emulator-{port_of(argv)}\tdevice')
            for port in state.get('devices', []):
                print(f'emulator-{port}\toffline')
            sys.exit(0)
        if len(args) != 4 or args[0] != '-s' or args[2:] != ['emu', 'kill'] \
                or not args[1].startswith('emulator-'):
            fail(f'fake adb: unexpected call {args}')
        port = int(args[1].split('-', 1)[1])
        mine = [pid for pid, argv in procs.items() if port_of(argv) == port and avd_of(argv)]
        if not mine:
            fail(f"adb: device '{args[1]}' not found")
        if avd_of(procs[mine[0]]) in state.get('ignore_emu_kill', []):
            print('OK: killing emulator, bye bye')
            sys.exit(0)
        for pid in mine:
            procs.pop(pid)
        print('OK: killing emulator, bye bye')
    elif role == 'kill':
        if len(args) != 2 or args[0] not in ('-TERM', '-KILL') or not args[1].isdigit():
            fail(f'fake kill: unexpected call {args}', 2)
        argv = procs.get(args[1])
        if argv is None:
            fail(f'kill: ({args[1]}) - No such process')
        ignore = 'ignore_term' if args[0] == '-TERM' else 'ignore_kill'
        if avd_of(argv) not in state.get(ignore, []):
            procs.pop(args[1])
    elif role == 'emulator':
        avd = args[1] if args[:1] == ['-avd'] and len(args) > 1 else None
        if not avd or args[2:3] != ['-port'] or len(args) < 4 or not args[3].isdigit() \
                or args[4:4 + len(BOOT)] != BOOT:
            fail(f'fake emulator: unexpected call {args}')
        port = int(args[3])
        home, sdk = os.environ.get('ANDROID_AVD_HOME'), os.environ.get('ANDROID_SDK_ROOT')
        if not home or not (Path(home) / f'{avd}.ini').is_file():
            fail(f'FATAL | Unknown AVD name [{avd}], use -list-avds to see valid list.')
        if not sdk or os.environ.get('ANDROID_HOME') != sdk:
            fail('FATAL | ANDROID_SDK_ROOT is not set')
        if port % 2 or not 5554 <= port <= 5682:
            fail(f'FATAL | invalid port {port}')
        if any(port_of(a) == port for a in procs.values()):
            fail(f'FATAL | port {port} is busy')
        if any(avd_of(a) == avd for a in procs.values()):
            fail(f'FATAL | Running multiple emulators with the same AVD [{avd}]')
        if avd in state.get('fail_start', []):
            fail('FATAL | broken system image')
        pid = str(state.get('next_pid', 4000))
        state['next_pid'] = int(pid) + 1
        procs[pid] = [ENGINE, *args]
        if avd in state.get('crash_after_start', []):
            state.setdefault('crashing', []).append(pid)
        print(f'INFO | started {avd} on {port}')
    else:
        fail(f'fake android: unknown role {role}', 2)
    state_path.write_text(json.dumps(state))
