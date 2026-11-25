#!/usr/bin/env python3
"""Lend the host's virtual machines (full-OS Docker containers and the host's Android
emulators) to agents and the user.

`vm.py <action>` is the borrowing command; `vm.py watch` is the single watcher that
reminds, expires, reclaims and powers off. Both take one lock around every state change.
Standard library only. Times are stored and computed in UTC and shown in Asia/Taipei.

Replaceable for tests (environment variables):
  VM_HOME     data root (default ~/vm); --root overrides it
  VM_DOCKER   docker command (default `docker`), split like a shell would
  VM_HCOM     hcom command (default `hcom`)
  VM_MEMINFO  meminfo file (default /proc/meminfo)
  VM_NOW      fixed current time, ISO 8601 with offset
  VM_PS       process lister (default `ps`), called as `ps -ww -eo pid=,args=`
  VM_ADB      adb command (default `adb`)
  VM_KILL     kill command (default `kill`), called as `kill -TERM|-KILL <pid>`
  VM_EMULATOR emulator command (default <SDK>/emulator/emulator of the AVD's SDK)
  VM_ANDROID_AVD_DIRS  AVD folders to search, separated by `:` (default: see avd_dirs)
  VM_ANDROID_SDKS      Android SDK roots to search, separated by `:` (default: see sdk_roots)
  VM_ANDROID_STOP_WAIT seconds to wait for a graceful emulator stop (default 120)

Safety: with a data root in a temporary folder (tests, trials), a program whose variable
above is unset is never run; the call fails instead, so a test can never reach the host's
real containers, emulators or agents. VM_REAL_HOST=1 lifts that on purpose.
"""
import argparse
import datetime as dt
import fcntl
import glob
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    TAIPEI = ZoneInfo('Asia/Taipei')
except Exception:  # no tz database on this host: Taipei has no daylight saving
    TAIPEI = dt.timezone(dt.timedelta(hours=8), 'Asia/Taipei')

UTC = dt.timezone.utc
HUMAN = '使用者'
DEFAULT_HOURS = 3.0
MAX_HOURS = 8.0
RESERVE_GB = 8.0
STOP_GRACE_SECONDS = 120
WARN_BEFORE = dt.timedelta(minutes=10)
ABSENT_LIMIT = dt.timedelta(minutes=30)
BOOT_WINDOW = dt.timedelta(minutes=10)
STOP_FAILED_NOTIFY_EVERY = dt.timedelta(minutes=10)
LOCK_WAIT_SECONDS = 600
WATCH_INTERVAL_SECONDS = 30

MACHINES_FILE = 'machines.json'
LEASES_FILE = 'leases.json'
STATE_FILE = 'watch-state.json'
LOG_FILE = 'vm.log'
LOCK_FILE = '.lock'

NAME_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,31}$')
CONTAINER_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]*$')

# Android emulators: one lease per AVD, keyed `android:<AVD name>`.
ANDROID = 'android'
ANDROID_PREFIX = ANDROID + ':'
AVD_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
ANDROID_PORTS = range(5554, 5684, 2)  # emulator console ports; adb serial emulator-<port>
ANDROID_OVERHEAD_GB = 2.0  # emulator process memory on top of the AVD's hw.ramSize
ANDROID_DEFAULT_GB = 4.0  # need when the AVD's hw.ramSize cannot be read
ANDROID_START_WAIT_SECONDS = 30
ANDROID_TERM_WAIT_SECONDS = 15
ANDROID_UNLEASED_GRACE = dt.timedelta(minutes=10)
ANDROID_BOOT_ARGS = ['-no-window', '-no-audio', '-no-boot-anim', '-gpu', 'swiftshader_indirect']
ANDROID_RESERVED_ARGS = {'-avd', '-port', '-ports', '-no-window'}

STATUS_OFF = '關機'
STATUS_BOOTING = '開機中'
STATUS_RUNNING = '執行中'
STATUS_STOP_FAILED = '關機失敗'


class Refused(Exception):
    """An action that is not allowed; the message says why and what to do next."""


# ---------------------------------------------------------------- time

def now():
    fixed = os.environ.get('VM_NOW')
    if fixed:
        moment = dt.datetime.fromisoformat(fixed)
        if moment.tzinfo is None:
            raise ValueError('VM_NOW needs a UTC offset, e.g. 2026-11-17T00:00:00+00:00')
        return moment.astimezone(UTC)
    return dt.datetime.now(UTC)


def iso(moment):
    return moment.astimezone(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse(text):
    return dt.datetime.fromisoformat(text.replace('Z', '+00:00')).astimezone(UTC)


def taipei(moment):
    return moment.astimezone(TAIPEI).strftime('%Y-%m-%d %H:%M') + '（台北）'


def remaining(moment, current):
    seconds = int((moment - current).total_seconds())
    if seconds <= 0:
        return '已到期'
    hours, rest = divmod(seconds // 60, 60)
    return f'剩 {hours} 小時 {rest} 分' if hours else f'剩 {rest} 分'


# ---------------------------------------------------------------- files

def data_root(arg=None):
    return Path(arg or os.environ.get('VM_HOME') or Path.home() / 'vm').expanduser()


def read_json(path, default):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def write_json(path, data):
    tmp = path.with_name(path.name + f'.tmp{os.getpid()}')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    os.replace(tmp, path)


class Store:
    """The files under the data root. Every change happens inside `locked()`."""

    def __init__(self, root):
        self.root = Path(root)

    def machines(self):
        return read_json(self.root / MACHINES_FILE, {'machines': {}})['machines']

    def save_machines(self, machines):
        write_json(self.root / MACHINES_FILE, {'machines': machines})

    def leases(self):
        return read_json(self.root / LEASES_FILE, {'leases': {}})['leases']

    def save_leases(self, leases):
        write_json(self.root / LEASES_FILE, {'leases': leases})

    def state(self):
        return read_json(self.root / STATE_FILE, {'low_memory': False})

    def save_state(self, state):
        write_json(self.root / STATE_FILE, state)

    def log(self, action, machine, borrower, reason, by):
        entry = {'time': iso(now()), 'action': action, 'machine': machine,
                 'borrower': borrower, 'reason': reason, 'by': by}
        with open(self.root / LOG_FILE, 'a') as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + '\n')

    def locked(self, wait=LOCK_WAIT_SECONDS):
        return Lock(self.root / LOCK_FILE, wait)


class Lock:
    def __init__(self, path, wait):
        self.path, self.wait = path, wait

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, 'a')
        deadline = time.monotonic() + self.wait
        told = False
        while True:
            try:
                fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    self.handle.close()
                    raise Refused('等了太久還拿不到 vm 的鎖（可能有機器正在關機），稍後再試。')
                if not told:
                    print('另一個 vm 動作進行中，等待它完成…', file=sys.stderr)
                    told = True
                time.sleep(0.2)

    def __exit__(self, *exc):
        fcntl.flock(self.handle, fcntl.LOCK_UN)
        self.handle.close()


# ---------------------------------------------------------------- outside world

PROGRAM_VARS = ('VM_DOCKER', 'VM_HCOM', 'VM_PS', 'VM_ADB', 'VM_KILL', 'VM_EMULATOR')
TEMP_FOLDERS = ('/tmp', '/var/tmp', '/dev/shm')
ROOT = {'path': None}  # the data root of this run, set by Vm


class RealHostBlocked(OSError):
    """A real host program asked for while the data root is a temporary folder."""


