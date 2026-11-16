"""vm skill tests: the real vm.py runs as a subprocess against a temporary data root, with
fake docker and hcom programs and a fake meminfo file. No real container is touched."""
import datetime as dt
import fcntl
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parents[1]
SCRIPT = SKILL / 'scripts/vm.py'
TESTS = Path(__file__).resolve().parent
T0 = dt.datetime(2026, 11, 17, 0, 0, tzinfo=dt.timezone.utc)


def load():
    spec = importlib.util.spec_from_file_location('vm', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vm = load()


def at(minutes=0, hours=0):
    return (T0 + dt.timedelta(minutes=minutes, hours=hours)).isoformat()


class VmCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='vm-test-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])
        self.root = self.tmp / 'vm'
        self.root.mkdir()
        self.events = self.tmp / 'events.jsonl'
        self.events.touch()
        self.docker_state = self.tmp / 'docker.json'
        self.hcom_list = self.tmp / 'hcom-list.json'
        self.meminfo = self.tmp / 'meminfo'
        self.set_memory(100)
        self.set_docker({'busi-vm-win': {'running': False}, 'busi-vm-mac': {'running': False}})
        self.set_present('aaaa', 'bebe')
        machines = {
            'win': {'container': 'busi-vm-win', 'memory_gb': 16,
                    'ports': {'web': 8006, 'rdp': 3389, 'ssh': 2222},
                    'ssh_host': 'vm-win', 'folder': 'win'},
            'mac': {'container': 'busi-vm-mac', 'memory_gb': 16,
                    'ports': {'vnc': 5999, 'ssh': 50922}, 'ssh_host': 'vm-mac',
                    'folder': 'mac'}}
        (self.root / 'machines.json').write_text(json.dumps({'machines': machines}))

    # ------------------------------------------------------------ fixtures

    def set_memory(self, gb):
        self.meminfo.write_text(f'MemTotal: 150000000 kB\nMemAvailable: {int(gb * 1024 * 1024)} kB\n')

    def set_docker(self, containers, **extra):
        self.docker_state.write_text(json.dumps({'containers': containers, **extra}))

    def docker(self):
        return json.loads(self.docker_state.read_text())

    def update_docker(self, **extra):
        state = self.docker()
        state.update(extra)
        self.docker_state.write_text(json.dumps(state))

    def running(self, container):
        return self.docker()['containers'][container]['running']

    def set_present(self, *names):
        self.hcom_list.write_text(json.dumps(
            [{'name': n, 'base_name': n, 'status': 'listening'} for n in names]))

    def env(self, who='aaaa', when=None):
        env = {k: v for k, v in os.environ.items() if k != 'HCOM_INSTANCE_NAME'}
        env.update(VM_HOME=str(self.root), VM_MEMINFO=str(self.meminfo),
                   VM_DOCKER=shlex.join([sys.executable, str(TESTS / 'fake_docker.py')]),
                   VM_HCOM=shlex.join([sys.executable, str(TESTS / 'fake_hcom.py')]),
                   FAKE_DOCKER_STATE=str(self.docker_state), FAKE_EVENTS=str(self.events),
                   FAKE_HCOM_LIST=str(self.hcom_list), VM_NOW=when or at())
        if who:
            env['HCOM_INSTANCE_NAME'] = who
        return env

    def vm(self, *args, who='aaaa', when=None):
        return subprocess.run([sys.executable, str(SCRIPT), *args], env=self.env(who, when),
                              capture_output=True, text=True, timeout=60)

    def spawn(self, *args, who='aaaa', when=None):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), *args], env=self.env(who, when),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(proc.stderr.close)
        self.addCleanup(proc.stdout.close)
        return proc

    def watch(self, when):
        result = self.vm('watch', '--once', who=None, when=when)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def ok(self, *args, **kw):
        result = self.vm(*args, **kw)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def refused(self, *args, **kw):
        result = self.vm(*args, **kw)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertTrue(result.stderr.strip())
        return result.stderr

    def leases(self):
        path = self.root / 'leases.json'
        return json.loads(path.read_text())['leases'] if path.exists() else {}

    def log(self):
        path = self.root / 'vm.log'
        if not path.exists():
            return []
        return [json.loads(line) for line in path.read_text().splitlines()]

    def calls(self, kind=None):
        rows = [json.loads(line) for line in self.events.read_text().splitlines()]
        rows = [r for r in rows if not (r[0] == 'docker' and r[1] == 'inspect')]
        return [r for r in rows if kind is None or r[0] == kind]

    def sends(self, to=None):
        return [r for r in self.calls('hcom') if to is None or r[2] == f'@{to}']

    def stops(self):
        return [r for r in self.calls('docker') if r[1] == 'stop']

    def starts(self):
        return [r for r in self.calls('docker') if r[1] == 'start']


