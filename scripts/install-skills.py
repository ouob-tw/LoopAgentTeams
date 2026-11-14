#!/usr/bin/env python3
"""Install this repo's skills globally for Claude Code and Codex, but only skills whose
current content passed their full suite.

A skill folder that holds a registered full suite (`full_suites` in `.suite-gate.json`)
needs a reusable pass in the suite gate's ledger whose run saw the same folder content as
the work tree now; otherwise nothing is installed and the missing suites are listed with
the gate command that runs them. Skills without a full suite are installed as they are.
bunx reads a snapshot of the checked content, so a change made meanwhile is not installed.
A SKILL.md whose frontmatter has an unquoted value holding `: ` is refused before bunx runs,
since bunx skips such a skill and still exits 0. After bunx, every chosen skill must sit in
~/.agents/skills (Codex) and the Claude skills folder with the snapshot's exact content;
otherwise the missing or different skills are listed and the exit code is 1.
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


# Names the skills tool leaves out when it copies a skill folder.
SKIPPED_FILES = {'metadata.json'}
SKIPPED_DIRS = {'.git', '__pycache__', '__pypackages__'}


def frontmatter_problems(text, label):
    """'<label>:<line>: ...' for each line of a SKILL.md frontmatter whose plain (unquoted)
    value holds `: `, which YAML rejects."""
    if not text.startswith('---\n'):
        return []
    problems = []
    for number, line in enumerate(text[4:].split('\n---', 1)[0].splitlines(), 2):
        if not line or line[0] in ' \t#':
            continue
        key, sep, value = line.partition(':')
        value = value.strip()
        if sep and value and value[0] not in '"\'|>[{&*!' and ': ' in value:
            problems.append(f'{label}:{number}: the value of {key.strip()} holds ": " '
                            'without quotes; wrap the value in double quotes')
    return problems


def folder_files(folder):
    """{relative path: bytes} of the files the skills tool copies from folder; None when
    folder does not exist."""
    if not folder.is_dir():
        return None
    files = {}
    for top, dirs, names in os.walk(folder, followlinks=True):
        dirs[:] = [name for name in dirs if name not in SKIPPED_DIRS]
        for name in names:
            if name not in SKIPPED_FILES:
                path = Path(top, name)
                files[path.relative_to(folder).as_posix()] = path.read_bytes()
    return files


def install_places():
    """The folders a global install for claude-code and codex writes each skill into."""
    claude = os.environ.get('CLAUDE_CONFIG_DIR', '').strip() or Path.home() / '.claude'
    return [Path.home() / '.agents/skills', Path(claude) / 'skills']


def not_installed(snapshot, names, folders):
    """'<skill>: <why> at <path>' for each chosen skill whose installed copy is missing or
    differs from the snapshot."""
    problems = []
    for name, folder in zip(names, folders):
        expected = folder_files(Path(snapshot, folder))
        for place in install_places():
            installed = folder_files(place / name)
            if installed != expected:
                why = 'missing' if installed is None else 'different content'
                problems.append(f'{name}: {why} at {place / name}')
    return problems


def install(tree, names, folders):
    """Run bunx on a snapshot of the folders as they are in tree, then check that each
    chosen skill was installed with the snapshot's content; returns the exit code."""
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
        problems = [problem for folder in folders
                    for problem in frontmatter_problems(
                        Path(snapshot, folder, 'SKILL.md').read_text(encoding='utf-8'),
                        f'{folder}/SKILL.md')]
        if problems:
            raise RuntimeError('SKILL.md frontmatter that bunx would skip:\n  '
                               + '\n  '.join(problems))
        command = [bunx, 'skills', 'add', snapshot, '--skill', *names,
                   '--global', '--agent', 'claude-code', 'codex', '--yes']
        print(shlex.join(command), flush=True)
        code = subprocess.run(command).returncode
        if code != 0:
            return code
        problems = not_installed(snapshot, names, folders)
        if problems:
            print('install-skills: bunx exited 0 but these skills are not installed as '
                  'checked:\n  ' + '\n  '.join(problems), file=sys.stderr)
            return 1
        return 0


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
        suites = []
        for name, suite, result in lacking:
            why = 'the latest run of this content failed' if result == 'failed' \
                else 'no run of this content'
            print(f"  {name}: {suite['cwd']}: {suite['command']} ({why})", file=sys.stderr)
            if suite['cwd'] not in suites:
                suites.append(suite['cwd'])
        # The snapshot form tests HEAD in a clean checkout, so another agent merging into
        # this work tree mid-run cannot void the record; it is filed under the same
        # content tree, directory and command that the check above reads.
        command = shlex.join(['uv', 'run', '--no-project', 'python', str(gate.SCRIPT), 'run',
                              '--registered', *suites, '--purpose', 'release'])
        folders = sorted({skills[name] for name, _, _ in lacking})
        # The snapshot is HEAD's content, the check above is the work tree's.
        uncommitted = [folder for folder, work, head in zip(
            folders, gate.subtrees(ROOT, [f'{tree}:{f}' for f in folders]),
            gate.subtrees(ROOT, [f'HEAD:{f}' for f in folders])) if work != head]
        if uncommitted:
            print('Commit these folders first, or the snapshot will not test their current '
                  'content:\n  ' + '\n  '.join(uncommitted), file=sys.stderr)
        print('Run the suites through the gate on a snapshot of the committed HEAD (commit '
              'your changes first; uncommitted ones are not tested), then install again:',
              file=sys.stderr)
        print(f"  cd {shlex.quote(str(ROOT))} && {command}", file=sys.stderr)
        return 1
    try:
        return install(tree, names, [skills[name] for name in names])
    except (RuntimeError, subprocess.CalledProcessError) as exc:
        print(f'install-skills: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
