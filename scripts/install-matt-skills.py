#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6,<7"]
# ///
"""Install the Mattpocock Skills group, excluding skills bundled in LAT and Other."""

import argparse
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

import yaml


def skill_names(root):
    names = set()
    for path in root.rglob("SKILL.md"):
        if any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        content = path.read_text()
        if not content.startswith("---\n"):
            raise ValueError(f"Missing frontmatter: {path}")
        metadata = yaml.safe_load(content.split("---", 2)[1])
        name = metadata["name"]
        if not isinstance(name, str) or not name or name.startswith("-"):
            raise ValueError(f"Invalid skill name: {path}")
        if name in names:
            raise ValueError(f"Duplicate skill name: {name}")
        names.add(name)
    if not names:
        raise ValueError(f"No skills found: {root}")
    return names


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent", nargs="+", default=["claude-code", "codex"])
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch the upstream list and print commands without installing")
    args = parser.parse_args()
    for command in ("gh", "bunx", "trash-put"):
        if not shutil.which(command):
            parser.error(f"Required command not found: {command}")

    repo = Path(__file__).resolve().parents[1]
    local = skill_names(repo / "skills")
    temporary = Path(tempfile.mkdtemp(prefix="lat-skills-"))
    try:
        upstream_dir = temporary / "upstream"
        subprocess.run(["gh", "repo", "clone", "mattpocock/skills", str(upstream_dir),
                        "--", "--depth=1", "--quiet"], check=True)
        manifest = json.loads((upstream_dir / ".claude-plugin/plugin.json").read_text())
        if manifest.get("name") != "mattpocock-skills" or not manifest.get("skills"):
            raise ValueError("Mattpocock Skills plugin manifest is missing or invalid")
        upstream = set()
        for relative in manifest["skills"]:
            upstream.update(skill_names(upstream_dir / relative))
    finally:
        subprocess.run(["trash-put", str(temporary)], check=True)

    names = upstream - local
    if not names:
        print("All upstream skills are already bundled in the LAT repo.")
        return
    # Keep the upstream source in the installer lockfile for future updates.
    command = ["bunx", "skills", "add", "mattpocock/skills", "--skill", *sorted(names),
               "--global", "--agent", *args.agent, "--yes"]
    print(shlex.join(command), flush=True)
    if not args.dry_run:
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
