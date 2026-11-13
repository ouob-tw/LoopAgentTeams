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

    def test_load_block_suggests_cpu_quota_in_the_tests_slice(self):
        message = self.bash('stress-ng --cpu 30 -t 60').stderr
        self.assertIn('--slice=lat-tests.slice -p CPUQuota=', message)
        self.assertIn('AllowedCPUs does not take effect', message)

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


class TestRunTests(HookCase):
    """Runners need a memory limit and a timeout, on hosts where the limit can be applied."""

    LIMITED = ('systemd-run --user --scope -q -p MemoryMax=40G -p MemorySwapMax=0 '
               '-p OOMPolicy=continue timeout 600 ')

    def setUp(self):
        super().setUp()
        runtime = self.tmp / 'runtime/systemd'
        runtime.mkdir(parents=True)
        (runtime / 'private').touch()
        bin_dir = self.tmp / 'bin'
        bin_dir.mkdir()
        tool = bin_dir / 'systemd-run'
        tool.touch()
        tool.chmod(0o755)
        self.env = {'XDG_RUNTIME_DIR': str(self.tmp / 'runtime'), 'PATH': str(bin_dir)}

    def run_hook(self, command, env=None):
        full = dict(os.environ, HOST_GUARD_CONFIG=str(self.config), **(env or self.env))
        payload = {'tool_name': 'Bash', 'cwd': str(self.tmp), 'tool_input': {'command': command}}
        return subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=json.dumps(payload),
                              env=full, capture_output=True, text=True)

    def test_unlimited_runners_are_blocked(self):
        for command in ['bun test tests/unit/panel.test.js', 'nice bun run test',
                        'nice -n 5 bun run test:unit', 'pytest -q', 'uv run pytest tests/a.py',
                        'uv run --no-sync pytest -q', 'uv run --with x pytest -q',
                        'python3 -m pytest', '.venv/bin/pytest -q', 'bunx vitest run',
                        'bun x vitest', 'npx vitest', 'cargo test --locked', 'cargo +nightly test',
                        'cd app && bun test', 'FOO=1 pytest', 'bash -c "cargo test"',
                        'timeout 90 bun test', 'x=1; pytest',
                        'systemd-run --user --scope -p MemoryMax=40G bun test',
                        'systemd-run --user --scope -p CPUQuota=50% timeout 90 pytest',
                        'bun --cwd app test', 'bun --cwd app run test',
                        'cargo --manifest-path app/Cargo.toml test', 'time pytest -q',
                        'time -p bun test', 'MemoryMax=40G timeout 600 pytest -q',
                        'systemd-run --user --scope -p MemoryMax=infinity timeout 600 pytest',
                        'systemd-run --user --scope -p MemoryMax=8G timeout 0 pytest -q',
                        "bash -c 'pytest -q'", "/bin/bash -c 'pytest -q'",
                        'timeout -k 5 600 pytest -q',
                        'systemd-run --user --scope -p MemoryMax=8G timeout .0 pytest',
                        'systemd-run --user --scope -p MemoryMax=8G timeout 0s pytest']:
            with self.subTest(command):
                result = self.run_hook(command)
                self.assert_blocked(result, 'memory limit')
                self.assertIn('MemoryMax=40G', result.stderr)

    def test_limited_runners_pass(self):
        for runner in ['bun test tests/unit', 'uv run --no-sync pytest -q', 'cargo test',
                       'bun run test', 'bunx vitest run']:
            with self.subTest(runner):
                self.assert_allowed(self.run_hook(self.LIMITED + runner))
        self.assert_allowed(self.run_hook(
            'timeout 600 systemd-run --user --scope -p MemoryMax=8G bun test'))
        self.assert_allowed(self.run_hook(self.LIMITED + "bash -c 'pytest -q'"))
        self.assert_allowed(self.run_hook(self.LIMITED + "/bin/bash -c 'pytest -q'"))
        self.assert_allowed(self.run_hook(self.LIMITED + "bash -c \"bash -c 'pytest -q'\""))
        self.assert_allowed(self.run_hook(
            'systemd-run --user --scope -p MemoryMax=8G timeout .5 pytest -q'))
        self.assert_allowed(self.run_hook(
            'systemd-run --user --scope --property=MemoryMax=8G timeout 10m cargo test'))
        self.assert_allowed(self.run_hook(
            'systemd-run --user --scope -p MemoryMax=8G timeout -k 5 600 pytest -q'))

    def test_each_runner_in_a_command_is_checked(self):
        self.assert_blocked(self.run_hook(self.LIMITED + 'pytest -q && bun test'), 'memory limit')

    def test_mentions_are_not_test_runs(self):
        for command in ['grep pytest pyproject.toml', 'uv pip install pytest', 'which pytest',
                        'echo "bun test failed"', "pgrep -f 'bun test tests/unit'",
                        'cargo testing', 'bun install', 'cargo build', 'ls pytest.ini',
                        'git log --grep pytest', 'cat <<\'EOF\'\nbun test\nEOF',
                        "suite-gate.py run -- 'uv run pytest -q'",
                        "grep -c 'pytest' pyproject.toml", "rg -c 'bun test' README.md",
                        'bun test.js', 'cargo test-helper', "echo bash -c 'pytest'",
                        "printf '%s\\n' bash -c 'pytest'"]:
            with self.subTest(command):
                self.assert_allowed(self.run_hook(command))

    def test_skipped_where_the_limit_cannot_be_applied(self):
        no_tool = dict(self.env, PATH=str(self.tmp))
        self.assert_allowed(self.run_hook('bun test', env=no_tool))
        no_manager = dict(self.env, XDG_RUNTIME_DIR=str(self.tmp / 'nowhere'))
        self.assert_allowed(self.run_hook('bun test', env=no_manager))

    def test_limit_comes_from_the_config_and_a_bad_value_falls_back(self):
        self.config.write_text(json.dumps({'test_memory_limit': '12G'}))
        self.assertIn('MemoryMax=12G', self.run_hook('pytest').stderr)
        self.config.write_text(json.dumps({'test_memory_limit': '1 G; rm'}))
        self.assertIn('MemoryMax=40G', self.run_hook('pytest').stderr)


