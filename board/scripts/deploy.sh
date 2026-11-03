#!/usr/bin/env bash
# Deploy the board from a committed state (HEAD, or the commit named in LAT_DEPLOY_COMMIT), never from the working folder's uncommitted edits:
# build in a temporary detached git worktree, swap the result in as build/, restart the service
# and wait for the login page, then print the inbox. Before the swap a failure leaves the live
# build/ untouched; after it a failed restart or login check puts the previous build/ back and restarts once more.
#
#   bash board/scripts/deploy.sh                          # deploy HEAD
#   LAT_DEPLOY_COMMIT=<commit> bash board/scripts/deploy.sh   # deploy (or roll back to) that commit
#
# A named commit is built in its own temporary worktree; the main workspace's branch and files are
# not touched. A commit that does not exist stops the script before anything is changed.
#
# Settings (environment):
#   LAT_DEPLOY_COMMIT     commit to deploy: any hash, tag or branch name git knows (default: HEAD)
#   LAT_DEPLOY_BOARD_DIR  board directory to deploy (default: the one holding this script)
#   LAT_DEPLOY_UNIT       systemd user unit to restart (default: lat-board)
#   LAT_DEPLOY_RESTART    restart command, run with sh -c (default: systemctl --user restart <unit>)
#   LAT_DEPLOY_BUILD      build command run in the worktree's board directory (default: bun run build)
#   PORT                  port of the running board (default: 7100); HOST is always 127.0.0.1
#   LAT_DEPLOY_WAIT       seconds to wait for the login page to answer 200, and for the inbox (default: 60)

set -u

board=${LAT_DEPLOY_BOARD_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
unit=${LAT_DEPLOY_UNIT:-lat-board}
restart=${LAT_DEPLOY_RESTART:-systemctl --user restart $unit}
build_cmd=${LAT_DEPLOY_BUILD:-bun run build}
port=${PORT:-7100}
wait_seconds=${LAT_DEPLOY_WAIT:-60}
worktree=
swapped=
moving=

# An agent shell often has no bun on PATH: add Bun's folder and the PATH the service itself uses.
unit_path=$(systemctl --user show "$unit" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n 's/^PATH=//p')
PATH=$PATH:$HOME/.bun/bin${unit_path:+:$unit_path}

say() { printf 'deploy: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

cleanup() {
	# Interrupted (or failed) between the two renames: put the live build back.
	if [ -n "$moving" ] && [ ! -d "$board/build" ] && [ -d "$board/build-prev" ]; then
		mv "$board/build-prev" "$board/build"
	fi
	if [ -n "$worktree" ]; then
		git -C "$repo" worktree remove --force "$worktree" 2>/dev/null || trash "$worktree" 2>/dev/null
		git -C "$repo" worktree prune
	fi
	[ -d "$board/build-new" ] && [ -z "$swapped" ] && trash "$board/build-new"
	return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

wait_for_login() {
	local deadline=$((SECONDS + wait_seconds)) code
	while [ "$SECONDS" -lt "$deadline" ]; do
		code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/login")
		[ "$code" = 200 ] && return 0
		sleep 1
	done
	return 1
}

[ -d "$board" ] || die "no board directory: $board"
[ -d "$board/node_modules" ] || die "$board/node_modules is missing; run bun install there first"
repo=$(git -C "$board" rev-parse --show-toplevel) || die "$board is not inside a git repository"
prefix=$(git -C "$board" rev-parse --show-prefix)
target=${LAT_DEPLOY_COMMIT:-HEAD}
full=$(git -C "$board" rev-parse --verify --quiet "$target^{commit}") || die "commit not found: $target; build/ is untouched"
sha=$(git -C "$board" rev-parse --short "$full")

[ -e "$board/build-new" ] && trash "$board/build-new"
[ -e "$board/build-prev" ] && { say "removing the old build-prev"; trash "$board/build-prev"; }

worktree=$(mktemp -d "${TMPDIR:-/tmp}/lat-board-deploy-XXXXXX") || die "cannot make a temporary folder"
git -C "$repo" worktree add --detach "$worktree" "$full" >/dev/null 2>&1 || die "cannot make a worktree at $sha"
say "building $sha from a clean worktree"
ln -s "$board/node_modules" "$worktree/${prefix}node_modules"
(cd "$worktree/$prefix" && LAT_BOARD_BUILD_DIR="$board/build-new" sh -c "$build_cmd" >&2) \
	|| die "the build failed; build/ is untouched"
[ -f "$board/build-new/index.js" ] || die "the build left no build-new/index.js; build/ is untouched"

moving=1
if [ -d "$board/build" ]; then
	mv -T "$board/build" "$board/build-prev" || die "could not move build/ aside; build/ is untouched"
fi
mv -T "$board/build-new" "$board/build" || die "could not move build-new into place; build/ is untouched"
moving=
swapped=1
say "swapped in $sha; restarting"

if sh -c "$restart" >&2 && wait_for_login; then
	say "login page answers 200 on port $port"
	[ -d "$board/build-prev" ] && trash "$board/build-prev"
	say "deployed $sha"
	# The login page says the service is up; this says what the deployed HEAD makes of the real data.
	(cd "$worktree/$prefix" && timeout "$wait_seconds" bun run --silent board inbox) >&2 || say "the inbox could not be read in full; run: bun run board inbox"
	exit 0
fi

say "restart or login check failed; putting the previous build back"
if [ ! -d "$board/build-prev" ]; then
	say "there was no previous build to put back; the new build is still in place"
	exit 1
fi
trash "$board/build"
mv "$board/build-prev" "$board/build"
if sh -c "$restart" >&2 && wait_for_login; then
	say "previous build restored and running"
else
	say "previous build restored, but the restart or login check failed; check the service"
fi
exit 1
