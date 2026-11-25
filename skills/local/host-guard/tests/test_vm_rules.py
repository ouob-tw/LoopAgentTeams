"""host-guard rules that keep agents from going around `vm` borrowing (#670)."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from hook_runner import run_hook

MACHINES = {'machines': {
    'win': {'container': 'vm-win-1', 'memory_gb': 16, 'ports': {'web': 8006, 'ssh': 2222},
            'ssh_host': 'vm-win', 'folder': 'win'},
    'mac': {'container': 'vm-mac-1', 'memory_gb': 16, 'ports': {'vnc': 5999, 'ssh': 2223},
            'ssh_host': 'vm-mac', 'folder': 'mac'},
    'lin': {'container': 'vm-lin-1', 'memory_gb': 8, 'ports': {'ssh': 2224},
            'ssh_host': 'vm-lin', 'folder': 'lin'}}}
LEASES = {'leases': {
    'win': {'borrower': 'luna', 'human': False, 'purpose': 'test',
            'borrowed_at': '2026-11-17T00:00:00Z', 'expires_at': '2026-11-17T03:00:00Z',
            'powered_on_at': None, 'warned': False, 'absent_since': None},
    'mac': {'borrower': '使用者', 'human': True, 'purpose': 'mine',
            'borrowed_at': '2026-11-17T00:00:00Z', 'expires_at': '2026-11-17T03:00:00Z',
            'powered_on_at': None, 'warned': False, 'absent_since': None}}}
KVM = '--device=/dev/kvm --device=/dev/net/tun --cap-add NET_ADMIN'


class VmCase(unittest.TestCase):
    """The hook as Claude and Codex run it, with a temporary home and vm data root."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='host-guard-vm-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])
        self.home = self.tmp / 'home'
        self.home.mkdir()
        self.root = self.tmp / 'data'
        self.root.mkdir()
        (self.root / 'machines.json').write_text(json.dumps(MACHINES))
        (self.root / 'leases.json').write_text(json.dumps(LEASES))
        self.work = self.tmp / 'work'
        self.work.mkdir()
        self.env = {'VM_HOME': str(self.root), 'HCOM_INSTANCE_NAME': 'luna'}

    def hook(self, payload, **env):
        full = {k: v for k, v in os.environ.items()
                if k not in ('VM_HOME', 'HCOM_INSTANCE_NAME', 'XDG_CONFIG_HOME',
                             'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_STATE_HOME')}
        full.update(HOME=str(self.home), HOST_GUARD_CONFIG=str(self.tmp / 'none.json'))
        full.update(self.env)
        for key, value in env.items():
            if value is None:
                full.pop(key, None)
            else:
                full[key] = value
        return run_hook(payload, full)

    def bash(self, command, cwd=None, **env):
        return self.hook({'tool_name': 'Bash', 'cwd': str(cwd or self.work),
                          'tool_input': {'command': command}}, **env)

    def blocked(self, command, text, **env):
        result = self.bash(command, **env)
        self.assertEqual(result.returncode, 2, f'{command!r} was allowed')
        self.assertIn(text, result.stderr, command)
        return result

    def allowed(self, command, **env):
        result = self.bash(command, **env)
        self.assertEqual(result.returncode, 0, f'{command!r}: {result.stderr}')


