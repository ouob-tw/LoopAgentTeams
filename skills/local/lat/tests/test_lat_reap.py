"""Service reaper CLI: real child processes with fake HCOM_PROCESS_IDs and a fake HCOM list.

LAT_REAP_TEST_SCOPE limits the reaper to this test's own fake agents, so the host's real
agents and processes are never judged or signalled; teardown kills only PIDs it started.
"""
from datetime import datetime, timedelta, timezone
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/lat-reap.py'
LAT_FILE = SCRIPT.parent / 'lat-watch.py'
PYTHON = os.path.realpath(sys.executable)
# Each node writes its PID once ready; a 'shell' node is a real sh running its children.
NODE = r'''
import json, os, shlex, signal, socket, subprocess, sys, time
spec = json.loads(sys.argv[1])
if spec.get('ignore_term'):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
if spec.get('listen'):
    # The first free port of this ticket's range 7950-7959, reported to the test.
    for port in range(7950, 7960):
        server = socket.socket()
        try:
            server.bind(('127.0.0.1', port))
            break
        except OSError:
            server.close()
    else:
        sys.exit('ports 7950-7959 are all in use')
    server.listen()
    with open(os.path.join(spec['dir'], spec['label'] + '.port'), 'w') as stream:
        stream.write(str(port))

def command(child):
    return [child.get('exe', child['python']), *child.get('options', []),
            child.get('script', __file__), json.dumps(child),
            *child.get('extra', [])]

def environment(child):
    env = dict(os.environ)
    if 'env' in child:
        env = {k: v for k, v in env.items() if not k.startswith('HCOM_')}
        env.update(child['env'])
    return env

for child in spec.get('children', []):
    if child.get('shell'):
        jobs = ' '.join(shlex.join(command(grandchild)) + ' &' for grandchild in child['children'])
        script = 'echo $$ > "$0.tmp" && mv "$0.tmp" "$0"; ' + jobs + ' while :; do sleep 1; done'
        subprocess.Popen(['sh', '-c', script, os.path.join(spec['dir'], child['label'])],
                         env=environment(child))
    else:
        subprocess.Popen(command(child), env=environment(child))
path = os.path.join(spec['dir'], spec['label'])
with open(path + '.tmp', 'w') as stream:
    stream.write(str(os.getpid()))
os.replace(path + '.tmp', path)
while True:
    time.sleep(1)
'''