def temporary(path):
    real = os.path.realpath(path)
    return any(real == t or real.startswith(t.rstrip('/') + '/')
               for t in {os.path.realpath(tempfile.gettempdir()),
                         *map(os.path.realpath, TEMP_FOLDERS)})


def command(var, default):
    """The program for `var`: its value when set, else the real `default`, which is refused
    for a data root in a temporary folder unless VM_REAL_HOST=1."""
    given = os.environ.get(var)
    if given:
        return shlex.split(given)
    root = ROOT['path']
    if root is not None and temporary(root) and os.environ.get('VM_REAL_HOST') != '1':
        raise RealHostBlocked(f'{var} 沒設定，且資料根目錄 {root} 在暫存資料夾，'
                              f'不執行主機上真正的 {default}（測試請給假程式）')
    return shlex.split(default)


class Docker:
    def _run(self, args, timeout=60):
        try:
            return subprocess.run(command('VM_DOCKER', 'docker') + args, capture_output=True,
                                  text=True, timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return subprocess.CompletedProcess(args, 1, '', str(exc))

    def running(self, container):
        """True or False; None when the container does not exist or docker failed."""
        result = self._run(['inspect', '-f', '{{.State.Running}}', container])
        if result.returncode != 0:
            return None
        return result.stdout.strip() == 'true'

    def start(self, container):
        """None on success, else the reason."""
        result = self._run(['start', container], timeout=120)
        if result.returncode != 0:
            return (result.stderr or result.stdout).strip() or f'exit {result.returncode}'
        if self.running(container) is not True:
            return 'docker start 回報成功，但容器沒有在執行'
        return None

    def stop(self, container):
        """Graceful stop with a 2-minute grace; None on success, else the reason."""
        result = self._run(['stop', '-t', str(STOP_GRACE_SECONDS), container],
                           timeout=STOP_GRACE_SECONDS + 60)
        if result.returncode != 0:
            return (result.stderr or result.stdout).strip() or f'exit {result.returncode}'
        if self.running(container):
            return 'docker stop 回報成功，但容器還在執行'
        return None


class Hcom:
    def _run(self, args):
        try:
            return subprocess.run(command('VM_HCOM', 'hcom') + args, capture_output=True,
                                  text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return subprocess.CompletedProcess(args, 1, '', str(exc))

    def send(self, name, text):
        """True when hcom accepted the message."""
        return self._run(['send', f'@{name}', '--from', 'vm', '--intent', 'inform',
                          '--', text]).returncode == 0

    def present(self):
        """Names of agents alive on HCOM; None when hcom could not be asked."""
        result = self._run(['list', '--json'])
        if result.returncode != 0:
            return None
        try:
            agents = json.loads(result.stdout)
        except ValueError:
            return None
        names = set()
        for agent in agents:
            if agent.get('status') == 'inactive':
                continue
            names.update(n for n in (agent.get('name'), agent.get('base_name')) if n)
        return names


def available_gb():
    path = os.environ.get('VM_MEMINFO') or '/proc/meminfo'
    for line in Path(path).read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1]) / 1024 / 1024
    raise RuntimeError(f'{path} has no MemAvailable line')


# ---------------------------------------------------------------- Android emulators

def emulator_avd(argv):
    """The AVD name an emulator process runs, or None when argv is not an Android emulator.
    Only the SDK's `emulator` launcher or its `qemu-system-*` engine given an AVD (`-avd NAME`
    or `@NAME`) counts, so Docker VMs' qemu (no AVD) and other programs are never matched."""
    if not argv:
        return None
    program = os.path.basename(argv[0])
    if program != 'emulator' and not program.startswith('qemu-system-'):
        return None
    for i, word in enumerate(argv[1:], 1):
        if word == '-avd' and i + 1 < len(argv):
            return argv[i + 1]
        if word.startswith('@') and len(word) > 1:
            return word[1:]
    return None


def emulator_port(argv):
    """The console port in an emulator's arguments (`-port N` or `-ports N,M`), or None."""
    for i, word in enumerate(argv[:-1]):
        if word in ('-port', '-ports'):
            first = argv[i + 1].split(',')[0]
            return int(first) if first.isdigit() else None
    return None


def ram_gb(config):
    """hw.ramSize of an AVD config.ini in G ('2G', '3072M', '2048' meaning MB), or None."""
    try:
        text = Path(config).read_text(errors='replace')
    except OSError:
        return None
    for line in text.splitlines():
        key, _, value = line.partition('=')
        if key.strip() != 'hw.ramSize':
            continue
        match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*([GgMm]?)[Bb]?\s*', value)
        if not match:
            return None
        number = float(match.group(1))
        return number if match.group(2).lower() == 'g' else number / 1024
    return None


def config_value(config, wanted):
    try:
        for line in Path(config).read_text(errors='replace').splitlines():
            key, _, value = line.partition('=')
            if key.strip() == wanted:
                return value.strip()
    except OSError:
        pass
    return None


def path_list(var):
    value = os.environ.get(var)
    return None if value is None else [Path(p).expanduser() for p in value.split(':') if p]


def sdk_roots():
    """Android SDK roots that have an emulator, in search order."""
    given = path_list('VM_ANDROID_SDKS')
    if given is None:
        home = Path.home()
        given = [Path(p) for p in (os.environ.get('ANDROID_HOME'),
                                   os.environ.get('ANDROID_SDK_ROOT')) if p]
        given += [home / 'Android/Sdk', home / 'Android/sdk', home / 'android-sdk']
    roots = []
    for root in given:
        if (root / 'emulator/emulator').exists() and root not in roots:
            roots.append(root)
    return roots


def avd_dirs():
    """Folders that hold AVDs (`<name>.ini` + `<name>.avd/`), in search order: $ANDROID_AVD_HOME,
    ~/.android/avd, each SDK root's avd/, then ~/Android/*avd* (custom ANDROID_AVD_HOME folders)."""
    given = path_list('VM_ANDROID_AVD_DIRS')
    if given is None:
        home = Path.home()
        given = [Path(p) for p in (os.environ.get('ANDROID_AVD_HOME'),) if p]
        given += [home / '.android/avd', *(r / 'avd' for r in sdk_roots())]
        given += [Path(p) for p in sorted(glob.glob(str(home / 'Android/*avd*')))]
    dirs = []
    for folder in given:
        if folder.is_dir() and folder.resolve() not in [d.resolve() for d in dirs]:
            dirs.append(folder)
    return dirs