class PowerTests(VmCase):

    def test_direct_power_actions_on_listed_containers_are_blocked(self):
        for command in ['docker start vm-win-1', 'docker stop -t 120 vm-mac-1',
                        'docker restart vm-win-1', 'docker kill vm-win-1', 'docker rm -f vm-win-1',
                        'docker pause vm-win-1', 'docker unpause vm-win-1',
                        'docker container stop vm-win-1', 'docker -H unix:///x.sock stop vm-win-1',
                        'docker stop other vm-win-1', 'sudo docker stop vm-win-1',
                        "bash -c 'docker stop vm-win-1'", 'x=$(docker start vm-win-1)',
                        'echo "$(docker stop vm-win-1)"', 'echo `docker stop vm-win-1`',
                        'timeout 60 docker stop vm-win-1', 'cd /tmp && docker stop vm-mac-1',
                        'docker update --restart=always vm-win-1',
                        'docker update --restart unless-stopped vm-mac-1']:
            with self.subTest(command):
                result = self.blocked(command, 'vm borrow')
                self.assertIn('vm return', result.stderr)
                self.assertIn('vm.py', result.stderr)

    def test_compose_on_listed_services_or_in_the_vm_folder_is_blocked(self):
        self.blocked('docker compose stop vm-win-1', 'vm borrow')
        self.blocked('docker-compose restart vm-mac-1', 'vm borrow')
        (self.root / 'win').mkdir()
        self.blocked(f'docker compose -f {self.root}/win/compose.yml up -d', 'vm borrow')
        self.blocked(f'cd {self.root}/win && docker compose down', 'vm borrow')
        other = self.work / 'app'
        other.mkdir()
        (other / 'compose.yml').write_text('services:\n  w:\n    devices: [/dev/kvm]\n')
        self.blocked(f'cd {other} && docker compose up -d', 'vm add')

    def test_unrelated_docker_commands_pass(self):
        (self.work / 'compose.yml').write_text('services:\n  db:\n    image: postgres\n')
        for command in ['docker ps', 'docker ps -a', 'docker inspect vm-win-1',
                        'docker logs vm-win-1', 'docker stop postgres-test',
                        'docker start my-app', 'docker rm -f old-test', 'docker compose up -d',
                        'docker compose stop db', 'docker run --rm alpine echo hi',
                        'docker create --name scratch alpine',
                        'docker exec vm-win-1 ls', 'docker stats --no-stream',
                        'docker update --memory 4g my-app', 'docker update --restart=no vm-win-1',
                        'git commit -m "docker stop vm-win-1 is blocked now"',
                        'grep -rn "docker stop vm-win-1" skills/']:
            with self.subTest(command):
                self.allowed(command)


class StateFileTests(VmCase):

    def test_shell_writes_moves_and_deletes_of_state_files_are_blocked(self):
        r = self.root
        for command in [f'echo {{}} > {r}/leases.json', f'echo x >> {r}/vm.log',
                        f'printf x >{r}/machines.json', f'cp /tmp/x.json {r}/leases.json',
                        f'cp /tmp/leases.json {r}/', f'cp -t {r} /tmp/leases.json',
                        f'mv {r}/leases.json /tmp/', f'mv /tmp/x {r}/watch-state.json',
                        f'rm {r}/leases.json', f'rm -f {r}/.lock', f'rm -rf {r}',
                        f'trash-put {r}/machines.json', f'echo {{}} | tee {r}/leases.json',
                        f'sed -i s/luna/nova/ {r}/leases.json', f'sed -Ei s/a/b/ {r}/machines.json',
                        f'perl -pi -e s/a/b/ {r}/leases.json', f'truncate -s 0 {r}/vm.log',
                        f'touch {r}/watch-state.json', f'dd if=/dev/null of={r}/leases.json',
                        f'install -m 644 x {r}/leases.json', f'ln -sf /tmp/x {r}/leases.json',
                        f'rsync /tmp/leases.json {r}/', f'mv {r} /tmp/old-vm',
                        f'rm {r}/*.json', f'cd {r} && rm leases.json',
                        f'cd {r} && echo {{}} > leases.json', f'sudo rm {r}/leases.json',
                        f"bash -c 'rm {r}/leases.json'", 'rm $VM_HOME/leases.json',
                        'echo {} > ${VM_HOME}/leases.json',
                        f'jq . {r}/leases.json | sponge {r}/leases.json',
                        f'find {r} -name "*.json" -delete', f'find {r} -exec rm {{}} +',
                        f'find {self.tmp} -name leases.json -delete', f'cd {r} && find . -delete',
                        f'cd {r} && find -name leases.json -delete',
                        f'find {self.tmp} -iname LEASES.JSON -delete',
                        f'find {self.work} {self.tmp} -name leases.json -delete',
                        f'x=$(rm {r}/leases.json)', f'echo "$(cp /tmp/x {r}/leases.json)"',
                        f'timeout 5 sudo tee {r}/leases.json < /tmp/x']:
            with self.subTest(command):
                result = self.blocked(command, 'only the vm command writes')
                self.assertIn('vm extend', result.stderr)

    def test_default_root_is_vm_under_home(self):
        (self.home / 'vm').mkdir()
        self.blocked('rm ~/vm/leases.json', 'only the vm command writes', VM_HOME=None)
        self.blocked('echo {} > $HOME/vm/machines.json', 'only the vm command writes',
                     VM_HOME=None)
        self.allowed(f'rm {self.root}/leases.json', VM_HOME=None)

    def test_reads_and_other_files_pass(self):
        r = self.root
        for command in [f'cat {r}/leases.json', f'jq . {r}/machines.json',
                        f'cp {r}/leases.json /tmp/backup.json', f'tail -f {r}/vm.log',
                        f'grep luna {r}/leases.json', f'ls -la {r}', f'cp x {r}/win/notes.txt',
                        f'echo hi > {r}/win/oem/install.bat', f'rm {r}/win/old.iso',
                        'echo hi > /tmp/leases.json', 'rm -rf /tmp/vm-test',
                        'sed -i s/a/b/ notes.txt', 'touch README.md',
                        f'find {r} -name "*.json"', f'find {r} -exec cat {{}} +',
                        'find ~ -name "*.tmp" -delete', f'find {self.home} -name x -delete',
                        f'find {r} -name "*.tmp" -delete', f'find {r}/win -delete']:
            with self.subTest(command):
                self.allowed(command)