class ListTests(VmCase):
    def test_list_shows_status_borrower_purpose_taipei_expiry_and_remaining(self):
        self.ok('borrow', 'win', '測試安裝程式')
        out = self.ok('list', when=at(minutes=5))
        self.assertIn('win：開機中｜借用者 aaaa｜用途 測試安裝程式｜到期 2026-11-17 11:00（台北）'
                      '（剩 2 小時 55 分）', out)
        self.assertIn('mac：關機｜沒有人借用', out)
        out = self.ok('status', 'win', when=at(minutes=20, hours=1))
        self.assertIn('win：執行中', out)
        self.assertNotIn('mac', out)

    def test_list_marks_a_machine_whose_container_does_not_exist(self):
        self.set_docker({'busi-vm-mac': {'running': False}})
        self.assertIn('win：關機（容器未建立）', self.ok('list'))


class BorrowTests(VmCase):
    def test_second_borrower_sees_first_borrower_purpose_and_expiry(self):
        self.ok('borrow', 'win', '測試安裝程式')
        err = self.refused('borrow', 'win', '別的事', who='bebe')
        self.assertIn('aaaa', err)
        self.assertIn('測試安裝程式', err)
        self.assertIn('2026-11-17 11:00（台北）', err)
        self.assertEqual(self.leases()['win']['borrower'], 'aaaa')

    def test_agent_actions_without_hcom_name_are_refused(self):
        self.ok('borrow', 'win', 'x')
        for args in (['borrow', 'mac', 'x'], ['extend', 'win'], ['return', 'win'],
                     ['start', 'win'], ['add', 'new', '--container', 'c', '--memory-gb', '4',
                                        '--ssh-host', 'h', '--purpose', 'p']):
            self.assertIn('HCOM', self.refused(*args, who=None), args)
        self.assertEqual(list(self.leases()), ['win'])

    def test_a_self_reported_borrower_name_is_not_accepted(self):
        self.ok('borrow', 'win', 'x')
        for args in (['extend', 'win', '--borrower', 'aaaa'], ['return', 'win', '--as', 'aaaa']):
            result = self.vm(*args, who='bebe')
            self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('只有借用者', self.refused('extend', 'win', who='bebe'))
        self.assertIn('只有借用者', self.refused('return', 'win', who='bebe'))
        self.assertEqual(self.leases()['win']['expires_at'], '2026-11-17T03:00:00Z')
        self.assertTrue(self.running('busi-vm-win'))

    def test_concurrent_borrows_of_one_machine_let_one_through(self):
        self.update_docker(start_delay=0.5)
        procs = [self.spawn('borrow', 'win', 'x', who=who) for who in ('aaaa', 'bebe')]
        codes = sorted(p.wait(timeout=60) for p in procs)
        self.assertEqual(codes, [0, 1])
        self.assertEqual(len(self.starts()), 1)

    def test_concurrent_borrows_of_two_machines_with_memory_for_one_let_one_through(self):
        self.set_memory(30)  # 16 + 8 fits once; the booting machine's 16 is deducted after
        self.update_docker(start_delay=0.5)
        procs = [self.spawn('borrow', name, 'x', who=who)
                 for name, who in (('win', 'aaaa'), ('mac', 'bebe'))]
        results = [(p.wait(timeout=60), p.stderr.read()) for p in procs]
        self.assertEqual(sorted(code for code, _ in results), [0, 1])
        refusal = next(err for code, err in results if code)
        self.assertIn('已扣掉開機中機器的 16G', refusal)
        self.assertEqual(len(self.leases()), 1)

    def test_two_machines_run_for_two_agents_when_memory_allows(self):
        self.ok('borrow', 'win', 'x', who='aaaa')
        self.ok('borrow', 'mac', 'y', who='bebe')
        self.assertTrue(self.running('busi-vm-win') and self.running('busi-vm-mac'))

    def test_borrow_refused_below_need_plus_reserve(self):
        self.set_memory(23.5)
        err = self.refused('borrow', 'win', 'x')
        self.assertIn('需要 16G＋保留 8G', err)
        self.assertIn('等別的機器歸還', err)
        self.assertEqual(self.leases(), {})
        self.assertEqual(self.starts(), [])

    def test_borrow_refused_while_watcher_holds_its_low_memory_stop(self):
        self.set_memory(4)
        self.watch(at())
        self.set_memory(100)
        self.assertIn('可用記憶體不足', self.refused('borrow', 'win', 'x'))
        self.watch(at(minutes=1))
        self.ok('borrow', 'win', 'x', when=at(minutes=1))

    def test_default_three_hours_and_eight_hour_limits(self):
        self.ok('borrow', 'win', 'x')
        self.assertEqual(self.leases()['win']['expires_at'], '2026-11-17T03:00:00Z')
        self.assertIn('超過現在起 8 小時', self.refused('extend', 'win', '--hours', '5.5'))
        self.ok('extend', 'win', '--hours', '5')
        self.assertEqual(self.leases()['win']['expires_at'], '2026-11-17T08:00:00Z')
        self.assertIn('最多 8 小時', self.refused('borrow', 'mac', 'x', '--hours', '9'))
        self.assertNotIn('mac', self.leases())

    def test_return_stops_gracefully_and_clears_the_lease(self):
        self.ok('borrow', 'win', 'x')
        self.ok('return', 'win')
        self.assertEqual(self.stops(), [['docker', 'stop', '-t', '120', 'busi-vm-win']])
        self.assertEqual(self.leases(), {})
        self.assertFalse(self.running('busi-vm-win'))

    def test_borrow_start_failure_leaves_no_lease(self):
        self.update_docker(fail_start=['busi-vm-win'])
        err = self.refused('borrow', 'win', 'x')
        self.assertIn('借用沒有成立', err)
        self.assertIn('cannot start', err)
        self.assertEqual(self.leases(), {})

    def test_human_flag_borrows_as_the_user(self):
        self.ok('borrow', 'win', '手動測試', '--human', who=None)
        self.assertEqual(self.leases()['win']['borrower'], '使用者')
        self.assertIn('借用者 使用者', self.ok('list'))

    def test_machine_outside_the_list_is_refused_with_the_available_ones(self):
        err = self.refused('borrow', 'linux', 'x')
        self.assertIn('「linux」不在機器清單上', err)
        self.assertIn('mac、win', err)
        self.assertIn('vm add', err)