class Android:
    """The host's Android emulators: find AVDs, list, start and stop emulator processes.
    Every outside program (ps, adb, kill, emulator) is replaceable through VM_* variables."""

    def _run(self, var, default, args, timeout=30):
        try:
            return subprocess.run(command(var, default) + args, capture_output=True, text=True,
                                  timeout=timeout)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return subprocess.CompletedProcess(args, 1, '', str(exc))

    def avds(self):
        """{AVD name: [folder, ...]} of every AVD in the searched folders."""
        found = {}
        for folder in avd_dirs():
            for ini in sorted(folder.glob('*.ini')):
                if (folder / (ini.stem + '.avd')).is_dir() or config_value(ini, 'path'):
                    found.setdefault(ini.stem, []).append(folder)
        return found

    def find(self, name):
        """{'avd', 'avd_home', 'sdk', 'memory_gb'} of a borrowable AVD, or Refused."""
        avds = self.avds()
        homes = avds.get(name)
        if not homes:
            names = '、'.join(sorted(avds)) or '（沒有找到任何模擬器）'
            searched = '、'.join(str(d) for d in avd_dirs()) or '（沒有模擬器資料夾）'
            raise Refused(f'找不到模擬器「{name}」。可借的模擬器：{names}（搜尋 {searched}）。'
                          '用 vm list android 查看，或先用 avdmanager create avd 建立。')
        if len(homes) > 1:
            raise Refused(f'模擬器「{name}」同時在 {"、".join(map(str, homes))}，vm 分不出要開哪一台。'
                          '用 avdmanager move avd -n 改掉其中一台的名稱後再借。')
        home = homes[0]
        folder = Path(config_value(home / f'{name}.ini', 'path') or home / f'{name}.avd')
        config = folder / 'config.ini'
        image = config_value(config, 'image.sysdir.1')
        roots = sdk_roots()
        sdk = next((r for r in roots if image and (r / image).is_dir()), None)
        if sdk is None:
            where = '、'.join(map(str, roots)) or '（主機上沒找到有 emulator 的 SDK）'
            raise Refused(f'模擬器「{name}」的系統映像 {image or "（config.ini 沒寫）"} 不在任何 '
                          f'Android SDK 裡（找過 {where}）。先用 sdkmanager 安裝該映像。')
        ram = ram_gb(config)
        need = ram + ANDROID_OVERHEAD_GB if ram else ANDROID_DEFAULT_GB
        return {'avd': name, 'avd_home': str(home), 'sdk': str(sdk), 'memory_gb': round(need, 2)}

    def processes(self):
        """[{'pid', 'avd', 'port'}] of running Android emulator processes; None when ps failed."""
        result = self._run('VM_PS', 'ps', ['-ww', '-eo', 'pid=,args='])
        if result.returncode != 0:
            return None
        found = []
        for line in result.stdout.splitlines():
            pid, _, args = line.strip().partition(' ')
            if not pid.isdigit():
                continue
            argv = args.split()
            avd = emulator_avd(argv)
            if avd:
                found.append({'pid': int(pid), 'avd': avd, 'port': emulator_port(argv)})
        return found

    def running(self, avd):
        """True or False; None when the process list could not be read."""
        procs = self.processes()
        return None if procs is None else any(p['avd'] == avd for p in procs)

    def adb_ports(self):
        """Console ports of emulators adb knows (`emulator-<port>`); empty when adb failed."""
        result = self._run('VM_ADB', 'adb', ['devices'])
        return {int(m.group(1)) for m in re.finditer(r'^emulator-(\d+)\s', result.stdout, re.M)} \
            if result.returncode == 0 else set()

    def start(self, info, port, extra, log_path):
        """Start the AVD without a window on `port`; None once its process runs, else the reason."""
        sdk = Path(info['sdk'])
        args = ['-avd', info['avd'], '-port', str(port), *ANDROID_BOOT_ARGS, *extra]
        env = {**os.environ, 'ANDROID_HOME': str(sdk), 'ANDROID_SDK_ROOT': str(sdk),
               'ANDROID_AVD_HOME': info['avd_home']}
        log_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            program = command('VM_EMULATOR', shlex.quote(str(sdk / 'emulator/emulator')))
            with open(log_path, 'w') as log:
                child = subprocess.Popen(program + args, env=env, stdin=subprocess.DEVNULL,
                                         stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)
        except OSError as exc:
            return f'無法執行模擬器程式：{exc}'
        deadline = time.monotonic() + ANDROID_START_WAIT_SECONDS
        while True:
            if self.running(info['avd']):
                return None
            code = child.poll()
            if code is not None and self.running(info['avd']):
                return None  # the launcher handed over to the engine and exited
            if code is not None or time.monotonic() >= deadline:
                if code is None:
                    child.kill()
                    child.wait()
                tail = log_tail(log_path)
                what = f'模擬器程式結束（exit {code}）' if code is not None else \
                    f'{ANDROID_START_WAIT_SECONDS} 秒內沒看到模擬器程式'
                return what + (f'：{tail}' if tail else '')
            time.sleep(0.2)

    def stop(self, avd, port):
        """Graceful stop (`adb emu kill`, then SIGTERM), SIGKILL as the last step. None once no
        process of this AVD is left, else the reason."""
        wait = float(os.environ.get('VM_ANDROID_STOP_WAIT') or STOP_GRACE_SECONDS)
        notes = []
        if port:
            result = self._run('VM_ADB', 'adb', ['-s', f'emulator-{port}', 'emu', 'kill'])
            if result.returncode:
                notes.append(f'adb emu kill 失敗：{(result.stderr or result.stdout).strip()}')
            elif self._gone(avd, wait):
                return None
        for signal_name, seconds in (('-TERM', min(wait, ANDROID_TERM_WAIT_SECONDS)),
                                     ('-KILL', min(wait, 5))):
            procs = self.processes()
            if procs is None:
                return '讀不到程式清單（ps 失敗），無法確認模擬器是否已關' + \
                    (f'；{"；".join(notes)}' if notes else '')
            mine = [p for p in procs if p['avd'] == avd]
            if not mine:
                return None
            for proc in mine:
                result = self._run('VM_KILL', 'kill', [signal_name, str(proc['pid'])])
                if result.returncode:
                    notes.append(f'kill {signal_name} {proc["pid"]} 失敗：'
                                 f'{(result.stderr or result.stdout).strip()}')
            if self._gone(avd, seconds):
                return None
        left = [str(p['pid']) for p in self.processes() or [] if p['avd'] == avd]
        return f'模擬器 {avd} 的程式（pid {"、".join(left) or "?"}）結束不了' + \
            (f'；{"；".join(notes)}' if notes else '')

    def _gone(self, avd, seconds):
        deadline = time.monotonic() + seconds
        while True:
            if self.running(avd) is False:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.2)


def log_tail(path, lines=3):
    try:
        text = Path(path).read_text(errors='replace').strip().splitlines()
    except OSError:
        return ''
    return ' / '.join(text[-lines:])[-400:]


class DockerUnit:
    """A listed Docker machine, seen through the calls the shared rules need."""
    kind = 'docker'

    def __init__(self, machine, docker):
        self.machine, self.docker = machine, docker
        self.memory_gb = float(machine['memory_gb'])

    def running(self):
        return self.docker.running(self.machine['container'])

    def stop(self):
        return self.docker.stop(self.machine['container'])


class AndroidUnit:
    """One AVD's emulator; `lease` is None for an emulator running without a lease."""
    kind = ANDROID

    def __init__(self, avd, lease, android):
        self.avd, self.lease, self.android = avd, lease, android
        self.memory_gb = float((lease or {}).get('memory_gb') or ANDROID_DEFAULT_GB)

    def running(self):
        return self.android.running(self.avd)

    def stop(self):
        port = (self.lease or {}).get('port')
        if port is None:
            port = next((p['port'] for p in self.android.processes() or []
                         if p['avd'] == self.avd and p['port']), None)
        return self.android.stop(self.avd, port)


# ---------------------------------------------------------------- shared rules

def caller(human):
    """The borrower name of whoever runs this command."""
    if human:
        return HUMAN
    name = os.environ.get('HCOM_INSTANCE_NAME', '').strip()
    if not name:
        raise Refused('找不到 HCOM 實例名稱（HCOM_INSTANCE_NAME）。Agent 要在 HCOM 下執行 vm；'
                      '借用者一律取自 HCOM，不能自己指定。')
    return name