class ClaudeFileToolTests(VmCase):

    def tool(self, name, path):
        key = 'notebook_path' if name == 'NotebookEdit' else 'file_path'
        return self.hook({'tool_name': name, 'cwd': str(self.work),
                          'tool_input': {key: str(path), 'content': '{}'}})

    def test_writes_to_state_files_are_blocked(self):
        for name in ('Write', 'Edit', 'NotebookEdit'):
            for file in ('leases.json', 'machines.json', 'watch-state.json', 'vm.log'):
                with self.subTest(name=name, file=file):
                    result = self.tool(name, self.root / file)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertIn('only the vm command writes', result.stderr)

    def test_old_root_is_blocked_and_other_files_pass(self):
        result = self.tool('Write', self.home / 'vm-busi/deadline')
        self.assertEqual(result.returncode, 2)
        self.assertIn('vm extend', result.stderr)
        for path in (self.work / 'leases.json', self.root / 'win/oem/install.bat',
                     self.work / 'notes.ipynb'):
            with self.subTest(path=path):
                self.assertEqual(self.tool('Edit', path).returncode, 0)


class ScheduleTests(VmCase):

    def unit(self, name, text):
        folder = self.home / '.config/systemd/user'
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_text(text)

    def test_vm_power_schedules_are_blocked(self):
        self.unit('qa290-mac-guard.service', '[Service]\nExecStart=docker stop vm-mac-1\n')
        self.unit('stopper.timer', '[Timer]\nOnActiveSec=3h\n')
        self.unit('stopper.service', '[Service]\nExecStart=/usr/bin/docker stop vm-win-1\n')
        unit_dir = self.home / '.config/systemd/user'
        for command in ['systemd-run --user --on-active=3h docker stop vm-win-1',
                        'systemd-run --user --on-active=3h bash -c "docker stop vm-win-1"',
                        'systemd-run --user --on-active 3h uv run --no-project python '
                        '~/.agents/skills/vm/scripts/vm.py return win',
                        'systemctl --user start qa290-mac-guard.service',
                        'systemctl --user enable --now stopper.timer',
                        'systemctl --user start busi-vm-guard',
                        'echo "docker stop vm-win-1" | at now + 3 hours',
                        "at now + 1 hour <<'EOF'\ndocker stop vm-mac-1\nEOF",
                        '(crontab -l; echo "0 3 * * * docker stop vm-win-1") | crontab -',
                        f"cat > {unit_dir}/x.service <<'EOF'\n[Service]\n"
                        "ExecStart=docker stop vm-win-1\nEOF",
                        'sudo systemctl start qa290-mac-guard.service',
                        "bash -c 'systemctl --user start stopper.timer'",
                        'x=$(systemd-run --user --on-active=1h docker stop vm-win-1)',
                        'systemctl -M host --user start qa290-mac-guard']:
            with self.subTest(command):
                self.blocked(command, 'vm watcher')

    def test_unrelated_schedules_and_the_vm_watcher_pass(self):
        self.unit('backup.service', '[Service]\nExecStart=/usr/bin/rsync -a a b\n')
        self.unit('vm-watch.service', '[Service]\nExecStart=uv run python vm.py watch\n')
        self.unit('mac-notify.service', '[Service]\nExecStart=notify-send hi\n')
        for command in ['systemctl --user start backup.service',
                        'systemctl --user enable --now vm-watch.service',
                        'systemctl --user restart lat-board', 'systemctl --user status vm-watch',
                        'systemd-run --user --on-active=1h echo hi',
                        'systemd-run --user --scope -p MemoryMax=4G timeout 60 '
                        'pytest skills/local/vm/tests/test_vm.py',
                        'echo "make report" | at now + 1 hour', 'crontab -l',
                        'crontab -l | grep vm-win-1', 'systemctl --user restart mac-notify.service',
                        'systemctl --user start win-build.timer',
                        'systemd-run --user --wait uv run python ~/.agents/skills/vm/scripts/vm.py list']:
            with self.subTest(command):
                self.allowed(command)