class AddAndStartTests(VmCase):
    def add(self, name, who='aaaa', memory='16'):
        self.set_docker({**self.docker()['containers'], f'c-{name}': {'running': False}})
        return self.vm('add', name, '--container', f'c-{name}', '--memory-gb', memory,
                       '--port', 'web=8100', '--port', 'ssh=2300', '--ssh-host', f'vm-{name}',
                       '--purpose', '安裝新系統', who=who)

    def test_add_registers_the_caller_as_borrower_without_powering_on(self):
        result = self.add('linux')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('docker create', result.stdout)
        self.assertIn('127.0.0.1', result.stdout)
        machine = json.loads((self.root / 'machines.json').read_text())['machines']['linux']
        self.assertEqual(machine, {'container': 'c-linux', 'memory_gb': 16.0,
                                   'ports': {'web': 8100, 'ssh': 2300},
                                   'ssh_host': 'vm-linux', 'folder': 'linux'})
        self.assertTrue((self.root / 'linux').is_dir())
        lease = self.leases()['linux']
        self.assertEqual((lease['borrower'], lease['powered_on_at']), ('aaaa', None))
        self.assertEqual(lease['expires_at'], '2026-11-17T03:00:00Z')
        self.assertEqual(self.starts(), [])

    def test_start_is_for_the_borrower_only_and_checks_memory(self):
        self.add('linux')
        self.assertIn('只有借用者', self.refused('start', 'linux', who='bebe'))
        self.set_memory(20)
        self.assertIn('記憶體不夠', self.refused('start', 'linux'))
        self.set_memory(100)
        self.ok('start', 'linux')
        self.assertTrue(self.running('c-linux'))

    def test_start_failure_keeps_the_lease(self):
        self.add('linux')
        self.update_docker(fail_start=['c-linux'])
        self.assertIn('借用保留', self.refused('start', 'linux'))
        self.assertEqual(self.leases()['linux']['borrower'], 'aaaa')
        self.assertFalse(self.running('c-linux'))

    def test_concurrent_starts_with_memory_for_one_let_one_through(self):
        self.add('one', who='aaaa')
        self.add('two', who='bebe')
        self.set_memory(30)
        self.update_docker(start_delay=0.5)
        procs = [self.spawn('start', name, who=who) for name, who in (('one', 'aaaa'),
                                                                      ('two', 'bebe'))]
        self.assertEqual(sorted(p.wait(timeout=60) for p in procs), [0, 1])
        self.assertEqual(len(self.starts()), 1)


