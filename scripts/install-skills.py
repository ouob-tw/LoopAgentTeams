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
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GATE = ROOT / 'skills/local/three-tier-testing/scripts/suite-gate.py'
NAME = re.compile(r'^name:\s*["\']?([^"\'\s]+)', re.M)


def load_gate():
    spec = importlib.util.spec_from_file_location('suite_gate', GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def skill_dirs():
    """{name: folder relative to the repo} for every SKILL.md under skills/."""
    found = {}
    for path in sorted((ROOT / 'skills').rglob('SKILL.md')):
        rel = path.parent.relative_to(ROOT)
        if any(part.startswith('.') for part in rel.parts):
            continue
        text = path.read_text()
        match = NAME.search(text.split('---', 2)[1]) if text.startswith('---\n') else None
        if not match:
            raise ValueError(f'no name in the frontmatter of {path}')
        found[match.group(1)] = rel.as_posix()
    return found


def subtrees(specs):
    """The object each `<tree>:<path>` names, or None when it does not exist."""
    if not specs:
        return []
    result = subprocess.run(['git', 'cat-file', '--batch-check=%(objectname)'], cwd=ROOT,
                            input=''.join(f'{spec}\n' for spec in specs),
                            capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f'git cat-file failed: {result.stderr.strip()}')
    return [None if line.endswith(' missing') else line
            for line in result.stdout.splitlines()]


def suite_result(records, suite, folder, current):
    """'passed', 'failed' or 'missing': the latest full run of this suite whose content of
    folder equals current decides, as the gate's own reuse does for the whole tree."""
    runs = [r for r in records if not r.get('kind') and not r.get('content_changed')
            and r.get('rel_cwd') == suite['cwd'] and r.get('command') == suite['command']
            and isinstance(r.get('tree'), str)]
    for record, tree in zip(runs, subtrees([f"{r['tree']}:{folder}" for r in runs])):
        if tree == current:
            return 'passed' if record.get('reusable') else 'failed'
    return 'missing'


def check(gate, folders):
    """(content tree, [(skill, suite, result)] for each suite under the folders that has no
    reusable pass)."""
    registry = gate.load_registry(ROOT) or {}
    suites = gate.read_full_suites(registry)
    tree = gate.content_tree(ROOT, gate.include_patterns(registry))
    records = list(reversed(gate.read_records()))
    lacking = []
    for name, folder in folders.items():
        current = subtrees([f'{tree}:{folder}'])[0]
        if current is None:
            raise RuntimeError(f'{folder} is not in the content the gate fingerprints')
        for suite in suites:
            if suite['cwd'] == folder or suite['cwd'].startswith(folder + '/'):
                result = suite_result(records, suite, folder, current)
                if result != 'passed':
                    lacking.append((name, suite, result))
    return tree, lacking


def install(tree, names, folders):
    """Run bunx on a snapshot of the folders as they are in tree."""
    with tempfile.TemporaryDirectory(prefix='lat-skills-') as snapshot:
        archive = subprocess.run(['git', 'archive', '--format=tar', tree, '--', *folders],
                                 cwd=ROOT, capture_output=True)
        if archive.returncode != 0:
            raise RuntimeError(f'git archive failed: {archive.stderr.decode().strip()}')
        subprocess.run(['tar', '-x', '-C', snapshot], input=archive.stdout, check=True)
        command = ['bunx', 'skills', 'add', snapshot, '--skill', *names,
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
        skills = skill_dirs()
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
