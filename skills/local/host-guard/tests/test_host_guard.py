import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/host-guard.py'


def load():
    spec = importlib.util.spec_from_file_location('host_guard', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


guard = load()


class HookCase(unittest.TestCase):
    """Runs the hook as Claude and Codex do: JSON on stdin, exit 2 and stderr to block."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='host-guard-test-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])
        self.config = self.tmp / 'config.json'
        self.config.write_text(json.dumps({'extra_scan_roots': ['/mnt/raid'],
                                           'max_load_cores': 4}))

    def hook(self, payload):
        env = dict(os.environ, HOST_GUARD_CONFIG=str(self.config))
        return subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=json.dumps(payload),
                              env=env, capture_output=True, text=True)

    def bash(self, command, cwd=None):
        return self.hook({'tool_name': 'Bash', 'cwd': str(cwd or self.tmp),
                          'tool_input': {'command': command}})

    def assert_blocked(self, result, text):
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn(text, result.stderr)

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)


class ScanTests(HookCase):

    def test_scans_rooted_at_protected_paths_are_blocked(self):
        for command in ['find / -name suite-gate.py -not -path "*/node_modules/*"',
                        'sudo find / -xdev -name x', 'timeout 60 find / -name x',
                        'x=$(find / -name y)', 'bash -c "find / -name x"',
                        'du -sh /mnt/raid', 'du -sh /mnt', 'grep -rn foo /', 'rg foo /',
                        'fd suite-gate /', 'ls -R /mnt', 'tree /media/',
                        "cat <<'EOF'\nnote\nEOF\nfind / -name x"]:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), 'scans the whole filesystem')

    def test_narrow_or_shallow_commands_pass(self):
        for command in ['find . -name x', 'find /home/me -name x', 'find / -maxdepth 2 -name x',
                        'du -sh /mnt/raid/data', 'grep foo /etc/passwd', 'ls -la /',
                        'echo find / is slow', 'git log -- / | head', 'find "$HOME" -name x',
                        'git commit -m "stop running find / on the host"',
                        "git commit -F - <<'EOF'\nAgents ran `find /` and `du /mnt`\nEOF\ngit log -1"]:
            with self.subTest(command):
                self.assert_allowed(self.bash(command))

    def test_extra_root_comes_from_the_config(self):
        self.config.write_text('{}')
        self.assert_allowed(self.bash('du -sh /mnt/raid'))

    def test_grep_and_glob_tools_with_a_protected_path_are_blocked(self):
        self.assert_blocked(self.hook({'tool_name': 'Grep', 'tool_input': {'pattern': 'x',
                                                                           'path': '/'}}),
                            'rooted at /')
        self.assert_blocked(self.hook({'tool_name': 'Glob', 'tool_input': {'pattern': '**/x',
                                                                           'path': '/mnt/raid/'}}),
                            'rooted at /mnt/raid')
        self.assert_allowed(self.hook({'tool_name': 'Grep', 'tool_input': {'pattern': 'x'}}))

    def test_codex_list_command_and_bad_payload(self):
        self.assert_blocked(self.hook({'tool_name': 'Bash', 'tool_input': {
            'command': ['bash', '-lc', 'find / -name x']}}), 'scans the whole filesystem')
        bad = subprocess.run([sys.executable, str(SCRIPT), 'hook'], input='not json',
                             capture_output=True, text=True)
        self.assertEqual(bad.returncode, 0)


class LoadTests(HookCase):

    def test_unlimited_load_is_blocked(self):
        for command in ["timeout 3h sh -c 'while :; do :; done' &",
                        'while true; do :; done', 'stress-ng --cpu 30 -t 60',
                        'stress --cpu 8', 'sysbench cpu run', 'yes > /dev/null &']:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), 'taskset -c 0-3')

    def test_load_on_few_cores_passes(self):
        for command in ["taskset -c 0-3 sh -c 'while :; do :; done' &",
                        'taskset -c 0,1 stress-ng --cpu 2',
                        'systemd-run --user --scope -p AllowedCPUs=0-3 stress-ng --cpu 4',
                        'cpulimit -l 200 -- stress --cpu 2', 'stress-ng --help | head',
                        'echo done', "echo 'never run while :; do :; done unpinned'",
                        'bunx skills add ~/repo --skill lat --global --yes > /dev/null 2>&1']:
            with self.subTest(command):
                self.assert_allowed(self.bash(command))

    def test_taskset_above_the_core_limit_is_blocked(self):
        self.assert_blocked(self.bash('taskset -c 0-15 stress-ng --cpu 16'), 'at most 4 cores')

    def test_a_script_that_starts_unlimited_load_is_blocked(self):
        script = self.tmp / 'loadcmp.sh'
        script.write_text("for i in $(seq 30); do timeout 3h sh -c 'while :; do :; done' & done\n"
                          'pytest\n')
        for command in ['bash loadcmp.sh', f'bash {script}', './loadcmp.sh',
                        'BUSY=30 RUNS=10 bash loadcmp.sh 2>&1 | tail']:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), f'in {script}')

    def test_a_script_run_under_taskset_passes(self):
        script = self.tmp / 'loadcmp.sh'
        script.write_text("timeout 3h sh -c 'while :; do :; done' &\n")
        self.assert_allowed(self.bash('taskset -c 0-3 bash loadcmp.sh'))
        script.write_text("taskset -c 0-1 sh -c 'while :; do :; done' &\n")
        self.assert_allowed(self.bash('bash loadcmp.sh'))


class HeredocTests(HookCase):

    def test_an_unquoted_heredoc_that_substitutes_a_command_is_blocked(self):
        for command, name in [('cat > brief.md <<EOF\nNever run `bun run build`.\nEOF', 'EOF'),
                              ('cat <<-MSG\n\tnow: $(date)\n\tMSG', 'MSG'),
                              ('git commit -m "$(cat <<EOF\nfix `x`\nEOF\n)"', 'EOF')]:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), f"(<<'{name}')")

    def test_literal_or_variable_only_heredocs_pass(self):
        for command in ["cat > brief.md <<'EOF'\nNever run `bun run build` or $(pkill).\nEOF",
                        'cat > brief.md <<"EOF"\nrun `x`\nEOF',
                        'cat <<\\EOF\nrun `x`\nEOF',
                        'cat <<EOF\nhome is $HOME, cost \\$(not run) and \\`literal\\`\nEOF',
                        'grep -c x <<<"`echo`"',
                        'echo "`date`"']:
            with self.subTest(command):
                self.assert_allowed(self.bash(command))


class DeleteTests(HookCase):
    """Deletes that wipe a folder of agent conversation records or state by mistake."""

    def hook(self, payload):
        env = {k: v for k, v in os.environ.items()
               if k not in ('CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_STATE_HOME')}
        env.update(HOME=str(self.tmp), HOST_GUARD_CONFIG=str(self.config), **self.extra_env)
        return subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=json.dumps(payload),
                              env=env, capture_output=True, text=True)

    extra_env = {}

    def test_a_path_ending_in_a_substitution_is_blocked(self):
        # The 2026-10-23 case: the substitution came out empty and trashed a whole project folder.
        for command in ["trash-put ~/.claude/projects/-x/$(cut -d' ' -f2 /dev/null) 2>/dev/null",
                        'rm -rf "$T/$name"', 'rm -f $dir/${file}', 'trash $out/`ls`',
                        'sudo rm -r /srv/$(date)', 'xargs rm -rf build/$x',
                        'gio trash ./$x', 'rm -rf "$T"/"$name"',
                        'trash-put ~/.claude/projects/-x/`cut -f2 /nonexistent`',
                        "trash-put ~/.claude/projects/-x/$(cut -d')' -f2 /nonexistent)",
                        "trash-put ~/.claude/projects/-x/$(cut -f2 '/nonexistent')",
                        'trash-put ~/.claude/projects/-x/$(cut -f2 "/nonexistent")',
                        "trash-put '/tmp/parent/'$name", "trash-put '/tmp/parent/'\"$name\"",
                        'rm -rf /$x']:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), 'ends in a substitution')

    def test_agent_record_and_state_folders_are_blocked(self):
        for command, path in [('trash-put ~/.hcom', '.hcom'),
                              ('rm -rf ~/.claude/projects', '.claude/projects'),
                              ('rm -rf ~/.claude/projects/-home-x-proj/',
                               '.claude/projects/-home-x-proj'),
                              ('rm -rf $HOME/.codex/sessions', '.codex/sessions'),
                              ('trash-put ~/.local/state/lat', '.local/state/lat'),
                              ('bash -c "rm -rf ~/.local/state"', '.local/state'),
                              ('cd x; trash-put ~', str(self.tmp)),
                              ('/bin/rm -rf ~/.hcom', '.hcom'),
                              ('bash -lc "trash-put ~/.hcom"', '.hcom'),
                              ('if true; then trash-put ~/.hcom; fi', '.hcom'),
                              ('env LANG=C trash-put ~/.hcom', '.hcom'),
                              ('LANG=C rm -rf ~/.hcom', '.hcom'),
                              ('{ rm -rf ~/.hcom; }', '.hcom'),
                              ('cd ~/.claude && trash-put projects', '.claude/projects'),
                              ('cd "$HOME/.claude" && trash-put projects', '.claude/projects'),
                              (f"trash-put '{self.tmp}/.hcom'", '.hcom'),
                              (f"rm -rf '{self.tmp}/.claude'", '.claude')]:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), path)

    def test_a_cd_that_may_not_apply_still_counts_the_start_folder(self):
        claude = self.tmp / '.claude'
        claude.mkdir()
        for command in ['(cd /tmp); trash-put projects', 'cd /tmp | trash-put projects']:
            with self.subTest(command):
                self.assert_blocked(self.bash(command, cwd=claude), '.claude/projects')

    def test_ordinary_deletes_pass(self):
        for command in ['rm ~/.claude/projects/-home-x-proj/abc.jsonl', 'trash-put $S/deploy',
                        'rm -rf "${T:?}/${name:?}"', 'trash-put build-prev', 'trash-put $T',
                        'git rm --cached x', 'echo "rm -rf ~/.hcom"', 'shred -u $T/$pw',
                        "cat <<'EOF'\nrm -rf ~/.hcom $a/$b\nEOF",
                        'git commit -m "fix: document cleanup; rm -rf ~/.hcom"',
                        "trash-put '/tmp/$x'", "trash-put '/tmp/a/$x'", 'rm -rf "${T:?}"/x',
                        'cd /tmp && trash-put projects']:
            with self.subTest(command):
                self.assert_allowed(self.bash(command))


class DeleteOverrideTests(DeleteTests):
    """The client and state folders follow CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_STATE_HOME."""

    def setUp(self):
        super().setUp()
        self.extra_env = {'CLAUDE_CONFIG_DIR': str(self.tmp / 'cc'),
                          'CODEX_HOME': str(self.tmp / 'cx'), 'XDG_STATE_HOME': str(self.tmp / 'st')}

    def test_agent_record_and_state_folders_are_blocked(self):
        for command, path in [('trash-put "$CODEX_HOME/sessions"', 'cx/sessions'),
                              ('rm -rf ${CLAUDE_CONFIG_DIR}/projects', 'cc/projects'),
                              ('trash-put $XDG_STATE_HOME/lat', 'st/lat')]:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), path)

    def test_a_cd_that_may_not_apply_still_counts_the_start_folder(self):
        claude = self.tmp / 'cc'
        claude.mkdir()
        self.assert_blocked(self.bash('(cd /tmp); trash-put projects', cwd=claude), 'cc/projects')


class InstallTests(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='host-guard-install-'))
        self.addCleanup(subprocess.run, ['rm', '-rf', str(self.tmp)])

    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True)

    def test_claude_install_keeps_other_entries_backs_up_and_is_idempotent(self):
        settings = self.tmp / 'settings.json'
        other = {'matcher': 'Bash', 'hooks': [{'type': 'command', 'command': 'other.py'}]}
        settings.write_text(json.dumps({'model': 'x', 'hooks': {'PreToolUse': [other]}}))
        preview = self.run_cli('install', '--client', 'claude', '--claude-settings', str(settings),
                               '--preview')
        self.assertEqual(preview.returncode, 0, preview.stderr)
        self.assertNotIn('host-guard.py', settings.read_text())
        for _ in range(2):
            result = self.run_cli('install', '--client', 'claude', '--claude-settings',
                                  str(settings))
            self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(settings.read_text())
        self.assertEqual(data['model'], 'x')
        groups = data['hooks']['PreToolUse']
        self.assertEqual(groups[0], other)
        self.assertEqual(len(groups), 2)
        self.assertEqual(groups[1]['matcher'], 'Bash|Grep|Glob')
        self.assertEqual(groups[1]['hooks'][0]['command'], guard.HOOK_COMMAND)
        self.assertTrue(list(self.tmp.glob('settings.json.host-guard-backup-*')))

    def test_codex_install_names_the_group_and_uninstall_removes_only_it(self):
        codex = self.tmp / 'codex'
        codex.mkdir()
        other = {'name': 'suite-gate', 'matcher': 'Bash',
                 'hooks': [{'type': 'command', 'command': 'suite-gate.py hook'}]}
        (codex / 'hooks.json').write_text(json.dumps({'hooks': {'PreToolUse': [other]}}))
        self.assertEqual(self.run_cli('install', '--client', 'codex', '--codex-home',
                                      str(codex)).returncode, 0)
        groups = json.loads((codex / 'hooks.json').read_text())['hooks']['PreToolUse']
        self.assertEqual(groups[1]['name'], 'host-guard')
        self.assertEqual(groups[1]['matcher'], 'Bash')
        self.assertEqual(self.run_cli('uninstall', '--client', 'codex', '--codex-home',
                                      str(codex)).returncode, 0)
        groups = json.loads((codex / 'hooks.json').read_text())['hooks']['PreToolUse']
        self.assertEqual(groups, [other])


if __name__ == '__main__':
    unittest.main()
