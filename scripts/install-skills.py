#!/usr/bin/env python3
"""Install this repo's skills globally for Claude Code and Codex, but only skills whose
current content passed their full suite.

A skill folder that holds a registered full suite (`full_suites` in `.suite-gate.json`)
needs a reusable pass in the suite gate's ledger whose run saw the same folder content as
the work tree now; otherwise nothing is installed and the missing suites are listed with
the gate command that runs them. Skills without a full suite are installed as they are.
bunx reads a snapshot of the checked content, so a change made meanwhile is not installed.
"""
import argparse
import importlib.util
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / 'skills/local/three-tier-testing/scripts/suite-gate.py'


def load_gate():
    spec = importlib.util.spec_from_file_location('suite_gate', GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(gate, folders):
    """(content tree, [(skill, suite, result)] for each suite under the folders that has no
    reusable pass)."""
    names = {folder: name for name, folder in folders.items()}
    tree, lacking = gate.lacking_folder_suites(ROOT, gate.load_registry(ROOT) or {},
                                               list(folders.values()))
    return tree, [(names[folder], suite, result) for folder, suite, result in lacking]


def find_bunx():
    """bunx from PATH, else ~/.bun/bin/bunx (Bun's installer puts it there, and agent shells
    often lack that directory on PATH); None when neither exists."""
    found = shutil.which('bunx')
    if found:
        return found
    fallback = Path.home() / '.bun/bin/bunx'
    if fallback.is_file() and os.access(fallback, os.X_OK):
        return str(fallback)
    return None


def install(tree, names, folders):
    """Run bunx on a snapshot of the folders as they are in tree."""
    bunx = find_bunx()
    if not bunx:
        raise RuntimeError(f"bunx not found: not on PATH and not at "
                           f"{Path.home() / '.bun/bin/bunx'}. "
                           'Install Bun (https://bun.sh) or add ~/.bun/bin to PATH.')
    with tempfile.TemporaryDirectory(prefix='lat-skills-') as snapshot:
        archive = subprocess.run(['git', 'archive', '--format=tar', tree, '--', *folders],
                                 cwd=ROOT, capture_output=True)
        if archive.returncode != 0:
            raise RuntimeError(f'git archive failed: {archive.stderr.decode().strip()}')
        subprocess.run(['tar', '-x', '-C', snapshot], input=archive.stdout, check=True)
        command = [bunx, 'skills', 'add', snapshot, '--skill', *names,
                   '--global', '--agent', 'claude-code', 'codex', '--yes']
        print(shlex.join(command), flush=True)
        return subprocess.run(command).returncode


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--skill', nargs='+', metavar='NAME',
                        help='install only these skills (default: every skill in the repo)')
    args = parser.parse_args(argv)
    gate = load_gate()
    try:
        skills = gate.skill_folders(ROOT)
        unknown = sorted(set(args.skill or ()) - set(skills))
        if unknown:
            parser.error(f"unknown skill: {', '.join(unknown)} "
                         f"(this repo has: {', '.join(sorted(skills))})")
        names = args.skill or sorted(skills)
        tree, lacking = check(gate, {name: skills[name] for name in names})
    except (RuntimeError, ValueError) as exc:
        print(f'install-skills: {exc}', file=sys.stderr)
        return 1
    if lacking:
        print('Not installed: these skills have no passing full-suite record for their '
              'current content:', file=sys.stderr)
        commands = []
        for name, suite, result in lacking:
            why = 'the latest run of this content failed' if result == 'failed' \
                else 'no run of this content'
            print(f"  {name}: {suite['cwd']}: {suite['command']} ({why})", file=sys.stderr)
            run = gate.gate_command(suite['command'], ('--purpose', 'post-merge'))
            command = f"cd {shlex.quote(str(ROOT / suite['cwd']))} && {run}"
            if command not in commands:
                commands.append(command)
        print('Run each suite through the gate on this content, then install again:',
              file=sys.stderr)
        for command in commands:
            print(f'  {command}', file=sys.stderr)
        return 1
    try:
        return install(tree, names, [skills[name] for name in names])
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f'install-skills: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