def is_android(key):
    return key.startswith(ANDROID_PREFIX)


def avd_of(key):
    return key[len(ANDROID_PREFIX):]


def target(machine, avd):
    """The lease key a command names: a machine name, or `android:<AVD>` for
    `android --avd <AVD>` (also accepted written as `android:<AVD>`)."""
    if machine == ANDROID or is_android(machine):
        name = avd if machine == ANDROID else avd_of(machine)
        if machine != ANDROID and avd and avd != name:
            raise Refused(f'{machine} 與 --avd {avd} 指的不是同一台。只用其中一種寫法。')
        if not name:
            raise Refused('Android 模擬器要用 --avd 指定名稱，例如 vm borrow android "<用途>" '
                          '--avd <名稱>；vm list android 列出可借的模擬器。')
        if not AVD_RE.match(name):
            raise Refused(f'模擬器名稱「{name}」不合規則（英數字、點、底線、連字號）。'
                          '用 vm list android 查看正確名稱。')
        return ANDROID_PREFIX + name
    if avd:
        raise Refused(f'--avd 只用在 Android 模擬器：vm borrow android "<用途>" --avd {avd}。')
    return machine


def borrow_hint(key):
    if is_android(key):
        return f'vm borrow android "<用途>" --avd {avd_of(key)}'
    return f'vm borrow {key} <用途>'


def command_name(key):
    """How a command names the machine, e.g. `win` or `android --avd pixel`."""
    return f'android --avd {avd_of(key)}' if is_android(key) else key


def machine_or_refuse(machines, name):
    if name not in machines:
        names = '、'.join(sorted(machines)) or '（清單是空的）'
        raise Refused(f'「{name}」不在機器清單上。可用的機器：{names}。'
                      '新機器先用 vm add 登記；Android 模擬器用 vm borrow android "<用途>" '
                      '--avd <名稱>。')
    return machines[name]


def describe(lease):
    return (f"{lease['borrower']} 借用中，用途：{lease['purpose']}，"
            f"到期 {taipei(parse(lease['expires_at']))}")


def own_lease(leases, name, who):
    lease = leases.get(name)
    if not lease:
        raise Refused(f'{name} 目前沒有人借用。要用請先 {borrow_hint(name)}。')
    if lease['borrower'] != who:
        raise Refused(f'{name} 由 {describe(lease)}。只有借用者能延長、開機或歸還；'
                      '請等它歸還或到期（vm list 查看），或改借其他機器。')
    return lease


def free_or_refuse(leases, name, who):
    """Refuse when `name` already has a lease."""
    lease = leases.get(name)
    if not lease:
        return
    if lease['borrower'] == who:
        what = command_name(name)
        raise Refused(f'你已經借了 {name}（到期 {taipei(parse(lease["expires_at"]))}）。'
                      f'要更久用 vm extend {what}，沒在執行用 vm start {what}。')
    raise Refused(f'{name} 由 {describe(lease)}。請等它歸還或到期，'
                  '或改借其他機器（vm list）。')


def hours_or_refuse(hours):
    if hours is None:
        return DEFAULT_HOURS
    if not 0 < hours <= MAX_HOURS:
        raise Refused(f'時間要大於 0、最多 {MAX_HOURS:g} 小時，收到 {hours:g}。'
                      f'改用 --hours 1 到 {MAX_HOURS:g} 之間的值，之後需要再 vm extend。')
    return hours


def emulator_args_or_refuse(text):
    """Extra emulator arguments from --emulator-args; vm sets the AVD, port and window."""
    words = shlex.split(text or '')
    bad = [w for w in words if w.split('=', 1)[0] in ANDROID_RESERVED_ARGS or w.startswith('@')]
    if bad:
        raise Refused(f'--emulator-args 不能含 {"、".join(bad)}：模擬器名稱、連線埠與無視窗由 vm '
                      '指定。拿掉這些再試。')
    return words


def new_lease(who, purpose, current, hours, powered_on_at):
    return {'borrower': who, 'human': who == HUMAN, 'purpose': purpose,
            'borrowed_at': iso(current), 'expires_at': iso(current + dt.timedelta(hours=hours)),
            'powered_on_at': powered_on_at, 'warned': False}


def android_fields(info, port, extra):
    return {'kind': ANDROID, 'avd': info['avd'], 'avd_home': info['avd_home'],
            'sdk': info['sdk'], 'memory_gb': info['memory_gb'], 'port': port,
            'serial': f'emulator-{port}' if port else None, 'emulator_args': extra}


def preexisting(procs, avd, baseline):
    """True when every process of this AVD was already running at the rollout baseline."""
    pids = {p['pid'] for p in procs or () if p['avd'] == avd}
    return bool(pids) and pids <= set(baseline or ())


def booting(lease, current):
    on = lease.get('powered_on_at')
    return bool(on) and current - parse(on) < BOOT_WINDOW


def admit(store, units, leases, name, need, current):
    """Refuse when the watcher is in its low-memory stop, or when available memory minus
    the needs of machines still booting is short of this machine's need plus the reserve."""
    if store.state().get('low_memory'):
        raise Refused('可用記憶體不足，看守程式已把所有虛擬機關機，暫停開機。'
                      f'等可用記憶體回到 {RESERVE_GB:g}G 以上再試。')
    pending = sum(units[other].memory_gb for other, lease in leases.items()
                  if other != name and other in units and booting(lease, current)
                  and units[other].running())
    free = available_gb() - pending
    if free < need + RESERVE_GB:
        extra = f'（已扣掉開機中機器的 {pending:g}G）' if pending else ''
        raise Refused(f'記憶體不夠開 {name}：可用 {free:.1f}G{extra}，需要 '
                      f'{need:g}G＋保留 {RESERVE_GB:g}G。等別的機器歸還或關機後再試。')


def stop_machine(store, unit, name, lease, hcom, reason, release, by):
    """Stop the machine. On success drop the lease when `release`; on failure keep the
    lease, mark it stop-failed, log it and notify the borrower. True when stopped."""
    pending = (store.leases().get(name) or {}).get('stop_failed')
    release = release or bool(pending and pending['release'])  # a failed return still ends
    error = unit.stop()
    leases = store.leases()
    if error is None:
        if release:
            leases.pop(name, None)
        elif name in leases:
            leases[name].pop('stop_failed', None)
            leases[name]['powered_on_at'] = None
        store.save_leases(leases)
        store.log('stop', name, lease['borrower'] if lease else None, reason, by)
        return True
    store.log('stop-failed', name, lease['borrower'] if lease else None,
              f'{reason}: {error}', by)
    if lease and name in leases:
        current = now()
        failed = leases[name].get('stop_failed') or {'reason': reason, 'release': release}
        failed['error'] = error
        last = failed.get('notified_at')
        if not lease.get('human') and (not last or current - parse(last)
                                       >= STOP_FAILED_NOTIFY_EVERY):
            hcom.send(lease['borrower'], f'vm：{name} 關機失敗（{error}）。借用保留，'
                      '看守程式會每輪重試。')
            failed['notified_at'] = iso(current)
        leases[name]['stop_failed'] = failed
        store.save_leases(leases)
    return False


# ---------------------------------------------------------------- actions