class WatchTests(VmCase):
    def test_reminds_once_ten_minutes_before_expiry_then_stops_and_clears(self):
        self.ok('borrow', 'win', 'x')
        self.watch(at(minutes=169))
        self.assertEqual(self.sends(), [])
        self.watch(at(minutes=170))
        self.watch(at(minutes=171))  # a new watcher process: the reminder is not repeated
        self.assertEqual(len(self.sends('aaaa')), 1)
        self.assertIn('vm extend win', self.sends('aaaa')[0][-1])
        self.watch(at(hours=3))
        self.assertEqual(self.stops(), [['docker', 'stop', '-t', '120', 'busi-vm-win']])
        self.assertEqual(self.leases(), {})

    def test_human_leases_get_no_reminder(self):
        self.ok('borrow', 'win', 'x', '--human', who=None)
        self.watch(at(minutes=175))
        self.assertEqual(self.sends(), [])

    def test_extension_that_wins_the_lock_keeps_the_machine_running(self):
        self.ok('borrow', 'win', 'x')
        lock = open(self.root / '.lock', 'a')
        fcntl.flock(lock, fcntl.LOCK_EX)
        watcher = self.spawn('watch', '--once', who=None, when=at(hours=3, minutes=1))
        time.sleep(1)
        self.assertIsNone(watcher.poll(), 'the watcher should be waiting for the lock')
        # The borrower's extend holds the lock now and finishes first.
        leases = json.loads((self.root / 'leases.json').read_text())
        leases['leases']['win']['expires_at'] = '2026-11-17T05:00:00Z'
        (self.root / 'leases.json').write_text(json.dumps(leases))
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
        self.assertEqual(watcher.wait(timeout=60), 0, watcher.stderr.read())
        self.assertTrue(self.running('busi-vm-win'))
        self.assertEqual(self.stops(), [])
        self.assertIn('win', self.leases())

    def test_extend_through_the_command_also_resets_the_reminder(self):
        self.ok('borrow', 'win', 'x')
        self.watch(at(minutes=175))
        self.ok('extend', 'win', '--hours', '1', when=at(minutes=176))
        self.assertFalse(self.leases()['win']['warned'])
        self.watch(at(hours=3, minutes=1))
        self.assertEqual(self.stops(), [])

    def test_failed_stop_keeps_lease_marks_it_and_retries_each_round(self):
        self.ok('borrow', 'win', 'x')
        self.update_docker(fail_stop=['busi-vm-win'])
        self.watch(at(hours=3))
        self.assertIn('win', self.leases())
        self.assertIn('win：關機失敗｜借用者 aaaa', self.ok('list', when=at(hours=3)))
        self.assertEqual(len(self.sends('aaaa')), 1)  # the failure
        self.watch(at(hours=3, minutes=1))
        self.watch(at(hours=3, minutes=11))
        actions = [e['action'] for e in self.log()]
        self.assertEqual(actions.count('retry-stop'), 2)
        self.assertEqual(actions.count('stop-failed'), 3)
        self.assertEqual(len(self.sends('aaaa')), 2)  # re-notified after 10 minutes
        self.assertEqual(len(self.stops()), 3)
        self.update_docker(fail_stop=[])
        self.watch(at(hours=3, minutes=12))
        self.assertEqual(self.leases(), {})
        self.assertFalse(self.running('busi-vm-win'))

    def test_failed_return_keeps_the_lease(self):
        self.ok('borrow', 'win', 'x')
        self.update_docker(fail_stop=['busi-vm-win'])
        self.assertIn('借用保留', self.refused('return', 'win'))
        self.assertEqual(self.leases()['win']['stop_failed']['reason'], '歸還')

    def test_human_stop_failure_is_only_logged(self):
        self.ok('borrow', 'win', 'x', '--human', who=None)
        self.update_docker(fail_stop=['busi-vm-win'])
        self.watch(at(hours=3))
        self.assertEqual(self.sends(), [])
        self.assertIn('stop-failed', [e['action'] for e in self.log()])

    def test_watcher_restart_resumes_from_files(self):
        self.ok('borrow', 'win', 'x')
        self.watch(at(minutes=1))
        # Every watch --once is a fresh process; nothing is carried in memory.
        self.watch(at(hours=3, minutes=5))
        self.assertEqual(len(self.stops()), 1)
        self.assertEqual(self.leases(), {})

    def test_borrower_gone_from_hcom_over_30_minutes_is_reclaimed(self):
        self.ok('borrow', 'win', 'x')
        self.set_present('bebe')
        self.watch(at(minutes=10))
        self.watch(at(minutes=40))
        self.assertEqual(self.stops(), [])
        self.watch(at(minutes=41))
        self.assertEqual(self.stops(), [['docker', 'stop', '-t', '120', 'busi-vm-win']])
        self.assertEqual(self.leases(), {})

    def test_borrower_back_on_hcom_resets_the_absence(self):
        self.ok('borrow', 'win', 'x')
        self.set_present('bebe')
        self.watch(at(minutes=10))
        self.set_present('aaaa')
        self.watch(at(minutes=20))
        self.set_present('bebe')
        self.watch(at(minutes=45))
        self.assertEqual(self.stops(), [])

    def test_hcom_failure_or_human_lease_never_counts_as_absence(self):
        self.ok('borrow', 'win', 'x')
        self.ok('borrow', 'mac', 'y', '--human', who=None)
        self.set_present()
        self.watch(at(minutes=10))
        self.hcom_list.unlink()
        self.watch(at(minutes=50))
        self.assertIn('win', self.leases())
        self.set_present()
        self.watch(at(minutes=51))  # absent since minute 10: 41 minutes
        self.assertNotIn('win', self.leases())
        self.assertIn('mac', self.leases())

    def test_running_machine_without_a_lease_is_stopped(self):
        self.set_docker({'busi-vm-win': {'running': True}, 'busi-vm-mac': {'running': False},
                         'other': {'running': True}})
        self.watch(at())
        self.assertEqual(self.stops(), [['docker', 'stop', '-t', '120', 'busi-vm-win']])

    def test_low_memory_stops_every_listed_machine_and_tells_borrowers(self):
        self.ok('borrow', 'win', 'x', who='aaaa')
        self.ok('borrow', 'mac', 'y', '--human', who=None)
        self.set_memory(7)
        self.watch(at(minutes=30))
        self.assertEqual(sorted(s[-1] for s in self.stops()), ['busi-vm-mac', 'busi-vm-win'])
        self.assertTrue(all(s[2:4] == ['-t', '120'] for s in self.stops()))
        self.assertEqual(len(self.sends('aaaa')), 1)
        self.assertIn('記憶體不足', self.sends('aaaa')[0][-1])
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(sorted(self.leases()), ['mac', 'win'])  # leases are kept
        self.assertIn('可用記憶體不足', self.refused('start', 'win', when=at(minutes=31)))