class PatternKillTests(HookCase):
    """pkill -f and killall reach every matching process, not only the one meant."""

    def assert_kill_blocked(self, command):
        result = self.bash(command)
        self.assert_blocked(result, 'kill <PID>')
        self.assertIn('pgrep -af', result.stderr)

    def test_pattern_kills_are_blocked(self):
        for command in ["pkill -f 'http.server 7111 --bind'", 'pkill --full node', 'pkill --ful node',
                        'pkill -9fx node', 'pkill -xf node', 'pkill -9 -f node', 'pkill node -f',
                        'pkill "-f" node', 'pkill -TERM -f node', 'pkill -u swy -f node',
                        '/usr/bin/pkill -f node', '\\pkill -f node', 'killall node',
                        'killall -9 node', '/usr/bin/killall node']:
            with self.subTest(command):
                self.assert_kill_blocked(command)

    def test_prefixes_and_nested_commands_are_blocked(self):
        for command in ['sudo pkill -f node', 'sudo -u swy pkill -f node', 'sudo -n killall node',
                        'sudo --user swy pkill -f node', 'timeout 5 pkill -f node',
                        'timeout 5s killall node', 'timeout -k 5 10 pkill -f node',
                        'timeout --signal KILL 5 pkill -f node', 'timeout .5 pkill -f node',
                        'echo node | xargs pkill -f', 'echo node | xargs -r pkill -f',
                        'echo node | xargs -I {} pkill -f {}', 'echo node | xargs -n 1 killall',
                        'nice -n 5 pkill -f node', 'nohup killall node', 'env A=1 pkill -f node',
                        'A=1 pkill -f node', 'command pkill -f node', 'exec killall node',
                        "bash -c 'pkill -f node'", "bash -lc 'killall node'", 'sh -c "pkill -f node"',
                        "/bin/bash -c 'pkill -f node'", "sudo bash -c 'pkill -f node'",
                        """bash -c "bash -c 'pkill -f node'\"""", "cd /tmp && pkill -f node",
                        'true; killall node', 'false || pkill -f node', 'x=$(pkill -f node)',
                        'echo `pkill -f node`', '(pkill -f node)', '{ pkill -f node; }',
                        '! pkill -f node', 'if true; then pkill -f node; fi',
                        'for p in a; do pkill -f $p; done', 'pkill -f node &',
                        "cat <<'EOF'\nnote\nEOF\npkill -f node",
                        'sudo --host localhost pkill -f node', '> /tmp/out pkill -f node',
                        '>/tmp/out pkill -f node', '2>/dev/null killall node',
                        '>&2 pkill -f node', "bash -c '> /tmp/out pkill -f node'",
                        'sudo > /tmp/out pkill -f node',
                        'echo "<<EOF"\npkill -f node\nEOF', 'echo \'<<EOF\'\nkillall node\nEOF',
                        '# <<EOF\npkill -f node\nEOF',
                        'echo "a << b"\npkill -f node', 'echo $((1<<2))\npkill -f node',
                        '((x = 1 << 2))\nkillall node', 'taskset -c 0 pkill -f node',
                        'taskset 0x1 killall node', 'setsid killall node',
                        'timeout 1e3 pkill -f node', 'mask=$((1 << 3))\npkill -f node',
                        'echo $(((1+(2))<<2))\npkill -f node',
                        'stdbuf -oL pkill -f node', 'stdbuf -o L pkill -f node',
                        'systemd-run --user --scope pkill -f node',
                        'systemd-run --user --scope -p MemoryMax=1G killall node']:
            with self.subTest(command):
                self.assert_kill_blocked(command)

    def test_codex_list_command_is_blocked(self):
        result = self.hook({'tool_name': 'Bash', 'tool_input': {
            'command': ['bash', '-lc', 'pkill -f node']}})
        self.assert_blocked(result, 'kill <PID>')

    def test_mentions_pass(self):
        for command in ['grep pkill notes.md', 'grep -f list pkill', 'echo pkill -f node',
                        'echo killall', 'man killall', 'which killall', 'command -v killall',
                        "echo 'pkill -f node'", 'echo "; killall node"',
                        'git commit -m "stop using pkill -f node"', '# pkill -f node',
                        'echo done # killall node', 'echo \\`pkill -f node\\`',
                        "cat <<'EOF'\npkill -f node\nEOF",
                        'cat <<EOF\nkillall node\nEOF',
                        "cat <<'END-NOTE'\npkill -f node\nEND-NOTE",
                        'cat <<\\EOF\nkillall node\nEOF',
                        "cat <<-'EOF'\n\tpkill -f node\n\tEOF",
                        "cat <<'EOF'\npkill -f node", "cat <<'A' <<'B'\nkillall x\nA\nkillall y\nB",
                        'cat <<< "killall node"',
                        'git commit -m "$(cat <<\'EOF\'\nsaid "x\nkillall is blocked\nEOF\n)"',
                        """git commit -F - <<'EOF'\nfix\nkillall node\nEOF\ngit log -1"""]:
            with self.subTest(command):
                self.assert_allowed(self.bash(command))

    def test_narrow_kills_pass(self):
        for command in ['pkill node', 'pkill -x node', 'pkill -9 node', 'pkill -HUP node',
                        'pkill -SIGTERM node', 'pkill -ufoo node', 'pkill -u foo node',
                        'pkill --signal TERM node', 'pkill -- -f', 'pgrep -f node', 'pgrep -af node',
                        'kill 123', 'kill -9 123', 'sudo kill 123', 'kill $(cat pidfile)',
                        'pgrep -f node | xargs kill', 'killall5-notes']:
            with self.subTest(command):
                self.assert_allowed(self.bash(command))