class Vm:
    def __init__(self, root, docker=None, hcom=None, android=None):
        ROOT['path'] = str(root)
        self.store = Store(root)
        self.docker = docker or Docker()
        self.hcom = hcom or Hcom()
        self.android = android or Android()

    def unit(self, name, lease, machines):
        """The machine behind a lease key, or None for a Docker name not on the list."""
        if is_android(name):
            return AndroidUnit(avd_of(name), lease, self.android)
        machine = machines.get(name)
        return DockerUnit(machine, self.docker) if machine else None

    def units(self, machines, leases, procs=()):
        """Every listed machine, every Android lease, and each running emulator in `procs`."""
        found = {name: DockerUnit(m, self.docker) for name, m in machines.items()}
        for key, lease in leases.items():
            if is_android(key):
                found[key] = AndroidUnit(avd_of(key), lease, self.android)
        for proc in procs or ():
            key = ANDROID_PREFIX + proc['avd']
            found.setdefault(key, AndroidUnit(proc['avd'], None, self.android))
        return found

    def log_path(self, avd):
        return self.store.root / ANDROID / f'{avd}.log'

    def free_port(self, leases, procs, name, prefer=None):
        """An emulator console port no other lease, running emulator or adb device uses."""
        taken = {lease.get('port') for key, lease in leases.items()
                 if key != name and is_android(key)}
        taken |= {p['port'] for p in procs if p['port']} | self.android.adb_ports()
        for port in ([prefer] if prefer else []) + list(ANDROID_PORTS):
            if port not in taken:
                return port
        raise Refused(f'沒有空的模擬器連線埠（{ANDROID_PORTS[0]}–{ANDROID_PORTS[-1]} 都在用）。'
                      '等別的模擬器歸還後再試。')

    def processes_or_refuse(self):
        procs = self.android.processes()
        if procs is None:
            raise Refused('讀不到主機的程式清單（ps 失敗），無法確認模擬器狀態。稍後再試。')
        return procs

    def status_rows(self, only=None, extra_avds=()):
        machines, leases, current = self.store.machines(), self.store.leases(), now()
        procs = self.android.processes()
        units = self.units(machines, leases, procs)
        for avd in extra_avds:
            units.setdefault(ANDROID_PREFIX + avd, AndroidUnit(avd, None, self.android))
        running_avds = None if procs is None else {p['avd'] for p in procs}
        baseline = self.store.state().get('android_baseline')
        if baseline is None:  # the watcher has not taken its rollout baseline yet
            baseline = [p['pid'] for p in procs or ()]
        rows = []
        for name in sorted(units):
            if only and not only(name):
                continue
            lease, unit = leases.get(name), units[name]
            if unit.kind == ANDROID:
                running = None if running_avds is None else unit.avd in running_avds
            else:
                running = unit.running()
            if lease and lease.get('stop_failed'):
                status = STATUS_STOP_FAILED
            elif running and lease and booting(lease, current):
                status = STATUS_BOOTING
            elif running:
                status = STATUS_RUNNING
            elif running is None:
                status = STATUS_OFF + ('（讀不到程式清單）' if unit.kind == ANDROID
                                       else '（容器未建立）')
            else:
                status = STATUS_OFF
            unleased = bool(running and not lease and unit.kind == ANDROID)
            row = {'machine': name, 'status': status, 'borrower': None, 'purpose': None,
                   'expires': None, 'remaining': None, 'serial': None, 'unleased': unleased,
                   'preexisting': unleased and preexisting(procs, unit.avd, baseline)}
            if lease:
                expires = parse(lease['expires_at'])
                row.update(borrower=lease['borrower'], purpose=lease['purpose'],
                           expires=taipei(expires), remaining=remaining(expires, current),
                           serial=lease.get('serial'))
            rows.append(row)
        return rows

    def list(self, only=None, avd=None):
        machines = self.store.machines()
        if only == ANDROID and not avd:
            found = self.android.avds()
            rows = self.status_rows(is_android, found)
            if not rows:
                searched = '、'.join(str(d) for d in avd_dirs()) or '（沒有模擬器資料夾）'
                return f'主機上沒有找到模擬器（搜尋 {searched}）。先用 avdmanager create avd 建立。'
            return '\n'.join(self.row_line(r) for r in rows)
        key = target(only, avd) if only else None
        if key and is_android(key):
            rows = self.status_rows(lambda n: n == key, [avd_of(key)])
            lease = self.store.leases().get(key)
            if not lease and rows[0]['status'] == STATUS_OFF:
                self.android.find(avd_of(key))  # refuses with the borrowable names
        else:
            if key:
                machine_or_refuse(machines, key)
            rows = self.status_rows(lambda n: not key or n == key)
        if not rows:
            return ('機器清單是空的。用 vm add 登記第一台機器；Android 模擬器用 '
                    'vm list android 查看。')
        lines = [self.row_line(r) for r in rows]
        if key and is_android(key):
            lease = self.store.leases().get(key)
            if lease and lease.get('serial'):
                lines.append(f"連線：adb -s {lease['serial']} …；模擬器資料夾 "
                             f"{lease['avd_home']}；SDK {lease['sdk']}；開機紀錄 "
                             f"{self.log_path(avd_of(key))}")
        elif key:
            machine = machines[key]
            ports = '、'.join(f'{label} 127.0.0.1:{port}'
                             for label, port in machine.get('ports', {}).items())
            lines.append(f"連線：ssh -F {self.store.root / 'ssh/config'} {machine['ssh_host']}"
                         + (f'；連線埠 {ports}' if ports else ''))
        else:
            lines.append('Android 模擬器：vm list android 列出主機上全部模擬器。')
        if self.store.state().get('low_memory'):
            lines.append('注意：可用記憶體不足，看守程式暫停所有開機。')
        return '\n'.join(lines)

    @staticmethod
    def row_line(r):
        adb = f"｜adb {r['serial']}" if r['serial'] else ''
        if r['borrower']:
            return (f"{r['machine']}：{r['status']}｜借用者 {r['borrower']}｜"
                    f"用途 {r['purpose']}｜到期 {r['expires']}（{r['remaining']}）{adb}")
        take = f"是你開的就用 vm borrow android \"<用途>\" --avd {avd_of(r['machine'])} 接手"
        if r['preexisting']:
            return (f"{r['machine']}：{r['status']}｜沒有人借用（vm 管理模擬器之前就在執行，"
                    f"看守不會因此關機；{take}）")
        if r['unleased']:
            return (f"{r['machine']}：{r['status']}｜沒有人借用（看守程式 "
                    f"{ANDROID_UNLEASED_GRACE.seconds // 60} 分鐘後會關機；{take}）")
        return f"{r['machine']}：{r['status']}｜沒有人借用"

    def borrow(self, name, purpose, hours, human, avd=None, emulator_args=None):
        who = caller(human)
        hours = hours_or_refuse(hours)
        key = target(name, avd)
        if not purpose.strip():
            raise Refused(f'用途是空的。請寫明用途，例如 vm borrow {command_name(key)} "測試安裝程式"'
                          if not is_android(key) else
                          f'用途是空的。請寫明用途，例如 vm borrow android "測試登入" --avd {avd_of(key)}。')
        if is_android(key):
            return self.borrow_android(key, purpose, hours, who,
                                       emulator_args_or_refuse(emulator_args))
        if emulator_args:
            raise Refused('--emulator-args 只用在 Android 模擬器。拿掉後再試。')
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            machine = machine_or_refuse(machines, name)
            free_or_refuse(leases, name, who)
            running = self.docker.running(machine['container'])
            if running:
                raise Refused(f'{name} 沒有人借用卻在執行，看守程式會把它關機。等 vm list 顯示'
                              f'關機後再 vm borrow {name}。')
            if running is None:
                raise Refused(f'{name} 的容器 {machine["container"]} 不存在。新登記的機器用 '
                              'vm add 的登記者身分建立容器後，以 vm start 開機。')
            admit(self.store, self.units(machines, leases), leases, name,
                  float(machine['memory_gb']), current)
            error = self.docker.start(machine['container'])
            if error:
                self.store.log('borrow-failed', name, who, f'開機失敗：{error}', who)
                raise Refused(f'{name} 開機失敗，借用沒有成立：{error}')
            leases[name] = new_lease(who, purpose, current, hours, iso(current))
            self.store.save_leases(leases)
            self.store.log('borrow', name, who, purpose, who)
        return f'已借用 {name}，到期 {taipei(parse(leases[name]["expires_at"]))}。用完請 vm return {name}。'

    def borrow_android(self, key, purpose, hours, who, extra):
        avd = avd_of(key)
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            free_or_refuse(leases, key, who)
            info = self.android.find(avd)
            procs = self.processes_or_refuse()
            mine = [p for p in procs if p['avd'] == avd]
            if mine:  # running without a lease (started before vm managed emulators): adopt it
                port = next((p['port'] for p in mine if p['port']), None)
                leases[key] = {**new_lease(who, purpose, current, hours, None),
                               **android_fields(info, port, extra)}
                self.store.save_leases(leases)
                self.forget_unleased(key)
                self.store.log('adopt', key, who, purpose, who)
                serial = f'adb 連線名稱 emulator-{port}' if port else 'adb 連線名稱不明'
                return (f'{key} 原本就在執行（沒有借用），已登記為你借用，到期 '
                        f'{taipei(parse(leases[key]["expires_at"]))}，{serial}。'
                        f'用完請 vm return android --avd {avd}。')
            units = self.units(machines, leases, procs)
            admit(self.store, units, leases, key, info['memory_gb'], current)
            port = self.free_port(leases, procs, key)
            error = self.android.start(info, port, extra, self.log_path(avd))
            if error:
                self.store.log('borrow-failed', key, who, f'開機失敗：{error}', who)
                raise Refused(f'{key} 開機失敗，借用沒有成立：{error}')
            leases[key] = {**new_lease(who, purpose, current, hours, iso(current)),
                           **android_fields(info, port, extra)}
            self.store.save_leases(leases)
            self.store.log('borrow', key, who, purpose, who)
        return (f'已借用 {key}，adb 連線名稱 emulator-{port}，到期 '
                f'{taipei(parse(leases[key]["expires_at"]))}。開機要一兩分鐘，'
                f'用 adb -s emulator-{port} wait-for-device 等它。'
                f'用完請 vm return android --avd {avd}。')

    def forget_unleased(self, key):
        state = self.store.state()
        seen = state.get('android_unleased') or {}
        if key in seen:
            seen.pop(key)
            state['android_unleased'] = seen
            self.store.save_state(state)

    def extend(self, name, hours, human, avd=None):
        who = caller(human)
        hours = hours_or_refuse(hours)
        key = target(name, avd)
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            if not is_android(key):
                machine_or_refuse(machines, key)
            lease = own_lease(leases, key, who)
            new = max(parse(lease['expires_at']), current) + dt.timedelta(hours=hours)
            limit = current + dt.timedelta(hours=MAX_HOURS)
            if new > limit:
                raise Refused(f'延長後到期 {taipei(new)}，超過現在起 {MAX_HOURS:g} 小時'
                              f'（最晚 {taipei(limit)}）。改用較短的 --hours。')
            lease['expires_at'] = iso(new)
            lease['warned'] = False
            if lease.get('stop_failed'):  # keep the extended lease once the retry stops it
                lease['stop_failed']['release'] = False
            self.store.save_leases(leases)
            self.store.log('extend', key, who, f'到期改為 {iso(new)}', who)
        return f'{key} 延長到 {taipei(new)}。'

    def return_(self, name, human, avd=None):
        who = caller(human)
        key = target(name, avd)
        with self.store.locked():
            machines, leases = self.store.machines(), self.store.leases()
            if not is_android(key):
                machine_or_refuse(machines, key)
            lease = own_lease(leases, key, who)
            unit = self.unit(key, lease, machines)
            running = unit.running()
            if running is None and unit.kind == ANDROID:
                raise Refused('讀不到主機的程式清單（ps 失敗），無法確認模擬器狀態，借用保留。'
                              f'稍後再 vm return {command_name(key)}。')
            if running:
                if not stop_machine(self.store, unit, key, lease, self.hcom, '歸還', True, who):
                    raise Refused(f'{key} 關機失敗，借用保留，看守程式會每輪重試；'
                                  f'用 vm list {command_name(key)} 看結果。')
            else:
                leases.pop(key)
                self.store.save_leases(leases)
                self.store.log('return', key, who, '歸還（未在執行）', who)
        return f'已歸還 {key}，機器已關機。'

    def start(self, name, human, avd=None, emulator_args=None):
        who = caller(human)
        key = target(name, avd)
        if emulator_args and not is_android(key):
            raise Refused('--emulator-args 只用在 Android 模擬器。拿掉後再試。')
        extra = emulator_args_or_refuse(emulator_args) if emulator_args else None
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            if not is_android(key):
                machine_or_refuse(machines, key)
            lease = own_lease(leases, key, who)
            unit = self.unit(key, lease, machines)
            if is_android(key):
                procs = self.processes_or_refuse()
                if any(p['avd'] == unit.avd for p in procs):
                    return f'{key} 已經在執行。'
                admit(self.store, self.units(machines, leases, procs), leases, key,
                      unit.memory_gb, current)
                port = self.free_port(leases, procs, key, prefer=lease.get('port'))
                extra = lease.get('emulator_args') or [] if extra is None else extra
                error = self.android.start(lease, port, extra, self.log_path(unit.avd))
                if error:
                    self.store.log('start-failed', key, who, error, who)
                    raise Refused(f'{key} 開機失敗，借用保留，可以再試 vm start '
                                  f'{command_name(key)}：{error}')
                lease.update(port=port, serial=f'emulator-{port}', emulator_args=extra)
            else:
                machine = machines[key]
                running = self.docker.running(machine['container'])
                if running:
                    return f'{key} 已經在執行。'
                if running is None:
                    raise Refused(f'{key} 的容器 {machine["container"]} 不存在，先照官方說明以 '
                                  'docker create 建立（不要用 docker run）。')
                admit(self.store, self.units(machines, leases), leases, key,
                      unit.memory_gb, current)
                error = self.docker.start(machine['container'])
                if error:
                    self.store.log('start-failed', key, who, error, who)
                    raise Refused(f'{key} 開機失敗，借用保留，可以再試 vm start {key}：{error}')
            lease['powered_on_at'] = iso(current)
            self.store.save_leases(leases)
            self.store.log('start', key, who, '借用者開機', who)
        serial = f'（adb 連線名稱 {lease["serial"]}）' if is_android(key) else ''
        return f'{key} 開機中{serial}。'

    def add(self, name, container, memory_gb, ports, ssh_host, purpose, hours, human):
        who = caller(human)
        hours = hours_or_refuse(hours)
        if not NAME_RE.match(name) or name == ANDROID:
            raise Refused('機器名只能用小寫英數字與連字號，32 字以內，也不能叫 android，例如 win2。'
                          '換個名字再登記。')
        if not CONTAINER_RE.match(container):
            raise Refused(f'容器名稱「{container}」不合 Docker 規則，改用英數字、底線、點或連字號。')
        if not memory_gb > 0:
            raise Refused('記憶體需求要大於 0（單位 G），例如 --memory-gb 16。')
        if not purpose.strip():
            raise Refused('用途是空的。請用 --purpose 寫明用途，例如 --purpose "安裝新系統"。')
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            if name in machines:
                raise Refused(f'{name} 已經在機器清單上。換個名字，或用 vm borrow {name} 借用。')
            if any(m['container'] == container for m in machines.values()):
                raise Refused(f'容器 {container} 已經登記給別的機器。換一個容器名稱。')
            machines[name] = {'container': container, 'memory_gb': memory_gb,
                              'ports': ports, 'ssh_host': ssh_host, 'folder': name}
            (self.store.root / name).mkdir(parents=True, exist_ok=True)
            self.store.save_machines(machines)
            leases[name] = new_lease(who, purpose, current, hours, None)
            expires = parse(leases[name]['expires_at'])
            self.store.save_leases(leases)
            self.store.log('add', name, who, purpose, who)
        return (f'已登記 {name}，你是借用者（到期 {taipei(expires)}），尚未開機。'
                f'下一步：照官方說明以 docker create 建立容器 {container}，'
                f'掛載只用 {self.store.root / name} 底下的路徑，連線埠只綁 127.0.0.1；'
                f'再用 vm start {name} 開機。')

    def reclaim(self, name, to_human, hours, purpose, avd=None):
        hours = hours_or_refuse(hours)
        key = target(name, avd)
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            if not is_android(key):
                machine_or_refuse(machines, key)
            lease = leases.get(key)
            if not lease:
                raise Refused(f'{key} 沒有人借用，直接用 vm borrow --human {command_name(key)} '
                              '<用途>。')
            what = '轉給使用者' if to_human else '關機'
            if not lease.get('human'):
                self.hcom.send(lease['borrower'], f'vm：使用者強制收回了你借的 {key}，'
                               f'機器將{what}。請停止使用這台機器。')
            self.store.log('reclaim', key, lease['borrower'], what, HUMAN)
            if to_human:
                kept = {k: v for k, v in lease.items() if k in (
                    'kind', 'avd', 'avd_home', 'sdk', 'memory_gb', 'port', 'serial',
                    'emulator_args')}
                leases[key] = {**new_lease(HUMAN, purpose or '強制收回', current, hours,
                                           lease.get('powered_on_at')), **kept}
                expires = parse(leases[key]['expires_at'])
                self.store.save_leases(leases)
                return f'{key} 已轉給使用者，到期 {taipei(expires)}。'
            unit = self.unit(key, lease, machines)
            if unit.running():
                if not stop_machine(self.store, unit, key, lease, self.hcom, '強制收回', True,
                                    HUMAN):
                    raise Refused(f'{key} 關機失敗，借用保留，看守程式會每輪重試；'
                                  f'用 vm list {command_name(key)} 看結果。')
            else:
                leases.pop(key)
                self.store.save_leases(leases)
                self.store.log('release', key, lease['borrower'], '強制收回（未在執行）', HUMAN)
        return f'{key} 已收回並關機。'

    # ------------------------------------------------------------ watcher

    def watch_once(self):
        """One watcher round, entirely inside the lock and on freshly read files."""
        with self.store.locked():
            stopped_now = self._low_memory()
            present = None
            asked = False
            machines, leases = self.store.machines(), self.store.leases()
            procs = self.android.processes()
            names = sorted(set(machines) | {k for k in leases if is_android(k)}
                           | {ANDROID_PREFIX + p['avd'] for p in procs or ()})
            state = self.store.state()
            seen = dict(state.get('android_unleased') or {})
            unleased = {}
            baseline = self._baseline(procs, leases)
            for name in names:
                lease = self.store.leases().get(name)
                unit = self.unit(name, lease, machines)
                if unit is None:
                    continue
                current = now()
                running = unit.running()
                if running is None and unit.kind == ANDROID:
                    continue  # the process list failed: nothing is known about it this round
                if not lease:
                    if running and unit.kind == ANDROID:
                        if preexisting(procs, unit.avd, baseline):
                            continue  # running before vm managed emulators: never auto-stopped
                        since = self._unleased(name, unit, seen.get(name), current)
                        if since:
                            unleased[name] = since
                    elif running:
                        stop_machine(self.store, unit, name, None, self.hcom,
                                     '沒有借用卻在執行', False, 'watch')
                    continue
                failed = lease.get('stop_failed')
                if failed and name in stopped_now:
                    continue  # the low-memory stop already tried this round
                if failed:
                    if running is False or running is None:
                        self._settle_stopped(name, failed)
                    else:
                        self.store.log('retry-stop', name, lease['borrower'],
                                       failed['reason'], 'watch')
                        stop_machine(self.store, unit, name, lease, self.hcom,
                                     failed['reason'], failed['release'], 'watch')
                    continue
                expires = parse(lease['expires_at'])
                if current >= expires:
                    self._end(name, unit, lease, running, '到期')
                    continue
                if not lease.get('human'):
                    if not asked:
                        present, asked = self.hcom.present(), True
                    if self._absent(name, unit, lease, running, present, current):
                        continue
                    if not lease.get('warned') and current >= expires - WARN_BEFORE:
                        self.hcom.send(lease['borrower'],
                                       f'vm：你借的 {name} 將於 {taipei(expires)} 到期並關機。'
                                       f'還要用請 vm extend {command_name(name)}，'
                                       f'用完請 vm return {command_name(name)}。')
                        leases = self.store.leases()
                        leases[name]['warned'] = True
                        self.store.save_leases(leases)
                        self.store.log('remind', name, lease['borrower'], '10 分鐘後到期',
                                       'watch')
            if procs is None:
                return  # the process list failed: keep what was known
            state = self.store.state()
            alive = {p['pid'] for p in procs}
            changed = {'android_unleased': unleased,
                       'android_baseline': [pid for pid in baseline if pid in alive]}
            if any(state.get(k) != v for k, v in changed.items()):
                state.update(changed)
                self.store.save_state(state)

    def _baseline(self, procs, leases):
        """PIDs of emulators that were running without a lease when the watcher first
        handled emulators (the rollout). Taken once, on the first round with a process list;
        those processes are listed and logged but never stopped for having no lease."""
        state = self.store.state()
        if 'android_baseline' in state or procs is None:
            return state.get('android_baseline') or []
        found = [p for p in procs if ANDROID_PREFIX + p['avd'] not in leases]
        for proc in found:
            self.store.log('baseline', ANDROID_PREFIX + proc['avd'], None,
                           f'vm 管理模擬器之前就在執行（pid {proc["pid"]}），看守不會因沒有借用而關機',
                           'watch')
        state['android_baseline'] = sorted(p['pid'] for p in found)
        self.store.save_state(state)
        return state['android_baseline']

    def _unleased(self, name, unit, since, current):
        """An emulator running without a lease: log it the first time, stop it once it has
        been seen unleased for the grace period. The first-seen time, or None when stopped."""
        if not since:
            since = iso(current)
            self.store.log('unleased', name, None,
                           f'沒有借用卻在執行，{ANDROID_UNLEASED_GRACE.seconds // 60} 分鐘內'
                           '沒人借用就關機', 'watch')
        if current - parse(since) >= ANDROID_UNLEASED_GRACE and stop_machine(
                self.store, unit, name, None, self.hcom, '沒有借用卻在執行', False, 'watch'):
            return None
        return since

    def _settle_stopped(self, name, failed):
        leases = self.store.leases()
        borrower = leases[name]['borrower']
        if failed['release']:
            leases.pop(name)
        else:
            leases[name].pop('stop_failed')
            leases[name]['powered_on_at'] = None
        self.store.save_leases(leases)
        self.store.log('stop', name, borrower, f"{failed['reason']}（已關機）", 'watch')

    def _end(self, name, unit, lease, running, reason):
        if running:
            stop_machine(self.store, unit, name, lease, self.hcom, reason, True, 'watch')
        else:
            leases = self.store.leases()
            leases.pop(name, None)
            self.store.save_leases(leases)
            self.store.log('release', name, lease['borrower'], reason, 'watch')

    def _absent(self, name, unit, lease, running, present, current):
        """Track how long the borrower has been gone from HCOM; reclaim after the limit.
        Unknown presence (hcom failed) changes nothing. True when the lease ended."""
        if present is None:
            return False
        leases = self.store.leases()
        if lease['borrower'] in present:
            if leases[name].get('absent_since'):
                leases[name]['absent_since'] = None
                self.store.save_leases(leases)
            return False
        since = leases[name].get('absent_since')
        if not since:
            leases[name]['absent_since'] = iso(current)
            self.store.save_leases(leases)
            self.store.log('absent', name, lease['borrower'], '借用者不在 HCOM 上', 'watch')
            return False
        if current - parse(since) > ABSENT_LIMIT:
            self._end(name, unit, lease, running, '借用者離開 HCOM 超過 30 分鐘')
            return True
        return False

    def _low_memory(self):
        state = self.store.state()
        free = available_gb()
        if free >= RESERVE_GB:
            if state.get('low_memory'):
                state['low_memory'] = False
                state.pop('since', None)
                self.store.save_state(state)
                self.store.log('low-memory-end', None, None, f'可用 {free:.1f}G', 'watch')
            return set()
        if not state.get('low_memory'):
            state.update(low_memory=True, since=iso(now()))
            self.store.save_state(state)
            self.store.log('low-memory', None, None, f'可用 {free:.1f}G', 'watch')
        machines, leases = self.store.machines(), self.store.leases()
        units = self.units(machines, leases, self.android.processes())
        tried = set()
        for name in sorted(units):
            unit = units[name]
            if not unit.running():
                continue
            tried.add(name)
            lease = leases.get(name)
            reason = f'可用記憶體 {free:.1f}G 低於 {RESERVE_GB:g}G'
            stopped = stop_machine(self.store, unit, name, lease, self.hcom, reason, False,
                                   'watch')
            if stopped and lease and not lease.get('human'):
                kept = name in self.store.leases()
                self.hcom.send(lease['borrower'], f'vm：主機可用記憶體不足，{name} 已關機。' + (
                    f'借用保留，記憶體恢復後可用 vm start {command_name(name)} 再開。' if kept
                    else '你先前的歸還已完成，借用已清除。'))
        return tried