class ReviewFixTests(VmCase):
    def test_low_memory_does_not_pause_expiry(self):
        self.ok('borrow', 'win', 'x')
        self.set_memory(4)
        self.watch(at(minutes=30))
        self.watch(at(hours=3))
        self.assertEqual(self.leases(), {})
        self.assertIn('到期', [e['reason'] for e in self.log() if e['action'] == 'release'])

    def test_low_memory_stop_keeps_a_pending_return_release(self):
        self.ok('borrow', 'win', 'x')
        self.update_docker(fail_stop=['busi-vm-win'])
        self.refused('return', 'win')
        self.update_docker(fail_stop=[])
        self.set_memory(4)
        self.watch(at(minutes=5))
        self.assertEqual(self.leases(), {})

    def test_extending_a_failed_stop_lease_keeps_it_after_the_retry(self):
        self.ok('borrow', 'win', 'x')
        self.update_docker(fail_stop=['busi-vm-win'])
        self.watch(at(hours=3))
        self.ok('extend', 'win', '--hours', '2', when=at(hours=3, minutes=1))
        self.update_docker(fail_stop=[])
        self.watch(at(hours=3, minutes=2))
        self.assertEqual(self.leases()['win']['borrower'], 'aaaa')
        self.assertNotIn('stop_failed', self.leases()['win'])

    def test_running_machine_without_a_lease_cannot_be_borrowed_until_stopped(self):
        self.set_docker({'busi-vm-win': {'running': True}, 'busi-vm-mac': {'running': False}})
        self.assertIn('看守程式會把它關機', self.refused('borrow', 'win', 'x'))
        self.watch(at())
        self.ok('borrow', 'win', 'x')