class HeredocTests(HookCase):

    def test_an_unquoted_heredoc_that_substitutes_a_command_is_blocked(self):
        for command, name in [('cat > brief.md <<EOF\nNever run `bun run build`.\nEOF', 'EOF'),
                              ('cat <<-MSG\n\tnow: $(date)\n\tMSG', 'MSG'),
                              ('git commit -m "$(cat <<EOF\nfix `x`\nEOF\n)"', 'EOF'),
                              ('cat <<EOF-TEXT\nrun `x`\nEOF-TEXT', 'EOF-TEXT'),
                              ('cat <<END.X > f\nnow $(date)\nEND.X', 'END.X'),
                              ('cat <<EOF\npath \\\\$(date)\nEOF', 'EOF'),
                              ("cat <<'A'\nplain\nA\ncat <<B\nrun `x`\nB", 'B'),
                              ('cat <<EOF\nEOF  \n$(printf expanded)\nEOF', 'EOF'),
                              ('cat <<-EOF\n  EOF\n$(date)\n\tEOF', 'EOF'),
                              ("cat <<'A' # <<'B'\nliteral\nA\ncat <<B\n$(printf x)\nB", 'B'),
                              ("cat <<'A'; echo \\\"; cat <<B\nliteral\nA\n$(printf x)\nB", 'B'),
                              ("cat <<'A' <<B; echo \"<<'C'\"\nliteral\nA\n$(printf x)\nB", 'B'),
                              ("cat <<'A' <<B\nliteral\nA\n$(date)\nB", 'B')]:
            with self.subTest(command):
                self.assert_blocked(self.bash(command), f"(<<'{name}')")

    def test_literal_or_variable_only_heredocs_pass(self):
        for command in ["cat > brief.md <<'EOF'\nNever run `bun run build` or $(pkill).\nEOF",
                        'cat > brief.md <<"EOF"\nrun `x`\nEOF',
                        'cat <<\\EOF\nrun `x`\nEOF',
                        'cat <<EOF\nhome is $HOME, cost \\$(not run) and \\`literal\\`\nEOF',
                        'cat <<EOF\nthree backslashes \\\\\\$(not run)\nEOF',
                        "cat <<'EOF'\nwrite <<EOF and `x`\nmore\nEOF",
                        "cat <<'EOF'\nExample:\ncat <<TXT\nrun $(date)\nTXT\nEOF",
                        'cat <<"EOF-TEXT"\nrun `x`\nEOF-TEXT',
                        "cat <<'A' <<'B'\nrun `x`\nA\nrun $(y)\nB",
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
        for command in ['(cd /tmp); trash-put projects', 'cd /tmp | trash-put projects',
                        'cd /tmp; trash-put projects', 'cd /tmp && true; trash-put projects',
                        'true || cd /tmp && trash-put projects',
                        'printf x | cd /tmp && trash-put projects',
                        'true ||\n cd /tmp && trash-put projects',
                        'printf x | \\\n cd /tmp && trash-put projects',
                        'cd /nonexistent && printf ready\ntrash-put projects']:
            with self.subTest(command):
                self.assert_blocked(self.bash(command, cwd=claude), '.claude/projects')

    def test_a_cd_joined_by_and_moves_the_delete(self):
        claude = self.tmp / '.claude'
        claude.mkdir()
        for command, cwd in [('cd /tmp && trash-put projects', claude),
                             ('cd /tmp && ls && trash-put .claude', self.tmp),
                             ('(cd /tmp && trash-put projects)', claude),
                             ('cd /tmp; cd /tmp && trash-put .claude', self.tmp),
                             ('ls && cd /tmp && trash-put projects', claude),
                             ('cd /tmp &&\n  trash-put projects', claude),
                             ('printf x | cat\ncd /tmp && trash-put .claude', self.tmp)]:
            with self.subTest(command):
                self.assert_allowed(self.bash(command, cwd=cwd))

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
                          'CODEX_HOME': str(self.tmp / 'cx'),
                          'XDG_STATE_HOME': str(self.tmp / 'st')}

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