# ---------------------------------------------------------------- command line

def port_pair(text):
    label, sep, port = text.partition('=')
    if not sep or not label or not port.isdigit():
        raise argparse.ArgumentTypeError('連線埠寫成 名稱=埠號，例如 ssh=2222')
    return label, int(port)


def parser():
    top = argparse.ArgumentParser(prog='vm', description='借用主機上的虛擬機與 Android 模擬器。')
    top.add_argument('--root', help='資料根目錄（預設 $VM_HOME 或 ~/vm）')
    sub = top.add_subparsers(dest='action', required=True)

    def android(p, args=False):
        p.add_argument('--avd', help='Android 模擬器名稱（機器寫 android 時必填）')
        if args:
            p.add_argument('--emulator-args', help='額外的模擬器參數，例如 "-cores 2"')

    for action in ('list', 'status'):
        p = sub.add_parser(action, help='列出機器狀態與借用（android 列出全部模擬器）')
        p.add_argument('machine', nargs='?')
        android(p)
    p = sub.add_parser('borrow', help='借用並開機')
    p.add_argument('machine')
    p.add_argument('purpose')
    p.add_argument('--hours', type=float)
    p.add_argument('--human', action='store_true')
    android(p, True)
    p = sub.add_parser('extend', help='延長自己的借用')
    p.add_argument('machine')
    p.add_argument('--hours', type=float)
    p.add_argument('--human', action='store_true')
    android(p)
    p = sub.add_parser('return', help='歸還並關機')
    p.add_argument('machine')
    p.add_argument('--human', action='store_true')
    android(p)
    p = sub.add_parser('start', help='替自己借到的機器開機')
    p.add_argument('machine')
    p.add_argument('--human', action='store_true')
    android(p, True)
    p = sub.add_parser('add', help='登記新機器（登記者成為借用者，不開機）')
    p.add_argument('machine')
    p.add_argument('--container', required=True)
    p.add_argument('--memory-gb', type=float, required=True)
    p.add_argument('--port', type=port_pair, action='append', default=[])
    p.add_argument('--ssh-host', required=True)
    p.add_argument('--purpose', required=True)
    p.add_argument('--hours', type=float)
    p.add_argument('--human', action='store_true')
    p = sub.add_parser('reclaim', help='（只限使用者）強制收回')
    p.add_argument('machine')
    how = p.add_mutually_exclusive_group(required=True)
    how.add_argument('--to-human', action='store_true')
    how.add_argument('--stop', action='store_true')
    p.add_argument('--hours', type=float)
    p.add_argument('--purpose')
    android(p)
    p = sub.add_parser('watch', help='看守程式（由 systemd 服務執行）')
    p.add_argument('--once', action='store_true')
    p.add_argument('--interval', type=float, default=WATCH_INTERVAL_SECONDS)
    return top