def starttime(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rpartition(') ')[2].split()
        return None if fields[0] == 'Z' else int(fields[19])
    except (OSError, ValueError, IndexError):
        return None


def iso(seconds):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


class ReapTestCase(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.pids = self.root / 'pids'
        self.pids.mkdir()
        self.node_script = self.root / 'node.py'
        self.node_script.write_text(NODE)
        # A disposable LAT skill copy, so a process can really run a script inside one.
        self.lat_copy = self.root / 'lat-copy'
        (self.lat_copy / 'scripts').mkdir(parents=True)
        (self.lat_copy / 'SKILL.md').write_text('---\nname: lat\n---\n')
        self.lat_script = self.lat_copy / 'scripts/idle.py'
        self.lat_script.write_text(NODE)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('claude', 'hcom'):
            (self.bin / name).symlink_to(PYTHON)
        self.state = self.root / 'state'
        self.hcom = self.root / 'hcom.json'
        self.scope = f'reaptest-{uuid.uuid4().hex[:8]}-'
        self.set_hcom([])
        self.started, self.roots = {}, []
        self.addCleanup(self.kill_started)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(('HCOM_', 'LAT_REAP_'))}
        self.env.update(XDG_STATE_HOME=str(self.state), LAT_REAP_HCOM_LIST=str(self.hcom),
                        LAT_REAP_TEST_SCOPE=self.scope, LAT_REAP_GRACE_SECONDS='1')

    def kill_started(self):
        for label, (pid, start) in self.started.items():
            if starttime(pid) == start:
                os.kill(pid, signal.SIGKILL)
        for process in self.roots:
            process.wait(timeout=10)

    def agent_env(self, agent, tool=None):
        env = {'HCOM_PROCESS_ID': self.scope + agent, 'HCOM_INSTANCE_NAME': agent,
               'HCOM_TAG': 'test'}
        if tool:
            env['HCOM_TOOL'] = tool
        return env

    def node(self, label, children=(), **options):
        return {'label': label, 'dir': str(self.pids), 'python': PYTHON, 'children': list(children),
                **options}

    def shell(self, label, children=(), **options):
        return self.node(label, children, shell=True, **options)

    def spawn(self, tree, env):
        """Start a process tree; return {label: pid} once every node is ready."""
        labels = []

        def collect(node):
            labels.append(node['label'])
            for child in node['children']:
                collect(child)
        collect(tree)
        base = {key: value for key, value in os.environ.items() if not key.startswith('HCOM_')}
        process = subprocess.Popen([tree.get('exe', PYTHON), tree.get('script', str(self.node_script)),
                                    json.dumps(tree),
                                    *tree.get('extra', [])], env={**base, **env},
                                   cwd=tree.get('cwd'))
        self.roots.append(process)
        deadline = time.monotonic() + 15
        found = {}
        while len(found) < len(labels):
            for label in labels:
                path = self.pids / label
                if label not in found and path.exists():
                    pid = int(path.read_text())
                    found[label] = pid
                    self.started[label] = (pid, starttime(pid))
            if time.monotonic() > deadline:
                self.fail(f'process tree not ready: {sorted(set(labels) - set(found))}')
            time.sleep(0.02)
        for path in self.pids.glob('*.port'):
            self.env['LAT_REAP_PROTECTED_PORTS'] = path.read_text()
        return found

    def set_hcom(self, agents):
        """agents: (name, process id suffix, client pid) tuples HCOM still lists."""
        self.hcom.write_text(json.dumps([
            {'name': f'test-{name}', 'base_name': name,
             'launch_context': {'process_id': self.scope + suffix,
                                'pid_identity': f'linux:boot:{starttime(pid)}'}}
            for name, suffix, pid in agents]))

    def run_reaper(self, *args, cwd=None, env=None, timeout=60):
        return subprocess.run([PYTHON, str(SCRIPT), *args], text=True, capture_output=True,
                              env={**self.env, **(env or {})}, cwd=cwd, timeout=timeout)

    def reap(self, *args, **options):
        result = self.run_reaper('reap', *args, **options)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def keep(self, pid, *, reason='user checks the page', until=None, by='test-orch', **options):
        return self.run_reaper('keep', '--pid', str(pid), '--reason', reason,
                               '--until', until or iso(3600), '--by', by,
                               '--session', 'session-1', **options)

    def expire_keeps(self):
        path = self.state / 'lat/reaper/keeps.json'
        value = json.loads(path.read_text())
        for keep in value['keeps']:
            keep['until'] = iso(-1)
        path.write_text(json.dumps(value))

    def alive(self, pid):
        return starttime(pid) is not None

    def gone(self, pid, seconds=5):
        deadline = time.monotonic() + seconds
        while self.alive(pid):
            if time.monotonic() > deadline:
                return False
            time.sleep(0.05)
        return True

    def log(self):
        path = self.state / 'lat/reaper/closed.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def closed_pids(self):
        return [record['pid'] for record in self.log() if record.get('signal')]

    def dead_agent(self, agent, label=None, **options):
        """A leftover service of an agent HCOM no longer lists and whose client is gone."""
        label = label or f'{agent}-service'
        return self.spawn(self.node(label, **options), self.agent_env(agent))[label]

    def live_agent(self, agent, tool='claude', services=(), helpers=()):
        """client -> helpers (no shell) and client -> tool shell -> services; HCOM lists it."""
        tree = self.node(f'{agent}-client', [
            *(self.node(name) for name in helpers),
            self.shell(f'{agent}-shell', [self.node(name) for name in services]),
        ])
        pids = self.spawn(tree, self.agent_env(agent, tool))
        return pids


class ReapTests(ReapTestCase):
    def test_owner_ended_is_closed_and_logged_without_environment(self):
        long_argument = 'x' * 400
        service = self.dead_agent('gone', extra=['--token-like', long_argument])
        result = self.reap()
        self.assertTrue(self.gone(service), result.stdout)
        [record] = self.log()
        self.assertEqual(record['pid'], service)
        self.assertEqual(record['trigger'], 'manual')
        self.assertEqual(record['starttime'], self.started['gone-service'][1])
        self.assertEqual(record['agent'], 'test-gone')
        self.assertEqual(record['process_id'], self.scope + 'gone')
        self.assertEqual((record['signal'], record['result']), ('SIGTERM', 'exited after SIGTERM'))
        self.assertLessEqual(len(record['command']), 120)
        self.assertTrue(record['cwd'])
        self.assertTrue({'time', 'trigger', 'pid', 'starttime', 'command', 'cwd', 'agent',
                         'process_id', 'signal', 'result'} <= set(record))
        self.assertNotIn(long_argument, json.dumps(record))
        self.assertNotIn('HCOM_PROCESS_ID=', json.dumps(record))

    def test_running_agent_is_not_closed(self):
        pids = self.live_agent('busy', services=['busy-server'])
        self.set_hcom([('busy', 'busy', pids['busy-client'])])
        self.reap()
        self.assertTrue(all(map(self.alive, pids.values())))
        self.assertEqual(self.log(), [])

    def test_one_evidence_of_life_is_enough(self):
        # HCOM still lists the agent although its client process is gone.
        listed = self.dead_agent('listed')
        self.set_hcom([('listed', 'listed', listed)])
        hcom = json.loads(self.hcom.read_text())
        hcom[0]['launch_context']['pid_identity'] = 'linux:boot:1'
        self.hcom.write_text(json.dumps(hcom))
        # HCOM forgot the agent but its client (named after HCOM_TOOL) is still running.
        tree = self.node('forgot-client', [self.shell('forgot-shell', [self.node('forgot-server')])],
                         exe=str(self.bin / 'claude'))
        pids = self.spawn(tree, self.agent_env('forgot', 'claude'))
        self.reap()
        self.assertTrue(self.alive(listed))
        self.assertTrue(all(map(self.alive, pids.values())))
        self.assertEqual(self.log(), [])

    def test_agent_option_only_closes_that_agent(self):
        mine = self.dead_agent('mine')
        other = self.dead_agent('other')
        result = self.reap('--agent', 'test-mine')
        self.assertTrue(self.gone(mine), result.stdout)
        self.assertTrue(self.alive(other))
        self.assertEqual(self.closed_pids(), [mine])

    def test_agent_option_refuses_a_running_agent(self):
        pids = self.live_agent('runner', services=['runner-server'])
        self.set_hcom([('runner', 'runner', pids['runner-client'])])
        result = self.reap('--agent', 'test-runner')
        self.assertIn('still running', result.stdout)
        self.assertTrue(all(map(self.alive, pids.values())))
        self.assertEqual(self.log(), [])

    def test_unreadable_hcom_closes_nothing_and_logs_why(self):
        service = self.dead_agent('lost')
        self.hcom.write_text('not json')
        result = self.run_reaper('reap')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.alive(service))
        [record] = self.log()
        self.assertEqual(record['result'], 'aborted')
        self.assertIn('HCOM', record['reason'])

    def test_corrupt_keep_records_close_nothing(self):
        service = self.dead_agent('corrupt')
        (self.state / 'lat/reaper').mkdir(parents=True)
        (self.state / 'lat/reaper/keeps.json').write_text('{"keeps": [{"pid": 1}]}')
        result = self.run_reaper('reap')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.alive(service))
        self.assertIn('keep records unreadable', self.log()[0]['reason'])

    def test_keep_records_with_wrong_types_close_nothing(self):
        service = self.dead_agent('typed')
        (self.state / 'lat/reaper').mkdir(parents=True)
        (self.state / 'lat/reaper/keeps.json').write_text(json.dumps({'keeps': [{
            'pid': str(service), 'starttime': self.started['typed-service'][1],
            'process_id': self.scope + 'typed', 'reason': 'r', 'until': iso(600), 'by': 'b'}]}))
        result = self.run_reaper('reap')
        self.assertEqual(result.returncode, 1)
        self.assertTrue(self.alive(service))
        self.assertIn('unexpected format', self.log()[0]['reason'])

    def test_lat_documents_do_not_make_a_process_a_lat_process(self):
        viewer = self.dead_agent('viewer', extra=[str(LAT_FILE), str(self.lat_script)])
        reader = self.dead_agent('reader', extra=[str(SCRIPT.parents[1] / 'SKILL.md')])
        self.reap()
        self.assertTrue(self.gone(viewer))
        self.assertTrue(self.gone(reader))

    def test_never_handled_processes_survive_a_reap(self):
        tree = self.node('dead-root', [
            self.node('no-marker', env={}),
            self.node('listener', listen=True),
            self.node('lat-script', script=str(self.lat_script), options=['-X', 'dev']),
            self.node('plain'),
        ])
        pids = self.spawn(tree, self.agent_env('dead'))
        self.reap()
        self.assertTrue(self.gone(pids['plain']))
        self.assertTrue(self.gone(pids['dead-root']))
        # A running hcom process keeps its agent alive, so keep refusal covers that rule.
        for label in ('no-marker', 'listener', 'lat-script'):
            self.assertTrue(self.alive(pids[label]), label)

    def test_caller_and_its_ancestors_survive(self):
        service = self.dead_agent('caller', label='caller-service')
        command = f'{shlex.quote(PYTHON)} {shlex.quote(str(SCRIPT))} reap; echo $$ > {self.root}/sh'
        result = subprocess.run(['sh', '-c', command], text=True, capture_output=True,
                                env={**self.env, **self.agent_env('caller')}, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.gone(service))
        self.assertNotIn(int((self.root / 'sh').read_text()), self.closed_pids())
        self.assertEqual(self.closed_pids(), [service])

    def test_sigterm_ignored_gets_sigkill_after_grace(self):
        service = self.dead_agent('stubborn', ignore_term=True)
        began = time.monotonic()
        self.reap()
        self.assertGreaterEqual(time.monotonic() - began, 1)
        self.assertTrue(self.gone(service))
        [record] = self.log()
        self.assertEqual((record['signal'], record['result']), ('SIGKILL', 'killed'))

    def test_reused_pid_is_not_killed(self):
        pids = self.live_agent('owner', services=['owner-server'])
        self.set_hcom([('owner', 'owner', pids['owner-client']), ('orch', 'orch', pids['owner-client'])])
        server = pids['owner-server']
        directory = self.state / 'lat/reaper'
        directory.mkdir(parents=True)
        (directory / 'keeps.json').write_text(json.dumps({'keeps': [{
            'pid': server, 'starttime': self.started['owner-server'][1] - 1,
            'process_id': self.scope + 'owner', 'reason': 'old', 'until': iso(-60),
            'by': 'test-orch'}]}))
        self.reap()
        self.assertTrue(self.alive(server))
        self.assertEqual(self.log(), [])