class SkillsAddTests(HookCase):
    """`bunx skills add` from a LoopAgentTeams checkout (it has the install script)."""

    def setUp(self):
        super().setUp()
        self.home = self.tmp / 'home'
        self.repo = self.home / 'LoopAgentTeams'
        (self.repo / 'scripts').mkdir(parents=True)
        (self.repo / 'scripts/install-skills.py').write_text('')
        (self.repo / 'skills/local/lat').mkdir(parents=True)
        (self.home / 'other/skills').mkdir(parents=True)

    def hook(self, payload):
        env = dict(os.environ, HOST_GUARD_CONFIG=str(self.config), HOME=str(self.home))
        return subprocess.run([sys.executable, str(SCRIPT), 'hook'], input=json.dumps(payload),
                              env=env, capture_output=True, text=True)

    def test_installs_from_the_repo_are_blocked(self):
        for command, cwd in [
                ('bunx skills add ~/LoopAgentTeams --skill lat --global --yes', None),
                (f'bunx skills add {self.repo} --skill lat hcom-spawn', None),
                ('bunx skills@latest add "$HOME/LoopAgentTeams/" -g -y', None),
                ('npx skills add ~/LoopAgentTeams/skills/local/lat', None),
                ('bun x skills add ~/LoopAgentTeams', None),
                ('cd ~/LoopAgentTeams && bunx skills add . --skill lat', None),
                ('bunx skills add ./ --skill lat', self.repo / 'skills'),
                ("bash -lc 'bunx skills add ~/LoopAgentTeams --skill lat'", None),
                ('timeout 300 bunx skills add ~/LoopAgentTeams 2>&1 | tail', None),
                (f'CI=1 bunx skills add {self.repo}', None),
                (f'env FOO=1 bunx skills add {self.repo}', None),
                ('/usr/local/bin/bunx skills add ~/LoopAgentTeams', None),
                ("bash -lc 'cd ~/LoopAgentTeams && bunx skills add .'", None),
                ('cd "$HOME/LoopAgentTeams" && bunx skills add .', None),
                ('(cd ~/LoopAgentTeams; bunx skills add .)', None),
                ('out=$(bunx skills add ~/LoopAgentTeams)', None),
                (f"FOO='a b' bunx skills add {self.repo}", None),
                ('nice -n 10 bunx skills add ~/LoopAgentTeams', None),
                ("bash -lc 'cd /tmp' && bunx skills add .", self.repo),
                ('(cd /tmp) && bunx skills add .', self.repo),
                ("# update the user's skills\nbunx skills add ~/LoopAgentTeams", None),
                ('cd -- ~/LoopAgentTeams && bunx skills add .', None),
                ('sudo -u swy bunx skills add ~/LoopAgentTeams', None),
                ('bunx skills add ~/Loop\\AgentTeams', None),
                ('bunx skills add "$HOME"/\'LoopAgentTeams\'', None),
                ('CI=1 \\\n  bunx skills add ~/LoopAgentTeams', None),
                ('env CI=1 \\\n  bunx \\\n  skills add ~/LoopAgentTeams --skill lat', None),
                ('echo x | xargs -r bunx skills add ~/LoopAgentTeams', None),
                ('timeout 1e3 bunx skills add ~/LoopAgentTeams', None),
                ('{ bunx skills add ~/LoopAgentTeams; }', None),
                ('mask=$((1 << 3))\nbunx skills add ~/LoopAgentTeams', None),
                ('v=`cd /tmp; pwd`; bunx skills add .', self.repo)]:
            with self.subTest(command):
                result = self.bash(command, cwd)
                self.assert_blocked(result, f'{self.repo}/scripts/install-skills.py')
                self.assertIn(f'from the LoopAgentTeams repo at {self.repo}', result.stderr)

    def test_installs_from_other_sources_pass(self):
        for command in ['bunx skills add mattpocock/skills --skill tdd --global --yes',
                        'bunx skills add ouob-tw/LoopAgentTeams --skill lat',
                        'bunx skills add ~/other --skill lat',
                        'cd ~/LoopAgentTeams && bunx skills add ~/other',
                        'bunx skills list', 'echo bunx skills add ~/LoopAgentTeams',
                        "echo 'bunx skills add ~/LoopAgentTeams'",
                        'printf \'%s\\n\' "bunx skills add $HOME/LoopAgentTeams"',
                        'git commit -m "block bunx skills add ~/LoopAgentTeams"',
                        "printf '%s\\n' 'example; bunx skills add ~/LoopAgentTeams'",
                        'echo "example\nbunx skills add ~/LoopAgentTeams"',
                        'echo "bash -lc \'bunx skills add ~/LoopAgentTeams\'"',
                        "cd /tmp && bash -c 'cd ~/LoopAgentTeams' && bunx skills add .",
                        'cd ~/other && (cd ~/LoopAgentTeams) && bunx skills add .',
                        'cd ~/other && v=`cd ~/LoopAgentTeams; pwd`; bunx skills add .',
                        "echo ';' bunx skills add ~/LoopAgentTeams",
                        'echo \\; bunx skills add ~/LoopAgentTeams',
                        "printf '%s\\n' '&&' bunx skills add ~/LoopAgentTeams",
                        '# bunx skills add ~/LoopAgentTeams',
                        'echo done # bunx skills add ~/LoopAgentTeams',
                        'uv run --no-project python ~/LoopAgentTeams/scripts/install-skills.py']:
            with self.subTest(command):
                self.assert_allowed(self.bash(command, self.repo))


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