def main(argv=None):
    args = parser().parse_args(argv)
    vm = Vm(data_root(args.root))
    try:
        if args.action in ('list', 'status'):
            print(vm.list(args.machine, args.avd))
        elif args.action == 'borrow':
            print(vm.borrow(args.machine, args.purpose, args.hours, args.human, args.avd,
                            args.emulator_args))
        elif args.action == 'extend':
            print(vm.extend(args.machine, args.hours, args.human, args.avd))
        elif args.action == 'return':
            print(vm.return_(args.machine, args.human, args.avd))
        elif args.action == 'start':
            print(vm.start(args.machine, args.human, args.avd, args.emulator_args))
        elif args.action == 'add':
            print(vm.add(args.machine, args.container, args.memory_gb, dict(args.port),
                         args.ssh_host, args.purpose, args.hours, args.human))
        elif args.action == 'reclaim':
            print(vm.reclaim(args.machine, args.to_human, args.hours, args.purpose, args.avd))
        elif args.action == 'watch':
            while True:
                try:
                    vm.watch_once()
                except Exception as exc:  # keep watching; the next round reads fresh files
                    if args.once:
                        raise
                    print(f'watch: {type(exc).__name__}: {exc}', file=sys.stderr, flush=True)
                if args.once:
                    break
                time.sleep(args.interval)
    except Refused as exc:
        print(f'vm：{exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