class SignalTimeIdentityTests(ReapTestCase):
    # Exception to the CLI-only entry point (orchestrator decision): an unprivileged test
    # cannot force a real PID reuse between scan and signal, so close() is called directly.
    def test_pid_with_a_new_start_time_is_not_signalled(self):
        spec = importlib.util.spec_from_file_location('lat_reap', SCRIPT)
        reap = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reap)
        pid = self.dead_agent('reused')
        seen = reap.Process(pid, os.getpid(), self.started['reused-service'][1] - 1, 'S',
                            'python3', ('python3',), {})
        world = reap.World({pid: seen}, {}, set(), {})
        [record] = reap.close({pid: 'owner agent ended'}, world, self.root / 'log', 'manual')
        self.assertEqual((record['signal'], record['result']), (None, 'gone before signal'))
        self.assertTrue(self.alive(pid))


class KeepTests(ReapTestCase):
    def test_kept_leftover_survives_until_expiry(self):
        orchestrator = self.live_agent('orch')
        self.set_hcom([('orch', 'orch', orchestrator['orch-client'])])
        service = self.dead_agent('held')
        result = self.keep(service)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.reap()
        self.assertTrue(self.alive(service))
        scan = self.run_reaper('scan').stdout
        self.assertIn(f'PID {service}', scan.split('Kept:')[1])
        self.expire_keeps()
        self.reap()
        self.assertTrue(self.gone(service))
        self.assertIn('keep expired', self.log()[0]['why'])
        self.assertEqual(json.loads((self.state / 'lat/reaper/keeps.json').read_text())['keeps'], [])

    def test_keep_without_listening_port_is_accepted(self):
        orchestrator = self.live_agent('orch')
        self.set_hcom([('orch', 'orch', orchestrator['orch-client'])])
        service = self.dead_agent('quiet')
        result = self.keep(service)
        self.assertEqual(result.returncode, 0, result.stdout)
        [record] = json.loads((self.state / 'lat/reaper/keeps.json').read_text())['keeps']
        self.assertEqual((record['pid'], record['by'], record['session']),
                         (service, 'test-orch', 'session-1'))
        self.assertEqual(record['reason'], 'user checks the page')

    def test_expired_keep_closes_even_while_the_owner_runs(self):
        pids = self.live_agent('owner', helpers=['owner-mcp'], services=['owner-server'])
        self.set_hcom([('owner', 'owner', pids['owner-client'])])
        result = self.keep(pids['owner-server'], by='test-owner')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.expire_keeps()
        self.reap()
        self.assertTrue(self.gone(pids['owner-server']))
        for label in ('owner-client', 'owner-mcp', 'owner-shell'):
            self.assertTrue(self.alive(pids[label]), label)

    def test_released_keep_spares_base_processes_among_its_descendants(self):
        # The kept process later became an ancestor of the agent's client.
        tree = self.node('kept', [self.node('base-client', [
            self.node('base-mcp'), self.shell('base-shell', [self.node('base-server')])])])
        pids = self.spawn(tree, self.agent_env('base'))
        self.set_hcom([('base', 'base', pids['base-client'])])
        directory = self.state / 'lat/reaper'
        directory.mkdir(parents=True)
        (directory / 'keeps.json').write_text(json.dumps({'keeps': [{
            'pid': pids['kept'], 'starttime': self.started['kept'][1],
            'process_id': self.scope + 'base', 'reason': 'demo', 'until': iso(-1),
            'by': 'test-base'}]}))
        self.reap()
        self.assertTrue(self.gone(pids['base-server']))
        for label in ('kept', 'base-client', 'base-mcp', 'base-shell'):
            self.assertTrue(self.alive(pids[label]), label)

    def test_release_by_orchestrator_closes_unexpired_keeps(self):
        orchestrator = self.live_agent('orch')
        owner = self.live_agent('mine', services=['mine-server'])
        mine = owner['mine-server']
        other = self.dead_agent('theirs')
        self.set_hcom([('orch', 'orch', orchestrator['orch-client']),
                       ('mine', 'mine', owner['mine-client']),
                       ('other', 'other', orchestrator['orch-client'])])
        self.assertEqual(self.keep(mine).returncode, 0)
        self.assertEqual(self.keep(other, by='test-other').returncode, 0)
        result = self.run_reaper('release', '--by', 'test-orch')
        self.assertIn('Released 1', result.stdout)
        self.reap('--trigger', 'deactivate')
        self.assertTrue(self.gone(mine))
        self.assertTrue(self.alive(owner['mine-client']))
        self.assertTrue(self.alive(other))
        self.assertEqual({record['trigger'] for record in self.log()}, {'deactivate'})

    def test_valid_keep_inside_a_released_keep_survives(self):
        tree = self.node('outer', [self.node('inner', [self.node('inner-worker')]),
                                   self.node('outer-worker')])
        pids = self.spawn(tree, self.agent_env('nest'))
        orchestrator = self.live_agent('orch')
        self.set_hcom([('orch', 'orch', orchestrator['orch-client'])])
        self.assertEqual(self.keep(pids['outer']).returncode, 0)
        self.expire_keeps()
        self.assertEqual(self.keep(pids['inner']).returncode, 0)
        self.reap()
        self.assertTrue(self.gone(pids['outer-worker']))
        for label in ('inner', 'inner-worker'):
            self.assertTrue(self.alive(pids[label]), label)

    def test_keep_ends_when_its_orchestrator_is_gone(self):
        owner = self.live_agent('owner', services=['owner-server'])
        self.set_hcom([('owner', 'owner', owner['owner-client']), ('orch', 'orch', owner['owner-client'])])
        self.assertEqual(self.keep(owner['owner-server']).returncode, 0)
        self.reap()
        self.assertTrue(self.alive(owner['owner-server']))
        self.set_hcom([('owner', 'owner', owner['owner-client'])])
        self.reap()
        self.assertTrue(self.gone(owner['owner-server']))
        self.assertIn('no longer running', self.log()[0]['why'])

    def test_keep_refuses_invalid_requests(self):
        pids = self.live_agent('agent', tool='codex', helpers=['agent-helper'],
                               services=['agent-server'])
        tree = self.node('dead-root', [self.node('no-marker', env={}),
                                       self.node('listener', listen=True),
                                       self.node('lat-script', script=str(self.lat_script), options=['-O']),
                                       self.node('hcom-tool', exe=str(self.bin / 'hcom'),
                      env=self.agent_env('hcomtool'))])
        others = self.spawn(tree, self.agent_env('dead'))
        self.set_hcom([('agent', 'agent', pids['agent-client'])])
        cases = {
            'client': pids['agent-client'], 'client child without shell': pids['agent-helper'],
            'tool shell': pids['agent-shell'], 'no marker': others['no-marker'],
            'protected port': others['listener'], 'LAT process': others['lat-script'],
            'hcom process': others['hcom-tool'],
        }
        for case, pid in cases.items():
            result = self.keep(pid)
            self.assertEqual(result.returncode, 1, case)
            self.assertIn('Refused', result.stdout, case)
        self.assertIn('already passed', self.keep(pids['agent-server'], until=iso(-5)).stdout)
        self.assertIn('needs a reason', self.keep(pids['agent-server'], reason=' ').stdout)
        missing = self.run_reaper('keep', '--pid', str(pids['agent-server']), '--reason', 'r',
                                  '--by', 'x', '--session', 's')
        self.assertEqual(missing.returncode, 2)
        self.assertIn('not running', self.keep(2 ** 22 + 7).stdout)
        self.assertFalse((self.state / 'lat/reaper/keeps.json').exists())
        self.assertEqual(self.keep(pids['agent-server']).returncode, 0)

    def test_caller_ancestor_keep_is_refused(self):
        command = (f'{shlex.quote(PYTHON)} {shlex.quote(str(SCRIPT))} keep --pid $$ '
                   f'--reason r --until {iso(600)} --by b --session s')
        result = subprocess.run(['sh', '-c', command], text=True, capture_output=True,
                                env={**self.env, **self.agent_env('self')}, timeout=60)
        self.assertEqual(result.returncode, 1)
        self.assertIn('caller or its ancestor', result.stdout)

    def test_codex_like_structure_keeps_the_launch_chain(self):
        # node -> codex -> resident helper / tool shell -> service, as Codex runs on this host.
        tree = self.node('cx-node', [self.node('cx-codex', [
            self.node('cx-helper'), self.shell('cx-shell', [self.node('cx-server')])])])
        pids = self.spawn(tree, self.agent_env('cx', 'codex'))
        self.set_hcom([('cx', 'cx', pids['cx-node']), ('orch', 'orch', pids['cx-node'])])
        for label in ('cx-node', 'cx-codex', 'cx-helper', 'cx-shell'):
            self.assertIn('base process', self.keep(pids[label]).stdout, label)
        self.assertEqual(self.keep(pids['cx-server']).returncode, 0)
        self.expire_keeps()
        self.reap()
        self.assertTrue(self.gone(pids['cx-server']))
        for label in ('cx-node', 'cx-codex', 'cx-helper', 'cx-shell'):
            self.assertTrue(self.alive(pids[label]), label)


