#!/usr/bin/env python3
"""Lend the host's virtual machines (full-OS Docker containers) to agents and the user.

`vm.py <action>` is the borrowing command; `vm.py watch` is the single watcher that
reminds, expires, reclaims and powers off. Both take one lock around every state change.
Standard library only. Times are stored and computed in UTC and shown in Asia/Taipei.

Replaceable for tests (environment variables):
  VM_HOME     data root (default ~/vm); --root overrides it
  VM_DOCKER   docker command (default `docker`), split like a shell would
  VM_HCOM     hcom command (default `hcom`)
  VM_MEMINFO  meminfo file (default /proc/meminfo)
  VM_NOW      fixed current time, ISO 8601 with offset
"""
import argparse
import datetime as dt
import fcntl
import json
import os
import re
import shlex
import subprocess
import sys
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

def command(var, default):
    return shlex.split(os.environ.get(var) or default)


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


def machine_or_refuse(machines, name):
    if name not in machines:
        names = '、'.join(sorted(machines)) or '（清單是空的）'
        raise Refused(f'「{name}」不在機器清單上。可用的機器：{names}。'
                      '新機器先用 vm add 登記。')
    return machines[name]


def describe(lease):
    return (f"{lease['borrower']} 借用中，用途：{lease['purpose']}，"
            f"到期 {taipei(parse(lease['expires_at']))}")


def own_lease(leases, name, who):
    lease = leases.get(name)
    if not lease:
        raise Refused(f'{name} 目前沒有人借用。要用請先 vm borrow {name} <用途>。')
    if lease['borrower'] != who:
        raise Refused(f'{name} 由 {describe(lease)}。只有借用者能延長、開機或歸還；'
                      '請等它歸還或到期（vm list 查看），或改借其他機器。')
    return lease


def hours_or_refuse(hours):
    if hours is None:
        return DEFAULT_HOURS
    if not 0 < hours <= MAX_HOURS:
        raise Refused(f'時間要大於 0、最多 {MAX_HOURS:g} 小時，收到 {hours:g}。'
                      f'改用 --hours 1 到 {MAX_HOURS:g} 之間的值，之後需要再 vm extend。')
    return hours


def new_lease(who, purpose, current, hours, powered_on_at):
    return {'borrower': who, 'human': who == HUMAN, 'purpose': purpose,
            'borrowed_at': iso(current), 'expires_at': iso(current + dt.timedelta(hours=hours)),
            'powered_on_at': powered_on_at, 'warned': False}


def booting(lease, current):
    on = lease.get('powered_on_at')
    return bool(on) and current - parse(on) < BOOT_WINDOW


def admit(store, machines, leases, name, current, docker):
    """Refuse when the watcher is in its low-memory stop, or when available memory minus
    the needs of machines still booting is short of this machine's need plus the reserve."""
    if store.state().get('low_memory'):
        raise Refused('可用記憶體不足，看守程式已把所有虛擬機關機，暫停開機。'
                      f'等可用記憶體回到 {RESERVE_GB:g}G 以上再試。')
    pending = sum(float(machines[other]['memory_gb']) for other, lease in leases.items()
                  if other != name and other in machines and booting(lease, current)
                  and docker.running(machines[other]['container']))
    free = available_gb() - pending
    need = float(machines[name]['memory_gb']) + RESERVE_GB
    if free < need:
        extra = f'（已扣掉開機中機器的 {pending:g}G）' if pending else ''
        raise Refused(f'記憶體不夠開 {name}：可用 {free:.1f}G{extra}，需要 '
                      f'{machines[name]["memory_gb"]}G＋保留 {RESERVE_GB:g}G。'
                      '等別的機器歸還或關機後再試。')