class ReclaimTests(VmCase):
    def test_reclaim_notifies_first_then_hands_to_the_user(self):
        self.ok('borrow', 'win', 'x')
        self.ok('reclaim', 'win', '--to-human', who=None, when=at(minutes=5))
        self.assertEqual(self.calls()[-1][:3], ['hcom', 'send', '@aaaa'])
        self.assertIn('強制收回', self.calls()[-1][-1])
        lease = self.leases()['win']
        self.assertEqual((lease['borrower'], lease['human']), ('使用者', True))
        self.assertTrue(self.running('busi-vm-win'))

    def test_reclaim_notifies_first_then_stops(self):
        self.ok('borrow', 'win', 'x')
        self.ok('reclaim', 'win', '--stop', who=None)
        kinds = [c[:2] for c in self.calls()]
        self.assertLess(kinds.index(['hcom', 'send']), kinds.index(['docker', 'stop']))
        self.assertEqual(self.leases(), {})
        self.assertFalse(self.running('busi-vm-win'))


class LogTests(VmCase):
    def test_every_watcher_action_is_logged_with_utc_time_machine_borrower_reason(self):
        self.ok('borrow', 'win', 'x', who='aaaa')
        self.ok('borrow', 'mac', 'y', who='bebe')
        self.set_present('aaaa')
        self.watch(at(minutes=1))
        self.watch(at(minutes=32))  # bebe gone over 30 minutes
        self.watch(at(minutes=171))  # reminder for aaaa
        self.update_docker(fail_stop=['busi-vm-win'])
        self.watch(at(hours=3))  # expiry, stop fails
        self.watch(at(hours=3, minutes=1))  # retry
        self.update_docker(fail_stop=[])
        self.set_memory(5)
        self.ok('reclaim', 'win', '--to-human', who=None, when=at(hours=3, minutes=2))
        self.ok('start', 'win', '--human', who=None, when=at(hours=3, minutes=2))
        self.watch(at(hours=3, minutes=3))  # low memory
        watcher = [e for e in self.log() if e['by'] == 'watch']
        actions = {e['action'] for e in watcher}
        self.assertTrue({'absent', 'stop', 'remind', 'stop-failed', 'retry-stop',
                         'low-memory'} <= actions, actions)
        reasons = ' '.join(e['reason'] for e in watcher)
        for word in ('離開 HCOM 超過 30 分鐘', '到期', '10 分鐘後到期', '低於 8G'):
            self.assertIn(word, reasons)
        for entry in watcher:
            self.assertRegex(entry['time'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
            self.assertIn('machine', entry)
            self.assertIn('borrower', entry)
            self.assertTrue(entry['reason'])
        stopped = [e for e in watcher if e['action'] == 'stop']
        self.assertTrue(all(e['machine'] and e['borrower'] for e in stopped))


class FailureMessageTests(VmCase):
    def test_every_refusal_exits_nonzero_with_a_reason_and_a_next_step(self):
        self.ok('borrow', 'win', 'x')
        cases = [
            (['borrow', 'win', 'y'], {'who': 'bebe'}, '借用中', 'vm list'),
            (['borrow', 'win', 'y'], {}, '你已經借了', 'vm extend'),
            (['borrow', 'nope', 'y'], {}, '不在機器清單上', 'vm add'),
            (['borrow', 'mac', ' '], {}, '用途是空的', 'vm borrow'),
            (['borrow', 'mac', 'y', '--hours', '0'], {}, '最多 8 小時', '--hours'),
            (['extend', 'mac'], {}, '沒有人借用', 'vm borrow'),
            (['extend', 'win', '--hours', '8'], {}, '超過現在起 8 小時', '--hours'),
            (['return', 'win'], {'who': 'bebe'}, '只有借用者', 'vm '),
            (['start', 'mac'], {}, '沒有人借用', 'vm borrow'),
            (['borrow', 'mac', 'y'], {'who': None}, 'HCOM_INSTANCE_NAME', 'HCOM 下執行'),
            (['reclaim', 'mac', '--stop'], {'who': None}, '沒有人借用', 'vm borrow --human'),
            (['add', 'Bad!', '--container', 'c', '--memory-gb', '1', '--ssh-host', 'h',
              '--purpose', 'p'], {}, '機器名只能用', '換個名字'),
            (['add', 'win', '--container', 'c', '--memory-gb', '1', '--ssh-host', 'h',
              '--purpose', 'p'], {}, '已經在機器清單上', 'vm borrow'),
            (['add', 'new', '--container', 'busi-vm-mac', '--memory-gb', '1', '--ssh-host',
              'h', '--purpose', 'p'], {}, '已經登記給別的機器', '換一個'),
        ]
        for args, kw, reason, step in cases:
            err = self.refused(*args, **kw)
            self.assertIn(reason, err, args)
            self.assertIn(step, err, args)
        self.set_docker({'busi-vm-win': {'running': True}})
        err = self.refused('borrow', 'mac', 'y', who='bebe')  # mac's container is gone
        self.assertIn('不存在', err)
        self.assertIn('vm start', err)


class PackagingTests(unittest.TestCase):
    def test_programs_live_in_the_skill_and_the_unit_runs_the_installed_copy(self):
        unit = (SKILL / 'scripts/vm-watch.service').read_text()
        exec_line = next(line for line in unit.splitlines() if line.startswith('ExecStart='))
        self.assertIn('%h/.agents/skills/vm/scripts/vm.py watch', exec_line)
        self.assertIn('Restart=always', unit)
        self.assertTrue(SCRIPT.is_file())

    def test_skill_text_covers_the_required_topics_without_host_secrets(self):
        text = (SKILL / 'SKILL.md').read_text() + (SKILL / 'FORMATS.md').read_text()
        for needle in ('vm borrow', 'vm extend', 'vm return', 'vm start', 'vm add',
                       'vm list', 'reclaim', 'docker create', '127.0.0.1', 'ssh', '遠端桌面',
                       '網頁畫面', '~/vm/browser/', 'host-guard', '不是資安防線', 'Codex',
                       'https://github.com/dockur/windows',
                       'https://github.com/sickcodes/Docker-OSX'):
            self.assertIn(needle, text)
        self.assertNotRegex(text, r'\]\((\.\./)+docs/|\(docs/')
        self.assertNotRegex(text, r'\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+')
        self.assertNotRegex(text, r'BEGIN [A-Z ]*PRIVATE KEY|ssh-(rsa|ed25519) AAAA')
        self.assertNotIn(str(Path.home()), text)


if __name__ == '__main__':
    unittest.main()