class SharedStateTests(ReapTestCase):
    def test_projects_share_keeps(self):
        project_a, project_b = self.root / 'a', self.root / 'b'
        project_a.mkdir()
        project_b.mkdir()
        orchestrator = self.live_agent('orch')
        self.set_hcom([('orch', 'orch', orchestrator['orch-client'])])
        service = self.dead_agent('shared')
        self.assertEqual(self.keep(service, cwd=project_a).returncode, 0)
        self.reap(cwd=project_b)
        self.assertTrue(self.alive(service))
        self.assertTrue((self.state / 'lat/reaper/keeps.json').exists())
        self.assertFalse(any(project_a.iterdir()) or any(project_b.iterdir()))

    def test_concurrent_reaps_signal_each_process_once(self):
        services = [self.dead_agent(f'race{index}', ignore_term=index == 0) for index in range(3)]
        project_a, project_b = self.root / 'a', self.root / 'b'
        project_a.mkdir()
        project_b.mkdir()
        results = []
        threads = [threading.Thread(target=lambda cwd=cwd: results.append(
            self.run_reaper('reap', cwd=cwd))) for cwd in (project_a, project_b)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual([result.returncode for result in results], [0, 0])
        self.assertTrue(all(map(self.gone, services)))
        signalled = self.closed_pids()
        self.assertEqual(sorted(signalled), sorted(services))

    def hold_lock(self):
        directory = self.state / 'lat/reaper'
        directory.mkdir(parents=True, exist_ok=True)
        stream = open(directory / 'reap.lock', 'a')
        self.addCleanup(stream.close)
        fcntl.flock(stream, fcntl.LOCK_EX)
        return stream

    def test_periodic_skips_and_manual_waits_for_the_lock(self):
        service = self.dead_agent('locked')
        lock = self.hold_lock()
        periodic = self.run_reaper('reap', '--trigger', 'periodic')
        self.assertEqual(periodic.returncode, 0)
        self.assertIn('Skipped', periodic.stdout)
        self.assertTrue(self.alive(service))
        timed_out = self.run_reaper('reap', env={'LAT_REAP_LOCK_SECONDS': '0.5'})
        self.assertEqual(timed_out.returncode, 1)
        self.assertIn('waited too long', timed_out.stdout)
        began = time.monotonic()
        threading.Timer(1, lambda: fcntl.flock(lock, fcntl.LOCK_UN)).start()
        self.reap()
        self.assertGreaterEqual(time.monotonic() - began, 0.9)
        self.assertTrue(self.gone(service))

    def test_scan_is_read_only(self):
        orchestrator = self.live_agent('orch', services=['orch-server'])
        self.set_hcom([('orch', 'orch', orchestrator['orch-client'])])
        leftover = self.dead_agent('left')
        kept = self.dead_agent('kept')
        self.assertEqual(self.keep(kept).returncode, 0)
        before = {path: path.read_bytes() for path in self.state.rglob('*') if path.is_file()}
        result = self.run_reaper('scan', '--all')
        self.assertEqual(result.returncode, 0, result.stderr)
        after = {path: path.read_bytes() for path in self.state.rglob('*') if path.is_file()}
        self.assertEqual(before, after)
        self.assertTrue(all(map(self.alive, [leftover, kept, *orchestrator.values()])))
        sections = result.stdout
        self.assertIn(f'PID {orchestrator["orch-server"]}',
                      sections.split('Agent still running:')[1].split('Leftover:')[0])
        self.assertIn(f'PID {leftover}', sections.split('Leftover:')[1].split('Kept:')[0])
        self.assertIn(f'PID {kept}', sections.split('Kept:')[1].split('Never handled:')[0])
        self.assertIn(f'PID {orchestrator["orch-client"]}', sections.split('Never handled:')[1])
        self.assertIn('Recent close records', sections)

    def test_scan_creates_no_state_folder(self):
        self.dead_agent('fresh')
        result = self.run_reaper('scan')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.state.exists())


if __name__ == '__main__':
    unittest.main()