class KvmCreateTests(VmCase):

    def test_docker_run_with_kvm_is_always_blocked(self):
        for command in [f'docker run -d --name vm-win-1 {KVM} -v {self.root}/win:/storage '
                        'dockurr/windows',
                        'docker run --device /dev/kvm sickcodes/docker-osx',
                        'docker run -v /dev/kvm:/dev/kvm x', 'docker container run --device=/dev/kvm x',
                        "sudo bash -c 'docker run --device=/dev/kvm x'",
                        'id=$(docker run -d --device=/dev/kvm x)']:
            with self.subTest(command):
                self.blocked(command, 'docker create')

    def test_the_borrower_may_create_its_registered_container(self):
        for command in [f'docker create --name vm-win-1 {KVM} -v {self.root}/win/storage:/storage '
                        f'-v {self.root}/win/oem:/oem -p 127.0.0.1:8006:8006 dockurr/windows',
                        f'docker create --name=vm-win-1 --device /dev/kvm '
                        f'--mount type=bind,source={self.root}/win,target=/storage x',
                        f'cd {self.root}/win && docker create --name vm-win-1 --device=/dev/kvm '
                        '-v ./storage:/storage x',
                        'docker create --name vm-win-1 --device=/dev/kvm -v $VM_HOME/win:/s x']:
            with self.subTest(command):
                self.allowed(command)

    def test_other_creators_names_and_mounts_are_blocked(self):
        good = f'-v {self.root}/win:/storage dockurr/windows'
        cases = [
            (f'docker create --name vm-win-1 {KVM} {good}', 'nova', 'is borrowed by luna'),
            (f'docker create --name vm-win-1 {KVM} {good}', None, 'HCOM'),
            (f'docker create --name vm-mac-1 {KVM} -v {self.root}/mac:/s x', 'luna',
             'is borrowed by'),
            (f'docker create --name vm-lin-1 {KVM} -v {self.root}/lin:/s x', 'luna',
             'nobody has borrowed'),
            (f'docker create --name vm-new-9 {KVM} {good}', 'luna', 'not on the machine list'),
            (f'docker create {KVM} {good}', 'luna', 'not on the machine list'),
            (f'docker create --name vm-win-1 {KVM} -v /data/win:/storage x', 'luna',
             'mounts only'),
            (f'docker create --name vm-win-1 {KVM} -v {self.root}/mac:/storage x', 'luna',
             'mounts only'),
            (f'docker create --name vm-win-1 {KVM} -v winvol:/storage x', 'luna', 'mounts only'),
            (f'docker create --name vm-win-1 {KVM} -v "${{PWD:-.}}/win:/storage" x', 'luna',
             'mounts only'),
        ]
        for command, who, text in cases:
            with self.subTest(command=command, who=who):
                self.blocked(command, text, HCOM_INSTANCE_NAME=who)