def stop_machine(store, machine, name, lease, docker, hcom, reason, release, by):
    """Stop the machine. On success drop the lease when `release`; on failure keep the
    lease, mark it stop-failed, log it and notify the borrower. True when stopped."""
    pending = (store.leases().get(name) or {}).get('stop_failed')
    release = release or bool(pending and pending['release'])  # a failed return still ends
    error = docker.stop(machine['container'])
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
    def __init__(self, root, docker=None, hcom=None):
        self.store = Store(root)
        self.docker = docker or Docker()
        self.hcom = hcom or Hcom()

    def status_rows(self):
        machines, leases, current = self.store.machines(), self.store.leases(), now()
        rows = []
        for name in sorted(machines):
            lease = leases.get(name)
            running = self.docker.running(machines[name]['container'])
            if lease and lease.get('stop_failed'):
                status = STATUS_STOP_FAILED
            elif running and lease and booting(lease, current):
                status = STATUS_BOOTING
            elif running:
                status = STATUS_RUNNING
            else:
                status = STATUS_OFF + ('（容器未建立）' if running is None else '')
            row = {'machine': name, 'status': status, 'borrower': None, 'purpose': None,
                   'expires': None, 'remaining': None}
            if lease:
                expires = parse(lease['expires_at'])
                row.update(borrower=lease['borrower'], purpose=lease['purpose'],
                           expires=taipei(expires), remaining=remaining(expires, current))
            rows.append(row)
        return rows

    def list(self, only=None):
        machines = self.store.machines()
        if only:
            machine_or_refuse(machines, only)
        rows = [r for r in self.status_rows() if not only or r['machine'] == only]
        if not rows:
            return '機器清單是空的。用 vm add 登記第一台機器。'
        lines = []
        for r in rows:
            if r['borrower']:
                lines.append(f"{r['machine']}：{r['status']}｜借用者 {r['borrower']}｜"
                             f"用途 {r['purpose']}｜到期 {r['expires']}（{r['remaining']}）")
            else:
                lines.append(f"{r['machine']}：{r['status']}｜沒有人借用")
        if only:
            machine = machines[only]
            ports = '、'.join(f'{label} 127.0.0.1:{port}'
                             for label, port in machine.get('ports', {}).items())
            lines.append(f"連線：ssh -F {self.store.root / 'ssh/config'} {machine['ssh_host']}"
                         + (f'；連線埠 {ports}' if ports else ''))
        if self.store.state().get('low_memory'):
            lines.append('注意：可用記憶體不足，看守程式暫停所有開機。')
        return '\n'.join(lines)

    def borrow(self, name, purpose, hours, human):
        who = caller(human)
        hours = hours_or_refuse(hours)
        if not purpose.strip():
            raise Refused('用途是空的。請寫明用途，例如 vm borrow win "測試安裝程式"。')
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            machine = machine_or_refuse(machines, name)
            lease = leases.get(name)
            if lease:
                if lease['borrower'] == who:
                    raise Refused(f'你已經借了 {name}（到期 {taipei(parse(lease["expires_at"]))}）。'
                                  f'要更久用 vm extend {name}，沒在執行用 vm start {name}。')
                raise Refused(f'{name} 由 {describe(lease)}。請等它歸還或到期，'
                              '或改借其他機器（vm list）。')
            running = self.docker.running(machine['container'])
            if running:
                raise Refused(f'{name} 沒有人借用卻在執行，看守程式會把它關機。等 vm list 顯示'
                              f'關機後再 vm borrow {name}。')
            if running is None:
                raise Refused(f'{name} 的容器 {machine["container"]} 不存在。新登記的機器用 '
                              'vm add 的登記者身分建立容器後，以 vm start 開機。')
            admit(self.store, machines, leases, name, current, self.docker)
            error = self.docker.start(machine['container'])
            if error:
                self.store.log('borrow-failed', name, who, f'開機失敗：{error}', who)
                raise Refused(f'{name} 開機失敗，借用沒有成立：{error}')
            leases[name] = new_lease(who, purpose, current, hours, iso(current))
            self.store.save_leases(leases)
            self.store.log('borrow', name, who, purpose, who)
        return f'已借用 {name}，到期 {taipei(parse(leases[name]["expires_at"]))}。用完請 vm return {name}。'

    def extend(self, name, hours, human):
        who = caller(human)
        hours = hours_or_refuse(hours)
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            machine_or_refuse(machines, name)
            lease = own_lease(leases, name, who)
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
            self.store.log('extend', name, who, f'到期改為 {iso(new)}', who)
        return f'{name} 延長到 {taipei(new)}。'

    def return_(self, name, human):
        who = caller(human)
        with self.store.locked():
            machines, leases = self.store.machines(), self.store.leases()
            machine = machine_or_refuse(machines, name)
            lease = own_lease(leases, name, who)
            if self.docker.running(machine['container']):
                if not stop_machine(self.store, machine, name, lease, self.docker, self.hcom,
                                    '歸還', True, who):
                    raise Refused(f'{name} 關機失敗，借用保留，看守程式會每輪重試；用 vm list {name} 看結果。')
            else:
                leases.pop(name)
                self.store.save_leases(leases)
                self.store.log('return', name, who, '歸還（未在執行）', who)
        return f'已歸還 {name}，機器已關機。'

    def start(self, name, human):
        who = caller(human)
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            machine = machine_or_refuse(machines, name)
            lease = own_lease(leases, name, who)
            running = self.docker.running(machine['container'])
            if running:
                return f'{name} 已經在執行。'
            if running is None:
                raise Refused(f'{name} 的容器 {machine["container"]} 不存在，先照官方說明以 '
                              'docker create 建立（不要用 docker run）。')
            admit(self.store, machines, leases, name, current, self.docker)
            error = self.docker.start(machine['container'])
            if error:
                self.store.log('start-failed', name, who, error, who)
                raise Refused(f'{name} 開機失敗，借用保留，可以再試 vm start {name}：{error}')
            lease['powered_on_at'] = iso(current)
            self.store.save_leases(leases)
            self.store.log('start', name, who, '借用者開機', who)
        return f'{name} 開機中。'

    def add(self, name, container, memory_gb, ports, ssh_host, purpose, hours, human):
        who = caller(human)
        hours = hours_or_refuse(hours)
        if not NAME_RE.match(name):
            raise Refused('機器名只能用小寫英數字與連字號，32 字以內，例如 win2。換個名字再登記。')
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

    def reclaim(self, name, to_human, hours, purpose):
        hours = hours_or_refuse(hours)
        with self.store.locked():
            machines, leases, current = self.store.machines(), self.store.leases(), now()
            machine = machine_or_refuse(machines, name)
            lease = leases.get(name)
            if not lease:
                raise Refused(f'{name} 沒有人借用，直接用 vm borrow --human {name} <用途>。')
            what = '轉給使用者' if to_human else '關機'
            if not lease.get('human'):
                self.hcom.send(lease['borrower'], f'vm：使用者強制收回了你借的 {name}，'
                               f'機器將{what}。請停止使用這台機器。')
            self.store.log('reclaim', name, lease['borrower'], what, HUMAN)
            if to_human:
                leases[name] = new_lease(HUMAN, purpose or '強制收回', current, hours,
                                         lease.get('powered_on_at'))
                expires = parse(leases[name]['expires_at'])
                self.store.save_leases(leases)
                return f'{name} 已轉給使用者，到期 {taipei(expires)}。'
            if self.docker.running(machine['container']):
                if not stop_machine(self.store, machine, name, lease, self.docker, self.hcom,
                                    '強制收回', True, HUMAN):
                    raise Refused(f'{name} 關機失敗，借用保留，看守程式會每輪重試；用 vm list {name} 看結果。')
            else:
                leases.pop(name)
                self.store.save_leases(leases)
                self.store.log('release', name, lease['borrower'], '強制收回（未在執行）', HUMAN)
        return f'{name} 已收回並關機。'

    # ------------------------------------------------------------ watcher

    def watch_once(self):
        """One watcher round, entirely inside the lock and on freshly read files."""
        with self.store.locked():
            stopped_now = self._low_memory()
            present = None
            asked = False
            machines = self.store.machines()
            for name in sorted(machines):
                machine = machines[name]
                lease = self.store.leases().get(name)
                current = now()
                running = self.docker.running(machine['container'])
                if not lease:
                    if running:
                        stop_machine(self.store, machine, name, None, self.docker, self.hcom,
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
                        stop_machine(self.store, machine, name, lease, self.docker,
                                     self.hcom, failed['reason'], failed['release'], 'watch')
                    continue
                expires = parse(lease['expires_at'])
                if current >= expires:
                    self._end(name, machine, lease, running, '到期')
                    continue
                if not lease.get('human'):
                    if not asked:
                        present, asked = self.hcom.present(), True
                    if self._absent(name, machine, lease, running, present, current):
                        continue
                    if not lease.get('warned') and current >= expires - WARN_BEFORE:
                        self.hcom.send(lease['borrower'],
                                       f'vm：你借的 {name} 將於 {taipei(expires)} 到期並關機。'
                                       f'還要用請 vm extend {name}，用完請 vm return {name}。')
                        leases = self.store.leases()
                        leases[name]['warned'] = True
                        self.store.save_leases(leases)
                        self.store.log('remind', name, lease['borrower'], '10 分鐘後到期',
                                       'watch')

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

    def _end(self, name, machine, lease, running, reason):
        if running:
            stop_machine(self.store, machine, name, lease, self.docker, self.hcom, reason,
                         True, 'watch')
        else:
            leases = self.store.leases()
            leases.pop(name, None)
            self.store.save_leases(leases)
            self.store.log('release', name, lease['borrower'], reason, 'watch')

    def _absent(self, name, machine, lease, running, present, current):
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
            self._end(name, machine, lease, running, '借用者離開 HCOM 超過 30 分鐘')
            return True
        return False

    def _low_memory(self):
        state = self.store.state()
        free = available_gb()
        if free >= RESERVE_GB:
            if state.get('low_memory'):
                state = {'low_memory': False}
                self.store.save_state(state)
                self.store.log('low-memory-end', None, None, f'可用 {free:.1f}G', 'watch')
            return set()
        if not state.get('low_memory'):
            state = {'low_memory': True, 'since': iso(now())}
            self.store.save_state(state)
            self.store.log('low-memory', None, None, f'可用 {free:.1f}G', 'watch')
        machines, leases = self.store.machines(), self.store.leases()
        tried = set()
        for name in sorted(machines):
            machine = machines[name]
            if not self.docker.running(machine['container']):
                continue
            tried.add(name)
            lease = leases.get(name)
            reason = f'可用記憶體 {free:.1f}G 低於 {RESERVE_GB:g}G'
            stopped = stop_machine(self.store, machine, name, lease, self.docker, self.hcom,
                                   reason, False, 'watch')
            if stopped and lease and not lease.get('human'):
                kept = name in self.store.leases()
                self.hcom.send(lease['borrower'], f'vm：主機可用記憶體不足，{name} 已關機。' + (
                    f'借用保留，記憶體恢復後可用 vm start {name} 再開。' if kept
                    else '你先前的歸還已完成，借用已清除。'))
        return tried


# ---------------------------------------------------------------- command line

def port_pair(text):
    label, sep, port = text.partition('=')
    if not sep or not label or not port.isdigit():
        raise argparse.ArgumentTypeError('連線埠寫成 名稱=埠號，例如 ssh=2222')
    return label, int(port)


def parser():
    top = argparse.ArgumentParser(prog='vm', description='借用主機上的虛擬機。')
    top.add_argument('--root', help='資料根目錄（預設 $VM_HOME 或 ~/vm）')
    sub = top.add_subparsers(dest='action', required=True)
    for action in ('list', 'status'):
        p = sub.add_parser(action, help='列出機器狀態與借用')
        p.add_argument('machine', nargs='?')
    p = sub.add_parser('borrow', help='借用並開機')
    p.add_argument('machine')
    p.add_argument('purpose')
    p.add_argument('--hours', type=float)
    p.add_argument('--human', action='store_true')
    p = sub.add_parser('extend', help='延長自己的借用')
    p.add_argument('machine')
    p.add_argument('--hours', type=float)
    p.add_argument('--human', action='store_true')
    p = sub.add_parser('return', help='歸還並關機')
    p.add_argument('machine')
    p.add_argument('--human', action='store_true')
    p = sub.add_parser('start', help='替自己借到的機器開機')
    p.add_argument('machine')
    p.add_argument('--human', action='store_true')
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
    p = sub.add_parser('watch', help='看守程式（由 systemd 服務執行）')
    p.add_argument('--once', action='store_true')
    p.add_argument('--interval', type=float, default=WATCH_INTERVAL_SECONDS)
    return top


def main(argv=None):
    args = parser().parse_args(argv)
    vm = Vm(data_root(args.root))
    try:
        if args.action in ('list', 'status'):
            print(vm.list(args.machine))
        elif args.action == 'borrow':
            print(vm.borrow(args.machine, args.purpose, args.hours, args.human))
        elif args.action == 'extend':
            print(vm.extend(args.machine, args.hours, args.human))
        elif args.action == 'return':
            print(vm.return_(args.machine, args.human))
        elif args.action == 'start':
            print(vm.start(args.machine, args.human))
        elif args.action == 'add':
            print(vm.add(args.machine, args.container, args.memory_gb, dict(args.port),
                         args.ssh_host, args.purpose, args.hours, args.human))
        elif args.action == 'reclaim':
            print(vm.reclaim(args.machine, args.to_human, args.hours, args.purpose))
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