class HumanFlagTests(VmCase):

    def test_user_only_flags_are_blocked(self):
        vm = 'uv run --no-project python ~/.agents/skills/vm/scripts/vm.py'
        for command in [f'{vm} borrow --human win "x"', f'{vm} extend win --human',
                        f'{vm} borrow win x --hum', f'{vm} reclaim win --stop',
                        f'{vm} --root /tmp/v reclaim win --to-human', 'vm borrow win x --human',
                        'vm reclaim win --stop', 'python3 skills/local/vm/scripts/vm.py reclaim win --stop',
                        f"bash -c '{vm} reclaim win --stop'", f'{vm} borrow win x --hu',
                        'uv run ~/.agents/skills/vm/scripts/vm.py reclaim win --stop',
                        'python3 -u ~/.agents/skills/vm/scripts/vm.py reclaim win --stop',
                        '~/.agents/skills/vm/scripts/vm.py borrow --human win x',
                        f'sudo {vm} reclaim win --stop', f'x=$({vm} borrow --human win x)']:
            with self.subTest(command):
                self.blocked(command, 'for the user only')

    def test_ordinary_vm_actions_pass(self):
        vm = 'uv run --no-project python ~/.agents/skills/vm/scripts/vm.py'
        for command in [f'{vm} list', f'{vm} borrow win "test installer" --hours 2',
                        f'{vm} extend win --hours 1', f'{vm} return win', f'{vm} start win',
                        f'{vm} status win', 'vm list', 'grep -n reclaim skills/local/vm/SKILL.md',
                        f'{vm} borrow win reclaim', f'{vm} --root /tmp/reclaim list',
                        'grep -n -- --human skills/local/vm/scripts/vm.py',
                        'git commit -m "vm reclaim --human is user only"']:
            with self.subTest(command):
                self.allowed(command)


class OldFolderTests(VmCase):

    def test_any_path_to_the_old_folder_is_blocked_with_the_new_place(self):
        old = self.home / 'vm-busi'
        cases = [('ssh -F ~/vm-busi/ssh-config busi-win', 'ssh/config'),
                 ('ssh -F ~/vm-busi/ssh-config -i ~/vm-busi/win-key x', 'ssh/config'),
                 ('scp -F $HOME/vm-busi/ssh-config a busi-win:', 'ssh/config'),
                 (f'ssh -i {old}/creds/id_ed25519 x', '/ssh/'),
                 ('~/vm-busi/vmctl start win', 'vm borrow'),
                 ('bash ~/vm-busi/vmctl stop', 'vm return'),
                 ('vmctl start mac', 'vm borrow'),
                 ('echo 2026-11-17T03:00 > ~/vm-busi/deadline', 'vm extend'),
                 ('nohup python3 ~/vm-busi/guard.py &', 'vm watcher'),
                 (f'cd {old} && python3 guard.py', 'vm list'),
                 ('ls ~/vm-busi/win/oem', '/win/oem'),
                 ('cat ~/vm-busi/agent-browser-guide.md', 'vm list'),
                 ('ls ~/vm-busi', 'vm list'),
                 ('rsync -a ~/vm-busi/browser/ /tmp/b', '/browser'),
                 ('ssh -o UserKnownHostsFile=~/vm-busi/creds/known_hosts x', '/ssh/'),
                 ('x=$(cat ~/vm-busi/deadline)', 'vm extend'),
                 ("sudo bash -c 'cat ~/vm-busi/deadline'", 'vm extend')]
        for command, text in cases:
            with self.subTest(command):
                result = self.blocked(command, text)
                self.assertIn('vm-busi', result.stderr)
                self.assertIn(str(self.root), result.stderr)

    def test_a_file_named_from_inside_the_old_folder_is_blocked(self):
        old = self.home / 'vm-busi'
        old.mkdir()
        (old / 'guard.py').write_text('')
        result = self.bash('nohup python3 guard.py &', cwd=old)
        self.assertEqual(result.returncode, 2)
        self.assertIn('vm watcher', result.stderr)

    def test_text_about_the_old_folder_passes(self):
        for command in ['git commit -m "move ~/vm-busi/ssh-config to the new place"',
                        'grep -rn vm-busi docs/', "echo 'see ~/vm-busi/ssh-config'",
                        'ls ~/vm-busier', 'cat notes/vm-busi.md',
                        "rg -n '~/vm-busi/ssh-config' ~/proj", 'grep -rln ~/vm-busi docs',
                        'grep -rn -e ~/vm-busi/vmctl .']:
            with self.subTest(command):
                self.allowed(command)


class MissingDataTests(VmCase):

    def check_resilient(self):
        for command in ['docker ps', 'ls', 'docker stop vm-win-1', 'git status',
                        'echo hi > /tmp/x', 'systemctl --user start backup.service']:
            with self.subTest(command):
                self.allowed(command)
        self.blocked(f'echo {{}} > {self.root}/leases.json', 'only the vm command writes')
        self.blocked(f'docker create --name vm-win-1 {KVM} -v {self.root}/win:/s x',
                     'not on the machine list')
        self.blocked('docker run --device=/dev/kvm x', 'docker create')
        self.blocked('ls ~/vm-busi', 'vm-busi')

    def test_missing_files(self):
        (self.root / 'machines.json').unlink()
        (self.root / 'leases.json').unlink()
        self.check_resilient()

    def test_unreadable_files(self):
        (self.root / 'machines.json').write_text('{not json')
        (self.root / 'leases.json').write_text('[1, 2]')
        self.check_resilient()

    def test_missing_lease_file_blocks_create(self):
        (self.root / 'leases.json').write_text('not json')
        self.blocked(f'docker create --name vm-win-1 {KVM} -v {self.root}/win:/s x',
                     'nobody has borrowed')
        self.allowed('docker inspect vm-win-1')

    def test_missing_data_root(self):
        result = self.bash('docker ps', VM_HOME=str(self.tmp / 'nowhere'))
        self.assertEqual(result.returncode, 0, result.stderr)


class EmulatorTests(VmCase):
    """Android emulators start only through `vm borrow android` (#721)."""

    def test_direct_emulator_starts_are_blocked_with_the_vm_borrow_usage(self):
        engine = '~/Android/Sdk/emulator/qemu/linux-x86_64/qemu-system-x86_64-headless'
        for command, avd in [
                ('emulator -avd pixel', 'pixel'),
                ('~/Android/Sdk/emulator/emulator -avd pixel -no-window -port 5570', 'pixel'),
                ('$ANDROID_HOME/emulator/emulator @pixel', 'pixel'),
                ('"$ANDROID_SDK_ROOT/emulator/emulator" -avd=pixel', 'pixel'),
                ('nohup emulator -avd pixel -no-window > /tmp/emu.log 2>&1 &', 'pixel'),
                ('ANDROID_AVD_HOME=~/Android/qa88-avd setsid emulator -avd qa88 &', 'qa88'),
                ("bash -c 'emulator -avd pixel'", 'pixel'),
                ('cd /tmp && emulator -no-snapshot -avd pixel', 'pixel'),
                ('x=$(emulator -avd pixel &)', 'pixel'),
                ('timeout 600 emulator -avd pixel', 'pixel'),
                (f'{engine} -avd pixel -port 5570', 'pixel'),
                (f'{engine} -no-window', '<name>')]:
            with self.subTest(command):
                result = self.blocked(command, 'vm borrow android')
                self.assertIn(f'--avd {avd}', result.stderr)
                self.assertIn('vm.py', result.stderr)

    def test_creating_listing_and_adb_pass(self):
        for command in [
                'avdmanager create avd -n pixel -k "system-images;android-35;default;x86_64"',
                'emulator -list-avds', 'emulator -version', 'emulator -accel-check',
                '~/Android/Sdk/emulator/emulator -help',
                'adb -s emulator-5554 install app.apk', 'adb -s emulator-5554 shell input tap 1 2',
                'adb -s emulator-5554 emu kill', 'adb devices',
                'qemu-system-x86_64 -name windows -m 16G -enable-kvm',
                'grep -rn "emulator -avd" docs', 'git commit -m "emulator -avd pixel"',
                'uv run --no-project python ~/.agents/skills/vm/scripts/vm.py borrow android '
                '"login test" --avd pixel']:
            with self.subTest(command):
                self.allowed(command)

    def test_codex_shell_lists_are_checked_too(self):
        result = self.hook({'tool_name': 'Bash', 'cwd': str(self.work),
                            'tool_input': {'command': ['bash', '-lc', 'emulator -avd pixel']}})
        self.assertEqual(result.returncode, 2)
        self.assertIn('vm borrow android', result.stderr)


if __name__ == '__main__':
    unittest.main()
